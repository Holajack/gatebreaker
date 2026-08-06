import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// The game's first and only asset pipeline: one merged GLB holding all 106
// models from the CC0 Quaternius item pack, keyed by node name.
//
// Built by tools/build-items-glb.mjs. Everything else in the renderer is
// THREE primitives generated in code, so this module is deliberately small and
// deliberately optional — see the "must not hard-fail" note on loadItemModels.
//
// WHY MESHOPT AND NOT DRACO: DRACOLoader.setDecoderPath() resolves two loose
// files at runtime. Under Capacitor the app is served from https://localhost
// with base:'./', and a wrong decoder path fails silently on-device after
// packaging. MeshoptDecoder ships its wasm base64-embedded inside the JS
// module, which Vite inlines into the bundle, so there is nothing to resolve
// and nothing to fetch. That is what makes this offline-safe by construction.

let _loaded = false;
let _loading = null;
let _scene = null;

// lowercase name -> source Object3D in the loaded scene.
// Lookup is case-insensitive on BOTH sides because the pack's own filenames
// disagree with each other by case (Axe_Small vs Axe_small, FishBone vs
// Fishbone) and macOS hides that until the APK runs on Android.
const _byName = new Map();
// Canonical display name, keyed the same way, so listItems() reports the real
// node names rather than the lowercased lookup keys.
const _canonical = new Map();
const _bounds = new Map();

const _box = new THREE.Box3();
const _size = new THREE.Vector3();

function index(scene) {
  _byName.clear();
  _canonical.clear();
  _bounds.clear();
  for (const child of scene.children) {
    if (!child.name) continue;
    const key = child.name.toLowerCase();
    _byName.set(key, child);
    _canonical.set(key, child.name);
  }
}

/**
 * Load the merged item GLB. Resolves TRUE on success and FALSE on any failure —
 * missing file, corrupt file, decoder refusal. It never throws and never
 * rejects, because an offline game must still boot when an asset did not ship:
 * weapons.js keeps its procedural builders as the fallback path.
 */
export async function loadItemModels(url = 'models/items.glb') {
  if (_loaded) return true;
  if (_loading) return _loading;

  _loading = new Promise((resolve) => {
    let loader;
    try {
      loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
    } catch {
      resolve(false);
      return;
    }
    loader.load(
      url,
      (gltf) => {
        try {
          _scene = gltf.scene;
          // Static props: nothing here is skinned or animated, so freezing the
          // matrix update saves 106 world-matrix recomputes per frame on the
          // source copies that never move.
          _scene.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = false;
            // Object3D.clone() shares geometry and materials with the source,
            // so every clone points back into this scene. entities.disposeObject3D
            // frees anything it reaches that is NOT flagged — without this a
            // single expiring loot drop would dispose the geometry that all 106
            // models and every future clone are still using, and the pack would
            // silently vanish mid-run.
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            if (o.geometry) o.geometry.userData.shared = true;
            for (const m of mats) {
              if (!m) continue;
              m.userData.shared = true;
              m.side = THREE.FrontSide;
              // Belt and braces on the failure that cost the most time here:
              // the pack's FBX materials carry opacity 0, which survives all
              // the way to a MeshStandardMaterial whose alphaMode is OPAQUE.
              // Nothing warns, the mesh is in the graph with correct world
              // bounds, and it draws with zero alpha — so it vanishes the
              // instant the bloom pass composites the frame. The exporter now
              // forces alpha to 1, and this catches any GLB built before that.
              if (!m.transparent && m.opacity < 1) m.opacity = 1;
            }
          });
          index(_scene);
          _loaded = _byName.size > 0;
          resolve(_loaded);
        } catch {
          resolve(false);
        }
      },
      undefined,
      () => resolve(false),
    );
  });
  return _loading;
}

export function hasItem(name) {
  return typeof name === 'string' && _byName.has(name.toLowerCase());
}

export function listItems() {
  return Array.from(_canonical.values()).sort();
}

/**
 * A ready-to-parent copy of one pack model.
 *
 * DEFAULT SCALE 0.4 IS DELIBERATE. The pack is metre-mismatched against this
 * game: its Sword measures 0.53 x 2.30 x 0.12 units on a ~1.8-unit humanoid,
 * so dropping one in unscaled produces a sword taller than the character.
 * 0.4x lands the blade at ~0.92m, which reads correctly in the hand.
 *
 * The models run along +Y in glTF space, which already matches the
 * HAND_SOCKET convention in weapons.js — no reorientation is needed.
 */
export function getItemMesh(name, { scale = 0.4, clone = true } = {}) {
  if (!name) return null;
  const src = _byName.get(String(name).toLowerCase());
  if (!src) return null;
  const obj = clone ? src.clone(true) : src;
  // The GLB's own root carries the Blender Z-up -> glTF Y-up correction, so
  // scale is applied on a wrapper rather than stomping that rotation.
  const holder = new THREE.Group();
  holder.name = `${_canonical.get(String(name).toLowerCase())}`;
  holder.add(obj);
  holder.scale.setScalar(scale);
  holder.userData.fromPack = true;
  return holder;
}

/** World-space size of a model at scale 1, for reach/socket tuning. */
export function itemBounds(name) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  const cached = _bounds.get(key);
  if (cached) return { ...cached };
  const src = _byName.get(key);
  if (!src) return null;
  _box.setFromObject(src);
  _box.getSize(_size);
  const b = { x: _size.x, y: _size.y, z: _size.z };
  _bounds.set(key, b);
  return { ...b };
}

export function itemModelStats() {
  let meshes = 0, triangles = 0;
  const materials = new Set();
  if (_scene) {
    _scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) materials.add(m.uuid);
      const g = o.geometry;
      if (g) {
        const count = g.index ? g.index.count : (g.attributes.position?.count || 0);
        triangles += Math.floor(count / 3);
      }
    });
  }
  return {
    loaded: _loaded,
    roots: _byName.size,
    meshes,
    materials: materials.size,
    triangles,
  };
}

/** Teardown. Only meaningful on a GL context loss or a hard reset. */
export function disposeItemModels() {
  if (_scene) {
    const seen = new Set();
    _scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && !seen.has(m.uuid)) { seen.add(m.uuid); m.dispose(); }
      }
    });
  }
  _scene = null;
  _loaded = false;
  _loading = null;
  _byName.clear();
  _canonical.clear();
  _bounds.clear();
}
