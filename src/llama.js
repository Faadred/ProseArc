// Built-in translator: runs llama.cpp's llama-server (its own program) hidden
// on 127.0.0.1 with a free port, and talks to it like any OpenAI-compatible
// server. One model at a time; started on demand, restarted when the model or
// options change, stopped when the app quits.
//
// Engine builds: the one bundled with the app (vendor/llama in dev,
// resources/llama when installed) and any downloaded into userData/engine
// (NVIDIA build, updates). See pickEngine().

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const LOAD_TIMEOUT_MS = 10 * 60 * 1000; // big models from slow disks take a while
const DEFAULT_CTX = 8192;               // passages are short; context = brief + glossary + neighbours

function createBuiltin({ app, store }) {
  let proc = null;
  let state = { status: 'stopped' };   // stopped | starting | ready | error
  let current = null;                  // { key, port, url, model, engine }
  let starting = null;                 // in-flight ensure() promise
  let tail = [];                       // last log lines, for error messages
  const listeners = new Set();

  const bundledDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'llama') : path.join(__dirname, '..', 'vendor', 'llama'));
  const downloadsDir = () => path.join(app.getPath('userData'), 'engine');

  function setState(next) {
    state = next;
    for (const fn of listeners) { try { fn(state); } catch { /* listener gone */ } }
  }

  async function readBuild(dir) {
    try {
      const b = JSON.parse(await fsp.readFile(path.join(dir, 'build.json'), 'utf8'));
      const exe = path.join(dir, b.exe);
      if (!fs.existsSync(exe)) return null;
      return { ...b, dir, exe };
    } catch { return null; }
  }

  /** All engine builds on this PC: [{ flavour, build, version, exe, dir, source }] */
  async function listEngines() {
    const out = [];
    const bundled = await readBuild(bundledDir());
    if (bundled) out.push({ ...bundled, source: 'bundled' });
    let entries = [];
    try { entries = await fsp.readdir(downloadsDir(), { withFileTypes: true }); } catch { /* none */ }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const b = await readBuild(path.join(downloadsDir(), e.name));
      if (b) out.push({ ...b, source: 'downloaded' });
    }
    return out;
  }

  /**
   * The build to run: the user's chosen flavour if present (e.g. NVIDIA),
   * newest build first; pinned build (after Undo) wins. Falls back to any.
   */
  async function pickEngine() {
    const cfg = await store.getAppConfig();
    const all = await listEngines();
    if (!all.length) return null;
    if (cfg.enginePinned) {
      const pinned = all.find((e) => `${e.flavour}-${e.build}` === cfg.enginePinned);
      if (pinned) return pinned;
    }
    const want = cfg.engineFlavour || 'auto';
    const byNewest = (a, b) => (b.version || 0) - (a.version || 0);
    if (want !== 'auto') {
      const m = all.filter((e) => e.flavour === want).sort(byNewest);
      if (m.length) return m[0];
    }
    // auto: a downloaded NVIDIA build if there is one, else the newest Vulkan.
    const cuda = all.filter((e) => e.flavour.startsWith('cuda')).sort(byNewest);
    if (want === 'auto' && cuda.length) return cuda[0];
    const vk = all.filter((e) => e.flavour === 'vulkan').sort(byNewest);
    return vk[0] || all.sort(byNewest)[0];
  }

  function freePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
  }

  // Turn llama-server's log into a short reason the UI can explain.
  function reasonFromLog() {
    const text = tail.join('\n');
    if (/out of memory|failed to allocate|ErrorOutOfDeviceMemory|cudaMalloc failed|not enough memory/i.test(text)) return 'oom';
    if (/unknown model architecture|unsupported model/i.test(text)) return 'arch';
    if (/failed to load model|error loading model|invalid magic|failed to read/i.test(text)) return 'load';
    if (/address already in use|bind/i.test(text)) return 'port';
    return 'crash';
  }

  async function waitReady(url, child) {
    const t0 = Date.now();
    while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
      if (child.exitCode !== null) {
        const err = new Error('llama-server exited'); err.builtin = reasonFromLog(); throw err;
      }
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) return;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    const err = new Error('load timeout'); err.builtin = 'timeout'; throw err;
  }

  function stop() {
    if (proc) {
      const p = proc;
      proc = null;
      try { p.kill(); } catch { /* already gone */ }
    }
    current = null;
    setState({ status: 'stopped' });
  }

  /**
   * Make sure llama-server runs with this model/options; returns its
   * chat-completions URL. opts: { model (path to .gguf), thinking, ctx }
   */
  async function ensure(opts) {
    const model = (opts && opts.model) || '';
    if (!model) { const e = new Error('no model'); e.builtin = 'noModel'; throw e; }
    if (!fs.existsSync(model)) { const e = new Error('model missing'); e.builtin = 'modelMissing'; throw e; }
    const engine = await pickEngine();
    if (!engine) { const e = new Error('no engine'); e.builtin = 'noEngine'; throw e; }
    const ctx = Number(opts.ctx) || DEFAULT_CTX;
    const thinking = !!opts.thinking;
    const key = JSON.stringify([engine.exe, model, ctx, thinking]);

    if (current && current.key === key && proc && state.status === 'ready') return current.url;
    if (starting && starting.key === key) return starting.promise;

    stop();
    const run = (async () => {
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      const args = [
        '-m', model,
        '--host', '127.0.0.1', '--port', String(port),
        '-c', String(ctx),
        '-np', '1',            // one translation at a time: all memory to one slot
        '--no-mmproj',         // text only; skip vision projectors beside the model
        '--no-webui',
        '--reasoning-budget', thinking ? '-1' : '0',
      ];
      tail = [];
      setState({ status: 'starting', model, engine: { flavour: engine.flavour, build: engine.build } });
      const child = spawn(engine.exe, args, { cwd: path.dirname(engine.exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      proc = child;
      const onData = (d) => {
        for (const line of String(d).split(/\r?\n/)) if (line.trim()) tail.push(line);
        if (tail.length > 80) tail = tail.slice(-80);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', () => {
        if (proc === child) {
          proc = null;
          if (state.status === 'ready') setState({ status: 'error', reason: 'crash' });
          current = null;
        }
      });
      try {
        await waitReady(base, child);
      } catch (err) {
        if (proc === child) { try { child.kill(); } catch { /* gone */ } proc = null; }
        setState({ status: 'error', reason: err.builtin || 'crash', log: tail.slice(-12).join('\n') });
        throw err;
      }
      current = { key, port, url: `${base}/v1/chat/completions`, model, engine };
      setState({ status: 'ready', model, engine: { flavour: engine.flavour, build: engine.build } });
      return current.url;
    })();
    starting = { key, promise: run };
    try { return await run; } finally { if (starting && starting.promise === run) starting = null; }
  }

  return {
    ensure,
    stop,
    listEngines,
    pickEngine,
    status: () => state,
    url: () => (current ? current.url : null),
    onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { createBuiltin, DEFAULT_CTX };
