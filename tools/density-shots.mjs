// Scratch tool: mid-fight screenshots at the new density, for eyeballing.
//
//   GB_PORT=5260 GB_OUT=... node tools/density-shots.mjs [label]
//
// One shot inside the biggest E combat room with the director's own wave up and
// closing, one inside the E boss chamber with the boss and its adds. No asserts
// — this exists so a human (or a model) can look at the room and say whether it
// reads as populated.

import { ensureServer, launchBrowser, newPhonePage, gotoGame, evalGame, shotPath } from './_harness.mjs';

const LABEL = process.argv[2] || 'density';

const srv = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
await gotoGame(page);

await evalGame(page, (g) => {
  g.save.level = 30;
  g.save.autoStats = 29;
  g.refreshDerived?.(true);
});

const info = await evalGame(page, async (g) => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };

  const realRandom = Math.random;
  Math.random = () => 0.42;              // same dungeon as tools/density-probe
  g.startGate(0);
  Math.random = realRandom;
  await frames(20);
  g.mode._introSkip = true;
  await frames(50);

  const d = g.world;
  const dir = g.mode.director;
  const L = d.layout;
  const combat = L.rooms.filter((r) => r.kind === 'combat');
  const room = combat.reduce((a, b) => (a.w * a.d >= b.w * b.d ? a : b));

  // Immortal for the shot: this is a composition, not a playtest, and a player
  // who dies mid-frame puts a death screen over the thing being photographed.
  g.player.hp = 99999; g.derived.maxHp = 99999; g.player.invuln = 9999;

  g.player.pos.set(room.centre.x, 0, room.centre.z);
  g.player.body?.reset?.(room.centre.x, 0, room.centre.z);
  // Let the room trigger, seal, spawn its wave, and let the wave close in.
  await frames(260);
  return {
    room: { w: room.w, d: room.d, area: room.w * room.d, budget: room.budget },
    waveSize: dir.waveSize, enemies: g.enemies.length, shadows: g.shadows.length,
    total: g.gate.enemies, phase: dir.state,
  };
});
await page.screenshot({ path: shotPath(`${LABEL}-e-room.png`) });

const bossInfo = await evalGame(page, async (g) => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  const d = g.world;
  const dir = g.mode.director;
  const L = d.layout;
  // Skip to the boss: clear every combat room, drop the membranes, walk in.
  for (const r of L.rooms) if (r.kind === 'combat') dir.states[r.id] = 3;
  dir._active = -1;
  for (const e of [...g.enemies]) {
    g.scene.remove(e.mesh); g.scene.remove(e.bar);
    e.mesh.userData.character?.dispose?.();
    g.enemies.length = 0;
  }
  for (const door of L.doors) d.setDoorSealed(door.id, false);
  const boss = L.rooms[L.bossRoom];
  g.player.pos.set(boss.centre.x, 0, boss.centre.z + 9);
  g.player.body?.reset?.(boss.centre.x, 0, boss.centre.z + 9);
  await frames(140);
  // The adds trickle over ~15 s; pull the timer forward until the chamber is at
  // its live cap, then let everyone close in for the shot.
  const want = 1 + dir._adds.live;
  for (let i = 0; i < 500 && g.enemies.length < want; i++) { dir._adds.timer = 0; await frame(); }
  await frames(150);
  // Break contact before the shot. Everything in this game chases the player,
  // so a frame taken while standing still is a frame of the boss standing on
  // the camera — which shows the pack's SPACING not at all. One dash-length
  // step away, photographed before they close again, is the frame a player
  // actually sees when kiting.
  g.player.pos.set(boss.centre.x - 9, 0, boss.centre.z + 11);
  g.player.body?.reset?.(boss.centre.x - 9, 0, boss.centre.z + 11);
  await frames(45);
  return {
    boss: { w: L.rooms[L.bossRoom].w, d: L.rooms[L.bossRoom].d },
    enemies: g.enemies.length, adds: { ...dir._adds }, shadows: g.shadows.length, phase: dir.state,
  };
});
await page.screenshot({ path: shotPath(`${LABEL}-e-boss.png`) });

console.log(JSON.stringify({ info, bossInfo, errors }, null, 2));
console.log(shotPath(`${LABEL}-e-room.png`));
console.log(shotPath(`${LABEL}-e-boss.png`));

await browser.close();
await srv.stop();
