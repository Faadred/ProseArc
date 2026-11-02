// Fetch the llama.cpp engine that ships inside ProseArc: the Vulkan build of
// llama.cpp's current *stable* release (works on any graphics card), checked
// against GitHub's SHA-256 digest, unpacked into vendor/llama/.
//
//   node scripts/fetch-llama.js          (run before `npm run dist`)
//
// vendor/ is git-ignored; electron-builder copies vendor/llama into the
// installed app's resources (see package.json → build.extraResources).

const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { getStableBuild, flavourAssets, downloadChecked, extractZip, findServerExe, serverVersion } = require('../src/llama-release');

(async () => {
  const outDir = path.join(__dirname, '..', 'vendor', 'llama');
  const info = await getStableBuild();
  console.log(`llama.cpp stable ${info.stable} → build ${info.build} (${info.date.slice(0, 10)})`);

  try {
    const cur = JSON.parse(await fsp.readFile(path.join(outDir, 'build.json'), 'utf8'));
    if (cur.build === info.build) { console.log('Already up to date.'); return; }
  } catch { /* none yet */ }

  const [asset] = flavourAssets(info, 'vulkan');
  const zip = path.join(os.tmpdir(), asset.name);
  let last = 0;
  await downloadChecked(asset.url, zip, asset.sha256, (d, t) => {
    const pct = t ? Math.floor((d / t) * 100) : 0;
    if (pct >= last + 10) { last = pct; process.stdout.write(`  ${pct}%\n`); }
  });
  console.log('  checksum OK');

  await fsp.rm(outDir, { recursive: true, force: true });
  const binDir = path.join(outDir, 'vulkan');
  await extractZip(zip, binDir);
  await fsp.rm(zip, { force: true });

  const exe = await findServerExe(binDir);
  if (!exe) throw new Error('llama-server.exe not found in the zip');
  const ver = await serverVersion(exe);
  if (!ver) throw new Error('llama-server --version did not run');
  await fsp.writeFile(path.join(outDir, 'build.json'), JSON.stringify({
    stable: info.stable, build: info.build, flavour: 'vulkan', version: ver, exe: path.relative(outDir, exe),
  }, null, 2));
  console.log(`Done: ${path.relative(process.cwd(), exe)} (version ${ver})`);
})().catch((err) => { console.error(err.message || err); process.exit(1); });
