// RPG_SPEC step 14 — LEGENDARY GATING AND ASCENSION.
//
//   GB_PORT=5279 node tools/ascension-test.mjs [--no-shots]
//
// Two halves, the shop-test shape:
//
//   A. THE LAWS, in Node. The drop floor (rollDrop at rankIndex < 3 never
//      returns legendary across 100k seeded rolls; at >= 3 it does), the
//      downgrade's determinism (same stream, same base/seed/affixes, only the
//      label capped), the shop ceiling (no legendary on any shelf at any band,
//      rows otherwise untouched), the materials migration, the craft recipe,
//      and the LEGENDARY LAW — structurally: the verb whitelist is closed, an
//      outlaw key throws, and hitDamage over the same seed moves by exactly
//      the RARITIES.mul ratio (a rule contributes zero damage).
//
//   B. THE COUNTER, in the real game. A save with a funded recipe and an epic
//      in hand boots; the sheet shows the ASCENSION block; ASCEND consumes the
//      epic, equips the legendary (same seed), prints its rule, debits the
//      ledger; a reload proves the {b,r,s,l} codec carried it.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';
import { mulberry32 } from '../src/core/rng.js';
import { freshSave } from '../src/core/save.js';
import {
  rollDrop, rollWeapon, hitDamage, RARITIES, RARITY_ORDER, WEAPONS,
  LEGENDARY_RULES, RULE_VERBS, assertLegendaryLaw, LEGENDARY_MIN_RANK,
} from '../src/game/weapons.js';
import { shopStock } from '../src/game/shop.js';
import {
  ensureMaterials, grantEmberdust, grantSigil, canAscend, ascend,
  ascensionRecipe, FAMILY_SIGIL, SIGIL_LABEL, EMBERDUST_COST, ASH_COST,
} from '../src/game/ascension.js';

const argv = process.argv.slice(2);
const SHOTS = !argv.includes('--no-shots');

let pass = 0; let failN = 0;
const results = [];
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failN++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
  results.push({ label, ok: Boolean(cond), detail });
}

// ===========================================================================
// A. THE LAWS  (Node, no browser)
// ===========================================================================
console.log('\nA. THE LAWS\n');

// --- gate 1: the drop floor, 100k seeded rolls per side --------------------
{
  const N = 100000;
  let low = 0;
  for (let s = 1; s <= N; s++) {
    if (rollDrop(mulberry32(s), { rankIndex: 2, level: 20, luck: 0.6 }).rarity === 'legendary') low++;
  }
  ok(low === 0, `rollDrop at rankIndex < ${LEGENDARY_MIN_RANK} never returns legendary (${N} seeded rolls)`, `${low} escaped`);
  let high = 0;
  for (let s = 1; s <= N; s++) {
    if (rollDrop(mulberry32(s), { rankIndex: 3, level: 30, luck: 0.6 }).rarity === 'legendary') high++;
  }
  ok(high > 0, `rollDrop at rankIndex >= ${LEGENDARY_MIN_RANK} does return legendary`, `${high} of ${N}`);

  // Downgrade, not re-roll: where the high-rank stream rolled a legendary,
  // the low-rank stream must yield the SAME base, seed-path and first three
  // affixes, with only the label capped to epic.
  let compared = 0; let identical = true; let detail = '';
  for (let s = 1; s <= N && compared < 500; s++) {
    const free = rollWeapon('riftedge', s, { level: 30, luck: 0.6 });
    if (free.rarity !== 'legendary') continue;
    compared++;
    const capped = rollWeapon('riftedge', s, { level: 30, luck: 0.6, maxRarity: 'epic' });
    const a = free.affixes.slice(0, 3).map((x) => `${x.key}:${x.mag.toFixed(6)}`).join('|');
    const b = capped.affixes.slice(0, 3).map((x) => `${x.key}:${x.mag.toFixed(6)}`).join('|');
    if (capped.rarity !== 'epic' || a !== b) { identical = false; detail = `seed ${s}: ${capped.rarity} ${a} vs ${b}`; }
  }
  ok(identical && compared > 0, 'the downgrade consumes the stream identically (affix rolls align, label capped)', detail || `${compared} legendaries compared`);

  // The floor binds ARMOUR too (gate1 covers the whole loot path): 100k
  // seeded armour drops below band B never come up legendary, and the L20
  // balance envelope can never meet a set it could not legitimately own.
  const { rollArmorDrop } = await import('../src/game/armor.js');
  let armLow = 0; let armHigh = 0;
  for (let s = 1; s <= N; s++) {
    if (rollArmorDrop(mulberry32(s), { rankIndex: 2, level: 20, luck: 0.6 })?.rarity === 'legendary') armLow++;
  }
  for (let s = 1; s <= N; s++) {
    if (rollArmorDrop(mulberry32(s), { rankIndex: 3, level: 30, luck: 0.6 })?.rarity === 'legendary') armHigh++;
  }
  ok(armLow === 0, `rollArmorDrop at rankIndex < ${LEGENDARY_MIN_RANK} never returns legendary (${N} seeded rolls)`, `${armLow} escaped`);
  ok(armHigh > 0, `rollArmorDrop at rankIndex >= ${LEGENDARY_MIN_RANK} does`, `${armHigh} of ${N}`);
}

// --- gate 2: the shop ceiling ----------------------------------------------
{
  let legs = 0; const bands = [];
  for (const lv of [1, 8, 16, 25, 37, 53]) {
    const s = Object.assign(freshSave(), { level: lv });
    const rows = shopStock(s);
    const n = rows.filter((r) => r.rarity === 'legendary').length;
    legs += n;
    bands.push(`${lv}:${n}`);
    // Row stability: two rolls of the same shelf agree row-for-row.
    const key = (rs) => rs.map((r) => `${r.baseId}:${r.rarity}:${r.price}:${r.weapon?.seed ?? '-'}`).join('|');
    ok(key(rows) === key(shopStock(Object.assign(freshSave(), { level: lv }))),
      `LV ${lv}: the clamped shelf is still deterministic row-for-row`);
  }
  ok(legs === 0, 'no legendary appears on any shelf at any band', bands.join(' '));
  // The clamp downgrades rather than deleting: a would-be legendary row is on
  // the shelf as an EPIC (measured: the 37/53 shelves carry them).
  const high = shopStock(Object.assign(freshSave(), { level: 37 }));
  ok(high.some((r) => r.rarity === 'epic'), 'the ceiling downgrades to epic rather than emptying rows');
}

// --- the materials ledger ---------------------------------------------------
{
  const s = freshSave();
  const m = ensureMaterials(s);
  ok(m.emberdust === 0 && Object.keys(m.sigils).length === 6,
    'a fresh save grows an empty ledger with all six sigil keys', JSON.stringify(m.sigils));
  // Idempotent + total over garbage.
  const bad = { materials: { emberdust: 'lots', sigils: { warden: -3, bogus: 9 } } };
  const mb = ensureMaterials(bad);
  ok(mb.emberdust === 0 && mb.sigils.warden === 0 && !('bogus' in mb.sigils),
    'a corrupt ledger converges: NaN dust 0, negative sigils 0, unknown keys dropped', JSON.stringify(mb));
  grantEmberdust(s, 3);
  grantEmberdust(s, -5);
  ok(s.materials.emberdust === 3, 'grantEmberdust credits and refuses negatives', String(s.materials.emberdust));
  ok(grantSigil(s, 'warden') && s.materials.sigils.warden === 1, 'grantSigil credits a named boss');
  ok(!grantSigil(s, 'nope'), 'grantSigil refuses unknown bosses');
}

// --- gate 3: the craft ------------------------------------------------------
{
  const s = Object.assign(freshSave(), { level: 25 });
  ensureMaterials(s);
  const epic = rollWeapon('gatecleaver', 41414, { rarity: 'epic', level: 22 });

  ok(canAscend(s, epic).reason === 'NEEDS 1 INFERNUS SIGIL', 'refusal names the missing sigil first',
    canAscend(s, epic).reason);
  grantSigil(s, 'infernus');
  ok(/MORE EMBERDUST/.test(canAscend(s, epic).reason), 'then the dust', canAscend(s, epic).reason);
  grantEmberdust(s, EMBERDUST_COST);
  ok(/MORE ASH/.test(canAscend(s, epic).reason), 'then the ash', canAscend(s, epic).reason);
  s.ash = ASH_COST + 500;
  ok(canAscend(s, epic).ok, 'a funded recipe passes');

  const rows = ascensionRecipe(s, epic);
  ok(rows.length === 3 && rows.every((r) => r[3]), 'ascensionRecipe reports all three rows met', JSON.stringify(rows));

  const r = ascend(s, epic);
  ok(r.ok && r.weapon.rarity === 'legendary', 'ascend produces a legendary');
  ok(r.weapon.seed === epic.seed, 'the consumed epic\'s seed becomes the legendary\'s seed', `${epic.seed} -> ${r.weapon.seed}`);
  ok(r.weapon.affixes.length === 4, 'the legendary carries 4 affixes');
  ok(/Ascendant/.test(r.weapon.name), 'the legendary is named Ascendant', r.weapon.name);
  ok(r.weapon.rule === LEGENDARY_RULES.gatecleaver, 'the legendary carries its base\'s rule');
  ok(s.ash === 500 && s.materials.emberdust === 0 && s.materials.sigils.infernus === 0,
    'the recipe was debited exactly', `ash ${s.ash}, dust ${s.materials.emberdust}`);
  // Affix continuity: the epic's three affixes lead the legendary's four.
  const a3 = epic.affixes.map((x) => x.key).join(',');
  const b3 = r.weapon.affixes.slice(0, 3).map((x) => x.key).join(',');
  ok(a3 === b3, 'the epic\'s affixes lead the legendary\'s (shared stream)', `${a3} -> ${b3}`);

  // Refusals that guard the craft's edges.
  ok(canAscend(s, r.weapon).reason === 'ALREADY ASCENDED', 'a legendary cannot re-ascend');
  ok(canAscend(s, rollWeapon('riftedge', 1, { rarity: 'rare', level: 5 })).reason === 'ONLY AN EPIC CAN ASCEND',
    'a rare cannot ascend');
  // FAMILY_SIGIL deliberately maps polearm onto the WARDEN's sigil (its own
  // comment: six bosses cover seven families by sharing — reach weapons drill
  // in the sword's martial line, and NO SIGIL walled Vigil/Voidglaive out of
  // ascension entirely). The refusal for an unfunded polearm epic is therefore
  // the ordinary missing-sigil one, not the family wall.
  ok(canAscend(s, rollWeapon('vigil', 9, { rarity: 'epic', level: 20 })).reason === 'NEEDS 1 WARDEN SIGIL',
    'the polearm family ascends on the WARDEN sigil (shared — no seventh boss, no walled-out family)');
}

// --- THE LAW, structurally --------------------------------------------------
{
  ok(assertLegendaryLaw(), 'the shipped rule table passes the law');
  // Every legendary base has a rule; every fx key is a sanctioned verb.
  const missing = Object.keys(WEAPONS).filter((id) => !LEGENDARY_RULES[id]);
  ok(missing.length === 0, 'every base carries a legendary rule', missing.join(',') || 'all 16');
  let outlawed = false;
  try { assertLegendaryLaw({ cheat: { name: 'X', text: 'x', fx: { dmgMul: 2 } } }); } catch { outlawed = true; }
  ok(outlawed, 'a damage-multiplying fx key THROWS — the law is structural, not convention');
  const damageWords = ['dmg', 'damage', 'power', 'atk'];
  const dirty = [...RULE_VERBS].filter((v) => damageWords.some((w) => v.toLowerCase().includes(w)));
  ok(dirty.length === 0, 'the verb whitelist itself contains no damage term', dirty.join(',') || 'clean');

  // And the number: same seed, epic vs legendary, hitDamage moves by EXACTLY
  // the RARITIES.mul ratio on every base and every step — the rule adds zero.
  let exact = true; let worst = '';
  for (const id of Object.keys(WEAPONS)) {
    const e = rollWeapon(id, 999, { rarity: 'epic', level: 30 });
    const l = rollWeapon(id, 999, { rarity: 'legendary', level: 30 });
    for (let i = 0; i < e.combo.length; i++) {
      const ratio = hitDamage(l, l.combo[i], 100) / hitDamage(e, e.combo[i], 100);
      if (Math.abs(ratio - RARITIES.legendary.mul / RARITIES.epic.mul) > 1e-9) {
        exact = false; worst = `${id} step ${i}: ${ratio}`;
      }
    }
  }
  ok(exact, 'hitDamage(legendary)/hitDamage(epic) === mul ratio on every base — rules add zero damage', worst || '16 bases x all steps');

  // The envelope, weapon-side (RPG_SPEC rawStep): the whole legendary damage
  // step over epic is +16%, under one tier step (~+53%) — stated in the spec
  // so nobody "fixes" it upward, asserted here so nobody does it by accident.
  const step = RARITIES.legendary.mul / RARITIES.epic.mul;
  ok(step < 1.2, 'the legendary raw step stays a small part of the prize', `x${step.toFixed(3)}`);

  // Sigil map sanity: every family in FAMILY_SIGIL names a labelled boss.
  const orphans = Object.values(FAMILY_SIGIL).filter((b) => !SIGIL_LABEL[b]);
  ok(orphans.length === 0, 'every sigil boss has a label', orphans.join(',') || '6 bosses');
}

// ===========================================================================
// B. THE COUNTER  (the real game)
// ===========================================================================
console.log('\nB. THE COUNTER\n');

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });

// A hunter one craft away: epic dawnbrand (sword -> WARDEN sigil) in hand,
// ledger funded, deep enough in the game for the panel to be honest.
const SAVE = Object.assign(freshSave(), {
  level: 26,
  autoStats: 25,
  stats: { str: 10, agi: 5, vit: 6, int: 2, per: 2 },
  ash: 9000,
  weapon: { b: 'dawnbrand', r: 'epic', s: 424242, l: 24 },
  materials: { emberdust: 9, sigils: { warden: 1 } },
});

await page.addInitScript((save) => {
  // Once only: init scripts re-run on EVERY navigation, and the reload half of
  // this test exists precisely to prove the PERSISTED save survives — a blind
  // re-seed here would clobber the legendary it is checking for.
  try {
    if (!localStorage.getItem('gb.test.seeded')) {
      localStorage.setItem('gatebreaker.save.v2', JSON.stringify(save));
      localStorage.setItem('gb.test.seeded', '1');
    }
  } catch { /* blocked */ }
}, SAVE);
await gotoGame(page);

const boot = await page.evaluate(() => {
  const g = window.__game;
  return {
    weapon: g.weapon?.baseId, rarity: g.weapon?.rarity, seed: g.weapon?.seed,
    dust: g.save.materials?.emberdust, warden: g.save.materials?.sigils?.warden,
    rule: g.weapon?.rule || null,
  };
});
ok(boot.weapon === 'dawnbrand' && boot.rarity === 'epic', 'the epic boots into the hand', `${boot.weapon}/${boot.rarity}`);
ok(boot.dust === 9 && boot.warden === 1, 'the ledger survives load', `dust ${boot.dust}, warden ${boot.warden}`);
ok(boot.rule === null, 'an epic carries no rule');

await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page.waitForTimeout(2200);

// The sheet, weapon slot -> the ASCENSION block.
await page.click('#btnInventory');
await page.waitForTimeout(450);
const block = await page.evaluate(() => {
  const asc = document.getElementById('invAscend');
  const btn = document.getElementById('invAscendBtn');
  return {
    present: Boolean(asc),
    rows: asc ? [...asc.querySelectorAll('.crow')].map((r) => `${r.className.includes('met') && !r.className.includes('unmet') ? '+' : '-'}${r.textContent}`) : [],
    btnEnabled: Boolean(btn && !btn.disabled),
  };
});
ok(block.present, 'the equipped epic shows the ASCENSION block');
ok(block.rows.length === 3 && block.rows.every((r) => r.startsWith('+')),
  'all three recipe rows read met', block.rows.join(' | '));
ok(block.btnEnabled, 'ASCEND is enabled on a funded recipe');
if (SHOTS) {
  // Bring the recipe into the frame — the sheet scrolls, screenshots do not.
  await page.evaluate(() => document.getElementById('invAscend')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: shotPath('ascend-before.png') });
  await page.evaluate(() => { document.getElementById('invCol').scrollTop = 0; });
}

// The craft.
await page.click('#invAscendBtn');
await page.waitForTimeout(600);
const after = await page.evaluate(() => {
  const g = window.__game;
  const rule = document.querySelector('#inv .rule');
  const legRow = document.querySelector('#inv .gate.leg');
  return {
    rarity: g.weapon?.rarity, seed: g.weapon?.seed, name: g.weapon?.name,
    ruleName: g.weapon?.rule?.name || null,
    dust: g.save.materials?.emberdust, warden: g.save.materials?.sigils?.warden, ash: g.save.ash,
    stashLen: g.stash.length,
    ruleShown: rule ? rule.textContent : null,
    legRowShown: Boolean(legRow),
    record: g.save.equipment?.weapon || null,
  };
});
ok(after.rarity === 'legendary', 'ASCEND equips a legendary', `${after.name}`);
ok(after.seed === 424242, 'the legendary keeps the consumed epic\'s seed', String(after.seed));
ok(after.ruleName === 'DAWNBRAND ASCENDANT', 'the sword carries its base\'s rule', after.ruleName);
ok(after.dust === 0 && after.warden === 0 && after.ash === 1000,
  'the ledger and wallet were debited exactly', `dust ${after.dust}, sigil ${after.warden}, ash ${after.ash}`);
ok(after.stashLen === 0, 'the consumed epic did NOT leak into the stash', String(after.stashLen));
ok(Boolean(after.ruleShown && after.ruleShown.includes('DAWNBRAND ASCENDANT')),
  'the panel prints the legendary rule', String(after.ruleShown).slice(0, 60));
ok(after.legRowShown, 'the equipped row is styled as legendary');
ok(after.record?.r === 'legendary' && after.record?.s === 424242,
  'the {b,r,s,l} record was persisted with the flipped rarity', JSON.stringify(after.record));
if (SHOTS) {
  // Frame the legendary row + the rule box together: scroll to the top (the
  // equipped row) — the rule box sits directly under the stat readout.
  await page.evaluate(() => { document.getElementById('invCol').scrollTop = 0; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: shotPath('ascend-after.png') });
}

// F5: the codec is the persistence law.
await page.reload();
await page.waitForTimeout(2600);
const reborn = await page.evaluate(() => {
  const g = window.__game;
  return { rarity: g.weapon?.rarity, seed: g.weapon?.seed, name: g.weapon?.name, rule: g.weapon?.rule?.name };
});
ok(reborn.rarity === 'legendary' && reborn.seed === 424242 && reborn.rule === 'DAWNBRAND ASCENDANT',
  'the legendary survives a reload byte-for-byte', `${reborn.name} (${reborn.seed})`);

// Emberdust granting, live: a seeded B-rank boss kill pays 1 dust + a sigil.
const dustRun = await page.evaluate(async () => {
  const g = window.__game;
  g.appState.go('run', { rank: 'B', gateIndex: 3, forceOpen: true });
  await new Promise((r) => setTimeout(r, 1500));
  const before = {
    dust: g.save.materials.emberdust,
    infernus: g.save.materials.sigils.infernus,
  };
  // Kill the field, then the boss, through the real kill path.
  [...g.enemies].forEach((e) => { if (!e.isBoss) g._killEnemy(e); });
  g.killed = g.gate.enemies; // trip the boss spawn
  g._spawnBoss?.();
  await new Promise((r) => setTimeout(r, 300));
  const boss = g.enemies.find((e) => e.isBoss);
  if (boss) g._killEnemy(boss);
  return {
    before,
    after: { dust: g.save.materials.emberdust, infernus: g.save.materials.sigils.infernus },
    bossFound: Boolean(boss),
  };
});
ok(dustRun.bossFound, 'a B-rank boss spawned for the drop test');
ok(dustRun.after.dust >= dustRun.before.dust + 1,
  'the boss kill paid its guaranteed emberdust', `${dustRun.before.dust} -> ${dustRun.after.dust}`);
ok(dustRun.after.infernus === dustRun.before.infernus + 1,
  'Infernus dropped the greatsword sigil', `${dustRun.before.infernus} -> ${dustRun.after.infernus}`);

// And an E-rank boss pays NO dust (below band B) but DOES pay its sigil.
const eRun = await page.evaluate(async () => {
  const g = window.__game;
  g.appState.go('run', { rank: 'E', gateIndex: 0, forceOpen: true });
  await new Promise((r) => setTimeout(r, 1200));
  const before = { dust: g.save.materials.emberdust, warden: g.save.materials.sigils.warden };
  [...g.enemies].forEach((e) => { if (!e.isBoss) g._killEnemy(e); });
  g.killed = g.gate.enemies;
  g._spawnBoss?.();
  await new Promise((r) => setTimeout(r, 300));
  const boss = g.enemies.find((e) => e.isBoss);
  if (boss) g._killEnemy(boss);
  return { before, after: { dust: g.save.materials.emberdust, warden: g.save.materials.sigils.warden } };
});
ok(eRun.after.dust === eRun.before.dust, 'an E-rank boss pays no emberdust (below band B)',
  `${eRun.before.dust} -> ${eRun.after.dust}`);
ok(eRun.after.warden === eRun.before.warden + 1, 'but the Warden still drops the sword sigil');

const pageErrors = errors.filter((e) => !/favicon/.test(e));
ok(pageErrors.length === 0, 'no page errors during the run', pageErrors.slice(0, 3).join(' | '));

writeReport('ascension', { pass, fail: failN, results });
await browser.close();
await server.stop();
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
