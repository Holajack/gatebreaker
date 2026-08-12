// Wave 3-A/3-B acceptance: the equipment save model, stow/draw, and the
// hunter's sheet — now with LIVE armour slots (RPG_SPEC step 13) — on a
// phone-shaped landscape viewport.
//
// The things this exists to catch, all of which have bitten this repo before
// in one form or another:
//   1. A save written by the SHIPPED build must still boot. The migration runs
//      on first contact from every entry point, so the test writes a real
//      pre-wave profile into localStorage and then reads the live game back.
//   2. Equipping out of the stash must SWAP, not push — for weapons AND for
//      armour. The push-only path is a duplication exploit the moment a panel
//      lets you do it on purpose.
//   3. A panel must fit 412 CSS px of height. The Exchange already paid for
//      that lesson; the sheet has strictly more content than the Exchange.
//   4. TWO SHIPPED 3-A BUGS stay dead: the right column used to clip with NO
//      visible scrollbar at 892x412 (native scrollbars are overlay-or-nothing
//      platform policy — the panel now draws its own rail), and the
//      SHEATHE/DRAW button used to go stale under the city's auto-stow policy
//      and then apply the OPPOSITE of its own label when tapped.
//
//   GB_PORT=5251 node tools/inventory-test.mjs

import fs from 'node:fs';
import { launchBrowser, newPhonePage, ensureServer, gotoGame, shotPath, OUT, writeReport } from './_harness.mjs';
// Step 11's live checks recompute the armour fold in pure node and demand the
// page agrees byte-for-byte — the strongest possible "single computation site"
// assertion.
import { armorDerive, combinedDR } from '../src/game/armor.js';
import { derive } from '../src/game/config.js';

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
// Exactly the shape the shipped build writes: a flat save.weapon, a stash
// whose weapon entries have no `k`, and NO save.equipment at all. The armour
// and trinket records ride in the same stash the way _takeArmor writes them —
// they are what the step-13 panel equips from.
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
    { k: 'a', b: 'ossuary_chest', r: 'rare', s: 1102, l: 14 },
    { k: 'a', b: 'issue_chest', r: 'common', s: 7, l: 2 },
    // Locked two different ways at LV14 / D-band: vigil by level (34),
    // deepglass by rank (minRank 2 = C). The rows must say so in the
    // Exchange's exact words.
    { k: 'a', b: 'vigil_chest', r: 'epic', s: 9, l: 14 },
    { k: 'a', b: 'deepglass_chest', r: 'rare', s: 11, l: 14 },
    { k: 't', b: 'ember_ring', r: 'uncommon', s: 1106, l: 14 },
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
    armorStash: (g.armorStash || []).map((r) => r.b),
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
ok(boot.stash.length === 2, 'the weapon stash survived', boot.stash.join(','));
ok(boot.armorStash.length === 5, 'the armour/trinket records rode along untouched', boot.armorStash.join(','));

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
    tabs: [...(inv?.querySelectorAll('.tabs button') || [])].map((b) => b.dataset.tab),
    panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
    panelBottom: panel ? Math.round(panel.getBoundingClientRect().bottom) : 0,
    viewport: window.innerHeight,
    docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cityUiHidden: (() => {
      const c = document.getElementById('cityUi');
      return !c || getComputedStyle(c).display === 'none';
    })(),
  };
});
ok(open.visible && open.bodyClass, 'the inventory button opens the sheet');
ok(open.slots === 8, 'eight equipment slots are on screen', String(open.slots));
ok(open.tabs.join(',') === 'gear,stats,sets', 'the sheet carries GEAR / STATS / SETS tabs', open.tabs.join(','));
ok(open.panelBottom <= open.viewport + 1 && open.panelHeight > 0,
  'the panel fits a 412 px landscape viewport', `${open.panelHeight}px tall, bottom ${open.panelBottom} of ${open.viewport}`);
ok(open.docScroll === 0, 'the page does not scroll horizontally', `${open.docScroll}px overflow`);
ok(open.cityUiHidden, 'the city overlay is hidden so it cannot eat taps');
await page.screenshot({ path: shotPath('inv-panel-gear.png') });

// ------------------------------------- 3-A bug 1: the clip with no scrollbar
//
// STATS is the densest tab: ~460 px of content in a ~250 px box. The panel
// draws its OWN rail (native scrollbars are overlay-or-nothing platform
// policy — measured on this very harness: even a pure ::-webkit-scrollbar
// customisation kept offsetWidth === clientWidth and painted nothing until
// mid-scroll). The rail must be visible, sized, and must move with the scroll.
await page.click('#inv .tabs button[data-tab="stats"]');
await page.waitForTimeout(350);
const rail = await page.evaluate(async () => {
  const inv = window.__game.invUI;
  const col = inv.colEl;
  const r0 = inv.railEl.getBoundingClientRect();
  const t0 = inv.thumbEl.getBoundingClientRect();
  col.scrollTop = col.scrollHeight;   // to the end
  await new Promise((r) => setTimeout(r, 120));
  const t1 = inv.thumbEl.getBoundingClientRect();
  col.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 120));
  // No row value may render under the rail's lane or past the panel edge.
  const panelRight = document.querySelector('#inv .panel').getBoundingClientRect().right;
  let worst = 0;
  for (const b of col.querySelectorAll('.row b')) worst = Math.max(worst, b.getBoundingClientRect().right);
  return {
    overflow: col.scrollHeight - col.clientHeight,
    railVisible: getComputedStyle(inv.railEl).display !== 'none' && r0.height > 60,
    thumbH: Math.round(t0.height),
    thumbMoved: t1.top - t0.top,
    railH: Math.round(r0.height),
    worstValueRight: Math.round(worst),
    railLeft: Math.round(r0.left),
    panelRight: Math.round(panelRight),
  };
});
ok(rail.overflow > 100, 'the STATS tab genuinely overflows its box (the bug precondition)', `${rail.overflow}px hidden`);
ok(rail.railVisible && rail.thumbH >= 24,
  'BUG 1 DEAD: a scrollbar rail is VISIBLE while content overflows', `rail ${rail.railH}px, thumb ${rail.thumbH}px`);
ok(rail.thumbMoved > 20, 'the thumb tracks the scroll position', `moved ${Math.round(rail.thumbMoved)}px`);
ok(rail.worstValueRight <= rail.railLeft + 1,
  'row values stop before the rail lane — nothing clips against the panel edge',
  `worst ${rail.worstValueRight} vs rail at ${rail.railLeft}`);

// STATS tab content
const stats = await page.evaluate(() => document.querySelector('#invBody').textContent);
for (const want of ['IDENTITY', 'RESOURCES', 'Emberdust', 'STRENGTH', 'DERIVED', 'Dodge window', 'ARMOUR', 'ARMY']) {
  ok(stats.includes(want), `the STATS tab reports ${want}`);
}
// The spec's answered open question: Emberdust surfaces in the STATS tab, and
// before the ascension step drops any, the honest number is 0.
const emberRow = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#invBody .row')]
    .find((x) => x.querySelector('span')?.textContent.startsWith('Emberdust'));
  return r ? r.querySelector('b')?.textContent : null;
});
ok(emberRow === '0', 'Emberdust reads 0 before any has dropped', String(emberRow));
ok(/Armour reduction0\.0%/.test(stats.replace(/\s+/g, '')) || stats.includes('0.0%'),
  'naked: the armour readout reports 0.0% reduction');
await page.screenshot({ path: shotPath('inv-panel-stats.png') });

// ------------------------------------------- 3-A bug 2: SHEATHE/DRAW truth
//
// The city does NOT pause under the sheet, so the auto-stow policy can flip
// the stance while the button is on screen. Shipped behaviour: the label went
// stale AND the tap toggled off the LIVE stance — tapping the word SHEATHE
// drew the sword. Now: the label is polled fresh, and the tap applies what the
// label SAYS, even when it races the poll.
const stance = await page.evaluate(async () => {
  const g = window.__game;
  const W = window.__weapons;
  const btn = document.getElementById('invStance');
  // Pin the auto-stow policy for the duration: this test drives the stance by
  // hand, and the policy re-sheathing an idle plaza player mid-assert would
  // read as a flaky button. _stanceHold is the policy's own suppression
  // mechanism; it is restored before the gate section needs the policy back.
  g._stanceHold = 9999;
  g.setStance('drawn', { manual: false });
  await new Promise((r) => setTimeout(r, 400));
  const labelDrawn = btn.textContent;
  // The policy sheathes under the open sheet…
  g.setStance('sheathed', { manual: false });
  await new Promise((r) => setTimeout(r, 500));   // > one 300 ms poll tick
  const labelAfterAuto = btn.textContent;
  // …and a tap that RACES the poll still does what the player read: flip the
  // stance right now and click before any poll can update the label.
  g.setStance('drawn', { manual: false });
  const labelAtTap = btn.textContent;             // stale on purpose: 'DRAW'
  btn.click();
  const stanceAfterTap = W.weaponStance(g.player.mesh);
  const labelAfterTap = btn.textContent;
  g._stanceHold = 0;   // hand the stance back to the policy
  return { labelDrawn, labelAfterAuto, labelAtTap, stanceAfterTap, labelAfterTap };
});
ok(stance.labelDrawn === 'SHEATHE', 'drawn weapon: the button offers SHEATHE', stance.labelDrawn);
ok(stance.labelAfterAuto === 'DRAW',
  'BUG 2a DEAD: the label follows an auto-stow that happens under the open sheet', stance.labelAfterAuto);
ok(stance.labelAtTap === 'DRAW' && stance.stanceAfterTap === 'drawn',
  'BUG 2b DEAD: a tap that races the poll applies what the label SAYS (DRAW -> drawn, never the opposite)',
  `label ${stance.labelAtTap} -> ${stance.stanceAfterTap}`);
ok(stance.labelAfterTap === 'SHEATHE', 'and the label re-renders from the applied stance', stance.labelAfterTap);

// ------------------------------------------------- step 13: armour slots LIVE
//
// The chest slot: two candidates equippable, two locked (level / rank), with
// the Exchange's exact wording, a compare strip with deltas BEFORE the equip
// commits, swap semantics into save.equipment, one persistence write, and the
// silhouette refresh the step-12 report left wired-but-uncalled.
await page.click('#inv .slot[data-slot="chest"]');
await page.waitForTimeout(300);
const chestList = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('#invBody .gate')].map((r) => ({
    name: r.querySelector('.meta b')?.textContent,
    sub: r.querySelector('.meta small')?.textContent,
    locked: r.classList.contains('locked'),
  })),
  text: document.getElementById('invBody').textContent,
}));
ok(chestList.rows.length === 4, 'the chest slot lists exactly its four stashed candidates', `${chestList.rows.length} rows`);
ok(chestList.rows.some((r) => r.sub === 'REQUIRES LEVEL 34' && r.locked),
  'a level-locked piece says REQUIRES LEVEL 34 (shop wording)', 'vigil_chest');
ok(chestList.rows.some((r) => r.sub === 'C-GRADE HUNTERS ONLY' && r.locked),
  'a rank-locked piece says C-GRADE HUNTERS ONLY (shop wording)', 'deepglass_chest');
await page.screenshot({ path: shotPath('inv-panel-armor-slot.png') });

// Tap the ossuary chest -> the compare strip, deltas first, nothing equipped yet.
const preEquip = await page.evaluate(() => {
  const g = window.__game;
  const row = [...document.querySelectorAll('#invBody .gate')].find((r) => r.textContent.includes('Ossuary'));
  row.click();
  return {
    chest: g.save.equipment.chest,
    appearance: g.player.mesh.userData.appearance?.key || null,
    charsReady: window.__characters?.ready?.() || false,
  };
});
await page.waitForTimeout(300);
const cmp = await page.evaluate(() => {
  const strip = document.getElementById('invCompare');
  const btn = document.getElementById('invEquipConfirm');
  const b = btn?.getBoundingClientRect();
  return {
    present: Boolean(strip),
    text: strip?.textContent || '',
    equipEnabled: btn ? !btn.disabled : false,
    equipH: b ? Math.round(b.height) : 0,
  };
});
ok(preEquip.chest === null, 'tapping a stash row does NOT equip — the deltas come first', 'chest still empty');
ok(cmp.present && cmp.text.includes('(+'), 'the compare strip shows signed deltas', cmp.text.slice(0, 90));
ok(cmp.text.includes('Armor') && cmp.text.includes('Set'), 'the strip covers armour and set identity');
ok(cmp.equipEnabled, 'EQUIP is enabled for an equippable piece');
ok(cmp.equipH >= 44, 'the EQUIP commit button holds the 44 px tap floor', `${cmp.equipH}px`);
await page.screenshot({ path: shotPath('inv-panel-compare.png') });

// Confirm.
await page.click('#invEquipConfirm');
await page.waitForTimeout(400);
const equipped = await page.evaluate(() => {
  const g = window.__game;
  return {
    chest: g.save.equipment.chest,
    armorStash: g.armorStash.map((r) => r.b),
    weaponStash: g.stash.length,
    armorDR: g.derived.armorDR,
    persisted: JSON.parse(localStorage.getItem('gatebreaker.save.v2')).equipment.chest,
    persistedStash: JSON.parse(localStorage.getItem('gatebreaker.save.v2')).stash.length,
    appearance: g.player.mesh.userData.appearance?.key || null,
    save: JSON.parse(JSON.stringify(g.save)),
    derived: JSON.parse(JSON.stringify(g.derived)),
  };
});
ok(equipped.chest?.b === 'ossuary_chest', 'EQUIP moves the record into save.equipment.chest', JSON.stringify(equipped.chest));
ok(!equipped.armorStash.includes('ossuary_chest') && equipped.armorStash.length === 4,
  'the equipped record LEFT the stash — swap, no duplicate', equipped.armorStash.join(','));
ok(equipped.persisted?.b === 'ossuary_chest' && equipped.persistedStash === equipped.weaponStash + 4,
  'the swap was persisted in one write', `${equipped.persisted?.b} + ${equipped.persistedStash} stashed`);
ok(equipped.armorDR > 0, 'worn armour is LIVE: armorDR moved off zero', `${(equipped.armorDR * 100).toFixed(1)}%`);
// The single-computation-site law, re-asserted through the panel's own path.
const foldBonus = armorDerive(equipped.save.equipment, equipped.save.level);
const foldDerived = JSON.parse(JSON.stringify(derive(equipped.save, foldBonus)));
ok(JSON.stringify(foldDerived) === JSON.stringify(equipped.derived),
  'panel equip re-derives byte-identically to the pure fold', `armorDR ${(equipped.derived.armorDR * 100).toFixed(1)}%`);
// Step 12's live-equip wiring (the previous wave left this exact call to the
// panel): the silhouette follows the equipment on a real equip.
if (preEquip.charsReady) {
  ok(equipped.appearance && equipped.appearance !== preEquip.appearance,
    'equipping armour re-skins the hunter (step-12 look applied live)',
    `${preEquip.appearance} -> ${equipped.appearance}`);
} else {
  ok(true, 'character pack not ready — silhouette check skipped (procedural body)', 'skipped');
}
await page.screenshot({ path: shotPath('inv-panel-armor-equipped.png') });

// A locked piece: the strip opens, names the reason, and refuses the commit.
const lockedTry = await page.evaluate(() => {
  const row = [...document.querySelectorAll('#invBody .gate')].find((r) => r.textContent.includes('Vigil'));
  row.click();
  return true;
});
await page.waitForTimeout(300);
const lockedCmp = await page.evaluate(() => {
  const g = window.__game;
  const btn = document.getElementById('invEquipConfirm');
  const before = g.save.equipment.chest?.b;
  btn?.click();
  return {
    lockedTry: true,
    disabled: btn?.disabled,
    reason: document.querySelector('#invCompare .cmp-reason')?.textContent || '',
    chestAfter: g.save.equipment.chest?.b,
    before,
  };
});
ok(lockedTry && lockedCmp.disabled && lockedCmp.reason === 'REQUIRES LEVEL 34',
  'a locked piece opens the strip but EQUIP is dead, reason named', lockedCmp.reason);
ok(lockedCmp.chestAfter === lockedCmp.before, 'clicking the dead button changes nothing', lockedCmp.chestAfter);
await page.click('#invCompareBack');
await page.waitForTimeout(250);

// UNEQUIP: back to the stash, derived back to naked, look stripped.
const unequip = await page.evaluate(() => {
  document.getElementById('invUnequip').click();
  const g = window.__game;
  return {
    chest: g.save.equipment.chest,
    armorStash: g.armorStash.map((r) => r.b),
    armorDR: g.derived.armorDR,
    persisted: JSON.parse(localStorage.getItem('gatebreaker.save.v2')).equipment.chest,
  };
});
ok(unequip.chest === null && unequip.persisted === null, 'UNEQUIP empties the slot in memory and on disk');
ok(unequip.armorStash.includes('ossuary_chest') && unequip.armorStash.length === 5,
  'the piece went back to the stash — still no duplicate', unequip.armorStash.join(','));
ok(unequip.armorDR === 0, 'derived armour returns to zero when naked', String(unequip.armorDR));

// The trinket slot (the spec's answered open question: KEEP) equips too.
await page.click('#inv .slot[data-slot="trinket"]');
await page.waitForTimeout(250);
await page.evaluate(() => {
  [...document.querySelectorAll('#invBody .gate')].find((r) => r.textContent.includes('Ember Ring'))?.click();
});
await page.waitForTimeout(250);
await page.click('#invEquipConfirm');
await page.waitForTimeout(300);
const trinket = await page.evaluate(() => ({
  worn: window.__game.save.equipment.trinket,
  leech: window.__game._armorBonus?.leech || 0,
}));
ok(trinket.worn?.k === 't' && trinket.worn?.b === 'ember_ring', 'the trinket slot equips a ring', JSON.stringify(trinket.worn));
ok(trinket.leech > 0, 'the trinket effect reaches the armour fold', `leech +${(trinket.leech * 100).toFixed(1)}%`);

// The offhand stays honest: no offhand item exists this wave.
await page.click('#inv .slot[data-slot="offhand"]');
await page.waitForTimeout(250);
const offhand = await page.evaluate(() => document.getElementById('invBody').textContent);
ok(/NOT YET FITTED/.test(offhand), 'the offhand still says NOT YET FITTED rather than pretending');

// ------------------------------------------------ STASH_LIMIT is 40, enforced
const cap = await page.evaluate(() => {
  const g = window.__game;
  const before = g.armorStash.slice();
  // Fill to the cap with real records, persist, and try to unequip into it.
  while (g.stash.length + g.armorStash.length < 40) {
    g.armorStash.push({ k: 'a', b: 'issue_head', r: 'common', s: 1, l: 1 });
  }
  g._persistLoadout();
  const persistedAtCap = JSON.parse(localStorage.getItem('gatebreaker.save.v2')).stash.length;
  const overflowRefused = g.invUI._unequipArmor('trinket') === false;
  const trinketStillWorn = g.save.equipment.trinket?.b === 'ember_ring';
  // One MORE record than the cap must be trimmed by the persist path.
  g.armorStash.push({ k: 'a', b: 'issue_head', r: 'common', s: 2, l: 1 });
  g._persistLoadout();
  const trimmed = JSON.parse(localStorage.getItem('gatebreaker.save.v2')).stash.length;
  // restore
  g.armorStash = before;
  g._persistLoadout();
  return { persistedAtCap, overflowRefused, trinketStillWorn, trimmed };
});
ok(cap.persistedAtCap === 40, 'the shared stash persists 40 records (12 was the 3-A cap)', String(cap.persistedAtCap));
ok(cap.trimmed === 40, 'a 41st record is trimmed, never written', String(cap.trimmed));
ok(cap.overflowRefused && cap.trinketStillWorn,
  'UNEQUIP into a full stash is refused instead of silently deleting a record');

// --------------------------------------------------------------- SETS tab
await page.click('#inv .tabs button[data-tab="sets"]');
await page.waitForTimeout(300);
const sets = await page.evaluate(() => document.getElementById('invBody').textContent);
for (const name of ["HUNTER'S ISSUE", 'OSSUARY PLATE', 'DEEPGLASS WEAVE', 'EMBERFALL HARNESS', "ARCHON'S VIGIL"]) {
  ok(sets.includes(name), `the SETS tab lists ${name}`);
}
ok((sets.match(/\/ 5/g) || []).length >= 5, 'every set shows an n / 5 progress readout',
  `${(sets.match(/\/ 5/g) || []).length} counters`);
// >= 5, not === 5: the vigil 5-piece RULE's own text mentions "2-piece", so a
// literal count of the substring legitimately lands on six.
ok((sets.match(/2-piece/g) || []).length >= 5 && (sets.match(/4-piece/g) || []).length >= 5
  && (sets.match(/5-piece/g) || []).length >= 5,
  'all three threshold lines are spelled out per set');
await page.screenshot({ path: shotPath('inv-panel-sets.png') });

// ------------------------------------------------------------- weapon swap
await page.click('#inv .slot[data-slot="weapon"]');
await page.waitForTimeout(250);
const swap = await page.evaluate(() => {
  const g = window.__game;
  const before = { held: g.weapon.baseId, stash: g.stash.map((w) => w.baseId) };
  g.invUI._equip(0);
  const after = { held: g.weapon.baseId, stash: g.stash.map((w) => w.baseId) };
  return {
    before,
    after,
    saved: (g.save.stash || []).filter((r) => r.k === 'w').map((r) => r.b),
    savedWeapon: g.save.equipment.weapon?.b,
  };
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
  pollStopped: window.__game.invUI._stancePoll === null,
}));
ok(closed.hidden && !closed.bodyClass, 'Escape closes the sheet');
ok(closed.mode === 'city' && closed.state === 'playing',
  'closing does NOT rebuild the city or leave the game paused', `${closed.mode}/${closed.state}`);
ok(closed.pollStopped, 'the stance-label poll stops with the sheet (no zombie interval)');

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

// ---------------------------------------------------- step 11: a worn set is LIVE
//
// A fresh page with a save that WEARS a full ossuary set (records written the
// way the sanitiser stores them). Three claims, each one the spec's:
//   1. game.derived is byte-identical to the pure fold derive(save,
//      armorDerive(equipment, level)) — refreshDerived really is the single
//      computation site and nothing in the boot path re-rolls or drifts.
//   2. _damagePlayer applies the multiplicative stack and the set rules: the
//      ossuary 2pc moves the armorDR term, and below 35% HP the 5pc bulwark
//      cuts damage 20% and lets trash stagger nothing.
//   3. The SETS tab shows 5/5 with all three bonus lines ACTIVE.
const ARMORED = {
  ...LEGACY,
  stash: [
    { b: 'sunderaxe', r: 'uncommon', s: 4242, l: 8 },
    { b: 'whisperfangs', r: 'common', s: 77, l: 5 },
  ],
  equipment: {
    weapon: { k: 'w', b: 'dawnbrand', r: 'rare', s: 990211, l: 12 },
    offhand: null,
    head: { k: 'a', b: 'ossuary_head', r: 'rare', s: 1101, l: 14 },
    chest: { k: 'a', b: 'ossuary_chest', r: 'rare', s: 1102, l: 14 },
    hands: { k: 'a', b: 'ossuary_hands', r: 'rare', s: 1103, l: 14 },
    legs: { k: 'a', b: 'ossuary_legs', r: 'rare', s: 1104, l: 14 },
    feet: { k: 'a', b: 'ossuary_feet', r: 'rare', s: 1105, l: 14 },
    trinket: { k: 't', b: 'ember_ring', r: 'uncommon', s: 1106, l: 14 },
  },
};
// The first page keeps rendering its dungeon otherwise, and two WebGL
// contexts on SwiftShader is how a 30 s boot wait times out.
await page.close();
const { page: page2, errors: errors2 } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });
await page2.addInitScript((save) => {
  try { localStorage.setItem('gatebreaker.save.v2', JSON.stringify(save)); } catch { /* blocked */ }
}, ARMORED);
await gotoGame(page2);
await page2.click('#btnPlay');
await page2.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page2.waitForTimeout(1200);

const live = await page2.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  const d = g.derived;
  const probe = (hpFrac, source) => {
    p.alive = true;
    p.hp = d.maxHp * hpFrac;
    p.invuln = 0; p._dodgeT = 0; p.hurt = 0;
    const before = p.hp;
    g._damagePlayer(100, null, source || null);
    return { dmg: Math.round((before - p.hp) * 1000) / 1000, hurt: p.hurt };
  };
  const full = probe(1.0, null);
  const low = probe(0.2, null);
  const lowTrash = probe(0.2, { key: 'grunt', isBoss: false });
  const lowElite = probe(0.2, { key: 'brute', isBoss: false });
  // restore
  p.hp = d.maxHp; p.invuln = 1;
  return {
    save: JSON.parse(JSON.stringify(g.save)),
    derived: JSON.parse(JSON.stringify(g.derived)),
    rules: [...(g._rules?.keys() || [])],
    full, low, lowTrash, lowElite,
  };
});

// 1. the derived block IS the pure fold, byte for byte.
const nodeBonus = armorDerive(live.save.equipment, live.save.level);
const nodeDerived = JSON.parse(JSON.stringify(derive(live.save, nodeBonus)));
ok(JSON.stringify(nodeDerived) === JSON.stringify(live.derived),
  'game.derived is byte-identical to the pure fold derive(save, armorDerive(equipment))',
  `armorDR ${(live.derived.armorDR * 100).toFixed(1)}%`);
ok(live.derived.armorDR > 0.10 && live.derived.armorDR < 0.30,
  'a full rare ossuary set at L14 lands in the spec 15-21% band (2pc x1.10 included)',
  `${(live.derived.armorDR * 100).toFixed(1)}%`);
ok(live.rules.includes('lowhp_bulwark'), 'the 5-piece RULE is registered', live.rules.join(','));

// 2. the damage pipeline: multiplicative stack, then the bulwark under 35%.
const expectFull = Math.max(1, Math.round(100 * (1 - combinedDR(nodeDerived.dr, nodeDerived.armorDR))));
const expectLow = Math.max(1, Math.round(100 * (1 - combinedDR(nodeDerived.dr, nodeDerived.armorDR)) * 0.80));
ok(live.full.dmg === expectFull,
  '_damagePlayer applies taken = raw x (1 - combinedDR(dr, armorDR))', `${live.full.dmg} vs ${expectFull}`);
ok(live.low.dmg === expectLow,
  'below 35% HP the ossuary bulwark cuts a further 20%', `${live.low.dmg} vs ${expectLow}`);
ok(live.lowTrash.hurt === 0 && live.lowElite.hurt > 0,
  'while low, trash (grunt) cannot stagger but an elite (brute) still can',
  `grunt hurt ${live.lowTrash.hurt}, brute hurt ${live.lowElite.hurt.toFixed(2)}`);

// 3. the SETS tab, worn.
await page2.click('#btnInventory');
await page2.waitForTimeout(400);
await page2.click('#inv .tabs button[data-tab="sets"]');
await page2.waitForTimeout(320);
const setText = await page2.evaluate(() => document.querySelector('#invBody').textContent);
ok(setText.includes('OSSUARY PLATE') && setText.includes('5 / 5'),
  'the SETS tab shows OSSUARY PLATE 5 / 5');
ok((setText.match(/ACTIVE/g) || []).length === 3, 'exactly the worn set\'s three threshold lines read ACTIVE',
  `${(setText.match(/ACTIVE/g) || []).length} ACTIVE`);
// Scroll the worn set into frame so the screenshot PROVES the readout.
await page2.evaluate(() => {
  const col = document.getElementById('invCol');
  const rows = [...col.querySelectorAll('.readout')];
  const worn = rows.find((r) => r.textContent.includes('OSSUARY'));
  if (worn) worn.scrollIntoView({ block: 'start' });
});
await page2.waitForTimeout(250);
await page2.screenshot({ path: shotPath('inv-panel-sets-live.png') });

// The worn chest renders in its slot cell and the GEAR tab offers UNEQUIP.
await page2.click('#inv .slot[data-slot="chest"]');
await page2.waitForTimeout(300);
const wornChest = await page2.evaluate(() => ({
  text: document.getElementById('invBody').textContent,
  unequip: Boolean(document.getElementById('invUnequip')),
}));
ok(/EQUIPPED/.test(wornChest.text) && wornChest.unequip,
  'a worn slot shows the piece and offers UNEQUIP', 'ossuary chest');
await page2.screenshot({ path: shotPath('inv-panel-worn-chest.png') });

ok(errors2.length === 0, 'zero page errors on the armoured boot', errors2.slice(0, 2).join(' | ') || 'none');

ok(errors.length === 0, 'zero page errors', errors.slice(0, 2).join(' | ') || 'none');

writeReport('inventory-result.json', { pass, fail, results, errors: errors.concat(errors2) });
console.log(`\nshots + report: ${OUT}`);
console.log(fail === 0 ? `INVENTORY PASSED — ${pass} checks` : `INVENTORY FAILED — ${fail} of ${pass + fail}`);

await browser.close();
await server.stop();
if (fail) process.exitCode = 1;
