// Syntax check for every JavaScript file in the app (npm run check).
// `node --check a.js b.js` only checks the first file, so we run it per file.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dirs = ['.', 'src', 'scripts', 'test'];
const files = dirs.flatMap((d) => {
  const dir = path.join(root, d);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(c?js|mjs)$/.test(f)).map((f) => path.join(dir, f));
});

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed += 1; process.stderr.write(r.stderr); }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
