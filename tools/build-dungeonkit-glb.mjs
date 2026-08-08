// Convert the KayKit Dungeon Remastered FREE pack into the meshopt GLB the
// dungeon-crawl gates preload (docs/DUNGEON_SPEC.json step 9 / tilesets
// integration contract).
//
//   node tools/build-dungeonkit-glb.mjs             # build + manifest + verify
//   node tools/build-dungeonkit-glb.mjs --verify    # verify the committed GLB only
//
// OUTPUTS
//   public/models/dungeonkit.glb  + dungeonkit.json   (same schema as citykit.json)
//
// SOURCE (CC0, no attribution obligation; provenance recorded in the manifest)
//   KayKit "Dungeon Remastered" FREE tier 1.1 — kaylousberg.itch.io/kaykit-dungeon-remastered
//   (that URL now 301s to /kaykit-dungeon-pack; same product, devlog on the page
//   is titled "Dungeon Remastered 1.1 Update"). Pristine zip kept at
//   assets/source/dungeon/kaykit/dungeon-free.zip beside the extracted tree.
//
// THE SCALE FIX — the load-bearing measurement CONTENT_PACKS.json flagged as
// unverified. The kit is authored on a FOUR metre cell:
//
//     wall                4.000 wide x 4.000 tall x 1.000 thick
//     floor_tile_large    4.000 x 4.000 footprint
//     floor_tile_small    2.000 x 2.000 (the half tile)
//
// Our world grid is 2 m with a 2 m storey (citykit.json: town_wall y 0..2,
// ruin_wall y 2.001). So every piece is multiplied by 0.5 INTO THE VERTEX DATA
// — the exact mirror of the town kit's 2x bake, and for the same reason: a
// scale left on the root node is silently discarded the moment a consumer pulls
// `.geometry` off a child to feed an InstancedMesh, which is what the perf
// budget requires. Post-bake: wall = 2 m wide x 2 m storey, floor_tile_large =
// one 2 m cell, floor_tile_small = a half tile.
//
// INHERITED TRAPS (see tools/build-world-glb.mjs for the war stories):
//   * gltfpack MUST get -kn or every getObjectByName returns null.
//   * meshopt only, never Draco (DRACOLoader breaks the offline guarantee).
//   * mergeDocuments() appends SCENES; adoptScene() folds them or three.js
//     renders exactly one piece.
//   * Keys lowercase + 'dungeon_' prefix: macOS hides case collisions, Android
//     does not, and this kit's wall.gltf would collide with citykit's town wall
//     lineage without the prefix.
//   * baseColorFactor alpha 0 renders nothing and warns about nothing. GLTF
//     sources make it unlikely (it is an FBX-import artefact) but it is forced
//     back to 1 and then asserted anyway — belt and braces cost nothing here.
//   * The KayKit 1024x1024 gradient atlas costs 4 MB of GPU memory for a few
//     hundred flat colours. It is downscaled ONLY when every UV any mesh
//     actually samples lands on the identical pixel afterwards (the creatures
//     builder's approach), stepping 128 -> 256 -> 512 until that holds.
//
// public/models/dungeonkit.glb MUST be committed: assets/source is gitignored
// and machine-local, so CI can never regenerate it.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'assets', 'source', 'dungeon', 'kaykit', 'dungeon',
  'KayKit_Dungeon_Pack_1.1_FREE', 'Assets', 'gltf');
const OUTDIR = path.join(ROOT, 'public', 'models');
const OUT_GLB = path.join(OUTDIR, 'dungeonkit.glb');
const OUT_MANIFEST = path.join(OUTDIR, 'dungeonkit.json');

// Authored cell is 4 m (measured; see header). World grid is 2 m.
const SCALE = 0.5;
const PREFIX = 'dungeon';

// ---------------------------------------------------------------- drop list
//
// Redundancy, not taste — the same rule as build-world-glb.mjs. Everything
// here is either tavern/town furniture the city kit already covers, tabletop
// clutter too small to read at gameplay camera distance, an item that belongs
// to items.glb's domain, or a colour/shape variant beyond what the rank-flag
// and dressing designs can consume.
const DROP = new Set([
  // Tavern furniture: gates are combat spaces; citykit dresses interiors.
  'table_long', 'table_long_broken', 'table_long_decorated_A', 'table_long_decorated_C',
  'table_long_tablecloth', 'table_long_tablecloth_decorated_A',
  'table_medium', 'table_medium_broken', 'table_medium_decorated_A',
  'table_medium_tablecloth', 'table_medium_tablecloth_decorated_B',
  'table_small', 'table_small_decorated_A', 'table_small_decorated_B',
  'chair', 'stool', 'bed_decorated', 'bed_floor', 'bed_frame',
  'shelf_large', 'shelf_small', 'shelf_small_candles', 'shelves',
  // Tabletop clutter: a plate is ~7 cm after the 0.5x bake.
  'plate', 'plate_food_A', 'plate_food_B', 'plate_small', 'plate_stack',
  'bottle_A_brown', 'bottle_A_green', 'bottle_A_labeled_brown', 'bottle_A_labeled_green',
  'bottle_B_brown', 'bottle_B_green', 'bottle_C_brown', 'bottle_C_green',
  // Pickup-sized items: loot renders from items.glb, not the tileset.
  'key', 'keyring', 'keyring_hanging', 'coin',
  // Banner variants: keep plain + shield + patternA in all six colours (18
  // banners already outnumber the rank palette); three more shape families
  // on top of that is bytes for no new silhouette.
  'banner_patternB_blue', 'banner_patternB_brown', 'banner_patternB_green',
  'banner_patternB_red', 'banner_patternB_white', 'banner_patternB_yellow',
  'banner_patternC_blue', 'banner_patternC_brown', 'banner_patternC_green',
  'banner_patternC_red', 'banner_patternC_white', 'banner_patternC_yellow',
  'banner_thin_blue', 'banner_thin_brown', 'banner_thin_green',
  'banner_thin_red', 'banner_thin_white', 'banner_thin_yellow',
  'banner_triple_blue', 'banner_triple_brown', 'banner_triple_green',
  'banner_triple_red', 'banner_triple_white', 'banner_triple_yellow',
  // Trunk B/C are the A silhouette with different lid clutter.
  'trunk_large_B', 'trunk_large_C', 'trunk_medium_B', 'trunk_medium_C',
  'trunk_small_B', 'trunk_small_C',
]);

// ------------------------------------------------------------------- shell

function run(cmd, args, { label }) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`${label}: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${label} exited ${code}\n${out.slice(-4000)}\n${err.slice(-4000)}`));
    });
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 'wall_Tsplit' -> 'dungeon_wall_tsplit' */
function keyFor(basename) {
  const slug = basename.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${PREFIX}_${slug}`;
}

async function gltfIO() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

// --- minimal mat4 (column-major, glTF order), same as build-world-glb.mjs.
function matMul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
function matApply(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** World-space AABB of a node subtree, from POSITION accessor min/max corners. */
function nodeBounds(node, parentMatrix = IDENTITY, acc = null) {
  const box = acc || { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const local = node.getMatrix ? node.getMatrix() : IDENTITY;
  const world = matMul(parentMatrix, Array.from(local));
  const mesh = node.getMesh && node.getMesh();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const lo = pos.getMin([]);
      const hi = pos.getMax([]);
      for (let i = 0; i < 8; i++) {
        const p = matApply(world, i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
        for (let a = 0; a < 3; a++) {
          if (p[a] < box.min[a]) box.min[a] = p[a];
          if (p[a] > box.max[a]) box.max[a] = p[a];
        }
      }
    }
  }
  for (const child of node.listChildren()) nodeBounds(child, world, box);
  return box;
}

/** Fold a merged-in scene's roots under one node named `key` (trap: merge
 *  copies SCENES; three.js renders scenes[0] only). Same as build-world's. */
function adoptScene(doc, scene, target, key) {
  const kids = scene.listChildren();
  let root;
  if (kids.length === 1) {
    root = kids[0];
    scene.removeChild(root);
  } else {
    root = doc.createNode(key);
    for (const k of kids) { scene.removeChild(k); root.addChild(k); }
  }
  root.setName(key);
  let n = 0;
  const rename = (node) => {
    for (const c of node.listChildren()) { c.setName(`${key}__part${n++}`); rename(c); }
  };
  rename(root);
  target.addChild(root);
  scene.dispose();
  return root;
}

/** Multiply a subtree by a uniform scale, baked into the VERTEX DATA — see
 *  THE SCALE FIX in the header for why node.setScale() is the wrong tool. */
async function bakeUniformScale(node, s) {
  const { transformMesh } = await import('@gltf-transform/functions');
  const M = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
  const seen = new Set();
  const walk = (n) => {
    const t = n.getTranslation();
    n.setTranslation([t[0] * s, t[1] * s, t[2] * s]);
    const mesh = n.getMesh && n.getMesh();
    if (mesh && !seen.has(mesh)) { seen.add(mesh); transformMesh(mesh, M); }
    for (const c of n.listChildren()) walk(c);
  };
  walk(node);
}

/** TANGENT is only meaningful with a normal map; this kit has none. */
function stripTangents(doc) {
  let removed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('TANGENT')) { prim.setAttribute('TANGENT', null); removed++; }
    }
  }
  return removed;
}

/**
 * Force any alpha-0 baseColorFactor back to opaque, then assert none remain.
 * The items pack shipped materials like this: correct geometry, correct
 * bounds, nothing drawn, no warning anywhere.
 */
function forceOpaque(doc) {
  let forced = 0;
  for (const m of doc.getRoot().listMaterials()) {
    const f = m.getBaseColorFactor();
    if (f[3] <= 0.001) {
      m.setBaseColorFactor([f[0], f[1], f[2], 1]);
      m.setAlphaMode('OPAQUE');
      forced++;
      console.log(`[dungeonkit] material '${m.getName() || '(unnamed)'}' had alpha ${f[3]} -> forced to 1`);
    }
  }
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getBaseColorFactor()[3] <= 0.001) {
      throw new Error(`material '${m.getName()}' still has alpha 0 after forceOpaque`);
    }
  }
  return forced;
}

/**
 * Downscale the shared gradient atlas, but only if every UV the meshes
 * actually sample lands on the IDENTICAL pixel afterwards (the creatures
 * builder's rule — a wrong colour is invisible in review and obvious on a
 * phone). Tries 128, then 256, then 512; keeps the source size if none hold.
 */
async function shrinkAtlas(doc) {
  let sharp;
  try { sharp = (await import('sharp')).default; }
  catch { console.log('[dungeonkit] sharp unavailable, atlas kept at source size'); return; }

  for (const tex of doc.getRoot().listTextures()) {
    const [w, h] = tex.getSize() || [];
    if (!w || Math.max(w, h) <= 128) continue;

    const uvs = new Set();
    for (const mat of doc.getRoot().listMaterials()) {
      if (mat.getBaseColorTexture() !== tex) continue;
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMaterial() !== mat) continue;
          const uv = prim.getAttribute('TEXCOORD_0');
          if (!uv) continue;
          const a = uv.getArray();
          for (let i = 0; i < a.length; i += 2) uvs.add(`${a[i]},${a[i + 1]}`);
        }
      }
    }
    if (!uvs.size) continue;

    const src = Buffer.from(tex.getImage());
    const A = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (o, u, v) => {
      const wrap = (x) => ((x % 1) + 1) % 1;
      const x = Math.min(o.info.width - 1, Math.floor(wrap(u) * o.info.width));
      const y = Math.min(o.info.height - 1, Math.floor(wrap(v) * o.info.height));
      const i = (y * o.info.width + x) * o.info.channels;
      return `${o.data[i]},${o.data[i + 1]},${o.data[i + 2]},${o.data[i + 3]}`;
    };

    let applied = null;
    for (const target of [128, 256, 512]) {
      if (target >= Math.max(w, h)) break;
      const scale = target / Math.max(w, h);
      const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
      const small = await sharp(src).resize(nw, nh, { kernel: 'nearest' }).png().toBuffer();
      const B = await sharp(small).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let ok = true;
      for (const s of uvs) {
        const [u, v] = s.split(',').map(Number);
        if (px(A, u, v) !== px(B, u, v)) { ok = false; break; }
      }
      if (ok) { applied = { small, nw, nh }; break; }
    }
    const label = `${tex.getName() || 'atlas'} ${w}x${h} (${uvs.size} sampled UVs)`;
    if (!applied) { console.log(`[dungeonkit] ${label}: no lossless downscale — kept`); continue; }
    tex.setImage(new Uint8Array(applied.small));
    // Flat palette cells want point sampling; NEAREST minFilter also stops
    // three.js generating mipmaps, which is the real memory win.
    for (const mat of doc.getRoot().listMaterials()) {
      if (mat.getBaseColorTexture() !== tex) continue;
      const info = mat.getBaseColorTextureInfo();
      if (info) { info.setMagFilter(9728); info.setMinFilter(9728); }
    }
    console.log(`[dungeonkit] ${label} -> ${applied.nw}x${applied.nh}, all sampled texels identical`);
  }
}

// ------------------------------------------------------- grid classification
// Copied from build-world-glb.mjs (see that file for why inference is strict
// and per-piece classification is lenient — they are different questions).

function axisFit(d, unit, tol = 0.05) {
  const k = d / unit;
  if (k < 0.25) return { fit: 'sub', cells: 0 };
  const n = Math.round(k);
  if (n >= 1 && Math.abs(k - n) <= tol) return { fit: 'exact', cells: n };
  if (n >= 1 && k > n && k - n <= 0.3) return { fit: 'overhang', cells: n };
  if (Math.abs(k - 0.5) <= tol) return { fit: 'half', cells: 0.5 };
  if (k < 0.75) return { fit: 'sub', cells: 0 };
  return { fit: 'free', cells: null };
}

function inferGrid(pieces, { tol = 0.05, minScore = 0.6 } = {}) {
  const candidates = [0.25, 0.5, 1, 2, 4];
  const scored = candidates.map((g) => {
    let hits = 0, considered = 0;
    for (const p of pieces) {
      for (const d of [p.size[0], p.size[2]]) {
        if (d < g * 0.75) continue;
        considered++;
        if (Math.abs(d / g - Math.round(d / g)) <= tol) hits++;
      }
    }
    return { grid: g, hits, considered, score: considered ? Number((hits / considered).toFixed(4)) : 0 };
  });
  const floor = Math.max(8, pieces.length * 0.25);
  const best = scored.filter((s) => s.score >= minScore && s.considered >= floor)
    .sort((a, b) => b.grid - a.grid)[0]
    || scored.slice().sort((a, b) => b.score - a.score)[0];
  return { grid: best.grid, confidence: best.score, scored, tolerance: tol };
}

function classifyOnGrid(piece, unit, tol = 0.05) {
  if (!unit) return { cells: null, fit: null, onGrid: false };
  const x = axisFit(piece.size[0], unit, tol);
  const z = axisFit(piece.size[2], unit, tol);
  return {
    cells: [x.cells, z.cells],
    fit: [x.fit, z.fit],
    onGrid: x.fit !== 'free' && z.fit !== 'free',
  };
}

async function glbStats(io, file) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  const scenes = root.listScenes();
  const names = new Set();
  for (const n of root.listNodes()) if (n.getName()) names.add(n.getName());
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      triangles += Math.floor((idx ? idx.getCount() : (pos ? pos.getCount() : 0)) / 3);
    }
  }
  return {
    scenes: scenes.length,
    nodeNames: names,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    triangles,
    extensions: root.listExtensionsUsed().map((e) => e.extensionName),
  };
}

// ---------------------------------------------------------------- the build

export async function buildDungeonKit() {
  const io = await gltfIO();
  const { Document } = await import('@gltf-transform/core');
  const { dedup, prune, unpartition, mergeDocuments } = await import('@gltf-transform/functions');

  if (!(await exists(SRC))) {
    throw new Error(
      `dungeon kit source not found at ${SRC}. It is gitignored; unzip ` +
      `assets/source/dungeon/kaykit/dungeon-free.zip (itch.io free tier, CC0).`,
    );
  }

  const doc = new Document();
  const scene = doc.createScene('dungeonkit');
  doc.getRoot().setDefaultScene(scene);

  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.gltf')).sort();
  let kept = 0;
  const droppedNames = [];
  for (const f of files) {
    const base = f.slice(0, -5);
    if (DROP.has(base)) { droppedNames.push(base); continue; }
    const src = await io.read(path.join(SRC, f));
    const srcScenes = src.getRoot().listScenes();
    if (srcScenes.length !== 1) throw new Error(`${f}: expected 1 scene, got ${srcScenes.length}`);
    mergeDocuments(doc, src);
    const mine = doc.getRoot().listScenes().filter((s) => s !== scene);
    if (mine.length !== 1) throw new Error(`${f}: merge left ${mine.length} loose scenes`);
    const key = keyFor(base);
    const root = adoptScene(doc, mine[0], scene, key);
    // THE SCALE FIX: 4 m authored cell -> our 2 m grid, baked into vertices.
    await bakeUniformScale(root, SCALE);
    root.setExtras({ source: `kaykit-dungeon-remastered-free/${f}`, authoredScale: 1 / SCALE });
    kept++;
  }
  console.log(`[dungeonkit] ${files.length} GLTF pieces -> ${kept} kept, ${droppedNames.length} dropped ` +
    `(x${SCALE} baked to the 2 m grid)`);

  // Bounds BEFORE gltfpack: post-quantisation POSITION min/max are in integer
  // space and useless for placement docs.
  const roots = scene.listChildren();
  const pieces = roots.map((n) => {
    const b = nodeBounds(n);
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    let tris = 0;
    const walk = (node) => {
      const m = node.getMesh && node.getMesh();
      if (m) for (const p of m.listPrimitives()) {
        const i = p.getIndices(); const pos = p.getAttribute('POSITION');
        tris += Math.floor((i ? i.getCount() : (pos ? pos.getCount() : 0)) / 3);
      }
      for (const c of node.listChildren()) walk(c);
    };
    walk(n);
    return {
      key: n.getName(),
      source: n.getExtras()?.source || null,
      size: size.map((v) => Number(v.toFixed(4))),
      min: b.min.map((v) => Number(v.toFixed(4))),
      max: b.max.map((v) => Number(v.toFixed(4))),
      triangles: tris,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  const grid = inferGrid(pieces);
  const unit = grid.confidence >= 0.6 ? grid.grid : null;
  for (const p of pieces) Object.assign(p, classifyOnGrid(p, unit, grid.tolerance));

  stripTangents(doc);
  // unpartition() is required, not cosmetic: every merged source arrives with
  // its own Buffer and a GLB is allowed exactly one.
  await doc.transform(dedup(), prune(), unpartition());
  forceOpaque(doc);
  await shrinkAtlas(doc);

  // Exactly one scene, no duplicate node names anywhere (three.js renames
  // collisions on load, which silently breaks getObjectByName consumers).
  if (doc.getRoot().listScenes().length !== 1) {
    throw new Error(`expected 1 scene, got ${doc.getRoot().listScenes().length}`);
  }
  const seen = new Set(); const dupes = [];
  const walkAll = (n) => {
    const name = n.getName();
    if (name) { if (seen.has(name)) dupes.push(name); else seen.add(name); }
    for (const c of n.listChildren()) walkAll(c);
  };
  for (const c of scene.listChildren()) walkAll(c);
  if (dupes.length) {
    throw new Error(`${dupes.length} duplicate node name(s), e.g. ${dupes.slice(0, 6).join(', ')}`);
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-dungeonkit-'));
  const raw = path.join(tmp, 'dungeonkit-raw.glb');
  await io.write(raw, doc);
  const rawBytes = (await fs.stat(raw)).size;

  // meshopt via gltfpack; -kn is mandatory (names are the whole API).
  const gltfpack = path.join(ROOT, 'node_modules', '.bin', 'gltfpack');
  if (!(await exists(gltfpack))) throw new Error(`gltfpack not found at ${gltfpack} — run: npm i -D gltfpack`);
  await fs.mkdir(OUTDIR, { recursive: true });
  await run(gltfpack, ['-i', raw, '-o', OUT_GLB, '-cc', '-kn'], { label: 'gltfpack' });
  await fs.rm(tmp, { recursive: true, force: true });

  const final = await glbStats(io, OUT_GLB);
  const missing = pieces.map((p) => p.key).filter((k) => !final.nodeNames.has(k));
  if (missing.length) {
    throw new Error(`gltfpack dropped ${missing.length} node name(s), e.g. ${missing.slice(0, 5).join(', ')} ` +
      `— the -kn failure mode.`);
  }
  if (final.scenes !== 1) throw new Error(`gltfpack produced ${final.scenes} scenes`);
  if (!final.extensions.includes('EXT_meshopt_compression')) {
    throw new Error(`EXT_meshopt_compression missing from output (extensions: ${final.extensions.join(', ')})`);
  }

  const bytes = (await fs.stat(OUT_GLB)).size;
  const manifest = {
    file: 'models/dungeonkit.glb',
    generatedBy: 'tools/build-dungeonkit-glb.mjs',
    sources: [{
      name: 'KayKit — Dungeon Remastered Pack (FREE tier, 1.1)',
      author: 'Kay Lousberg',
      url: 'https://kaylousberg.itch.io/kaykit-dungeon-remastered',
      licence: 'CC0 1.0 (License.txt inside the zip re-verified at download time)',
      downloaded: '2026-08-07',
      prefix: 'dungeon_',
      pieces: kept,
      authoredGrid: 4, scaleBaked: SCALE,
      note: `Authored on a 4 m cell with a 4 m storey (measured: wall 4.000 wide x 4.000 tall, ` +
        `floor_tile_large 4.000 x 4.000, floor_tile_small the 2 m half tile). Multiplied by ` +
        `${SCALE} INTO THE VERTEX DATA at build time so it shares the 2 m grid and 2 m storey of ` +
        `citykit.glb. Sizes below are post-scale; multiply by 2 to compare with KayKit's docs. ` +
        `The itch URL 301s to /kaykit-dungeon-pack — same product, the page devlog is ` +
        `"Dungeon Remastered 1.1 Update". Pristine zip: assets/source/dungeon/kaykit/dungeon-free.zip.`,
    }],
    grid: {
      gridded: grid.confidence >= 0.6,
      unit: grid.confidence >= 0.6 ? grid.grid : null,
      bestGuess: grid.grid,
      confidence: grid.confidence,
      tolerance: grid.tolerance,
      onGridPieces: pieces.filter((p) => p.onGrid).length,
      note: `Cell size in metres on the XZ plane, post-bake. Same fit vocabulary as citykit.json: ` +
        `exact/overhang/half tile on ${grid.grid} m centres, "sub" snaps its centre, "free" is ` +
        `hand-placed. Y is unconstrained.`,
    },
    gridCandidates: grid.scored,
    stats: { pieces: pieces.length, bytes, triangles: final.triangles, materials: final.materials, textures: final.textures },
    notes: [
      'SCALE: everything in this file is metres on the shared 2 m grid, exactly like citykit.glb ' +
      'and nature.glb. The 0.5x is baked into vertices — do not apply any further factor.',
      'PIVOTS: floor tiles and walls are centred on their cell origin; y = 0 is the walk plane. ' +
      'dungeon_wall is a full-cell 0.5 m-thick slab centred on the cell (z -0.25..0.25 post-bake), ' +
      'spanning y 0..2 — the ruin_wall convention (cell-bisecting), NOT the town_wall edge slab.',
      'STOREY HEIGHT is 2 m post-bake, matching both citykit sub-kits, so dungeon walls stack ' +
      'and mix with ruin_* pieces at the same floor intervals.',
      'DUNGEON_MODULES coverage (docs/DUNGEON_SPEC.json step 9): floors (dungeon_floor_tile_*, ' +
      'dungeon_floor_dirt_*, dungeon_floor_wood_*), walls (dungeon_wall*), doorframe ' +
      '(dungeon_wall_doorway*), archway (dungeon_wall_arched*), column (dungeon_column, ' +
      'dungeon_pillar*, dungeon_wall_pillar), torch (dungeon_torch, dungeon_torch_lit, ' +
      'dungeon_torch_mounted), chest (dungeon_chest, dungeon_chest_gold, dungeon_trunk_*), ' +
      'barrel (dungeon_barrel_*, dungeon_keg*), banner (dungeon_banner_*), stairs ' +
      '(dungeon_stairs*), traps (dungeon_floor_tile_big_spikes, dungeon_floor_tile_*grate*).',
      'All pieces are textured by ONE shared gradient atlas (downscaled with per-UV pixel ' +
      'verification). Flat-shaded low-poly; no normal map, no PBR set.',
      'Keys are lowercase with a dungeon_ prefix: this kit\'s wall/floor stems collide with ' +
      'citykit lineage by case and by name, which macOS hides and Android does not.',
    ],
    pieces,
  };
  await fs.writeFile(OUT_MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);

  console.log(`[dungeonkit] wrote ${path.relative(ROOT, OUT_GLB)}  ${(bytes / 1024).toFixed(1)} KB ` +
    `(raw ${(rawBytes / 1024).toFixed(1)} KB)  ${pieces.length} pieces  ${final.triangles} tris  ` +
    `${final.materials} materials  ${final.textures} texture(s)  grid ${grid.grid} m`);
  console.log(`[dungeonkit] manifest ${path.relative(ROOT, OUT_MANIFEST)}`);
  return { file: OUT_GLB, manifestFile: OUT_MANIFEST, bytes, pieces: pieces.length, triangles: final.triangles };
}

// ------------------------------------------------------------------- verify

export async function verifyDungeonKit() {
  const io = await gltfIO();
  if (!(await exists(OUT_GLB))) throw new Error(`${OUT_GLB} missing`);
  if (!(await exists(OUT_MANIFEST))) throw new Error(`${OUT_MANIFEST} missing`);
  const manifest = JSON.parse(await fs.readFile(OUT_MANIFEST, 'utf8'));
  const stats = await glbStats(io, OUT_GLB);
  if (stats.scenes !== 1) throw new Error(`expected 1 scene, got ${stats.scenes}`);
  if (!stats.extensions.includes('EXT_meshopt_compression')) {
    throw new Error('EXT_meshopt_compression missing — this file was not packed with gltfpack -cc');
  }
  const missing = manifest.pieces.map((p) => p.key).filter((k) => !stats.nodeNames.has(k));
  if (missing.length) {
    throw new Error(`${missing.length} manifest key(s) missing from GLB, e.g. ${missing.slice(0, 5).join(', ')}`);
  }
  const badCase = manifest.pieces.map((p) => p.key).filter((k) => k !== k.toLowerCase());
  if (badCase.length) throw new Error(`non-lowercase key(s): ${badCase.slice(0, 5).join(', ')}`);
  console.log(`[dungeonkit] verify OK: ${manifest.pieces.length} pieces, 1 scene, meshopt present, ` +
    `${stats.triangles} tris`);
  return true;
}

// ---------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--verify')) await verifyDungeonKit();
    else { await buildDungeonKit(); await verifyDungeonKit(); }
  } catch (e) {
    console.error(`[dungeonkit] FAILED: ${e.message}`);
    process.exit(1);
  }
}
