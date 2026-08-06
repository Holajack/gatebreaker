// Inventories assets/ so we can both see exactly what has landed, and flags
// anything that will cause trouble on a phone before it is wired in.
//
//   node tools/asset-report.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('assets');

// Rough ceilings for a mobile WebGL build. Over these is not fatal, but it is
// worth knowing before the file is loaded at runtime rather than after.
const WARN = {
  '.glb': 4 * 1024 * 1024,
  '.gltf': 4 * 1024 * 1024,
  '.png': 2 * 1024 * 1024,
  '.jpg': 2 * 1024 * 1024,
  '.hdr': 2 * 1024 * 1024,
  '.exr': 12 * 1024 * 1024,
  '.ogg': 6 * 1024 * 1024,
  '.mp3': 6 * 1024 * 1024,
  '.svg': 64 * 1024,
};

// Formats we cannot load. Uploading these is the most common wasted upload.
const UNUSABLE = new Set(['.fbx', '.obj', '.blend', '.dae', '.3ds', '.max', '.mtl', '.tga', '.psd']);

const kb = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    // Docs live alongside the assets; they are not assets.
    else if (e.name !== '.gitkeep' && !e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
if (!files.length) {
  console.log('assets/ is empty — see assets/README.md for where things go.');
  process.exit(0);
}

const byDir = new Map();
let total = 0;
const warnings = [];
const unusable = [];

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const dir = path.dirname(rel);
  const ext = path.extname(f).toLowerCase();
  const size = fs.statSync(f).size;
  total += size;

  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push({ name: path.basename(f), size, ext });

  if (UNUSABLE.has(ext)) unusable.push(`${rel} (${ext} cannot be loaded — export glTF/GLB instead)`);
  else if (WARN[ext] && size > WARN[ext]) warnings.push(`${rel} is ${kb(size)} — heavy for a phone`);
  if (size > 100 * 1024 * 1024) warnings.push(`${rel} exceeds GitHub's 100MB per-file limit`);
  if (/[A-Z ()]/.test(path.basename(f))) {
    warnings.push(`${rel} — prefer lowercase-hyphenated names, they become identifiers`);
  }
}

console.log(`\nASSET INVENTORY — ${files.length} files, ${kb(total)} total\n`);
for (const [dir, list] of [...byDir.entries()].sort()) {
  console.log(`  ${dir}/  (${list.length})`);
  for (const f of list.sort((a, b) => b.size - a.size)) {
    console.log(`      ${f.name.padEnd(42)} ${kb(f.size).padStart(9)}`);
  }
}

if (unusable.length) {
  console.log(`\nWRONG FORMAT (${unusable.length}) — these are dead weight in the repo:`);
  unusable.forEach((w) => console.log(`  - ${w}`));
}
if (warnings.length) {
  console.log(`\nWARNINGS (${warnings.length}):`);
  warnings.forEach((w) => console.log(`  - ${w}`));
}
if (!unusable.length && !warnings.length) console.log('\nNothing to flag.');

// APK budget: only what ships in public/ counts, but assets/ is what feeds it.
console.log(`\nIf all of this shipped as-is the APK would grow by roughly ${kb(total)}.`);
console.log('Current APK is ~7.9 MB; 40-60 MB is a normal landing zone.\n');
