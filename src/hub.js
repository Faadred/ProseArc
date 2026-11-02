// Hugging Face: find GGUF models, list a repo's model files, rate each for
// this PC, and suggest one. Plain web API, no account needed (gated and
// private repos are left out: they need a login).

const { fitFor } = require('./models');

const API = 'https://huggingface.co/api';
const GB = 1024 ** 3;

// Not translation models.
const SKIP_PIPELINES = new Set([
  'feature-extraction', 'sentence-similarity', 'automatic-speech-recognition', 'text-to-speech', 'text-to-audio',
  'audio-to-audio', 'audio-classification', 'text-classification', 'token-classification', 'image-classification',
  'text-to-image', 'image-to-image', 'image-to-video', 'text-to-video', 'text-ranking', 'zero-shot-classification',
  'object-detection', 'depth-estimation', 'image-segmentation',
]);
const SKIP_REPO = /embed|rerank|whisper|tts|speech|ocr|vae|diffusion|flux|sdxl|yue|music|audio|voice|vits|bark|kokoro|wan2|video/i;
// Inside a repo: only full models (no vision projectors, MTP/draft heads, imatrix data, later split parts).
const SKIP_FILE = /(^|[\/_.-])(mmproj|mtp|draft|imatrix|lora)([\/_.-]|$)/i;
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;

async function getJson(url, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ProseArc' }, signal });
  if (!res.ok) { const e = new Error(`Hugging Face ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

/** Search GGUF repos, most downloaded first → [{ id, author, downloads, likes, updated, pipeline }] */
async function searchModels(query, { limit = 40 } = {}) {
  const q = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(limit * 2) });
  if (query && query.trim()) q.set('search', query.trim());
  for (const k of ['gated', 'private', 'downloads', 'likes', 'pipeline_tag', 'lastModified']) q.append('expand[]', k);
  const rows = await getJson(`${API}/models?${q}`);
  return rows
    .filter((r) => !r.private && !r.gated)
    .filter((r) => !SKIP_PIPELINES.has(r.pipeline_tag) && !SKIP_REPO.test(r.id))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      author: r.id.split('/')[0],
      name: r.id.split('/').slice(1).join('/'),
      downloads: r.downloads || 0,
      likes: r.likes || 0,
      updated: r.lastModified || '',
      pipeline: r.pipeline_tag || '',
    }));
}

function quantOf(file) {
  const m = file.match(/(?:^|[-_.])((?:UD-)?I?Q\d(?:_[0-9A-Z]+)*|BF16|F16|F32|MXFP4)(?=\.gguf$|[-_.])/i);
  return m ? m[1].toUpperCase() : '';
}

/**
 * A repo's model files → [{ path, file, size, sizeGB, sha256, quant, fit, recommended }].
 * Files without an LFS SHA-256 can't be checked after download, so they're left out.
 */
async function listRepoFiles(repo, sys) {
  const tree = await getJson(`${API}/models/${repo}/tree/main?recursive=true`);
  const files = tree
    .filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path))
    .filter((f) => !SKIP_FILE.test(f.path) && !SPLIT.test(f.path))
    .filter((f) => f.lfs && /^[0-9a-f]{64}$/.test(f.lfs.oid || ''))
    .map((f) => {
      const size = f.lfs.size || f.size || 0;
      const sizeGB = Math.round((size / GB) * 10) / 10;
      return {
        path: f.path,
        file: f.path.split('/').pop(),
        size,
        sizeGB,
        sha256: f.lfs.oid,
        quant: quantOf(f.path.split('/').pop()),
        fit: fitFor(sizeGB, sys),
      };
    })
    .sort((a, b) => a.size - b.size);
  const rec = recommend(files);
  for (const f of files) f.recommended = !!rec && f.path === rec.path;
  return files;
}

// Q4_K_M first (the usual best balance), then other 4–5-bit quants that fit,
// the largest that fits, else the smallest file.
function recommend(files) {
  if (!files.length) return null;
  const fits = files.filter((f) => f.fit === 'fits');
  const pref = ['Q4_K_M', 'UD-Q4_K_XL', 'Q4_K_S', 'Q5_K_M', 'IQ4_XS', 'Q4_0'];
  for (const q of pref) {
    const f = fits.find((x) => x.quant === q);
    if (f) return f;
  }
  if (fits.length) return fits[fits.length - 1];
  const partly = files.filter((f) => f.fit === 'partial');
  const q4 = partly.find((x) => x.quant === 'Q4_K_M');
  return q4 || files[0];
}

module.exports = { searchModels, listRepoFiles, quantOf };
