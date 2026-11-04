// Translation queue — books translated one after another (never two at once:
// the built-in translator runs one model, and order stays predictable).
//
// Items: { id, projectId, status: 'waiting' | 'running' | 'done' | 'error', error? }.
// Saved to a JSON file so the queue survives closing the app; after a restart
// it is paused and the book that was running waits again (its finished
// passages are kept: translation resumes where it stopped).
//
// A run that fails because of the setup (no key, wrong key, server not
// reachable, built-in translator problem) pauses the whole queue: the next
// book would fail the same way. Other errors mark that book and move on.

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const STOP_ALL = new Set(['noKey', 'badKey', 'unreachable', 'noModelLoaded', 'http404']);
const stopsQueue = (key) => STOP_ALL.has(key) || String(key || '').startsWith('builtin.');

function createQueue({ engine, file, send = () => {} }) {
  let items = [];
  let state = 'idle';       // 'idle' | 'running' | 'paused'
  let lastError = null;     // { key, params, projectId } of the error that paused the queue
  let current = null;       // item being translated
  let pausing = false;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    items = (saved.items || []).map((it) => (it.status === 'running' ? { ...it, status: 'waiting' } : it));
    if (items.some((it) => it.status === 'waiting')) state = 'paused';
  } catch { /* no queue yet */ }

  const snapshot = () => ({ state, items: items.map((it) => ({ ...it })), lastError, current: current ? current.projectId : null });
  // Saves run one at a time (a book can finish while the user reorders), each
  // writing the latest list through its own temp file, then renaming it into place.
  let saving = Promise.resolve();
  function save() {
    const write = async () => {
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ items: items.map(({ _remove, ...it }) => it) }, null, 2));
      await fsp.rename(tmp, file);
    };
    const safe = () => write().catch((err) => console.error('queue: could not save', err.message));
    saving = saving.then(safe, safe);
    return saving;
  }
  const changed = async () => { await save(); send('queue:state', snapshot()); };

  async function add(projectIds) {
    const have = new Set(items.filter((it) => it.status !== 'done').map((it) => it.projectId));
    for (const projectId of projectIds) {
      if (have.has(projectId)) continue;
      items.push({ id: crypto.randomUUID(), projectId, status: 'waiting' });
      have.add(projectId);
    }
    await changed();
    return snapshot();
  }

  async function remove(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return snapshot();
    if (it === current) { it._remove = true; engine.stop(); return snapshot(); } // dropped once it stops; the queue goes on
    items = items.filter((x) => x.id !== id);
    await changed();
    return snapshot();
  }

  async function removeProject(projectId) {
    const it = items.find((x) => x.projectId === projectId && x !== current);
    items = items.filter((x) => x.projectId !== projectId || x === current);
    if (it) await changed();
  }

  async function move(id, delta) {
    const i = items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return snapshot();
    [items[i], items[j]] = [items[j], items[i]];
    await changed();
    return snapshot();
  }

  async function clearFinished() {
    items = items.filter((x) => x.status === 'waiting' || x.status === 'running');
    await changed();
    return snapshot();
  }

  async function retry(id) {
    const it = items.find((x) => x.id === id);
    if (it && it.status === 'error') { it.status = 'waiting'; delete it.error; await changed(); }
    return snapshot();
  }

  // Run one book through the engine and report how it ended.
  function runOne(projectId) {
    return new Promise((resolve) => {
      let end = null;
      const sender = {
        send: (ch, ev) => {
          send(ch, ev); // the windows still see live progress
          if (ev.type === 'done') end = { ok: ev.reason === 'completed', stopped: ev.reason === 'stopped' };
          if (ev.type === 'error') end = { ok: false, key: ev.key, params: ev.params };
        },
      };
      Promise.resolve(engine.start(projectId, sender))
        .then(() => resolve(end || { ok: false, key: 'generic', params: { msg: 'no result' } }))
        .catch((err) => resolve({ ok: false, key: 'generic', params: { msg: err.message } }));
    });
  }

  async function loop() {
    while (state === 'running') {
      const it = items.find((x) => x.status === 'waiting');
      if (!it) { state = 'idle'; break; }
      current = it;
      it.status = 'running';
      await changed();
      const r = await runOne(it.projectId);
      current = null;
      if (it._remove) {
        items = items.filter((x) => x !== it);
      } else if (r.ok) {
        it.status = 'done';
      } else if (r.stopped || pausing) {
        it.status = 'waiting';
        state = 'paused';
      } else {
        it.status = 'error';
        it.error = { key: r.key, params: r.params || {} };
        if (stopsQueue(r.key)) { state = 'paused'; lastError = { ...it.error, projectId: it.projectId }; }
      }
      pausing = false;
      await changed();
    }
    await changed();
  }

  async function start() {
    if (state === 'running') return { ok: true, ...snapshot() };
    if (engine.isRunning()) return { ok: false, busy: true, ...snapshot() };
    if (!items.some((x) => x.status === 'waiting')) return { ok: false, empty: true, ...snapshot() };
    state = 'running';
    lastError = null;
    loop().catch((err) => { console.error('queue:', err); state = 'paused'; send('queue:state', snapshot()); });
    return { ok: true, ...snapshot() };
  }

  async function pause() {
    if (state !== 'running') return snapshot();
    pausing = true;
    state = 'paused';
    engine.stop(); // the current book stops after its passage; its work is kept
    await changed();
    return snapshot();
  }

  return {
    get: snapshot, add, remove, removeProject, move, clearFinished, retry, start, pause,
    isRunning: () => state === 'running',
    hasProject: (projectId) => items.some((x) => x.projectId === projectId && x.status !== 'done'),
  };
}

module.exports = { createQueue, stopsQueue };
