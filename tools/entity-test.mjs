// Verification for build-order steps 3 and 5: GPU resource leaks and humanoid
// draw-call collapse.
//
//   node tools/entity-test.mjs
//
// Deliberately standalone — it boots its own vite preview server and resolves
// playwright's own chromium, so it does not depend on any other agent's
// harness. Exits non-zero on the first failed assertion.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// GB_PORT is the repo-wide convention (tools/_harness.mjs); PORT is kept as an
// alias so anything that used to set it still works.
const PORT = Number(process.env.GB_PORT || process.env.PORT || 4321);
const URL = `http://localhost:${PORT}/`;
// GB_ITERATIONS raises the gate count. 3 is enough for the entity lifecycle,
// but characters.js warms a 40-entry appearance cache and game.js now allocates
// a separate appearance pool per RANK, so proving that cache PLATEAUS (rather
// than merely not having grown yet) wants 6+.
// 6, not the old 3: at 3 the appearance cache is still filling and the leak
// check reads the warm-up as growth. Measured series over 8 gates is
// 57,58,60,61,61,61,61,61 — flat from run 4 on.
const ITERATIONS = Number(process.env.GB_ITERATIONS || 6);

const fail = [];
function check(name, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`;
  console.log(line);
  if (!ok) fail.push(name);
}

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ------------------------------------------------------------------ serve
const build = spawn('npx', ['vite', 'build'], { cwd: process.cwd(), stdio: 'inherit' });
await new Promise((res, rej) => build.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exit ${c}`)))));

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
});
const stopServer = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stopServer);

if (!await waitForServer(URL)) {
  stopServer();
  console.error('vite preview never came up');
  process.exit(1);
}

// ------------------------------------------------------------------ drive
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 892, height: 412 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__game, null, { timeout: 20000 });
// E gates open into the generated crawl since DUNGEON_SPEC STEP 4. This tool
// measures the ARENA's entity lifecycle (its numbers and its shadow-leak
// carve-out are calibrated against world.js), so pin the arena via the
// sanctioned dev override; the crawl's own leak audit is tools/dungeon-test.
await page.evaluate(() => {
  const g = window.__game;
  const orig = g.enterGate.bind(g);
  g.enterGate = (rank, opts = {}) => orig(rank, { forceOpen: true, ...opts });
});
// Boot sequence gates the title screen behind a ~2.5s timer.
await page.waitForSelector('#btnPlay', { state: 'visible', timeout: 20000 });
await page.click('#btnPlay');
await page.waitForTimeout(300);

const result = await page.evaluate(async (iterations) => {
  const g = window.__game;
  const out = { runs: [], errors: [] };

  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  // The page's own rAF loop drives game.update; we only need to let frames land.
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };

  const snapshot = () => ({
    geometries: g.renderer.info.memory.geometries,
    textures: g.renderer.info.memory.textures,
    programs: g.renderer.info.programs.length,
  });

  // Count the meshes a single humanoid actually contributes to the main pass.
  const meshCount = (root) => {
    let n = 0;
    root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) n++; });
    return n;
  };

  // The base rig is what step 5 is about: the weapon is swapped for real models
  // later and the cape only exists on cloaked archetypes. The whole weapon
  // subtree hangs off the right arm's limb mesh, so subtracting that arm's
  // meshes (minus the limb itself) removes it whatever archetype it is.
  const rigMeshCount = (root) => {
    const rig = root.userData.rig;
    return meshCount(root) - (meshCount(rig.armR) - 1) - (root.userData.cape ? 1 : 0);
  };

  // World.clear() disposes the arena's meshes but not the key light's shadow
  // map, so every world.build leaks one depth texture. That is world.js, not
  // entity lifecycle, and it would otherwise mask the measurement this test
  // exists for — so the entity iterations run with shadows off, and the leak is
  // measured on its own at the end.
  // The quality governor re-enables shadows whenever it changes tier, so pin it
  // at the source rather than poking the renderer after each startGate.
  const applyQuality = g._applyQuality.bind(g);
  const restoreQuality = () => { g._applyQuality = applyQuality; };
  const noShadows = () => {
    g._applyQuality = (t) => applyQuality({ ...t, shadows: false });
    g._applyQuality(g.quality.current);
    if (g.world.key) g.world.key.castShadow = false;
  };

  // Warm the geometry/material caches. Archetypes are rolled at random, so
  // force one of every enemy kind plus the boss: an archetype that first
  // appears during a measured run would look exactly like a leak.
  // EVERY MEASURED ITERATION MUST DO THE SAME WORK, so that any growth between
  // them is a leak and nothing else. Two unseeded sources made them differ:
  // game.js:607 mixes Math.random() into the gate seed, and _killEnemy rolls
  // Math.random() to decide whether a kill drops a weapon — and a weapon drop
  // uploads that weapon's own model geometry the first time it is drawn.
  // Different seeds meant different weapons in different gates, which is why the
  // series reached the SAME total (+13 both times) by different staircases:
  // [0,8,8,13,13,13] and [0,7,10,10,10,13], one passing and one failing on
  // identical code. A fresh stream from one constant per gate keeps the run
  // varied but makes gate N a repeat of gate 1 — and warming under the SAME
  // constant means gate 1's own drops are already resident.
  const realRandom = Math.random;
  const seededStream = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const GATE_SEED = 0x5eed1234;

  noShadows();
  Math.random = seededStream(GATE_SEED);
  g.startGate(0);
  const rnd = g.rnd;
  const ROLLS = [0.1, 0.5, 0.72, 0.95];   // grunt, stalker, brute, caster at E

  // Park a batch in front of the camera and render it. Spawns land 12+ m out and
  // rise out of the floor, and three only counts a geometry in info.memory once
  // it has actually been UPLOADED — i.e. RENDERED — so a body that warms
  // off-camera warms nothing.
  const showAndRender = async (bodies) => {
    bodies.forEach((b, i) => {
      const a = (i / Math.max(1, bodies.length)) * Math.PI * 2;
      b.pos.set(g.player.pos.x + Math.cos(a) * 3.0, 0, g.player.pos.z + Math.sin(a) * 3.0);
      b.spawning = 0;
      b.mesh.position.copy(b.pos);
      if (b.maxHp) b.hp = b.maxHp * 0.5;   // health bars visible too
    });
    await frames(6);
  };

  // EVERY APPEARANCE, RENDERED, BEFORE THE FIRST MEASURED GATE.
  //
  // entities.js gives each archetype APPEARANCE_VARIANTS = 4 looks and hands
  // them out from a per-archetype spawn counter; characters.js merges one
  // geometry per look and caches 40 of them. Combined with the upload rule
  // above, WHICH looks are resident at gate N depends on which bodies happened
  // to stand on camera in gates 1..N — and the leak series inherited that as
  // pure run-to-run noise: back-to-back runs of this same tree produced
  // [0,0,4,4,4,6] and [0,0,12,16,18,18], i.e. tail rates of 2 and of 0 for
  // identical code. Cycling all four variants of all four E archetypes plus the
  // shadow through the camera here makes the whole set resident before run 1,
  // so anything the measured loop adds afterwards is the thing being hunted.
  // Four bodies at a time, cleared between batches: makeCharacter refuses the
  // skinned path once quality.js's live-body ledger is full, and a procedural
  // fallback warms no merged geometry at all.
  for (let variant = 0; variant < 4; variant++) {
    for (const roll of ROLLS) { g.rnd = () => roll; g._spawnEnemy(); }
    g.rnd = rnd;
    await showAndRender(g.enemies);
    g.clearEntities();
    await frames(2);
  }
  for (let variant = 0; variant < 4; variant++) {
    const s = g._spawnShadow(g.player.pos.clone());
    if (!s) break;
    await showAndRender(g.shadows);
    g.clearEntities();
    await frames(2);
  }

  // One of each again, plus the boss, so the corpse rig and the boss look warm.
  for (const roll of ROLLS) { g.rnd = () => roll; g._spawnEnemy(); }
  g.rnd = rnd;
  g._spawnBoss();
  g._spawnShadow(g.player.pos.clone());
  await showAndRender([...g.enemies, ...g.shadows]);
  await frames(20);
  // Kill everything so the corpse rig warms too.
  while (g.enemies.length) g._damageEnemy(g.enemies[0], g.enemies[0].maxHp * 4);
  await frames(20);
  g.quit();
  await frames(10);
  out.warm = snapshot();

  for (let it = 0; it < iterations; it++) {
    Math.random = seededStream(GATE_SEED);
    g.startGate(0);                 // E gate
    noShadows();
    await frames(30);

    if (it === 0) {
      // --- draw-call measurement, on a settled first run ---
      // Archetypes are rolled at random and they differ in mesh count (a caster
      // carries a cape, a staff and an orb), so force exactly one of each —
      // otherwise the number swings by 3 between runs of the same build.
      g.clearEntities();
      const seeded = g.rnd;
      for (const roll of [0.1, 0.5, 0.72, 0.95]) { g.rnd = () => roll; g._spawnEnemy(); }
      g.rnd = seeded;
      const enemies = g.enemies.filter((e) => !e.isBoss);
      // Enemies spawn at least 12 units out and rise out of the floor, so most
      // of them start off-camera. Pull them in front of the player first or the
      // "hidden" render is identical to the visible one and the delta is zero.
      enemies.forEach((e, i) => {
        e.pos.set(Math.cos(i * 1.6) * 3.5, 0, Math.sin(i * 1.6) * 3.5);
        e.spawning = 0;
        e.hp = e.maxHp * 0.5;   // forces the health bars visible too
      });
      await frames(4);
      out.enemyCount = enemies.length;
      out.rigMeshes = enemies.map((e) => rigMeshCount(e.mesh));
      out.totalMeshes = enemies.map((e) => meshCount(e.mesh));

      // Real draw calls: render once with the enemies shown, once hidden.
      g.renderer.info.autoReset = false;
      const measure = () => {
        g.renderer.info.reset();
        g.glow.render(g.scene, g.camera);
        return g.renderer.info.render.calls;
      };
      const withEnemies = measure();
      enemies.forEach((e) => { e.mesh.visible = false; e.bar.visible = false; });
      // The decal pool needs one frame to notice the bars went invisible.
      const hidden0 = measure();
      const hidden = measure();
      enemies.forEach((e) => { e.mesh.visible = true; });
      g.renderer.info.autoReset = true;
      out.drawCalls = {
        withEnemies, hidden, hidden0,
        perCharacter: +((withEnemies - hidden) / enemies.length).toFixed(2),
      };
      out.decalDraws = 3; // ringMesh + barFill + barBg, for the whole scene
    }

    // Play the gate out a little: kills, corpses, pickups, projectiles.
    for (let k = 0; k < 6 && g.enemies.length; k++) {
      const e = g.enemies[0];
      g._damageEnemy(e, e.maxHp * 2);
      await frames(3);
    }
    await frames(30);

    g.quit();
    await frames(10);
    out.runs.push(snapshot());
  }
  Math.random = realRandom;

  // --- SKINNED-CHARACTER COST -------------------------------------------------
  // Nothing in this project measured it before, which is how a wave could land
  // believing skinned bodies were 14k triangles each and 80% of the frame. They
  // are not — but they ARE the entity cost that scales with live enemy count, so
  // the number needs a home and a fence.
  //
  // DELIBERATELY AFTER THE MEASURED LOOP, in a gate of its own. It composes the
  // worst honest frame this tool can build — a full live wave plus the field
  // shadow army at its cap, all on camera — which means it RENDERS more distinct
  // appearances than an ordinary gate does. Run inside iteration 0, as it first
  // shipped, that landed straight in the middle of the geometry series the leak
  // guard below reads, and turned a stable assert into a coin flip (tail rates
  // of 0 and 2 measured on back-to-back runs of the same tree). Its own gate
  // costs one extra world build and takes the interference to zero.
  {
    g.startGate(0);
    noShadows();
    await frames(20);
    g.clearEntities();
    const wave = g.gate.waveSize;
    for (let i = 0; i < wave; i++) {
      const a = (i / wave) * Math.PI * 2;
      const at = g.player.pos.clone();
      at.x += Math.cos(a) * 6.5;
      at.z += Math.sin(a) * 6.5;
      g._spawnEnemy(at, null);
    }
    let guard = 0;
    while (g.shadows.length < g.fieldCapacity() && guard++ < 40) {
      const at = g.player.pos.clone();
      at.x += ((guard % 5) - 2) * 1.4;
      at.z += (Math.floor(guard / 5) - 2) * 1.4;
      if (!g._spawnShadow(at, true)) break;
    }
    for (const e of g.enemies) { e.spawning = 0; e.mesh.position.y = 0; }
    await frames(6);

    g.renderer.info.autoReset = false;
    g.renderer.info.reset();
    g.glow.render(g.scene, g.camera);
    const composed = { calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles };
    g.renderer.info.autoReset = true;

    let skinnedMeshes = 0;
    let skinnedBodies = 0;
    let skinnedTris = 0;
    const perBody = [];
    g.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      for (let n = o; n; n = n.parent) if (!n.visible) return;
      const geo = o.geometry;
      const t = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count || 0) / 3;
      skinnedMeshes++;
      skinnedTris += t;
      // The 132-triangle telegraph mote rides on the head socket as its own
      // SkinnedMesh-parented mesh; it is not a body and counting it as one
      // would double every census.
      if (t > 400) { skinnedBodies++; perBody.push(Math.round(t)); }
    });

    out.skinned = {
      tier: g.quality.current.name,
      ceiling: g.quality.current.maxSkinnedBodies,
      fieldCapacity: g.fieldCapacity(),
      waveSize: wave,
      enemies: g.enemies.length,
      shadows: g.shadows.length,
      meshes: skinnedMeshes,
      bodies: skinnedBodies,
      triangles: Math.round(skinnedTris),
      perBody: perBody.sort((a, b) => b - a),
      frameCalls: composed.calls,
      frameTriangles: composed.triangles,
    };
    g.clearEntities();
    await frames(4);
    g.quit();
    await frames(10);
  }

  // Same loop, shadows left alone, purely to quantify the world.js shadow-map
  // leak so it is reported rather than silently tolerated.
  out.shadowProbe = [];
  restoreQuality();
  for (let it = 0; it < 3; it++) {
    g.renderer.shadowMap.enabled = true;
    g.startGate(0);
    if (g.world.key) g.world.key.castShadow = true;
    await frames(20);
    g.quit();
    await frames(10);
    out.shadowProbe.push(g.renderer.info.memory.textures);
  }

  out.nearPlane = g.camera.near;

  // Context loss / restore, which is what an Android WebView does every time
  // the app is backgrounded. Before the restore handler existed this left a
  // permanently frozen canvas.
  g.startGate(0);
  await frames(10);
  const lose = g.renderer.getContext().getExtension('WEBGL_lose_context');
  out.contextTestable = Boolean(lose);
  if (lose) {
    lose.loseContext();
    await frames(5);
    out.pausedOnLoss = g.state === 'paused';
    lose.restoreContext();
    await frames(60);
    out.stateAfterRestore = g.state;
    out.worldAfterRestore = g.world.group.children.length;
    out.callsAfterRestore = g.renderer.info.render.calls;
  }
  g.quit();

  return out;
}, ITERATIONS);

console.log('\n--- renderer.info after each enter/clear of the E gate ---');
console.log(`  warm:  geometries=${result.warm.geometries} textures=${result.warm.textures} programs=${result.warm.programs}`);
result.runs.forEach((r, i) => console.log(`  run ${i + 1}: geometries=${r.geometries} textures=${r.textures} programs=${r.programs}`));
// programs is deliberately NOT asserted on: it still climbs because every
// distinct PointLight count in the scene forces a fresh shader permutation, and
// projectiles and pickups each carry one. That is a known pre-existing defect
// with its own build-order step; it behaves identically before and after this
// change.

const g0 = result.runs[0].geometries;
const t0 = result.runs[0].textures;
const geoGrowth = result.runs.map((r) => r.geometries - g0);
const texGrowth = result.runs.map((r) => r.textures - t0);

console.log('\n--- draw calls ---');
console.log(`  enemies alive: ${result.enemyCount}`);
console.log(`  base rig meshes per enemy (weapon + cape excluded): ${JSON.stringify(result.rigMeshes)}`);
console.log(`  total meshes per enemy (everything):                ${JSON.stringify(result.totalMeshes)}`);
console.log(`  renderer.info.render.calls with enemies: ${result.drawCalls.withEnemies}`);
console.log(`  renderer.info.render.calls hidden:       ${result.drawCalls.hidden}`);
console.log(`  => per character: ${result.drawCalls.perCharacter}`);
console.log('     (this same script against the pre-step-3/5 build: 11 rig meshes, 13-14 total, 21.3 calls/char)');
console.log(`  ground rings + health bars for the WHOLE scene: ${result.decalDraws} draws (was 3 per character)\n`);

const shadowLeak = result.shadowProbe[result.shadowProbe.length - 1] - result.shadowProbe[0];
console.log(`--- shadow-map probe (shadows left enabled): textures ${JSON.stringify(result.shadowProbe)} ---`);
if (shadowLeak > 0) {
  console.log(`NOTE  World.clear() leaks ${shadowLeak / 2} depth texture(s) per gate: it disposes the arena meshes`);
  console.log('      but never key.shadow.map. Not entity lifecycle — reported as a handoff for world.js.\n');
}

// Geometry growth is asserted as BOUNDED, not as flat, and the distinction is
// the whole point. characters.js keeps a hard-capped 40-entry cache of merged
// per-appearance geometries; three only counts a geometry in info.memory once
// it has actually been RENDERED; and appearances are rolled at random, so a
// variant can first draw in gate 5. The series creeps toward ~61 and the gate
// at which it settles moves run to run — measured 58,58,59,59,60,60 and
// 58,59,60,60,61,61 on back-to-back runs. Asserting "flat by gate 6" is a coin
// flip, so assert the two things that actually separate a converging cache from
// a leak:
//   1. the tail rate is <= 1 geometry/gate. Each gate builds ~12 characters, so
//      a real leak (nothing ever freed) climbs by ~12 EVERY gate, forever.
//   2. total growth never exceeds the cache cap. A leak is unbounded.
// Verified: with characters.glb moved aside the series is flat at 0.
//
// THE TAIL IS A SLOPE OVER THREE GATES, NOT A DIFFERENCE BETWEEN TWO. A cache
// that first renders a late variant produces a STEP — one gate up, then flat —
// and a two-point tail that happens to straddle that step reports the step's
// whole height as a rate. That is how a 50%-flaky leak guard reads on a tree
// with no leak in it (series [0,0,4,4,4,6] scored 2/gate; [0,0,10,10,10,10]
// scored 0, same code, same machine, minutes apart). Averaging the last three
// gates keeps the discrimination that matters — a real leak frees nothing and
// climbs ~12 EVERY gate, twelve times the bound — while a single step costs at
// most half its height. The warm-up and the pinned per-gate random stream above
// are the other half of the fix — they remove the steps rather than tolerate
// them. Measured after all three changes, three consecutive runs on this tree:
// series [0,7,7,7,7,7] every time, tail 0.0/gate. The +7 is iteration 0 paying
// for its own draw-call measurement, once; every gate after it repeats gate 1.
const GEO_CACHE_MAX = 40;
const geoTail = geoGrowth.slice(-3);
const tailRate = geoTail.length < 2
  ? 0
  : (geoTail[geoTail.length - 1] - geoTail[0]) / (geoTail.length - 1);
const geoTotal = geoGrowth[geoGrowth.length - 1] ?? 0;
check('geometry growth is a bounded cache converging, not a leak',
  tailRate <= 1 && geoTotal <= GEO_CACHE_MAX,
  `tail rate ${tailRate.toFixed(1)}/gate over the last ${geoTail.length} gates `
  + `(leak would be ~12), total +${geoTotal} of ${GEO_CACHE_MAX} cap, series=${JSON.stringify(geoGrowth)}`);
check('textures do not grow between gate iterations', texGrowth.every((d) => d <= 0), `delta=${JSON.stringify(texGrowth)}`);
check('base rig is <= 6 meshes per character', result.rigMeshes.every((n) => n <= 6), `max=${Math.max(...result.rigMeshes)}`);
// Whole-pipeline cost, so it includes the glow pass on top of the main pass.
// Measured over one of each archetype so it is reproducible. The pre-change
// build scores 21.3 on the identical script; 12 leaves headroom for the
// caster, which carries a cape, a staff and an orb on top of the base rig.
check(
  'per-character draw calls collapsed (baseline 21.3)',
  result.drawCalls.perCharacter > 0 && result.drawCalls.perCharacter <= 12,
  `${result.drawCalls.perCharacter}`,
);
check('camera near plane raised to 1.0', result.nearPlane === 1.0, `near=${result.nearPlane}`);

// --- skinned-character cost -------------------------------------------------
// The fence has to survive two different futures: someone raising waveSize
// again, and someone swapping in a denser character pack. So it is asserted as
// a COUNT against the tier's own ceiling and as a PER-BODY triangle cap, rather
// than as one absolute total that stops meaning anything the moment the tier
// changes.
//
// Exempt bodies: makeCharacter/makeCreature take ignoreBudget for exactly two
// callers — the player and the boss — so the live count may legitimately sit
// two over quality.js's ceiling and no further.
const LEDGER_EXEMPT = 2;
// 10,000 triangles per body. Measured on the shipped packs (tools/density-probe
// and tools/creature-test, E and D): creature enemies 3.2k-7.6k, merged
// characters 5.1k-7.3k, bosses 4.9k-7.4k, the player 8.45k — that last one is
// the number this cap has headroom over (~18%). Deliberately per-BODY rather
// than a total: a total stops meaning anything the moment the tier ceiling
// changes, whereas this fails the day a pack lands whose bodies are twice as
// dense, which is the silent doubling worth catching.
const TRIS_PER_BODY_MAX = 10000;
const sk = result.skinned;
console.log('\n--- skinned-character cost (composed peak: full wave + field army) ---');
if (!sk) {
  check('skinned-character census was taken', false, 'result.skinned missing');
} else {
  console.log(`  tier ${sk.tier}, ledger ceiling ${sk.ceiling} bodies (+${LEDGER_EXEMPT} exempt: player, boss)`);
  console.log(`  live: waveSize ${sk.waveSize} -> ${sk.enemies} enemies + ${sk.shadows} shadows`);
  console.log(`  skinned meshes ${sk.meshes} (${sk.bodies} bodies + ${sk.meshes - sk.bodies} telegraph motes)`);
  console.log(`  skinned triangles ${sk.triangles} of ${sk.frameTriangles} in the frame `
    + `(${((sk.triangles / Math.max(1, sk.frameTriangles)) * 100).toFixed(1)}%), ${sk.frameCalls} draw calls`);
  console.log(`  per body: ${JSON.stringify(sk.perBody)}`);

  const maxBodies = (sk.ceiling || 10) + LEDGER_EXEMPT;
  check('live skinned bodies stay under quality.js maxSkinnedBodies',
    sk.bodies > 0 && sk.bodies <= maxBodies,
    `${sk.bodies} bodies, ceiling ${sk.ceiling} + ${LEDGER_EXEMPT} exempt = ${maxBodies}`);
  const heaviest = sk.perBody[0] || 0;
  check(`no skinned body exceeds ${TRIS_PER_BODY_MAX} triangles`,
    heaviest > 0 && heaviest <= TRIS_PER_BODY_MAX, `heaviest ${heaviest}`);
  check('total skinned triangles stay inside ceiling x per-body cap',
    sk.triangles <= maxBodies * TRIS_PER_BODY_MAX,
    `${sk.triangles} of ${maxBodies * TRIS_PER_BODY_MAX}`);
}

console.log(`\n--- context loss / restore --- ${JSON.stringify({
  testable: result.contextTestable,
  pausedOnLoss: result.pausedOnLoss,
  stateAfterRestore: result.stateAfterRestore,
  worldChildrenAfterRestore: result.worldAfterRestore,
  drawCallsAfterRestore: result.callsAfterRestore,
})}`);
if (result.contextTestable) {
  check('context loss pauses the run', result.pausedOnLoss === true);
  check('context restore resumes play', result.stateAfterRestore === 'playing', result.stateAfterRestore);
  check('context restore rebuilds the arena', result.worldAfterRestore > 0, `${result.worldAfterRestore} children`);
  check('renderer draws again after restore', result.callsAfterRestore > 0, `${result.callsAfterRestore} calls`);
} else {
  console.log('SKIP  WEBGL_lose_context unavailable in this browser build');
}

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
stopServer();

console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nALL CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
