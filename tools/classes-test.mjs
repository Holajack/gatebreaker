// CLASSES_SPEC build-order STEPS 1-7 gate: the classes core (directions,
// masteries, classes, resonance, applyLayers), the save/respec layer (the
// four additive fields, their sanitisers, the migration token grant, the
// respec cap and token path), the fifteen direction masteries fired live in
// the running game's combat hooks (STEP 4), the Assay Hall desk (STEP 5),
// the archon substrate — StatusTable / ArchonPool / tintForStacks /
// ResourceMeter (STEP 6) — and ascension: THE REACH trial flag, the affinity
// counters at their combat hooks, the offer panel and the HUD meter (STEP 7).
//
//   node tools/classes-test.mjs      (also: npm run test:classes)
//
// The node sections run first, pure and THREE-free — classes.js is THREE-free
// by contract, exactly like progression.js, and those sections are the proof.
// The MASTERY HOOKS sections then boot the real game through the shared
// Playwright harness (GB_PORT honoured) and trigger every proc where it
// actually lives: _damagePlayer, _damageEnemy, _applySwingHit, _killEnemy,
// the skill casts and the decal channel.
//
// THE FIRST SECTION IS THE NULL-IDENTITY ASSERT and it is deliberately first:
// every save in existence has no class and no archon, so applyLayers() must be
// a byte-exact no-op for all of them. It is the first assert written and the
// last one allowed to fail (CLASSES_SPEC balanceAndMigration).

import { mulberry32 } from '../src/core/rng.js';
import { STATS, STAT_RATES, SKILLS, derive } from '../src/game/config.js';
import {
  freshSave, freshArchonState, migrate, SCHEMA_VERSION, EQUIP_SLOTS,
} from '../src/core/save.js';
import {
  grantXp, allocate, respecCost, respec, effectiveStat, shadowFieldCapacity,
} from '../src/game/progression.js';
import {
  DIRECTIONS, MASTERY_THRESHOLDS, CLASSES, CLASS_LIST, ARCHONS, ARCHON_KEYS,
  CLASS_QUALITY, PARITY_WEIGHTS, SUM_PCT_CLAMP,
  directionOf, masteryTier, masteriesOf, resonanceOf, classModifiers,
  applyLayers, applyModifiers, clampSumPct,
  canChooseClass, chooseClass, archonOffers, canAscend, ascend, bumpAffinity,
  archonResourceRules, archonFieldBonus,
  ASSAY_SEAL_COST, canRechooseClass, rechooseClass, rechooseCost,
} from '../src/game/classes.js';
// BAND UNLOCKS (Wave F.3: THE DEAD ZONE FILLS) — the 18/30/42 riders. Data +
// bandsOf are node-testable exactly like the roster; the runtime seams are
// asserted by the source-grep tripwire pattern the CLASS FLAGS section
// established (same rationale: round 1 shipped inert terms).
import {
  BAND_LEVELS, BAND_HOLD_SECONDS, BAND_COLORS, OATH_SECONDS, OATH_COOLDOWN,
  BAND_TECHNIQUES, BAND_ATTUNEMENTS, BAND_OATHS, bandsOf,
} from '../src/game/classes.js';
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
function ok(cond, label, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? `  — ${detail}` : ''}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const section = (t) => console.log(`\n${t}`);

const STAT_KEYS = STATS.map((s) => s.key);

// ---------------------------------------------------------------- identity
section('NULL IDENTITY  (the top risk in the spec: no class, no archon => byte-identical derived block)');
{
  // 200 pseudo-random saves off a forked mulberry32 stream — never
  // Math.random, so a failure here replays identically.
  const rnd = mulberry32(0xC1A55E5 >>> 0);
  const tiers = [null, 'base', 'advanced', 'sovereign'];
  // Some of these saves own T3 masteries and some carry an archon — BOTH must
  // still be identity cases: masteries are combat-hook business, and the
  // archon layer touches the derived block never (interlock.stackingRule).
  let allEqual = true;
  let allNewObject = true;
  let noMutation = true;
  let firstDiff = '';
  for (let i = 0; i < 200; i++) {
    const s = freshSave();
    s.level = 1 + Math.floor(rnd() * 100);
    s.autoStats = s.level - 1;
    for (const k of STAT_KEYS) s.stats[k] = Math.floor(rnd() * 300);
    s.classTier = tiers[Math.floor(rnd() * tiers.length)];
    if (rnd() < 0.3) s.archon = ARCHON_KEYS[Math.floor(rnd() * ARCHON_KEYS.length)];
    const d = derive(s);
    const snapshot = JSON.stringify(d);
    const out = applyLayers(s, d);
    if (out === d) allNewObject = false;
    if (JSON.stringify(d) !== snapshot) noMutation = false;
    for (const k of Object.keys(d)) {
      if (out[k] !== d[k]) {
        allEqual = false;
        if (!firstDiff) firstDiff = `save#${i} field ${k}: ${d[k]} -> ${out[k]}`;
      }
    }
    if (Object.keys(out).length !== Object.keys(d).length) {
      allEqual = false;
      if (!firstDiff) firstDiff = `save#${i} key count changed`;
    }
  }
  ok(allEqual, '200 seeded class-less saves: applyLayers is a field-exact no-op', firstDiff);
  ok(allNewObject, 'applyLayers returns a NEW object, never the input');
  ok(noMutation, 'applyLayers never mutates its input');
}

// -------------------------------------------------------------- directions
section('DIRECTIONS  (derived from SPENT points only; 30-point floor, 35% share bar, STATS-order ties)');
{
  ok(directionOf(freshSave()) === 'unsworn', 'a fresh save is UNSWORN');

  const s = freshSave();
  s.stats.str = 29;
  ok(directionOf(s) === 'unsworn', 'spent 29 all-in is still UNSWORN');
  s.stats.str = 30;
  ok(directionOf(s) === 'str', 'spent 30 all-in is a direction', directionOf(s));

  // The 35% share boundary, tested at 1000 spent so the fraction is exact.
  const sh = freshSave();
  sh.stats.str = 349; sh.stats.agi = 217; sh.stats.vit = 217; sh.stats.int = 217;
  ok(directionOf(sh) === 'unsworn', 'a 34.9% lead share is UNSWORN', directionOf(sh));
  sh.stats.str = 350; sh.stats.int = 216;
  ok(directionOf(sh) === 'str', 'a 35.0% lead share is a direction', directionOf(sh));

  // Exact ties resolve by STATS array order, deterministically.
  const tie = freshSave();
  tie.stats.str = 50; tie.stats.vit = 50;
  ok(directionOf(tie) === 'str', 'a str/vit tie resolves to str (STATS order)', directionOf(tie));
  const tie2 = freshSave();
  tie2.stats.agi = 40; tie2.stats.per = 40; tie2.stats.str = 20;
  ok(directionOf(tie2) === 'agi', 'an agi/per tie resolves to agi (STATS order)', directionOf(tie2));

  // autoStats must NOT count — direction is about choices.
  const auto = freshSave();
  auto.level = 60; auto.autoStats = 59; auto.stats.vit = 40;
  ok(effectiveStat(auto, 'str') === 59, 'sanity: the auto grant is live on this save');
  ok(directionOf(auto) === 'vit', 'the auto grant does not dilute the spent share', directionOf(auto));

  ok(Object.keys(DIRECTIONS).sort().join(',') === STAT_KEYS.slice().sort().join(','),
    'DIRECTIONS covers exactly the five stats');
  const names = Object.values(DIRECTIONS).map((d) => d.name);
  ok(new Set(names).size === 5, 'five distinct direction names', names.join(','));
}

// --------------------------------------------------------------- masteries
section('MASTERY THRESHOLDS  (60 / 120 / 200 spent in ONE stat; independent of direction)');
{
  const cases = [[59, 0], [60, 1], [119, 1], [120, 2], [199, 2], [200, 3], [0, 0], [500, 3]];
  for (const [spent, want] of cases) {
    const s = freshSave();
    s.stats.str = spent;
    ok(masteryTier(s, 'str') === want, `str ${spent} spent is tier ${want}`, String(masteryTier(s, 'str')));
  }
  // A 200/145 split owns BREAKER T3 and BULWARK T2 at once — masteries are
  // the payout, direction is only the label (masteryRules.notGatedByDirection).
  const hybrid = freshSave();
  hybrid.stats.str = 200; hybrid.stats.vit = 145;
  const owned = masteriesOf(hybrid);
  ok(owned.length === 5, 'a 200/145 str/vit build owns exactly 5 masteries', String(owned.length));
  const keys = owned.map((m) => m.key).sort().join(',');
  ok(keys === ['aftershock', 'ironhide', 'riposte', 'ruinous', 'sunder'].join(','),
    'and they are BREAKER 1-3 plus BULWARK 1-2', keys);
  ok(directionOf(hybrid) === 'str', 'while the direction label is str alone');

  // 15 masteries total, tiered against the exported thresholds.
  let count = 0;
  let thresholdsAgree = true;
  for (const d of Object.values(DIRECTIONS)) {
    count += d.masteries.length;
    d.masteries.forEach((m, i) => {
      if (m.spent !== MASTERY_THRESHOLDS[i] || m.tier !== i + 1) thresholdsAgree = false;
    });
  }
  ok(count === 15, 'exactly fifteen masteries exist', String(count));
  ok(thresholdsAgree, 'every mastery row agrees with MASTERY_THRESHOLDS');
  const mNames = Object.values(DIRECTIONS).flatMap((d) => d.masteries.map((m) => m.name));
  ok(new Set(mNames).size === 15, 'all fifteen mastery names are distinct');
}

// ----------------------------------------------------------------- classes
section('CLASS ROSTER  (eight classes, each with a real benefit AND a real drawback)');
{
  ok(CLASS_LIST.length === 8, 'eight classes', String(CLASS_LIST.length));
  ok(Object.keys(CLASSES).join(',') === 'vanguard,berserker,bladedancer,hexweaver,binder,oracle,templar,reaver',
    'the roster keys match the spec');
  const hasTerms = (side) => side && Boolean(
    Object.keys(side.pct || {}).length || Object.keys(side.add || {}).length
    || Object.keys(side.capRaise || {}).length || Object.keys(side.capReplace || {}).length
    || Object.keys(side.flagsScaled || {}).length || Object.keys(side.flags || {}).length
    || side.dynamic,
  );
  for (const c of CLASS_LIST) {
    ok(hasTerms(c.benefit), `${c.key} has a real benefit`);
    ok(hasTerms(c.drawback), `${c.key} has a real drawback`);
    ok(typeof c.benefitText === 'string' && typeof c.drawbackText === 'string' && c.drawbackText.length > 10,
      `${c.key} carries panel text for BOTH sides (drawbacks are never small print)`);
    ok(c.affinity.every((k) => STAT_KEYS.includes(k)), `${c.key} affinity keys are real stats`);
  }
  ok(CLASS_LIST.filter((c) => c.affinity.length === 2).length === 3,
    'exactly three dual-affinity classes (binder, templar, reaver — per the spec roster)');
  ok(CLASS_QUALITY.base === 1.00 && CLASS_QUALITY.advanced === 1.12 && CLASS_QUALITY.sovereign === 1.25,
    'class quality is 1.00 / 1.12 / 1.25');
}

// --------------------------------------------------------------- resonance
section('RESONANCE  (direction-in-affinity, tiered by the matched mastery)');
{
  const s = freshSave();
  s.level = 70; s.autoStats = 69; s.classTier = 'advanced';
  s.stats.int = 250; s.stats.vit = 95;
  ok(resonanceOf(s) === 0, 'no class chosen means resonance 0');
  s.className = 'binder';
  ok(resonanceOf(s) === 3, 'BINDER + EMBERMIND T3 resonates at 3', String(resonanceOf(s)));
  s.className = 'berserker';
  ok(resonanceOf(s) === 0, 'a mismatched class (BERSERKER on an int build) resonates at 0');

  // REAVER worked example: direction str at tier 2 -> resonance 2 through the
  // hybrid affinity's matched stat.
  const r = freshSave();
  r.stats.str = 150; r.stats.agi = 130; r.stats.vit = 65;
  r.className = 'reaver';
  ok(directionOf(r) === 'str', 'the REAVER build reads as str', directionOf(r));
  ok(resonanceOf(r) === 2, 'REAVER resonates at str mastery tier 2', String(resonanceOf(r)));
}

// ------------------------------------------------------------ apply layers
section('APPLY LAYERS  (the worked examples, recomputed live)');
{
  // THE QUIET GENERAL — BINDER, EMBERMIND, level 70, quality advanced,
  // resonance 3. benefitScale 1.12 x 1.12 = 1.2544, drawbackScale 0.94.
  const s = freshSave();
  s.level = 70; s.autoStats = 69; s.classTier = 'advanced';
  s.stats.int = 250; s.stats.vit = 95;
  s.className = 'binder';
  const base = derive(s);
  ok(base.maxHp === 2555 && near(base.atk, 289.0, 0.01) && near(base.shadowDmgMul, 4.509, 0.001),
    'sanity: derive() reproduces the worked example base block',
    `hp ${base.maxHp} atk ${base.atk} sdm ${base.shadowDmgMul}`);
  const out = applyLayers(s, base);
  ok(near(out.atk, 289.0 * (1 - 0.20 * 0.94), 0.01), 'BINDER atk -20% softened to -18.8%', String(out.atk));
  ok(out.maxHp === Math.floor(2555 * (1 - 0.15 * 0.94)), 'BINDER maxHp -15% softened to -14.1%, floored', String(out.maxHp));
  ok(near(out.shadowDmgMul, 4.509 * 1.25088, 0.001), 'BINDER shadow damage +20% x 1.2544', String(out.shadowDmgMul));
  const mods = classModifiers(s);
  ok(near(mods.benefitScale, 1.2544, 1e-9) && near(mods.drawbackScale, 0.94, 1e-9),
    'quality x resonance scales are exactly 1.2544 / 0.94');
  ok(mods.flags.fieldAdd === 2, 'the +2 field flag is UNSCALED (headcount is a draw-call budget)');
  ok(near(mods.flags.extractAdd, 0.12 * 1.2544, 1e-9), 'extraction +12pts scales to +15.05pts', String(mods.flags.extractAdd));
  ok(near(mods.flags.skillCostPct, 0.30 * 0.94, 1e-9), 'the mana drawback softens to +28.2%');

  // THE STANDING WALL — VANGUARD: the raised DR cap re-admits the raw the
  // base 45% clamp cut off; the crit cap DROP is a hard 30%.
  const v = freshSave();
  v.level = 70; v.autoStats = 69; v.classTier = 'advanced';
  v.stats.vit = 245; v.stats.int = 60; v.stats.per = 40;
  v.className = 'vanguard';
  const vb = derive(v);
  ok(near(vb.dr, 0.45, 1e-9), 'sanity: base dr sits clamped at the 45% cap');
  const vo = applyLayers(v, vb);
  ok(near(vo.dr, 0.5652, 1e-6), 'VANGUARD dr recovers its uncapped 0.5652 under the raised cap', String(vo.dr));
  ok(near(vo.crit, 0.30, 1e-9), 'VANGUARD crit is hard-capped at 30%', String(vo.crit));
  ok(vo.maxHp === Math.floor(vb.maxHp * (1 + 0.14 * 1.2544)), 'VANGUARD maxHp +14% x 1.2544', String(vo.maxHp));
  ok(near(vo.speed, vb.speed * (1 - 0.12 * 0.94), 1e-6), 'VANGUARD speed -12% softened');
  ok(near(vo.dashDistance, SKILLS.dash.distance * (1 - 0.20 * 0.94), 1e-6),
    'dash distance is seeded from SKILLS and cut', String(vo.dashDistance));

  // THE LONG BURN — BERSERKER: the atk-speed cap raise re-admits raw; the DR
  // cap drop to 25% is never softened by resonance (drawback caps are law).
  const b = freshSave();
  b.level = 70; b.autoStats = 69; b.classTier = 'advanced';
  b.stats.str = 230; b.stats.vit = 70; b.stats.agi = 45;
  b.className = 'berserker';
  const bb = derive(b);
  ok(near(bb.atkSpeed, 0.30, 1e-9), 'sanity: base atkSpeed sits clamped at the 30% cap');
  const bo = applyLayers(b, bb);
  ok(near(bo.atkSpeed, 0.30 + 0.06 * 1.2544, 1e-6), 'BERSERKER atk-speed cap raises to 37.5%', String(bo.atkSpeed));
  ok(near(bo.dr, 0.25, 1e-9), 'BERSERKER dr is hard-capped at 25%, unsoftened', String(bo.dr));
  ok(near(bo.hpRegen, bb.hpRegen * (1 - 0.50 * 0.94), 1e-6), 'BERSERKER hp regen -50% softened');
  ok(near(classModifiers(b).flags.rageMaxAtkBonus, 0.40 * 1.2544, 1e-9),
    'the missing-HP rage ceiling scales to +50.2%');

  // BLADEDANCER: adds against SKILLS-seeded bases, and the 300ms dodge cap
  // from the roster text wins over the worked example's own arithmetic.
  const d2 = freshSave();
  d2.level = 70; d2.autoStats = 69; d2.classTier = 'advanced';
  d2.stats.agi = 260; d2.stats.vit = 50; d2.stats.str = 35;
  d2.className = 'bladedancer';
  const db = derive(d2);
  const dd = applyLayers(d2, db);
  ok(near(dd.dashCd, 1.60 - 0.55 * 1.2544, 1e-6), 'BLADEDANCER dash cooldown 1.60 -> 0.91s', String(dd.dashCd));
  ok(near(dd.dashIframes, 0.34 + 0.08 * 1.2544, 1e-6), 'BLADEDANCER i-frames 0.34 -> 0.44', String(dd.dashIframes));
  ok(near(dd.dodgeWindow, 0.300, 1e-9), 'the dodge window caps at 300ms (roster text is law)', String(dd.dodgeWindow));
  ok(near(dd.knockTakenMul, 1 + 0.40 * 0.94, 1e-9), 'knockback taken +40% softened to +37.6%', String(dd.knockTakenMul));

  // ORACLE: the floor reaches exactly 100% and no further.
  const o = freshSave();
  o.level = 70; o.autoStats = 69; o.classTier = 'sovereign';
  o.stats.per = 300;
  o.className = 'oracle';
  const ob = derive(o);
  ok(near(ob.dmgFloor, 0.92, 1e-9), 'sanity: base floor sits at the 92% cap');
  const oo = applyLayers(o, ob);
  ok(near(oo.dmgFloor, 1.00, 1e-9), 'ORACLE floor lands at exactly 100%', String(oo.dmgFloor));
  ok(oo.tellLeadMs > ob.tellLeadMs, 'ORACLE telegraph lead rises past the stat cap');

  // TEMPLAR: INT counts as VIT, but the converted DR still answers to the 45%
  // base cap — TEMPLAR raises nothing.
  const t = freshSave();
  t.level = 70; t.autoStats = 69; t.classTier = 'base';
  t.stats.vit = 220; t.stats.int = 120;
  t.className = 'templar';
  const tb = derive(t);
  const to = applyLayers(t, tb);
  ok(to.maxHp > tb.maxHp, 'TEMPLAR converts INT into max HP');
  ok(to.dr <= STAT_RATES.vit.drCap + 1e-9, 'TEMPLAR converted DR never exceeds the 45% cap', String(to.dr));

  // dashCd hard floor: no stack of cooldown cuts may make the dash free.
  const floorS = freshSave();
  floorS.level = 70; floorS.className = 'bladedancer'; floorS.classTier = 'sovereign';
  const floored = applyModifiers({ dashCd: 0.6 }, { pct: {}, add: { dashCd: -5 }, caps: {} }, floorS);
  ok(near(floored.dashCd, 0.5, 1e-9), 'dashCd can never fold below the 0.5s floor', String(floored.dashCd));
}

// ------------------------------------------------------------------- clamp
section('THE SUM-PCT CLAMP  ([-0.5, +0.6] at both ends, synthetic terms no real class produces)');
{
  ok(SUM_PCT_CLAMP[0] === -0.5 && SUM_PCT_CLAMP[1] === 0.6, 'the exported clamp is [-0.5, +0.6]');
  ok(clampSumPct(-0.9) === -0.5, 'the low end clamps at -50%');
  ok(clampSumPct(1.4) === 0.6, 'the high end clamps at +60%');
  ok(clampSumPct(0.25) === 0.25, 'in-range values pass through');
  const s = freshSave();
  const d = derive(s);
  const up = applyModifiers(d, { pct: { atk: 2.0 }, add: {}, caps: {} }, s);
  ok(near(up.atk, d.atk * 1.6, 1e-9), 'a +200% pct pool folds as +60%', String(up.atk));
  const down = applyModifiers(d, { pct: { atk: -0.9 }, add: {}, caps: {} }, s);
  ok(near(down.atk, d.atk * 0.5, 1e-9), 'a -90% pct pool folds as -50%', String(down.atk));
  // Every roster class's STATED terms sit inside the clamp at base quality
  // (HEXWEAVER's +60% mpRegen and BERSERKER's -50% hpRegen ride the
  // boundaries exactly). Quality/resonance can push the two regen terms past
  // the rail — and the clamp absorbing that overflow is the design, so the
  // fold below must never emerge outside the rails either way.
  for (const key of Object.keys(CLASSES)) {
    const cs = freshSave();
    cs.level = 70; cs.autoStats = 69; cs.classTier = 'base';
    cs.stats.str = 200; cs.stats.agi = 200; cs.stats.vit = 200; cs.stats.int = 200; cs.stats.per = 200;
    cs.className = key;
    const m = classModifiers(cs);
    ok(Object.values(m.pct).every((p) => p >= SUM_PCT_CLAMP[0] && p <= SUM_PCT_CLAMP[1]),
      `${key} stated pct terms sit inside the clamp at base quality`);
    cs.classTier = 'sovereign';
    const ms = classModifiers(cs);
    ok(Object.values(ms.pct).every((p) => clampSumPct(p) >= SUM_PCT_CLAMP[0] && clampSumPct(p) <= SUM_PCT_CLAMP[1]),
      `${key} at sovereign quality still folds inside the rails`);
  }
}

// ------------------------------------------------------------ class choice
section('CLASS CHOICE  (level 20 gate, one respec token, once)');
{
  const s = freshSave();
  s.level = 19;
  ok(!canChooseClass(s), 'not choosable below 20');
  ok(!chooseClass(s, 'berserker'), 'chooseClass refuses below 20');
  s.level = 20;
  ok(canChooseClass(s), 'choosable at 20');
  ok(!chooseClass(s, 'warlock'), 'an unknown class key is refused');
  ok(chooseClass(s, 'berserker'), 'a real class at 20 commits');
  ok(s.className === 'berserker', 'className is written');
  ok(s.respecTokens === 1, 'choosing banks one respec token', String(s.respecTokens));
  ok(s.archonState.classTokenGranted === true, 'the once-guard is set');
  ok(!chooseClass(s, 'oracle'), 'rechoosing is refused here (that path costs an Assay Seal, STEP 5)');
  ok(s.className === 'berserker' && s.respecTokens === 1, 'and nothing changed on the refusal');
}

// -------------------------------------------------------------- rechoosing
section('RECHOOSING  (one Assay Seal: free the first time, 1,800 ash after; className only)');
{
  ok(ASSAY_SEAL_COST === 1800, 'the seal is priced at 1,800 ash', String(ASSAY_SEAL_COST));

  const s = freshSave();
  s.level = 24;
  ok(!canRechooseClass(s), 'no class, nothing to reseal');
  ok(!rechooseClass(s, 'oracle'), 'rechooseClass refuses a classless save');
  chooseClass(s, 'berserker');
  s.classTier = 'advanced';           // pretend the level-40 trial happened
  s.stats.str = 130;
  s.ash = 500;
  ok(canRechooseClass(s), 'a sworn save can reseal');
  ok(rechooseCost(s) === 0, 'the FIRST reseal is free (a seal on the house)', String(rechooseCost(s)));

  ok(!rechooseClass(s, 'warlock'), 'an unknown key is refused');
  ok(!rechooseClass(s, 'berserker'), 'resealing to the class you already hold is refused');
  ok(s.archonState.freeSealUsed === false, 'and neither refusal burned the free seal');

  ok(rechooseClass(s, 'oracle'), 'the free reseal commits with 500 ash in the wallet');
  ok(s.className === 'oracle', 'className is rewritten');
  ok(s.ash === 500, 'and the free seal charged nothing', String(s.ash));
  ok(s.archonState.freeSealUsed === true, 'the free seal is spent — once, ever');
  ok(s.respecTokens === 1, 'a reseal mints NO second respec token', String(s.respecTokens));
  ok(s.classTier === 'advanced' && s.stats.str === 130,
    'classTier (quality) and stats are untouched — a reseal changes className ONLY');

  ok(rechooseCost(s) === 1800, 'the second seal costs 1,800', String(rechooseCost(s)));
  ok(!rechooseClass(s, 'vanguard'), '500 ash cannot buy it');
  ok(s.className === 'oracle' && s.ash === 500, 'the refusal changed nothing');
  s.ash = 1800;
  ok(rechooseClass(s, 'vanguard'), 'exactly 1,800 ash buys the reseal');
  ok(s.className === 'vanguard' && s.ash === 0, 'the seal is bought and spent atomically', `${s.className} ash=${s.ash}`);

  // The free-seal guard must SURVIVE a save/load cycle, or every boot would
  // mint another free look and the layer stops being a commitment.
  const rt = migrate(JSON.parse(JSON.stringify(s)));
  ok(rt.archonState.freeSealUsed === true, 'freeSealUsed round-trips through migrate()');
  const corrupt = migrate({ ...JSON.parse(JSON.stringify(s)), archonState: { ...s.archonState, freeSealUsed: 'yes' } });
  ok(corrupt.archonState.freeSealUsed === false, 'a corrupted freeSealUsed sanitises to false (never truthy garbage)');
}

// ------------------------------------------------------------------ respec
section('RESPEC  (80 + 14/point VERBATIM below the 3000 cap; tokens consumed instead of ash)');
{
  // The load-bearing assert, byte-for-byte from tools/progression-test.mjs.
  const s = freshSave();
  grantXp(s, 139); // xpForLevel(1)
  allocate(s, 'str', 3);
  ok(respecCost(s) === 80 + 14 * 3, 'respec cost is 80 + 14/point at spent=3 (=122)', String(respecCost(s)));

  const capd = freshSave();
  capd.stats.str = 208;
  ok(respecCost(capd) === 2992, 'spent 208 still prices linearly (2992)', String(respecCost(capd)));
  capd.stats.str = 209;
  ok(respecCost(capd) === 3000, 'the cap first binds at spent 209', String(respecCost(capd)));
  capd.stats.str = 300; capd.stats.int = 195;
  ok(respecCost(capd) === 3000, 'the L100 all-in 495 spent costs 3000, not 6010', String(respecCost(capd)));

  // Ash path, unchanged from the shipped behaviour.
  const a = freshSave();
  a.points = 10; allocate(a, 'vit', 3);
  a.ash = 121;
  ok(!respec(a), 'one ash short fails');
  a.ash = 122;
  ok(respec(a), 'exact ash succeeds');
  ok(a.ash === 0 && a.stats.vit === 0 && a.points === 10, 'ash is spent, points refunded');

  // Token path: consumed INSTEAD of ash, never alongside.
  const t = freshSave();
  t.points = 10; allocate(t, 'int', 5);
  t.respecTokens = 1; t.ash = 5000;
  ok(respec(t), 'a token respecs with no ash check');
  ok(t.respecTokens === 0, 'the token is consumed', String(t.respecTokens));
  ok(t.ash === 5000, 'and the ash is untouched', String(t.ash));
  ok(t.stats.int === 0 && t.points === 10, 'points come back in full');

  const z = freshSave();
  z.respecTokens = 1;
  ok(!respec(z), 'nothing spent still refuses');
  ok(z.respecTokens === 1, 'and the token is not wasted on the refusal');

  const broke = freshSave();
  broke.points = 5; allocate(broke, 'agi', 2);
  ok(!respec(broke), 'no token, no ash: refused (shipped behaviour verbatim)');
}

// --------------------------------------------------------------- migration
section('SAVE MIGRATION  (three generations in, sane defaults out; the token grant fires once)');
{
  // GENERATION 1 — pre-3-A (schema v1): integer shadow count, no equipment,
  // no shop, no clock. The same fixture progression-test.mjs uses.
  const gen1 = {
    version: 1, level: 23, xp: 400, points: 9,
    stats: { str: 12, agi: 4, vit: 7, int: 3 },
    cleared: { E: 74, D: 130 }, shadows: 6, totalKills: 812, deaths: 3,
  };
  const m1 = migrate(gen1);
  ok(m1.version === SCHEMA_VERSION, 'gen1 migrates to v2');
  ok(m1.className === null && m1.archon === null, 'gen1: no class, no archon — never auto-assigned');
  ok(m1.respecTokens === 1, 'gen1 at level 23 (past the class gate) banks the one migration token', String(m1.respecTokens));
  ok(m1.archonState.migTokenGranted === true, 'gen1: the grant guard is set');
  ok(m1.archonState.classTokenGranted === false, 'gen1: the class-choice guard is NOT set');
  ok(JSON.stringify(m1.archonState.affinity) === JSON.stringify({ shadow: 0, flame: 0, frost: 0, storm: 0, beast: 0 }),
    'gen1: affinity counters start at zero (the offer reflects how they play NOW)');
  ok(m1.shadows.roster.length === 6 && m1.stats.per === 0, 'gen1: the existing v1 upgrades still happen');
  ok(EQUIP_SLOTS.every((slot) => slot in m1.equipment), 'gen1: the eight equipment slots exist');
  const m1round = migrate(m1);
  ok(JSON.stringify(m1round) === JSON.stringify(m1), 'gen1 -> v2 -> v2 round trip is byte-identical');
  ok(m1round.respecTokens === 1, 'a repeated migration cannot mint a second token', String(m1round.respecTokens));

  // A young gen1 save below the class gate gets no token — the system will
  // reach them live instead.
  const young = migrate({ version: 1, level: 12, stats: { str: 5 }, shadows: 0 });
  ok(young.respecTokens === 0 && young.archonState.migTokenGranted === false,
    'gen1 below level 20 gets no token and stays grantable');

  // GENERATION 2 — 1.7-era v2: roster records and a weapon, but no equipment
  // block, no shop, no clock.
  const gen2 = {
    version: 2, level: 30, xp: 100, points: 4,
    stats: { str: 40, agi: 10, vit: 30, int: 20, per: 5 }, autoStats: 29,
    cleared: { E: 60, D: 90, C: 140 }, ash: 900,
    shadows: { roster: [{ id: 1, name: 'Cinderbound Thrall', grade: 2, type: 'grunt', level: 28, kills: 40, bornAt: 0 }], deployed: [1], nextId: 2 },
    weapon: { b: 'ironsword', r: 'rare', s: 12345, l: 28 },
    classTier: null, totalKills: 2000, deaths: 9,
  };
  const m2 = migrate(gen2);
  ok(m2.className === null && m2.archon === null && m2.respecTokens === 1,
    'gen2 at level 30: sane defaults plus the one token');
  ok(m2.archonState.migTokenGranted === true, 'gen2: guard set');
  ok(m2.equipment.weapon && m2.equipment.weapon.b === 'ironsword', 'gen2: the old weapon reaches the weapon slot');
  ok(m2.shop.band === -1 && m2.worldTime === 15.0, 'gen2: the 1.8-era fields still default correctly');
  ok(m2.shadows.roster.length === 1 && m2.ash === 900, 'gen2: roster and wallet survive');
  ok(JSON.stringify(migrate(m2)) === JSON.stringify(m2), 'gen2 round trip is byte-identical');

  // GENERATION 3 — 1.8 (current shipped build): everything above plus
  // equipment, shop and clock — and a classTier from the level-40 trial,
  // which must survive untouched (it is QUALITY now, still theirs).
  const gen3 = {
    version: 2, level: 60, xp: 0, points: 12,
    stats: { str: 30, agi: 20, vit: 80, int: 120, per: 25 }, autoStats: 59,
    cleared: { E: 50, D: 70, C: 100, B: 150, A: 220, S: 300 }, ash: 4200,
    shadows: { roster: [{ id: 1, name: 'Ashveil Warden', grade: 5, type: 'brute', level: 55, kills: 900, bornAt: 0 }], deployed: [1], nextId: 2 },
    weapon: { b: 'emberbrand', r: 'epic', s: 777, l: 58 },
    equipment: {
      weapon: { k: 'w', b: 'emberbrand', r: 'epic', s: 777, l: 58 },
      offhand: null, head: { k: 'a', b: 'vigil_hood', r: 'rare', s: 9, l: 50 },
      chest: null, hands: null, legs: null, feet: null, trinket: null,
    },
    shop: { band: 4, sold: ['emberbrand'] },
    worldTime: 9.25,
    classTier: 'advanced', totalKills: 15000, deaths: 40,
  };
  const m3 = migrate(gen3);
  ok(m3.className === null && m3.archon === null && m3.respecTokens === 1,
    'gen3 at level 60: sane defaults plus the one token');
  ok(m3.classTier === 'advanced', 'gen3: the earned classTier is untouched (it is QUALITY now)');
  ok(m3.shop.band === 4 && m3.worldTime === 9.25 && m3.equipment.head.b === 'vigil_hood',
    'gen3: the 1.8 fields survive intact');
  ok(JSON.stringify(migrate(m3)) === JSON.stringify(m3), 'gen3 round trip is byte-identical');

  // A save written by THIS build round-trips its class identity too.
  const classed = migrate(gen3);
  classed.className = 'binder'; classed.archon = 'flame'; classed.respecTokens = 3;
  classed.archonState.sigils = 2; classed.archonState.affinity.flame = 420;
  classed.archonState.classTokenGranted = true;
  const mc = migrate(JSON.parse(JSON.stringify(classed)));
  ok(mc.className === 'binder' && mc.archon === 'flame' && mc.respecTokens === 3,
    'a classed+ascended save keeps its identity through migrate');
  ok(mc.archonState.sigils === 2 && mc.archonState.affinity.flame === 420,
    'sigils and affinity counters survive');

  // Additive-only proof for the rollback direction: every key the shipped
  // build wrote still exists, and the new footprint is exactly the additive
  // fields since — the four from this wave (className/archon/archonState/
  // respecTokens) plus hunterName, added later the same way (null-default,
  // not a schema bump — see save.js's own comment on that field).
  const fresh = freshSave();
  const shippedKeys = ['version', 'level', 'xp', 'points', 'stats', 'autoStats', 'playerBody', 'cleared', 'shadows', 'ash', 'daily', 'classTier', 'unlockedAnomaly', 'totalKills', 'deaths', 'weapon', 'stash', 'equipment', 'shop', 'worldTime'];
  ok(shippedKeys.every((k) => k in fresh), 'every shipped save key survives in freshSave');
  const newKeys = Object.keys(fresh).filter((k) => !shippedKeys.includes(k));
  // RETARGET (Wave B5): settlement + visited joined the additive footprint —
  // multi-town travel state, absent-means-default like every field before
  // them. The fence still does its job: an EIGHTH field must be argued into
  // this list, never slipped past it.
  ok(newKeys.sort().join(',') === 'archon,archonState,className,hunterName,respecTokens,settlement,visited',
    'the new footprint is exactly the seven additive fields', newKeys.join(','));
}

// -------------------------------------------------------------- sanitisers
section('SANITISERS  (hand-corrupted values never reach classes.js)');
{
  const corrupt = {
    version: 2, level: 50,
    stats: { str: 10 }, autoStats: 49,
    shadows: { roster: [], deployed: [], nextId: 1 },
    className: 'wizard',                 // not a class
    archon: 'monarch',                   // banned and unknown
    respecTokens: Number.NaN,
    archonState: {
      resource: -5, sigils: 2.9, ascendedAt: 'yesterday',
      pacts: [null, 'junk', { id: 'x' }, { id: 3, extra: true }],
      affinity: { flame: 123456, frost: -2, bogus: 7 },
      migTokenGranted: true, classTokenGranted: 'yes',
    },
  };
  const m = migrate(corrupt);
  ok(m.className === null, 'an unknown className snaps to null', String(m.className));
  ok(m.archon === null, 'an unknown archon snaps to null', String(m.archon));
  ok(m.respecTokens === 0, 'NaN tokens snap to 0 (guard already set, so no re-grant)', String(m.respecTokens));
  ok(m.archonState.resource === 0, 'a negative resource snaps to 0');
  ok(m.archonState.sigils === 2, 'fractional sigils floor', String(m.archonState.sigils));
  ok(m.archonState.ascendedAt === 0, 'a non-numeric ascendedAt snaps to 0');
  ok(m.archonState.pacts.length === 1 && m.archonState.pacts[0].id === 3,
    'pacts filter to objects with a numeric id', JSON.stringify(m.archonState.pacts));
  ok(m.archonState.affinity.flame === 9999, 'affinity clamps at the 9999 overflow guard');
  ok(m.archonState.affinity.frost === 0, 'negative affinity clamps at 0');
  ok(!('bogus' in m.archonState.affinity), 'unknown affinity keys are dropped');
  ok(m.archonState.classTokenGranted === false, 'a non-boolean guard reads as false');

  const inflate = migrate({ version: 2, level: 50, stats: {}, shadows: { roster: [], deployed: [], nextId: 1 }, respecTokens: 1e9, archonState: freshArchonState() });
  ok(inflate.respecTokens === 99, 'a hand-inflated wallet clamps at 99', String(inflate.respecTokens));
  const frac = migrate({ version: 2, level: 10, stats: {}, shadows: { roster: [], deployed: [], nextId: 1 }, respecTokens: 3.7 });
  ok(frac.respecTokens === 3, 'fractional tokens floor', String(frac.respecTokens));
  ok(migrate(null).className === null && migrate(null).respecTokens === 0, 'a null save is fresh and class-less');
}

// ---------------------------------------------------------------- archons
section('ARCHON OFFERS AND ASCENSION  (level 55 + classTier + an S clear; top two counters plus SHADOW)');
{
  ok(Object.keys(ARCHONS).join(',') === ARCHON_KEYS.join(','), 'five paths in the fixed key order');
  for (const k of ARCHON_KEYS) {
    const r = archonResourceRules(k);
    ok(r && ['max', 'gainPer', 'decayPerSecond', 'ultimateCost'].every((f) => typeof r[f] === 'number'),
      `${k} carries complete resource rules`);
  }
  ok(archonResourceRules('monarch') === null, 'an unknown path has no rules');

  const s = freshSave();
  s.level = 55; s.classTier = 'base'; s.cleared = { S: 120 };
  ok(canAscend(s), 'level 55 + classTier + S clear can ascend');
  s.level = 54;
  ok(!canAscend(s), 'level 54 cannot');
  s.level = 55; s.classTier = null;
  ok(!canAscend(s), 'no classTier (level-40 trial undone) cannot');
  s.classTier = 'base'; s.cleared = {};
  ok(!canAscend(s), 'no S clear cannot');
  s.cleared = { S: 120 };

  ok(JSON.stringify(archonOffers(s)) === JSON.stringify(['shadow', 'flame']),
    'all-zero counters offer [shadow, flame] — never fewer than two', JSON.stringify(archonOffers(s)));
  bumpAffinity(s, 'flame', 50);
  bumpAffinity(s, 'frost', 30);
  ok(JSON.stringify(archonOffers(s)) === JSON.stringify(['flame', 'frost', 'shadow']),
    'top two by counter, then SHADOW appended (always offerable)', JSON.stringify(archonOffers(s)));
  bumpAffinity(s, 'shadow', 100);
  ok(JSON.stringify(archonOffers(s)) === JSON.stringify(['shadow', 'flame']),
    'SHADOW in the top pair is not appended twice');
  bumpAffinity(s, 'storm', 20000);
  ok(s.archonState.affinity.storm === 9999, 'bumpAffinity clamps at 9999');
  bumpAffinity(s, 'storm', -50000);
  ok(s.archonState.affinity.storm === 0, 'and at 0 on the way down');
  bumpAffinity(s, 'monarch', 5);
  ok(!('monarch' in s.archonState.affinity), 'an unknown path key bumps nothing');

  // Offers gate legality: the trial presents archonOffers and nothing else.
  ok(!ascend(s, 'beast'), 'an unoffered path is refused');
  const t0 = s.respecTokens;
  ok(ascend(s, 'flame'), 'an offered path ascends');
  ok(s.archon === 'flame' && s.archonState.ascendedAt === 55 && s.archonState.resource === 0,
    'ascension writes the path, the level, and zeroes the meter');
  ok(s.respecTokens === t0 + 1, 'first ascension banks one respec token');

  // Re-ascension needs an ASHEN SIGIL and mints no token — sigils can never
  // farm tokens.
  ok(!canAscend(s), 'ascended with no sigil cannot re-ascend');
  s.archonState.sigils = 1;
  ok(canAscend(s), 'a sigil re-opens the trial');
  const t1 = s.respecTokens;
  ok(ascend(s, 'shadow'), 're-ascension to an offered path succeeds');
  ok(s.archon === 'shadow' && s.archonState.sigils === 0, 'the sigil is consumed');
  ok(s.respecTokens === t1, 'and no token is minted', String(s.respecTokens));

  // The archon layer touches the derived block never — interlock rule 3 made
  // testable early (STEP 7 re-asserts it in the browser).
  const before = derive(s);
  const after = applyLayers(s, before);
  ok(Object.keys(before).every((k) => after[k] === before[k]),
    'an ascended, class-less save still gets a byte-identical derived block');
}

// ----------------------------------------------------------------- parity
section('PARITY TABLE  (five routes, one ceiling: every composite within 0.06 of 1.00)');
{
  const wsum = Object.values(PARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  ok(near(wsum, 1.0, 1e-9), 'the axis weights sum to 1', String(wsum));
  for (const [key, path] of Object.entries(ARCHONS)) {
    const c = Object.entries(PARITY_WEIGHTS).reduce((a, [axis, w]) => a + w * path.parity[axis], 0);
    ok(near(c, 1.0, 0.06), `${key} composite lands within 0.06 of 1.00`, c.toFixed(4));
  }
  const rooms = Object.values(ARCHONS).map((p) => p.parity.roomDps);
  ok(Math.max(...rooms) / Math.min(...rooms) > 1.5,
    'while the axis spread stays enormous (room DPS varies >1.5x) — equal power, different routes');
}

// =========================================================================
// STEP 11 — THE PARITY MODEL. The spec's five worked builds, run through a
// headless DPS/eHP model against the powerParity yardstick: level 70,
// resonant, quality 'advanced', a 60 s S-gate room and THE RIFT ARCHON.
//
// The section above pins the STATED table; this one EVALUATES the routes.
// Every mechanic number is read live from classes.js / archon.js / config.js
// / shadows.js — nothing is copied — so retuning any of them moves a raw
// axis here and drives a composite out of the band. That is the assert the
// spec calls for: "without that assert, this table is a wish".
//
// HOW RAW BECOMES A SCORE, honestly stated: raw axis values are computed
// mechanistically (deterministic 60 s sims for the two DPS axes, closed
// forms for eHP and mobility), normalised per axis by the roster's own
// geometric mean (so a global retune that lifts every path equally cancels
// out), then compressed by a frozen per-axis exponent. The exponents and
// the encounter constants below are the YARDSTICK'S DEFINITION — fixed at
// STEP 11 calibration, when all five composites landed within 0.055 of the
// frozen anchor — and they are not to be retuned to make a failing path
// pass: the spec's rule is TUNE THE TABLES, NOT THE MODEL. The compression
// exists because the axes saturate in play (2.7x the eHP is not 2.7x the
// power; a room cleared in 9 s instead of 12 is the same room) while raw
// mechanised spreads are wide by design.
// =========================================================================
section('PARITY MODEL  (the five worked builds, evaluated: one ceiling by five routes)');
{
  const { ENEMY_TYPES, BOSSES, GATES, scaleEnemy } = await import('../src/game/config.js');
  const { ARCHON_PATHS } = await import('../src/game/archon.js');
  const { shadowCombat } = await import('../src/game/shadows.js');

  // ---- the five worked builds (interlock.workedExamples, verbatim) --------
  const mkBuild = (stats, className) => {
    const s = freshSave();
    s.level = 70; s.autoStats = 69; s.classTier = 'advanced';
    Object.assign(s.stats, stats);
    s.className = className;
    return s;
  };
  const BUILDS = {
    shadow: mkBuild({ int: 250, vit: 95 }, 'binder'),        // THE QUIET GENERAL
    flame:  mkBuild({ str: 230, vit: 70, agi: 45 }, 'berserker'), // THE LONG BURN
    frost:  mkBuild({ vit: 245, int: 60, per: 40 }, 'vanguard'),  // THE STANDING WALL
    storm:  mkBuild({ agi: 260, vit: 50, str: 35 }, 'bladedancer'), // THE UNCAUGHT
    beast:  mkBuild({ str: 150, agi: 130, vit: 65 }, 'reaver'),   // THE PACT
  };
  const D = {};
  const FLAGS = {};
  for (const [k, s] of Object.entries(BUILDS)) {
    D[k] = applyLayers(s, derive(s));
    FLAGS[k] = classModifiers(s).flags;
  }

  // The hybrid sanity check, made executable: five different directions and
  // five different classes — three genuinely independent axes, not three
  // names for one choice.
  ok(directionOf(BUILDS.shadow) === 'int' && directionOf(BUILDS.flame) === 'str'
    && directionOf(BUILDS.frost) === 'vit' && directionOf(BUILDS.storm) === 'agi'
    && directionOf(BUILDS.beast) === 'str',
    'the five builds derive five direction reads (int/str/vit/agi/str — none assigned, all earned)');
  ok(new Set(Object.values(BUILDS).map((s) => s.className)).size === 5,
    'and wear five different classes — the axes are independent');

  // ---- layer A/B pins: the spec's printed arithmetic, from the live code --
  // (Storm and beast are pinned in their own STEP 10 section; these are the
  // other three. Where the spec's print carries intermediate rounding the
  // code truth is pinned and the drift noted — same posture as the eHP
  // 13,096 +/- 10 case above.)
  ok(near(D.shadow.atk, 234.7, 0.1) && D.shadow.maxHp === 2194 && D.shadow.maxMp === 2490,
    'QUIET GENERAL: atk 234.7, maxHp 2194 (spec prints 2,195 pre-floor), maxMp 2,490',
    `${D.shadow.atk.toFixed(1)} / ${D.shadow.maxHp} / ${D.shadow.maxMp}`);
  ok(D.shadow.cdr === 0.40 && near(D.shadow.dr, 0.295, 0.001) && near(D.shadow.skillMul, 8.975, 1e-9),
    'cdr capped 0.40, dr 0.295, skillMul 8.975 — the worked example verbatim');
  ok(near(D.shadow.shadowDmgMul, 5.640, 0.01),
    'shadowDmgMul 5.64 (the spec prints 5.654 by scaling the whole multiplier; the code scales the +20% term)',
    D.shadow.shadowDmgMul.toFixed(3));
  ok(near(D.flame.atk, 841.0, 0.1) && near(D.flame.atkSpeed, 0.375, 0.001)
    && near(D.flame.dr, 0.250, 1e-9) && D.flame.maxHp === 2280 && D.flame.crit === 0.55,
    'LONG BURN: atk 841, atk-speed cap raised to 37.5%, dr pinned AT the 25% Berserker cap, maxHp 2,280',
    `${D.flame.atk.toFixed(1)} / ${D.flame.atkSpeed.toFixed(3)} / ${D.flame.dr} / ${D.flame.maxHp}`);
  ok(D.frost.maxHp === 4943 && near(D.frost.dr, 0.5652, 0.0005) && D.frost.maxMp === 1160,
    'STANDING WALL: maxHp 4,943 (spec prints 4,944 pre-floor), dr 0.5652 past the raised 57.5% cap, maxMp 1,160',
    `${D.frost.maxHp} / ${D.frost.dr.toFixed(4)} / ${D.frost.maxMp}`);

  // ---- the yardstick (frozen at STEP 11 calibration) ----------------------
  const SIM = 60;                 // the spec's own 60 s window
  const DT = 0.05;                // deterministic fixed step, no RNG anywhere
  const SWING_BASE = 2.0;         // swings/s at 0 atk speed — calibrated on the
                                  // spec's own "~2.7 hits/s" at the LONG
                                  // BURN's 37.5% (2.0 x 1.375 = 2.75)
  // Cone cleave by the favoured weapon archetype (the yardstick arms each
  // build with "a rare weapon of the archetype the path favours"): greataxe
  // arcs seed a pack (3), sword/blade catches a pair (2), daggers and claws
  // are single-target (1) — concentration routes get concentration.
  const CLEAVE = { shadow: 2, flame: 3, frost: 2, storm: 1, beast: 1 };
  const UPTIME_ROOM = 0.85;       // melee time-on-target while a room swarms
  // Boss uptime tracks what the build can afford to stand through: the
  // STANDING WALL never steps back (0.85); the UNCAUGHT disengages at will
  // and re-enters free (0.80); shadow and beast fight behind an ally (0.75);
  // the LONG BURN at a 25% DR cap with healing -33% and regen -47% spends
  // most of THE RIFT ARCHON's kit running (0.42) — "the roster's worst
  // eHP-with-no-shield" priced as engagement, which is where it actually
  // costs a melee build.
  const UPTIME_BOSS = { shadow: 0.75, flame: 0.42, frost: 0.85, storm: 0.80, beast: 0.75 };
  // The room: gate.waveSize 9 (GATES rank S) mixed bodies at enemyLevel 54,
  // hardened x12. WHY: at yardstick power the at-level pack dies to 1-3
  // hits from every build, which measures hit-cadence and nothing else; the
  // spec's own flame arithmetic ("a combustion roughly every 3.7 s per
  // target") presupposes bodies that survive a stack build. x12 is the
  // durability where every route's machinery participates and rooms still
  // clear (slots die and refill — steady wave pressure, overkill wasted).
  const DURABLE_MUL = 12;
  const N4 = 3;                   // packed-fight neighbours inside 4 m (combustion)
  const N6 = 4;                   // ...and inside 6 m (shatter)
  const SOLDIER_CYCLE = 0.85;     // game.js's shipped shadow attack cycle
  const ARMY_ENGAGE_ROOM = 0.70;  // twelve bodies spread across a live room
  const ARMY_ENGAGE_BOSS = 0.30;  // "a single target neutralises headcount"
  const PACT_ENGAGE_ROOM = 0.40;  // one ally, travel time between targets
  const PACT_ENGAGE_BOSS = 0.70;  // one huge ally on one huge, moving boss
  const RAGE_ROOM = 25;           // %-missing-HP a berserker sustains vs trash
  const RAGE_BOSS = 15;           // ...and vs a boss he cannot out-sustain
  const KITE = { shadow: 0.5, flame: 0.5, frost: 0.3, storm: 1.0, beast: 0.5 }; // moving fraction of fight time
  const WILD_CYCLE_ROOM = 45;     // 90 s base, -6 s per transformed kill: rooms feed it
  const WILD_CYCLE_BOSS = 90;     // no adds in the boss chamber — no refunds at all
  const DASH_USE = 0.35;          // fraction of traversal dash casts actually taken
  const CRIT_MUL_GAME = 1.85;     // game.js:218 — the ONE crit multiplier the
                                  // combat funnel applies (derived.critDmg is
                                  // panel-side; CERTAINTY/TEMPO are the only
                                  // combat-side scalers, per _damageEnemy)
  const TEMPO_MEAN = 2.5;         // WINDSTEP T3 mean stacks mid-fight (of 5)
  const SUNDER_UPTIME = 0.66;     // BREAKER T2+ finisher keeps the mark up

  const S_GATE = GATES.find((g) => g.rank === 'S');
  const PACK = ['grunt', 'grunt', 'grunt', 'stalker', 'stalker', 'brute', 'brute', 'caster', 'caster'];
  const packHp = PACK.map((t) => scaleEnemy(ENEMY_TYPES[t], S_GATE.enemyLevel).hp * DURABLE_MUL);
  // THE RIFT ARCHON at the yardstick save's level, game.js's own scaling.
  const bossHp = Math.floor(BOSSES.archon.hp * (1 + (70 - S_GATE.reqLevel) * 0.04));

  const critF = (d, path) => 1 + d.crit * (CRIT_MUL_GAME * (path === 'storm' ? 1 + TEMPO_MEAN * 0.06 : 1) - 1);
  const floorF = (d) => (d.dmgFloor + 1) / 2;    // mean of a [floor, 1] roll
  const swings = (d) => SWING_BASE * (1 + d.atkSpeed);
  const sunderF = (path) => (path === 'flame' || path === 'beast') ? 1 + 0.18 * SUNDER_UPTIME : 1;
  const hitDmg = (d, path) => d.atk * critF(d, path) * floorF(d) * sunderF(path);

  // A promoted level-70 field of 12 (grade mix inside every maxCount):
  // 1 ASHEN FIRST, 3 WARLORD, 5 CHAMPION, 3 VANGUARD.
  const ARMY_MULS = [4.0, 2.5, 2.5, 2.5, 1.8, 1.8, 1.8, 1.8, 1.8, 1.35, 1.35, 1.35];
  const soldierUnit = shadowCombat(BUILDS.shadow, { type: 'grunt', grade: 2, level: 60 }).atk; // SOLDIER = mul 1.00
  // The class layer's shadow term, as the RUNTIME applies it (fixup 1):
  // game.js _shadowStrike multiplies s.atk by _classShadowMul — the post-
  // class factor over the INT part shadowCombat already holds — which is
  // exactly this ratio. The SOVEREIGN'S WILL browser section asserts the
  // seam against a live binder save, so this line prices a real mechanic,
  // not a wish.
  const armyClassMul = D.shadow.shadowDmgMul / (1 + (250 + 69) * STAT_RATES.int.shadowDmg);
  const armyHit = soldierUnit * armyClassMul * (ARMY_MULS.reduce((a, b) => a + b, 0) / ARMY_MULS.length);
  const pactHit = shadowCombat(BUILDS.beast, { type: 'brute', grade: ARCHON_PATHS.beast.pact.grade, level: 60 }).atk
    * ARCHON_PATHS.beast.pact.mul;

  // ---- ROOM: 60 s of steady wave pressure, USEFUL damage only -------------
  // (overkill is wasted — "measured from room entry to room clear" counts
  // corpses, not numbers; a slot that dies refills at full stacks-zero).
  const roomSim = (path) => {
    const d = D[path];
    const AP = ARCHON_PATHS;
    const slots = PACK.map((t, i) => ({ hp: packHp[i], max: packHp[i], stacks: 0, frozenT: 0 }));
    let useful = 0;
    let mech = 0;
    let t = 0;
    let hitAcc = 0;
    let ember = 0;
    let ashT = 0;
    let charge = 200;             // the bar walks in full — travel banked it
    let wildT = 0;
    let wildCd = 0;
    let soldierAcc = 0;
    let pactAcc = 0;
    const rageF = path === 'flame' ? 1 + FLAGS.flame.rageAtkPerMissingHpPct * RAGE_ROOM : 1;
    const respawn = (i) => { slots[i] = { hp: packHp[i], max: packHp[i], stacks: 0, frozenT: 0 }; };
    const hurt = (i, amount, isMech) => {
      const e = slots[i];
      if (e.hp <= 0) return;
      const a = e.frozenT > 0 ? amount * (1 + AP.frost.freeze.bonusTakenPct) : amount;
      useful += Math.min(a, e.hp);
      if (isMech) mech += Math.min(a, e.hp);
      e.hp -= a;
      if (e.hp <= 0) respawn(i);
    };
    const combust = (i0) => {
      const q = [i0];
      for (let qi = 0; qi < q.length && qi < AP.flame.combustion.chainCap; qi++) {
        const e = slots[q[qi]];
        if (!e || e.stacks < AP.flame.combustion.atStacks) continue;
        ember += e.stacks * ARCHONS.flame.resourceRules.gainPer;
        e.stacks = 0;
        let n = 0;
        for (let j = 0; j < slots.length && n < N4; j++) {
          if (j === q[qi] || slots[j].hp <= 0) continue;
          n++;
          const tgt = slots[j];
          hurt(j, D.flame.atk * AP.flame.combustion.atkPct * rageF * critF(D.flame, 'flame') * sunderF('flame'), true);
          if (slots[j] === tgt && tgt.hp > 0) {
            tgt.stacks += AP.flame.combustion.reseed;
            if (tgt.stacks >= AP.flame.combustion.atStacks) q.push(j);
          }
        }
      }
    };
    const shatter = (i, h) => {
      const e = slots[i];
      e.frozenT = 0;
      e.stacks = 0;
      const recips = [];
      for (let j = 0; j < slots.length && recips.length < N6; j++) {
        if (j !== i && slots[j].hp > 0) recips.push(j);
      }
      if (!recips.length) return;
      const share = (h * AP.frost.shatter.splitPct) / recips.length; // a SPLIT, never 300% each
      for (const j of recips) {
        const tgt = slots[j];
        const wasFrozen = tgt.frozenT > 0;
        const overLine = share >= tgt.max * AP.frost.shatter.hitFracOfMaxHp;
        hurt(j, share, true);
        if (slots[j] !== tgt || tgt.hp <= 0) continue;
        if (wasFrozen && overLine) { shatter(j, share); continue; }
        if (tgt.frozenT <= 0) {
          tgt.stacks += AP.frost.shatter.reseed;
          if (tgt.stacks >= AP.frost.freeze.atStacks) { tgt.frozenT = AP.frost.freeze.seconds; tgt.stacks = 0; }
        }
      }
    };
    while (t < SIM) {
      t += DT;
      if (path === 'beast') {
        if (wildT > 0) wildT -= DT; else wildCd -= DT;
        if (wildCd <= 0 && wildT <= 0) { wildT = ARCHON_PATHS.beast.wildForm.seconds; wildCd = WILD_CYCLE_ROOM; }
      }
      hitAcc += swings(d) * UPTIME_ROOM * DT;
      while (hitAcc >= 1) {
        hitAcc -= 1;
        let h = hitDmg(d, path) * rageF;
        if (path === 'beast' && wildT > 0) h *= AP.beast.wildForm.atkMul;
        let struck = 0;
        for (let j = 0; j < slots.length && struck < CLEAVE[path]; j++) {
          const e = slots[j];
          if (e.hp <= 0) continue;
          struck++;
          const preFrozen = e.frozenT > 0;
          hurt(j, h, false);
          if (slots[j] !== e) continue;           // died and refilled
          if (path === 'flame' && e.hp > 0) {
            e.stacks++;
            if (e.stacks >= AP.flame.combustion.atStacks) combust(j);
          }
          if (path === 'frost' && e.hp > 0) {
            if (preFrozen && h >= e.max * AP.frost.shatter.hitFracOfMaxHp) shatter(j, h);
            else if (e.frozenT <= 0) {
              e.stacks++;
              if (e.stacks >= AP.frost.freeze.atStacks) { e.frozenT = AP.frost.freeze.seconds; e.stacks = 0; }
            }
          }
          if (path === 'storm' && struck === 1 && charge >= AP.storm.arc.discharge) {
            charge -= AP.storm.arc.discharge;
            let chains = 0;
            for (let c = 0; c < slots.length && chains < AP.storm.arc.chains; c++) {
              if (c === j || slots[c].hp <= 0) continue;
              chains++;
              hurt(c, d.atk * AP.storm.arc.atkPct * critF(d, 'storm'), true);
            }
          }
        }
      }
      if (path === 'flame') {
        for (let i = 0; i < slots.length; i++) {
          const e = slots[i];
          if (e.hp > 0 && e.stacks > 0) hurt(i, D.flame.atk * AP.flame.pyre.dotFracPerStackPerSecond * e.stacks * DT, true);
        }
        if (ashT > 0) {
          ashT -= DT;
          for (let i = 0; i < slots.length; i++) {
            const e = slots[i];
            if (e.hp <= 0) continue;
            hurt(i, D.flame.atk * AP.flame.ashfall.atkFracPerSecond * DT, true);
            if (slots[i] === e && e.hp > 0) {
              e.stacks += AP.flame.ashfall.stacksPerSecond * DT;
              if (e.stacks >= AP.flame.combustion.atStacks) combust(i);
            }
          }
        } else if (ember >= ARCHONS.flame.resourceRules.ultimateCost) {
          ember -= ARCHONS.flame.resourceRules.ultimateCost;
          ashT = AP.flame.ashfall.seconds;
        }
      }
      if (path === 'frost') {
        for (const e of slots) if (e.frozenT > 0) e.frozenT -= DT;
        const fi = slots.findIndex((e) => e.hp > 0 && e.frozenT > 0.5);
        if (fi >= 0) {                            // the free tap: detonate a freeze
          const e = slots[fi];
          const h = e.max * AP.frost.detonate.hitFracOfMaxHp * critF(D.frost, 'frost');
          hurt(fi, h, true);
          if (slots[fi] === e && e.hp > 0) shatter(fi, h);
          else if (slots[fi] === e) { e.frozenT = 0; e.stacks = 0; }
        }
      }
      if (path === 'storm') charge += d.speed * KITE.storm * DT; // +1/metre
      if (path === 'shadow') {
        soldierAcc += (12 / SOLDIER_CYCLE) * ARMY_ENGAGE_ROOM * DT;
        while (soldierAcc >= 1) {
          soldierAcc -= 1;
          const i = slots.findIndex((e) => e.hp > 0);
          if (i < 0) break;
          hurt(i, armyHit * critF(D.shadow, 'shadow'), true); // army crits roll at the OWNER's derived.crit (game funnel)
        }
      }
      if (path === 'beast') {
        pactAcc += (1 / SOLDIER_CYCLE) * PACT_ENGAGE_ROOM * DT;
        while (pactAcc >= 1) {
          pactAcc -= 1;
          const i = slots.findIndex((e) => e.hp > 0);
          if (i < 0) break;
          hurt(i, pactHit * critF(D.beast, 'beast'), true);
        }
      }
    }
    return { dps: useful / SIM, mechShare: mech / Math.max(1, useful) };
  };

  // ---- BOSS: sustained single-target output, HP-unbounded -----------------
  // (a 60 s window against a target the %-terms price off bossHp; overkill
  // is a room concept).
  const bossSim = (path) => {
    const d = D[path];
    const AP = ARCHON_PATHS;
    const up = UPTIME_BOSS[path];
    let dmg = 0;
    let mech = 0;
    let t = 0;
    let hitAcc = 0;
    let stacks = 0;
    let frozenT = 0;
    let ember = 0;
    let ashT = 0;
    let charge = 200;
    let tempestT = 0;
    let wildT = 0;
    let wildCd = 0;
    let soldierAcc = 0;
    let pactAcc = 0;
    const rageF = path === 'flame' ? 1 + FLAGS.flame.rageAtkPerMissingHpPct * RAGE_BOSS : 1;
    const hurt = (a, isMech) => {
      const x = frozenT > 0 ? a * (1 + AP.frost.freeze.bonusTakenPct) : a;
      dmg += x;
      if (isMech) mech += x;
    };
    while (t < SIM) {
      t += DT;
      if (path === 'beast') {
        if (wildT > 0) wildT -= DT; else wildCd -= DT;
        if (wildCd <= 0 && wildT <= 0) { wildT = AP.beast.wildForm.seconds; wildCd = WILD_CYCLE_BOSS; }
      }
      if (tempestT > 0) tempestT -= DT;
      const rateMul = (path === 'storm' && tempestT > 0) ? 2 : 1; // cooldown-free swings
      hitAcc += swings(d) * up * rateMul * DT;
      while (hitAcc >= 1) {
        hitAcc -= 1;
        let h = hitDmg(d, path) * rageF;
        if (path === 'beast' && wildT > 0) h *= AP.beast.wildForm.atkMul;
        if (path === 'storm' && tempestT > 0) mech += h; // the doubled half is the mechanic's
        hurt(h, false);
        if (path === 'flame') {
          stacks++;
          if (stacks >= AP.flame.combustion.atStacks) { ember += stacks * ARCHONS.flame.resourceRules.gainPer; stacks = 0; } // self-blast excluded: the blast hits nobody
        }
        if (path === 'frost' && frozenT <= 0) {
          stacks++;
          if (stacks >= AP.frost.freeze.atStacks) { frozenT = AP.frost.freeze.seconds; stacks = 0; }
        }
        if (path === 'storm' && tempestT <= 0 && charge >= AP.storm.arc.discharge) {
          charge -= AP.storm.arc.discharge;       // spent on connection; chains find nobody
        }
      }
      if (path === 'flame') {
        if (stacks > 0) hurt(D.flame.atk * AP.flame.pyre.dotFracPerStackPerSecond * stacks * DT, true);
        if (ashT > 0) { ashT -= DT; hurt(D.flame.atk * AP.flame.ashfall.atkFracPerSecond * DT, true); }
        else if (ember >= ARCHONS.flame.resourceRules.ultimateCost) {
          ember -= ARCHONS.flame.resourceRules.ultimateCost;
          ashT = AP.flame.ashfall.seconds;
        }
      }
      if (path === 'frost' && frozenT > 0) {
        frozenT -= DT;
        if (frozenT > 0.5) {                      // one detonate per freeze window
          hurt(bossHp * AP.frost.detonate.hitFracOfMaxHp * critF(D.frost, 'frost'), true);
          frozenT = 0;
        }
      }
      if (path === 'storm') {
        if (tempestT <= 0) charge += d.speed * KITE.storm * DT;
        if (charge >= ARCHONS.storm.resourceRules.ultimateCost && tempestT <= 0) {
          charge = 0;
          tempestT = AP.storm.tempest.seconds;
          hurt(3 * d.atk * AP.storm.tempest.boltAtkPct, true); // three dash lines through the boss
        }
      }
      if (path === 'shadow') {
        soldierAcc += (12 / SOLDIER_CYCLE) * ARMY_ENGAGE_BOSS * DT;
        while (soldierAcc >= 1) { soldierAcc -= 1; hurt(armyHit * critF(D.shadow, 'shadow'), true); }
      }
      if (path === 'beast') {
        pactAcc += (1 / SOLDIER_CYCLE) * PACT_ENGAGE_BOSS * DT;
        while (pactAcc >= 1) { pactAcc -= 1; hurt(pactHit * critF(D.beast, 'beast'), true); }
      }
    }
    return { dps: dmg / SIM, mechShare: mech / Math.max(1, dmg) };
  };

  // ---- eHP: the spec's own definition, closed form ------------------------
  // maxHp / (1 - dr), plus shields and delayed-damage terms, plus the
  // fraction of incoming damage the path's allies absorb — and DENIAL, the
  // damage never dealt, which the spec names as "real power that the eHP
  // axis is there to score".
  const eHPOf = (path) => {
    const d = D[path];
    let v = d.maxHp / (1 - d.dr);
    if (path === 'frost') {
      v += d.maxHp * (ARCHONS.frost.resourceRules.max / 100);       // Glacial Barrier at cap
      v /= (1 - ARCHON_PATHS.frost.rime.maxSlow * 0.8);             // -60% enemy tempo at ~80% coverage
      v *= 1.05;                                                    // Vanguard's kill-cancelled 25% bleed-defer
    }
    if (path === 'shadow') v /= (1 - 0.35);                         // twelve bodies soak a third of the room
    if (path === 'beast') {
      const wf = ARCHON_PATHS.beast.wildForm;
      const upW = wf.seconds / WILD_CYCLE_ROOM;
      const drW = 1 - (1 - d.dr) * (1 - wf.flatDr);                 // the 40% flat DR stacks after vit's
      v = (1 - upW) * v + upW * d.maxHp / (1 - drW);
      v /= (1 - 0.20);                                              // the pact holds a fifth of the pressure
    }
    if (path === 'storm') v /= (1 - 0.15);                          // 310 ms windows + a 0.91 s dash: some hits never land
    return v;
  };

  // ---- mobility: mean crawl speed with dash flow --------------------------
  const mobilityOf = (path) => {
    const d = D[path];
    const dashDist = d.dashDistance !== undefined ? d.dashDistance : SKILLS.dash.distance;
    const dashCd = d.dashCd !== undefined ? d.dashCd : SKILLS.dash.cd;
    let v = d.speed + (dashDist / dashCd) * DASH_USE;
    if (path === 'storm') {
      const T = ARCHON_PATHS.storm.tempest;
      const fill = ARCHONS.storm.resourceRules.ultimateCost / d.speed; // +1/metre at full crawl
      const cycle = fill + T.seconds;
      const tSpeed = Math.min(T.hardSpeedCap, d.speed * (1 + T.speedBonus)); // THE 14 u/s ceiling holds here too
      const tDash = tSpeed + (dashDist / 0.5) * DASH_USE;           // dash cd zero inside the window
      v = (v * fill + tDash * T.seconds) / cycle;
    }
    if (path === 'beast') v *= 1 + FLAGS.beast.killStackSpeedPct;   // one lingering kill stack between rooms
    return v;
  };

  // ---- evaluate, score, assert the band -----------------------------------
  const AXES = ['roomDps', 'bossDps', 'eHP', 'mobility'];
  // Frozen per-axis compression (see the header): DPS and eHP axes saturate
  // hard in play; mobility is nearly linear time and gets amplified toward
  // the table's stated 0.80-1.60 spread.
  const GAMMA = { roomDps: 0.22, bossDps: 0.35, eHP: 0.22, mobility: 1.70 };
  // Frozen anchor: the roster midrange at STEP 11 calibration. Composites
  // are measured against it so the assert reads "within 0.06 of 1.00".
  const ANCHOR = 0.9929;

  const raw = {};
  for (const k of Object.keys(BUILDS)) {
    const r = roomSim(k);
    const b = bossSim(k);
    raw[k] = {
      roomDps: r.dps, bossDps: b.dps, eHP: eHPOf(k), mobility: mobilityOf(k),
      roomMech: r.mechShare, bossMech: b.mechShare,
    };
  }
  const geo = {};
  for (const a of AXES) {
    geo[a] = Math.exp(Object.keys(raw).reduce((s, k) => s + Math.log(raw[k][a]), 0) / 5);
  }
  const model = {};
  for (const k of Object.keys(raw)) {
    const scores = {};
    for (const a of AXES) scores[a] = Math.pow(raw[k][a] / geo[a], GAMMA[a]);
    const composite = AXES.reduce((s, a) => s + PARITY_WEIGHTS[a] * scores[a], 0) / ANCHOR;
    model[k] = { ...scores, composite };
    console.log(`  ${k.padEnd(6)} room ${raw[k].roomDps.toFixed(0).padStart(5)} boss ${raw[k].bossDps.toFixed(0).padStart(5)}`
      + ` eHP ${raw[k].eHP.toFixed(0).padStart(5)} mob ${raw[k].mobility.toFixed(1).padStart(5)}`
      + `  -> composite ${composite.toFixed(4)}`);
  }
  for (const k of Object.keys(model)) {
    ok(near(model[k].composite, 1.0, 0.06),
      `${k}'s EVALUATED composite lands within 0.06 of 1.00 — the owner's hard requirement, measured`,
      model[k].composite.toFixed(4));
  }

  // ---- ...and by DIFFERENT routes -----------------------------------------
  const maxOf = (a) => Object.keys(raw).reduce((m, k) => (raw[k][a] > raw[m][a] ? k : m));
  const minOf = (a) => Object.keys(raw).reduce((m, k) => (raw[k][a] < raw[m][a] ? k : m));
  ok(maxOf('roomDps') === 'flame', 'FLAME owns the room row (spread pressure + the burn)', maxOf('roomDps'));
  ok(maxOf('bossDps') === 'beast', 'BEAST owns the boss row (concentration: pact + Wild Form)', maxOf('bossDps'));
  ok(maxOf('eHP') === 'frost', 'FROST owns the eHP row (Barrier + denial)', maxOf('eHP'));
  ok(maxOf('mobility') === 'storm', 'STORM owns the mobility row (Tempest under the 14 u/s ceiling)', maxOf('mobility'));
  ok(minOf('eHP') === 'storm', 'and STORM pays for it with the roster\'s thinnest eHP', minOf('eHP'));
  ok(minOf('mobility') === 'frost', 'while FROST pays for the wall in boots (mobility floor)', minOf('mobility'));
  const roomSorted = Object.keys(raw).sort((a, b) => raw[a].roomDps - raw[b].roomDps).slice(0, 2).sort();
  ok(roomSorted.join('+') === 'beast+frost',
    'the two slow room-clears are BEAST and FROST — one ally / demanding setup, as priced', roomSorted.join('+'));
  // Route dominance: the mechanism, not the stat sheet, carries each path.
  ok(raw.shadow.roomMech > 0.55 && raw.shadow.bossMech > 0.55,
    'SHADOW reaches its numbers through the ARMY (soldiers deal the majority on both axes)',
    `${raw.shadow.roomMech.toFixed(2)} / ${raw.shadow.bossMech.toFixed(2)}`);
  ok(raw.storm.roomMech > 0.40,
    'STORM reaches its room number through ARC (chains carry >40% at the tuned 4-discharge economy)',
    raw.storm.roomMech.toFixed(2));
  ok(raw.frost.bossMech > 0.50,
    'FROST reaches its boss number through FREEZE WINDOWS (the +45% and the detonate carry the majority)',
    raw.frost.bossMech.toFixed(2));
  ok(raw.beast.bossMech > 0.18,
    'BEAST\'s pact carries a real share of its boss lead on top of Wild Form',
    raw.beast.bossMech.toFixed(2));
  ok(raw.flame.roomMech > 0,
    'FLAME\'s burn participates in the room (at yardstick power the pack dies too fast for the full cascade — '
    + 'the immortal-room section above is where superlinearity is proven)',
    raw.flame.roomMech.toFixed(3));
}

// ---------------------------------------------------------------- hygiene
section('SOURCE HYGIENE  (no wall clock, no Math.random, no borrowed nouns)');
{
  const src = readFileSync(new URL('../src/game/classes.js', import.meta.url), 'utf8');
  ok(!/Math\.random/.test(src), 'classes.js never calls Math.random');
  ok(!/Date\.now/.test(src), 'classes.js never reads the wall clock');
  ok(!/monarch/i.test(src), 'no "monarch" in classes.js');
  ok(!/\barise\b/i.test(src), 'no "arise" in classes.js');
  ok(!/from 'three'|from "three"/.test(src), 'classes.js is THREE-free');
  const saveSrc = readFileSync(new URL('../src/core/save.js', import.meta.url), 'utf8');
  ok(!/monarch/i.test(saveSrc) && !/\barise\b/i.test(saveSrc), 'no borrowed nouns in save.js');
  ok(!/from '..\/game\/classes|from "..\/game\/classes/.test(saveSrc),
    'save.js does not import classes.js (the allowlist is a deliberate duplicate)');
}

// -------------------------------------------------- flags have consumers
// FIXUP 1's tripwire, kept forever: round-1 verification proved every
// flags/flagsScaled term inert by grepping src/ — two classes shipped with
// drawbacks only. Each card term below must keep a runtime seam; the strings
// are the distinctive consumption forms, so an armour-layer twin (extractAdd,
// fieldAdd) cannot satisfy the check by accident. The SOVEREIGN'S WILL
// section additionally asserts the shadow seam FUNCTIONALLY (a binder-classed
// legion detonation lands the class factor).
section('CLASS FLAGS ARE CONSUMED  (every card term has a runtime seam — the round-1 grep, kept)');
{
  const gameSrc = readFileSync(new URL('../src/game/game.js', import.meta.url), 'utf8');
  const progSrc = readFileSync(new URL('../src/game/progression.js', import.meta.url), 'utf8');
  const seams = [
    ['rageAtkPerMissingHpPct', 'BERSERKER rage rate'],
    ['rageMaxAtkBonus', 'BERSERKER rage cap'],
    ['healingTakenPct', 'BERSERKER healing tax'],
    ['basicAtkPct', 'HEXWEAVER basic-attack cut'],
    ['windupDmgPct', 'ORACLE windup bonus'],
    ['spellLeechPct', 'TEMPLAR spell leech'],
    ['cooldownPct', 'TEMPLAR cooldown tax'],
    ['leechPct', 'REAVER life leech'],
    ['killStackMax', 'REAVER stack cap'],
    ['killStackSeconds', 'REAVER stack window'],
    ['killStackSpeedPct', 'REAVER speed per stack'],
    ['killStackAtkSpeedPct', 'REAVER attack speed per stack'],
    ['bleedFrac', 'VANGUARD deferral fraction'],
    ['bleedSeconds', 'VANGUARD deferral window'],
    ['bleedCancelOnKill', 'VANGUARD kill-cancel'],
    ['skillCostPct', 'mana surcharge rate'],
    ['skillCostSkills', 'mana surcharge list'],
    ['_classFlags?.fieldAdd', 'BINDER field +2 (class seam, not the armour twin)'],
    ['_classFlags?.extractAdd', 'BINDER extraction add (class seam, not the trinket)'],
    ['_classShadowMul', 'BINDER shadow-damage strike factor'],
    ['derived.dashDistance', 'VANGUARD dash-distance cut at the dash'],
    ['derived.dashIframes', 'BLADEDANCER i-frame raise at the dash'],
  ];
  for (const [needle, label] of seams) {
    ok(gameSrc.includes(needle), `game.js consumes ${label} (${needle})`);
  }
  ok(progSrc.includes('rosterPct'),
    "progression.js prices BINDER's roster +25% inside the one capacity read");
  ok(gameSrc.includes('_healPlayer'),
    'incidental heals route through the one healing seam the tax prices');
}

// =========================================================================
// WAVE F.3 — BAND UNLOCKS (THE DEAD ZONE FILLS). The audit line this wave
// answers: "no new abilities are earned between level 12 (Bind) and 55
// (archon)". Three class-flavoured riders at 18/30/42, data in classes.js,
// resolved at the existing dash/nova/Bind sites. Node-testable exactly like
// the roster; the runtime seams get the CLASS-FLAGS-style source tripwire
// (round 1's lesson: a term without a greppable consumer ships inert).
// =========================================================================
section('BAND DATA  (three tables x eight classes; thresholds inside the dead zone)');
{
  ok(BAND_LEVELS.technique === 18 && BAND_LEVELS.attunement === 30 && BAND_LEVELS.oathwork === 42,
    'the bands land at 18 / 30 / 42', JSON.stringify(BAND_LEVELS));
  const lvls = Object.values(BAND_LEVELS);
  ok(lvls.every((l) => l > 12 && l < 55),
    'every band sits strictly inside the 12-55 dead zone the audit named');
  // One thumb, one timing: the dash and oath holds use the SAME threshold the
  // archon slot taught. Asserted against the shipped constant, not a copy.
  ok(BAND_HOLD_SECONDS === ARCHONS.shadow.sovereignsWill.bindHoldSeconds,
    'the band hold threshold IS the archon slot\'s 0.35 s', String(BAND_HOLD_SECONDS));
  ok(OATH_SECONDS === 20 && OATH_COOLDOWN === 60, 'the oath stance is 20 s on a 60 s clock');
  const classKeys = Object.keys(CLASSES);
  for (const [label, table] of [
    ['BAND_TECHNIQUES', BAND_TECHNIQUES], ['BAND_ATTUNEMENTS', BAND_ATTUNEMENTS], ['BAND_OATHS', BAND_OATHS],
  ]) {
    ok(classKeys.every((k) => table[k] && typeof table[k].name === 'string' && table[k].params),
      `${label} carries a named rider with params for all eight classes`);
  }
  ok(classKeys.every((k) => typeof BAND_COLORS[k] === 'number'),
    'every class has a band accent colour');
  // All 24 rider names are distinct, and none collides with a mastery or a
  // class name — the panel and the toasts must never show the same word for
  // two different things.
  const riderNames = [BAND_TECHNIQUES, BAND_ATTUNEMENTS, BAND_OATHS]
    .flatMap((tb) => Object.values(tb).map((r) => r.name));
  const reserved = new Set([
    ...Object.values(DIRECTIONS).flatMap((d) => d.masteries.map((m) => m.name)),
    ...CLASS_LIST.map((c) => c.name),
  ]);
  ok(new Set(riderNames).size === 24, 'all 24 rider names are distinct', String(new Set(riderNames).size));
  ok(riderNames.every((n) => !reserved.has(n)), 'no rider name collides with a mastery or class name');
  // THE BALANCE LAW: riders are tempo/positioning/utility. Exactly two rows
  // carry a damage payload, both positional, both priced under sanctioned
  // ancestors: REAVER's line under Tempest's 0.9 bolt, BERSERKER's echo
  // under Nova's own 0.45 falloff span (echo + fringe <= one point-blank).
  const dmgRows = [];
  for (const tb of [BAND_TECHNIQUES, BAND_ATTUNEMENTS, BAND_OATHS]) {
    for (const [k, row] of Object.entries(tb)) {
      if (row.params.lineAtkPct || row.params.echoFrac) dmgRows.push(`${k}.${row.key}`);
    }
  }
  ok(dmgRows.length === 2 && dmgRows.includes('reaver.reavingline') && dmgRows.includes('berserker.echo'),
    'exactly two damage payloads exist in the band tables (the two sanctioned positional ones)',
    JSON.stringify(dmgRows));
  ok(BAND_TECHNIQUES.reaver.params.lineAtkPct <= 0.9,
    'REAVER\'s line sits under the Tempest bolt ceiling (0.9)');
  ok(BAND_ATTUNEMENTS.berserker.params.echoFrac <= 0.45,
    'BERSERKER\'s echo sits inside Nova\'s own falloff span (0.45)');
}

section('BANDS OF  (class-flavoured: unclassed reads all-null at any level; classed fills per threshold)');
{
  const s = freshSave();
  s.level = 70;
  const none = bandsOf(s);
  ok(none.technique === null && none.attunement === null && none.oathwork === null,
    'an UNCLASSED level-70 save reads all-null — the riders are the class\'s, not the level\'s');
  s.className = 'hexweaver';
  s.level = 17;
  const b17 = bandsOf(s);
  ok(b17.technique === null && b17.attunement === null && b17.oathwork === null,
    'a classed save under 18 reads all-null');
  s.level = 18;
  ok(bandsOf(s).technique === BAND_TECHNIQUES.hexweaver && bandsOf(s).attunement === null,
    'level 18 lights the technique only');
  s.level = 30;
  ok(bandsOf(s).attunement === BAND_ATTUNEMENTS.hexweaver && bandsOf(s).oathwork === null,
    'level 30 adds the attunement');
  s.level = 42;
  const b42 = bandsOf(s);
  ok(b42.technique === BAND_TECHNIQUES.hexweaver && b42.attunement === BAND_ATTUNEMENTS.hexweaver
    && b42.oathwork === BAND_OATHS.hexweaver,
    'level 42 completes all three riders');
  // INTERLOCK: the band layer is behaviour-only. The derived block of a
  // banded save is IDENTICAL to the same save's block before the wave —
  // bandsOf feeds game.js hooks and never enters classModifiers/applyLayers,
  // which is what keeps the parity model's pricing untouched.
  const mods = classModifiers(s);
  const flagKeys = Object.keys(mods.flags);
  ok(!flagKeys.some((k) => /band|oath|technique|attunement/i.test(k)),
    'classModifiers carries NO band terms — the parity model never sees the riders');
}

section('BAND SEAMS ARE CONSUMED  (the CLASS-FLAGS tripwire, extended: every rider has a runtime home)');
{
  const gameSrc = readFileSync(new URL('../src/game/game.js', import.meta.url), 'utf8');
  const uiSrc = readFileSync(new URL('../src/ui/ui.js', import.meta.url), 'utf8');
  const stringsSrc = readFileSync(new URL('../src/game/strings.js', import.meta.url), 'utf8');
  const seams = [
    ['_bands = bandsOf', 'the cache at the single computation site'],
    ['_tryDash(true)', 'the hold-dash fires the signature step'],
    ['_dashHoldT', 'the dash-slot hold timer'],
    ['_tryOath', 'the oath stance verb'],
    ['_oathHoldT', 'the Bind-slot oath hold (unascended branch)'],
    ['BAND_HOLD_SECONDS', 'both holds read the shared threshold'],
    ['seekRange', 'BERSERKER close steers'],
    ['distanceMul', 'BERSERKER close reaches'],
    ['chainSeconds', 'BLADEDANCER afterstep window'],
    ['plowShove', 'VANGUARD plow shove'],
    ['lineAtkPct', 'REAVER line payload'],
    ['snareTouch', 'HEXWEAVER wisp snare'],
    ['dodgeWindowAdd', 'ORACLE window terms (step + oath)'],
    ['mpFrac', 'TEMPLAR litany step'],
    ['echoFrac', 'BERSERKER echo arm'],
    ['dashReset', 'BLADEDANCER quickening'],
    ['healShadowFrac', 'BINDER mending'],
    ['radiusPerStack', 'REAVER riding surge'],
    ['knockImmune', 'VANGUARD ironside oath'],
    ['atkSpeedPct', 'BERSERKER war tempo on the swing clock'],
    ['dashCdMul', 'BLADEDANCER veil oath'],
    ['skillCdTickMul', 'HEXWEAVER weave oath'],
    ['mpRegenMul', 'TEMPLAR litany oath'],
    ['killStackFreeze', 'REAVER hunger oath'],
    ['oathwork?.fieldAdd', 'BINDER legion oath (the earned-term seam)'],
    ['band.unlock.', 'the crossing ceremony toasts'],
    ['e.snareT', 'the snare rides the enemy action clock'],
    // Review extension: the first needle list left 13 consumed params
    // untripped — future inertness of any of these would not have failed.
    ['invulnAdd', 'ORACLE ruling i-frame term'],
    ['plowStagger', 'VANGUARD plow stumble'],
    ['plowHalfWidth', 'VANGUARD plow lane width'],
    ['halfWidth', 'REAVER line lane width'],
    ['snareMul', 'HEXWEAVER snare slow factor'],
    ['snareSeconds', 'HEXWEAVER wisp duration'],
    ['echoDelay', 'BERSERKER echo timing'],
    ['radiusMul', 'ORACLE widened nova'],
    ['staggerAdd', 'ORACLE nova stagger term'],
    ['healFrac', 'TEMPLAR consecrate heal'],
    ['rodeAfterstep', 'the afterstep consume-vs-rearm gate (review blocker fix)'],
  ];
  for (const [needle, label] of seams) {
    ok(gameSrc.includes(needle), `game.js consumes ${label} (${needle})`);
  }
  ok(uiSrc.includes('band.row.') && uiSrc.includes('bandsOf'),
    'ui.js lists the band rows on the levelup panel');
  for (const key of ['band.unlock.technique', 'band.unlock.attunement', 'band.unlock.oathwork',
    'band.oath.begin', 'band.oath.notReady', 'band.row.technique']) {
    ok(stringsSrc.includes(`'${key}'`), `strings.js carries ${key}`);
  }
  // Precedence: the oath gesture lives on the UNASCENDED branch only — the
  // archon multiplexer's branch must not mention it, so at 55+ the archon
  // tag wins the slot exactly as the band contract states. Cheap structural
  // read: _tryOath is called exactly once in game.js.
  ok(gameSrc.split('this._tryOath()').length === 2,
    'the oath fires from exactly one site (the unascended Bind branch)');
}

// =========================================================================
// STEP 6 — THE ARCHON SUBSTRATE (headless). StatusTable / ResourceMeter /
// tintForStacks driven in bare node; ArchonPool needs a renderer and gets its
// own browser section below. This module is the parity guarantee — FLAME,
// FROST and STORM will be configurations of exactly these classes — so the
// expiry rule, the decay rule and the clamps are pinned here before any path
// exists to depend on them.
// =========================================================================
section('ARCHON SUBSTRATE  (headless: stack expiry, resource decay, the non-emissive tint)');
{
  const { StatusTable, ResourceMeter, tintForStacks } = await import('../src/game/archon.js');

  // --- StatusTable: per-target stacks, refresh-on-apply expiry ------------
  const t = new StatusTable({ pyre: { max: 10, expiry: 4 }, rime: { max: 10, expiry: 6 } });
  const a = {}; const b = {};
  ok(t.apply(a, 'pyre') === 1, 'one apply is one stack');
  for (let i = 0; i < 20; i++) t.apply(a, 'pyre');
  ok(t.get(a, 'pyre') === 10, 'stacks clamp at the rule max (10)');
  ok(t.apply(a, 'pyre', 0) === 10 && t.get(b, 'pyre') === 0,
    'a zero apply polls without creating state');
  t.tick(3.9);
  ok(t.get(a, 'pyre') === 10, 'stacks hold inside the expiry window');
  t.apply(a, 'pyre');
  t.tick(3.9);
  ok(t.get(a, 'pyre') === 10,
    'an apply refreshes the kind clock (refresh-on-apply — pressure maintained by landing hits)');
  t.apply(b, 'rime', 3);   // fresh rime NOW: pyre has 0.1 s left, rime 6.0
  t.tick(0.2);
  ok(t.get(a, 'pyre') === 0, 'the clock running out drops every stack at once');
  ok(t.get(b, 'rime') === 3, 'other targets age on their own rules (rime expiry 6 still live)');
  t.clear(b);
  ok(t.get(b, 'rime') === 0 && t.size === 0, 'clear() empties the target and the table forgets it');
  t.apply(a, 'pyre', 5); t.apply(b, 'rime', 5);
  t.disposeAll();
  ok(t.size === 0, 'disposeAll drops every target — the leak tripwire the browser re-checks');
  ok(new StatusTable().apply({}, 'anything') === 1,
    'a bare table still works off the default rule — no config, no trap');

  // --- ResourceMeter: the five shipped rule sets --------------------------
  for (const k of ARCHON_KEYS) {
    ok(new ResourceMeter(archonResourceRules(k)).value === 0, `${k}: a fresh meter reads 0`);
  }
  const ember = new ResourceMeter(archonResourceRules('flame'));
  ember.gain(30);
  ok(ember.value === 60, 'EMBER: 30 consumed stacks x gainPer 2 bank 60', String(ember.value));
  ember.tick(2, true);
  ok(near(ember.value, 54, 1e-9), 'EMBER decays 3/s when the caller says out-of-combat');
  ember.tick(10, false);
  ok(near(ember.value, 54, 1e-9), 'and not at all in combat — the boolean is the call site\'s job');
  ok(!ember.ready, '54 banked cannot fire the 100-cost ultimate');
  ember.gain(30);
  ok(ember.value === 100 && ember.ready, 'the bank clamps at max and readies the ultimate');
  ok(ember.fireUltimate() === true && ember.value === 0, 'Ashfall spends the meter IN FULL');
  ok(ember.fireUltimate() === false, 'an empty meter refuses to fire');
  const charge = new ResourceMeter(archonResourceRules('storm'));
  charge.gain(400);
  ok(charge.value === 200, 'CHARGE: +1 per metre, clamped at 200');
  charge.tick(1, true);
  ok(near(charge.value, 192, 1e-9), 'CHARGE decays 8/s while the caller says stationary');
  const army = new ResourceMeter(archonResourceRules('shadow'));
  army.gain(50);
  ok(army.value === 0 && !army.ready,
    'SHADOW/BEAST: a max-0 meter is inert — the army/cooldown IS the resource, no bank to light');

  // --- tintForStacks: a colour and nothing but a colour -------------------
  const h0 = tintForStacks('pyre', 0).getHexString();
  const g5 = tintForStacks('pyre', 5).g;
  const g10 = tintForStacks('pyre', 10).g;
  ok(h0 === 'ffffff', 'zero stacks tint white — the multiplicative identity on material.color');
  ok(g10 < g5 && g5 < 1, 'the ramp moves monotonically toward the kind hue with stacks');
  ok(tintForStacks('pyre', 10).r > 0.99,
    'and never crushes the body dark — a tinted enemy stays readable as a character');
  ok(tintForStacks('pyre', 1) === tintForStacks('pyre', 2),
    'the returned Color is the module scratch (same object both calls) — zero per-call allocation');
  ok(tintForStacks('unknown-kind', 10).getHexString() === 'ffffff',
    'an unknown kind tints nothing');

  // --- source hygiene: the no-glow rule is checkable in the file itself ---
  // Comments stripped first: the file's own header EXPLAINS the no-emissive
  // rule, which is allowed; code touching one is not.
  const src = readFileSync(new URL('../src/game/archon.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[^]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/emissive/i.test(code), 'archon.js CODE never touches an emissive (grep, comments stripped)');
  ok(!/applyRim|GLOW_LAYER/.test(code) && !/from '[^']*\/(rim|glow)\.js'/.test(src),
    'archon.js never imports or references the rim/glow machinery');
  ok(!/Math\.random/.test(code), 'archon.js CODE never calls Math.random (its header names the ban)');
  ok(!/Date\.now/.test(code), 'archon.js never reads the wall clock');
  ok(!/monarch/i.test(src) && !/\barise\b/i.test(src), 'no borrowed nouns in archon.js');
}

// =========================================================================
// STEP 7 (node half) — the archonRnd fork registration. The sigil roll must
// ride its own seeded stream (a replayed gate seed pays the same sigil), and
// the constant must be the spec's 0x2545f491, registered in the same comment
// registry every other fork lives in.
// =========================================================================
section('ARCHON FORK  (0x2545f491: seeded sigil stream, registered, unique)');
{
  const gsrc = readFileSync(new URL('../src/game/game.js', import.meta.url), 'utf8');
  ok(gsrc.includes('mulberry32((this.seed ^ 0x2545f491) >>> 0)'),
    'game.js forks archonRnd off the gate seed with the spec\'s constant');
  const others = ['0x9e3779b9', '0x5bf03635', '0x85ebca6b', '0x27d4eb2f', '0x5f356495',
    '0x1f123bb5', '0x632be59b', '0xc2b2ae35', '0xcc9e2d51', '0xb5297a4d'];
  ok(!others.includes('0x2545f491'), 'the constant collides with no registered fork');
  ok(gsrc.includes('0xb5297a4d / 0x2545f491'),
    'and it is appended to the one fork registry comment (no second list)');
  ok(gsrc.includes("this._archonRnd && this._archonRnd() < 1 / 3"),
    'the sigil roll draws off the fork, never Math.random — one per three S clears, seeded');
}

// =========================================================================
// STEP 8 (node half) — SOVEREIGN'S WILL data, the field-capacity read and the
// ASHEN SECOND read. Both reads are PURE (classes.archonFieldBonus feeds
// progression.shadowFieldCapacity's fieldAdd term; shadows.gradeMaxCount is
// the one path-aware read of SHADOW_GRADES), so the numbers the browser
// section sees are asserted here first without a renderer.
// =========================================================================
section('SOVEREIGN\'S WILL DATA + FIELD CAPACITY + ASHEN SECOND  (node: the pure reads)');
{
  const SW = ARCHONS.shadow.sovereignsWill;
  ok(JSON.stringify(SW.stances) === JSON.stringify(['hold', 'hunt', 'focus']),
    'the three command states, in the spec\'s order', JSON.stringify(SW.stances));
  ok(SW.holdRing === 4 && SW.holdIntercept === 6 && SW.huntRange === 26,
    'HOLD leashes at 4 m, intercepts to 6, HUNT keeps the shipped 26 m scan');
  ok(SW.fieldBonus === 2, 'the path\'s field bonus is +2');
  ok(SW.legion.detonatePct === 0.6 && SW.legion.radius === 4
    && SW.legion.reformSeconds === 6 && SW.legion.reformHpPct === 0.5,
    'LEGION STEP: 60% own atk in 4 m, re-form over 6 s at 50% HP', JSON.stringify(SW.legion));
  ok(ARCHONS.shadow.resourceRules.ultimateCooldown === 45, 'on a 45 s cooldown');

  // --- archonFieldBonus: the archon layer's ONLY capacity term ------------
  const s = freshSave();
  ok(archonFieldBonus(s) === 0, 'an unascended save reads +0');
  s.archon = 'flame';
  ok(archonFieldBonus(s) === 0, 'every other path reads +0 — the term is SHADOW\'s alone');
  s.archon = 'shadow';
  ok(archonFieldBonus(s) === 2, 'the SHADOW ARCHON reads +2');

  // --- the +2 through progression's clamps, exactly as game.fieldCapacity
  //     composes it: shadowFieldCapacity(save, tier, armorAdd + archonAdd) --
  s.level = 32;
  s.autoStats = 0;
  s.stats.int = 80;            // earned = 2 + floor(32/8) + floor(80/40) = 8
  const tier12 = { maxFieldShadows: 12 };
  ok(shadowFieldCapacity(s, tier12, archonFieldBonus(s)) === 10,
    'mid-game: earned 8 + the path\'s 2 = 10 under a 12 tier');
  s.archon = null;
  ok(shadowFieldCapacity(s, tier12, archonFieldBonus(s)) === 8,
    'the same save unascended fields 8 — the delta is exactly the bonus');
  s.archon = 'shadow';
  ok(shadowFieldCapacity(s, { maxFieldShadows: 6 }, archonFieldBonus(s)) === 6,
    'a low quality tier still gets the final word — the +2 grants NOTHING there (the spec\'s low-tier-phone clause)');
  s.level = 80;
  s.stats.int = 200;           // earned = 2 + 10 + 5 + 2 = 19
  ok(shadowFieldCapacity(s, tier12, archonFieldBonus(s)) === 12,
    'and the hard 12 holds whatever the path adds');

  // --- ASHEN SECOND: the path-aware read of SHADOW_GRADES -----------------
  const SH = await import('../src/game/shadows.js');
  const top = SH.GRADES.length - 1;
  const a = freshSave();
  a.level = 60;
  a.ash = 10000;               // promoteCost at grade 5 is ~6,184 — affordable
  ok(SH.gradeMaxCount(a, top) === 1, 'ASHEN FIRST reads its table maxCount 1 for everyone');
  ok(SH.gradeMaxCount(a, top - 1) === 3, 'WARLORD reads 3');
  a.archon = 'shadow';
  ok(SH.gradeMaxCount(a, top) === 2, 'for the SHADOW ARCHON the top slot reads 2 — ASHEN SECOND');
  ok(SH.gradeMaxCount(a, top - 1) === 3, 'and ONLY the top slot: WARLORD still reads 3');
  a.archon = null;
  // Now through canPromote, the one consumer: an ASHEN FIRST already held.
  SH.addShadow(a, SH.makeShadow(a, { type: 'grunt', level: 40, grade: top }));
  const wl = SH.makeShadow(a, { type: 'grunt', level: 40, grade: top - 1 });
  SH.addShadow(a, wl);
  ok(SH.canPromote(a, wl) === false,
    'with one ASHEN FIRST held, an unascended save cannot raise a second');
  a.archon = 'shadow';
  ok(SH.canPromote(a, wl) === true,
    'the SHADOW ARCHON can — the second slot exists for this path only');
  SH.addShadow(a, SH.makeShadow(a, { type: 'grunt', level: 40, grade: top }));
  ok(SH.canPromote(a, wl) === false,
    'and no third: 2 is a slot count, not an exemption from slot counts');
}

// =========================================================================
// STEP 9 (node half) — FLAME + FROST as data, the DPS-model cases, and the
// heap-delta assert. The path numbers are archon.js ARCHON_PATHS (the
// substrate configured, exactly as STEP 6's header promised); the model
// cases recompute the spec's own worked-example arithmetic from those
// numbers, so the browser section below asserts the game against THIS model
// and never against itself.
// =========================================================================
section('FLAME + FROST DATA + DPS MODEL  (node: the spec\'s arithmetic from the shipped numbers)');
{
  const { ARCHON_PATHS, ResourceMeter, StatusTable } = await import('../src/game/archon.js');
  const FL = ARCHON_PATHS.flame;
  const FR = ARCHON_PATHS.frost;

  // --- the path numbers, pinned against the spec wording ------------------
  ok(FL.stacks.pyre.max === 10 && FL.pyre.dotFracPerStackPerSecond === 0.02,
    'PYRE: 1 stack per hit to 10, each a 2%-of-atk tick per second');
  ok(FL.combustion.atStacks === 10 && FL.combustion.atkPct === 2.2
    && FL.combustion.radius === 4 && FL.combustion.reseed === 4,
    'COMBUSTION: at 10 stacks, 220% atk in 4 m, 4 re-seeded on everything caught');
  ok(FL.ashfall.seconds === 8 && FL.ashfall.radius === 14
    && FL.ashfall.atkFracPerSecond === 0.45 && FL.ashfall.stacksPerSecond === 1,
    'ASHFALL: 8 s, 14 m, 45% atk/s, 1 stack/s');
  ok(FL.fx.maxInstances === 64 && FL.fx.kind === 'flame',
    'flame vfx budget: 64 quads, one pool (vfxBudget verbatim)');
  ok(FR.stacks.rime.max === 10 && FR.rime.slowPerStack === 0.06 && FR.rime.maxSlow === 0.60,
    'RIME: -6% move and attack speed per stack, to -60% at 10');
  ok(FR.freeze.atStacks === 10 && FR.freeze.seconds === 2.2 && FR.freeze.bonusTakenPct === 0.45,
    'FREEZE: the 10th stack, 2.2 s solid, +45% damage taken');
  ok(FR.shatter.hitFracOfMaxHp === 0.15 && FR.shatter.splitPct === 3.0
    && FR.shatter.radius === 6 && FR.shatter.reseed === 3,
    'SHATTER: a 15%-of-max-HP hit splits 300% of itself in 6 m, +3 Rime each');
  ok(FR.detonate.hitFracOfMaxHp > FR.shatter.hitFracOfMaxHp,
    'the manual detonate clears the shatter line by construction — the tap IS a shatter');
  ok(FR.fx.maxInstances === 48 && FR.fx.kind === 'frost',
    'frost vfx budget: 48 shards, one pool');
  // The meter numbers stay classes.js's alone (no duplicate source): flame
  // banks 2 Ember per consumed stack toward 100; frost banks 0.4 %-points
  // per applied stack toward the 35% cap, decaying 2/s out of combat.
  const fr = archonResourceRules('flame');
  const rr = archonResourceRules('frost');
  ok(fr.max === 100 && fr.gainPer === 2 && fr.decayPerSecond === 3 && fr.ultimateCost === 100,
    'EMBER rules read from classes.js: 100 / +2 per consumed stack / -3 out of combat / Ashfall spends all');
  ok(rr.max === 35 && rr.gainPer === 0.4 && rr.decayPerSecond === 2 && rr.ultimateCost === 0,
    'BARRIER rules read from classes.js: cap 35% / +0.4%-pt per stack / -2%-pt out of combat / detonate free');

  // --- ResourceMeter.set — the persistence seam --------------------------
  const m = new ResourceMeter(fr);
  ok(m.set(60) === 60 && m.value === 60, 'set() seeds a bank from the save');
  ok(m.set(1e9) === 100, 'and clamps to max — a hand-edited save cannot overfill');
  ok(m.set(-5) === 0 && m.set(NaN) === 0, 'and floors garbage at 0, sanitiser posture');

  // --- DPS-model cases: the worked examples' arithmetic -------------------
  // THE LONG BURN (flame, level 70): derive() atk 841. Each combustion is
  // 220% x 841 = 1,850.2; at ~2.7 hits/s a fresh target combusts every
  // 10 / 2.7 = 3.70 s (only true because the target restarts from ZERO —
  // the re-seed lands on its neighbours); Ashfall burns 45% x 841 = 378/s.
  const atkLB = 841.0;
  const combustion = atkLB * FL.combustion.atkPct;
  ok(near(combustion, 1850.2, 0.05),
    'THE LONG BURN: one combustion is 1,850 (220% x 841 — the worked example verbatim)', combustion.toFixed(1));
  ok(near(FL.combustion.atStacks / 2.7, 3.7, 0.005),
    'and the per-target cycle is 3.7 s at 2.7 hits/s (10 stacks from zero)');
  ok(near(atkLB * FL.ashfall.atkFracPerSecond, 378, 0.5),
    'Ashfall ticks 378/s over 14 m (45% x 841)');
  ok(near(atkLB * FL.pyre.dotFracPerStackPerSecond * 10, 168.2, 0.05),
    'a 10-stack target burns for 20% atk/s = 168/s before the blast even fires');
  // Boss case (nothing to cascade into): sustained single-target adds burn
  // ramp + a combustion per 10 hits. At 2.7 hits/s of `h` damage each, the
  // extra is 1850/3.7 = 500/s of blast... which the target NEVER receives
  // (self-blast excluded), so flame's boss add is the DoT alone — mean
  // ~5.5 stacks over the ramp -> 11% atk/s, exactly why bossDps sits at
  // 0.82, the roster's floor with shadow's 0.88 above it.
  ok(ARCHONS.flame.parity.bossDps < ARCHONS.shadow.parity.bossDps,
    'the model agrees with the table: flame is the roster\'s WORST boss row');
  ok(ARCHONS.flame.parity.roomDps === 1.30
    && ARCHONS.flame.parity.roomDps === Math.max(...Object.values(ARCHONS).map((p) => p.parity.roomDps)),
    'and its 1.30 room row is the roster\'s BEST — cascade superlinearity priced in');

  // THE STANDING WALL (frost, level 70): maxHp 4,944 after class terms; the
  // Barrier caps at 35% x 4,944 = 1,730; eHP = 4,944 / (1 - 0.5652) + 1,730
  // = 13,096 — the parity table's highest, which is the row the mechanic has
  // to justify.
  const hpSW = 4944;
  const cap = hpSW * (rr.max / 100);
  ok(near(cap, 1730, 0.6), 'THE STANDING WALL: Barrier caps at 1,730 (35% x 4,944)', cap.toFixed(0));
  const eHP = hpSW / (1 - 0.5652) + cap;
  // 4,944 / 0.4348 = 11,371.0; + 1,730.4 = 13,101 — the spec's printed
  // 13,096 carries ~5 of its own intermediate rounding, so the tolerance
  // covers the calculator drift, not the mechanic.
  ok(near(eHP, 13096, 10), 'eHP lands on the worked example\'s 13,096 (±10 print rounding)', eHP.toFixed(0));
  ok(ARCHONS.frost.parity.eHP === 1.20
    && ARCHONS.frost.parity.eHP === Math.max(...Object.values(ARCHONS).map((p) => p.parity.eHP)),
    'the table agrees: frost\'s 1.20 eHP row is the roster\'s best');
  // (BEAST's 0.82 is the roster's true floor — one ally, no cascade; frost
  // is the worst of the three STACKING paths.)
  ok(ARCHONS.frost.parity.roomDps < 1
    && Object.values(ARCHONS).every((p) => p === ARCHONS.frost || p === ARCHONS.beast
      || p.parity.roomDps > ARCHONS.frost.parity.roomDps),
    'and its room row sits below every path but BEAST\'s — control is paid for in clear speed');
  // Freeze windows: +45% taken for 2.2 s per 10 hits landed, plus a 300%
  // shatter split — the burst that lets 0.87-room frost post a 1.06 boss row
  // above shadow's 0.88.
  ok(ARCHONS.frost.parity.bossDps > ARCHONS.shadow.parity.bossDps,
    'freeze windows put frost\'s boss row above shadow\'s despite the worst room row');
  // Slow floor: 10 stacks x 6% = the spec's own -60%.
  ok(near(FR.rime.slowPerStack * FR.stacks.rime.max, FR.rime.maxSlow, 1e-9),
    'the slow floor IS the full load: 10 x 6% = 60%, no hidden headroom');

  // --- combustion cascade, modelled headless on the real StatusTable ------
  // The game's _combust queue semantics run here against immortal bodies:
  // links consume 10 and seed 4 on every other body in range.
  const table = new StatusTable({ pyre: FL.stacks.pyre });
  const runChain = (room, first) => {
    let ember = 0;
    let links = 0;
    const q = [first];
    let qi = 0;
    for (; qi < q.length && qi < FL.combustion.chainCap; qi++) {
      const t = q[qi];
      const consumed = table.get(t, 'pyre');
      if (consumed < FL.combustion.atStacks) continue;
      links++;
      ember += consumed * fr.gainPer;
      table.clear(t);
      for (const o of room) {
        if (o === t) continue;
        if (table.apply(o, 'pyre', FL.combustion.reseed) >= FL.combustion.atStacks) q.push(o);
      }
    }
    return { ember, links, capped: qi >= FL.combustion.chainCap };
  };
  // Two bodies: subcritical. Ten hits combust A; B is left seeded at exactly
  // 4 and the chain ends — one link, 20 Ember (+2 x 10 consumed).
  const A2 = {}; const B2 = {};
  for (let i = 0; i < 10; i++) table.apply(A2, 'pyre', 1);
  const duo = runChain([A2, B2], A2);
  ok(duo.links === 1 && duo.ember === 20,
    'two bodies are subcritical: one link, +20 Ember (2 per consumed stack)', JSON.stringify(duo));
  ok(table.get(B2, 'pyre') === 4 && table.get(A2, 'pyre') === 0,
    'the neighbour keeps exactly the 4-seed; the combusted body restarts from zero (the 3.7 s cycle)');
  table.disposeAll();
  // A packed 9-body room (gate.waveSize 9, everyone in every blast) that the
  // fight has already warmed to 6 stacks each — mid-room-brawl state: each
  // link then seeds 4 x 8 = 32 while consuming 10, SUPERCRITICAL and self-
  // sustaining among bodies the blasts cannot kill. That superlinearity is
  // the roomDps 1.30 row; live rooms terminate the chain by DYING (every
  // link deals 220% atk to everything it seeds), and the chainCap watchdog
  // is what bounds the immortal worst case game-side.
  const room9 = Array.from({ length: 9 }, () => ({}));
  for (const t of room9) table.apply(t, 'pyre', 6);
  for (let i = 0; i < 4; i++) table.apply(room9[0], 'pyre', 1);
  const packed = runChain(room9, room9[0]);
  ok(packed.links > 9 && packed.capped,
    'a warmed immortal room sustains the cascade past a full room\'s worth, into the watchdog',
    JSON.stringify(packed));
  ok(packed.ember === packed.links * 10 * fr.gainPer,
    'every link consumed a full clamped 10-stack load into Ember', String(packed.ember));
  table.disposeAll();
}

// =========================================================================
// STEP 10 (node half) — STORM + BEAST as data, the worked examples'
// arithmetic, the 14 u/s ceiling as ONE source, and the segment pool driven
// headless. Same contract as the flame/frost section above: the browser
// asserts the game against THIS model, never against itself.
// =========================================================================
section('STORM + BEAST DATA + DPS MODEL  (node: arc/tempest/pact/wild-form arithmetic)');
{
  const { ARCHON_PATHS, ArchonPool } = await import('../src/game/archon.js');
  const { shadowCombat } = await import('../src/game/shadows.js');
  const ST = ARCHON_PATHS.storm;
  const BE = ARCHON_PATHS.beast;

  // --- the path numbers, pinned against the spec wording ------------------
  // discharge 4 is the STEP 11 parity tune (was 10): at +1 Charge/metre and
  // the yardstick's ~2.2 hits/s, 10 sustained chains on only a third of hits
  // and the harness priced storm ~0.09 under the parity band. See archon.js.
  ok(ST.arc.discharge === 4 && ST.arc.chains === 4 && ST.arc.radius === 8 && ST.arc.atkPct === 0.55,
    'ARC: a landed hit discharges 4 Charge into up to 4 chains within 8 m at 55% atk each');
  ok(ST.tempest.seconds === 6 && ST.tempest.speedBonus === 0.55 && ST.tempest.boltAtkPct === 0.9,
    'TEMPEST STEP: 6 s, +55% speed, 90%-atk dash bolts');
  ok(ST.tempest.hardSpeedCap === 14,
    'the HARD ABSOLUTE speed ceiling is 14 u/s, carried as data (one source for the one clamp)');
  ok(ST.fx.kind === 'storm' && ST.fx.maxInstances === 40,
    'storm vfx budget: 40 thin box segments, one pool (vfxBudget verbatim)');
  ok(!ST.stacks && !BE.stacks,
    'neither path owns a StatusTable kind — storm discharges, beast banks a cooldown');
  ok(BE.pact.mul === 4.0 && BE.pact.grade === 5,
    'PACT: 4.0x a normal shadow\'s shadowCombat numbers, bound at WARLORD (grade 5)');
  ok(BE.pact.bands.E === 0 && BE.pact.bands.D === 0 && BE.pact.bands.C === 1
    && BE.pact.bands.B === 2 && BE.pact.bands.A === 3 && BE.pact.bands.S === 4,
    'five pact slots, one per gate rank band, E/D sharing the first (spec verbatim)');
  ok(BE.wildForm.seconds === 12 && BE.wildForm.atkMul === 2.2
    && BE.wildForm.speedMul === 1.5 && BE.wildForm.flatDr === 0.40,
    'WILD FORM: 12 s, 2.2x attack power, 1.5x speed, 40% flat DR');
  ok(!BE.fx, 'beast declares NO fx pool — zero new pools is its whole vfx budget');
  // The meter/cooldown rules stay classes.js's alone (no duplicate source).
  const sr = archonResourceRules('storm');
  const br = archonResourceRules('beast');
  ok(sr.max === 200 && sr.gainPer === 1 && sr.decayPerSecond === 8 && sr.ultimateCost === 200,
    'CHARGE rules read from classes.js: 200 / +1 per metre / -8 while stationary / Tempest spends all');
  ok(br.max === 0 && br.ultimateCooldown === 90 && br.cooldownPerKill === 6,
    'BEAST rules read from classes.js: no bank, 90 s Wild Form cooldown, -6 s per transformed kill');

  // --- THE UNCAUGHT (storm, level 70): the worked example's arithmetic ----
  const su = freshSave();
  su.level = 70; su.autoStats = 69; su.classTier = 'advanced';
  su.stats.agi = 260; su.stats.vit = 50; su.stats.str = 35;
  su.className = 'bladedancer';
  const du = applyLayers(su, derive(su));
  ok(near(du.atk, 320.4, 0.1),
    'sanity: the build lands on the example\'s post-class atk 320.4', du.atk.toFixed(1));
  ok(Math.round(du.atk * ST.arc.atkPct) === 176,
    'ARC chains hit for 176 each (55% x 320.4 — worked example verbatim)',
    String(Math.round(du.atk * ST.arc.atkPct)));
  ok(near(du.speed, 10.196, 0.01),
    'sanity: the build\'s speed is the example\'s 10.196', du.speed.toFixed(3));
  const tempestSpeed = Math.min(ST.tempest.hardSpeedCap, du.speed * (1 + ST.tempest.speedBonus));
  ok(near(du.speed * (1 + ST.tempest.speedBonus), 15.80, 0.01) && tempestSpeed === 14,
    'TEMPEST: 10.196 x 1.55 = 15.80, HARD-CLAMPED TO 14.0 (the example\'s own words)');
  // Charge economy: 200 m of travel fills the bar (+1/metre), ~25 s of a
  // normal crawl at the build's own speed — the example's "roughly 25 s".
  ok(near(200 / (sr.gainPer * 8), 25, 0.01),
    'the bar fills in ~200 m; at ~8 m/s of real crawl movement that is the example\'s ~25 s');
  ok(ARCHONS.storm.parity.mobility === 1.60
    && ARCHONS.storm.parity.mobility === Math.max(...Object.values(ARCHONS).map((p) => p.parity.mobility)),
    'the parity table agrees: storm\'s 1.60 mobility row is the roster\'s best');
  ok(ARCHONS.storm.parity.eHP === Math.min(...Object.values(ARCHONS).map((p) => p.parity.eHP)),
    'and its 0.72 eHP row is the roster\'s floor — you die to two mistakes');

  // --- THE PACT (beast, level 70): pact + wild form arithmetic ------------
  const sb = freshSave();
  sb.level = 70; sb.autoStats = 69; sb.classTier = 'advanced';
  sb.stats.str = 150; sb.stats.agi = 130; sb.stats.vit = 65;
  sb.className = 'reaver';
  const dbst = applyLayers(sb, derive(sb));
  ok(near(dbst.atk, 649.0, 0.1),
    'sanity: REAVER leaves atk at the example\'s 649 (its drawbacks are mana and hp)', dbst.atk.toFixed(1));
  // The S-band pact of the worked example: a brute-archetype corpse bound at
  // WARLORD. shadowCombat is the SAME function the game fields it through.
  const pactRec = { type: 'brute', grade: BE.pact.grade, level: 60 };
  const c = shadowCombat(sb, pactRec);
  ok(c.hp === 1014, 'shadowCombat gives the example\'s ~1,014 HP', String(c.hp));
  ok(Math.round(c.atk) === 218, 'and its ~218 atk', String(Math.round(c.atk)));
  ok(Math.floor(c.hp * BE.pact.mul) === 4056 && Math.round(c.atk * BE.pact.mul) === 871,
    'x 4.0 pact multiplier -> 4,056 HP / 871 atk (worked example verbatim)');
  ok(near(dbst.atk * BE.wildForm.atkMul, 1428, 0.5),
    'WILD FORM: 649 x 2.2 = 1,428 (worked example verbatim)',
    (dbst.atk * BE.wildForm.atkMul).toFixed(1));
  ok(near(dbst.speed, 10.14, 0.01)
    && Math.min(ST.tempest.hardSpeedCap, dbst.speed * BE.wildForm.speedMul) === 14,
    'wild speed 10.14 x 1.5 = 15.2, CLAMPED TO 14.0 — the same one ceiling');
  ok(ARCHONS.beast.parity.bossDps === 1.22
    && ARCHONS.beast.parity.bossDps === Math.max(...Object.values(ARCHONS).map((p) => p.parity.bossDps)),
    'the parity table agrees: beast\'s 1.22 boss row is the roster\'s best');
  ok(ARCHONS.beast.parity.roomDps === Math.min(...Object.values(ARCHONS).map((p) => p.parity.roomDps)),
    'and its 0.82 room row is the roster\'s floor — one ally, no cascade');

  // --- the segment pool, driven headless ----------------------------------
  // kind 'storm' builds the box-segment flavour: spawnSegment stores an
  // orientation + length per slot, tick ages without a camera, the ring caps
  // by construction, dispose is idempotent — the same contract the quad
  // pools pinned in the STEP 6 browser section.
  const pool = new ArchonPool(null, { kind: 'storm', maxInstances: 40 });
  ok(pool.segment === true && pool.max === 40, 'a storm pool is 40 segment slots');
  const a10 = { x: 0, y: 1, z: 0 };
  const b10 = { x: 3, y: 1, z: 4 };
  const slot = pool.spawnSegment(a10, b10, { life: 1 });
  ok(pool._len[slot] === 5, 'a 3-4-5 segment stores world length 5 on its slot', String(pool._len[slot]));
  ok(Math.abs(pool._px[slot] - 1.5) < 1e-9 && Math.abs(pool._pz[slot] - 2) < 1e-9,
    'anchored at the midpoint');
  const q2 = pool._qx[slot] ** 2 + pool._qy[slot] ** 2 + pool._qz[slot] ** 2 + pool._qw[slot] ** 2;
  ok(Math.abs(q2 - 1) < 1e-6, 'with a unit orientation quaternion');
  pool.tick(0.5);
  ok(pool.liveCount === 1, 'tick without a camera ages segments headless');
  pool.tick(1);
  ok(pool.liveCount === 0, 'and a lapsed segment collapses to nothing');
  for (let i = 0; i < 100; i++) pool.spawnSegment(a10, b10, { life: 9 });
  ok(pool.liveCount === 40, '100 spawns into 40 slots: the ring reuses the oldest, the cap is the cap');
  pool.dispose();
  pool.dispose();
  ok(pool._disposed === true, 'dispose is idempotent — the one teardown verb');
}

// =========================================================================
// STEP 9 (node half) — the heap-delta assert: 600 simulated frames of the
// full substrate hot path (a 12-body StatusTable ticking, both meters, a
// 64-quad ArchonPool spawning and aging headless) grow the heap by nothing
// once the pools are warm. Run in a child with --expose-gc because a delta
// measured through lazy GC asserts the collector's mood, not the code.
// =========================================================================
section('HEAP DELTA  (node: 600 frames of the archon hot path allocate nothing retained)');
{
  const { spawnSync } = await import('node:child_process');
  const archonUrl = new URL('../src/game/archon.js', import.meta.url).href;
  const script = `
    const { StatusTable, ArchonPool, ResourceMeter, tintForStacks, ARCHON_PATHS } =
      await import(${JSON.stringify(archonUrl)});
    const st = new StatusTable({ pyre: ARCHON_PATHS.flame.stacks.pyre });
    const pool = new ArchonPool(null, { kind: 'flame', maxInstances: 64 });
    const ember = new ResourceMeter({ max: 100, gainPer: 2, decayPerSecond: 3, ultimateCost: 100 });
    const bodies = Array.from({ length: 12 }, () => ({}));
    const pos = { x: 0, y: 1, z: 0 };
    const frame = (i) => {
      // the per-frame shape game.js runs: apply-ish churn, tick, poll, tint
      st.apply(bodies[i % 12], 'pyre', 1);
      for (const b of bodies) st.get(b, 'pyre');
      st.tick(1 / 60);
      ember.gain(1); ember.tick(1 / 60, i % 2 === 0);
      tintForStacks('pyre', i % 11);
      pos.x = (i % 7) - 3;
      pool.spawn(pos, { life: 0.5, scale: 1, rise: 1 });
      pool.tick(1 / 60);
    };
    for (let i = 0; i < 240; i++) frame(i);       // warm every pool
    gc(); gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 600; i++) frame(i);
    gc(); gc();
    const h1 = process.memoryUsage().heapUsed;
    console.log(JSON.stringify({ delta: h1 - h0 }));
  `;
  const res = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60000 });
  let delta = NaN;
  try { delta = JSON.parse(res.stdout.trim().split('\n').pop()).delta; } catch { /* fall through */ }
  ok(Number.isFinite(delta), 'the heap probe ran', (res.stderr || '').slice(0, 300));
  // 64 KB of slack covers allocator page granularity; a per-frame leak of
  // even one small object would show as 600 x sizeof and blow through it.
  ok(delta < 64 * 1024, `600 frames retain < 64 KB (measured ${delta} bytes)`);
}

// =========================================================================
// STEP 4 — MASTERY HOOKS IN PLAY (browser). Every proc fired in the running
// game, at the hook that owns it, with the dice pinned where a roll would
// otherwise blur the assert (Math.random for crits, game._masteryRnd for
// PUNISH's cancel — the same pinning fight-test uses for its gate roll).
// =========================================================================
section('MASTERY HOOKS IN PLAY  (browser: all fifteen procs, driven at their combat hooks)');

// The exact save the browser probe runs: every stat at 200 spent owns all
// fifteen masteries at once (masteries are per-stat and independent of the
// direction label). Expected numbers are recomputed HERE from derive() so the
// asserts compare the game against the model, not the game against itself.
const S4 = freshSave();
S4.level = 60;
S4.autoStats = 59;
S4.stats = { str: 200, agi: 200, vit: 200, int: 200, per: 200 };
const D4 = derive(S4);
const IRONHIDE_CAP = Math.max(1, Math.round(D4.maxHp * 0.12));

const { ensureServer, launchBrowser, newPhonePage, gotoGame, forceOpenGates, evalGame, shotPath } =
  await import('./_harness.mjs');

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors: pageErrors } = await newPhonePage(browser);
try {
  await gotoGame(page);
  await forceOpenGates(page);

  // ---- block A: the fifteen procs --------------------------------------
  const A = await evalGame(page, async (g) => {
    const W = await import('/src/game/weapons.js');
    const V = g.player.pos.constructor;
    const out = {};
    const realRender = g.renderer.render;
    const realRandom = Math.random;
    try {
      g.renderer.render = () => {};
      g.fx.damageNumber = () => {};
      g.save.level = 60;
      g.save.autoStats = 59;
      g.save.stats = { str: 200, agi: 200, vit: 200, int: 200, per: 200 };
      g.refreshDerived(true);
      out.tiers = { ...g._mastery };
      out.derived = { dmgFloor: g.derived.dmgFloor, critDmg: g.derived.critDmg, maxHp: g.derived.maxHp };

      // Pinned gate roll, exactly like fight-test: layout and enemy draws
      // replay identically.
      Math.random = () => 0.42;
      g.startGate(0);
      Math.random = realRandom;
      for (let i = 0; i < 5; i++) g.update(1 / 60);
      // Silence the wave machinery: this probe supplies its own bodies.
      g.killed = -99999;
      g.spawned = 99999;
      for (const e of [...g.enemies]) g._killEnemy(e);

      const p = g.player;
      const mk = (x, z) => {
        g._spawnEnemy(new V(x, 0, z), 'grunt');
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0;
        e.attackCd = 9e9;
        e.hp = 1e9;
        e.maxHp = 1e9;
        return e;
      };

      // ---- IRONHIDE: the 12% burst cap, after every mitigation ----------
      p.hp = g.derived.maxHp; p.invuln = 0; p._dodgeT = 0;
      g._riposteT = 999;                    // keep RIPOSTE out of this check
      g._damagePlayer(1e6, null);
      out.ironhide = { lost: g.derived.maxHp - p.hp, alive: p.alive };

      // ---- RIPOSTE: 25% of post-mitigation damage, 3.5 m, 0.9 s ICD -----
      const dummy = mk(p.pos.x + 2, p.pos.z);
      g._riposteT = 0;
      p.hp = g.derived.maxHp; p.invuln = 0;
      g._damagePlayer(1000, null);
      out.riposte = {
        armed: g._riposteFire.armed, dmg: g._riposteFire.dmg,
        icd: g._riposteT, hpLost: g.derived.maxHp - p.hp,
      };
      const rBefore = dummy.hp;
      p.invuln = 1;
      g.update(1 / 60);                     // the banked blast fires here
      out.riposte.enemyLost = rBefore - dummy.hp;
      p.hp = g.derived.maxHp; p.invuln = 0;
      g._damagePlayer(1000, null);          // inside the 0.9 s ICD
      out.riposte.rearmedInsideIcd = g._riposteFire.armed;

      // ---- UNYIELDING: the lethal hit leaves 1 HP + 2 s invulnerability -
      g._unyieldingT = 0;
      p.hp = 50; p.invuln = 0;
      g._damagePlayer(1e6, null);
      out.unyielding = { hp: p.hp, alive: p.alive, invuln: p.invuln, cd: g._unyieldingT };
      p.hp = g.derived.maxHp;

      // ---- SLIPSTREAM / ANSWER / TEMPO: the perfect-dodge ladder --------
      p.cds.dash = 1.0; p._dodgeT = 0.05; p.invuln = 0.2;
      g._tempoStacks = 0; g._slipT = 0; g._answerT = 0;
      g._damagePlayer(100, null);
      out.windstep = { dashCd: p.cds.dash, slipT: g._slipT, answerT: g._answerT, stacks1: g._tempoStacks };
      for (let i = 0; i < 6; i++) { p._dodgeT = 0.05; p.invuln = 0.2; g._damagePlayer(100, null); }
      out.windstep.stacksCap = g._tempoStacks;
      p.invuln = 1;
      g.update(1 / 60);
      out.windstep.maxSpeed = p.body.maxSpeed;
      // chain lapses at 4 s, then one stack sheds every 2 s: 6.1 s => 5 - 1.
      for (let i = 0; i < Math.ceil(6.1 * 60); i++) { p.invuln = 1; g.update(1 / 60); }
      out.windstep.stacksAfterDecay = g._tempoStacks;

      // ---- ANSWER: guaranteed crit at 1.3x, basic attacks only ----------
      p._dodgeT = 0.05; p.invuln = 0.2;
      g._damagePlayer(100, null);           // re-arm the queue
      g._tempoStacks = 0;                   // isolate 1.3x from TEMPO's +6%/stack
      dummy.telegraph = 0; dummy.sunderT = 0;
      Math.random = () => 0.99;             // no natural crits
      let hb = dummy.hp;
      const aCrit = g._damageEnemy(dummy, 100, {});
      out.answer = { crit: aCrit, delta: hb - dummy.hp, consumed: g._answerT };
      g._answerT = 1.0;
      hb = dummy.hp;
      const sCrit = g._damageEnemy(dummy, 100, { origin: 'skill' });
      out.answerSkill = { crit: sCrit, delta: hb - dummy.hp, answerT: g._answerT };
      Math.random = realRandom;

      // ---- KINDLING: kills inside 3 s refund 20%/kill up to the cost ----
      p.mp = g.derived.maxMp; p.cds.slash = 0;
      g._overN = 0; g._overT = 0;
      g._trySlash();
      const kCost = g.derived.maxMp - p.mp;
      out.kindling = { cost: kCost, windowT: g._kindlingT };
      const mpBefore = p.mp;
      let firstRefund = null;
      for (let i = 0; i < 6; i++) {
        const kE = mk(p.pos.x + 3, p.pos.z);
        g._killEnemy(kE);
        if (firstRefund === null) firstRefund = p.mp - mpBefore;
      }
      out.kindling.refund1 = firstRefund;
      out.kindling.total = p.mp - mpBefore;

      // ---- OVERCHARGE: the 4th cast in the window is free and 1.6x ------
      g._overN = 0; g._overT = 0;
      const costs = [];
      const deltas = [];
      Math.random = () => 0.99;
      for (let c = 0; c < 4; c++) {
        p.pos.set(0, 0, 0); p.body.reset(0, 0, 0); p.yaw = 0;
        dummy.pos.set(0, 0, 2); dummy.vel.set(0, 0, 0);
        dummy.telegraph = 0; dummy.sunderT = 0; dummy.stagger = 0;
        p.cds.slash = 0; p.mp = g.derived.maxMp;
        hb = dummy.hp;
        g._trySlash();
        costs.push(g.derived.maxMp - p.mp);
        deltas.push(hb - dummy.hp);
      }
      Math.random = realRandom;
      out.overcharge = { costs, ratio: deltas[3] / deltas[0] };
      out.residueCap = g._residue.filter((f) => f.t > 0).length;

      // ---- RESIDUE: the field ticks bodies standing in it ---------------
      dummy.pos.set(40, 0, 40);             // out of the cast's own cone
      p.pos.set(0, 0, 0); p.body.reset(0, 0, 0);
      p.cds.slash = 0; p.mp = g.derived.maxMp;
      g._trySlash();                        // leaves a field at the origin
      dummy.pos.set(0.5, 0, 1.5); dummy.vel.set(0, 0, 0);
      hb = dummy.hp;
      p.invuln = 5;
      for (let i = 0; i < 90; i++) g.update(1 / 60);   // 1.5 s inside 3 s field
      out.residue = {
        lost: hb - dummy.hp,
        live: g._residue.filter((f) => f.t > 0).length,
        discs: g._groundFx ? g._groundFx.liveDiscs : 0,
      };

      // ---- SUNDER / AFTERSHOCK / RUINOUS: the finisher ladder -----------
      const w = g.weapon;
      const fin = w.combo[w.combo.length - 1];
      out.finisherStep = Boolean(fin.finisher);
      p.pos.set(0, 0, 0); p.body.reset(0, 0, 0); p.yaw = 0;
      const A2 = mk(0, 2);                  // in the cone
      const B2 = mk(0, -4);                 // behind: aftershock only
      const C2 = mk(6.5, 0);                // outside 5 m, inside 7 m
      dummy.pos.set(40, 0, 40);
      Math.random = () => 0.99;
      let bB = B2.hp; let cB = C2.hp;
      g._ruinFin = 0;
      g._applySwingHit(fin);
      out.sunder = { aT: A2.sunderT, bLost: bB - B2.hp, cLost: cB - C2.hp, cStagger1: C2.stagger };
      hb = A2.hp;
      g._damageEnemy(A2, 100, {});          // the +18% read
      out.sunder.delta = hb - A2.hp;
      A2.pos.set(0, 0, 2); C2.pos.set(6.5, 0, 0); C2.stagger = 0;
      g._applySwingHit(fin);
      g._applySwingHit(fin);                // the 3rd
      out.ruinous = { count: g._ruinFin, cStagger: C2.stagger };
      Math.random = realRandom;

      // ---- RUINOUS half two: a kill refreshes the combo window ----------
      const st = p.attack;
      st.active = false; st.next = 1; st.chain = 0.15; st.cd = 0;
      const kE2 = mk(3, 0);
      kE2.hp = 1; kE2.maxHp = 1;
      g._damageEnemy(kE2, 10, {});
      out.ruinKill = { chain: st.chain, chainWindow: w.chainWindow, next: st.next };

      // ---- PUNISH: +30% into a wind-up, 25% cancel off the seeded fork --
      A2.telegraph = 0.4; A2.telegraphMax = 0.4; A2.sunderT = 0;
      Math.random = () => 0.99;
      g._masteryRnd = () => 0.99;           // suppress the cancel
      hb = A2.hp;
      g._damageEnemy(A2, 100, {});
      out.punish = { delta: hb - A2.hp, telegraphKept: A2.telegraph };
      A2.telegraph = 0.4;
      g._masteryRnd = () => 0;              // force the cancel
      hb = A2.hp;
      g._damageEnemy(A2, 100, {});
      out.punish.delta2 = hb - A2.hp;
      out.punish.cancelled = A2.telegraph === 0 && A2.swing === 0;
      Math.random = realRandom;

      // ---- READING: the wind-up becomes a ground arc, tellLead early ----
      A2.stagger = 0;
      A2.strikeW.combo[0].windup = 0.5;     // inside the 520 ms tell lead
      W.startAttack(A2.attack, A2.strikeW);
      A2.pos.set(2, 0, 0); A2.vel.set(0, 0, 0);
      p.invuln = 2;
      g.update(1 / 60);
      out.reading = {
        telegraph: A2.telegraph,
        tellLead: g.derived.tellLeadMs,
        arcs: g._groundFx ? g._groundFx.liveArcs : 0,
        arcCount: g._groundFx ? g._groundFx.arcMesh.count : 0,
      };

      // ---- UNYIELDING's one-per-90s: the second lethal hit kills --------
      out.secondLethal = { cd: g._unyieldingT };
      p.hp = 5; p.invuln = 0; p._dodgeT = 0;
      g._damagePlayer(1e6, null);
      out.secondLethal.alive = p.alive;
      return out;
    } finally {
      g.renderer.render = realRender;
      Math.random = realRandom;
    }
  });

  ok(A.tiers.str === 3 && A.tiers.agi === 3 && A.tiers.vit === 3 && A.tiers.int === 3 && A.tiers.per === 3,
    'the probe save owns all fifteen masteries (T3 everywhere)', JSON.stringify(A.tiers));
  ok(near(A.derived.dmgFloor, 1.0, 1e-9),
    'CERTAINTY: the damage floor reads 100% on the live derived block', String(A.derived.dmgFloor));
  ok(near(A.derived.critDmg, D4.critDmg + 0.25, 1e-9),
    'CERTAINTY: +25% crit damage lands on the live derived block', `${A.derived.critDmg} vs ${D4.critDmg} + 0.25`);
  ok(A.derived.maxHp === D4.maxHp, 'sanity: the browser derive matches the node model', String(A.derived.maxHp));

  ok(A.ironhide.lost === IRONHIDE_CAP && A.ironhide.alive,
    `IRONHIDE: a million-point hit lands as exactly 12% of max HP (${IRONHIDE_CAP})`, String(A.ironhide.lost));

  ok(A.riposte.armed === true && near(A.riposte.dmg, A.riposte.hpLost * 0.25, 1e-6),
    'RIPOSTE: arms a shockwave worth 25% of the post-mitigation hit', JSON.stringify(A.riposte));
  ok(near(A.riposte.icd, 0.9, 1e-6), 'RIPOSTE: the 0.9 s internal cooldown starts', String(A.riposte.icd));
  ok(A.riposte.enemyLost >= Math.floor(A.riposte.hpLost * 0.25),
    'RIPOSTE: the blast damages an enemy inside 3.5 m next frame', String(A.riposte.enemyLost));
  ok(A.riposte.rearmedInsideIcd === false, 'RIPOSTE: a hit inside the ICD does not re-arm it');

  ok(A.unyielding.hp === 1 && A.unyielding.alive === true,
    'UNYIELDING: the lethal hit leaves exactly 1 HP', JSON.stringify(A.unyielding));
  ok(A.unyielding.invuln >= 2.0 - 1e-9, 'UNYIELDING: 2 s of invulnerability granted', String(A.unyielding.invuln));
  ok(near(A.unyielding.cd, 90, 1e-6), 'UNYIELDING: the 90 s real-time cooldown arms', String(A.unyielding.cd));
  ok(A.secondLethal.cd > 0 && A.secondLethal.alive === false,
    'UNYIELDING: a second lethal hit inside the 90 s kills for real', JSON.stringify(A.secondLethal));

  ok(A.windstep.dashCd === 0, 'SLIPSTREAM: a perfect dodge refunds the dash cooldown in full', String(A.windstep.dashCd));
  ok(near(A.windstep.slipT, 0.6, 1e-9), 'SLIPSTREAM: 0.6 s of attack speed opens', String(A.windstep.slipT));
  ok(near(A.windstep.answerT, 1.2, 1e-9), 'ANSWER: the 1.2 s guaranteed-crit window arms', String(A.windstep.answerT));
  ok(A.windstep.stacks1 === 1 && A.windstep.stacksCap === 5,
    'TEMPO: dodges chain to stacks and cap at 5', JSON.stringify([A.windstep.stacks1, A.windstep.stacksCap]));
  ok(near(A.windstep.maxSpeed, Math.min(14, D4.speed * 1.4), 1e-6),
    'TEMPO: 5 stacks of +8% speed apply under the absolute 14 u/s ceiling',
    `${A.windstep.maxSpeed} vs min(14, ${D4.speed} x 1.4)`);
  ok(A.windstep.stacksAfterDecay === 4,
    'TEMPO: one stack decays 2 s after the 4 s chain lapses', String(A.windstep.stacksAfterDecay));

  ok(A.answer.crit === true && A.answer.delta === Math.round(100 * 1.85 * 1.25 * 1.3),
    'ANSWER: the queued crit lands at 1.3x the earned multiplier (301 on a 100 hit with CERTAINTY)',
    JSON.stringify(A.answer));
  ok(A.answer.consumed === 0, 'ANSWER: the charge is consumed by the hit');
  ok(A.answerSkill.crit === false && A.answerSkill.delta === 100 && near(A.answerSkill.answerT, 1.0, 1e-9),
    'ANSWER: a skill application passes through without consuming the charge', JSON.stringify(A.answerSkill));

  ok(A.kindling.cost > 0 && near(A.kindling.windowT, 3, 1e-9),
    'KINDLING: a skill cast arms the 3 s window on its real cost', JSON.stringify(A.kindling));
  ok(near(A.kindling.refund1, A.kindling.cost * 0.2, 1e-6),
    'KINDLING: the first kill refunds exactly 20% of the cast', String(A.kindling.refund1));
  ok(near(A.kindling.total, A.kindling.cost, 1e-6),
    'KINDLING: six kills stack refunds up to the full cost and stop', String(A.kindling.total));

  ok(A.overcharge.costs[0] > 0 && A.overcharge.costs[1] > 0 && A.overcharge.costs[2] > 0
    && A.overcharge.costs[3] === 0,
    'OVERCHARGE: the 4th cast in the window costs zero mana', JSON.stringify(A.overcharge.costs));
  ok(near(A.overcharge.ratio, 1.6, 0.02),
    'OVERCHARGE: and deals 1.6x (measured against cast #1 on the same target)', String(A.overcharge.ratio));

  ok(A.residueCap === 3, 'RESIDUE: four casts hold at the 3-field cap', String(A.residueCap));
  ok(A.residue.lost >= Math.max(1, Math.round(D4.atk * 0.06)) * 2,
    'RESIDUE: a body standing in the field takes the 12%-of-atk-per-second ticks', String(A.residue.lost));
  ok(A.residue.discs >= 1, 'RESIDUE: the live field draws through the pooled disc channel', String(A.residue.discs));

  ok(A.finisherStep === true, 'sanity: the probe weapon has a real finisher step');
  ok(A.sunder.aT > 4.9 && A.sunder.aT <= 5,
    'SUNDER: the finisher opens a 5 s armour break on what it hits', String(A.sunder.aT));
  ok(A.sunder.delta === 118,
    'SUNDER: a 100-point hit lands as 118 through the break (+18%, all sources)', String(A.sunder.delta));
  ok(A.sunder.bLost === Math.round(D4.atk * 0.4),
    'AFTERSHOCK: the finisher detonates 40% of atk on a body behind the swing', `${A.sunder.bLost} vs ${Math.round(D4.atk * 0.4)}`);
  ok(A.sunder.cLost === 0 && A.sunder.cStagger1 === 0,
    'AFTERSHOCK: 6.5 m is outside the 5 m blast (and the 1st finisher does not stagger it)');
  ok(A.ruinous.count === 3 && A.ruinous.cStagger >= 0.8 - 1e-9,
    'RUINOUS: the 3rd finisher staggers everything inside 7 m for 0.8 s', JSON.stringify(A.ruinous));
  ok(A.ruinKill.chain === A.ruinKill.chainWindow && A.ruinKill.chain > 0.15 && A.ruinKill.next === 1,
    'RUINOUS: a kill refreshes the combo window to full without rewinding the cursor', JSON.stringify(A.ruinKill));

  ok(A.punish.delta === 130 && near(A.punish.telegraphKept, 0.4, 1e-9),
    'PUNISH: a hit into the wind-up deals +30% (cancel roll suppressed)', JSON.stringify(A.punish));
  ok(A.punish.delta2 === 130 && A.punish.cancelled === true,
    'PUNISH: the forced cancel wipes the wind-up outright', JSON.stringify(A.punish));

  ok(A.reading.telegraph > 0 && A.reading.telegraph <= A.reading.tellLead / 1000,
    'READING: the wind-up sits inside derived.tellLeadMs when the arc shows', JSON.stringify(A.reading));
  ok(A.reading.arcs >= 1 && A.reading.arcCount >= 1,
    'READING: the telegraph renders as a live arc in the pooled channel', JSON.stringify(A.reading));

  // ---- block B: the decal channel's budget and teardown ----------------
  const B = await evalGame(page, (g) => {
    const r = g.renderer;
    const out = {};
    const pool = g._ensureGroundFx();
    pool.begin();
    for (let i = 0; i < 3; i++) pool.pushDisc(i * 2, 0, 4, 0xb98bff, 1);
    for (let i = 0; i < 6; i++) pool.pushArc(i * 2, 4, i, 2.6, 0xff4d6d);
    pool.commit();
    out.pushed = { discs: pool.liveDiscs, arcs: pool.liveArcs, discCount: pool.discMesh.count, arcCount: pool.arcMesh.count };
    const calls = () => { r.render(g.scene, g.camera); return r.info.render.calls; };
    const live = calls();
    pool.clear();
    const idle = calls();
    out.delta = live - idle;
    // capacity clamps: pushes past the caps drop silently.
    pool.begin();
    for (let i = 0; i < 12; i++) pool.pushDisc(0, 0, 1, 0xffffff, 1);
    for (let i = 0; i < 12; i++) pool.pushArc(0, 0, 0, 1, 0xffffff);
    pool.commit();
    out.caps = { discs: pool.liveDiscs, arcs: pool.liveArcs };
    // teardown cycle: geometries hand back to the renderer and a rebuild
    // returns the count to the live baseline exactly.
    const memLive = r.info.memory.geometries;
    pool.dispose();
    g._groundFx = null;
    r.render(g.scene, g.camera);
    out.memAfterDispose = r.info.memory.geometries;
    const re = g._ensureGroundFx();
    re.begin();
    re.pushDisc(0, 0, 1, 0xffffff, 1);
    re.pushArc(0, 0, 0, 1, 0xffffff);
    re.commit();
    r.render(g.scene, g.camera);
    out.memRestored = r.info.memory.geometries;
    out.memLive = memLive;
    g._groundFx.clear();
    return out;
  });

  ok(B.pushed.discs === 3 && B.pushed.arcs === 6 && B.pushed.discCount === 3 && B.pushed.arcCount === 6,
    'channel: pushes land as instance counts (3 discs + 6 arcs)', JSON.stringify(B.pushed));
  ok(B.delta === 2,
    'channel: READING + RESIDUE both live cost exactly +2 draw calls, 0 idle (inside the +3 budget)',
    String(B.delta));
  ok(B.caps.discs === 8 && B.caps.arcs === 6,
    'channel: capacity clamps hold (8 discs / 6 arcs, spec max 6 arcs live)', JSON.stringify(B.caps));
  ok(B.memAfterDispose === B.memLive - 2 && B.memRestored === B.memLive,
    'channel: a dispose/rebuild cycle returns renderer.info.memory.geometries to baseline',
    JSON.stringify({ live: B.memLive, disposed: B.memAfterDispose, restored: B.memRestored }));

  // =======================================================================
  // STEP 5 — THE ASSAY HALL DESK (browser). The door's save-dependent line,
  // the panel, choosing BERSERKER with the derived block asserted to change by
  // EXACTLY the modelled amounts and by nothing else, then the reseal ladder
  // (free first seal, 1,800 ash after) and the fast-travel list still one tap
  // away.
  // =======================================================================
  section('THE ASSAY HALL DESK  (browser: door line, roster panel, BERSERKER by exact deltas, the seal ladder)');

  // ---- C0: below level 20 the door is the shipped fast-travel desk --------
  const C0 = await evalGame(page, async (g) => {
    window.__app.go('city');
    await new Promise((r) => setTimeout(r, 900));
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'assay');
    g.save.level = 1; g.save.autoStats = 0;
    g.save.stats = { str: 0, agi: 0, vit: 0, int: 0, per: 0 };
    g.save.className = null; g.save.classTier = null;
    g.refreshDerived(true);
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    const sub = g.mode.prompt?.sub;
    g.mode.confirmPrompt();
    return {
      sub,
      assayOpen: Boolean(g.assayUI?.isOpen),
      gatesVisible: !document.getElementById('gates').classList.contains('hidden'),
    };
  });
  ok(C0.sub === 'RIFT CONTRACTS', 'below 20 the door still reads RIFT CONTRACTS', String(C0.sub));
  ok(!C0.assayOpen && C0.gatesVisible, 'and confirming opens the shipped gate list, not the class panel', JSON.stringify(C0));

  // ---- C: the class choice, asserted against the model --------------------
  // The probe save: level 22, str 60 spent — direction BREAKER at tier 1, so
  // BERSERKER is RESONANT 1 with quality base (classTier null). Every expected
  // number below is recomputed here from classes.js's own stated rules.
  const C = await evalGame(page, async (g) => {
    window.__app.go('city');
    await new Promise((r) => setTimeout(r, 900));
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'assay');
    g.save.level = 22; g.save.autoStats = 21;
    g.save.stats = { str: 60, agi: 0, vit: 0, int: 0, per: 0 };
    g.save.points = 0; g.save.ash = 5000;
    g.save.className = null; g.save.classTier = null; g.save.respecTokens = 0;
    g.save.archonState.classTokenGranted = false;
    g.save.archonState.freeSealUsed = false;
    g.refreshDerived(true);
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    const sub = g.mode.prompt?.sub;
    const acted = g.mode.confirmPrompt();
    const toasts = [...document.querySelectorAll('#toasts .toast.gold')].map((t) => t.textContent);
    const rows = [...document.querySelectorAll('#assayList .gate')].map((r) => ({
      key: r.dataset.classKey,
      resonant: r.classList.contains('resonant'),
      badge: r.querySelector('.badge')?.textContent ?? null,
      benSize: getComputedStyle(r.querySelector('.ben')).fontSize,
      dbkSize: getComputedStyle(r.querySelector('.dbk')).fontSize,
      hasBen: Boolean(r.querySelector('.ben')?.textContent),
      hasDbk: Boolean(r.querySelector('.dbk')?.textContent),
    }));
    return {
      sub,
      acted,
      open: Boolean(g.assayUI?.isOpen),
      pathLine: document.querySelector('#assayPanel .assay-strip span')?.textContent ?? '',
      toasts,
      rows,
      derivedBefore: { ...g.derived },
    };
  });
  ok(C.sub === 'YOUR CLASS AWAITS', 'at 20+ with no class the door reads YOUR CLASS AWAITS', String(C.sub));
  ok(C.acted?.id === 'assay' && C.open, 'confirming at the door opens the class panel', JSON.stringify(C.acted));
  ok(C.toasts.some((t) => t === 'YOUR CLASS AWAITS'),
    "the migration's promised gold toast fires on the visit", JSON.stringify(C.toasts));
  ok(/YOUR PATH SO FAR READS AS BREAKER/.test(C.pathLine),
    'the header names the derived direction', C.pathLine);
  ok(C.rows.length === 8, 'all eight classes are on the roster', String(C.rows.length));
  ok(C.rows[0].key === 'berserker' && C.rows[1].key === 'reaver',
    'resonant classes sort first (BERSERKER then REAVER for a str build)', JSON.stringify(C.rows.map((r) => r.key)));
  ok(C.rows[0].badge === 'RESONANT 1', 'the badge carries the mastery tier', String(C.rows[0].badge));
  ok(C.rows.slice(2).every((r) => !r.resonant && r.badge === null), 'the other six read neutral');
  ok(C.rows.every((r) => r.hasBen && r.hasDbk), 'every row states its benefit AND its drawback');
  ok(C.rows.every((r) => r.benSize === r.dbkSize),
    'drawbacks render in the SAME type size as benefits — the non-negotiable', JSON.stringify(C.rows[0]));

  await page.screenshot({ path: shotPath('assay-panel-choice.png') });

  // The commit, driven through the real DOM: tap the row, tap the button.
  const C2 = await evalGame(page, async (g) => {
    document.querySelector('#assayList .gate[data-class-key="berserker"]').click();
    const btnText = document.getElementById('assayConfirm').textContent;
    const btnDisabled = document.getElementById('assayConfirm').disabled;
    document.getElementById('assayConfirm').click();
    return {
      btnText, btnDisabled,
      className: g.save.className,
      respecTokens: g.save.respecTokens,
      tokenGuard: g.save.archonState.classTokenGranted,
      ash: g.save.ash,
      derivedAfter: { ...g.derived },
      stripRight: document.querySelector('#assayPanel .assay-strip .right')?.textContent ?? '',
    };
  });
  ok(C2.btnText === 'BECOME BERSERKER' && C2.btnDisabled === false,
    'the confirm button names the commitment', C2.btnText);
  ok(C2.className === 'berserker', 'the class is sworn', String(C2.className));
  ok(C2.respecTokens === 1 && C2.tokenGuard === true, 'choosing banks exactly one respec token', String(C2.respecTokens));
  ok(C2.ash === 5000, 'choosing is FREE — the commitment is the cost', String(C2.ash));
  ok(/FIRST RESEAL FREE/.test(C2.stripRight), 'the re-rendered panel offers the free first reseal', C2.stripRight);

  // THE STEP 5 VERIFY CLAUSE: the derived block changes by exactly the
  // modelled amounts and by nothing else. BERSERKER at quality base,
  // resonance 1: benefitScale 1.04, drawbackScale 0.98.
  {
    const d0 = C.derivedBefore;
    const d1 = C2.derivedAfter;
    // atkSpeed: raw (60+21) x 0.006 = 0.486 was clamped at the 0.30 base cap;
    // the raised cap 0.30 + 0.06 x 1.04 re-admits the clamped-off raw up to it.
    const expAtkSpeed = Math.min(STAT_RATES.str.atkSpeedCap + 0.06 * 1.04, (60 + 21) * STAT_RATES.str.atkSpeed);
    // hpRegen: 0.6 + 21 x 0.05 = 1.65, then x(1 - 0.50 x 0.98).
    const expHpRegen = (0.6 + 21 * STAT_RATES.vit.regen) * (1 - 0.50 * 0.98);
    ok(near(d1.atkSpeed, expAtkSpeed, 1e-12),
      `BERSERKER raises the attack-speed cap to exactly ${expAtkSpeed}`, `${d0.atkSpeed} -> ${d1.atkSpeed}`);
    ok(near(d1.hpRegen, expHpRegen, 1e-12),
      `BERSERKER halves regen (resonance-softened) to exactly ${expHpRegen}`, `${d0.hpRegen} -> ${d1.hpRegen}`);
    const changed = Object.keys(d0).filter((k) => d0[k] !== d1[k]).sort();
    ok(JSON.stringify(changed) === JSON.stringify(['atkSpeed', 'hpRegen']),
      'and NOTHING else moved — the derived block changes by the modelled amounts only',
      JSON.stringify(changed));
    ok(Object.keys(d1).length === Object.keys(d0).length, 'no field appeared or vanished');
    // The DR-cap drawback (45% -> 25%) exists but does not bind at vit 21
    // (dr 0.0378): a drawback that is not binding must not move the number.
    ok(d1.dr === d0.dr, 'the DR cap drawback does not bind below it', `${d0.dr} -> ${d1.dr}`);
  }

  await page.screenshot({ path: shotPath('assay-panel-reseal.png') });

  // ---- D: the seal ladder -------------------------------------------------
  const D = await evalGame(page, async (g) => {
    const out = {};
    // Free first reseal: ORACLE, with the wallet untouched.
    document.querySelector('#assayList .gate[data-class-key="oracle"]').click();
    out.freeBtn = document.getElementById('assayConfirm').textContent;
    document.getElementById('assayConfirm').click();
    out.afterFree = {
      className: g.save.className, ash: g.save.ash,
      freeSealUsed: g.save.archonState.freeSealUsed,
      respecTokens: g.save.respecTokens,
    };
    // Second reseal: 1,799 ash cannot buy it...
    g.save.ash = 1799;
    g.assayUI.render();
    document.querySelector('#assayList .gate[data-class-key="berserker"]').click();
    out.poorBtn = {
      text: document.getElementById('assayConfirm').textContent,
      disabled: document.getElementById('assayConfirm').disabled,
    };
    // ...and 1,800 exactly can. render() keeps the selection; a second row
    // click would TOGGLE it off (that is the deselect gesture).
    g.save.ash = 1800;
    g.assayUI.render();
    out.paidBtn = document.getElementById('assayConfirm').textContent;
    document.getElementById('assayConfirm').click();
    out.afterPaid = {
      className: g.save.className, ash: g.save.ash,
      classTier: g.save.classTier, strSpent: g.save.stats.str,
    };
    // The desk keeps its old job: RIFT CONTRACTS from inside the panel.
    document.getElementById('assayGates').click();
    await new Promise((r) => setTimeout(r, 400));
    out.gates = {
      assayOpen: Boolean(g.assayUI.isOpen),
      gatesVisible: !document.getElementById('gates').classList.contains('hidden'),
    };
    // And the door line for a sworn save.
    window.__app.go('city');
    await new Promise((r) => setTimeout(r, 900));
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'assay');
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    out.swornSub = g.mode.prompt?.sub;
    return out;
  });
  ok(/RESEAL AS ORACLE · FREE/.test(D.freeBtn), 'the first reseal is offered free', D.freeBtn);
  ok(D.afterFree.className === 'oracle' && D.afterFree.ash === 5000 && D.afterFree.freeSealUsed === true,
    'the free reseal commits, charges nothing, burns the once-guard', JSON.stringify(D.afterFree));
  ok(D.afterFree.respecTokens === 1, 'a reseal mints no second respec token', String(D.afterFree.respecTokens));
  ok(/1800 ASH/.test(D.poorBtn.text) && D.poorBtn.disabled === true,
    '1,799 ash cannot press the 1,800-ash button', JSON.stringify(D.poorBtn));
  ok(D.afterPaid.className === 'berserker' && D.afterPaid.ash === 0,
    'exactly 1,800 ash buys and spends the seal atomically', JSON.stringify(D.afterPaid));
  ok(D.afterPaid.classTier === null && D.afterPaid.strSpent === 60,
    'a reseal changes className ONLY — quality and stats untouched');
  ok(D.gates.assayOpen === false && D.gates.gatesVisible === true,
    'RIFT CONTRACTS is still one tap away inside the panel', JSON.stringify(D.gates));
  ok(D.swornSub === 'CLASSES · RIFT CONTRACTS', 'a sworn save reads the combined door line', String(D.swornSub));

  // =======================================================================
  // STEP 6 — ARCHON POOL (browser). One pool of 64 instances is ONE draw
  // call; dispose() returns renderer.info.memory to its pre-build values; and
  // the runtime traverse confirms what the source grep already said — no
  // emissive channel exists to write, and the mesh sits on layer 0 only
  // (GLOW_LAYER is layer 1).
  // =======================================================================
  section('ARCHON POOL  (browser: 64 instances = one draw call; dispose to baseline; no glow)');
  const P6 = await evalGame(page, async (g) => {
    const { ArchonPool } = await import('/src/game/archon.js');
    const out = {};
    // Everything below is synchronous, so the game's own RAF cannot
    // interleave a render (or an update) between the paired reads — the two
    // frames differ by exactly the pool and nothing else.
    g.renderer.render(g.scene, g.camera);
    const geoBefore = g.renderer.info.memory.geometries;
    const texBefore = g.renderer.info.memory.textures;
    g.renderer.render(g.scene, g.camera);
    const callsBefore = g.renderer.info.render.calls;
    const pool = new ArchonPool(g.scene, { kind: 'flame', maxInstances: 64 });
    const V = g.player.pos.constructor;
    // 80 spawns into 64 slots: the ring must reuse the oldest, never grow.
    for (let i = 0; i < 80; i++) {
      pool.spawn(new V((i % 8) - 4, 1, ((i / 8) | 0) - 4), { life: 5, scale: 1 });
    }
    pool.tick(1 / 60, g.camera);
    out.live = pool.liveCount;
    g.renderer.render(g.scene, g.camera);
    out.callsDelta = g.renderer.info.render.calls - callsBefore;
    out.hasEmissive = 'emissive' in pool.material;
    out.layerMask = pool.mesh.layers.mask;
    out.isBasic = pool.material.isMeshBasicMaterial === true;
    pool.dispose();
    pool.dispose();  // idempotence: the run-end and path-swap paths may race
    g.renderer.render(g.scene, g.camera);
    out.geoDelta = g.renderer.info.memory.geometries - geoBefore;
    out.texDelta = g.renderer.info.memory.textures - texBefore;
    out.inScene = g.scene.children.includes(pool.mesh);
    return out;
  });
  ok(P6.live === 64, '80 spawns into 64 slots hold at 64 — the cap is the cap', String(P6.live));
  ok(P6.callsDelta === 1, 'a full pool costs exactly ONE draw call', String(P6.callsDelta));
  ok(P6.isBasic && P6.hasEmissive === false,
    'the material is MeshBasicMaterial — no emissive channel EXISTS to violate the glow rule');
  ok(P6.layerMask === 1, 'the mesh lives on layer 0 only — never GLOW_LAYER', String(P6.layerMask));
  ok(P6.geoDelta === 0 && P6.texDelta === 0 && !P6.inScene,
    'dispose() returns geometries/textures to baseline and leaves the scene',
    JSON.stringify({ geo: P6.geoDelta, tex: P6.texDelta, inScene: P6.inScene }));

  // =======================================================================
  // STEP 7 — AFFINITY FROM REAL PLAY (browser). Every counter bumped at the
  // hook that owns it, in a live gate: the resonanceReading table made
  // executable. The zero() helper re-arms between probes so each assert reads
  // one clause alone.
  // =======================================================================
  section('AFFINITY COUNTERS  (browser: every resonanceReading clause at its own combat hook)');
  const R1 = await evalGame(page, async (g) => {
    const out = {};
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    try {
      g.renderer.render = () => {};
      g.fx.damageNumber = () => {};
      g.save.level = 60;
      g.save.autoStats = 59;
      g.save.stats = { str: 200, agi: 200, vit: 200, int: 200, per: 200 };
      g.save.ash = 99999;
      g.refreshDerived(true);
      Math.random = () => 0.42;
      g.startGate(0);
      Math.random = realRandom;
      for (let i = 0; i < 5; i++) g.update(1 / 60);
      // An E gate never arms THE REACH, whatever the save looks like.
      out.trialOnE = g._trialRun;
      g.killed = -99999;
      g.spawned = 99999;
      for (const e of [...g.enemies]) g._killEnemy(e);

      const zero = () => {
        g.save.archonState.affinity = { shadow: 0, flame: 0, frost: 0, storm: 0, beast: 0 };
      };
      const aff = () => ({ ...g.save.archonState.affinity });
      const V = g.player.pos.constructor;
      const p = g.player;
      const mk = (x, z, type = 'grunt') => {
        g._spawnEnemy(new V(x, 0, z), type);
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0; e.attackCd = 9e9; e.hp = 1e9; e.maxHp = 1e9;
        return e;
      };
      Math.random = () => 0.99;   // suppress crits and drop rolls throughout

      // FROST +1 per perfect dodge, STORM +2 per dash-clear — one i-framed
      // hit inside both windows pays both counters (two different instincts).
      zero();
      p.hp = g.derived.maxHp; p.invuln = 0.2; p._dodgeT = 0.05; p.dashTimer = 0.1;
      g._damagePlayer(100, null);
      out.dodge = aff();
      // A dash-clear OUTSIDE the dodge window is storm's alone.
      p.invuln = 0.2; p._dodgeT = 0; p.dashTimer = 0.1;
      g._damagePlayer(100, null);
      out.dodgeLate = aff();
      // Post-hit i-frames (no dash live) pay neither.
      p.invuln = 0.2; p._dodgeT = 0; p.dashTimer = 0;
      g._damagePlayer(100, null);
      out.dodgeNone = aff();

      // FROST +2 per enemy killed while staggered.
      zero();
      const s1 = mk(2, 0); s1.hp = 1; s1.stagger = 0.5;
      g._killEnemy(s1);
      out.staggerKill = aff();
      // The killing blow's OWN stagger does not count — pre-hit truth only,
      // or every melee kill would read as a staggered kill.
      zero();
      const s1b = mk(2, 0); s1b.hp = 1;
      g._damageEnemy(s1b, 100, { stagger: 0.5 });
      out.freshStaggerKill = aff();
      // A genuinely held enemy killed through the damage path does.
      zero();
      const s1c = mk(2, 0); s1c.hp = 1; s1c.stagger = 0.5;
      g._damageEnemy(s1c, 100, {});
      out.heldKill = aff();

      // BEAST +1 per elite (brute rides the same tier map extraction uses).
      zero();
      const s2 = mk(2, 0, 'brute'); s2.hp = 1;
      g._killEnemy(s2);
      out.elite = aff();

      // BEAST +3 per boss. encounterDriven=true keeps the arena from clearing
      // the whole gate out from under the rest of this probe — RESTORED right
      // after, because the arena world object is REUSED by every later gate
      // entry and a stale true would hand DungeonMode a director with no
      // dungeon.
      zero();
      const s3 = mk(2, 0); s3.hp = 1; s3.isBoss = true;
      g.world.encounterDriven = true;
      g._killEnemy(s3);
      g.world.encounterDriven = false;
      out.boss = aff();

      // FLAME +2 per Nova that hits 4+ — and nothing at 3.
      zero();
      p.pos.set(0, 0, 0); p.body.reset(0, 0, 0);
      const n1 = mk(2, 0); const n2 = mk(-2, 0); const n3 = mk(0, 2);
      p.cds.nova = 0; p.mp = g.derived.maxMp;
      g._tryNova();
      out.nova3 = aff();
      zero();
      const n4 = mk(0, -2);
      for (const e of [n1, n2, n3, n4]) { e.hp = 1e9; e.pos.setY(0); }
      p.cds.nova = 0; p.mp = g.derived.maxMp;
      g._tryNova();
      out.nova4 = aff();

      // FLAME +1 per enemy KILLED BY THE FINISHER's own cone — the
      // aftershock rider's kill deliberately does not count.
      zero();
      for (const e of [...g.enemies]) g._killEnemy(e);
      zero();
      p.pos.set(0, 0, 0); p.body.reset(0, 0, 0); p.yaw = 0;
      const w = g.weapon;
      const fin = w.combo[w.combo.length - 1];
      const inCone = mk(0, 2); inCone.hp = 1;
      const behind = mk(0, -3); behind.hp = 1;   // out of the cone, inside 5 m
      g._applySwingHit(fin);
      out.finKill = aff();
      out.finKilledBoth = !g.enemies.includes(inCone) && !g.enemies.includes(behind);
      // An opener kill is not a finisher kill.
      zero();
      const op = mk(0, 2); op.hp = 1;
      g._applySwingHit(w.combo[0]);
      out.openerKill = aff();

      // SHADOW +1 per successful Bind extraction (corpses left by the kills
      // above are still inside their window).
      zero();
      Math.random = () => 0;      // extraction succeeds
      p.cds.summon = 0;
      g._trySummon();
      const raised = g.shadows.length;
      Math.random = () => 0.99;
      out.bind = { raised, aff: aff() };

      // SHADOW +3 per shadow promoted (the one commit site, shadows.js).
      zero();
      const SH = await import('/src/game/shadows.js');
      const rec = g.save.shadows.roster[g.save.shadows.roster.length - 1];
      out.promoted = rec ? SH.promote(g.save, rec.id) : false;
      out.promote = aff();

      // STORM +1 per 400 m travelled inside a gate, off the body's own
      // ground speed — the odometer, not the teleport.
      zero();
      g._travelAcc = 398;
      p.invuln = 9;
      p.body.addImpulse(40, 0, 0);
      for (let i = 0; i < 90; i++) g.update(1 / 60);
      out.travel = { aff: aff(), accBelow: g._travelAcc < 400 };
    } finally {
      g.renderer.render = realRender;
      Math.random = realRandom;
    }
    return out;
  });
  ok(R1.trialOnE === false, 'an E gate never arms THE REACH', String(R1.trialOnE));
  ok(R1.dodge.frost === 1 && R1.dodge.storm === 2,
    'one hit i-framed inside dash AND dodge window pays frost +1 and storm +2', JSON.stringify(R1.dodge));
  ok(R1.dodgeLate.frost === 1 && R1.dodgeLate.storm === 4,
    'a sloppy dash-clear (outside the dodge window) is storm\'s alone', JSON.stringify(R1.dodgeLate));
  ok(R1.dodgeNone.frost === 1 && R1.dodgeNone.storm === 4,
    'post-hit i-frames with no dash live pay neither', JSON.stringify(R1.dodgeNone));
  ok(R1.staggerKill.frost === 2, 'a staggered kill pays frost +2', JSON.stringify(R1.staggerKill));
  ok(R1.freshStaggerKill.frost === 0,
    'the killing blow\'s own stagger does not count — pre-hit truth only',
    JSON.stringify(R1.freshStaggerKill));
  ok(R1.heldKill.frost === 2,
    'an already-held enemy killed through the damage path does', JSON.stringify(R1.heldKill));
  ok(R1.elite.beast === 1, 'an elite kill pays beast +1', JSON.stringify(R1.elite));
  ok(R1.boss.beast === 3, 'a boss kill pays beast +3', JSON.stringify(R1.boss));
  ok(R1.nova3.flame === 0, 'a Nova that hits 3 pays nothing', JSON.stringify(R1.nova3));
  ok(R1.nova4.flame === 2, 'a Nova that hits 4 pays flame +2', JSON.stringify(R1.nova4));
  ok(R1.finKilledBoth === true && R1.finKill.flame === 1,
    'the finisher cone kill pays flame +1; the aftershock rider\'s kill does not',
    JSON.stringify(R1.finKill));
  ok(R1.openerKill.flame === 0, 'an opener kill is not a finisher kill', JSON.stringify(R1.openerKill));
  ok(R1.bind.raised >= 1 && R1.bind.aff.shadow === R1.bind.raised,
    'each successful Bind extraction pays shadow +1', JSON.stringify(R1.bind));
  ok(R1.promoted === true && R1.promote.shadow === 3,
    'a promotion pays shadow +3 at the one commit site', JSON.stringify(R1.promote));
  ok(R1.travel.aff.storm === 1 && R1.travel.accBelow,
    'crossing 400 m of real ground pays storm +1 and rolls the odometer', JSON.stringify(R1.travel));

  // =======================================================================
  // STEP 7 — THE REACH AND THE OFFER (browser). The S gate arms the trial for
  // an eligible save; the Rift Archon's death opens the offer — top two by
  // counter plus SHADOW; NOT YET declines; a real row click ascends; and the
  // derived block is BYTE-IDENTICAL across ascension (interlock rule 3, the
  // step's own verify clause).
  // =======================================================================
  section('THE REACH  (browser: trial flag, sigil stream, the offer, ascension changes nothing)');
  const R2 = await evalGame(page, async (g) => {
    const out = {};
    const realRandom = Math.random;
    try {
      g.fx.damageNumber = () => {};
      g.save.classTier = 'advanced';
      g.save.className = 'binder';
      g.save.cleared.S = 999;
      g.save.archonState.sigils = 0;
      g.refreshDerived(true);
      Math.random = () => 0.42;
      // forceOpen (Wave E retarget): S mounts the reach natively now; these
      // probes poke g.killed/g.spawned against the ARENA wave path, which
      // survives exactly behind the sanctioned forceOpen override.
      g.enterGate('S', { forceOpen: true });
      Math.random = realRandom;
      for (let i = 0; i < 5; i++) g.update(1 / 60);
      out.trialArmed = g._trialRun;
      g.killed = -99999;
      g.spawned = 99999;
      Math.random = () => 0.99;
      for (const e of [...g.enemies]) g._killEnemy(e);
      Math.random = realRandom;
      // The Rift Archon falls under the flag. Crawl shape (encounterDriven)
      // so the arena's instant clear does not tear the run down mid-probe.
      const V = g.player.pos.constructor;
      g._spawnEnemy(new V(2, 0, 2), 'grunt');
      const boss = g.enemies[g.enemies.length - 1];
      boss.spawning = 0; boss.isBoss = true; boss.hp = 1;
      g.world.encounterDriven = true;
      g.save.archonState.affinity = { shadow: 0, flame: 40, frost: 90, storm: 10, beast: 5 };
      g._archonRnd = () => 0.9;          // above 1/3: no sigil this kill
      g._killEnemy(boss);
      g.world.encounterDriven = false;   // the arena world object is shared
      const panel = document.getElementById('archonPanel');
      out.offerVisible = Boolean(panel) && !panel.classList.contains('hidden');
      out.trialBurned = g._trialRun === false;
      out.rows = [...document.querySelectorAll('#archonList .gate')].map((r) => r.dataset.archon);
      out.pills = [...document.querySelectorAll('#archonList .aff')].map((r) => r.textContent);
      out.sigilsHigh = g.save.archonState.sigils;
      return out;
    } finally {
      Math.random = realRandom;
    }
  });
  ok(R2.trialArmed === true, 'the S gate arms THE REACH for an eligible save', String(R2.trialArmed));
  ok(R2.offerVisible && R2.trialBurned,
    'killing the Rift Archon under the flag opens the offer and burns the flag',
    JSON.stringify({ visible: R2.offerVisible, burned: R2.trialBurned }));
  ok(JSON.stringify(R2.rows) === JSON.stringify(['frost', 'flame', 'shadow']),
    'the offer is the top two by counter plus SHADOW appended', JSON.stringify(R2.rows));
  ok(JSON.stringify(R2.pills) === JSON.stringify(['AFFINITY 90', 'AFFINITY 40', 'AFFINITY 0']),
    'each row shows the counter that earned it — SHADOW offerable at 0', JSON.stringify(R2.pills));
  ok(R2.sigilsHigh === 0, 'a 0.9 draw on the sigil stream drops nothing', String(R2.sigilsHigh));
  // 120 s, not the 30 s default: the S-crawl mass kill above just spawned a
  // field of skinned corpses, and headless SwiftShader pays multi-second
  // shader-compile frames for their first render (measured 3.2 s for one
  // 2-program compile). The screenshot only needs ONE stable frame; the
  // budget covers the compile storm, not any behaviour under test.
  await page.screenshot({ path: shotPath('archon-offer.png'), timeout: 120000 });

  const R3 = await evalGame(page, (g) => {
    const out = {};
    // NOT YET declines: the panel closes, nothing is consumed, nothing is
    // written — the offer returns on the next eligible S clear.
    document.getElementById('archonLater').click();
    const panel = document.getElementById('archonPanel');
    out.declined = { hidden: panel.classList.contains('hidden'), archon: g.save.archon };
    // Sigil wiring: a low draw on the (already-burned-trial) next S boss.
    const V = g.player.pos.constructor;
    g._spawnEnemy(new V(2, 0, 2), 'grunt');
    const boss = g.enemies[g.enemies.length - 1];
    boss.spawning = 0; boss.isBoss = true; boss.hp = 1;
    g._archonRnd = () => 0.1;
    g.world.encounterDriven = true;      // keep the arena from instant-clearing
    g._killEnemy(boss);
    g.world.encounterDriven = false;
    out.sigils = g.save.archonState.sigils;
    out.noSecondOffer = panel.classList.contains('hidden');
    return out;
  });
  ok(R3.declined.hidden && R3.declined.archon === null,
    'NOT YET closes the panel and ascends nothing', JSON.stringify(R3.declined));
  ok(R3.sigils === 1, 'a 0.1 draw on the sigil stream banks one ASHEN SIGIL', String(R3.sigils));
  ok(R3.noSecondOffer === true, 'the burned flag offers only once per run');

  const R4 = await evalGame(page, (g) => {
    const out = {};
    const realRandom = Math.random;
    try {
      // Re-enter THE REACH by the real door (the flag re-arms in _beginGate)
      // and take the trial to the end this time.
      Math.random = () => 0.42;
      // forceOpen (Wave E retarget): S mounts the reach natively now; these
      // probes poke g.killed/g.spawned against the ARENA wave path, which
      // survives exactly behind the sanctioned forceOpen override.
      g.enterGate('S', { forceOpen: true });
      Math.random = realRandom;
      for (let i = 0; i < 5; i++) g.update(1 / 60);
      out.reArmed = g._trialRun;
      g.killed = -99999;
      g.spawned = 99999;
      Math.random = () => 0.99;
      for (const e of [...g.enemies]) g._killEnemy(e);
      Math.random = realRandom;
      const V = g.player.pos.constructor;
      g._spawnEnemy(new V(2, 0, 2), 'grunt');
      const boss = g.enemies[g.enemies.length - 1];
      boss.spawning = 0; boss.isBoss = true; boss.hp = 1;
      g.world.encounterDriven = true;
      g.save.archonState.affinity = { shadow: 0, flame: 40, frost: 90, storm: 10, beast: 5 };
      g._archonRnd = () => 0.9;
      g._killEnemy(boss);
      g.world.encounterDriven = false;   // shared arena world — see R1
      // THE assert this section exists for: ascension leaves the derived
      // block byte-identical. Snapshot before the click, compare after —
      // onChoose runs refreshDerived, so a leak would show here.
      const before = JSON.stringify(g.derived);
      const tokensBefore = g.save.respecTokens;
      document.querySelector('#archonList .gate[data-archon="frost"]').click();
      out.ascended = {
        archon: g.save.archon,
        derivedSame: JSON.stringify(g.derived) === before,
        tokens: g.save.respecTokens - tokensBefore,
        resource: g.save.archonState.resource,
        ascendedAt: g.save.archonState.ascendedAt,
        sigils: g.save.archonState.sigils,
        panelHidden: document.getElementById('archonPanel').classList.contains('hidden'),
      };
      // The meter lights and the Bind slot wears the path's tag.
      g.ui.updateHud(g);
      const meter = document.getElementById('archonMeter');
      out.hud = {
        meter: Boolean(meter) && !meter.classList.contains('hidden'),
        name: meter?.querySelector('b')?.textContent,
        val: meter?.querySelector('span')?.textContent,
        barShown: meter?.querySelector('.am-bar')?.style.display !== 'none',
        tag: document.querySelector('.skill-btn[data-skill="summon"] .archon-tag')?.textContent,
      };
    } finally {
      Math.random = realRandom;
    }
    return out;
  });
  ok(R4.reArmed === true, 'an undeclined save re-arms the trial on the next S entry');
  ok(R4.ascended.archon === 'frost' && R4.ascended.panelHidden,
    'a real row click ascends and closes the panel', JSON.stringify(R4.ascended));
  ok(R4.ascended.derivedSame === true,
    'ASCENSION CHANGES NOTHING: the derived block is byte-identical across it (interlock rule 3)');
  ok(R4.ascended.tokens === 1 && R4.ascended.resource === 0,
    'first ascension banks one respec token and zeroes the meter', JSON.stringify(R4.ascended));
  ok(R4.ascended.sigils === 1,
    'the FIRST ascension spends no sigil — the banked one waits for a re-ascension');
  ok(R4.hud.meter && R4.hud.name === 'FROST ARCHON' && R4.hud.val === 'BARRIER 0/35' && R4.hud.barShown,
    'the HUD meter lights with the path name and its empty bank', JSON.stringify(R4.hud));
  ok(R4.hud.tag === 'SHATTER',
    'the Bind slot wears the contextual tag (its mechanic is step 9\'s)', String(R4.hud.tag));
  await page.screenshot({ path: shotPath('archon-hud.png') });

  // The migration promise made visible: the fast-travel list's S row reads as
  // the trial for an eligible save (an ascended save with a banked sigil
  // still qualifies — re-ascension is a real path).
  const R5 = await page.evaluate(() => {
    window.__app.go('gates');
    const rows = [...document.querySelectorAll('#gateList .gate')];
    const s = rows.find((r) => r.querySelector('.rank-S'));
    return { line: s?.querySelector('small')?.textContent || null };
  });
  ok(R5.line === 'THE REACH — THE ASCENSION TRIAL AWAITS',
    'the S-gate row reads as the trial for an eligible save', String(R5.line));

  // =======================================================================
  // STEP 8 — SOVEREIGN'S WILL (browser). The verify clause verbatim: a run
  // with 12 fielded shadows, HOLD/HUNT/FOCUS producing three DISTINCT target
  // selections, and Legion Step's recall-detonate-reform cycle disposing and
  // rebuilding nothing — the meshes persist; only positions and HP change.
  // Plus the contextual slot: tap = LEGION, hold = BIND, and the shipped
  // tap-is-Bind verbatim for everyone else.
  // =======================================================================
  section('SOVEREIGN\'S WILL  (browser: 12 fielded, three stances, the LEGION cycle, the slot)');
  const W1 = await evalGame(page, async (g) => {
    const out = {};
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    const realSummon = g._trySummon;
    try {
      g.renderer.render = () => {};
      g.fx.damageNumber = () => {};
      const SH = await import('/src/game/shadows.js');
      // Become the SHADOW ARCHON. The real writer (ascend via the offer row)
      // ran in the step-7 section; here the path itself is the subject.
      g.save.archon = 'shadow';
      g.save.level = 60;
      g.save.autoStats = 59;
      g.save.stats = { str: 200, agi: 200, vit: 200, int: 200, per: 200 };
      // Pin the tier whose maxFieldShadows is 12 and lock the governor: the
      // harness page's adaptive tier must not shrink the column the verify
      // clause names mid-probe.
      g.quality.setTier('ultra');
      g.quality.locked = true;
      while (g.save.shadows.roster.length < 14) {
        SH.addShadow(g.save, SH.makeShadow(g.save, { type: 'grunt', level: 30 }));
      }
      Math.random = () => 0.42;
      g.startGate(0);
      Math.random = realRandom;
      for (let i = 0; i < 5; i++) g.update(1 / 60);
      // earned 2 + 60/8 + 259/40 = 15, +2 path, clamped to the hard 12
      out.fieldCap = g.fieldCapacity();
      out.fielded = g.shadows.length;
      out.stanceDefault = g.shadowStance;

      // Silence the wave machinery and supply known bodies.
      g.killed = -99999;
      g.spawned = 99999;
      Math.random = () => 0.99;
      for (const e of [...g.enemies]) g._killEnemy(e);
      Math.random = realRandom;
      const p = g.player;
      const V = p.pos.constructor;
      const mk = (x, z) => {
        g._spawnEnemy(new V(x, 0, z), 'grunt');
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0; e.attackCd = 9e9; e.hp = 1e6; e.maxHp = 1e6;
        return e;
      };
      const A = mk(p.pos.x + 3, p.pos.z);        // closing on the player
      const B = mk(p.pos.x + 20, p.pos.z);       // far, near the scout
      const C = mk(p.pos.x + 10, p.pos.z + 10);  // the mark
      const idOf = (e) => (e === A ? 'A' : e === B ? 'B' : e === C ? 'C' : e ? '?' : null);
      const far = g.shadows[0];                  // a scout parked out by B
      far.pos.set(p.pos.x + 18, 0, p.pos.z);
      const near_ = g.shadows[1];                // a soldier at the player's side
      near_.pos.set(p.pos.x + 1, 0, p.pos.z + 1);

      // --- three stances, three DISTINCT selections ----------------------
      out.guard = { bad: g.setShadowStance('charge'), hold: g.setShadowStance('hold') };
      out.hold = { far: idOf(g._shadowTarget(far)), near: idOf(g._shadowTarget(near_)) };
      g.setShadowStance('hunt');
      out.hunt = { far: idOf(g._shadowTarget(far)), near: idOf(g._shadowTarget(near_)) };
      g.setShadowStance('focus');
      out.focusUnmarked = idOf(g._shadowTarget(far));
      Math.random = () => 0.99;                  // the marking hit must not crit-kill
      g._damageEnemy(C, 1);
      Math.random = realRandom;
      out.focus = { far: idOf(g._shadowTarget(far)), near: idOf(g._shadowTarget(near_)) };
      // The migration pin: any other save runs the shipped HUNT verbatim and
      // the setter refuses.
      g.save.archon = 'flame';
      out.pinned = { far: idOf(g._shadowTarget(far)), set: g.setShadowStance('hold') };
      g.save.archon = 'shadow';

      // --- LEGION STEP: recall-detonate-reform, nothing rebuilt ----------
      g.setShadowStance('hold');
      for (let i = 0; i < g.shadows.length; i++) {
        const s = g.shadows[i];
        s.pos.set(p.pos.x - 30 + i * 2.5, 0, p.pos.z - 30);  // out of every blast
        s.telegraph = 0; s.swing = 0;
      }
      const det = g.shadows[3];
      det.pos.set(B.pos.x + 1, 0, B.pos.z);      // only B inside ITS 4 m
      const meshes = g.shadows.map((s) => s.mesh);
      const uuids = g.shadows.map((s) => s.mesh.uuid);
      const hpB = B.hp;
      const hpA = A.hp;
      g._legionT = 0;
      Math.random = () => 0.99;                  // pin crits off the detonation
      g._tryLegionStep();
      Math.random = realRandom;
      out.legion = {
        cd: g._legionT,
        bLost: hpB - B.hp,
        // The save is BINDER-classed here (the step-7 section swore it), so
        // the expected figure carries the class strike seam (fixup 1):
        // s.atk x 60% x armour term x _classShadowMul. If the runtime ever
        // drops the class factor again, bLost falls ~18% short of this.
        expected: Math.max(1, Math.round(det.atk * 0.6
          * (g._armorBonus?.shadowDmgMul || 1) * (g._classShadowMul || 1))),
        aUntouched: A.hp === hpA,
        allOut: g.shadows.every((s) => s.reform > 0 && s.mesh.visible === false),
        count: g.shadows.length,
      };
      const hpB2 = B.hp;
      g._tryLegionStep();                        // inside the cooldown: inert
      out.legion.secondInert = B.hp === hpB2 && g._legionT > 44;

      // Walk the stagger. Real hit-stop runs once soldiers re-engage, so the
      // mid-point asserts the SHAPE (some back, some still out), not a count.
      p.invuln = 9e9;
      for (let i = 0; i < Math.ceil(3.0 * 60); i++) g.update(1 / 60);
      out.mid = {
        back: g.shadows.filter((s) => !(s.reform > 0)).length,
        out: g.shadows.filter((s) => s.reform > 0).length,
      };
      for (let i = 0; i < Math.ceil(10 * 60); i++) g.update(1 / 60);
      out.after = {
        count: g.shadows.length,
        allBack: g.shadows.every((s) => !(s.reform > 0) && s.mesh.visible === true),
        sameMeshes: g.shadows.every((s, i) => s.mesh === meshes[i] && s.mesh.uuid === uuids[i]),
        hpHalf: g.shadows.every((s) => s.hp === Math.max(1, Math.round(s.maxHp * 0.5))),
        nearPlayer: g.shadows.every((s) => s.pos.distanceTo(p.pos) < 10),
        cdRunning: g._legionT > 30 && g._legionT < 45,
      };

      // --- the contextual slot: tap = LEGION, hold = BIND ----------------
      let binds = 0;
      g._trySummon = () => { binds++; };
      g._legionT = 0;
      g.input.pressed.add('summon'); g.input.held.add('summon');
      g.update(1 / 60);
      g.input.held.delete('summon');             // released well inside 0.35 s
      g.update(1 / 60);
      out.tap = { legionFired: g._legionT > 40, binds };
      g.input.pressed.add('summon'); g.input.held.add('summon');
      for (let i = 0; i < 60; i++) g.update(1 / 60);   // held past the threshold
      g.input.held.delete('summon');
      g.update(1 / 60);
      out.held = { binds };
      g.save.archon = 'flame';                   // any other save: shipped verbatim
      g.input.pressed.add('summon'); g.input.held.add('summon');
      g.update(1 / 60);
      g.input.held.delete('summon');
      out.plain = { binds };
      g.save.archon = 'shadow';

      // --- the HUD wipe reads LEGION's clock while it runs ---------------
      g._legionT = 30;
      g.ui.updateHud(g);
      const btn = document.querySelector('.skill-btn[data-skill="summon"]');
      out.hud = {
        tag: btn?.querySelector('.archon-tag')?.textContent,
        wipe: btn?.querySelector('.cd')?.style.transform,
      };
    } finally {
      Math.random = realRandom;
      g.renderer.render = realRender;
      g._trySummon = realSummon;
    }
    return out;
  });
  ok(W1.fieldCap === 12 && W1.fielded === 12,
    'the SHADOW ARCHON fields 12 (earned 15 + path 2, hard-clamped)', JSON.stringify({ cap: W1.fieldCap, fielded: W1.fielded }));
  ok(W1.stanceDefault === 'hunt', 'a fresh run opens in HUNT — the shipped behaviour is the default');
  ok(W1.guard.bad === false && W1.guard.hold === true,
    'the stance setter takes the three states and nothing else', JSON.stringify(W1.guard));
  ok(W1.hold.far === 'A' && W1.hold.near === 'A',
    'HOLD: every soldier answers what closes on the PLAYER — the far scout ignores the enemy at its feet', JSON.stringify(W1.hold));
  ok(W1.hunt.far === 'B' && W1.hunt.near === 'A',
    'HUNT: each soldier takes its own nearest — the shipped selection', JSON.stringify(W1.hunt));
  ok(W1.focus.far === 'C' && W1.focus.near === 'C',
    'FOCUS: every blade on the last-hit mark, wherever the soldier stands', JSON.stringify(W1.focus));
  ok(W1.focusUnmarked === 'B',
    'an unmarked FOCUS falls back to HUNT — "focus" never reads as "stand down"', String(W1.focusUnmarked));
  ok(W1.pinned.far === 'B' && W1.pinned.set === false,
    'any non-shadow save is pinned to HUNT and the setter refuses — the migration pin', JSON.stringify(W1.pinned));
  ok(near(W1.legion.cd, 45, 1e-9), 'LEGION STEP arms the 45 s cooldown', String(W1.legion.cd));
  ok(W1.legion.bLost === W1.legion.expected && W1.legion.aUntouched,
    'each soldier detonates for 60% of its OWN atk in 4 m — one blast reached B, none reached A',
    JSON.stringify(W1.legion));
  ok(W1.legion.allOut && W1.legion.count === 12,
    'the whole column recalls: off the field, invisible, still twelve records', JSON.stringify(W1.legion));
  ok(W1.legion.secondInert === true, 'a second press inside the cooldown is inert');
  ok(W1.mid.back >= 1 && W1.mid.out >= 1,
    'the re-form staggers over 6 s: mid-walk some soldiers stand while others are still out', JSON.stringify(W1.mid));
  ok(W1.after.count === 12 && W1.after.allBack,
    'the full column re-forms', JSON.stringify(W1.after));
  ok(W1.after.sameMeshes,
    'NOTHING DISPOSED, NOTHING REBUILT: every soldier wears the same mesh object it detonated with (the verify clause)');
  ok(W1.after.hpHalf, 're-formed soldiers stand at 50% HP — the cycle\'s price');
  ok(W1.after.nearPlayer, 'and they re-form at the player\'s side, not where they died');
  ok(W1.after.cdRunning, 'with the 45 s still running down');
  ok(W1.tap.legionFired && W1.tap.binds === 0,
    'the slot\'s TAP is LEGION STEP — a sub-0.35 s press fires the ultimate, not Bind', JSON.stringify(W1.tap));
  ok(W1.held.binds === 1, 'holding past 0.35 s fires BIND — the skill moved, it did not vanish', JSON.stringify(W1.held));
  ok(W1.plain.binds === 2, 'every other save keeps the shipped tap-is-Bind verbatim', JSON.stringify(W1.plain));
  ok(W1.hud.tag === 'LEGION' && typeof W1.hud.wipe === 'string' && W1.hud.wipe.startsWith('scaleY(0.66'),
    'the slot wears the LEGION tag and its wipe reads Legion\'s clock (30/45)', JSON.stringify(W1.hud));

  // The player-visible moment: detonation rings under a re-fired Legion Step,
  // rendered for real and read by eye alongside the stance panel below.
  const W2 = await evalGame(page, (g) => {
    const realRender = g.renderer.render;
    g.renderer.render = () => {};
    g.player.invuln = 9e9;
    for (let i = 0; i < 900; i++) g.update(1 / 60);  // let the column re-form
    g.renderer.render = realRender;
    g._legionT = 0;
    g._tryLegionStep();
    g.update(1 / 60); g.update(1 / 60);
    return { fired: g._legionT > 40, out: g.shadows.filter((s) => s.reform > 0).length };
  });
  ok(W2.fired && W2.out === 12, 'the screenshot frame catches a live detonation', JSON.stringify(W2));
  await page.screenshot({ path: shotPath('legion-step.png') });

  // The stance toggle on the shadow panel (now the STATS SHEET's ARMY
  // block, opened via the ticker's STATS button — the V3 paper-doll port
  // replaced the old GEAR/STATS/SETS tabs with persistent rails + these
  // sheets; see src/ui/inventoryui.js's header comment).
  const W3 = await evalGame(page, (g) => {
    g.invUI.open();
    g.invUI._sheet = 'stats';
    g.invUI.render();
    const rowOf = () => document.querySelector('#invOverlayBody .stanceGroup');
    const row = rowOf();
    const out = { present: Boolean(row) };
    if (row) {
      out.labels = [...row.querySelectorAll('button')].map((b) => b.textContent);
      const focusBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'FOCUS');
      focusBtn.click();                          // re-renders the sheet
      out.stance = g.shadowStance;
      out.onAfter = rowOf()?.querySelector('button.on')?.textContent;
    }
    // The toggle lives at the bottom of the ARMY block — scroll it into the
    // screenshot frame (the sheet owns its one scroll box now).
    const col = document.querySelector('#invOverlayBody .scrollCol');
    if (col) col.scrollTop = col.scrollHeight;
    return out;
  });
  ok(W3.present && JSON.stringify(W3.labels) === JSON.stringify(['HOLD', 'HUNT', 'FOCUS']),
    'the three-way toggle sits on the shadow panel', JSON.stringify(W3));
  ok(W3.stance === 'focus' && W3.onAfter === 'FOCUS',
    'tapping a stance commands the live run and the panel says so', JSON.stringify(W3));
  await page.screenshot({ path: shotPath('sovereign-stances.png') });
  await evalGame(page, (g) => { g.invUI.close(); return true; });

  // =======================================================================
  // STEP 9 — FLAME IN PLAY (browser). The verify clause's DPS-model cases at
  // the hooks that own them: Pyre per player hit, the burn tick, combustion
  // exact to the model (220% x atk, self excluded, 4-seed on neighbours,
  // Ember +2/consumed stack), the cascade, expiry restoring the tint, and
  // Ashfall off the contextual slot — plus the draw-call budget: a real
  // rendered frame with the path at its busiest lands within +2 of the same
  // scene unascended.
  // =======================================================================
  section('FLAME IN PLAY  (browser: Pyre, combustion, cascade, Ashfall, the +2 draw budget)');
  const F1 = await evalGame(page, async (g) => {
    const out = {};
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    const realNums = g.fx.damageNumber;
    try {
      g.fx.damageNumber = () => {};
      g.quality.setTier('ultra');
      g.quality.locked = true;
      // No masteries in the way: every stat's SPENT points at zero keeps all
      // fifteen procs cold, so the deltas below are the path's alone.
      g.save.level = 60;
      g.save.autoStats = 59;
      g.save.stats = { str: 0, agi: 0, vit: 0, int: 0, per: 0 };
      g.save.shadows.roster.length = 0;
      const p = g.player;
      const V = p.pos.constructor;
      const mk = (x, z, hp) => {
        g._spawnEnemy(new V(x, 0, z), 'grunt');
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0; e.attackCd = 9e9; e.hp = hp; e.maxHp = hp;
        return e;
      };
      const settle = (frames) => {
        g.renderer.render = () => {};
        for (let i = 0; i < frames; i++) g.update(1 / 60);
        g.renderer.render = realRender;
      };
      const measure = (a, b, c) => {
        // One fixed layout for both runs: full HP (bars hidden), pinned
        // spots, one sim step, then an EXPLICIT synchronous render with
        // autoReset off — the dungeon-test technique, so the number is the
        // whole colour+depth frame and ours alone (the game's own composite
        // ends on an overlay pass whose counter reads 1).
        // The world clock is pinned to NOON for the counted frame: the two
        // measures run minutes of real time apart and the day/night staging
        // adds and removes sky draws across dusk — a ±8-call swing that has
        // nothing to do with the path under test (observed once as baseline
        // 102 vs busy-path 94).
        if (g.worldClock) g.worldClock.hours = 12;
        for (const [e, x] of [[a, 3], [b, 6], [c, 9]]) {
          e.hp = e.maxHp;
          e.pos.set(p.pos.x + x, 0, p.pos.z + 3);
          e.vel.set(0, 0, 0);
        }
        // invuln OFF for the counted frame: the i-frame flicker toggles the
        // whole player body (and its shadow passes) on sim-time parity —
        // ±10 calls of pure noise between the two measures, in a random
        // direction per run. Nothing can strike here (every attackCd is
        // pinned at 9e9), so the frame is safe as well as deterministic.
        p.invuln = 0;
        g.renderer.render = () => {};
        g.update(1 / 60);
        g.renderer.render = realRender;
        const r = g.renderer;
        r.info.autoReset = false;
        r.info.reset();
        r.render(g.scene, g.camera);
        const calls = r.info.render.calls;
        r.info.autoReset = true;
        return calls;
      };
      const boot = (archon) => {
        g.save.archon = archon;
        Math.random = () => 0.42;
        g.startGate(0);
        Math.random = realRandom;
        for (let i = 0; i < 5; i++) g.update(1 / 60);
        g.killed = -99999;
        g.spawned = 99999;
        Math.random = () => 0.99;
        for (const e of [...g.enemies]) g._killEnemy(e);
        Math.random = realRandom;
        const A = mk(p.pos.x + 3, p.pos.z, 1e6);
        const B = mk(p.pos.x + 6, p.pos.z, 1e6);
        const C = mk(p.pos.x + 20, p.pos.z, 1e6);
        return { A, B, C };
      };

      // ---- the unascended baseline frame --------------------------------
      const base = boot(null);
      settle(120);
      out.baseCalls = measure(base.A, base.B, base.C);
      out.baseClean = { pool: Boolean(g._archonFx), path: g._archonPath?.key ?? null };

      // ---- the flame run ------------------------------------------------
      const { A, B, C } = boot('flame');
      out.bound = {
        path: g._archonPath?.key,
        pool: Boolean(g._archonFx),
        poolMax: g._archonFx?.max,
        meterMax: g._archonRes?.max,
      };
      const st = g._archonStatus;
      const atk = g.derived.atk;
      Math.random = () => 0.99;               // no crits anywhere below

      // Pyre per player hit + the tint on the body. One sim frame first: the
      // tint is applied by the per-frame pass on stack CHANGE, not at the
      // hit — per-frame material writes are what the change-detection saves.
      for (let i = 0; i < 9; i++) g._damageEnemy(A, 10);
      out.stacks9 = st.get(A, 'pyre');
      settle(1);
      const tm = A._tintMats && A._tintMats[0];
      out.tint = {
        n: A._archonTintN,
        built: Boolean(tm),
        // pyre pulls green/blue down and never red — orange over the base.
        shifted: Boolean(tm) && tm.m.color.g < tm.g - 1e-4,
        cUntinted: (C._archonTintN || 0) === 0,
      };

      // The burn: 2%/stack/s of atk, half-second ticks. Drain hit-stop
      // first so the measured second is a real second.
      settle(30);
      const tick9 = Math.max(1, Math.round(atk * 0.02 * 9 * 0.5));
      const hpA0 = A.hp;
      p.invuln = 9e9;
      settle(60);
      out.burn = { lost: hpA0 - A.hp, tick: tick9 };

      // Combustion: B inside the 4 m, C far outside. The 10th stack fires
      // it; the hit itself is 10 raw so A's own ledger shows exactly the
      // hit — no self-blast.
      A.pos.set(p.pos.x + 3, 0, p.pos.z);
      B.pos.set(A.pos.x + 2, 0, A.pos.z);
      C.pos.set(p.pos.x + 40, 0, p.pos.z);
      const hpB0 = B.hp;
      const hpA1 = A.hp;
      g._damageEnemy(A, 10);
      out.combust = {
        aStacks: st.get(A, 'pyre'),
        bStacks: st.get(B, 'pyre'),
        cStacks: st.get(C, 'pyre'),
        bLost: hpB0 - B.hp,
        expected: Math.max(1, Math.round(atk * 2.2)),
        aLostOnHit: hpA1 - A.hp,
        ember: g._archonRes.value,
      };

      // Cascade: B rides its 4-seed to 10; its blast seeds A AND C if C
      // stands close — one chain link, +20 more Ember.
      C.pos.set(B.pos.x + 2, 0, B.pos.z);
      for (let i = 0; i < 6; i++) g._damageEnemy(B, 10);
      out.cascade = {
        bReset: st.get(B, 'pyre'),
        aSeeded: st.get(A, 'pyre'),
        cSeeded: st.get(C, 'pyre'),
        ember: g._archonRes.value,
      };

      // Expiry: 4+ hitless seconds cool the room and the tint restores to
      // the base palette exactly.
      settle(Math.ceil(4.4 * 60));
      out.expiry = {
        a: st.get(A, 'pyre'),
        c: st.get(C, 'pyre'),
        tintN: A._archonTintN,
        restored: Boolean(tm) && Math.abs(tm.m.color.g - tm.g) < 1e-6,
      };

      // Ashfall off the slot TAP (hold stays Bind — asserted in the frost
      // section below). Ember pinned full, combat pinned live so the decay
      // cannot nibble the 100 before the release lands.
      g._combatT = 999;
      g._archonRes.set(100);
      g.renderer.render = () => {};
      g.update(1 / 60);
      out.hudResource = g.save.archonState.resource;
      g.input.pressed.add('summon');
      g.input.held.add('summon');
      g.update(1 / 60);
      g.input.held.delete('summon');
      g.update(1 / 60);
      g.renderer.render = realRender;
      out.ashfall = {
        live: g._ashfall.t > 6.5 && g._ashfall.t <= 8,
        spent: g._archonRes.value === 0,
        atPlayer: Math.hypot(g._ashfall.x - p.pos.x, g._ashfall.z - p.pos.z) < 2,
      };
      // A and B inside the ring burn and gain a stack per second; C outside
      // (40 m) takes nothing.
      A.pos.set(p.pos.x + 4, 0, p.pos.z);
      B.pos.set(p.pos.x - 4, 0, p.pos.z);
      C.pos.set(p.pos.x + 40, 0, p.pos.z);
      const hpA2 = A.hp;
      const hpC2 = C.hp;
      settle(66);
      out.ashBurn = {
        aLost: A.hp < hpA2,
        aStacks: st.get(A, 'pyre'),
        cLost: hpC2 - C.hp,
        cStacks: st.get(C, 'pyre'),
        stillLive: g._ashfall.t > 5,
        discUp: (g._groundFx?.discMesh.count || 0) >= 1,
        quadsUp: g._archonFx.liveCount > 0,
      };

      // The budget frame: path at its busiest — Ashfall down, stacks
      // burning, quads live — against the unascended baseline of the SAME
      // pinned scene. +2 is the whole allowance (pool + the shared decal
      // channel's disc mesh).
      out.pathCalls = measure(A, B, C);
      out.tag = (g.ui.updateHud(g),
        document.querySelector('.skill-btn[data-skill="summon"] .archon-tag')?.textContent);
    } finally {
      Math.random = realRandom;
      g.renderer.render = realRender;
      g.fx.damageNumber = realNums;
    }
    return out;
  });
  ok(F1.baseClean.pool === false && F1.baseClean.path === null,
    'an unascended run binds no path and builds no pool — the baseline is honest', JSON.stringify(F1.baseClean));
  ok(F1.bound.path === 'flame' && F1.bound.pool && F1.bound.poolMax === 64 && F1.bound.meterMax === 100,
    'the flame run binds the path, the 64-quad pool and the 100-Ember meter', JSON.stringify(F1.bound));
  ok(F1.stacks9 === 9, 'nine player hits are nine Pyre stacks', String(F1.stacks9));
  ok(F1.tint.built && F1.tint.shifted && F1.tint.n === 9 && F1.tint.cUntinted,
    'the body tints toward the ember hue — a material COLOUR, cloned per enemy, nobody else touched',
    JSON.stringify(F1.tint));
  ok(F1.burn.lost >= F1.burn.tick && F1.burn.lost <= F1.burn.tick * 3,
    'the 9-stack burn ticks 2%/stack/s of atk in half-second banks', JSON.stringify(F1.burn));
  ok(F1.combust.aStacks === 0 && F1.combust.bStacks === 4 && F1.combust.cStacks === 0,
    'the 10th stack combusts: A resets to ZERO, the 4-seed lands on B in range and misses C',
    JSON.stringify(F1.combust));
  ok(F1.combust.bLost === F1.combust.expected,
    'the blast is 220% of atk exactly (crit pinned off)', JSON.stringify(F1.combust));
  ok(F1.combust.aLostOnHit === 10,
    'the combusting target takes the HIT and no self-blast — its ledger shows the 10 and nothing else',
    String(F1.combust.aLostOnHit));
  ok(F1.combust.ember === 20, 'Ember banks +2 per consumed stack: one full load = 20', String(F1.combust.ember));
  ok(F1.cascade.bReset === 0 && F1.cascade.aSeeded >= 4 && F1.cascade.cSeeded === 4
    && F1.cascade.ember === 40,
    'the cascade: B rides its seed to 10, combusts, seeds BOTH neighbours, banks 20 more',
    JSON.stringify(F1.cascade));
  ok(F1.expiry.a === 0 && F1.expiry.c === 0 && F1.expiry.tintN === 0 && F1.expiry.restored,
    'four hitless seconds cool every stack and the tint restores the base palette EXACTLY',
    JSON.stringify(F1.expiry));
  ok(F1.hudResource >= 99, 'the HUD meter reads the same bank the sim spends', String(F1.hudResource));
  ok(F1.ashfall.live && F1.ashfall.spent && F1.ashfall.atPlayer,
    'the slot TAP casts ASHFALL: 8 s, cast at the caster, the full 100 spent', JSON.stringify(F1.ashfall));
  ok(F1.ashBurn.aLost && F1.ashBurn.aStacks >= 1 && F1.ashBurn.cLost === 0 && F1.ashBurn.cStacks === 0,
    'the floor burns what stands in it — damage plus a stack a second — and nothing outside the 14 m',
    JSON.stringify(F1.ashBurn));
  ok(F1.ashBurn.discUp && F1.ashBurn.quadsUp && F1.ashBurn.stillLive,
    'Ashfall rides the SHARED decal channel and the one quad pool', JSON.stringify(F1.ashBurn));
  ok(F1.pathCalls - F1.baseCalls <= 2 && F1.pathCalls > F1.baseCalls,
    `the whole path costs <= +2 draw calls at its busiest (${F1.baseCalls} -> ${F1.pathCalls})`);
  ok(F1.tag === 'ASHFALL', 'the slot wears the ASHFALL tag', String(F1.tag));

  // The player-visible moment, rendered for real and read by eye.
  await evalGame(page, (g) => {
    g.player.invuln = 9e9;
    for (let i = 0; i < 3; i++) g.update(1 / 60);
    return true;
  });
  await page.screenshot({ path: shotPath('flame-archon.png') });

  // =======================================================================
  // STEP 9 — FROST IN PLAY (browser). Rime slowing the action clock, the
  // Barrier absorbing before HP, the 10th-stack freeze (+45% taken, stagger
  // hold), the shatter split with its re-seed, the manual detonate on the
  // slot, thaw clearing the stacks, and Bind alive on the hold.
  // =======================================================================
  section('FROST IN PLAY  (browser: Rime slow, Barrier, freeze, shatter, the detonate slot)');
  const FR1 = await evalGame(page, async (g) => {
    const out = {};
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    const realNums = g.fx.damageNumber;
    const realSummon = g._trySummon;
    try {
      g.fx.damageNumber = () => {};
      g.renderer.render = () => {};
      const p = g.player;
      const V = p.pos.constructor;
      g.save.archon = 'frost';
      Math.random = () => 0.42;
      g.startGate(0);
      Math.random = realRandom;
      for (let i = 0; i < 5; i++) g.update(1 / 60);
      g.killed = -99999;
      g.spawned = 99999;
      Math.random = () => 0.99;
      for (const e of [...g.enemies]) g._killEnemy(e);
      const mk = (x, z) => {
        g._spawnEnemy(new V(x, 0, z), 'grunt');
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0; e.attackCd = 9e9; e.hp = 1000; e.maxHp = 1000;
        return e;
      };
      const A = mk(p.pos.x + 3, p.pos.z);
      const B = mk(p.pos.x + 6, p.pos.z);
      const C = mk(p.pos.x + 20, p.pos.z);
      const st = g._archonStatus;
      out.bound = { path: g._archonPath?.key, meterMax: g._archonRes?.max, poolMax: g._archonFx?.max };

      // Nine hits: nine stacks, 9 x 0.4 = 3.6 %-points of Barrier.
      p.invuln = 9e9;
      for (let i = 0; i < 9; i++) g._damageEnemy(A, 10);
      out.rime = { stacks: st.get(A, 'rime'), barrier: g._archonRes.value };

      // The slow: 9 stacks = -54% on the ACTION clock. Half a simulated
      // second moves A's attack cooldown 0.5 x 0.46 = 0.23. (Hit-stop
      // drained first so the measured window is clean; combat pinned so the
      // Barrier holds still for its own assert later.)
      for (let i = 0; i < 40; i++) g.update(1 / 60);
      g._combatT = 999;
      A.attackCd = 1.0;
      B.attackCd = 1.0;
      for (let i = 0; i < 30; i++) g.update(1 / 60);
      out.slow = {
        slowed: A.attackCd,
        clean: B.attackCd,
        expectSlowed: 1.0 - 0.5 * 0.46,
        expectClean: 0.5,
      };
      A.attackCd = 9e9;
      B.attackCd = 9e9;

      // The Barrier absorbs BEFORE HP: 10 %-points on a full bar eats the
      // whole blow, HP untouched, the spend read back off the meter.
      p.hp = g.derived.maxHp;
      p.invuln = 0;
      p._dodgeT = 0;
      const bar0 = 10;
      g._archonRes.set(bar0);
      g._damagePlayer(50, null);
      out.absorb = {
        hpLost: g.derived.maxHp - p.hp,
        spent: bar0 - g._archonRes.value,
        someSpent: g._archonRes.value < bar0,
      };
      p.invuln = 9e9;

      // The 10th stack freezes: 2.2 s, the stagger hold, stacks held, and
      // +45% taken inside the window (145 on a 1,000-HP body sits just
      // UNDER the 150 shatter line on purpose).
      g._damageEnemy(A, 10);
      out.freeze = {
        frozenT: A.frozenT,
        stagger: A.stagger,
        held: st.get(A, 'rime'),
      };
      const hpF = A.hp;
      g._damageEnemy(A, 100);
      out.frozenBonus = { lost: A.hp >= 0 ? hpF - A.hp : hpF, expected: Math.round(100 * 1.45) };
      const barF = g._archonRes.value;
      g._damageEnemy(A, 1);                     // frozen: no stacks, no Barrier
      out.frozenNoFarm = { stacks: st.get(A, 'rime'), barrierDelta: g._archonRes.value - barF };

      // SHATTER: a 200 hit lands 290 — over the 15% line — and 300% of it
      // splits to the one neighbour inside 6 m, +3 Rime; the far body and
      // the freeze itself are both gone.
      A.pos.set(p.pos.x + 3, 0, p.pos.z);
      B.pos.set(A.pos.x + 3, 0, A.pos.z);
      C.pos.set(p.pos.x + 40, 0, p.pos.z);
      const hpB1 = B.hp;
      const hpC1 = C.hp;
      g._damageEnemy(A, 200);
      out.shatter = {
        aThawed: !(A.frozenT > 0),
        aStacks: st.get(A, 'rime'),
        bLost: hpB1 - B.hp,
        expected: Math.round(Math.round(200 * 1.45) * 3.0),
        bRime: st.get(B, 'rime'),
        cLost: hpC1 - C.hp,
      };

      // The manual detonate off the slot: freeze B, stand A beside it, tap.
      // The 20%-of-maxHp strike rides the ordinary funnel (x1.45 frozen) and
      // shatters — B thaws, A eats the split.
      for (let i = 0; i < 7; i++) g._damageEnemy(B, 1);   // 3 + 7 -> frozen
      out.preDetonate = { bFrozen: B.frozenT > 0 };
      // Topped up so the 290 detonate is survivable and B's ledger reads the
      // full expected number rather than a death-clamped one.
      B.hp = B.maxHp;
      A.hp = A.maxHp;
      A.pos.set(B.pos.x + 3, 0, B.pos.z);
      let binds = 0;
      g._trySummon = () => { binds++; };
      const hpB2 = B.hp;
      const hpA2 = A.hp;
      g.input.pressed.add('summon');
      g.input.held.add('summon');
      g.update(1 / 60);
      g.input.held.delete('summon');
      g.update(1 / 60);
      const detHit = Math.round(1000 * 0.2 * 1.45);
      out.detonate = {
        binds,
        bThawed: !(B.frozenT > 0),
        bLost: hpB2 - B.hp,
        expected: detHit,
        aLost: hpA2 - A.hp,
        aExpected: Math.round(detHit * 3.0),
        aRime: st.get(A, 'rime'),
      };
      // And the HOLD is still Bind — the skill moved, it did not vanish.
      g.input.pressed.add('summon');
      g.input.held.add('summon');
      for (let i = 0; i < 30; i++) g.update(1 / 60);
      g.input.held.delete('summon');
      g.update(1 / 60);
      out.hold = { binds };

      // Thaw: a freeze left alone expires and the stacks leave with it.
      for (let i = 0; i < 3; i++) g._damageEnemy(A, 1);   // A: 3 + 3 = 6... top up to freeze
      for (let i = 0; i < 10; i++) { if (st.get(A, 'rime') < 10) g._damageEnemy(A, 1); }
      out.preThaw = { frozen: A.frozenT > 0, stacks: st.get(A, 'rime') };
      for (let i = 0; i < Math.ceil(2.4 * 60); i++) g.update(1 / 60);
      out.thaw = { frozen: A.frozenT > 0, stacks: st.get(A, 'rime') };

      // The HUD: BARRIER meter named and the SHATTER tag on the slot.
      g.ui.updateHud(g);
      out.hud = {
        tag: document.querySelector('.skill-btn[data-skill="summon"] .archon-tag')?.textContent,
        meterName: document.querySelector('#archonMeter b')?.textContent,
      };

      // Leave a frozen body on screen for the eye: freeze C close in.
      C.pos.set(p.pos.x + 4, 0, p.pos.z + 1);
      for (let i = 0; i < 10; i++) g._damageEnemy(C, 1);
      out.shotReady = C.frozenT > 0;
    } finally {
      Math.random = realRandom;
      g.renderer.render = realRender;
      g.fx.damageNumber = realNums;
      g._trySummon = realSummon;
    }
    return out;
  });
  ok(FR1.bound.path === 'frost' && FR1.bound.meterMax === 35 && FR1.bound.poolMax === 48,
    'the frost run binds the path, the 35% Barrier meter and the 48-shard pool', JSON.stringify(FR1.bound));
  ok(FR1.rime.stacks === 9 && near(FR1.rime.barrier, 3.6, 1e-6),
    'nine hits: nine Rime, 3.6 %-points of Barrier (0.4 per stack applied)', JSON.stringify(FR1.rime));
  ok(Math.abs(FR1.slow.slowed - FR1.slow.expectSlowed) < 0.03
    && Math.abs(FR1.slow.clean - FR1.slow.expectClean) < 0.03,
    'nine stacks slow the ACTION clock by 54% while a clean body runs realtime', JSON.stringify(FR1.slow));
  ok(FR1.absorb.hpLost === 0 && FR1.absorb.someSpent && FR1.absorb.spent > 0 && FR1.absorb.spent < 5,
    'the Barrier absorbs BEFORE HP and pays exactly the hit\'s percent off the meter', JSON.stringify(FR1.absorb));
  ok(near(FR1.freeze.frozenT, 2.2, 1e-6) && FR1.freeze.stagger >= 2.2 && FR1.freeze.held === 10,
    'the 10th stack freezes solid: 2.2 s on the existing stagger hold, stacks held', JSON.stringify(FR1.freeze));
  ok(FR1.frozenBonus.lost === FR1.frozenBonus.expected,
    'a frozen enemy takes +45% (145 on the pinned 100 — just under the shatter line)', JSON.stringify(FR1.frozenBonus));
  ok(FR1.frozenNoFarm.stacks === 10 && FR1.frozenNoFarm.barrierDelta === 0,
    'hits on a frozen body farm no stacks and no Barrier — the freeze is the payoff, not a battery',
    JSON.stringify(FR1.frozenNoFarm));
  ok(FR1.shatter.aThawed && FR1.shatter.aStacks === 0,
    'the shatter spends the freeze: thawed, stacks gone', JSON.stringify(FR1.shatter));
  ok(FR1.shatter.bLost === FR1.shatter.expected && FR1.shatter.bRime === 3 && FR1.shatter.cLost === 0,
    '300% of THE HIT splits to the 6 m neighbour with +3 Rime; the far body feels nothing',
    JSON.stringify(FR1.shatter));
  ok(FR1.detonate.binds === 0 && FR1.preDetonate.bFrozen && FR1.detonate.bThawed
    && FR1.detonate.bLost === FR1.detonate.expected,
    'the slot TAP detonates the nearest frozen target for 20% of ITS max HP x1.45 — and is not Bind',
    JSON.stringify(FR1.detonate));
  ok(FR1.detonate.aLost === FR1.detonate.aExpected && FR1.detonate.aRime === 3,
    'and the detonate IS a shatter: the neighbour eats the 300% split and the re-seed',
    JSON.stringify(FR1.detonate));
  ok(FR1.hold.binds === 1, 'holding past 0.35 s still fires BIND on the frost slot', String(FR1.hold.binds));
  ok(FR1.preThaw.frozen && FR1.preThaw.stacks === 10 && !FR1.thaw.frozen && FR1.thaw.stacks === 0,
    'an untouched freeze thaws at 2.2 s and the stacks clear with it — spec wording verbatim',
    JSON.stringify({ pre: FR1.preThaw, post: FR1.thaw }));
  ok(FR1.hud.tag === 'SHATTER' && FR1.hud.meterName === 'FROST ARCHON',
    'the slot wears the SHATTER tag and the vitals meter names the path', JSON.stringify(FR1.hud));
  ok(FR1.shotReady, 'a frozen body stands ready for the screenshot frame');

  await evalGame(page, (g) => {
    g.player.invuln = 9e9;
    for (let i = 0; i < 3; i++) g.update(1 / 60);
    return true;
  });
  await page.screenshot({ path: shotPath('frost-archon.png') });

  // =======================================================================
  // STEP 10 — STORM IN PLAY (browser). Charge from real distance travelled
  // and its stationary decay, Arc at the hit funnel (4-discharge, 4-chain
  // cap, 8 m, 176-model damage), Tempest Step off the slot tap (spent in
  // full, no regen, dash cd zero, attack cd zero, the 90% dash bolt) and the
  // 14 u/s HARD CEILING under every stacked speed term — the step's explicit
  // verify clause.
  // =======================================================================
  section('STORM IN PLAY  (browser: Charge odometer, Arc chains, Tempest Step, the 14 u/s ceiling)');
  const ST1 = await evalGame(page, async (g) => {
    const out = {};
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    const realNums = g.fx.damageNumber;
    try {
      g.fx.damageNumber = () => {};
      g.quality.setTier('ultra');
      g.quality.locked = true;
      g.save.level = 60;
      g.save.autoStats = 59;
      g.save.stats = { str: 0, agi: 0, vit: 0, int: 0, per: 0 };
      g.save.shadows.roster.length = 0;
      const p = g.player;
      const V = p.pos.constructor;
      const mk = (x, z, hp, key = 'grunt') => {
        g._spawnEnemy(new V(x, 0, z), key);
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0; e.attackCd = 9e9; e.hp = hp; e.maxHp = hp;
        e.pos.set(x, 0, z);
        return e;
      };
      const settle = (frames) => {
        g.renderer.render = () => {};
        for (let i = 0; i < frames; i++) g.update(1 / 60);
        g.renderer.render = realRender;
      };
      g.save.archon = 'storm';
      Math.random = () => 0.42;
      g.startGate(0);
      Math.random = realRandom;
      for (let i = 0; i < 5; i++) g.update(1 / 60);
      g.killed = -99999;
      g.spawned = 99999;
      Math.random = () => 0.99;
      for (const e of [...g.enemies]) g._killEnemy(e);
      Math.random = realRandom;
      out.bound = {
        path: g._archonPath?.key,
        pool: Boolean(g._archonFx),
        poolMax: g._archonFx?.max,
        segment: g._archonFx?.segment,
        meterMax: g._archonRes?.max,
      };

      // Charge from REAL distance: hold a direction for two seconds and
      // compare the bank against the body's own displacement (+1 per metre).
      // 's' (screen-down, world +z) — the E arena's entry portal stands a
      // step behind spawn on -z and walking 'w' just pins you against it.
      p.invuln = 9e9;
      g._archonRes.set(0);
      const x0 = p.pos.x;
      const z0 = p.pos.z;
      g.input.keys.add('s');
      settle(120);
      g.input.keys.delete('s');
      const walked = Math.hypot(p.pos.x - x0, p.pos.z - z0);
      out.charge = { walked, value: g._archonRes.value };
      // Decay 8/s while STATIONARY — even mid-combat (the clock that guards
      // Ember/Barrier does not guard Charge; movement does).
      g._combatT = 999;
      settle(10);                          // damp to a standstill first
      const v0c = g._archonRes.value;
      settle(60);
      out.decay = { before: v0c, after: g._archonRes.value };

      // ARC at the hit funnel: B and C flank the target inside 8 m, D far
      // out. One landed hit = -10 Charge, 55% x atk to each neighbour.
      const A = mk(p.pos.x + 3, p.pos.z, 1e6);
      const B = mk(p.pos.x + 5, p.pos.z, 1e6);
      const C = mk(p.pos.x + 1, p.pos.z + 1.5, 1e6);
      const D = mk(p.pos.x + 40, p.pos.z, 1e6);
      const atk = g.derived.atk;
      Math.random = () => 0.99;            // no crits anywhere below
      g._archonRes.set(200);
      const hpA0 = A.hp; const hpB0 = B.hp; const hpC0 = C.hp; const hpD0 = D.hp;
      g._damageEnemy(A, 10);
      out.arc = {
        aLost: hpA0 - A.hp,
        bLost: hpB0 - B.hp,
        cLost: hpC0 - C.hp,
        dLost: hpD0 - D.hp,
        expected: Math.max(1, Math.round(atk * 0.55)),
        charge: g._archonRes.value,
        segs: g._archonFx.liveCount,
      };
      // Below the discharge floor: no chain, no spend — a stopped storm is
      // a plain hunter.
      g._archonRes.set(3);
      const hpB1 = B.hp;
      g._damageEnemy(A, 10);
      out.dry = { bLost: hpB1 - B.hp, charge: g._archonRes.value };
      // The 4-chain cap: five bodies in radius, exactly four struck (array
      // order — deterministic under the seeded spawn stream).
      const E2 = mk(A.pos.x, A.pos.z + 2, 1e6);
      const F2 = mk(A.pos.x, A.pos.z - 2, 1e6);
      const G2 = mk(A.pos.x + 3, A.pos.z + 1, 1e6);
      g._archonRes.set(200);
      const roomPre = [B, C, E2, F2, G2].map((e) => e.hp);
      g._damageEnemy(A, 10);
      out.cap = {
        struck: [B, C, E2, F2, G2].filter((e, i) => e.hp < roomPre[i]).length,
        last: G2.hp === roomPre[4],
        charge: g._archonRes.value,
      };

      // TEMPEST STEP off the slot TAP: the full 200 spent, 6 s window. The
      // tap happens ON THE MOVE — a stationary storm's bank decays 8/s by
      // design ("standing still is the only way to be weak"), and while
      // moving the +1/metre gain holds a full bar pinned at its clamp, which
      // is exactly how the ultimate is reached in play.
      g._archonRes.set(200);
      g.input.keys.add('s');
      g.renderer.render = () => {};
      g.update(1 / 60);
      g.input.pressed.add('summon');
      g.input.held.add('summon');
      g.update(1 / 60);
      g.input.held.delete('summon');
      g.update(1 / 60);
      out.tempest = { t: g._tempestT, charge: g._archonRes.value };
      // No regen for the duration: half a second of hard running banks zero.
      for (let i = 0; i < 30; i++) g.update(1 / 60);
      g.input.keys.delete('s');
      out.noRegen = { charge: g._archonRes.value, t: g._tempestT };
      // THE CEILING (the step's verify clause): speed pinned absurd, five
      // TEMPO stacks stacked on top of the live Tempest — 14.0, never more.
      const realSpeed = g.derived.speed;
      g.derived.speed = 30;
      g._tempoStacks = 5;
      g.update(1 / 60);
      out.cap14 = p.body.maxSpeed;
      g._tempoStacks = 0;
      g.derived.speed = realSpeed;
      g.update(1 / 60);
      out.tempestSpeed = { maxSpeed: p.body.maxSpeed, expected: Math.min(14, realSpeed * 1.55) };
      // Basic attacks ignore their cooldown while the window runs.
      p.attack.cd = 5;
      g.update(1 / 60);
      out.atkCd = p.attack.cd;
      // Every dash leaves a 90%-atk bolt down its line, and dash cd is zero.
      p.yaw = 0;
      const T = mk(p.pos.x, p.pos.z + 4, 1e6);
      p.cds.dash = 0;
      const hpT0 = T.hp;
      g.input.pressed.add('dash');
      g.update(1 / 60);
      out.bolt = {
        lost: hpT0 - T.hp,
        expected: Math.max(1, Math.round(atk * 0.9)),
        dashCd: p.cds.dash,
        segs: g._archonFx.liveCount,
      };
      g.renderer.render = realRender;
      out.hud = (g.ui.updateHud(g), {
        tag: document.querySelector('.skill-btn[data-skill="summon"] .archon-tag')?.textContent,
        meterName: document.querySelector('#archonMeter b')?.textContent,
        meterText: document.querySelector('#archonMeter')?.textContent || '',
      });
    } finally {
      Math.random = realRandom;
      g.renderer.render = realRender;
      g.fx.damageNumber = realNums;
    }
    return out;
  });
  ok(ST1.bound.path === 'storm' && ST1.bound.pool && ST1.bound.poolMax === 40
    && ST1.bound.segment === true && ST1.bound.meterMax === 200,
    'the storm run binds the path, the 40-SEGMENT pool and the 200-Charge meter', JSON.stringify(ST1.bound));
  ok(ST1.charge.value > 6 && Math.abs(ST1.charge.value - ST1.charge.walked) < ST1.charge.walked * 0.25 + 1,
    `Charge banks +1 per metre of REAL ground covered (walked ${ST1.charge.walked.toFixed(1)} m, banked ${ST1.charge.value.toFixed(1)})`);
  ok(ST1.decay.before - ST1.decay.after > 5 && ST1.decay.before - ST1.decay.after < 9.5,
    'and decays 8/s while stationary — combat does not shield it, only motion does', JSON.stringify(ST1.decay));
  ok(ST1.arc.aLost === 10 && ST1.arc.bLost === ST1.arc.expected && ST1.arc.cLost === ST1.arc.expected
    && ST1.arc.dLost === 0,
    'ARC: the hit chains 55% x atk to both 8 m neighbours and misses the far body — the target takes only its own hit',
    JSON.stringify(ST1.arc));
  ok(ST1.arc.charge === 196 && ST1.arc.segs >= 2,
    'one landed hit discharges exactly 4 and lights the chain segments', JSON.stringify(ST1.arc));
  ok(ST1.dry.bLost === 0 && ST1.dry.charge === 3,
    'below 4 Charge: no chain, no spend — a Storm Archon who stops moving is a plain hunter',
    JSON.stringify(ST1.dry));
  ok(ST1.cap.struck === 4 && ST1.cap.last && ST1.cap.charge === 196,
    'five bodies in radius: exactly FOUR chains land, one discharge pays for all of them', JSON.stringify(ST1.cap));
  ok(ST1.tempest.t > 5.5 && ST1.tempest.t <= 6 && ST1.tempest.charge === 0,
    'the slot TAP fires TEMPEST STEP: 6 s window, the full 200 spent', JSON.stringify(ST1.tempest));
  ok(ST1.noRegen.charge === 0 && ST1.noRegen.t > 0,
    'and Charge cannot regenerate for the duration — half a second of hard running banks nothing',
    JSON.stringify(ST1.noRegen));
  ok(ST1.cap14 === 14,
    `THE CEILING: derived.speed 30 x Tempest x 5 TEMPO stacks clamps to exactly 14.0 u/s (got ${ST1.cap14})`);
  ok(near(ST1.tempestSpeed.maxSpeed, ST1.tempestSpeed.expected, 1e-6),
    'at the build\'s real speed the +55% applies under the same one clamp', JSON.stringify(ST1.tempestSpeed));
  ok(ST1.atkCd === 0, 'basic attacks ignore their cooldown inside the window', String(ST1.atkCd));
  ok(ST1.bolt.lost === ST1.bolt.expected && ST1.bolt.dashCd === 0 && ST1.bolt.segs >= 1,
    'a Tempest dash costs no cooldown and leaves a 90%-atk bolt along its line', JSON.stringify(ST1.bolt));
  ok(ST1.hud.tag === 'TEMPEST' && ST1.hud.meterName === 'STORM ARCHON' && /CHARGE/.test(ST1.hud.meterText),
    'the slot wears the TEMPEST tag and the vitals meter reads CHARGE', JSON.stringify(ST1.hud));

  // The player-visible moment: long-lived chain segments strung across the
  // room, rendered for real and read by eye. invuln OFF so the i-frame
  // blink cannot hide the hunter in the frame (every attacker is pinned at
  // attackCd 9e9, so nothing can actually strike).
  await evalGame(page, (g) => {
    const p = g.player;
    g.player.invuln = 0;
    const V = p.pos.constructor;
    const a = new V(); const b = new V();
    for (const e of g.enemies) {
      if (e.hp <= 0) continue;
      a.copy(p.pos).setY(1.2);
      b.copy(e.pos).setY(1.1);
      g._archonFx?.spawnSegment(a, b, { life: 6, scale: 1.6 });
      g.fx.burst(e.pos.clone().setY(1.1), 8, 0x9dd8ff, { speed: 4, up: 2, life: 0.5 });
    }
    for (let i = 0; i < 3; i++) g.update(1 / 60);
    return true;
  });
  // Same 120 s budget as the REACH shot: the segment pool's first render can
  // land in a SwiftShader shader-compile frame.
  await page.screenshot({ path: shotPath('storm-archon.png'), timeout: 120000 });

  // =======================================================================
  // STEP 10 — BEAST IN PLAY (browser). The pact bound through the shipped
  // extraction verb (elite corpse -> band slot), the 4.0x fielded beast
  // consuming the whole allowance, re-fielding on gate entry, and the 12 s
  // Wild Form: rig swap with the material traverse (ZERO emissive, ZERO
  // GLOW_LAYER on the player root — the step's verify clause), 2.2x/1.5x/
  // 40% numbers, no skills, kill-shortened cooldown, disposal-clean end.
  // =======================================================================
  section('BEAST IN PLAY  (browser: pact bind, 4.0x beast, whole-field allowance, Wild Form)');
  const BE1 = await evalGame(page, async (g) => {
    const SH = await import('/src/game/shadows.js');
    const CR = await import('/src/render/creatures.js');
    const GL = await import('/src/render/glow.js');
    const out = {};
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    const realNums = g.fx.damageNumber;
    try {
      g.fx.damageNumber = () => {};
      g.quality.setTier('ultra');
      g.quality.locked = true;
      g.save.level = 60;
      g.save.autoStats = 59;
      g.save.stats = { str: 0, agi: 0, vit: 0, int: 0, per: 0 };
      g.save.shadows.roster.length = 0;
      g.save.archonState.pacts.length = 0;
      // Bare body: earlier sections leave armour on this save, and the 40%
      // flat-DR assert below wants the mitigation chain's other terms at
      // zero so 100 -> 60 is exact.
      g.save.equipment = null;
      const p = g.player;
      const V = p.pos.constructor;
      const mk = (x, z, hp, key = 'grunt') => {
        g._spawnEnemy(new V(x, 0, z), key);
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0; e.attackCd = 9e9; e.hp = hp; e.maxHp = hp;
        e.pos.set(x, 0, z);
        return e;
      };
      const boot = () => {
        Math.random = () => 0.42;
        g.startGate(0);
        Math.random = realRandom;
        for (let i = 0; i < 5; i++) g.update(1 / 60);
        g.killed = -99999;
        g.spawned = 99999;
        Math.random = () => 0.99;
        for (const e of [...g.enemies]) g._killEnemy(e);
        Math.random = realRandom;
      };
      g.save.archon = 'beast';
      boot();
      out.bound = {
        path: g._archonPath?.key,
        pool: Boolean(g._archonFx),         // BEAST builds NO pool
        meterMax: g._archonRes?.max,
        shadows: g.shadows.length,
      };

      // Bind a PACT from an elite corpse through the shipped verb.
      p.invuln = 9e9;
      const brute = mk(p.pos.x + 3, p.pos.z, 50, 'brute');
      const bruteLevel = brute.level;
      Math.random = () => 0.99;             // no drops off the kill
      g._damageEnemy(brute, 5000);
      Math.random = () => 0;                // extraction cannot fail
      p.cds.summon = 0;
      g._trySummon();
      Math.random = realRandom;
      const pact = g.save.archonState.pacts[0];
      const model = pact ? SH.shadowCombat(g.save, pact) : null;
      const beast = g.shadows[0];
      out.pact = {
        count: g.save.archonState.pacts.length,
        band: pact?.band,
        grade: pact?.grade,
        type: pact?.type,
        level: pact?.level === bruteLevel,
        fielded: g.shadows.length,
        isPact: Boolean(beast?.isPact),
        hp: beast?.maxHp,
        hpExpected: model ? Math.floor(model.hp * 4.0) : -1,
        atkOk: Boolean(beast) && Math.abs(beast.atk - model.atk * 4.0) < 1e-6,
      };
      // The whole-field allowance: a trash corpse cannot add a soldier
      // beside the beast, whatever the capacity number says.
      const grunt = mk(p.pos.x - 3, p.pos.z, 50, 'grunt');
      Math.random = () => 0.99;
      g._damageEnemy(grunt, 5000);
      Math.random = () => 0;
      p.cds.summon = 0;
      g._trySummon();
      Math.random = realRandom;
      out.allowance = { fielded: g.shadows.length, roster: g.save.shadows.roster.length };
      // Re-entry fields the pact again, not the roster.
      boot();
      out.refield = { fielded: g.shadows.length, isPact: Boolean(g.shadows[0]?.isPact) };

      // WILD FORM. Give the pact a real creature key when the pack is up so
      // the rig swap is the real SkeletonUtils path; without the pack the
      // form still runs on the hunter's own body (the procedural fallback).
      out.creaturesReady = CR.creaturesReady();
      if (out.creaturesReady) {
        const cast = CR.creatureFor('wildtest', { archetype: 'brute', rank: 'E' });
        if (cast) g.save.archonState.pacts[0].creature = cast.key;
      }
      g.renderer.render = () => {};
      p.cds.summon = 0;
      g.input.pressed.add('summon');
      g.input.held.add('summon');
      g.update(1 / 60);
      g.input.held.delete('summon');
      g.update(1 / 60);
      out.wild = {
        t: g._wildT,
        cd: g._wildCd,
        mesh: Boolean(g._wildMesh),
        baseHidden: g._wildMesh ? g.player.mesh.visible === false : null,
      };
      if (g._wildMesh) g.__wildUuid = g._wildMesh.uuid;
      // THE TRAVERSE (verify clause): zero emissive, zero GLOW_LAYER
      // membership, on every object and material of the visible player root.
      const root = g._wildMesh || g.player.mesh;
      let mats = 0; let emissiveBad = 0; let glowBad = 0;
      root.traverse((o) => {
        if (o.layers && (o.layers.mask & (1 << GL.GLOW_LAYER)) !== 0) glowBad++;
        if (!o.material) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
          if (!m) continue;
          mats++;
          if (m.emissive && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0)) emissiveBad++;
        }
      });
      out.traverse = { mats, emissiveBad, glowBad };
      // 2.2x attack power at the one funnel; 40% flat DR at the other.
      const X = mk(p.pos.x + 2, p.pos.z, 1e6);
      Math.random = () => 0.99;
      const hpX0 = X.hp;
      g._damageEnemy(X, 100);
      out.wildAtk = { lost: hpX0 - X.hp, expected: Math.round(100 * 2.2) };
      // Differential, not absolute: the level-60 body has real vitality DR
      // from auto-stats (derive's dr rides effective vit), so the exact
      // number is "the same hit, x0.60 after the round" — the form's own
      // term isolated from the rest of the mitigation chain.
      p.hp = g.derived.maxHp;
      p.invuln = 0;
      p._dodgeT = 0;
      const wtHold = g._wildT;
      g._wildT = 0;
      g._damagePlayer(100, X.pos);
      const bareLost = Math.round(g.derived.maxHp - p.hp);
      g._wildT = wtHold;
      p.hp = g.derived.maxHp;
      p.invuln = 0;
      p._dodgeT = 0;
      g._damagePlayer(100, X.pos);
      out.wildDr = {
        bare: bareLost,
        lost: Math.round(g.derived.maxHp - p.hp),
        expected: Math.max(1, Math.round(bareLost * 0.6)),
      };
      p.invuln = 9e9;
      // The ceiling again, worn as a beast: 1.5x under the same one clamp.
      const realSpeed = g.derived.speed;
      g.derived.speed = 8;
      g.update(1 / 60);
      out.wildSpeed = { maxSpeed: p.body.maxSpeed, expected: 12 };
      g.derived.speed = 30;
      g.update(1 / 60);
      out.wildCap = p.body.maxSpeed;
      g.derived.speed = realSpeed;
      // No skills: the buttons refuse while transformed.
      p.cds.slash = 0; p.cds.nova = 0; p.cds.summon = 0;
      p.mp = g.derived.maxMp;
      const mp0 = p.mp;
      g._trySlash(); g._tryNova(); g._trySummon();
      out.noSkills = {
        slash: p.cds.slash, nova: p.cds.nova, summon: p.cds.summon, mp: p.mp === mp0,
      };
      // A kill made transformed shortens the cooldown by exactly 6 s.
      const K = mk(p.pos.x - 2, p.pos.z, 10);
      const cd0 = g._wildCd;
      g._damageEnemy(K, 5000);
      out.killCd = { before: cd0, after: g._wildCd };
      Math.random = realRandom;
      g.renderer.render = realRender;
      out.hud = (g.ui.updateHud(g), {
        tag: document.querySelector('.skill-btn[data-skill="summon"] .archon-tag')?.textContent,
      });
    } finally {
      Math.random = realRandom;
      g.renderer.render = realRender;
      g.fx.damageNumber = realNums;
    }
    return out;
  });
  ok(BE1.bound.path === 'beast' && BE1.bound.pool === false && BE1.bound.meterMax === 0,
    'the beast run binds the path, builds NO pool and lights no meter — zero new pools, no bank',
    JSON.stringify(BE1.bound));
  ok(BE1.pact.count === 1 && BE1.pact.band === 0 && BE1.pact.grade === 5
    && BE1.pact.type === 'brute' && BE1.pact.level,
    'the elite corpse binds a PACT: band 0 (E gate), WARLORD grade, the corpse\'s own archetype and level',
    JSON.stringify(BE1.pact));
  ok(BE1.pact.fielded === 1 && BE1.pact.isPact
    && BE1.pact.hp === BE1.pact.hpExpected && BE1.pact.atkOk,
    'ONE beast fields at exactly 4.0x its shadowCombat numbers', JSON.stringify(BE1.pact));
  ok(BE1.allowance.fielded === 1 && BE1.allowance.roster === 0,
    'the pact consumes the ENTIRE field allowance — a trash corpse adds nobody beside it',
    JSON.stringify(BE1.allowance));
  ok(BE1.refield.fielded === 1 && BE1.refield.isPact,
    're-entering a gate fields the pact again, not the roster', JSON.stringify(BE1.refield));
  ok(BE1.wild.t > 11.5 && BE1.wild.t <= 12 && near(BE1.wild.cd, 90, 0.2),
    'the slot TAP is WILD FORM: 12 s window, the 90 s cooldown starts', JSON.stringify(BE1.wild));
  ok(BE1.creaturesReady && BE1.wild.mesh && BE1.wild.baseHidden === true,
    'the pack is up and the form is a REAL rig swap: borrowed body on, base body hidden',
    JSON.stringify({ ready: BE1.creaturesReady, wild: BE1.wild }));
  ok(BE1.traverse.mats > 0 && BE1.traverse.emissiveBad === 0 && BE1.traverse.glowBad === 0,
    `THE TRAVERSE: ${BE1.traverse.mats} materials on the transformed player root — zero emissive, zero GLOW_LAYER`,
    JSON.stringify(BE1.traverse));
  ok(BE1.wildAtk.lost === BE1.wildAtk.expected,
    'Wild Form hits for 2.2x through the one damage funnel (100 -> 220, crit pinned off)',
    JSON.stringify(BE1.wildAtk));
  ok(BE1.wildDr.lost === BE1.wildDr.expected && BE1.wildDr.bare > BE1.wildDr.lost,
    'and takes exactly 40% less through the one mitigation site (same hit, x0.60 after the round)',
    JSON.stringify(BE1.wildDr));
  ok(near(BE1.wildSpeed.maxSpeed, 12, 1e-6) && BE1.wildCap === 14,
    'speed 1.5x under the SAME 14 u/s ceiling (8 -> 12; 30 -> clamped 14)',
    JSON.stringify({ speed: BE1.wildSpeed, cap: BE1.wildCap }));
  ok(BE1.noSkills.slash === 0 && BE1.noSkills.nova === 0 && BE1.noSkills.summon === 0 && BE1.noSkills.mp,
    'no skills and no items: Ruin, Nova and Bind all refuse while transformed', JSON.stringify(BE1.noSkills));
  ok(near(BE1.killCd.before - BE1.killCd.after, 6, 1e-6),
    'a kill made while transformed takes exactly 6 s off the cooldown', JSON.stringify(BE1.killCd));
  ok(BE1.hud.tag === 'WILD', 'the slot wears the WILD tag', String(BE1.hud.tag));

  // The player-visible moment: the transformed hunter beside the pact beast.
  // invuln OFF for the frame — the i-frame blink would hide the wild body.
  await evalGame(page, (g) => {
    g.player.invuln = 0;
    for (let i = 0; i < 3; i++) g.update(1 / 60);
    return true;
  });
  // 120 s: the wild body's cloned creature materials compile on first render.
  await page.screenshot({ path: shotPath('beast-archon.png'), timeout: 120000 });

  // The form's END is disposal-clean, and a boss corpse exists for the pact.
  const BE2 = await evalGame(page, async (g) => {
    const out = {};
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    const realNums = g.fx.damageNumber;
    try {
      g.fx.damageNumber = () => {};
      g.renderer.render = () => {};
      g.player.invuln = 9e9;
      // Ride the window out (the live RAF may already have ended it — both
      // routes land in _endWildForm, which is the point).
      for (let i = 0; i < Math.ceil(13 * 60); i++) g.update(1 / 60);
      // invuln off + one clean frame BEFORE the visibility read: the i-frame
      // blink writes p.mesh.visible every frame and would coin-flip it.
      g.player.invuln = 0;
      g.update(1 / 60);
      out.ended = {
        t: g._wildT,
        mesh: Boolean(g._wildMesh),
        baseVisible: g.player.mesh.visible,
        gone: g.__wildUuid ? !g.scene.getObjectByProperty('uuid', g.__wildUuid) : true,
        cd: g._wildCd,
      };
      // Cooldown still running: the tap refuses a re-entry.
      g._tryWildForm();
      out.reentry = { t: g._wildT };
      // A boss corpse exists for a BEAST ARCHON — the pact spec's other bind
      // source — and binding it REPLACES the band slot.
      Math.random = () => 0.99;
      g._spawnBoss();
      const boss = g.boss;
      boss.spawning = 0;
      g._damageEnemy(boss, boss.hp + boss.maxHp + 1e9);
      out.bossCorpse = g.corpses.some((c) => c.tierWeight === 'boss');
      // Bind range is 14 m and the boss chamber is across the arena — walk
      // to the corpse (teleport in test time) before the bind verb.
      const bc = g.corpses.find((c) => c.tierWeight === 'boss');
      if (bc) g.player.pos.copy(bc.pos);
      Math.random = () => 0;
      g.player.cds.summon = 0;
      g._trySummon();
      Math.random = realRandom;
      out.bossPact = {
        count: g.save.archonState.pacts.length,
        type: g.save.archonState.pacts[0]?.type,
        band: g.save.archonState.pacts[0]?.band,
      };
    } finally {
      Math.random = realRandom;
      g.renderer.render = realRender;
      g.fx.damageNumber = realNums;
    }
    return out;
  });
  ok(BE2.ended.t === 0 && !BE2.ended.mesh && BE2.ended.baseVisible && BE2.ended.gone,
    'the window closes clean: base body back, borrowed rig out of the scene and disposed',
    JSON.stringify(BE2.ended));
  ok(BE2.ended.cd > 0 && BE2.reentry.t === 0,
    'and the cooldown holds the door — the tap refuses a re-entry', JSON.stringify({ cd: BE2.ended.cd, re: BE2.reentry }));
  ok(BE2.bossCorpse === true,
    'a boss leaves a corpse for a BEAST ARCHON (the pact spec\'s "boss or elite corpse")');
  ok(BE2.bossPact.count === 1 && BE2.bossPact.type === 'boss' && BE2.bossPact.band === 0,
    'binding the boss corpse REPLACES the band slot — five slots, one per band, no hoard',
    JSON.stringify(BE2.bossPact));

  ok(pageErrors.length === 0, 'no page errors during the browser sections', pageErrors.slice(0, 2).join('\n'));
} finally {
  await browser.close();
  await server.stop();
}

// ------------------------------------------------------------------ report
console.log('');
if (fails.length) {
  fails.forEach((f) => console.log(`  FAIL  ${f}`));
  console.log(`\nPASS ${pass}   FAIL ${fails.length}`);
  process.exit(1);
}
console.log(`PASS ${pass}   FAIL 0`);
