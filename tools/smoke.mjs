// The gating test for every build step: boot the game, walk the real UI into a
// gate, play it, fight it to a result screen, and prove nothing leaked.
//
//   node tools/smoke.mjs [--city] [--gate <rank>] [--shots] [--no-leak-check]
//
//   --city   require the city hub transition (fails if city mode is absent).
//            Without it the city is probed and reported but not required, so
//            this test runs today and keeps running once the city lands.
//   --gate   which rank to enter, default E.
//   --shots  also capture a one-per-second filmstrip of the live-play phase.
//   --no-leak-check  demote the geometry/texture growth probe to a warning.
//            It is FATAL by default: build-order step 3 landed, clearEntities
//            disposes, and a regression here is an Android crash, not a slowdown.

import {
  OUT, launchBrowser, newPhonePage, ensureServer, gotoGame,
  evalGame, writeReport, shotPath, forceOpenGates,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const REQUIRE_CITY = flag('city');
const RANK = opt('gate', 'E');
const FILMSTRIP = flag('shots');
const LEAK_NONFATAL = flag('no-leak-check');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return Boolean(ok);
};

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors, logs } = await newPhonePage(browser);
let fatal = null;

try {
  // ---------------------------------------------------------------- boot
  await gotoGame(page);
  // Arena-behaviour tool: pin the flat arena for E/D via the sanctioned
  // forceOpen dev override (see _harness.forceOpenGates).
  await forceOpenGates(page);
  await page.screenshot({ path: shotPath('01-title.png') });

  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  check('canvas has non-zero size', canvas && canvas.w > 0 && canvas.h > 0,
    canvas ? `${canvas.w}x${canvas.h}` : 'no canvas');

  // ------------------------------------------------------------- city hub
  // PLAY now lands in the city, not the gate list. Probe AFTER the click —
  // CityUI (#cityPrompt) only mounts when CityMode does, so probing from the
  // title always read false.
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 25000 })
    .catch(() => {});
  await page.waitForTimeout(600);
  const city = await evalGame(page, (g) => ({
    mode: g.mode?.name || null,
    hasMode: typeof g.enterCity === 'function' || g.mode?.name === 'city' || Boolean(g.city),
    prompt: Boolean(document.getElementById('cityPrompt')),
    portals: g.mode?.city?.portals?.length || 0,
  }));
  await page.screenshot({ path: shotPath('02-city.png') });
  if (REQUIRE_CITY) check('title -> city transition available', city.hasMode && city.prompt, JSON.stringify(city));
  else check('PLAY lands in the city hub', city.mode === 'city' && city.prompt, JSON.stringify(city));

  // ------------------------------------------------------------ gate entry
  // Fast travel through AppState — the WALKED portal route is flow-test's job.
  await page.evaluate(() => window.__app?.go('gates'));
  await page.waitForSelector('#gateList .gate', { timeout: 10000 });
  await page.screenshot({ path: shotPath('02b-gates.png') });
  const gateCount = await page.locator('#gateList .gate:not(.locked)').count();
  check('at least one unlocked gate is listed', gateCount > 0, `${gateCount} unlocked`);

  const target = page.locator(`#gateList .gate:not(.locked):has(.rank-${RANK})`).first();
  if (await target.count()) await target.click();
  else await page.locator('#gateList .gate:not(.locked)').first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: shotPath('03-gate.png') });

  const entered = await evalGame(page, (g) => ({
    state: g.state,
    rank: g.gate?.rank,
    enemies: g.enemies.length,
    total: g.gate?.enemies,
  }));
  check('gate entered and playing', entered.state === 'playing' && entered.enemies > 0, JSON.stringify(entered));

  // ----------------------------------------------------- live play, ~6 s
  // Real input against the real render loop: this is what catches a shader or
  // rAF regression that a stubbed simulation never touches.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down('w');
    await page.keyboard.down('d');
    await page.waitForTimeout(400);
    await page.keyboard.up('w');
    await page.keyboard.up('d');
    await page.keyboard.press('j');
    await page.waitForTimeout(180);
    await page.keyboard.press('j');
    await page.waitForTimeout(180);
    await page.keyboard.press('Shift');
    await page.waitForTimeout(240);
    if (FILMSTRIP) await page.screenshot({ path: shotPath(`play-${String(i).padStart(2, '0')}.png`) });
  }
  await page.screenshot({ path: shotPath('04-combat.png') });

  const live = await evalGame(page, (g) => ({
    state: g.state,
    hp: Math.round(g.player?.hp ?? 0),
    runTime: +(g.runTime ?? 0).toFixed(1),
    calls: g.renderer.info.render.calls,
    tier: g.quality?.current?.name ?? null,
    hudVisible: !document.getElementById('hud').classList.contains('hidden'),
    objective: document.getElementById('objCount').textContent,
  }));
  check('HUD is live and the clock advanced', live.hudVisible && live.runTime > 1, JSON.stringify(live));

  // ------------------------------------------- fast-forward to a result
  // Wall-clock combat proves very little; a scripted hunter simulated flat out
  // actually reaches the boss and the results screen in a couple of seconds.
  //
  // The hunter is deliberately over-levelled first. A level-1 breaker against a
  // full E gate is a coin flip — it stalls out of reach of a kiting enemy about
  // one run in three — and a smoke test that flakes is worse than no test. This
  // asserts the machine works end to end, not that the balance is fair; that is
  // what tools/playtest.mjs is for.
  const run = await evalGame(page, (g, [simSeconds]) => {
    g.renderer.render = () => {};        // rendering is what makes this slow
    g.fx.damageNumber = () => {};        // and DOM churn is what makes it slower
    g.save.level = 40;
    g.save.stats.str = 60; g.save.stats.vit = 60; g.save.stats.agi = 20; g.save.stats.int = 20;
    g.refreshDerived(true);
    g.startGate(0);

    const inp = g.input;
    let bossSeen = false;
    let steps = 0;
    for (let i = 0; i < simSeconds * 60; i++) {
      steps = i;
      const e = g._nearestEnemy(g.player.pos, Infinity);
      if (e) {
        const dx = e.pos.x - g.player.pos.x;
        const dz = e.pos.z - g.player.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        // Keep closing even inside melee range: stopping at the reach boundary
        // is what let ranged enemies kite the old bot into a permanent stall.
        inp.move.x = dx / d; inp.move.y = -dz / d;
        if (d < 3.2) inp.pressed.add('attack');
        if (d > 6 && i % 90 === 0) inp.pressed.add('dash');
        if (i % 240 === 0) inp.pressed.add('slash');
        if (i % 600 === 0) inp.pressed.add('nova');
        if (i % 900 === 0) inp.pressed.add('summon');
      }
      if (g.bossActive) bossSeen = true;
      g.update(1 / 60);
      if (g.state !== 'playing') break;
    }
    return {
      state: g.state,
      bossSeen,
      killed: g.killed,
      total: g.gate.enemies,
      xp: g.xpEarned,
      simSeconds: +(steps / 60).toFixed(1),
      resultTitle: document.getElementById('resultTitle')?.textContent,
      resultsVisible: !document.getElementById('results').classList.contains('hidden'),
    };
  }, 900);
  await page.screenshot({ path: shotPath('05-results.png') });

  check('run reached a result screen', run.state === 'over' && run.resultsVisible, JSON.stringify(run));
  check('gate cleared, boss included', run.bossSeen && run.killed >= run.total && run.xp > 0,
    `killed ${run.killed}/${run.total}, ${run.xp} XP, ${run.simSeconds}s simulated`);

  // -------------------------------------------- progression / shadow army
  // The save schema changed shape under game.js (shadows: int -> roster
  // object). These assertions exist because every one of them was a live
  // crash or a silent wipe before the modules were wired together.
  const prog = await evalGame(page, (g) => {
    g.renderer.render = () => {};
    g.save.level = 30;
    g.save.autoStats = 29;
    g.save.shadows = { roster: [], deployed: [], nextId: 1 };
    g.startGate(0);

    // Kill the opening wave outright so there are corpses to extract from.
    [...g.enemies].forEach((e) => g._killEnemy(e));
    const corpsesBefore = g.corpses.length;

    // Pin the extraction roll so this measures the wiring, not the dice.
    const realRandom = Math.random;
    Math.random = () => 0;
    g.player.cds.summon = 0;
    if (g.corpses[0]) g.player.pos.copy(g.corpses[0].pos);
    g._trySummon();
    Math.random = realRandom;

    const raisedField = g.shadows.length;
    const raisedRoster = g.save.shadows.roster.length;

    // A level-up must move autoStats, or the +1-to-every-stat grant is dead.
    const autoBefore = g.save.autoStats;
    g.gainXp(999999);
    const autoAfter = g.save.autoStats;

    // Clearing the gate must not overwrite the roster with a number.
    g._clearGate();
    const rosterAfterClear = g.save.shadows.roster?.length ?? -1;

    // Death releases the weakest quarter and never the best.
    g.save.shadows.roster = [];
    for (let i = 0; i < 8; i++) {
      g.save.shadows.roster.push({ id: i + 1, name: `t${i}`, grade: i === 7 ? 5 : 0, type: 'grunt', level: 10, kills: 0, bornAt: 0 });
    }
    g.state = 'playing';
    g._fail();
    const afterFail = g.save.shadows.roster.length;
    const keptBest = g.save.shadows.roster.some((r) => r.grade === 5);

    return {
      corpsesBefore, raisedField, raisedRoster, rosterAfterClear,
      autoGained: autoAfter - autoBefore, afterFail, keptBest,
      deployedIsArray: Array.isArray(g.save.shadows.deployed),
    };
  });
  check('corpses are raiseable and extraction fills the roster',
    prog.corpsesBefore > 0 && prog.raisedField > 0 && prog.raisedRoster === prog.raisedField,
    JSON.stringify(prog));
  check('levelling grants autoStats', prog.autoGained > 0, `+${prog.autoGained}`);
  check('clearing a gate preserves the roster', prog.rosterAfterClear === prog.raisedRoster,
    `${prog.rosterAfterClear} vs ${prog.raisedRoster}`);
  check('death releases the weakest quarter and keeps the best',
    prog.afterFail === 6 && prog.keptBest, `${prog.afterFail}/8 left, best kept: ${prog.keptBest}`);

  // ------------------------------------------------------ leak regression
  // Three entries into the same gate. clearEntities only scene.remove()s, so
  // geometries orphan; step 3 makes this stop growing and --leak makes it bite.
  const leak = await evalGame(page, (g) => {
    // Pin the tier: an adaptive upgrade mid-probe turns shadow maps on and adds
    // two textures, which is a settings change, not a leak, but is
    // indistinguishable from one in the raw counter.
    g.quality.lock('medium');
    const cycle = () => {
      g.quit();
      g.startGate(0);
      for (let k = 0; k < 120; k++) g.update(1 / 60);
    };
    // One discarded cycle so lazily-allocated, allocate-once resources (the env
    // render target, the key light's depth map) are already paid for.
    cycle();
    const samples = [];
    for (let i = 0; i < 3; i++) {
      cycle();
      samples.push({
        geometries: g.renderer.info.memory.geometries,
        textures: g.renderer.info.memory.textures,
        programs: g.renderer.info.programs?.length ?? null,
      });
    }
    g.quality.lock(null);
    return samples;
  });
  const grew = leak[2].geometries > leak[0].geometries || leak[2].textures > leak[0].textures;
  const leakDetail = leak.map((s) => `${s.geometries}g/${s.textures}t`).join(' -> ');
  if (LEAK_NONFATAL) {
    console.log(`${grew ? 'WARN' : 'PASS'}  geometry/texture growth across 3 gate entries — ${leakDetail}`);
  } else {
    check('geometries/textures do not grow across 3 gate entries', !grew, leakDetail);
  }

  check('zero page errors', errors.length === 0, errors.join('\n---\n') || 'none');
} catch (e) {
  fatal = e;
  check('smoke completed without throwing', false, e.message);
  // A screenshot of the moment it died is worth more than the stack alone.
  try { await page.screenshot({ path: shotPath('99-crash.png') }); } catch { /* page may be gone */ }
} finally {
  await browser.close();
  await server.stop();
}

const failed = checks.filter((c) => !c.ok);
const report = writeReport('smoke-result', { checks, errors, logs: logs.slice(0, 200) });

console.log(`\nshots + report: ${OUT}`);
console.log(`report: ${report}`);
if (fatal) console.error(fatal.stack || fatal.message);
console.log(failed.length ? `\nSMOKE FAILED — ${failed.length}/${checks.length} checks` : `\nSMOKE PASSED — ${checks.length} checks`);
process.exit(failed.length ? 1 : 0);
