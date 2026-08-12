// Armour: definitions, rolling, set progress, and the derived contribution.
// THREE-free and DOM-free like config.js / progression.js / shop.js, so the
// headless armour suite (tools/armor-test.mjs) drives it straight from node.
//
// THE SET BONUS LAW (RPG_SPEC armorSets.setBonusLaw):
// PARTIAL BONUSES ARE SMALL FLAT NUMBERS. THE FULL-SET BONUS IS A RULE, NOT A
// NUMBER. A number can be stacked, multiplied and compared against a bigger
// number; a rule cannot be stacked with itself, and there are only five armour
// slots so exactly one full-set rule can ever be live. Two 2-piece partials
// from two different sets are deliberately allowed and deliberately
// competitive with one 5-piece rule — that tension is the interesting part.
// Set bonuses do NOT scale with rarity or level; a legendary set piece is
// better than a common one through AP and affixes only.
//
// An armour INSTANCE is the same five short fields as a weapon: (kind, base,
// rarity, seed, level). rollArmor consumes its stream in a FIXED order and
// draws the rarity even when one is forced — exactly as rollWeapon does — which
// is the only reason a five-field record can rebuild an item byte-identically.

import { mulberry32 } from '../core/rng.js';
import { RARITIES, RARITY_ORDER, rollRarity } from './weapons.js';

// ------------------------------------------------------------------ tables

// Base armour points per piece tier, before slot weight and rarity.
//
// Tiers 3 and 5 are tuned DOWN from the spec's first-pass 36/80, exactly as its
// own risk note predicted ("the envelope assert will probably fail first time,
// and that means the table is wrong, not the test"). The binding constraint is
// the +35% survivability envelope, worst obtainable rolls, at the spec's three
// assert levels:
//   L20, full epic tier-3, every piece Guarded at hi (+14% AP):
//     36: AP = 36*3.3*1.36*1.14 = 184.2 -> DR 184.2/(184.2+90+520) = 23.2%
//         -> 1/(1-DR) * hp factor = 1.302 * 1.040 = 1.354  OVER
//     34: AP = 173.9 -> DR 22.2% -> 1.285 * 1.040 = 1.337   inside
//   L50, full legendary tier-5, every piece Guarded at hi:
//     80: AP = 80*3.3*1.58*1.14 = 475.5 -> DR 475.5/(475.5+90+1300) = 25.5%
//         -> 1.342 * 1.029 = 1.381                          OVER
//     72: AP = 428.0 -> DR 23.5% -> 1.308 * 1.029 = 1.346   inside
// Tiers 1/2/4 are never the best-in-slot at an assert level (t4's reqLevel 22
// misses L20 and t5 outclasses it at L50/L80), so they keep the spec values.
export const TIER_AP = { 1: 12, 2: 22, 3: 34, 4: 55, 5: 72 };

// Chest is the slab; hands the smallest. Sum 3.30 — the spec's worked examples
// (full set AP = TIER_AP * 3.30) depend on this exact sum.
export const SLOT_WEIGHT = { chest: 1.00, legs: 0.75, head: 0.60, feet: 0.50, hands: 0.45 };

// The five armour slots a set counts. Offhand and trinket are deliberately
// OUTSIDE the set maths so there is always a free choice no set can claim.
export const ARMOR_SLOTS = ['head', 'chest', 'hands', 'legs', 'feet'];

export const SET_THRESHOLDS = [2, 4, 5];

// Hard clamp on TOTAL damage reduction from every source: taken >= raw * 0.28.
// derive().dr caps at 0.45 and the armour term rides 15-23%, which multiply to
// ~0.57 — so this is headroom for affixes and set rules, not a wall honest
// builds hit. Step 11's _damagePlayer applies it via combinedDR().
export const TOTAL_DR_CAP = 0.72;

// Hard clamp on armour-sourced move speed. Base speed is 6.0 and agility's own
// bonus caps at +4.2; armour must never become the dominant speed source.
export const ARMOR_SPEED_CAP = 0.6;

// Feet knockback reduction (secondary + Rooted-adjacent effects) clamp.
const KNOCK_TAKEN_CAP = 0.50;
// staggerResist is a NEW derived value; spec range 0..0.6.
const STAGGER_RESIST_CAP = 0.60;

// Per-slot secondary rates, per tier. All flat, all rarity-independent —
// rarity buys AP and affixes, never secondaries (armorSets.secondaryBySlot).
//   head:  tellLeadMs +6/tier (clamped later by STAT_RATES.per.tellCapMs 520),
//          critDmg +0.02/tier
//   chest: maxHp +9/tier (and the largest SLOT_WEIGHT)
//   hands: atkSpeed +0.012/tier, folded into the EXISTING 0.30 cap by step 11
//   legs:  speed +0.045/tier (armour speed cap 0.6), dodgeWindow +0.008/tier s
//   feet:  staggerResist +0.06/tier, knockback taken -0.05/tier
const SLOT_SECONDARY = {
  head: (t, a) => { a.tellAdd = 6 * t; a.critDmgAdd = 0.02 * t; },
  chest: (t, a) => { a.hpAdd = 9 * t; },
  hands: (t, a) => { a.atkSpeedAdd = 0.012 * t; },
  legs: (t, a) => { a.speedAdd = 0.045 * t; a.dodgeAdd = 0.008 * t; },
  feet: (t, a) => { a.staggerResist = 0.06 * t; a.knockTaken = 0.05 * t; },
};

// A SEPARATE pool from weapons.js's AFFIXES because those all mutate weapon
// fields (dmgMul, rate, reachMul...) that mean nothing on a boot. Same
// lo/hi/apply(target, magnitude) contract, drawn without replacement from a
// pool copy, so rollArmor stays a structural clone of rollWeapon forever.
export const ARMOR_AFFIXES = {
  guarded:   { name: 'Guarded',   lo: 0.05,  hi: 0.14,  apply: (a, m) => { a.apMul *= 1 + m; } },
  vital:     { name: 'Vital',     lo: 0.02,  hi: 0.07,  apply: (a, m) => { a.hpMul *= 1 + m; } },
  fleet:     { name: 'Fleet',     lo: 0.02,  hi: 0.08,  apply: (a, m) => { a.speedAdd += m * 0.9; } },
  rooted:    { name: 'Rooted',    lo: 0.04,  hi: 0.12,  apply: (a, m) => { a.staggerResist += m; } },
  deft:      { name: 'Deft',      lo: 0.01,  hi: 0.035, apply: (a, m) => { a.atkSpeedAdd += m; } },
  thirsting: { name: 'Thirsting', lo: 0.005, hi: 0.02,  apply: (a, m) => { a.leech += m; } },
  ashen:     { name: 'Ashen',     lo: 0.04,  hi: 0.16,  apply: (a, m) => { a.ashFind += m; } },
};

const ARMOR_AFFIX_KEYS = Object.keys(ARMOR_AFFIXES);

// ------------------------------------------------------------------ the sets
//
// bonuses[threshold] carries BOTH the display text and the machine-readable
// payload. The numeric keys are the ones armorDerive folds directly; `rule` is
// a 5-piece full-set rule for step 11's combat integration to implement —
// armorDerive only REPORTS it (rules[]), it never simulates it.
export const SETS = {
  issue: {
    id: 'issue', name: "HUNTER'S ISSUE", tier: 1, minRank: 0, reqLevel: 1,
    chestIcon: 'armor_leather',
    flavour: 'What the Association hands you at the door. It is not good. It is yours.',
    bonuses: {
      2: { text: '+8% ash from kills', ashMul: 1.08 },
      4: { text: 'Dash cooldown -0.25s', dashCdAdd: -0.25 },
      5: {
        text: 'The first hit you take in each dungeon room is reduced by 40%.',
        rule: 'first_hit_ward', firstHitMul: 0.60,
      },
    },
  },
  ossuary: {
    id: 'ossuary', name: 'OSSUARY PLATE', tier: 2, minRank: 1, reqLevel: 6,
    chestIcon: 'armor_metal',
    flavour: "Bone laid into steel. The Gravelord's tithe, worn outward.",
    bonuses: {
      2: { text: '+10% armour DR', armorDrMul: 1.10 },
      4: { text: '+18% stagger resist, knockback taken -25%', staggerResistAdd: 0.18, knockTakenMul: 0.75 },
      5: {
        text: 'Below 35% HP you take 20% less damage and trash cannot stagger you.',
        rule: 'lowhp_bulwark', lowHpFrac: 0.35, lowHpDmgMul: 0.80,
      },
    },
  },
  deepglass: {
    id: 'deepglass', name: 'DEEPGLASS WEAVE', tier: 3, minRank: 2, reqLevel: 14,
    chestIcon: 'armor_metal2',
    flavour: 'Cold enough to keep. Light enough to run in.',
    bonuses: {
      2: { text: '+0.35 move speed', speedAdd: 0.35 },
      4: { text: 'Perfect-dodge window +40ms', dodgeAdd: 0.040 },
      5: {
        text: 'A perfect dodge refunds 25% of the hit as mana and guarantees your next crit.',
        rule: 'dodge_riposte', manaRefund: 0.25,
      },
    },
  },
  emberfall: {
    id: 'emberfall', name: 'EMBERFALL HARNESS', tier: 4, minRank: 3, reqLevel: 22,
    chestIcon: 'armor_black',
    flavour: 'It was already burning when they pulled it out.',
    bonuses: {
      2: { text: '+6% attack speed', atkSpeedAdd: 0.06 },
      4: { text: 'Combo finishers leech 3% of damage dealt', finisherLeech: 0.03 },
      5: {
        text: 'Every third combo finisher detonates for 60% weapon damage in a 4m ring.',
        rule: 'third_finisher_detonate', detonateMul: 0.60, detonateRadius: 4,
      },
    },
  },
  vigil: {
    id: 'vigil', name: "ARCHON'S VIGIL", tier: 5, minRank: 4, reqLevel: 34,
    chestIcon: 'armor_golden',
    flavour: 'Made for someone who commands more soldiers than he has hands.',
    bonuses: {
      2: { text: '+12% shadow damage', shadowDmgMul: 1.12 },
      // STILL clamped by progression.shadowFieldCapacity's quality-tier ceiling
      // and its hard Math.min(12) — on a low tier this bonus does nothing, and
      // the panel must say '+2 (capped by graphics tier)' rather than lying.
      4: { text: '+2 shadow field capacity (capped by graphics tier)', shadowFieldAdd: 2 },
      5: {
        text: 'Bound shadows inherit 15% of your armour DR and your active 2-piece bonus.',
        rule: 'shadow_inherit', inheritDrFrac: 0.15,
      },
    },
  },
};

// -------------------------------------------------------------- definitions
//
// Ids are `${setId}_${slot}` — lowercase, no spaces, stable forever; an id in
// a save is a contract (the weapons table set the precedent).
//
// ICON MAPPING (RPG_SPEC equipmentSlots, including its stand-in answers):
//   head  — the atlas has exactly crown / crown2, alternated across the sets;
//           set identity is expressed through rarity tint and, in step 12, the
//           character part-swap, not through five distinct helmet icons.
//   chest — armor_leather / armor_metal / armor_metal2 / armor_black /
//           armor_golden: one per set, a lucky exact fit.
//   hands — the pack has ONE glove icon; all five sets share it, tinted by
//           rarity. That is honest and reads fine at 40px.
//   legs  — NO leg icon exists (flagged in the spec's openQuestions). Stand-in:
//           reuse the set's chest icon; the panel renders it desaturated so it
//           cannot be mistaken for the chest piece.
//   feet  — NO boot icon exists either. Stand-in: `bone` (the spec's
//           iconKeyExample for the slot), shared across sets, rarity-tinted.
const PIECE_NAMES = {
  issue:     { head: 'Issue Hood',       chest: 'Issue Jack',        hands: 'Issue Gloves',       legs: 'Issue Legwraps',      feet: 'Issue Boots' },
  ossuary:   { head: 'Ossuary Helm',     chest: 'Ossuary Plate',     hands: 'Ossuary Gauntlets',  legs: 'Ossuary Greaves',     feet: 'Ossuary Sabatons' },
  deepglass: { head: 'Deepglass Cowl',   chest: 'Deepglass Weave',   hands: 'Deepglass Wraps',    legs: 'Deepglass Leggings',  feet: 'Deepglass Treads' },
  emberfall: { head: 'Emberfall Casque', chest: 'Emberfall Harness', hands: 'Emberfall Grips',    legs: 'Emberfall Tassets',   feet: 'Emberfall Striders' },
  vigil:     { head: 'Vigil Crown',      chest: 'Vigil Aegis',       hands: 'Vigil Fists',        legs: 'Vigil Greaves',       feet: 'Vigil Sabatons' },
};

const HEAD_ICONS = { issue: 'crown', ossuary: 'crown2', deepglass: 'crown', emberfall: 'crown2', vigil: 'crown' };

function pieceIcon(setId, slot) {
  const set = SETS[setId];
  if (slot === 'head') return HEAD_ICONS[setId];
  if (slot === 'chest') return set.chestIcon;
  if (slot === 'hands') return 'glove';
  if (slot === 'legs') return set.chestIcon; // stand-in — panel desaturates
  return 'bone';                             // feet stand-in
}

export const ARMOR_BASES = {};
for (const setId of Object.keys(SETS)) {
  const set = SETS[setId];
  for (const slot of ARMOR_SLOTS) {
    const id = `${setId}_${slot}`;
    ARMOR_BASES[id] = {
      id, kind: 'a', slot, setId,
      tier: set.tier, minRank: set.minRank, reqLevel: set.reqLevel,
      icon: pieceIcon(setId, slot),
      model: null, // no worn meshes this wave; step 12's part swap is the look
      name: PIECE_NAMES[setId][slot],
      blurb: set.flavour,
    };
  }
}

// Trinkets: no AP, no secondary, no set — ONE rolled exotic effect. The single
// best-supported slot in the icon pack (7 rings + 3 necklaces), and explicitly
// outside the set maths so there is always a slot no set can dictate.
// Effect keys and their consumers:
//   leech    -> the existing on-hit leech term
//   ashFind  -> multiplies shop.ashForXp at the payout site (via ashMul)
//   luck     -> feeds rollDrop / rollArmorDrop's existing `luck` parameter
//   mpRegen  -> flat mana-regen add
//   extract  -> feeds progression.extractionChance (its new extractAdd term)
const TRINKETS = [
  { id: 'ember_ring',         name: 'Ember Ring',         icon: 'ring1',     tier: 1, minRank: 0, reqLevel: 1,
    effect: { key: 'leech', lo: 0.01, hi: 0.03 },
    blurb: 'Warm on the hand that kills.' },
  { id: 'ash_band',           name: 'Ash Band',           icon: 'ring2',     tier: 2, minRank: 1, reqLevel: 6,
    effect: { key: 'ashFind', lo: 0.06, hi: 0.18 },
    blurb: 'It remembers what everything burned down to.' },
  { id: 'stillwater_pendant', name: 'Stillwater Pendant', icon: 'necklace1', tier: 2, minRank: 1, reqLevel: 8,
    effect: { key: 'mpRegen', lo: 0.3, hi: 0.9 },
    blurb: 'The calm is not yours. You are borrowing it.' },
  { id: 'fortune_loop',       name: 'Fortune Loop',       icon: 'ring5',     tier: 3, minRank: 2, reqLevel: 14,
    effect: { key: 'luck', lo: 0.05, hi: 0.15 },
    blurb: 'Gates open a little kinder for whoever wears it.' },
  { id: 'takers_chain',       name: "Taker's Chain",      icon: 'necklace2', tier: 4, minRank: 3, reqLevel: 22,
    effect: { key: 'extract', lo: 0.02, hi: 0.06 },
    blurb: 'The dead find it hard to refuse.' },
  { id: 'deep_fortune',       name: 'Deep Fortune',       icon: 'ring7',     tier: 5, minRank: 4, reqLevel: 34,
    effect: { key: 'luck', lo: 0.10, hi: 0.22 },
    blurb: 'Luck this old has opinions.' },
];
for (const t of TRINKETS) {
  ARMOR_BASES[t.id] = { ...t, kind: 't', slot: 'trinket', setId: null, model: null };
}

export const ARMOR_LIST = Object.values(ARMOR_BASES);

// ------------------------------------------------------------------ rolling

function between(rnd, lo, hi) { return lo + rnd() * (hi - lo); }

/**
 * Concrete armour (or trinket) instance from a base definition — rollWeapon's
 * structural twin. `rnd` may be a mulberry32-style function or a raw numeric
 * seed; passing the seed is what makes a piece storable as five short fields.
 *
 * FIXED stream order (the determinism contract): 1 rarity draw, then per affix
 * one pick draw + one magnitude draw (trinkets: 1 rarity draw + 1 magnitude
 * draw). The rarity is drawn even when one was forced, so a given seed lands on
 * the same rolls either way — exactly rollWeapon's trick.
 */
export function rollArmor(baseId, rnd, { rarity, level = 1, luck = 0, maxRarity = null } = {}) {
  const seed = typeof rnd === 'number' ? rnd >>> 0 : null;
  const r = seed === null ? rnd : mulberry32(seed);
  const base = ARMOR_BASES[baseId] || ARMOR_BASES.issue_chest;
  const rolled = rollRarity(r, luck);
  let key = (RARITIES[rarity] || RARITIES[rolled] || RARITIES.common).key;
  // rollWeapon's rank-band ceiling, identically: a downgrade AFTER the draw,
  // so forcing it consumes the stream exactly as not forcing it does.
  if (maxRarity && RARITY_ORDER.indexOf(key) > RARITY_ORDER.indexOf(maxRarity)) key = maxRarity;
  const rd = RARITIES[key];

  if (base.kind === 't') {
    // Rarity on a trinket scales the one magnitude via the SHIPPED rarity
    // multiplier (the same single ladder AP uses) — otherwise a legendary
    // trinket would be a common trinket with a gold border.
    const mag = between(r, base.effect.lo, base.effect.hi) * rd.mul;
    return {
      kind: 't', baseId: base.id, base, slot: 'trinket', setId: null,
      name: base.name, rarity: rd.key, rarityName: rd.name, tint: rd.color,
      tier: base.tier, level, seed, ap: 0,
      effect: { key: base.effect.key, mag },
      affixes: [], blurb: base.blurb,
      // Single comparable number, like rollWeapon's score. Normalised by the
      // effect's own hi so a 2% leech and a 15% luck compare within kind.
      score: Math.round((mag / base.effect.hi) * 100 * base.tier),
    };
  }

  const a = {
    kind: 'a', baseId: base.id, base, slot: base.slot, setId: base.setId,
    name: base.name, rarity: rd.key, rarityName: rd.name, tint: rd.color,
    tier: base.tier, level, seed,
    // Affix accumulators (the ARMOR_AFFIXES apply targets)…
    apMul: 1, hpMul: 1,
    // …and the per-slot secondaries the affixes stack onto.
    hpAdd: 0, tellAdd: 0, critDmgAdd: 0, atkSpeedAdd: 0, speedAdd: 0,
    dodgeAdd: 0, staggerResist: 0, knockTaken: 0, leech: 0, ashFind: 0,
    affixes: [], blurb: base.blurb,
  };
  SLOT_SECONDARY[a.slot](base.tier, a);

  // Without replacement, from a pool copy — no "Guarded Guarded Helm".
  const pool = ARMOR_AFFIX_KEYS.slice();
  for (let i = 0; i < rd.affixes && pool.length; i++) {
    const pick = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const af = ARMOR_AFFIXES[pick];
    const mag = between(r, af.lo, af.hi);
    af.apply(a, mag);
    a.affixes.push({ key: pick, name: af.name, mag });
  }

  // AP = SLOT_WEIGHT * TIER_AP * rarity mul (the spec formula), times Guarded.
  a.ap = SLOT_WEIGHT[a.slot] * TIER_AP[a.tier] * rd.mul * a.apMul;
  // Vital multiplies the PIECE's hp contribution, not the player's maxHp — a
  // 1.07^5 player-wide multiplier alone would blow the +35% survivability
  // envelope before AP contributed anything.
  a.hpAdd *= a.hpMul;
  if (a.affixes.length) a.name = `${a.affixes[0].name} ${base.name}`;
  // Single comparable number: AP carries it, secondaries tiebreak.
  a.score = Math.round(a.ap * 10 + a.hpAdd * 2 + (a.speedAdd + a.atkSpeedAdd + a.staggerResist + a.leech + a.ashFind) * 100);
  return a;
}

/** Pick an armour base weighted toward the player's depth, then roll it —
 * rollDrop's structural twin over ARMOR_LIST (trinkets included: gates are
 * their only source). Weight peaks where a piece becomes available and decays
 * as you outgrow it, so E-gates stop handing out Issue jackets forever. */
export function rollArmorDrop(rnd, { rankIndex = 0, level = 1, luck = 0 } = {}) {
  const eligible = [];
  let total = 0;
  for (let i = 0; i < ARMOR_LIST.length; i++) {
    const b = ARMOR_LIST[i];
    if (b.minRank > rankIndex) continue;
    const gap = rankIndex - b.minRank;
    const weight = 1 / (1 + gap * 0.7);
    eligible.push({ b, weight });
    total += weight;
  }
  if (!eligible.length) return null;
  let r = rnd() * total;
  let pickedId = eligible[0].b.id;
  for (let i = 0; i < eligible.length; i++) {
    r -= eligible[i].weight;
    if (r <= 0) { pickedId = eligible[i].b.id; break; }
  }
  // ONE deliberate deviation from rollDrop's shape: when handed a live stream,
  // draw a uint32 seed from it and roll from THAT. A dropped weapon lives as
  // an instance for the whole session, but armour is persisted as a
  // {k,b,r,s,l} record the moment it is picked up — rolled seedless, its seed
  // would serialize as the fallback 1 and the record would rebuild a DIFFERENT
  // item than the toast announced. Drawing the seed keeps the gate-stream
  // determinism (same replay, same seed) and makes the record faithful.
  const seed = typeof rnd === 'function' ? Math.floor(rnd() * 0x100000000) >>> 0 : rnd;
  // The legendary drop floor (RPG_SPEC step 14, gate1) binds the WHOLE loot
  // path, armour included: below band B a drawn legendary downgrades to epic.
  // Same trick as rollWeapon's — the rarity draw inside rollArmor happens
  // either way, so the stream is consumed identically and the L20 balance
  // envelope can never meet a full-legendary set it cannot legitimately own.
  return rollArmor(pickedId, seed, { level, luck, maxRarity: rankIndex >= 3 ? null : 'epic' });
}

// ------------------------------------------------------------------- codec
//
// Byte-compatible with serializeWeapon's output plus the kind marker the
// save.js sanitiser already understands ('a' armour, 't' trinket).

export function serializeArmor(a) {
  if (!a) return null;
  return { k: a.kind === 't' ? 't' : 'a', b: a.baseId, r: a.rarity, s: a.seed ?? 1, l: a.level ?? 1 };
}

export function deserializeArmor(rec) {
  if (!rec || !ARMOR_BASES[rec.b]) return null;
  return rollArmor(rec.b, (rec.s ?? 1) >>> 0, { rarity: rec.r, level: rec.l || 1 });
}

// ------------------------------------------------------------------ derived

/** Flat rows for the UI, weaponSummary's twin. */
export function armorSummary(a) {
  if (!a) return [];
  if (a.kind === 't') {
    const label = {
      leech: 'Leech', ashFind: 'Ash found', luck: 'Luck', mpRegen: 'Mana regen', extract: 'Bind chance',
    }[a.effect.key] || a.effect.key;
    const v = a.effect.key === 'mpRegen'
      ? `+${a.effect.mag.toFixed(1)}/s`
      : `+${(a.effect.mag * 100).toFixed(1)}%`;
    return [['Slot', 'Trinket'], [label, v]];
  }
  const rows = [
    ['Slot', a.slot.toUpperCase()],
    ['Set', SETS[a.setId]?.name || '—'],
    ['Armor', `${Math.round(a.ap)}`],
  ];
  if (a.hpAdd) rows.push(['Health', `+${Math.round(a.hpAdd)}`]);
  if (a.tellAdd) rows.push(['Tell lead', `+${Math.round(a.tellAdd)}ms`]);
  if (a.critDmgAdd) rows.push(['Crit dmg', `+${Math.round(a.critDmgAdd * 100)}%`]);
  if (a.atkSpeedAdd) rows.push(['Atk speed', `+${(a.atkSpeedAdd * 100).toFixed(1)}%`]);
  if (a.speedAdd) rows.push(['Speed', `+${a.speedAdd.toFixed(2)}`]);
  if (a.dodgeAdd) rows.push(['Dodge window', `+${Math.round(a.dodgeAdd * 1000)}ms`]);
  if (a.staggerResist) rows.push(['Stagger resist', `+${Math.round(a.staggerResist * 100)}%`]);
  if (a.knockTaken) rows.push(['Knockback taken', `-${Math.round(a.knockTaken * 100)}%`]);
  if (a.leech) rows.push(['Leech', `+${(a.leech * 100).toFixed(1)}%`]);
  if (a.ashFind) rows.push(['Ash found', `+${Math.round(a.ashFind * 100)}%`]);
  return rows;
}

/**
 * How many pieces of each set are worn. Counted over the FIVE armour slots
 * only — offhand and trinket never count. Accepts live instances or raw
 * {k,b,r,s,l} records, because the save stores records and the game holds
 * instances and both sides ask the same question.
 */
export function setProgress(equipment) {
  const m = new Map();
  if (!equipment) return m;
  for (const slot of ARMOR_SLOTS) {
    const it = equipment[slot];
    if (!it) continue;
    const base = ARMOR_BASES[it.baseId || it.b];
    if (!base || base.slot !== slot || !base.setId) continue;
    m.set(base.setId, (m.get(base.setId) || 0) + 1);
  }
  return m;
}

/**
 * Multiplicative stacking with the existing vitality DR, then the hard total
 * clamp: taken >= raw * (1 - TOTAL_DR_CAP). This is step 11's one call in
 * _damagePlayer; it lives here so the armour suite can assert the clamp
 * against a deliberately absurd loadout without booting the game.
 */
export function combinedDR(statDr, armorDR) {
  return Math.min(TOTAL_DR_CAP, 1 - (1 - statDr) * (1 - armorDR));
}

/**
 * The armour layer's whole derived contribution, from an equipment object
 * (records or instances) and the player level. Pure — recomputed on every
 * equip change, never cached in the save, because a cached stat line is
 * exactly the thing that drifts when tables are tuned.
 *
 * Numeric set bonuses (2/4-piece flat numbers) are folded in here; 5-piece
 * RULES are only reported in `rules` for the combat layer to implement.
 */
export function armorDerive(equipment, level = 1) {
  const out = {
    armorDR: 0, hpAdd: 0, speedAdd: 0, atkSpeedAdd: 0,
    staggerResist: 0, knockTakenMul: 1, leech: 0, ashFind: 0, ashMul: 1,
    tellAdd: 0, critDmgAdd: 0, dodgeAdd: 0,
    luckAdd: 0, mpRegenAdd: 0, extractAdd: 0,
    dashCdAdd: 0, finisherLeech: 0, shadowDmgMul: 1, shadowFieldAdd: 0,
    counts: new Map(), rules: [],
  };
  if (!equipment) return out;

  let ap = 0;
  let knockCut = 0;
  for (const slot of ARMOR_SLOTS) {
    let it = equipment[slot];
    if (!it) continue;
    if (!it.base) it = deserializeArmor(it);
    if (!it || it.kind !== 'a' || it.slot !== slot) continue;
    ap += it.ap;
    out.hpAdd += it.hpAdd;
    out.speedAdd += it.speedAdd;
    out.atkSpeedAdd += it.atkSpeedAdd;
    out.staggerResist += it.staggerResist;
    knockCut += it.knockTaken;
    out.leech += it.leech;
    out.ashFind += it.ashFind;
    out.tellAdd += it.tellAdd;
    out.critDmgAdd += it.critDmgAdd;
    out.dodgeAdd += it.dodgeAdd;
  }

  let tr = equipment.trinket;
  if (tr) {
    if (!tr.base) tr = deserializeArmor(tr);
    if (tr && tr.kind === 't' && tr.effect) {
      const { key, mag } = tr.effect;
      if (key === 'leech') out.leech += mag;
      else if (key === 'ashFind') out.ashFind += mag;
      else if (key === 'luck') out.luckAdd += mag;
      else if (key === 'mpRegen') out.mpRegenAdd += mag;
      else if (key === 'extract') out.extractAdd += mag;
    }
  }

  const counts = setProgress(equipment);
  out.counts = counts;
  let drMul = 1;
  for (const [setId, n] of counts) {
    const set = SETS[setId];
    if (!set) continue;
    for (const th of SET_THRESHOLDS) {
      if (n < th) continue;
      const b = set.bonuses[th];
      if (!b) continue;
      if (b.ashMul) out.ashMul *= b.ashMul;
      if (b.dashCdAdd) out.dashCdAdd += b.dashCdAdd;
      if (b.armorDrMul) drMul *= b.armorDrMul;
      if (b.staggerResistAdd) out.staggerResist += b.staggerResistAdd;
      if (b.knockTakenMul) out.knockTakenMul *= b.knockTakenMul;
      if (b.speedAdd) out.speedAdd += b.speedAdd;
      if (b.dodgeAdd) out.dodgeAdd += b.dodgeAdd;
      if (b.atkSpeedAdd) out.atkSpeedAdd += b.atkSpeedAdd;
      if (b.finisherLeech) out.finisherLeech += b.finisherLeech;
      if (b.shadowDmgMul) out.shadowDmgMul *= b.shadowDmgMul;
      if (b.shadowFieldAdd) out.shadowFieldAdd += b.shadowFieldAdd;
      if (b.rule) out.rules.push({ setId, key: b.rule, text: b.text, bonus: b });
    }
  }

  // The soft curve: asymptotes below 1, denominator grows with level, so a
  // tier-1 set decays into irrelevance without an expiry rule. The ossuary
  // 2-piece multiplies the TERM (before the total clamp, which combinedDR
  // owns) — it can nudge armorDR past its natural asymptote and that is fine,
  // because the 0.72 total clamp is the wall.
  out.armorDR = drMul * (ap / (ap + 90 + 26 * level));
  // Hard armour-internal clamps. speed: ARMOR_SPEED_CAP across ALL armour
  // sources (secondaries + Fleet + deepglass 2-piece). knockback: the
  // secondary/affix cut clamps at 0.50, then the ossuary 4-piece multiplies —
  // set bonuses are rules about a number, not entries in the same budget.
  out.speedAdd = Math.min(ARMOR_SPEED_CAP, out.speedAdd);
  out.staggerResist = Math.min(STAGGER_RESIST_CAP, out.staggerResist);
  out.knockTakenMul *= 1 - Math.min(KNOCK_TAKEN_CAP, knockCut);
  // One multiplier for the payout site: affix/trinket ash-find and the issue
  // 2-piece compound.
  out.ashMul *= 1 + out.ashFind;
  return out;
}
