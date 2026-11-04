// Folder import — find every book in a folder and the folders inside it.
//
// scanFolder(root) → a tree { name, path, rel, folders: [...], files: [...] }.
// Each folder is a series or category; each supported file is one book.
// Sorted the way people expect ("Book 2" before "Book 10"), hidden and
// system folders skipped, depth capped so a stray link can't loop forever.

const fsp = require('fs/promises');
const path = require('path');

const BOOK_EXTS = new Set(['.txt', '.md', '.markdown', '.epub', '.docx', '.pdf']);
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information']);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

async function scanFolder(root, { maxDepth = MAX_DEPTH } = {}) {
  const base = path.resolve(root);
  const st = await fsp.stat(base);
  if (!st.isDirectory()) throw new Error('Not a folder');

  async function walk(dir, rel, depth) {
    const node = { name: path.basename(dir) || dir, path: dir, rel, folders: [], files: [] };
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return node; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue; // hidden, Office lock files
      const full = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        const sub = await walk(full, childRel, depth + 1);
        if (sub.files.length || sub.folders.length) node.folders.push(sub);
      } else if (e.isFile() && BOOK_EXTS.has(path.extname(e.name).toLowerCase())) {
        let s;
        try { s = await fsp.stat(full); } catch { continue; }
        node.files.push({ name: e.name, path: full, rel: childRel, size: s.size, mtimeMs: Math.round(s.mtimeMs), ext: path.extname(e.name).toLowerCase() });
      }
    }
    node.folders.sort(byName);
    node.files.sort(byName);
    return node;
  }

  return walk(base, '', 0);
}

/**
 * Every file in the tree, in reading order (a folder's own files, then its
 * subfolders), with its series: the folder path below the root ("Fantasy /
 * Mistborn"), or the root's own name for files sitting in the root.
 */
function listBooks(tree) {
  const out = [];
  (function visit(node, trail) {
    const series = trail.length ? trail.join(' / ') : tree.name;
    for (const f of node.files) out.push({ ...f, series });
    for (const sub of node.folders) visit(sub, [...trail, sub.name]);
  })(tree, []);
  return out;
}

/** Same file as an earlier import? (path, case-insensitive on Windows). */
function sameSource(a, b) {
  if (!a || !b) return false;
  return path.resolve(a.path).toLowerCase() === path.resolve(b.path).toLowerCase();
}

/** A book name from a file name: drop the extension, turn _ and . into spaces. */
function bookName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || fileName;
}

module.exports = { scanFolder, listBooks, sameSource, bookName, BOOK_EXTS, collator };
