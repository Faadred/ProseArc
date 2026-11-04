// Watched folders: new books found on a check, deleted books stay deleted,
// a missing folder is skipped, auto-translate fills the queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFolder, listBooks, sameSource } = require('../src/scan');
const { createStore } = require('../src/store');
const { createWatcher } = require('../src/watch');

function setup(t, { queue = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prosearc-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const books = path.join(root, 'Books');
  const store = createStore(path.join(root, 'data', 'projects'));
  const imported = [];
  // Stand-in for main.js importBooks(): a book per file, with its series and source.
  const importBooks = async (list, settings) => {
    const created = [];
    const failed = [];
    for (const b of list) {
      if (b.path.endsWith('.bad.txt')) { failed.push({ name: path.basename(b.path), path: b.path, reason: 'error' }); continue; }
      const p = await store.createProject({ name: path.basename(b.path), text: 'Hello.', settings, series: b.series, source: b });
      imported.push({ file: path.relative(books, b.path), series: b.series, settings });
      created.push({ id: p.id, name: p.name, words: 1, sourcePath: b.path });
    }
    return { created, failed };
  };
  const sent = [];
  const watcher = createWatcher({ store, scanFolder, listBooks, sameSource, importBooks, queue, send: (ch, x) => sent.push([ch, x]) });
  const put = (rel) => { const p = path.join(books, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'Some text.'); return p; };
  return { root, books, store, watcher, imported, sent, put };
}

test('a check imports only new books, into their series, with the folder\'s settings', async (t) => {
  const { books, store, watcher, imported, sent, put } = setup(t);
  put('Saga/Book 1.txt');
  await watcher.add({ path: books, settings: { targetLang: 'Arabic', provider: 'lmstudio' } });
  let r = await watcher.check();
  assert.equal(r.added.length, 1);
  put('Saga/Book 2.txt');
  put('New series/Part 1.md');
  r = await watcher.check();
  assert.deepEqual(r.added.map((a) => a.name).sort(), ['Book 2.txt', 'Part 1.md']);
  assert.deepEqual(imported.map((x) => [x.file.replace(/\\/g, '/'), x.series]), [
    ['Saga/Book 1.txt', 'Saga'], ['New series/Part 1.md', 'New series'], ['Saga/Book 2.txt', 'Saga'], // folders in name order
  ]);
  assert.ok(imported.every((x) => x.settings.targetLang === 'Arabic'));
  r = await watcher.check();
  assert.equal(r.added.length, 0, 'nothing new the third time');
  assert.equal((await store.listProjects()).length, 3);
  const [f] = await watcher.folders();
  assert.ok(f.lastChecked > 0);
  assert.ok(sent.some(([ch]) => ch === 'watch:result'));
});

test('a deleted book stays deleted; an unreadable file is not retried every time', async (t) => {
  const { books, store, watcher, put } = setup(t);
  const a = put('A.txt');
  put('B.bad.txt');
  await watcher.add({ path: books });
  let r = await watcher.check();
  assert.equal(r.added.length, 1);
  assert.equal(r.failed.length, 1);
  const [book] = await store.listProjects();
  await watcher.ignore(a); // what main.js does when a book is deleted
  await store.deleteProject(book.id);
  r = await watcher.check();
  assert.equal(r.added.length, 0, 'not brought back');
  assert.equal(r.failed.length, 0, 'the unreadable file is remembered');
  await watcher.ignore(path.join(os.tmpdir(), 'elsewhere.txt')); // not in a watched folder: ignored quietly
  const [f] = await watcher.folders();
  assert.equal(f.ignored.length, 2);
});

test('a missing folder is marked and skipped; adding the same folder twice updates it', async (t) => {
  const { books, root, watcher, put } = setup(t);
  put('X.txt');
  await watcher.add({ path: books, autoTranslate: false });
  await watcher.add({ path: books.toUpperCase() === books ? books : books, settings: { targetLang: 'French' }, autoTranslate: true });
  let list = await watcher.folders();
  assert.equal(list.length, 1);
  assert.equal(list[0].autoTranslate, true);
  assert.equal(list[0].settings.targetLang, 'French');
  await watcher.add({ path: path.join(root, 'Unplugged') });
  const r = await watcher.check();
  assert.deepEqual(r.missing, [path.join(root, 'Unplugged')]);
  list = await watcher.folders();
  assert.equal(list.find((f) => f.path.endsWith('Unplugged')).missing, true);
  await watcher.update(books, { autoTranslate: false });
  assert.equal((await watcher.folders())[0].autoTranslate, false);
  await watcher.remove(path.join(root, 'Unplugged'));
  assert.equal((await watcher.folders()).length, 1);
});

test('auto-translate adds new books to the queue and starts it when idle', async (t) => {
  const calls = [];
  const queue = { state: 'idle', add: async (ids) => calls.push(['add', ids.length]), get() { return { state: this.state }; }, start: async () => calls.push(['start']) };
  const { books, watcher, put } = setup(t, { queue });
  put('One.txt');
  put('Two.txt');
  await watcher.add({ path: books, autoTranslate: true });
  await watcher.check();
  assert.deepEqual(calls, [['add', 2], ['start']]);
  // Off: nothing queued.
  calls.length = 0;
  await watcher.update(books, { autoTranslate: false });
  put('Three.txt');
  await watcher.check();
  assert.deepEqual(calls, []);
});

test('two checks at once run as one', async (t) => {
  const { books, watcher, put } = setup(t);
  put('Only.txt');
  await watcher.add({ path: books });
  const [r1, r2] = await Promise.all([watcher.check(), watcher.check()]);
  assert.equal(r1, r2);
  assert.equal(r1.added.length, 1);
});
