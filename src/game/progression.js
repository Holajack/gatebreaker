// All level / stat / capacity math, as pure functions over the save object.
//
// Nothing here imports THREE or touches the DOM on purpose: this is the module
// the headless progression test drives directly, and it is the single place
// that decides how big the shadow army is allowed to get.

import {
  LEVEL_CAP, POINTS_PER_LEVEL, AUTO_STAT_PER_LEVEL, DAILY_CONTRACT_POINTS,
  STREAK_BONUS_CAP, WEEKLY_HUNT_XP_MULT, GATES, STATS, xpForLevel,
} from './config.js';
// For BINDER's roster term only (classModifiers reads config, never this
// module, so the import cannot cycle). Applied INSIDE shadowRosterCapacity —
// the one read addShadow, the panel and the tests all share — rather than as
// a caller-supplied parameter, because a capacity three call sites could
// each forget is a capacity that lies on exactly one of them.
import { classModifiers } from './classes.js';

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

// 80 + 14/point, CAPPED at 3000 (CLASSES_SPEC layerA_directions.respec).
// Uncapped, the L100 all-in figure of 495 spent points priced a respec at
// 6,010 ash — past the Exchange's entire late-game curve, so the button was
// theoretical exactly when directions and masteries made it matter most. The
// cap first binds at spent = 209 (80 + 14 x 209 = 3,006), so every number
// below that — including the load-bearing spent=3 = 122 assert — is verbatim.
export function respecCost(save) {
  const spent = STAT_KEYS.reduce((a, k) => a + (save.stats[k] || 0), 0);
  return Math.min(3000, 80 + 14 * spent);
}

/**
 * Refund every spent point. Escalating cost is what stops free
 * experimentation; a respec TOKEN (granted by choosing a class, ascending,
 * and once by the classes-wave migration) is the sanctioned exception and is
 * consumed INSTEAD of ash, never alongside it.
 *
 * Note for the UI: because direction and every mastery are DERIVED from
 * save.stats, zeroing the spread also clears them — the confirm dialog must
 * say so by name (losing BREAKER T3 is a bigger loss than losing the points).
 */
export function respec(save) {
  const spent = STAT_KEYS.reduce((a, k) => a + (save.stats[k] || 0), 0);
  if (spent === 0) return false;
  if ((save.respecTokens || 0) > 0) {
    save.respecTokens -= 1;
  } else {
    const cost = respecCost(save);
    if ((save.ash || 0) < cost) return false;
    save.ash -= cost;
  }
  STAT_KEYS.forEach((k) => { save.stats[k] = 0; });
  save.points = (save.points || 0) + spent;
  return true;
}

/** Spent points plus the per-level automatic grant, which applies to every stat. */
export function effectiveStat(save, key) {
  return (save.stats?.[key] || 0) + (save.autoStats || 0);
}

/** How many shadows you may OWN. INT-driven, so army size is a build decision.
 *  BINDER's "+25% roster" (flagsScaled rosterPct, quality/resonance-scaled)
 *  multiplies the earned figure UNDER the 120 hard cap — the worked example's
 *  "already at the 120 hard cap, so inert" clause holds by construction.
 *  classModifiers is null for every save without a class, so the shipped
 *  number passes through exactly. */
export function shadowRosterCapacity(save) {
  const earned = 6 + Math.floor(effectiveStat(save, 'int') * 0.35) + Math.floor(save.level * 0.6);
  const rosterPct = classModifiers(save)?.flags?.rosterPct || 0;
  return Math.min(120, Math.floor(earned * (1 + rosterPct)));
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
    // The day rolls over but the STREAK fields ride across (Wave F.4): the
    // streak is exactly the state that must survive the reset, or every new
    // day would open by forgetting yesterday. Absent-means-default like the
    // rest of the block — a pre-F.4 save reads streak 0 / lastClaimDay null
    // and behaves as day one of a fresh chain.
    const prev = save.daily || {};
    save.daily = {
      dayKey: key, progress: 0, claimed: false,
      streak: prev.streak || 0,
      lastClaimDay: prev.lastClaimDay ?? null,
    };
  }
  save.daily.progress = Math.min(DAILY_TARGET, (save.daily.progress || 0) + Math.max(0, deltaProgress));
  return save.daily.progress >= DAILY_TARGET && !save.daily.claimed;
}

/**
 * Local-calendar day ordinal — Date.UTC over the LOCAL date components, so
 * "consecutive days" is a pure integer comparison immune to DST (a fixed
 * -86400000 ms probe can land on the wrong local date across a shifted
 * midnight; local components can't). Same offline-clock stance as dailyKey:
 * the device clock is the only clock, and rolling it forges streaks — the
 * accepted cost of full offline, flagged in the audit alongside the daily's.
 */
export function localDayNumber(now = Date.now()) {
  const d = new Date(now);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/** The streak bonus the NEXT (or just-fired) claim pays: +1 point per
 *  consecutive day beyond the first, capped (config STREAK_BONUS_CAP = +3).
 *  Reads save.daily.streak as-is — call after claimDaily for "what did today
 *  pay", or feed it a hypothetical streak via the second arg for previews. */
export function streakBonus(save, streak = save?.daily?.streak || 0) {
  return Math.min(STREAK_BONUS_CAP, Math.max(0, streak - 1));
}

/**
 * The streak as a SURFACE should show it (the ledger strip's flame count):
 * the stored counter, but only while the chain is alive — last claim today or
 * yesterday. A save returning after a gap still carries the stale integer
 * (claimDaily is the one writer and it self-corrects on the next claim), so
 * the read side owns the honesty: showing "FLAME 6" a week after the chain
 * broke would be the strip lying.
 */
export function dailyStreak(save, now = Date.now()) {
  const d = save.daily || {};
  if (!(d.streak > 0) || d.lastClaimDay == null) return 0;
  const today = localDayNumber(now);
  return (d.lastClaimDay === today || d.lastClaimDay === today - 1) ? d.streak : 0;
}

export function claimDaily(save, now = Date.now()) {
  const st = dailyState(save, now);
  if (st.expired || st.claimed || st.progress < st.target) return false;
  save.daily.claimed = true;
  // STREAKS (Wave F.4): consecutive-calendar-day fulfillment chains; any gap
  // (or a clock rolled backwards) resets to day one. The chain check runs on
  // day ordinals, not key strings — see localDayNumber. The bonus lands in
  // the SAME points grant so there is no second payout path to fall out of
  // sync: day one pays the shipped 3 exactly (bonus 0), so every pre-streak
  // test and every first claim is byte-identical to the shipped behaviour.
  const day = localDayNumber(now);
  save.daily.streak = save.daily.lastClaimDay === day - 1 ? (save.daily.streak || 0) + 1 : 1;
  save.daily.lastClaimDay = day;
  save.points = (save.points || 0) + DAILY_CONTRACT_POINTS + streakBonus(save);
  return true;
}

// ---------------------------------------------------------------------------
// THE WEEKLY HUNT (Wave F.4) — one rotating contract per calendar week, the
// daily's slower sibling and the ladder's second rung past 53. Same shape as
// the daily on purpose (state/tick/claim triple, absent-means-default save
// block, auto-claim at the completing clear, ticked from the SAME _clearGate
// funnel), because a second bookkeeping idiom is a second thing to get wrong.
// ---------------------------------------------------------------------------

// The modifier rotation. DETERMINISTIC from the week ordinal by plain modulo —
// no RNG stream is touched or forked: the hunt is a calendar fact, not a roll,
// so two devices on the same local week post the same contract, and the
// _combatRnd/forked-stream discipline (streams only for SIM outcomes) is
// never diluted by a UI-facing draw.
//   wild    — Verge wild-gate clears only (game._wildRun; any rank, since the
//             Verge posts wild portals across the ladder)
//   anomaly — anomalous clears only (rank gate implicit: ANOMALY_CHANCE is 0
//             below B, so the modifier itself names the deep ladder)
//   boss    — a NAMED boss target: fell that gate's boss, repeatedly
export const WEEKLY_KINDS = ['wild', 'anomaly', 'boss'];
// Targets per kind, sized by gate odds: wild gates are always postable (3),
// anomalies roll 14-26% on B+ so demanding 3 would be a lottery (2), a named
// boss is a full deliberate run each (2).
export const WEEKLY_TARGETS = { wild: 3, anomaly: 2, boss: 2 };

/**
 * The week ordinal — dailyKey's week, Monday-aligned. localDayNumber 0
 * (1970-01-01) was a Thursday, so +3 shifts the fold to Monday boundaries:
 * the hunt rolls over at local Monday midnight, same offline-clock stance
 * (and the same clock-rolling caveat) as the daily.
 */
export function weeklyKey(now = Date.now()) {
  return Math.floor((localDayNumber(now) + 3) / 7);
}

/**
 * Resolve week `week`'s contract for this save. Pure — no RNG, no writes.
 * The boss pick indexes the save's UNLOCKED gates (there is always at least
 * E) so the hunt never posts a target the hunter cannot legally walk to;
 * floor(week/3) rotates the pick so consecutive boss weeks name different
 * heads. Level-dependent, which is why tickWeekly STAMPS the resolved
 * contract into save.weekly at the week's first tick: a mid-week level-up
 * must not swap the target out from under banked progress.
 */
export function weeklyContract(save, week) {
  let kind = WEEKLY_KINDS[((week % WEEKLY_KINDS.length) + WEEKLY_KINDS.length) % WEEKLY_KINDS.length];
  // A contract must be PROGRESSABLE by the save that receives it (review
  // fix): anomalies only roll at B+ (reqLevel 19), so an 'anomaly' week
  // handed to a sub-19 hunter was a dead strip in the ledger for seven
  // days. Degrade to 'wild' — the Verge is open from level 1. tickWeekly's
  // first-tick stamp freezes the RESOLVED contract, so a mid-week level-up
  // past 19 never swaps it back under banked progress.
  const bGate = GATES.find((g) => g.rank === 'B');
  if (kind === 'anomaly' && (save.level || 1) < (bGate?.reqLevel ?? 19)) kind = 'wild';
  let boss = null;
  if (kind === 'boss') {
    const unlocked = GATES.filter((g) => g.reqLevel <= (save.level || 1));
    boss = unlocked[Math.floor(week / WEEKLY_KINDS.length) % unlocked.length].boss;
  }
  return { kind, boss, target: WEEKLY_TARGETS[kind] };
}

/** Read-side view, dailyState's exact contract: never writes, absent or
 *  stale-week state reads as a fresh unstarted contract (expired: true). */
export function weeklyState(save, now = Date.now()) {
  const week = weeklyKey(now);
  const w = save.weekly && save.weekly.week === week ? save.weekly : null;
  const c = w || weeklyContract(save, week);
  return {
    week, kind: c.kind, boss: c.boss, target: c.target,
    progress: w ? (w.progress || 0) : 0,
    claimed: w ? Boolean(w.claimed) : false,
    expired: !w,
  };
}

/**
 * Advance the hunt off one gate clear. `info` is the clear's facts from the
 * ONE funnel (_clearGate): { wild, anomaly, boss } — the tick decides what
 * counted, the funnel never does. Returns true when complete and unclaimed
 * (the auto-claim signal, same stance as the daily: an offline solo game
 * gains nothing from a claim button between the player and their reward).
 */
export function tickWeekly(save, info = {}, now = Date.now()) {
  const week = weeklyKey(now);
  if (!save.weekly || save.weekly.week !== week) {
    // The stamp: contract resolved ONCE per week, then frozen (see
    // weeklyContract on why). Absent-means-default — a pre-F.4 save simply
    // stamps its first week here.
    save.weekly = { week, ...weeklyContract(save, week), progress: 0, claimed: false };
  }
  const w = save.weekly;
  const hit = w.kind === 'wild' ? Boolean(info.wild)
    : w.kind === 'anomaly' ? Boolean(info.anomaly)
      : Boolean(info.boss) && info.boss === w.boss;
  if (hit) w.progress = Math.min(w.target, (w.progress || 0) + 1);
  return w.progress >= w.target && !w.claimed;
}

/**
 * Claim the fulfilled hunt. Returns the XP grant (0 when nothing is
 * claimable) and banks the respec token itself; the CALLER routes the XP
 * through game.gainXp — the one grant path, so the weekly pays ash parity
 * and fires the level ceremony like every other income — while headless
 * suites feed it straight to grantXp. Sized off xpForLevel at save.level
 * (config WEEKLY_HUNT_XP_MULT; the quests.questXp philosophy, priced in the
 * claimant's own gap), computed BEFORE any levels the grant itself causes.
 * The token cap mirrors save.js's sanitiseRespecTokens ceiling of 99.
 */
export function claimWeekly(save, now = Date.now()) {
  const week = weeklyKey(now);
  const w = save.weekly;
  if (!w || w.week !== week || w.claimed || (w.progress || 0) < w.target) return 0;
  w.claimed = true;
  save.respecTokens = Math.min(99, (save.respecTokens || 0) + 1);
  return Math.round(xpForLevel(save.level) * WEEKLY_HUNT_XP_MULT);
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
