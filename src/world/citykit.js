import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// THE CITY'S GEOMETRY KIT
// ---------------------------------------------------------------------------
// Two sources, one placement API.
//
//   1. public/models/citykit.glb — 245 CC0 pieces (Kenney Fantasy Town 2.0 as
//      `town_*`, Quaternius Modular Ruins as `ruin_*`), converted by
//      tools/build-world-glb.mjs. This is what the city actually looks like.
//   2. A procedural stand-in for every piece the city places, authored to the
//      SAME bounds and the SAME pivot as its kit counterpart.
//
// Rule (2) is the whole design of this file. city.js never asks "did the GLB
// load?" — it asks for a piece by key and gets a geometry with a known origin
// either way, so a missing or corrupt asset degrades to a blocky city rather
// than an empty plane or a crash. An offline game that ships one APK cannot
// afford a second code path that has never been run.
//
// PLACEMENT CONVENTIONS, measured off public/models/citykit.json, not guessed:
//   * The grid is 2.0 m. A cell centred on (i*2, j*2) spans -1..+1 in x and z.
//   * y = 0 is the walk plane. Storey height is 2.0 m in BOTH sub-kits.
//   * `town_wall*` is a 0.2 m slab on the +X EDGE of its cell (x 0.8..1.0),
//     full 2 m in z. rotation.y maps local +X to (cos, -sin), so:
//        yaw 0     -> east edge      yaw  PI/2 -> north edge (-Z)
//        yaw PI    -> west edge      yaw -PI/2 -> south edge (+Z)
//     Four walls at those four yaws around one cell centre make a closed room.
//   * `ruin_wall*` BISECTS its cell instead of edging it and does NOT
//     interchange with town walls. The city only uses ruins as free-standing
//     rubble, so that trap never fires here.
//   * `town_roof` is a SINGLE PITCH falling toward -X with the eave overhang on
//     that side (x -1.134..1, y -0.045..1.252). A gable is therefore two
//     columns of it, the low side facing out on each flank; anything else
//     tiles into a sawtooth. Verified by rendering, not by reading the name.
//
// EVERY KEY IS LOWERCASE. macOS hides case collisions; Android does not.
//
// Draw-call model: one InstancedMesh per piece TYPE for the whole city (a
// KitField), not per chunk and never a clone per building. ~40 fields cover
// several thousand placements. Splitting those fields per 64 m chunk would
// multiply the draw calls by the number of visible chunks, which is the
// opposite of the goal; see the note in city.js.

export const KIT_URL = 'models/citykit.glb';
export const KIT_CELL = 2.0;      // grid size in metres, from citykit.json
export const KIT_STOREY = 2.0;    // floor-to-floor, both sub-kits

// Local +X of a piece points at this edge of its cell after rotation.y = yaw.
export const YAW_EAST = 0;
export const YAW_NORTH = Math.PI / 2;
export const YAW_WEST = Math.PI;
export const YAW_SOUTH = -Math.PI / 2;

// ---------------------------------------------------------------------------
// Spec surface: the twelve building modules and nine street props.
// Each entry names the kit piece it resolves to plus its authored footprint,
// so a caller can lay pieces out without loading the GLB first.
// ---------------------------------------------------------------------------

export const MODULES = {
  base:     { piece: 'town_wall',              size: [0.2, 2.0, 2.0], edge: true },
  mid:      { piece: 'town_wall_wood',         size: [0.2, 2.0, 2.0], edge: true },
  cap:      { piece: 'town_roof',              size: [2.134, 1.252, 2.0], edge: false },
  parapet:  { piece: 'town_wall_half',         size: [0.2, 1.0, 2.0], edge: true },
  awning:   { piece: 'town_overhang',          size: [0.57, 0.66, 2.0], edge: true },
  sign:     { piece: 'town_banner_red',        size: [0.1, 1.679, 1.0], edge: true },
  stair:    { piece: 'town_stairs_stone',      size: [2.04, 2.0, 1.0], edge: false },
  pillar:   { piece: 'town_pillar_stone',      size: [0.32, 2.0, 0.32], edge: false },
  arch:     { piece: 'town_wall_arch_top',     size: [0.2, 2.0, 2.0], edge: true },
  vent:     { piece: 'town_chimney_top',       size: [0.504, 1.25, 0.68], edge: true },
  balcony:  { piece: 'town_balcony_wall',      size: [0.66, 2.0, 2.0], edge: true },
  antenna:  { piece: 'town_poles',             size: [0.2, 2.0, 2.0], edge: true },
};

export const PROPS = {
  lamp:     { piece: 'town_lantern',      size: [0.433, 3.112, 0.449] },
  bollard:  { piece: 'town_pillar_wood',  size: [0.32, 2.0, 0.32] },
  bench:    { piece: 'town_stall_bench',  size: [0.52, 0.451, 1.88] },
  bin:      { piece: 'town_stall_stool',  size: [0.52, 0.451, 0.52] },
  planter:  { piece: 'town_hedge',        size: [0.5, 0.5, 2.0] },
  crate:    { piece: 'town_cart',         size: [1.786, 1.071, 2.68] },
  banner:   { piece: 'town_banner_green', size: [0.1, 1.679, 1.0] },
  barrier:  { piece: 'town_fence',        size: [0.15, 0.76, 2.0] },
  notice:   { piece: 'town_stall',        size: [1.3, 0.731, 2.0] },
};

// ---------------------------------------------------------------------------
// GLB loading and indexing
// ---------------------------------------------------------------------------

// lowercase key -> { parts: [{ geometry, material, offset: Matrix4 }], box }
const _kit = new Map();
let _kitLoaded = false;
let _kitLoading = null;
let _kitTextures = new Set();
// Metre-space Float32 copies, built lazily for callers outside the instancing
// path (moduleGeometry / propGeometry / buildFacade). See bakePiece().
const _bakedCache = new Map();

/**
 * Index one GLB scene root into instanceable parts.
 *
 * THE TRAP THIS FUNCTION EXISTS TO AVOID, hit for real and worth a paragraph:
 * citykit.glb is gltfpack output with KHR_mesh_quantization, so every position
 * attribute is a raw Int16 in a +/-32767 lattice and the dequantisation scale
 * lives on the MESH NODE's transform, not in the vertex data. The obvious
 * implementation — clone the geometry and applyMatrix4() the node transform
 * into it, so an InstancedMesh can use it directly — silently destroys that:
 * BufferAttribute.applyMatrix4 reads the raw integers, scales them, and writes
 * them back into the same Int16 array, where they clamp. The city built, the
 * counts were right, every assertion passed, and each wall was a 65-kilometre
 * slab. From the ground it read as flat bands of colour with no error anywhere.
 *
 * So the node transform is NOT baked. It is kept per part as `offset`, and
 * KitField multiplies it into every instance matrix instead. Vertex data is
 * never touched, quantisation survives to the GPU (which is the entire point
 * of shipping meshopt), and the bug cannot recur.
 */
function indexPiece(root) {
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  // Group by material AND transform: two primitives can only share one
  // InstancedMesh if they agree on both.
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const offset = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const key = `${mat ? mat.uuid : 'null'}|${offset.elements.map((e) => e.toFixed(5)).join()}`;
    let g = groups.get(key);
    if (!g) { g = { material: mat, offset, geos: [] }; groups.set(key, g); }
    g.geos.push(o.geometry);
  });
  if (!groups.size) return null;

  const parts = [];
  const box = new THREE.Box3();
  const b = new THREE.Box3();
  for (const { material, offset, geos } of groups.values()) {
    let geo = geos[0];
    if (geos.length > 1) {
      const merged = tryMerge(geos.map((x) => x.clone()));
      if (merged) geo = merged;
    }
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    parts.push({ geometry: geo, material, offset });
    b.copy(geo.boundingBox).applyMatrix4(offset);
    box.union(b);
  }
  return { parts, box };
}

/** Float32 copy of an attribute, honouring `normalized`. */
function toFloat(attr) {
  if (attr.array instanceof Float32Array) return attr.clone();
  const out = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
  }
  return new THREE.BufferAttribute(out, attr.itemSize);
}

/**
 * A single metre-space, Float32, offset-applied geometry for one kit piece.
 *
 * The instancing path never calls this — it would throw away the quantisation
 * the GLB is compressed with. It exists because moduleGeometry/propGeometry
 * are a published contract and a caller who merges the result into their own
 * geometry needs real metres, not a lattice index.
 */
function bakePiece(key) {
  const cached = _bakedCache.get(key);
  if (cached) return cached;
  const entry = _kit.get(key);
  if (!entry) return null;
  const baked = [];
  for (const p of entry.parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', toFloat(p.geometry.attributes.position));
    if (p.geometry.attributes.normal) g.setAttribute('normal', toFloat(p.geometry.attributes.normal));
    if (p.geometry.attributes.uv) g.setAttribute('uv', toFloat(p.geometry.attributes.uv));
    if (p.geometry.index) g.setIndex(Array.from(p.geometry.index.array));
    g.applyMatrix4(p.offset);
    baked.push(g);
  }
  let geo = baked.length === 1 ? baked[0] : (tryMerge(baked) || baked[0]);
  if (baked.length > 1 && geo !== baked[0]) baked.forEach((g) => g.dispose());
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  _bakedCache.set(key, geo);
  return geo;
}

function tryMerge(geos) {
  try {
    return mergeGeometries(geos, false);
  } catch {
    return null;
  }
}

/**
 * Load public/models/citykit.glb. Resolves TRUE on success and FALSE on any
 * failure — it never throws and never rejects, exactly like loadItemModels.
 * On false, every pieceGeometry() call falls through to its procedural twin.
 */
export async function loadCityKit(url = KIT_URL) {
  if (_kitLoaded) return true;
  if (_kitLoading) return _kitLoading;

  _kitLoading = new Promise((resolve) => {
    let loader;
    try {
      loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
    } catch {
      resolve(false);
      return;
    }
    loader.load(url, (gltf) => {
      try {
        for (const child of gltf.scene.children) {
          if (!child.name) continue;
          const entry = indexPiece(child);
          if (entry) _kit.set(child.name.toLowerCase(), entry);
        }
        // The item pack shipped materials with opacity 0 that survived every
        // stage of the pipeline and drew nothing. Correct geometry, correct
        // bounds, invisible. Cheap to check, expensive to miss.
        for (const entry of _kit.values()) {
          for (const p of entry.parts) {
            const m = p.material;
            if (!m) continue;
            if (!m.transparent && m.opacity < 1) m.opacity = 1;
            if (m.map) _kitTextures.add(m.map);
          }
        }
        _kitLoaded = _kit.size > 0;
        resolve(_kitLoaded);
      } catch {
        resolve(false);
      }
    }, undefined, () => resolve(false));
  });
  return _kitLoading;
}

export function cityKitLoaded() { return _kitLoaded; }
export function hasPiece(key) { return _kit.has(String(key).toLowerCase()) || key in PROC; }
export function listKitPieces() { return Array.from(_kit.keys()).sort(); }

/** Authored bounds of a piece in metres, kit or procedural. */
export function pieceBounds(key) {
  const k = String(key).toLowerCase();
  const entry = _kit.get(k);
  if (entry) {
    const b = entry.box;
    return { min: b.min.clone(), max: b.max.clone(), size: b.getSize(new THREE.Vector3()) };
  }
  const g = procGeometry(k);
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  const bp = g.boundingBox;
  return { min: bp.min.clone(), max: bp.max.clone(), size: bp.getSize(new THREE.Vector3()) };
}

// ---------------------------------------------------------------------------
// Procedural stand-ins
// ---------------------------------------------------------------------------
// Authored to the same bounds and pivot as the kit piece they replace. These
// are also what MODULES/PROPS resolve to when the GLB is absent, and what
// buildFacade / buildBlock are made of.

const COL = {
  plaster: 0xcfd4e2,
  wood:    0x8a5a34,
  darkwood:0x5c3a20,
  stone:   0x8f95a3,
  roof:    0x3fae9a,
  slate:   0x5c6474,
  leaf:    0x3e7a4c,
  trunk:   0x6b4a2c,
  cloth:   0xb3413c,
  cloth2:  0x3f8a52,
  rock:    0x7b8090,
};

const _procCache = new Map();
// NOT convertSRGBToLinear(). three's ColorManagement is on by default in
// r152+, so `new THREE.Color(0x8a5a34)` has ALREADY converted the hex into the
// linear working space. Converting again squares the value: 0x6a6144 lands at
// (0.019, 0.014, 0.005) instead of (0.145, 0.118, 0.058), which is an eighth of
// the intended brightness and reads as "the lighting is broken", not "the
// colours are wrong". Shader uniforms are the opposite case — raw ShaderMaterial
// uniforms get no automatic conversion, which is why sky.js does call it.
const _linear = (hex) => new THREE.Color(hex);

function paint(geo, hex) {
  const c = _linear(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Axis-aligned box spanning [x0,x1] x [y0,y1] x [z0,z1], vertex-coloured. */
function slab(x0, x1, y0, y1, z0, z1, hex) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return paint(g, hex);
}

/** Single-pitch roof prism: low edge at x0, ridge at x1. Matches town_roof. */
function wedge(x0, x1, yBase, yLow, yHigh, z0, z1, hex) {
  const p = [
    x0, yBase, z0, x1, yBase, z0, x1, yBase, z1, x0, yBase, z1,       // 0..3 underside
    x0, yLow, z0, x1, yHigh, z0, x1, yHigh, z1, x0, yLow, z1,          // 4..7 top
  ];
  const idx = [
    0, 2, 1, 0, 3, 2,           // bottom
    4, 5, 6, 4, 6, 7,           // top
    0, 1, 5, 0, 5, 4,           // -z
    3, 7, 6, 3, 6, 2,           // +z
    1, 2, 6, 1, 6, 5,           // ridge end (+x)
    0, 4, 7, 0, 7, 3,           // eave end (-x)
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  // A uv attribute nobody samples, purely so this can be merged with
  // BoxGeometry: mergeGeometries requires an identical attribute set across
  // every input and returns null (with a console warning nobody reads) when
  // one member is missing a channel.
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(16), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return paint(g, hex);
}

function group(parts) {
  if (parts.length === 1) return parts[0];
  const merged = mergeGeometries(parts, false);
  if (!merged) {
    // Never return null into a geometry slot; fall back to the largest input.
    return parts.reduce((a, b) => (
      (a.attributes.position.count >= b.attributes.position.count) ? a : b));
  }
  parts.forEach((p) => p.dispose());
  return merged;
}

// A wall slab on the +X edge of the cell, optionally with a door or window
// panel punched into the face so the procedural city still reads as buildings.
function procWall(hex, kind) {
  const parts = [slab(0.8, 1.0, 0, 2, -1, 1, hex)];
  if (kind === 'door') parts.push(slab(0.76, 0.82, 0.02, 1.5, -0.42, 0.42, COL.darkwood));
  if (kind === 'window') parts.push(slab(0.76, 0.82, 0.85, 1.55, -0.45, 0.45, 0x2a3550));
  return group(parts);
}

const PROC = {
  // --- walls -------------------------------------------------------------
  town_wall:                      () => procWall(COL.plaster),
  town_wall_wood:                 () => procWall(COL.wood),
  town_wall_half:                 () => slab(0.8, 1.0, 0, 1, -1, 1, COL.plaster),
  town_wall_door:                 () => procWall(COL.plaster, 'door'),
  town_wall_wood_door:            () => procWall(COL.wood, 'door'),
  town_wall_window_glass:         () => procWall(COL.plaster, 'window'),
  town_wall_window_shutters:      () => procWall(COL.plaster, 'window'),
  town_wall_wood_window_shutters: () => procWall(COL.wood, 'window'),
  town_wall_wood_window_round:    () => procWall(COL.wood, 'window'),
  town_wall_arch_top:             () => procWall(COL.stone),
  town_wall_block:                () => slab(-1, 1, 0, 2, -1, 1, COL.stone),
  town_balcony_wall:              () => procWall(COL.wood),
  town_poles:                     () => slab(0.85, 0.95, 0, 2, -1, 1, COL.darkwood),
  town_overhang:                  () => slab(0.28, 0.85, 1.34, 2.0, -1, 1, COL.darkwood),

  // --- roof --------------------------------------------------------------
  town_roof:      () => wedge(-1.134, 1, -0.045, 0.15, 1.252, -1, 1, COL.roof),
  town_roof_flat: () => slab(-1, 1, 0, 0.252, -1, 1, COL.slate),

  // --- structure ---------------------------------------------------------
  town_pillar_stone: () => slab(-0.16, 0.16, 0, 2, -0.16, 0.16, COL.stone),
  town_pillar_wood:  () => slab(-0.16, 0.16, 0, 2, -0.16, 0.16, COL.darkwood),
  town_stairs_stone: () => group([
    slab(-1.04, 1, 0, 0.5, -0.5, 0.5, COL.stone),
    slab(-0.5, 1, 0.5, 1.0, -0.5, 0.5, COL.stone),
    slab(0.1, 1, 1.0, 1.5, -0.5, 0.5, COL.stone),
    slab(0.6, 1, 1.5, 2.0, -0.5, 0.5, COL.stone),
  ]),
  town_chimney_top:  () => slab(0.426, 0.93, 0, 1.25, -0.34, 0.34, COL.stone),

  // --- street furniture --------------------------------------------------
  town_lantern: () => group([
    slab(-0.06, 0.06, 0, 2.7, -0.06, 0.06, COL.slate),
    slab(-0.2, 0.2, 2.7, 3.11, -0.2, 0.2, COL.slate),
  ]),
  town_stall_bench: () => group([
    slab(-0.26, 0.26, 0.34, 0.45, -0.94, 0.94, COL.wood),
    slab(-0.2, -0.1, 0, 0.34, -0.85, -0.6, COL.darkwood),
    slab(-0.2, -0.1, 0, 0.34, 0.6, 0.85, COL.darkwood),
  ]),
  town_stall_stool: () => slab(-0.26, 0.26, 0, 0.45, -0.26, 0.26, COL.wood),
  town_fence:  () => slab(0.85, 1.0, 0, 0.76, -1, 1, COL.darkwood),
  town_hedge:  () => slab(0.5, 1.0, 0, 0.5, -1, 1, COL.leaf),
  town_stall:  () => slab(-0.65, 0.65, 0, 0.731, -1, 1, COL.wood),
  town_cart:   () => group([
    slab(-0.89, 0.89, 0.35, 1.07, -1.29, 1.19, COL.wood),
    slab(-0.89, 0.89, 0, 0.35, -0.7, 0.7, COL.darkwood),
  ]),
  town_stall_red:   () => group([
    slab(-1, 1, 0, 0.8, -1, 1, COL.wood),
    slab(-1, 1, 1.9, 2.47, -1, 1, COL.cloth),
  ]),
  town_stall_green: () => group([
    slab(-1, 1, 0, 0.8, -1, 1, COL.wood),
    slab(-1, 1, 1.9, 2.47, -1, 1, COL.cloth2),
  ]),
  town_banner_red:   () => slab(0.75, 0.85, 0.321, 2.0, -0.5, 0.5, COL.cloth),
  town_banner_green: () => slab(0.75, 0.85, 0.321, 2.0, -0.5, 0.5, COL.cloth2),

  // --- nature ------------------------------------------------------------
  town_tree: () => group([
    slab(-0.22, 0.22, 0, 1.8, -0.22, 0.22, COL.trunk),
    coneGeo(1.02, 3.1, 1.75, COL.leaf),
  ]),
  town_tree_high: () => group([
    slab(-0.22, 0.22, 0, 2.2, -0.22, 0.22, COL.trunk),
    coneGeo(1.02, 3.75, 2.15, COL.leaf),
  ]),
  town_rock_large: () => paint(dodec(1.6, 0, 1.1, 0), COL.rock),
  town_rock_small: () => paint(dodec(1.0, 0, 1.0, 0), COL.rock),

  // --- ruins (the Breach, and rubble) -------------------------------------
  ruin_floor_standard: () => slab(-1, 1, -0.25, 0.03, -1, 1, COL.stone),
  ruin_column_round:   () => cylGeo(0.26, 4.0, COL.stone),
  ruin_column_round_short: () => cylGeo(0.26, 2.0, COL.stone),
  ruin_arch_gothic:    () => group([
    slab(-1.55, -1.15, 0, 3.4, -0.37, 0.13, COL.stone),
    slab(1.15, 1.55, 0, 3.4, -0.37, 0.13, COL.stone),
    slab(-1.55, 1.55, 3.4, 3.76, -0.37, 0.13, COL.stone),
  ]),
  ruin_wall_broken: () => group([
    slab(-1, 0.1, 0, 1.4, -0.13, 0.13, COL.stone),
    slab(0.1, 1, 0, 0.8, -0.13, 0.13, COL.stone),
  ]),
  ruin_stairs:      () => group([
    slab(-1, 1, 0, 0.5, 0.4, 1, COL.stone),
    slab(-1, 1, 0, 1.0, -0.2, 0.4, COL.stone),
    slab(-1, 1, 0, 1.5, -0.8, -0.2, COL.stone),
  ]),
  ruin_statue_stag: () => group([
    slab(-0.7, 0.7, 0, 1.0, -0.7, 0.7, COL.stone),
    slab(-0.35, 0.35, 1.0, 2.4, -0.6, 0.6, COL.stone),
  ]),
  ruin_brick:  () => slab(-0.3, 0.3, 0, 0.3, -0.2, 0.2, COL.stone),
  ruin_bricks: () => slab(-0.6, 0.6, 0, 0.5, -0.5, 0.5, COL.stone),
  town_fountain_round: () => group([
    ringGeo(1.6, 2.0, 0.56, COL.stone),
    cylGeo(1.6, 0.28, 0x2f6f9e),
  ]),
};

function coneGeo(r, h, y0, hex) {
  const g = new THREE.ConeGeometry(r, h, 7, 1);
  g.translate(0, y0 + h / 2, 0);
  return paint(g, hex);
}
function cylGeo(r, h, hex) {
  const g = new THREE.CylinderGeometry(r, r * 1.08, h, 8, 1);
  g.translate(0, h / 2, 0);
  return paint(g, hex);
}
function ringGeo(ri, ro, h, hex) {
  const g = new THREE.CylinderGeometry(ro, ro, h, 16, 1, true);
  g.translate(0, h / 2, 0);
  const inner = new THREE.CylinderGeometry(ri, ri, h, 16, 1, true);
  inner.translate(0, h / 2, 0);
  const lip = new THREE.RingGeometry(ri, ro, 16);
  lip.rotateX(-Math.PI / 2);
  lip.translate(0, h, 0);
  return paint(group([g, inner, lip]), hex);
}
function dodec(r, _a, sy, _b) {
  const g = new THREE.DodecahedronGeometry(r, 0);
  g.scale(1, sy / r, 1);
  g.translate(0, sy * 0.75, 0);
  return g;
}

function procGeometry(key) {
  const k = String(key).toLowerCase();
  const cached = _procCache.get(k);
  if (cached) return cached;
  const make = PROC[k];
  // Anything unmapped becomes a one-cell block rather than nothing at all: a
  // visible wrong box is a bug report, an invisible hole is a mystery.
  const g = make ? make() : slab(-0.5, 0.5, 0, 1, -0.5, 0.5, COL.stone);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  _procCache.set(k, g);
  return g;
}

// ---------------------------------------------------------------------------
// Unified piece access
// ---------------------------------------------------------------------------

/**
 * The renderable parts of one piece: kit geometry + kit material when the GLB
 * loaded, otherwise one procedural part on the shared vertex-colour material.
 * The returned geometries and materials are SHARED and must not be disposed by
 * the caller — disposeCityKit() owns them.
 */
export function pieceParts(key) {
  const k = String(key).toLowerCase();
  const entry = _kit.get(k);
  if (entry) return entry.parts;
  return [{ geometry: procGeometry(k), material: cityMaterials().shell, offset: _identity }];
}

/**
 * ONE geometry for a piece, in METRES, ready to merge or measure.
 *
 * This is not the geometry the instancing path uses. Kit geometry is quantised
 * and carries its dequantisation on a node transform (see indexPiece), so the
 * baked copy is what a caller outside KitField actually wants — and building
 * it lazily means the compressed form is what the GPU still receives.
 */
export function pieceGeometry(key) {
  const k = String(key).toLowerCase();
  if (_kit.has(k)) return bakePiece(k);
  return procGeometry(k);
}

export function moduleGeometry(key) {
  const m = MODULES[key];
  return pieceGeometry(m ? m.piece : key);
}

export function propGeometry(key) {
  const p = PROPS[key];
  return pieceGeometry(p ? p.piece : key);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

let _mats = null;

/**
 * The shared procedural palette. All flat-shaded MeshStandardMaterial with
 * vertexColors, so per-piece tint bakes into merged geometry and every merged
 * chunk is still one draw call. No textures anywhere: the repo's art direction
 * is flat-shaded low-poly and the kit's own atlas carries the rest.
 */
export function cityMaterials() {
  if (_mats) return _mats;
  _mats = {
    shell: new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0.02,
    }),
    trim: new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0.18,
    }),
    glass: new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.18, metalness: 0.4,
      transparent: true, opacity: 0.72,
    }),
    road: new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: false, roughness: 0.97, metalness: 0.0,
    }),
    // MeshBasic so it survives on the glow layer with the scene's lights and
    // environment stripped out by Glow.render.
    emissive: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  };
  return _mats;
}

// ---------------------------------------------------------------------------
// KitField — one InstancedMesh per material of one piece type
// ---------------------------------------------------------------------------

/**
 * A pool of instances of a single kit piece. Multi-material pieces (the
 * fountain's stone and water) produce one InstancedMesh per material and are
 * driven together, so the caller sets one matrix per placement regardless.
 *
 * Capacity is fixed at construction: InstancedMesh cannot grow, and
 * reallocating mid-build is how a city ends up with half its lamps missing.
 */
export class KitField {
  constructor(key, capacity, { castShadow = true, receiveShadow = true, name = null } = {}) {
    this.key = String(key).toLowerCase();
    this.capacity = Math.max(1, capacity | 0);
    this.meshes = [];
    this.offsets = [];
    this._count = 0;
    const parts = pieceParts(this.key);
    for (let i = 0; i < parts.length; i++) {
      this.offsets.push(parts[i].offset || _identity);
      const m = new THREE.InstancedMesh(parts[i].geometry, parts[i].material, this.capacity);
      m.name = `${name || this.key}${parts.length > 1 ? `#${i}` : ''}`;
      m.castShadow = castShadow;
      m.receiveShadow = receiveShadow;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      m.userData.kitPiece = this.key;
      this.meshes.push(m);
    }
  }

  get count() { return this._count; }

  /**
   * Append one placement. Returns false once capacity is exhausted.
   *
   * `matrix` places the PIECE; each part's own node transform (which is also
   * what dequantises its vertex data) is multiplied in here rather than baked
   * into the geometry. See indexPiece for why that distinction is load-bearing.
   */
  add(matrix) {
    if (this._count >= this.capacity) return false;
    for (let i = 0; i < this.meshes.length; i++) {
      _am.multiplyMatrices(matrix, this.offsets[i]);
      this.meshes[i].setMatrixAt(this._count, _am);
    }
    this._count++;
    return true;
  }

  /** Place by transform without building a Matrix4 at the call site. */
  place(x, y, z, yaw = 0, scale = 1) {
    _fq.setFromAxisAngle(_up, yaw);
    _fs.set(scale, scale, scale);
    _fp.set(x, y, z);
    _fm.compose(_fp, _fq, _fs);
    return this.add(_fm);
  }

  /**
   * Publish the instance data. Must be called once after the last add(), or
   * three renders zero instances and the bounding sphere stays at the origin —
   * which then frustum-culls the entire field the moment the camera moves.
   */
  finalize() {
    for (const m of this.meshes) {
      m.count = this._count;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
    return this;
  }

  get triangles() {
    let t = 0;
    for (const m of this.meshes) {
      const g = m.geometry;
      const n = g.index ? g.index.count : (g.attributes.position?.count || 0);
      t += Math.floor(n / 3) * this._count;
    }
    return t;
  }

  addTo(parent) { for (const m of this.meshes) parent.add(m); return this; }

  /** Frees only the per-instance buffers; geometry and materials are shared. */
  dispose() {
    for (const m of this.meshes) {
      m.dispose();
      m.removeFromParent();
    }
    this.meshes.length = 0;
    this._count = 0;
  }
}

const _identity = /* @__PURE__ */ new THREE.Matrix4();
const _am = new THREE.Matrix4();
const _fm = new THREE.Matrix4();
const _fq = new THREE.Quaternion();
const _fp = new THREE.Vector3();
const _fs = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export function makeKitField(key, count, opts) {
  return new KitField(key, count, opts);
}

/** Spec surface: an InstancedMesh for one of the nine street props. */
export function makePropField(key, count) {
  const p = PROPS[key];
  const field = new KitField(p ? p.piece : key, count, { name: `prop_${key}` });
  return field.meshes[0];
}

// ---------------------------------------------------------------------------
// Procedural facades — the merged-geometry path
// ---------------------------------------------------------------------------

const STYLES = {
  stone:  { shell: 0xb9bdc9, trim: 0x8f95a3, roof: 0x4d6070 },
  timber: { shell: 0xd7d2c4, trim: 0x7a4f2c, roof: 0x3fae9a },
  brick:  { shell: 0xa8705c, trim: 0x6f4436, roof: 0x51606e },
  civic:  { shell: 0xc8cbd6, trim: 0x6f7a92, roof: 0x39566b },
};

/**
 * One merged building shell: storeys, a band per floor, and a gabled cap.
 * Returns geometry whose origin is the footprint centre at ground level, so a
 * caller only has to translate it.
 */
export function buildFacade(rnd, { width = 6, depth = 6, floors = 2, style = 'timber' } = {}) {
  const s = STYLES[style] || STYLES.timber;
  const hw = width / 2, hd = depth / 2;
  const h = floors * KIT_STOREY;
  const parts = [];

  parts.push(slab(-hw, hw, 0, h, -hd, hd, s.shell));
  for (let f = 1; f <= floors; f++) {
    const y = f * KIT_STOREY;
    parts.push(slab(-hw - 0.09, hw + 0.09, y - 0.16, y, -hd - 0.09, hd + 0.09, s.trim));
  }
  // Windows as recessed panels, two per face per storey. Vertex-coloured, so
  // they cost nothing beyond the triangles.
  for (let f = 0; f < floors; f++) {
    const y = f * KIT_STOREY + 0.85;
    for (let k = -1; k <= 1; k += 2) {
      parts.push(slab(hw - 0.04, hw + 0.03, y, y + 0.7, k * hd * 0.42 - 0.35, k * hd * 0.42 + 0.35, 0x263248));
      parts.push(slab(-hw - 0.03, -hw + 0.04, y, y + 0.7, k * hd * 0.42 - 0.35, k * hd * 0.42 + 0.35, 0x263248));
    }
  }
  // Gable cap, ridge along the longer axis so it reads as a street frontage.
  const ridgeAlongZ = depth >= width;
  const rise = Math.min(1.6, (ridgeAlongZ ? width : depth) * 0.28);
  if (ridgeAlongZ) {
    parts.push(wedge(-hw - 0.2, 0, h, h + 0.12, h + rise, -hd - 0.2, hd + 0.2, s.roof));
    const r = wedge(-hw - 0.2, 0, h, h + 0.12, h + rise, -hd - 0.2, hd + 0.2, s.roof);
    r.rotateY(Math.PI);
    parts.push(r);
  } else {
    const a = wedge(-hd - 0.2, 0, h, h + 0.12, h + rise, -hw - 0.2, hw + 0.2, s.roof);
    a.rotateY(Math.PI / 2);
    parts.push(a);
    const b = wedge(-hd - 0.2, 0, h, h + 0.12, h + rise, -hw - 0.2, hw + 0.2, s.roof);
    b.rotateY(-Math.PI / 2);
    parts.push(b);
  }
  if (rnd && rnd() < 0.45) {
    const cx = (rnd() - 0.5) * width * 0.5;
    parts.push(slab(cx - 0.35, cx + 0.35, h, h + rise + 0.9, -0.35, 0.35, s.trim));
  }

  const geometry = group(parts);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, height: h + rise, footprint: { w: width, d: depth } };
}

/**
 * A city block: one to three facades inside the given rectangle.
 *
 * `obstacles` are circles for the existing resolve() signature; `boxes` are the
 * real rectangles. Rasterising a long building as a circle would seal the
 * streets either side of it, so NavGrid must use `boxes`, not `obstacles`.
 */
export function buildBlock(rnd, { x = 0, z = 0, w = 12, d = 12, style = 'timber', floorsMin = 1, floorsMax = 3 } = {}) {
  const geos = [];
  const obstacles = [];
  const boxes = [];
  const splitLong = w > d;
  const n = (splitLong ? w : d) > 18 ? 2 + (rnd() < 0.4 ? 1 : 0) : 1;
  const span = splitLong ? w : d;
  const seg = span / n;

  for (let i = 0; i < n; i++) {
    const centre = -span / 2 + seg * (i + 0.5);
    const bw = (splitLong ? seg : w) - 1.2;
    const bd = (splitLong ? d : seg) - 1.2;
    const floors = floorsMin + Math.floor(rnd() * (floorsMax - floorsMin + 1));
    const f = buildFacade(rnd, { width: bw, depth: bd, floors, style });
    const ox = splitLong ? centre : 0;
    const oz = splitLong ? 0 : centre;
    f.geometry.translate(x + ox, 0, z + oz);
    geos.push(f.geometry);
    boxes.push({ x: x + ox, z: z + oz, w: bw, d: bd, rot: 0 });
    obstacles.push({ pos: { x: x + ox, z: z + oz }, radius: Math.max(bw, bd) * 0.5 });
  }
  return { geometry: group(geos), obstacles, boxes };
}

// ---------------------------------------------------------------------------
// Teardown / introspection
// ---------------------------------------------------------------------------

export function disposeCityKit() {
  for (const entry of _kit.values()) {
    for (const p of entry.parts) {
      p.geometry.dispose();
      p.material?.dispose?.();
    }
  }
  _kit.clear();
  for (const g of _bakedCache.values()) g.dispose();
  _bakedCache.clear();
  for (const t of _kitTextures) t.dispose();
  _kitTextures = new Set();
  _kitLoaded = false;
  _kitLoading = null;

  for (const g of _procCache.values()) g.dispose();
  _procCache.clear();
  if (_mats) { for (const m of Object.values(_mats)) m.dispose(); _mats = null; }
}

export function cityKitStats() {
  let geometries = _procCache.size + _bakedCache.size;
  const materials = new Set();
  if (_mats) for (const m of Object.values(_mats)) materials.add(m.uuid);
  for (const entry of _kit.values()) {
    for (const p of entry.parts) {
      geometries++;
      if (p.material) materials.add(p.material.uuid);
    }
  }
  return {
    geometries,
    materials: materials.size,
    kitLoaded: _kitLoaded,
    kitPieces: _kit.size,
    procedural: _procCache.size,
  };
}
