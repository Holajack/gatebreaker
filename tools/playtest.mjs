// Headless logic soak test: drives a scripted hunter through a gate with
// rendering stubbed, so we can verify combat, waves, levelling and the boss
// far faster than real time.
//
//   node tools/playtest.mjs [gateIndex] [simSeconds] [forceLevel]

import { launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame, writeReport, forceOpenGates } from './_harness.mjs';

const gateIndex = Number(process.argv[2] ?? 0);
const simSeconds = Number(process.argv[3] ?? 400);
const forceLevel = Number(process.argv[4] ?? 0);

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);

await gotoGame(page, { waitMs: 2000 });
// Arena-behaviour tool: pin the flat arena for E/D via the sanctioned
// forceOpen dev override (see _harness.forceOpenGates).
await forceOpenGates(page);

const result = await evalGame(page, (g, [gateIdx, seconds, level]) => {
  g.renderer.render = () => {};
  g.fx.damageNumber = () => {};           // skip DOM churn
  const events = [];
  const origToast = g.ui.toast.bind(g.ui);
  g.ui.toast = (m, k) => { events.push(m); origToast(m, k); };

  if (level > 0) {
    g.save.level = level;
    // Spend the accumulated points so the hunter is actually built, not naked.
    const pts = level * 3;
    g.save.stats.str = Math.floor(pts * 0.35);
    g.save.stats.vit = Math.floor(pts * 0.35);
    g.save.stats.agi = Math.floor(pts * 0.15);
    g.save.stats.int = Math.floor(pts * 0.15);
    g.refreshDerived(true);
  }
  g.startGate(gateIdx);
  const inp = g.input;
  const steps = Math.floor(seconds * 60);
  let bossSeen = false;
  let maxEnemies = 0;

  for (let i = 0; i < steps; i++) {
    const e = g._nearestEnemy(g.player.pos, Infinity);
    if (e) {
      const dx = e.pos.x - g.player.pos.x;
      const dz = e.pos.z - g.player.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      // Keep closing even inside melee range. The old bot parked itself at
      // 2.2 units and stopped moving, which a ranged enemy simply kites
      // forever — the soak would sit at "playing" for the whole budget.
      inp.move.x = dx / d; inp.move.y = -dz / d;
      if (d < 3.2) inp.pressed.add('attack');
      if (d > 6 && i % 90 === 0) inp.pressed.add('dash');
      if (i % 240 === 0) inp.pressed.add('slash');
      if (i % 600 === 0) inp.pressed.add('nova');
      if (i % 900 === 0) inp.pressed.add('summon');
    }
    maxEnemies = Math.max(maxEnemies, g.enemies.length);
    if (g.bossActive) bossSeen = true;
    g.update(1 / 60);
    if (g.state !== 'playing') break;
  }

  return {
    finalState: g.state,
    bossSeen,
    maxEnemiesAtOnce: maxEnemies,
    killed: g.killed,
    gateTotal: g.gate.enemies,
    playerLevel: g.save.level,
    playerPoints: g.save.points,
    playerHp: Math.round(g.player.hp),
    shadows: g.shadows.length,
    corpses: g.corpses.length,
    projectiles: g.projectiles.length,
    xpEarned: g.xpEarned,
    runTime: Math.round(g.runTime),
    resultTitle: document.getElementById('resultTitle')?.textContent,
    events: events.slice(0, 25),
  };
}, gateIndex, simSeconds, forceLevel);

console.log(JSON.stringify(result, null, 2));
console.log('\nERRORS:', errors.length ? errors.join('\n---\n') : '(none)');
console.log('report:', writeReport('playtest', { gateIndex, simSeconds, forceLevel, result, errors }));
await browser.close();
await server.stop();
process.exit(errors.length ? 1 : 0);
