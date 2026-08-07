import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ---------------------------------------------------------------------------
// THE NATURE SCATTER KIT
// ---------------------------------------------------------------------------
// public/models/nature.glb — 140 CC0 pieces (Quaternius Ultimate Nature Pack),
// converted by tools/build-world-glb.mjs. Shipped in the APK since the first
// asset pass and imported by NOTHING until now; this file is its loader.
//
// Same contract as citykit.js, and for the same reason: a caller asks for a
// piece by key and gets renderable parts either way, so a missing or corrupt
// GLB degrades to blocky procedural stand-ins instead of an empty field or a
// crash. The procedural twins here are deliberately crude — a cone tuft where
// a grass clump should be — because they exist to keep the offline game whole,
// not to compete with the kit.
//
// PLACEMENT, from public/models/nature.json rather than guessed:
//   * NOT a modular grid kit (grid.gridded is false). Pieces place freely;
//     footprint radius is max(size.x, size.z) / 2.
//   * Metres, same as citykit.glb. Pivots at the base: y = 0 is ground, so a
//     piece drops onto terrain height with no offset.
//
// EVERY KEY IS LOWERCASE. macOS hides case collisions; Android does not.

export const NATURE_URL = 'models/nature.glb';

// lowercase key -> { parts: [{ geometry, material, offset: Matrix4 }], box }
const _kit = new Map();
let _kitLoaded = false;
let _kitLoading = null;
let _kitTextures = new Set();

/**
 * Index one GLB scene root into instanceable parts.
 *
 * Copied from citykit.js indexPiece rather than imported, because the trap it
 * guards is per-kit state: nature.glb is the same gltfpack output with
 * KHR_mesh_quantization, so every position attribute is a raw Int16 lattice
 * whose dequantisation scale lives on the MESH NODE's transform. Baking that
 * transform into the vertex data with applyMatrix4 clamps the integers and
 * turns every bush into a kilometre-wide slab — silently. So the node
 * transform is kept per part as `offset` and multiplied into each instance
 * matrix by NatureField instead; vertex data is never touched.
 */
function indexPiece(root) {
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();

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
      try {
        const merged = mergeGeometries(geos.map((x) => x.clone()), false);
        if (merged) geo = merged;
      } catch { /* keep geos[0] */ }
    }
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    parts.push({ geometry: geo, material, offset });
    b.copy(geo.boundingBox).applyMatrix4(offset);
    box.union(b);
  }
  return { parts, box };
}

/**
 * Load public/models/nature.glb. Resolves TRUE on success and FALSE on any
 * failure — never throws, never rejects, exactly like loadCityKit. On false,
 * every naturePieceParts() call falls through to its procedural twin.
 */
export async function loadNatureKit(url = NATURE_URL) {
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
        // Same invisible-material trap the item pack shipped: opacity 0 with
        // transparent false survives the pipeline and draws nothing.
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

export function natureKitLoaded() { return _kitLoaded; }

// ---------------------------------------------------------------------------
// Procedural stand-ins
// ---------------------------------------------------------------------------
// Only the pieces the city actually scatters get an authored twin; anything
// else falls through to a visible green cone — a wrong tuft is a bug report,
// an invisible hole is a mystery. Bounds and base pivots match nature.json.

const COL = {
  grass:  0x5f8a3e,
  dry:    0x8a8a4e,
  flower: 0xd8788f,
  leaf:   0x3e7a4c,
  rock:   0x7b8090,
};

let _mat = null;
/** One shared flat-shaded material for every procedural stand-in. */
function natureMaterial() {
  if (!_mat) {
    _mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0.0,
    });
  }
  return _mat;
}

// NOT convertSRGBToLinear — ColorManagement already converted the hex. See the
// long note in citykit.js; converting twice lands at an eighth brightness.
function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function cone(r, h, hex, seg = 5) {
  const g = new THREE.ConeGeometry(r, h, seg, 1);
  g.translate(0, h / 2, 0);
  return paint(g, hex);
}
function blob(r, h, hex) {
  const g = new THREE.DodecahedronGeometry(r, 0);
  g.scale(1, h / r, 1);
  g.translate(0, h * 0.7, 0);
  return paint(g, hex);
}

const PROC = {
  grass:        () => cone(0.16, 1.0, COL.grass, 4),
  grass_2:      () => cone(0.18, 1.2, COL.dry, 4),
  grass_short:  () => cone(0.18, 0.4, COL.grass, 4),
  flowers:      () => cone(0.22, 0.83, COL.flower, 5),
  plant_1:      () => blob(0.5, 0.5, COL.leaf),
  plant_3:      () => blob(0.5, 0.9, COL.leaf),
  bush_1:       () => blob(0.75, 1.2, COL.leaf),
  bush_2:       () => blob(0.67, 1.1, COL.leaf),
  bushberries_1: () => blob(0.7, 1.25, COL.leaf),
  rock_moss_2:  () => blob(0.31, 0.69, COL.rock),
  rock_moss_5:  () => blob(0.4, 0.58, COL.rock),
  rock_moss_6:  () => blob(0.51, 0.71, COL.rock),
};

const _procCache = new Map();
function procGeometry(key) {
  const k = String(key).toLowerCase();
  const cached = _procCache.get(k);
  if (cached) return cached;
  const make = PROC[k];
  const g = make ? make() : cone(0.2, 0.5, COL.grass, 4);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  _procCache.set(k, g);
  return g;
}

const _identity = /* @__PURE__ */ new THREE.Matrix4();

/**
 * The renderable parts of one nature piece: kit geometry + kit material when
 * the GLB loaded, one procedural part on the shared material otherwise.
 * SHARED — the caller must not dispose them; disposeNatureKit() owns them.
 */
export function naturePieceParts(key) {
  const k = String(key).toLowerCase();
  const entry = _kit.get(k);
  if (entry) return entry.parts;
  return [{ geometry: procGeometry(k), material: natureMaterial(), offset: _identity }];
}

// ---------------------------------------------------------------------------
// NatureField — one InstancedMesh per material of one piece type
// ---------------------------------------------------------------------------
// The same shape as citykit's KitField, duplicated rather than shared because
// KitField's constructor is hard-bound to citykit's pieceParts — routing a
// nature key through it would hand back citykit's "unmapped stone block"
// fallback instead of this file's tufts, and the failure would only be visible
// with the GLB deliberately deleted. ~60 lines is cheaper than that trap.

export class NatureField {
  constructor(key, capacity, { castShadow = false, receiveShadow = true, name = null } = {}) {
    this.key = String(key).toLowerCase();
    this.capacity = Math.max(1, capacity | 0);
    this.meshes = [];
    this.offsets = [];
    this._count = 0;
    const parts = naturePieceParts(this.key);
    for (let i = 0; i < parts.length; i++) {
      this.offsets.push(parts[i].offset || _identity);
      const m = new THREE.InstancedMesh(parts[i].geometry, parts[i].material, this.capacity);
      m.name = `${name || this.key}${parts.length > 1 ? `#${i}` : ''}`;
      m.castShadow = castShadow;
      m.receiveShadow = receiveShadow;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      m.userData.naturePiece = this.key;
      this.meshes.push(m);
    }
  }

  get count() { return this._count; }

  add(matrix) {
    if (this._count >= this.capacity) return false;
    for (let i = 0; i < this.meshes.length; i++) {
      _am.multiplyMatrices(matrix, this.offsets[i]);
      this.meshes[i].setMatrixAt(this._count, _am);
    }
    this._count++;
    return true;
  }

  /**
   * Place by transform without building a Matrix4 at the call site.
   *
   * `scaleY` defaults to `scale` but can differ: the Quaternius grass tufts
   * are authored ~1 m tall, and squashing them vertically while keeping their
   * footprint is what turns "reeds" into "short grass" without shipping a
   * second mesh. KitField has no equivalent because no city piece needs it.
   */
  place(x, y, z, yaw = 0, scale = 1, scaleY = scale) {
    _fq.setFromAxisAngle(_up, yaw);
    _fs.set(scale, scaleY, scale);
    _fp.set(x, y, z);
    _fm.compose(_fp, _fq, _fs);
    return this.add(_fm);
  }

  /** Must run once after the last add(), or three renders zero instances. */
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

const _am = new THREE.Matrix4();
const _fm = new THREE.Matrix4();
const _fq = new THREE.Quaternion();
const _fp = new THREE.Vector3();
const _fs = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Teardown / introspection
// ---------------------------------------------------------------------------

export function disposeNatureKit() {
  for (const entry of _kit.values()) {
    for (const p of entry.parts) {
      p.geometry.dispose();
      p.material?.dispose?.();
    }
  }
  _kit.clear();
  for (const t of _kitTextures) t.dispose();
  _kitTextures = new Set();
  _kitLoaded = false;
  _kitLoading = null;

  for (const g of _procCache.values()) g.dispose();
  _procCache.clear();
  if (_mat) { _mat.dispose(); _mat = null; }
}

export function natureKitStats() {
  return {
    kitLoaded: _kitLoaded,
    kitPieces: _kit.size,
    procedural: _procCache.size,
  };
}
