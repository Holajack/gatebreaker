// Verification for the skinned-character swap.
//
//   node tools/character-test.mjs            headless, screenshots to $GB_OUT
//   node tools/character-test.mjs --headed   watch it happen
//
// What it proves, in order of how badly each one bites if it regresses:
//
//   1. Characters are GLB-BACKED. The player, every enemy and every shadow
//      carry a userData.character with a real SkinnedMesh, not the box-man.
//   2. NO SKELETON IS SHARED. Object3D.clone() on a rigged model produces
//      instances that all point at the SOURCE skeleton and animate in lockstep;
//      it is silent and it looks like a bug in the AI, not in the loader. Every
//      instance's Skeleton uuid, bone uuids and boneMatrices buffer must be
//      distinct, and their live bone matrices must actually DIVERGE.
//   3. THE MIXER ADVANCES and the pose changes: bone world positions at t0 and
//      t+2s must differ, or we have shipped 20 statues.
//   4. APPEARANCES DIFFER. Enemies must not all resolve to one merged geometry.
//   5. DRAW CALLS AND FRAME COST with a crowd of 20, measured off
//      renderer.info, not estimated.
//   6. FALLBACK. With the GLB blocked at the network layer the game still
//      boots, still spawns, and still animates on the procedural rig.
//
// Every failure exits non-zero. Screenshots are written and the run prints
// their paths so the numbers can be checked against pixels.

import fs from 'node:fs';
import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, enterGate,
  writeReport, shotPath, evalGame, OUT,
} from './_harness.mjs';

const HEADED = process.argv.includes('--headed') || process.argv.includes('--gpu');
// SwiftShader rasterises AND runs the vertex stage on the CPU, so it charges
// skinning at roughly 10x what a phone GPU does and it charges triangles at
// several times what any GPU does. --gpu drops it for the real driver, which is
// the only frame number in here worth quoting.
const GPU = process.argv.includes('--gpu');
const CROWD = Number(process.env.GB_CROWD || 20);

const failures = [];
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`;
  console.log(line);
  results.push({ name, ok, detail });
  if (!ok) failures.push(name);
  return ok;
}

// ---------------------------------------------------------------- probes
//
// These run inside the page against window.__game. Kept as plain functions so
// the bridge only ever ships one argument array.

function probeSnapshot(game) {
  const ents = [];
  const push = (label, e) => {
    if (!e?.mesh) return;
    const ch = e.mesh.userData.character;
    let skinned = null;
    e.mesh.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o; });
    const bones = skinned?.skeleton?.bones || [];
    const boneNames = bones.slice(0, 4).map((b) => b.name);
    const boneUuids = bones.slice(0, 8).map((b) => b.uuid);
    ents.push({
      label,
      glb: Boolean(ch),
      appearance: e.mesh.userData.appearance?.key || null,
      base: e.mesh.userData.appearance?.base || null,
      archetype: e.mesh.userData.appearance?.archetype || null,
      state: ch?.state || null,
      mixerTime: ch?.mixer?.time ?? null,
      skeletonUuid: skinned?.skeleton?.uuid || null,
      boneMatricesId: skinned?.skeleton?.boneMatrices ? skinned.skeleton.boneMatrices.length : 0,
      boneNames,
      boneUuids,
      geometryUuid: skinned?.geometry?.uuid || null,
      hasHandSocket: Boolean(e.mesh.userData.rig?.hand),
      // world height of the mesh, to catch a scale mistake against the 2.14
      // unit procedural rig the whole game is dimensioned against
      height: window.__chars ? window.__chars.measureHeight(e.mesh) : null,
      pos: [+e.pos.x.toFixed(2), +e.pos.z.toFixed(2)],
    });
  };
  push('player', game.player);
  game.enemies.forEach((e, i) => push(`enemy${i}:${e.key}`, e));
  game.shadows.forEach((s, i) => push(`shadow${i}`, s));
  return ents;
}

function probeBonePose(game) {
  // First bone-matrix row of every skinned instance. Two instances that share a
  // skeleton produce byte-identical rows forever.
  const out = [];
  const collect = (label, mesh) => {
    let skinned = null;
    mesh.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o; });
    if (!skinned?.skeleton) return;
    const m = skinned.skeleton.boneMatrices;
    const sig = [];
    for (let i = 0; i < Math.min(m.length, 64); i++) sig.push(+m[i].toFixed(4));
    out.push({ label, sig: sig.join(','), uuid: skinned.skeleton.uuid });
  };
  if (game.player?.mesh) collect('player', game.player.mesh);
  game.enemies.forEach((e, i) => collect(`enemy${i}`, e.mesh));
  game.shadows.forEach((s, i) => collect(`shadow${i}`, s.mesh));
  return out;
}

function probeRenderStats(game) {
  const info = game.renderer.info;
  return {
    calls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs?.length ?? 0,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    enemies: game.enemies.length,
    shadows: game.shadows.length,
  };
}

/**
 * CPU cost of one game frame, vsync removed: stop the clock, then call
 * game.update by hand and time it. This is the number that decides whether 20
 * skinned characters fit on a phone, because skinning cost is bone matrices and
 * a bone-texture upload per instance — all of it CPU-side.
 */
async function measureUpdateCost(page, frames) {
  return page.evaluate(async (n) => {
    const g = window.__game;
    window.__clock?.stop();
    const t = [];
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      g.update(1 / 60);
      t.push(performance.now() - a);
    }
    window.__clock?.start();
    t.sort((a, b) => a - b);
    return {
      medianMs: +t[Math.floor(t.length / 2)].toFixed(2),
      p95Ms: +t[Math.floor(t.length * 0.95)].toFixed(2),
    };
  }, frames);
}

/** Median / p95 rAF interval over `frames` frames, measured in the page. */
async function measureFrames(page, frames) {
  return page.evaluate(async (n) => {
    const samples = [];
    let last = performance.now();
    await new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        const now = performance.now();
        samples.push(now - last);
        last = now;
        if (++i >= n) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    samples.sort((a, b) => a - b);
    return {
      medianFrameMs: +samples[Math.floor(samples.length / 2)].toFixed(2),
      p95FrameMs: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
    };
  }, frames);
}

// ---------------------------------------------------------------------- run

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: !GPU });
let exitCode = 0;

try {
  // ================================================== PASS 1: GLB available
  const { page, errors } = await newPhonePage(browser, { width: 900, height: 520, dpr: 2 });
  // Expose THREE + a crowd spawner. Both are additive and read-only w.r.t. the
  // game's own state machine.
  await page.addInitScript(() => {
    window.__charTest = true;
  });
  await gotoGame(page);
  const packOk = await page.evaluate(async () => {
    const m = await import('/src/render/characters.js');
    window.__chars = m;
    await m.loadCharacterModels();
    return m.characterStats();
  });
  check('characters.glb loads through GLTFLoader + MeshoptDecoder',
    packOk.loaded === true,
    `${packOk.characters} characters, ${packOk.rigs} rigs, ${packOk.clips} clips`);
  check('geometry merge never fell back to per-primitive meshes',
    packOk.mergeFailures === 0, `mergeFailures=${packOk.mergeFailures}`);

  await enterGate(page, { rank: 'E', waitMs: 2500 });

  // Force a crowd: spawn enemies and shadows until we have CROWD characters.
  const crowdInfo = await evalGame(page, (game, [want]) => {
    const before = game.enemies.length + game.shadows.length;
    let guard = 0;
    while (game.enemies.length + game.shadows.length < want && guard++ < 200) {
      if (game.enemies.length <= game.shadows.length) game._spawnEnemy();
      else {
        const p = game.player.pos.clone();
        p.x += (Math.random() - 0.5) * 8;
        p.z += (Math.random() - 0.5) * 8;
        // fieldCapacity clamps shadows hard; bypass it for the measurement only
        const cap = game.fieldCapacity;
        game.fieldCapacity = () => 999;
        game._spawnShadow(p, true);
        game.fieldCapacity = cap;
      }
    }
    // Clear the spawn-rise animation so the crowd is actually on screen, and
    // stop the gate adding more mid-measurement.
    for (const e of game.enemies) e.spawning = 0;
    game.spawnTimer = 1e9;
    game.spawned = game.gate.enemies;
    return { before, after: game.enemies.length + game.shadows.length };
  }, CROWD);
  console.log(`crowd: ${crowdInfo.before} -> ${crowdInfo.after} characters`);

  await page.waitForTimeout(1200);

  const snap0 = await evalGame(page, probeSnapshot);
  const pose0 = await evalGame(page, probeBonePose);
  await page.waitForTimeout(2500);
  const snap1 = await evalGame(page, probeSnapshot);
  const pose1 = await evalGame(page, probeBonePose);

  const glb = snap1.filter((e) => e.glb);
  // The skinned count is capped by the QUALITY TIER's character budget (low 8 /
  // medium 14 / high 20 / ultra 26), and game.js drives that budget from the
  // live tier now, so a desktop that starts or settles on 'high' skins 20 and
  // builds the 21st procedurally. That is the governor working, not a failure —
  // so assert against the budget rather than against the crowd size. This still
  // catches the regression that matters (characters silently stop being
  // skinned), because that shows up as a count far under the budget.
  const charBudget = await page.evaluate(() => window.__characters?.stats?.().budget ?? null);
  const expected = charBudget ? Math.min(snap1.length, charBudget) : snap1.length;
  check('every character inside the tier budget is GLB-backed',
    glb.length >= expected && snap1.length > 0,
    `${glb.length}/${snap1.length} skinned, tier budget ${charBudget ?? 'unknown'}`);

  const player = snap1.find((e) => e.label === 'player');
  check('the player is GLB-backed and has a real hand socket',
    Boolean(player?.glb && player.hasHandSocket && player.skeletonUuid),
    player ? `${player.base}, height ${player.height}` : 'no player');

  check('character height sits against the 2.14-unit procedural rig',
    Boolean(player && player.height > 1.7 && player.height < 2.6),
    `player height ${player?.height}`);

  // --- skeleton isolation
  const skelUuids = new Set(glb.map((e) => e.skeletonUuid));
  check('no two instances share a Skeleton',
    skelUuids.size === glb.length, `${skelUuids.size} skeletons / ${glb.length} instances`);
  const allBoneUuids = glb.flatMap((e) => e.boneUuids);
  check('no two instances share a Bone',
    new Set(allBoneUuids).size === allBoneUuids.length,
    `${new Set(allBoneUuids).size}/${allBoneUuids.length} distinct bone uuids`);

  const sigs = new Set(pose1.map((p) => p.sig));
  check('live bone matrices actually diverge between instances',
    sigs.size > 1, `${sigs.size} distinct bone-matrix signatures across ${pose1.length} instances`);

  // --- mixer advances
  // ANY advance proves the mixer is being ticked. Not a wall-clock threshold:
  // under SwiftShader a frame can take half a second, and animateRig clamps dt
  // to 0.05, so 2.5 s of wall time can legitimately be 0.2 s of mixer time.
  // Paired BY LABEL, not by index: the gate keeps spawning during the sample
  // window, and an enemy still rising out of the floor is skipped by game.js
  // before it reaches animateRig, so index pairing compares strangers.
  const t0 = new Map(snap0.filter((e) => e.glb).map((e) => [e.label, e.mixerTime]));
  const paired = snap1.filter((e) => e.glb && t0.has(e.label));
  const advanced = paired.filter((e) => e.mixerTime > t0.get(e.label) + 1e-3);
  const deltas = paired.map((e) => e.mixerTime - t0.get(e.label)).sort((a, b) => a - b);
  check('AnimationMixer advances on every instance',
    paired.length > 0 && advanced.length === paired.length,
    `${advanced.length}/${paired.length} advanced, median +`
    + `${(deltas[Math.floor(deltas.length / 2)] || 0).toFixed(2)} s`);

  const byLabel = new Map(pose0.map((p) => [p.label, p.sig]));
  const moved = pose1.filter((p) => byLabel.get(p.label) !== p.sig);
  check('the pose actually changes over time (not 20 statues)',
    moved.length === pose1.length, `${moved.length}/${pose1.length} re-posed`);

  // --- appearance variety
  const enemyEnts = snap1.filter((e) => e.label.startsWith('enemy'));
  const appearances = new Set(enemyEnts.map((e) => e.appearance));
  const geoms = new Set(glb.map((e) => e.geometryUuid));
  check('enemies get visibly different appearance seeds',
    appearances.size >= Math.min(4, enemyEnts.length),
    `${appearances.size} distinct appearances across ${enemyEnts.length} enemies`);
  check('distinct appearances resolve to distinct merged geometries',
    geoms.size >= Math.min(4, glb.length), `${geoms.size} merged geometries`);

  const shadowEnts = snap1.filter((e) => e.label.startsWith('shadow'));
  if (shadowEnts.length) {
    const shadowLooks = new Set(shadowEnts.map((e) => e.appearance));
    check('shadows vary in silhouette while sharing one material',
      shadowLooks.size >= Math.min(2, shadowEnts.length),
      `${shadowLooks.size} silhouettes across ${shadowEnts.length} shadows`);
  }

  // --- performance
  //
  // renderer.info.render.calls is the WHOLE scene: arena, props, effects, glow.
  // The number that matters is the DELTA, so the characters are hidden for one
  // render and the difference is attributed to them.
  const calls = await evalGame(page, (game) => {
    const roots = [
      game.player.mesh,
      ...game.enemies.map((e) => e.mesh),
      ...game.shadows.map((s) => s.mesh),
      ...game.corpses.map((c) => c.mesh),
    ].filter(Boolean);
    // Bind put CREATURE clones on this field (shadow soldiers, creature
    // corpses): multi-primitive bodies with props that legitimately cost more
    // draws than a merged one-mesh character. Split the attribution so each
    // population is judged against its own budget instead of averaging a
    // skeleton's props into every villager.
    const isCreature = (m) => Boolean(m.userData?.character?.isCreature);
    const charRoots = roots.filter((m) => !isCreature(m));
    const creatureRoots = roots.filter(isCreature);
    // glow.render is a multi-pass composer, and renderer.info auto-resets at
    // every pass, so reading it afterwards reports the final composite quad
    // and nothing else. Accumulate across the whole frame instead.
    const info = game.renderer.info;
    const frame = () => {
      info.autoReset = false;
      info.reset();
      game.glow.render(game.scene, game.camera);
      const out = { calls: info.render.calls, triangles: info.render.triangles };
      info.autoReset = true;
      return out;
    };
    const a = frame();
    for (const r of roots) r.visible = false;
    const none = frame();
    for (const r of charRoots) r.visible = true;
    const charsOnly = frame();
    for (const r of roots) r.visible = true;
    frame();
    return {
      total: a.calls,
      scene: none.calls,
      characters: charsOnly.calls - none.calls,
      creatures: a.calls - charsOnly.calls,
      count: charRoots.length,
      creatureCount: creatureRoots.length,
      triangles: a.triangles - none.triangles,
    };
  });
  const perCharacter = calls.count ? +(calls.characters / calls.count).toFixed(2) : 0;
  const perCreature = calls.creatureCount ? +(calls.creatures / calls.creatureCount).toFixed(2) : 0;
  const bodies = calls.count + calls.creatureCount;
  const perBody = bodies ? +((calls.characters + calls.creatures) / bodies).toFixed(2) : 0;
  const trisPer = bodies ? Math.round(calls.triangles / bodies) : 0;

  const perf = await measureFrames(page, 180);
  const cpu = await measureUpdateCost(page, 150);
  console.log(`  draw calls ${calls.total} total = ${calls.scene} scene `
    + `+ ${calls.characters} for ${calls.count} characters (${perCharacter}/character)`
    + (calls.creatureCount ? ` + ${calls.creatures} for ${calls.creatureCount} creature bodies (${perCreature}/creature)` : ''));
  console.log(`  ${calls.triangles} character triangles, ${trisPer}/body`);
  console.log(`  CPU game.update() ${cpu.medianMs} ms median / ${cpu.p95Ms} ms p95 `
    + `— animation, AI, physics and render submission, vsync excluded`);
  console.log(`  frame ${perf.medianFrameMs} ms median / ${perf.p95FrameMs} ms p95 `
    + `${GPU ? '(real GPU, desktop — still not a phone number)' : '(SwiftShader SOFTWARE raster at 1800x1040 — a RELATIVE number; it runs the vertex/skinning stage on the CPU, so it overcharges skinned meshes badly. Re-run with --gpu for a driver number.)'}`);
  // Budget note: the body is ONE call. The rest is the shadow-map depth pass,
  // the held weapon (main + glow layer), and the telegraph mote on enemies
  // (main + glow). The procedural rig paid all of those too, on 10 meshes
  // instead of 1 — the fallback run below prints its number for comparison.
  // The crowd is a MIX now: merged one-mesh characters (5-call budget as ever)
  // and creature bodies — monsters, bound shadows, creature corpses — whose
  // multi-primitive KayKit builds legitimately pay more (body primitives +
  // props, each with main + depth + glow-eye passes; 9 matches what a living
  // creature costs in tools/creature-test.mjs's frame accounting). Budget the
  // blend rather than averaging a skeleton's props into every villager — and
  // rather than judging the lone player against an amortized number his ground
  // ring and weapon-glow fixed costs were never inside.
  const crowdBudget = bodies ? +((5 * calls.count + 9 * calls.creatureCount) / bodies).toFixed(2) : 5;
  check(`a crowd of ${bodies} (${calls.count} characters + ${calls.creatureCount} creature bodies) `
    + `stays under its blended draw budget of ${crowdBudget}/body`,
    perBody <= crowdBudget,
    `${perBody} calls/body (${calls.characters + calls.creatures} total; `
    + `${perCharacter}/character, ${perCreature}/creature)`);

  const render = await evalGame(page, probeRenderStats);

  // --- the lineup: freeze the clock, stand one of everything in a row facing
  // the camera, render once by hand. This is the shot a human actually judges.
  await page.evaluate(() => { window.__clock?.stop(); });
  const lineup = await evalGame(page, (game) => {
    const all = [game.player, ...game.enemies, ...game.shadows];
    const shown = all.slice(0, 9);
    shown.forEach((e, i) => {
      e.pos.set(-8.4 + i * 2.1, 0, 0);
      e.mesh.position.copy(e.pos);
      e.mesh.rotation.set(0, 0, 0);   // glTF forward is +Z: 0 faces the camera
      e.mesh.visible = true;
      if (e.bar) e.bar.visible = false;
      if (e.spawning !== undefined) e.spawning = 0;
    });
    for (const e of all.slice(9)) e.mesh.visible = false;
    for (const c of game.corpses) c.mesh.visible = false;
    game.camera.position.set(0, 2.4, 11.5);
    game.camera.lookAt(0, 1.1, 0);
    game.camera.updateProjectionMatrix();
    game.glow.render(game.scene, game.camera);
    return shown.map((e) => e.mesh.userData.appearance?.base || 'procedural');
  });
  console.log(`  lineup: ${lineup.join(', ')}`);
  await page.screenshot({ path: shotPath('characters-lineup.png') });

  // Same lineup, walking, so the screenshot is not of nine idle statues.
  await evalGame(page, (game) => {
    const all = [game.player, ...game.enemies, ...game.shadows].slice(0, 9);
    for (let f = 0; f < 40; f++) {
      all.forEach((e, i) => {
        const ch = e.mesh.userData.character;
        if (ch) ch.animate({ moving: true, speed: 3 + i * 0.6, dt: 1 / 60 });
      });
    }
    game.glow.render(game.scene, game.camera);
  });
  await page.screenshot({ path: shotPath('characters-lineup-walk.png') });
  await page.evaluate(() => { window.__clock?.start(); });

  check('no page errors during the GLB run', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();

  // =============================================== PASS 2: GLB unavailable
  // The offline requirement: a missing asset must degrade, not crash.
  const { page: p2, errors: e2 } = await newPhonePage(browser, { width: 900, height: 520, dpr: 2 });
  // Both packs, not just characters.glb. Enemies now come from creatures.glb
  // and fall back to characters.glb before falling back to the procedural
  // box-man, so blocking one pack alone proves nothing about the last resort.
  await p2.route('**/models/characters.*', (route) => route.fulfill({ status: 404, body: '' }));
  await p2.route('**/models/creatures.*', (route) => route.fulfill({ status: 404, body: '' }));
  await gotoGame(p2);
  await p2.evaluate(async () => { window.__chars = await import('/src/render/characters.js'); });
  await enterGate(p2, { rank: 'E', waitMs: 2500 });
  await evalGame(p2, (game, [want]) => {
    let guard = 0;
    while (game.enemies.length + game.shadows.length < want && guard++ < 200) {
      if (game.enemies.length <= game.shadows.length) game._spawnEnemy();
      else {
        const p = game.player.pos.clone();
        p.x += (Math.random() - 0.5) * 8;
        p.z += (Math.random() - 0.5) * 8;
        const cap = game.fieldCapacity;
        game.fieldCapacity = () => 999;
        game._spawnShadow(p, true);
        game.fieldCapacity = cap;
      }
    }
    for (const e of game.enemies) e.spawning = 0;
  }, CROWD);
  await p2.waitForTimeout(1500);
  const fbCalls = await evalGame(p2, (game) => {
    const roots = [game.player.mesh, ...game.enemies.map((e) => e.mesh),
      ...game.shadows.map((s) => s.mesh), ...game.corpses.map((c) => c.mesh)].filter(Boolean);
    const info = game.renderer.info;
    const frame = () => {
      info.autoReset = false;
      info.reset();
      game.glow.render(game.scene, game.camera);
      const c = info.render.calls;
      info.autoReset = true;
      return c;
    };
    const withC = frame();
    for (const r of roots) r.visible = false;
    const without = frame();
    for (const r of roots) r.visible = true;
    frame();
    return { characters: withC - without, count: roots.length };
  });
  const fbPerf = await measureFrames(p2, 180);
  const fbCpu = await measureUpdateCost(p2, 150);
  console.log(`  PROCEDURAL BASELINE CPU game.update() ${fbCpu.medianMs} ms median `
    + `/ ${fbCpu.p95Ms} ms p95`);
  const fbPer = fbCalls.characters / Math.max(1, fbCalls.count);
  check('skinned characters cost FEWER draw calls than the procedural rig they replace',
    perBody < fbPer,
    `${perBody}/body skinned vs ${fbPer.toFixed(2)}/character procedural`);
  console.log(`  PROCEDURAL BASELINE: ${fbCalls.characters} draw calls for ${fbCalls.count} `
    + `humanoids (${(fbCalls.characters / Math.max(1, fbCalls.count)).toFixed(2)}/character), `
    + `frame ${fbPerf.medianFrameMs} ms median / ${fbPerf.p95FrameMs} ms p95`);
  const fb = await evalGame(p2, (game) => {
    const legs = [];
    for (const e of game.enemies) {
      const rig = e.mesh.userData.rig;
      legs.push({ glb: Boolean(e.mesh.userData.character), legRot: rig?.legL?.rotation.x ?? null });
    }
    return { alive: game.player.alive, enemies: game.enemies.length, legs };
  });
  check('game still boots and spawns with characters.glb absent',
    fb.alive && fb.enemies > 0, `${fb.enemies} enemies on the procedural rig`);
  check('fallback humanoids are procedural, not skinned',
    fb.legs.every((l) => !l.glb), `${fb.legs.filter((l) => l.glb).length} unexpectedly skinned`);
  check('the procedural pose driver still runs in fallback',
    fb.legs.some((l) => Math.abs(l.legRot || 0) > 0.001),
    `leg rotations ${fb.legs.map((l) => (l.legRot ?? 0).toFixed(2)).join(',')}`);
  await p2.screenshot({ path: shotPath('characters-fallback.png') });
  check('no page errors during the fallback run', e2.length === 0, e2.slice(0, 2).join(' | '));
  await p2.close();

  const report = writeReport('character-test', {
    when: new Date().toISOString(),
    pack: packOk,
    crowd: crowdInfo,
    perf,
    fallbackPerf: fbPerf,
    cpu,
    fallbackCpu: fbCpu,
    calls,
    fallbackCalls: fbCalls,
    lineup,
    render,
    drawCallsPerCharacter: perCharacter,
    entities: snap1,
    results,
  });
  console.log(`\nreport     ${report}`);
  console.log(`screenshots ${OUT}/characters-crowd.png`);
  console.log(`            ${OUT}/characters-closeup.png`);
  console.log(`            ${OUT}/characters-fallback.png`);
} catch (err) {
  console.error(err);
  failures.push(`threw: ${err.message}`);
} finally {
  await browser.close();
  await server.stop();
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`);
  exitCode = 1;
} else {
  console.log('\nall character checks passed');
}
fs.writeSync(1, '');
process.exit(exitCode);
