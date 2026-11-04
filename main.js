// Main process — the Node.js side of the app.
// Creates the window and exposes file-system / project operations to the UI
// over IPC (inter-process communication). The renderer can't touch the disk
// directly; it calls these handlers through the preload bridge.

const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, safeStorage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fsp = require('fs/promises');
const fs = require('fs');

const { createStore } = require('./src/store');
const { createEngine } = require('./src/engine');
const { buildExport, buildHtmlDocument, buildEpub } = require('./src/exporter');
const { epubToBlocks } = require('./src/epub');
const { docxToBlocks } = require('./src/docx');
const { pdfToBlocks, pdfCover } = require('./src/pdf');
const os = require('os');
const { getSystemInfo } = require('./src/hardware');
const { detectLocalServers } = require('./src/local-servers');
const { scanModelFolders } = require('./src/models');
const { createBuiltin } = require('./src/llama');
const llamaRelease = require('./src/llama-release');
const hub = require('./src/hub');
const { downloadFile } = require('./src/download');
const { scanFolder, sameSource, bookName } = require('./src/scan');
const { createQueue } = require('./src/queue');
const providers = require('./src/providers');

let store;  // initialised once the app is ready and userData path is known.
let engine; // translation engine, created alongside the store.
let builtin; // the built-in translator (llama-server), started on demand.
let queue; // the translation queue (books one after another).

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,            // brief: graceful down to ~980px
    minHeight: 600,
    backgroundColor: '#1F1E26',
    autoHideMenuBar: true,   // hide the dev-looking File/Edit/View bar; Alt reveals it
    icon: path.join(__dirname, 'build', 'icon.ico'), // window + taskbar icon in dev
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Links (e.g. "Get a key") open in the user's browser, never inside the app,
  // and the app window never navigates away from index.html.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  return win;
}

// Render an HTML string to a PDF file using a hidden window + Chromium's
// printToPDF (handles Arabic shaping / RTL natively, no extra dependencies).
async function writePdf(html, filePath) {
  const tmpHtml = path.join(os.tmpdir(), `nls-export-${Date.now()}.html`);
  await fsp.writeFile(tmpHtml, html, 'utf8');

  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pdfWin.loadFile(tmpHtml);
    const data = await pdfWin.webContents.printToPDF({ printBackground: true });
    await fsp.writeFile(filePath, data);
  } finally {
    pdfWin.destroy();
    fsp.unlink(tmpHtml).catch(() => {});
  }
}

// ---- Covers -----------------------------------------------------------------

// Normalize any picked/extracted image into a modest JPEG (≤600px wide) so
// covers stay small on disk no matter what the source was. Returns null if
// the bytes aren't a decodable image.
function normalizeCoverJpeg(buffer) {
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) return null;
  const { width } = img.getSize();
  const scaled = width > 600 ? img.resize({ width: 600 }) : img;
  return scaled.toJPEG(88);
}

// file:// URL for a project's cover (mtime query busts the renderer's cache
// after a change), or null when the project has none.
function coverUrlFor(id) {
  const p = store.getCoverPath(id);
  if (!p) return null;
  try { return pathToFileURL(p).href + '?v=' + fs.statSync(p).mtimeMs; }
  catch { return null; }
}

// Read and parse one manuscript file (single and folder imports). Returns
// { fileName, text } or { fileName, blocks, title, cover? } or { fileName, error }.
async function readManuscript(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.epub') {
      const buf = await fsp.readFile(filePath);
      const { title, blocks, cover } = await epubToBlocks(buf);
      return { fileName, blocks, title, cover };
    }
    if (ext === '.docx') {
      const { title, blocks } = await docxToBlocks(await fsp.readFile(filePath));
      return { fileName, blocks, title };
    }
    if (ext === '.pdf') {
      const buf = await fsp.readFile(filePath);
      const { title, blocks } = await pdfToBlocks(buf);
      // First page as the cover — usually the actual cover art in book PDFs.
      const png = await pdfCover(buf);
      return { fileName, blocks, title, cover: png ? png.toString('base64') : null };
    }
    // txt / md / markdown / anything else: read as UTF-8 text.
    const text = await fsp.readFile(filePath, 'utf8');
    return { fileName, text };
  } catch (err) {
    return { fileName, error: err.message || String(err) };
  }
}

// Every open window gets these events (engine progress, queue changes, imports).
function broadcast(ch, payload) {
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send(ch, payload); } catch { /* closing */ } }
}

// ---- IPC handlers -----------------------------------------------------------
// Each handler is async and returns a value (or throws) back to the renderer.

function registerIpc() {
  ipcMain.handle('projects:list', async () => {
    const projects = await store.listProjects();
    return projects.map((p) => ({ ...p, coverUrl: coverUrlFor(p.id) }));
  });
  ipcMain.handle('projects:get', async (_e, id) => {
    const project = await store.getProject(id);
    project.coverUrl = coverUrlFor(id);
    return project;
  });
  ipcMain.handle('projects:delete', async (_e, id) => { if (queue) await queue.removeProject(id); return store.deleteProject(id); });
  ipcMain.handle('projects:create', async (_e, input) => {
    const project = await store.createProject(input);
    if (input.cover) {
      try {
        const jpeg = normalizeCoverJpeg(Buffer.from(input.cover, 'base64'));
        if (jpeg) await store.saveCover(project.id, jpeg);
      } catch { /* a bad cover never blocks project creation */ }
    }
    project.coverUrl = coverUrlFor(project.id);
    return project;
  });
  ipcMain.handle('projects:save', (_e, project) => {
    delete project.coverUrl; // display-only field; not part of the stored JSON
    return store.saveProject(project);
  });

  // Set or clear a project's cover image.
  ipcMain.handle('cover:pick', async (e, projectId) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a cover image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      const jpeg = normalizeCoverJpeg(await fsp.readFile(result.filePaths[0]));
      if (!jpeg) return { error: 'unsupported' };
      await store.saveCover(projectId, jpeg);
      return { coverUrl: coverUrlFor(projectId) };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });
  ipcMain.handle('cover:remove', async (_e, projectId) => {
    await store.deleteCover(projectId);
    return true;
  });
  ipcMain.handle('projects:updateSegment', (_e, { projectId, segmentId, fields }) =>
    store.updateSegment(projectId, segmentId, fields));
  ipcMain.handle('projects:saveGlossary', (_e, { projectId, glossary }) =>
    store.saveGlossary(projectId, glossary));
  ipcMain.handle('glossary:getGlobal', () => store.getGlobalGlossary());
  ipcMain.handle('glossary:saveGlobal', (_e, glossary) => store.saveGlobalGlossary(glossary));
  ipcMain.handle('glossary:getSeries', (_e, series) => store.getSeriesGlossary(series));
  ipcMain.handle('glossary:saveSeries', (_e, { series, glossary }) => store.saveSeriesGlossary(series, glossary));
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, settings) => store.saveSettings(settings));
  ipcMain.handle('secrets:get', () => store.getSecrets());
  ipcMain.handle('secrets:save', (_e, secrets) => store.saveSecrets(secrets));

  // Open a native file picker and read the chosen manuscript.
  // Returns one of:
  //   { fileName, text }            — plain txt/Markdown
  //   { fileName, blocks, title }   — structured import (EPUB/DOCX/PDF)
  //   { fileName, error }           — parse failed
  //   null                          — the user cancelled
  ipcMain.handle('manuscript:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a manuscript',
      properties: ['openFile'],
      filters: [
        { name: 'Books & manuscripts', extensions: ['txt', 'md', 'markdown', 'epub', 'docx', 'pdf'] },
        { name: 'Text & Markdown', extensions: ['txt', 'md', 'markdown'] },
        { name: 'EPUB', extensions: ['epub'] },
        { name: 'Word', extensions: ['docx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    return readManuscript(result.filePaths[0]);
  });

  // Export — the format is chosen in-app; here we just save & generate it.
  ipcMain.handle('export:project', async (e, { projectId, format }) => {
    const project = await store.getProject(projectId);

    const FORMATS = {
      txt: { name: 'Text', ext: 'txt' },
      md: { name: 'Markdown', ext: 'md' },
      pdf: { name: 'PDF', ext: 'pdf' },
      epub: { name: 'EPUB', ext: 'epub' },
    };
    const fmt = FORMATS[(format || 'txt').toLowerCase()] || FORMATS.txt;

    const { text, total, untranslated } = buildExport(project, fmt.ext);

    const win = BrowserWindow.fromWebContents(e.sender);
    const safeName = (project.name || 'export').replace(/[\\/:*?"<>|]/g, '_');
    const result = await dialog.showSaveDialog(win, {
      title: `Export as ${fmt.name}`,
      defaultPath: `${safeName}.${fmt.ext}`,
      filters: [{ name: fmt.name, extensions: [fmt.ext] }],
    });

    if (result.canceled || !result.filePath) return { canceled: true };

    if (fmt.ext === 'pdf') {
      await writePdf(buildHtmlDocument(project), result.filePath);
    } else if (fmt.ext === 'epub') {
      const coverPath = store.getCoverPath(projectId);
      const cover = coverPath ? await fsp.readFile(coverPath) : null;
      await fsp.writeFile(result.filePath, await buildEpub(project, cover));
    } else {
      await fsp.writeFile(result.filePath, text, 'utf8'); // txt, md
    }

    return { canceled: false, path: result.filePath, total, untranslated, format: fmt.ext };
  });

  // ---- Folder import: a folder of books (and the folders inside it) ---------
  ipcMain.handle('folder:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder of books', properties: ['openDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('folder:scan', async (_e, root) => {
    try {
      const tree = await scanFolder(root);
      // Mark files already in the library (same file path) so they're skipped.
      const known = (await store.listProjects()).filter((p) => p.source).map((p) => p.source);
      const mark = (node) => {
        for (const f of node.files) f.imported = known.some((k) => sameSource(k, f));
        node.folders.forEach(mark);
      };
      mark(tree);
      return { ok: true, tree };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // input: { books: [{ path, series, size, mtimeMs }], settings, queue: bool }
  ipcMain.handle('folder:import', async (_e, input) => {
    const books = input.books || [];
    const created = [];
    const failed = [];
    for (let i = 0; i < books.length; i++) {
      const b = books[i];
      broadcast('folder:progress', { done: i, total: books.length, name: path.basename(b.path) });
      const m = await readManuscript(b.path);
      const empty = !m.error && (Array.isArray(m.blocks) ? m.blocks.length === 0 : !String(m.text || '').trim());
      if (m.error || empty) { failed.push({ name: m.fileName, reason: m.error ? 'error' : 'empty' }); continue; }
      try {
        const project = await store.createProject({
          name: (m.title && m.title.trim()) || bookName(m.fileName),
          text: m.text,
          blocks: m.blocks,
          settings: input.settings || {},
          series: b.series,
          source: { path: b.path, size: b.size, mtimeMs: b.mtimeMs },
        });
        if (m.cover) {
          try { const jpeg = normalizeCoverJpeg(Buffer.from(m.cover, 'base64')); if (jpeg) await store.saveCover(project.id, jpeg); } catch { /* no cover */ }
        }
        const words = project.segments.reduce((n, s) => n + (s.original ? s.original.split(/\s+/).length : 0), 0);
        created.push({ id: project.id, name: project.name, words });
      } catch (err) {
        failed.push({ name: m.fileName, reason: 'error' });
      }
    }
    broadcast('folder:progress', { done: books.length, total: books.length });
    if (input.queue && created.length) await queue.add(created.map((c) => c.id));
    return { created, failed };
  });

  // ---- Translation queue ---------------------------------------------------
  ipcMain.handle('queue:get', () => queue.get());
  ipcMain.handle('queue:add', (_e, ids) => queue.add(ids));
  ipcMain.handle('queue:remove', (_e, id) => queue.remove(id));
  ipcMain.handle('queue:move', (_e, { id, delta }) => queue.move(id, delta));
  ipcMain.handle('queue:clearFinished', () => queue.clearFinished());
  ipcMain.handle('queue:retry', (_e, id) => queue.retry(id));
  ipcMain.handle('queue:start', () => queue.start());
  ipcMain.handle('queue:pause', () => queue.pause());

  // Translation engine. Events stream back on the 'engine:event' channel to the
  // window that started the run (e.sender).
  ipcMain.handle('engine:start', (e, projectId) => {
    if (queue && queue.isRunning()) return { busy: 'queue' }; // one book at a time
    return engine.start(projectId, e.sender);
  });
  ipcMain.handle('engine:stop', () => engine.stop());
  ipcMain.handle('engine:retranslateSegment', (e, { projectId, segmentId }) =>
    engine.retranslateSegment(projectId, segmentId, e.sender));
  ipcMain.handle('engine:testConnection', (_e, apiUrl) => engine.testConnection(apiUrl));
  ipcMain.handle('engine:sample', (_e, cfg) => engine.sampleTranslate(cfg || {}));
  ipcMain.handle('engine:listModels', (_e, cfg) => engine.listModels(cfg || {}));

  // Providers page: the list, and which ones are set up.
  ipcMain.handle('providers:list', async () => {
    const s = await store.getSecrets();
    const configured = {};
    for (const p of providers.PROVIDERS) configured[p.id] = providers.isConfigured(p.id, s);
    return { providers: providers.PROVIDERS, configured, encrypted: safeStorage.isEncryptionAvailable() };
  });

  // First-run Setup: what this PC can run, and AI apps already running on it.
  ipcMain.handle('system:info', () => getSystemInfo());
  ipcMain.handle('local:detect', () => detectLocalServers());

  // Model folders for the built-in translator: scanned recursively for .gguf.
  ipcMain.handle('models:folders', async () => (await store.getAppConfig()).modelFolders || []);
  ipcMain.handle('models:addFolder', async (e, folder) => {
    let dir = folder ? path.resolve(folder) : '';
    if (!dir) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, { title: 'Choose a folder with models', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths.length) return null;
      dir = r.filePaths[0];
    }
    try { if (!fs.statSync(dir).isDirectory()) return { error: 'notFolder' }; } catch { return { error: 'notFolder' }; }
    const cfg = await store.getAppConfig();
    const list = cfg.modelFolders || [];
    if (!list.some((f) => f.toLowerCase() === dir.toLowerCase())) list.push(dir);
    await store.saveAppConfig({ modelFolders: list });
    return { folders: list };
  });
  ipcMain.handle('models:removeFolder', async (_e, dir) => {
    const cfg = await store.getAppConfig();
    const list = (cfg.modelFolders || []).filter((f) => f !== dir);
    await store.saveAppConfig({ modelFolders: list });
    return { folders: list };
  });
  ipcMain.handle('builtin:status', () => (builtin ? builtin.status() : { status: 'stopped' }));
  ipcMain.handle('builtin:engines', async () => (builtin ? builtin.listEngines() : []));
  ipcMain.handle('builtin:stop', () => { if (builtin) builtin.stop(); });

  // ---- Engine builds: NVIDIA download, updates, Undo ----------------------
  // Downloads live in userData/engine/<flavour>-<build>/ beside a build.json,
  // like the bundled copy. The newest of bundled vs downloaded runs (see
  // src/llama.js pickEngine); Undo pins the previous build.
  let engineDl = null; // { flavour, ac }
  const engineRoot = () => path.join(app.getPath('userData'), 'engine');
  const sendAll = (ch, payload) => { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send(ch, payload); } catch { /* closing */ } } };

  ipcMain.handle('engine:info', async () => {
    const cfg = await store.getAppConfig();
    const engines = await builtin.listEngines();
    const active = await builtin.pickEngine();
    return {
      engines: engines.map((e) => ({ flavour: e.flavour, build: e.build, version: e.version, source: e.source, id: `${e.flavour}-${e.build}` })),
      active: active ? `${active.flavour}-${active.build}` : null,
      flavour: cfg.engineFlavour || 'auto',
      pinned: cfg.enginePinned || null,
      downloading: engineDl ? engineDl.flavour : null,
    };
  });

  ipcMain.handle('app:updateInfo', () => ({
    version: require('./package.json').version,
    canSelfUpdate: !!appUpdater(),
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    releasesUrl: 'https://github.com/Faadred/ProseArc/releases/latest',
    ...updateState,
  }));
  ipcMain.handle('app:checkUpdate', async () => {
    const u = appUpdater();
    if (!u) return { ok: false, error: 'unsupported' };
    if (updateState.state === 'downloading' || updateState.state === 'ready') return { ok: true };
    try { await u.checkForUpdates(); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('app:installUpdate', () => {
    const u = appUpdater();
    if (u && updateState.state === 'ready') { if (builtin) builtin.stop(); u.quitAndInstall(); }
  });
  ipcMain.handle('app:openReleases', () => shell.openExternal('https://github.com/Faadred/ProseArc/releases/latest'));

  ipcMain.handle('engine:checkUpdate', async () => {
    try {
      const info = await llamaRelease.getStableBuild();
      const sizes = {};
      for (const f of ['vulkan', 'cuda12']) {
        try { sizes[f] = llamaRelease.flavourAssets(info, f).reduce((n, a) => n + a.size, 0); } catch { /* not offered */ }
      }
      return { ok: true, stable: info.stable, build: info.build, version: Number(info.build.slice(1)), date: info.date, sizes };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('engine:download', async (_e, flavour) => {
    if (engineDl) return { ok: false, error: 'busy' };
    const ac = new AbortController();
    engineDl = { flavour, ac };
    const tmp = path.join(engineRoot(), '.downloads');
    try {
      const info = await llamaRelease.getStableBuild();
      const assets = llamaRelease.flavourAssets(info, flavour);
      const total = assets.reduce((n, a) => n + a.size, 0);
      let before = 0;
      const zips = [];
      for (const a of assets) {
        const zip = path.join(tmp, a.name);
        await llamaRelease.downloadChecked(a.url, zip, a.sha256, (d) => {
          sendAll('engine:progress', { flavour, phase: 'download', done: before + d, total });
        }, ac.signal);
        before += a.size;
        zips.push(zip);
      }
      sendAll('engine:progress', { flavour, phase: 'install', done: total, total });
      const id = `${flavour}-${info.build}`;
      const dir = path.join(engineRoot(), id);
      await fsp.rm(dir, { recursive: true, force: true });
      for (const z of zips) await llamaRelease.extractZip(z, path.join(dir, 'bin'));
      const exe = await llamaRelease.findServerExe(dir);
      const version = exe ? await llamaRelease.serverVersion(exe) : null;
      if (!version) { await fsp.rm(dir, { recursive: true, force: true }); throw new Error('The downloaded engine did not start (llama-server --version).'); }
      await fsp.writeFile(path.join(dir, 'build.json'), JSON.stringify({ stable: info.stable, build: info.build, flavour, version, exe: path.relative(dir, exe) }, null, 2));
      for (const z of zips) await fsp.rm(z, { force: true });
      // Keep this build and the one before it of the same flavour (for Undo).
      const same = (await builtin.listEngines()).filter((e) => e.source === 'downloaded' && e.flavour === flavour).sort((a, b) => b.version - a.version);
      for (const old of same.slice(2)) await fsp.rm(old.dir, { recursive: true, force: true });
      await store.saveAppConfig({ engineFlavour: flavour, enginePinned: null });
      builtin.stop(); // next translation starts the new build
      return { ok: true, id, version };
    } catch (err) {
      return { ok: false, error: ac.signal.aborted ? 'cancelled' : err.message };
    } finally {
      engineDl = null;
      sendAll('engine:progress', { flavour, phase: 'idle' });
    }
  });
  ipcMain.handle('engine:cancel', () => { if (engineDl) engineDl.ac.abort(); });

  // ---- Hugging Face: find and download models -----------------------------
  // Downloads go to <download folder>/<owner>/<repo>/<file> (LM Studio's
  // layout), and that folder is added to the model folders so the built-in
  // translator sees new models at once.
  let modelDl = null; // { repo, file, ac, progress }
  async function downloadFolder() {
    const cfg = await store.getAppConfig();
    return cfg.downloadFolder || (cfg.modelFolders || [])[0] || path.join(app.getPath('documents'), 'ProseArc Models');
  }
  ipcMain.handle('hub:search', async (_e, query) => {
    try { return { ok: true, results: await hub.searchModels(query || '') }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('hub:files', async (_e, repo) => {
    try { return { ok: true, files: await hub.listRepoFiles(repo, await getSystemInfo()) }; }
    catch (err) { return { ok: false, error: err.message, status: err.status }; }
  });
  ipcMain.handle('hub:folder', () => downloadFolder());
  ipcMain.handle('hub:chooseFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Download models to…', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    await store.saveAppConfig({ downloadFolder: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.handle('hub:state', () => (modelDl ? { repo: modelDl.repo, file: modelDl.file, progress: modelDl.progress } : null));
  ipcMain.handle('hub:download', async (_e, { repo, file }) => {
    if (modelDl) return { ok: false, error: 'busy' };
    const ac = new AbortController();
    modelDl = { repo, file: file.path, ac, progress: null };
    try {
      const root = await downloadFolder();
      const dest = path.join(root, ...repo.split('/'), ...file.path.split('/'));
      const url = `https://huggingface.co/${repo}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      await downloadFile({
        url, dest, sha256: file.sha256, size: file.size, signal: ac.signal,
        onProgress: (p) => { modelDl.progress = p; sendAll('hub:progress', { repo, file: file.path, ...p }); },
      });
      // Make sure the built-in translator looks in the download folder.
      const cfg = await store.getAppConfig();
      const folders = cfg.modelFolders || [];
      const inside = folders.some((f) => path.resolve(dest).toLowerCase().startsWith(path.resolve(f).toLowerCase() + path.sep));
      if (!inside) await store.saveAppConfig({ modelFolders: [...folders, root] });
      return { ok: true, path: dest };
    } catch (err) {
      return { ok: false, error: err.code || 'failed', message: err.message, needGB: err.needGB };
    } finally {
      modelDl = null;
      sendAll('hub:progress', { repo, file: file.path, phase: 'idle' });
    }
  });
  ipcMain.handle('hub:cancel', () => { if (modelDl) modelDl.ac.abort(); });

  // Choose which build runs: { flavour } ('auto' | 'vulkan' | 'cuda12') or { pin: id | null }.
  ipcMain.handle('engine:use', async (_e, choice) => {
    const patch = {};
    if (choice && 'flavour' in choice) { patch.engineFlavour = choice.flavour; patch.enginePinned = null; }
    if (choice && 'pin' in choice) patch.enginePinned = choice.pin;
    await store.saveAppConfig(patch);
    builtin.stop();
    return true;
  });
  ipcMain.handle('models:list', async () => {
    const cfg = await store.getAppConfig();
    return scanModelFolders(cfg.modelFolders || [], await getSystemInfo());
  });
  // Apply AI settings to every existing book (Setup's "use for my books too").
  ipcMain.handle('projects:applyAi', async (_e, ai) => {
    const keys = ['provider', 'apiUrl', 'model', 'thinking'];
    const list = await store.listProjects();
    for (const s of list) {
      const p = await store.getProject(s.id);
      for (const k of keys) if (ai && k in ai) p[k] = ai[k];
      await store.saveProject(p);
    }
    return list.length;
  });
  ipcMain.handle('projects:resetForRetranslate', (_e, { projectId, includeReviewed }) =>
    store.resetForRetranslate(projectId, includeReviewed));
  ipcMain.handle('projects:markAllReviewed', (_e, projectId) => store.markAllReviewed(projectId));
}

// One-time migration: the app was renamed (folder "novel-localization-suite" →
// "prosearc"), and Electron derives userData from the package name. Copy any
// existing projects + shared glossary from the legacy folder into the new one so
// nothing is lost. Copy (not move) leaves the old folder as a safety backup.
function migrateLegacyUserData() {
  const dest = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'novel-localization-suite');
  const destProjects = path.join(dest, 'projects');
  try {
    if (legacy === dest || !fs.existsSync(legacy) || fs.existsSync(destProjects)) return;
    fs.mkdirSync(dest, { recursive: true });
    const legacyProjects = path.join(legacy, 'projects');
    if (fs.existsSync(legacyProjects)) fs.cpSync(legacyProjects, destProjects, { recursive: true });
    const legacyGlossary = path.join(legacy, 'glossary-global.json');
    if (fs.existsSync(legacyGlossary)) fs.copyFileSync(legacyGlossary, path.join(dest, 'glossary-global.json'));
  } catch {
    // Non-fatal: a fresh install simply has nothing to migrate.
  }
}

// ---- App updates from GitHub releases ---------------------------------------
// Installed builds only: the portable exe has no install location to update,
// and dev runs aren't packaged. Those get a link to the releases page instead.
let updater;             // electron-updater's autoUpdater, set up once
let updateState = { state: 'idle' };
const canSelfUpdate = () => app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
function setUpdateState(s) {
  updateState = s;
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('app:update', s); } catch { /* closing */ } }
}
function appUpdater() {
  if (updater !== undefined) return updater;
  updater = null;
  if (!canSelfUpdate()) return updater;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => setUpdateState({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => setUpdateState({ state: 'none' }));
    autoUpdater.on('update-available', (i) => setUpdateState({ state: 'downloading', version: i.version, pct: 0 }));
    autoUpdater.on('download-progress', (p) => setUpdateState({ ...updateState, state: 'downloading', pct: Math.floor(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => setUpdateState({ state: 'ready', version: i.version }));
    autoUpdater.on('error', (err) => setUpdateState({ state: 'error', error: String((err && err.message) || err) }));
    updater = autoUpdater;
  } catch { /* updater unavailable — never block app start */ }
  return updater;
}

app.whenReady().then(() => {
  // userData is the OS-specific per-app data folder (safe, writable, persists
  // across app updates). Projects live in a subfolder of it.
  migrateLegacyUserData();
  // API keys are encrypted with Windows' DPAPI (only this Windows user can read them).
  const protect = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  };
  store = createStore(path.join(app.getPath('userData'), 'projects'), protect);
  builtin = createBuiltin({ app, store });
  engine = createEngine({ store, builtin });
  queue = createQueue({ engine, file: path.join(app.getPath('userData'), 'queue.json'), send: broadcast });
  // Tell every window when the built-in translator starts, loads, fails or stops.
  builtin.onStatus((st) => {
    for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('builtin:status', st); } catch { /* closing */ } }
  });

  registerIpc();
  createWindow();

  // Check GitHub for a new version on start (downloads in the background;
  // installs on quit or with "Restart to update" in Settings).
  if (appUpdater()) appUpdater().checkForUpdates().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Never leave llama-server running after ProseArc closes.
app.on('will-quit', () => { if (builtin) builtin.stop(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
