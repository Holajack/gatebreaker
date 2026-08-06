import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOW_LAYER } from '../render/glow.js';
import { applyRim } from '../render/rim.js';
import { DecalPool } from '../render/decalpool.js';

// Procedurally assembled low-poly humanoids. Building rigs in code means the
// APK ships with zero model files and every silhouette is tunable from here.
//
// Two rules govern everything below:
//
// 1. NOTHING IS ALLOCATED PER ENTITY. Geometry and materials come out of the
//    caches at the top of this file and are shared by every character that asks
//    for the same colours. The old version built ~12 geometries and ~6
//    materials per humanoid and the caller only ever scene.remove()d them, so
//    an S-rank run orphaned ~600 live GPU geometries. On Android that is the
//    per-app memory limiter killing the process, not a frame-rate dip.
// 2. THE STATIC PARTS ARE ONE MESH. Torso, hips, head and shoulders never move
//    relative to each other, so they merge into a single BufferGeometry with
//    their two tints baked into a vertex-colour attribute. Same for the pair of
//    eyes. What is left is 6 meshes per character instead of 15.

// The pool is re-exported here so callers have one entity entry point.
export { DecalPool };

// ------------------------------------------------------------------- caches

const geoCache = new Map();
const matCache = new Map();

// Anything out of these caches is shared by many entities, so entity teardown
// must not dispose it. disposeObject3D below reads this flag.
function cachedGeo(key, build) {
  let g = geoCache.get(key);
  if (!g) { g = build(); g.userData.shared = true; geoCache.set(key, g); }
  return g;
}

function cachedMat(key, build) {
  let m = matCache.get(key);
  if (!m) { m = build(); m.userData.shared = true; matCache.set(key, m); }
  return m;
}

/** Release every shared humanoid resource. Only for teardown / tests. */
export function disposeEntityCache() {
  geoCache.forEach((g) => g.dispose());
  matCache.forEach((m) => m.dispose());
  geoCache.clear();
  matCache.clear();
  if (pool) { pool.dispose(); pool = null; }
  decals.length = 0;
}

/** Dispose an entity's GPU resources, skipping anything out of the caches. */
export function disposeObject3D(root) {
  // Tests and tools hand this synthetic entities whose `mesh` is a plain object,
  // and a teardown helper that throws takes the whole run down with it.
  if (!root || typeof root.traverse !== 'function') return;
  root.traverse((o) => {
    if (o.isDecal) { o.release(); return; }
    if (!o.geometry && !o.material) return;
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m && !m.userData?.shared) m.dispose();
  });
}

// -------------------------------------------------------------- geometry kit

const _col = new THREE.Color();

function box(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Bake a tint into a vertex-colour attribute so one material can serve both. */
function paint(g, hex) {
  _col.setHex(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = _col.r; a[i * 3 + 1] = _col.g; a[i * 3 + 2] = _col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function limbGeo(w, h, d, hex) {
  const g = box(w, h, d, 0, -h / 2, 0); // pivot at the top so it swings like a joint
  return paint(g, hex);
}

function torsoGeo(color, accent) {
  return cachedGeo(`torso:${color}:${accent}`, () => mergeGeometries([
    paint(box(0.62, 0.82, 0.38, 0, 1.28, 0), accent),  // torso
    paint(box(0.54, 0.26, 0.34, 0, 0.84, 0), accent),  // hips
    paint(box(0.42, 0.44, 0.40, 0, 1.92, 0), color),   // head
    paint(box(0.86, 0.20, 0.42, 0, 1.62, 0), color),   // shoulders
  ], false));
}

// Both eyes in one geometry, offsets relative to their shared centre so the
// telegraph flare (rig.eyeL.scale.setScalar) still swells them in place.
const eyesGeo = () => cachedGeo('eyes', () => mergeGeometries([
  box(0.1, 0.06, 0.02, -0.1, 0, 0),
  box(0.1, 0.06, 0.02, 0.1, 0, 0),
], false));

// ------------------------------------------------------------- material kit

// Ghost humanoids (shadows, corpses) get private copies of everything, because
// game.js fades a decaying corpse by writing material.opacity — against a
// shared material that would fade every other shadow on the field with it.
// Material.clone deep-copies userData, so the `shared` flag has to go or
// disposeObject3D would refuse to free the copy.
function unshare(m) {
  const c = m.clone();
  c.userData = {};
  return c;
}

// One material for the whole body. The old pair differed only in tint (now a
// vertex attribute) and in a handful of PBR constants, so those are averaged;
// the rim strength likewise sits between the old torso 0.55 and skin 0.95.
function bodyMat(glow, ghost) {
  const shared = cachedMat(`body:${glow}:${ghost ? 1 : 0}`, () => applyRim(new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: ghost ? 0.4 : 0.5,
    // metalness is what makes scene.environment visible at all — at 0 you only
    // get the ~4% dielectric Fresnel term and the IBL may as well not be there.
    metalness: 0.3,
    envMapIntensity: 1.05,
    ...(ghost
      ? { transparent: true, opacity: 0.62, emissive: new THREE.Color(glow), emissiveIntensity: 0.55 }
      : {}),
  }), { color: glow, strength: 0.75 }));
  // Re-rim rather than trusting the clone: customProgramCacheKey is an own
  // property applyRim installs, and Material.copy does not carry it over.
  return ghost ? applyRim(unshare(shared), { color: glow, strength: 0.75 }) : shared;
}

// Not cloned for ghosts: it is opaque, so the corpse fade loop skips it anyway
// — same as when every humanoid built its own.
const eyeMat = (glow) => cachedMat(`eye:${glow}`, () => new THREE.MeshBasicMaterial({ color: glow }));

// ------------------------------------------------------------------ weapons

function swordMesh(glow, ghost) {
  const geo = cachedGeo('sword', () => mergeGeometries([
    paint(box(0.1, 1.5, 0.03, 0, 0.72, 0), 0xdfe6ff),  // blade
    paint(box(0.36, 0.08, 0.1), 0x4a4f70),             // guard
  ], false));
  const shared = cachedMat(`sword:${glow}:${ghost ? 1 : 0}`, () => new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true,
    emissive: new THREE.Color(glow), emissiveIntensity: 0.7,
    metalness: 0.95, roughness: 0.18, envMapIntensity: 2.2,
    ...(ghost ? { transparent: true, opacity: 0.7 } : {}),
  }));
  const m = new THREE.Mesh(geo, ghost ? unshare(shared) : shared);
  m.layers.enable(GLOW_LAYER);
  return m;
}

function clawMesh(glow) {
  const geo = cachedGeo('claw', () => mergeGeometries([-0.06, 0, 0.06].map((off) => {
    const c = new THREE.ConeGeometry(0.05, 0.5, 4);
    c.rotateX(Math.PI * 0.9);
    c.translate(off, -0.9, 0.1);
    return c;
  }), false));
  const mat = cachedMat(`claw:${glow}`, () => new THREE.MeshStandardMaterial({
    color: 0xf0f0ff, emissive: new THREE.Color(glow), emissiveIntensity: 0.5, flatShading: true,
  }));
  return new THREE.Mesh(geo, mat);
}

function staffMesh(glow) {
  const staff = new THREE.Mesh(
    cachedGeo('staff', () => new THREE.CylinderGeometry(0.045, 0.045, 1.9, 6)),
    cachedMat('staffWood', () => new THREE.MeshStandardMaterial({ color: 0x3a2f28, roughness: 0.9 })),
  );
  staff.position.y = -0.7;
  const orb = new THREE.Mesh(
    cachedGeo('orb', () => new THREE.IcosahedronGeometry(0.19, 0)),
    cachedMat(`orb:${glow}`, () => new THREE.MeshBasicMaterial({ color: glow })),
  );
  orb.position.y = 0.95;
  orb.layers.enable(GLOW_LAYER);
  staff.add(orb);
  return staff;
}

// ------------------------------------------------------------------- rig

export function makeHumanoid({
  color = 0x7c5cff,
  glow = 0xffffff,
  accent = 0x2b2f4a,
  scale = 1,
  weapon = 'sword',
  cloak = false,
  ghost = false,
  boss = false, // reserved: difficulty.js passes it, nothing reads it yet
} = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const skin = bodyMat(glow, ghost);

  // torso + hips + head + shoulders, one draw
  const torso = new THREE.Mesh(torsoGeo(color, accent), skin);
  torso.castShadow = true;
  body.add(torso);

  // eyes — an emissive pair that reads as a glowing visor at distance
  const eyes = new THREE.Mesh(eyesGeo(), eyeMat(glow));
  eyes.position.set(0, 1.95, 0.21);
  eyes.layers.enable(GLOW_LAYER);
  body.add(eyes);

  // arms — pivot groups so we can swing them from the shoulder
  const armL = new THREE.Group(); armL.position.set(-0.42, 1.58, 0);
  const armR = new THREE.Group(); armR.position.set(0.42, 1.58, 0);
  const armGeo = cachedGeo(`arm:${color}`, () => limbGeo(0.18, 0.72, 0.18, color));
  const armLMesh = new THREE.Mesh(armGeo, skin); armLMesh.castShadow = true;
  const armRMesh = new THREE.Mesh(armGeo, skin); armRMesh.castShadow = true;
  armL.add(armLMesh); armR.add(armRMesh);
  body.add(armL, armR);

  // legs
  const legL = new THREE.Group(); legL.position.set(-0.17, 0.82, 0);
  const legR = new THREE.Group(); legR.position.set(0.17, 0.82, 0);
  const legGeo = cachedGeo(`leg:${accent}`, () => limbGeo(0.2, 0.8, 0.22, accent));
  const legLMesh = new THREE.Mesh(legGeo, skin); legLMesh.castShadow = true;
  const legRMesh = new THREE.Mesh(legGeo, skin); legRMesh.castShadow = true;
  legL.add(legLMesh); legR.add(legRMesh);
  body.add(legL, legR);

  // weapon in the right hand
  let blade = null;
  if (weapon === 'sword') {
    blade = new THREE.Group();
    blade.add(swordMesh(glow, ghost));
    blade.position.set(0, -0.72, 0.06);
    blade.rotation.x = -0.25;
    armRMesh.add(blade);
  } else if (weapon === 'claw') {
    armRMesh.add(clawMesh(glow));
  } else if (weapon === 'staff') {
    blade = staffMesh(glow);
    armRMesh.add(blade);
  }

  if (cloak) {
    const capeMat = cachedMat(`cape:${accent}:${ghost ? 1 : 0}`, () => new THREE.MeshStandardMaterial({
      color: accent, side: THREE.DoubleSide, roughness: 0.9, flatShading: true,
      ...(ghost ? { transparent: true, opacity: 0.55 } : {}),
    }));
    const cape = new THREE.Mesh(
      cachedGeo('cape', () => new THREE.ConeGeometry(0.62, 1.5, 6, 1, true)),
      ghost ? unshare(capeMat) : capeMat,
    );
    cape.position.set(0, 1.15, -0.22);
    cape.rotation.x = 0.16;
    body.add(cape);
    root.userData.cape = cape;
  }

  root.scale.setScalar(scale);
  // `head` and `torso` are the same object now that they share a geometry; the
  // rig keys are kept because animateRig and game.js both address them by name.
  // eyeL/eyeR likewise both point at the single merged eye mesh, so the
  // telegraph flare still works unchanged.
  root.userData.rig = {
    body, torso, head: torso, armL, armR, legL, legR, blade, eyeL: eyes, eyeR: eyes,
  };
  return root;
}

// ------------------------------------------------------------------ decals
//
// makeGroundRing / makeHealthBar / setHealthBar are kept as compatibility
// shims. They no longer return real Meshes: they return a transform-only proxy
// that reserves a slot in the shared DecalPool, so the caller's existing
// scene-graph code (parenting, .position, .quaternion, .visible) keeps working
// while the actual drawing collapses into three instanced draws for the whole
// scene. New code should talk to DecalPool directly.

const RING = 0;
const BAR = 1;

let pool = null;
const decals = [];

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

class Decal extends THREE.Object3D {
  constructor(kind, color, size, opacity) {
    super();
    this.isDecal = true;
    this.kind = kind;
    this.color = color;
    this.size = size;
    this.opacity = opacity;
    this.handle = -1;
    this.ratio = 1;
    this._radius = -1;
    decals.push(this);
  }

  release() {
    if (pool && this.handle >= 0) pool.release(this.handle);
    this.handle = -1;
    const i = decals.indexOf(this);
    if (i >= 0) decals.splice(i, 1);
  }

  updateMatrixWorld(force) {
    super.updateMatrixWorld(force);
    // The pool needs a scene and the shims are handed one only indirectly, via
    // whatever the caller parented this proxy to. Checking here is what makes
    // the shims drop-in: no wiring required at the call site.
    if (!pool) attachPool(this);
  }
}

function rootOf(obj) {
  let o = obj, visible = true;
  while (o.parent) { visible = visible && o.visible; o = o.parent; }
  return { root: o, visible: visible && o.visible };
}

function attachPool(from) {
  const { root } = rootOf(from);
  if (!root.isScene) return;
  pool = new DecalPool(root);
  pool.onBeforeUpdate = syncDecals;
  for (const d of decals) acquire(d);
}

function acquire(d) {
  if (d.handle >= 0) return;
  d.handle = d.kind === RING
    ? pool.acquireRing(d.color, d.size, d.opacity)
    : pool.acquireBar(d.color, d.size);
}

// Runs once per frame, from inside DecalPool.update.
function syncDecals() {
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i];
    const { root, visible } = rootOf(d);
    // Detached from the scene means the entity that owned it is gone. Reclaim
    // the slot rather than waiting for a caller that will never come back.
    if (root !== pool.scene) { d.release(); continue; }
    // Retry: a decal created while the pool was full still has no slot.
    if (d.handle < 0) acquire(d);
    if (d.handle < 0) continue;
    d.matrixWorld.decompose(_p, _q, _s);
    if (d.kind === RING) {
      // The old ring was a child of the character, so it picked up the
      // character's scale. Fold that back in.
      const r = d.size * _s.x;
      if (r !== d._radius) { pool.setRingRadius(d.handle, r); d._radius = r; }
      pool.setRing(d.handle, _p.x, _p.y, _p.z, visible);
    } else {
      pool.setBar(d.handle, _p.x, _p.y, _p.z, d.ratio, visible);
    }
  }
}

// A flat glowing disc under a character. On a dark arena this is the single
// biggest readability win — you can always find yourself and spot enemies.
export function makeGroundRing(color, radius = 0.8, opacity = 0.5) {
  const d = new Decal(RING, color, radius, opacity);
  // Sits above the ground's vertex-noise range so it never gets buried.
  d.position.y = 0.36;
  if (pool) acquire(d);
  return d;
}

// Billboarded health bar that sits above an entity.
export function makeHealthBar(width = 1.2, color = 0xff2d55) {
  const d = new Decal(BAR, color, width, 1);
  d.userData = { width };
  if (pool) acquire(d);
  return d;
}

export function setHealthBar(bar, ratio) {
  bar.ratio = Math.max(0, Math.min(1, ratio));
}

// Simple walk / idle / attack pose driver shared by every humanoid.
export function animateRig(root, { moving, speed, t, attackPhase = 0, hurt = 0, airborne = false, riseRate = 0 }) {
  const rig = root.userData.rig;
  if (!rig) return;
  const { armL, armR, legL, legR, body, head } = rig;

  if (airborne && attackPhase <= 0) {
    // Tuck on the way up, reach on the way down — reading the character's
    // vertical direction from the pose is most of what sells a jump.
    const rising = riseRate > 0;
    const k = Math.max(-1, Math.min(1, riseRate * 0.12));
    legL.rotation.x = rising ? -0.75 : 0.28;
    legR.rotation.x = rising ? -0.42 : 0.5;
    armL.rotation.x = -1.15 - k * 0.35;
    armR.rotation.x = -0.85 - k * 0.35;
    body.rotation.y *= 0.85;
    body.position.y = 0;
    body.rotation.z = -k * 0.1;
    if (root.userData.cape) root.userData.cape.rotation.x = 0.16 + 0.42 - k * 0.25;
    if (hurt > 0) head.rotation.z = -Math.sin(hurt * 40) * 0.1 * hurt; else head.rotation.z *= 0.8;
    return;
  }

  if (attackPhase > 0) {
    // Wind up then chop through — armR leads, torso counter-rotates.
    const p = 1 - attackPhase; // 0 -> 1 over the swing
    const swing = p < 0.3
      ? -1.5 * (p / 0.3)
      : -1.5 + 3.4 * ((p - 0.3) / 0.7);
    armR.rotation.x = swing;
    armL.rotation.x = -swing * 0.3;
    body.rotation.y = swing * 0.22;
    legL.rotation.x = 0.1;
    legR.rotation.x = -0.1;
  } else if (moving) {
    // Stride FREQUENCY saturates, stride LENGTH keeps growing. Frequency used
    // to be `5 + speed * 0.9`, so speed fed the leg cycle without limit — a
    // fast hunter hit ~5 strides/sec, which reads as broken legs rather than
    // sprinting. Real gait does the opposite: past a jog you cover ground by
    // reaching further, not by cycling faster. Capping here also keeps enemies
    // and shadows sane whatever speed the caller hands us.
    const gait = Math.min(1, Math.max(0, speed / 11));
    const cyc = t * (5.0 + gait * 4.4);   // 0.80 -> 1.50 strides/sec
    const amp = 0.55 + gait * 0.62;       // longer reach instead
    legL.rotation.x = Math.sin(cyc) * 0.85 * amp;
    legR.rotation.x = -Math.sin(cyc) * 0.85 * amp;
    armL.rotation.x = -Math.sin(cyc) * 0.65 * amp;
    armR.rotation.x = Math.sin(cyc) * 0.65 * amp;
    body.position.y = Math.abs(Math.sin(cyc)) * (0.04 + gait * 0.05);
    body.rotation.y = Math.sin(cyc) * (0.04 + gait * 0.04);
    body.rotation.z = 0;
  } else {
    const idle = Math.sin(t * 1.8);
    legL.rotation.x *= 0.85;
    legR.rotation.x *= 0.85;
    armL.rotation.x = idle * 0.08 - 0.05;
    armR.rotation.x = -idle * 0.08 - 0.05;
    body.position.y = idle * 0.035;
    body.rotation.y *= 0.85;
  }

  if (hurt > 0) {
    body.rotation.z = Math.sin(hurt * 40) * 0.14 * hurt;
    head.rotation.z = -Math.sin(hurt * 40) * 0.1 * hurt;
  } else {
    head.rotation.z *= 0.8;
  }

  if (root.userData.cape) {
    root.userData.cape.rotation.x = 0.16 + (moving ? Math.sin(t * 8) * 0.06 + 0.14 : Math.sin(t * 1.5) * 0.03);
  }
}
