const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { buildExport, buildHtmlDocument, buildEpub, isRtl } = require('../src/exporter');
const { epubToBlocks } = require('../src/epub');

const book = () => ({
  name: 'A <Made-up> Book',
  sourceLang: 'English',
  targetLang: 'Arabic',
  segments: [
    { type: 'heading', level: 1, original: 'Chapter 1', translation: 'الفصل 1' },
    { type: 'paragraph', original: 'She was *very* tired.', translation: 'كانت *متعبة* جدًا.' },
    { type: 'scene-break', original: '' },
    { type: 'blockquote', original: 'A quote.', translation: 'اقتباس.' },
    { type: 'list-item', ordered: true, original: 'one', translation: 'واحد' },
    { type: 'list-item', ordered: true, original: 'two', translation: 'اثنان' },
    { type: 'paragraph', original: 'Not translated yet.', translation: '   ' },
  ],
});

test('isRtl', () => {
  assert.equal(isRtl('Arabic'), true);
  assert.equal(isRtl(' hebrew '), true);
  assert.equal(isRtl('English'), false);
  assert.equal(isRtl(undefined), false);
});

test('buildExport txt: plain prose, original as fallback, untranslated counted', () => {
  const { text, total, untranslated } = buildExport(book(), 'txt');
  assert.equal(total, 7);
  assert.equal(untranslated, 1); // the scene break doesn't count
  assert.equal(text, 'الفصل 1\n\nكانت متعبة جدًا.\n\n* * *\n\nاقتباس.\n\n- واحد\n\n- اثنان\n\nNot translated yet.\n');
});

test('buildExport md: keeps Markdown structure', () => {
  const { text } = buildExport(book(), 'md');
  assert.match(text, /^# الفصل 1\n\nكانت \*متعبة\* جدًا\.\n\n\* \* \*\n\n> اقتباس\.\n\n1\. واحد/);
});

test('buildHtmlDocument: RTL, escaped title, emphasis and one list', () => {
  const html = buildHtmlDocument(book());
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /A &lt;Made-up&gt; Book/);
  assert.match(html, /<em>متعبة<\/em>/);
  assert.match(html, /<ol>\n {2}<li>واحد<\/li>\n {2}<li>اثنان<\/li>\n {2}<\/ol>/);
  assert.match(html, /class="scene-break"/);
});

test('buildEpub: valid layout, and it imports back with the same text', async () => {
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const buf = await buildEpub(book(), cover);
  const zip = await JSZip.loadAsync(buf);
  // mimetype must be the first entry, stored uncompressed.
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  assert.equal(await zip.file('mimetype').async('string'), 'application/epub+zip');
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.match(opf, /page-progression-direction="rtl"/);
  assert.match(opf, /properties="cover-image"/);

  const back = await epubToBlocks(buf);
  assert.equal(back.title, 'A <Made-up> Book');
  assert.equal(Buffer.from(back.cover, 'base64').toString('hex'), 'ffd8ffd9');
  const texts = back.blocks.map((b) => b.type + ':' + (b.text || ''));
  assert.deepEqual(texts, [
    'heading:A <Made-up> Book', // the title page heading
    'heading:الفصل 1',
    'paragraph:كانت *متعبة* جدًا.',
    'scene-break:',
    'blockquote:اقتباس.',
    'list-item:واحد',
    'list-item:اثنان',
    'paragraph:Not translated yet.',
  ]);
});
