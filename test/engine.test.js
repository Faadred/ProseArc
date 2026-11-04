// The translation run, against a fake AI server on 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createStore } = require('../src/store');
const { createEngine } = require('../src/engine');

// handler(reqInfo) → { status, body } ; reqInfo = { path, headers, body }
function startServer(t, handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const info = { path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      calls.push(info);
      const out = await handler(info, calls.length);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => server.close());
    resolve({ base: `http://127.0.0.1:${server.address().port}`, calls });
  }));
}

const passageOf = (body) => {
  const last = body.messages[body.messages.length - 1].content;
  return last.slice(last.lastIndexOf('\n\n') + 2);
};
const openaiReply = (text) => ({ body: { choices: [{ message: { content: text } }] } });

async function setup(t, { provider = 'lmstudio', text = 'One.\n\nTwo.\n\nOne.', secrets = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prosearc-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = createStore(path.join(root, 'projects'));
  // Keys and addresses go straight to the engine (the real store keeps an
  // address only for local apps), so every request stays on 127.0.0.1.
  const store = { ...real, getSecrets: async () => ({ ...secrets }) };
  const project = await store.createProject({ name: 'Test', text, settings: { provider, model: 'm', contextWindow: 1 } });
  const engine = createEngine({ store, builtin: null });
  return { store, engine, project };
}

// Run the engine and collect its events until it finishes.
async function run(engine, fn) {
  const events = [];
  await fn({ send: (_ch, e) => events.push(e) });
  return events;
}
const last = (events) => events.filter((e) => e.type === 'done' || e.type === 'error').at(-1);

test('local app: translates every pending segment once, saves, sends no-thinking switch', async (t) => {
  const { base, calls } = await startServer(t, ({ body }) => openaiReply(`<think>hmm</think>[${passageOf(body)}]`));
  const { store, engine, project } = await setup(t, { secrets: { lmstudioBaseUrl: `${base}/v1` } });
  const events = await run(engine, (s) => engine.start(project.id, s));

  assert.deepEqual(last(events), { type: 'done', reason: 'completed', counts: { total: 3, translated: 3, reviewed: 0 }, projectId: project.id });
  assert.ok(events.every((e) => e.projectId === project.id), 'every event names its book');
  assert.equal(calls.length, 2, 'the repeated "One." is translated once');
  assert.equal(calls[0].path, '/v1/chat/completions');
  assert.equal(calls[0].body.reasoning_effort, 'none');
  assert.equal(calls[0].body.model, 'm');
  assert.equal(calls[0].headers.authorization, undefined);
  const saved = await store.getProject(project.id);
  assert.deepEqual(saved.segments.map((s) => [s.translation, s.status]), [
    ['[One.]', 'translated'], ['[Two.]', 'translated'], ['[One.]', 'translated'],
  ]);
});

test('a server that rejects the no-thinking switch is asked again without it', async (t) => {
  const { base, calls } = await startServer(t, ({ body }) => (body.reasoning_effort
    ? { status: 400, body: { error: 'unknown field reasoning_effort' } }
    : openaiReply('ok')));
  const { engine, project } = await setup(t, { text: 'A.\n\nB.', secrets: { lmstudioBaseUrl: `${base}/v1` } });
  const events = await run(engine, (s) => engine.start(project.id, s));
  assert.equal(last(events).reason, 'completed');
  // First segment: with, then without. Second: without from the start.
  assert.deepEqual(calls.map((c) => 'reasoning_effort' in c.body), [true, false, false]);
});

test('an edit made in Review during the run is never overwritten', async (t) => {
  let store; let project;
  const { base } = await startServer(t, async ({ body }, n) => {
    if (n === 1) await store.updateSegment(project.id, 1, { translation: 'USER EDIT', status: 'reviewed' });
    return openaiReply(`[${passageOf(body)}]`);
  });
  ({ store, project } = await setup(t, { text: 'A.\n\nB.\n\nC.', secrets: { lmstudioBaseUrl: `${base}/v1` } }));
  const engine = createEngine({ store, builtin: null });
  await run(engine, (s) => engine.start(project.id, s));
  const saved = await store.getProject(project.id);
  assert.deepEqual(saved.segments.map((s) => [s.translation, s.status]), [
    ['[A.]', 'translated'], ['USER EDIT', 'reviewed'], ['[C.]', 'translated'],
  ]);
});

test('online provider without a key: clear error, no request sent', async (t) => {
  const { base, calls } = await startServer(t, () => openaiReply('x'));
  const { engine, project } = await setup(t, { provider: 'openai', secrets: { openaiBaseUrl: base } });
  const events = await run(engine, (s) => engine.start(project.id, s));
  assert.equal(last(events).type, 'error');
  assert.equal(last(events).key, 'noKey');
  assert.equal(calls.length, 0);
});

test('a rejected key (401) stops at once with "bad key", no retries', async (t) => {
  const { base, calls } = await startServer(t, () => ({ status: 401, body: { error: 'nope' } }));
  const { store, engine, project } = await setup(t, { provider: 'groq', secrets: { groq: 'gq-test', groqBaseUrl: base } });
  const events = await run(engine, (s) => engine.start(project.id, s));
  assert.equal(last(events).key, 'badKey');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer gq-test');
  assert.equal('reasoning_effort' in calls[0].body, false, 'online providers never get the local switch');
  const saved = await store.getProject(project.id);
  assert.ok(saved.segments.every((s) => s.status === 'pending'));
});

test('a server error is retried, then the run carries on', async (t) => {
  const { base, calls } = await startServer(t, ({ body }, n) => (n === 1 ? { status: 503, body: 'busy' } : openaiReply(`[${passageOf(body)}]`)));
  const { engine, project } = await setup(t, { text: 'Only one.', secrets: { lmstudioBaseUrl: `${base}/v1` } });
  const events = await run(engine, (s) => engine.start(project.id, s));
  assert.equal(last(events).reason, 'completed');
  assert.equal(calls.length, 2);
  assert.ok(events.some((e) => e.key === 'retry' && e.params.reason === 'HTTP 503'));
});

test('Claude uses the native Messages API', async (t) => {
  const { base, calls } = await startServer(t, ({ body }) => ({ body: { content: [{ type: 'text', text: `[${passageOf(body)}]` }] } }));
  const { store, engine, project } = await setup(t, { provider: 'anthropic', text: 'Hi.', secrets: { anthropic: 'sk-ant-test', anthropicBaseUrl: base } });
  const events = await run(engine, (s) => engine.start(project.id, s));
  assert.equal(last(events).reason, 'completed');
  assert.equal(calls[0].path, '/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test');
  assert.match(calls[0].body.system, /literary translator/);
  assert.ok(calls[0].body.messages.every((m) => m.role !== 'system'));
  assert.equal((await store.getProject(project.id)).segments[0].translation, '[Hi.]');
});

test('retranslateSegment redoes just one segment', async (t) => {
  const { base, calls } = await startServer(t, () => openaiReply('again'));
  const { store, engine, project } = await setup(t, { text: 'A.\n\nB.', secrets: { lmstudioBaseUrl: `${base}/v1` } });
  await store.updateSegment(project.id, 0, { translation: 'old', status: 'reviewed' });
  const events = await run(engine, (s) => engine.retranslateSegment(project.id, 0, s));
  assert.equal(last(events).reason, 'completed');
  assert.equal(calls.length, 1);
  const saved = await store.getProject(project.id);
  assert.deepEqual(saved.segments.map((s) => [s.translation, s.status]), [['again', 'translated'], ['', 'pending']]);
});

test('series glossary: book terms win over series terms, series terms over shared ones', async (t) => {
  const { base, calls } = await startServer(t, () => openaiReply('ok'));
  const { store, engine, project } = await setup(t, { text: 'Mara met Oren by the Lantern.', secrets: { lmstudioBaseUrl: `${base}/v1` } });
  // The book belongs to a series (a folder import).
  const p = await store.getProject(project.id);
  p.series = 'Fantasy / The Glass Lantern';
  p.glossary = [{ id: 'b1', source: 'Oren', target: 'BOOK-Oren' }];
  await store.saveProject(p);
  await store.saveGlobalGlossary([
    { id: 'g1', source: 'Mara', target: 'SHARED-Mara' },
    { id: 'g2', source: 'Oren', target: 'SHARED-Oren' },
    { id: 'g3', source: 'Lantern', target: 'SHARED-Lantern' },
  ]);
  await store.saveSeriesGlossary('Fantasy / The Glass Lantern', [
    { id: 's1', source: 'Mara', target: 'SERIES-Mara' },
    { id: 's2', source: 'Oren', target: 'SERIES-Oren' },
  ]);
  await store.saveSeriesGlossary('Another series', [{ id: 'x', source: 'Lantern', target: 'OTHER-Lantern' }]);
  await run(engine, (s) => engine.start(project.id, s));
  const system = calls[0].body.messages[0].content;
  assert.match(system, /"Mara" → "SERIES-Mara"/);
  assert.match(system, /"Oren" → "BOOK-Oren"/);
  assert.match(system, /"Lantern" → "SHARED-Lantern"/);
  assert.doesNotMatch(system, /SHARED-Mara|SERIES-Oren|SHARED-Oren|OTHER-/);
});
