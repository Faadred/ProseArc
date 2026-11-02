// llama.cpp releases: find the current *stable* build and download its
// Windows zips, checked against the SHA-256 digest GitHub publishes for each
// asset. Used by scripts/fetch-llama.js (bundling) and by the app (NVIDIA
// build download, engine updates).
//
// llama.cpp tags a build per commit (b12048, …, all "prerelease"). The latest
// non-prerelease ("stable", e.g. v0.8.0) carries one asset, nightly-tag.txt,
// naming the build it vouches for (e.g. b11960). We follow that build.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO = 'ggml-org/llama.cpp';
const API = `https://api.github.com/repos/${REPO}`;
const UA = { 'User-Agent': 'ProseArc', Accept: 'application/vnd.github+json' };

// Which zip(s) make up each flavour of the engine on Windows x64.
const FLAVOURS = {
  vulkan: (b) => [`llama-${b}-bin-win-vulkan-x64.zip`],
  cuda12: (b) => [`llama-${b}-bin-win-cuda-12.4-x64.zip`, 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
  cpu: (b) => [`llama-${b}-bin-win-cpu-x64.zip`],
};

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return res.json();
}

/** { stable: 'v0.8.0', build: 'b11960', date, assets: { name: { url, size, sha256 } } } */
async function getStableBuild() {
  const latest = await getJson(`${API}/releases/latest`);
  const tagAsset = (latest.assets || []).find((a) => a.name === 'nightly-tag.txt');
  if (!tagAsset) throw new Error('Stable release has no nightly-tag.txt');
  const tagRes = await fetch(tagAsset.browser_download_url, { headers: { 'User-Agent': 'ProseArc' } });
  const build = (await tagRes.text()).trim();
  if (!/^b\d+$/.test(build)) throw new Error(`Unexpected build tag "${build}"`);
  const rel = await getJson(`${API}/releases/tags/${build}`);
  const assets = {};
  for (const a of rel.assets || []) {
    assets[a.name] = { url: a.browser_download_url, size: a.size, sha256: String(a.digest || '').replace(/^sha256:/, '') };
  }
  return { stable: latest.tag_name, build, date: rel.published_at, assets };
}

/** Asset records for a flavour of a build (throws if GitHub lacks one). */
function flavourAssets(info, flavour) {
  const names = FLAVOURS[flavour](info.build);
  return names.map((n) => {
    const a = info.assets[n];
    if (!a) throw new Error(`Build ${info.build} has no ${n}`);
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`No SHA-256 digest published for ${n}`);
    return { name: n, ...a };
  });
}

/**
 * Download `url` to `dest`, resuming a partial `dest.part`, then check its
 * SHA-256. onProgress(doneBytes, totalBytes). Throws on mismatch (and deletes).
 */
async function downloadChecked(url, dest, sha256, onProgress = () => {}, signal) {
  const part = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let have = 0;
  try { have = (await fsp.stat(part)).size; } catch { /* fresh */ }
  const res = await fetch(url, { headers: { 'User-Agent': 'ProseArc', ...(have ? { Range: `bytes=${have}-` } : {}) }, signal, redirect: 'follow' });
  if (res.status === 416) { have = 0; await fsp.rm(part, { force: true }); return downloadChecked(url, dest, sha256, onProgress, signal); }
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  if (res.status === 200 && have) { have = 0; } // server ignored Range: start over
  const total = have + Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
  let done = have;
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      done += chunk.length;
      onProgress(done, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  const got = await sha256File(part);
  if (got !== sha256) {
    await fsp.rm(part, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
  }
  await fsp.rename(part, dest);
  return dest;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Unzip with Windows' own tar.exe (bsdtar): streams from disk, no extra deps. */
function extractZip(zip, dir) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return fsp.mkdir(dir, { recursive: true }).then(() => new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true, maxBuffer: 1 << 20 }, (err) => (err ? reject(err) : resolve()));
  }));
}

/** Find llama-server.exe somewhere under dir (zips sometimes nest a folder). */
async function findServerExe(dir) {
  const want = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase() === want) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/** `llama-server --version` → the build number (e.g. 11960), or null if it won't run. */
function serverVersion(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`;
      // "version: 0.8.0-dev (build 11960, commit …)" today; "version: 11960 (…)" in older builds.
      const m = text.match(/\(build\s+(\d+)/i) || text.match(/version:\s*(\d+)\s*\(/i);
      resolve(m ? Number(m[1]) : null);
    });
  });
}

module.exports = { getStableBuild, flavourAssets, downloadChecked, extractZip, findServerExe, serverVersion, sha256File, FLAVOURS };
