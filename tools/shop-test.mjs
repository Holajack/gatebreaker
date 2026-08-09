// tools/shop-test.mjs — the Exchange's weapon shop.
//
//   node tools/shop-test.mjs [--no-shots] [--headed]
//
// Two halves, because the feature has two halves:
//
//   A. THE LADDER, in Node. src/game/shop.js is DOM-free and THREE-free by
//      construction, so the stock table, the rank gating, the prices, the
//      determinism and the save migration are asserted by importing the module
//      directly — no browser, no timing, no flake.
//
//   B. THE COUNTER, in the real game. Boot -> PLAY -> walk into the Exchange
//      -> the door prompt -> the panel -> buy -> RELOAD THE PAGE and check the
//      weapon is still in his hand and the ash is still gone. A shop that
//      cannot survive F5 is not a shop, and localStorage round-tripping is the
//      only honest way to prove it.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';
import { freshSave, migrate } from '../src/core/save.js';
import {
  shopStock, shopBand, buy, priceOf, grantAsh, ashForXp, ensureShopSave, ASH_PER_XP,
} from '../src/game/shop.js';
import { WEAPONS } from '../src/game/weapons.js';

const argv = process.argv.slice(2);
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); return Boolean(cond); };
const phase = (n) => console.log(`  · ${n}`);
const report = {};

// ===========================================================================
// A. THE LADDER  (Node, no browser)
// ===========================================================================
console.log('\nA. THE LADDER\n');

// --- migration: a save written before the shop existed --------------------
{
  const old = { version: 2, level: 9, shadows: { roster: [], deployed: [], nextId: 1 } };
  const m = migrate(old);
  ok(m.ash === 0, `migrated pre-shop save has ash=${m.ash}, expected 0`);
  ok(m.shop && Array.isArray(m.shop.sold), 'migrated pre-shop save has no shop record');
  // The nastier case: a hand-edited or corrupted wallet.
  const bad = migrate({ version: 2, level: 9, ash: 'lots', shop: { band: 'x', sold: [1, 'riftedge'] },
    shadows: { roster: [], deployed: [], nextId: 1 } });
  ok(bad.ash === 0, `corrupt ash survived migration as ${JSON.stringify(bad.ash)}`);
  ok(bad.shop.band === -1, `corrupt shop.band survived migration as ${JSON.stringify(bad.shop.band)}`);
  ok(bad.shop.sold.length === 1 && bad.shop.sold[0] === 'riftedge',
    `corrupt sold list survived as ${JSON.stringify(bad.shop.sold)}`);
  // And a save object that never went through migrate at all.
  const raw = { level: 4 };
  const shop = ensureShopSave(raw);
  ok(raw.ash === 0 && shop.band === shopBand(raw), 'ensureShopSave did not repair a bare save object');
  phase('migration');
}

// --- the ladder actually climbs -------------------------------------------
{
  const rows = {};
  for (const lv of [1, 8, 16, 25, 37, 53]) {
    const s = freshSave();
    s.level = lv;
    const stock = shopStock(s);
    ok(stock.length === Object.keys(WEAPONS).length,
      `LV ${lv}: shelf has ${stock.length} rows, the weapon table has ${Object.keys(WEAPONS).length}`);
    const open = stock.filter((r) => !r.locked);
    rows[lv] = { open: open.map((r) => r.baseId), band: shopBand(s) };
    ok(open.length > 0, `LV ${lv}: nothing at all is buyable`);
    // Every unlocked row must be legally equippable RIGHT NOW. A shop that
    // sells you something you cannot hold is worse than a locked row.
    for (const r of open) {
      ok(WEAPONS[r.baseId].reqLevel <= lv,
        `LV ${lv}: ${r.baseId} is on sale but needs level ${WEAPONS[r.baseId].reqLevel}`);
      ok(r.price > 0 && r.weapon, `LV ${lv}: ${r.baseId} is unlocked with price ${r.price}`);
    }
    for (const r of stock.filter((x) => x.locked)) {
      ok(r.weapon === null && r.reason, `LV ${lv}: locked row ${r.baseId} still carries a weapon or no reason`);
    }
  }
  report.ladder = rows;
  // THE OWNER'S ASK: strictly more on the shelf as he gets stronger.
  const counts = [1, 8, 16, 25, 37].map((lv) => rows[lv].open.length);
  for (let i = 1; i < counts.length; i++) {
    ok(counts[i] > counts[i - 1],
      `the shelf did not grow between band ${i - 1} and ${i}: ${counts.join(' -> ')}`);
  }
  console.log(`  unlocked rows by level 1/8/16/25/37: ${counts.join(' / ')}`);
  // The top of the table must eventually be reachable.
  ok(rows[37].open.includes('voidglaive'), 'the tier-5 weapon never becomes buyable');
  phase('rank gating');
}

// --- determinism -----------------------------------------------------------
{
  const a = shopStock(Object.assign(freshSave(), { level: 20 }));
  const b = shopStock(Object.assign(freshSave(), { level: 20 }));
  const key = (rows) => rows.map((r) => `${r.baseId}:${r.rarity}:${r.price}:${r.weapon?.seed ?? '-'}`).join('|');
  ok(key(a) === key(b), 'two shelves rolled from the same save differ — the stock stream is not deterministic');
  // Same band, different level inside it: rows already on the shelf must not
  // re-roll. B rank spans 25..36.
  const lo = shopStock(Object.assign(freshSave(), { level: 25 }));
  const hi = shopStock(Object.assign(freshSave(), { level: 36 }));
  ok(key(lo) === key(hi), 'the shelf re-rolled on a level-up that did not change the rank band');
  // Crossing a band MUST change it — that is the reward.
  const next = shopStock(Object.assign(freshSave(), { level: 37 }));
  ok(key(next) !== key(hi), 'crossing into A rank produced an identical shelf');
  // No Math.random / Date.now in the generation path.
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/game/shop.js', 'utf8'));
  // Comments stripped first: the module's own header documents the rule by
  // naming both functions, and a naive grep would fail on the documentation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/Math\.random|Date\.now/.test(code), 'shop.js reaches for Math.random or Date.now in a generation path');
  phase('determinism');
}

// --- money ------------------------------------------------------------------
{
  const s = freshSave();
  s.level = 16;
  ok(ashForXp(0) === 0, 'a zero-XP event paid ash');
  ok(ashForXp(1) === 1, 'a 1 XP kill rounded down to zero ash');
  ok(ashForXp(100) === Math.round(100 * ASH_PER_XP), 'ashForXp does not follow ASH_PER_XP');
  grantAsh(s, 40);
  ok(s.ash === 40, `grantAsh wrote ${s.ash}`);

  const row = shopStock(s).find((r) => !r.locked);
  const broke = buy(s, row.baseId);
  ok(!broke.ok && /MORE ASH/.test(broke.reason || ''),
    `buying at 40 ash succeeded or gave the wrong reason: ${JSON.stringify(broke)}`);
  ok(s.ash === 40, 'a refused purchase still moved the wallet');

  grantAsh(s, 5000);
  const before = s.ash;
  const good = buy(s, row.baseId);
  ok(good.ok, `an affordable purchase failed: ${good.reason}`);
  ok(s.ash === before - good.price, `wallet went ${before} -> ${s.ash} for a ${good.price} purchase`);
  ok(good.weapon && good.weapon.baseId === row.baseId, 'the purchase returned the wrong weapon');
  ok(priceOf(good.weapon) === good.price, 'priceOf disagrees with what was charged');

  const again = buy(s, row.baseId);
  ok(!again.ok && again.reason === 'ALREADY BOUGHT', `a second purchase of the same row: ${again.reason}`);

  // A locked row cannot be bought by asking for it directly — the panel is not
  // the only caller, and "the UI does not show the button" is not a rule.
  const locked = shopStock(s).find((r) => r.locked);
  const cheat = buy(s, locked.baseId);
  ok(!cheat.ok, `a locked row (${locked.baseId}) was purchasable directly`);
  ok(!buy(s, 'no_such_weapon').ok, 'an unknown base id was purchasable');

  // Ranking up re-stocks: the sold row comes back.
  s.level = 40;
  const restocked = shopStock(s).find((r) => r.baseId === row.baseId);
  ok(!restocked.sold, 'ranking up did not restock the shelf');
  report.money = { price: good.price, ashAfter: s.ash };
  phase('money');
}

if (fail.length) {
  console.log(`\nSHOP LADDER FAILED — ${fail.length}`);
  for (const f of fail) console.log(`  FAIL ${f}`);
  process.exit(1);
}

// ===========================================================================
// B. THE COUNTER  (the real game)
// ===========================================================================
console.log('\nB. THE COUNTER\n');

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: true });
// Landscape: index.html's rotate gate swallows pointer events in portrait.
const { page, errors } = await newPhonePage(browser, { width: 900, height: 506, dpr: 1 });

/** Drive the player with the exact vector the thumbstick writes. */
async function walkTo(p, tx, tz, { timeoutMs = 25000, stopWithin = 0.9 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await p.evaluate(([gx, gz]) => {
      const g = window.__game;
      const q = g.player.pos;
      const dx = gx - q.x, dz = gz - q.z;
      const d = Math.hypot(dx, dz);
      g.input.move.x = d > 0.001 ? dx / d : 0;
      g.input.move.y = d > 0.001 ? -dz / d : 0;
      return { d, x: q.x, z: q.z };
    }, [tx, tz]);
    if (last.d < stopWithin) break;
    await p.waitForTimeout(90);
  }
  await p.evaluate(() => { window.__game.input.move.x = 0; window.__game.input.move.y = 0; });
  return last;
}

try {
  await gotoGame(page);
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
  await page.waitForTimeout(800);

  // Fund the wallet and rank him up so the shelf has something worth buying.
  // Done through the same functions the game uses, then persisted through the
  // same onSave, so nothing here is a shortcut around the code under test.
  await page.evaluate(() => {
    const g = window.__game;
    g.save.level = 20;
    g.gainXp(0);            // no-op XP; proves the ash hook tolerates zero
    g.save.ash = 4000;
    g.refreshDerived(true);
    g.onSave();
  });

  // --- walk in through the door -------------------------------------------
  const door = await page.evaluate(() => {
    const d = window.__game.mode.city.interiors.byId.get('exchange').door;
    return { outX: d.outX + d.nx * 2.4, outZ: d.outZ + d.nz * 2.4, inX: d.inX, inZ: d.inZ };
  });
  await page.evaluate(([x, z]) => {
    const g = window.__game;
    g.player.body.reset(x, g.mode.city.heightAt(x, z) + 0.2, z);
    g.mode._camReady = false;
  }, [door.outX, door.outZ]);
  await page.waitForTimeout(250);
  await walkTo(page, door.inX, door.inZ);

  const counter = await page.evaluate(() => {
    const it = window.__game.mode.city.interactables.find((x) => x.id === 'exchange');
    return { x: it.pos.x, z: it.pos.z, interiorId: it.interiorId || null };
  });
  ok(counter.interiorId === 'exchange', 'the exchange prompt is not inside the Exchange');
  await walkTo(page, counter.x, counter.z, { stopWithin: 1.0 });
  await page.waitForTimeout(250);

  const atCounter = await page.evaluate(() => {
    const g = window.__game;
    const el = document.getElementById('cityPrompt');
    return {
      inside: g.mode._insideId,
      prompt: g.mode.prompt ? { id: g.mode.prompt.id, sub: g.mode.prompt.sub } : null,
      text: el ? el.innerText.replace(/\s+/g, ' ').trim() : null,
      confirmVisible: Boolean(document.getElementById('cityConfirm')?.offsetParent),
    };
  });
  report.atCounter = atCounter;
  console.log(`  at the counter: inside=${atCounter.inside} prompt="${atCounter.text}"`);
  ok(atCounter.inside === 'exchange', `walking to the counter did not get inside (${atCounter.inside})`);
  ok(atCounter.prompt?.id === 'exchange', `no exchange prompt at the counter (${JSON.stringify(atCounter.prompt)})`);
  ok(atCounter.prompt?.sub !== 'NOT YET OPEN', 'the Exchange still advertises itself as closed');
  ok(atCounter.confirmVisible, 'no confirm button at the Exchange counter');
  if (SHOTS) await page.screenshot({ path: shotPath('shop-00-counter.png') });

  // --- the panel ------------------------------------------------------------
  await page.click('#cityConfirm');
  await page.waitForSelector('#shop:not(.hidden)', { timeout: 8000 });
  const panel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#shopList .gate')];
    return {
      rows: rows.length,
      buyable: rows.filter((r) => !r.classList.contains('locked') && !r.classList.contains('owned')).length,
      ash: document.querySelector('#shopWallet b')?.textContent,
      held: document.querySelectorAll('#shopWallet b')[1]?.textContent,
      // The panel must actually cover the thumbstick, or the player walks away
      // while shopping.
      covers: (() => {
        const s = document.getElementById('shop').getBoundingClientRect();
        return s.width >= window.innerWidth - 1 && s.height >= window.innerHeight - 1;
      })(),
    };
  });
  report.panel = panel;
  console.log(`  panel: ${panel.rows} rows, ${panel.buyable} buyable, ash ${panel.ash}, wielding ${panel.held}`);
  ok(panel.rows === Object.keys(WEAPONS).length, `panel drew ${panel.rows} rows`);
  ok(panel.buyable > 0, 'nothing is buyable in the panel at level 20 with 4000 ash');
  ok(panel.ash === '4000', `wallet shows ${panel.ash}`);
  ok(panel.covers, 'the shop panel does not cover the screen, so the thumbstick is still live under it');
  if (SHOTS) await page.screenshot({ path: shotPath('shop-01-panel.png') });

  // --- buy ------------------------------------------------------------------
  const before = await page.evaluate(() => ({
    ash: window.__game.save.ash,
    weapon: window.__game.weapon.name,
    baseId: window.__game.weapon.baseId,
    stash: window.__game.stash.length,
  }));
  // Buy the most expensive thing he can afford — the interesting case.
  const target = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#shopList .gate')]
      .filter((r) => !r.classList.contains('locked') && !r.classList.contains('owned'));
    let best = null, bestP = -1;
    for (const r of rows) {
      const p = Number(r.querySelector('.price b')?.textContent || 0);
      if (p > bestP && p <= window.__game.save.ash) { bestP = p; best = r; }
    }
    if (!best) return null;
    best.dataset.gbTarget = '1';
    return { price: bestP, name: best.querySelector('.meta b').textContent };
  });
  ok(Boolean(target), 'no affordable row to buy');
  await page.click('#shopList .gate[data-gb-target="1"]');
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => ({
    ash: window.__game.save.ash,
    weapon: window.__game.weapon.name,
    baseId: window.__game.weapon.baseId,
    stash: window.__game.stash.length,
    stored: JSON.parse(localStorage.getItem('gatebreaker.save.v2') || '{}'),
  }));
  report.purchase = { before, target, after: { ash: after.ash, weapon: after.weapon, stash: after.stash } };
  console.log(`  bought ${target?.name} for ${target?.price}: ash ${before.ash} -> ${after.ash}, wielding "${after.weapon}"`);
  ok(after.ash === before.ash - target.price, `wallet went ${before.ash} -> ${after.ash} for a ${target.price} purchase`);
  ok(after.weapon !== before.weapon || after.baseId !== before.baseId,
    'the purchased weapon was not equipped');
  ok(after.stash === before.stash + 1, 'the old weapon did not go to the stash');
  ok(after.stored.ash === after.ash, 'the spend was not written to localStorage');
  ok(Array.isArray(after.stored.shop?.sold) && after.stored.shop.sold.length === 1,
    `the sold list did not persist: ${JSON.stringify(after.stored.shop)}`);
  if (SHOTS) await page.screenshot({ path: shotPath('shop-02-bought.png') });

  // --- close, and the city is still standing --------------------------------
  await page.click('#shopClose');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById('shop').classList.contains('hidden'),
    mode: window.__game.mode?.name,
    inside: window.__game.mode?._insideId,
    // city.js names its root group 'city' (line ~685). NOT 'cityRoot' —
    // acceptance.mjs's `cityDisposed` probe uses that name and is therefore
    // always true; it is only reported there, never asserted, but do not copy
    // it.
    city: Boolean(window.__game.scene.getObjectByName('city')),
  }));
  report.closed = closed;
  ok(closed.hidden, 'LEAVE did not close the panel');
  ok(closed.mode === 'city' && closed.city, 'closing the shop tore the city down');
  ok(closed.inside === 'exchange', 'closing the shop moved the player out of the building');

  // --- RELOAD: the whole point ---------------------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__game), null, { timeout: 30000 });
  await page.waitForSelector('#title:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const reloaded = await page.evaluate(() => ({
    ash: window.__game.save.ash,
    weapon: window.__game.weapon.name,
    baseId: window.__game.weapon.baseId,
    sold: window.__game.save.shop?.sold || [],
    level: window.__game.save.level,
  }));
  report.reloaded = reloaded;
  console.log(`  after reload: ash ${reloaded.ash}, wielding "${reloaded.weapon}", sold ${JSON.stringify(reloaded.sold)}`);
  ok(reloaded.ash === after.ash, `ash after reload ${reloaded.ash}, expected ${after.ash}`);
  ok(reloaded.weapon === after.weapon && reloaded.baseId === after.baseId,
    `the bought weapon did not survive the reload: "${reloaded.weapon}" vs "${after.weapon}"`);
  ok(reloaded.sold.length === 1, 'the shelf forgot the purchase across a reload');

  // And the row is still marked bought when he walks back in.
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const reopened = await page.evaluate(() => {
    window.__game.shopUI.open();
    const rows = [...document.querySelectorAll('#shopList .gate')];
    return {
      owned: rows.filter((r) => r.classList.contains('owned')).length,
      ash: document.querySelector('#shopWallet b')?.textContent,
      held: document.querySelectorAll('#shopWallet b')[1]?.textContent,
    };
  });
  report.reopened = reopened;
  ok(reopened.owned === 1, `the shelf shows ${reopened.owned} bought rows after a reload, expected 1`);
  ok(reopened.held === reloaded.weapon, `the panel says he is wielding "${reopened.held}"`);
  if (SHOTS) await page.screenshot({ path: shotPath('shop-03-after-reload.png') });

  ok(errors.length === 0, `page errors: ${errors.slice(0, 2).join(' | ')}`);
} catch (err) {
  console.error(err);
  ok(false, `shop counter run threw: ${err.message}`);
} finally {
  const file = writeReport('shop-test', { when: new Date().toISOString(), fail, ...report });
  console.log(`\nreport -> ${file}`);
  await browser.close();
  await server.stop();
  if (fail.length) {
    console.log(`\nSHOP FAILED — ${fail.length}`);
    for (const f of fail) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('\nPASS — the Exchange sells, equips and remembers');
  process.exit(0);
}
