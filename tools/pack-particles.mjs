// Pack a curated subset of the Kenney Particle Pack (80 512x512 PNGs, CC0)
// into ONE WebP atlas plus a JSON index — the tools/pack-icons.mjs pattern.
// 80 separate textures would blow texture-bind counts on the phone GPU; one
// atlas is one bind for the whole VFX layer.
//
//   node tools/pack-particles.mjs [--src <dir>] [--out public/models/] [--cell 224]
//
// OUTPUTS
//   public/models/particles.webp + particles.json
//
// CURATION (24 of 80): the docs/CONTENT_PACKS.json ability-VFX slots are
// impact bursts, cast/summon flashes, dash smoke, buff twirls, portal
// ambience, telegraph accents, Bind extraction wisps. Deliberately skipped:
//   * muzzle_*  — firearm flashes; no guns in this game
//   * slash_*   — slash arcs are PROCEDURAL per the spec (built, not shipped)
//   * window_*, symbol_*, scratch_*, dirt_* — no caller in the VFX design
//   * the "Rotated" duplicates — rotation is a quad transform at runtime,
//     shipping pre-rotated pixels is pure bytes
//
// GLOW DISCIPLINE (repo rule): these sprites are for SKILLS, TELEGRAPHS,
// PORTALS and shadow-army treatment ONLY. No rim/glow/emissive on living
// characters — an atlas entry is not a license to break that.
//
// Keys are lowercase (macOS is case-insensitive, Android is not — the exact
// ship-breaker pack-icons.mjs exists to defuse).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_SRC = path.join(ROOT, 'assets', 'source', 'vfx', 'kenney-particle',
  'particle-pack', 'PNG (Transparent)');
const DEFAULT_OUT = path.join(ROOT, 'public', 'models');

// name -> role, so the manifest documents WHY each sprite is aboard. The
// selection covers every family the VFX design calls for with 2-4 variants
// each (variants stop repeated effects reading as stamped copies).
const CURATED = {
  // dodge smoke, portal ambience, summon dust
  smoke_01: 'soft round puff — dash/dodge smoke',
  smoke_04: 'billowy puff — portal ambience',
  smoke_07: 'wispy puff — summon dust',
  // impact bursts, ember effects (Emberfall rank flavour)
  fire_01: 'fire burst — impact flash',
  flame_01: 'flame tongue — burning tick',
  flame_05: 'small flame — ember trail',
  // cast flashes, Bind extraction wisps
  magic_01: 'pentagon rune ring — cast flash / summon circle accent',
  magic_02: 'octagon rune ring — Bind extraction circle accent',
  magic_04: 'sparkle cluster — buff apply',
  magic_05: 'dense wisp — summon core',
  // portal glow, telegraph accents
  flare_01: 'horizontal flare — portal rim accent',
  light_01: 'radial glow — telegraph pulse',
  // hit sparks
  spark_01: 'star spark — melee impact',
  spark_04: 'thin spark burst — parry/clash',
  spark_06: 'small spark — chip hit',
  // pickup glints, crit accents
  star_04: 'four-point glint — loot sparkle',
  star_07: 'soft star — crit accent',
  // buff twirls
  twirl_01: 'spiral twirl — buff loop',
  twirl_02: 'double twirl — level-up burst',
  // projectile traces
  trace_01: 'streak — projectile trace',
  trace_06: 'tapered streak — dash trail',
  // ground marks after AoE (decal-style quad)
  scorch_01: 'scorch mark — AoE aftermath',
  // generic soft dots for Points clouds
  circle_02: 'soft dot — generic particle',
  circle_05: 'hard-edge dot — dense particle',
};

export async function packParticles({
  srcDir = DEFAULT_SRC,
  outDir = DEFAULT_OUT,
  // 224 measured against 256/192 on the real set: 214 KB vs 268/166, and the
  // detail loss vs 256 is invisible on additive billboards at phone scale.
  cell = 224,
} = {}) {
  const names = Object.keys(CURATED).sort((a, b) => a.localeCompare(b));
  for (const n of names) {
    if (n !== n.toLowerCase()) throw new Error(`curated key not lowercase: ${n}`);
  }

  const cols = Math.ceil(Math.sqrt(names.length));
  const rows = Math.ceil(names.length / cols);
  const width = cols * cell;
  const height = rows * cell;

  const composites = [];
  const sprites = {};
  for (let i = 0; i < names.length; i++) {
    const file = path.join(srcDir, `${names[i]}.png`);
    // Downsample 512 -> cell. These are soft alpha billboards drawn small and
    // additive; 256 is indistinguishable at phone scale and quarters the bytes.
    composites.push({
      input: await sharp(file)
        .resize(cell, cell, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
      left: (i % cols) * cell,
      top: Math.floor(i / cols) * cell,
    });
    sprites[names[i]] = [i % cols, Math.floor(i / cols)];
  }

  await fs.mkdir(outDir, { recursive: true });
  const atlasFile = path.join(outDir, 'particles.webp');
  const indexFile = path.join(outDir, 'particles.json');

  await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    // alphaQuality high on purpose: these are MOSTLY alpha — a crushed alpha
    // channel shows up as hard sprite edges against dark dungeon fog.
    .webp({ quality: 80, alphaQuality: 90, effort: 6 })
    .toFile(atlasFile);

  const index = {
    atlas: 'particles.webp',
    cell, cols, rows, width, height,
    count: names.length,
    note: 'All keys lowercase. [col,row] cells in one atlas — bind once, draw every ' +
      'effect. Sprites are white/grey masks: tint via material color, additive blending. ' +
      'SKILLS, TELEGRAPHS, PORTALS and shadow-army treatment ONLY — the no-glow-on-' +
      'living-characters rule stands.',
    source: {
      pack: 'Kenney Particle Pack (1.1)',
      author: 'Kenney (Kenney Vleugels, kenney.nl)',
      licence: 'CC0 1.0 (License.txt inside the zip re-verified at download time)',
      url: 'https://kenney.nl/assets/particle-pack',
      downloaded: '2026-08-07',
      used: names.length,
      available: 80,
      note: 'Curated from PNG (Transparent)/, 512px sources downsampled to the cell size. ' +
        'Pristine zip at assets/source/vfx/kenney-particle/kenney_particle-pack.zip. ' +
        'Skipped families: muzzle (no guns), slash (procedural arcs per DUNGEON_SPEC), ' +
        'window/symbol/scratch/dirt (no caller), Rotated/ duplicates (runtime transform).',
    },
    roles: CURATED,
    sprites,
  };
  await fs.writeFile(indexFile, `${JSON.stringify(index, null, 1)}\n`);

  const bytes = (await fs.stat(atlasFile)).size;
  console.log(`[particles] ${names.length} sprites -> ${width}x${height} atlas, ` +
    `${(bytes / 1024).toFixed(1)} KB webp`);
  return { atlas: atlasFile, index: indexFile, bytes, count: names.length };
}

// ------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  try {
    await packParticles({
      srcDir: opt('src', DEFAULT_SRC),
      outDir: path.resolve(ROOT, opt('out', DEFAULT_OUT)),
      cell: Number(opt('cell', 224)),
    });
  } catch (e) {
    console.error(`[particles] FAILED: ${e.message}`);
    process.exit(1);
  }
}
