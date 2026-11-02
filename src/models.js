// Model files (.gguf) on this PC: scan the user's model folders (nested any
// way, e.g. LM Studio's models/<publisher>/<model>/<file>.gguf), read each
// file's GGUF header for its name, size class and context length, and rate
// how well it fits this PC.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_DEPTH = 6;
const GB = 1024 ** 3;

// Not translation models: vision projectors, speculative/MTP heads, LoRA adapters.
const SKIP_FILE = /(^|[-_.])(mmproj|mtp|draft|lora|adapter|imatrix)([-_.]|$)/i;
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;

async function walk(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth + 1, out);
    else if (e.isFile() && /\.gguf$/i.test(e.name)) out.push(p);
  }
}

// ---- GGUF header (just the small metadata keys we need) ----------------------
// Layout: "GGUF", u32 version, u64 tensor_count, u64 kv_count, then KV pairs:
// string key, u32 type, value. Strings are u64 length + bytes. We read the
// first 2 MB and stop at the first big array (the tokenizer) we can't use.
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12 };
const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

async function readGgufMeta(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(2 * 1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.toString('latin1', 0, 4) !== 'GGUF') return null;
    let o = 8; // magic + version
    o += 8;   // tensor count
    const kvCount = Number(b.readBigUInt64LE(o)); o += 8;
    const meta = {};
    const str = () => { const n = Number(b.readBigUInt64LE(o)); o += 8; const s = b.toString('utf8', o, o + n); o += n; return s; };
    const scalar = (type) => {
      switch (type) {
        case T.U8: return b.readUInt8(o);
        case T.I8: return b.readInt8(o);
        case T.U16: return b.readUInt16LE(o);
        case T.I16: return b.readInt16LE(o);
        case T.U32: return b.readUInt32LE(o);
        case T.I32: return b.readInt32LE(o);
        case T.F32: return b.readFloatLE(o);
        case T.BOOL: return b.readUInt8(o) !== 0;
        case T.U64: return Number(b.readBigUInt64LE(o));
        case T.I64: return Number(b.readBigInt64LE(o));
        case T.F64: return b.readDoubleLE(o);
        default: throw new Error('type');
      }
    };
    for (let i = 0; i < kvCount; i++) {
      if (o + 16 > b.length) break;
      const key = str();
      const type = b.readUInt32LE(o); o += 4;
      if (type === T.STR) { meta[key] = str(); continue; }
      if (type === T.ARR) {
        const et = b.readUInt32LE(o); o += 4;
        const n = Number(b.readBigUInt64LE(o)); o += 8;
        if (et === T.STR) { for (let k = 0; k < n; k++) { if (o + 8 > b.length) return meta; str(); } }
        else if (SIZE[et]) o += n * SIZE[et];
        else return meta;
        if (o > b.length) return meta;
        continue;
      }
      if (!(type in SIZE)) return meta;
      meta[key] = scalar(type);
      o += SIZE[type];
    }
    return meta;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

function quantFromName(name) {
  const m = name.match(/(I?Q\d(?:_[0-9A-Z]+)*|BF16|F16|F32|MXFP4)(?=[.\-_]|$)/i);
  return m ? m[1].toUpperCase() : '';
}

/** Rate a file for this PC: 'fits' | 'partial' | 'slow' | 'toobig'. */
function fitFor(sizeGB, sys) {
  const vram = sys && sys.gpu ? sys.gpu.vramGB : 0;
  const ram = sys ? sys.ramGB : 0;
  const need = sizeGB + 1.5; // weights + room for context
  if (vram && need <= vram * 0.95) return 'fits';
  if (vram && need <= vram + ram * 0.5) return 'partial';
  if (!vram && need <= ram * 0.6) return 'slow';
  return 'toobig';
}

/** Scan folders → [{ path, file, folder, name, arch, params, quant, sizeGB, ctx, fit }] */
async function scanModelFolders(folders, sys) {
  const files = [];
  for (const f of folders || []) await walk(f, 0, files);
  const seen = new Set();
  const models = [];
  for (const file of files) {
    const base = path.basename(file);
    if (SKIP_FILE.test(base.replace(/\.gguf$/i, ''))) continue;
    const split = base.match(SPLIT);
    if (split && split[1] !== '00001') continue; // later parts load with the first
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let bytes = 0;
    try {
      if (split) {
        const total = Number(split[2]);
        for (let k = 1; k <= total; k++) {
          const part = file.replace(SPLIT, `-${String(k).padStart(5, '0')}-of-${split[2]}.gguf`);
          bytes += fs.statSync(part).size;
        }
      } else {
        bytes = fs.statSync(file).size;
      }
    } catch { continue; } // incomplete download / missing parts
    const meta = (await readGgufMeta(file)) || {};
    const arch = meta['general.architecture'] || '';
    if (/embed|bert|clip|whisper|wav|t5encoder/i.test(arch)) continue;
    const sizeGB = Math.round((bytes / GB) * 10) / 10;
    models.push({
      path: file,
      file: base,
      folder: path.basename(path.dirname(file)),
      name: meta['general.name'] || base.replace(/\.gguf$/i, '').replace(SPLIT, ''),
      arch,
      params: meta['general.size_label'] || '',
      quant: quantFromName(base),
      ctx: meta[`${arch}.context_length`] || 0,
      sizeGB,
      fit: fitFor(sizeGB, sys),
    });
  }
  models.sort((a, b) => a.name.localeCompare(b.name) || a.sizeGB - b.sizeGB);
  return models;
}

module.exports = { scanModelFolders, readGgufMeta, fitFor };
