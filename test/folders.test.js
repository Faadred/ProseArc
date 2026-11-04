// Folder import (scan) and the translation queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFolder, listBooks, sameSource, bookName } = require('../src/scan');
const { createQueue, stopsQueue } = require('../src/queue');
const { createStore } = require('../src/store');

function tmpDir(t, prefix = 'prosearc-folders-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(root, rel, text = 'Some text.') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

test('scanFolder: nested folders, natural order, only books, hidden skipped', async (t) => {
  const root = tmpDir(t);
  put(root, 'Fantasy/Saga/Book 10.txt');
  put(root, 'Fantasy/Saga/Book 2.epub');
  put(root, 'Fantasy/Saga/Book 1.md');
  put(root, 'Fantasy/Saga/cover.jpg');
  put(root, 'Fantasy/Standalone.docx');
  put(root, 'Mystery/Case one.pdf');
  put(root, 'Empty/notes.jpg');
  put(root, '.hidden/secret.txt');
  put(root, 'Fantasy/~$Book.docx'); // a Word lock file
  put(root, 'Loose.txt');

  const tree = await scanFolder(root);
  assert.equal(tree.rel, '');
  assert.deepEqual(tree.folders.map((f) => f.name), ['Fantasy', 'Mystery'], 'folders without books are left out');
  const fantasy = tree.folders[0];
  assert.deepEqual(fantasy.files.map((f) => f.name), ['Standalone.docx']);
  assert.deepEqual(fantasy.folders[0].files.map((f) => f.name), ['Book 1.md', 'Book 2.epub', 'Book 10.txt']);
  assert.equal(fantasy.folders[0].rel, 'Fantasy/Saga');
  const f = fantasy.folders[0].files[0];
  assert.equal(f.ext, '.md');
  assert.ok(f.size > 0 && f.mtimeMs > 0);

  const books = listBooks(tree);
  assert.deepEqual(books.map((b) => [path.basename(b.path), b.series]), [
    ['Loose.txt', path.basename(root)],
    ['Standalone.docx', 'Fantasy'],
    ['Book 1.md', 'Fantasy / Saga'],
    ['Book 2.epub', 'Fantasy / Saga'],
    ['Book 10.txt', 'Fantasy / Saga'],
    ['Case one.pdf', 'Mystery'],
  ]);
});

test('scanFolder: depth limit, and a file is not a folder', async (t) => {
  const root = tmpDir(t);
  put(root, 'a/b/c/deep.txt');
  const shallow = await scanFolder(root, { maxDepth: 2 });
  assert.equal(listBooks(shallow).length, 0);
  assert.equal(listBooks(await scanFolder(root)).length, 1);
  await assert.rejects(scanFolder(path.join(root, 'a/b/c/deep.txt')), /Not a folder/);
});

test('sameSource and bookName', () => {
  assert.equal(sameSource({ path: 'C:\\Books\\A.epub' }, { path: 'c:\\books\\a.EPUB' }), process.platform === 'win32');
  assert.equal(sameSource({ path: '/x/a.txt' }, { path: '/x/b.txt' }), false);
  assert.equal(sameSource(null, { path: '/x' }), false);
  assert.equal(bookName('The_Long__Road.epub'), 'The Long Road');
  assert.equal(bookName('Book 2.md'), 'Book 2');
});

test('store keeps a book\'s series and source file', async (t) => {
  const store = createStore(path.join(tmpDir(t), 'projects'));
  const p = await store.createProject({ name: 'B1', text: 'Hi.', series: 'Fantasy / Saga', source: { path: 'C:\\x\\B1.txt', size: 3, mtimeMs: 9 } });
  const [s] = await store.listProjects();
  assert.equal(s.series, 'Fantasy / Saga');
  assert.deepEqual(s.source, { path: 'C:\\x\\B1.txt', size: 3, mtimeMs: 9 });
  const plain = await store.createProject({ name: 'B2', text: 'Hi.' });
  assert.equal(plain.series, undefined);
});

// ---- queue, with a fake engine ------------------------------------------------

// outcomes: projectId -> 'ok' | 'error:<key>' | 'hang' (runs until stopped)
function fakeEngine(outcomes = {}) {
  let running = false;
  let stopNow = null;
  const ran = [];
  return {
    ran,
    isRunning: () => running,
    stop: () => { if (stopNow) stopNow(); },
    start: async (projectId, sender) => {
      running = true;
      ran.push(projectId);
      sender.send('engine:event', { type: 'started', projectId });
      const o = outcomes[projectId] || 'ok';
      if (o === 'hang') await new Promise((r) => { stopNow = r; });
      stopNow = null;
      running = false;
      if (o === 'hang') sender.send('engine:event', { type: 'done', reason: 'stopped', projectId });
      else if (o.startsWith('error:')) sender.send('engine:event', { type: 'error', key: o.slice(6), params: {}, projectId });
      else sender.send('engine:event', { type: 'done', reason: 'completed', projectId });
    },
  };
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

test('queue: books run one after another, in order, and the queue is saved', async (t) => {
  const file = path.join(tmpDir(t), 'queue.json');
  const engine = fakeEngine();
  const events = [];
  const q = createQueue({ engine, file, send: (ch, ev) => events.push([ch, ev]) });
  await q.add(['a', 'b', 'c']);
  await q.add(['b']); // already waiting: not added twice
  assert.equal(q.get().items.length, 3);
  await q.move(q.get().items[2].id, -1); // c before b
  await q.start();
  await until(() => q.get().state === 'idle');
  assert.deepEqual(engine.ran, ['a', 'c', 'b']);
  assert.ok(q.get().items.every((x) => x.status === 'done'));
  assert.ok(events.some(([ch, ev]) => ch === 'engine:event' && ev.type === 'started'), 'live progress still reaches the windows');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 3);
  await q.clearFinished();
  assert.equal(q.get().items.length, 0);
});

test('queue: a setup error pauses everything; a book error only marks that book', async (t) => {
  const dir = tmpDir(t);
  const outcomes = { a: 'error:generic', b: 'ok', c: 'error:badKey', d: 'ok' };
  const engine = fakeEngine(outcomes);
  const q = createQueue({ engine, file: path.join(dir, 'q.json') });
  await q.add(['a', 'b', 'c', 'd']);
  await q.start();
  await until(() => q.get().state !== 'running');
  const st = q.get();
  assert.deepEqual(st.items.map((x) => x.status), ['error', 'done', 'error', 'waiting']);
  assert.equal(st.state, 'paused');
  assert.equal(st.lastError.key, 'badKey');
  assert.deepEqual(engine.ran, ['a', 'b', 'c']);
  assert.equal(stopsQueue('builtin.crash'), true);
  assert.equal(stopsQueue('empty'), false);
  // Retry the failed book after fixing the key.
  outcomes.c = 'ok';
  await q.retry(st.items[2].id);
  engine.ran.length = 0;
  await q.start();
  await until(() => q.get().state === 'idle');
  assert.deepEqual(engine.ran.sort(), ['c', 'd']);
});

test('queue: pause stops the running book, which waits again; restart resumes paused', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'q.json');
  const engine = fakeEngine({ a: 'hang' });
  const q = createQueue({ engine, file });
  await q.add(['a', 'b']);
  await q.start();
  await until(() => engine.isRunning());
  assert.equal((await q.start()).ok, true, 'start while running is a no-op');
  await q.pause();
  await until(() => !engine.isRunning());
  await until(() => q.get().items[0].status === 'waiting');
  assert.equal(q.get().state, 'paused');
  assert.deepEqual(engine.ran, ['a']);
  await new Promise((r) => setTimeout(r, 100)); // let the queue's last save finish before the folder is removed

  // Closing the app while a book runs: after restart it waits, the queue is paused.
  const file2 = path.join(dir, 'q2.json');
  fs.writeFileSync(file2, JSON.stringify({ items: [{ id: '1', projectId: 'x', status: 'running' }, { id: '2', projectId: 'y', status: 'done' }] }));
  const q2 = createQueue({ engine: fakeEngine(), file: file2 });
  assert.equal(q2.get().state, 'paused');
  assert.deepEqual(q2.get().items.map((x) => x.status), ['waiting', 'done']);
});

test('queue: won\'t start while a book is translated by hand; removing the running book moves on', async (t) => {
  const dir = tmpDir(t);
  const busy = { isRunning: () => true, stop() {}, start: async () => {} };
  const q = createQueue({ engine: busy, file: path.join(dir, 'q1.json') });
  await q.add(['a']);
  assert.equal((await q.start()).busy, true);

  const engine = fakeEngine({ a: 'hang' });
  const q2 = createQueue({ engine, file: path.join(dir, 'q2.json') });
  await q2.add(['a', 'b']);
  await q2.start();
  await until(() => engine.isRunning());
  await q2.remove(q2.get().items[0].id);
  await until(() => q2.get().state === 'idle');
  assert.deepEqual(engine.ran, ['a', 'b']);
  assert.deepEqual(q2.get().items.map((x) => [x.projectId, x.status]), [['b', 'done']]);
  await q2.removeProject('b');
  assert.equal(q2.get().items.length, 0);
});

test('series glossaries: one list per series, an empty list removes it', async (t) => {
  const store = createStore(path.join(tmpDir(t), 'projects'));
  assert.deepEqual(await store.getSeriesGlossary('A'), []);
  assert.deepEqual(await store.getSeriesGlossary(''), []);
  await store.saveSeriesGlossary('A', [{ id: '1', source: 'x', target: 'y' }]);
  await store.saveSeriesGlossary('B / C', [{ id: '2', source: 'p', target: 'q' }]);
  assert.equal((await store.getSeriesGlossary('A'))[0].target, 'y');
  assert.equal((await store.getSeriesGlossary('B / C'))[0].target, 'q');
  await store.saveSeriesGlossary('A', []);
  assert.deepEqual(await store.getSeriesGlossary('A'), []);
  assert.equal((await store.getSeriesGlossary('B / C')).length, 1, 'other series untouched');
});
