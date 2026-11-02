const test = require('node:test');
const assert = require('node:assert/strict');
const { segment, textToBlocks, splitLongParagraph, MAX_SEGMENT_CHARS } = require('../src/segmenter');

test('textToBlocks: headings, paragraphs, quotes, lists, scene breaks', () => {
  const text = [
    '# Chapter One',
    'The first line\nwraps onto a second.',
    '> A quoted\n> passage.',
    '- apples\n- pears',
    '1. one\n2. two',
    '* * *',
    'After the break.',
  ].join('\n\n');
  assert.deepEqual(textToBlocks(text), [
    { type: 'heading', level: 1, text: 'Chapter One' },
    { type: 'paragraph', text: 'The first line wraps onto a second.' },
    { type: 'blockquote', text: 'A quoted passage.' },
    { type: 'list-item', ordered: false, text: 'apples' },
    { type: 'list-item', ordered: false, text: 'pears' },
    { type: 'list-item', ordered: true, text: 'one' },
    { type: 'list-item', ordered: true, text: 'two' },
    { type: 'scene-break', text: '' },
    { type: 'paragraph', text: 'After the break.' },
  ]);
});

test('textToBlocks: Windows line endings and blank-ish lines behave like Unix', () => {
  const unix = textToBlocks('One.\n\nTwo.');
  assert.deepEqual(textToBlocks('One.\r\n  \r\nTwo.'), unix);
  assert.deepEqual(textToBlocks(''), []);
  assert.deepEqual(textToBlocks(null), []);
});

test('textToBlocks: emphasis markers stay in the text', () => {
  assert.deepEqual(textToBlocks('She *really* meant **it**.'), [
    { type: 'paragraph', text: 'She *really* meant **it**.' },
  ]);
});

test('splitLongParagraph: groups whole sentences under the limit', () => {
  const p = 'One two three. Four five six! Seven eight nine? Ten.';
  const chunks = splitLongParagraph(p, 20);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(' '), p);
  for (const c of chunks) assert.match(c, /[.!?]$/);
});

test('splitLongParagraph: a single over-long sentence is kept whole', () => {
  const p = 'a'.repeat(50);
  assert.deepEqual(splitLongParagraph(p, 10), [p]);
});

test('segment: long prose is split, headings and lists never are', () => {
  const sentence = 'This sentence is about forty characters. ';
  const long = sentence.repeat(Math.ceil((MAX_SEGMENT_CHARS * 2) / sentence.length)).trim();
  const longHeading = `# ${'Word '.repeat(400).trim()}`;
  const segs = segment(`${longHeading}\n\n${long}`);
  assert.equal(segs[0].type, 'heading');
  assert.equal(segs[0].level, 1);
  const prose = segs.slice(1);
  assert.ok(prose.length >= 2, 'long paragraph split');
  for (const s of prose) {
    assert.equal(s.type, 'paragraph');
    assert.ok(s.original.length <= MAX_SEGMENT_CHARS);
  }
  assert.equal(prose.map((s) => s.original).join(' '), long);
});

test('segment: scene breaks become empty scene-break segments', () => {
  assert.deepEqual(segment('A.\n\n***\n\nB.'), [
    { type: 'paragraph', original: 'A.' },
    { type: 'scene-break', original: '' },
    { type: 'paragraph', original: 'B.' },
  ]);
});
