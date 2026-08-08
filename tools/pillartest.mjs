// Obstacle sliding: pushing straight into a pillar must slide around it, not
// stick. Deterministic — one pillar at the origin, two approach angles.
//
//   node tools/pillartest.mjs

import { launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame, writeReport, forceOpenGates } from './_harness.mjs';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);

await gotoGame(page, { waitMs: 2000 });
// Arena-behaviour tool: pin the flat arena for E/D via the sanctioned
// forceOpen dev override (see _harness.forceOpenGates).
await forceOpenGates(page);

const r = await evalGame(page, (g) => {
  g.renderer.render = () => {};
  g.fx.damageNumber = () => {};
  g.startGate(0);
  g.enemies.forEach((e) => { g.scene.remove(e.mesh); g.scene.remove(e.bar); });
  g.enemies.length = 0;

  const out = {};
  const V = g.player.pos.constructor;
  for (const [label, offsetX] of [['head-on', 0], ['slightly-off', 0.25]]) {
    g.world.obstacles.length = 0;
    g.world.obstacles.push({ pos: new V(0, 0, 0), radius: 2 });
    g.player.pos.set(offsetX, 0, 4);
    g.player.vel.set(0, 0, 0);
    g.input.move.x = 0;
    g.input.move.y = 1;      // push toward -z, i.e. straight at the pillar
    const start = g.player.pos.clone();
    const trail = [];
    for (let i = 0; i < 60 * 6; i++) {
      g.update(1 / 60);
      if (i % 60 === 0) trail.push([+g.player.pos.x.toFixed(2), +g.player.pos.z.toFixed(2)]);
    }
    out[label] = {
      moved: +g.player.pos.distanceTo(start).toFixed(2),
      distToCentre: +Math.hypot(g.player.pos.x, g.player.pos.z).toFixed(2),
      trail,
    };
  }
  return out;
});

console.log(JSON.stringify(r, null, 2));
console.log('ERRORS:', errors.length ? errors.join('\n') : '(none)');
console.log('report:', writeReport('pillartest', { result: r, errors }));
await browser.close();
await server.stop();
process.exit(errors.length ? 1 : 0);
