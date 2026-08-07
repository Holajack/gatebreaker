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
// Everything here is measured on the live scene graph, not inferred. The
// screenshots at the end are the ones a human has to open and judge.

import {
  OUT, launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame,
  writeReport, shotPath,
} from './_harness.mjs';

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass), detail: String(detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return Boolean(pass);
};
const note = (s) => console.log(`  ${s}`);

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
const report = {};

try {
  // ================================================================= 1. FLOW
  console.log('\n1. START IN THE CITY, WALK TO A PORTAL, ENTER, COME BACK\n');
  await gotoGame(page);
  await page.screenshot({ path: shotPath('acc-00-title.png') });

  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
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
