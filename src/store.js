// Project store — persistence for projects as one JSON file each.
//
// Files live in <projectsDir>/<id>.json (projectsDir is provided by main.js,
// which points it at Electron's userData directory). Saves are ATOMIC: we write
// to a temp file and rename it over the real one. fs.rename is atomic on a
// single filesystem, so a crash mid-save leaves either the old file or the new
// one intact — never a half-written, corrupt project.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { segment, segmentBlocks } = require('./segmenter');

const SCHEMA_VERSION = 2; // v2: segments carry a structural `type` (heading/paragraph/…)

const DEFAULTS = {
  provider: 'builtin',      // an id from src/providers.js ('local' = a URL from older versions)
  sourceLang: 'English',
  targetLang: 'Arabic',
  apiUrl: 'http://localhost:1234/v1/chat/completions', // LM Studio default (used by 'local')
  model: '',                // empty = let the local server use whatever is loaded
  contextWindow: 2,         // preceding translated segments fed as continuity
  thinking: false,          // let reasoning models "think" first (slower; local models)
};

// API keys for cloud providers — stored separately from projects, never exported.
const { SECRET_FIELDS } = require('./providers');
const SECRET_KEYS = SECRET_FIELDS;

// `protect` (from main.js) encrypts the secrets file with Electron's safeStorage
// (Windows DPAPI: only this Windows user can read it). Without it, plain JSON.
function createStore(projectsDir, protect = null) {
  // Make sure the directory exists once, up front.
  fs.mkdirSync(projectsDir, { recursive: true });

  const filePath = (id) => path.join(projectsDir, `${id}.json`);

  // Covers live beside the projects folder, one JPEG per project.
  const coversDir = path.join(path.dirname(projectsDir), 'covers');
  fs.mkdirSync(coversDir, { recursive: true });
  const coverFile = (id) => path.join(coversDir, `${id}.jpg`);

  // The shared dictionary lives beside the projects folder (one per install).
  const globalGlossaryPath = path.join(path.dirname(projectsDir), 'glossary-global.json');

  // App-wide defaults for NEW projects (set once in the Settings tab).
  const settingsPath = path.join(path.dirname(projectsDir), 'settings-global.json');
  // Cloud API keys live in their own file, never bundled into project JSON.
  const secretsPath = path.join(path.dirname(projectsDir), 'secrets-global.json');

  // Only these keys are stored as project defaults; anything else is ignored.
  const SETTINGS_KEYS = ['provider', 'sourceLang', 'targetLang', 'apiUrl', 'model', 'contextWindow', 'thinking'];

  /** Atomically write an object as pretty JSON to `dest`. */
  async function atomicWrite(dest, obj) {
    // Unique temp name so two concurrent saves can't collide on the temp file.
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    const data = JSON.stringify(obj, null, 2);
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, dest); // atomic replace
  }

  /** Read and parse one project file by id. Returns the full project object. */
  async function getProject(id) {
    const raw = await fsp.readFile(filePath(id), 'utf8');
    return JSON.parse(raw);
  }

  /** Status counts used by the Library progress bars. */
  function countStatuses(segments) {
    let translated = 0;
    let reviewed = 0;
    for (const s of segments) {
      if (s.status === 'reviewed') {
        reviewed += 1;
        translated += 1; // reviewed implies a translation exists
      } else if (s.status === 'translated') {
        translated += 1;
      }
    }
    return { total: segments.length, translated, reviewed };
  }

  /**
   * Lightweight list of all projects for the Library screen.
   * Reads each file but returns only summary fields (not the full segment array
   * in the payload — just derived counts).
   */
  async function listProjects() {
    let entries;
    try {
      entries = await fsp.readdir(projectsDir);
    } catch {
      return [];
    }

    const summaries = [];
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      try {
        const project = await getProject(path.basename(file, '.json'));
        summaries.push({
          id: project.id,
          name: project.name,
          kind: project.kind || 'novel',
          engine: project.engine || null,
          sourceLang: project.sourceLang,
          targetLang: project.targetLang,
          counts: countStatuses(project.segments || []),
          series: project.series || '',
          source: project.source || null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        });
      } catch {
        // Skip unreadable/corrupt files rather than crashing the whole list.
      }
    }

    // Most recently touched first.
    summaries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return summaries;
  }

  /**
   * Create a new project from an imported manuscript.
   * Pass EITHER `text` (a raw txt/Markdown string) OR `blocks` (a pre-parsed
   * typed-block list, as produced by the EPUB/DOCX importers).
   * @param {object} input
   * @param {string} input.name
   * @param {string} [input.text] - raw manuscript contents (txt/Markdown).
   * @param {Array} [input.blocks] - pre-parsed typed blocks (overrides text).
   * @param {object} [input.settings] - any of the DEFAULTS to override.
   */
  async function createProject({ name, text, blocks, settings = {}, series = '', source = null }) {
    const now = new Date().toISOString();
    const rawSegments = Array.isArray(blocks) ? segmentBlocks(blocks) : segment(text || '');
    const globalDefaults = await getSettings(); // user's saved defaults seed new projects

    const project = {
      schemaVersion: SCHEMA_VERSION,
      id: crypto.randomUUID(),
      kind: 'novel',
      name: name && name.trim() ? name.trim() : 'Untitled Project',
      ...DEFAULTS,
      ...globalDefaults,
      ...settings,
      createdAt: now,
      updatedAt: now,
      segments: rawSegments.map((s, i) => {
        // Scene breaks (and any empty piece) carry no translatable text, so we
        // mark them done up front — the engine skips non-pending segments and
        // the exporter renders them as dividers.
        const isDivider = s.type === 'scene-break' || !String(s.original || '').trim();
        const seg = {
          id: i,
          type: s.type || 'paragraph',
          original: s.original,
          translation: '',
          status: isDivider ? 'reviewed' : 'pending',
        };
        if (s.level) seg.level = s.level;
        if (s.ordered) seg.ordered = true;
        return seg;
      }),
      glossary: [],
    };
    // Folder imports: the series (folder path) and the file the book came from.
    if (series) project.series = String(series);
    if (source && source.path) project.source = { path: source.path, size: source.size || 0, mtimeMs: source.mtimeMs || 0 };

    await atomicWrite(filePath(project.id), project);
    return project;
  }

  /** Persist a full project object (atomically) and bump updatedAt. */
  async function saveProject(project) {
    project.updatedAt = new Date().toISOString();
    await atomicWrite(filePath(project.id), project);
    return project;
  }

  /**
   * Update a single segment safely: re-read the project from disk, change just
   * that one segment, and save atomically. This is what the Review editor uses,
   * so a manual edit never clobbers (and is never clobbered by) a background run.
   */
  async function updateSegment(projectId, segmentId, fields) {
    const project = await getProject(projectId);
    const seg = project.segments.find((s) => s.id === segmentId);
    if (!seg) throw new Error(`Segment ${segmentId} not found`);
    Object.assign(seg, fields);
    await saveProject(project);
    return { segment: seg, counts: countStatuses(project.segments) };
  }

  /** Replace a project's glossary (re-read + atomic save, like updateSegment). */
  async function saveGlossary(projectId, glossary) {
    const project = await getProject(projectId);
    project.glossary = Array.isArray(glossary) ? glossary : [];
    await saveProject(project);
    return project.glossary;
  }

  /**
   * Mark segments for re-translation by setting them back to 'pending'.
   * By default reviewed segments are protected (left untouched); pass
   * includeReviewed=true to redo everything.
   */
  async function resetForRetranslate(projectId, includeReviewed = false) {
    const project = await getProject(projectId);
    for (const s of project.segments) {
      // Never re-queue non-translatable dividers (scene breaks / empty pieces).
      if (s.type === 'scene-break' || !String(s.original || '').trim()) continue;
      if (includeReviewed || s.status !== 'reviewed') s.status = 'pending';
    }
    await saveProject(project);
    return countStatuses(project.segments);
  }

  /**
   * Mark every segment that has a translation as 'reviewed' in one go.
   * Untranslated (empty) segments are left pending. For users who trust the
   * first pass and don't want to approve thousands of segments one by one.
   */
  async function markAllReviewed(projectId) {
    const project = await getProject(projectId);
    for (const s of project.segments) {
      if (s.translation && s.translation.trim()) s.status = 'reviewed';
    }
    await saveProject(project);
    return countStatuses(project.segments);
  }

  /** The shared dictionary, used by every project. Returns [] if none yet. */
  async function getGlobalGlossary() {
    try {
      return JSON.parse(await fsp.readFile(globalGlossaryPath, 'utf8'));
    } catch {
      return [];
    }
  }

  // Series glossaries (folder imports): one list per series name, in one file.
  // Every book of a series uses its series' terms, so names stay the same in every volume.
  const seriesGlossaryPath = path.join(path.dirname(projectsDir), 'glossary-series.json');
  async function readSeriesGlossaries() {
    try { return JSON.parse(await fsp.readFile(seriesGlossaryPath, 'utf8')) || {}; } catch { return {}; }
  }
  async function getSeriesGlossary(series) {
    if (!series) return [];
    const all = await readSeriesGlossaries();
    return Array.isArray(all[series]) ? all[series] : [];
  }
  async function saveSeriesGlossary(series, glossary) {
    if (!series) return [];
    const all = await readSeriesGlossaries();
    const list = Array.isArray(glossary) ? glossary : [];
    if (list.length) all[series] = list; else delete all[series];
    await atomicWrite(seriesGlossaryPath, all);
    return list;
  }

  /** Atomically save the shared dictionary. */
  async function saveGlobalGlossary(glossary) {
    const list = Array.isArray(glossary) ? glossary : [];
    await atomicWrite(globalGlossaryPath, list);
    return list;
  }

  /** App-wide default settings for new projects. Returns {} if none saved. */
  async function getSettings() {
    try {
      const raw = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
      const clean = {};
      for (const k of SETTINGS_KEYS) if (raw[k] !== undefined) clean[k] = raw[k];
      return clean;
    } catch {
      return {};
    }
  }

  /** Atomically save app-wide default settings (only known keys are kept). */
  async function saveSettings(input) {
    // Merge: a partial save (e.g. from Setup) keeps the other defaults.
    const clean = await getSettings();
    for (const k of SETTINGS_KEYS) if (input && input[k] !== undefined) clean[k] = input[k];
    await atomicWrite(settingsPath, clean);
    return clean;
  }

  /** Cloud API keys (per provider). Returns {} if none saved. */
  // App-level config: model folders, built-in engine choice. Not project defaults.
  const appConfigPath = path.join(path.dirname(projectsDir), 'app-config.json');
  async function getAppConfig() {
    try { return JSON.parse(await fsp.readFile(appConfigPath, 'utf8')) || {}; } catch { return {}; }
  }
  async function saveAppConfig(patch) {
    const next = { ...(await getAppConfig()), ...(patch || {}) };
    await atomicWrite(appConfigPath, next);
    return next;
  }

  // Secrets file: { v: 2, enc: base64 } when encrypted; older files are plain
  // { key: value } and get encrypted the first time they're read.
  async function readSecretsRaw() {
    let raw;
    try { raw = JSON.parse(await fsp.readFile(secretsPath, 'utf8')); } catch { return {}; }
    if (raw && raw.v === 2 && typeof raw.enc === 'string') {
      if (!protect) return {};
      try { return JSON.parse(protect.decrypt(Buffer.from(raw.enc, 'base64'))); } catch { return {}; }
    }
    if (raw && raw.v === 2 && raw.plain) return raw.plain;
    // Plain file from before encryption: upgrade it in place.
    const clean = {};
    for (const k of SECRET_KEYS) if (raw && raw[k] !== undefined) clean[k] = String(raw[k]);
    if (protect && protect.available()) await writeSecretsRaw(clean);
    return clean;
  }
  async function writeSecretsRaw(obj) {
    if (protect && protect.available()) {
      await atomicWrite(secretsPath, { v: 2, enc: protect.encrypt(JSON.stringify(obj)).toString('base64') });
    } else {
      await atomicWrite(secretsPath, { v: 2, plain: obj });
    }
  }
  async function getSecrets() {
    const raw = await readSecretsRaw();
    const clean = {};
    for (const k of SECRET_KEYS) if (raw[k] !== undefined) clean[k] = raw[k];
    return clean;
  }
  // Merge: saving one provider's key keeps the others.
  async function saveSecrets(input) {
    const clean = await getSecrets();
    for (const k of SECRET_KEYS) if (input && input[k] !== undefined) clean[k] = String(input[k]);
    for (const k of Object.keys(clean)) if (clean[k] === '') delete clean[k];
    await writeSecretsRaw(clean);
    return clean;
  }

  /** Save a project's cover image (a normalized JPEG buffer). */
  async function saveCover(id, jpegBuffer) {
    await fsp.writeFile(coverFile(id), jpegBuffer);
    return coverFile(id);
  }

  /** Absolute path of a project's cover, or null if it has none. */
  function getCoverPath(id) {
    return fs.existsSync(coverFile(id)) ? coverFile(id) : null;
  }

  /** Remove a project's cover. Resolves even if it was already gone. */
  async function deleteCover(id) {
    try {
      await fsp.unlink(coverFile(id));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /** Delete a project file (and its cover). Resolves even if already gone. */
  async function deleteProject(id) {
    try {
      await fsp.unlink(filePath(id));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await deleteCover(id);
  }

  return {
    listProjects,
    getProject,
    createProject,
    saveProject,
    updateSegment,
    saveGlossary,
    resetForRetranslate,
    markAllReviewed,
    getGlobalGlossary,
    saveGlobalGlossary,
    getSeriesGlossary,
    saveSeriesGlossary,
    getSettings,
    saveSettings,
    getSecrets,
    saveSecrets,
    getAppConfig,
    saveAppConfig,
    deleteProject,
    saveCover,
    getCoverPath,
    deleteCover,
    countStatuses,
    _atomicWrite: atomicWrite, // exposed for engine use later
  };
}

module.exports = { createStore, DEFAULTS, SCHEMA_VERSION };
