// Providers registry, model-file helpers (GGUF header, folder scan, fit), quant names, PC tiers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROVIDERS, byId, SECRET_FIELDS, baseUrlFor, isConfigured } = require('../src/providers');
const { readGgufMeta, scanModelFolders, fitFor } = require('../src/models');
const { quantOf } = require('../src/hub');
const { tierFor } = require('../src/hardware');
const { flavourAssets } = require('../src/llama-release');

test('providers: unique ids, every cloud one has a base URL and key link', () => {
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
  for (const p of PROVIDERS.filter((x) => x.kind === 'cloud')) {
    assert.match(p.baseUrl, /^https:\/\//, p.id);
    assert.match(p.keyUrl, /^https:\/\//, p.id);
  }
  assert.ok(SECRET_FIELDS.includes('openai'));
  assert.ok(SECRET_FIELDS.includes('lmstudioBaseUrl'));
  assert.ok(!SECRET_FIELDS.includes('builtin'));
});

test('baseUrlFor: user address wins, trailing slashes dropped', () => {
  assert.equal(baseUrlFor('lmstudio'), 'http://localhost:1234/v1');
  assert.equal(baseUrlFor('lmstudio', { lmstudioBaseUrl: ' http://pc:9000/v1/// ' }), 'http://pc:9000/v1');
  assert.equal(baseUrlFor('nope'), '');
  assert.equal(byId.anthropic.native, 'anthropic');
});

test('isConfigured', () => {
  assert.equal(isConfigured('openai', {}), false);
  assert.equal(isConfigured('openai', { openai: '  ' }), false);
  assert.equal(isConfigured('openai', { openai: 'k' }), true);
  assert.equal(isConfigured('compatible', {}), false);
  assert.equal(isConfigured('compatible', { compatibleBaseUrl: 'http://x' }), true);
  assert.equal(isConfigured('lmstudio', {}), true);
  assert.equal(isConfigured('builtin', {}), true);
  assert.equal(isConfigured('unknown', {}), false);
});

test('quantOf: common file names', () => {
  assert.equal(quantOf('Qwen3-4B-Instruct-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(quantOf('model.IQ3_XXS.gguf'), 'IQ3_XXS');
  assert.equal(quantOf('gemma-3-4b-it-UD-Q5_K_XL.gguf'), 'UD-Q5_K_XL');
  assert.equal(quantOf('tiny-bf16.gguf'), 'BF16');
  assert.equal(quantOf('weird.gguf'), '');
});

test('fitFor: graphics card, partly, processor, too big', () => {
  const gpu8 = { gpu: { vramGB: 8 }, ramGB: 16 };
  assert.equal(fitFor(4, gpu8), 'fits');
  assert.equal(fitFor(10, gpu8), 'partial');
  assert.equal(fitFor(30, gpu8), 'toobig');
  const cpu = { gpu: null, ramGB: 16 };
  assert.equal(fitFor(2.5, cpu), 'slow');
  assert.equal(fitFor(12, cpu), 'toobig');
});

test('tierFor', () => {
  assert.equal(tierFor(24, 32).key, 'large');
  assert.equal(tierFor(8, 16).maxB, 8);
  assert.equal(tierFor(0, 16).key, 'cpu');
  assert.equal(tierFor(0, 8).key, 'online');
});

// A minimal GGUF header: magic, version, tensors, KV count, then KV pairs.
function gguf(kvs) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); };
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(kvs.length));
  for (const [key, type, val] of kvs) {
    parts.push(str(key), u32(type));
    if (type === 8) parts.push(str(val));
    else if (type === 4) parts.push(u32(val));
    else if (type === 9) { parts.push(u32(8), u64(val.length), ...val.map(str)); }
  }
  return Buffer.concat(parts);
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prosearc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('readGgufMeta: strings, numbers, skips string arrays', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'm.gguf');
  fs.writeFileSync(file, gguf([
    ['general.architecture', 8, 'qwen3'],
    ['tokenizer.ggml.tokens', 9, ['a', 'b', 'c']],
    ['qwen3.context_length', 4, 32768],
    ['general.name', 8, 'Made Up 4B'],
  ]));
  assert.deepEqual(await readGgufMeta(file), {
    'general.architecture': 'qwen3',
    'qwen3.context_length': 32768,
    'general.name': 'Made Up 4B',
  });
  const notGguf = path.join(dir, 'x.gguf');
  fs.writeFileSync(notGguf, 'hello world, not a model');
  assert.equal(await readGgufMeta(notGguf), null);
});

test('scanModelFolders: nested folders, skips projectors and later split parts', async (t) => {
  const dir = tmpDir(t);
  const put = (rel) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, gguf([['general.architecture', 8, 'llama']]));
  };
  put('pub/model-a/model-a-Q4_K_M.gguf');
  put('pub/model-a/mmproj-model-a-f16.gguf');
  put('pub/big/big-Q8_0-00001-of-00002.gguf');
  put('pub/big/big-Q8_0-00002-of-00002.gguf');
  put('.hidden/secret.gguf');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
  const models = await scanModelFolders([dir, path.join(dir, 'missing')], { gpu: { vramGB: 8 }, ramGB: 16 });
  const names = models.map((m) => path.basename(m.path)).sort();
  assert.deepEqual(names, ['big-Q8_0-00001-of-00002.gguf', 'model-a-Q4_K_M.gguf']);
  for (const m of models) assert.equal(m.fit, 'fits');
});

test('flavourAssets: needs every file and a SHA-256 for each', () => {
  const sha = 'a'.repeat(64);
  const info = { build: 'b100', assets: {} };
  assert.throws(() => flavourAssets(info, 'vulkan'), /has no/);
  for (const flavour of ['vulkan', 'cuda12']) {
    const names = [];
    try { flavourAssets({ build: 'b100', assets: new Proxy({}, { get: (_o, n) => { names.push(n); return { url: 'u', size: 1, sha256: sha }; } }) }, flavour); } catch { /* collect names */ }
    assert.ok(names.length >= 1, flavour);
    const ok = { build: 'b100', assets: Object.fromEntries(names.map((n) => [n, { url: 'u', size: 1, sha256: sha }])) };
    assert.equal(flavourAssets(ok, flavour).length, names.length);
    const bad = { build: 'b100', assets: Object.fromEntries(names.map((n) => [n, { url: 'u', size: 1, sha256: '' }])) };
    assert.throws(() => flavourAssets(bad, flavour), /No SHA-256/);
  }
});
