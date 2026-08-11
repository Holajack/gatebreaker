// Wave 3-A acceptance: the equipment save model, stow/draw, and the hunter's
// sheet on a phone-shaped landscape viewport.
//
// The three things this exists to catch, all of which have bitten this repo
// before in one form or another:
//   1. A save written by the SHIPPED build must still boot. The migration runs
//      on first contact from every entry point, so the test writes a real
//      pre-wave profile into localStorage and then reads the live game back.
//   2. Equipping out of the stash must SWAP, not push. The old equip() path
//      unshifts the outgoing weapon and never removes the incoming one, which
//      is a duplication exploit the moment a panel lets you do it on purpose.
//   3. A panel must fit 412 CSS px of height. The Exchange already paid for
//      that lesson; the sheet has strictly more content than the Exchange.
//
//   GB_PORT=5251 node tools/inventory-test.mjs

import fs from 'node:fs';
import { launchBrowser, newPhonePage, ensureServer, gotoGame, shotPath, OUT, writeReport } from './_harness.mjs';

let pass = 0; let fail = 0;
const results = [];
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
  results.push({ label, ok: Boolean(cond), detail });
}

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });

// ---------------------------------------------------------------- old save
//
// Exactly the shape the shipped build writes: a flat save.weapon, a flat
// stash with no `k`, and NO save.equipment at all.
const LEGACY = {
  version: 2,
  level: 14,
  xp: 40,
  points: 3,
  stats: { str: 4, agi: 2, vit: 3, int: 1, per: 0 },
  autoStats: 13,
  playerBody: 'male',
  cleared: { E: 41.2 },
  shadows: { roster: [{ id: 1, name: 'Cinderbound 1', grade: 1, type: 'grunt', level: 9, kills: 2, bornAt: 0 }], deployed: [], nextId: 2 },
  ash: 640,
  daily: { dayKey: null, progress: 0, claimed: false },
  totalKills: 88,
  deaths: 2,
  weapon: { b: 'dawnbrand', r: 'rare', s: 990211, l: 12 },
  stash: [
    { b: 'sunderaxe', r: 'uncommon', s: 4242, l: 8 },
    { b: 'whisperfangs', r: 'common', s: 77, l: 5 },
  ],
  shop: { band: 2, sold: ['vigil'] },
  worldTime: 15,
};

await page.addInitScript((save) => {
  try { localStorage.setItem('gatebreaker.save.v2', JSON.stringify(save)); } catch { /* blocked */ }
}, LEGACY);

await gotoGame(page);

const boot = await page.evaluate(() => {
  const g = window.__game;
  return {
    level: g.save.level,
    ash: g.save.ash,
    weapon: g.weapon?.baseId || null,
    rarity: g.weapon?.rarity || null,
    stash: g.stash.map((w) => w.baseId),
    equipmentKeys: Object.keys(g.save.equipment || {}),
    equippedRecord: g.save.equipment?.weapon || null,
    mirror: g.save.weapon || null,
  };
});
ok(boot.weapon === 'dawnbrand' && boot.rarity === 'rare',
  'a pre-wave save still boots with the right weapon in hand', `${boot.weapon}/${boot.rarity}`);
ok(boot.level === 14 && boot.ash === 640, 'the rest of the profile survives migration', `LV${boot.level} ${boot.ash} ash`);
ok(boot.equipmentKeys.length === 8, 'the save grew eight equipment slots', boot.equipmentKeys.join(','));
ok(boot.equippedRecord?.b === 'dawnbrand' && boot.equippedRecord?.k === 'w',
  'the old single weapon was copied into equipment.weapon', JSON.stringify(boot.equippedRecord));
ok(boot.mirror?.b === 'dawnbrand', 'save.weapon is still written as a rollback mirror', JSON.stringify(boot.mirror));
ok(boot.stash.length === 2, 'the old stash survived', boot.stash.join(','));

// ------------------------------------------------------------------ in city
await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page.waitForTimeout(2200);

ok(await page.locator('#btnInventory').isVisible(), 'the HUD carries an inventory button in the city');

// --------------------------------------------------------------- stow/draw
const stow = await page.evaluate(async () => {
  const g = window.__game;
  const W = window.__weapons;
  const mesh = g.player.mesh;
  const before = { stance: W.weaponStance(mesh), parent: mesh.userData.weapon?.main?.parent?.name || null };
  g.setStance('sheathed', { manual: true });
  const sheathed = { stance: W.weaponStance(mesh), parent: mesh.userData.weapon?.main?.parent?.name || null };
  g.setStance('drawn', { manual: true });
  const drawn = { stance: W.weaponStance(mesh), parent: mesh.userData.weapon?.main?.parent?.name || null };
  return { before, sheathed, drawn, drawSeconds: W.drawTime(g.weapon) };
});
ok(stow.sheathed.stance === 'sheathed', 'the sword can be put away', stow.sheathed.parent || 'no parent');
ok(stow.sheathed.parent !== stow.before.parent,
  'stowing RE-PARENTS rather than hiding', `${stow.before.parent} -> ${stow.sheathed.parent}`);
ok(stow.drawn.stance === 'drawn' && stow.drawn.parent === stow.before.parent,
  'drawing puts it back in the same fist socket', stow.drawn.parent || 'no parent');
ok(stow.drawSeconds > 0.18 && stow.drawSeconds <= 0.45, 'draw time follows the mass law', `${stow.drawSeconds.toFixed(3)}s`);

// A stow must not create or leak GPU objects — it is a re-parent, full stop.
const churn = await page.evaluate(() => {
  const g = window.__game;
  const info = () => ({ g: g.renderer.info.memory.geometries, t: g.renderer.info.memory.textures });
  const a = info();
  for (let i = 0; i < 12; i++) { g.setStance('sheathed', { manual: true }); g.setStance('drawn', { manual: true }); }
  return { a, b: info() };
});
ok(churn.a.g === churn.b.g && churn.a.t === churn.b.t,
  '24 stow/draw cycles allocate no geometry or texture', `${churn.a.g}g/${churn.a.t}t -> ${churn.b.g}g/${churn.b.t}t`);

// Auto policy: standing still and unthreatened in the plaza sheathes itself.
//
// WAIT ON SIM TIME, NOT WALL TIME. Headless SwiftShader renders this scene at
// roughly 4 fps, and Game.update clamps dt to 0.05 — so a 3.0 s in-game timer
// takes about 15 s of wall clock in here. A fixed waitForTimeout looked like a
// broken auto-sheath and was actually a slow GPU.
await page.evaluate(() => { window.__game.setStance('drawn', { manual: false }); window.__game._stanceHold = 0; });
await page.waitForFunction(
  () => window.__weapons.weaponStance(window.__game.player.mesh) === 'sheathed',
  null, { timeout: 45000 },
).catch(() => {});
const auto = await page.evaluate(() => ({
  stance: window.__weapons.weaponStance(window.__game.player.mesh),
  idle: Number((window.__game._idleSince || 0).toFixed(2)),
}));
ok(auto.stance === 'sheathed', 'the sword sheathes itself after a few idle seconds in the plaza',
  `${auto.stance} after ${auto.idle}s of sim time`);

await page.screenshot({ path: shotPath('inv-plaza-sheathed.png') });
await page.evaluate(() => window.__game.setStance('drawn', { manual: true }));
await page.waitForTimeout(500);
await page.screenshot({ path: shotPath('inv-plaza-drawn.png') });

// ------------------------------------------------------------------- panel
await page.click('#btnInventory');
await page.waitForTimeout(450);
const open = await page.evaluate(() => {
  const inv = document.getElementById('inv');
  const panel = inv?.querySelector('.panel');
  return {
    visible: Boolean(inv && !inv.classList.contains('hidden')),
    bodyClass: document.body.classList.contains('gb-inv'),
    slots: inv?.querySelectorAll('#invSlots .slot').length || 0,
    panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
    panelBottom: panel ? Math.round(panel.getBoundingClientRect().bottom) : 0,
    viewport: window.innerHeight,
    docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cityUiHidden: (() => {
      const c = document.getElementById('cityUi');
      return !c || getComputedStyle(c).display === 'none';
    })(),
    text: inv?.querySelector('#invBody')?.textContent || '',
  };
});
ok(open.visible && open.bodyClass, 'the inventory button opens the sheet');
ok(open.slots === 8, 'eight equipment slots are on screen', String(open.slots));
ok(open.panelBottom <= open.viewport + 1 && open.panelHeight > 0,
  'the panel fits a 412 px landscape viewport', `${open.panelHeight}px tall, bottom ${open.panelBottom} of ${open.viewport}`);
ok(open.docScroll === 0, 'the page does not scroll horizontally', `${open.docScroll}px overflow`);
ok(open.cityUiHidden, 'the city overlay is hidden so it cannot eat taps');
await page.screenshot({ path: shotPath('inv-panel-gear.png') });

// STATS tab
await page.click('#inv .tabs button[data-tab="stats"]');
await page.waitForTimeout(320);
const stats = await page.evaluate(() => document.querySelector('#invBody').textContent);
for (const want of ['IDENTITY', 'STRENGTH', 'DERIVED', 'Dodge window', 'ARMOUR', 'ARMY']) {
  ok(stats.includes(want), `the STATS tab reports ${want}`);
}
ok(/NO ARMOUR IN THIS BUILD/.test(stats), 'the panel says armour is not implemented rather than faking it');
await page.screenshot({ path: shotPath('inv-panel-stats.png') });

// An armour slot must say so, not pretend.
await page.click('#inv .slot[data-slot="chest"]');
await page.waitForTimeout(300);
const chest = await page.evaluate(() => document.querySelector('#invBody').textContent);
ok(/NOT YET FITTED/.test(chest), 'an armour slot admits it is not fitted yet');
await page.screenshot({ path: shotPath('inv-panel-armor-slot.png') });

// ------------------------------------------------------------- equip swap
await page.click('#inv .slot[data-slot="weapon"]');
await page.waitForTimeout(250);
const swap = await page.evaluate(() => {
  const g = window.__game;
  const before = { held: g.weapon.baseId, stash: g.stash.map((w) => w.baseId) };
  g.invUI._equip(0);
  const after = { held: g.weapon.baseId, stash: g.stash.map((w) => w.baseId) };
  return { before, after, saved: (g.save.stash || []).map((r) => r.b), savedWeapon: g.save.equipment.weapon?.b };
});
ok(swap.after.held === swap.before.stash[0], 'equipping from the stash equips the right weapon', swap.after.held);
ok(swap.after.stash.length === swap.before.stash.length,
  'equipping from the stash SWAPS — no duplicate', `${swap.before.stash.join(',')} -> ${swap.after.stash.join(',')}`);
ok(!swap.after.stash.includes(swap.after.held), 'the equipped weapon is no longer also in the stash', swap.after.stash.join(','));
ok(swap.savedWeapon === swap.after.held && swap.saved.length === swap.after.stash.length,
  'the swap was persisted in one write', `${swap.savedWeapon} + ${swap.saved.length} spare`);

// ------------------------------------------------------------------- close
await page.keyboard.press('Escape');
await page.waitForTimeout(320);
const closed = await page.evaluate(() => ({
  hidden: document.getElementById('inv').classList.contains('hidden'),
  bodyClass: document.body.classList.contains('gb-inv'),
  mode: window.__game.mode?.name,
  state: window.__game.state,
}));
ok(closed.hidden && !closed.bodyClass, 'Escape closes the sheet');
ok(closed.mode === 'city' && closed.state === 'playing',
  'closing does NOT rebuild the city or leave the game paused', `${closed.mode}/${closed.state}`);

// --------------------------------------------------------------- in a gate
await page.evaluate(() => window.__game.startGate(0));
// Same slow-GPU caveat: wait for the run to actually be live rather than for a
// number of milliseconds that happens to work on a fast machine.
await page.waitForFunction(() => window.__game?.state === 'playing' && window.__game?.mode?.name === 'dungeon',
  null, { timeout: 45000 }).catch(() => {});
// The crawl reveals the HUD at the END of its walk-in intro (DUNGEON_SPEC edit
// 7), and that intro is sim seconds, which is ~5x wall seconds in here.
await page.waitForSelector('#hud:not(.hidden)', { timeout: 60000 }).catch(() => {});
ok(await page.locator('#btnInventory').isVisible(), 'the HUD carries an inventory button inside a gate too');
await page.click('#btnInventory');
await page.waitForTimeout(400);
const inGate = await page.evaluate(() => ({
  open: window.__game.invUI.isOpen,
  state: window.__game.state,
}));
ok(inGate.open && inGate.state === 'paused', 'opening the sheet in a gate pauses the sim', inGate.state);
await page.screenshot({ path: shotPath('inv-panel-in-gate.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const afterGate = await page.evaluate(() => ({
  open: window.__game.invUI.isOpen,
  state: window.__game.state,
  stance: window.__weapons.weaponStance(window.__game.player.mesh),
}));
ok(!afterGate.open && afterGate.state === 'playing', 'closing it resumes the run', afterGate.state);
ok(afterGate.stance === 'drawn', 'the weapon is drawn inside a gate', afterGate.stance);

ok(errors.length === 0, 'zero page errors', errors.slice(0, 2).join(' | ') || 'none');

writeReport('inventory-result.json', { pass, fail, results, errors });
console.log(`\nshots + report: ${OUT}`);
console.log(fail === 0 ? `INVENTORY PASSED — ${pass} checks` : `INVENTORY FAILED — ${fail} of ${pass + fail}`);

await browser.close();
await server.stop();
if (fail) process.exitCode = 1;
