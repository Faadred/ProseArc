const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');

function setup(t, protect) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prosearc-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createStore(path.join(root, 'projects'), protect) };
}

// Stand-in for Electron safeStorage: reversible, and clearly not plain JSON.
const fakeProtect = {
  available: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64').split('').reverse().join('')),
  decrypt: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'base64').toString('utf8'),
};

test('createProject: segments, statuses, saved defaults, listProjects', async (t) => {
  const { store } = setup(t);
  await store.saveSettings({ targetLang: 'Arabic', contextWindow: 3, bogus: 'dropped' });
  assert.deepEqual(await store.getSettings(), { targetLang: 'Arabic', contextWindow: 3 });

  const p = await store.createProject({ name: '  ', text: '# One\n\nHello.\n\n***\n\nBye.' });
  assert.equal(p.name, 'Untitled Project');
  assert.equal(p.targetLang, 'Arabic');
  assert.equal(p.contextWindow, 3);
  assert.deepEqual(p.segments.map((s) => [s.id, s.type, s.status]), [
    [0, 'heading', 'pending'], [1, 'paragraph', 'pending'], [2, 'scene-break', 'reviewed'], [3, 'paragraph', 'pending'],
  ]);

  const list = await store.listProjects();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].counts, { total: 4, translated: 1, reviewed: 1 });
});

test('updateSegment, markAllReviewed, resetForRetranslate', async (t) => {
  const { store } = setup(t);
  const p = await store.createProject({ name: 'B', text: 'A.\n\nB.\n\n***\n\nC.' });
  await store.updateSegment(p.id, 0, { translation: 'أ', status: 'translated' });
  await store.updateSegment(p.id, 1, { translation: 'ب', status: 'reviewed' });
  await assert.rejects(store.updateSegment(p.id, 99, {}), /not found/);

  let counts = await store.resetForRetranslate(p.id);
  let fresh = await store.getProject(p.id);
  assert.deepEqual(fresh.segments.map((s) => s.status), ['pending', 'reviewed', 'reviewed', 'pending']);

  counts = await store.markAllReviewed(p.id);
  fresh = await store.getProject(p.id);
  assert.deepEqual(fresh.segments.map((s) => s.status), ['reviewed', 'reviewed', 'reviewed', 'pending']);
  assert.deepEqual(counts, { total: 4, translated: 3, reviewed: 3 });

  await store.resetForRetranslate(p.id, true);
  fresh = await store.getProject(p.id);
  assert.deepEqual(fresh.segments.map((s) => s.status), ['pending', 'pending', 'reviewed', 'pending']);
});

test('saving never leaves temp files, and a corrupt project is skipped in the list', async (t) => {
  const { root, store } = setup(t);
  const p = await store.createProject({ name: 'C', text: 'x.' });
  for (let i = 0; i < 5; i++) await store.saveProject(p);
  fs.writeFileSync(path.join(root, 'projects', 'broken.json'), '{ not json');
  const files = fs.readdirSync(path.join(root, 'projects'));
  assert.ok(files.every((f) => !f.endsWith('.tmp')));
  assert.equal((await store.listProjects()).length, 1);
});

test('deleteProject removes the cover too', async (t) => {
  const { store } = setup(t);
  const p = await store.createProject({ name: 'D', text: 'x.' });
  await store.saveCover(p.id, Buffer.from([1, 2, 3]));
  assert.ok(store.getCoverPath(p.id));
  await store.deleteProject(p.id);
  assert.equal(store.getCoverPath(p.id), null);
  await store.deleteProject(p.id); // already gone: no error
});

test('secrets: encrypted on disk, merged on save, empty value removes a key', async (t) => {
  const { root, store } = setup(t, fakeProtect);
  await store.saveSecrets({ openai: 'sk-one', notAField: 'x' });
  await store.saveSecrets({ groq: 'gq-two' });
  const disk = fs.readFileSync(path.join(root, 'secrets-global.json'), 'utf8');
  assert.doesNotMatch(disk, /sk-one|gq-two/);
  assert.equal(JSON.parse(disk).v, 2);
  assert.deepEqual(await store.getSecrets(), { openai: 'sk-one', groq: 'gq-two' });
  await store.saveSecrets({ openai: '' });
  assert.deepEqual(await store.getSecrets(), { groq: 'gq-two' });
});

test('secrets: an old plain-text file is upgraded to encrypted on first read', async (t) => {
  const { root, store } = setup(t, fakeProtect);
  const file = path.join(root, 'secrets-global.json');
  fs.writeFileSync(file, JSON.stringify({ openai: 'sk-old', junk: 1 }));
  assert.deepEqual(await store.getSecrets(), { openai: 'sk-old' });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sk-old/);
  assert.deepEqual(await store.getSecrets(), { openai: 'sk-old' });
});

test('app config merges patches', async (t) => {
  const { store } = setup(t);
  await store.saveAppConfig({ modelFolders: ['a'] });
  await store.saveAppConfig({ engineFlavour: 'vulkan' });
  assert.deepEqual(await store.getAppConfig(), { modelFolders: ['a'], engineFlavour: 'vulkan' });
});
