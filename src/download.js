// Large file download (models, engine builds): resumable (keeps <file>.part
// between runs, continues with an HTTP Range request), SHA-256 computed while
// downloading (a resumed part is hashed once first), checked before the file
// gets its real name, and refused up front when the disk is too full.
//
// Uses Node's https module rather than fetch(): on large files fetch's web
// streams ran ~13x slower here (1.4 MB/s vs 22 MB/s for the same file).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const MAX_REDIRECTS = 8;

function abortedError() { const e = new Error('aborted'); e.code = 'aborted'; return e; }

/** GET with redirects; resolves the final response (status 200/206 or an error status). */
function request(url, headers, signal, hops = 0) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortedError()); return; }
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'ProseArc', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) { reject(new Error('Too many redirects')); return; }
        resolve(request(new URL(res.headers.location, url).href, headers, signal, hops + 1));
        return;
      }
      resolve(res);
    });
    req.on('error', (err) => reject(signal && signal.aborted ? abortedError() : err));
    if (signal) signal.addEventListener('abort', () => req.destroy(abortedError()), { once: true });
  });
}

async function hashExisting(file, hash, signal) {
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    if (signal) signal.addEventListener('abort', () => rs.destroy(abortedError()), { once: true });
    rs.on('data', (d) => hash.update(d)).on('error', reject).on('end', resolve);
  });
}

async function freeBytes(dir) {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch { return Infinity; }
}

/**
 * Download url → dest, checked against sha256 (hex). size = expected bytes (optional).
 * onProgress({ done, total, speed, phase }) with phase 'download' | 'verify'.
 * Throws Error with .code: 'noSpace' | 'checksum' | 'aborted' | 'http'.
 */
async function downloadFile({ url, dest, sha256, size, signal, onProgress = () => {} }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = 0;
  try { have = (await fsp.stat(part)).size; } catch { /* fresh start */ }
  if (size && have > size) { await fsp.rm(part, { force: true }); have = 0; }

  const need = (size || 0) - have;
  if (need > 0 && (await freeBytes(path.dirname(dest))) < need + 256 * 1024 * 1024) {
    const e = new Error('Not enough free disk space'); e.code = 'noSpace'; e.needGB = Math.ceil(need / 1024 ** 3); throw e;
  }

  const hash = crypto.createHash('sha256');
  if (have) {
    onProgress({ done: have, total: size || have, speed: 0, phase: 'verify' });
    await hashExisting(part, hash, signal);
  }

  let total = size || have;
  if (!size || have < size) {
    const res = await request(url, have ? { Range: `bytes=${have}-` } : {}, signal);
    if (have && res.statusCode === 200) {
      res.resume();
      await fsp.rm(part, { force: true }); // server ignored Range: start over
      return downloadFile({ url, dest, sha256, size, signal, onProgress });
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      const e = new Error(`HTTP ${res.statusCode}`); e.code = 'http'; e.status = res.statusCode; throw e;
    }
    total = size || have + Number(res.headers['content-length'] || 0);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w', highWaterMark: 4 * 1024 * 1024 });
    let done = have;
    let windowStart = Date.now();
    let windowBytes = 0;
    let speed = 0;
    let lastEmit = 0;
    try {
      for await (const chunk of res) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        done += chunk.length;
        windowBytes += chunk.length;
        const now = Date.now();
        if (now - windowStart >= 1000) { speed = (windowBytes * 1000) / (now - windowStart); windowStart = now; windowBytes = 0; }
        if (now - lastEmit > 250) { lastEmit = now; onProgress({ done, total, speed, phase: 'download' }); }
      }
    } catch (err) {
      throw (signal && signal.aborted) ? abortedError() : err;
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (signal && signal.aborted) throw abortedError();
    if (size && done !== size) { const e = new Error('Download ended early'); e.code = 'http'; throw e; }
  }

  onProgress({ done: total, total, speed: 0, phase: 'verify' });
  const got = hash.digest('hex');
  if (got !== String(sha256).toLowerCase()) {
    await fsp.rm(part, { force: true });
    const e = new Error('Checksum mismatch'); e.code = 'checksum'; throw e;
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  return dest;
}

module.exports = { downloadFile, freeBytes };
