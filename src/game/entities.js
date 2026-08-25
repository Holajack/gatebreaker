import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOW_LAYER } from '../render/glow.js';
import { applyRim } from '../render/rim.js';
import { DecalPool } from '../render/decalpool.js';
import {
  loadCharacterModels, charactersReady, makeCharacter, characterStats,
  setCharacterQuality as setCharacterTier, characterBudgetAvailable, warmAppearance, MODEL_SCALE,
  setPlayerArmorLook, armorLookFromEquipment,
} from '../render/characters.js';
import {
  loadCreatureModels, creaturesReady, makeCreature, creatureStats,
  setCreatureQuality, creatureBudgetAvailable,
} from '../render/creatures.js';
import { buildHeldWeapon, enemyWeaponKind, setStance } from './weapons.js';

// Humanoids. There are now TWO implementations behind makeHumanoid():
//
//   A. REAL SKINNED CHARACTERS out of public/models/characters.glb — 21 CC0
//      Quaternius bodies on two skeletons, with 24 animation clips each and
//      swappable head/body/legs/feet. This is what actually ships.
//   B. THE PROCEDURAL BOX-MAN below, kept verbatim as the fallback. The game is
//      fully offline: if the GLB did not make it into the APK, or the decoder
//      refuses it on some device, a missing asset must degrade rather than
//      crash the boot. Everything from `caches` to `animateRig`'s pose driver
//      is that fallback, and it is still the thing the ground rings, health
//      bars and weapon grips are dimensioned against.
//
// The two paths are interchangeable from the caller's side: makeHumanoid
// returns a Group carrying the same userData.rig keys either way, and
// animateRig takes the same options object and routes to an AnimationMixer
// when the Group is GLB-backed.
//
// Two rules govern the procedural path:
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
// Character-pack controls, re-exported so game.js/main.js never have to know
// which render module the skinned path lives in.
export {
  loadCharacterModels, charactersReady, characterStats,
  characterBudgetAvailable, MODEL_SCALE,
  // Armour-look controls (RPG_SPEC step 12). setPlayerArmorLook points the
  // hunter's silhouette at an equipment object; the caller then rebuilds via
  // rebuildHumanoid, same contract as setPlayerBody + rebuild.
  setPlayerArmorLook, armorLookFromEquipment,
};
// Creature-pack controls, same contract.
export {
  loadCreatureModels, creaturesReady, creatureStats, creatureBudgetAvailable,
};

/**
 * Point BOTH skinned packs at a quality tier.
 *
 * game.js calls this from _applyQuality and knows about exactly one of the two
 * modules, so the fan-out lives here rather than at the call site.
 */
export function setCharacterQuality(tier) {
  setCharacterTier(tier);
  setCreatureQuality(tier);
}

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
  // A GLB-backed humanoid owns an AnimationMixer and a reference on a shared
  // merged geometry. Neither is reachable by traversal, and leaking the mixer
  // leaks every AnimationAction bound to the dead skeleton.
  _pending.delete(root);
  if (root.userData?.character) {
    root.userData.character.dispose();
    root.userData.character = null;
  }
  if (root.userData?.heroLight) root.userData.heroLight = null;
  root.traverse((o) => {
    if (o.isDecal) { o.release(); return; }
    // The hero light (and any future entity light). dispose() frees a shadow
    // map if one ever exists; today it is a no-op kept for symmetry with the
    // rule that everything an entity owns is released here.
    if (o.isLight) { o.dispose(); return; }
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
    // Living bodies opt OUT of the rim entirely; shadows opt IN to the
    // restrained preset. Explicit, rather than leaning on rim.js's heuristic.
  }), ghost ? { preset: 'shadow', color: glow } : { rim: false }));
  // Re-rim rather than trusting the clone: customProgramCacheKey is an own
  // property applyRim installs, and Material.copy does not carry it over.
  return ghost ? applyRim(unshare(shared), { preset: 'shadow', color: glow }) : shared;
}

// Not cloned for ghosts: it is opaque, so the corpse fade loop skips it anyway
// — same as when every humanoid built its own.
const eyeMat = (glow) => cachedMat(`eye:${glow}`, () => new THREE.MeshBasicMaterial({ color: glow }));

// ------------------------------------------------------------------ weapons

// THE PLANK. 1.5 units of untapered white box on the glow layer, which the
// review of the shipped build described as a fluorescent tube brighter and
// longer than the body carrying it. It is now reachable ONLY from the
// procedural box-man path and from attachHandWeapon's last resort — i.e. only
// when public/models/items.glb did not ship. It is tagged so
// tools/creature-test.mjs can assert nothing in a live gate is holding one.
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
  m.userData.procedural = 'sword';
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

// ------------------------------------------------------- skinned characters
//
// Everything from here to `makeHumanoid` is the GLB path. It is deliberately
// written so that game.js needs no edits at all: makeHumanoid infers the
// archetype from the arguments game.js already passes, seeds the appearance
// from a spawn counter, and — because the pack cannot be loaded synchronously —
// UPGRADES humanoids that were built before the load finished, in place.

let _charLoad = null;
/**
 * Distinct looks generated per archetype before the sequence wraps, and a
 * PER-ARCHETYPE counter so the wrap is exact.
 *
 * An ever-increasing counter would be more varied and would also allocate a new
 * merged geometry (~165 KB) for every enemy that ever spawns, forever — the
 * entity leak test reads exactly that as unbounded geometry growth, and from
 * the outside it is indistinguishable from a leak. Four per archetype across
 * the eight enemy/shadow archetypes plus the player's single fixed look is 33
 * appearances, inside the 40-entry geometry cache in characters.js, and the
 * whole set for a rank is allocated in one pass the first time anything is
 * built at that rank. It is still 33 different bodies where the game had one.
 */
const APPEARANCE_VARIANTS = 4;
const _spawnSeq = new Map();
const _warmed = new Set();

const ARCHETYPES = [
  'player', 'grunt', 'stalker', 'brute', 'caster', 'lancer', 'howler', 'boss', 'shadow',
];

/**
 * Allocate every archetype's looks for a rank, once per rank. Doing the whole
 * rank at once rather than one archetype at a time costs one pass during boot
 * (the player is the first thing built) and buys a geometry count that never
 * moves again — which is the difference between a warm cache and a leak, from
 * the outside.
 */
function warmRank(rank) {
  if (_warmed.has(rank)) return;
  _warmed.add(rank);
  for (const a of ARCHETYPES) {
    for (let i = 0; i < APPEARANCE_VARIANTS; i++) {
      warmAppearance(a === 'player' ? 'player' : `${a}:${i}`, { archetype: a, rank });
      if (a === 'player') break;      // the player has exactly one look
    }
  }
}
/** Procedural humanoids awaiting the pack: root -> the opts they were built from. */
const _pending = new Map();

let _creatureLoad = null;

/** Kick the creature pack exactly once. Resolves FALSE, never throws. */
export function preloadCreatures(url, manifestUrl) {
  if (_creatureLoad) return _creatureLoad;
  _creatureLoad = Promise.resolve()
    .then(() => loadCreatureModels(url, manifestUrl))
    .then((ok) => { if (ok) upgradePendingHumanoids(); return ok; })
    .catch(() => false);
  return _creatureLoad;
}

// Test bridge, mirroring window.__items / window.__characters in main.js.
// Harmless in production, and the only way tools/creature-test.mjs can read the
// pack's own counters (merge failures, budget, per-creature draw calls) rather
// than inferring them from pixels.
if (typeof window !== 'undefined') {
  window.__creatures = {
    ready: creaturesReady,
    stats: creatureStats,
    promise: () => _creatureLoad,
  };
}

/**
 * Kick BOTH skinned packs exactly once. Resolves FALSE, never throws.
 *
 * The returned promise settles when both have finished, but its VALUE is the
 * character pack's result — main.js reads it to decide whether to warn about
 * characters.glb, and it gates the splash on both loads without needing to know
 * there are two.
 */
export function preloadCharacters(url, manifestUrl) {
  if (_charLoad) return _charLoad;
  const chars = Promise.resolve()
    .then(() => loadCharacterModels(url, manifestUrl))
    .then((ok) => { if (ok) upgradePendingHumanoids(); return ok; })
    .catch(() => false);
  _charLoad = Promise.all([chars, preloadCreatures()])
    .then(([ok]) => ok)
    .catch(() => false);
  return _charLoad;
}

/**
 * Archetype inference from the arguments game.js already passes.
 *
 * game.js does not know about appearance yet, so the mapping is reconstructed
 * from what it does say. Passing `archetype` explicitly (see the game.js
 * handoff) is strictly better — it is the only way lancer and howler get their
 * own looks, because game.js hands both of them a plain sword.
 */
function inferArchetype({ ghost, boss, weapon, scale }) {
  if (ghost) return 'shadow';
  if (boss || scale >= 1.9) return 'boss';
  if (weapon === 'staff') return 'caster';
  if (weapon === 'claw') return 'stalker';
  if (weapon === 'none') return 'player';
  if (scale >= 1.2) return 'brute';
  return 'grunt';
}

/**
 * Put something in a skinned character's fist.
 *
 * THE PACK MODEL IS TRIED FIRST, always. `weapon` is the coarse kind game.js
 * asks for ('sword'/'claw'/'staff'); `archetype` refines it, so a shadow gets a
 * sword, a brute gets a hammer and a stalker gets a dagger instead of all three
 * carrying the same object. The procedural builders below are what is left when
 * items.glb did not ship — the plank is the last resort, not the default.
 */
function attachHandWeapon(socket, weapon, glow, ghost, archetype) {
  if (!socket) return null;
  if (weapon === 'staff') {
    // The item pack has no staff and nothing that reads as one; a wand-shaped
    // dagger would be a worse lie than the procedural staff, which is a wooden
    // pole with an orb and is not the thing anyone complained about.
    const staff = staffMesh(glow);
    socket.add(staff);
    return staff;
  }

  const kind = enemyWeaponKind(archetype) || (weapon === 'sword' ? 'sword' : null);
  if (kind) {
    const packed = buildHeldWeapon(kind, { ghost });
    if (packed) { socket.add(packed); return packed; }
  }

  if (weapon === 'claw') {
    const claw = clawMesh(glow);
    socket.add(claw);
    return claw;
  }
  if (weapon === 'sword') {
    // Offline fallback only: items.glb is absent.
    const blade = new THREE.Group();
    blade.add(swordMesh(glow, ghost));
    // Identical local transform to the procedural rig: the socket is built so
    // that y = -0.72 is the fist there too.
    blade.position.set(0, -0.72, 0.06);
    blade.rotation.x = -0.25;
    socket.add(blade);
    return blade;
  }
  return null;
}

/**
 * A monster's weapon, if it should have one at all.
 *
 * Most creatures answer 'native' (their weapon mesh is skinned to their own
 * skeleton and is already in the body draw call) or 'kit' (creatures.js
 * socketed the KayKit axe/shield/staff the skeleton was modelled with), and
 * both are already done by the time this runs. 'none' is a real answer: a yeti
 * and a demon fight with what they have, and claws beat a glowing plank.
 */
function attachCreatureWeapon(inst) {
  const slot = inst.weaponSlot;
  if (!slot || slot === 'none' || slot === 'native' || slot === 'kit') return null;
  if (!inst.sockets.hand) return null;
  const held = buildHeldWeapon(slot);
  if (!held) return null;
  inst.sockets.hand.add(held);
  return held;
}

const _dummy = () => new THREE.Object3D();

// ------------------------------------------------------------ hero presence
//
// In combat the eye must find the PLAYER first, but every legal brightening
// tool is banned on him: no rim, no glow, no emissive on a living body
// (tools/visual-test.mjs and acceptance both audit for it). What is not
// banned is LIGHT — so the hero carries a small warm point light that lifts
// his own shading a touch and leaves everyone else exactly as lit as before.
// Enemies never get one, which is the whole point: same materials, different
// illumination, and the player reads brightest without a single shader trick.
//
// This does not violate city.js's "NO POINT LIGHTS, EVER" rule, which is
// about TOGGLING: NUM_POINT_LIGHTS is part of three's program cache key, so
// flipping a light's visibility recompiles every material in the scene. This
// light exists from _buildPlayer on and is never toggled — the count only
// moves when the player is created or destroyed, alongside the projectile and
// pickup lights game.js already adds and removes.
const HERO_LIGHT = {
  color: 0xffc24b,     // the player's own glow colour — one warm identity
  intensity: 0.6,      // restrained: the arena key light is 1.9
  distance: 6,
  decay: 2,            // physical falloff, same as world.js's fill light
};

/**
 * Attach (or keep) the player's presence light. Idempotent: the upgrade path
 * rebuilds the player's body in place, and the light must survive that
 * without ever being doubled.
 */
function attachHeroLight(root) {
  const prev = root.userData.heroLight;
  if (prev && prev.parent === root) return prev;
  const light = new THREE.PointLight(
    HERO_LIGHT.color, HERO_LIGHT.intensity, HERO_LIGHT.distance, HERO_LIGHT.decay,
  );
  light.name = 'heroLight';
  // Above and slightly BEHIND the shoulders. The gameplay camera rides behind
  // the player, so this is the side of him the eye actually reads. ~0.55 m
  // off the upper back puts the inverse-square peak on the torso the camera
  // frames (0.6 / 0.3 m^2 is comparable to the 1.9 key light on that one
  // band) and it falls to a faint warm floor pool within two metres —
  // measured per-character on the pinned visual-test scene, where the dark
  // adventurer torso read 0.25 mean luma against 0.68 for a bone skeleton.
  light.position.set(0, 1.55, 0.55);
  // Never a shadow caster: a point-light shadow is six cubemap passes, which
  // is a desktop luxury this phone budget does not have.
  light.castShadow = false;
  root.add(light);
  root.userData.heroLight = light;
  return light;
}

/**
 * Fill `root` with a skinned character. Returns false when the pack is absent,
 * the tier's character budget is already spent, or the merge failed — in every
 * one of those cases the caller falls back to the procedural rig.
 */
/**
 * Archetypes that are MONSTERS and come out of creatures.glb.
 *
 * The two that are missing are the two that are supposed to be people: the
 * PLAYER, and the SHADOW soldiers — shadows are raised from the fallen, so a
 * humanoid silhouette is not a placeholder there, it is the fiction. Corpses go
 * the same way, because a corpse is a shadow that has not been bound yet.
 */
const CREATURE_ARCHETYPES = new Set([
  'grunt', 'stalker', 'brute', 'caster', 'lancer', 'howler', 'boss',
]);

function buildSkinnedInto(root, opts) {
  const archetype = opts.archetype || inferArchetype(opts);
  const monster = !opts.ghost
    && opts.creatures !== false
    && CREATURE_ARCHETYPES.has(archetype)
    && creaturesReady();
  if (!monster && !charactersReady()) return false;

  // The player must look the same every session; everything else varies per
  // spawn, which is the entire point of this change.
  let seed = opts.seed;
  if (seed == null) {
    if (archetype === 'player') seed = 'player';
    else {
      const n = (_spawnSeq.get(archetype) || 0) % APPEARANCE_VARIANTS;
      _spawnSeq.set(archetype, n + 1);
      seed = `${archetype}:${n}`;
    }
  }

  const rank = opts.rank || 'E';
  // Warm the WHOLE rank's character looks up front, even when this spawn is
  // going to be a monster. Shadows, corpses and the over-budget fallback all
  // still come from characters.glb, so those geometries get allocated either
  // way — and allocating them in one early pass is the difference between a
  // cache that converges by the first gate and one that adds five geometries in
  // gate six, which tools/entity-test.mjs reads (correctly) as a leak.
  if (charactersReady()) warmRank(rank);

  let inst = null;
  if (monster) {
    inst = makeCreature({
      seed,
      archetype,
      rank,
      // game.js does not name the boss today, and creatures.js falls back to a
      // rank lookup that happens to be exact. Passing it (see the handoff) is
      // still strictly better than relying on that coincidence.
      boss: typeof opts.boss === 'string' ? opts.boss : null,
      scale: 1,                     // the caller's scale rides on `root`
      glow: opts.glow,
      eyes: true,
      ignoreBudget: archetype === 'boss',
    });
  }
  if (!inst && charactersReady()) {
    // Creature pack absent, or its budget spent: a humanoid enemy is a worse
    // read than a monster but a far better one than no enemy at all.
    inst = makeCharacter({
      seed,
      archetype,
      rank,
      scale: 1,
      glow: opts.glow,
      color: opts.color,
      ghost: opts.ghost,
      // The armour look (RPG_SPEC step 12). Usually absent — appearanceFor
      // then reads the module's cached equipment look, so a rebuild after a
      // wardrobe change resolves the NEW armour rather than a value frozen
      // into buildOpts at first build. An explicit partsOverride (tests, or a
      // future preview feature) still rides buildOpts and wins.
      partsOverride: opts.partsOverride,
      // The telegraph mote costs 2 draw calls (main pass + glow pass) and only
      // earns them on something that winds up an attack at you. The player can
      // see his own swing and shadows are already emissive head to foot.
      eyes: archetype !== 'player' && !opts.ghost,
      armed: opts.weapon && opts.weapon !== 'none',
      ignoreBudget: archetype === 'player' || archetype === 'boss',
    });
  }
  if (!inst) return false;

  // Tear the procedural body out, but never the DecalPool proxies — the ground
  // ring is parented here by game.js and releasing its slot would strand it.
  const equipped = root.userData.weapon || null;
  if (equipped?.main) equipped.main.removeFromParent();
  if (equipped?.offhand) equipped.offhand.removeFromParent();
  for (const child of [...root.children]) {
    if (child.isDecal) continue;
    // The hero light outlives the body swap: destroying and re-creating it
    // here would flick NUM_POINT_LIGHTS and recompile every material mid-boot.
    if (child === root.userData.heroLight) continue;
    root.remove(child);
    disposeObject3D(child);
  }
  root.userData.cape = null;

  root.add(inst.root);
  root.userData.character = inst;
  root.userData.appearance = inst.appearance;
  if (archetype === 'player') attachHeroLight(root);

  const legL = _dummy(); const legR = _dummy();
  inst.root.add(legL, legR);
  root.userData.rig = {
    body: inst.root,
    torso: inst.mesh,
    head: inst.sockets.head || inst.root,
    armL: inst.sockets.handL || inst.root,
    armR: inst.sockets.hand || inst.root,
    legL,
    legR,
    blade: null,
    eyeL: inst.eyes || legL,
    eyeR: inst.eyes || legL,
    // weapons.js prefers these over the arm fallback, and they are the only
    // sockets on a skinned rig that are actually a hand.
    hand: inst.sockets.hand || null,
    handL: inst.sockets.handL || null,
    // Where a sheathed weapon rides. weapons.js setStance re-parents between
    // these and the hand; null here falls back to the torso rather than
    // dropping the weapon at the character's feet.
    back: inst.sockets.back || null,
    hip: inst.sockets.hip || null,
  };

  // A corpse is the one humanoid game.js never calls animateRig on: it is
  // built ghosted-but-uncloaked, tipped by -PI/2.4 and left to sink. The tip
  // is cancelled on the inner group (same axis, so the two X rotations
  // commute) and the Death clip PLAYS from standing instead of being scrubbed
  // to its last frame — game.js ticks the mixer from _updateCorpses, so the
  // fallen visibly crumple where the old code teleported them into the final
  // pose. clampWhenFinished then holds the ground pose for the Bind window.
  if (opts.ghost && !opts.cloak && archetype === 'shadow') {
    inst.play('die', { fade: 0, once: true, clamp: true });
    inst.mixer.update(0.01);      // pose the first frame, not the last
    inst.root.rotation.x = Math.PI / 2.4;
  }

  if (equipped?.main && inst.sockets.hand) {
    inst.sockets.hand.add(equipped.main);
    root.userData.rig.blade = equipped.main;
    if (equipped.offhand && inst.sockets.handL) inst.sockets.handL.add(equipped.offhand);
    // The upgrade path re-parents the weapon without going through
    // equipWeapon, so the armed idle/attack posture is restated here.
    inst.setArmed?.(true);
    // ...and so is the stance. The pack upgrade lands seconds after boot, long
    // after the city may already have sheathed the sword; putting the blade
    // back in the fist here would look like the toggle spontaneously failed.
    if (root.userData.stance === 'sheathed') setStance(root, 'sheathed');
  } else if (inst.isCreature) {
    // game.js hands every enemy a 'sword'/'claw'/'staff' string. A monster
    // ignores it: what it carries was decided when it was modelled.
    root.userData.rig.blade = attachCreatureWeapon(inst);
  } else {
    root.userData.rig.blade = attachHandWeapon(
      inst.sockets.hand, opts.weapon, opts.glow, opts.ghost, archetype,
    );
  }
  // Remembered so rebuildHumanoid can re-run this swap later — the identity
  // screen's body flip needs the same in-place rebuild the upgrade path does,
  // but for a root the pending map already drained.
  root.userData.buildOpts = opts;
  return true;
}

/**
 * Rebuild an already-skinned humanoid in place with the opts it was first
 * built from. The identity screen's M/F flip goes through here: appearanceFor
 * re-resolves the player pool off the NEW body, and the equipped weapon + hero
 * light survive the swap exactly as they do on a pack upgrade. Returns false
 * (leaving the body untouched) when the pack is absent — the box-man has no
 * gendered body to swap anyway.
 */
export function rebuildHumanoid(root) {
  const opts = root?.userData?.buildOpts;
  if (!opts || (!charactersReady() && !creaturesReady())) return false;
  // The outgoing instance's mixer and merged-geometry refcount hang off
  // userData, out of reach of buildSkinnedInto's child-dispose traversal, so
  // they are released here — but only after the new body exists, so a failed
  // build cannot leave a stripped player behind.
  const old = root.userData.character || null;
  root.userData.character = null;
  const ok = buildSkinnedInto(root, opts);
  if (ok) old?.dispose();
  else root.userData.character = old;
  return ok;
}

/**
 * Swap every humanoid built before the pack finished loading. Without this the
 * player — who is constructed during Game's constructor, long before a 3.2 MB
 * GLB can arrive — would be a box-man for the whole session.
 */
export function upgradePendingHumanoids() {
  if (!charactersReady() && !creaturesReady()) return 0;
  let n = 0;
  for (const [root, opts] of Array.from(_pending)) {
    _pending.delete(root);
    if (!root.parent && !opts.keepDetached) continue;   // already thrown away
    if (buildSkinnedInto(root, opts)) n++;
  }
  return n;
}

// ------------------------------------------------------------------- rig

export function makeHumanoid(opts = {}) {
  const {
    color = 0x7c5cff,
    glow = 0xffffff,
    accent = 0x2b2f4a,
    scale = 1,
    weapon = 'sword',
    cloak = false,
    ghost = false,
    boss = false, // reserved: difficulty.js passes it, nothing reads it yet
  } = opts;

  // Fire-and-forget; resolves FALSE when public/models/characters.glb is absent.
  preloadCharacters();

  const built = { color, glow, accent, scale, weapon, cloak, ghost, boss, ...opts };
  if ((charactersReady() || creaturesReady()) && opts.characters !== false) {
    const skinned = new THREE.Group();
    if (buildSkinnedInto(skinned, built)) {
      skinned.scale.setScalar(scale);
      return skinned;
    }
  }

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
  // The box-man player carries the same presence light the skinned one does —
  // the silhouette problem does not care which body the hero happens to wear.
  if ((opts.archetype || inferArchetype(built)) === 'player') attachHeroLight(root);
  // `head` and `torso` are the same object now that they share a geometry; the
  // rig keys are kept because animateRig and game.js both address them by name.
  // eyeL/eyeR likewise both point at the single merged eye mesh, so the
  // telegraph flare still works unchanged.
  // Stow anchors for the offline path. The game must boot and play with
  // public/models/ deleted, which means the box-man has to be able to put a
  // sword away too. Two empty Object3Ds cost no draw call and no geometry; the
  // heights are the box-man's own chest and hip (shoulder pivots sit at 1.58,
  // leg pivots at 0.82), so weapons.js's one STOW table lands in the same
  // place on both bodies.
  const backAnchor = new THREE.Object3D(); backAnchor.position.set(0, 1.55, 0);
  const hipAnchor = new THREE.Object3D(); hipAnchor.position.set(0, 1.00, 0);
  body.add(backAnchor, hipAnchor);
  root.userData.rig = {
    body, torso, head: torso, armL, armR, legL, legR, blade, eyeL: eyes, eyeR: eyes,
    back: backAnchor, hip: hipAnchor,
  };
  // If the pack is still in flight this box-man is provisional: remember what
  // it was asked for so upgradePendingHumanoids can rebuild it as a real
  // character the moment characters.glb resolves. Bounded, because the map is
  // drained on the first upgrade pass and entries are removed on disposal.
  if ((!charactersReady() || !creaturesReady())
    && opts.characters !== false && _pending.size < 128) {
    _pending.set(root, built);
  }
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
//
// SIGNATURE UNCHANGED: game.js calls this in three places and weapons.js
// authors its swing curves against the same option bag. A GLB-backed humanoid
// is routed to its AnimationMixer here rather than at the call site, which is
// what lets the skinned characters land without touching game.js at all.
//
// `dt` is an OPTIONAL extra key. Without it the mixer measures wall-clock,
// which is right except that hit-stop and level-up time dilation do not slow
// the animation down; passing dt makes them match.
export function animateRig(root, opts = {}) {
  const character = root.userData?.character;
  if (character) { character.animate(opts); return; }

  const {
    // `flinch` (Wave D stage 3) is a signed lateral: which way the body should
    // recoil, -1..1, computed by the caller from the blow's bearing relative
    // to facing (positive = blow came from the LEFT, so the lean goes right).
    // 0 — every caller that does not pass it — keeps the shipped symmetric
    // wobble byte-identical, so citizens, shadows and enemies are untouched.
    // Skinned characters route through CharacterInstance.animate above, which
    // plays its HitRecieve clip and ignores unknown keys; this directional
    // lean is the procedural box-man's twin of that clip.
    moving, speed, t, attackPhase = 0, hurt = 0, flinch = 0, airborne = false, riseRate = 0,
    // Swing shaping, supplied by weapons.js attackAnim for the player. The
    // defaults are EXACTLY the numbers this branch used to hardcode (wind to
    // -1.5 over the first 30%, chop through to +1.9, torso twist 0.22), so
    // every caller that does not pass them — enemies, shadows, citizens —
    // poses byte-identically to before.
    swingContact = 0.3, swingLo = -1.5, swingHi = 1.9, swingTwist = 0.22,
    twoHand = false, mirror = false,
  } = opts;
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
    // Wind up then chop through — the lead arm carries it, torso
    // counter-rotates. The break point sits on the CONTACT frame so the pose
    // reaches the bottom of the arc on the exact frame damage is applied.
    const p = 1 - attackPhase; // 0 -> 1 over the swing
    const c = Math.min(0.9, Math.max(0.1, swingContact));
    const swing = p < c
      ? swingLo * (p / c)
      : swingLo + (swingHi - swingLo) * ((p - c) / (1 - c));
    // Daggers alternate hands (mirror); two-handers drag both arms through
    // the same arc instead of the off-arm's light counter-swing.
    const lead = mirror ? armL : armR;
    const off = mirror ? armR : armL;
    lead.rotation.x = swing;
    off.rotation.x = twoHand ? swing : -swing * 0.3;
    body.rotation.y = swing * swingTwist * (mirror ? -1 : 1);
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
    if (flinch) {
      // DIRECTIONAL FLINCH (Wave D stage 3): the body leans AWAY from the
      // blow and the head snaps INTO it — the two-part recoil every stunt
      // reel teaches — instead of the direction-blind shimmy below. The lean
      // is a decaying bias (hurt runs 0.35 -> 0) with the old wobble riding
      // on top at reduced amplitude, so the silhouette still shakes but the
      // shake now points somewhere. bias + wobble EQUALS the legacy ceilings
      // (0.09+0.05 = body 0.14, 0.06+0.04 = head 0.10) so a flinched pose
      // can never bend further than the shipped one — the review caught the
      // first cut exceeding its own stated envelope by 14%.
      body.rotation.z = flinch * (0.09 * hurt + Math.sin(hurt * 40) * 0.05 * hurt);
      head.rotation.z = -flinch * (0.06 * hurt + Math.sin(hurt * 40) * 0.04 * hurt);
    } else {
      body.rotation.z = Math.sin(hurt * 40) * 0.14 * hurt;
      head.rotation.z = -Math.sin(hurt * 40) * 0.1 * hurt;
    }
  } else {
    head.rotation.z *= 0.8;
  }

  if (root.userData.cape) {
    root.userData.cape.rotation.x = 0.16 + (moving ? Math.sin(t * 8) * 0.06 + 0.14 : Math.sin(t * 1.5) * 0.03);
  }
}
