// Convert the two CC0 world kits into meshopt GLBs the game can preload.
//
//   node tools/build-world-glb.mjs                 # build both + manifests + verify
//   node tools/build-world-glb.mjs --only city
//   node tools/build-world-glb.mjs --only nature
//   node tools/build-world-glb.mjs --verify        # verify the committed GLBs only
//
// OUTPUTS
//   public/models/citykit.glb  + citykit.json   Kenney Fantasy Town 2.0 (town_*)
//                                               + Quaternius Modular Ruins  (ruin_*)
//   public/models/nature.glb   + nature.json    Quaternius Ultimate Nature
//
// WHY THE RUINS ARE FOLDED INTO citykit.glb RATHER THAN A THIRD FILE
//   Both kits are ARCHITECTURE, both are modular, and after the scale fix below
//   both land on the same 2.0-unit cell — so they share one grid constant, one
//   manifest, one fetch and one material palette, and the ruined citadel can be
//   built out of town walls and ruin arches in the same pass. nature.glb is
//   separate because it is the only kit the open-air biomes need, it is pure
//   freeform scatter with no grid at all, and keeping it out means the city hub
//   never pays for 140 trees.
//
// THE SCALE FIX — the single most load-bearing thing in this file
//   The two kits are NOT authored at the same scale, and nothing warns you.
//   Kenney's Fantasy Town is a 1.0 cell with a 1.0-unit storey; Quaternius'
//   ruins are a 2.0 cell with a 2.0-unit storey (its How-To-Use.txt says "1x1
//   grid", which is true in its own authoring units and false in world units
//   after FBX import). Dropped side by side untouched, the town is half the
//   height of the ruins and neither snaps to the other. Three independent
//   measurements agree the factor is exactly 2:
//
//       wall/storey height   kenney 1.000 x2 = 2.000   ruins 2.001   ratio 1.000
//       floor tile X and Z   kenney 1.000 x2 = 2.000   ruins 2.000   ratio 1.000
//       stair run            kenney 1.000 x2 = 2.000   ruins 2.015   ratio 0.992
//
//   so bakeUniformScale() multiplies every town_ piece by 2 at build time. It is
//   baked into the VERTEX DATA, not onto the node, on purpose: a scale sitting
//   on the root node is silently discarded the moment a consumer pulls
//   `.geometry` off a child to feed an InstancedMesh, which is exactly what the
//   perf budget requires everyone to do. Post-bake, citykit.glb and nature.glb
//   are both in metres and the whole file is one 2.0 grid.
//
// THE TRAPS THIS PIPELINE IS BUILT AROUND — every one of them fails SILENTLY:
//
//   1. Blender is NOT on PATH on this Mac. See resolveBlender().
//   2. tools/blender-items.py renames imported FBX objects to '<name>__part'
//      BEFORE creating the handle Empty. Without it Blender hands back
//      'Wall001' and every getObjectByName returns null. This script reuses
//      that script verbatim rather than reinventing it.
//   3. gltfpack MUST be given -kn or node names are stripped; the file then
//      loads without error and is completely unusable.
//   4. meshopt, NOT Draco. DRACOLoader resolves its decoder path at runtime and
//      fails silently on-device under Capacitor, which breaks the offline rule.
//   5. gltf-transform's Document.merge() brings the source SCENE across, not its
//      nodes — 167 merges produce 167 scenes and three.js renders only scenes[0].
//      mergeInto() below reparents the roots into one scene and disposes the rest.
//   6. The Quaternius FBX materials carry opacity 0. blender-items.py forces
//      Alpha back to 1; assertNoZeroAlpha() re-checks it on the finished file,
//      because "correct geometry, correct bounds, nothing drawn" looks like a
//      renderer bug and is not one.
//   7. Every key is lowercased. macOS is case-insensitive, Android is not, and
//      the two kits collide on case alone (Kenney 'wall.glb' vs ruins
//      'Wall.fbx') — hence the town_/ruin_ prefixes.
//
// public/models/*.glb MUST be committed: the source kits live in
// assets/source/world/ which is large and machine-local, so CI can never
// regenerate them, and a build that shipped without them would show no city and
// raise no error.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'assets', 'source', 'world');
const OUTDIR = path.join(ROOT, 'public', 'models');
const BLENDER_APP = '/Applications/Blender.app/Contents/MacOS/Blender';

const KENNEY_GLB = path.join(SRC, 'kenney-fantasy-town', 'Models', 'GLB format');
const RUINS_FBX = path.join(SRC, 'ruins-fbx');
const NATURE_FBX = path.join(SRC, 'nature-fbx');

// ---------------------------------------------------------------- drop lists
//
// Redundancy, not taste. Every name here is either already in items.glb, is
// covered better by the other kit in this same build, or is not a world piece.

const RUINS_DROP = new Set([
  'Character_Animated',                       // 4.1 MB rigged humanoid; not a ruins piece
  'Tree_1', 'Tree_2', 'Tree_3',               // nature.glb ships 5 species x 4 seasons
  'DeadTree_1', 'DeadTree_2', 'DeadTree_3',   // nature.glb ships 20 dead/dead-snow trees
  'Floor_Tree',                               // only piece needing Bark/Leaf textures
  'Bush_Large', 'Bush_Round', 'Grass',        // freeform; nature.glb covers these
  'Chest', 'Chest_Gold', 'Skull',             // items.glb already has Chest_* and Skull
]);

// Kenney authors at half world scale; see THE SCALE FIX in the header. Three
// measurements pin the factor at 2.000 / 2.000 / 0.992.
const TOWN_SCALE = 2;

const NATURE_DROP = new Set([
  // No desert biome exists in src/game/biomes.js (warren, ossuary, deepglass,
  // emberfall, rivenwaste, archonreach, whitedrift, verdantrot, cinderwaste).
  'Cactus_1', 'Cactus_2', 'Cactus_3', 'Cactus_4', 'Cactus_5',
  'CactusFlower_1', 'CactusFlowers_2', 'CactusFlowers_3', 'CactusFlowers_4', 'CactusFlowers_5',
]);

// ------------------------------------------------------------------- helpers

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

async function resolveBlender(explicit) {
  const tried = [];
  for (const c of [explicit, process.env.GB_BLENDER, BLENDER_APP, 'blender'].filter(Boolean)) {
    tried.push(c);
    if (c === 'blender') {
      try { await run('blender', ['--version'], { label: 'blender --version' }); return 'blender'; }
      catch { continue; }
    }
    if (await exists(c)) return c;
  }
  throw new Error(
    `Blender not found. Tried: ${tried.join(', ')}.\n` +
    `Set GB_BLENDER=/path/to/Blender or pass --blender. On this Mac it lives at ${BLENDER_APP} ` +
    `and is deliberately NOT on PATH.`,
  );
}

/** '<Wall_ArchRound>' -> 'ruin_wall_archround'; 'wall-doorway-square' -> 'town_wall_doorway_square' */
function keyFor(prefix, basename) {
  const slug = basename.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return prefix ? `${prefix}_${slug}` : slug;
}

// ------------------------------------------------------------- glTF plumbing

async function gltfIO() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

// --- minimal mat4 (column-major, glTF order) so bounds never depend on an API
//     shape I'd have to guess at.
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

/**
 * TRAP 5. Document.merge() carries the source scene across whole. Reparent its
 * roots into `target` under one node named `key`, then dispose the leftover
 * scene, or three.js renders exactly one piece out of N.
 */
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
  // Descendants get namespaced too: '(%ignore)' and 'door' recur across pieces
  // and duplicate names make getObjectByName non-deterministic.
  let n = 0;
  const rename = (node) => {
    for (const c of node.listChildren()) { c.setName(`${key}__part${n++}`); rename(c); }
  };
  rename(root);
  target.addChild(root);
  scene.dispose();
  return root;
}

/**
 * Multiply a subtree by a uniform scale, baked into the vertex data.
 *
 * NOT node.setScale(). A root-node scale is correct in the scene graph and
 * vanishes the instant a consumer does `getObjectByName(k).children[0].geometry`
 * to build an InstancedMesh — the geometry comes back at the authored size, the
 * building is half height, and nothing anywhere reports a problem. Child
 * translations are scaled alongside the meshes so offset parts stay put.
 */
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

/** Strip UVs from primitives whose material references no texture at all. */
function stripUnusedUVs(doc) {
  let removed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const textured = mat && [
        mat.getBaseColorTexture(), mat.getNormalTexture(), mat.getEmissiveTexture(),
        mat.getOcclusionTexture(), mat.getMetallicRoughnessTexture(),
      ].some(Boolean);
      if (textured) continue;
      for (const sem of prim.listSemantics()) {
        if (sem.startsWith('TEXCOORD_') || sem === 'TANGENT') { prim.setAttribute(sem, null); removed++; }
      }
    }
  }
  return removed;
}

/** TANGENT is only meaningful with a normal map. Nothing here has one. */
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
 * TRAP 6. baseColorFactor alpha 0 survives Blender AND the glTF export, and
 * three.js then renders correct geometry with a zero alpha channel: invisible,
 * no warning, no throw. Legitimately translucent materials (Kenney's fountain
 * 'Water') are allowed through; a hard 0 never is.
 */
function assertNoZeroAlpha(doc) {
  const bad = [];
  for (const m of doc.getRoot().listMaterials()) {
    const a = m.getBaseColorFactor()[3];
    if (a <= 0.001) bad.push(`${m.getName() || '(unnamed)'} alpha=${a}`);
  }
  if (bad.length) {
    throw new Error(
      `${bad.length} material(s) have baseColorFactor alpha 0 — the models will render ` +
      `as nothing with no error at all: ${bad.slice(0, 8).join(', ')}`,
    );
  }
}

async function glbStats(file) {
  const io = await gltfIO();
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
    rootNodes: scenes.length ? scenes[0].listChildren().length : 0,
    rootNames: scenes.length ? scenes[0].listChildren().map((n) => n.getName()) : [],
    nodeNames: names,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    meshes: root.listMeshes().length,
    triangles,
  };
}

// ------------------------------------------------------------ grid inference

/**
 * Kenney and Quaternius both author modular kits on a clean unit grid, but
 * neither ships the number. Infer it: try candidate cell sizes and score each
 * on how many pieces have a footprint that is a near-integer multiple of it.
 * A piece is only evidence if its footprint is at least half a cell — props
 * (a lantern, a skull) sit anywhere and say nothing about the grid.
 */
/**
 * How one axis of a piece relates to a candidate cell size.
 *
 * "Bounding box is an exact multiple of the cell" is NOT the same question as
 * "does this piece tile on the cell", and conflating them is wrong in a way
 * that matters: a Kenney roof is 2.134 m across on a 2 m grid because the eaves
 * overhang, and it tiles perfectly on 2 m centres. A strict multiple test
 * rejects every roof, every stair nosing and every moulding in the kit.
 *
 *   exact     within tolerance of N cells
 *   overhang  covers N cells and spills up to 0.3 of a cell decoratively
 *   half      a deliberate half-cell module (both kits ship them)
 *   sub       smaller than a cell — a wall slab, a column, a prop. Snap its
 *             CENTRE to the grid; its footprint says nothing.
 *   free      none of the above. Genuinely off-grid; place it by hand.
 */
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

/**
 * INFERENCE IS STRICT ON PURPOSE, and it is a different test from axisFit.
 *
 * axisFit's lenient labels (half, overhang) are right for describing a piece
 * once the grid is known and catastrophically wrong for finding the grid: every
 * piece on a 2 m grid is exactly a "half" of a 4 m grid, so allowing half-cells
 * here makes 4 outscore 2, and allowing overhang makes every candidate fit.
 * Scoring counts EXACT integer multiples and nothing else.
 */
function inferGrid(pieces, { tol = 0.05, minScore = 0.6 } = {}) {
  const candidates = [0.25, 0.5, 1, 2, 4];
  const scored = candidates.map((g) => {
    let hits = 0, considered = 0;
    for (const p of pieces) {
      for (const d of [p.size[0], p.size[2]]) {
        // A footprint under 3/4 of a cell is evidence of nothing — a lantern
        // sits anywhere. Excluding it also stops a too-large candidate winning
        // on a handful of survivors; the sample floor below is the other half.
        if (d < g * 0.75) continue;
        considered++;
        // ABSOLUTE tolerance, in cells. Scaling it by cell count (an earlier
        // version did) lets a 12-cell piece be 0.6 cells wrong, at which point
        // every candidate "fits" and the inference is worthless.
        if (Math.abs(d / g - Math.round(d / g)) <= tol) hits++;
      }
    }
    return { grid: g, hits, considered, score: considered ? Number((hits / considered).toFixed(4)) : 0 };
  });
  // Largest cell that explains a clear majority: 1.0 trivially "explains" a 2.0
  // grid, so a plain argmax always collapses to the smallest candidate. The
  // sample-size floor stops a 4.0 grid winning off six big pieces.
  const floor = Math.max(8, pieces.length * 0.25);
  const best = scored.filter((s) => s.score >= minScore && s.considered >= floor)
    .sort((a, b) => b.grid - a.grid)[0]
    || scored.slice().sort((a, b) => b.score - a.score)[0];
  return { grid: best.grid, confidence: best.score, scored, tolerance: tol };
}

/** Per-piece grid classification for the manifest. */
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

// ------------------------------------------------------------------ manifest

function buildManifest({ name, sources, grid, pieces, bytes, triangles, materials, textures, notes }) {
  return {
    file: `models/${name}.glb`,
    generatedBy: 'tools/build-world-glb.mjs',
    sources,
    grid: {
      // gridded:false means DO NOT SNAP. Nature is freeform scatter and the
      // best-scoring cell there is an artefact of small props, not a real grid.
      gridded: grid.confidence >= 0.6,
      unit: grid.confidence >= 0.6 ? grid.grid : null,
      bestGuess: grid.grid,
      confidence: grid.confidence,
      tolerance: grid.tolerance,
      onGridPieces: pieces.filter((p) => p.onGrid).length,
      note: grid.confidence >= 0.6
        ? `Cell size in metres on the XZ plane. Structural pieces span an integer number of ` +
          `cells. Per-piece "cells" is [x,z] in cells and "fit" is [x,z] in ` +
          `{exact, overhang, half, sub, free}. exact/overhang/half all tile on ${grid.grid} m ` +
          `centres — "overhang" only means eaves or a stair nosing spill past the cell, which is ` +
          `normal and must NOT be read as off-grid. "sub" is smaller than a cell (a wall slab, a ` +
          `column): snap its centre. "free" means place it by hand. Y is unconstrained.`
        : `NOT a modular grid kit — place these freely. bestGuess is the top-scoring candidate ` +
          `and it explains only ${Math.round(grid.confidence * 100)}% of footprints at a ` +
          `${grid.tolerance}-cell tolerance. Use each piece's own size instead.`,
    },
    gridCandidates: grid.scored,
    stats: { pieces: pieces.length, bytes, triangles, materials, textures },
    notes,
    pieces,
  };
}

// -------------------------------------------------------------- blender pass

/**
 * The Blender headless pass. This is tools/blender-items.py's pipeline —
 * '<name>__part' rename FIRST, shared material palette, one Empty per model
 * named after the file, alpha-0 fix — with ONE bug fixed, so it is emitted to a
 * temp file instead of calling that script directly.
 *
 * THE BUG (blender-items.py:90, hit for real on the ruins pack): bpy.ops.object
 * .join() deletes the objects it merged, and the script then iterates the list
 * of pre-join references to clean up leftovers:
 *
 *     for o in fresh:
 *         if o is not joined and o.name in bpy.data.objects:
 *     ReferenceError: StructRNA of type Object has been removed
 *
 * The item pack never tripped it because its FBX are one mesh each, so join()
 * was skipped by the `len(meshes) > 1` guard. 44 of the 78 ruins pieces are
 * multi-mesh. The fix is to hold NAMES across the join, not references.
 * blender-items.py should get the same fix; see the handoff note.
 */
const BLENDER_WORLD_PY = String.raw`
import bpy, json, os, re, sys

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT, STATS = argv[0], argv[1], argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene_col = bpy.context.scene.collection

names = sorted(f[:-4] for f in os.listdir(SRC)
               if f.lower().endswith('.fbx') and not f.startswith('.'))

SUFFIX = re.compile(r'\.\d{3,}$')
def base_name(n):
    return SUFFIX.sub('', n)

palette = {}
roots = []
per_model = {}
skipped = []

def deselect_all():
    for o in bpy.data.objects:
        o.select_set(False)

for name in names:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, name + '.fbx'))
    fresh = [o for o in bpy.data.objects if o not in before]
    if not fresh:
        raise RuntimeError('imported nothing from ' + name)

    # STEP 1 - rename FIRST. Creating the handle Empty with the same name as an
    # imported root makes Blender hand back 'Wall001' and every
    # getObjectByName in the game then returns null.
    for i, o in enumerate(fresh):
        o.name = '%s__part%d' % (name, i)

    # Hold NAMES, not references: join() invalidates every merged object's
    # StructRNA and touching one afterwards is a hard ReferenceError.
    fresh_names = [o.name for o in fresh]
    mesh_names = [o.name for o in fresh if o.type == 'MESH']
    if not mesh_names:
        skipped.append(name)
        for nm in fresh_names:
            o = bpy.data.objects.get(nm)
            if o is not None:
                bpy.data.objects.remove(o, do_unlink=True)
        continue

    # STEP 2 - collapse to the shared material palette. Each pack re-authors the
    # same handful of flat colours in every file; without this the GLB carries
    # hundreds of identical materials and three compiles a program for each.
    for nm in mesh_names:
        o = bpy.data.objects[nm]
        for slot in o.material_slots:
            m = slot.material
            if m is None:
                continue
            key = base_name(m.name)
            keep = palette.get(key)
            if keep is None:
                if m.name != key:
                    m.name = key
                palette[key] = m
            elif keep is not m:
                slot.material = keep

    # STEP 3 - one mesh per piece.
    deselect_all()
    for nm in mesh_names:
        bpy.data.objects[nm].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects[mesh_names[0]]
    if len(mesh_names) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = '%s__part' % name
    joined.data.name = '%s__mesh' % name
    joined_name = joined.name

    # Drop whatever survived that is not the joined mesh (stray empties,
    # armatures, lights). Resolved by name because join() ate the rest.
    for nm in fresh_names:
        if nm == joined_name:
            continue
        o = bpy.data.objects.get(nm)
        if o is not None:
            bpy.data.objects.remove(o, do_unlink=True)
    joined = bpy.data.objects[joined_name]

    # STEP 4 - the handle. This is the node the game looks up by name.
    holder = bpy.data.objects.new(name, None)
    holder.empty_display_size = 0.05
    scene_col.objects.link(holder)
    joined.parent = holder
    joined.matrix_parent_inverse.identity()

    tris = sum(max(0, len(p.vertices) - 2) for p in joined.data.polygons)
    d = joined.dimensions
    per_model[name] = {'triangles': tris, 'dims': [round(d.x, 4), round(d.y, 4), round(d.z, 4)]}
    roots.append(name)

    if holder.name != name:
        raise RuntimeError('node name collision: wanted %r got %r' % (name, holder.name))

# ------------------------------------------------------------- fix opacity
#
# The Quaternius FBX materials carry an opacity of 0. Blender's importer maps it
# onto Principled BSDF Alpha, the glTF exporter writes baseColorFactor alpha 0,
# and three.js hands back a material with opacity 0. alphaMode stays OPAQUE, so
# nothing warns and nothing throws: correct geometry, correct bounds, nothing
# drawn.
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    for node in m.node_tree.nodes:
        alpha = node.inputs.get('Alpha') if hasattr(node, 'inputs') else None
        if alpha is not None and not alpha.is_linked:
            alpha.default_value = 1.0
    try:
        m.blend_method = 'OPAQUE'
    except (AttributeError, TypeError):
        pass

for coll in (bpy.data.materials, bpy.data.meshes, bpy.data.images, bpy.data.armatures):
    for block in list(coll):
        if block.users == 0:
            coll.remove(block)

used_materials = set()
for o in bpy.data.objects:
    if o.type == 'MESH':
        for m in o.data.materials:
            if m:
                used_materials.add(m.name)

kwargs = dict(
    filepath=OUT, export_format='GLB', export_yup=True, export_apply=False,
    export_cameras=False, export_lights=False, export_animations=False,
    export_skins=False, export_morph=False, export_extras=False,
    export_tangents=False, use_selection=False, use_visible=False,
    export_materials='EXPORT',
)
try:
    bpy.ops.export_scene.gltf(**kwargs)
except TypeError:
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True)

with open(STATS, 'w') as fh:
    json.dump({
        'roots': roots,
        'models': len(roots),
        'skipped': skipped,
        'triangles': sum(v['triangles'] for v in per_model.values()),
        'materials': sorted(used_materials),
        'perModel': per_model,
    }, fh)

print('ITEMPACK_OK models=%d tris=%d materials=%d skipped=%d' % (
    len(roots), sum(v['triangles'] for v in per_model.values()),
    len(used_materials), len(skipped)))
`;

/**
 * Stage a filtered copy of an FBX kit and push it through the Blender pass
 * above.
 */
async function blenderKit({ srcDir, drop, blender, tmp, label }) {
  const stage = path.join(tmp, `${label}-src`);
  await fs.mkdir(stage, { recursive: true });
  const all = (await fs.readdir(srcDir)).filter((f) => f.toLowerCase().endsWith('.fbx') && !f.startsWith('.'));
  let kept = 0, dropped = [];
  for (const f of all) {
    const base = f.slice(0, -4);
    if (drop.has(base)) { dropped.push(base); continue; }
    await fs.copyFile(path.join(srcDir, f), path.join(stage, f));
    kept++;
  }
  console.log(`[${label}] ${all.length} FBX -> ${kept} kept, ${dropped.length} dropped` +
    (dropped.length ? ` (${dropped.join(', ')})` : ''));

  const rawGlb = path.join(tmp, `${label}-raw.glb`);
  const statsJson = path.join(tmp, `${label}-stats.json`);
  const script = path.join(tmp, 'blender-world.py');
  await fs.writeFile(script, BLENDER_WORLD_PY);
  const { out } = await run(blender, [
    '-b', '--factory-startup', '--python-exit-code', '1',
    '--python', script, '--', stage, rawGlb, statsJson,
  ], { label: `blender(${label})` });
  if (!/ITEMPACK_OK/.test(out)) throw new Error(`blender did not report success:\n${out.slice(-4000)}`);
  const stats = JSON.parse(await fs.readFile(statsJson, 'utf8'));
  console.log(`[${label}] blender exported ${stats.models} models, ${stats.triangles} tris, ` +
    `${stats.materials.length} materials`);
  return { rawGlb, stats, dropped };
}

// ------------------------------------------------------------------ assemble

async function finish({ doc, name, io, sources, notes }) {
  const { dedup, prune, unpartition } = await import('@gltf-transform/functions');

  const scene = doc.getRoot().getDefaultScene();
  const roots = scene.listChildren();

  // Bounds BEFORE gltfpack: post-quantisation numbers are the compressed
  // approximation, and the city builder snaps against the authored geometry.
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
  stripUnusedUVs(doc);
  // unpartition() is required, not cosmetic: mergeDocuments() brings each source
  // file's own Buffer across, and a GLB is allowed exactly one.
  await doc.transform(dedup(), prune(), unpartition());
  assertNoZeroAlpha(doc);

  const raw = path.join(os.tmpdir(), `gb-${name}-merged.glb`);
  await io.write(raw, doc);

  const mid = await glbStats(raw);
  if (mid.scenes !== 1) {
    throw new Error(`expected exactly 1 scene, got ${mid.scenes}. three.js renders only scenes[0], ` +
      `so a multi-scene file shows one piece and hides the other ${mid.scenes - 1}.`);
  }
  console.log(`[${name}] merged: ${mid.rootNodes} roots, ${mid.materials} materials, ` +
    `${mid.textures} textures, ${mid.triangles} tris, ${(fss.statSync(raw).size / 1024).toFixed(0)} KB raw`);

  // TRAP 3/4: meshopt via gltfpack, and -kn is mandatory.
  const gltfpack = path.join(ROOT, 'node_modules', '.bin', 'gltfpack');
  if (!(await exists(gltfpack))) throw new Error(`gltfpack not found at ${gltfpack} — run: npm i -D gltfpack`);
  await fs.mkdir(OUTDIR, { recursive: true });
  const outFile = path.join(OUTDIR, `${name}.glb`);
  await run(gltfpack, ['-i', raw, '-o', outFile, '-cc', '-kn'], { label: 'gltfpack' });

  const final = await glbStats(outFile);
  const missing = pieces.map((p) => p.key).filter((k) => !final.nodeNames.has(k));
  if (missing.length) {
    throw new Error(
      `${missing.length} node name(s) were lost by gltfpack (e.g. ${missing.slice(0, 5).join(', ')}). ` +
      `This is the -kn failure mode; the file loads without error and is unusable.`,
    );
  }
  if (final.scenes !== 1) throw new Error(`gltfpack produced ${final.scenes} scenes`);

  const bytes = (await fs.stat(outFile)).size;
  const manifest = buildManifest({
    name, sources, grid, pieces, bytes,
    triangles: final.triangles, materials: final.materials, textures: final.textures, notes,
  });
  const manifestFile = path.join(OUTDIR, `${name}.json`);
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);

  console.log(`[${name}] wrote ${path.relative(ROOT, outFile)}  ${(bytes / 1024).toFixed(1)} KB  ` +
    `${pieces.length} pieces  ${final.triangles} tris  ${final.materials} materials  grid ${grid.grid}`);
  await fs.rm(raw, { force: true });
  return { file: outFile, manifestFile, bytes, pieces: pieces.length, grid: grid.grid };
}

// ---------------------------------------------------------------- city build

export async function buildCityKit({ blenderPath = null } = {}) {
  const io = await gltfIO();
  const { Document } = await import('@gltf-transform/core');
  const { mergeDocuments } = await import('@gltf-transform/functions');

  if (!(await exists(KENNEY_GLB))) throw new Error(`Kenney kit not found at ${KENNEY_GLB}`);
  if (!(await exists(RUINS_FBX))) throw new Error(`Ruins kit not found at ${RUINS_FBX}`);

  const doc = new Document();
  const scene = doc.createScene('world');
  doc.getRoot().setDefaultScene(scene);

  // ---- Kenney Fantasy Town: already GLB, no Blender needed.
  const files = (await fs.readdir(KENNEY_GLB)).filter((f) => f.toLowerCase().endsWith('.glb')).sort();
  for (const f of files) {
    const src = await io.read(path.join(KENNEY_GLB, f));
    const srcScenes = src.getRoot().listScenes();
    if (srcScenes.length !== 1) throw new Error(`${f}: expected 1 scene, got ${srcScenes.length}`);
    mergeDocuments(doc, src);
    const mine = doc.getRoot().listScenes().filter((s) => s !== scene);
    if (mine.length !== 1) throw new Error(`${f}: merge left ${mine.length} loose scenes`);
    const key = keyFor('town', f.slice(0, -4));
    const root = adoptScene(doc, mine[0], scene, key);
    // See THE SCALE FIX at the top of this file. Baked into vertices, not nodes.
    await bakeUniformScale(root, TOWN_SCALE);
    root.setExtras({ source: `kenney-fantasy-town/${f}`, authoredScale: 1 / TOWN_SCALE });
  }
  console.log(`[citykit] merged ${files.length} Kenney GLB pieces (x${TOWN_SCALE} baked to metres)`);

  // ---- Quaternius Modular Ruins: FBX, so through Blender.
  const blender = await resolveBlender(blenderPath);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-world-'));
  const { rawGlb, stats } = await blenderKit({
    srcDir: RUINS_FBX, drop: RUINS_DROP, blender, tmp, label: 'ruins',
  });
  const ruinsDoc = await io.read(rawGlb);
  const rs = ruinsDoc.getRoot().listScenes();
  if (rs.length !== 1) throw new Error(`ruins raw glb has ${rs.length} scenes`);
  mergeDocuments(doc, ruinsDoc);
  const merged = doc.getRoot().listScenes().filter((s) => s !== scene);
  if (merged.length !== 1) throw new Error(`ruins merge left ${merged.length} loose scenes`);
  // The ruins scene holds ALL of its roots; adopt each one individually.
  const rScene = merged[0];
  for (const node of rScene.listChildren().slice()) {
    const orig = node.getName();
    const key = keyFor('ruin', orig);
    rScene.removeChild(node);
    node.setName(key);
    let i = 0;
    const rename = (nd) => { for (const c of nd.listChildren()) { c.setName(`${key}__part${i++}`); rename(c); } };
    rename(node);
    node.setExtras({ source: `quaternius-modular-ruins/${orig}.fbx` });
    scene.addChild(node);
  }
  rScene.dispose();
  console.log(`[citykit] merged ${stats.models} ruins pieces`);
  await fs.rm(tmp, { recursive: true, force: true });

  return finish({
    doc, name: 'citykit', io,
    sources: [
      {
        name: 'Kenney — Fantasy Town Kit 2.0', url: 'https://kenney.nl/assets/fantasy-town-kit',
        licence: 'CC0 1.0', prefix: 'town_', pieces: files.length,
        authoredGrid: 1 / TOWN_SCALE * 2, scaleBaked: TOWN_SCALE,
        note: `Authored on a 1.0 cell at half world scale; multiplied by ${TOWN_SCALE} INTO THE ` +
          `VERTEX DATA at build time so it shares the 2 m grid and metric scale of everything ` +
          `else. Sizes below are post-scale. Divide by ${TOWN_SCALE} to compare with Kenney's docs.`,
      },
      {
        name: 'Quaternius — Ultimate Modular Ruins Pack', url: 'https://quaternius.com/packs/ultimatemodularruins.html',
        licence: 'CC0 1.0', prefix: 'ruin_', pieces: stats.models,
        authoredGrid: 2, scaleBaked: 1,
        note: 'Already metric. Its How-To-Use.txt calls this a "1x1 grid", which is true in its ' +
          'own authoring units and is 2.0 world units after FBX import.',
      },
    ],
    notes: [
      'SCALE: everything in this file is metres, and so is nature.glb. The Kenney pieces were ' +
      `multiplied by ${TOWN_SCALE} at build time (baked into vertices, not node transforms) ` +
      'because the two kits are authored at different scales. Do not apply any further factor.',
      'PIVOTS: every piece is centred on its cell origin, so a cell spans -1..+1 in x and z, and ' +
      'y = 0 is the walk plane. Placing a piece at a cell centre is the whole placement rule.',
      'town_wall* is a 0.2-thick slab on the +X EDGE of the cell (x 0.8..1.0), full 2 m width in ' +
      'z, spanning y 0..2. Four of them at 90-degree yaw steps around one cell centre make a room.',
      'ruin_wall* is different and this WILL catch you: it spans the full cell in x and sits on ' +
      'the cell CENTRE line in z (z -0.25..0.03), so it bisects the cell instead of edging it. ' +
      'Town walls and ruin walls do not interchange without a half-cell offset.',
      'Ruins floor tiles hang below the walk plane (y -0.25..+0.03); the top face is y ~= 0, so ' +
      'they drop straight in at y = 0 with no offset.',
      'Ruins walls: turning a 90-degree corner needs the next wall flipped 180 degrees vertically ' +
      'or the corners overlap. ruin_curve_1 / ruin_curve_2 pre-bake that flip — use those.',
      'STOREY HEIGHT is 2 m in both sub-kits (town_wall y = 2.000, ruin_wall y = 2.001), so floors ' +
      'stack at 2 m intervals across both.',
      'town_* pieces are textured by ONE shared 512x512 colormap atlas (~11 KB) — the whole palette ' +
      'of the Kenney kit, and the only image in this file. ruin_* pieces are untextured flat ' +
      'material colours. Both are flat-shaded low-poly; there is no normal map and no PBR set.',
      'Keys are lowercase and prefixed because Kenney "wall.glb" and Quaternius "Wall.fbx" collide ' +
      'on case alone, which macOS hides and Android does not.',
    ],
  });
}

// -------------------------------------------------------------- nature build

export async function buildNature({ blenderPath = null } = {}) {
  const io = await gltfIO();
  if (!(await exists(NATURE_FBX))) throw new Error(`Nature kit not found at ${NATURE_FBX}`);

  const blender = await resolveBlender(blenderPath);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-world-'));
  const { rawGlb, stats } = await blenderKit({
    srcDir: NATURE_FBX, drop: NATURE_DROP, blender, tmp, label: 'nature',
  });

  const doc = await io.read(rawGlb);
  const scenes = doc.getRoot().listScenes();
  if (scenes.length !== 1) throw new Error(`nature raw glb has ${scenes.length} scenes`);
  const scene = scenes[0];
  scene.setName('world');
  doc.getRoot().setDefaultScene(scene);
  for (const node of scene.listChildren()) {
    const orig = node.getName();
    const key = keyFor(null, orig);
    node.setName(key);
    let i = 0;
    const rename = (nd) => { for (const c of nd.listChildren()) { c.setName(`${key}__part${i++}`); rename(c); } };
    rename(node);
    node.setExtras({ source: `quaternius-ultimate-nature/${orig}.fbx` });
  }
  await fs.rm(tmp, { recursive: true, force: true });

  return finish({
    doc, name: 'nature', io,
    sources: [
      { name: 'Quaternius — Ultimate Nature Pack', url: 'https://quaternius.com/packs/ultimatenature.html', licence: 'CC0 1.0', prefix: '', pieces: stats.models },
    ],
    notes: [
      'SCATTER, NOT A GRID. grid.gridded is false and every piece has onGrid false. Do not snap ' +
      'these to anything — use each piece\'s own size, and treat max(size[0], size[2]) / 2 as its ' +
      'footprint radius for collision and spacing.',
      'Metres, same as citykit.glb. Pivots are at the base: y = 0 is ground, so pieces drop in at ' +
      'terrain height with no offset.',
      'Season/biome variants share a stem: <species>_N, <species>_autumn_N, <species>_snow_N, ' +
      '<species>_dead_N, <species>_dead_snow_N. snow + dead_snow are the whitedrift set; autumn ' +
      'feeds verdantrot and emberfall; dead feeds rivenwaste and cinderwaste.',
      'Variants that share geometry and differ only in material were collapsed to one mesh by ' +
      'gltfpack, so the seasonal sets are close to free — 172,996 authored triangles became ' +
      '120,125 unique ones. Reuse variants freely; they cost node count, not memory.',
      'Untextured flat material colours throughout — no image is shipped with this file. 18 ' +
      'materials for 140 pieces, so an InstancedMesh per piece is cheap.',
    ],
  });
}

// ------------------------------------------------------------------- verify

/**
 * GLTFLoader decodes embedded images through `self.URL.createObjectURL` and
 * `document.createElementNS('img')`. items.glb has no textures so tools/
 * items-verify.mjs never met this; citykit.glb carries the Kenney colormap and
 * the loader dies with a bare `ReferenceError: self is not defined` — in Node
 * only. This shims just enough DOM to get past it.
 *
 * BE CLEAR ABOUT WHAT THIS DOES NOT PROVE: the image bytes are never decoded
 * here, so this says nothing about the texture being valid. The texture is
 * checked separately, for real, through gltf-transform in checkTexture().
 */
function installHeadlessImageShim() {
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (typeof globalThis.document !== 'undefined') return;
  globalThis.document = {
    createElementNS() {
      const listeners = {};
      return {
        width: 1, height: 1, style: {},
        addEventListener(t, f) { (listeners[t] || (listeners[t] = [])).push(f); },
        removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
        set src(_v) {
          queueMicrotask(() => { for (const f of listeners.load || []) f({ target: this }); });
        },
        get src() { return 'blob:headless'; },
      };
    },
  };
}

/** The real texture check — bytes, mime and dimensions, straight off the GLB. */
async function checkTexture(file) {
  const io = await gltfIO();
  const doc = await io.read(file);
  return doc.getRoot().listTextures().map((t) => ({
    name: t.getName(),
    mime: t.getMimeType(),
    size: t.getSize(),
    bytes: t.getImage() ? t.getImage().byteLength : 0,
    usedBy: doc.getRoot().listMaterials()
      .filter((m) => m.getBaseColorTexture() === t).map((m) => m.getName()),
  }));
}

/**
 * Parse the committed GLBs through the SAME GLTFLoader + MeshoptDecoder the
 * game uses, so a decoder or -kn mismatch fails here rather than on a phone.
 */
export async function verifyWorldGlbs() {
  installHeadlessImageShim();
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');

  let failures = 0;
  const check = (n, ok, d = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
    return ok;
  };

  for (const name of ['citykit', 'nature']) {
    const glb = path.join(OUTDIR, `${name}.glb`);
    const mf = path.join(OUTDIR, `${name}.json`);
    console.log(`\n=== ${name}.glb`);
    if (!fss.existsSync(glb) || !fss.existsSync(mf)) {
      check(`${name}.glb + ${name}.json exist`, false, 'run: node tools/build-world-glb.mjs');
      continue;
    }
    const bytes = fss.statSync(glb).size;
    const manifest = JSON.parse(fss.readFileSync(mf, 'utf8'));
    const buf = fss.readFileSync(glb);
    const gltf = await new Promise((res, rej) => {
      const l = new GLTFLoader();
      l.setMeshoptDecoder(MeshoptDecoder);
      l.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej);
    });
    check('parses through GLTFLoader + MeshoptDecoder', true, `${(bytes / 1024).toFixed(1)} KB`);
    check('exactly one scene', gltf.scenes.length === 1, `${gltf.scenes.length}`);

    const roots = gltf.scene.children;
    check('root count matches manifest', roots.length === manifest.pieces.length,
      `glb ${roots.length} vs manifest ${manifest.pieces.length}`);
    check('no root lost its name', roots.every((o) => o.name), 'the gltfpack -kn failure mode');
    const lower = roots.filter((o) => o.name !== o.name.toLowerCase());
    check('every key is lowercase', lower.length === 0, lower.map((o) => o.name).join(', '));
    const dupes = roots.map((o) => o.name).filter((n, i, a) => a.indexOf(n) !== i);
    check('no duplicate root names', dupes.length === 0, dupes.join(', '));
    const suffixed = roots.filter((o) => /\.\d{3}$/.test(o.name) || /__\d{3}$/.test(o.name));
    check('no Blender collision suffixes', suffixed.length === 0, suffixed.map((o) => o.name).join(', '));

    // Every manifest key must resolve, and its size must match what we recorded.
    let unresolved = 0, mismatched = [];
    for (const p of manifest.pieces) {
      const o = gltf.scene.getObjectByName(p.key);
      if (!o) { unresolved++; continue; }
      const s = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
      const tol = 0.02 + 0.01 * Math.max(p.size[0], p.size[1], p.size[2]);
      if (Math.abs(s.x - p.size[0]) > tol || Math.abs(s.y - p.size[1]) > tol || Math.abs(s.z - p.size[2]) > tol) {
        mismatched.push(`${p.key} manifest ${p.size.join('x')} vs glb ${[s.x, s.y, s.z].map((v) => v.toFixed(3)).join('x')}`);
      }
    }
    check('every manifest key resolves via getObjectByName', unresolved === 0, `${unresolved} missing`);
    check('manifest dimensions match the compressed GLB', mismatched.length === 0,
      `${mismatched.length} off: ${mismatched.slice(0, 4).join(' | ')}`);

    // Invisible-geometry trap.
    const zero = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m && m.opacity <= 0.001) zero.push(m.name || o.name);
      }
    });
    check('no material has opacity 0', zero.length === 0, zero.slice(0, 6).join(', '));

    let tris = 0; const mats = new Set();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) mats.add(m.uuid);
      const g = o.geometry;
      tris += Math.floor((g.index ? g.index.count : (g.attributes.position?.count || 0)) / 3);
    });
    check('material palette collapsed', mats.size <= 40, `${mats.size} materials, ${tris} triangles`);

    // A textured material whose mesh lost its UVs samples one texel and renders
    // a uniform colour. An untextured material left at pure black renders as a
    // silhouette. Both look like a lighting bug and neither raises anything.
    const noUV = [], black = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        if (m.map && !o.geometry.attributes.uv) noUV.push(`${o.name}/${m.name}`);
        if (!m.map && m.color && m.color.getHex() === 0x000000) black.push(`${o.name}/${m.name}`);
      }
    });
    check('every textured mesh kept its UVs', noUV.length === 0, noUV.slice(0, 6).join(', '));
    check('no untextured material is pure black', black.length === 0, black.slice(0, 6).join(', '));

    const texes = await checkTexture(glb);
    if (name === 'citykit') {
      check('exactly one shared colormap atlas survives dedup', texes.length === 1,
        texes.map((t) => `${t.name} ${t.mime} ${t.size?.join('x')} ${t.bytes}B used by [${t.usedBy}]`).join(' | '));
      check('the atlas is actually referenced by a material',
        texes.length === 1 && texes[0].usedBy.length > 0, JSON.stringify(texes[0]?.usedBy));
    } else {
      check('no textures shipped', texes.length === 0, `${texes.length}`);
    }

    // --- grid inference re-checked against pieces measured out of the GLB the
    //     game actually loads, not out of the manifest. Tolerance is ABSOLUTE in
    //     cells: an earlier version scaled it by cell count, so a 12-cell piece
    //     could be 0.6 cells wrong and still "pass", and every candidate grid
    //     passed. 10 structural pieces, chosen largest-first.
    const unit = manifest.grid.unit;
    if (!unit) {
      console.log(`--- grid check: manifest declares gridded=false ` +
        `(best guess ${manifest.grid.bestGuess} explains only ` +
        `${Math.round(manifest.grid.confidence * 100)}%), nothing to snap-check`);
      const anySnapped = manifest.pieces.some((p) => p.onGrid);
      check('non-gridded manifest flags no piece as onGrid', !anySnapped);
    } else {
      // Sample the 10 largest pieces the manifest claims sit EXACTLY on the
      // grid, re-measure them out of the compressed GLB, and require both that
      // the axis really is an integer number of cells and that the cell count
      // the manifest published is the one the geometry actually has. The second
      // half is the point: the city builder places from the manifest, so a
      // manifest that disagrees with the mesh is the failure that matters.
      const sample = manifest.pieces
        .filter((p) => p.fit && p.fit.includes('exact'))
        .sort((a, b) => (b.size[0] * b.size[2]) - (a.size[0] * a.size[2]))
        .slice(0, 10);
      console.log(`--- grid check: unit ${unit} m, ${manifest.grid.onGridPieces}/` +
        `${manifest.pieces.length} pieces on-grid; hand-checking the 10 largest ` +
        `exact-fit pieces against the GLB`);
      let ok = 0;
      for (const p of sample) {
        const o = gltf.scene.getObjectByName(p.key);
        const s = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
        const axes = [s.x, s.z];
        let good = true;
        const parts = [];
        for (let a = 0; a < 2; a++) {
          const declared = p.fit[a];
          const k = axes[a] / unit;
          const err = Math.abs(k - Math.round(k));
          if (declared === 'exact') {
            const agrees = err <= 0.06 && Math.round(k) === p.cells[a];
            if (!agrees) good = false;
            parts.push(`${'xz'[a]}=${Math.round(k)}c exact err${err.toFixed(3)}${agrees ? '' : ' MISMATCH'}`);
          } else {
            parts.push(`${'xz'[a]}=${declared}`);
          }
        }
        if (good) ok++;
        console.log(`    ${good ? 'ok  ' : 'OFF '} ${p.key.padEnd(32)} ` +
          `${s.x.toFixed(3)} x ${s.y.toFixed(3)} x ${s.z.toFixed(3)} m   ${parts.join('  ')}`);
      }
      check(`grid ${unit} m holds for all 10 hand-checked pieces`, ok === 10 && sample.length === 10,
        `${ok}/${sample.length}`);

      // Say out loud what the grid does NOT explain, so nobody reads a pass as
      // "every piece snaps".
      const off = manifest.pieces.filter((p) => !p.onGrid)
        .sort((a, b) => (b.size[0] * b.size[2]) - (a.size[0] * a.size[2])).slice(0, 6);
      if (off.length) {
        console.log(`    off-grid props (expected — place freely): ` +
          off.map((p) => `${p.key} ${p.size[0]}x${p.size[2]}`).join(', '));
      }
    }
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll world-kit checks passed');
  return failures;
}

// ------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const only = opt('only', null);
  const blenderPath = opt('blender', null);
  try {
    if (argv.includes('--verify')) {
      process.exit((await verifyWorldGlbs()) ? 1 : 0);
    }
    if (!only || only === 'city') await buildCityKit({ blenderPath });
    if (!only || only === 'nature') await buildNature({ blenderPath });
    if (!only) process.exit((await verifyWorldGlbs()) ? 1 : 0);
  } catch (e) {
    console.error(`[world] FAILED: ${e.message}`);
    process.exit(1);
  }
}
