import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOW_LAYER } from './glow.js';
import { PROCEDURAL_HEIGHT } from './characters.js';
import { Quality, TIERS } from '../core/quality.js';

// MONSTERS. 17 curated creatures out of public/models/creatures.glb (13
// Quaternius Ultimate Monsters + 4 KayKit skeletons, all CC0), built by
// tools/build-creatures-glb.mjs and described by public/models/creatures.json.
//
// WHY THIS FILE EXISTS. The shipped build put characters.glb bodies on every
// enemy, so an E-GRADE RIFT was fought against a construction worker in a
// hi-vis hard hat. creatures.glb was in the APK and imported by nothing. This
// module is the other half of entities.js's skinned path: characters.glb keeps
// the PLAYER and the SHADOW SOLDIERS (shadows are humanoid because they are
// raised from the fallen, which is the one place a person is correct), and
// everything hostile comes from here.
//
// THE API IS characters.js's API ON PURPOSE. loadCreatureModels /
// creaturesReady / makeCreature / creatureStats / setCreatureQuality /
// disposeCreatureModels mirror their character equivalents, and the object
// makeCreature returns exposes the same surface CharacterInstance does
// (root, mesh, mixer, sockets, eyes, appearance, play, animate, clipDuration,
// dispose). entities.js therefore treats the two interchangeably instead of
// growing a second idiom.
//
// ---------------------------------------------------------- five asset facts
// all read off the manifest or measured through three.js, and all re-asserted
// by tools/creature-test.mjs:
//
// 1. SEVENTEEN CREATURES, EACH A DIRECT CHILD OF THE ONE SCENE, each with its
//    own skeleton. There is no shared rig here and no part swapping: a monster
//    is one authored thing.
// 2. EVERY CLIP IS NAMESPACED `<key>__<clip>` and binds to exactly one
//    creature. GLTFLoader renames duplicate node names on load, so a genuinely
//    shared clip library would bind to whichever creature happened to keep the
//    original names. Never play `orc__walk` on anything but an orc.
// 3. THE MESHES ARE QUANTIZED AND THE MESH NODE TRANSFORM IS A LIE — same as
//    characters.glb. Every mesh node under a creature carries the identical
//    dequantisation translate+scale, and the dequantisation is also baked into
//    the inverse bind matrices, so a SkinnedMesh bound with an IDENTITY bind
//    matrix and no node transform lands in metres. That is what makes fact 4
//    safe.
// 4. A KAYKIT SKELETON IS 9-10 PRIMITIVES SPLIT BY MATERIAL (skeleton + Glow),
//    which would be 9-10 draw calls per enemy. Because every one of those
//    primitives shares one skeleton and one node transform, they merge per
//    material into 2 SkinnedMeshes. Quaternius creatures are 1-2 primitives
//    and merge to 1 — including their built-in weapon mesh, which is skinned
//    to the same skeleton and therefore free.
// 5. NOTHING HERE MAY THROW. The game is fully offline. A missing or corrupt
//    creatures.glb has to leave entities.js on characters.glb (and, failing
//    that, on the procedural box-man), not take the boot down.

// --------------------------------------------------------------- constants

/** Logical states, identical to CHARACTER_STATES so callers need no branch. */
export const CREATURE_STATES = [
  'idle', 'walk', 'run', 'attack', 'hurt', 'die', 'cast', 'jump', 'roll', 'wave', 'interact',
];

// The three clip vocabularies in this pack (Quaternius ground, Quaternius
// flying, KayKit) listed in preference order per state, all lowercase because
// the builder lowercased every clip suffix. A rename upstream degrades to a
// worse animation rather than to nothing.
const CLIP_FOR = {
  idle: ['idle', 'flying_idle', 'skeletons_idle', 'idle_a'],
  walk: ['walk', 'walking_a', 'skeletons_walking', 'fast_flying', 'run', 'flying_idle'],
  run: ['run', 'running_a', 'fast_flying', 'walk', 'walking_a', 'skeletons_walking'],
  attack: [
    'weapon', 'melee_2h_attack_chop', 'melee_1h_attack_chop', 'melee_1h_attack_stab',
    'ranged_magic_shoot', 'bite_front', 'headbutt', 'punch', 'melee_unarmed_attack_punch_a',
  ],
  hurt: ['hitreact', 'hitrecieve', 'hit_a', 'hit_b'],       // upstream spelling, preserved
  die: ['death', 'skeletons_death', 'hitreact', 'hitrecieve'],
  cast: ['ranged_magic_spellcasting', 'ranged_magic_shoot', 'skeletons_taunt', 'idle', 'flying_idle'],
  jump: ['jump', 'fast_flying', 'run', 'running_a'],
  roll: ['dodge_backward', 'jump', 'run', 'running_a'],
  wave: ['skeletons_taunt', 'idle', 'flying_idle'],
  interact: ['idle', 'skeletons_idle', 'flying_idle'],
};

/** Above this ground speed a creature runs instead of walking. */
const RUN_SPEED = 5.0;

const RANKS = ['E', 'D', 'C', 'B', 'A', 'S'];

/**
 * Presence table. Everything that is a JUDGEMENT rather than a measurement
 * lives here, in one block, so retuning how a monster reads never means
 * touching the loading code.
 *
 *   height   world height at scale 1, in the same units the procedural rig
 *            uses (PROCEDURAL_HEIGHT = 2.14 is a person). The instance is
 *            normalised onto this from the manifest's measured size, so a blob
 *            is knee-high and a demon looms without either of them being
 *            authored at the same size.
 *   hover    metres off the ground. The flying rigs have no contact pose and
 *            no walk clip; standing one on the floor reads as a bug.
 *   weapon   'native'  the creature's own weapon mesh is skinned to its
 *                      skeleton and already animates (orc, orc_skull, demon)
 *            'kit:...' KayKit props out of this same GLB, socketed to the
 *                      handslot bones the pack ships for exactly this
 *            <kind>    a kind key in weapons.js's held-model table: a real
 *                      model from items.glb goes in the fist
 *            null      CLAWS. A yeti does not hold a sword, and nothing here
 *                      ever gets a procedural plank.
 *   eye      telegraph-mote offset in world units, or null for none.
 */
// BOSSES ARE NOT TALLER THAN TRASH IN THIS TABLE, deliberately. config.js
// already scales them 2.5x-3.4x on top of whatever is here, and game.js pins
// the boss health bar at a FIXED world y of 5.6 — so a boss authored at 2.45
// comes out 6.4 units tall at C rank and wears its own health bar across its
// face. Measured, screenshotted, and the reason every boss entry below is
// ~2.1: 2.1 x 2.6 = 5.5, which clears the bar. B/A/S bosses still exceed it and
// need the game.js fix in the handoff.
const LOOK = {
  greenblob: { height: 1.15, hover: 0, weapon: null, eye: { y: 0.20, z: 0.30 } },
  greenspikyblob: { height: 1.45, hover: 0, weapon: null, eye: { y: 0.24, z: 0.34 } },
  tribal: { height: 2.14, hover: 0, weapon: 'axe', eye: { y: 0.10, z: 0.16 } },
  orc: { height: 2.30, hover: 0, weapon: 'native', eye: { y: 0.10, z: 0.18 } },
  orc_skull: { height: 2.10, hover: 0, weapon: 'native', eye: { y: 0.10, z: 0.18 } },
  ghost: { height: 2.05, hover: 0.35, weapon: null, eye: { y: 0.06, z: 0.20 } },
  ghost_skull: { height: 2.05, hover: 0.38, weapon: null, eye: { y: 0.06, z: 0.20 } },
  yeti: { height: 2.05, hover: 0, weapon: null, eye: { y: 0.10, z: 0.20 } },
  goleling_evolved: { height: 1.90, hover: 0.30, weapon: null, eye: { y: 0.06, z: 0.22 } },
  dragon: { height: 1.55, hover: 0.55, weapon: null, eye: { y: 0.04, z: 0.24 } },
  demon: { height: 2.15, hover: 0, weapon: 'native', eye: { y: 0.12, z: 0.20 } },
  alien: { height: 2.05, hover: 0, weapon: 'dagger', eye: { y: 0.08, z: 0.16 } },
  dragon_evolved: { height: 2.00, hover: 0.22, weapon: null, eye: { y: 0.06, z: 0.26 } },
  // The KayKit set already ships emissive eye meshes, so the mote is small and
  // sits just off the skull rather than replacing them.
  skeleton_minion: { height: 2.05, hover: 0, weapon: 'kit:kaykit_blade,kaykit_shield_small_a', eye: null },
  // No quiver: it ships with the pack and it fits, but a quiver on a rogue
  // holding a BLADE promises a bow that is never drawn, and it is the one prop
  // that pushed this creature over tools/entity-test.mjs's six-mesh rig budget.
  skeleton_rogue: { height: 2.05, hover: 0, weapon: 'kit:kaykit_blade', eye: null },
  skeleton_mage: { height: 2.10, hover: 0, weapon: 'kit:kaykit_staff', eye: null },
  skeleton_warrior: { height: 2.10, hover: 0, weapon: 'kit:kaykit_axe,kaykit_shield_large_a', eye: null },
};

/**
 * Which creature is the boss of each rank. The manifest's own boss field maps
 * 1:1 onto config.js's GATES (warden E, gravelord D, frostcaller C, infernus B,
 * weaver A, archon S), so this table is derivable — but game.js does not pass
 * the boss key today, only the rank, and a rank is enough. Passing `boss`
 * explicitly (see the entities.js handoff) overrides it.
 */
const BOSS_BY_NAME = {
  warden: 'skeleton_warrior',
  gravelord: 'orc_skull',
  frostcaller: 'yeti',
  infernus: 'demon',
  weaver: 'alien',
  archon: 'dragon_evolved',
};
const BOSS_BY_RANK = {
  E: 'skeleton_warrior', D: 'orc_skull', C: 'yeti', B: 'demon', A: 'alien', S: 'dragon_evolved',
};

// ------------------------------------------------------------ module state

let _loaded = false;
let _loading = null;
let _scene = null;
let _manifest = null;
let _clips = new Map();          // clip name -> AnimationClip
const _templates = new Map();    // creature key -> Template
const _recs = new Map();         // creature key -> manifest record (+ look)
const _props = new Map();        // prop key -> source Object3D
const _live = new Set();

let _mergeFailures = 0;
let _liveInstances = 0;

// ---------------------------------------------------------------- quality
//
// Same shape and the same reasoning as characters.js: a skeleton costs a
// bone-matrix pass and a bone-texture upload per instance per frame on the CPU,
// which no resolution drop reduces. The tier caps how many enemies may be
// creature-backed at once; entities.js falls back past the cap.
//
// Measured against the manifest: a Quaternius creature is 1.5k-7.7k triangles
// in ONE draw call (its built-in weapon merges into the body), a KayKit
// skeleton 4.6k-5.9k in TWO. That is at or below the 8.9k / 2-call merged
// character it replaces, so the budget can match character budget exactly.
const BUDGET = { low: 8, medium: 14, high: 20, ultra: 26 };

let _quality = { tier: 'medium', budget: BUDGET.medium, castShadow: true };

try {
  const guess = Quality.guessStartTier();
  _quality = {
    tier: guess,
    budget: BUDGET[guess] ?? BUDGET.medium,
    castShadow: TIERS[guess]?.shadows !== false,
  };
} catch { /* headless: keep the medium default */ }

/** Point the creature budget at a quality tier object (or its name). */
export function setCreatureQuality(tier) {
  const name = typeof tier === 'string' ? tier : tier?.name;
  if (!name || !BUDGET[name]) return;
  _quality = {
    tier: name,
    budget: BUDGET[name],
    castShadow: (typeof tier === 'object' ? tier.shadows : TIERS[name]?.shadows) !== false,
  };
  for (const inst of _live) for (const m of inst.meshes) m.castShadow = _quality.castShadow;
}

/** True when another creature fits inside the tier's budget. */
export function creatureBudgetAvailable() {
  return _loaded && _liveInstances < _quality.budget;
}

// ------------------------------------------------------------------ seeds

/** FNV-1a, byte-identical to the one in characters.js so seeds behave alike. */
function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return (seed >>> 0) || 1;
  let h = 0x811c9dc5;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- loading

function lower(s) { return String(s || '').toLowerCase(); }

/**
 * Load creatures.glb + creatures.json.
 *
 * Resolves TRUE on success and FALSE on ANY failure. Never throws, never
 * rejects: an APK shipped with public/models/ deleted must still boot, and
 * entities.js reads the false and stays on the humanoid path.
 */
export async function loadCreatureModels(
  url = 'models/creatures.glb',
  manifestUrl = 'models/creatures.json',
) {
  if (_loaded) return true;
  if (_loading) return _loading;

  _loading = (async () => {
    let manifest = null;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) return false;
      manifest = await res.json();
    } catch {
      return false;
    }
    if (!manifest?.creatures) return false;

    const gltf = await new Promise((resolve) => {
      let loader;
      try {
        loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
      } catch {
        resolve(null);
        return;
      }
      loader.load(url, resolve, undefined, () => resolve(null));
    });
    if (!gltf?.scene) return false;

    try {
      return adopt(gltf, manifest);
    } catch {
      _loaded = false;
      return false;
    }
  })();

  return _loading;
}

function adopt(gltf, manifest) {
  _scene = gltf.scene;
  _manifest = manifest;
  _scene.updateMatrixWorld(true);

  _clips = new Map();
  for (const c of gltf.animations || []) _clips.set(lower(c.name), c);

  // Every clone shares geometry and materials with this scene, so entity
  // teardown must not free them. entities.disposeObject3D frees anything it
  // reaches that is NOT flagged — without this one expiring monster would
  // dispose the geometry that all 17 of them are still using.
  _scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    if (o.geometry) o.geometry.userData.shared = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.userData.shared = true;
      // Same trap models.js documents: an FBX-sourced material can arrive with
      // opacity 0 on an OPAQUE alphaMode, which draws nothing and warns nobody.
      if (!m.transparent && m.opacity < 1) m.opacity = 1;
    }
  });

  _recs.clear();
  for (const [k, rec] of Object.entries(manifest.creatures)) {
    const key = lower(k);
    // Android is case-sensitive and macOS is not; keys are lowercased on both
    // sides so a capitalisation slip cannot ship as a device-only bug.
    _recs.set(key, { ...rec, key, look: LOOK[key] || { height: PROCEDURAL_HEIGHT, hover: 0, weapon: null, eye: null } });
  }

  _props.clear();
  for (const k of Object.keys(manifest.props || {})) {
    const node = _scene.getObjectByName(k);
    if (node) _props.set(lower(k), node);
  }

  _templates.clear();
  for (const key of _recs.keys()) {
    const t = buildTemplate(key, _recs.get(key));
    if (t) _templates.set(key, t);
  }

  _loaded = _templates.size > 0;
  return _loaded;
}

/**
 * One reusable bone tree + merged SkinnedMeshes per creature.
 *
 * Cloning the shipped node directly would work but would carry 9-10 separate
 * primitives per KayKit skeleton into every instance. This builds the merged
 * form ONCE, and SkeletonUtils.clone then has one bone tree and 1-2 meshes to
 * copy per spawn. SkeletonUtils.clone and never Object3D.clone: the latter
 * leaves every instance pointing at the SOURCE skeleton and the whole field
 * animates as one creature.
 */
function buildTemplate(key, rec) {
  const root = _scene.getObjectByName(key);
  if (!root) return null;

  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) return null;

  const skeleton = skinned[0].skeleton;
  // Every mesh under a creature binds to the same skin, which is what makes the
  // merge below legal. Anything else is a pack change and is refused.
  for (const m of skinned) if (m.skeleton !== skeleton) return null;

  const boneRoot = skeleton.bones.find((b) => !b.parent?.isBone) || skeleton.bones[0];
  if (!boneRoot) return null;

  const template = new THREE.Group();
  template.name = `creature_${key}`;
  // clone(true) carries the non-skinned props parented to bones (the KayKit
  // helmet lives under the head bone) along with the skeleton.
  const bones = boneRoot.clone(true);
  template.add(bones);

  const byName = new Map();
  bones.traverse((o) => { if (o.isBone) byName.set(o.name, o); });
  const ordered = skeleton.bones.map((b) => byName.get(b.name)).filter(Boolean);
  if (ordered.length !== skeleton.bones.length) return null;

  // Group by material, merge inside each group. All primitives share one node
  // transform (asset fact 3), so their positions are already in one space.
  const groups = new Map();
  for (const m of skinned) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!mat) continue;
    let g = groups.get(mat.uuid);
    if (!g) { g = { material: mat, geos: [] }; groups.set(mat.uuid, g); }
    g.geos.push(m.geometry);
  }
  if (!groups.size) return null;

  const size = Array.isArray(rec.size) ? rec.size : [2, 2, 2];
  const height = size[1] || PROCEDURAL_HEIGHT;
  const radius = Math.max(size[0], size[1], size[2]) * 0.8 + 0.4;

  let index = 0;
  for (const g of groups.values()) {
    let geometry = g.geos[0];
    if (g.geos.length > 1) {
      let merged = null;
      try {
        merged = mergeGeometries(g.geos, false);
      } catch {
        merged = null;
      }
      if (merged) {
        // Merged geometry is OURS, not the pack's, but it is shared by every
        // instance of this creature — disposeCreatureModels frees it.
        merged.userData.shared = true;
        geometry = merged;
      } else {
        // Survivable: the creature just costs one draw call per primitive
        // instead of one per material. Counted so the test can hold it at zero.
        _mergeFailures++;
      }
    }
    const skin = new THREE.SkinnedMesh(geometry, g.material);
    skin.name = `skin${index++}`;
    template.add(skin);
    // Identity bind matrix + no node transform: see asset fact 3. A computed
    // bounding sphere would be ~7900 units across (quantised positions) and
    // nothing would ever cull, so the real bounds are published from the
    // manifest's measured size instead.
    skin.bind(new THREE.Skeleton(ordered, skeleton.boneInverses), new THREE.Matrix4());
    skin.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.5, 0), radius);
    skin.geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(-radius, -0.4, -radius), new THREE.Vector3(radius, height + 0.6, radius),
    );
    if (g.geos.length > 1 && geometry !== g.geos[0]) {
      // Only the merged copies are ours to free later.
      geometry.userData.owned = true;
    }
  }

  return {
    key,
    template,
    boneCount: ordered.length,
    /** Authored height, metres, before normalisation. */
    authoredHeight: height,
    /** Scale that puts this creature at its LOOK height. */
    scale: (rec.look?.height || PROCEDURAL_HEIGHT) / (height || PROCEDURAL_HEIGHT),
    drawCalls: groups.size,
  };
}

export function creaturesReady() { return _loaded; }
export function creatureManifest() { return _manifest; }
export function creatureKeys() { return Array.from(_recs.keys()).sort(); }
export function creatureRecord(key) { return _recs.get(lower(key)) || null; }

// ------------------------------------------------------------- casting
//
// The counterpart of characters.appearanceFor: turn (seed, archetype, rank)
// into a concrete creature. There is no part mixing here — a monster is one
// authored thing — so variety comes from the pool, not from a chimera.

function ranksOf(rec) {
  const out = [rec.rank, ...(rec.alsoRanks || [])];
  return out.filter(Boolean);
}

function rankDistance(rec, rank) {
  const want = RANKS.indexOf(rank);
  if (want < 0) return 0;
  let best = 99;
  for (const r of ranksOf(rec)) {
    const d = Math.abs(RANKS.indexOf(r) - want);
    if (d >= 0 && d < best) best = d;
  }
  return best;
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

/**
 * Deterministic creature choice.
 *
 * @param {string|number} seed      anything stable — 'grunt:2', a spawn index
 * @param {object} opts
 * @param {string} opts.archetype   grunt|stalker|brute|caster|lancer|howler|boss
 * @param {string} opts.rank        'E'..'S'
 * @param {string} [opts.boss]      boss key from config.js BOSSES, when known
 * @returns {{key,creature,archetype,rank,role,look}|null}
 */
export function creatureFor(seed, { archetype = 'grunt', rank = 'E', boss = null } = {}) {
  if (!_loaded) return null;

  if (archetype === 'boss') {
    const key = (boss && BOSS_BY_NAME[boss]) || BOSS_BY_RANK[rank] || BOSS_BY_RANK.E;
    const rec = _recs.get(key) || _recs.get(BOSS_BY_RANK.E);
    if (!rec || !_templates.has(rec.key)) return null;
    return { key: rec.key, creature: rec, archetype: 'boss', rank, role: 'boss', look: rec.look };
  }

  const usable = Array.from(_recs.values()).filter((r) => r.role !== 'boss' && _templates.has(r.key));
  if (!usable.length) return null;

  // Four widening passes, in order. Rank E has no stalker and no caster in the
  // pack, and the game spawns both at E, so a widening rule is not an edge case
  // — it is the normal path for half the archetypes in the first gate.
  const exact = usable.filter((r) => r.archetype === archetype && ranksOf(r).includes(rank));
  let pool = exact;
  if (!pool.length) {
    // Same role, nearest rank. A D-rank skeleton rogue in the Warren reads
    // correctly; a blob standing in for a caster does not.
    const byArch = usable.filter((r) => r.archetype === archetype);
    if (byArch.length) {
      let best = 99;
      for (const r of byArch) best = Math.min(best, rankDistance(r, rank));
      pool = byArch.filter((r) => rankDistance(r, rank) === best);
    }
  }
  if (!pool.length) pool = usable.filter((r) => ranksOf(r).includes(rank));
  if (!pool.length) pool = usable;

  const sorted = pool.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
  // entities.js seeds spawns `<archetype>:<variant>`, with variant cycling
  // 0..3. Indexing by that variant rather than by a hash draw is what
  // guarantees the pool is actually walked: a pool of two and four hash draws
  // produced four identical skeletons at B rank, which is not variety, it is a
  // coin that came up heads four times.
  const variant = String(seed).match(/:(\d+)$/);
  const spread = RANKS.indexOf(rank) + 1;
  const rec = variant
    ? sorted[(Number(variant[1]) * spread) % sorted.length]
    : pick(mulberry32(hashSeed(seed)), sorted);
  if (!rec) return null;
  return { key: rec.key, creature: rec, archetype, rank, role: rec.role, look: rec.look };
}

// ----------------------------------------------------------------- sockets

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * A socket under `bone` whose axes are the CREATURE's, offset so that a child
 * placed at the weapons.js hand offset lands on the fist.
 *
 * Identical construction to characters.makeSocket and for the same reason:
 * weapons.js authors every grip against the procedural rig, where the hand sits
 * at local y = -0.72. `scale` counter-scales the creature normalisation back
 * out so a weapon authored at rig scale comes out the size it was authored.
 */
function makeSocket(bone, { lift = 0, scale = 1 } = {}) {
  const s = new THREE.Object3D();
  s.name = `${bone.name}_socket`;
  bone.getWorldQuaternion(_q);
  s.quaternion.copy(_q).invert();
  s.scale.setScalar(scale);
  _v.set(0, 1, 0).applyQuaternion(s.quaternion).multiplyScalar(lift * scale);
  s.position.copy(_v);
  bone.add(s);
  return s;
}

/**
 * Find a bone by any of several names, case-insensitively. Quaternius
 * capitalises (Middle1_R) and KayKit does not (handslot_r), and both are
 * prefixed with the creature key by the builder.
 */
function findBone(root, key, names) {
  // PREFERENCE ORDER, NOT TRAVERSAL ORDER. One pass that accepts whichever
  // candidate the traversal reaches first is wrong every time the preferred
  // bone is DEEPER than a fallback: `Neck` is the parent of `Head`, so the eye
  // mote landed on the neck of every Quaternius creature, and `hand_r` is the
  // parent of `handslot_r`, which would have hung every KayKit weapon off the
  // wrist. Both were measured before this loop was turned the right way round.
  for (const n of names) {
    const want = lower(`${key}_${n}`);
    let found = null;
    root.traverse((o) => { if (!found && o.isBone && lower(o.name) === want) found = o; });
    if (found) return found;
  }
  return null;
}

let _eyeGeo = null;
function eyeGeometry() {
  if (_eyeGeo) return _eyeGeo;
  const a = new THREE.BoxGeometry(0.055, 0.03, 0.02); a.translate(-0.048, 0, 0);
  const b = new THREE.BoxGeometry(0.055, 0.03, 0.02); b.translate(0.048, 0, 0);
  const merged = mergeGeometries([a, b], false);
  if (merged) { a.dispose(); b.dispose(); _eyeGeo = merged; } else { b.dispose(); _eyeGeo = a; }
  _eyeGeo.userData.shared = true;
  return _eyeGeo;
}

const _matCache = new Map();
function eyeMaterial(glow) {
  const key = `eye:${glow}`;
  let m = _matCache.get(key);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({ color: glow, toneMapped: false });
  m.userData.shared = true;
  _matCache.set(key, m);
  return m;
}

// ------------------------------------------------------------- instances

class CreatureInstance {
  constructor(root, meshes, mixer, cast, template) {
    this.root = root;
    this.meshes = meshes;
    /** The representative mesh, for callers that expect exactly one. */
    this.mesh = meshes[0] || null;
    this.mixer = mixer;
    this.template = template;
    this.appearance = cast;
    this.creature = cast.key;
    this.skeleton = this.mesh?.skeleton || null;
    this.sockets = {};
    this.runSpeed = RUN_SPEED;
    /**
     * What entities.js should do about a weapon: 'native' and 'kit' are already
     * handled here, 'none' means claws, anything else is a kind key for
     * weapons.buildHeldWeapon.
     */
    this.weaponSlot = 'none';
    this.isCreature = true;

    this._prefix = `${cast.key}__`;
    this._actions = new Map();
    this._cur = null;
    this._state = null;
    this._dead = false;
    this._hurtT = 0;
    this._armed = false;
    this._lastNow = -1;
    this._owned = [];          // per-instance materials/geometry to free
    _live.add(this);
    _liveInstances++;
  }

  _clip(state) {
    const names = CLIP_FOR[state] || CLIP_FOR.idle;
    for (const n of names) {
      const c = _clips.get(this._prefix + n);
      if (c) return c;
    }
    return null;
  }

  _action(state) {
    if (this._actions.has(state)) return this._actions.get(state);
    const clip = this._clip(state);
    const a = clip ? this.mixer.clipAction(clip) : null;
    this._actions.set(state, a);
    return a;
  }

  /** Duration of the clip backing a state, in seconds (0 when absent). */
  clipDuration(state) {
    const c = this._clip(state);
    return c ? c.duration : 0;
  }

  /** Crossfade into a state. Signature matches CharacterInstance.play. */
  play(state, { fade = 0.15, once = false, clamp = false, timeScale = 1 } = {}) {
    if (this._dead && state !== 'die') return false;
    const next = this._action(state);
    if (!next) return false;
    if (state === 'die') this._dead = true;
    if (next === this._cur) { this._state = state; return true; }

    next.reset();
    next.enabled = true;
    next.paused = false;
    next.setEffectiveTimeScale(timeScale);
    next.setEffectiveWeight(1);
    next.clampWhenFinished = clamp;
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.play();

    if (this._cur && fade > 0) {
      this._cur.paused = false;       // a paused action never finishes fading out
      next.crossFadeFrom(this._cur, fade, false);
    } else if (this._cur) {
      this._cur.stop();
    }
    this._cur = next;
    this._state = state;
    return true;
  }

  get state() { return this._state; }
  get dead() { return this._dead; }

  update(dt) {
    this.mixer.update(Math.min(0.05, Math.max(0, dt)));
  }

  _wallDt() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (this._lastNow < 0) { this._lastNow = now; return 1 / 60; }
    const d = now - this._lastNow;
    this._lastNow = now;
    return Math.min(0.05, Math.max(0, d));
  }

  /** The animateRig bridge — identical option bag to CharacterInstance.animate. */
  animate({ moving = false, speed = 0, attackPhase = 0, hurt = 0, airborne = false, dt = null } = {}) {
    const d = dt == null ? this._wallDt() : Math.min(0.05, Math.max(0, dt));

    if (this._dead) { this.mixer.update(d); return; }

    if (attackPhase > 0) {
      this.play('attack', { fade: 0.06 });
      const a = this._cur;
      if (a) {
        // Drive the swing off the game's own timer rather than guessing a
        // timeScale, so the contact frame cannot drift off the hitbox.
        a.paused = true;
        const dur = a.getClip().duration;
        a.time = Math.min(dur, Math.max(0, (1 - Math.min(1, attackPhase)) * dur));
      }
      this._hurtT = 0;
    } else {
      if (this._cur && this._cur.paused) this._cur.paused = false;
      if (this._hurtT > 0) {
        this._hurtT -= d;
      } else if (hurt > 0 && this._state !== 'hurt') {
        this.play('hurt', { fade: 0.05, once: true });
        this._hurtT = Math.max(0.2, this.clipDuration('hurt')) * 0.8;
      } else if (airborne) {
        this.play('jump', { fade: 0.12 });
      } else if (moving) {
        this.play(speed > this.runSpeed ? 'run' : 'walk', { fade: 0.14 });
      } else {
        this.play('idle', { fade: 0.2 });
      }
    }

    this.mixer.update(d);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    _live.delete(this);
    _liveInstances = Math.max(0, _liveInstances - 1);
    try {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.root);
    } catch { /* a mixer with no root is already gone */ }
    this._actions.clear();
    this._cur = null;
    // Every instance owns a private Skeleton, and a Skeleton owns a GPU
    // boneTexture nothing else will free. Skipping this leaks one texture per
    // monster per gate — invisible in geometry counts, fatal under Android's
    // per-app memory limiter over a long session.
    try { this.skeleton?.dispose(); } catch { /* older three: no dispose */ }
    for (const r of this._owned) { try { r.dispose(); } catch { /* already gone */ } }
    this._owned.length = 0;
  }
}

/**
 * Attach the KayKit props a skeleton is authored to carry. These live in this
 * same GLB and socket to the `handslot_r` / `handslot_l` / `spine` bones the
 * pack ships for exactly this purpose, so a skeleton warrior comes out holding
 * the axe and shield it was modelled with — not a procedural plank.
 */
function attachKit(inst3d, key, spec) {
  const out = [];
  for (const name of spec.split(',')) {
    const propKey = lower(name.trim());
    const src = _props.get(propKey);
    const meta = _manifest?.props?.[propKey];
    if (!src || !meta) continue;
    const boneName = meta.attachNodeFor?.[key] || `${key}_${meta.attach}`;
    let bone = null;
    inst3d.traverse((o) => { if (!bone && o.isBone && o.name === boneName) bone = o; });
    if (!bone) continue;
    // Plain (non-skinned) props: a straight clone shares geometry and material
    // with the source, both of which are flagged shared at load.
    const prop = src.clone(true);
    prop.traverse((o) => { if (o.isMesh) o.castShadow = _quality.castShadow; });
    bone.add(prop);
    out.push(prop);
  }
  return out;
}

/**
 * Build one monster.
 *
 * @param {object} opts
 * @param {string|number} opts.seed   selection seed
 * @param {string} opts.archetype     grunt|stalker|brute|caster|lancer|howler|boss
 * @param {string} opts.rank          'E'..'S'
 * @param {string} [opts.boss]        boss key from config.js BOSSES
 * @param {number} opts.scale         game-space scale (1 == the procedural humanoid)
 * @param {number} opts.glow          telegraph-mote colour
 * @param {boolean} opts.eyes         emissive telegraph mote (default true)
 * @returns {CreatureInstance|null}   null when the pack is absent or over budget
 */
export function makeCreature({
  seed = 0,
  archetype = 'grunt',
  rank = 'E',
  boss = null,
  scale = 1,
  glow = 0xffffff,
  eyes = true,
  ignoreBudget = false,
} = {}) {
  if (!_loaded) return null;
  if (!ignoreBudget && _liveInstances >= _quality.budget) return null;

  const cast = creatureFor(seed, { archetype, rank, boss });
  if (!cast) return null;
  const tpl = _templates.get(cast.key);
  if (!tpl) return null;

  const inst3d = skeletonClone(tpl.template);
  const meshes = [];
  inst3d.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  if (!meshes.length) return null;

  // SkeletonUtils.clone hands every SkinnedMesh its OWN Skeleton, which for a
  // two-material creature means two bone textures uploaded per frame for one
  // monster. They share bones, so collapse them onto one — and that single
  // Skeleton is still private to this instance, which is the part that matters.
  const skeleton = meshes[0].skeleton;
  for (let i = 1; i < meshes.length; i++) {
    const spare = meshes[i].skeleton;
    meshes[i].bind(skeleton, meshes[i].bindMatrix);
    if (spare && spare !== skeleton) { try { spare.dispose(); } catch { /* nothing uploaded yet */ } }
  }
  for (const m of meshes) {
    m.castShadow = _quality.castShadow;
    m.receiveShadow = false;
    m.frustumCulled = true;
  }

  const norm = tpl.scale;
  const root = new THREE.Group();
  root.name = `creature_${cast.key}`;
  root.add(inst3d);
  root.scale.setScalar(scale * norm);
  // Flying rigs have no contact pose and no walk clip. Hover is authored in
  // world metres and rides the caller's scale, so a brute-scaled dragon floats
  // proportionally higher rather than clipping the floor.
  if (cast.look.hover) root.position.y = cast.look.hover * scale;

  const mixer = new THREE.AnimationMixer(inst3d);
  const inst = new CreatureInstance(root, meshes, mixer, cast, tpl);

  // sockets
  inst3d.updateMatrixWorld(true);
  const hand = { lift: 0.72, scale: 1 / norm };
  // KayKit ships explicit hand slots. Quaternius rigs stop at the finger roots,
  // and Middle1_R sits in the palm — LowerArm_R would hang a weapon off the
  // elbow.
  const boneR = findBone(inst3d, cast.key, ['handslot_r', 'Middle1_R', 'hand_r', 'LowerArm_R']);
  const boneL = findBone(inst3d, cast.key, ['handslot_l', 'Middle1_L', 'hand_l', 'LowerArm_L']);
  const boneHead = findBone(inst3d, cast.key, ['Head', 'head', 'Head2', 'Neck']);
  if (boneR) inst.sockets.hand = makeSocket(boneR, hand);
  if (boneL) inst.sockets.handL = makeSocket(boneL, hand);
  if (boneHead) inst.sockets.head = makeSocket(boneHead, { lift: 0, scale: 1 / norm });

  // weapon
  const want = cast.look.weapon;
  if (typeof want === 'string' && want.startsWith('kit:')) {
    const props = attachKit(inst3d, cast.key, want.slice(4));
    inst.weaponSlot = props.length ? 'kit' : 'none';
  } else if (want === 'native') {
    // The creature's own weapon mesh is skinned to its own skeleton and merged
    // into the body draw call. Nothing to attach and nothing to pay.
    inst.weaponSlot = 'native';
  } else if (typeof want === 'string' && inst.sockets.hand) {
    inst.weaponSlot = want;
  } else {
    inst.weaponSlot = 'none';
  }

  if (eyes && inst.sockets.head && cast.look.eye) {
    // The telegraph mote, on an ANCHOR rather than positioned directly.
    // game.js flares it by writing rig.eyeL.scale, which would stomp any scale
    // set on the mote itself — and it needs one: a creature has a real face, so
    // the mote at full size reads as a glowing halo stuck to its head, which is
    // exactly the "glowing different things" the owner asked us to stop doing.
    // At 0.55 it is barely there at rest and still doubles into a clear tell
    // when game.js pushes it to 1.7-2.2.
    const anchor = new THREE.Object3D();
    anchor.name = 'eyeAnchor';
    anchor.position.set(0, cast.look.eye.y, cast.look.eye.z);
    anchor.scale.setScalar(0.55);
    inst.sockets.head.add(anchor);
    const eye = new THREE.Mesh(eyeGeometry(), eyeMaterial(glow));
    eye.layers.enable(GLOW_LAYER);
    eye.frustumCulled = false;
    anchor.add(eye);
    inst.eyes = eye;
  }

  root.userData.creature = inst;
  root.userData.appearance = cast;
  inst.play('idle', { fade: 0 });
  return inst;
}

// ------------------------------------------------------------------ stats

export function creatureStats() {
  return {
    loaded: _loaded,
    creatures: _recs.size,
    templates: _templates.size,
    props: _props.size,
    clips: _clips.size,
    instances: _liveInstances,
    budget: _quality.budget,
    tier: _quality.tier,
    mergeFailures: _mergeFailures,
    /** Draw calls per creature, by key, after the per-material merge. */
    drawCalls: Object.fromEntries(Array.from(_templates.entries()).map(([k, t]) => [k, t.drawCalls])),
  };
}

/** Teardown. Only meaningful on GL context loss or a test reset. */
export function disposeCreatureModels() {
  for (const inst of Array.from(_live)) inst.dispose();
  for (const t of _templates.values()) {
    t.template.traverse((o) => {
      if (o.isMesh && o.geometry?.userData?.owned) o.geometry.dispose();
    });
  }
  _templates.clear();
  for (const m of _matCache.values()) m.dispose();
  _matCache.clear();
  if (_scene) {
    _scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
    });
  }
  if (_eyeGeo) { _eyeGeo.dispose(); _eyeGeo = null; }
  _scene = null;
  _manifest = null;
  _clips = new Map();
  _recs.clear();
  _props.clear();
  _loaded = false;
  _loading = null;
  _liveInstances = 0;
  _mergeFailures = 0;
}
