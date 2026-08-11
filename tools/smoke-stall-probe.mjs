// Why did tools/smoke.mjs stall at 26/36 kills after 900 simulated seconds?
// Same arena autoplay loop as smoke, but it records a progress trace and, if it
// stalls, a full snapshot of what everything on the field was doing. Runs N
// seeds so the flake rate is a measured number rather than an impression.
//
//   GB_PORT=5173 GB_RUNS=5 node tools/smoke-stall-probe.mjs
import { ensureServer, launchBrowser, newPhonePage, gotoGame, evalGame, forceOpenGates } from './_harness.mjs';

const RUNS = Number(process.env.GB_RUNS || 5);

const srv = await ensureServer();
const browser = await launchBrowser();
const { page } = await newPhonePage(browser);
await gotoGame(page);
await forceOpenGates(page);

const results = [];
for (let run = 0; run < RUNS; run++) {
  const r = await evalGame(page, (g, [simSeconds]) => {
    g.renderer.render = () => {};
    g.fx.damageNumber = () => {};
    g.save.level = 40;
    g.save.stats.str = 60; g.save.stats.vit = 60; g.save.stats.agi = 20; g.save.stats.int = 20;
    g.refreshDerived(true);
    g.startGate(0);

    const inp = g.input;
    let bossSeen = false;
    let steps = 0;
    const trace = [];
    let lastKilled = -1;
    let stalledSince = 0;
    let firstStallAt = -1;
    for (let i = 0; i < simSeconds * 60; i++) {
      steps = i;
      const e = g._nearestEnemy(g.player.pos, Infinity);
      if (e) {
        const dx = e.pos.x - g.player.pos.x;
        const dz = e.pos.z - g.player.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        inp.move.x = dx / d; inp.move.y = -dz / d;
        if (d < 3.2) inp.pressed.add('attack');
        if (d > 6 && i % 90 === 0) inp.pressed.add('dash');
        if (i % 240 === 0) inp.pressed.add('slash');
        if (i % 600 === 0) inp.pressed.add('nova');
        if (i % 900 === 0) inp.pressed.add('summon');
      }
      if (g.bossActive) bossSeen = true;
      g.update(1 / 60);
      if (i % 600 === 0) {
        trace.push({ s: Math.round(i / 60), killed: g.killed, spawned: g.spawned, live: g.enemies.length });
      }
      if (g.killed === lastKilled) {
        stalledSince++;
        if (stalledSince === 1800 && firstStallAt < 0) firstStallAt = Math.round(i / 60);
      } else { lastKilled = g.killed; stalledSince = 0; }
      if (g.state !== 'playing') break;
    }
    const snap = {
      state: g.state,
      bossSeen,
      killed: g.killed,
      spawned: g.spawned,
      total: g.gate.enemies,
      waveSize: g.gate.waveSize,
      live: g.enemies.length,
      simSeconds: +(steps / 60).toFixed(1),
      firstStallAt,
      trace,
      player: { x: +g.player.pos.x.toFixed(1), z: +g.player.pos.z.toFixed(1), hp: Math.round(g.player.hp) },
      worldRadius: g.world.radius,
      spawnTimer: +(g.spawnTimer ?? -1).toFixed(2),
      // What are the survivors doing? Distance from the player, whether they are
      // moving at all, and whether they are inside the arena disc.
      enemies: g.enemies.map((e) => ({
        key: e.key,
        d: +Math.hypot(e.pos.x - g.player.pos.x, e.pos.z - g.player.pos.z).toFixed(1),
        speed: +Math.hypot(e.vel.x, e.vel.z).toFixed(2),
        hp: Math.round(e.hp),
        spawning: +(e.spawning || 0).toFixed(2),
        r: +Math.hypot(e.pos.x, e.pos.z).toFixed(1),
      })),
    };
    return snap;
  }, 900);
  results.push(r);
  console.log(`run ${run}: state=${r.state} killed=${r.killed}/${r.total} spawned=${r.spawned} `
    + `live=${r.live} boss=${r.bossSeen} sim=${r.simSeconds}s firstStallAt=${r.firstStallAt}s`);
  if (r.state !== 'over') {
    console.log(`  trace: ${r.trace.map((t) => `${t.s}s:${t.killed}/${t.spawned}(${t.live})`).join(' ')}`);
    console.log(`  player ${JSON.stringify(r.player)} spawnTimer=${r.spawnTimer} worldRadius=${r.worldRadius}`);
    console.log(`  survivors: ${JSON.stringify(r.enemies)}`);
  }
}
const fails = results.filter((r) => r.state !== 'over');
console.log(`\n${fails.length}/${RUNS} runs failed to reach a result screen`);

await browser.close();
await srv.stop();
