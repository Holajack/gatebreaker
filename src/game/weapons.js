import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOW_LAYER } from '../render/glow.js';

// Swappable weapons: data tables, procedural meshes, drop rolls and the swing
// state machine that replaces the single hardcoded sword timing in game.js.
//
// Design rule for this file: an archetype is a *feel*, not a stat line. The
// greataxe is not "a slower sword with bigger numbers" — it locks you in place
// for a second and hits everything in front of you. The daggers are not "a fast
// sword" — they walk you into the enemy one small step at a time. All of that
// lives in the combo step timings, which is why steps carry lock/cancel windows
// rather than a single duration.

// Local copy rather than importing from world.js: rolling a drop or drawing an
// inventory icon must not drag the arena builder (and its env/sky passes) in.
// terrain.js keeps its own copy for the same reason.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- asset cache
//
// Disposing a material drops three's compiled program for it. Re-equipping the
// same weapon then recompiles the shader on the next draw, which measured
// 8-60ms on a mid-range Android — a visible hitch on every weapon swap and
// every shadow-soldier spawn. So: geometry and materials are cached by shape
// and by rarity tint, shared across every instance, and never disposed while
// the game is running. Both caches are bounded (a fixed set of parts x 5
// rarities x 2 ghost variants), so nothing here grows without limit.

const _geoCache = new Map();
const _matCache = new Map();

// `shared` is the flag Game.clearEntities honours: entity teardown disposes
// anything it reaches that is NOT marked, so an unmarked cache entry would be
// freed out from under every other weapon still holding it.
function cachedGeo(key, build) {
  let g = _geoCache.get(key);
  if (g === undefined) { g = build(); g.userData.shared = true; _geoCache.set(key, g); }
  return g;
}

function cachedMat(key, build) {
  let m = _matCache.get(key);
  if (m === undefined) { m = build(); m.userData.shared = true; _matCache.set(key, m); }
  return m;
}

function box(w, h, d) {
  return cachedGeo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
}
function cyl(rt, rb, h, seg) {
  return cachedGeo(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
}
function cone(r, h, seg) {
  return cachedGeo(`n${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg));
}
function octa(r) {
  return cachedGeo(`o${r}`, () => new THREE.OctahedronGeometry(r, 0));
}
// A triangular prism lying in XY with its thickness along Z — the readable
// building block for axe bits and glaive blades.
function wedge(r, thickness) {
  return cachedGeo(`w${r},${thickness}`, () => {
    const g = new THREE.CylinderGeometry(r, r, thickness, 3);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

function steelMat(tint, ghost) {
  return cachedMat(`steel:${tint}:${ghost ? 1 : 0}`, () => new THREE.MeshStandardMaterial({
    color: 0xdfe6ff,
    emissive: new THREE.Color(tint), emissiveIntensity: 0.55,
    metalness: 0.95, roughness: 0.18, envMapIntensity: 2.2, flatShading: true,
    ...(ghost ? { transparent: true, opacity: 0.7 } : {}),
  }));
}

function darkMat(ghost) {
  return cachedMat(`dark:${ghost ? 1 : 0}`, () => new THREE.MeshStandardMaterial({
    color: 0x4a4f70, metalness: 0.7, roughness: 0.4, flatShading: true,
    ...(ghost ? { transparent: true, opacity: 0.7 } : {}),
  }));
}

function haftMat(ghost) {
  return cachedMat(`haft:${ghost ? 1 : 0}`, () => new THREE.MeshStandardMaterial({
    color: 0x3a2f28, roughness: 0.9, metalness: 0.05, flatShading: true,
    ...(ghost ? { transparent: true, opacity: 0.7 } : {}),
  }));
}

// The one part that goes on the glow layer. MeshBasic because the bloom pass
// renders emissive-only geometry unlit anyway — a Standard material here would
// just cost a lighting evaluation nobody sees.
function edgeMat(tint) {
  return cachedMat(`edge:${tint}`, () => new THREE.MeshBasicMaterial({ color: tint }));
}

/** Teardown only — never call this mid-run. See the cache note above. */
export function disposeWeaponAssets() {
  _geoCache.forEach((g) => g.dispose());
  _matCache.forEach((m) => m.dispose());
  _heldGeo.forEach((g) => g?.dispose());
  _geoCache.clear();
  _matCache.clear();
  _heldGeo.clear();
}

export function weaponCacheStats() {
  return { geometries: _geoCache.size, materials: _matCache.size, heldModels: _heldGeo.size };
}

// ----------------------------------------------------------------- archetypes
//
// `grip` is layered on top of the hand socket (see HAND_SOCKET) so each weapon
// class hangs off the fist at a plausible angle instead of all sharing one.
// `anim` is consumed by animateRig in entities.js: `lo`/`hi` are the shoulder
// rotation at the top of the windup and the end of the follow-through, so the
// axe visibly winds further back and the daggers barely wind up at all.

export const ARCHETYPES = {
  // THE SIGN OF rx WAS WRONG IN EVERY ENTRY, AND THAT IS THE WHOLE OF THE
  // "he isn't really holding it" BUG. The previous values (sword -0.45,
  // greataxe -0.35, daggers -0.65, polearm -0.30) were written against a
  // comment that asks for FORWARD pitch — but the hand socket is
  // character-aligned (characters.js makeSocket inverts the bone's rest-pose
  // world quaternion), and in that frame a rotation of -rx about X tips the
  // model's +Y toward -Z, i.e. BACKWARD, into the torso.
  //
  // tools/grip-probe.mjs measured the shipped sword at bladeDir
  // (0.011, 0.896, -0.443): 26 degrees BEHIND vertical, blade buried in the
  // shoulder, only the grip and pommel visible past the arm. Positive rx is
  // what the comment always meant.
  //
  // The rz/tilt sign was wrong the same way. The character's right hand sits
  // at local x = -0.25, so the character's right is -X, and the composite
  // blade direction works out to x = -sin(rz + packTilt). A NEGATIVE total
  // therefore leans the blade ACROSS the body to the left — the probe caught
  // the sword's bounds running from x -0.47 to +0.18, straight through the
  // chest. Positive leans it outboard, clear of the silhouette.
  sword: {
    name: 'Sword', feel: 'Balanced. Three chops, moderate reach, cancels cleanly.',
    build: buildSword,
    grip: { y: 0, z: 0.06, rx: 0.34, rz: 0.10 },
    anim: { lo: -1.50, hi: 1.90, twist: 0.22, twoHand: false, thrust: false, alternate: false },
    mass: 1.4,
  },
  greataxe: {
    // Two-handed, so it hangs closer to the body's centre line and pitches
    // less: a haft angled hard forward reads as "carrying a shovel".
    name: 'Greataxe', feel: 'Slow, enormous, wide. You are committed the moment you press.',
    build: buildGreatweapon,
    grip: { y: -0.02, z: 0.08, rx: 0.26, rz: 0.06 },
    anim: { lo: -2.30, hi: 2.40, twist: 0.42, twoHand: true, thrust: false, alternate: false },
    mass: 4.8,
  },
  daggers: {
    // The steepest pitch of the four on purpose: a short blade held near
    // vertical disappears against the forearm, and the dagger silhouette is
    // the only thing telling the player he is the fast archetype.
    name: 'Twin Daggers', feel: 'Five hits, short reach, steps into the target, crits constantly.',
    build: buildDaggers,
    grip: { y: 0.02, z: 0.08, rx: 0.52, rz: 0.12 },
    anim: { lo: -0.90, hi: 1.55, twist: 0.14, twoHand: false, thrust: false, alternate: true },
    mass: 0.9,
  },
  polearm: {
    // Nearly upright: a 2.5 m shaft pitched as far as a sword would put the
    // butt through the floor and the point through the character's own head.
    name: 'Spear', feel: 'Long reach, narrow thrusts. Poke from outside their swing.',
    build: buildPolearm,
    // z was 0.10 and that is the one number in this table that was still wrong.
    // A pole is nearly upright, so a forward offset does not disappear into a
    // pitch the way it does on a raked sword: grip-measure put the shaft axis
    // 0.036 m clear of the fist centre, and the hand crop showed the haft
    // passing OUTSIDE an apparently open hand. 0.02 threads it through the
    // fingers. rx/rz are unchanged — the lean is what keeps a 2.5 m shaft out of
    // the character's own silhouette.
    grip: { y: 0.04, z: 0.02, rx: 0.16, rz: 0.05 },
    anim: { lo: -0.55, hi: 1.15, twist: 0.10, twoHand: true, thrust: true, alternate: false },
    mass: 2.2,
  },
};

// The right hand in makeHumanoid's rig: the weapon parents to armRMesh, whose
// pivot is the shoulder and whose 0.72-tall limb geometry hangs downward, so
// the fist sits at local y = -0.72. Everything below is authored at rig scale 1
// because the humanoid root already carries the character's scale.
const HAND_SOCKET = { x: 0, y: -0.72, z: 0 };

// -------------------------------------------------------------------- rarity

export const RARITIES = {
  common:    { key: 'common',    name: 'Common',    color: 0xb9c0d4, mul: 1.00, affixes: 0, weight: 100 },
  uncommon:  { key: 'uncommon',  name: 'Uncommon',  color: 0x54e08a, mul: 1.09, affixes: 1, weight: 46 },
  rare:      { key: 'rare',      name: 'Rare',      color: 0x4aa8ff, mul: 1.20, affixes: 2, weight: 18 },
  epic:      { key: 'epic',      name: 'Epic',      color: 0xb14bff, mul: 1.36, affixes: 3, weight: 6 },
  legendary: { key: 'legendary', name: 'Legendary', color: 0xffc24b, mul: 1.58, affixes: 4, weight: 1.2 },
};

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export function rarityColor(key) {
  return (RARITIES[key] || RARITIES.common).color;
}

// Affixes only touch fields the swing code already reads, so a rolled weapon
// never needs its combo array cloned — see rollWeapon.
export const AFFIXES = {
  power:    { name: 'Cruel',     lo: 0.05, hi: 0.15,  apply: (w, m) => { w.dmgMul *= 1 + m; } },
  keen:     { name: 'Keen',      lo: 0.03, hi: 0.11,  apply: (w, m) => { w.critAdd += m; } },
  swift:    { name: 'Quick',     lo: 0.05, hi: 0.14,  apply: (w, m) => { w.rate *= 1 + m; } },
  brutal:   { name: 'Brutal',    lo: 0.18, hi: 0.55,  apply: (w, m) => { w.knockMul *= 1 + m; } },
  reach:    { name: 'Longarm',   lo: 0.05, hi: 0.15,  apply: (w, m) => { w.reachMul *= 1 + m; } },
  vampiric: { name: 'Thirsting', lo: 0.01, hi: 0.045, apply: (w, m) => { w.leech += m; } },
};

const AFFIX_KEYS = Object.keys(AFFIXES);

const TITLES = ['the Hollow', 'Ash', 'the Long Night', 'Broken Grades', 'the Archon', 'Nine Gates'];

// --------------------------------------------------------------- weapon table
//
// Step fields:
//   windup    seconds from press until the hit lands
//   active    seconds the swing stays live (hits are spread across it)
//   recovery  seconds of follow-through after the active window
//   lock      seconds from step start during which you may not dash out
//   cancel    seconds before the step ends that the next combo input is taken
//   arc/range hit cone, before the instance's arcMul/reachMul
//   dmg       share of a full weapon hit
//   knock     knockback impulse, before knockMul
//   stagger   seconds of enemy stagger
//   lunge     forward impulse applied once at step start
//   move      movement speed multiplier while the step runs
//   hits      damage applications inside the active window (default 1)
//
// The current hardcoded sword — windup 0.17, total 0.34, ranges 2.9/3.6, arcs
// 0.62pi/0.85pi, knockback 2.5/9, finisher x1.85 — is exactly `riftedge` below,
// so switching game.js over to this table is a no-op for existing feel.

const SWORD_COMBO = [
  { windup: 0.17, active: 0.09, recovery: 0.08, lock: 0.26, cancel: 0.09,
    arc: Math.PI * 0.62, range: 2.9, dmg: 1.00, knock: 2.5, stagger: 0,    lunge: 0.6, move: 0.35, shake: 0.00, hitStop: 0.00 },
  { windup: 0.16, active: 0.09, recovery: 0.09, lock: 0.25, cancel: 0.09,
    arc: Math.PI * 0.62, range: 2.9, dmg: 1.12, knock: 3.0, stagger: 0,    lunge: 0.7, move: 0.35, shake: 0.00, hitStop: 0.00 },
  { windup: 0.22, active: 0.11, recovery: 0.19, lock: 0.33, cancel: 0.10,
    arc: Math.PI * 0.85, range: 3.6, dmg: 2.30, knock: 9.0, stagger: 0.45, lunge: 1.1, move: 0.25, shake: 0.30, hitStop: 0.05, finisher: true },
];

// lock === total duration: an axe swing owns you until it is finished. That is
// the whole point of the archetype, so it is not a tuning accident.
const GREATAXE_COMBO = [
  { windup: 0.42, active: 0.14, recovery: 0.34, lock: 0.90, cancel: 0.14,
    arc: Math.PI * 1.15, range: 4.0, dmg: 2.60, knock: 13, stagger: 0.55, lunge: 1.2, move: 0.10, shake: 0.45, hitStop: 0.06 },
  { windup: 0.55, active: 0.16, recovery: 0.52, lock: 1.23, cancel: 0.16,
    arc: Math.PI * 1.35, range: 4.6, dmg: 4.30, knock: 20, stagger: 0.90, lunge: 1.6, move: 0.06, shake: 0.90, hitStop: 0.10, finisher: true },
];

const MAUL_COMBO = [
  { windup: 0.48, active: 0.15, recovery: 0.40, lock: 1.03, cancel: 0.15,
    arc: Math.PI * 1.20, range: 4.0, dmg: 2.90, knock: 15, stagger: 0.65, lunge: 1.0, move: 0.08, shake: 0.55, hitStop: 0.07 },
  // Radial: a ground pound has no front, so the arc is the full circle.
  { windup: 0.62, active: 0.18, recovery: 0.62, lock: 1.42, cancel: 0.18,
    arc: Math.PI * 2.00, range: 5.0, dmg: 4.80, knock: 24, stagger: 1.10, lunge: 0.4, move: 0.04, shake: 1.10, hitStop: 0.12, finisher: true },
];

// Each light step carries a real forward step, so a full dagger combo closes
// about 4m of ground — the archetype hunts you into the enemy's face.
const DAGGER_LIGHT = { windup: 0.075, active: 0.05, recovery: 0.055, lock: 0.075, cancel: 0.05,
  arc: Math.PI * 0.50, range: 2.0, knock: 0.7, stagger: 0, move: 0.62, shake: 0.00, hitStop: 0.00 };

const DAGGER_COMBO = [
  { ...DAGGER_LIGHT, dmg: 1.00, lunge: 0.9 },
  { ...DAGGER_LIGHT, dmg: 1.00, lunge: 0.9 },
  { ...DAGGER_LIGHT, dmg: 1.05, lunge: 1.0 },
  { ...DAGGER_LIGHT, dmg: 1.10, lunge: 1.0 },
  { windup: 0.10, active: 0.12, recovery: 0.16, lock: 0.22, cancel: 0.06,
    arc: Math.PI * 0.70, range: 2.3, dmg: 1.35, knock: 4.0, stagger: 0.20, lunge: 1.8, move: 0.45,
    shake: 0.22, hitStop: 0.04, hits: 2, finisher: true },
];

const SPEAR_COMBO = [
  { windup: 0.20, active: 0.09, recovery: 0.13, lock: 0.29, cancel: 0.10,
    arc: Math.PI * 0.22, range: 4.6, dmg: 1.15, knock: 3.5, stagger: 0,    lunge: 1.2, move: 0.70, shake: 0.00, hitStop: 0.00 },
  { windup: 0.18, active: 0.09, recovery: 0.15, lock: 0.27, cancel: 0.10,
    arc: Math.PI * 0.20, range: 4.9, dmg: 1.30, knock: 4.0, stagger: 0,    lunge: 1.4, move: 0.70, shake: 0.00, hitStop: 0.00 },
  { windup: 0.28, active: 0.12, recovery: 0.30, lock: 0.52, cancel: 0.12,
    arc: Math.PI * 0.26, range: 6.0, dmg: 2.50, knock: 11,  stagger: 0.50, lunge: 3.2, move: 0.55, shake: 0.35, hitStop: 0.06, finisher: true },
];

// Glaive alternates thrust and sweep so the same weapon covers single-target
// poke and crowd clearing depending on where you are in the chain.
const GLAIVE_COMBO = [
  { windup: 0.19, active: 0.09, recovery: 0.12, lock: 0.28, cancel: 0.10,
    arc: Math.PI * 0.24, range: 4.8, dmg: 1.10, knock: 3.0, stagger: 0,    lunge: 1.2, move: 0.70, shake: 0.00, hitStop: 0.00 },
  { windup: 0.22, active: 0.11, recovery: 0.14, lock: 0.33, cancel: 0.11,
    arc: Math.PI * 0.90, range: 4.2, dmg: 1.25, knock: 5.0, stagger: 0.15, lunge: 0.8, move: 0.55, shake: 0.18, hitStop: 0.00 },
  { windup: 0.20, active: 0.09, recovery: 0.13, lock: 0.29, cancel: 0.10,
    arc: Math.PI * 0.26, range: 5.2, dmg: 1.35, knock: 4.0, stagger: 0,    lunge: 1.5, move: 0.70, shake: 0.00, hitStop: 0.00 },
  { windup: 0.30, active: 0.14, recovery: 0.30, lock: 0.56, cancel: 0.12,
    arc: Math.PI * 1.05, range: 5.4, dmg: 2.60, knock: 13,  stagger: 0.60, lunge: 2.2, move: 0.45, shake: 0.50, hitStop: 0.07, finisher: true },
];

export const WEAPONS = {
  riftedge: {
    id: 'riftedge', name: 'Riftedge', archetype: 'sword', tier: 1, minRank: 0, reqLevel: 1,
    dmgMul: 1.00, cd: 0.40, chainWindow: 0.90, reachMul: 1, arcMul: 1, knockMul: 1,
    critAdd: 0, critMul: 1.85, moveMul: 1, combo: SWORD_COMBO,
    blurb: 'Standard hunter issue. Nothing on it is remarkable except that it works.',
    look: { len: 1.50, width: 0.10, guard: 0.36 },
  },
  dawnbrand: {
    id: 'dawnbrand', name: 'Dawnbrand', archetype: 'sword', tier: 3, minRank: 2, reqLevel: 12,
    dmgMul: 1.06, cd: 0.34, chainWindow: 1.00, reachMul: 1.05, arcMul: 1, knockMul: 1.1,
    critAdd: 0.05, critMul: 1.95, moveMul: 1.02, combo: SWORD_COMBO, rate: 1.12,
    blurb: 'Lighter than it has any right to be. The edge stays warm.',
    look: { len: 1.62, width: 0.09, guard: 0.44 },
  },
  sunderaxe: {
    id: 'sunderaxe', name: 'Sunderaxe', archetype: 'greataxe', tier: 2, minRank: 1, reqLevel: 6,
    dmgMul: 1.35, cd: 0.85, chainWindow: 1.30, reachMul: 1, arcMul: 1, knockMul: 1.3,
    critAdd: -0.02, critMul: 2.20, moveMul: 0.92, combo: GREATAXE_COMBO,
    blurb: 'Two swings. If both miss, you have a long moment to think about it.',
    look: { head: 'axe', haft: 1.85, bit: 0.34 },
  },
  gravemaul: {
    id: 'gravemaul', name: 'Gravemaul', archetype: 'greataxe', tier: 4, minRank: 3, reqLevel: 20,
    dmgMul: 1.55, cd: 1.05, chainWindow: 1.50, reachMul: 1, arcMul: 1, knockMul: 1.6,
    critAdd: -0.04, critMul: 2.40, moveMul: 0.86, combo: MAUL_COMBO, rate: 0.94,
    blurb: 'The finisher does not swing at anything. It swings at the floor.',
    look: { head: 'maul', haft: 1.95, bit: 0.26 },
  },
  whisperfangs: {
    id: 'whisperfangs', name: 'Whisperfangs', archetype: 'daggers', tier: 1, minRank: 0, reqLevel: 3,
    dmgMul: 0.58, cd: 0.16, chainWindow: 0.50, reachMul: 1, arcMul: 1, knockMul: 0.7,
    critAdd: 0.14, critMul: 2.05, moveMul: 1.08, combo: DAGGER_COMBO,
    blurb: 'You have to be close enough to smell them. That is the trade.',
    look: { len: 0.52, width: 0.07 },
  },
  veinsplitters: {
    id: 'veinsplitters', name: 'Veinsplitters', archetype: 'daggers', tier: 3, minRank: 2, reqLevel: 14,
    dmgMul: 0.60, cd: 0.15, chainWindow: 0.55, reachMul: 1.04, arcMul: 1, knockMul: 0.7,
    critAdd: 0.22, critMul: 2.30, moveMul: 1.10, combo: DAGGER_COMBO, rate: 1.08,
    blurb: 'Barely damages armour. Finds every gap in it.',
    look: { len: 0.58, width: 0.06 },
  },
  vigil: {
    id: 'vigil', name: 'Vigil', archetype: 'polearm', tier: 2, minRank: 1, reqLevel: 8,
    dmgMul: 1.18, cd: 0.50, chainWindow: 0.80, reachMul: 1, arcMul: 1, knockMul: 1,
    critAdd: 0.02, critMul: 1.90, moveMul: 0.98, combo: SPEAR_COMBO,
    blurb: 'Kills things that never get to touch you. Useless in a crowd.',
    look: { head: 'spear', shaft: 2.50 },
  },
  voidglaive: {
    id: 'voidglaive', name: 'Voidglaive', archetype: 'polearm', tier: 5, minRank: 4, reqLevel: 28,
    dmgMul: 1.25, cd: 0.46, chainWindow: 0.95, reachMul: 1.06, arcMul: 1.05, knockMul: 1.15,
    critAdd: 0.06, critMul: 2.05, moveMul: 0.98, combo: GLAIVE_COMBO, rate: 1.05,
    blurb: 'Thrust, sweep, thrust, and then something the geometry does not survive.',
    look: { head: 'glaive', shaft: 2.35 },
  },
};

export const WEAPON_LIST = Object.values(WEAPONS);

// ------------------------------------------------------------------ rolling

function between(rnd, lo, hi) { return lo + rnd() * (hi - lo); }

export function rollRarity(rnd, luck = 0) {
  // luck shifts weight up the table without ever making common impossible.
  let total = 0;
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    total += RARITIES[RARITY_ORDER[i]].weight * (1 + luck * i * 0.5);
  }
  let r = rnd() * total;
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    r -= RARITIES[RARITY_ORDER[i]].weight * (1 + luck * i * 0.5);
    if (r <= 0) return RARITY_ORDER[i];
  }
  return 'common';
}

/**
 * Concrete weapon instance from a base definition.
 * `rnd` may be a mulberry32-style function or a raw numeric seed; passing the
 * seed is what makes a weapon storable as four fields (see serializeWeapon).
 */
export function rollWeapon(baseId, rnd, { rarity, level = 1, luck = 0 } = {}) {
  const seed = typeof rnd === 'number' ? rnd >>> 0 : null;
  const r = seed === null ? rnd : mulberry32(seed);
  const base = WEAPONS[baseId] || WEAPONS.riftedge;
  // Draw the rarity even when one was forced, so a given seed lands on the same
  // stat rolls either way — that is what lets a save store four fields and
  // rebuild the exact weapon instead of a snapshot of every number.
  const rolled = rollRarity(r, luck);
  const rd = RARITIES[rarity] || RARITIES[rolled] || RARITIES.common;

  const w = {
    baseId: base.id,
    base,
    archetype: base.archetype,
    arch: ARCHETYPES[base.archetype],
    name: base.name,
    rarity: rd.key,
    rarityName: rd.name,
    tint: rd.color,
    tier: base.tier,
    level,
    seed,
    // Rolled numbers. Every one of these is read by the swing helpers below,
    // so the combo array stays shared and read-only across all instances.
    dmgMul: base.dmgMul * rd.mul * between(r, 0.94, 1.07),
    rate: (base.rate || 1) * between(r, 0.97, 1.04),
    reachMul: base.reachMul * between(r, 0.98, 1.03),
    arcMul: base.arcMul,
    knockMul: base.knockMul * between(r, 0.94, 1.08),
    critAdd: base.critAdd,
    critMul: base.critMul,
    moveMul: base.moveMul,
    leech: 0,
    combo: base.combo,
    chainWindow: base.chainWindow,
    affixes: [],
    blurb: base.blurb,
  };

  // Draw affixes without replacement so a "Cruel Cruel Riftedge" can't happen.
  const pool = AFFIX_KEYS.slice();
  for (let i = 0; i < rd.affixes && pool.length; i++) {
    const pick = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const a = AFFIXES[pick];
    const mag = between(r, a.lo, a.hi);
    a.apply(w, mag);
    w.affixes.push({ key: pick, name: a.name, mag });
  }

  w.cd = base.cd / w.rate;
  w.name = buildName(base, rd, w.affixes, r);
  // Single comparable number for "is this better than what I'm holding".
  const c = w.combo;
  let dmgSum = 0, timeSum = 0;
  for (let i = 0; i < c.length; i++) {
    dmgSum += c[i].dmg * (c[i].hits || 1);
    timeSum += c[i].windup + c[i].active + c[i].recovery;
  }
  w.dps = (dmgSum * w.dmgMul * w.rate) / Math.max(0.001, timeSum);
  w.score = Math.round(w.dps * 100 * (1 + w.critAdd * (w.critMul - 1)));
  return w;
}

function buildName(base, rd, affixes, rnd) {
  const prefix = affixes.length ? `${affixes[0].name} ` : '';
  const title = rd.key === 'legendary' || rd.key === 'epic'
    ? ` of ${TITLES[Math.floor(rnd() * TITLES.length)]}`
    : '';
  return `${prefix}${base.name}${title}`;
}

/** Pick a base weighted toward the player's depth, then roll it. */
export function rollDrop(rnd, { rankIndex = 0, level = 1, luck = 0 } = {}) {
  const eligible = [];
  let total = 0;
  for (let i = 0; i < WEAPON_LIST.length; i++) {
    const w = WEAPON_LIST[i];
    if (w.minRank > rankIndex) continue;
    // Weight peaks at the rank where a weapon becomes available and decays as
    // you outgrow it, so E-rank gates stop handing out starter swords forever.
    const gap = rankIndex - w.minRank;
    const weight = 1 / (1 + gap * 0.7);
    eligible.push({ w, weight });
    total += weight;
  }
  if (!eligible.length) return starterWeapon();
  let r = rnd() * total;
  let pickedId = eligible[0].w.id;
  for (let i = 0; i < eligible.length; i++) {
    r -= eligible[i].weight;
    if (r <= 0) { pickedId = eligible[i].w.id; break; }
  }
  return rollWeapon(pickedId, rnd, { level, luck });
}

/** The weapon you always have. Fixed roll so it is identical on every device. */
export function starterWeapon() {
  return rollWeapon('riftedge', 1, { rarity: 'common', level: 1 });
}

// Weapons are fully described by (base, rarity, seed, level) because rollWeapon
// consumes the stream in a fixed order — so the save file stores four fields
// instead of a snapshot that would drift the next time the tables are tuned.
export function serializeWeapon(w) {
  if (!w) return null;
  return { b: w.baseId, r: w.rarity, s: w.seed ?? 1, l: w.level ?? 1 };
}

export function deserializeWeapon(data) {
  if (!data || !WEAPONS[data.b]) return starterWeapon();
  return rollWeapon(data.b, data.s >>> 0, { rarity: data.r, level: data.l || 1 });
}

/** Flat rows for the UI, already formatted. */
export function weaponSummary(w) {
  const rows = [
    ['Class', w.arch.name],
    ['Power', `x${w.dmgMul.toFixed(2)}`],
    ['Combo', `${w.combo.length} hits`],
    ['Reach', `${(w.combo[0].range * w.reachMul).toFixed(1)}m`],
    ['Cooldown', `${w.cd.toFixed(2)}s`],
    ['Crit', `${w.critAdd >= 0 ? '+' : ''}${Math.round(w.critAdd * 100)}%  x${w.critMul.toFixed(2)}`],
  ];
  if (w.leech > 0) rows.push(['Leech', `${(w.leech * 100).toFixed(1)}%`]);
  return rows;
}

// ---------------------------------------------------------- mesh construction

function addPart(group, geometry, material, x, y, z, glow) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  if (glow) m.layers.enable(GLOW_LAYER);
  group.add(m);
  return m;
}

function buildSword(look, tint, ghost) {
  const g = new THREE.Group();
  const len = look.len ?? 1.5;
  const wd = look.width ?? 0.10;

  const blade = addPart(g, box(wd, len, 0.03), steelMat(tint, ghost), 0, len * 0.5 + 0.1, 0, false);
  // Only the largest part casts: a shadow map draw per pommel is not worth it.
  blade.castShadow = true;
  // Inset fuller — the strip that makes the blade read as lit rather than white.
  addPart(g, box(wd * 0.34, len * 0.78, 0.045), edgeMat(tint), 0, len * 0.5 + 0.1, 0, true);

  addPart(g, box(look.guard ?? 0.36, 0.08, 0.11), darkMat(ghost), 0, 0.06, 0, false);
  addPart(g, cyl(0.036, 0.042, 0.26, 6), haftMat(ghost), 0, -0.09, 0, false);
  addPart(g, octa(0.07), darkMat(ghost), 0, -0.24, 0, false);
  return g;
}

function buildGreatweapon(look, tint, ghost) {
  const g = new THREE.Group();
  const haft = look.haft ?? 1.85;
  const top = haft * 0.62;

  const pole = addPart(g, cyl(0.055, 0.065, haft, 6), haftMat(ghost), 0, haft * 0.5 - 0.38, 0, false);
  pole.castShadow = true;
  // Grip wrap: two dark bands so the hand position is readable at distance.
  addPart(g, cyl(0.07, 0.07, 0.16, 6), darkMat(ghost), 0, 0.02, 0, false);
  addPart(g, cyl(0.07, 0.07, 0.12, 6), darkMat(ghost), 0, -0.26, 0, false);

  if (look.head === 'maul') {
    // A solid block on a stick. Unmistakable from a top-down camera.
    const head = addPart(g, box(0.46, 0.44, 0.52), steelMat(tint, ghost), 0, top, 0, false);
    head.castShadow = true;
    addPart(g, box(0.5, 0.1, 0.56), darkMat(ghost), 0, top + 0.24, 0, false);
    addPart(g, box(0.5, 0.1, 0.56), darkMat(ghost), 0, top - 0.24, 0, false);
    addPart(g, box(0.08, 0.10, 0.60), edgeMat(tint), 0, top, 0, true);
    addPart(g, cone(0.07, 0.30, 4), darkMat(ghost), 0, top + 0.42, 0, false);
  } else {
    const bit = look.bit ?? 0.34;
    // Wide crescent bit forward, small counter-bit behind, spike above.
    const main = addPart(g, wedge(bit, 0.06), steelMat(tint, ghost), bit * 0.55, top, 0, false);
    main.scale.set(1.45, 1.15, 1);
    main.rotation.z = -Math.PI / 2;
    main.castShadow = true;
    const back = addPart(g, wedge(bit * 0.6, 0.055), steelMat(tint, ghost), -bit * 0.42, top, 0, false);
    back.scale.set(1.1, 1, 1);
    back.rotation.z = Math.PI / 2;
    addPart(g, box(0.05, bit * 1.5, 0.075), edgeMat(tint), bit * 1.05, top, 0, true);
    addPart(g, cone(0.06, 0.40, 4), steelMat(tint, ghost), 0, top + bit * 0.95, 0, false);
    addPart(g, cyl(0.09, 0.09, 0.14, 6), darkMat(ghost), 0, top, 0, false);
  }
  return g;
}

function buildDagger(look, tint, ghost) {
  const g = new THREE.Group();
  const len = look.len ?? 0.52;
  const wd = look.width ?? 0.07;
  const blade = addPart(g, box(wd, len, 0.022), steelMat(tint, ghost), 0, len * 0.5 + 0.07, 0, false);
  blade.castShadow = true;
  addPart(g, cone(wd * 0.7, 0.16, 4), steelMat(tint, ghost), 0, len + 0.14, 0, false);
  addPart(g, box(wd * 0.36, len * 0.7, 0.034), edgeMat(tint), 0, len * 0.5 + 0.07, 0, true);
  addPart(g, box(0.16, 0.045, 0.075), darkMat(ghost), 0, 0.05, 0, false);
  addPart(g, cyl(0.028, 0.032, 0.17, 6), haftMat(ghost), 0, -0.04, 0, false);
  return g;
}

function buildDaggers(look, tint, ghost) {
  const g = buildDagger(look, tint, ghost);
  // The offhand blade is reverse-gripped and reparented to the left fist by
  // equipWeapon — twin daggers have to actually be twin or the silhouette lies.
  const off = buildDagger(look, tint, ghost);
  off.rotation.set(Math.PI * 0.92, 0, 0.18);
  off.position.set(0, 0.04, -0.02);
  g.userData.offhand = off;
  return g;
}

function buildPolearm(look, tint, ghost) {
  const g = new THREE.Group();
  const shaft = look.shaft ?? 2.5;
  const tip = shaft * 0.6;

  const pole = addPart(g, cyl(0.045, 0.052, shaft, 6), haftMat(ghost), 0, shaft * 0.3, 0, false);
  pole.castShadow = true;
  addPart(g, cone(0.05, 0.22, 4), darkMat(ghost), 0, shaft * 0.3 - shaft * 0.5 - 0.05, 0, false)
    .rotation.x = Math.PI;
  addPart(g, cyl(0.06, 0.06, 0.1, 6), darkMat(ghost), 0, tip - 0.16, 0, false);

  if (look.head === 'glaive') {
    // Swept cleaver: a long wedge kicked off-axis so the outline is obviously
    // not a spear even when the shaft is foreshortened by the camera.
    const bladeGeo = box(0.10, 0.9, 0.028);
    const cleaver = addPart(g, bladeGeo, steelMat(tint, ghost), 0.14, tip + 0.42, 0, false);
    cleaver.rotation.z = -0.24;
    cleaver.castShadow = true;
    const hook = addPart(g, wedge(0.2, 0.05), steelMat(tint, ghost), 0.3, tip + 0.72, 0, false);
    hook.rotation.z = -0.9;
    addPart(g, box(0.038, 0.78, 0.045), edgeMat(tint), 0.17, tip + 0.44, 0, true).rotation.z = -0.24;
    addPart(g, cone(0.07, 0.26, 4), steelMat(tint, ghost), 0.24, tip + 0.92, 0, false).rotation.z = -0.24;
  } else {
    const head = addPart(g, cone(0.10, 0.52, 4), steelMat(tint, ghost), 0, tip + 0.34, 0, false);
    head.castShadow = true;
    addPart(g, box(0.03, 0.34, 0.06), edgeMat(tint), 0, tip + 0.32, 0, true);
    // Crossbar: stops the head reading as "stick with a point" at 10m.
    addPart(g, box(0.30, 0.035, 0.035), darkMat(ghost), 0, tip + 0.02, 0, false);
    addPart(g, octa(0.045), darkMat(ghost), 0.15, tip + 0.02, 0, false);
    addPart(g, octa(0.045), darkMat(ghost), -0.15, tip + 0.02, 0, false);
  }
  return g;
}

/**
 * Procedural mesh for a rolled weapon (or a bare archetype key).
 * The returned group's origin is the fist; +Y runs out along the weapon.
 * `group.userData.offhand`, when present, belongs in the left hand.
 */
export function buildWeaponMesh(weapon, { ghost = false } = {}) {
  const arch = typeof weapon === 'string'
    ? ARCHETYPES[weapon]
    : (weapon.arch || ARCHETYPES[weapon.archetype]);
  const base = typeof weapon === 'string' ? null : (weapon.base || WEAPONS[weapon.baseId]);
  const look = base ? base.look : {};
  const tint = (typeof weapon === 'string' ? RARITIES.common.color : weapon.tint) || RARITIES.common.color;
  const archKey = arch === ARCHETYPES.daggers ? 'daggers' : (base ? base.archetype : 'sword');

  const packed = buildPackMesh(weapon, archKey, ghost);
  if (packed) return packed;

  const g = (arch || ARCHETYPES.sword).build(look, tint, ghost);
  g.userData.archetype = archKey;
  return g;
}

// ------------------------------------------------------- CC0 item pack models
//
// The two additions that adopt public/models/items.glb. Everything above this
// point is the original procedural implementation and stays the fallback: the
// game must boot and play with public/models/ deleted entirely, so a null model
// source here is a normal state, not an error.
//
// setModelSource is injection rather than an import so weapons.js keeps its
// zero-dependency shape — it can still be loaded by a headless Node test with
// no GLB, no renderer and no fetch.

let _getModel = null;

/**
 * Point weapon construction at the item pack.
 * `getMesh` is models.getItemMesh: (name, { scale, clone }) -> Object3D | null.
 * Pass null to go back to purely procedural weapons.
 */
export function setModelSource(getMesh) {
  _getModel = typeof getMesh === 'function' ? getMesh : null;
}

// The pack is metre-mismatched against this game: its Sword is 2.30 units tall
// on a ~1.8-unit humanoid, so unscaled it is a sword taller than the hunter
// holding it.
//
// These started at the 0.4x models.js still defaults to, and were then checked
// against the actual rig in a screenshot — which is the only way to get this
// right. At 0.4x the pack Sword's tip lands at y 1.67, level with the shoulder,
// so the entire blade sits inside the arm mesh and the weapon reads as gone.
// Each value below puts the archetype's tip within ~0.1 of the procedural
// weapon it replaces (procedural sword tip ~1.6 above the fist, greataxe ~1.5,
// dagger ~0.66), which is the silhouette the game's combat was tuned around.
// `lift` is the third number, and it is the other half of the grip bug.
//
// Every items.glb weapon pivots at the GUARD and runs +Y up the blade, so its
// handle hangs BELOW the pivot. Dropping the pivot on the fist therefore puts
// the fist around the crossguard with the whole handle and pommel dangling
// free underneath — which is precisely what the audit crop shows: a wrapped
// grip and a pommel floating past an empty-looking hand. `lift` slides the
// model up its own axis so the MIDDLE OF THE HANDLE lands in the fist, which
// is the difference between "the weapon is parented to the hand" and "the
// character is holding the weapon". Procedural weapons need none of this:
// buildSword and friends already author the origin at the middle of the grip.
//
// LIFT IS NOT ONE NUMBER FOR ALL FOUR, and it is NOT a number you can guess off
// a screenshot — two passes tried and both stopped short, leaving the pommel on
// the knuckles with the fist closed around nothing. tools/grip-measure.mjs now
// derives it instead, and the rule it implements is:
//
//     lift = (where the fist sits along the shaft) - (handle length) / 2
//
// both terms measured on the LIVE, animated player: the fist from the posed skin
// vertices of the wrist and every phalanx, the handle from the model's own
// geometry. Measured on this rig the fist lands at about -0.176 along the shaft
// (a hand's length past the wrist socket, which is why every by-eye guess landed
// high), and the pack Sword's handle is 0.252 m at scale 0.60. That gives
// sword -0.05 and daggers -0.09, both confirmed against a rendered hand crop:
// the wrap now enters the top of the fist and the pommel emerges below it.
//
// A HAFT weapon is deliberately NOT on this rule. greataxe/maul/polearm have
// 0.5-1.5 m of shaft you may grip anywhere along, "mid-handle" would put the
// hands at the balance point of a pole, and their crops already read correctly.
// Do not "make them consistent".
//
// offhandLift exists because the offhand dagger is REVERSE-gripped: equipWeapon
// keeps the builder's ~180-degree X rotation, so that copy's local +Y points at
// the floor and the shared lift slides it the WRONG WAY — lowering the main
// hand raised the offhand out of its fist. It is a separate number because it is
// a separate direction, not because the two daggers differ.
export const PACK_FIT = {
  sword: { scale: 0.60, tilt: 0.16, lift: -0.05 },
  greataxe: { scale: 0.62, tilt: 0.10, lift: 0.22 },
  daggers: { scale: 0.50, tilt: 0.14, lift: -0.09, offhandLift: 0.14 },
  polearm: { scale: 0.55, tilt: 0.06, lift: 0.10 },
};

// Rarity is carried by swapping to the pack's own gold variants rather than by
// tinting: clones share materials with the source GLB, so mutating a material
// to tint one weapon would recolour every other copy of it in the scene.
const GOLDEN = new Set(['epic', 'legendary']);

/**
 * Node name in items.glb for a rolled weapon, or null when the pack has no
 * honest match and the procedural builder should be used instead.
 *
 * The polearm archetype has NO spear or glaive in this pack — the closest
 * things are an arrow and a dart, which read as ammunition, not a weapon. So
 * spears stay procedural rather than being given a wrong silhouette.
 */
export function weaponModelName(weapon) {
  if (!weapon) return null;
  const base = typeof weapon === 'string' ? null : (weapon.base || WEAPONS[weapon.baseId]);
  const archetype = typeof weapon === 'string'
    ? weapon
    : (weapon.archetype || base?.archetype || 'sword');
  const gold = GOLDEN.has(typeof weapon === 'string' ? 'common' : weapon.rarity) ? '_Golden' : '';

  switch (archetype) {
    case 'sword':
      return `Sword${gold}`;
    case 'greataxe':
      // The maul variant is a hammer, not an axe, and the pack has both — using
      // the axe for it would misread the one archetype whose finisher is a
      // ground pound.
      return base?.look?.head === 'maul' ? `Hammer_Double${gold}` : `Axe_Double${gold}`;
    case 'daggers':
      return `Dagger${gold}`;
    default:
      return null;
  }
}

/**
 * One pack model wrapped so equipWeapon's applyGrip has a clean node to pose.
 * `lift` overrides the archetype's, which only the reverse-gripped offhand
 * needs — see PACK_FIT.daggers.offhandLift.
 */
function packPart(name, archKey, lift) {
  const fit = PACK_FIT[archKey] || PACK_FIT.sword;
  const holder = _getModel(name, { scale: fit.scale });
  if (!holder) return null;
  // applyGrip overwrites position/rotation on the group it is handed, so the
  // scale, the outboard tilt and the handle lift all live one level down where
  // they survive. The lift is applied along the OUTER group's +Y (the blade
  // axis after applyGrip has posed it), so it slides the model along its own
  // length rather than dragging it off the hand sideways.
  holder.rotation.z = fit.tilt;
  holder.position.y = lift ?? fit.lift;
  const outer = new THREE.Group();
  outer.add(holder);
  outer.userData.archetype = archKey;
  outer.userData.packModel = name;
  return outer;
}

function buildPackMesh(weapon, archKey, ghost) {
  // Shadow soldiers are translucent. Pack materials are shared across every
  // clone, so making one instance transparent would ghost the player's weapon
  // too — the procedural builder already has a per-instance ghost path.
  if (!_getModel || ghost) return null;
  const name = weaponModelName(weapon);
  if (!name) return null;
  const g = packPart(name, archKey);
  if (!g) return null;

  if (archKey === 'daggers') {
    const off = packPart(name, archKey, PACK_FIT.daggers.offhandLift);
    if (off) {
      // Same reverse grip the procedural builder authors, so equipWeapon's
      // offhand handling below needs no special case for pack models.
      off.rotation.set(Math.PI * 0.92, 0, 0.18);
      off.position.set(0, 0.04, -0.02);
      g.userData.offhand = off;
    }
  }
  return g;
}

// ------------------------------------------------- weapons for everyone else
//
// The player's weapon is a rolled instance out of the tables above. Enemies,
// bosses and shadow soldiers do not roll: they just need something in the fist
// that reads as a weapon at play distance.
//
// Until now they all got `swordMesh` out of entities.js — a 1.5-unit untapered
// box painted 0xdfe6ff with emissiveIntensity 0.7 on the glow layer. The
// independent review of the shipped build called it exactly what it is: "a long
// untapered pure-white bar, brighter and often longer than the body carrying
// it... they look like fluorescent tubes." Every one of these now comes out of
// items.glb instead, and the plank survives only as the offline fallback for a
// build shipped without public/models/.

/**
 * Held-weapon kinds, mapped onto items.glb node names.
 *
 * Scales are in the same space PACK_FIT above uses: the pack is
 * metre-mismatched against this game (its Sword is 2.30 units tall on a
 * ~2.14-unit humanoid), and these land each model's tip within ~0.1 of the
 * procedural weapon it replaces, which is the silhouette the combat was tuned
 * around. `tilt` rotates the model away from the body so the blade clears the
 * arm instead of rendering inside it — see the PACK_FIT note above.
 */
// `grip` is the same shape ARCHETYPES.grip uses: offsets layered on the hand
// socket plus a resting pitch, per weapon CLASS, so an axe hangs low off the
// fist, a hammer rests back over the forearm and a dagger rides high and
// steeply raked instead of every kind sharing the sword's one pose. rx is the
// resting pitch about the fist; without it every weapon points the same way
// out of every hand, which is exactly the "not actually holding it" read.
// The rx values are large on purpose. These models pivot at the guard and run
// straight up +Y, which on an arms-down idle puts the whole blade INSIDE the
// body silhouette — measured on a spawned lancer: blade box x[-0.25,0.06]
// against a torso half-width of ~0.3, i.e. invisible from behind and "not
// held" from the front. ~30-40 degrees of forward pitch pushes the head clear
// of the silhouette from every angle.
// SIGNS CORRECTED HERE FOR THE SAME REASON AS ARCHETYPES.grip above: every rx
// and every tilt in this table used to be negative, which pitched the blade
// backward into the torso and leaned it across the chest. `lift` is new and is
// what actually puts the handle in the fist rather than the crossguard.
export const HELD_MODELS = {
  // The three short-handled entries carry the SAME correction PACK_FIT
  // documents, from the same measurement: enemies hold the same guard-pivoted
  // models on the same rig, so "pommel on the knuckles" was never a
  // player-only bug — tools/grip-measure.mjs audits these kinds too, and the
  // npc-sword crop showed it as plainly as the player's did. The haft entries
  // below measured correct and are deliberately left alone.
  sword: { item: 'Sword', scale: 0.60, tilt: 0.16, lift: -0.05, grip: { y: 0, z: 0.06, rx: 0.36 } },
  // Sword_big is NOT "the sword, bigger", and it is the one model the geometry
  // rule mispredicts: its pivot sits partway UP the grip rather than at the
  // guard, so grip-measure's handle-below-pivot reads 0.091 m and asks for
  // -0.10, and -0.10 still left the pommel resting on the knuckles. -0.22 comes
  // off a rendered sweep of the hand crop (-0.10 / -0.16 / -0.22 / -0.28): it is
  // where the guard clears the top of the fist and the pommel emerges under it,
  // and -0.28 has begun to bury the guard again. Measure the render, not the
  // pivot, when the two disagree.
  bigsword: { item: 'Sword_big', scale: 0.52, tilt: 0.12, lift: -0.22, grip: { y: -0.02, z: 0.07, rx: 0.30 } },
  axe: { item: 'Axe_small', scale: 0.62, tilt: 0.14, lift: 0.12, grip: { y: -0.02, z: 0.06, rx: 0.34 } },
  greataxe: { item: 'Axe_Double', scale: 0.62, tilt: 0.10, lift: 0.22, grip: { y: -0.02, z: 0.08, rx: 0.26 } },
  hammer: { item: 'Hammer_Double', scale: 0.60, tilt: 0.10, lift: 0.22, grip: { y: -0.03, z: 0.08, rx: 0.26 } },
  dagger: { item: 'Dagger', scale: 0.55, tilt: 0.14, lift: -0.09, grip: { y: 0.02, z: 0.07, rx: 0.50 } },
  // A bow is carried ACROSS the body, not raised, so it keeps the shallowest
  // pitch of the set — and it is gripped at the riser, which is the middle of
  // the model rather than one end, hence lift 0.
  bow: { item: 'Bow_Wooden', scale: 0.62, tilt: 0.06, lift: 0, grip: { y: 0, z: 0.05, rx: 0.14 } },
};

/**
 * What each archetype carries when it is NOT a creature with its own kit.
 *
 * null means empty hands, and that is a real answer rather than a gap: a
 * hexcaster casts, a howler screams, and a monster with claws is better served
 * by claws than by a weapon it was never modelled to hold.
 */
export const ENEMY_WEAPON_KIND = {
  grunt: 'axe',
  stalker: 'dagger',
  brute: 'hammer',
  caster: null,
  lancer: 'bigsword',
  howler: null,
  boss: 'bigsword',
  // Shadow soldiers are raised hunters and carry a hunter's sword.
  shadow: 'sword',
  player: 'sword',
};

export function enemyWeaponKind(archetype) {
  return Object.prototype.hasOwnProperty.call(ENEMY_WEAPON_KIND, archetype)
    ? ENEMY_WEAPON_KIND[archetype]
    : null;
}

// ONE DRAW CALL PER HELD WEAPON.
//
// Every weapon in items.glb is 4-5 primitives split by flat colour (Steel,
// LightSteel, DarkSteel, LightWood, DarkWood) with nothing but POSITION and
// NORMAL on them. Handing one of those to a shadow soldier straight out of the
// pack costs 4-5 draw calls where the procedural plank cost 1, and
// tools/character-test.mjs caught exactly that: a 21-strong crowd went from 5
// to 8.05 calls per character the moment enemies stopped carrying planks.
//
// So the colours are baked into a Uint8 vertex-colour attribute once per item
// and the primitives merge into a single geometry against a single material —
// the same trick characters.js uses on the 12-primitive bodies. Cached by item
// name and shared by every instance, so it costs one merge per weapon KIND for
// the life of the process.
//
// The player's weapon deliberately does NOT go through here: packPart above
// keeps the pack's own per-part materials, and there is exactly one player.

const _heldGeo = new Map();
const _col = new THREE.Color();

/**
 * Copy an attribute into plain Float32 storage, decoding any normalization.
 *
 * items.glb is quantized: positions are raw Uint16 with the dequantisation
 * carried in the node matrices (KHR_mesh_quantization), normals are packed
 * ints. That is fine while the node transform is alive — but this pipeline
 * BAKES matrixWorld into the vertices, and BufferAttribute.applyMatrix4
 * writes its float results straight back into the integer array. Every vertex
 * truncated to almost-zero and each held weapon rendered as an invisible
 * point cloud: armed enemies looked EMPTY-HANDED in every shipped build.
 * Floating the attributes first is what makes the bake legal.
 */
function toFloatAttribute(att) {
  if (att.array instanceof Float32Array && !att.normalized) return att.clone();
  const out = new Float32Array(att.count * att.itemSize);
  for (let i = 0; i < att.count; i++) {
    for (let j = 0; j < att.itemSize; j++) out[i * att.itemSize + j] = att.getComponent(i, j);
  }
  return new THREE.BufferAttribute(out, att.itemSize, false);
}

function bakeColour(mesh) {
  const g = mesh.geometry.clone();
  for (const name of ['position', 'normal']) {
    if (g.attributes[name]) g.setAttribute(name, toFloatAttribute(g.attributes[name]));
  }
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

/** Merged, vertex-coloured geometry for one item-pack model. Null if absent. */
function mergedItemGeometry(name) {
  if (_heldGeo.has(name)) return _heldGeo.get(name);
  let merged = null;
  const src = _getModel ? _getModel(name, { scale: 1 }) : null;
  if (src) {
    // The holder is a fresh Group at the origin, so matrixWorld here is exactly
    // the part's offset inside the model — which has to be baked in, because
    // after the merge there are no part nodes left to carry it.
    src.updateMatrixWorld(true);
    const parts = [];
    src.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const g = bakeColour(o);
      g.applyMatrix4(o.matrixWorld);
      parts.push(g);
    });
    if (parts.length) {
      try {
        merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
      } catch {
        merged = null;
      }
      if (merged && parts.length > 1) for (const p of parts) p.dispose();
      else if (!merged) for (const p of parts) p.dispose();
    }
  }
  if (merged) merged.userData.shared = true;
  // Cache the null too: a missing model must not re-walk the pack every spawn.
  _heldGeo.set(name, merged);
  return merged;
}

function heldMaterial() {
  return cachedMat('held', () => new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    // Between the pack's Steel and its Wood, because one material now serves
    // both. At the size a held weapon occupies on a phone screen the split was
    // never legible; the draw call was.
    metalness: 0.55,
    roughness: 0.42,
    envMapIntensity: 1.4,
    // NOT FrontSide: mergedItemGeometry bakes node matrixWorld into the
    // vertices, and several items.glb nodes carry mirrored (negative
    // determinant) transforms, which flips their triangle winding. Under the
    // default FrontSide every such weapon back-face-culled to nothing — armed
    // enemies rendered EMPTY-HANDED, swinging at you with a bare fist while a
    // fully-built invisible axe hung in the socket. The pack's own materials
    // are doubleSided for the same reason; these few hundred triangles are not
    // where the fill-rate budget lives.
    side: THREE.DoubleSide,
  }));
}

/**
 * Translucent copy of a pack weapon for a shadow or a corpse.
 *
 * NOT cached and NOT flagged shared, deliberately, both times for the same
 * reason: game.js fades a decaying corpse by writing material.opacity on every
 * transparent mesh it can reach, so one shared ghost material would fade every
 * shadow on the field along with it.
 */
function ghostHeldMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9fd8ff,
    vertexColors: true,
    emissive: new THREE.Color(0x35e6ff),
    emissiveIntensity: 0.30,
    metalness: 0.55,
    roughness: 0.35,
    transparent: true,
    opacity: 0.7,
    // DoubleSide for the same mirrored-winding reason as heldMaterial. The
    // transparent-speckle risk FrontSide was guarding is minor on a blade-thin
    // shape, and an invisible weapon is strictly worse.
    side: THREE.DoubleSide,
  });
  mat.userData = {};   // NOT shared: disposeObject3D must be allowed to free it
  return mat;
}

/**
 * A ready-to-parent held weapon for a non-player character.
 *
 * The returned group is already positioned at the hand socket, so a caller with
 * a bone socket (or the procedural rig's arm mesh) only has to `.add()` it.
 * Returns NULL when the item pack has not loaded or has no model for the kind
 * — that is a normal state in an offline build, and the caller decides whether
 * empty hands or a procedural fallback is the better answer.
 */
export function buildHeldWeapon(kind, { ghost = false } = {}) {
  const spec = HELD_MODELS[kind];
  if (!spec || !_getModel) return null;
  const geometry = mergedItemGeometry(spec.item);
  if (!geometry) return null;

  const mesh = new THREE.Mesh(geometry, ghost ? ghostHeldMaterial() : heldMaterial());
  mesh.castShadow = true;
  const holder = new THREE.Group();
  holder.name = spec.item;
  holder.add(mesh);
  holder.scale.setScalar(spec.scale);
  holder.rotation.z = spec.tilt;
  // See PACK_FIT.lift: the pack pivots at the guard, so without this the fist
  // closes on the crossguard and the whole handle hangs below it.
  holder.position.y = spec.lift || 0;

  const outer = new THREE.Group();
  outer.add(holder);
  const grip = spec.grip || {};
  outer.position.set(
    HAND_SOCKET.x,
    HAND_SOCKET.y + (grip.y || 0),
    HAND_SOCKET.z + (grip.z ?? 0.06),
  );
  outer.rotation.set(grip.rx ?? -0.25, grip.ry || 0, grip.rz || 0);
  outer.userData.packModel = spec.item;
  outer.userData.heldKind = kind;
  return outer;
}

// ------------------------------------------------------------ equip and swap

function handSocket(rig, side) {
  const explicit = side === 'L' ? rig.handL : rig.hand;
  if (explicit) return explicit;
  // Fall back to the limb mesh inside the shoulder pivot group, which is where
  // makeHumanoid already parents the hardcoded weapon.
  const arm = side === 'L' ? rig.armL : rig.armR;
  if (!arm) return null;
  for (let i = 0; i < arm.children.length; i++) if (arm.children[i].isMesh) return arm.children[i];
  return arm;
}

function applyGrip(group, arch) {
  const grip = arch.grip;
  group.position.set(HAND_SOCKET.x, HAND_SOCKET.y + (grip.y || 0), HAND_SOCKET.z + (grip.z || 0));
  group.rotation.set(grip.rx || 0, grip.ry || 0, grip.rz || 0);
}

/**
 * Attach `weapon` to a humanoid built by makeHumanoid, detaching whatever it
 * was holding. Nothing is disposed: geometry and materials are shared cache
 * entries, and dropping a material would cost a shader recompile on the next
 * equip. Pass `null` to leave the character empty-handed.
 */
export function equipWeapon(root, weapon, { ghost = false } = {}) {
  unequipWeapon(root);
  if (!weapon) return null;

  const rig = root.userData?.rig;
  if (!rig) return null;
  const arch = weapon.arch || ARCHETYPES[weapon.archetype] || ARCHETYPES.sword;

  const main = buildWeaponMesh(weapon, { ghost });
  const offhand = main.userData.offhand || null;
  if (offhand) main.remove(offhand);

  const rHand = handSocket(rig, 'R');
  if (!rHand) return null;
  applyGrip(main, arch);
  rHand.add(main);

  if (offhand) {
    const lHand = handSocket(rig, 'L');
    if (lHand) {
      const base = offhand.rotation.clone();
      applyGrip(offhand, arch);
      // Keep the reverse grip the builder authored, layered on the hand pose.
      offhand.rotation.x += base.x;
      offhand.rotation.z = base.z - (arch.grip.rz || 0);
      lHand.add(offhand);
    }
  }

  // Existing code reads rig.blade for the held weapon; keep that contract.
  rig.blade = main;
  root.userData.weapon = {
    instance: weapon, main, offhand, ghost,
    // The DRAWN pose, captured the moment it is authored. setStance restores
    // from this rather than recomputing, because the offhand dagger's reverse
    // grip is a rotation the BUILDER authored and equipWeapon layered on top —
    // recomputing it from the archetype alone would quietly lose the reverse.
    hold: {
      main: snapshot(main),
      offhand: offhand ? snapshot(offhand) : null,
    },
    stance: 'drawn',
  };
  // A skinned character idles differently with a blade out (Idle_Sword) and
  // attacks with a slash instead of a punch — tell it the fist is full.
  root.userData.character?.setArmed?.(true);
  // Equipping while sheathed keeps the new weapon sheathed. The panel shows it
  // on the back, which is the honest read: stance is a property of the
  // CHARACTER, not of the item, so swapping the item must not silently draw.
  if (root.userData.stance === 'sheathed') setStance(root, 'sheathed');
  return main;
}

/** Detach the current weapon and return the instance that was held. */
export function unequipWeapon(root) {
  const held = root?.userData?.weapon;
  if (!held) return null;
  held.main?.parent?.remove(held.main);
  held.offhand?.parent?.remove(held.offhand);
  if (root.userData.rig) root.userData.rig.blade = null;
  root.userData.weapon = null;
  root.userData.character?.setArmed?.(false);
  return held.instance;
}

export function currentWeapon(root) {
  return root?.userData?.weapon?.instance || null;
}

// ------------------------------------------------------------- stow and draw
//
// "when they are in the plaza, the sword can be visible or placed in the
// inventory" — the owner. A stance is 'drawn' or 'sheathed', it lives on the
// CHARACTER and it is NOT PERSISTED: a resumed save re-derives it from where
// the player is standing and what is near him. Persisting it would create a
// third source of truth about what is in the hand, alongside the equipment
// record and root.userData.weapon.
//
// HARD RULE: RE-PARENT ONLY. Nothing here creates geometry, creates a material
// or disposes anything. The asset-cache note at the top of this file measured a
// material dispose at 8-60 ms of shader recompile on a mid-range Android, and a
// stow that rebuilt the mesh would pay that every time the player walked into
// the plaza. It is also why a stowed weapon is the SAME object re-parented and
// not a second hidden mesh: a hidden mesh still costs a matrix update and a
// frustum test, and two meshes is how a stow feature becomes a permanent draw
// call in a 24-call dungeon budget.

/**
 * Where each archetype rides when it is put away, and how.
 *
 * The transform is expressed in the stow socket's own space, which is
 * character-aligned and character-scaled (characters.js makeSocket), so these
 * numbers are metres and radians on a 2.14-unit humanoid and mean the same
 * thing on the procedural box-man. `socket` is a NAME rather than just a
 * transform precisely because twin daggers ride at the HIPS while everything
 * else rides on the BACK.
 *
 * Rotations follow the same composite as the grips above: for a rotation
 * (rx, 0, rz) the model's +Y axis ends up at (-sin rz, cos rz * cos rx,
 * cos rz * sin rx). An rx near ±pi is a weapon carried point-DOWN.
 */
export const STOW = {
  // Hilt over the right shoulder where the hand can reach it, blade running
  // down across the back to the left hip. Point-down, hence rx near -pi.
  sword: { socket: 'back', x: -0.16, y: 0.16, z: -0.20, rx: -3.02, ry: 0, rz: -0.40 },
  // Head UP over the shoulder, haft butt near the hip: a greataxe carried
  // point-down would put a 40 cm bit through the back of the character's knee.
  greataxe: { socket: 'back', x: -0.05, y: -0.40, z: -0.30, rx: -0.10, ry: 0, rz: -0.28 },
  // Near vertical. A 2.5 m shaft raked as hard as a sword pushes the butt
  // through the floor at one end and the point through the head at the other.
  polearm: { socket: 'back', x: 0.02, y: -0.80, z: -0.30, rx: -0.08, ry: 0, rz: -0.16 },
  // ONE PER HIP, which is the whole reason this table carries a socket name.
  daggers: {
    socket: 'hip', x: -0.26, y: 0.01, z: -0.12, rx: -2.94, ry: 0, rz: -0.10,
    offhand: { x: 0.26, y: 0.01, z: -0.12, rx: -2.94, ry: 0, rz: 0.10 },
  },
};

/**
 * Seconds to bring the weapon out. The mass law applied to one more verb: a
 * greataxe player who let it sheath while wandering pays for that the moment
 * something jumps him, a dagger player pays almost nothing. Without this,
 * stow/draw is a free cosmetic toggle and mass stops being a real property.
 */
export function drawTime(weapon) {
  const arch = weapon?.arch || ARCHETYPES[weapon?.archetype] || null;
  const mass = arch?.mass ?? 1.4;
  return Math.min(0.45, 0.18 + 0.035 * mass);
}

function snapshot(obj) {
  return {
    px: obj.position.x, py: obj.position.y, pz: obj.position.z,
    rx: obj.rotation.x, ry: obj.rotation.y, rz: obj.rotation.z,
  };
}

function restore(obj, s) {
  obj.position.set(s.px, s.py, s.pz);
  obj.rotation.set(s.rx, s.ry, s.rz);
}

/**
 * The stow anchor for `name`, with a fallback chain that ends somewhere real.
 *
 * The procedural box-man carries explicit rig.back / rig.hip anchors (see
 * entities.js) so the game still stows correctly with public/models/ deleted;
 * the last resort is the torso, which puts the weapon in roughly the right
 * place rather than at the character's feet.
 */
function stowSocket(rig, name) {
  if (!rig) return null;
  return (name === 'hip' ? rig.hip : rig.back) || rig.back || rig.hip || rig.torso || rig.body || null;
}

/** 'drawn' | 'sheathed' — what this character is currently doing with it. */
export function weaponStance(root) {
  return root?.userData?.stance || 'drawn';
}

/**
 * Move the equipped weapon between the fist and its stow socket.
 *
 * Returns the stance actually applied, which is NOT always the one asked for:
 * a character holding nothing, or an archetype with no STOW entry, stays
 * drawn. Callers should believe the return value, not the argument.
 */
export function setStance(root, stance) {
  const want = stance === 'sheathed' ? 'sheathed' : 'drawn';
  const held = root?.userData?.weapon;
  if (!held || !held.main) {
    // Remember the intent anyway: equipping later should honour it.
    if (root?.userData) root.userData.stance = want;
    return want;
  }
  const rig = root.userData.rig;
  const arch = held.instance?.arch || ARCHETYPES[held.instance?.archetype] || ARCHETYPES.sword;
  const archKey = held.main.userData.archetype
    || (arch === ARCHETYPES.daggers ? 'daggers' : held.instance?.base?.archetype)
    || 'sword';
  const table = STOW[archKey];

  if (want === 'sheathed') {
    const socket = table ? stowSocket(rig, table.socket) : null;
    // No anchor and no table both mean "this rig cannot put it away"; saying so
    // by returning 'drawn' is better than hiding the weapon inside the pelvis.
    if (!socket) { root.userData.stance = 'drawn'; return 'drawn'; }
    socket.add(held.main);
    held.main.position.set(table.x, table.y, table.z);
    held.main.rotation.set(table.rx, table.ry || 0, table.rz);
    if (held.offhand) {
      const off = table.offhand || table;
      const offSocket = stowSocket(rig, off.socket || table.socket);
      offSocket?.add(held.offhand);
      held.offhand.position.set(off.x, off.y, off.z);
      held.offhand.rotation.set(off.rx, off.ry || 0, off.rz);
    }
    // The free win: setArmed(false) swaps the idle back to the neutral
    // arms-down clip and invalidates the cached action, so sheathing produces
    // the relaxed plaza walk with no additional animation work.
    root.userData.character?.setArmed?.(false);
  } else {
    const rHand = handSocket(rig, 'R');
    if (!rHand) { root.userData.stance = 'sheathed'; return 'sheathed'; }
    rHand.add(held.main);
    restore(held.main, held.hold.main);
    if (held.offhand && held.hold.offhand) {
      const lHand = handSocket(rig, 'L');
      if (lHand) {
        lHand.add(held.offhand);
        restore(held.offhand, held.hold.offhand);
      }
    }
    root.userData.character?.setArmed?.(true);
  }

  held.stance = want;
  root.userData.stance = want;
  return want;
}

// --------------------------------------------------------- swing state machine
//
// Replaces player.swing / swingHitApplied / comboIndex / comboTimer in game.js.
// Nothing in here allocates: the tick reads step objects straight out of the
// shared combo table and hands them to a caller-supplied callback.

const PHASE_IDLE = 0, PHASE_WINDUP = 1, PHASE_ACTIVE = 2, PHASE_RECOVER = 3;

export function makeAttackState() {
  return {
    active: false,
    index: 0,        // step currently running
    next: 0,         // step the following press will run
    t: 0,            // seconds elapsed inside the current step, rate-scaled
    phase: PHASE_IDLE,
    hits: 0,         // damage applications already made this step
    cd: 0,           // shared attack cooldown
    chain: 0,        // seconds of combo window left after a step ends
    lunge: 0,        // forward impulse the caller should consume this frame
    buffered: false, // a press arrived too early and is waiting
  };
}

export function currentStep(state, w) {
  return state.active ? w.combo[state.index] : null;
}

export function canAttack(state, w) {
  if (state.cd > 0) return false;
  if (!state.active) return true;
  const step = w.combo[state.index];
  const total = step.windup + step.active + step.recovery;
  // Only the tail of the recovery accepts the next input. A greataxe step sets
  // cancel small relative to its recovery, so it stays a real commitment.
  return state.t >= total - step.cancel;
}

/** Begin the next combo step. Returns the step, or null if the input was eaten. */
export function startAttack(state, w) {
  if (!canAttack(state, w)) {
    if (state.active) state.buffered = true;
    return null;
  }
  // `next` is the authoritative cursor; tickAttack rewinds it to 0 when the
  // chain window lapses. Reading `chain` here instead would drop every cancel
  // back to the opener, because chain is only armed once a step has ended.
  const idx = state.next % w.combo.length;
  const step = w.combo[idx];
  state.active = true;
  state.index = idx;
  state.next = idx + 1;
  state.t = 0;
  state.phase = PHASE_WINDUP;
  state.hits = 0;
  state.chain = 0;
  state.cd = w.cd;
  state.lunge = step.lunge || 0;
  state.buffered = false;
  return step;
}

/**
 * Advance the swing. `onHit(step, hitIndex, ctx)` fires once per damage
 * application; the step object is shared table data, so treat it as read-only.
 */
export function tickAttack(state, w, dt, onHit, ctx) {
  if (state.cd > 0) state.cd = Math.max(0, state.cd - dt);
  if (!state.active) {
    if (state.chain > 0) {
      state.chain -= dt;
      if (state.chain <= 0) { state.chain = 0; state.next = 0; }
    }
    return;
  }

  const step = w.combo[state.index];
  // Attack rate scales the clock rather than the table, so a "Quick" roll
  // speeds up the whole swing without cloning per-instance combo steps.
  state.t += dt * w.rate;

  if (state.phase === PHASE_WINDUP && state.t >= step.windup) state.phase = PHASE_ACTIVE;

  if (state.phase === PHASE_ACTIVE) {
    const total = step.hits || 1;
    const span = total > 1 ? step.active / total : 0;
    while (state.hits < total && state.t >= step.windup + span * state.hits) {
      if (onHit) onHit(step, state.hits, ctx);
      state.hits++;
    }
    if (state.t >= step.windup + step.active) state.phase = PHASE_RECOVER;
  }

  if (state.phase === PHASE_RECOVER && state.t >= step.windup + step.active + step.recovery) {
    state.active = false;
    state.phase = PHASE_IDLE;
    state.chain = w.chainWindow;
  }
}

/** True once, for a press that arrived mid-swing and is now due. */
export function consumeBuffer(state) {
  if (!state.buffered) return false;
  state.buffered = false;
  return true;
}

/** Take the pending forward impulse for this frame, in metres. */
export function consumeLunge(state) {
  const l = state.lunge;
  state.lunge = 0;
  return l;
}

/** Hard reset — death, gate transition, or a swap mid-swing. */
export function cancelAttack(state) {
  state.active = false;
  state.phase = PHASE_IDLE;
  state.hits = 0;
  state.t = 0;
  state.chain = 0;
  state.next = 0;
  state.lunge = 0;
  state.buffered = false;
}

/** Movement multiplier for the frame: heavy weapons nearly root you. */
export function moveScale(state, w) {
  if (!state.active) return w.moveMul;
  return w.moveMul * (w.combo[state.index].move ?? 0.35);
}

/** Dash and other escapes should be refused while this is true. */
export function isCommitted(state, w) {
  return state.active && state.t < w.combo[state.index].lock;
}

/** 1 -> 0 across the step, matching animateRig's existing attackPhase input. */
export function attackPhase(state, w) {
  if (!state.active) return 0;
  const step = w.combo[state.index];
  const total = step.windup + step.active + step.recovery;
  return 1 - Math.min(1, state.t / total);
}

// Reused across frames — copy what you need, do not hold the reference.
const _anim = { phase: 0, windup: 0.3, lo: -1.5, hi: 1.9, twist: 0.22, twoHand: false, thrust: false, mirror: false };

/** Everything animateRig needs to pose a swing for this archetype. */
export function attackAnim(state, w) {
  const a = w.arch.anim;
  _anim.lo = a.lo; _anim.hi = a.hi; _anim.twist = a.twist;
  _anim.twoHand = a.twoHand; _anim.thrust = a.thrust;
  if (!state.active) {
    _anim.phase = 0; _anim.windup = 0.3; _anim.mirror = false;
    return _anim;
  }
  const step = w.combo[state.index];
  const total = step.windup + step.active + step.recovery;
  _anim.phase = 1 - Math.min(1, state.t / total);
  // Placing the chop at the real windup fraction is what keeps the visual
  // contact frame on the frame damage is actually applied.
  _anim.windup = step.windup / total;
  // Daggers alternate hands so five hits don't read as one arm flailing.
  _anim.mirror = a.alternate && (state.index % 2 === 1);
  return _anim;
}

// ---------------------------------------------------------------- hit maths
//
// One place where a weapon's rolled multipliers meet a combo step, so game.js
// never has to remember which of the two owns which factor.

export function hitDamage(w, step, atk) { return atk * w.dmgMul * step.dmg; }
export function hitRange(w, step) { return step.range * w.reachMul; }
export function hitArc(w, step) { return step.arc * w.arcMul; }
export function hitKnockback(w, step) { return step.knock * w.knockMul; }
export function hitStagger(w, step) { return step.stagger || 0; }
export function isRadial(step) { return step.arc >= Math.PI * 1.99; }
