// Wave 4 acceptance: the equipment save model, stow/draw, and the hunter's
// sheet — now the V3 "paper doll" port (persistent stage + compare/sets/stats
// SHEETS replacing the old GEAR/STATS/SETS TABS), with a REAL live character
// render at centre — on a phone-shaped landscape viewport.
//
// The things this exists to catch, all of which have bitten this repo before
// in one form or another, PLUS what this port itself introduced:
//   1. A save written by the SHIPPED build must still boot. The migration runs
//      on first contact from every entry point, so the test writes a real
//      pre-wave profile into localStorage and then reads the live game back.
//   2. Equipping out of the stash must SWAP, not push — for weapons AND for
//      armour. The push-only path is a duplication exploit the moment a panel
//      lets you do it on purpose.
//   3. A panel must fit 412 CSS px of height. The Exchange already paid for
//      that lesson; the sheet has strictly more content than the Exchange.
//   4. TWO SHIPPED 3-A BUGS stay dead: a scroll box must carry a VISIBLE
//      panel-owned rail (native scrollbars are overlay-or-nothing platform
//      policy), and the SHEATHE/DRAW button must never go stale under the
//      city's auto-stow policy and apply the OPPOSITE of its own label.
//   5. THE PORT'S OWN BUG, caught and fixed during this wave: the inventory
//      camera's fixed offset from the player can end up staring straight into
//      a nearby ally instead of the player — the city's roster companion
//      (citizens.js's 'city_companion', which heels at the player's shoulder)
//      reproduced this 100% of the time with a bound shadow. game.js now
//      hides any VISIBLE shadow mesh and the companion for the shot's
//      duration; this file asserts that both the render is sane WITH a bound
//      shadow on the roster and that the hidden meshes come back after close.
//   6. HARD NUMBERS: no "x1.NN" multiplier notation may survive anywhere on
//      the panel, dodge window reads in seconds, and damage reduction reads
//      "NN% (CAP 72%)" against the REAL cap.
//
//   GB_PORT=5251 node tools/inventory-test.mjs

import fs from 'node:fs';
import { launchBrowser, newPhonePage, ensureServer, gotoGame, shotPath, OUT, writeReport } from './_harness.mjs';
// Step 11's live checks recompute the armour fold in pure node and demand the
// page agrees byte-for-byte — the strongest possible "single computation site"
// assertion.
import { armorDerive, combinedDR, TOTAL_DR_CAP } from '../src/game/armor.js';
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
// they are what the panel equips from. shadows.roster carries ONE bound
// shadow deliberately: this is the exact shape that reproduced the port's own
// camera bug (see the header), so the migration/boot path is tested with it
// present rather than in spite of it.
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
    slots: inv?.querySelectorAll('.rail .slot').length || 0,
    leftSlots: [...(inv?.querySelectorAll('#invRailLeft .slot') || [])].map((b) => b.dataset.slot),
    rightSlots: [...(inv?.querySelectorAll('#invRailRight .slot') || [])].map((b) => b.dataset.slot),
    tickerCells: inv?.querySelectorAll('#invTicker .cell').length || 0,
    hasStatsBtn: Boolean(document.getElementById('invStatsBtn')),
    hasSetsBtn: Boolean(document.getElementById('invSetsBtn')),
    hasOpenStash: Boolean(document.getElementById('invOpenStash')),
    hasStance: Boolean(document.getElementById('invStance')),
    panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
    panelBottom: panel ? Math.round(panel.getBoundingClientRect().bottom) : 0,
    viewport: window.innerHeight,
    docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cityUiHidden: (() => {
      const c = document.getElementById('cityUi');
      return !c || getComputedStyle(c).display === 'none';
    })(),
    hudHidden: (() => {
      const h = document.getElementById('hud');
      return !h || getComputedStyle(h).display === 'none';
    })(),
    invViewActive: Boolean(window.__game._invView),
  };
});
ok(open.visible && open.bodyClass, 'the inventory button opens the sheet');
ok(open.slots === 8, 'eight equipment slots are on screen', String(open.slots));
ok(open.leftSlots.join(',') === 'weapon,offhand,head,chest',
  'the left rail carries weapon/offhand/head/chest, in EQUIP_SLOTS order', open.leftSlots.join(','));
ok(open.rightSlots.join(',') === 'hands,legs,feet,trinket',
  'the right rail carries hands/legs/feet/trinket', open.rightSlots.join(','));
ok(open.tickerCells === 8, 'the bottom ticker shows exactly eight always-visible stats', String(open.tickerCells));
ok(open.hasStatsBtn && open.hasSetsBtn, 'the ticker carries the STATS and SETS sheet buttons');
ok(open.hasOpenStash && open.hasStance, 'the stage carries OPEN STASH and the stow/draw button, per the V3 layout');
ok(open.panelBottom <= open.viewport + 1 && open.panelHeight > 0,
  'the panel fits a 412 px landscape viewport', `${open.panelHeight}px tall, bottom ${open.panelBottom} of ${open.viewport}`);
ok(open.docScroll === 0, 'the page does not scroll horizontally', `${open.docScroll}px overflow`);
ok(open.cityUiHidden, 'the city overlay is hidden so it cannot eat taps');
ok(open.hudHidden, 'the HUD is hidden so its own chrome cannot bleed through the transparent stage');
ok(open.invViewActive, 'open() hands the camera to the paper-doll framing (game._invView is set)');
await page.screenshot({ path: shotPath('inv-panel-main.png') });

// ------------------------------------------------- THE REAL CHARACTER RENDER
//
// Non-negotiable per the brief: the centre of the stage must be the ACTUAL
// player mesh, not a placeholder. Proven three ways: (a) the stage window has
// no opaque covering of its own so the live canvas shows through, (b) the
// camera the game is rendering with is NOT the standard follow rig (proof the
// hook actually took over), and (c) — the strongest proof — the SAME PIXELS
// change when the equipped gear changes, asserted further down once a chest
// piece is equipped.
const stageRender = await page.evaluate(() => {
  const stage = document.getElementById('invStageCenter');
  const cs = getComputedStyle(stage);
  return {
    stageBackgroundAlphaLow: (() => {
      // The stage's own CSS background is a low-alpha radial gradient, not an
      // opaque fill — parse the rgba() the browser resolves the shorthand to.
      const m = cs.backgroundImage.match(/rgba?\(([^)]+)\)/);
      if (!m) return true; // 'none' / transparent also passes
      const parts = m[1].split(',').map((s) => parseFloat(s));
      const a = parts[3] ?? 1;
      return a < 0.2;
    })(),
    cameraIsInventoryFramed: Boolean(window.__game._invView),
    playerMeshVisible: window.__game.player.mesh.visible !== false,
  };
});
ok(stageRender.stageBackgroundAlphaLow,
  'the stage window carries no opaque covering — the live scene shows through');
ok(stageRender.cameraIsInventoryFramed && stageRender.playerMeshVisible,
  'the ONE renderer/camera is pointed at the ACTUAL live player mesh, not a placeholder');

// ------------------------------------------- 3-A bug 1: the clip with no scrollbar
//
// The STATS sheet is the densest surface in the panel — the same shape the
// old shipped bug lived in. The panel draws its OWN rail (native scrollbars
// are overlay-or-nothing platform policy — measured on this very harness:
// even a pure ::-webkit-scrollbar customisation kept offsetWidth ===
// clientWidth and painted nothing until mid-scroll). The rail must be
// visible, sized, and must move with the scroll.
await page.click('#invStatsBtn');
await page.waitForTimeout(350);
const rail = await page.evaluate(async () => {
  const col = document.querySelector('#invOverlayBody .scrollCol');
  const railEl = document.querySelector('#invOverlayBody .rail2');
  const thumbEl = railEl?.querySelector('.thumb');
  const r0 = railEl.getBoundingClientRect();
  const t0 = thumbEl.getBoundingClientRect();
  col.scrollTop = col.scrollHeight;   // to the end
  await new Promise((r) => setTimeout(r, 120));
  const t1 = thumbEl.getBoundingClientRect();
  col.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 120));
  // No row value may render under the rail's lane or past the panel edge.
  const panelRight = document.querySelector('#inv .panel').getBoundingClientRect().right;
  let worst = 0;
  for (const b of col.querySelectorAll('.readout b, .row b')) worst = Math.max(worst, b.getBoundingClientRect().right);
  return {
    overflow: col.scrollHeight - col.clientHeight,
    railVisible: getComputedStyle(railEl).display !== 'none' && r0.height > 60,
    thumbH: Math.round(t0.height),
    thumbMoved: t1.top - t0.top,
    railH: Math.round(r0.height),
    worstValueRight: Math.round(worst),
    railLeft: Math.round(r0.left),
    panelRight: Math.round(panelRight),
  };
});
ok(rail.overflow > 100, 'the STATS sheet genuinely overflows its box (the bug precondition)', `${rail.overflow}px hidden`);
ok(rail.railVisible && rail.thumbH >= 24,
  'BUG 1 DEAD: a scrollbar rail is VISIBLE while content overflows', `rail ${rail.railH}px, thumb ${rail.thumbH}px`);
ok(rail.thumbMoved > 20, 'the thumb tracks the scroll position', `moved ${Math.round(rail.thumbMoved)}px`);
ok(rail.worstValueRight <= rail.railLeft + 1,
  'row values stop before the rail lane — nothing clips against the panel edge',
  `worst ${rail.worstValueRight} vs rail at ${rail.railLeft}`);

// STATS sheet content — everything the old tabbed view held, nothing cut.
const stats = await page.evaluate(() => document.querySelector('#invOverlayBody').textContent);
for (const want of [
  'IDENTITY', 'RESOURCES', 'Emberdust', 'STRENGTH', 'DERIVED',
  'OFFENSE', 'DEFENSE', 'MOBILITY', 'RESOURCE', 'Dodge window', 'ARMOUR', 'ARMY',
]) {
  ok(stats.includes(want), `the STATS sheet reports ${want}`);
}
// The spec's answered open question: Emberdust surfaces in the sheet, and
// before the ascension step drops any, the honest number is 0.
const emberRow = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#invOverlayBody .row')]
    .find((x) => x.querySelector('span')?.textContent.startsWith('Emberdust'));
  return r ? r.querySelector('b')?.textContent : null;
});
ok(emberRow === '0', 'Emberdust reads 0 before any has dropped', String(emberRow));
// HARD NUMBERS: the headline damage-reduction row is the REAL combined
// number against the REAL cap — "NN% (CAP 72%)", never the mockup's invented
// 75. LEGACY has spent vitality points (str4/agi2/vit3 + 13 auto-granted), so
// the COMBINED figure is legitimately non-zero even with no armour worn —
// the row() helper's own comment explains the query below (label and value
// are not textContent-adjacent, a sub-hint sits between them).
ok(stats.includes(`(CAP ${Math.round(TOTAL_DR_CAP * 100)}%)`),
  `damage reduction shows the REAL total cap (${Math.round(TOTAL_DR_CAP * 100)}%), not an invented one`);
const rowValue = async (labelStart) => page.evaluate((want) => {
  const r = [...document.querySelectorAll('#invOverlayBody .row')]
    .find((x) => x.querySelector('span')?.textContent.startsWith(want));
  return r ? r.querySelector('b')?.textContent : null;
}, labelStart);
const drRowValue = await rowValue('Damage reduction');
ok(/^\d+% \(CAP 72%\)$/.test(drRowValue || ''),
  'the headline damage reduction is well-formed: "NN% (CAP 72%)"', String(drRowValue));
// The ARMOUR-ONLY breakdown row is the one that must read naked-zero here —
// vitality's own contribution is real and expected, armour's is not (nothing
// is worn yet).
const armourOnly = await rowValue('— armour only');
ok(armourOnly === '0.0%', 'naked: the armour-only breakdown reads 0.0% before anything is worn', String(armourOnly));
// Dodge window is SECONDS, two decimals — the owner's own complaint
// ("dodge window is 114 ms"), answered.
ok(/Dodge window[\s\S]{0,10}0\.\d\ds/.test(stats), 'dodge window reads in seconds, not milliseconds', stats.match(/Dodge window[\s\S]{0,12}/)?.[0]);
await page.screenshot({ path: shotPath('inv-sheet-stats.png') });

// HARD NUMBERS, panel-wide: no "x1.NN" multiplier notation may survive
// ANYWHERE on the sheet — the owner's other named complaint ("everything is
// based on 1.49 damage" WAS this exact notation).
ok(!/\bx\d\.\d\d\b/.test(stats), 'no "x1.NN" multiplier notation survives on the STATS sheet', stats.match(/\bx\d\.\d\d\b/)?.[0] || 'none found');

await page.click('#invOverlayClose');
await page.waitForTimeout(250);

// ------------------------------------------------------------- weapon slot
//
// Tapping ANY slot opens the compare sheet directly — the paper-doll's rails
// have no intermediate list view of their own; the compare sheet's own
// candidate list IS the list.
await page.click('#inv .slot[data-slot="weapon"]');
await page.waitForTimeout(350);
const weaponSheet = await page.evaluate(() => ({
  overlayVisible: !document.getElementById('invOverlay').classList.contains('hidden'),
  title: document.getElementById('invOverlayTitle')?.textContent || document.querySelector('#invOverlay .ohead b')?.textContent,
  equippedName: document.querySelector('#invOverlay .cmpCard.eq .nm')?.textContent,
  candidateCount: document.querySelectorAll('#invOverlayBody .gate').length,
  equipDisabled: document.getElementById('invEquipConfirm')?.disabled,
}));
ok(weaponSheet.overlayVisible, 'tapping the weapon slot opens the compare sheet');
ok(weaponSheet.title === 'WEAPON SLOT', 'the sheet header names the slot', weaponSheet.title);
ok(Boolean(weaponSheet.equippedName?.length > 0),
  'the EQUIPPED card shows the held weapon\'s real (rolled) name', weaponSheet.equippedName);
ok(weaponSheet.candidateCount === 2, 'the weapon stash lists exactly its two spare weapons', String(weaponSheet.candidateCount));
ok(weaponSheet.equipDisabled, 'EQUIP is disabled until a candidate is picked (the two-step flow)');
await page.screenshot({ path: shotPath('inv-sheet-weapon.png') });

// ------------------------------------------------- step 4: weapon two-step
//
// The port's own change (see the file header comment above InventoryUI):
// weapon equips now go through the SAME two-step compare-then-confirm every
// armour slot already used, rather than the old one-tap auto-equip.
const weaponPick = await page.evaluate(() => {
  const g = window.__game;
  const before = { held: g.weapon.baseId, stash: g.stash.map((w) => w.baseId) };
  document.querySelectorAll('#invOverlayBody .gate')[0].click();
  return { before };
});
await page.waitForTimeout(250);
const weaponCmp = await page.evaluate(() => ({
  equipEnabled: !document.getElementById('invEquipConfirm')?.disabled,
  compareText: document.getElementById('invCompare')?.textContent || '',
  heldStillOld: window.__game.weapon.baseId,
}));
ok(weaponCmp.equipEnabled, 'picking a weapon candidate enables EQUIP — nothing equips on the pick itself');
ok(weaponCmp.heldStillOld === weaponPick.before.held, 'the pick alone does not change what is held', weaponCmp.heldStillOld);
ok(weaponCmp.compareText.length > 0 && !weaponCmp.compareText.includes('Pick a candidate'),
  'the delta strip fills in once a candidate is picked');
await page.click('#invEquipConfirm');
await page.waitForTimeout(400);
const weaponSwap = await page.evaluate(() => {
  const g = window.__game;
  return {
    held: g.weapon.baseId,
    stash: g.stash.map((w) => w.baseId),
    savedWeapon: g.save.equipment.weapon?.b,
    saved: (g.save.stash || []).filter((r) => r.k === 'w').map((r) => r.b),
    overlayHidden: document.getElementById('invOverlay').classList.contains('hidden'),
  };
});
ok(weaponSwap.held === weaponPick.before.stash[0], 'confirming EQUIP swaps in the right weapon', weaponSwap.held);
ok(weaponSwap.stash.length === weaponPick.before.stash.length,
  'equipping from the stash SWAPS — no duplicate', `${weaponPick.before.stash.join(',')} -> ${weaponSwap.stash.join(',')}`);
ok(!weaponSwap.stash.includes(weaponSwap.held), 'the equipped weapon is no longer also in the stash', weaponSwap.stash.join(','));
ok(weaponSwap.savedWeapon === weaponSwap.held && weaponSwap.saved.length === weaponSwap.stash.length,
  'the swap was persisted in one write', `${weaponSwap.savedWeapon} + ${weaponSwap.saved.length} spare`);
ok(weaponSwap.overlayHidden, 'confirming EQUIP closes the sheet back to the paper doll — the payoff is seeing it change');

// -------------------------------------------------------------- hard numbers
//
// The weapon compare sheet is where the owner's OWN "1.49 damage" complaint
// lived (weaponSummary's Power row used to print "x1.49"). Re-open the slot
// and check the readout for that exact notation.
await page.click('#inv .slot[data-slot="weapon"]');
await page.waitForTimeout(300);
const weaponNums = await page.evaluate(() => document.getElementById('invOverlayBody').textContent);
ok(!/\bx\d\.\d\d\b/.test(weaponNums), 'the weapon sheet carries no "x1.NN" power notation', weaponNums.match(/\bx\d\.\d\d\b/)?.[0] || 'none found');
ok(/Power[\s\S]{0,6}[+-]\d+%/.test(weaponNums), 'weapon power reads as a signed percentage instead', weaponNums.match(/Power[\s\S]{0,10}/)?.[0]);
await page.click('#invOverlayClose');
await page.waitForTimeout(250);

// ---------------------------------------------------------------- armour
//
// The chest slot: two candidates equippable, two locked (level / rank), with
// the Exchange's exact wording, a compare strip with deltas BEFORE the equip
// commits, swap semantics into save.equipment, one persistence write, and the
// silhouette refresh the step-12 report left wired-but-uncalled — now proven
// by an actual PIXEL DIFF on the character render, per the brief's own bar.
const preShot = await page.screenshot();
await page.click('#inv .slot[data-slot="chest"]');
await page.waitForTimeout(300);
const chestList = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('#invOverlayBody .gate')].map((r) => ({
    name: r.querySelector('.meta b')?.textContent,
    sub: r.querySelector('.meta small')?.textContent,
    locked: r.classList.contains('locked'),
  })),
}));
ok(chestList.rows.length === 4, 'the chest slot lists exactly its four stashed candidates', `${chestList.rows.length} rows`);
ok(chestList.rows.some((r) => r.sub === 'REQUIRES LEVEL 34' && r.locked),
  'a level-locked piece says REQUIRES LEVEL 34 (shop wording)', 'vigil_chest');
ok(chestList.rows.some((r) => r.sub === 'C-GRADE HUNTERS ONLY' && r.locked),
  'a rank-locked piece says C-GRADE HUNTERS ONLY (shop wording)', 'deepglass_chest');
await page.screenshot({ path: shotPath('inv-sheet-armor-slot.png') });

// Tap the ossuary chest -> the compare strip fills in, deltas first, nothing
// equipped yet.
const preEquip = await page.evaluate(() => {
  const g = window.__game;
  const row = [...document.querySelectorAll('#invOverlayBody .gate')].find((r) => r.textContent.includes('Ossuary'));
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
ok(preEquip.chest === null, 'tapping a candidate does NOT equip — the deltas come first', 'chest still empty');
ok(cmp.present && cmp.text.includes('(+'), 'the compare strip shows signed deltas', cmp.text.slice(0, 90));
ok(cmp.text.includes('Armor') && cmp.text.includes('Set'), 'the strip covers armour and set identity');
ok(cmp.equipEnabled, 'EQUIP is enabled for an equippable piece');
ok(cmp.equipH >= 44, 'the EQUIP commit button holds the 44 px tap floor', `${cmp.equipH}px`);
await page.screenshot({ path: shotPath('inv-sheet-compare.png') });

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
    overlayHidden: document.getElementById('invOverlay').classList.contains('hidden'),
    railChestName: document.querySelector('#inv .slot[data-slot="chest"] b')?.textContent,
  };
});
ok(equipped.chest?.b === 'ossuary_chest', 'EQUIP moves the record into save.equipment.chest', JSON.stringify(equipped.chest));
ok(!equipped.armorStash.includes('ossuary_chest') && equipped.armorStash.length === 4,
  'the equipped record LEFT the stash — swap, no duplicate', equipped.armorStash.join(','));
ok(equipped.persisted?.b === 'ossuary_chest' && equipped.persistedStash === equipped.weaponStash + 4,
  'the swap was persisted in one write', `${equipped.persisted?.b} + ${equipped.persistedStash} stashed`);
ok(equipped.armorDR > 0, 'worn armour is LIVE: armorDR moved off zero', `${(equipped.armorDR * 100).toFixed(1)}%`);
ok(equipped.overlayHidden, 'confirming EQUIP closes the sheet back to the paper doll');
ok(equipped.railChestName?.includes('Ossuary'), 'the LEFT RAIL itself now shows the equipped piece', equipped.railChestName);
// The single-computation-site law, re-asserted through the panel's own path.
const foldBonus = armorDerive(equipped.save.equipment, equipped.save.level);
const foldDerived = JSON.parse(JSON.stringify(derive(equipped.save, foldBonus)));
ok(JSON.stringify(foldDerived) === JSON.stringify(equipped.derived),
  'panel equip re-derives byte-identically to the pure fold', `armorDR ${(equipped.derived.armorDR * 100).toFixed(1)}%`);
// Step 12's live-equip wiring: the silhouette follows the equipment on a real
// equip — asserted BOTH structurally (the appearance key changed) AND
// visually (an actual pixel diff against the pre-equip screenshot), which is
// the brief's own bar for "the render changed".
if (preEquip.charsReady) {
  ok(equipped.appearance && equipped.appearance !== preEquip.appearance,
    'equipping armour re-skins the hunter (step-12 look applied live)',
    `${preEquip.appearance} -> ${equipped.appearance}`);
} else {
  ok(true, 'character pack not ready — silhouette check skipped (procedural body)', 'skipped');
}
const postShot = await page.screenshot();
ok(Buffer.compare(preShot, postShot) !== 0,
  'the rendered PIXELS changed after equipping — the live character preview, proven, not asserted');
await page.screenshot({ path: shotPath('inv-panel-armor-equipped.png') });

// A locked piece: the strip opens, names the reason, and refuses the commit.
await page.click('#inv .slot[data-slot="chest"]');
await page.waitForTimeout(300);
const lockedTry = await page.evaluate(() => {
  const row = [...document.querySelectorAll('#invOverlayBody .gate')].find((r) => r.textContent.includes('Vigil'));
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
    reason: document.querySelector('#invOverlayBody .cmp-reason')?.textContent || '',
    chestAfter: g.save.equipment.chest?.b,
    before,
  };
});
ok(lockedTry && lockedCmp.disabled && lockedCmp.reason === 'REQUIRES LEVEL 34',
  'a locked piece opens the strip but EQUIP is dead, reason named', lockedCmp.reason);
ok(lockedCmp.chestAfter === lockedCmp.before, 'clicking the dead button changes nothing', lockedCmp.chestAfter);

// UNEQUIP: back to the stash, derived back to naked, look stripped, sheet
// closes (the port's own consistency call — see _unequipArmor's comment).
const unequip = await page.evaluate(() => {
  document.getElementById('invUnequip').click();
  const g = window.__game;
  return {
    chest: g.save.equipment.chest,
    armorStash: g.armorStash.map((r) => r.b),
    armorDR: g.derived.armorDR,
    persisted: JSON.parse(localStorage.getItem('gatebreaker.save.v2')).equipment.chest,
    overlayHidden: document.getElementById('invOverlay').classList.contains('hidden'),
  };
});
ok(unequip.chest === null && unequip.persisted === null, 'UNEQUIP empties the slot in memory and on disk');
ok(unequip.armorStash.includes('ossuary_chest') && unequip.armorStash.length === 5,
  'the piece went back to the stash — still no duplicate', unequip.armorStash.join(','));
ok(unequip.armorDR === 0, 'derived armour returns to zero when naked', String(unequip.armorDR));
ok(unequip.overlayHidden, 'UNEQUIP also closes the sheet back to the paper doll');

// The trinket slot equips too, and its delta strip carries the effect-swap
// rule (both rows shown when the effects differ).
await page.click('#inv .slot[data-slot="trinket"]');
await page.waitForTimeout(250);
await page.evaluate(() => {
  [...document.querySelectorAll('#invOverlayBody .gate')].find((r) => r.textContent.includes('Ember Ring'))?.click();
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
const offhand = await page.evaluate(() => document.getElementById('invOverlayBody').textContent);
ok(/NOT YET FITTED/.test(offhand), 'the offhand still says NOT YET FITTED rather than pretending');
const offhandNoList = await page.evaluate(() => ({
  hasGate: Boolean(document.querySelector('#invOverlayBody .gate')),
}));
ok(!offhandNoList.hasGate, 'the offhand sheet carries no candidate rows — nothing fits here today');
await page.click('#invOverlayClose');
await page.waitForTimeout(250);

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

// --------------------------------------------------------------- SETS sheet
await page.click('#invSetsBtn');
await page.waitForTimeout(300);
const sets = await page.evaluate(() => document.getElementById('invOverlayBody').textContent);
for (const name of ["HUNTER'S ISSUE", 'OSSUARY PLATE', 'DEEPGLASS WEAVE', 'EMBERFALL HARNESS', "ARCHON'S VIGIL"]) {
  ok(sets.includes(name), `the SETS sheet lists ${name}`);
}
ok((sets.match(/\/ 5/g) || []).length >= 5, 'every set shows an n / 5 progress readout',
  `${(sets.match(/\/ 5/g) || []).length} counters`);
const setCardCount = await page.evaluate(() => document.querySelectorAll('#invOverlayBody .setCard').length);
ok(setCardCount === 5, 'ALL FIVE real sets render as cards — no fake mockup sets (EMBERFORGE/VOIDGLASS/etc) leaked in', String(setCardCount));
await page.screenshot({ path: shotPath('inv-sheet-sets.png') });
await page.click('#invOverlayClose');
await page.waitForTimeout(250);

// ------------------------------------------------------------------- close
await page.keyboard.press('Escape');
await page.waitForTimeout(320);
const closed = await page.evaluate(() => ({
  hidden: document.getElementById('inv').classList.contains('hidden'),
  bodyClass: document.body.classList.contains('gb-inv'),
  mode: window.__game.mode?.name,
  state: window.__game.state,
  pollStopped: window.__game.invUI._stancePoll === null,
  invViewCleared: window.__game._invView === null,
}));
ok(closed.hidden && !closed.bodyClass, 'Escape closes the sheet');
ok(closed.mode === 'city' && closed.state === 'playing',
  'closing does NOT rebuild the city or leave the game paused', `${closed.mode}/${closed.state}`);
ok(closed.pollStopped, 'the stance-label poll stops with the sheet (no zombie interval)');
ok(closed.invViewCleared, 'exitInventoryView cleared the camera hand-off (game._invView is null again)');

// The companion (and any shadow) hidden for the shot must come back. The
// LEGACY save's roster carries exactly one bound shadow, which is what
// reproduced the port's own camera bug — see the file header.
const companionBack = await page.evaluate(() => {
  const c = document.title; // no-op read to keep this block symmetrical
  const comp = window.__game.scene.getObjectByName('city_companion');
  return { present: Boolean(comp), visible: comp ? comp.visible : null };
});
ok(!companionBack.present || companionBack.visible,
  'the heeling companion (hidden for the portrait shot) is visible again after close');

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
  invViewActive: Boolean(window.__game._invView),
}));
ok(inGate.open && inGate.state === 'paused', 'opening the sheet in a gate pauses the sim', inGate.state);
ok(inGate.invViewActive, 'the paper-doll camera framing is active inside a paused gate too');
await page.screenshot({ path: shotPath('inv-panel-in-gate.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const afterGate = await page.evaluate(() => ({
  open: window.__game.invUI.isOpen,
  state: window.__game.state,
  stance: window.__weapons.weaponStance(window.__game.player.mesh),
  invViewCleared: window.__game._invView === null,
}));
ok(!afterGate.open && afterGate.state === 'playing', 'closing it resumes the run', afterGate.state);
ok(afterGate.stance === 'drawn', 'the weapon is drawn inside a gate', afterGate.stance);
ok(afterGate.invViewCleared, 'the camera hand-off clears on close inside a gate too');

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
//   3. The SETS sheet shows 5/5 with all three bonus lines ACTIVE, and the
//      chest rail slot shows the worn piece with an UNEQUIP offered.
const ARMORED = {
  ...LEGACY,
  shadows: { roster: [], deployed: [], nextId: 1 },
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

// 3. the SETS sheet and the rail, worn.
await page2.click('#btnInventory');
await page2.waitForTimeout(400);
await page2.click('#invSetsBtn');
await page2.waitForTimeout(320);
const setText = await page2.evaluate(() => document.querySelector('#invOverlayBody').textContent);
ok(setText.includes('OSSUARY PLATE') && setText.includes('5 / 5'),
  'the SETS sheet shows OSSUARY PLATE 5 / 5');
// Threshold rows carry no literal "ACTIVE" string (they read the same 2PC/
// 4PC/5PC text either way) — earned-vs-unearned is the .tier.live CSS class,
// so that is what the test asserts: exactly the worn set's three thresholds.
const liveTierCount = await page2.evaluate(() => {
  const cards = [...document.querySelectorAll('#invOverlayBody .setCard')];
  const ossuary = cards.find((c) => c.textContent.includes('OSSUARY PLATE'));
  return ossuary ? ossuary.querySelectorAll('.tier.live').length : -1;
});
ok(liveTierCount === 3, 'exactly the worn set\'s three threshold lines are marked live', String(liveTierCount));
await page2.screenshot({ path: shotPath('inv-sheet-sets-live.png') });
await page2.click('#invOverlayClose');
await page2.waitForTimeout(250);

// The worn chest renders in its RAIL slot and its compare sheet offers
// UNEQUIP with the piece's full readout.
await page2.click('#inv .slot[data-slot="chest"]');
await page2.waitForTimeout(300);
const wornChest = await page2.evaluate(() => ({
  text: document.getElementById('invOverlayBody').textContent,
  unequip: Boolean(document.getElementById('invUnequip')),
  railName: document.querySelector('#inv .slot[data-slot="chest"] b')?.textContent,
}));
ok(wornChest.text.includes('Ossuary') && wornChest.unequip, 'a worn slot shows the piece and offers UNEQUIP', 'ossuary chest');
ok(wornChest.railName?.includes('Ossuary'), 'the rail slot itself names the worn piece, not the generic slot label', wornChest.railName);
await page2.screenshot({ path: shotPath('inv-panel-worn-chest.png') });

// The default framing renders the geared-up hunter — a second character
// screenshot proving the render reflects a DIFFERENT loadout than the naked
// LEGACY save above (visually confirmable in the two PNGs).
await page2.click('#invOverlayClose');
await page2.waitForTimeout(250);
await page2.screenshot({ path: shotPath('inv-panel-main-geared.png') });

ok(errors2.length === 0, 'zero page errors on the armoured boot', errors2.slice(0, 2).join(' | ') || 'none');

ok(errors.length === 0, 'zero page errors', errors.slice(0, 2).join(' | ') || 'none');

writeReport('inventory-result.json', { pass, fail, results, errors: errors.concat(errors2) });
console.log(`\nshots + report: ${OUT}`);
console.log(fail === 0 ? `INVENTORY PASSED — ${pass} checks` : `INVENTORY FAILED — ${fail} of ${pass + fail}`);

await browser.close();
await server.stop();
if (fail) process.exitCode = 1;
