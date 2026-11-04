// Watched folders — folders the user imported and asked ProseArc to keep an
// eye on. They are checked when the app starts and on "Check now"; books that
// appeared since are imported with the settings chosen for that folder, into
// the same series (folder) layout as the first import.
//
// Kept in app-config.json → watchedFolders: [{ path, settings, autoTranslate,
// ignored: [file paths], lastChecked, lastAdded, missing }].
// - A book the user deletes from the library is remembered in `ignored`, so a
//   check never brings it back.
// - A folder that isn't there (an unplugged drive) is marked missing and skipped.
// - autoTranslate (off by default) puts new books in the translation queue.

const path = require('path');

const norm = (p) => path.resolve(p).toLowerCase();
const inside = (file, folder) => {
  const f = norm(file), d = norm(folder);
  return f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
};

function createWatcher({ store, scanFolder, listBooks, sameSource, importBooks, queue = null, send = () => {} }) {
  let checking = null; // the running check (one at a time)

  async function folders() {
    const cfg = await store.getAppConfig();
    return Array.isArray(cfg.watchedFolders) ? cfg.watchedFolders : [];
  }
  async function saveFolders(list) {
    await store.saveAppConfig({ watchedFolders: list });
    send('watch:state', list);
    return list;
  }

  async function add({ path: dir, settings = {}, autoTranslate = false }) {
    const list = await folders();
    const at = list.findIndex((f) => norm(f.path) === norm(dir));
    const entry = { path: path.resolve(dir), settings, autoTranslate: !!autoTranslate, ignored: [], lastChecked: Date.now(), lastAdded: 0, missing: false };
    if (at >= 0) list[at] = { ...list[at], settings, autoTranslate: !!autoTranslate };
    else list.push(entry);
    return saveFolders(list);
  }

  async function remove(dir) {
    return saveFolders((await folders()).filter((f) => norm(f.path) !== norm(dir)));
  }

  async function update(dir, patch) {
    const list = await folders();
    const f = list.find((x) => norm(x.path) === norm(dir));
    if (f) {
      if ('autoTranslate' in patch) f.autoTranslate = !!patch.autoTranslate;
      if (patch.settings) f.settings = { ...f.settings, ...patch.settings };
    }
    return saveFolders(list);
  }

  // A book was deleted: if it came from a watched folder, don't import it again.
  async function ignore(filePath) {
    if (!filePath) return;
    const list = await folders();
    let changed = false;
    for (const f of list) {
      if (!inside(filePath, f.path)) continue;
      f.ignored = Array.isArray(f.ignored) ? f.ignored : [];
      if (!f.ignored.some((p) => norm(p) === norm(filePath))) { f.ignored.push(path.resolve(filePath)); changed = true; }
    }
    if (changed) await saveFolders(list);
  }

  async function runCheck() {
    const list = await folders();
    const known = (await store.listProjects()).filter((p) => p.source).map((p) => p.source);
    const result = { checked: 0, missing: [], added: [], failed: [] };
    const toQueue = [];
    for (const f of list) {
      let tree;
      try {
        tree = await scanFolder(f.path);
      } catch {
        f.missing = true;
        result.missing.push(f.path);
        continue;
      }
      f.missing = false;
      result.checked += 1;
      const ignored = (f.ignored || []).map(norm);
      const fresh = listBooks(tree).filter((b) => !known.some((k) => sameSource(k, b)) && !ignored.includes(norm(b.path)));
      f.lastChecked = Date.now();
      if (!fresh.length) continue;
      const r = await importBooks(fresh, f.settings || {});
      f.lastAdded = r.created.length;
      result.added.push(...r.created.map((c) => ({ ...c, folder: f.path })));
      result.failed.push(...r.failed.map((x) => ({ ...x, folder: f.path })));
      // Files that can't be read would fail on every check: remember them too.
      for (const x of r.failed) if (x.path) (f.ignored = f.ignored || []).push(path.resolve(x.path));
      for (const c of r.created) known.push({ path: c.sourcePath });
      if (f.autoTranslate && r.created.length) toQueue.push(...r.created.map((c) => c.id));
    }
    await saveFolders(list);
    if (queue && toQueue.length) {
      await queue.add(toQueue);
      if (queue.get().state === 'idle') await queue.start();
    }
    send('watch:result', result);
    return result;
  }

  // One check at a time; a second "Check now" waits for the first.
  function check() {
    if (!checking) checking = runCheck().finally(() => { checking = null; });
    return checking;
  }

  return { folders, add, remove, update, ignore, check, isChecking: () => !!checking };
}

module.exports = { createWatcher };
