// EPUB import — read an .epub (a ZIP of XHTML) into typed blocks.
//
// We follow the OPF spine (the publisher's reading order), parse each chapter's
// XHTML through the shared HTML→blocks converter, and concatenate. Structure
// (chapters, headings, emphasis, scene breaks) is preserved. Uses JSZip, which
// the EPUB exporter already depends on — no new runtime dependency.

const JSZip = require('jszip');
const { htmlToBlocks } = require('./html-to-blocks');

// Resolve an href relative to the OPF's directory, normalizing ./ and ../.
function resolvePath(baseDir, href) {
  const clean = decodeURIComponent(String(href).split('#')[0]);
  const out = [];
  for (const part of (baseDir + clean).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

async function readText(zip, zipPath) {
  let file = zip.file(zipPath) || zip.file(decodeURIComponent(zipPath));
  if (!file) {
    // Last resort: case-insensitive match (some EPUBs are sloppy).
    const lower = zipPath.toLowerCase();
    const hit = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
    if (hit) file = zip.file(hit);
  }
  if (!file) throw new Error(`Missing in EPUB: ${zipPath}`);
  return file.async('string');
}

// XML entities in OPF text (e.g. a title "Romeo &amp; Juliet").
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return XML_ENT[e.toLowerCase()] ?? m;
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
        || tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? m[1] : null;
}

/**
 * Parse an EPUB buffer into { title, blocks, cover } (cover: base64 image
 * bytes of the book's cover art, or null when the EPUB has none).
 * @param {Buffer|Uint8Array} buffer
 */
async function epubToBlocks(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  // 1. container.xml points at the OPF package document.
  const container = await readText(zip, 'META-INF/container.xml');
  const opfPath = attr(container.match(/<rootfile\b[^>]*>/i)?.[0] || '', 'full-path');
  if (!opfPath) throw new Error('Invalid EPUB: no OPF root file');

  const opf = await readText(zip, opfPath);
  const baseDir = opfPath.includes('/') ? opfPath.replace(/\/[^/]*$/, '/') : '';

  // 2. Manifest: id → { href, media }.
  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id && href) manifest[id] = { href, media: attr(tag, 'media-type') || '' };
  }

  // 3. Spine: ordered idrefs into the manifest.
  const spine = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(m[0], 'idref');
    if (idref && manifest[idref]) spine.push(manifest[idref]);
  }

  // Title (best-effort) for a sensible default project name.
  const title = decodeXml((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

  // Cover image (best-effort): EPUB 3 properties="cover-image", then the
  // EPUB 2 <meta name="cover"> pointer, then a filename that looks like one.
  let cover = null;
  try {
    let coverItem = null;
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const props = attr(m[0], 'properties') || '';
      if (/\bcover-image\b/i.test(props)) {
        coverItem = { href: attr(m[0], 'href'), media: attr(m[0], 'media-type') || '' };
        break;
      }
    }
    if (!coverItem) {
      const metaTag = opf.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i)?.[0];
      const coverId = metaTag && attr(metaTag, 'content');
      if (coverId && manifest[coverId]) coverItem = manifest[coverId];
    }
    if (!coverItem) {
      coverItem = Object.values(manifest).find(
        (it) => /^image\//i.test(it.media) && /cover/i.test(it.href)
      ) || null;
    }
    if (coverItem && coverItem.href) {
      const zipPath = resolvePath(baseDir, coverItem.href);
      const file = zip.file(zipPath) || zip.file(decodeURIComponent(zipPath));
      if (file) cover = await file.async('base64'); // image bytes, base64
    }
  } catch { /* a bad cover never blocks the import */ }

  // 4. Walk the spine in order, parsing each XHTML document.
  const blocks = [];
  for (const item of spine) {
    if (item.media && !/html/i.test(item.media)) continue; // skip images, css, etc.
    let html;
    try { html = await readText(zip, resolvePath(baseDir, item.href)); }
    catch { continue; } // a missing chapter shouldn't abort the whole import
    blocks.push(...htmlToBlocks(html));
  }

  return { title, blocks, cover };
}

module.exports = { epubToBlocks };
