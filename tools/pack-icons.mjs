// Pack the 107 1000x1000 item icons (31 MB of PNG) into one WebP atlas plus a
// JSON index, so the whole inventory/loot UI is a single image and a single
// request.
//
//   node tools/pack-icons.mjs [--src <pack Icons dir>] [--out public/models/] [--cell 128]
//
// THE SHIP-BREAKER this exists to defuse: icon filenames disagree with model
// filenames BY CASE ONLY — Axe_Small.png vs Axe_small.fbx, Fishbone.png vs
// FishBone.fbx, Sword_Big.png vs Sword_big.fbx. macOS APFS is case-insensitive,
// so a naive lookup works perfectly in dev on this Mac and then returns nothing
// on Android and in Linux CI. Every key in the emitted index is lowercased, and
// src/ui/icons.js lowercases on lookup, so the two sides can never disagree.
//
// Potion1_Filled additionally has TWO icons (Blue/Red) and no exact-name match,
// so it gets an explicit alias.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_SRC = path.join(ROOT, 'Ultimate RPG Items Pack - Aug 2019', 'Icons');
const DEFAULT_OUT = path.join(ROOT, 'public', 'models');

// name in the index (lowercase) -> icon file stem that actually exists.
// Anything the pack does not name identically to its model goes here.
const ALIASES = {
  potion1_filled: 'Potion1_Filled_Blue',
};

export async function packIcons({
  srcDir = DEFAULT_SRC,
  outDir = DEFAULT_OUT,
  cell = 128,
} = {}) {
  const files = (await fs.readdir(srcDir))
    .filter((f) => f.toLowerCase().endsWith('.png') && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error(`no PNGs in ${srcDir}`);

  const cols = Math.ceil(Math.sqrt(files.length));
  const rows = Math.ceil(files.length / cols);
  const width = cols * cell;
  const height = rows * cell;

  const composites = [];
  const icons = {};
  const seen = new Map(); // lowercase key -> original stem, to catch real dupes

  for (let i = 0; i < files.length; i++) {
    const stem = files[i].slice(0, -4);
    const key = stem.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`two icons collide after lowercasing: ${seen.get(key)} and ${stem}`);
    }
    seen.set(key, stem);

    const col = i % cols;
    const row = Math.floor(i / cols);
    composites.push({
      input: await sharp(path.join(srcDir, files[i]))
        .resize(cell, cell, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
      left: col * cell,
      top: row * cell,
    });
    icons[key] = [col, row];
  }

  for (const [alias, target] of Object.entries(ALIASES)) {
    const t = target.toLowerCase();
    if (!icons[t]) throw new Error(`alias ${alias} points at missing icon ${target}`);
    if (!icons[alias]) icons[alias] = icons[t].slice();
  }

  await fs.mkdir(outDir, { recursive: true });
  const atlasFile = path.join(outDir, 'icons.webp');
  const indexFile = path.join(outDir, 'icons.json');

  await sharp({
    create: {
      width, height, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp({ quality: 82, alphaQuality: 90, effort: 6 })
    .toFile(atlasFile);

  // Sorted keys so the committed JSON has a stable diff between rebuilds.
  const sorted = {};
  for (const k of Object.keys(icons).sort()) sorted[k] = icons[k];

  const index = {
    atlas: 'icons.webp',
    cell, cols, rows, width, height,
    count: Object.keys(sorted).length,
    // Documented in the file itself so nobody "fixes" the casing later.
    note: 'All keys are lowercase. Pack filenames disagree with model filenames by case only.',
    icons: sorted,
  };
  await fs.writeFile(indexFile, `${JSON.stringify(index, null, 0)}\n`);

  const bytes = (await fs.stat(atlasFile)).size;
  console.log(`[icons] ${files.length} icons -> ${width}x${height} atlas, ` +
    `${(bytes / 1024).toFixed(1)} KB, ${index.count} keys (+${Object.keys(ALIASES).length} alias)`);

  return { atlas: atlasFile, index: indexFile, bytes, count: index.count };
}

// ------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  try {
    await packIcons({
      srcDir: opt('src', DEFAULT_SRC),
      outDir: path.resolve(ROOT, opt('out', DEFAULT_OUT)),
      cell: Number(opt('cell', 128)),
    });
  } catch (e) {
    console.error(`[icons] FAILED: ${e.message}`);
    process.exit(1);
  }
}
