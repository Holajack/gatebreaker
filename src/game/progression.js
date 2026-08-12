// All level / stat / capacity math, as pure functions over the save object.
//
// Nothing here imports THREE or touches the DOM on purpose: this is the module
// the headless progression test drives directly, and it is the single place
// that decides how big the shadow army is allowed to get.

import {
  LEVEL_CAP, POINTS_PER_LEVEL, AUTO_STAT_PER_LEVEL, DAILY_CONTRACT_POINTS,
  STATS, xpForLevel,
} from './config.js';

const STAT_KEYS = STATS.map((s) => s.key);

// Extraction never gets more than three swings at one corpse. Exported because
// game.js has to stop offering the prompt at the same number.
export const MAX_EXTRACT_ATTEMPTS = 3;

// Corpse decay window, seconds. Matches the existing corpse lifetime.
export const CORPSE_WINDOW = 12;

const TIER_WEIGHTS = { trash: 0.62, elite: 0.45, boss: 0.22 };

// One daily objective is three of anything the caller counts.
export const DAILY_TARGET = 3;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Feed XP in. Levels are resolved in a loop because a single boss kill can
 * cross several thresholds, and every crossing owes both free points and the
 * automatic +1 to every stat.
 */
export function grantXp(save, amount) {
  const out = { levelsGained: 0, pointsGained: 0, autoGained: 0, capped: false };
  if (!(amount > 0)) {
    out.capped = save.level >= LEVEL_CAP;
    return out;
  }
  if (save.level >= LEVEL_CAP) {
    // At the cap XP has nowhere to go; don't let it accumulate into a number
    // that would dump 40 levels at once if the cap ever moves.
    save.xp = 0;
    out.capped = true;
    return out;
  }
  save.xp += amount;
  while (save.level < LEVEL_CAP && save.xp >= xpForLevel(save.level)) {
    save.xp -= xpForLevel(save.level);
    save.level++;
    save.points += POINTS_PER_LEVEL;
    save.autoStats = (save.autoStats || 0) + AUTO_STAT_PER_LEVEL;
    out.levelsGained++;
    out.pointsGained += POINTS_PER_LEVEL;
    out.autoGained += AUTO_STAT_PER_LEVEL;
  }
  if (save.level >= LEVEL_CAP) {
    save.xp = 0;
    out.capped = true;
  }
  return out;
}

export function canAllocate(save, key) {
  return STAT_KEYS.includes(key) && (save.points || 0) > 0;
}

export function allocate(save, key, count = 1) {
  if (!STAT_KEYS.includes(key)) return false;
  const n = Math.floor(count);
  if (n <= 0 || (save.points || 0) < n) return false;
  save.points -= n;
  save.stats[key] = (save.stats[key] || 0) + n;
  return true;
}

export function respecCost(save) {
  const spent = STAT_KEYS.reduce((a, k) => a + (save.stats[k] || 0), 0);
  return 80 + 14 * spent;
}

/** Refund every spent point. Escalating cost is what stops free experimentation. */
export function respec(save) {
  const cost = respecCost(save);
  if ((save.ash || 0) < cost) return false;
  const spent = STAT_KEYS.reduce((a, k) => a + (save.stats[k] || 0), 0);
  if (spent === 0) return false;
  save.ash -= cost;
  STAT_KEYS.forEach((k) => { save.stats[k] = 0; });
  save.points = (save.points || 0) + spent;
  return true;
}

/** Spent points plus the per-level automatic grant, which applies to every stat. */
export function effectiveStat(save, key) {
  return (save.stats?.[key] || 0) + (save.autoStats || 0);
}

/** How many shadows you may OWN. INT-driven, so army size is a build decision. */
export function shadowRosterCapacity(save) {
  return Math.min(120, 6 + Math.floor(effectiveStat(save, 'int') * 0.35) + Math.floor(save.level * 0.6));
}

/**
 * How many shadows may stand on the field AT ONCE. Separate from roster size
 * because this one is a draw-call budget, not a progression axis — the quality
 * tier gets the final word.
 *
 * `fieldAdd` is the vigil 4-piece set bonus (+2, RPG_SPEC step 11). It joins
 * the EARNED term, so it is still clamped by both the quality tier's ceiling
 * and the hard Math.min(12) — on a low graphics tier the bonus does nothing,
 * and the panel says so rather than lying. Defaults to 0, so every pre-armour
 * caller computes the identical number.
 */
export function shadowFieldCapacity(save, qualityTier, fieldAdd = 0) {
  const tierCap = qualityTier?.maxFieldShadows ?? 12;
  const earned = 2 + Math.floor(save.level / 8) + Math.floor(effectiveStat(save, 'int') / 40)
    + Math.max(0, Math.floor(fieldAdd));
  return Math.max(2, Math.min(12, tierCap, earned));
}

/**
 * Odds one extraction attempt takes. Free to attempt — the cost is the corpse
 * decaying and the three-attempt limit, not mana.
 */
export function extractionChance(save, { enemyLevel = 1, tierWeight = 'trash', secondsSinceDeath = 0, attemptIndex = 0, extractAdd = 0 } = {}) {
  if (attemptIndex >= MAX_EXTRACT_ATTEMPTS || attemptIndex < 0) return 0;
  const w = typeof tierWeight === 'number' ? tierWeight : (TIER_WEIGHTS[tierWeight] ?? TIER_WEIGHTS.trash);
  const levelFactor = clamp(1 + (save.level - enemyLevel) * 0.03, 0.4, 1.6);
  const decay = Math.max(0.25, 1 - Math.max(0, secondsSinceDeath) / CORPSE_WINDOW);
  const attemptPenalty = 1 - attemptIndex * 0.18;
  // extractAdd rides beside the PER term: it is the extraction trinket's whole
  // contribution (RPG_SPEC step 10), flat like perception's, defaulting to 0
  // so every pre-armour caller computes the identical number.
  const raw = w * levelFactor * decay * attemptPenalty + effectiveStat(save, 'per') * 0.004 + extractAdd;
  return clamp(raw, 0.04, 0.95);
}

/** Local calendar date. The game is fully offline, so there is no other clock. */
export function dailyKey(now = Date.now()) {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function dailyState(save, now = Date.now()) {
  const key = dailyKey(now);
  const d = save.daily || {};
  const expired = d.dayKey !== key;
  return {
    key,
    progress: expired ? 0 : (d.progress || 0),
    target: DAILY_TARGET,
    claimed: expired ? false : Boolean(d.claimed),
    expired,
  };
}

/**
 * Advance today's contract. Returns true when the contract is complete and
 * still unclaimed, i.e. when the UI should light up the claim button.
 */
export function tickDaily(save, deltaProgress, now = Date.now()) {
  const key = dailyKey(now);
  if (!save.daily || save.daily.dayKey !== key) {
    save.daily = { dayKey: key, progress: 0, claimed: false };
  }
  save.daily.progress = Math.min(DAILY_TARGET, (save.daily.progress || 0) + Math.max(0, deltaProgress));
  return save.daily.progress >= DAILY_TARGET && !save.daily.claimed;
}

export function claimDaily(save, now = Date.now()) {
  const st = dailyState(save, now);
  if (st.expired || st.claimed || st.progress < st.target) return false;
  save.daily.claimed = true;
  save.points = (save.points || 0) + DAILY_CONTRACT_POINTS;
  return true;
}

/** The class trial fires once, at 40, and is not a menu choice. */
export function classTrialAvailable(save) {
  return save.level >= 40 && !save.classTier;
}

/**
 * Class quality is endurance under escalating pressure, not a dialogue pick.
 * Also pays the trial's flat +8 free points; the ASHEN FIRST shadow it awards
 * is shadows.js's business.
 */
export function awardClassTier(save, survivalSeconds) {
  const tier = survivalSeconds >= 150 ? 'sovereign' : survivalSeconds >= 60 ? 'advanced' : 'base';
  save.classTier = tier;
  save.points = (save.points || 0) + 8;
  return tier;
}
