// The one downloader (models, engine builds), against a local HTTP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { downloadFile } = require('../src/download');

const DATA = crypto.randomBytes(300 * 1024);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');

// Serves DATA at /file (honours Range unless ?norange), redirects /moved → /file.
function startServer(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range || null });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/moved') { res.writeHead(302, { Location: '/file' }); res.end(); return; }
    if (url.pathname !== '/file') { res.writeHead(404); res.end(); return; }
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m && !url.searchParams.has('norange')) {
      const from = Number(m[1]);
      res.writeHead(206, { 'Content-Length': DATA.length - from });
      res.end(DATA.subarray(from));
    } else {
      res.writeHead(200, { 'Content-Length': DATA.length });
      res.end(DATA);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => server.close());
    resolve({ base: `http://127.0.0.1:${server.address().port}`, seen });
  }));
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prosearc-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('downloads, follows a redirect, checks SHA-256, renames from .part', async (t) => {
  const { base } = await startServer(t);
  const dest = path.join(tmpDir(t), 'sub', 'model.gguf');
  const phases = new Set();
  await downloadFile({ url: `${base}/moved`, dest, sha256: SHA.toUpperCase(), size: DATA.length, onProgress: (p) => phases.add(p.phase) });
  assert.ok(fs.readFileSync(dest).equals(DATA));
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.ok(phases.has('verify'));
});

test('resumes a .part file with a Range request', async (t) => {
  const { base, seen } = await startServer(t);
  const dest = path.join(tmpDir(t), 'model.gguf');
  fs.writeFileSync(`${dest}.part`, DATA.subarray(0, 100 * 1024));
  await downloadFile({ url: `${base}/file`, dest, sha256: SHA, size: DATA.length });
  assert.equal(seen.at(-1).range, `bytes=${100 * 1024}-`);
  assert.ok(fs.readFileSync(dest).equals(DATA));
});

test('starts over when the server ignores Range', async (t) => {
  const { base, seen } = await startServer(t);
  const dest = path.join(tmpDir(t), 'model.gguf');
  fs.writeFileSync(`${dest}.part`, DATA.subarray(0, 1000));
  await downloadFile({ url: `${base}/file?norange`, dest, sha256: SHA, size: DATA.length });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].range, null);
  assert.ok(fs.readFileSync(dest).equals(DATA));
});

test('a wrong checksum fails and leaves nothing behind', async (t) => {
  const { base } = await startServer(t);
  const dest = path.join(tmpDir(t), 'model.gguf');
  await assert.rejects(downloadFile({ url: `${base}/file`, dest, sha256: '0'.repeat(64), size: DATA.length }), { code: 'checksum' });
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('an HTTP error is reported with its status', async (t) => {
  const { base } = await startServer(t);
  const dest = path.join(tmpDir(t), 'model.gguf');
  await assert.rejects(downloadFile({ url: `${base}/nothing`, dest, sha256: SHA }), { code: 'http', status: 404 });
});

test('cancelling stops the download', async (t) => {
  const { base } = await startServer(t);
  const dest = path.join(tmpDir(t), 'model.gguf');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(downloadFile({ url: `${base}/file`, dest, sha256: SHA, signal: ac.signal }), { code: 'aborted' });
  assert.equal(fs.existsSync(dest), false);
});
