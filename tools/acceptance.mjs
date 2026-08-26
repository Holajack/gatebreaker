// The owner's four complaints, verified end to end in one run.
//
//   node tools/acceptance.mjs
//
// This is deliberately NOT a unit test of any module. It drives the shipped UI
// from the title screen the way a person holding a phone would, and asks the
// four questions the owner actually asked after playing the last build:
//
//   1. Does it start in the CITY, let me walk to a portal, enter, and come back?
//   2. Are the enemies MONSTERS, or civilians in hi-vis hard hats?
//   3. Can I still walk through the rocks?
//   4. Do the characters look like people, or like glowing outlines?
//
// Section 5 is WORLD_SPEC step 12, the wave-2 sweep, and it asks the same kind
// of question about everything this wave added — not "does the module compute
// the right number" (the per-step suites own that) but "can a person do the
// thing, in the shipped build, in one continuous session":
//
//   5. Does the clock advance and survive a restart? Can he walk out of town
//      onto the frontier without falling through a seam? Is a wild gate really
//      enterable? Can he walk into a building and back out? Does the bound
//      companion turn up? Does buying a weapon stick across a reload?
//
// Everything here is measured on the live scene graph, not inferred. The
// screenshots at the end are the ones a human has to open and judge.

import {
  OUT, launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame,
  writeReport, shotPath, forceOpenGates,
} from './_harness.mjs';

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass), detail: String(detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return Boolean(pass);
};
const note = (s) => console.log(`  ${s}`);

/**
 * Drive the player with the exact vector the thumbstick writes, in real page
 * time, until he is within `stopWithin` of the target or the clock runs out.
 * Real frames, not a stepped loop: section 5 is about what a person can do.
 */
async function walkTo(page_, tx, tz, { timeoutMs = 25000, stopWithin = 1.0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page_.evaluate(([gx, gz]) => {
      const g = window.__game;
      const p = g.player.pos;
      const dx = gx - p.x, dz = gz - p.z;
      const d = Math.hypot(dx, dz);
      g.input.move.x = d > 0.001 ? dx / d : 0;
      g.input.move.y = d > 0.001 ? -dz / d : 0;
      return { d: +d.toFixed(2), x: +p.x.toFixed(1), z: +p.z.toFixed(1) };
    }, [tx, tz]);
    if (last.d < stopWithin) break;
    await page_.waitForTimeout(90);
  }
  await page_.evaluate(() => { window.__game.input.move.x = 0; window.__game.input.move.y = 0; });
  return last;
}

/** Walk the title -> PLAY -> city path and wait until CityMode is live. */
async function enterCityUi(page_, { waitMs = 900 } = {}) {
  await page_.click('#btnPlay');
  await page_.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
  // RETARGET 2026-08-26: tap through the first-arrival welcome overlay
  // (save.welcomed) — it owns every click while open. See _harness.dismissDialog.
  await page_.evaluate(() => { const d = window.__game?.dialog; for (let i = 0; d?.open && i < 12; i++) d.advance(); });
  await page_.waitForTimeout(waitMs);
}

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
const report = {};

try {
  // ================================================================= 1. FLOW
  console.log('\n1. START IN THE CITY, WALK TO A PORTAL, ENTER, COME BACK\n');
  await gotoGame(page);
  // Arena-behaviour tool: pin the flat arena for E/D via the sanctioned
  // forceOpen dev override (see _harness.forceOpenGates).
  await forceOpenGates(page);
  await page.screenshot({ path: shotPath('acc-00-title.png') });

  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
  // RETARGET 2026-08-26: first-arrival welcome — see enterCityUi above.
  await page.evaluate(() => { const d = window.__game?.dialog; for (let i = 0; d?.open && i < 12; i++) d.advance(); });
  await page.waitForTimeout(900);

  const arrived = await evalGame(page, (g) => ({
    mode: g.mode.name,
    portals: g.mode.city?.portals?.length ?? 0,
    enemies: g.enemies.length,
    gateBuilt: Boolean(g.gate),
    pos: [+g.player.pos.x.toFixed(1), +g.player.pos.z.toFixed(1)],
    grounded: g.player.body.grounded,
    hud: !document.getElementById('hud')?.classList.contains('hidden'),
  }));
  report.arrival = arrived;
  ok('PLAY lands in the city, not a dungeon',
    arrived.mode === 'city' && arrived.enemies === 0 && !arrived.gateBuilt,
    JSON.stringify(arrived));

  // --- can he actually WALK? drive the exact vector the thumbstick writes ---
  const walked = await page.evaluate(async () => {
    const g = window.__game;
    const start = g.player.pos.clone();
    // Forward on the stick = toward the plaza centre, which is what a new
    // player does first. If the spawn is inside a prop this returns ~0.
    for (let i = 0; i < 150; i++) {
      g.input.move.x = 0; g.input.move.y = 1;   // stick up = -z = into the plaza
      g.mode.update(1 / 60);
    }
    g.input.move.x = 0; g.input.move.y = 0;
    return {
      travelled: +start.distanceTo(g.player.pos).toFixed(2),
      to: [+g.player.pos.x.toFixed(1), +g.player.pos.z.toFixed(1)],
    };
  });
  report.firstWalk = walked;
  ok('pushing the stick forward from the spawn actually goes somewhere',
    walked.travelled > 6, `${walked.travelled} m to ${JSON.stringify(walked.to)}`);

  // --- walk to the nearest portal and read the prompt ---
  const approach = await page.evaluate(async () => {
    const g = window.__game;
    const city = g.mode.city;
    const target = city.portals.find((p) => p.rank === 'E') || city.portals[0];
    let steps = 0;
    for (; steps < 2400; steps++) {
      const dx = target.pos.x - g.player.pos.x;
      const dz = target.pos.z - g.player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 3.6) break;
      // input.move is the raw thumbstick: +y is "up", which physics maps to -z.
      g.input.move.x = dx / d;
      g.input.move.y = -dz / d;
      g.mode.update(1 / 60);
    }
    g.input.move.x = 0; g.input.move.y = 0;
    for (let i = 0; i < 20; i++) g.mode.update(1 / 60);
    const el = document.getElementById('cityPrompt');
    return {
      steps,
      rank: target.rank,
      dist: +Math.hypot(target.pos.x - g.player.pos.x, target.pos.z - g.player.pos.z).toFixed(2),
      promptText: el ? el.innerText.replace(/\s+/g, ' ').trim() : null,
      confirmVisible: Boolean(document.getElementById('cityConfirm')?.offsetParent),
    };
  });
  report.approach = approach;
  ok('walking up to a portal raises a prompt and a confirm button',
    approach.promptText && approach.confirmVisible,
    `${approach.dist} m — "${approach.promptText}"`);
  await page.screenshot({ path: shotPath('acc-01-portal-approach.png') });

  // --- tap confirm: this is the gate handoff the owner never got ---
  await page.click('#cityConfirm');
  await page.waitForFunction(() => window.__game?.mode?.name === 'dungeon', null, { timeout: 20000 });
  await page.waitForTimeout(1600);
  const entered = await evalGame(page, (g) => ({
    mode: g.mode.name, rank: g.gate?.rank, enemies: g.enemies.length,
    cityDisposed: !g.scene.getObjectByName('cityRoot'),
  }));
  report.entered = entered;
  ok('confirming at the portal enters the gate',
    entered.mode === 'dungeon' && entered.enemies > 0, JSON.stringify(entered));

  // ============================================================= 2. MONSTERS
  console.log('\n2. ARE THE ENEMIES MONSTERS?\n');
  const bestiary = await evalGame(page, (g) => {
    // entities.js parks BOTH pack instances on root.userData.character; the
    // only honest discriminator is userData.creature, which creatures.js writes
    // on the instance's own root one level down.
    const packOf = (mesh) => {
      let creature = null;
      mesh.traverse((o) => { if (!creature && o.userData?.creature) creature = o.userData.creature; });
      return creature;
    };
    const rows = [];
    for (const e of g.enemies) {
      const c = packOf(e.mesh);
      const ch = e.mesh.userData.character;
      rows.push({
        name: e.base?.name || '?',
        creature: c ? (c.key || c.appearance?.key || 'creature') : null,
        character: !c && ch ? (ch.appearance?.rig || 'character') : null,
        procedural: !c && !ch,
      });
    }
    // The plank sword tags itself; anything holding one is the old look.
    let planks = 0;
    g.scene.traverse((o) => { if (o.userData?.procedural === 'sword') planks++; });
    return { rows, planks };
  });
  report.bestiary = bestiary;
  const monsters = bestiary.rows.filter((r) => r.creature).length;
  ok('every enemy in the gate is a creatures.glb monster',
    monsters === bestiary.rows.length && monsters > 0,
    bestiary.rows.map((r) => `${r.name}=${r.creature || r.character || 'procedural'}`).join(', '));
  ok('nothing in the scene holds the procedural plank sword',
    bestiary.planks === 0, `${bestiary.planks} planks`);

  // ================================================================ 3. ROCKS
  console.log('\n3. CAN HE STILL WALK THROUGH THE ROCKS?\n');
  const rocks = await page.evaluate(async () => {
    const g = window.__game;
    const f = g.world.obstacleField;
    const stats = f.stats();
    // Pick a registered rock (not a pillar) well inside the arena and charge it.
    let target = null;
    for (let i = 0; i < f.count; i++) {
      const o = f.get(i);
      if (o.tag === 'rock' && Math.hypot(o.x, o.z) < g.world.radius * 0.8) { target = o; break; }
    }
    if (!target) return { stats, target: null };

    // "solid" = the game as it is now. "before" = the shipped behaviour for a
    // scatter rock: World.resolve knew only pillars and the field did not
    // exist, so both collision paths are off and the body walks straight
    // through. Unbinding BOTH is the only honest baseline — leaving the resolve
    // callback in place would silently re-collide through world.resolve.
    const run = (solid) => {
      const body = g.player.body;
      const savedField = body.obstacles;
      const savedResolve = body.resolve;
      body.setObstacles(solid ? f : null);
      if (!solid) body.resolve = null;
      // Start 6 m out, walk straight through where the rock is.
      const dx = target.x, dz = target.z;
      const d = Math.hypot(dx, dz) || 1;
      const sx = target.x - (dx / d) * 6, sz = target.z - (dz / d) * 6;
      body.reset(sx, 0, sz);
      let deepest = Infinity;
      for (let i = 0; i < 260; i++) {
        // Charge straight at the rock's centre, full stick, every frame.
        body.move(dx / d, dz / d, 1);
        body.step(1 / 60);
        const gap = Math.hypot(body.pos.x - target.x, body.pos.z - target.z)
          - (target.radius + body.radius);
        deepest = Math.min(deepest, gap);
      }
      body.move(0, 0, 0);
      body.setObstacles(savedField);
      body.resolve = savedResolve;
      return +deepest.toFixed(3);
    };
    // Order matters: measure the no-field baseline first so the "before"
    // number is not contaminated by where the solid run left the body.
    const without = run(false);
    const withField = run(true);
    return {
      stats,
      target: { x: +target.x.toFixed(1), z: +target.z.toFixed(1), r: +target.radius.toFixed(2), top: +target.top.toFixed(2) },
      penetrationWithoutField: without,
      penetrationWithField: withField,
      navGrid: Boolean(g.world.navGrid),
    };
  });
  report.rocks = rocks;
  note(`arena registry: ${JSON.stringify(rocks.stats)}`);
  ok('the arena registers real solids (pillars AND scatter rocks)',
    rocks.stats.count > 20, `${rocks.stats.count} obstacles`);
  ok('the player can no longer walk into a rock',
    rocks.target && rocks.penetrationWithField > -0.02,
    rocks.target
      ? `clearance ${rocks.penetrationWithField} m with the field vs ${rocks.penetrationWithoutField} m without`
      : 'no rock found');
  ok('the arena has a nav grid, so enemies path around the same solids',
    rocks.navGrid, String(rocks.navGrid));

  // ============================================================== 4. GLOWING
  console.log('\n4. DO THE CHARACTERS LOOK LIKE PEOPLE?\n');
  const look = await evalGame(page, (g) => {
    let livingRimmed = 0, livingPlain = 0, shadowRimmed = 0, shadowPlain = 0;
    const seen = new Set();
    const scan = (root, isShadow) => {
      root.traverse((o) => {
        if (!o.isMesh) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) {
          if (!m || seen.has(m.uuid)) continue;
          seen.add(m.uuid);
          const rimmed = Boolean(m.rimUniforms);
          if (isShadow) rimmed ? shadowRimmed++ : shadowPlain++;
          else rimmed ? livingRimmed++ : livingPlain++;
        }
      });
    };
    scan(g.player.mesh, false);
    for (const e of g.enemies) scan(e.mesh, false);
    for (const s of (g.shadows || [])) scan(s.mesh, true);
    return {
      livingRimmed, livingPlain, shadowRimmed, shadowPlain,
      bloomStrength: g.glow?.strength ?? null,
      bloomSpread: g.glow?.spread ?? null,
    };
  });
  report.look = look;
  ok('no living character carries a rim shader',
    look.livingRimmed === 0,
    `living rimmed=${look.livingRimmed} plain=${look.livingPlain} | shadow rimmed=${look.shadowRimmed} plain=${look.shadowPlain}`);
  ok('bloom is clamped to the value glow.js actually applies',
    look.bloomStrength <= 0.85 + 1e-6, `strength=${look.bloomStrength} spread=${look.bloomSpread}`);

  // --- the fight shot, at the real gameplay camera ---
  await page.evaluate(async () => {
    const g = window.__game;
    // Pull the enemies into frame so the shot is a fight, not an empty arena.
    const p = g.player.pos;
    let i = 0;
    for (const e of g.enemies) {
      const a = (i++ / g.enemies.length) * Math.PI * 2;
      e.pos.set(p.x + Math.cos(a) * 5.5, 0, p.z + Math.sin(a) * 5.5 - 2);
      e.mesh.position.copy(e.pos);
    }
    g.player.invuln = 0;
    g.player.mesh.visible = true;   // game.js blinks this at 22 Hz while invuln
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: shotPath('acc-02-fight.png') });

  // Eye level on the same fight — bloom and ground rings read very differently
  // from 13 m up than from where a person would be standing.
  await page.evaluate(() => {
    const g = window.__game;
    const p = g.player.pos;
    g.camera.position.set(p.x + 1.2, p.y + 1.7, p.z + 5.5);
    g.camera.lookAt(p.x, p.y + 1.3, p.z - 6);
    g.player.mesh.visible = true;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotPath('acc-03-fight-eye-level.png') });

  // ================================================== 1b. AND BACK TO THE CITY
  console.log('\n1b. CLEAR THE GATE AND COME BACK\n');
  const cleared = await page.evaluate(async () => {
    const g = window.__game;
    for (let i = 0; i < 3600; i++) {
      for (const e of [...g.enemies]) if (e.hp > 0) g._damageEnemy(e, 99999);
      g.update(1 / 60);
      if (g.state === 'over') break;
    }
    return { state: g.state, results: !document.getElementById('results')?.classList.contains('hidden') };
  });
  report.cleared = cleared;
  ok('killing everything reaches a result screen', cleared.state === 'over', JSON.stringify(cleared));

  // CONTINUE (and the level-up panel if it interposes)
  // #btnResultsOk is the results panel's CONTINUE; #btnStatsDone is the
  // level-up allocation panel that interposes between it and the city.
  for (let i = 0; i < 6; i++) {
    let clicked = false;
    for (const id of ['#btnResultsOk', '#btnStatsDone']) {
      const b = page.locator(id);
      if (await b.count() && await b.isVisible()) {
        await b.click();
        await page.waitForTimeout(900);
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
    if (await page.evaluate(() => window.__game?.mode?.name === 'city')) break;
  }
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 25000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  const back = await evalGame(page, (g) => ({
    mode: g.mode?.name,
    enemies: g.enemies.length,
    grounded: g.player.body.grounded,
    nearPortal: g.mode?.city
      ? +Math.min(...g.mode.city.portals.map((p) => Math.hypot(p.pos.x - g.player.pos.x, p.pos.z - g.player.pos.z))).toFixed(1)
      : null,
  }));
  report.returned = back;
  ok('CONTINUE puts him back in the city, on his feet, beside the portal he used',
    back.mode === 'city' && back.grounded && back.enemies === 0,
    JSON.stringify(back));

  // --- and he was PAID for it -------------------------------------------
  //
  // save.ash has existed since the v1 schema with two sinks (respec, shadow
  // promotion) and no source — nothing ever incremented it, so both sinks were
  // unreachable. The Exchange is the third sink and the reason it finally has
  // an income, granted alongside XP in game.gainXp. This is the end-to-end
  // proof that clearing a gate actually pays: the shop section below funds the
  // wallet directly so it can reach the expensive rows, which would otherwise
  // hide a broken earner.
  const wallet = await evalGame(page, (g) => ({
    ash: g.save.ash,
    ashEarned: g.ashEarned || 0,
    xpEarned: g.xpEarned,
    stored: (() => {
      try { return JSON.parse(localStorage.getItem('gatebreaker.save.v2') || '{}').ash; } catch { return null; }
    })(),
  }));
  report.wallet = wallet;
  ok('clearing a gate pays ash, and the wallet is persisted',
    wallet.ash > 0 && wallet.ashEarned > 0 && wallet.stored === wallet.ash,
    `${wallet.ashEarned} ash for ${wallet.xpEarned} XP, wallet ${wallet.ash}, stored ${wallet.stored}`);

  // --- the shot that matters most: the city at eye level on arrival ---
  await page.evaluate(() => {
    const g = window.__game;
    g.mode._accSaved = g.mode.updateCamera;
    g.mode.updateCamera = () => {};
    const p = g.player.pos;
    g.camera.position.set(p.x + 0.8, p.y + 1.68, p.z + 4.0);
    g.camera.lookAt(0, 3.0, -22);   // look across the plaza at the portal arc
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath('acc-04-city-eye-level.png') });

  await page.evaluate(() => {
    const g = window.__game;
    const p = g.player.pos;
    g.camera.position.set(p.x, p.y + 1.68, p.z + 2.4);
    g.camera.lookAt(p.x - 24, 2.4, p.z - 30);   // sweep left along the frontage
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotPath('acc-05-city-eye-left.png') });

  // ======================================= 5. WORLD_SPEC STEP 12 — THE SWEEP
  console.log('\n5. THE WORLD: CLOCK, FRONTIER, DOORS, COMPANION, SHOP\n');

  // ---- 5a. the clock advances, and it is the SAME light rig all day --------
  //
  // WORLD_SPEC decision 1 is the load-bearing one here: the sun and the moon
  // are the same DirectionalLight, and the light COUNT plus the shadow-casting
  // count are part of three's program cache key. So this measures the clock
  // moving AND the rig not changing shape while it does.
  //
  // The rig is THREE lights, not two: one hemi, one directional (sun AND moon),
  // and the shipped 'heroLight' PointLight that follows the player and has
  // nothing to do with the clock. It is counted so that a fourth appearing
  // would fail, not waved through.
  //
  // PROGRAM COUNT IS SAMPLED AT THE SAME HOUR, before and after — that is the
  // spec's wording and it is the only version that means anything. Comparing
  // 15:00 against 21:30 in a city that was rebuilt ten seconds ago measures
  // three.js compiling materials as they first come into view, not the clock
  // recompiling anything; the first cut of this check did exactly that and
  // reported a false 96 -> 104.
  const lightRigProbe = () => {
    const g = window.__game;
    let dir = 0, hemi = 0, other = 0, casters = 0;
    g.scene.traverse((o) => {
      if (!o.isLight) return;
      if (o.isDirectionalLight) dir++;
      else if (o.isHemisphereLight) hemi++;
      else other++;
      if (o.castShadow) casters++;
    });
    const k = g.mode.city?.key;
    return {
      hours: +g.worldClock.hours.toFixed(3),
      intensity: k ? +k.intensity.toFixed(3) : null,
      colour: k ? k.color.getHex() : null,
      rig: { dir, hemi, other, casters },
      programs: g.renderer.info.programs.length,
    };
  };

  // Settle at the shipped 15:00 look and let the renderer finish compiling
  // whatever the fresh city still owes before anything is counted.
  await page.evaluate(() => {
    const g = window.__game;
    g.worldClock.setHours(15);
    for (let i = 0; i < 60; i++) g.update(1 / 60);
  });
  await page.waitForTimeout(2500);
  const noon = await page.evaluate(lightRigProbe);

  // 24 real minutes is one 24 h day, so 60 s of game time is one hour. Ticked
  // through game.update, because that is the ONLY thing that advances the
  // clock in the shipped build — a bare setHours would prove nothing about the
  // wiring. dt is game.update's own 0.05 clamp, so 1200 steps is exactly 60 s
  // of game time and not 1200 frames of guesswork.
  const advanced = await page.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 1200; i++) g.update(0.05);
    return +g.worldClock.hours.toFixed(3);
  });

  // Deep dusk for the LOOK sample, and the hour that gets persisted.
  await page.evaluate(() => {
    const g = window.__game;
    g.worldClock.setHours(21.5);
    for (let i = 0; i < 60; i++) g.update(1 / 60);
  });
  await page.waitForTimeout(2500);
  const dusk = await page.evaluate(lightRigProbe);
  const storedHour = await page.evaluate(() => {
    window.__game.onSave();
    try { return JSON.parse(localStorage.getItem('gatebreaker.save.v2') || '{}').worldTime; } catch { return null; }
  });
  await page.screenshot({ path: shotPath('acc-06-city-night.png'), timeout: 90000 });

  // ...and back to 15:00, then round AGAIN.
  //
  // Two swings, because one cannot tell the two failure modes apart. Going
  // 15:00 -> 21:30 for the first time in a session legitimately compiles a
  // handful of programs: night materials and their depth variants enter the
  // shadow frustum for the first time and three compiles them once, which is
  // what a program cache is FOR. What must never happen is the same swing
  // compiling them AGAIN — that is the light-count cache invalidation
  // WORLD_SPEC decision 1 exists to prevent, and it shows up as the second
  // lap costing programs too. So: lap one is reported, lap two is asserted.
  const swing = async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.worldClock.setHours(21.5);
      for (let i = 0; i < 60; i++) g.update(1 / 60);
    });
    await page.waitForTimeout(1600);
    await page.evaluate(() => {
      const g = window.__game;
      g.worldClock.setHours(15);
      for (let i = 0; i < 60; i++) g.update(1 / 60);
    });
    await page.waitForTimeout(1600);
    return page.evaluate(lightRigProbe);
  };
  const backToNoon = await swing();
  const secondLap = await swing();

  report.clock = { noon, advancedHours: advanced, dusk, backToNoon, secondLap, storedHour };
  note(`clock ${noon.hours} h -> ${advanced} h -> ${dusk.hours} h · key ${noon.intensity} -> ${dusk.intensity}`
    + ` · rig ${JSON.stringify(dusk.rig)} · programs ${noon.programs} -> ${dusk.programs} -> ${backToNoon.programs} -> ${secondLap.programs}`);
  ok('the world clock advances while you stand in the city',
    advanced - noon.hours > 0.8 && advanced - noon.hours < 1.2,
    `${noon.hours} h -> ${advanced} h over 60 s of game time (expect ~1 h)`);
  ok('the light actually re-tints with the hour',
    dusk.intensity !== noon.intensity || dusk.colour !== noon.colour,
    `intensity ${noon.intensity} -> ${dusk.intensity}, colour ${noon.colour} -> ${dusk.colour}`);
  ok('the sun and the moon are the SAME light — count and casters never change',
    JSON.stringify(noon.rig) === JSON.stringify(dusk.rig)
      && JSON.stringify(noon.rig) === JSON.stringify(secondLap.rig)
      && dusk.rig.dir === 1 && dusk.rig.casters === 1,
    `${JSON.stringify(noon.rig)} -> ${JSON.stringify(dusk.rig)}`);
  note(`first swing into the dark cost ${dusk.programs - noon.programs} one-time program compiles`);
  ok('a SECOND day/night lap compiles nothing new — the shader cache is not being invalidated',
    secondLap.programs <= backToNoon.programs,
    `${noon.programs} at 15:00 -> ${dusk.programs} at 21.5 h -> ${backToNoon.programs} after lap 1 -> ${secondLap.programs} after lap 2`);
  ok('the hour is written to the save',
    typeof storedHour === 'number' && Math.abs(storedHour - dusk.hours) < 0.05,
    `stored ${storedHour}`);

  // ---- 5b. the frontier is walkable and the seam is not a ledge ------------
  const seam = await evalGame(page, (g) => {
    const city = g.mode.city;
    let jump = 0, at = null;
    // 120 radial sweeps outward across the blend band in 0.25 m steps — the
    // step a walking body takes in one frame at hub speed. The west cliff
    // (x < -88) is a real drop and is deliberately skipped.
    for (let k = 0; k < 120; k++) {
      const a = (k / 120) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const m = Math.max(Math.abs(ca), Math.abs(sa));
      let prev = null;
      for (let r = 150; r <= 205; r += 0.25) {
        const x = (r * ca) / m, z = (r * sa) / m;
        if (x < -88) { prev = null; continue; }
        const h = city.heightAt(x, z);
        if (!Number.isFinite(h)) return { jump: Infinity, at: { x, z }, nan: true };
        if (prev != null && Math.abs(h - prev) > jump) {
          jump = Math.abs(h - prev);
          at = { x: +x.toFixed(1), z: +z.toFixed(1) };
        }
        prev = h;
      }
    }
    return { jump: +jump.toFixed(3), at, nan: false, hasFrontier: Boolean(city.frontier) };
  });
  report.seam = seam;
  ok('the city has a frontier at all', seam.hasFrontier, String(seam.hasFrontier));
  ok('heightAt is continuous across the wall seam — no ledge to fall off',
    !seam.nan && seam.jump < 0.35, `worst step ${seam.jump} m at ${JSON.stringify(seam.at)}`);

  // Now WALK it, on the thumbstick, out of the north gate and onto the Verge.
  await page.evaluate(() => {
    const g = window.__game;
    g.player.body.reset(0, g.mode.city.heightAt(0, -40) + 0.2, -40);
    g.mode._camReady = false;
  });
  await page.waitForTimeout(250);
  const outward = await page.evaluate(async () => {
    const g = window.__game;
    let minY = Infinity, markX = 0, markZ = -40, strafe = 0, side = 1;
    // Steer at a far target and strafe when wedged — a body driven dead-on
    // into a round prop stalls forever with no lateral component to slide on,
    // which is exactly what a player's thumb works around.
    for (let i = 0; i < 60 * 60; i++) {
      const p = g.player.pos;
      let dx = 0 - p.x, dz = -320 - p.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      if (strafe > 0) { const t = dx; dx = -dz * side; dz = t * side; strafe--; }
      g.input.move.x = dx;
      g.input.move.y = -dz;
      g.mode.update(1 / 60);
      if (p.y < minY) minY = p.y;
      if (i > 0 && i % 120 === 0) {
        if (Math.hypot(p.x - markX, p.z - markZ) < 0.5 && strafe === 0) { strafe = 45; side = -side; }
        markX = p.x; markZ = p.z;
      }
    }
    g.input.move.x = 0; g.input.move.y = 0;
    const p = g.player.pos;
    return {
      x: +p.x.toFixed(1), z: +p.z.toFixed(1), y: +p.y.toFixed(2),
      minY: +minY.toFixed(2),
      grounded: g.player.body.grounded,
      groundY: +g.mode.city.heightAt(p.x, p.z).toFixed(2),
    };
  });
  report.frontierWalk = outward;
  note(`walked north to (${outward.x}, ${outward.z}) y=${outward.y} ground=${outward.groundY} minY=${outward.minY}`);
  ok('walking north out of town puts him on the frontier, on his feet',
    outward.z < -160 && outward.grounded && Math.abs(outward.y - outward.groundY) < 0.6,
    `ended z=${outward.z}, grounded=${outward.grounded}`);
  ok('he never fell through the world on the way out',
    outward.minY > -30, `lowest y was ${outward.minY}`);
  await page.screenshot({ path: shotPath('acc-07-frontier.png'), timeout: 90000 });

  // ---- 5c. a wild gate is enterable ---------------------------------------
  const wild = await page.evaluate(async () => {
    const g = window.__game;
    // A wild gate is rank-locked like any other; the sweep is about whether it
    // can be walked into, so unlock the ladder rather than grind to level 60.
    g.save.level = 60;
    g.refreshDerived(true);
    g.mode.refreshPortalLocks();
    const w = g.mode.city.portals.filter((p) => p.wild);
    const target = w.find((p) => !p.locked) || w[0] || null;
    return {
      count: w.length,
      target: target ? { rank: target.rank, x: target.pos.x, z: target.pos.z, locked: target.locked } : null,
    };
  });
  ok('the frontier carries wild gates', wild.count === 2, `${wild.count} wild gates`);
  ok('a wild gate unlocks with rank', wild.target && !wild.target.locked, JSON.stringify(wild.target));
  if (wild.target) {
    await page.evaluate((t) => {
      const g = window.__game;
      // Set down 14 m short of the dais and walk the rest, so the prompt is
      // raised by approach, not by teleporting onto it.
      const a = Math.atan2(t.z, t.x);
      const x = t.x - Math.cos(a) * 14, z = t.z - Math.sin(a) * 14;
      g.player.body.reset(x, g.mode.city.heightAt(x, z) + 0.2, z);
      g.mode._camReady = false;
    }, wild.target);
    await page.waitForTimeout(250);
    await walkTo(page, wild.target.x, wild.target.z, { stopWithin: 3.4, timeoutMs: 30000 });
    const wildPrompt = await evalGame(page, (g) => ({
      prompt: g.mode.prompt ? { kind: g.mode.prompt.kind, rank: g.mode.prompt.rank, locked: g.mode.prompt.locked, sub: g.mode.prompt.sub } : null,
      confirmVisible: Boolean(document.getElementById('cityConfirm')?.offsetParent),
      dist: (() => {
        const w = g.mode.city.portals.find((p) => p.wild && !p.locked);
        return w ? +Math.hypot(g.player.pos.x - w.pos.x, g.player.pos.z - w.pos.z).toFixed(2) : null;
      })(),
    }));
    report.wild = { ...wild, prompt: wildPrompt };
    note(`wild gate prompt at ${wildPrompt.dist} m: ${JSON.stringify(wildPrompt.prompt)}`);
    await page.screenshot({ path: shotPath('acc-08-wild-gate.png'), timeout: 90000 });
    ok('walking up to a wild gate raises an unlocked prompt',
      wildPrompt.prompt?.kind === 'portal' && wildPrompt.prompt.locked === false && wildPrompt.confirmVisible,
      JSON.stringify(wildPrompt.prompt));
    await page.click('#cityConfirm');
    await page.waitForFunction(() => window.__game?.mode?.name === 'dungeon', null, { timeout: 25000 })
      .catch(() => {});
    const inWild = await evalGame(page, (g) => ({ mode: g.mode?.name, rank: g.gate?.rank, enemies: g.enemies.length }));
    report.wildEntered = inWild;
    ok('confirming at a wild gate enters a gate',
      inWild.mode === 'dungeon' && inWild.enemies > 0, JSON.stringify(inWild));
    // Back to town the cheap way — the results path is already covered by 1b.
    await page.evaluate(() => window.__app.go('city', {}));
    await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
    await page.waitForTimeout(800);
  }

  // ---- 5d. the bound companion turns up -----------------------------------
  //
  // The companion is roster slot 0, so it only exists for a player who has
  // bound somebody. Seed the roster the way shadows.js writes it, re-enter the
  // city (which is what rebuilds the crowd), and look for it.
  const companion = await page.evaluate(async () => {
    const g = window.__game;
    if (!g.save.shadows?.roster?.length) {
      g.save.shadows = g.save.shadows || { roster: [], deployed: [], nextId: 1 };
      g.save.shadows.roster.push({
        id: 1, name: 'Cinderbound 1', grade: 1, type: 'grunt', level: g.save.level, kills: 0, bornAt: 0,
      });
      g.save.shadows.nextId = 2;
      g.onSave();
    }
    g.enterCity({});
    await new Promise((r) => setTimeout(r, 900));
    const city = g.mode.city;
    const node = g.scene.getObjectByName('city_companion');
    // The no-glow rule for living characters, applied to the companion body:
    // its ONE sanctioned accent is the wisp Points node, which is exempt.
    let rimmed = 0, emissive = 0, meshes = 0;
    node?.traverse((o) => {
      if (o.name === 'companion_wisps' || o.isPoints) return;
      if (!o.isMesh) return;
      meshes++;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        if (m.rimUniforms) rimmed++;
        if (m.emissive && m.emissive.getHex() !== 0x000000) emissive++;
      }
    });
    return {
      stats: city.citizens ? city.citizens.stats : null,
      node: Boolean(node),
      meshes, rimmed, emissive,
      dist: node ? +node.position.distanceTo(g.player.pos).toFixed(1) : null,
    };
  });
  report.companion = companion;
  note(`companion node=${companion.node} meshes=${companion.meshes} at ${companion.dist} m · crowd ${JSON.stringify(companion.stats)}`);
  ok('a player with a bound shadow gets a companion in the city',
    companion.node && companion.stats?.companion === true, JSON.stringify(companion.stats));
  ok('the companion body carries no rim and no emissive',
    companion.rimmed === 0 && companion.emissive === 0,
    `rimmed=${companion.rimmed} emissive=${companion.emissive} over ${companion.meshes} meshes`);
  // ---- 5d-bis. the frontier camps, and the phone-budget fence --------------
  //
  // Both need a city built at a HIGH tier, and this harness runs on a software
  // rasteriser at ~150 ms a frame, so by now the live governor has honestly
  // stepped itself down to `low` — where the camps are deliberately not built
  // (WORLD_SPEC: "2 hunter NPCs AT HIGH TIER") and where the density lever has
  // nothing to shed because the world was already sized small. Pin the tier and
  // re-enter, which is the same path a phone takes when it re-enters the city.
  const worldFence = await evalGame(page, async (g) => {
    const tier0 = g.quality.current.name || null;
    g.quality.lock('high');
    g.enterCity({});
    await new Promise((r) => setTimeout(r, 900));
    const crowd = g.mode.city.citizens ? g.mode.city.citizens.stats : null;

    const snap = () => {
      const s = g.mode.city.stats;
      return { density: s.density, tris: s.triangles, instances: s.instances };
    };
    const before = snap();
    // The REAL governor path: setTier fires game._applyQuality, which is where
    // the wiring was missing — every other lever in it fired and the world's
    // instance density did not.
    g.quality.setTier('low');
    const low = snap();
    g.quality.setTier('high');
    const up = snap();
    g.quality.lock(null);
    if (tier0) g.quality.setTier(tier0);
    return { tier0, crowd, before, low, up };
  });
  report.worldFence = worldFence;
  note(`camps at high tier: ${JSON.stringify(worldFence.crowd?.campPois)}`);
  note(`quality fence: ${worldFence.before.tris} tris at ${worldFence.before.density}`
    + ` -> low ${worldFence.low.tris} -> back up ${worldFence.up.tris}`);
  // WORLD_SPEC's frontier POI table puts PEOPLE in the two camps. They shipped
  // empty once, with the npcs field sitting unread in frontier.js, so the camps
  // get a count here rather than a screenshot someone has to look at.
  ok('the frontier camps have people in them',
    worldFence.crowd?.camp === 3
    && worldFence.crowd.campPois?.camp_hunters_east === 2
    && worldFence.crowd.campPois?.camp_farmstead === 1,
    JSON.stringify(worldFence.crowd?.campPois));
  ok('stepping the quality tier down sheds world triangles without a rebuild',
    worldFence.low.tris < worldFence.before.tris * 0.8
    && worldFence.low.instances < worldFence.before.instances,
    JSON.stringify(worldFence));
  ok('stepping the tier back up restores the world it shed',
    worldFence.up.tris === worldFence.before.tris,
    JSON.stringify({ low: worldFence.low.tris, up: worldFence.up.tris, before: worldFence.before.tris }));

  // ---- 5e. an interior is enterable and exitable, and it sells weapons -----
  const doorway = await evalGame(page, (g) => {
    const d = g.mode.city.interiors.byId.get('exchange').door;
    return { outX: d.outX + d.nx * 2.4, outZ: d.outZ + d.nz * 2.4, inX: d.inX, inZ: d.inZ };
  });
  await page.evaluate((d) => {
    const g = window.__game;
    g.player.body.reset(d.outX, g.mode.city.heightAt(d.outX, d.outZ) + 0.2, d.outZ);
    g.mode._camReady = false;
  }, doorway);
  await page.waitForTimeout(250);
  await walkTo(page, doorway.inX, doorway.inZ);
  const counter = await evalGame(page, (g) => {
    const it = g.mode.city.interactables.find((x) => x.id === 'exchange');
    return { x: it.pos.x, z: it.pos.z };
  });
  await walkTo(page, counter.x, counter.z);
  const insideNow = await evalGame(page, (g) => ({
    inside: g.mode._insideId,
    prompt: g.mode.prompt ? g.mode.prompt.id : null,
    boom: +Math.hypot(g.camera.position.x - g.player.pos.x, g.camera.position.y - g.player.pos.y,
      g.camera.position.z - g.player.pos.z).toFixed(2),
    confirmVisible: Boolean(document.getElementById('cityConfirm')?.offsetParent),
  }));
  report.interior = insideNow;
  note(`inside the Exchange: ${JSON.stringify(insideNow)}`);
  ok('he can walk INTO a building through its door',
    insideNow.inside === 'exchange', JSON.stringify(insideNow));
  ok('the interactable inside the building prompts',
    insideNow.prompt === 'exchange' && insideNow.confirmVisible, JSON.stringify(insideNow));
  await page.screenshot({ path: shotPath('acc-09-interior.png'), timeout: 90000 });

  // --- buy something ---
  await page.evaluate(() => {
    const g = window.__game;
    g.save.ash = 4000;   // an S-rank hunter's walking-around money
    g.onSave();
  });
  await page.click('#cityConfirm');
  await page.waitForSelector('#shop:not(.hidden)', { timeout: 10000 });
  await page.screenshot({ path: shotPath('acc-10-shop.png'), timeout: 90000 });
  const bought = await page.evaluate(async () => {
    const g = window.__game;
    const before = { ash: g.save.ash, weapon: g.weapon.name, baseId: g.weapon.baseId };
    const rows = [...document.querySelectorAll('#shopList .gate')]
      .filter((r) => !r.classList.contains('locked') && !r.classList.contains('owned'));
    let best = null, bestP = -1;
    for (const r of rows) {
      const p = Number(r.querySelector('.price b')?.textContent || 0);
      if (p > bestP && p <= g.save.ash) { bestP = p; best = r; }
    }
    if (!best) return { before, ok: false };
    best.click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      before,
      ok: true,
      price: bestP,
      after: { ash: g.save.ash, weapon: g.weapon.name, baseId: g.weapon.baseId },
      rows: rows.length,
    };
  });
  report.shop = bought;
  note(`shop: ${bought.rows} buyable rows; bought for ${bought.price}; "${bought.before.weapon}" -> "${bought.after?.weapon}"`);
  ok('the Exchange sells a weapon and equips it',
    bought.ok && bought.after.ash === bought.before.ash - bought.price
      && bought.after.baseId !== bought.before.baseId,
    JSON.stringify(bought.after || {}));
  await page.evaluate(() => window.__game.shopUI.close());
  await page.waitForTimeout(200);

  // --- and back out through the same door ---
  await walkTo(page, doorway.outX, doorway.outZ);
  const outAgain = await evalGame(page, (g) => ({ inside: g.mode._insideId, mode: g.mode.name }));
  ok('and he can walk back OUT of the building',
    outAgain.inside === null && outAgain.mode === 'city', JSON.stringify(outAgain));

  // ---- 5f. three city re-entries leak nothing -----------------------------
  const leak = await page.evaluate(async () => {
    const g = window.__game;
    const snap = () => ({
      geometries: g.renderer.info.memory.geometries,
      textures: g.renderer.info.memory.textures,
      programs: g.renderer.info.programs.length,
    });
    g.enterCity({});
    await new Promise((r) => setTimeout(r, 700));
    const before = snap();
    for (let i = 0; i < 3; i++) {
      g.enterCity({});
      await new Promise((r) => setTimeout(r, 700));
    }
    return {
      before,
      after: snap(),
      // The DOM leaks too if anyone forgets: CityMode is rebuilt on every
      // entry and its overlay must leave with it, or the page ends up with N
      // copies of #cityConfirm and getElementById starts returning corpses.
      cityUiNodes: document.querySelectorAll('#cityUi').length,
      shopNodes: document.querySelectorAll('#shop').length,
    };
  });
  report.leak = leak;
  note(`re-entry x3: geo ${leak.before.geometries} -> ${leak.after.geometries}, `
    + `tex ${leak.before.textures} -> ${leak.after.textures}, prog ${leak.before.programs} -> ${leak.after.programs}`);
  ok('three city re-entries leak no GPU resources',
    leak.after.geometries <= leak.before.geometries
      && leak.after.textures <= leak.before.textures
      && leak.after.programs <= leak.before.programs,
    JSON.stringify(leak));
  ok('...and no duplicate overlay DOM either',
    leak.cityUiNodes === 1 && leak.shopNodes === 1,
    `${leak.cityUiNodes} x #cityUi, ${leak.shopNodes} x #shop`);

  // ---- 5g. frame time in the city, at the 30 fps city target ---------------
  //
  // REPORTED, NOT ASSERTED. This is SwiftShader on a laptop; the number says
  // nothing about a phone and pretending otherwise would be the kind of claim
  // this file exists to stop.
  const frames = await page.evaluate(() => new Promise((resolve) => {
    const t = [];
    let last = performance.now();
    let n = 0;
    const tick = (now) => {
      t.push(now - last);
      last = now;
      if (++n < 180) requestAnimationFrame(tick);
      else resolve(t.slice(10).sort((a, b) => a - b));
    };
    requestAnimationFrame(tick);
  }));
  const p95 = frames[Math.floor(frames.length * 0.95)] || 0;
  const median = frames[Math.floor(frames.length * 0.5)] || 0;
  report.frameTime = {
    medianMs: +median.toFixed(1), p95Ms: +p95.toFixed(1),
    samples: frames.length, rasteriser: 'swiftshader (software) — NOT a phone number',
  };
  note(`city frame time: median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms `
    + `(software rasteriser — reported, not asserted; 30 fps city target = 33.3 ms)`);

  // ---- 5h. desktop keyboard, because the owner plays on a desktop too ------
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  const keyboard = await (async () => {
    const start = await evalGame(page, (g) => ({ x: g.player.pos.x, z: g.player.pos.z }));
    await page.keyboard.down('w');
    await page.waitForTimeout(1200);
    await page.keyboard.up('w');
    const afterW = await evalGame(page, (g) => ({ x: g.player.pos.x, z: g.player.pos.z }));
    await page.keyboard.down('d');
    await page.waitForTimeout(1200);
    await page.keyboard.up('d');
    const afterD = await evalGame(page, (g) => ({ x: g.player.pos.x, z: g.player.pos.z }));
    return {
      forward: +Math.hypot(afterW.x - start.x, afterW.z - start.z).toFixed(2),
      strafe: +Math.hypot(afterD.x - afterW.x, afterD.z - afterW.z).toFixed(2),
    };
  })();
  report.keyboard = keyboard;
  ok('desktop keyboard: W and D walk him around the city',
    keyboard.forward > 1.5 && keyboard.strafe > 1.5,
    `W moved ${keyboard.forward} m, D moved ${keyboard.strafe} m`);
  await page.screenshot({ path: shotPath('acc-11-desktop.png'), timeout: 90000 });

  // ---- 5i. RELOAD: the clock, the wallet and the weapon all survive --------
  const persisted = await page.evaluate(() => ({
    ash: window.__game.save.ash,
    weapon: window.__game.weapon.name,
    baseId: window.__game.weapon.baseId,
    hours: +window.__game.worldClock.hours.toFixed(2),
    level: window.__game.save.level,
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__game), null, { timeout: 30000 });
  await page.waitForSelector('#title:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const afterReload = await page.evaluate(async () => {
    const { bootBias } = await import('/src/render/daynight.js');
    const g = window.__game;
    return {
      ash: g.save.ash,
      weapon: g.weapon.name,
      baseId: g.weapon.baseId,
      hours: +g.worldClock.hours.toFixed(2),
      stored: +(g.save.worldTime ?? -1).toFixed(2),
      expectedHours: +bootBias(g.save.worldTime).toFixed(2),
      sold: (g.save.shop?.sold || []).length,
      roster: g.save.shadows?.roster?.length || 0,
    };
  });
  report.persisted = { before: persisted, after: afterReload };
  note(`after reload: ash ${afterReload.ash}, wielding "${afterReload.weapon}", `
    + `clock ${afterReload.hours} h (saved ${afterReload.stored} h)`);
  ok('the weapon he bought is still in his hand after a restart',
    afterReload.baseId === persisted.baseId && afterReload.ash === persisted.ash
      && afterReload.sold > 0,
    `${afterReload.weapon} / ${afterReload.ash} ash / ${afterReload.sold} sold`);
  ok('the world clock resumes where he left it',
    Math.abs(afterReload.hours - afterReload.expectedHours) < 0.05
      && Math.abs(afterReload.stored - persisted.hours) < 0.2,
    `saved ${afterReload.stored} h, resumed ${afterReload.hours} h (bootBias expects ${afterReload.expectedHours})`);

  // ...and the companion is still at his heel on the next visit.
  await enterCityUi(page);
  const compAgain = await evalGame(page, (g) => ({
    node: Boolean(g.scene.getObjectByName('city_companion')),
    companion: g.mode.city?.citizens?.stats?.companion ?? null,
  }));
  report.companionAfterReload = compAgain;
  ok('the companion is still there on the next session',
    compAgain.node && compAgain.companion === true, JSON.stringify(compAgain));
  await page.screenshot({ path: shotPath('acc-12-companion.png'), timeout: 90000 });

  // ======================================================= 6. SOULS (3-B2)
  // CLASSES_SPEC STEP 11: the identity layers, asked the way the owner would
  // after playing — does the game NAME what I've been doing, does the Assay
  // Hall remember my oath, does the endgame offer arrive when I've earned it,
  // and does a path actually DO its thing in a live gate?
  console.log('\n6. SOULS: DIRECTION, THE ASSAY OATH, THE ARCHON OFFER, THE STORM\n');

  // ---- 6a. a class-less save plays on shipped numbers ---------------------
  // (buildOrder: "a null-class save producing shipped numbers"). This profile
  // has levelled and fought all session and never chosen a class, so its
  // derived block must be field-exact to derive() — the migration guarantee,
  // measured on the live game rather than in a unit.
  const nullClass = await evalGame(page, async (g) => {
    const { derive } = await import('/src/game/config.js');
    const base = derive(g.save, g._armorBonus);
    return {
      className: g.save.className,
      archon: g.save.archon,
      diffs: Object.keys(base).filter((k) => g.derived[k] !== base[k]),
    };
  });
  report.nullClass = nullClass;
  ok('a class-less save still plays on exactly the shipped numbers',
    nullClass.className === null && nullClass.diffs.length === 0, JSON.stringify(nullClass));

  // ---- 6b. direction derives from SPENT points ----------------------------
  const direction = await evalGame(page, async (g) => {
    const { directionOf } = await import('/src/game/classes.js');
    const saved = { ...g.save.stats };
    g.save.stats = { str: 0, agi: 0, vit: 0, int: 120, per: 0 };
    const read = directionOf(g.save);
    g.ui._renderStats();
    const header = document.querySelector('#statGrid .readout b')?.textContent || '';
    g.save.stats = saved;
    g.refreshDerived();
    return { read, header };
  });
  report.direction = direction;
  ok('spending deep into INTELLECT reads as a direction and the panel names it',
    direction.read === 'int' && /EMBERMIND/.test(direction.header),
    `${direction.read} / "${direction.header}"`);

  // ---- 6c. the Assay Hall oath ------------------------------------------
  // Walk the door the way a player does (the prompt at the assayer's desk),
  // swear BERSERKER through the real panel controls, and demand the derived
  // block repricess by EXACTLY the modelled amounts — applyLayers is the one
  // pricing authority ("a class-chosen save producing the modelled numbers").
  const assay = await evalGame(page, async (g) => {
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'assay');
    g.save.level = Math.max(22, g.save.level);
    g.save.autoStats = Math.max(21, g.save.autoStats);
    g.save.stats.str = Math.max(60, g.save.stats.str | 0);
    g.save.className = null;
    g.refreshDerived(true);
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    const sub = g.mode.prompt?.sub;
    g.mode.confirmPrompt();
    const open = Boolean(g.assayUI?.isOpen);
    document.querySelector('#assayList .gate[data-class-key="berserker"]')?.click();
    document.getElementById('assayConfirm')?.click();
    const { applyLayers } = await import('/src/game/classes.js');
    const { derive } = await import('/src/game/config.js');
    const want = applyLayers(g.save, derive(g.save, g._armorBonus));
    return {
      sub,
      open,
      className: g.save.className,
      diffs: Object.keys(want).filter((k) => g.derived[k] !== want[k]),
      atkSpeed: g.derived.atkSpeed,
    };
  });
  report.assay = assay;
  ok('the assayer\'s desk offers the class choice at level 20+',
    assay.sub === 'YOUR CLASS AWAITS' && assay.open, JSON.stringify({ sub: assay.sub, open: assay.open }));
  ok('swearing BERSERKER sticks and reprices by exactly the modelled amounts',
    assay.className === 'berserker' && assay.diffs.length === 0,
    `class ${assay.className}, drifted fields: ${assay.diffs.join(',') || 'none'}`);
  await page.screenshot({ path: shotPath('acc-13-assay-oath.png'), timeout: 90000 });
  await evalGame(page, (g) => g.assayUI?.close?.());

  // ---- 6d. ...and the oath survives a restart -----------------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__game), null, { timeout: 30000 });
  await page.waitForSelector('#title:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(800);
  const oathAfter = await page.evaluate(() => ({
    className: window.__game.save.className,
    tokens: window.__game.save.respecTokens,
  }));
  report.oathAfter = oathAfter;
  ok('the class oath survives a restart (save round-trip through the sanitisers)',
    oathAfter.className === 'berserker', JSON.stringify(oathAfter));

  // ---- 6e. the archon offer arrives when earned ---------------------------
  // Level 55, the trial done, an S clear on the books, storm affinity led by
  // this save's (scripted) play: the offer must list the top two counters
  // plus SHADOW, and taking STORM must change NOTHING on the derived block
  // ("an ascended save producing an unchanged derived block").
  await enterCityUi(page);
  const offer = await evalGame(page, (g) => {
    g.save.level = 55;
    g.save.autoStats = 54;
    if (!g.save.classTier) g.save.classTier = 'base';
    g.save.cleared.S = 1;
    g.save.archon = null;
    g.save.archonState.affinity.storm = 40;
    g.save.archonState.affinity.frost = 12;
    g.refreshDerived(true);
    g._offerAscension();
    return {
      visible: !document.getElementById('archonPanel').classList.contains('hidden'),
      rows: [...document.querySelectorAll('#archonPanel .gate')].map((r) => r.dataset.archon),
    };
  });
  report.archonOffer = offer;
  ok('an archon offer appears when earned — the top two by affinity, plus SHADOW',
    offer.visible && offer.rows[0] === 'storm' && offer.rows.includes('shadow'),
    JSON.stringify(offer.rows));
  await page.screenshot({ path: shotPath('acc-14-archon-offer.png'), timeout: 90000 });
  const ascended = await evalGame(page, (g) => {
    const before = { ...g.derived };
    document.querySelector('#archonPanel .gate[data-archon="storm"]')?.click();
    return {
      archon: g.save.archon,
      diffs: Object.keys(before).filter((k) => g.derived[k] !== before[k]),
    };
  });
  report.ascended = ascended;
  ok('ascending STORM writes the identity and changes NOTHING on the derived block',
    ascended.archon === 'storm' && ascended.diffs.length === 0, JSON.stringify(ascended));

  // ---- 6f. the path's signature fires end-to-end in a live gate -----------
  // A landed hit through the real damage funnel chains 55% x atk to the 8 m
  // neighbour and spends exactly the 4-Charge discharge (the STEP 11 parity
  // tune), and the absolute 14 u/s ceiling holds against a speed no build
  // can reach — the two numbers the spec calls out by name.
  const storm = await evalGame(page, (g) => {
    const realRandom = Math.random;
    const realRender = g.renderer.render;
    try {
      g.startGate(0);
      g.renderer.render = () => {};
      // Skip the walk-in intro: its auto-walk writes body.maxSpeed on its own
      // (inert in play — nothing can be live during the walk-in), and the 14
      // u/s probe below must read the FIGHT loop's clamp site.
      for (let i = 0; i < 10; i++) {
        if (g.mode?.intro) g.mode._introSkip = true;
        g.update(1 / 60);
      }
      g.renderer.render = realRender;
      g.killed = -99999;
      g.spawned = 99999;
      Math.random = () => 0.99; // deterministic: no crits, no extraction rolls
      for (const e of [...g.enemies]) g._killEnemy(e);
      const V = g.player.pos.constructor;
      const mk = (x, z) => {
        g._spawnEnemy(new V(x, 0, z), 'grunt');
        const e = g.enemies[g.enemies.length - 1];
        e.spawning = 0; e.attackCd = 9e9; e.hp = 1e6; e.maxHp = 1e6;
        e.pos.set(x, 0, z);
        return e;
      };
      const A = mk(g.player.pos.x + 3, g.player.pos.z);
      const B = mk(g.player.pos.x + 5, g.player.pos.z);
      g._archonRes.set(200);
      const hpB = B.hp;
      g._damageEnemy(A, 10);
      const chained = hpB - B.hp;
      const charge = g._archonRes.value;
      const segs = g._archonFx?.liveCount || 0;
      // the ceiling: a live Tempest and an absurd speed, clamped at the body
      g._tempestT = 3;
      const realSpeed = g.derived.speed;
      g.derived.speed = 30;
      g.renderer.render = () => {};
      g.update(1 / 60);
      const cap = g.player.body.maxSpeed;
      g.derived.speed = realSpeed;
      g._tempestT = 0;
      g.update(1 / 60);
      return {
        chained, expected: Math.max(1, Math.round(g.derived.atk * 0.55)),
        charge, segs, cap,
      };
    } finally {
      Math.random = realRandom;
      g.renderer.render = realRender;
    }
  });
  report.storm = storm;
  ok('STORM\'s signature fires end-to-end: a landed hit chains 55% x atk and spends 4 Charge',
    storm.chained === storm.expected && storm.charge === 196 && storm.segs > 0,
    JSON.stringify(storm));
  ok('the absolute 14 u/s move-speed ceiling holds whatever pushes against it',
    storm.cap === 14, String(storm.cap));
  await page.screenshot({ path: shotPath('acc-15-storm-gate.png'), timeout: 90000 });

  ok('no uncaught page errors across the whole run', errors.length === 0,
    errors.slice(0, 2).join(' | ') || 'none');
} catch (err) {
  console.error(err);
  ok('acceptance run completed without throwing', false, err.message);
} finally {
  const file = writeReport('acceptance', { when: new Date().toISOString(), checks, ...report });
  const failed = checks.filter((c) => !c.pass);
  console.log(`\nreport: ${file}`);
  console.log(`shots:  ${OUT}`);
  console.log(failed.length
    ? `\nACCEPTANCE FAILED — ${failed.length}/${checks.length}: ${failed.map((f) => f.name).join('; ')}`
    : `\nACCEPTANCE PASSED — ${checks.length} checks`);
  await browser.close();
  await server.stop();
  process.exit(failed.length ? 1 : 0);
}
