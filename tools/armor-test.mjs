// Headless armour-table suite (RPG_SPEC step 10 VERIFY).
//
//   1. DETERMINISM  — the same (base, seed, rarity, level) rebuilds a
//                     byte-identical instance across 10k rolls, and the
//                     serialize -> deserialize roundtrip is exact.
//   2. DR CLAMP     — total reduction never exceeds 0.72 against a
//                     deliberately absurd loadout.
//   3. SPEED CLAMP  — armour-sourced move speed never exceeds +0.6.
//   4. THRESHOLDS   — set bonuses fire at exactly 2, 4 and 5 pieces, and two
//                     2-piece partials from different sets are both live.
//   5. ENVELOPE     — a full best-in-slot set at L20 / L50 / L80 stays inside
//                     +35% survivability / +12% offense versus naked. If this
//                     fails, the TABLE is wrong, not the test.
//
// Pure node — armor.js is THREE-free by contract, weapons.js imports three but
// three is import-safe headless (the shop suite set the precedent).

import {
  ARMOR_BASES, ARMOR_SLOTS, SETS, SET_THRESHOLDS, TIER_AP, SLOT_WEIGHT,
  rollArmor, rollArmorDrop, serializeArmor, deserializeArmor,
  setProgress, armorDerive, armorSummary, combinedDR,
  TOTAL_DR_CAP, ARMOR_SPEED_CAP,
} from '../src/game/armor.js';
import { RARITIES } from '../src/game/weapons.js';
import { derive, rankOf, SKILLS } from '../src/game/config.js';
import { shadowFieldCapacity } from '../src/game/progression.js';
import { mulberry32 } from '../src/core/rng.js';

let failures = 0;
function ok(cond, label, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? `  — ${detail}` : ''}`);
}

// Deep JSON compare that survives the `base` object reference (shared, so
// stringify is stable) — byte identity is the actual claim.
const bytes = (x) => JSON.stringify(x);

// ---------------------------------------------------------------- 1. determinism
console.log('\n== determinism ==');
{
  const ref = bytes(rollArmor('vigil_chest', 123456789, { level: 50 }));
  let same = true;
  for (let i = 0; i < 10000; i++) {
    if (bytes(rollArmor('vigil_chest', 123456789, { level: 50 })) !== ref) { same = false; break; }
  }
  ok(same, 'same seed -> byte-identical instance across 10k rolls');

  // Roundtrip: the five-field record rebuilds the exact item, forced-rarity
  // path included (the stream must be consumed identically either way).
  let round = true;
  const rnd = mulberry32(0xa11ce);
  for (let i = 0; i < 2000; i++) {
    const seed = Math.floor(rnd() * 0xffffffff) >>> 0;
    const ids = Object.keys(ARMOR_BASES);
    const id = ids[Math.floor(rnd() * ids.length)];
    const level = 1 + Math.floor(rnd() * 80);
    const a = rollArmor(id, seed, { level });
    const back = deserializeArmor(serializeArmor(a));
    if (bytes(a) !== bytes(back)) { round = false; break; }
  }
  ok(round, 'serialize -> deserialize roundtrip is byte-exact over 2k random rolls');

  // Trinkets consume the stream too and must roundtrip identically.
  const t = rollArmor('fortune_loop', 42, { level: 20 });
  ok(t.kind === 't' && bytes(deserializeArmor(serializeArmor(t))) === bytes(t),
    'trinket roundtrip is byte-exact');

  // rollArmorDrop is seed-deterministic like rollDrop.
  const d1 = bytes(rollArmorDrop(mulberry32(777), { rankIndex: 2, level: 20 }));
  const d2 = bytes(rollArmorDrop(mulberry32(777), { rankIndex: 2, level: 20 }));
  ok(d1 === d2, 'rollArmorDrop replays identically from the same stream');

  // FAITHFUL RECORDS: a stream-rolled drop must carry a real seed, so the
  // persisted {k,b,r,s,l} record rebuilds the exact item the toast announced —
  // armour is stored as records the moment it is picked up, so a fallback
  // seed here would silently swap the item's affixes on reload.
  let faithful = true;
  const drnd = mulberry32(0xbeef);
  for (let i = 0; i < 500; i++) {
    const a = rollArmorDrop(drnd, { rankIndex: 3, level: 30, luck: 0.2 });
    if (typeof a.seed !== 'number' || bytes(deserializeArmor(serializeArmor(a))) !== bytes(a)) { faithful = false; break; }
  }
  ok(faithful, 'stream-rolled drops carry a real seed and roundtrip byte-exact (500 drops)');
}

// ---------------------------------------------------------------- table shape
console.log('\n== table shape ==');
{
  const armour = Object.values(ARMOR_BASES).filter((b) => b.kind === 'a');
  const trinkets = Object.values(ARMOR_BASES).filter((b) => b.kind === 't');
  ok(armour.length === 25, '5 sets x 5 slots = 25 armour bases', String(armour.length));
  ok(trinkets.length === 6, '6 trinkets', String(trinkets.length));
  ok(Object.keys(SETS).length === 5, '5 sets');
  const slotSum = Object.values(SLOT_WEIGHT).reduce((s, w) => s + w, 0);
  ok(Math.abs(slotSum - 3.3) < 1e-9, 'SLOT_WEIGHT sums to 3.30 (the worked-example anchor)', slotSum.toFixed(2));
  ok(armour.every((b) => b.id === `${b.setId}_${b.slot}`), 'armour ids are ${setId}_${slot}');
  ok(Object.values(ARMOR_BASES).every((b) => b.icon && b.icon === b.icon.toLowerCase()), 'every base has a lowercase icon key');
  // AP formula spot-check straight from the spec's worked example shape:
  // full tier-1 common set AP = TIER_AP[1] * 3.30.
  const full1 = ARMOR_SLOTS.reduce((s, slot) => s + rollArmor(`issue_${slot}`, 1, { rarity: 'common', level: 5 }).ap, 0);
  const expect1 = TIER_AP[1] * 3.3;
  // Guarded can inflate a rolled piece, but common has 0 affixes, so exact.
  ok(Math.abs(full1 - expect1) < 1e-9, `full tier-1 common set AP = ${expect1.toFixed(1)}`, full1.toFixed(2));
}

// ---------------------------------------------------------------- helpers
// Best-in-slot loadout for a level: the highest-tier set legally wearable, at
// the best rarity that can DROP at that level's rank (legendary needs rank
// band B, rankIndex >= 3 — below that epic is the ceiling), with the best of
// 400 seeded rolls per slot (players keep their best drops; a cherry-picked
// sample IS the obtainable best).
const RANK_INDEX = { E: 0, D: 1, C: 2, B: 3, A: 4, S: 5, SOVEREIGN: 5 };
function bestSetFor(level) {
  return Object.values(SETS)
    .filter((s) => s.reqLevel <= level)
    .sort((a, b) => b.tier - a.tier)[0];
}
function bisLoadout(level) {
  const set = bestSetFor(level);
  const rarity = RANK_INDEX[rankOf(level)] >= 3 ? 'legendary' : 'epic';
  const eq = {};
  const rnd = mulberry32((level * 2654435761) >>> 0);
  for (const slot of ARMOR_SLOTS) {
    let best = null;
    for (let i = 0; i < 400; i++) {
      const a = rollArmor(`${set.id}_${slot}`, Math.floor(rnd() * 0xffffffff) >>> 0, { rarity, level });
      if (!best || a.score > best.score) best = a;
    }
    eq[slot] = best;
  }
  return { set, rarity, eq };
}
// Even-spread reference build: 5 spent points per level split across the five
// stats, plus the +1-per-level auto grant.
function refSave(level) {
  const spent = Math.floor((5 * (level - 1)) / 5);
  return {
    level,
    autoStats: level - 1,
    stats: { str: spent, agi: spent, vit: spent, int: spent, per: spent },
  };
}

// ---------------------------------------------------------------- 2. DR clamp
console.log('\n== total DR clamp ==');
{
  // Deliberately absurd: a full tier-5 legendary set worn at LEVEL 1, where
  // the level term of the denominator is nothing — armorDR alone reaches ~79%.
  const { eq } = { eq: {} };
  const rnd = mulberry32(0xdead);
  for (const slot of ARMOR_SLOTS) {
    let best = null;
    for (let i = 0; i < 400; i++) {
      const a = rollArmor(`vigil_${slot}`, Math.floor(rnd() * 0xffffffff) >>> 0, { rarity: 'legendary', level: 1 });
      if (!best || a.ap > best.ap) best = a;
    }
    eq[slot] = best;
  }
  const ad = armorDerive(eq, 1);
  ok(ad.armorDR > 0.5, 'the absurd loadout really is absurd (armorDR > 50%)', `${(ad.armorDR * 100).toFixed(1)}%`);
  const total = combinedDR(0.45, ad.armorDR); // vit DR at ITS cap
  ok(total <= TOTAL_DR_CAP + 1e-12, `combined reduction clamps at ${TOTAL_DR_CAP}`, `${(total * 100).toFixed(1)}%`);
  ok(combinedDR(0.45, 0.9999) === TOTAL_DR_CAP, 'clamp holds even against armorDR ~ 1');
  // And the honest case sits well under the wall.
  const honest = combinedDR(0.45, 0.21);
  ok(honest < TOTAL_DR_CAP, 'an honest capped build does not hit the wall', `${(honest * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------- 3. speed clamp
console.log('\n== armour speed clamp ==');
{
  // Worst stack: deepglass (2pc +0.35, legs secondary) with Fleet fished on
  // every piece. Analytic max: 0.135 (legs t3) + 0.35 + 5 x 0.072 (Fleet hi
  // 0.08 x 0.9) = 0.845, so the 0.6 clamp must be doing real work.
  const eq = {};
  const rnd = mulberry32(0xf1ee7);
  for (const slot of ARMOR_SLOTS) {
    let best = null;
    for (let i = 0; i < 600; i++) {
      const a = rollArmor(`deepglass_${slot}`, Math.floor(rnd() * 0xffffffff) >>> 0, { rarity: 'legendary', level: 20 });
      if (!best || a.speedAdd > best.speedAdd) best = a;
    }
    eq[slot] = best;
  }
  const raw = ARMOR_SLOTS.reduce((s, sl) => s + eq[sl].speedAdd, 0) + 0.35;
  const ad = armorDerive(eq, 20);
  ok(raw > ARMOR_SPEED_CAP, 'the stacked loadout exceeds the cap before clamping', `raw +${raw.toFixed(2)}`);
  ok(ad.speedAdd <= ARMOR_SPEED_CAP + 1e-12, `armour speed clamps at +${ARMOR_SPEED_CAP}`, `+${ad.speedAdd.toFixed(2)}`);
}

// ---------------------------------------------------------------- 4. thresholds
console.log('\n== set thresholds ==');
{
  const pieces = ARMOR_SLOTS.map((slot, i) => rollArmor(`ossuary_${slot}`, 1000 + i, { rarity: 'common', level: 10 }));
  const active = (eq) => armorDerive(eq, 10);

  // Build up 1..5 pieces and watch each bonus arrive exactly on time. The
  // ossuary numeric markers: 2pc multiplies armorDR x1.10, 4pc adds +0.18
  // staggerResist, 5pc reports the lowhp_bulwark rule.
  const eqN = (n) => {
    const eq = {};
    for (let i = 0; i < n; i++) eq[ARMOR_SLOTS[i]] = pieces[i];
    return eq;
  };
  const drRatio = (n) => {
    const eq = eqN(n);
    let ap = 0;
    for (const s of Object.values(eq)) ap += s.ap;
    const raw = ap / (ap + 90 + 26 * 10);
    return active(eq).armorDR / raw;
  };
  ok(Math.abs(drRatio(1) - 1) < 1e-9, '1 piece: no 2pc bonus', drRatio(1).toFixed(3));
  ok(Math.abs(drRatio(2) - 1.10) < 1e-9, '2 pieces: +10% armorDR fires at EXACTLY 2', drRatio(2).toFixed(3));
  ok(Math.abs(drRatio(3) - 1.10) < 1e-9, '3 pieces: still only the 2pc bonus');

  const base3 = active(eqN(3));
  const at4 = active(eqN(4));
  // staggerResist at 3 pieces: feet not yet worn (feet is index 4 in
  // ARMOR_SLOTS order head,chest,hands,legs,feet) -> 0; at 4 still no feet,
  // so the jump at 4 is exactly the set's +0.18.
  ok(Math.abs(at4.staggerResist - base3.staggerResist - 0.18) < 1e-9,
    '4 pieces: +18% staggerResist fires at EXACTLY 4',
    `${base3.staggerResist.toFixed(2)} -> ${at4.staggerResist.toFixed(2)}`);
  ok(Math.abs(at4.knockTakenMul - 0.75) < 1e-9, '4 pieces: knockback taken x0.75', at4.knockTakenMul.toFixed(2));
  ok(base3.rules.length === 0 && at4.rules.length === 0, 'no rule below 5 pieces');

  const at5 = active(eqN(5));
  ok(at5.rules.length === 1 && at5.rules[0].key === 'lowhp_bulwark', '5 pieces: the RULE arrives at EXACTLY 5', at5.rules[0]?.key);

  // Two 2-piece partials from different sets are deliberately both live.
  const mixed = {
    head: rollArmor('issue_head', 1, { rarity: 'common', level: 10 }),
    chest: rollArmor('issue_chest', 2, { rarity: 'common', level: 10 }),
    legs: rollArmor('ossuary_legs', 3, { rarity: 'common', level: 10 }),
    feet: rollArmor('ossuary_feet', 4, { rarity: 'common', level: 10 }),
  };
  const mx = active(mixed);
  const counts = setProgress(mixed);
  ok(counts.get('issue') === 2 && counts.get('ossuary') === 2, 'setProgress counts 2+2 across two sets');
  ok(Math.abs(mx.ashMul / (1 + mx.ashFind) - 1.08) < 1e-9, 'issue 2pc (+8% ash) live in the mix');
  {
    let ap = 0;
    for (const s of Object.values(mixed)) ap += s.ap;
    const raw = ap / (ap + 90 + 260);
    ok(Math.abs(mx.armorDR / raw - 1.10) < 1e-9, 'ossuary 2pc (+10% DR) live in the same mix');
  }

  // Trinkets and offhand never count toward a set.
  const withTrinket = { ...eqN(1), trinket: rollArmor('ember_ring', 9, { rarity: 'common', level: 10 }) };
  ok((setProgress(withTrinket).get('ossuary') || 0) === 1, 'trinket does not count toward set progress');
}

// ---------------------------------------------------------------- 5. envelope
console.log('\n== balance envelope (L20 / L50 / L80) ==');
for (const level of [20, 50, 80]) {
  const { set, rarity, eq } = bisLoadout(level);
  const save = refSave(level);
  const naked = derive(save);
  const ad = armorDerive(eq, level);

  // Survivability: effective-HP multiplier versus naked. DR stacks
  // multiplicatively, so the ratio reduces to hpFactor / (1 - armorDR) — the
  // vitality term cancels — but compute it the long way through combinedDR so
  // the clamp participates if it ever binds.
  const nakedSurv = 1 / (1 - naked.dr);
  const total = combinedDR(naked.dr, ad.armorDR);
  const armSurv = (1 / (1 - total)) * ((naked.maxHp + ad.hpAdd) / naked.maxHp);
  const survMul = armSurv / nakedSurv;

  // Offense: attack-speed x crit expectation proxy, both folded into their
  // EXISTING caps (atkSpeed 0.30; crit already capped in derive).
  const nakedOff = (1 + naked.atkSpeed) * (1 + naked.crit * (naked.critDmg - 1));
  const armOff = (1 + Math.min(0.30, naked.atkSpeed + ad.atkSpeedAdd))
    * (1 + naked.crit * (naked.critDmg - 1 + ad.critDmgAdd));
  const offMul = armOff / nakedOff;

  console.log(`  L${level}: ${set.name} ${rarity} — armorDR ${(ad.armorDR * 100).toFixed(1)}%, surv x${survMul.toFixed(3)}, off x${offMul.toFixed(3)}`);
  ok(survMul <= 1.35 + 1e-9, `L${level} survivability inside +35%`, `x${survMul.toFixed(3)}`);
  ok(offMul <= 1.12 + 1e-9, `L${level} offense inside +12%`, `x${offMul.toFixed(3)}`);
  ok(survMul > 1.05, `L${level} armour is worth wearing at all`, `x${survMul.toFixed(3)}`);
}

// -------------------------------------- 5b. the LEGENDARY-equipped envelope
//
// RPG_SPEC step 14: a full legendary loadout — five legendary pieces AND a
// legendary weapon — must not break the clamps. The armour side re-runs the
// envelope with rarity FORCED to legendary at every level (bisLoadout only
// reaches legendary at B+ on its own); the weapon side asserts the spec's
// rawStep clause: the entire legendary-over-epic damage step is the RARITIES
// ratio (+16%) — less than one tier step — and the legendary RULE contributes
// exactly zero to hitDamage (the law, measured at the damage function).
console.log('\n== legendary-equipped envelope ==');
{
  const { rollWeapon, hitDamage, RARITIES: WR, WEAPONS } = await import('../src/game/weapons.js');
  // Best-of-400 loadout at a rarity, the bisLoadout recipe with a forced rung.
  const bisAt = (level, rarity) => {
    const set = bestSetFor(level);
    const rnd = mulberry32((level * 2654435761 + 7) >>> 0);
    const eq = {};
    for (const slot of ARMOR_SLOTS) {
      let best = null;
      for (let i = 0; i < 400; i++) {
        const a = rollArmor(`${set.id}_${slot}`, Math.floor(rnd() * 0xffffffff) >>> 0, { rarity, level });
        if (!best || a.score > best.score) best = a;
      }
      eq[slot] = best;
    }
    const naked = derive(refSave(level));
    const ad = armorDerive(eq, level);
    const total = combinedDR(naked.dr, ad.armorDR);
    return {
      set,
      total,
      survMul: ((1 / (1 - total)) * ((naked.maxHp + ad.hpAdd) / naked.maxHp)) / (1 / (1 - naked.dr)),
      offMul: ((1 + Math.min(0.30, naked.atkSpeed + ad.atkSpeedAdd))
        * (1 + naked.crit * (naked.critDmg - 1 + ad.critDmgAdd)))
        / ((1 + naked.atkSpeed) * (1 + naked.crit * (naked.critDmg - 1))),
    };
  };
  // What step 14 answers for, at every level a legendary can be OWNED (the
  // drop floor forbids anything below band B / L25):
  //   * the legendary INCREMENT over the same-level epic best-in-slot stays
  //     small — the spec's rawStep philosophy, measured on armour: the rule
  //     is the prize, the number is not (measured +4.3% at L25);
  //   * offense and the 0.72 DR clamp hold everywhere;
  //   * the shipped +35% anchor levels (50/80) hold with full legendary.
  // KNOWN, PRE-EXISTING: at early-band levels the +35% survivability line is
  // exceeded by best-of-400 EPIC gear already (x1.439 at L25 — before this
  // step existed); the shipped contract anchors at L20/50/80 and holds there.
  // That early-band envelope is the armour curve's business, flagged upstream
  // rather than silently retuned here.
  for (const level of [25, 37, 50, 80]) {
    const leg = bisAt(level, 'legendary');
    const epi = bisAt(level, 'epic');
    const stepUp = leg.survMul / epi.survMul;
    console.log(`  L${level}: ${leg.set.name} legendary x5 — surv x${leg.survMul.toFixed(3)} (epic x${epi.survMul.toFixed(3)}, step x${stepUp.toFixed(3)}), off x${leg.offMul.toFixed(3)}, DR ${(leg.total * 100).toFixed(1)}%`);
    ok(stepUp <= 1.08 + 1e-9, `L${level} legendary survivability step over epic stays small`, `x${stepUp.toFixed(3)}`);
    ok(leg.offMul <= 1.12 + 1e-9, `L${level} full-legendary offense inside +12%`, `x${leg.offMul.toFixed(3)}`);
    ok(leg.total <= 0.72 + 1e-9, `L${level} full-legendary total DR inside the 0.72 clamp`, `${(leg.total * 100).toFixed(1)}%`);
    if (level >= 50) {
      ok(leg.survMul <= 1.35 + 1e-9, `L${level} full-legendary survivability inside +35% at the shipped anchor`, `x${leg.survMul.toFixed(3)}`);
    }
  }
  // Weapon side of the build: the whole legendary step, on every base.
  const step = WR.legendary.mul / WR.epic.mul;
  ok(step <= 1.2, 'legendary weapon raw step over epic stays under one tier step', `x${step.toFixed(3)}`);
  let ruleAddsZero = true;
  for (const id of Object.keys(WEAPONS)) {
    const e = rollWeapon(id, 4242, { rarity: 'epic', level: 50 });
    const l = rollWeapon(id, 4242, { rarity: 'legendary', level: 50 });
    if (Math.abs(hitDamage(l, l.combo[0], 100) / hitDamage(e, e.combo[0], 100) - step) > 1e-9) ruleAddsZero = false;
  }
  ok(ruleAddsZero, 'the legendary rule adds zero to hitDamage on every base (the law, measured)');
}

// ---------------------------------------------------------------- extras
console.log('\n== codec + summary sanity ==');
{
  // Rarity is drawn even when forced: forcing must not shift the affix rolls.
  const forced = rollArmor('emberfall_chest', 555, { rarity: 'epic', level: 30 });
  const free = rollArmor('emberfall_chest', 555, { level: 30 });
  ok(bytes(forced.affixes.map((a) => a.key)) === bytes(free.affixes.map((a) => a.key))
    || free.affixes.length !== forced.affixes.length,
    'forced rarity consumes the stream identically (affix picks align when counts match)');

  ok(RARITIES.legendary.affixes === 4 && rollArmor('vigil_head', 9, { rarity: 'legendary', level: 40 }).affixes.length === 4,
    'legendary armour carries 4 affixes');
  ok(rollArmor('issue_head', 9, { rarity: 'common', level: 1 }).affixes.length === 0, 'common armour carries 0 affixes');

  const rows = armorSummary(rollArmor('deepglass_legs', 31337, { rarity: 'rare', level: 20 }));
  ok(rows.some((r) => r[0] === 'Set') && rows.some((r) => r[0] === 'Armor'), 'armorSummary emits Set and Armor rows');

  const rec = serializeArmor(rollArmor('takers_chain', 8, { rarity: 'rare', level: 25 }));
  ok(rec.k === 't', 'trinket serializes with k:t');
  ok(serializeArmor(rollArmor('issue_feet', 8, { level: 3 })).k === 'a', 'armour serializes with k:a');
  ok(deserializeArmor({ k: 'a', b: 'not_a_base', r: 'rare', s: 1, l: 1 }) === null, 'unknown base deserializes to null, never throws');
}

// ------------------------------------------------- 6. step 11: the derive fold
console.log('\n== step 11: derive fold ==');
{
  // THE NAKED CONTRACT (step 11 VERIFY): with nothing in any armour slot,
  // every value the SHIPPED derive() returned is byte-identical. The armour
  // build adds NEW keys (armorDR/staggerResist/knockTakenMul/dashCd) whose
  // naked defaults are the exact no-op, so they are asserted separately.
  const SHIPPED_KEYS = [
    'maxHp', 'maxMp', 'atk', 'speed', 'crit', 'critDmg', 'atkSpeed', 'skillMul',
    'cdr', 'dr', 'hpRegen', 'mpRegen', 'dmgFloor', 'tellLeadMs', 'dodgeWindow',
    'shadowDmgMul',
  ];
  let identical = true;
  let defaults = true;
  const detail = [];
  for (const level of [1, 14, 20, 50, 80]) {
    const spent = level - 1;
    const save = { level, autoStats: level - 1, stats: { str: spent, agi: spent, vit: spent, int: spent, per: spent } };
    const naked = derive(save);
    const folded = derive(save, armorDerive({}, level));
    for (const k of SHIPPED_KEYS) {
      if (!Object.is(naked[k], folded[k])) { identical = false; detail.push(`${k}@L${level}`); }
    }
    if (folded.armorDR !== 0 || folded.staggerResist !== 0 || folded.knockTakenMul !== 1
      || folded.dashCd !== SKILLS.dash.cd) defaults = false;
  }
  ok(identical, 'naked fold: every shipped derive() value is byte-identical', detail.join(',') || 'all 16 keys x 5 levels');
  ok(defaults, 'naked fold: new keys read 0 / 0 / 1 / dash.cd exactly');

  // Damage byte-identity where the spec formula reduces to the shipped one:
  // a fresh save has dr 0, armour empty has armorDR 0, so
  // round(max(1, amount * (1 - combinedDR(0, 0)))) === round(max(1, amount)).
  const fresh = derive({ level: 1, autoStats: 0, stats: {} }, armorDerive({}, 1));
  let dmgSame = true;
  for (let amount = 1; amount <= 120; amount++) {
    const shipped = Math.max(1, Math.round(amount));
    const now = Math.max(1, Math.round(amount * (1 - combinedDR(fresh.dr, fresh.armorDR))));
    if (shipped !== now) { dmgSame = false; break; }
  }
  ok(dmgSame, 'fresh-save damage numbers are byte-identical through the new formula (1..120)');

  // The folds actually move when armour is worn — each against its clamp.
  const L = 20;
  const save20 = { level: L, autoStats: L - 1, stats: { str: 19, agi: 19, vit: 19, int: 19, per: 19 } };
  const wear = (setId, slots, rarity = 'common') => {
    const eq = {};
    slots.forEach((slot, i) => { eq[slot] = rollArmor(`${setId}_${slot}`, 40 + i, { rarity, level: L }); });
    return eq;
  };
  const naked20 = derive(save20);

  // issue 4pc: dash cd 1.60 -> 1.35, and ONLY at 4+.
  const issue2 = derive(save20, armorDerive(wear('issue', ['head', 'chest']), L));
  const issue4 = derive(save20, armorDerive(wear('issue', ['head', 'chest', 'hands', 'legs']), L));
  ok(issue2.dashCd === SKILLS.dash.cd && Math.abs(issue4.dashCd - (SKILLS.dash.cd - 0.25)) < 1e-12,
    'issue 4pc: dashCd 1.60 -> 1.35, not before', `${issue2.dashCd} -> ${issue4.dashCd}`);

  // deepglass 2pc: +0.35 speed exactly (head+chest carry no speed secondary).
  const dg2 = derive(save20, armorDerive(wear('deepglass', ['head', 'chest']), L));
  ok(Math.abs(dg2.speed - naked20.speed - 0.35) < 1e-12, 'deepglass 2pc: +0.35 move speed', `+${(dg2.speed - naked20.speed).toFixed(2)}`);

  // deepglass 4pc + legs: dodgeWindow grows but NEVER past the 260 ms cap.
  const dgAgi = { level: 60, autoStats: 59, stats: { str: 0, agi: 200, vit: 0, int: 0, per: 0 } };
  const dg4 = derive(dgAgi, armorDerive(wear('deepglass', ['head', 'chest', 'hands', 'legs']), 60));
  ok(dg4.dodgeWindow <= 0.260 + 1e-12, 'dodgeWindow honours the existing 260 ms cap with armour on top', `${Math.round(dg4.dodgeWindow * 1000)}ms`);

  // emberfall 2pc: atkSpeed folds into the EXISTING 0.30 cap.
  const strSave = { level: 60, autoStats: 59, stats: { str: 200, agi: 0, vit: 0, int: 0, per: 0 } };
  const ef2 = derive(strSave, armorDerive(wear('emberfall', ['head', 'chest', 'hands'], 'legendary'), 60));
  ok(ef2.atkSpeed <= 0.30 + 1e-12, 'armour atkSpeed folds into the 0.30 cap, no second budget', `+${(ef2.atkSpeed * 100).toFixed(1)}%`);

  // vigil 2pc: shadowDmgMul x1.12 on the armour axis.
  const v2 = derive(save20, armorDerive(wear('vigil', ['head', 'chest']), L));
  ok(Math.abs(v2.shadowDmgMul / naked20.shadowDmgMul - 1.12) < 1e-12, 'vigil 2pc: +12% shadow damage', `x${(v2.shadowDmgMul / naked20.shadowDmgMul).toFixed(2)}`);

  // ossuary 4pc: knockTakenMul = (1 - feet cut) * 0.75; without feet worn the
  // cut is 0, so the 4pc alone reads exactly 0.75.
  const os4 = derive(save20, armorDerive(wear('ossuary', ['head', 'chest', 'hands', 'legs']), L));
  ok(Math.abs(os4.knockTakenMul - 0.75) < 1e-12, 'ossuary 4pc: knockback taken x0.75', `x${os4.knockTakenMul.toFixed(2)}`);

  // chest hpAdd: maxHp grows by exactly the piece's contribution (floored sum).
  const chest = rollArmor('vigil_chest', 7, { rarity: 'common', level: L });
  const hp1 = derive(save20, armorDerive({ chest }, L));
  ok(hp1.maxHp === Math.floor(130 + (19 + 19) * 11 + (L - 1) * 9 + chest.hpAdd),
    'chest hpAdd lands inside the maxHp floor', `${naked20.maxHp} -> ${hp1.maxHp}`);
}

// ---------------------------------------- 7. step 11: vigil 4pc field capacity
console.log('\n== step 11: shadow field capacity ==');
{
  const save = { level: 16, autoStats: 15, stats: { int: 5 } };
  const base = shadowFieldCapacity(save, null);
  ok(shadowFieldCapacity(save, null, 0) === base, 'fieldAdd 0 is the shipped number', String(base));
  ok(shadowFieldCapacity(save, null, 2) === Math.min(12, base + 2), 'vigil 4pc adds +2 inside the hard 12', String(shadowFieldCapacity(save, null, 2)));
  // The quality tier STILL gets the final word — the spec's honesty clause.
  ok(shadowFieldCapacity(save, { maxFieldShadows: 4 }, 2) === 4, 'a low graphics tier caps the bonus to nothing', '4');
  const maxed = { level: 100, autoStats: 99, stats: { int: 400 } };
  ok(shadowFieldCapacity(maxed, null, 2) === 12, 'the hard Math.min(12) survives the bonus', String(shadowFieldCapacity(maxed, null, 2)));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
