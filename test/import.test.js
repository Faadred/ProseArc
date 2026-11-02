// HTML → blocks, and the EPUB / DOCX importers built on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { htmlToBlocks, isSceneText } = require('../src/html-to-blocks');
const { epubToBlocks } = require('../src/epub');
const { docxToBlocks } = require('../src/docx');

test('htmlToBlocks: structure and inline emphasis', () => {
  const html = `<html><head><title>x</title><style>p{}</style></head><body>
    <nav><p>Contents</p></nav>
    <h2>Chapter <em>Two</em></h2>
    <p>Plain <i>italic</i> and <b>bold</b> and <a href="#">a link</a>.</p>
    <div><p>Inside a wrapper div.</p></div>
    <blockquote><p>First quote.</p><p>Second quote.</p></blockquote>
    <ol><li>one</li><li>two</li></ol>
    <p>* * *</p>
    <hr/>
    <pre>line one
line two</pre>
    <p>   </p>
  </body></html>`;
  assert.deepEqual(htmlToBlocks(html), [
    { type: 'heading', level: 2, text: 'Chapter *Two*' },
    { type: 'paragraph', text: 'Plain *italic* and **bold** and a link.' },
    { type: 'paragraph', text: 'Inside a wrapper div.' },
    { type: 'blockquote', text: 'First quote.' },
    { type: 'blockquote', text: 'Second quote.' },
    { type: 'list-item', ordered: true, text: 'one' },
    { type: 'list-item', ordered: true, text: 'two' },
    { type: 'scene-break', text: '' },
    { type: 'scene-break', text: '' },
    { type: 'verse', text: 'line one\nline two' },
  ]);
});

test('htmlToBlocks: entities are decoded', () => {
  assert.deepEqual(htmlToBlocks('<p>Tom &amp; Jerry &#8212; &quot;hi&quot;</p>'), [
    { type: 'paragraph', text: 'Tom & Jerry — "hi"' },
  ]);
});

test('isSceneText', () => {
  for (const s of ['* * *', '***', '⁂', '- - -', '~~~', '• • •']) assert.equal(isSceneText(s), true, s);
  for (const s of ['', 'Hello', '*', 'A * B']) assert.equal(isSceneText(s), false, s);
});

async function makeEpub({ coverProp = true } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml',
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf', `<?xml version="1.0"?>
<package><metadata><dc:title>A  Made-up &amp; &#x645;   Book</dc:title></metadata>
<manifest>
  <item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/>
  <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  <item id="css" href="style.css" media-type="text/css"/>
  <item id="img" href="images/front.jpg" media-type="image/jpeg"${coverProp ? ' properties="cover-image"' : ''}/>
  <item id="gone" href="text/missing.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="css"/><itemref idref="gone"/><itemref idref="c2"/></spine>
</package>`);
  zip.file('OPS/text/ch1.xhtml', '<html><body><h1>One</h1><p>First <em>chapter</em>.</p></body></html>');
  zip.file('OPS/text/ch 2.xhtml', '<html><body><h1>Two</h1><p>Second chapter.</p></body></html>');
  zip.file('OPS/images/front.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('epubToBlocks: follows the spine, skips non-HTML and missing files, finds the cover', async () => {
  const { title, blocks, cover } = await epubToBlocks(await makeEpub());
  assert.equal(title, 'A Made-up & م Book');
  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: 'One' },
    { type: 'paragraph', text: 'First *chapter*.' },
    { type: 'heading', level: 1, text: 'Two' },
    { type: 'paragraph', text: 'Second chapter.' },
  ]);
  assert.equal(Buffer.from(cover, 'base64').toString('hex'), 'ffd8ffd9');
});

test('epubToBlocks: no cover when nothing marks one', async () => {
  const { cover } = await epubToBlocks(await makeEpub({ coverProp: false }));
  // "front.jpg" doesn't say cover and there's no pointer: no cover, no crash.
  assert.equal(cover, null);
});

test('epubToBlocks: rejects a ZIP with no OPF', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container></container>');
  await assert.rejects(epubToBlocks(await zip.generateAsync({ type: 'nodebuffer' })), /no OPF/);
});

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">It was </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>very</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>dark</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('docxToBlocks: headings and emphasis come through', async () => {
  const { blocks } = await docxToBlocks(await makeDocx());
  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: 'Chapter One' },
    { type: 'paragraph', text: 'It was *very* **dark**.' },
  ]);
});
