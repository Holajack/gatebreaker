// Build-order step 4 gate: save schema v2, progression math, shadow roster.
//
//   node tools/progression-test.mjs      (also: npm run test:progression)
//
// Pure Node. No browser, no vite, no THREE — every module under test is
// deliberately DOM-free, which is the whole reason this runs in 50ms instead of
// booting a headless chromium.

import {
  GATES, STATS, LEVEL_CAP, POINTS_PER_LEVEL, AUTO_STAT_PER_LEVEL,
  SHADOW_GRADES, xpForLevel, derive, rankOf, gateIndexOfRank, ENEMY_TYPES,
  scaleEnemy, POST53_XP_LEVEL, POST53_XP_GROWTH, DAILY_CONTRACT_POINTS,
  STREAK_BONUS_CAP, WEEKLY_HUNT_XP_MULT,
} from '../src/game/config.js';
import { freshSave, migrate, SCHEMA_VERSION } from '../src/core/save.js';
import {
  grantXp, allocate, canAllocate, respecCost, respec, effectiveStat,
  shadowRosterCapacity, shadowFieldCapacity, extractionChance,
  dailyKey, dailyState, tickDaily, claimDaily,
  localDayNumber, dailyStreak, streakBonus,
  weeklyKey, weeklyContract, weeklyState, tickWeekly, claimWeekly,
  WEEKLY_KINDS, WEEKLY_TARGETS,
  classTrialAvailable, awardClassTier, MAX_EXTRACT_ATTEMPTS, DAILY_TARGET,
} from '../src/game/progression.js';
import {
  GRADES, gradeName, gradeMultiplier, makeShadow, addShadow, removeShadow,
  releaseWeakest, promoteCost, canPromote, promote, setDeployed, autoDeploy,
  deployedRecords, shadowCombat, rosterSummary, nameFor,
} from '../src/game/shadows.js';
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];

function ok(cond, label, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? `  — ${detail}` : ''}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const section = (t) => console.log(`\n${t}`);

// The quality tiers this test pins against. Imported shapes would drag in
// window; only maxFieldShadows matters to progression.js.
const TIER = { low: { maxFieldShadows: 4 }, medium: { maxFieldShadows: 6 }, high: { maxFieldShadows: 9 }, ultra: { maxFieldShadows: 12 } };

// ------------------------------------------------------------------ xp curve
section('XP CURVE  (the formula is authoritative; the spec table is hand-computed)');

// Sample levels the spec prints, so drift between the two is visible rather
// than quietly resolved in someone's favour.
const SPEC_TABLE = { 2: 139, 5: 481, 10: 1368, 15: 2410, 20: 3667, 30: 6512, 40: 9792, 50: 13432, 60: 17109, 75: 24123, 100: 35880 };
for (const [lvl, printed] of Object.entries(SPEC_TABLE)) {
  const got = xpForLevel(Number(lvl));
  const drift = ((got - printed) / printed) * 100;
  console.log(`  L${lvl}: formula ${got}  spec-table ${printed}  drift ${drift.toFixed(2)}%`);
  ok(got === Math.floor(52 * Math.pow(Number(lvl), 1.42)), `L${lvl} matches the exact formula`);
  ok(Math.abs(drift) <= 7, `L${lvl} within 7% of the printed table`, `${drift.toFixed(2)}%`);
}
let strictlyUp = true;
let cumulative = 0;
for (let l = 1; l < LEVEL_CAP; l++) {
  cumulative += xpForLevel(l);
  if (l > 1 && xpForLevel(l) <= xpForLevel(l - 1)) strictlyUp = false;
}
ok(strictlyUp, 'the curve is strictly increasing');
ok(cumulative > 1_300_000 && cumulative < 1_600_000, 'L1->L100 total is in the 1.3M-1.6M band', String(cumulative));
console.log(`  cumulative L1->L100: ${cumulative.toLocaleString('en-US')} XP`);

// ---------------------------------------------------------------- levelling
section('LEVELLING');
{
  const s = freshSave();
  let levels = 0;
  // Walk the whole ladder one level at a time so an off-by-one in the loop
  // cannot hide behind a single huge grant.
  for (let i = 0; i < LEVEL_CAP * 2 && s.level < LEVEL_CAP; i++) {
    const r = grantXp(s, xpForLevel(s.level));
    levels += r.levelsGained;
  }
  ok(s.level === LEVEL_CAP, 'reaches the level cap', String(s.level));
  ok(levels === LEVEL_CAP - 1, 'exactly 99 levels gained', String(levels));
  ok(s.points === (LEVEL_CAP - 1) * POINTS_PER_LEVEL, 'free points = 5 per level', String(s.points));
  ok(s.autoStats === (LEVEL_CAP - 1) * AUTO_STAT_PER_LEVEL, 'autoStats = 1 per level', String(s.autoStats));
  for (const st of STATS) {
    ok(effectiveStat(s, st.key) === s.autoStats, `${st.key} carries the auto grant with nothing spent`);
  }
  const after = grantXp(s, 999999);
  ok(after.levelsGained === 0 && after.capped, 'XP past the cap is refused');
}
{
  // One boss kill can cross several thresholds, and every crossing owes points.
  const s = freshSave();
  const r = grantXp(s, xpForLevel(1) + xpForLevel(2) + xpForLevel(3));
  ok(r.levelsGained === 3, 'a multi-level grant pays per level crossed', String(r.levelsGained));
  ok(r.pointsGained === 3 * POINTS_PER_LEVEL, 'and the points to match', String(r.pointsGained));
  ok(r.autoGained === 3, 'and the auto grants to match', String(r.autoGained));
}

// ------------------------------------------------------------- allocation
section('ALLOCATION AND RESPEC');
{
  const s = freshSave();
  grantXp(s, xpForLevel(1));
  ok(canAllocate(s, 'per'), 'the fifth stat is allocatable');
  ok(!canAllocate(s, 'luck'), 'an unknown stat key is refused');
  const before = s.points;
  ok(allocate(s, 'str', 3), 'allocate spends points');
  ok(s.points === before - 3 && s.stats.str === 3, 'points and stat move together');
  ok(!allocate(s, 'str', 999), 'over-allocation is refused');
  ok(respecCost(s) === 80 + 14 * 3, 'respec cost is 80 + 14/point', String(respecCost(s)));
  ok(!respec(s), 'respec without ash fails');
  s.ash = 10_000;
  ok(respec(s), 'respec with ash succeeds');
  ok(s.stats.str === 0 && s.points === before, 'respec refunds every spent point');
}

// -------------------------------------------------------------- capacities
section('SHADOW CAPACITY');
{
  let prevRoster = -1;
  let prevField = -1;
  let rosterMonotonic = true;
  let fieldMonotonic = true;
  for (let lvl = 1; lvl <= LEVEL_CAP; lvl++) {
    const s = freshSave();
    s.level = lvl;
    s.autoStats = lvl - 1;
    const r = shadowRosterCapacity(s);
    const f = shadowFieldCapacity(s, TIER.ultra);
    if (r < prevRoster) rosterMonotonic = false;
    if (f < prevField) fieldMonotonic = false;
    prevRoster = r; prevField = f;
  }
  ok(rosterMonotonic, 'roster capacity never shrinks with level');
  ok(fieldMonotonic, 'field capacity never shrinks with level');
  ok(prevRoster <= 120, 'roster capacity caps at 120', String(prevRoster));
  ok(prevField === 12, 'field capacity caps at 12 on ultra', String(prevField));

  const maxed = freshSave();
  maxed.level = LEVEL_CAP; maxed.autoStats = 99; maxed.stats.int = 400;
  ok(shadowRosterCapacity(maxed) === 120, 'roster capacity hard-caps at 120');
  for (const [name, tier] of Object.entries(TIER)) {
    const got = shadowFieldCapacity(maxed, tier);
    ok(got === tier.maxFieldShadows, `${name} tier clamps the field to ${tier.maxFieldShadows}`, String(got));
  }
  const fresh = freshSave();
  ok(shadowFieldCapacity(fresh, TIER.low) >= 2, 'field capacity never drops below 2');
}

// -------------------------------------------------------------- extraction
section('EXTRACTION CHANCE');
{
  let inBounds = true;
  let samples = 0;
  const s = freshSave();
  for (const level of [1, 10, 40, 80, 100]) {
    for (const enemyLevel of [1, 15, 45, 90]) {
      for (const weight of ['trash', 'elite', 'boss']) {
        for (const secs of [0, 3, 6, 11]) {
          for (const attempt of [0, 1, 2]) {
            s.level = level; s.autoStats = level - 1;
            const c = extractionChance(s, { enemyLevel, tierWeight: weight, secondsSinceDeath: secs, attemptIndex: attempt });
            samples++;
            if (!(c >= 0.04 && c <= 0.95)) inBounds = false;
          }
        }
      }
    }
  }
  ok(inBounds, `every one of ${samples} sampled inputs stays inside [0.04, 0.95]`);

  const s2 = freshSave();
  s2.level = 20; s2.autoStats = 19;
  const a0 = extractionChance(s2, { enemyLevel: 18, tierWeight: 'trash', secondsSinceDeath: 0, attemptIndex: 0 });
  const a1 = extractionChance(s2, { enemyLevel: 18, tierWeight: 'trash', secondsSinceDeath: 0, attemptIndex: 1 });
  const a2 = extractionChance(s2, { enemyLevel: 18, tierWeight: 'trash', secondsSinceDeath: 0, attemptIndex: 2 });
  ok(a0 > a1 && a1 > a2, 'each attempt on the same corpse is strictly worse');
  ok(extractionChance(s2, { enemyLevel: 18, tierWeight: 'trash', attemptIndex: MAX_EXTRACT_ATTEMPTS }) === 0,
    'a fourth attempt returns exactly 0');
  const fresh0 = extractionChance(s2, { enemyLevel: 18, tierWeight: 'trash', secondsSinceDeath: 0, attemptIndex: 0 });
  const stale = extractionChance(s2, { enemyLevel: 18, tierWeight: 'trash', secondsSinceDeath: 11, attemptIndex: 0 });
  ok(fresh0 > stale, 'a decaying corpse is harder to raise');
  ok(extractionChance(s2, { enemyLevel: 18, tierWeight: 'boss', secondsSinceDeath: 0, attemptIndex: 0 })
     < extractionChance(s2, { enemyLevel: 18, tierWeight: 'trash', secondsSinceDeath: 0, attemptIndex: 0 }),
  'a boss resists extraction harder than trash');
}

// ------------------------------------------------------------------ dailies
section('DAILY CONTRACT');
{
  const s = freshSave();
  const now = Date.parse('2026-08-06T10:00:00');
  ok(dailyKey(now) === '2026-08-06', 'dailyKey is the local YYYY-MM-DD', dailyKey(now));
  ok(dailyState(s, now).expired, 'a save with no contract reads as expired');
  ok(tickDaily(s, 1, now) === false, 'one of three does not complete the contract');
  ok(tickDaily(s, 2, now) === true, 'three of three completes it');
  const before = s.points;
  ok(claimDaily(s, now), 'a complete contract can be claimed');
  ok(s.points === before + 3, 'claiming pays 3 points', String(s.points - before));
  ok(!claimDaily(s, now), 'it cannot be claimed twice');
  const tomorrow = now + 24 * 3600 * 1000;
  ok(dailyState(s, tomorrow).expired && dailyState(s, tomorrow).progress === 0, 'the contract resets the next day');
  ok(dailyState(s, now).target === DAILY_TARGET, 'the target is the exported constant');
}

// ------------------------------------------------------------------ streaks
// Wave F.4. RETARGET NOTE: the shipped daily paid a flat +3 with no memory of
// yesterday; the 'claiming pays 3 points' assert above still holds VERBATIM
// because day one of a chain pays base + bonus(streak 1) = 3 + 0 — the streak
// layer is byte-invisible until day two, by construction.
section('DAILY STREAKS');
{
  const s = freshSave();
  const base = Date.parse('2026-08-06T10:00:00'); // mid-morning: ±1h DST noise can't cross midnight
  const at = (days) => base + days * 24 * 3600 * 1000;
  const fulfill = (days) => { tickDaily(s, DAILY_TARGET, at(days)); return claimDaily(s, at(days)); };
  const claimPays = (days) => {
    const before = s.points;
    ok(fulfill(days), `day ${days} claim succeeds`);
    return s.points - before;
  };
  ok(claimPays(0) === DAILY_CONTRACT_POINTS, 'day one pays the shipped 3 (streak bonus 0)');
  ok(s.daily.streak === 1 && s.daily.lastClaimDay === localDayNumber(at(0)), 'day one arms the chain');
  ok(claimPays(1) === 4, 'day two pays 3 + 1');
  ok(claimPays(2) === 5, 'day three pays 3 + 2');
  ok(claimPays(3) === 6, 'day four pays 3 + 3 (the cap)');
  ok(claimPays(4) === 6, `day five stays capped at +${STREAK_BONUS_CAP}`);
  ok(s.daily.streak === 5, 'the counter itself keeps counting past the cap', String(s.daily.streak));
  ok(dailyStreak(s, at(4)) === 5, 'dailyStreak reports a live chain');
  ok(dailyStreak(s, at(5)) === 5, 'still live the morning after (extendable today)');
  ok(dailyStreak(s, at(6)) === 0, 'a skipped day reads as 0 — the strip never shows a dead chain');
  ok(claimPays(6) === 3, 'the claim after a gap resets to the base payout');
  ok(s.daily.streak === 1, 'and the chain restarts at one');
  // A clock rolled backwards forges nothing: prev day ordinal > claim day.
  const back = freshSave();
  tickDaily(back, DAILY_TARGET, at(3)); claimDaily(back, at(3));
  tickDaily(back, DAILY_TARGET, at(1)); claimDaily(back, at(1));
  ok(back.daily.streak === 1, 'a backwards clock resets rather than extends');
}

// ------------------------------------------------------------- weekly hunt
section('THE WEEKLY HUNT  (Wave F.4)');
{
  const base = Date.parse('2026-08-06T10:00:00'); // Thursday; 2026-08-03 was a Monday
  const at = (days) => base + days * 24 * 3600 * 1000;
  // Monday-aligned week fold: Thu 08-06 and Sun 08-09 share a week; Mon 08-10
  // opens the next one, exactly +1.
  const w0 = weeklyKey(base);
  ok(weeklyKey(Date.parse('2026-08-09T23:00:00')) === w0, 'Sunday night is still the same week');
  ok(weeklyKey(Date.parse('2026-08-10T01:00:00')) === w0 + 1, 'Monday is the next week ordinal');
  // Determinism without an RNG stream: the contract is pure modulo over the
  // week ordinal — the same week asks the same hunt on every device.
  ok(WEEKLY_KINDS.length === 3, 'three modifier kinds rotate');
  // RETARGET (review fix landed after this suite): the rotation is plain
  // modulo for a save that can PROGRESS every kind — an anomaly week
  // degrades to 'wild' below B's reqLevel 19, because handing a sub-19 save
  // a contract it cannot legally advance was a dead ledger strip for seven
  // days. Both sides asserted: the eligible save sees the raw rotation, the
  // fresh save sees anomaly resolved to wild and everything else untouched.
  const eligible = () => Object.assign(freshSave(), { level: 19 });
  for (let k = 0; k < 3; k++) {
    const raw = WEEKLY_KINDS[(w0 + k) % 3];
    ok(weeklyContract(eligible(), w0 + k).kind === raw,
      `week ${w0 + k} posts ${raw} by plain modulo for a B-unlocked save`);
    ok(weeklyContract(freshSave(), w0 + k).kind === (raw === 'anomaly' ? 'wild' : raw),
      `week ${w0 + k} resolves to ${raw === 'anomaly' ? 'wild (degraded)' : raw} for a fresh save`);
  }
  // A fresh save's boss week can only name the one gate it has unlocked.
  const bossWeekOff = [0, 1, 2].find((k) => WEEKLY_KINDS[(w0 + k) % 3] === 'boss');
  const bossNow = at(bossWeekOff * 7);
  ok(weeklyContract(freshSave(), w0 + bossWeekOff).boss === 'warden',
    'a level-1 save is only ever sent after the Warren\'s boss');
  // The stamp freezes the contract: level up mid-week, the target holds.
  {
    const s = freshSave();
    ok(weeklyState(s, bossNow).expired, 'an untouched week reads as expired');
    ok(tickWeekly(s, { boss: 'warden' }, bossNow) === false, 'one fell of two does not complete');
    ok(s.weekly.boss === 'warden' && s.weekly.target === WEEKLY_TARGETS.boss, 'the contract is stamped at first tick');
    s.level = 100; // mid-week growth
    ok(tickWeekly(s, { boss: 'archon' }, bossNow) === false, 'the wrong head never counts — the stamp is frozen');
    ok(tickWeekly(s, { boss: 'warden' }, bossNow) === true, 'the stamped head completes at target');
    const st = weeklyState(s, bossNow);
    ok(st.progress === 2 && !st.claimed && !st.expired, 'state reflects the banked progress');
  }
  // wild / anomaly weeks count ONLY their modifier.
  {
    const wildOff = [0, 1, 2].find((k) => WEEKLY_KINDS[(w0 + k) % 3] === 'wild');
    const now = at(wildOff * 7);
    const s = freshSave();
    tickWeekly(s, { wild: false, anomaly: true, boss: 'warden' }, now);
    ok(s.weekly.progress === 0, 'a plain (even anomalous) clear does not advance a wild week');
    for (let i = 0; i < WEEKLY_TARGETS.wild - 1; i++) tickWeekly(s, { wild: true }, now);
    ok(tickWeekly(s, { wild: true }, now) === true, `${WEEKLY_TARGETS.wild} wild clears complete a wild week`);
  }
  // Claim: XP sized off xpForLevel at the CLAIMANT's level (questXp
  // philosophy, weekly-large), +1 respec token, auto-claim-once semantics.
  {
    const s = freshSave();
    s.level = 60;
    const anomOff = [0, 1, 2].find((k) => WEEKLY_KINDS[(w0 + k) % 3] === 'anomaly');
    const now = at(anomOff * 7);
    for (let i = 0; i < WEEKLY_TARGETS.anomaly; i++) tickWeekly(s, { anomaly: true }, now);
    ok(claimWeekly(freshSave(), now) === 0, 'an untouched save has nothing to claim');
    const xp = claimWeekly(s, now);
    ok(xp === Math.round(xpForLevel(60) * WEEKLY_HUNT_XP_MULT),
      `the grant is xpForLevel(level) x ${WEEKLY_HUNT_XP_MULT}`, String(xp));
    ok(s.respecTokens === 1, 'the claim banks one respec token');
    ok(claimWeekly(s, now) === 0, 'it cannot be claimed twice');
    // Next week: clean slate, new contract.
    const nextWeek = now + 7 * 24 * 3600 * 1000;
    const st = weeklyState(s, nextWeek);
    ok(st.expired && st.progress === 0 && !st.claimed, 'the hunt resets the next week');
    ok(st.kind === WEEKLY_KINDS[(weeklyKey(nextWeek)) % 3], 'and rotates its modifier');
  }
}

// ------------------------------------------------------- the ladder past 53
// Wave F.4 RETARGET NOTE: this suite previously pinned only the PLAYER curve
// (the SPEC_TABLE and cumulative-band asserts above, all untouched) and
// carried no enemy-XP asserts at all — the linear 1 + (L-1)*0.12 income was
// old truth by omission. These sections pin the new post-53 exponential term
// AND name the old numbers it replaced, so the next retune sees both.
section('POST-53 XP CURVE');
{
  const grunt = ENEMY_TYPES.grunt;
  const oldXp = (L) => Math.floor(grunt.xp * (1 + (L - 1) * 0.12)); // the shipped linear income
  ok(POST53_XP_LEVEL === 53 && POST53_XP_GROWTH === 1.055, 'the seam and growth constants hold');
  // At and below the seam the pow term is G^0 = 1: byte-identical income.
  for (const L of [1, 10, 30, 53]) {
    ok(scaleEnemy(grunt, L).xp === oldXp(L), `grunt XP at L${L} is byte-identical to the linear curve`);
  }
  // Above it, the named old numbers move: 88 -> 93 at 54, 111 -> 276 at 70.
  ok(oldXp(54) === 88 && scaleEnemy(grunt, 54).xp === 93,
    'S-gate trash (54): old linear 88, new 93 (+5.5% at the seam)');
  ok(oldXp(70) === 111 && scaleEnemy(grunt, 70).xp === 276,
    'level-70 trash: old linear 111, new 276 (x2.48 where the linear term starved)');
  ok(scaleEnemy(grunt, 54).xp > scaleEnemy(grunt, 53).xp, 'the curve stays strictly increasing across the seam');
  // hp/atk are deliberately untouched — the cliff was income, not difficulty.
  ok(scaleEnemy(grunt, 70).hp === Math.floor(grunt.hp * (1 + 69 * 0.19)), 'post-53 hp scaling is still linear');
  ok(near(scaleEnemy(grunt, 70).atk, grunt.atk * (1 + 69 * 0.15), 1e-9), 'post-53 atk scaling is still linear');
  // THE PACING PARITY — the derivation the config comment shows, re-run live.
  // Proxy-kills for a band: sum of xpForLevel(L) / per-kill XP at matched
  // enemy level. Old truth: 30->45 cost 2,071 proxy-kills, 53->70 cost 3,093
  // — the 1.49x cliff the audit named. The shipped G = 1.055 lands 53->70 at
  // 2,060 — within 3% of the 30->45 band, i.e. the same session count.
  const proxy = (a, b, f) => { let s = 0; for (let L = a; L < b; L++) s += xpForLevel(L) / f(L); return s; };
  const target = proxy(30, 45, (L) => scaleEnemy(grunt, L).xp); // sub-53: identical to the old curve
  const oldCliff = proxy(53, 70, oldXp);
  const newBand = proxy(53, 70, (L) => scaleEnemy(grunt, L).xp);
  console.log(`  proxy-kills: 30->45 ${target.toFixed(0)}   53->70 old ${oldCliff.toFixed(0)} (x${(oldCliff / target).toFixed(2)})   new ${newBand.toFixed(0)} (x${(newBand / target).toFixed(2)})`);
  ok(oldCliff / target > 1.45, 'the old linear curve WAS the cliff (x1.49 named)', (oldCliff / target).toFixed(3));
  ok(Math.abs(newBand / target - 1) <= 0.03, '53->70 now paces like 30->45 to within 3%', (newBand / target).toFixed(3));
}

// -------------------------------------------------------------- class trial
section('CLASS TRIAL');
{
  const s = freshSave();
  s.level = 39;
  ok(!classTrialAvailable(s), 'not available below 40');
  s.level = 40;
  ok(classTrialAvailable(s), 'available at 40');
  ok(awardClassTier(freshSave(), 59) === 'base', '59s is base');
  ok(awardClassTier(freshSave(), 60) === 'advanced', '60s is advanced');
  ok(awardClassTier(freshSave(), 149) === 'advanced', '149s is advanced');
  ok(awardClassTier(freshSave(), 150) === 'sovereign', '150s is sovereign');
  const t = freshSave(); t.level = 40;
  const p0 = t.points;
  awardClassTier(t, 200);
  ok(t.points === p0 + 8, 'the trial pays a flat +8 points');
  ok(!classTrialAvailable(t), 'the trial fires exactly once');
}

// ------------------------------------------------------------------- ranks
section('RANKS AND GATES');
{
  const pairs = [[1, 'E'], [7, 'E'], [8, 'D'], [15, 'D'], [16, 'C'], [24, 'C'], [25, 'B'], [36, 'B'], [37, 'A'], [52, 'A'], [53, 'S'], [70, 'S'], [71, 'SOVEREIGN'], [100, 'SOVEREIGN']];
  for (const [lvl, want] of pairs) ok(rankOf(lvl) === want, `rankOf(${lvl}) is ${want}`, rankOf(lvl));
  const reqs = GATES.map((g) => g.reqLevel);
  ok(JSON.stringify(reqs) === JSON.stringify([1, 5, 11, 19, 29, 42]), 'gate unlock levels are 1/5/11/19/29/42', reqs.join(','));
  ok(GATES.every((g) => g.bossLevel > g.enemyLevel), 'every gate boss outranks its trash');
  ok(GATES.every((g) => typeof g.arena === 'number' && g.boss && g.name && g.blurb),
    'every gate keeps the fields world.js and ui.js read');
  ok(gateIndexOfRank('S') === 5 && gateIndexOfRank('E') === 0, 'gateIndexOfRank resolves');
  // Legal distance: the source-work name must be gone from the balance table.
  const cfg = readFileSync(new URL('../src/game/config.js', import.meta.url), 'utf8');
  ok(!/monarch/i.test(cfg), 'no "monarch" string survives in config.js');
}

// ------------------------------------------------------------------ derive
section('DERIVED STATS');
{
  const s = freshSave();
  const d = derive(s);
  for (const k of ['maxHp', 'maxMp', 'atk', 'speed', 'crit', 'critDmg', 'atkSpeed', 'skillMul', 'cdr', 'dr', 'hpRegen', 'mpRegen', 'dmgFloor', 'tellLeadMs', 'dodgeWindow', 'shadowDmgMul']) {
    ok(typeof d[k] === 'number' && Number.isFinite(d[k]), `derive() returns ${k}`, String(d[k]));
  }
  ok(near(d.dodgeWindow, 0.110, 0.0001), 'base dodge window is 110ms', String(d.dodgeWindow));
  const maxed = freshSave(); maxed.stats.agi = 1000; maxed.stats.vit = 1000; maxed.stats.per = 1000;
  const dm = derive(maxed);
  ok(near(dm.dodgeWindow, 0.260, 0.0001), 'dodge window caps at 260ms', String(dm.dodgeWindow));
  ok(near(dm.dmgFloor, 0.92, 0.0001), 'damage floor caps at 0.92', String(dm.dmgFloor));
  ok(near(dm.tellLeadMs, 520, 0.001), 'tell lead caps at 520ms', String(dm.tellLeadMs));
  ok(dm.dr <= 0.45 + 1e-9, 'damage reduction caps at 45%', String(dm.dr));
  // The auto grant has to reach derive(), or 99 levels of it would be invisible.
  const auto = freshSave(); auto.level = 50; auto.autoStats = 49;
  ok(derive(auto).maxHp > derive({ ...auto, autoStats: 0 }).maxHp, 'autoStats feeds derive()');
}

// --------------------------------------------------------------- migration
section('SAVE MIGRATION');
{
  const v1 = {
    version: 1, level: 23, xp: 400, points: 9,
    stats: { str: 12, agi: 4, vit: 7, int: 3 },
    cleared: { E: 74, D: 130 }, shadows: 6, totalKills: 812, deaths: 3,
  };
  const m = migrate(v1);
  ok(m.version === SCHEMA_VERSION, 'migrated save reports v2', String(m.version));
  ok(m.level === 23 && m.xp === 400 && m.points === 9, 'level/xp/points survive');
  ok(m.stats.str === 12 && m.stats.per === 0, 'stats survive and `per` is seeded to 0');
  ok(m.cleared.E === 74 && m.cleared.D === 130, 'clear times survive');
  ok(m.totalKills === 812 && m.deaths === 3, 'lifetime counters survive');
  ok(Array.isArray(m.shadows.roster) && m.shadows.roster.length === 6,
    'shadows: 6 becomes a 6-entry roster', String(m.shadows.roster.length));
  ok(new Set(m.shadows.roster.map((r) => r.id)).size === 6, 'roster ids are unique');
  ok(m.shadows.roster.every((r) => r.level === 23 && r.type === 'grunt' && r.grade === 1),
    'migrated records take the player level, grunt type, grade 1');
  ok(m.shadows.nextId === 7, 'nextId follows the migrated roster', String(m.shadows.nextId));
  ok(m.autoStats === 22, 'autoStats is reconstructed as levels-gained', String(m.autoStats));
  ok(m.ash === 0 && m.classTier === null && m.daily.dayKey === null, 'the v2-only fields appear');

  const round = migrate(m);
  ok(JSON.stringify(round) === JSON.stringify(m), 'v2 -> v2 is a byte-identical round trip');
  ok(migrate(null).level === 1, 'null migrates to a fresh save');
  ok(migrate('garbage').level === 1, 'garbage migrates to a fresh save');
  ok(migrate({ version: 2, shadows: 4 }).shadows.roster.length === 4,
    'a v2 stamp with a v1 shadow field still migrates');
}

// ----------------------------------------------------------------- roster
section('SHADOW ROSTER');
{
  ok(GRADES.length === 7, 'seven grades');
  ok(gradeName(0) === 'CINDER' && gradeName(6) === 'ASHEN FIRST', 'grade names');
  ok(gradeMultiplier(2) === 1.0, 'SOLDIER is the 1.0 baseline');
  ok(GRADES[6].maxCount === 1, 'exactly one ASHEN FIRST may exist');

  const s = freshSave();
  s.level = 50; s.autoStats = 49;
  const cap = shadowRosterCapacity(s);
  let added = 0;
  for (let i = 0; i < cap + 5; i++) {
    const r = addShadow(s, makeShadow(s, { type: 'grunt', level: 40 }));
    if (r.added) added++;
  }
  ok(added === cap, 'the roster fills to capacity and no further', `${added}/${cap}`);
  ok(s.shadows.roster.length === cap, 'roster length matches');
  const overflow = addShadow(s, makeShadow(s, { type: 'grunt', level: 40 }));
  ok(!overflow.added && overflow.reason === 'full', 'overflow is refused with reason "full"');

  const victim = s.shadows.roster[0].id;
  ok(removeShadow(s, victim), 'removeShadow finds a real id');
  ok(!removeShadow(s, 999999), 'removeShadow refuses an unknown id');

  // Deployment
  const fieldCap = shadowFieldCapacity(s, TIER.high);
  const deployed = autoDeploy(s, fieldCap);
  ok(deployed.length === fieldCap, 'autoDeploy fills exactly the field cap', String(deployed.length));
  ok(deployedRecords(s).length === fieldCap, 'deployedRecords resolves them all');
  s.shadows.roster[3].grade = 4;
  autoDeploy(s, fieldCap);
  ok(deployedRecords(s)[0].grade === 4, 'autoDeploy puts the highest grade first');
  ok(setDeployed(s, [999999]).length === 0, 'setDeployed drops ids that are not owned');
  const dupId = s.shadows.roster[1].id;
  ok(setDeployed(s, [dupId, dupId]).length === 1, 'setDeployed de-duplicates');

  // Promotion
  const rec = s.shadows.roster[0];
  rec.grade = 0;
  ok(promoteCost(s, rec).ash === 120, 'grade 0 promotion costs 120 ash');
  ok(promoteCost(s, { grade: 3 }).ash === Math.round(120 * Math.pow(2.2, 3)), 'promotion cost is 120 * 2.2^grade');
  ok(promoteCost(s, { grade: 3 }).minLevel === 32, 'minLevel is 8 * (grade + 1)');
  s.ash = 0;
  ok(!canPromote(s, rec), 'promotion without ash is refused');
  s.ash = 1_000_000;
  ok(canPromote(s, rec) && promote(s, rec.id), 'promotion with ash succeeds');
  ok(rec.grade === 1, 'grade advances by one');

  // The top grades are rank slots, not just price tags.
  const first = s.shadows.roster[1];
  first.grade = 6;
  const contender = s.shadows.roster[2];
  contender.grade = 5;
  s.level = 100;
  ok(!canPromote(s, contender), 'a second ASHEN FIRST is refused');
  ok(!canPromote(s, first), 'the top grade cannot be promoted further');

  // Death releases the weakest, never the best.
  const strongestBefore = rosterSummary(s).strongest.id;
  const released = releaseWeakest(s, 4);
  ok(released.length === 4, 'releaseWeakest releases the requested count');
  ok(released.every((r) => r.grade <= 1), 'and takes only low grades', released.map((r) => r.grade).join(','));
  ok(rosterSummary(s).strongest.id === strongestBefore, 'the strongest shadow survives a death');

  // Combat numbers
  const cs = freshSave();
  cs.level = 30; cs.autoStats = 29; cs.stats.int = 50;
  const soldier = { id: 1, name: 'x', grade: 2, type: 'grunt', level: 20, kills: 0, bornAt: 0 };
  const warlord = { ...soldier, grade: 5 };
  const a = shadowCombat(cs, soldier);
  const b = shadowCombat(cs, warlord);
  ok(b.atk > a.atk && b.hp > a.hp, 'a higher grade is strictly stronger');
  ok(near(a.hp, Math.floor(ENEMY_TYPES.grunt.hp * 1.0 * (1 + 30 * 0.06)), 1), 'hp matches the spec formula', String(a.hp));
  ok(a.speed >= 5.4, 'a shadow can keep up with the player', String(a.speed));
  ok(shadowCombat(cs, { ...soldier, type: 'boss' }).hp > 0, 'a boss-type record does not fall through to grunt');

  // Names
  const names = new Set();
  for (let i = 0; i < 120; i++) names.add(nameFor('grunt', 0, i));
  ok(names.size === 120, '120 generated names are all distinct', String(names.size));
  ok(![...names].some((n) => /monarch|shadow monarch/i.test(n)), 'no name borrows from the source work');

  const sum = rosterSummary(s);
  ok(sum.byGrade.length === SHADOW_GRADES.length, 'rosterSummary reports every grade bucket');
  ok(sum.byGrade.reduce((x, y) => x + y, 0) === sum.count, 'the grade buckets add up to the count');
}

// ------------------------------------------------------------------ report
console.log('');
if (fails.length) {
  fails.forEach((f) => console.log(`  FAIL  ${f}`));
  console.log(`\nPASS ${pass}   FAIL ${fails.length}`);
  process.exit(1);
}
console.log(`PASS ${pass}   FAIL 0`);
