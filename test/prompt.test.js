const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessages, relevantGlossary, effectiveGlossary } = require('../src/prompt');

const project = (over = {}) => ({
  sourceLang: 'English',
  targetLang: 'Arabic',
  contextWindow: 2,
  glossary: [],
  segments: [
    { id: 0, type: 'heading', original: 'Chapter 1', translation: 'الفصل 1', status: 'reviewed' },
    { id: 1, type: 'paragraph', original: 'Anna met Ben.', translation: 'قابلت آنا بن.', status: 'translated' },
    { id: 2, type: 'paragraph', original: 'Old text.', translation: 'stale', status: 'pending' },
    { id: 3, type: 'paragraph', original: 'Ben smiled at Anna.', translation: '', status: 'pending' },
  ],
  ...over,
});

test('effectiveGlossary: project terms override shared ones (case-insensitive)', () => {
  const merged = effectiveGlossary(
    [{ source: 'ben', target: 'بِن' }],
    [{ source: 'Ben', target: 'بن' }, { source: 'Anna', target: 'آنا' }, { target: 'no source' }],
  );
  assert.deepEqual(merged.map((g) => g.target).sort(), ['آنا', 'بِن']);
});

test('relevantGlossary: only terms that appear in the passage', () => {
  const g = [{ source: 'Anna', target: 'آنا' }, { source: 'Carl', target: 'كارل' }];
  assert.deepEqual(relevantGlossary(g, 'anna laughed'), [g[0]]);
  assert.deepEqual(relevantGlossary([], 'x'), []);
});

test('buildMessages: system prompt, glossary, context and the passage', () => {
  const p = project({ styleBrief: '  Keep it formal.  ', glossary: [{ source: 'Anna', target: 'آنا' }] });
  const msgs = buildMessages(p, 3, [{ source: 'Ben', target: 'بن' }, { source: 'Zed', target: 'زد' }]);
  const [system, context, ack, ask] = msgs;
  assert.equal(msgs.length, 4);
  assert.equal(system.role, 'system');
  assert.match(system.content, /from English into Arabic/);
  assert.match(system.content, /Translation brief for this book \(follow it\):\nKeep it formal\./);
  assert.match(system.content, /"Anna" → "آنا"/);
  assert.match(system.content, /"Ben" → "بن"/);
  assert.doesNotMatch(system.content, /Zed/);
  // Context: the 2 previous translated segments, skipping the pending one.
  assert.equal(context.role, 'user');
  assert.match(context.content, /^CONTEXT ONLY/);
  assert.match(context.content, /الفصل 1\n\nقابلت آنا بن\./);
  assert.doesNotMatch(context.content, /stale/);
  assert.equal(ack.role, 'assistant');
  assert.equal(ask.role, 'user');
  assert.ok(ask.content.endsWith('\n\nBen smiled at Anna.'));
});

test('buildMessages: no context when the window is 0 or nothing precedes', () => {
  assert.equal(buildMessages(project({ contextWindow: 0 }), 3).length, 2);
  assert.equal(buildMessages(project(), 0).length, 2);
});

test('buildMessages: headings get a heading hint', () => {
  const [system] = buildMessages(project(), 0);
  assert.match(system.content, /HEADING/);
});
