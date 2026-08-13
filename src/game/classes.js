// The three character-identity layers of CLASSES_SPEC, as data plus pure
// functions: (A) DIRECTIONS — derived every read from save.stats, never chosen
// in a menu; (B) CLASSES — a benefit AND a drawback each, chosen at the Assay
// Hall at level 20, soft-matched to the direction through RESONANCE; (C)
// ARCHONS — the five endgame paths, of which SHADOW is the one the codebase
// already half-built.
//
// THREE-free and DOM-free on purpose, exactly like progression.js and
// config.js: tools/classes-test.mjs drives this file in bare node. It must
// never import game.js, weapons.js, or anything that pulls THREE.
//
// THE MIGRATION GUARANTEE (asserted first in tools/classes-test.mjs, and the
// last assert allowed to fail): applyLayers(save, derived) returns a derived
// block DEEP-EQUAL to its input whenever save.className is null — which is
// every save in existence on the day this ships. Directions and masteries are
// deliberately NOT applied here: masteries are earned by stats alone, so if
// CERTAINTY's floor override lived in this function, a high-PER save with no
// class would change numbers on an update it never asked for. Mastery effects
// (including the two sanctioned derived-block exceptions, CERTAINTY and TEMPO)
// are combat-hook business — build-order STEP 4, game.js — and their numeric
// parameters live here only as data.

import { STATS, STAT_RATES, SKILLS } from './config.js';

// ---------------------------------------------------------------------------
// LAYER A — DIRECTIONS
// ---------------------------------------------------------------------------

// 60 / 120 / 200 SPENT points in one stat. autoStats never counts: it grows
// +1-per-level in every stat equally, so counting it would hand every mastery
// to every player for free by the level-200 equivalent and evaporate the layer.
export const MASTERY_THRESHOLDS = [60, 120, 200];

// Every mastery is a BEHAVIOUR (a cap, a proc, a refund, a field) rather than
// a flat multiplier on the derived block — that is the spec's primary
// anti-power-creep rule. CERTAINTY and TEMPO are the two sanctioned, capped
// exceptions. The numeric params are data for the STEP 4 combat hooks; nothing
// in THIS module applies them.
export const DIRECTIONS = {
  vit: {
    key: 'vit', name: 'BULWARK',
    masteries: [
      { tier: 1, spent: 60,  key: 'ironhide',   name: 'IRONHIDE',   params: { maxHitFracOfMaxHp: 0.12 } },
      { tier: 2, spent: 120, key: 'riposte',    name: 'RIPOSTE',    params: { returnFrac: 0.25, radius: 3.5, cooldown: 0.9, minHpFrac: 0.5 } },
      { tier: 3, spent: 200, key: 'unyielding', name: 'UNYIELDING', params: { cooldown: 90, invulnSeconds: 2.0 } },
    ],
  },
  agi: {
    key: 'agi', name: 'WINDSTEP',
    masteries: [
      { tier: 1, spent: 60,  key: 'slipstream', name: 'SLIPSTREAM', params: { atkSpeedBonus: 0.35, seconds: 0.6 } },
      { tier: 2, spent: 120, key: 'answer',     name: 'ANSWER',     params: { window: 1.2, critMul: 1.3 } },
      { tier: 3, spent: 200, key: 'tempo',      name: 'TEMPO',      params: { chainWindow: 4, maxStacks: 5, speedPctPerStack: 0.08, critDmgPerStack: 0.06, decayEvery: 2 } },
    ],
  },
  int: {
    key: 'int', name: 'EMBERMIND',
    masteries: [
      { tier: 1, spent: 60,  key: 'kindling',   name: 'KINDLING',   params: { refundFrac: 0.20, window: 3 } },
      { tier: 2, spent: 120, key: 'residue',    name: 'RESIDUE',    params: { radius: 4, seconds: 3, atkFracPerSecond: 0.12, maxFields: 3 } },
      { tier: 3, spent: 200, key: 'overcharge', name: 'OVERCHARGE', params: { every: 4, window: 10, dmgMul: 1.6 } },
    ],
  },
  str: {
    key: 'str', name: 'BREAKER',
    masteries: [
      { tier: 1, spent: 60,  key: 'sunder',     name: 'SUNDER',     params: { bonusTakenPct: 0.18, seconds: 5 } },
      { tier: 2, spent: 120, key: 'aftershock', name: 'AFTERSHOCK', params: { radius: 5, atkFrac: 0.40 } },
      { tier: 3, spent: 200, key: 'ruinous',    name: 'RUINOUS',    params: { staggerEvery: 3, staggerRadius: 7, staggerSeconds: 0.8 } },
    ],
  },
  per: {
    key: 'per', name: 'AUGUR',
    masteries: [
      { tier: 1, spent: 60,  key: 'reading',    name: 'READING',    params: { maxArcs: 6 } },
      { tier: 2, spent: 120, key: 'punish',     name: 'PUNISH',     params: { bonusPct: 0.30, cancelChance: 0.25 } },
      // The two sanctioned derived-block exceptions live under CERTAINTY and
      // TEMPO. Applied by the STEP 4 hooks, never by applyLayers — see the
      // header for why.
      { tier: 3, spent: 200, key: 'certainty',  name: 'CERTAINTY',  params: { dmgFloor: 1.0, critDmgAdd: 0.25 } },
    ],
  },
};

/**
 * What the player's spending has already made them. Reads save.stats — the
 * SPENT record — only: effectiveStat()'s auto grant raises every stat equally,
 * so including it would drag everyone to 'unsworn' at low level and to
 * whatever they happened to lead in at high level. Direction is about CHOICES.
 *
 * Ties break by STATS array order (strict `>` keeps the earlier key), never by
 * object-iteration order — deterministic across engines by construction.
 */
export function directionOf(save) {
  const s = save?.stats || {};
  let spent = 0;
  let lead = 'str';
  let leadVal = -1;
  for (const st of STATS) {
    const v = s[st.key] || 0;
    spent += v;
    if (v > leadVal) { lead = st.key; leadVal = v; }
  }
  // spent >= 30 lands at level 7 all-in, 10-12 for a normal spread — a
  // direction exists by the time Bind unlocks at 12. The 35% share bar is
  // inclusive: 35.0% exactly is a direction, 34.9% is not.
  if (spent < 30) return 'unsworn';
  if (leadVal / spent < 0.35) return 'unsworn';
  return lead;
}

/** Mastery tier (0-3) earned in one stat, from SPENT points only. */
export function masteryTier(save, statKey) {
  const v = save?.stats?.[statKey] || 0;
  let t = 0;
  for (const th of MASTERY_THRESHOLDS) if (v >= th) t++;
  return t;
}

/**
 * Every mastery this save owns, flattened for the stat panel and the combat
 * hooks. Masteries are per-stat thresholds INDEPENDENT of directionOf(): a
 * 200/145 str/vit build owns BREAKER T3 and BULWARK T2 at once. Direction is
 * the label and the resonance key; masteries are the payout — keeping them
 * separate is what stops the layer from producing dead ends after a respec.
 */
export function masteriesOf(save) {
  const out = [];
  for (const st of STATS) {
    const tier = masteryTier(save, st.key);
    const dir = DIRECTIONS[st.key];
    for (let t = 1; t <= tier; t++) {
      const m = dir.masteries[t - 1];
      out.push({ stat: st.key, tier: t, key: m.key, name: m.name });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LAYER B — CLASSES
// ---------------------------------------------------------------------------

// The EXISTING save.classTier ('base'|'advanced'|'sovereign', earned at the
// level-40 trial) reinterpreted as CLASS QUALITY: a multiplier on the class's
// BENEFIT terms only. Drawbacks are never scaled by quality — a better trial
// makes you better at your class, it does not excuse it.
export const CLASS_QUALITY = { base: 1.00, advanced: 1.12, sovereign: 1.25 };

// Per-tier resonance scaling: benefits x (1 + 0.04r), drawbacks x (1 - 0.02r).
// At resonance 3 a class is 12% better at what it is good at and 6% less
// punished for what it is bad at — roughly one weapon rarity step, per the
// spec's worstCaseSpread sizing: noticeable, chase-worthy, nowhere near
// mandatory.
export const RESONANCE_BENEFIT_PER_TIER = 0.04;
export const RESONANCE_DRAWBACK_PER_TIER = 0.02;

// The class layer's fold clamp: sumPct per derived field lives in
// [-0.5, +0.6], whatever combination of quality, resonance and future content
// stacks up. A guardrail against Wave 4, not against anything in this file.
export const SUM_PCT_CLAMP = [-0.5, 0.6];

// Balance guard: no class term may raise a fraction-valued cap by more than
// 15 percentage points past its STAT_RATES value, even after quality and
// resonance scaling (sovereign x resonance 3 = 1.40 would push HEXWEAVER's
// +12 cdr raise to +16.8 without this).
const CAP_RAISE_LIMIT = 0.15;

// The base caps class capRaise terms are measured from. Sourced from
// STAT_RATES so a designer retune moves both at once.
const BASE_CAPS = {
  dr: STAT_RATES.vit.drCap,             // 0.45
  crit: STAT_RATES.agi.critCap,         // 0.55
  atkSpeed: STAT_RATES.str.atkSpeedCap, // 0.30
  cdr: STAT_RATES.int.cdrCap,           // 0.40
  dmgFloor: STAT_RATES.per.floorCap,    // 0.92
  dodgeWindow: STAT_RATES.agi.dodgeCapMs / 1000, // 0.260 s
};

// Fields whose caps are fractions (the +15-point raise limit applies).
// tellLeadMs is milliseconds and dodgeWindow raises are expressed as
// capReplace (an absolute new cap), so neither appears here.
const FRACTION_CAP_FIELDS = new Set(['dr', 'crit', 'atkSpeed', 'cdr', 'dmgFloor']);

// Term-set schema, per class, per side (benefit / drawback):
//   pct        {field: fraction}  joins the field's summed-pct pool
//   add        {field: flat}      joins the field's flat pool (applied after pct)
//   capRaise   {field: delta}     BENEFIT ONLY: new cap = BASE_CAPS[field] +
//                                 delta x benefitScale, delta clamped to
//                                 CAP_RAISE_LIMIT for fraction fields. Marks
//                                 the field cap-raised, so applyModifiers
//                                 recovers the pre-clamp raw from save.stats.
//   capReplace {field: cap}       an absolute cap, never scaled. Under benefit
//                                 it also marks the field cap-raised (ORACLE's
//                                 floor 1.00); under drawback it is a hard
//                                 lower (VANGUARD's crit 0.30) — lowest wins.
//   flagsScaled{k: n}             numeric behaviour magnitudes the consumer
//                                 (STEP 4/5 hooks) multiplies by this side's
//                                 scale — classModifiers pre-multiplies them.
//   flags      {k: v}             shape constants (durations, counts, lists,
//                                 booleans) that scaling must never touch.
//
// Drawbacks render in the SAME TYPE SIZE as benefits everywhere, forever —
// benefitText/drawbackText are the panel strings and both are mandatory.
export const CLASSES = {
  vanguard: {
    key: 'vanguard', name: 'VANGUARD', affinity: ['vit'],
    fantasy: 'The one who is still standing when the room stops moving.',
    benefitText: '+14% MAX HP. RAISES THE DR CAP TO 55% (FROM 45%). 25% OF EVERY HIT ARRIVES AS A 3S BLEED — KILL ANYTHING AND THE REMAINDER IS CANCELLED.',
    drawbackText: '-12% MOVE SPEED. DASH DISTANCE -20%. CRIT RATE CAPPED AT 30%.',
    benefit: {
      pct: { maxHp: 0.14 },
      capRaise: { dr: 0.10 },
      // bleedFrac is the shape of the mitigation, not a magnitude to inflate —
      // scaling it up would DEFER more damage, which is not obviously better.
      flags: { bleedFrac: 0.25, bleedSeconds: 3, bleedCancelOnKill: true },
    },
    drawback: {
      pct: { speed: -0.12, dashDistance: -0.20 },
      capReplace: { crit: 0.30 },
    },
  },
  berserker: {
    key: 'berserker', name: 'BERSERKER', affinity: ['str'],
    fantasy: 'Every wound is an argument for swinging harder.',
    benefitText: 'ATTACK +0.45% PER 1% MISSING HP, TO +40% AT THE EDGE. RAISES THE ATTACK-SPEED CAP TO 36% (FROM 30%).',
    drawbackText: 'HEALING RECEIVED -35%. HP REGEN -50%. DROPS THE DR CAP TO 25% (FROM 45%).',
    benefit: {
      capRaise: { atkSpeed: 0.06 },
      flagsScaled: { rageMaxAtkBonus: 0.40, rageAtkPerMissingHpPct: 0.0045 },
    },
    drawback: {
      pct: { hpRegen: -0.50 },
      // The harshest drawback in the roster because the benefit is the
      // largest. Cap DROPS are never softened by resonance — lowest cap wins.
      capReplace: { dr: 0.25 },
      flagsScaled: { healingTakenPct: -0.35 },
    },
  },
  bladedancer: {
    key: 'bladedancer', name: 'BLADEDANCER', affinity: ['agi'],
    fantasy: 'Never in the same place the blow was aimed at.',
    benefitText: 'CUTS DASH COOLDOWN TO 1.05S (FROM 1.60S). EXTENDS DASH I-FRAMES TO 0.42S (FROM 0.34S). +12% CRIT DAMAGE. PERFECT-DODGE WINDOW +40MS (CAP 300MS).',
    drawbackText: '-18% MAX HP. -15% ATTACK. KNOCKBACK TAKEN +40%.',
    benefit: {
      pct: { critDmg: 0.12 },
      add: { dashCd: -0.55, dashIframes: 0.08, dodgeWindow: 0.040 },
      // The roster text's 300 ms is the law; the worked example's 310 ms
      // ignores its own stated cap and loses.
      capReplace: { dodgeWindow: 0.300 },
    },
    drawback: {
      pct: { maxHp: -0.18, atk: -0.15 },
      add: { knockTakenMul: 0.40 },
    },
  },
  hexweaver: {
    key: 'hexweaver', name: 'HEXWEAVER', affinity: ['int'],
    fantasy: 'The blade is a formality.',
    benefitText: '+25% SKILL DAMAGE. RAISES THE COOLDOWN-REDUCTION CAP TO 52% (FROM 40%). MP REGEN +60%.',
    drawbackText: '-25% BASIC-ATTACK DAMAGE. -20% ATTACK SPEED. -12% MAX HP.',
    benefit: {
      pct: { skillMul: 0.25, mpRegen: 0.60 },
      capRaise: { cdr: 0.12 },
    },
    drawback: {
      pct: { atkSpeed: -0.20, maxHp: -0.12 },
      // Basic-attack damage is a swing-time term, not a derived field — the
      // penalty that stops HEXWEAVER being "INT but better" rides as a flag.
      flagsScaled: { basicAtkPct: -0.25 },
    },
  },
  binder: {
    key: 'binder', name: 'BINDER', affinity: ['int', 'per'],
    fantasy: 'You arrived alone. That was an oversight.',
    benefitText: 'ROSTER +25%. FIELD +2 (QUALITY TIER STILL RULES). SHADOW DAMAGE +20%. EXTRACTION +12 PTS.',
    drawbackText: '-20% ATTACK. -15% MAX HP. NOVA AND RUIN COST +30% MANA.',
    benefit: {
      pct: { shadowDmgMul: 0.20 },
      // fieldAdd joins shadowFieldCapacity's EARNED term — quality.js
      // maxFieldShadows still clamps it, no exceptions. Unscaled: headcount
      // is a draw-call budget, not a knob quality may inflate.
      flags: { fieldAdd: 2 },
      flagsScaled: { rosterPct: 0.25, extractAdd: 0.12 },
    },
    drawback: {
      pct: { atk: -0.20, maxHp: -0.15 },
      flags: { skillCostSkills: ['slash', 'nova'] },
      flagsScaled: { skillCostPct: 0.30 },
    },
  },
  oracle: {
    key: 'oracle', name: 'ORACLE', affinity: ['per'],
    fantasy: 'You have already seen this fight.',
    benefitText: 'DAMAGE FLOOR +20 PTS (100% REACHABLE). TELEGRAPH LEAD +120MS. +18% DAMAGE TO ENEMIES WINDING UP.',
    drawbackText: '-20% CRIT RATE. -10% MOVE SPEED. SKILLS COST +25% MANA.',
    benefit: {
      add: { dmgFloor: 0.20, tellLeadMs: 120 },
      // The floor may reach exactly 100% — no low rolls, ever — and no more.
      // tellLeadMs gets headroom above the 520 stat cap for its +120 add.
      capReplace: { dmgFloor: 1.00, tellLeadMs: 640 },
      flagsScaled: { windupDmgPct: 0.18 },
    },
    drawback: {
      pct: { crit: -0.20, speed: -0.10 },
      flags: { skillCostSkills: ['attack', 'dash', 'slash', 'nova', 'summon'] },
      flagsScaled: { skillCostPct: 0.25 },
    },
  },
  templar: {
    key: 'templar', name: 'TEMPLAR', affinity: ['vit', 'int'],
    fantasy: 'Faith is a load-bearing structure.',
    benefitText: '30% OF INT COUNTS AS VIT FOR HP AND DR. SKILLS HEAL 6% OF THE DAMAGE THEY DEAL.',
    drawbackText: '-20% SKILL DAMAGE. -15% CRIT RATE. ALL COOLDOWNS +15%.',
    benefit: {
      // The INT-as-VIT conversion depends on the save, so it is computed in
      // classModifiers via `dynamic` — flat adds at VIT's own STAT_RATES, so a
      // retune of vitality re-prices TEMPLAR automatically.
      dynamic: (save) => {
        const intEff = (save?.stats?.int || 0) + (save?.autoStats || 0);
        return { add: { maxHp: 0.30 * intEff * STAT_RATES.vit.hp, dr: 0.30 * intEff * STAT_RATES.vit.dr } };
      },
      // The converted DR still answers to VIT's own 45% cap — TEMPLAR raises
      // nothing, it just fills the same tank from a second stat.
      capReplace: { dr: STAT_RATES.vit.drCap },
      flagsScaled: { spellLeechPct: 0.06 },
    },
    drawback: {
      pct: { skillMul: -0.20, crit: -0.15 },
      flagsScaled: { cooldownPct: 0.15 },
    },
  },
  reaver: {
    key: 'reaver', name: 'REAVER', affinity: ['str', 'agi'],
    fantasy: 'Momentum is the only defence worth having.',
    benefitText: '+3% LIFE LEECH ON ALL DAMAGE. KILLS GRANT +6% SPEED / +4% ATTACK SPEED FOR 4S, STACKING TO 5.',
    drawbackText: '-25% MAX MP. SKILLS COST +40% MANA. -10% MAX HP.',
    benefit: {
      flags: { killStackMax: 5, killStackSeconds: 4 },
      flagsScaled: { leechPct: 0.03, killStackSpeedPct: 0.06, killStackAtkSpeedPct: 0.04 },
    },
    drawback: {
      pct: { maxMp: -0.25, maxHp: -0.10 },
      flags: { skillCostSkills: ['attack', 'dash', 'slash', 'nova', 'summon'] },
      flagsScaled: { skillCostPct: 0.40 },
    },
  },
};

export const CLASS_LIST = Object.values(CLASSES);

/**
 * RESONANCE: how deeply the player's derived direction agrees with the class.
 * affinityMatched = directionOf(save) is one of the class's affinity keys; the
 * tier is then the mastery tier in that MATCHED stat. Soft synergy — a
 * mismatched class works at full stated terms, it just earns no discount.
 */
export function resonanceOf(save) {
  const cls = CLASSES[save?.className];
  if (!cls) return 0;
  const dir = directionOf(save);
  if (!cls.affinity.includes(dir)) return 0;
  return masteryTier(save, dir);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The [-0.5, +0.6] fold clamp, exported so the test can pin both ends. */
export function clampSumPct(p) {
  return clamp(p, SUM_PCT_CLAMP[0], SUM_PCT_CLAMP[1]);
}

// The pre-clamp value a cap-raised field would have had, recomputed from the
// save's own stats. Needed because derive() already clamped the field at its
// base cap — a raised cap is worthless unless the clamped-off remainder can be
// recovered. Stat terms only: an armour add lost to the base clamp stays lost
// (documented trade — recovering it would need the armour block plumbed
// through, and the stat term is the overwhelming share of every capped value).
function rawStatValue(field, save) {
  const s = save?.stats || {};
  const auto = save?.autoStats || 0;
  const R = STAT_RATES;
  switch (field) {
    case 'dr':          return ((s.vit || 0) + auto) * R.vit.dr;
    case 'crit':        return 0.05 + ((s.agi || 0) + auto) * R.agi.crit;
    case 'atkSpeed':    return ((s.str || 0) + auto) * R.str.atkSpeed;
    case 'cdr':         return ((s.int || 0) + auto) * R.int.cdr;
    case 'dmgFloor':    return R.per.floorBase + ((s.per || 0) + auto) * R.per.floor;
    case 'dodgeWindow': return (R.agi.dodgeBaseMs + ((s.agi || 0) + auto) * R.agi.dodgeWindowMs) / 1000;
    case 'tellLeadMs':  return R.per.tellBaseMs + ((s.per || 0) + auto) * R.per.tellMs;
    default:            return 0;
  }
}

// Bases for fields the derived block does not carry yet. Seeded only when a
// class term actually touches the field, so the null case adds no keys.
function defaultFieldBase(field) {
  switch (field) {
    case 'dashDistance': return SKILLS.dash.distance; // 7.5
    case 'dashIframes':  return SKILLS.dash.iframes;  // 0.34
    case 'dashCd':       return SKILLS.dash.cd;       // 1.60 (derive() already outputs this post-armour)
    case 'knockTakenMul': return 1;                   // ditto
    default:             return 0;
  }
}

// Lowest cap wins when two terms disagree — BERSERKER's 25% DR cap beats a
// hypothetical future raise, per the balance guards.
function mergeCap(caps, field, value) {
  caps[field] = caps[field] === undefined ? value : Math.min(caps[field], value);
}

/**
 * The chosen class's whole numeric contribution, pre-scaled by quality and
 * resonance. Returns null when no (valid) class is chosen — the caller treats
 * that as "the class layer does not exist", which is the migration guarantee.
 *
 * Shape: { pct, add, caps, capRaisedFields, flags, benefitScale,
 *          drawbackScale, resonance, quality } — pct/add/caps per the spec's
 * export list; the rest is what the STEP 4/5 consumers need to apply flags
 * without re-deriving the scaling rules.
 */
export function classModifiers(save) {
  const cls = CLASSES[save?.className];
  if (!cls) return null;
  const quality = CLASS_QUALITY[save.classTier] || CLASS_QUALITY.base;
  const resonance = resonanceOf(save);
  // Quality and resonance both scale BENEFITS; only resonance (softening)
  // touches drawbacks, and quality never does — a better trial makes you
  // better at your class, it does not excuse it.
  const benefitScale = quality * (1 + RESONANCE_BENEFIT_PER_TIER * resonance);
  const drawbackScale = 1 - RESONANCE_DRAWBACK_PER_TIER * resonance;

  const pct = {};
  const add = {};
  const caps = {};
  const capRaisedFields = new Set();
  const flags = {};

  const fold = (side, scale, isBenefit) => {
    if (!side) return;
    for (const [f, v] of Object.entries(side.pct || {})) pct[f] = (pct[f] || 0) + v * scale;
    for (const [f, v] of Object.entries(side.add || {})) add[f] = (add[f] || 0) + v * scale;
    if (side.dynamic) {
      const dyn = side.dynamic(save) || {};
      for (const [f, v] of Object.entries(dyn.pct || {})) pct[f] = (pct[f] || 0) + v * scale;
      for (const [f, v] of Object.entries(dyn.add || {})) add[f] = (add[f] || 0) + v * scale;
    }
    for (const [f, d] of Object.entries(side.capRaise || {})) {
      // capRaise is benefit-only by schema; the raise delta scales, the base
      // does not, and fraction fields respect the +15-point guard.
      const delta = FRACTION_CAP_FIELDS.has(f) ? Math.min(CAP_RAISE_LIMIT, d * scale) : d * scale;
      mergeCap(caps, f, (BASE_CAPS[f] ?? 0) + delta);
      capRaisedFields.add(f);
    }
    for (const [f, v] of Object.entries(side.capReplace || {})) {
      mergeCap(caps, f, v);
      // A benefit-side replace (ORACLE floor 1.00, BLADEDANCER window 300ms)
      // grants headroom, so the raw recovery applies; a drawback-side replace
      // is a pure lower and must NOT recover clamped-off raw.
      if (isBenefit) capRaisedFields.add(f);
    }
    for (const [k, v] of Object.entries(side.flags || {})) flags[k] = v;
    for (const [k, v] of Object.entries(side.flagsScaled || {})) flags[k] = v * scale;
  };
  fold(cls.benefit, benefitScale, true);
  fold(cls.drawback, drawbackScale, false);

  return { pct, add, caps, capRaisedFields, flags, benefitScale, drawbackScale, resonance, quality };
}

/**
 * Fold one modifier set into a derived block. Split from applyLayers so the
 * test can drive the clamp with synthetic term sets no real class produces.
 *
 * Per field: final = base x (1 + clamp(sumPct, -0.5, +0.6)) + sumAdd, then
 * caps (lowest wins; cap-raised fields recover their pre-clamp stat raw),
 * then the handful of hard floors. Returns a NEW object; never mutates.
 */
export function applyModifiers(derived, mods, save) {
  const out = { ...derived };
  const touched = new Set([...Object.keys(mods.pct || {}), ...Object.keys(mods.add || {})]);
  for (const f of touched) {
    const base = out[f] !== undefined ? out[f] : defaultFieldBase(f);
    out[f] = base * (1 + clampSumPct(mods.pct?.[f] || 0)) + (mods.add?.[f] || 0);
  }
  for (const [f, cap] of Object.entries(mods.caps || {})) {
    const cur = out[f] !== undefined ? out[f] : defaultFieldBase(f);
    // A raised cap re-admits value derive() clamped off; a lowered cap only
    // ever cuts. max(cur, rawStat) is exact for stat-only values and loses
    // nothing when the field was never clamped (cur is already the raw).
    const eligible = mods.capRaisedFields?.has(f) ? Math.max(cur, rawStatValue(f, save)) : cur;
    out[f] = Math.min(cap, eligible);
  }
  // Hard floors, matching derive()'s own: the dash can never become a free
  // permanent i-frame, and HP/MP stay integers as everywhere else in the game.
  if (out.dashCd !== undefined) out.dashCd = Math.max(0.5, out.dashCd);
  if (out.maxHp !== derived.maxHp && out.maxHp !== undefined) out.maxHp = Math.max(1, Math.floor(out.maxHp));
  if (out.maxMp !== derived.maxMp && out.maxMp !== undefined) out.maxMp = Math.max(0, Math.floor(out.maxMp));
  return out;
}

/**
 * The one entry point game.refreshDerived pipes derive() through (STEP 3).
 *
 * THE MIGRATION GUARANTEE: with className null (or unknown — the sanitiser
 * upstream should have caught it, but defence in depth), the return is a
 * fresh object deep-equal to the input. The ARCHON layer touches NOTHING here
 * by design — interlock rule: an archon path reads the final derived block
 * and operates on its own resources; no archon term ever enters these pools.
 * That is why save.archon is deliberately never consulted in this function.
 */
export function applyLayers(save, derived) {
  const mods = classModifiers(save);
  if (!mods) return { ...derived };
  return applyModifiers(derived, mods, save);
}

/**
 * The Assay Hall gate: level 20, and no class yet. Rechoosing an already-set
 * class is a different, priced path (an ASSAY SEAL — STEP 5's business), so
 * this function saying false for a classed save is correct, not a bug.
 */
export function canChooseClass(save) {
  return (save?.level || 0) >= 20 && (save?.className == null);
}

/**
 * Commit to a class. Free — the commitment IS the cost — and it banks one
 * respec token, once per profile ever: directions and masteries change what a
 * stat spread is worth, so the moment of choosing is the moment the player
 * most deserves a free re-read of their points. The once-guard lives inside
 * archonState so neither re-choice nor repeated migration can mint tokens.
 */
export function chooseClass(save, key) {
  if (!canChooseClass(save)) return false;
  if (!CLASSES[key]) return false;
  save.className = key;
  const st = ensureArchonState(save);
  if (!st.classTokenGranted) {
    st.classTokenGranted = true;
    save.respecTokens = Math.min(99, (save.respecTokens || 0) + 1);
  }
  return true;
}

// --------------------------------------------------------------- rechoosing
// One ASSAY SEAL, bought at the Assay Hall for 1,800 ash — or free the FIRST
// time, because every player deserves one look at a class they picked from a
// menu at level 20. Not free thereafter: the drawbacks are the whole design,
// and a free swap makes the optimal play "hold the class whose drawback does
// not apply to the current fight", which stops the layer being a commitment.
export const ASSAY_SEAL_COST = 1800;

/** A reseal exists only for a save that already swore a class. */
export function canRechooseClass(save) {
  return Boolean(CLASSES[save?.className]);
}

/** What the NEXT reseal costs in ash: 0 while the free first seal is unspent. */
export function rechooseCost(save) {
  return save?.archonState?.freeSealUsed ? ASSAY_SEAL_COST : 0;
}

/**
 * Swap className for a different class. Buying the seal and spending it are
 * ATOMIC — the panel never banks a seal the player could pay for and then
 * abandon. Changes className ONLY: classTier (quality), stats, direction,
 * archon, roster and stash are all untouched, and no respec token is minted
 * (chooseClass's once-guard has already burned; a reseal is a second look,
 * not a second reward).
 */
export function rechooseClass(save, key) {
  if (!canRechooseClass(save)) return false;
  if (!CLASSES[key] || key === save.className) return false;
  const st = ensureArchonState(save);
  if (st.freeSealUsed) {
    if ((save.ash || 0) < ASSAY_SEAL_COST) return false;
    save.ash -= ASSAY_SEAL_COST;
  } else {
    st.freeSealUsed = true;
  }
  save.className = key;
  return true;
}

// ---------------------------------------------------------------------------
// LAYER C — ARCHONS
// ---------------------------------------------------------------------------

// Fixed offer/tie order. Shadow first: it is always offerable (Bind is
// available to every build), so on an all-zero counter spread — every
// migrated save's first session — the offer reads [shadow, flame].
export const ARCHON_KEYS = ['shadow', 'flame', 'frost', 'storm', 'beast'];

// Resource rules are data for the STEP 6 ResourceMeter; parity axes are the
// spec's arithmetic parity table, carried here so the STEP 11 harness asserts
// against the shipped numbers rather than a copy in the test. Composite
// weights: room clear is the primary experience (0.35), the boss chamber is
// the payoff (0.30), dying ends the run (0.25), and mobility is small but
// non-zero so the movement path is not paying for a stat nobody scores.
export const PARITY_WEIGHTS = { roomDps: 0.35, bossDps: 0.30, eHP: 0.25, mobility: 0.10 };

export const ARCHONS = {
  shadow: {
    key: 'shadow', name: 'SHADOW ARCHON',
    identity: 'Command. You do not fight the room; you bring one.',
    // No banked resource — the army IS the resource. The ultimate rides a
    // plain cooldown (LEGION STEP, 45 s), not a meter.
    resourceName: null,
    resourceRules: { max: 0, gainPer: 0, decayPerSecond: 0, ultimateCost: 0, ultimateCooldown: 45 },
    parity: { roomDps: 1.12, bossDps: 0.88, eHP: 1.05, mobility: 0.85 },
    // SOVEREIGN'S WILL (STEP 8) — the path's numbers as DATA, so game.js's
    // mechanics and the node suite read the same source and cannot drift.
    sovereignsWill: {
      // The three command states. HUNT is the shipped _updateShadows
      // behaviour VERBATIM (the 26 m nearest-enemy scan), which is why a
      // non-shadow save — whose stance is pinned to 'hunt' — is byte-
      // identical to today.
      stances: ['hold', 'hunt', 'focus'],
      holdRing: 4,        // HOLD: the formation leash around the player
      // HOLD's intercept envelope: the 4 m ring plus the soldiers' own
      // ~2 m engage reach — an enemy at 6 m is strikeable by a soldier
      // standing ON the ring, so interception never pulls the wall apart.
      holdIntercept: 6,
      huntRange: 26,      // HUNT: the shipped scan radius, unchanged
      // FIELD CAPACITY +2 — joins shadowFieldCapacity's EARNED term (the
      // same seam the vigil 4pc uses), so quality.js maxFieldShadows and
      // the hard 12 still get the final word: on a low tier this grants
      // nothing and the path is fine, because a Shadow Archon's damage
      // rides gradeMultiplier and shadowDmgMul, not headcount.
      fieldBonus: 2,
      // The tap on the archon slot is LEGION STEP (interlock.theOneSlot);
      // Bind moves to a hold. 0.35 s sits between a deliberate hold and a
      // twitch tap — the same threshold the stow long-press already taught.
      bindHoldSeconds: 0.35,
      // LEGION STEP: recall instantly, detonate for 60% of each soldier's
      // OWN atk in 4 m, re-form at the player's side over 6 s at 50% HP.
      // Cooldown is resourceRules.ultimateCooldown (45 s) — the one clock
      // this meterless path owns.
      legion: { detonatePct: 0.6, radius: 4, reformSeconds: 6, reformHpPct: 0.5 },
    },
  },
  flame: {
    key: 'flame', name: 'FLAME ARCHON',
    identity: 'Ignition. Nothing you hit stops burning, and burning things set fire to each other.',
    resourceName: 'EMBER',
    // +2 per Pyre stack consumed by a combustion; decays out of combat only.
    resourceRules: { max: 100, gainPer: 2, decayPerSecond: 3, ultimateCost: 100 },
    parity: { roomDps: 1.30, bossDps: 0.82, eHP: 0.82, mobility: 0.95 },
  },
  frost: {
    key: 'frost', name: 'FROST ARCHON',
    identity: 'Arrest. The fight happens at the speed you allow.',
    // Rime lives ON ENEMIES (0-10 each); the player's own bank is the GLACIAL
    // BARRIER, denominated in percent of max HP: +0.4% per stack applied,
    // capped at 35%, decaying 2%/s out of combat. The manual freeze-detonate
    // ultimate costs nothing — its price is the ten hits of setup.
    resourceName: 'BARRIER',
    resourceRules: { max: 35, gainPer: 0.4, decayPerSecond: 2, ultimateCost: 0 },
    parity: { roomDps: 0.87, bossDps: 1.06, eHP: 1.20, mobility: 0.80 },
  },
  storm: {
    key: 'storm', name: 'STORM ARCHON',
    identity: 'Momentum. Standing still is the only way to be weak.',
    resourceName: 'CHARGE',
    // +1 per metre travelled; decays 8/s while STATIONARY — the only resource
    // in the roster generated by movement, which is why the path feels unlike
    // the other four in the hands.
    resourceRules: { max: 200, gainPer: 1, decayPerSecond: 8, ultimateCost: 200 },
    parity: { roomDps: 1.10, bossDps: 0.92, eHP: 0.72, mobility: 1.60 },
  },
  beast: {
    key: 'beast', name: 'BEAST ARCHON',
    identity: 'Pact. One overwhelming ally instead of many small ones.',
    // Nothing banked: WILD FORM's cooldown is the resource, shortened 6 s per
    // kill made while transformed.
    resourceName: null,
    resourceRules: { max: 0, gainPer: 0, decayPerSecond: 0, ultimateCost: 0, ultimateCooldown: 90, cooldownPerKill: 6 },
    parity: { roomDps: 0.82, bossDps: 1.22, eHP: 0.95, mobility: 1.10 },
  },
};

/** Resource meter rules for one path — the STEP 6 ResourceMeter's contract. */
export function archonResourceRules(key) {
  return ARCHONS[key]?.resourceRules || null;
}

/**
 * The archon layer's ONLY field-capacity contribution (STEP 8). Pure and
 * THREE-free so the node suite asserts the same read game.fieldCapacity()
 * feeds into shadowFieldCapacity's fieldAdd term. 0 for every other path and
 * every unascended save — the archon layer stays orthogonal (interlock rule
 * 3): this joins a BEHAVIOUR seam (how many soldiers stand), never the
 * derived block.
 */
export function archonFieldBonus(save) {
  return save?.archon === 'shadow' ? ARCHONS.shadow.sovereignsWill.fieldBonus : 0;
}

// The affinity counters and their guard rails live in save.archonState;
// classes.js owns the semantics, save.js owns only the structure (its
// sanitiser mirrors this shape without importing this module).
function ensureArchonState(save) {
  if (!save.archonState || typeof save.archonState !== 'object') {
    save.archonState = {
      resource: 0, sigils: 0, ascendedAt: 0, pacts: [],
      affinity: { shadow: 0, flame: 0, frost: 0, storm: 0, beast: 0 },
      migTokenGranted: false, classTokenGranted: false, freeSealUsed: false,
    };
  }
  if (!save.archonState.affinity || typeof save.archonState.affinity !== 'object') {
    save.archonState.affinity = { shadow: 0, flame: 0, frost: 0, storm: 0, beast: 0 };
  }
  return save.archonState;
}

/**
 * Nudge one path's affinity counter. Called by the existing kill / bind /
 * dash / finisher hooks (STEP 7). Capped at 9999 so an idle grinder cannot
 * overflow the save.
 */
export function bumpAffinity(save, key, n = 1) {
  if (!ARCHON_KEYS.includes(key)) return;
  const st = ensureArchonState(save);
  const cur = st.affinity[key] || 0;
  st.affinity[key] = Math.max(0, Math.min(9999, cur + Math.floor(n)));
}

/**
 * "Depending on their development": the top TWO paths by affinity counter,
 * plus SHADOW if it is not already in that pair — Shadow is always offerable
 * because Bind is available to every build. Never fewer than two. Ties
 * resolve by ARCHON_KEYS order via sort stability (guaranteed since ES2019),
 * so the offer is deterministic for any counter spread.
 */
export function archonOffers(save) {
  const aff = save?.archonState?.affinity || {};
  const sorted = ARCHON_KEYS.slice().sort((a, b) => (aff[b] || 0) - (aff[a] || 0));
  const offers = sorted.slice(0, 2);
  if (!offers.includes('shadow')) offers.push('shadow');
  return offers;
}

/**
 * Ascension gate: level 55 (the world calls you S rank at 53 before it lets
 * you become something else), the level-40 trial done (classTier set), and at
 * least one S clear on the books. Re-ascension additionally needs an ASHEN
 * SIGIL — the owner wants five viable identities, and a permanent choice
 * makes four of them things most players never see.
 */
export function canAscend(save) {
  if (!save) return false;
  if ((save.level || 0) < 55) return false;
  if (!save.classTier) return false;
  if (typeof save.cleared?.S !== 'number') return false;
  if (save.archon && (save.archonState?.sigils || 0) < 1) return false;
  return true;
}

/**
 * Take a path. The offer biases legality here on purpose: the trial's end
 * presents archonOffers(save) and nothing else, so ascend() enforcing
 * membership is the same rule the UI shows — no back door where a hand-called
 * ascend skips the development the spec keyed the offer on. First ascension
 * banks one respec token (an identity this large deserves a build re-read);
 * re-ascension spends its sigil instead and mints nothing, so sigils can
 * never farm tokens. classIsNotDestiny: note that save.className is never
 * consulted — any class may take any offered path.
 */
export function ascend(save, key) {
  if (!canAscend(save)) return false;
  if (!ARCHONS[key]) return false;
  if (!archonOffers(save).includes(key)) return false;
  const st = ensureArchonState(save);
  const reascension = Boolean(save.archon);
  if (reascension) st.sigils = Math.max(0, (st.sigils || 0) - 1);
  save.archon = key;
  st.resource = 0;
  st.ascendedAt = save.level || 0;
  if (!reascension) save.respecTokens = Math.min(99, (save.respecTokens || 0) + 1);
  return true;
}
