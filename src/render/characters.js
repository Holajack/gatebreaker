import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyRim } from './rim.js';
import { GLOW_LAYER } from './glow.js';
import { Quality, TIERS } from '../core/quality.js';
import { load as loadSave } from '../core/save.js';

// Real skinned characters, from the two CC0 Quaternius modular packs merged
// into public/models/characters.glb by tools/build-characters-glb.mjs.
//
// This module replaces the hand-posed box-man in entities.js. It owns four
// things and nothing else: loading the GLB, deciding what a character LOOKS
// like from a seed, instantiating one cheaply, and driving its AnimationMixer.
//
// -------------------------------------------------------------- five facts
// about the asset, all measured (tools/character-test.mjs re-asserts them):
//
// 1. TWO RIGS, NOT ONE. The men's and women's packs have identical bone NAMES
//    but different rest transforms and different inverse bind matrices, and
//    every clip bakes absolute local bone translations. Playing `male_Walk` on
//    a female skeleton stretches her. Bones are therefore prefixed m_/f_ and
//    clips male_/female_, and nothing here ever crosses that line.
// 2. THE SOURCE MESHES ARE QUANTIZED AND THE NODE TRANSFORM IS A LIE. Each
//    primitive's positions are Uint16 in a ~7930x space; the dequantisation
//    lives in the node matrix AND in the inverse bind matrices. three.js
//    cancels the node matrix out again because SkinnedMesh.bindMode is
//    'attached' (bindMatrixInverse := matrixWorld.invert() every frame). Net
//    effect: the mesh node's own transform is irrelevant, the effective local
//    space is metres, and geometry from any two primitives of the same rig is
//    directly mergeable. That is what makes fact 3 possible.
// 3. ONE CHARACTER IS 9-17 PRIMITIVES BECAUSE QUATERNIUS SPLITS BY MATERIAL,
//    and all 48 materials are identical apart from baseColorFactor (verified:
//    one distinct combination of metalness/roughness/side/transparency across
//    the whole file). So every primitive's flat colour is baked into a Uint8
//    vertex-colour attribute and the lot is merged into ONE SkinnedMesh
//    sharing ONE material. 12.6 draw calls per character becomes 1.
// 4. PARTS ARE SWAPPABLE WITHIN A PACK. head/body/legs/feet from any character
//    on the same rig skin correctly against the same skeleton, which is the
//    whole variety mechanism: 11 male x 4 slots is ~14k silhouettes.
// 5. NOTHING HERE MAY THROW. The game is fully offline; a missing GLB has to
//    degrade to the procedural rig in entities.js, not crash the boot.

// --------------------------------------------------------------- constants

/** Height of the procedural humanoid in entities.js, top of head at scale 1. */
export const PROCEDURAL_HEIGHT = 2.14;
/** Mean authored height of the pack. Characters run 1.79-2.01 units. */
const PACK_HEIGHT = 1.85;
/**
 * Everything in the game — camera framing, health-bar heights (2.4 * scale),
 * ring radii, the item pack's 0.4x weapon scale — is tuned against the
 * procedural rig. Characters are normalised onto it rather than the other way
 * round, and the residual per-character spread becomes free height variety.
 */
export const MODEL_SCALE = PROCEDURAL_HEIGHT / PACK_HEIGHT;

/** Universal slots. backpack/pistol exist on 3 characters and are not mixed. */
const SLOTS = ['head', 'body', 'legs', 'feet'];

/** Logical states, mapped to pack clips by CLIP_FOR. */
export const CHARACTER_STATES = [
  'idle', 'walk', 'run', 'attack', 'hurt', 'die', 'cast', 'jump', 'roll', 'wave', 'interact',
];

// The pack ships 24 clips per rig. Each state lists its preference order so a
// clip rename upstream degrades to a worse animation rather than to nothing.
const CLIP_FOR = {
  idle: ['Idle', 'Idle_Neutral', 'Idle_Sword'],
  walk: ['Walk', 'Run'],
  run: ['Run', 'Walk'],
  attack: ['Sword_Slash', 'Punch_Right', 'Kick_Right'],
  // The unarmed 3-step combo. Each state lists the mirrored clip second so a
  // pack shipped with one side still alternates rather than failing to attack.
  punch_r: ['Punch_Right', 'Punch_Left', 'Sword_Slash'],
  punch_l: ['Punch_Left', 'Punch_Right', 'Sword_Slash'],
  kick: ['Kick_Right', 'Kick_Left', 'Punch_Right'],
  hurt: ['HitRecieve', 'HitRecieve_2'],       // upstream spelling, preserved
  die: ['Death', 'HitRecieve'],
  cast: ['Idle_Gun_Pointing', 'Gun_Shoot', 'Idle_Gun'],
  jump: ['Roll', 'Run'],                       // the pack has no jump clip
  roll: ['Roll', 'Run'],
  wave: ['Wave', 'Idle'],
  interact: ['Interact', 'Idle'],
};

/** Above this ground speed a character runs instead of walking. */
const RUN_SPEED = 5.0;

// Where inside each attack clip the blow actually LANDS, as a fraction of the
// clip's duration. Measured by scrubbing the pack clips frame by frame in the
// harness (tools/character-test.mjs 'contact' screenshots): the sword crosses
// centreline at ~45% of Sword_Slash, the fists connect at ~40% of the punches,
// the kick a touch later. animate() warps the game's swing timer around these
// points so the visual impact lands ON the frame game.js applies the damage —
// which is the difference between "swinging down in a motion" and a pose that
// happens to deal damage.
const CLIP_CONTACT = { attack: 0.45, punch_r: 0.40, punch_l: 0.40, kick: 0.48 };

// The unarmed chain, in combo order. Alternating clips is what stops a mashed
// attack button restarting the same pose at frame 0 every press.
const UNARMED_CHAIN = ['punch_r', 'punch_l', 'kick'];

// The slice of the Roll clip a dash scrubs through. The full clip is 1.3 s of
// crouch, tumble and stand-up; a 0.26 s dash only has room for the tumble, so
// the entry crouch and the final straighten are cut rather than played at 5x.
const ROLL_IN = 0.12;
const ROLL_OUT = 0.78;

// ------------------------------------------------------------ module state

let _loaded = false;
let _loading = null;
let _scene = null;
let _manifest = null;
let _clips = new Map();          // clip name -> AnimationClip
const _rigs = new Map();         // 'male' | 'female' -> RigTemplate
const _chars = new Map();        // lowercase key -> manifest character record

let _mergeFailures = 0;
let _liveInstances = 0;

// --------------------------------------------------------------- quality
//
// Skinned characters are the most expensive thing this game draws: a 62-bone
// skeleton costs a bone-matrix pass and a bone-texture upload per instance per
// frame, and that cost is CPU-side, so it does not shrink when the tier drops
// the resolution. The tier therefore caps how many characters may be
// GLB-backed at once; entities.js falls back to the procedural rig past the
// cap rather than dropping the frame rate for everyone.

// Measured: one merged character is ~8.9k triangles and ~0.02 ms of CPU per
// frame (tools/character-test.mjs, desktop GPU, 21-character crowd: 82 draw
// calls and 1.4 ms of game.update against 298 calls and 1.0 ms for the
// procedural rig). Triangles, not draw calls, are what caps this on a phone —
// 20 characters is already 178k triangles before the world is drawn.
const BUDGET = { low: 8, medium: 14, high: 20, ultra: 26 };

let _quality = {
  tier: 'medium',
  budget: BUDGET.medium,
  castShadow: true,
};

// Guess once at import so the module is sane with no wiring at all; game.js
// can call setCharacterQuality from _applyQuality to keep it honest.
try {
  const guess = Quality.guessStartTier();
  _quality = {
    tier: guess,
    budget: BUDGET[guess] ?? BUDGET.medium,
    castShadow: TIERS[guess]?.shadows !== false,
  };
} catch { /* headless: keep the medium default */ }

/** Point the character budget at a quality tier object (or its name). */
export function setCharacterQuality(tier) {
  const name = typeof tier === 'string' ? tier : tier?.name;
  if (!name || !BUDGET[name]) return;
  _quality = {
    tier: name,
    budget: BUDGET[name],
    castShadow: (typeof tier === 'object' ? tier.shadows : TIERS[name]?.shadows) !== false,
  };
  // Existing instances follow the shadow decision immediately; the budget only
  // applies to the next thing spawned, because yanking a mesh out from under a
  // live enemy mid-run is worse than one frame over budget.
  for (const inst of _live) if (inst.mesh) inst.mesh.castShadow = _quality.castShadow;
}

/** True when another GLB-backed character fits inside the tier's budget. */
export function characterBudgetAvailable() {
  return _loaded && _liveInstances < _quality.budget;
}

const _live = new Set();

// ------------------------------------------------------------------ seeds

/** FNV-1a over a string, so an appearance seed can be any label. */
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

/** The same PRNG the world generators use, so seeds behave identically. */
function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

// ------------------------------------------------------------- appearance
//
// The point of this table: enemies stop being the same body in six colours.
// Each archetype gets a pool of base characters that reads as its role, and a
// `mix` probability that decides how aggressively head/legs/feet are stolen
// from other characters on the same rig. High mix = a crowd that looks like a
// crowd; low mix = a boss that looks deliberate.

const LOOKS = {
  // The player's base is a PAIR, indexed by save.playerBody: the two adventurer
  // outfits are the same silhouette on the two rigs, so switching body swaps
  // the female_* clip set for free (clips ride on the rig, fact 1). This entry
  // is the ONLY place the choice lives — appearanceFor resolves it here rather
  // than callers branching on gender anywhere else.
  player: { base: ['men_adventurer'], baseFemale: ['women_adventurer'], mix: 0, tint: 0.0 },
  grunt: {
    base: ['men_casual_2', 'men_casual_hoodie', 'men_beach', 'men_worker', 'men_farmer',
      'women_casual', 'women_worker'],
    mix: 0.8, tint: 0.30,
  },
  stalker: {
    base: ['men_punk', 'women_punk', 'women_scifi', 'men_swat', 'women_soldier'],
    mix: 0.75, tint: 0.34,
  },
  brute: {
    base: ['men_worker', 'men_spacesuit', 'men_swat', 'women_soldier', 'men_king'],
    mix: 0.55, tint: 0.34,
  },
  caster: {
    base: ['women_witch', 'men_king', 'women_formal', 'men_suit', 'women_suit'],
    mix: 0.45, tint: 0.38,
  },
  lancer: {
    base: ['women_medieval', 'women_soldier', 'men_swat', 'men_adventurer'],
    mix: 0.6, tint: 0.34,
  },
  howler: {
    base: ['women_witch', 'men_punk', 'women_punk', 'women_scifi'],
    mix: 0.85, tint: 0.38,
  },
  boss: {
    base: ['men_king', 'men_spacesuit', 'women_witch', 'women_medieval', 'women_scifi'],
    mix: 0.3, tint: 0.42,
  },
  // Shadows are deliberately UNIFORM in material and VARIED in silhouette:
  // the ghost material ignores vertex colour entirely, so all you read is the
  // outline, and the outline is different every time.
  shadow: { base: null, mix: 0.95, tint: 0 },
};

/** Rank rotates each pool so an S-rank grunt is not the same man as an E one. */
const RANK_OFFSET = { E: 0, D: 1, C: 2, B: 3, A: 4, S: 5 };

// ------------------------------------------------------------- player body
//
// save.playerBody is the identity screen's choice. It is read lazily from the
// save rather than plumbed through game.js, because the player can be built
// (and rebuilt by the pack-upgrade path) from several call sites and every one
// of them must agree without carrying the value around.
let _playerBody = null;

/** Override the hunter's body ('male' | 'female'). Anything else = male. */
export function setPlayerBody(body) {
  _playerBody = body === 'female' ? 'female' : 'male';
}

function playerBody() {
  if (_playerBody) return _playerBody;
  try {
    _playerBody = loadSave()?.playerBody === 'female' ? 'female' : 'male';
  } catch {
    _playerBody = 'male';     // headless / storage-denied: the schema default
  }
  return _playerBody;
}

/**
 * Deterministic appearance from a seed.
 *
 * @param {string|number} seed   anything stable — 'grunt:7', a spawn index, an rng draw
 * @param {object} opts
 * @param {string} opts.archetype  key into LOOKS; unknown falls back to 'grunt'
 * @param {string} opts.rank       'E'..'S', rotates the base pool
 * @returns {{key,rig,base,parts,archetype,rank,tint}|null}
 */
export function appearanceFor(seed, { archetype = 'grunt', rank = 'E' } = {}) {
  if (!_loaded) return null;
  const look = LOOKS[archetype] || LOOKS.grunt;
  const rnd = mulberry32(hashSeed(seed));

  // base character
  const basePool = (look.baseFemale && playerBody() === 'female') ? look.baseFemale : look.base;
  const pool = (basePool || Array.from(_chars.keys())).filter((k) => _chars.has(k));
  if (!pool.length) return null;
  const off = RANK_OFFSET[rank] || 0;
  const base = pool[(Math.floor(rnd() * pool.length) + off) % pool.length];
  const rec = _chars.get(base);
  const rig = rec.rig;

  // Part donors must share the rig, or the skin binds against the wrong
  // skeleton and the character tears apart.
  const donors = Array.from(_chars.values()).filter((c) => c.rig === rig);
  const parts = {};
  for (const slot of SLOTS) {
    let src = rec;
    // The body is swapped half as often as the extremities: swapping it is
    // what turns "a person in different trousers" into "a chimera".
    const p = slot === 'body' ? look.mix * 0.45 : look.mix;
    if (p > 0 && rnd() < p) {
      const d = pick(rnd, donors);
      if (d && d.parts[slot]) src = d;
    }
    parts[slot] = (src.parts[slot] || rec.parts[slot]) ?? null;
  }

  return {
    key: `${rig}|${parts.head}|${parts.body}|${parts.legs}|${parts.feet}`,
    rig, base, parts, archetype, rank, tint: look.tint,
  };
}

/**
 * Build and cache one appearance's merged geometry WITHOUT holding a reference,
 * so it stays evictable. Callers use this to allocate a whole archetype's set of
 * looks in one go instead of dribbling one new geometry into the cache per
 * spawn — which reads as an unbounded geometry leak to any lifecycle test, and
 * is indistinguishable from one until you have watched it for ten gates.
 */
export function warmAppearance(seed, opts) {
  if (!_loaded) return false;
  const a = appearanceFor(seed, opts);
  if (!a) return false;
  const g = mergedGeometryFor(a);
  if (g) releaseGeometry(a.key);
  return Boolean(g);
}

// ---------------------------------------------------------------- loading

function lower(s) { return String(s || '').toLowerCase(); }

/**
 * Load characters.glb + characters.json.
 *
 * Resolves TRUE on success and FALSE on ANY failure. Never throws, never
 * rejects: entities.makeHumanoid keeps its procedural path for exactly this
 * case, and an APK shipped with public/models/ deleted must still boot.
 */
export async function loadCharacterModels(
  url = 'models/characters.glb',
  manifestUrl = 'models/characters.json',
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
    if (!manifest?.rigs || !manifest?.characters) return false;

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
  for (const c of gltf.animations || []) _clips.set(c.name, c);

  _chars.clear();
  for (const [k, rec] of Object.entries(manifest.characters)) {
    // Android is case-sensitive and macOS is not; every key is lowercased on
    // both sides so a capitalisation slip cannot ship as a device-only bug.
    _chars.set(lower(k), { ...rec, key: lower(k) });
  }

  _rigs.clear();
  for (const [rigKey, rig] of Object.entries(manifest.rigs)) {
    const template = buildRigTemplate(rigKey, rig);
    if (template) _rigs.set(rigKey, template);
  }

  _loaded = _rigs.size > 0 && _chars.size > 0;
  return _loaded;
}

/**
 * One reusable bone tree + dummy SkinnedMesh per rig.
 *
 * Cloning the shipped rig root would clone all 11 characters hanging off it and
 * then throw 10 of them away. This template is 62 bones and one placeholder
 * mesh, so SkeletonUtils.clone has almost nothing to copy — and it is
 * SkeletonUtils.clone, not Object3D.clone, because the latter leaves every
 * instance pointing at the SOURCE skeleton and they all animate as one.
 */
function buildRigTemplate(rigKey, rig) {
  const rigRoot = _scene.getObjectByName(rig.node);
  if (!rigRoot) return null;

  const boneRoot = rigRoot.children.find((c) => c.isBone && c.name === rig.skeletonRoot)
    || rigRoot.children.find((c) => c.isBone);
  if (!boneRoot) return null;

  // Any skinned mesh under this rig carries the skeleton we need to copy.
  let srcSkinned = null;
  rigRoot.traverse((o) => { if (!srcSkinned && o.isSkinnedMesh) srcSkinned = o; });
  if (!srcSkinned) return null;

  const template = new THREE.Group();
  template.name = `template_${rigKey}`;
  const bones = boneRoot.clone(true);
  template.add(bones);

  const byName = new Map();
  bones.traverse((o) => { if (o.isBone) byName.set(o.name, o); });
  const ordered = srcSkinned.skeleton.bones.map((b) => byName.get(b.name)).filter(Boolean);
  if (ordered.length !== srcSkinned.skeleton.bones.length) return null;

  const skin = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  skin.name = 'skin';
  template.add(skin);
  // Identity bind matrix: see fact 2 at the top of this file. The source binds
  // this way too, and 'attached' bind mode cancels the node transform anyway.
  skin.bind(new THREE.Skeleton(ordered, srcSkinned.skeleton.boneInverses), new THREE.Matrix4());

  // Rest-pose orientation of the sockets, captured once, so a weapon can be
  // parented to a wrist bone and still come out axis-aligned to the character.
  template.updateMatrixWorld(true);

  return {
    key: rigKey,
    node: rig.node,
    bonePrefix: rig.bonePrefix,
    clipPrefix: rig.clipPrefix,
    template,
    boneCount: ordered.length,
  };
}

export function charactersReady() { return _loaded; }
export function characterManifest() { return _manifest; }
export function characterKeys() { return Array.from(_chars.keys()).sort(); }
export function characterRecord(key) { return _chars.get(lower(key)) || null; }

// ------------------------------------------------------- geometry merging

const _col = new THREE.Color();

/**
 * Bake a primitive's flat material colour into a Uint8 vertex-colour
 * attribute, once, in place. Colours out of GLTFLoader are already in the
 * renderer's working (linear) space and vertex colours are consumed there
 * unconverted, so this is a straight copy.
 */
function ensureColorAttribute(mesh) {
  const g = mesh.geometry;
  if (g.attributes.color) return g;
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  _col.copy(mat?.color || new THREE.Color(0xffffff));
  const n = g.attributes.position.count;
  const a = new Uint8Array(n * 3);
  const r = Math.round(Math.min(1, Math.max(0, _col.r)) * 255);
  const gg = Math.round(Math.min(1, Math.max(0, _col.g)) * 255);
  const b = Math.round(Math.min(1, Math.max(0, _col.b)) * 255);
  for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = gg; a[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3, true));
  return g;
}

// appearance.key -> { geometry, refs, order }
const _geoCache = new Map();
// 40 entries at ~165 KB of merged vertex/index data each is ~6.5 MB resident.
// entities.js caps itself at 31 distinct appearances so this never evicts in
// practice; the ceiling exists so a caller passing its own seeds cannot grow
// the cache without bound.
const GEO_CACHE_MAX = 40;
let _geoOrder = 0;

function partMeshes(nodeName) {
  const node = nodeName && _scene.getObjectByName(nodeName);
  if (!node) return [];
  const out = [];
  node.traverse((o) => { if (o.isSkinnedMesh) out.push(o); });
  return out;
}

function mergedGeometryFor(appearance) {
  const hit = _geoCache.get(appearance.key);
  if (hit) { hit.refs++; hit.order = _geoOrder++; return hit.geometry; }

  const sources = [];
  for (const slot of SLOTS) {
    for (const m of partMeshes(appearance.parts[slot])) sources.push(ensureColorAttribute(m));
  }
  if (!sources.length) return null;

  let geometry = null;
  try {
    geometry = mergeGeometries(sources, false);
  } catch {
    geometry = null;
  }
  if (!geometry) {
    // mergeGeometries returns null on any attribute-layout disagreement. That
    // is survivable — the caller falls back to one mesh per primitive — but it
    // is the difference between 1 and ~12 draw calls, so it is counted and the
    // test asserts it stays at zero.
    _mergeFailures++;
    return null;
  }

  // The effective local space of an 'attached' SkinnedMesh is metres (fact 2),
  // but the geometry's own positions are quantised, so a computed bounding
  // sphere would be ~7900 units across and nothing would ever cull. Publish
  // the real one instead: a character is under 2.4 m tall and animation never
  // takes a limb more than ~1.5 m from the hips.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 1.8);
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-1.2, -0.4, -1.2), new THREE.Vector3(1.2, 2.4, 1.2),
  );
  // entities.disposeObject3D frees anything it reaches that is not flagged;
  // this geometry is shared by every enemy with the same appearance.
  geometry.userData.shared = true;

  const entry = { geometry, refs: 1, order: _geoOrder++ };
  _geoCache.set(appearance.key, entry);
  evictGeometries();
  return geometry;
}

function releaseGeometry(key) {
  const entry = _geoCache.get(key);
  if (entry) entry.refs = Math.max(0, entry.refs - 1);
}

function evictGeometries() {
  if (_geoCache.size <= GEO_CACHE_MAX) return;
  const dead = Array.from(_geoCache.entries())
    .filter(([, e]) => e.refs <= 0)
    .sort((a, b) => a[1].order - b[1].order);
  for (const [k, e] of dead) {
    if (_geoCache.size <= GEO_CACHE_MAX) break;
    e.geometry.dispose();
    _geoCache.delete(k);
  }
}

// -------------------------------------------------------------- materials

const _matCache = new Map();

function bodyMaterial(glow, tintHex, tintAmount, hero = false) {
  // `hero` is part of the key ON PURPOSE: the plain entry is shared by
  // civilians and by every fallback-humanoid enemy, and mutating that one
  // material to lift the player would lift the whole crowd with him — which
  // is the exact "everyone is equally bright" problem this flag exists to fix.
  const key = `body:${glow}:${tintHex}:${tintAmount.toFixed(2)}${hero ? ':hero' : ''}`;
  let m = _matCache.get(key);
  if (m) return m;
  // material.color multiplies the baked vertex colour, so a light pull toward
  // the archetype's colour keeps type readability without repainting the
  // character. 1.0 would erase the pack's palette; 0 would erase the enemy's.
  const c = new THREE.Color(0xffffff).lerp(new THREE.Color(tintHex), tintAmount);
  m = applyRim(new THREE.MeshStandardMaterial({
    color: c,
    vertexColors: true,
    roughness: 0.62,
    // Non-zero metalness is what makes scene.environment visible at all.
    metalness: 0.16,
    // The hero gets a touch more of the environment, NOT a rim and NOT
    // emissive (both banned on living characters): with the creature albedo
    // rebalance and the warm hero light in entities.js this is what keeps the
    // player the brightest humanoid in a fight without glowing.
    envMapIntensity: hero ? 1.2 : 1.0,
    // Authored as doubleSided by Quaternius. Left alone deliberately: the
    // packs' normals were not verified and single-siding an unverified
    // low-poly mesh trades fill rate for holes you only see on a phone.
    side: THREE.DoubleSide,
    // Explicit opt-OUT. A living character is a normal person and gets normal
    // lit shading; the rim is what made everyone read as a glowing outline.
  }), { rim: false });
  m.userData.shared = true;
  _matCache.set(key, m);
  return m;
}

/**
 * The unified shadow look: dark, effectively unlit, rim-lit in the summoner's
 * colour. vertexColors is OFF, which is the whole trick — every shadow reads as
 * one army while the silhouettes stay as varied as the living.
 *
 * NOT cached: game.js fades a decaying corpse by writing material.opacity, and
 * against a shared material that would fade every shadow on the field with it.
 */
function ghostMaterial(glow) {
  // Numbers match creatures.js applyShadowSkin exactly — that recipe was
  // screenshot-tuned against a living skeleton in the pinned harness arena,
  // where THIS material's old 0.45/0.25/0.16/0.72 read as a bright teal
  // hologram instead of a shadow (under ACES at exposure 1.25 even a small
  // emissiveIntensity repaints a black body cyan, and the 0.45-rough specular,
  // 0.35 env pickup and 0.72 sky bleed-through each added their own glaze).
  // The humanoid ghost is only seen when creatures.glb is missing, and it must
  // read as the same near-black army as the bound-creature clones it stands in
  // for: matte, near-opaque, emissive at a whisper, the rim alone as the cold
  // accent.
  const m = applyRim(new THREE.MeshStandardMaterial({
    color: 0x0a1220,
    vertexColors: false,
    roughness: 0.9,
    metalness: 0.05,
    envMapIntensity: 0.12,
    emissive: new THREE.Color(glow),
    emissiveIntensity: 0.025,
    transparent: true,
    opacity: 0.94,
    // FrontSide, unlike the living. A transparent DOUBLE-sided low-poly body
    // draws its own back faces in undefined order and speckles: the first
    // render of this looked like TV static wrapped round a person. Depth write
    // stays on, which is what stops the remaining front-face overdraw.
    side: THREE.FrontSide,
    // Explicit opt-IN, restrained preset. Shadows are the documented exception
    // to "no rims": they are supposed to look unnatural, just not neon.
  }), { preset: 'shadow', color: glow });
  // `m.userData = {}` here used to WIPE the rim bookkeeping applyRim had just
  // written. Only the shared flag needs clearing — disposeObject3D must free
  // this material because it is per-instance.
  delete m.userData.shared;
  return m;
}

// ----------------------------------------------------------------- sockets

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * A socket under `bone` whose axes are the CHARACTER's, offset so that a child
 * placed at the weapons.js hand offset lands exactly on the bone.
 *
 * weapons.js authors every grip against the procedural rig, where the hand sits
 * at local y = -0.72 inside the arm mesh. That module is not ours to edit, so
 * the socket is built to make that number correct here too: it sits `lift`
 * "above" the bone along character-up, so the weapon's own -0.72 brings it back
 * to the fist. Bone local space is metres (fact 2).
 *
 * `scale` counter-scales MODEL_SCALE back out, so a weapon authored against the
 * procedural rig comes out exactly the size it was authored, on a character
 * that has been stretched to the procedural rig's height.
 */
function makeSocket(bone, { lift = 0, scale = 1 } = {}) {
  const s = new THREE.Object3D();
  s.name = `${bone.name}_socket`;
  // Character-space orientation, expressed in the bone's local frame. The
  // instance root has no rotation, so the bone's world quaternion here IS its
  // orientation relative to the character.
  bone.getWorldQuaternion(_q);
  s.quaternion.copy(_q).invert();
  s.scale.setScalar(scale);
  // 'up' in bone-local coordinates. The child's own -lift, expressed in the
  // socket's scaled frame, is lift*scale bone-local units, hence the factor.
  _v.set(0, 1, 0).applyQuaternion(s.quaternion).multiplyScalar(lift * scale);
  s.position.copy(_v);
  bone.add(s);
  return s;
}

// Two small emissive boxes: the telegraph flare game.js drives through
// rig.eyeL/rig.eyeR.scale. It is one extra draw call per character and it is
// the only pre-attack warning the player gets, so it stays.
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

class CharacterInstance {
  constructor(root, mesh, mixer, rig, appearance) {
    this.root = root;
    this.mesh = mesh;
    this.mixer = mixer;
    this.rig = rig;
    this.appearance = appearance;
    this.skeleton = mesh.skeleton;
    this.sockets = {};
    this.runSpeed = RUN_SPEED;

    this._actions = new Map();
    this._cur = null;
    this._state = null;
    this._dead = false;
    this._hurtT = 0;
    this._armed = false;
    this._lastNow = -1;
    this._atkPrev = 0;         // last frame's attackPhase, for edge detection
    this._atkState = 'attack'; // clip chosen at the START of the current swing
    this._atkOffset = 0;       // windup start offset for restart-with-variation
    this._unarmedSeq = 0;      // fallback chain position when no combo is given
    _live.add(this);
    _liveInstances++;
  }

  /**
   * Whether this character is holding a weapon. Drives the idle pose
   * (Idle_Sword vs arms-down) and the attack chain (slash vs punch/kick).
   * weapons.equipWeapon flips it, so it tracks the actual fist contents.
   *
   * The cached 'idle' action is invalidated because _clip resolves idle
   * DIFFERENTLY when armed — without this, a character built bare-handed and
   * armed a frame later (the player: equipWeapon runs after makeCharacter)
   * keeps the neutral arms-down idle and the blade hangs inside his leg.
   */
  setArmed(armed) {
    const v = Boolean(armed);
    if (v === this._armed) return;
    this._armed = v;
    this._actions.delete('idle');
    if (this._state === 'idle' && !this._dead) this.play('idle', { fade: 0.2 });
  }

  _clip(state) {
    // An armed character idles with the blade out. Without this the pack's
    // neutral idle drops both arms to the sides and a 1.5-unit sword pointing
    // straight up out of the fist passes through the shoulder.
    if (state === 'idle' && this._armed) {
      const armed = _clips.get(`${this.rig.clipPrefix}Idle_Sword`);
      if (armed) return armed;
    }
    const names = CLIP_FOR[state] || CLIP_FOR.idle;
    for (const n of names) {
      const c = _clips.get(this.rig.clipPrefix + n);
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

  /**
   * Crossfade into a state.
   * @param {string} state one of CHARACTER_STATES
   */
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
      this._cur.paused = false;         // a paused action never finishes fading out
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

  /** Advance the mixer. dt is clamped: a backgrounded tab must not teleport. */
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

  /**
   * The animateRig bridge: same option bag entities.animateRig takes, turned
   * into a state + a mixer tick.
   *
   * `dt` is optional because animateRig's signature is fixed and game.js does
   * not pass one today; without it we measure wall-clock, which is correct
   * except that hit-stop and level-up time dilation do not slow the animation.
   * Passing dt (see the game.js handoff) fixes that.
   */
  animate({
    moving = false, speed = 0, attackPhase = 0, attackContact = 0.5,
    combo = 0, dashPhase = 0, hurt = 0, airborne = false, dt = null,
  } = {}) {
    const d = dt == null ? this._wallDt() : Math.min(0.05, Math.max(0, dt));

    if (this._dead) { this.mixer.update(d); return; }

    if (attackPhase > 0) {
      // Drive the swing clip directly off the game's own swing timer rather
      // than guessing a timeScale. attackPhase counts 1 -> 0 across the swing,
      // so the animation cannot drift out of sync with the hitbox.
      //
      // The clip and its restart offset are chosen ONCE, on the swing's rising
      // edge, and held for the whole swing — re-deriving them per frame would
      // let a combo counter that resets mid-swing snap the pose.
      if (this._atkPrev <= 0 || attackPhase > this._atkPrev + 0.2) {
        if (this._armed) {
          this._atkState = 'attack';
          // One slash clip in the pack, so combo steps restart it from partway
          // into the windup: the arm is already lifted and the repeat press
          // reads as a return cut rather than the same chop replayed. The
          // finisher keeps most of its windup — that heave is its weight.
          this._atkOffset = combo === 2 ? 0.4 : combo >= 3 ? 0.15 : 0;
        } else {
          const step = combo > 0 ? (combo - 1) : this._unarmedSeq++;
          this._atkState = UNARMED_CHAIN[step % UNARMED_CHAIN.length];
          this._atkOffset = 0;
        }
      }
      this._atkPrev = attackPhase;

      this.play(this._atkState, { fade: 0.08 });
      const a = this._cur;
      if (a) {
        a.paused = true;
        const dur = a.getClip().duration;
        // Piecewise time-warp: the game says WHEN the damage lands
        // (attackContact, a fraction of the swing timer) and CLIP_CONTACT says
        // where the clip's blow is; windup and follow-through are stretched so
        // the two meet exactly. Damage numbers pop on the frame the blade
        // crosses the target — that sync is most of what makes a 0.34 s swing
        // read as a real hit.
        const elapsed = 1 - Math.min(1, attackPhase);
        const cDmg = Math.min(0.95, Math.max(0.05, attackContact));
        const contact = CLIP_CONTACT[this._atkState] ?? 0.45;
        const f = elapsed <= cDmg
          ? (this._atkOffset + (1 - this._atkOffset) * (elapsed / cDmg)) * contact
          : contact + ((elapsed - cDmg) / (1 - cDmg)) * (1 - contact);
        a.time = Math.min(dur, Math.max(0, f * dur));
      }
      this._hurtT = 0;
    } else if (dashPhase > 0) {
      // The dash is 0.26 s of i-frames game.js already owns; this only dresses
      // it. Scrubbed like the attack so the tumble tracks the dash timer.
      this._atkPrev = 0;
      this.play('roll', { fade: 0.06 });
      const a = this._cur;
      if (a) {
        a.paused = true;
        const dur = a.getClip().duration;
        const e = 1 - Math.min(1, dashPhase);
        a.time = dur * (ROLL_IN + (ROLL_OUT - ROLL_IN) * e);
      }
    } else {
      this._atkPrev = 0;
      if (this._cur && this._cur.paused) this._cur.paused = false;
      if (this._hurtT > 0) {
        this._hurtT -= d;
      } else if (hurt > 0 && this._state !== 'hurt') {
        this.play('hurt', { fade: 0.05, once: true });
        this._hurtT = Math.max(0.2, this.clipDuration('hurt')) * 0.8;
      } else if (airborne) {
        this.play('jump', { fade: 0.12 });
      } else if (moving) {
        this.play(speed > this.runSpeed ? 'run' : 'walk', { fade: 0.15 });
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
    // boneTexture that nothing else will ever free. Skipping this leaks one
    // texture per character per gate — invisible in geometry counts, fatal
    // under Android's per-app memory limiter over a long session.
    try { this.skeleton?.dispose(); } catch { /* older three: no dispose */ }
    if (this.appearance) releaseGeometry(this.appearance.key);
    evictGeometries();
  }
}

/**
 * Build one skinned character.
 *
 * @param {object} opts
 * @param {string|number} opts.seed        appearance seed
 * @param {string} opts.archetype          player|grunt|stalker|brute|caster|lancer|howler|boss|shadow
 * @param {string} opts.rank               'E'..'S'
 * @param {number} opts.scale              game-space scale (1 == the procedural humanoid)
 * @param {number} opts.glow               rim / eye colour
 * @param {number} opts.color              archetype tint multiplied over the pack palette
 * @param {boolean} opts.ghost             use the unified shadow material
 * @param {boolean} opts.eyes              emissive telegraph mote (default true)
 * @param {boolean} opts.armed             idle with a blade out rather than arms down
 * @returns {CharacterInstance|null}       null when the pack is absent or over budget
 */
export function makeCharacter({
  seed = 0,
  archetype = 'grunt',
  rank = 'E',
  scale = 1,
  glow = 0xffffff,
  color = 0xffffff,
  ghost = false,
  eyes = true,
  armed = false,
  ignoreBudget = false,
} = {}) {
  if (!_loaded) return null;
  if (!ignoreBudget && _liveInstances >= _quality.budget) return null;

  const appearance = appearanceFor(seed, { archetype: ghost ? 'shadow' : archetype, rank });
  if (!appearance) return null;
  const rig = _rigs.get(appearance.rig);
  if (!rig) return null;

  const geometry = mergedGeometryFor(appearance);
  if (!geometry) return null;

  const inst3d = skeletonClone(rig.template);
  const mesh = inst3d.getObjectByName('skin');
  if (!mesh || !mesh.isSkinnedMesh) { releaseGeometry(appearance.key); return null; }

  mesh.geometry = geometry;
  mesh.material = ghost
    ? ghostMaterial(glow)
    : bodyMaterial(glow, color, appearance.tint, archetype === 'player');
  mesh.castShadow = _quality.castShadow && !ghost;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;

  const root = new THREE.Group();
  root.name = `char_${appearance.base}`;
  root.add(inst3d);
  root.scale.setScalar(scale * MODEL_SCALE);

  const mixer = new THREE.AnimationMixer(inst3d);
  const inst = new CharacterInstance(root, mesh, mixer, rig, appearance);

  // sockets
  inst3d.updateMatrixWorld(true);
  const p = rig.bonePrefix;
  const wristR = inst3d.getObjectByName(`${p}Wrist_R`);
  const wristL = inst3d.getObjectByName(`${p}Wrist_L`);
  const head = inst3d.getObjectByName(`${p}Head`);
  // 0.72 is weapons.js's HAND_SOCKET.y; see makeSocket.
  const hand = { lift: 0.72, scale: 1 / MODEL_SCALE };
  if (wristR) inst.sockets.hand = makeSocket(wristR, hand);
  if (wristL) inst.sockets.handL = makeSocket(wristL, hand);
  if (head) inst.sockets.head = makeSocket(head, { lift: 0, scale: 1 });

  if (eyes && inst.sockets.head) {
    const eye = new THREE.Mesh(eyeGeometry(), eyeMaterial(glow));
    // Measured against the pack's Head bone, which sits at the base of the
    // skull: forward and up puts the mote over the eyes rather than in the ear.
    eye.position.set(0, 0.115, 0.098);
    eye.layers.enable(GLOW_LAYER);
    eye.frustumCulled = false;
    inst.sockets.head.add(eye);
    inst.eyes = eye;
  }

  root.userData.character = inst;
  root.userData.appearance = appearance;
  inst._armed = Boolean(armed);
  inst.play('idle', { fade: 0 });
  return inst;
}

// ------------------------------------------------------------------ stats

const _box = new THREE.Box3();
const _sz = new THREE.Vector3();

/**
 * World-space height of a humanoid root, procedural or skinned. The one number
 * that catches a scale mistake against the rest of the game, so it is exported
 * rather than re-derived in the test.
 */
export function measureHeight(object3d, { stride = 11 } = {}) {
  if (!object3d) return null;
  object3d.updateWorldMatrix(true, true);
  _box.makeEmpty();
  object3d.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (o.isSkinnedMesh) {
      // Box3.setFromObject would use the geometry's own bounds, which are in
      // QUANTISED space for this pack and would report ~7900 units. Push the
      // vertices through the real skinning maths instead — a sampled subset,
      // because this is a verification helper, not a per-frame call.
      o.skeleton.update();
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += stride) {
        _sz.fromBufferAttribute(pos, i);
        o.applyBoneTransform(i, _sz);
        _box.expandByPoint(_sz.applyMatrix4(o.matrixWorld));
      }
      return;
    }
    _box.expandByObject(o);
  });
  if (_box.isEmpty()) return null;
  return +(_box.max.y - _box.min.y).toFixed(3);
}

export function characterStats() {
  return {
    loaded: _loaded,
    rigs: _rigs.size,
    characters: _chars.size,
    clips: _clips.size,
    instances: _liveInstances,
    budget: _quality.budget,
    tier: _quality.tier,
    appearances: _geoCache.size,
    mergeFailures: _mergeFailures,
    /** Draw calls one GLB character costs: body + telegraph mote. */
    drawCallsPerCharacter: 2,
  };
}

/** Teardown. Only meaningful on GL context loss or a test reset. */
export function disposeCharacterModels() {
  for (const inst of Array.from(_live)) inst.dispose();
  for (const e of _geoCache.values()) e.geometry.dispose();
  _geoCache.clear();
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
  _rigs.clear();
  _chars.clear();
  _loaded = false;
  _loading = null;
  _liveInstances = 0;
  _mergeFailures = 0;
}
