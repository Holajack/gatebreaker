// tools/flow-test.mjs — the loop the owner actually asked for.
//
//   node tools/flow-test.mjs [--headed] [--no-shots] [--swiftshader]
//
// His words: "Whenever I start to play, it doesn't enter me into a city where I
// can go into the dungeon. It just starts me in the dungeon." So this tool
// asserts the whole journey, in order, through the real UI:
//
//   1. Press PLAY on the title. Assert the mounted mode is CITY, that a City
//      exists with six portals, and that no gate/world/enemies were built.
//   2. Drop a real CharacterBody at 200 random points across the city and step
//      it. Assert not one of them falls through the ground.
//   3. Walk — by feeding the same input.move vector the thumbstick writes —
//      toward the E portal. Assert the proximity prompt appears and names the
//      right rank.
//   4. Confirm it. Assert DungeonMode mounts on the E gate.
//   5. Clear the gate by killing everything the real spawner produces, through
//      the boss, so the real _clearGate path runs.
//   6. Press CONTINUE. Assert we are back in the CITY, standing beside the E
//      portal we walked into.
//   7. Assert a locked portal reads as locked and refuses entry.
//
// LANDSCAPE viewport throughout: index.html's rotate gate covers the screen in
// portrait and swallows every pointer event.

import fs from 'node:fs';
import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
  forceOpenGates,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');
// Same reasoning as city-test.mjs: a 226k-triangle city through SwiftShader is
// ~0.8 s a frame, and a scripted walk would take an hour. Everything asserted
// here is logic, not pixels.
const SWIFTSHADER = argv.includes('--swiftshader');

const SPAWN_SAMPLES = 200;

const fail = [];
const warn = [];
const notes = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); return Boolean(cond); };
let _t0 = Date.now();
const phase = (name) => {
  const now = Date.now();
  console.log(`  [${((now - _t0) / 1000).toFixed(1)}s] ${name}`);
  _t0 = now;
};

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: SWIFTSHADER });
// LANDSCAPE. Non-negotiable — see the header.
const { page, errors } = await newPhonePage(browser, { width: 900, height: 460, dpr: 1 });

const report = {};

try {
  await gotoGame(page, { waitMs: 2000 });
  // Arena-behaviour tool: pin the flat arena for E/D via the sanctioned
  // forceOpen dev override (see _harness.forceOpenGates).
  await forceOpenGates(page);
  phase('booted to title');

  // ------------------------------------------------------------ 1. the city
  ok(await page.isVisible('#title'), 'title screen is not visible after boot');
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(900);

  const arrived = await page.evaluate(() => {
    const g = window.__game;
    const c = g.mode?.city;
    return {
      mode: g.mode?.name ?? null,
      screen: window.__app?.current ?? null,
      state: g.state,
      hasCity: Boolean(c?.built),
      portals: c ? c.portals.map((p) => ({ rank: p.rank, locked: p.locked, wild: Boolean(p.wild), x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2) })) : [],
      gateBuilt: Boolean(g.gate),
      enemies: g.enemies.length,
      worldObjects: g.world.group.children.length,
      player: { x: +g.player.pos.x.toFixed(2), y: +g.player.pos.y.toFixed(2), z: +g.player.pos.z.toFixed(2) },
      hudVisible: !document.getElementById('hud').classList.contains('hidden'),
      stickZone: Boolean(document.getElementById('stickZone')?.offsetWidth),
      cityStats: c ? { triangles: c.stats.triangles, draws: c.stats.drawGroups, buildings: c.stats.buildings } : null,
      targetFps: window.__clock?.targetFps ?? null,
    };
  });
  report.arrival = arrived;

  ok(arrived.mode === 'city', `PLAY did not put the player in the city (mode=${arrived.mode})`);
  ok(arrived.hasCity, 'no City was built on entering the hub');
  // WORLD_SPEC step 7 appends the Verge's wild gates to city.portals; the
  // town's own six are the non-wild ones.
  ok(arrived.portals.filter((p) => !p.wild && p.rank).length === 6,
    `expected 6 town portals, saw ${arrived.portals.filter((p) => !p.wild).length}`);
  ok(!arrived.gateBuilt, 'a gate was built on entering the city — this is the bug the owner reported');
  ok(arrived.enemies === 0, `${arrived.enemies} enemies exist in the hub`);
  ok(arrived.worldObjects === 0, `dungeon World still holds ${arrived.worldObjects} objects in the city`);
  ok(arrived.hudVisible, 'HUD hidden in the city — #stickZone lives inside it, so movement would be dead');
  ok(arrived.stickZone, 'the thumbstick zone has no size in the city');
  phase(`in the city: ${arrived.cityStats?.buildings} buildings, ${arrived.cityStats?.triangles} tris, ${arrived.cityStats?.draws} draw groups`);

  // -------------------------------------------------- 2. no holes in the map
  const holes = await page.evaluate(async (samples) => {
    const { CharacterBody } = await import('/src/game/physics.js');
    const g = window.__game;
    const city = g.mode.city;
    const height = (x, z) => city.heightAt(x, z);
    const resolve = (pos, r, v) => city.resolve(pos, r, v);
    const normal = (x, z, out) => city.groundNormal(x, z, out);

    // Deterministic sample set so a failure is reproducible.
    let s = 987654321;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296); };

    const bad = [];
    const belowVoid = [];
    let lowestOnLedge = Infinity;
    const LIMIT = 130;    // inside City's own WALK_LIMIT of 134
    for (let i = 0; i < samples; i++) {
      const x = (rnd() * 2 - 1) * LIMIT;
      const z = (rnd() * 2 - 1) * LIMIT;
      const h = height(x, z);
      if (!Number.isFinite(h)) { bad.push({ x, z, why: 'heightAt returned NaN' }); continue; }
      const body = new CharacterBody({ radius: 0.6, maxSpeed: 6 });
      body.setEnvironment(height, resolve, normal);
      body.reset(x, h + 3, z);
      for (let k = 0; k < 90; k++) body.step(1 / 60);   // 1.5 s of falling + settling
      const under = height(body.pos.x, body.pos.z);
      const rec = {
        x: +x.toFixed(1), z: +z.toFixed(1),
        y: +body.pos.y.toFixed(2), ground: +under.toFixed(2), grounded: body.grounded,
      };
      // "Fell through" means the body ended up BELOW the surface it is standing
      // on, or nowhere at all. Ending up legitimately low — the west cliff drops
      // to -34 by design — is a different finding and is counted separately.
      if (!Number.isFinite(body.pos.y) || body.pos.y < under - 0.6 || !body.grounded) {
        bad.push({ ...rec, why: 'below its own ground' });
      } else if (body.pos.y < -10) {
        belowVoid.push(rec);
      } else if (x > -88) {
        lowestOnLedge = Math.min(lowestOnLedge, body.pos.y);
      }
    }
    return { samples, bad, belowVoid, lowestOnLedge };
  }, SPAWN_SAMPLES);
  report.groundIntegrity = holes;
  ok(holes.bad.length === 0,
    `${holes.bad.length}/${holes.samples} spawn points fell through the city ground: ${JSON.stringify(holes.bad.slice(0, 4))}`);
  // The void threshold CityMode rescues from has to sit below every walkable
  // metre of the town, or a player standing in a dip gets teleported.
  ok(holes.lowestOnLedge > -10,
    `walkable ground reaches ${holes.lowestOnLedge.toFixed(2)} m, below CityMode's VOID_Y of -10`);
  if (holes.belowVoid.length) {
    warn.push(`${holes.belowVoid.length}/${holes.samples} sample points sit below the west cliff lip (ground ~ -34). That is city.js's intended "the world ends" treatment, not a hole — but the parapet only covers the walled stretch of it.`);
  }
  phase(`ground integrity: ${holes.samples - holes.bad.length}/${holes.samples} settled on solid ground (${holes.belowVoid.length} of them on the cliff floor)`);

  // ------------------------------------------------------------- screenshots
  if (SHOTS) {
    await page.screenshot({ path: shotPath('flow-01-city-arrival.png') });
    // Eye level. The gameplay camera sits 13 m up; the honest question is what
    // the place looks like from where a person would be standing in it.
    await page.evaluate(() => {
      const g = window.__game;
      g.mode._eyeSaved = g.mode.updateCamera;
      g.mode.updateCamera = () => {};
      const p = g.player.pos;
      g.camera.position.set(p.x + 0.9, p.y + 1.68, p.z + 4.2);
      g.camera.lookAt(p.x, p.y + 1.5, p.z - 26);
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: shotPath('flow-02-city-eye-level.png') });
    // Same eye height, turned to face the portal plaza.
    await page.evaluate(() => {
      const g = window.__game;
      const p = g.player.pos;
      g.camera.position.set(p.x, p.y + 1.68, p.z + 2.0);
      g.camera.lookAt(0, 3.2, -22);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath('flow-03-city-eye-plaza.png') });
    await page.evaluate(() => {
      const g = window.__game;
      if (g.mode._eyeSaved) { g.mode.updateCamera = g.mode._eyeSaved; g.mode._eyeSaved = null; }
    });
    await page.waitForTimeout(300);
    phase('screenshots written');
  }

  // ---------------------------------------- 2b. and the cliff cannot trap you
  const rescued = await page.evaluate(async () => {
    const g = window.__game;
    const c = g.mode.city;
    // Straight off the west overlook, north of where the parapet runs.
    g.player.body.reset(-120, c.heightAt(-120, -110), -110);
    const dropped = g.player.pos.y;
    for (let i = 0; i < 90; i++) g.mode.update(1 / 60);
    return { dropped: +dropped.toFixed(2), y: +g.player.pos.y.toFixed(2), x: +g.player.pos.x.toFixed(2), z: +g.player.pos.z.toFixed(2) };
  });
  report.cliffRecovery = rescued;
  ok(rescued.y > -10, `a player who walks off the west cliff is stranded at y=${rescued.y} with no way back`);
  phase(`cliff recovery: dropped at y=${rescued.dropped}, recovered to (${rescued.x}, ${rescued.y}, ${rescued.z})`);
  await page.evaluate(() => {
    const g = window.__game;
    const sp = g.mode.city.spawnPoint();
    g.player.body.reset(sp.x, sp.y, sp.z);
  });

  // ------------------------------------------------------ 3. walk to a portal
  const target = arrived.portals.find((p) => p.rank === 'E');
  ok(Boolean(target), 'no E portal in the city');
  const walk = await walkTo(page, target.x, target.z, { stopWhenPrompted: true });
  report.walk = walk;
  ok(walk.moved > 4, `the player barely moved (${walk.moved.toFixed(1)} m) — the city stick path is broken`);
  ok(Boolean(walk.prompt), 'no prompt appeared after walking up to the E portal');
  ok(walk.prompt?.rank === 'E', `prompt named rank ${walk.prompt?.rank}, expected E`);
  ok(walk.prompt?.locked === false, 'the E portal reads as locked at level 1');
  ok(walk.confirmVisible, 'the confirm button is not on screen while the prompt is up');
  phase(`walked ${walk.moved.toFixed(1)} m; prompt: ${walk.prompt?.label} / ${walk.prompt?.sub}`);
  if (SHOTS) await page.screenshot({ path: shotPath('flow-04-portal-prompt.png') });

  // ------------------------------------------------------------ 4. enter it
  await page.click('#cityConfirm');
  await page.waitForFunction(() => window.__game?.mode?.name === 'dungeon', null, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  const inGate = await page.evaluate(() => {
    const g = window.__game;
    return {
      mode: g.mode?.name ?? null,
      screen: window.__app?.current ?? null,
      rank: g.gate?.rank ?? null,
      name: g.gate?.name ?? null,
      state: g.state,
      enemies: g.enemies.length,
      cityDisposed: !g.scene.getObjectByName('city')?.children.length,
      targetFps: window.__clock?.targetFps ?? null,
      envIsArena: g.player.body.groundHeight(12, 34) === 0,
    };
  });
  report.gate = inGate;
  ok(inGate.mode === 'dungeon', `confirming the portal did not enter a gate (mode=${inGate.mode})`);
  ok(inGate.rank === 'E', `entered rank ${inGate.rank}, expected E`);
  ok(inGate.enemies > 0, 'the gate spawned no enemies');
  ok(inGate.cityDisposed, 'the city was left in the scene during the run');
  ok(inGate.envIsArena, 'the player body is still bound to the city heightfield inside the gate');
  ok(inGate.targetFps === 60, `frame target is ${inGate.targetFps} in a gate, expected 60`);
  phase(`in gate ${inGate.rank} — ${inGate.name}, ${inGate.enemies} enemies`);
  if (SHOTS) await page.screenshot({ path: shotPath('flow-05-gate.png') });

  // ------------------------------------------------------------ 5. clear it
  const cleared = await clearGate(page);
  report.clear = cleared;
  ok(cleared.over, `the gate never resolved (state=${cleared.state}, killed=${cleared.killed})`);
  ok(cleared.results, 'no results panel after clearing the gate');
  phase(`cleared in ${cleared.seconds.toFixed(1)}s of wall clock, ${cleared.killed} kills`);

  // -------------------------------------------------- 6. back into the city
  await page.click('#btnResultsOk');
  await page.waitForTimeout(500);
  // A level-up may interpose the allocation panel; that is the real flow too.
  if (await page.isVisible('#levelup')) {
    notes.push('the allocation panel appeared between the results and the city (expected after a level-up)');
    await page.click('#btnStatsDone');
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(900);

  const back = await page.evaluate(() => {
    const g = window.__game;
    const c = g.mode?.city;
    const e = c?.portals.find((p) => p.rank === 'E');
    const p = g.player.pos;
    return {
      mode: g.mode?.name ?? null,
      screen: window.__app?.current ?? null,
      state: g.state,
      distToE: e ? +Math.hypot(p.x - e.pos.x, p.z - e.pos.z).toFixed(2) : null,
      player: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
      ground: c ? +c.heightAt(p.x, p.z).toFixed(2) : null,
      resultsVisible: !document.getElementById('results').classList.contains('hidden'),
      gatesVisible: !document.getElementById('gates').classList.contains('hidden'),
      targetFps: window.__clock?.targetFps ?? null,
    };
  });
  report.returned = back;
  ok(back.mode === 'city', `CONTINUE did not return to the city (mode=${back.mode})`);
  ok(back.distToE != null && back.distToE < 12,
    `returned ${back.distToE} m from the E portal — expected to arrive beside the one used`);
  ok(!back.resultsVisible, 'the results panel is still up in the city');
  ok(!back.gatesVisible, 'the gate-list menu is up in the city — that is the old flow');
  ok(Math.abs(back.player.y - back.ground) < 0.6,
    `the player returned ${(back.player.y - back.ground).toFixed(2)} m off the ground`);
  ok(back.targetFps === 30, `frame target is ${back.targetFps} in the city, expected 30`);
  phase(`returned to the city, ${back.distToE} m from the E portal`);
  if (SHOTS) await page.screenshot({ path: shotPath('flow-06-return.png') });

  // ------------------------------------------------------ 7. a locked portal
  const locked = await page.evaluate(() => {
    const g = window.__game;
    const c = g.mode.city;
    // S needs level 42; a level-1 save must not be able to walk into it.
    const s = c.portals.find((p) => p.rank === 'S');
    const before = { locked: s.locked, emissive: s.meshes.ring.material.emissiveIntensity };
    const unlockedRing = c.portals.find((p) => p.rank === 'E').meshes.ring.material.emissiveIntensity;
    // Stand on it and ask the mode what it would do.
    g.player.body.reset(s.pos.x, c.heightAt(s.pos.x, s.pos.z), s.pos.z + 2);
    g.mode._updatePrompt();
    const prompt = g.mode.prompt;
    const acted = g.mode.confirmPrompt();
    return {
      before, unlockedRing, prompt,
      acted, modeAfter: g.mode?.name ?? null,
    };
  });
  report.locked = locked;
  ok(locked.before.locked === true, 'the S portal is not locked for a level-1 save');
  ok(locked.before.emissive < locked.unlockedRing,
    `a locked portal glows as brightly as an open one (${locked.before.emissive} vs ${locked.unlockedRing}) — it does not read as locked in the world`);
  ok(Boolean(locked.prompt), 'no prompt at all on a locked portal — it fails silently, which is the thing to avoid');
  ok(locked.prompt?.locked === true, 'the locked portal prompt does not say it is locked');
  ok(/LEVEL\s*\d+/.test(locked.prompt?.sub || ''), `the locked prompt does not say why: "${locked.prompt?.sub}"`);
  ok(locked.acted === null && locked.modeAfter === 'city', 'confirming a locked portal entered the gate anyway');
  phase(`locked portal reads: "${locked.prompt?.label}" / "${locked.prompt?.sub}"`);

  // ------------------------------------- 8. fast travel is a convenience only
  // The gate list must still be REACHABLE (from the Assay Hall) and must still
  // work, but it must not be where the game drops you.
  const assay = await page.evaluate(() => {
    const g = window.__game;
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'assay');
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    const prompt = g.mode.prompt;
    const acted = g.mode.confirmPrompt();
    return { prompt, acted, screen: window.__app?.current ?? null };
  });
  await page.waitForTimeout(400);
  report.fastTravel = assay;
  ok(assay.prompt?.kind === 'interact', 'standing at the Assay Hall door produced no prompt');
  ok(assay.acted?.id === 'assay', 'the Assay Hall does not open the gate list');
  ok(await page.isVisible('#gates'), 'the gate list did not open from the Assay Hall');

  await page.click('#btnGatesBack');
  await page.waitForTimeout(600);
  const afterBack = await page.evaluate(() => ({
    mode: window.__game?.mode?.name ?? null,
    screen: window.__app?.current ?? null,
    gatesVisible: !document.getElementById('gates').classList.contains('hidden'),
    titleVisible: !document.getElementById('title').classList.contains('hidden'),
  }));
  report.gatesBack = afterBack;
  ok(!afterBack.gatesVisible, 'BACK left the gate list on screen');
  ok(!afterBack.titleVisible, 'BACK out of the fast-travel list dumped the player at the title, not the city');
  ok(afterBack.mode === 'city', `BACK out of the fast-travel list left mode=${afterBack.mode}`);
  phase('fast travel: Assay Hall opens the gate list, BACK returns to the city');

  // ------------------------------------------- 9. hardware back inside a gate
  await page.evaluate(() => window.__game.enterGate('E'));
  await page.waitForTimeout(1400);
  await page.keyboard.press('Escape');          // stands in for Android back
  await page.waitForTimeout(400);
  const paused = await page.evaluate(() => ({
    pauseVisible: !document.getElementById('pause').classList.contains('hidden'),
    state: window.__game.state,
  }));
  ok(paused.pauseVisible, 'hardware back inside a gate did not raise the pause menu');
  ok(paused.state === 'paused', `hardware back inside a gate left state=${paused.state}`);
  await page.keyboard.press('Escape');          // ...and again resumes
  await page.waitForTimeout(400);
  const resumed = await page.evaluate(() => ({
    pauseVisible: !document.getElementById('pause').classList.contains('hidden'),
    state: window.__game.state,
  }));
  ok(!resumed.pauseVisible && resumed.state === 'playing',
    `a second back did not resume the run (state=${resumed.state})`);
  report.hardwareBack = { paused, resumed };
  phase('hardware back: gate -> pause -> resume');

  // Put the player back somewhere sane so the final shot is not on a cliff.
  await page.evaluate(() => {
    window.__app.go('city');
  });
  await page.waitForTimeout(900);
  ok(await page.evaluate(() => window.__game?.mode?.name === 'city'), 'could not get back to the city at the end of the run');
} catch (e) {
  fail.push(`THREW: ${e.message}\n${e.stack || ''}`);
} finally {
  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
  if (fatal.length) fail.push(`page errors:\n${fatal.join('\n')}`);
  report.pageErrors = fatal;
  report.notes = notes;
  report.warnings = warn;
  report.failures = fail;
  const file = writeReport('flow-test', report);
  await browser.close();
  await server.stop();

  console.log(`\nreport: ${file}`);
  if (SHOTS) console.log(`shots:  ${shotPath('')}`);
  for (const n of notes) console.log(`  note: ${n}`);
  for (const w of warn) console.log(`  WARN: ${w}`);
  if (fail.length) {
    console.error(`\nFLOW TEST FAILED (${fail.length})`);
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('\nFLOW TEST PASSED — title -> city -> portal -> gate -> results -> city');
}

// ---------------------------------------------------------------------------

/**
 * Drive the player with the exact vector the floating thumbstick writes, so
 * this walks through the real movement path rather than teleporting.
 */
async function walkTo(page, tx, tz, { timeoutMs = 40000, stopWhenPrompted = false } = {}) {
  const start = await page.evaluate(() => {
    const p = window.__game.player.pos;
    return { x: p.x, z: p.z };
  });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(([gx, gz]) => {
      const g = window.__game;
      const p = g.player.pos;
      const dx = gx - p.x, dz = gz - p.z;
      const d = Math.hypot(dx, dz);
      // input.move is what Input._bindStick writes; y is "forward" = -z.
      g.input.move.x = d > 0.001 ? dx / d : 0;
      g.input.move.y = d > 0.001 ? -dz / d : 0;
      const prompt = g.mode?.prompt || null;
      return {
        d, x: p.x, z: p.z, prompt,
        confirmVisible: Boolean(document.getElementById('cityConfirm')?.classList.contains('on')),
      };
    }, [tx, tz]);
    // RETARGET (C-TALK): stop on portal/door prompts only. The crowd's
    // hunters now offer a kind:'talk' prompt within a couple of metres, and
    // the walk path crossing one is legitimate, timing-dependent city life —
    // this walk's assertion is "the E PORTAL prompts", and talk is defined
    // to never mask a portal (priority portal > door > talk), so walking on
    // through a chat offer is exactly what a player would do.
    if (stopWhenPrompted && last.prompt && last.prompt.kind !== 'talk') break;
    if (last.d < 1.5) break;
    await page.waitForTimeout(110);
  }
  await page.evaluate(() => {
    window.__game.input.move.x = 0;
    window.__game.input.move.y = 0;
  });
  await page.waitForTimeout(250);
  const end = await page.evaluate(() => {
    const g = window.__game;
    const p = g.player.pos;
    return {
      x: p.x, z: p.z,
      prompt: g.mode?.prompt || null,
      confirmVisible: Boolean(document.getElementById('cityConfirm')?.classList.contains('on')),
    };
  });
  return {
    from: start, to: { x: +end.x.toFixed(2), z: +end.z.toFixed(2) },
    moved: Math.hypot(end.x - start.x, end.z - start.z),
    distanceToTarget: last?.d ?? null,
    prompt: end.prompt,
    confirmVisible: end.confirmVisible,
  };
}

/**
 * Clear the gate the honest way: kill whatever the real spawner has produced,
 * let it spawn the next wave, and let the real boss / _clearGate chain fire.
 * No shortcut into _clearGate — the point is that the return path runs.
 */
async function clearGate(page, { timeoutMs = 90000 } = {}) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let state = 'playing';
  let killed = 0;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const g = window.__game;
      // Snapshot: _killEnemy splices the array it is iterating.
      for (const e of [...g.enemies]) {
        if (e.spawning > 0) e.spawning = 0;
        g._killEnemy(e);
      }
      return { state: g.state, killed: g.killed, spawned: g.spawned, boss: g.bossActive };
    });
    state = st.state;
    killed = st.killed;
    if (state === 'over') break;
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(600);
  const results = await page.isVisible('#results');
  return {
    over: state === 'over', state, killed, results,
    seconds: (Date.now() - t0) / 1000,
  };
}
