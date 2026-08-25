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
    // less: a haft angled hard forward reads as "carrying a shovel". rz was
    // 0.06 (matched to the greatsword) until an owner pass on the shipped
    // build: a haft this close to dead vertical reads as a flagpole rather
    // than a held weapon, even two-handed. 0.14 — a bit over double —
    // measured against grip-check's bladeDir gives it clearly more lateral
    // lean than the greatsword's 0.06 while staying well short of the
    // one-handed axe's own bump below, which is the "two hands, still
    // canted" read a held greataxe should have.
    name: 'Greataxe', feel: 'Slow, enormous, wide. You are committed the moment you press.',
    build: buildGreatweapon,
    grip: { y: -0.02, z: 0.08, rx: 0.26, rz: 0.14 },
    anim: { lo: -2.30, hi: 2.40, twist: 0.42, twoHand: true, thrust: false, alternate: false },
    mass: 4.8,
  },
  greatsword: {
    // RPG_SPEC weaponFamilies.greatsword: grip lifted from the already-measured
    // HELD_MODELS.bigsword (the lancer and the boss have carried Sword_big since
    // the pack landed, so its y/z/rx were tuned on a spawned lancer, not
    // guessed). rz 0.06 matches the greataxe: a two-hander hangs near the
    // centre line and leans only slightly outboard.
    name: 'Greatsword', feel: 'Linear and committed. It stops things dead rather than launching them.',
    build: buildGreatsword,
    grip: { y: -0.02, z: 0.07, rx: 0.30, rz: 0.06 },
    // Winds further than the sword, not as far as the greataxe — mass 3.6 sits
    // between their 1.4 and 4.8 and the shoulder arc should read that way.
    anim: { lo: -2.10, hi: 2.20, twist: 0.36, twoHand: true, thrust: false, alternate: false },
    mass: 3.6,
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
  axe: {
    // RPG_SPEC weaponFamilies.axe: grip lifted from HELD_MODELS.axe — grunts
    // have carried Axe_small on this rig since the pack landed, so y/z/rx are
    // measured numbers. rz was 0.08 — SMALLER than the sword's 0.10 despite
    // the axe being the weapon whose head is heaviest and most off-axis, the
    // one that should hang the LEAST like a flagpole of the one-handers. An
    // owner pass on the shipped build called it out directly: "it shouldn't
    // just be up and down, it should actually be somewhat sideways... that
    // way it looks natural the way you're holding it." 0.22 (measured with
    // grip-check's bladeDir against the packed Axe_small + its 0.14 forearm
    // tilt) puts the blade's lateral offset clearly past the sword's, which
    // is the point — a hand axe should read as more canted than a sword,
    // not less.
    name: 'Hand Axe', feel: 'Mid speed, mid reach, and a hook — nothing it touches gets to leave.',
    build: buildHandAxe,
    grip: { y: -0.02, z: 0.06, rx: 0.34, rz: 0.22 },
    anim: { lo: -1.80, hi: 2.05, twist: 0.30, twoHand: false, thrust: false, alternate: false },
    mass: 2.1,
  },
  bow: {
    // RPG_SPEC weaponFamilies.bow: grip lifted VERBATIM from HELD_MODELS.bow
    // below (same sign-corrected frame as every other entry) — the shallowest
    // pitch of the set, because a bow is carried across the body, not raised.
    // `mainHand: 'L'` is the family's one structural demand: adventurers.json
    // confirms the convention (adv_bow attaches to handslot_l, adv_arrow to
    // handslot_r), and equipWeapon honours the flag rather than assuming 'R'.
    // `ranged: true` is what routes game.js's attack input to draw-hold-release
    // instead of the swing machine — the family has no melee arc AT ALL.
    name: 'Bow', feel: 'Hold to draw, release to loose. Useless inside arm\'s reach — that is the trade.',
    build: buildBow,
    grip: { y: 0, z: 0.05, rx: 0.14, rz: 0.06 },
    // Barely winds: the shot is the projectile, not the arm.
    anim: { lo: -0.40, hi: 0.60, twist: 0.05, twoHand: false, thrust: true, alternate: false },
    mass: 1.1,
    mainHand: 'L',
    ranged: true,
  },
  staff: {
    // RPG_SPEC weaponFamilies.staff. The spec's grip { y 0.02, z 0.10,
    // rx -0.28 } was authored BEFORE two corrections this table now carries:
    // the rx sign flip documented at the top of ARCHETYPES (its -0.28 meant
    // "0.28 of forward pitch", which is +rx in the corrected frame), and the
    // polearm's z lesson (a near-upright pole does not fold a forward offset
    // into its pitch, so z 0.10 puts the shaft visibly outside the closed
    // fist — 0.03 threads it through the fingers). Magnitudes kept, frame
    // corrected; pitched slightly more than the polearm's 0.16 because the
    // staff is 0.7 m shorter and can afford the lean without the butt
    // sweeping the floor.
    name: 'Staff', feel: 'Costs mana where everything else costs time. The bolt arcs and steers; the beam roots you.',
    build: buildStaff,
    grip: { y: 0.02, z: 0.03, rx: 0.22, rz: 0.06 },
    // Two-handed (spec), thrust-flavoured: a cast PUSHES the head at the
    // target rather than sweeping an arc, so it reads closer to the spear's
    // language than the sword's.
    anim: { lo: -0.70, hi: 1.25, twist: 0.12, twoHand: true, thrust: true, alternate: false },
    mass: 1.6,
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

// ------------------------------------------------------------ legendary rules
//
// RPG_SPEC rarityAndLegendary: the raw legendary multiplier is deliberately a
// small step (1.36 -> 1.58, +16% — less than one tier step's ~+53%); the REAL
// prize is one named clause per base that changes a VERB. The hard law:
//
//   A LEGENDARY RULE MAY NEVER MULTIPLY DAMAGE.
//
// Enforced STRUCTURALLY, not by convention, in three layers:
//   1. every rule's `fx` object may only use keys from RULE_VERBS below, and
//      the whitelist contains no damage term — an unknown key throws at module
//      load (assertLegendaryLaw below runs unconditionally on import);
//   2. hitDamage(w, step, atk) — the ONE damage computation — takes no rule
//      input and never reads w.rule, so a rule has no channel into the number
//      even if someone smuggled a key past the list;
//   3. tools/ascension-test.mjs asserts both: the whitelist is closed, and a
//      legendary's hitDamage over an epic's from the SAME seed is exactly the
//      RARITIES.mul ratio — the rule contributed zero.
//
// Every verb below is tempo (when things happen), positioning (where bodies
// end up) or resource flow (what a hit refunds or passes on). Consumers:
// tickAttack/canAttack/startAttack here; the rest in game.js combat sites.
export const RULE_VERBS = new Set([
  'comboKeepOnWhiff',    // tickAttack: a lapsed chain keeps the combo cursor
  'finisherCancelMul',   // canAttack: the finisher's cancel window scales
  'chargeTimeMul',       // tickAttack/chargeMul: full charge takes less hold
  'chargedStaggerMul',   // game.js: a near-full charge's stagger scales
  'staggerOnMiss',       // game.js: finisher stagger lands in the arc regardless
  'craterT',             // game.js: radial finisher leaves a slow zone (secs)
  'craterSlow',          // game.js: movement factor inside the crater
  'pullStagger',         // game.js: the hook's pull also staggers (secs)
  'bleedJump',           // game.js: a bleeding kill passes the wound on (metres)
  'critRefund',          // game.js: a crit refunds step time (secs)
  'critRefundMax',       // game.js: at most N refunds per combo
  'finisherLungeMul',    // startAttack: the finisher's lunge scales
  'finisherDashReset',   // game.js: landing the finisher clears the dash cd
  'sweepPull',           // game.js: wide-arc hits pull toward the arc centre (m)
  'drawRefundOnKill',    // game.js: a full-draw kill re-arms a full draw
  'drawFullMul',         // game.js: full draw arrives sooner
  'beamCheapT',          // game.js: beam ticks past this time cost less (secs)
  'beamCostMul',         // game.js: the cheap tick's cost factor
  'boltTurnMul',         // game.js: the homing bolt's steering bound scales
]);

// One rule per base. Text is what the panel prints; fx is what combat reads.
// Where the spec's example clause names a mechanic this build does not have
// (daggers carry no bleed; nothing interrupts a player swing), the clause was
// re-cut to the nearest verb the machine actually owns — still tempo /
// positioning / resource, never a damage number.
export const LEGENDARY_RULES = {
  riftedge: { name: 'RIFTEDGE ASCENDANT', text: 'Your combo does not reset on a whiff — only taking a hit resets it.', fx: { comboKeepOnWhiff: true } },
  dawnbrand: { name: 'DAWNBRAND ASCENDANT', text: 'The third chop’s cancel window doubles, so the finisher can loop into itself.', fx: { finisherCancelMul: 2 } },
  gatecleaver: { name: 'GATECLEAVER ASCENDANT', text: 'The finisher’s full charge takes half the hold.', fx: { chargeTimeMul: 0.5 } },
  duskrend: { name: 'DUSKREND ASCENDANT', text: 'A near-full charge’s stagger doubles.', fx: { chargedStaggerMul: 2 } },
  sunderaxe: { name: 'SUNDERAXE ASCENDANT', text: 'The finisher’s stagger lands on everything in the arc even on a miss — the wind alone staggers.', fx: { staggerOnMiss: true } },
  gravemaul: { name: 'GRAVEMAUL ASCENDANT', text: 'The ground pound leaves a 3 s crater that halves enemy speed inside it.', fx: { craterT: 3, craterSlow: 0.5 } },
  hookfang: { name: 'HOOKFANG ASCENDANT', text: 'The hook’s pull also staggers what it drags (0.35 s).', fx: { pullStagger: 0.35 } },
  cinderbite: { name: 'CINDERBITE ASCENDANT', text: 'Killing a bleeding enemy passes the wound to the nearest enemy within 6 m.', fx: { bleedJump: 6 } },
  galesting: { name: 'GALESTING ASCENDANT', text: 'A full-draw arrow that kills its target refunds the draw — the next shot starts full.', fx: { drawRefundOnKill: true } },
  starpiercer: { name: 'STARPIERCER ASCENDANT', text: 'Full draw arrives 30% sooner.', fx: { drawFullMul: 0.7 } },
  emberstave: { name: 'EMBERSTAVE ASCENDANT', text: 'Beam ticks past 0.8 s cost half mana — a long channel is cheaper per second than a short one.', fx: { beamCheapT: 0.8, beamCostMul: 0.5 } },
  hollowlight: { name: 'HOLLOWLIGHT ASCENDANT', text: 'The homing bolt’s steering bound doubles.', fx: { boltTurnMul: 2 } },
  whisperfangs: { name: 'WHISPERFANGS ASCENDANT', text: 'A crit refunds 0.05 s of the current step’s recovery, at most 3 times per combo.', fx: { critRefund: 0.05, critRefundMax: 3 } },
  veinsplitters: { name: 'VEINSPLITTERS ASCENDANT', text: 'The finisher’s lunge doubles — the blades close the room themselves.', fx: { finisherLungeMul: 2 } },
  vigil: { name: 'VIGIL ASCENDANT', text: 'Landing the thrust finisher resets Dash.', fx: { finisherDashReset: true } },
  voidglaive: { name: 'VOIDGLAIVE ASCENDANT', text: 'The sweep pulls every target 0.8 m toward the centre of the arc.', fx: { sweepPull: 0.8 } },
};

/**
 * The structural half of the law, run at import time and re-runnable by the
 * tests against arbitrary tables: any fx key outside RULE_VERBS throws. The
 * whitelist itself is the proof there is no damage channel — grep it: no key
 * feeds hitDamage, and hitDamage takes no rule.
 */
export function assertLegendaryLaw(rules = LEGENDARY_RULES) {
  for (const [baseId, rule] of Object.entries(rules)) {
    if (!rule || typeof rule !== 'object' || !rule.fx || typeof rule.fx !== 'object') {
      throw new Error(`legendary rule ${baseId}: no fx object`);
    }
    for (const key of Object.keys(rule.fx)) {
      if (!RULE_VERBS.has(key)) {
        throw new Error(`legendary rule ${baseId}: fx key "${key}" is not a sanctioned verb — `
          + 'a legendary rule may never multiply damage, and new verbs must enter RULE_VERBS deliberately');
      }
    }
  }
  return true;
}
assertLegendaryLaw();

/** The rule a legendary of `baseId` carries, or null. Rarity-gated by the
 *  caller (rollWeapon attaches it only on legendary instances). */
export function legendaryRule(baseId) {
  return LEGENDARY_RULES[baseId] || null;
}

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
//
// RECOVERY IS TUNED AGAINST ENEMY ATTACK COOLDOWNS, deliberately: grunt
// attackCd is 1.5 s and stalker 1.2 s (config.ENEMY_TYPES). A whiffed greataxe
// finisher costs 0.55 windup + 0.16 active + 0.52 recovery = 1.23 s — almost
// exactly one free enemy attack — while a whiffed dagger light costs 0.18 s,
// which is nothing. Retune either side of that pairing and the other must
// follow, or heavy weapons stop being a wager and become a tax.

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

// RPG_SPEC weaponPhysics.familyTable, greatsword row: mass 3.6, windup 0.34,
// active 0.13, recovery 0.26, lock 0.72, cancel 0.12, reach 4.6, stagger
// 0.45/0.95, knock 8/16, move 0.16, hitStop 0.08, shake 0.55. The family is
// LINEAR where the greataxe is WIDE: a narrow overhead (0.42pi against the
// axe's 1.15pi), then a horizontal sweep at the family's full 0.95pi, then a
// finisher you can HOLD — `charge` extends the windup up to +0.45 s while the
// attack input stays down and scales damage 1.0 -> 2.1 linearly over the hold
// (see tickAttack / chargeMul). Note lock 0.72 vs the mass-formula's 0.48:
// the table deliberately buys NEAR-full commitment (0.72 of a 0.73 s opener)
// because "it stops them, it does not launch them" only reads if the player
// is also stopped. Low knockback relative to the greataxe, highest
// non-radial stagger in the game — that asymmetry IS the family.
const GREATSWORD_COMBO = [
  { windup: 0.34, active: 0.13, recovery: 0.26, lock: 0.72, cancel: 0.12,
    arc: Math.PI * 0.42, range: 4.6, dmg: 2.00, knock: 8.0, stagger: 0.45, lunge: 1.0, move: 0.16, shake: 0.30, hitStop: 0.05 },
  { windup: 0.36, active: 0.14, recovery: 0.28, lock: 0.78, cancel: 0.13,
    arc: Math.PI * 0.95, range: 4.2, dmg: 2.20, knock: 10.0, stagger: 0.55, lunge: 1.2, move: 0.14, shake: 0.40, hitStop: 0.06 },
  { windup: 0.40, active: 0.15, recovery: 0.34, lock: 0.89, cancel: 0.14,
    arc: Math.PI * 0.95, range: 4.6, dmg: 3.40, knock: 16.0, stagger: 0.95, lunge: 1.5, move: 0.12, shake: 0.55, hitStop: 0.08,
    charge: { time: 0.45, dmgMul: 2.1 }, finisher: true },
];

// RPG_SPEC familyTable, axe row: mass 2.1, windup 0.21, active 0.10, recovery
// 0.14, lock 0.38, cancel 0.09, arc 0.70pi, reach 3.0, stagger 0.15/0.55,
// knock 5/-12, move 0.30, hitStop 0.05. Two verbs no other family has:
//   bleed — every connecting hit applies a 3 s damage-over-time (game.js owns
//   the ticking; stacks cap at 3 applications), which is why the raw dmg
//   shares (1.15/1.30/2.30) sit BELOW the sword's — the wound is the damage;
//   the hook — the finisher's knock is NEGATIVE: game.js._damageEnemy reads
//   a negative impulse as a pull TOWARD the attacker (capped so it closes to
//   arm's length, never through you). The weapon that refuses to let go.
// Finisher shake is 0.30, not the table's 0.28: the table row conflicts with
// the spec's own hitStopAndShakeAreMass law ("keep the ordering monotonic in
// mass forever; assert it") — the shipped sword (mass 1.4) already shakes
// 0.30, so a heavier axe may not shake less. The asserted law wins by 0.02.
const AXE_COMBO = [
  { windup: 0.21, active: 0.10, recovery: 0.14, lock: 0.38, cancel: 0.09,
    arc: Math.PI * 0.70, range: 3.0, dmg: 1.15, knock: 5.0, stagger: 0.15, lunge: 0.8, move: 0.30, shake: 0.00, hitStop: 0.00, bleed: true },
  { windup: 0.20, active: 0.10, recovery: 0.15, lock: 0.37, cancel: 0.09,
    arc: Math.PI * 0.70, range: 3.0, dmg: 1.30, knock: 5.5, stagger: 0.18, lunge: 0.9, move: 0.30, shake: 0.10, hitStop: 0.00, bleed: true },
  { windup: 0.26, active: 0.12, recovery: 0.24, lock: 0.50, cancel: 0.10,
    arc: Math.PI * 0.78, range: 3.2, dmg: 2.30, knock: -12.0, stagger: 0.55, lunge: 0.6, move: 0.26, shake: 0.30, hitStop: 0.05, bleed: true, finisher: true },
];

// RPG_SPEC familyTable, bow row: mass 1.1, "draw 0.22 min / 0.55 full",
// active 0.02, recovery 0.22, lock 0.30, cancel 0.06, reach 34, arc 0, knock
// 1.5, stagger 0.1, shake 0.10, hitStop 0. The swing machine NEVER runs this
// table — game.js routes a ranged archetype to draw-hold-release — but the
// step still exists so every consumer of w.combo (dps scoring, the summary
// panel's reach row, moveScale's guards) reads honest family numbers instead
// of a special case. windup is the FULL draw; the single step is not a
// finisher, so the mass-monotonicity assert over finishers is untouched.
const BOW_COMBO = [
  { windup: 0.55, active: 0.02, recovery: 0.22, lock: 0.30, cancel: 0.06,
    arc: 0, range: 34, dmg: 1.00, knock: 1.5, stagger: 0.1, lunge: 0, move: 0.45, shake: 0.10, hitStop: 0.00 },
];

// The bow's ballistic contract, verbatim from RPG_SPEC weaponPhysics
// .projectilePhysics.arrowNumbers — ONE home so game.js and the tests read
// the same numbers.
//   gravity 9.0  — slightly under real gravity so aim stays forgiving on a
//                  phone without reading as floaty. THE SAME constant the
//                  staff bolt will use (step 9): a bolt is slower, so it arcs
//                  more, which is "internally consistent magic" made visible.
//   speed 22->46 — linear in draw fraction. At 46 m/s over 20 m the flight is
//                  0.435 s and the drop 0.5*9*0.435^2 = 0.85 m: visible,
//                  aimable. At 22 m/s the same shot drops 3.7 m — a snapped
//                  shot misses where a drawn one lands, which is how the
//                  player learns the draw from the arc, not from a number.
//   dmg 0.55->1.35, life 2.5 s, riseVy: without a soft-lock target the arrow
//                  leaves at vy = speed * 0.12, a gentle rise.
//   cone 25 deg  — soft-lock accepts the nearest enemy within 25 degrees of
//                  camera-forward (the spec's recommended aim affordance; no
//                  new input mode, no new camera mode).
//   maxLive 12   — the spec's cap on live player projectiles.
export const BOW = {
  drawMin: 0.22,
  drawFull: 0.55,
  speedMin: 22,
  speedFull: 46,
  dmgMin: 0.55,
  dmgFull: 1.35,
  gravity: 9.0,
  life: 2.5,
  riseVy: 0.12,
  launchY: 1.4,               // chest height; also the lineBlocked probe height
  coneCos: Math.cos((25 * Math.PI) / 180),
  reach: 34,
  moveDrawing: 0.45,          // familyTable: 0.45 while drawing, 0.85 otherwise
  maxLive: 12,
  knock: 1.5,
  stagger: 0.1,
  shake: 0.10,
};

// RPG_SPEC familyTable, staff row: mass 1.6, windup 0.28, active 0.06,
// recovery 0.18, lock 0.34, cancel 0.10, reach 18, stagger 0.20/0.35, knock
// 2.0/5.0, moveMul 0.55, hitStop 0, shake 0.15, steps 2. The family COSTS MANA
// where every other family costs only time — that is its identity line, and it
// is why both steps run through the swing machine rather than the bow's
// draw-hold-release: a cast has a windup you commit to, not a string you hold.
//   step 1 (bolt: true)  — game.js._applySwingHit routes the machine's hit to
//     _fireStaffBolt instead of the melee cone; range 18 is the family reach.
//   step 2 (beam: true)  — the finisher opens a channelled beam that ticks
//     while the button stays held (game.js owns the channel; see STAFF.beam).
//     Its move 0.20 is the familyTable's "roots to move 0.20 while held".
// dmg shares read low against the sword's 4.42 on purpose: the finisher's 0.55
// is PER TICK and a full channel lands up to 8 of them (4.4 shares), so the
// family's real output is metered by the mana bar, not by this column. The
// beam step is deliberately absent from weapon-feel-test's melee shake/hitStop
// mass ordering — like the bow, the staff fights at range and its "finisher"
// moves no air at the player's feet.
const STAFF_COMBO = [
  { windup: 0.28, active: 0.06, recovery: 0.18, lock: 0.34, cancel: 0.10,
    arc: 0, range: 18, dmg: 1.55, knock: 2.0, stagger: 0.20, lunge: 0, move: 0.55, shake: 0.15, hitStop: 0.00, bolt: true },
  { windup: 0.30, active: 0.06, recovery: 0.20, lock: 0.36, cancel: 0.10,
    arc: 0, range: 9.0, dmg: 0.55, knock: 5.0, stagger: 0.35, lunge: 0, move: 0.20, shake: 0.15, hitStop: 0.00, beam: true, finisher: true },
];

// The staff's ballistic-and-mana contract, ONE home for game.js and the tests
// (the same shape as BOW above).
//
// MAGIC MAY BEND PHYSICS IN EXACTLY TWO NAMED WAYS (RPG_SPEC weaponPhysics
// .magicMayBendExactlyTwoThings) — this table implements precisely those two
// and nothing else:
//   1. DAMAGE TYPE AND EFFECT — the bolt is arcane: its own tint, its own
//      impact flash off the Kenney atlas, mana as the resource. It never buys
//      a shorter windup, lock or recovery than STAFF_COMBO's (mass is real).
//   2. TRAJECTORY CURVATURE, BOUNDED — the bolt may STEER toward its locked
//      target at up to 90 deg/s (turnRate below; the spec's stated maximum,
//      vs 0 for arrows). It may NOT ignore gravity: gravity here is the SAME
//      9.0 the arrow flies under (asserted equal to BOW.gravity in
//      fight-test), and it may not exceed its 18 m/s launch speed — at
//      18 m/s a 90 deg/s turn is a ~11.5 m radius (v/omega = 18/(pi/2)), so
//      a sprinting target still outruns a homing bolt, which is what keeps
//      "homing" a property rather than a guarantee.
//
// The slower bolt under the shared g arcs MORE than an arrow (drop over 10 m:
// 0.5*9*(10/18)^2 = 1.39 m vs the full-draw arrow's 0.21 m) — internally
// consistent magic made visible, exactly as BOW's comment promises.
export const STAFF = {
  boltSpeed: 18,
  gravity: 9.0,                        // == BOW.gravity, by law — see above
  turnRate: Math.PI / 2,               // 90 deg/s, the spec's stated bound
  boltMp: 4,                           // vs maxMp 50+ and mpRegen 2.2+/s: a
                                       // net drain of ~3.5 MP/s at cadence, so
                                       // the bar meters the family, not the cd
  boltLife: 1.8,                       // 18 m/s * 1.8 = 32 m > reach + drop
  launchY: 1.5,                        // the crystal head, just above shoulder
  riseVy: 0.12,                        // unlocked shot: same gentle-rise
                                       // language the bow teaches
  coneCos: Math.cos((25 * Math.PI) / 180),  // same soft-lock cone as the bow
  reach: 18,
  maxLive: 12,                         // the spec's live player-projectile cap
  beam: {
    maxT: 1.6,                         // familyTable: "up to 1.6 s"
    tick: 0.2,                         // 8 ticks over a full channel
    mpPerTick: 2.5,                    // 20 MP for a full channel — Ruin costs
                                       // 12 for one burst; the beam is a
                                       // sustained spend you can stop
    range: 9.0,                        // "a SHORT channelled beam" — half the
                                       // bolt's reach, so the bolt stays the
                                       // long-range answer
    halfWidth: 0.9,                    // corridor half-width for the tick test
    move: 0.20,                        // familyTable: roots while held
    feetY: 1.3,                        // wall-cut probe height, chest-ish
  },
};

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
  // Greatsword bases. dmgMul runs below the greataxe pair on purpose: the
  // family's sum of dmg shares (7.6) is already the largest table, and its
  // finisher can charge to 2.1x on top — the instance multiplier is not where
  // this family's damage lives.
  gatecleaver: {
    id: 'gatecleaver', name: 'Gatecleaver', archetype: 'greatsword', tier: 2, minRank: 1, reqLevel: 7,
    dmgMul: 1.30, cd: 0.75, chainWindow: 1.25, reachMul: 1, arcMul: 1, knockMul: 1.15,
    critAdd: 0, critMul: 2.10, moveMul: 0.95, combo: GREATSWORD_COMBO,
    blurb: 'Too much sword to swing twice. You will not need to.',
    look: { len: 2.05, width: 0.14, guard: 0.52 },
  },
  duskrend: {
    id: 'duskrend', name: 'Duskrend', archetype: 'greatsword', tier: 4, minRank: 3, reqLevel: 22,
    dmgMul: 1.50, cd: 0.70, chainWindow: 1.35, reachMul: 1.05, arcMul: 1, knockMul: 1.30,
    critAdd: 0.03, critMul: 2.25, moveMul: 0.93, combo: GREATSWORD_COMBO, rate: 1.04,
    blurb: 'Raise it and the room holds its breath until it comes down.',
    look: { len: 2.20, width: 0.13, guard: 0.56 },
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
  // Hand-axe bases. The raw numbers read modest against the sword pair —
  // deliberately: every hit also opens a 3 s bleed (see AXE_COMBO), so the
  // family's real output arrives a beat after the swing.
  hookfang: {
    id: 'hookfang', name: 'Hookfang', archetype: 'axe', tier: 1, minRank: 0, reqLevel: 4,
    dmgMul: 1.12, cd: 0.55, chainWindow: 1.00, reachMul: 1, arcMul: 1, knockMul: 1,
    critAdd: 0.04, critMul: 1.95, moveMul: 1.00, combo: AXE_COMBO,
    blurb: 'The head curves back toward you. So does everything it touches.',
    look: { bit: 0.26, haft: 0.95 },
  },
  cinderbite: {
    id: 'cinderbite', name: 'Cinderbite', archetype: 'axe', tier: 3, minRank: 2, reqLevel: 13,
    dmgMul: 1.22, cd: 0.50, chainWindow: 1.05, reachMul: 1.03, arcMul: 1, knockMul: 1.15,
    critAdd: 0.08, critMul: 2.05, moveMul: 1.02, combo: AXE_COMBO, rate: 1.06,
    blurb: 'The wound stays open longer than the fight does.',
    look: { bit: 0.30, haft: 1.00 },
  },
  // Bow bases. cd here is the post-release recovery (familyTable 0.22) plus a
  // touch — the real cadence limiter is the draw itself, which no roll can
  // shorten (mass law: enchantment never voids weight). dmgMul reads modest
  // because the full-draw multiplier (x1.35) and the crit line are where the
  // family's damage lives; moveMul 0.85 is the familyTable's "otherwise"
  // column, the standing cost of carrying a ranged answer.
  galesting: {
    id: 'galesting', name: 'Galesting', archetype: 'bow', tier: 1, minRank: 0, reqLevel: 5,
    dmgMul: 1.05, cd: 0.26, chainWindow: 0, reachMul: 1, arcMul: 1, knockMul: 1,
    critAdd: 0.06, critMul: 2.00, moveMul: 0.85, combo: BOW_COMBO,
    blurb: 'Strung with wind, or so the fletcher claimed. It does whistle.',
    look: { limb: 1.10 },
  },
  starpiercer: {
    id: 'starpiercer', name: 'Starpiercer', archetype: 'bow', tier: 3, minRank: 2, reqLevel: 16,
    dmgMul: 1.18, cd: 0.22, chainWindow: 0, reachMul: 1.06, arcMul: 1, knockMul: 1.1,
    critAdd: 0.12, critMul: 2.20, moveMul: 0.88, combo: BOW_COMBO, rate: 1.05,
    blurb: 'Aim above what you want to hit. It was made for falling shots.',
    look: { limb: 1.22 },
  },
  // Staff bases (RPG_SPEC step 9). Two per new family so the Exchange ladder
  // picks them up with zero shop edits. dmgMul reads mid-table because the
  // bolt's 1.55 share and the beam's per-tick output already carry the
  // family; cd is the post-cast recovery breath, not the cadence limiter —
  // the MANA BAR is this family's cadence limiter, which is the whole
  // identity. look.head names the items.glb crystal that tops the haft
  // (Crystal2 base tier, Crystal4 the deeper one, per the spec's model
  // recommendation); buildStaff falls back to a procedural octahedron when
  // the pack is absent.
  emberstave: {
    id: 'emberstave', name: 'Emberstave', archetype: 'staff', tier: 2, minRank: 1, reqLevel: 8,
    dmgMul: 1.15, cd: 0.45, chainWindow: 1.10, reachMul: 1, arcMul: 1, knockMul: 1,
    critAdd: 0.02, critMul: 1.90, moveMul: 1.00, combo: STAFF_COMBO,
    blurb: 'The crystal was pulled from a gate that would not close. It remembers how.',
    look: { haft: 1.65, head: 'Crystal2' },
  },
  hollowlight: {
    id: 'hollowlight', name: 'Hollowlight', archetype: 'staff', tier: 4, minRank: 3, reqLevel: 21,
    dmgMul: 1.32, cd: 0.40, chainWindow: 1.20, reachMul: 1.05, arcMul: 1, knockMul: 1.1,
    critAdd: 0.06, critMul: 2.05, moveMul: 1.02, combo: STAFF_COMBO, rate: 1.06,
    blurb: 'It does not shine. It makes everything around it darker.',
    look: { haft: 1.75, head: 'Crystal4' },
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
export function rollWeapon(baseId, rnd, { rarity, level = 1, luck = 0, maxRarity = null } = {}) {
  const seed = typeof rnd === 'number' ? rnd >>> 0 : null;
  const r = seed === null ? rnd : mulberry32(seed);
  const base = WEAPONS[baseId] || WEAPONS.riftedge;
  // Draw the rarity even when one was forced, so a given seed lands on the same
  // stat rolls either way — that is what lets a save store four fields and
  // rebuild the exact weapon instead of a snapshot of every number.
  const rolled = rollRarity(r, luck);
  let key = (RARITIES[rarity] || RARITIES[rolled] || RARITIES.common).key;
  // The rank-band ceiling (RPG_SPEC gate1_dropFloor): a DOWNGRADE, never a
  // re-roll — the rarity draw above already happened, so the stream is
  // consumed identically whether or not the clamp binds. This is the same
  // trick the forced-rarity path uses, and it is what keeps a replayed gate
  // seed handing out the same loot with only the label capped.
  if (maxRarity && RARITY_ORDER.indexOf(key) > RARITY_ORDER.indexOf(maxRarity)) key = maxRarity;
  const rd = RARITIES[key];

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
  // The named clause is DERIVED from (base, rarity) — never persisted, never
  // rolled — so the {b,r,s,l} codec is untouched and every legendary of a base
  // carries its base's rule. Attached after the stat rolls: it consumes no
  // stream and hitDamage never reads it (see the law block above).
  w.rule = rd.key === 'legendary' ? (LEGENDARY_RULES[base.id] || null) : null;
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
  if (rd.key === 'legendary') {
    // The title draw still happens so the stream shape stays identical to
    // every seed rolled before legendaries were renamed; the word itself is
    // the spec's naming law — base name plus 'Ascendant', nothing invented.
    rnd();
    return `${prefix}${base.name} Ascendant`;
  }
  const title = rd.key === 'epic' ? ` of ${TITLES[Math.floor(rnd() * TITLES.length)]}` : '';
  return `${prefix}${base.name}${title}`;
}

// The legendary drop floor (RPG_SPEC gate1_dropFloor): below rank band B a
// drawn legendary DOWNGRADES to epic. 3 is B's index in config.RANKS
// (E 0, D 1, C 2, B 3) — "legendary" becomes a statement about where you have
// been, not about how lucky you were on your third E-gate.
export const LEGENDARY_MIN_RANK = 3;

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
  return rollWeapon(pickedId, rnd, {
    level,
    luck,
    // Downgrade, never re-roll: rollWeapon draws the rarity either way, so a
    // replayed gate stream at any rank hands out the same bases, seeds and
    // affixes — only the top label is capped below band B.
    maxRarity: rankIndex >= LEGENDARY_MIN_RANK ? null : 'epic',
  });
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

// A longer, two-handed sword rather than a scaled buildSword: the wider blade,
// the long two-hand grip and the pronounced tip are what stop it reading as
// "sword, but the screenshot is zoomed" at play distance.
function buildGreatsword(look, tint, ghost) {
  const g = new THREE.Group();
  const len = look.len ?? 2.05;
  const wd = look.width ?? 0.14;

  const blade = addPart(g, box(wd, len, 0.035), steelMat(tint, ghost), 0, len * 0.5 + 0.18, 0, false);
  blade.castShadow = true;
  addPart(g, cone(wd * 0.55, 0.24, 4), steelMat(tint, ghost), 0, len + 0.28, 0, false);
  // Fuller strip, same glow-layer trick as the sword's.
  addPart(g, box(wd * 0.30, len * 0.80, 0.05), edgeMat(tint), 0, len * 0.5 + 0.18, 0, true);

  addPart(g, box(look.guard ?? 0.52, 0.09, 0.13), darkMat(ghost), 0, 0.10, 0, false);
  // Two-hand grip: nearly twice the sword's 0.26, so the second hand has
  // somewhere honest to be when the anim drags both arms through the arc.
  addPart(g, cyl(0.040, 0.046, 0.44, 6), haftMat(ghost), 0, -0.16, 0, false);
  addPart(g, octa(0.09), darkMat(ghost), 0, -0.42, 0, false);
  return g;
}

// One bit, short haft, and a rear spur — the spur is the hook made visible,
// which matters because the finisher PULLS and the silhouette should warn you.
function buildHandAxe(look, tint, ghost) {
  const g = new THREE.Group();
  const haft = look.haft ?? 0.95;
  const bit = look.bit ?? 0.26;
  const top = haft - 0.25;

  const pole = addPart(g, cyl(0.038, 0.046, haft, 6), haftMat(ghost), 0, haft * 0.5 - 0.25, 0, false);
  pole.castShadow = true;
  addPart(g, cyl(0.055, 0.055, 0.12, 6), darkMat(ghost), 0, -0.02, 0, false);

  const main = addPart(g, wedge(bit, 0.05), steelMat(tint, ghost), bit * 0.55, top, 0, false);
  main.scale.set(1.35, 1.1, 1);
  main.rotation.z = -Math.PI / 2;
  main.castShadow = true;
  // The rear spur, kicked down-and-back.
  const spur = addPart(g, wedge(bit * 0.45, 0.045), steelMat(tint, ghost), -bit * 0.40, top - 0.05, 0, false);
  spur.rotation.z = Math.PI / 2 + 0.5;
  addPart(g, box(0.045, bit * 1.4, 0.065), edgeMat(tint), bit * 1.0, top, 0, true);
  addPart(g, cyl(0.075, 0.075, 0.12, 6), darkMat(ghost), 0, top, 0, false);
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

// Riser at the origin (the fist grips the middle of a bow, not an end),
// limbs raked BACK along -Z so the string side faces the archer, string on
// the glow layer so the silhouette reads "bow" at play distance even in a
// dark room. Procedural fallback only — the pack's Bow_Wooden is the shipped
// look.
function buildBow(look, tint, ghost) {
  const g = new THREE.Group();
  const limb = look.limb ?? 1.1;         // tip-to-tip along Y
  const half = limb * 0.5;
  const rake = 0.30;                     // limb sweep, radians

  addPart(g, cyl(0.034, 0.034, 0.24, 6), haftMat(ghost), 0, 0, 0, false);
  const upper = addPart(g, box(0.045, half, 0.055), haftMat(ghost), 0, half * 0.5, -Math.sin(rake) * half * 0.25, false);
  upper.rotation.x = rake;
  upper.castShadow = true;
  const lower = addPart(g, box(0.045, half, 0.055), haftMat(ghost), 0, -half * 0.5, -Math.sin(rake) * half * 0.25, false);
  lower.rotation.x = -rake;
  // Tips, where the string ties off.
  const tipZ = -Math.sin(rake) * half * 0.5 - 0.02;
  addPart(g, octa(0.04), darkMat(ghost), 0, half + 0.02, tipZ, false);
  addPart(g, octa(0.04), darkMat(ghost), 0, -half - 0.02, tipZ, false);
  // The string: tip to tip, dead straight.
  addPart(g, box(0.014, limb + 0.02, 0.014), edgeMat(tint), 0, 0, tipZ, true);
  return g;
}

// The magic implement (RPG_SPEC step 9). PROCEDURAL BY FINDING, not by
// preference: items.glb contains no staff, no wand and no rod, so the haft is
// authored from the same cyl/haftMat/darkMat/edgeMat blocks as every other
// procedural weapon and only the HEAD comes from the pack — a crystal
// (look.head: Crystal2 base / Crystal4 tier variant; 1-3 primitives each)
// whose silhouette reads unambiguously as a magic implement at play distance.
// With public/models/ absent the head falls back to a stretched octahedron,
// so the weapon still builds and still reads as a staff offline. The glow
// core inside the head is edgeMat — the SAME rarity-tint glow-layer trick the
// sword's fuller uses — never an emissive on the character.
//
// Head fit is per-model because the crystals are authored around different
// origins (measured off items.glb): Crystal2 is 0.90 tall CENTRED (so its
// centre must sit half its scaled height above the collar), Crystal4 is 0.50
// centred, Mineral sits base-down (minY -0.11). scale brings each to a
// 0.30-0.38 m head on the 2.14-unit rig.
const STAFF_HEAD_FIT = {
  Crystal2: { scale: 0.42, lift: 0.21 },
  Crystal4: { scale: 0.62, lift: 0.18 },
  Mineral: { scale: 0.55, lift: 0.09 },
};

function buildStaff(look, tint, ghost) {
  const g = new THREE.Group();
  const haft = look.haft ?? 1.65;
  // The fist grips a third of the way up: 0.55 m of shaft hangs below the
  // hand (enough to plant), the rest rises to the head.
  const below = 0.55;
  const top = haft - below;

  const pole = addPart(g, cyl(0.040, 0.048, haft, 6), haftMat(ghost), 0, haft * 0.5 - below, 0, false);
  pole.castShadow = true;
  // Grip wrap + butt cap, the readable-at-distance details.
  addPart(g, cyl(0.056, 0.056, 0.14, 6), darkMat(ghost), 0, 0.02, 0, false);
  addPart(g, octa(0.055), darkMat(ghost), 0, -below + 0.02, 0, false);
  // Collar where the head seats.
  addPart(g, cyl(0.070, 0.050, 0.10, 6), darkMat(ghost), 0, top + 0.02, 0, false);

  // Pack crystal head. Ghosts stay procedural for the same reason
  // buildPackMesh refuses them: pack materials are shared across every clone.
  let head = null;
  const fit = STAFF_HEAD_FIT[look.head];
  if (!ghost && _getModel && fit) {
    head = _getModel(look.head, { scale: fit.scale });
    if (head) {
      head.position.y = top + 0.07 + fit.lift;
      g.add(head);
    }
  }
  if (!head) {
    // Offline fallback: a stretched octahedron reads "crystal" against the
    // flat-shaded language of the rest of the kit.
    const oct = addPart(g, octa(0.13), steelMat(tint, ghost), 0, top + 0.30, 0, false);
    oct.scale.y = 1.55;
    oct.castShadow = true;
  }
  // The rarity-tint core, inside the head, on the glow layer.
  const core = addPart(g, octa(0.075), edgeMat(tint), 0, top + 0.30, 0, true);
  core.scale.y = 1.4;
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
  // greatsword and axe are lifted VERBATIM from HELD_MODELS.bigsword and
  // HELD_MODELS.axe below — the lancer/boss and the grunts have carried these
  // exact models on this exact rig since the pack landed, so scale, tilt and
  // (crucially) Sword_big's measured-off-a-render -0.22 lift are already the
  // screenshot-verified numbers. Do not retune one table without the other.
  greatsword: { scale: 0.52, tilt: 0.12, lift: -0.22 },
  axe: { scale: 0.62, tilt: 0.14, lift: 0.12 },
  greataxe: { scale: 0.62, tilt: 0.10, lift: 0.22 },
  daggers: { scale: 0.50, tilt: 0.14, lift: -0.09, offhandLift: 0.14 },
  polearm: { scale: 0.55, tilt: 0.06, lift: 0.10 },
  // Lifted verbatim from HELD_MODELS.bow: gripped at the riser, which is the
  // middle of the model rather than one end, hence lift 0.
  bow: { scale: 0.62, tilt: 0.06, lift: 0 },
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
    case 'greatsword':
      // The same Sword_big the lancer carries — the player's version differs
      // by PACK_FIT/grip, not by model. RPG_SPEC family mapping.
      return `Sword_big${gold}`;
    case 'axe':
      return `Axe_small${gold}`;
    case 'greataxe':
      // The maul variant is a hammer, not an axe, and the pack has both — using
      // the axe for it would misread the one archetype whose finisher is a
      // ground pound.
      return base?.look?.head === 'maul' ? `Hammer_Double${gold}` : `Axe_Double${gold}`;
    case 'daggers':
      return `Dagger${gold}`;
    case 'bow':
      // The pack's gold bow is named Bow_Golden, NOT Bow_Wooden_Golden — the
      // one family where the suffix rule would fabricate a missing node.
      return gold ? 'Bow_Golden' : 'Bow_Wooden';
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
  // grip.rz on axe/greataxe is new: every other entry in this table leans on
  // `tilt` alone (forearm clearance, not a grip choice) and stayed at rz 0,
  // which is exactly what read as "up and down" on the shipped build's axe.
  // ARCHETYPES.axe/greataxe picked up the same rz bump for the player's held
  // weapon — matching it here keeps a grunt's or the tribal creature's axe
  // (both go through buildHeldWeapon, not equipWeapon) canted the same way
  // instead of looking correct in one hand and vertical in the other.
  axe: { item: 'Axe_small', scale: 0.62, tilt: 0.14, lift: 0.12, grip: { y: -0.02, z: 0.06, rx: 0.34, rz: 0.22 } },
  greataxe: { item: 'Axe_Double', scale: 0.62, tilt: 0.10, lift: 0.22, grip: { y: -0.02, z: 0.08, rx: 0.26, rz: 0.14 } },
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

/**
 * The pool's window into the item pack (RPG_SPEC projectiles module: "via a
 * small exported accessor"). An arrow through here is ONE draw call against a
 * shared, vertex-coloured geometry — the same bake-and-merge path every held
 * NPC weapon uses — instead of the 2-3 a naive getItemMesh clone would cost.
 * Returns null when the pack is absent (a normal offline state). The geometry
 * is cached and shared: it is weapons.js's to dispose, never the caller's.
 */
export function sharedItemGeometry(name) {
  return mergedItemGeometry(name);
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

  // The bow family sets mainHand 'L' (a bow is held in the left hand; the
  // right draws the string) — everything else keeps the shipped 'R'.
  const mHand = handSocket(rig, arch.mainHand === 'L' ? 'L' : 'R');
  if (!mHand) return null;
  applyGrip(main, arch);
  mHand.add(main);

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
  // Same diagonal carry as the sword, pushed further out and raked harder: a
  // 2 m blade on the sword's exact transform pokes past both the shoulder and
  // the knee.
  greatsword: { socket: 'back', x: -0.16, y: 0.22, z: -0.24, rx: -3.02, ry: 0, rz: -0.46 },
  // A hand axe rides the belt like the daggers do — but head-UP (rx near 0,
  // like the greataxe's carry) with the grip dropped below the socket so the
  // bit sits at the belt line and the haft hangs down the thigh. On the back
  // it would read as a second, smaller greataxe.
  axe: { socket: 'hip', x: -0.26, y: -0.28, z: -0.12, rx: -0.12, ry: 0, rz: -0.10 },
  // Head UP over the shoulder, haft butt near the hip: a greataxe carried
  // point-down would put a 40 cm bit through the back of the character's knee.
  greataxe: { socket: 'back', x: -0.05, y: -0.40, z: -0.30, rx: -0.10, ry: 0, rz: -0.28 },
  // Near vertical. A 2.5 m shaft raked as hard as a sword pushes the butt
  // through the floor at one end and the point through the head at the other.
  polearm: { socket: 'back', x: 0.02, y: -0.80, z: -0.30, rx: -0.08, ry: 0, rz: -0.16 },
  // Same near-vertical carry as the polearm, crystal UP (rx near 0) — a
  // point-down staff would bury the one part that says "magic" behind the
  // knees. 0.7 m shorter than the spear, so it rides higher on the back and
  // rakes a touch harder without fouling the floor.
  staff: { socket: 'back', x: -0.04, y: -0.52, z: -0.28, rx: -0.09, ry: 0, rz: -0.20 },
  // Slung diagonally across the back, string toward the body, the same carry
  // every archer culture converged on. Point-down like the sword (rx near
  // -pi) but raked less hard: a strung bow lying flat along the sword's
  // diagonal would foul the greatsword's stow line and read as a second
  // blade; the shallower rz keeps the stave's curve legible from behind.
  bow: { socket: 'back', x: -0.14, y: 0.10, z: -0.22, rx: -3.05, ry: 0, rz: -0.30 },
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
    // Same mainHand rule as equipWeapon: the bow returns to the LEFT fist.
    const rHand = handSocket(rig, arch.mainHand === 'L' ? 'L' : 'R');
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
    // Chargeable steps (GREATSWORD_COMBO's finisher). `charging` is a LIVE
    // input flag the caller refreshes every frame before tickAttack; `chargeT`
    // is how long the blade has been held at the top of the windup, in real
    // (un-rate-scaled) seconds, capped by the step's charge.time.
    charging: false,
    chargeT: 0,
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
  // DAWNBRAND ASCENDANT (legendary rule, tempo verb): the finisher's cancel
  // window scales. 1 on every non-legendary instance — w.rule is null there —
  // so the shipped timing is untouched.
  const cancel = step.cancel * (step.finisher ? (w.rule?.fx.finisherCancelMul || 1) : 1);
  return state.t >= total - cancel;
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
  // VEINSPLITTERS ASCENDANT (positioning verb): the finisher's lunge scales.
  state.lunge = (step.lunge || 0) * (step.finisher ? (w.rule?.fx.finisherLungeMul || 1) : 1);
  state.buffered = false;
  state.chargeT = 0;
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
      if (state.chain <= 0) {
        state.chain = 0;
        // RIFTEDGE ASCENDANT (tempo verb): a lapsed chain KEEPS the combo
        // cursor — only taking a hit rewinds it (game.js does that in
        // _damagePlayer). Every other instance rewinds here, as shipped.
        if (!w?.rule?.fx.comboKeepOnWhiff) state.next = 0;
      }
    }
    return;
  }

  const step = w.combo[state.index];
  // Attack rate scales the clock rather than the table, so a "Quick" roll
  // speeds up the whole swing without cloning per-instance combo steps.
  let adv = dt * w.rate;
  // Chargeable step (RPG_SPEC: the greatsword's third step): while the input
  // is held, the blade PARKS just under the top of the windup and the overflow
  // time accrues as charge instead — up to step.charge.time real seconds, then
  // the swing releases itself. Steps without `charge` (every shipped table,
  // and npcStrikeWeapon) never enter this branch, so their timing is
  // byte-identical to before this field existed. Charge accrues un-rate-scaled
  // because a "Quick" affix should speed the swing, not shorten the hold the
  // player is deliberately buying.
  // GATECLEAVER ASCENDANT (tempo verb): full charge takes chargeTimeMul of the
  // hold. chargeMul divides by the same effective time, so the damage span
  // (1 -> dmgMul) is unchanged — only the clock to reach it moves.
  const chargeTime = step.charge ? step.charge.time * (w.rule?.fx.chargeTimeMul || 1) : 0;
  if (step.charge && state.phase === PHASE_WINDUP && state.charging
      && state.chargeT < chargeTime) {
    const headroom = Math.max(0, step.windup - 1e-6 - state.t);
    if (adv > headroom) {
      state.chargeT = Math.min(chargeTime, state.chargeT + (adv - headroom) / w.rate);
      adv = headroom;
    }
  }
  state.t += adv;

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

/**
 * A one-step pseudo-weapon for NPC strikes, so enemy humanoids run through the
 * SAME machine the player does instead of a parallel pair of hand-decremented
 * timers. The shape is deliberate arithmetic equivalence with the shipped
 * telegraph -> strike -> follow-through code in game.js:
 *
 *   windup   = the steerAgent telegraph (0.42/0.5/0.55 fairness windows —
 *              those numbers stay OWNED by enemyai.js and are poked into the
 *              step per attack, which is why every enemy gets its own copy)
 *   active   = 0, so tickAttack fires the blow on the exact frame the old
 *              `telegraph -= dt; if (telegraph <= 0) strike()` fired it
 *   recovery = 0.3, the old e.swing follow-through constant
 *
 * cd and chainWindow are 0 because enemy cadence is e.attackCd's business
 * (attackCd is tuned against player recovery — see the combo table note),
 * and an NPC has no combo to chain.
 */
export function npcStrikeWeapon() {
  return {
    combo: [{ windup: 0.42, active: 0, recovery: 0.3, lock: 0, cancel: 0,
      arc: 0, range: 0, dmg: 1, knock: 0, stagger: 0, lunge: 0, move: 0 }],
    rate: 1, cd: 0, chainWindow: 0,
    dmgMul: 1, reachMul: 1, arcMul: 1, knockMul: 1, moveMul: 1,
  };
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
  state.chargeT = 0;
}

/**
 * Damage multiplier a held charge has earned: 1 at a tap, step.charge.dmgMul
 * at a full hold, linear between (RPG_SPEC: "scales dmg 1.0 -> 2.1 linearly
 * over that hold"). 1 for every step without a charge clause, so callers can
 * apply it unconditionally.
 */
export function chargeMul(state, step, w = null) {
  const c = step?.charge;
  if (!c || !(c.time > 0)) return 1;
  // Same effective time tickAttack accrues against (GATECLEAVER ASCENDANT
  // halves it), so a full hold always reads as a full charge. `w` is optional:
  // existing callers without it get the shipped behaviour on every instance
  // that carries no rule.
  const time = c.time * (w?.rule?.fx.chargeTimeMul || 1);
  return 1 + ((c.dmgMul || 1) - 1) * Math.min(1, state.chargeT / time);
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
