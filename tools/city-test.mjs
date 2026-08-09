// tools/city-test.mjs — verify the city hub.
//
//   node tools/city-test.mjs [--walk-seconds 220] [--no-shots] [--headed]
//                            [--swiftshader]
//
// What it asserts, and why each one is here rather than "looks fine to me":
//
//   * DRAW CALLS p95 <= 220 on a scripted walk across the whole city. p95, not
//     mean: the mean hides the one street corner where the budget blows.
//   * renderer.info.programs.length DOES NOT GROW during that walk. This is the
//     PointLight.visible regression from overworld.js:293 — NUM_POINT_LIGHTS is
//     part of three's program cache key, so toggling a light as the player
//     moves recompiles every material in the scene and the frame time falls off
//     a cliff with nothing in the profile to blame.
//   * heightAt() agrees with the RENDERED ground mesh within 0.05 units at 200
//     sampled points, checked by raycasting the actual Mesh — not by calling
//     the height function twice and congratulating it.
//   * No holes: 200 random positions all return a downward ray hit.
//   * All six portals exist, carry the spec's colours, and are reachable —
//     dropped onto from above, the body settles grounded and stays put.
//
// The city is not wired into game.js yet (that is citymode.js's step), so this
// drives src/world/city.js directly inside the booted page. Vite's dev server
// transforms /src/** on request, which is what makes that possible without
// touching main.js.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const WALK_SECONDS = Number(arg('walk-seconds', 220));
const SHOTS = !argv.includes('--no-shots');   // the screenshots are the point
const HEADED = argv.includes('--headed');
// SwiftShader is the harness default because it makes pixels reproducible
// across machines. This tool opts out: a 226k-triangle city through a software
// rasteriser costs ~0.8 s per frame, so a scripted walk would take half an
// hour. Everything asserted here (draw calls, program count, triangle count,
// physics settling) is identical on either backend — only the pixels differ,
// and the pixels are for a human to look at, not for an assert.
const SWIFTSHADER = argv.includes('--swiftshader');

const EXPECT_COLORS = {
  E: 0x8b97c9, D: 0x2ad4c0, C: 0x4ade80, B: 0xa78bfa, A: 0xffc24b, S: 0xff4d6d,
};

const DRAW_P95_LIMIT = 220;
const HEIGHT_TOLERANCE = 0.05;
const SAMPLES = 200;

const fail = [];
const warn = [];
let _t0 = Date.now();
const phase = (name) => {
  const now = Date.now();
  console.log(`  [${((now - _t0) / 1000).toFixed(1)}s] ${name}`);
  _t0 = now;
};
const ok = (cond, msg) => { if (!cond) fail.push(msg); return cond; };

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: SWIFTSHADER });
const { page, errors } = await newPhonePage(browser, { width: 900, height: 560, dpr: 1 });

try {
  await gotoGame(page, { waitMs: 1800 });

  // ---------------------------------------------------------------- build
  const build = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const cityMod = await import('/src/world/city.js');
    const kit = await import('/src/world/citykit.js');
    const { Glow } = await import('/src/render/glow.js');
    const { Quality } = await import('/src/core/quality.js');

    const t0 = performance.now();
    const kitLoaded = await kit.loadCityKit();
    const tKit = performance.now() - t0;

    // Own renderer and canvas so nothing here depends on game.js's state.
    const canvas = document.createElement('canvas');
    canvas.id = 'citytest';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999';
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.6, 500);
    const quality = new Quality({ startTier: 'high' });
    const glow = new Glow(renderer, { scale: 0.25, strength: 1.25 });
    glow.setSize(window.innerWidth, window.innerHeight, 1);

    const t1 = performance.now();
    const city = new cityMod.City(scene, renderer, camera, quality);
    city.build(20260806, { level: 60 });
    const tBuild = performance.now() - t1;

    window.__city = { THREE, renderer, scene, camera, city, glow, cityMod, quality };
    return {
      kitLoaded,
      kitMs: Math.round(tKit),
      buildMs: Math.round(tBuild),
      stats: city.stats,
      kitStats: kit.cityKitStats(),
      portals: city.portals.map((p) => ({
        rank: p.rank,
        color: p.color,
        locked: p.locked,
        wild: Boolean(p.wild),
        meshes: p.group.children.length,
        pos: { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2) },
      })),
      interactables: city.interactables.map((i) => i.id),
      districts: cityMod.DISTRICTS.map((d) => d.id),
      pointLights: (() => { let n = 0; scene.traverse((o) => { if (o.isPointLight) n++; }); return n; })(),
      spawn: (() => { const s = city.spawnPoint(); return { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) }; })(),
    };
  });

  phase('build');
  console.log(`kit loaded: ${build.kitLoaded} (${build.kitMs} ms)   city build: ${build.buildMs} ms`);
  const { fields, ...statHead } = build.stats;
  console.log('stats:', JSON.stringify(statHead));
  console.log('kit  :', JSON.stringify(build.kitStats));
  console.log('triangle budget by piece:');
  for (const f of fields.slice(0, 14)) {
    console.log(`   ${f.key.padEnd(32)} x${String(f.count).padStart(5)}  ${String(f.triangles).padStart(7)} tris`);
  }

  ok(build.kitLoaded, 'citykit.glb failed to load — the city fell back to procedural pieces');
  ok(build.pointLights === 0,
    `found ${build.pointLights} PointLight(s) in the city scene; the shader-recompile rule says zero`);
  // WORLD_SPEC step 7: the Verge appends its wild gates to city.portals (that
  // is what makes portalAt/nearestPortal/compass/prompt work on them without a
  // line of change), so the town's own six are the non-wild ones.
  const townPortals = build.portals.filter((p) => !p.wild);
  ok(townPortals.length === 6, `expected 6 town portals, got ${townPortals.length}`);
  for (const p of build.portals) {
    ok(EXPECT_COLORS[p.rank] === p.color,
      `portal ${p.rank} colour is 0x${p.color.toString(16)}, spec says 0x${EXPECT_COLORS[p.rank]?.toString(16)}`);
    ok(p.meshes === 4, `portal ${p.rank} has ${p.meshes} meshes, spec says 4`);
  }
  const s = build.portals.find((p) => p.rank === 'S');
  ok(s && s.pos.z < -110, `the S portal must sit outside the north wall; z = ${s?.pos.z}`);
  for (const id of ['barracks', 'assay', 'trial', 'exchange', 'stash']) {
    ok(build.interactables.includes(id), `missing interactable "${id}"`);
  }

  // ------------------------------------------------- WORLD_SPEC step 8 layout
  //
  // The builder enforces layoutrules.js while it places; this asserts the SAME
  // table off city.layoutMeta afterwards. Three extra seeds, because a layout
  // rule that only holds for the shipped seed is not a rule — it is a
  // coincidence, and the whole point of build(seed) is that other seeds exist.
  const layout = await page.evaluate(async () => {
    const { THREE, city, quality } = window.__city;
    const cityMod = await import('/src/world/city.js');
    const rules = await import('/src/world/layoutrules.js');
    const run = (c) => {
      const v = rules.validateLayout(c);
      const floors = {}; const districts = {};
      for (const b of c.layoutMeta) {
        floors[b.floors] = (floors[b.floors] || 0) + 1;
        districts[b.district] = (districts[b.district] || 0) + 1;
      }
      const spire = c.layoutMeta.find((b) => b.isSpire) || null;
      return {
        ok: v.ok,
        violations: v.violations.slice(0, 12),
        buildings: c.layoutMeta.length,
        stats: c.layoutStats,
        floors,
        districts,
        spire: spire ? { x: +spire.cx.toFixed(1), z: +spire.cz.toFixed(1), floors: spire.floors, topY: +spire.topY.toFixed(2) } : null,
        tallestOther: +Math.max(...c.layoutMeta.filter((b) => !b.isSpire).map((b) => b.topY)).toFixed(2),
        doors: c.layoutMeta.filter((b) => b.door).length,
      };
    };
    const out = [{ seed: 20260806, ...run(city) }];
    // Extra seeds get their own City so the shipped one is left mounted for
    // every phase after this; dispose is called on each, which the leak check
    // downstream relies on.
    for (const seed of [4242, 99991]) {
      const scratch = new cityMod.City(new THREE.Scene(), window.__city.renderer, window.__city.camera, quality);
      scratch.build(seed, { level: 60 });
      out.push({ seed, ...run(scratch) });
      scratch.dispose();
    }
    return out;
  });

  phase('layout rules');
  for (const L of layout) {
    console.log(`layout seed ${L.seed}: ${L.buildings} buildings  floors ${JSON.stringify(L.floors)}`);
    console.log(`   districts ${JSON.stringify(L.districts)}`);
    console.log(`   spire ${JSON.stringify(L.spire)}  tallest other ${L.tallestOther} m   plots ${JSON.stringify(L.stats)}`);
    ok(L.ok, `validateLayout failed on seed ${L.seed}: `
      + L.violations.map((v) => `${v.rule}: ${v.detail}`).join(' | '));
    ok(L.doors === L.buildings, `seed ${L.seed}: ${L.doors}/${L.buildings} buildings have a doorway`);
    ok(L.spire && L.spire.floors === 5, `seed ${L.seed}: no 5-storey spire`);
    // The owner asked for taller buildings; this is that ask as a number. The
    // pre-step town was 1-3 storeys with 3 as a rarity.
    const tall = Object.entries(L.floors).reduce((n, [f, c]) => n + (Number(f) >= 3 ? c : 0), 0);
    ok(tall >= L.buildings * 0.2,
      `seed ${L.seed}: only ${tall}/${L.buildings} buildings are 3+ storeys — the skyline is flat again`);
  }

  // -------------------------------------------- heightAt vs the real mesh
  const height = await page.evaluate(({ n, half }) => {
    const { THREE, city } = window.__city;
    const ray = new THREE.Raycaster();
    ray.far = 400;
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    let worst = 0, worstAt = null, misses = 0, tested = 0;
    const diffs = [];
    // Deterministic sample grid over the walkable interior, jittered.
    let seed = 1234567;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * half;
      const z = (rnd() * 2 - 1) * half;
      const h = city.heightAt(x, z);
      origin.set(x, h + 60, z);
      ray.set(origin, down);
      const hit = ray.intersectObject(city.ground, false);
      tested++;
      if (!hit.length) { misses++; continue; }
      const d = Math.abs(hit[0].point.y - h);
      diffs.push(d);
      if (d > worst) { worst = d; worstAt = { x: +x.toFixed(2), z: +z.toFixed(2) }; }
    }
    diffs.sort((a, b) => a - b);
    return {
      tested, misses,
      worst: +worst.toFixed(5),
      worstAt,
      median: +(diffs[diffs.length >> 1] ?? 0).toFixed(5),
    };
  }, { n: SAMPLES, half: 98 });

  phase('heightAt sampling');
  console.log(`heightAt vs mesh: worst ${height.worst} median ${height.median} over ${height.tested} points`);
  ok(height.misses === 0, `${height.misses}/${height.tested} height samples missed the ground mesh entirely`);
  ok(height.worst <= HEIGHT_TOLERANCE,
    `heightAt disagrees with the rendered ground by ${height.worst} at ${JSON.stringify(height.worstAt)} (limit ${HEIGHT_TOLERANCE})`);

  // ---------------------------------------------------- no holes anywhere
  const holes = await page.evaluate(({ n }) => {
    const { THREE, city } = window.__city;
    city.ground.geometry.computeBoundingBox();
    const half = Math.min(
      Math.abs(city.ground.geometry.boundingBox.min.x),
      city.ground.geometry.boundingBox.max.x,
    ) - 0.5;
    const ray = new THREE.Raycaster();
    ray.far = 600;
    const down = new THREE.Vector3(0, -1, 0);
    const o = new THREE.Vector3();
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const bad = [];
    for (let i = 0; i < n; i++) {
      // Sample the real extent of the ground, not a hardcoded one: the map
      // has already been resized once and a stale constant turned "no holes"
      // into "the test aimed off the edge of the world".
      const x = (rnd() * 2 - 1) * half;
      const z = (rnd() * 2 - 1) * half;
      o.set(x, 400, z);
      ray.set(o, down);
      if (!ray.intersectObject(city.ground, false).length) bad.push({ x: +x.toFixed(1), z: +z.toFixed(1) });
    }
    return { n, bad };
  }, { n: SAMPLES });
  phase('hole sampling');
  ok(holes.bad.length === 0, `${holes.bad.length}/${holes.n} positions have no ground under them: ${JSON.stringify(holes.bad.slice(0, 5))}`);

  // --------------------------------------- portal reachability (settle test)
  const reach = await page.evaluate(async () => {
    const { THREE, city } = window.__city;
    const { CharacterBody } = await import('/src/game/physics.js');
    const body = new CharacterBody({ radius: 0.45 });
    body.setEnvironment(
      (x, z) => city.heightAt(x, z),
      city.resolve.bind(city),
      (x, z, out) => city.groundNormal(x, z, out),
    );
    const out = [];
    for (const p of city.portals) {
      // Stand just outside the dais on the plaza side and settle.
      const toCentre = new THREE.Vector3(-p.pos.x, 0, -p.pos.z);
      if (toCentre.lengthSq() < 1e-6) toCentre.set(0, 0, 1);
      toCentre.normalize();
      const sx = p.pos.x + toCentre.x * (p.radius - 0.6);
      const sz = p.pos.z + toCentre.z * (p.radius - 0.6);
      body.reset(sx, city.heightAt(sx, sz) + 2.5, sz);
      for (let i = 0; i < 120; i++) body.step(1 / 60);
      const hit = city.portalAt(body.pos);
      const drift = Math.hypot(body.pos.x - sx, body.pos.z - sz);
      out.push({
        rank: p.rank,
        grounded: body.grounded,
        inRange: !!hit && hit.rank === p.rank,
        y: +body.pos.y.toFixed(2),
        groundY: +city.heightAt(body.pos.x, body.pos.z).toFixed(2),
        drift: +drift.toFixed(2),
      });
    }
    return out;
  });
  phase('portal settle');
  for (const r of reach) {
    ok(r.grounded, `portal ${r.rank}: the body never settled on the ground (y=${r.y}, ground=${r.groundY})`);
    ok(Math.abs(r.y - r.groundY) < 0.12, `portal ${r.rank}: body rests ${(r.y - r.groundY).toFixed(2)} off the ground`);
    ok(r.inRange, `portal ${r.rank}: standing at its own trigger radius does not register portalAt()`);
  }
  console.log('portal settle:', reach.map((r) => `${r.rank}:${r.grounded ? 'ok' : 'FLOAT'}/${r.drift}m`).join(' '));

  // ------------------------------------------------------- the scripted walk
  const walk = await page.evaluate(async ({ seconds }) => {
    const { THREE, renderer, scene, camera, city, glow } = window.__city;
    const { CharacterBody } = await import('/src/game/physics.js');

    // The walk runs at a deliberately tiny resolution. Headless Chromium is on
    // SwiftShader, so at the real viewport a 300k-triangle frame costs ~200 ms
    // and a 60-second walk would take half an hour. Draw calls, the program
    // count and the triangle count are all resolution-INDEPENDENT, and those
    // are the three things this loop actually asserts. Frame milliseconds from
    // here are software-rasteriser numbers and are reported, never asserted.
    const RW = 320, RH = 200;
    renderer.setSize(RW, RH, false);
    glow.setSize(RW, RH, 1);
    camera.aspect = RW / RH;
    camera.updateProjectionMatrix();
    // Same reason, one layer down: the shadow pass re-rasterises the whole
    // city into a 2048^2 depth buffer every frame because updateShadowCamera
    // moves the light with the player. Shrinking the map changes fill cost
    // only — the shadow pass still issues exactly the same DRAW CALLS, which
    // is the thing being counted.
    const shadowSize = city.key.shadow.mapSize.x;
    city.key.shadow.mapSize.set(256, 256);
    if (city.key.shadow.map) { city.key.shadow.map.dispose(); city.key.shadow.map = null; }

    const body = new CharacterBody({ radius: 0.45, maxSpeed: 8.5 });
    body.setEnvironment(
      (x, z) => city.heightAt(x, z),
      city.resolve.bind(city),
      (x, z, out) => city.groundNormal(x, z, out),
    );
    const spawn = city.spawnPoint();
    body.reset(spawn.x, spawn.y + 0.4, spawn.z);

    // A route that visits every portal, every district and both gates.
    //
    // Portal waypoints are the STANDING SPOT, not the portal origin: the dais
    // is a solid 2.6 m collider, so aiming at p.pos means walking into a wall
    // and never arriving. This is the same offset the prompt radius uses.
    const stand = (p) => {
      const len = Math.hypot(p.pos.x, p.pos.z) || 1;
      const inward = p.rank === 'S' ? { x: 0, z: 1 } : { x: -p.pos.x / len, z: -p.pos.z / len };
      const r = p.radius - 0.8;
      return { x: p.pos.x + inward.x * r, z: p.pos.z + inward.z * r };
    };
    // The route follows the STREET NETWORK, not straight lines between
    // landmarks. Steering straight at a target across a city block wedges on
    // the first building and reports the city as unreachable when the fault is
    // the pathfinder — that is exactly the hole navgrid.js exists to fill, and
    // this tool must not pretend to have it.
    const R = 58;                 // ring-road radius, mirrors buildStreets()
    const ring = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ring.push({ x: Math.cos(a) * R, z: -Math.sin(a) * R });
    }
    const route = [
      // The five PLAZA portals, approached from their standing spots. The
      // Verge's wild gates are in city.portals too now (WORLD_SPEC step 7) and
      // are excluded here on purpose: this route follows the street network and
      // deliberately has no pathfinder, so a waypoint 200 m outside the wall
      // steers the body straight into a wall corner and reports the town as
      // unreachable. Walking out to the Verge is frontier-test's job, and it
      // does it on the axes the gates actually open onto.
      ...city.portals.filter((p) => p.rank !== 'S' && !p.wild).map(stand),
      { x: 0, z: 0 },
      // north avenue to the Assay Hall
      { x: 0, z: -18 }, { x: 0, z: -30 }, { x: 0, z: -48 }, { x: 0, z: -18 },
      // east avenue to the Ashworks
      { x: 30, z: 0 }, { x: 44, z: 0 }, { x: 44, z: 10 }, { x: 44, z: 0 },
      // the ring road, all the way round
      ...ring,
      // west avenue and the cliff overlook
      { x: -30, z: 0 }, { x: -60, z: 0 }, { x: -82, z: 0 }, { x: -60, z: 0 },
      // south avenue and the market
      { x: 0, z: 20 }, { x: 0, z: 30 }, { x: 0, z: 60 }, { x: 0, z: 30 },
      // out of the north gate to the Breach and back
      { x: 0, z: -30 }, { x: 0, z: -70 }, { x: 0, z: -88 }, { x: 0, z: -110 },
      stand(city.portals.find((p) => p.rank === 'S')),
      { x: 0, z: -88 }, { x: 0, z: 0 },
    ];

    const calls = [];
    const tris = [];
    const frameMs = [];
    const programs = [];
    const camPos = new THREE.Vector3();
    const look = new THREE.Vector3();
    let leg = 0;
    let ungrounded = 0;
    let stuck = 0;
    let prev = body.pos.clone();
    const trace = [];

    const dt = 1 / 60;
    const SUB = 4;                                  // physics steps per render
    const frames = Math.round(seconds * 60 / SUB);

    // WARM-UP, and the reason the programs assertion means anything.
    // three compiles a material's program the first time that material is
    // drawn, so a cold scene grows renderer.info.programs from 3 to ~21 purely
    // by being looked at. That is first compilation, not RE-compilation, and
    // asserting against it would fail every run for the wrong reason. Force
    // every material through a real draw from several angles first, then take
    // the baseline. Growth after this point is a genuine cache-key change.
    for (const v of [[0, 6, 46], [0, 120, 40], [-90, 8, 0], [60, 10, -60], [0, 20, -140], [80, 60, 80]]) {
      camera.position.set(v[0], v[1], v[2]);
      camera.lookAt(0, 2, 0);
      city.update(0.016, camera.position);
      glow.render(scene, camera);
    }
    renderer.compile(scene, camera);
    const startPrograms = renderer.info.programs.length;

    for (let f = 0; f < frames; f++) {
      let dx = 0, dz = 0, d = 0;
      for (let k = 0; k < SUB; k++) {
        const target = route[leg % route.length];
        dx = target.x - body.pos.x;
        dz = target.z - body.pos.z;
        d = Math.hypot(dx, dz);
        if (d < 3.2) leg++;
        body.move(dx, dz, 1);
        body.step(dt);
        if (!body.grounded) ungrounded++;
        if (body.pos.distanceTo(prev) < 0.01 && d > 3.2) stuck++;
        prev.copy(body.pos);
      }

      // Third-person chase camera, yawed along the direction of travel.
      const yaw = Math.atan2(dx, dz);
      camPos.set(
        body.pos.x - Math.sin(yaw) * 8.5,
        body.pos.y + 5.2,
        body.pos.z - Math.cos(yaw) * 8.5,
      );
      camPos.y = Math.max(camPos.y, city.heightAt(camPos.x, camPos.z) + 1.6);
      camera.position.copy(camPos);
      look.set(body.pos.x, body.pos.y + 1.3, body.pos.z);
      camera.lookAt(look);

      city.update(dt * SUB, body.pos);

      // renderer.info.autoReset is TRUE by default, which resets the counters
      // at the START of every renderer.render() call. Glow.render issues six
      // of them (glow pass, four blurs, main pass) plus the composite quad, so
      // reading info.render.calls afterwards reports the LAST call only — one
      // draw, every frame, for any scene. Turning autoReset off and resetting
      // by hand is the only way to get the whole frame's cost.
      renderer.info.autoReset = false;
      const t0 = performance.now();
      renderer.info.reset();
      glow.render(scene, camera);
      frameMs.push(performance.now() - t0);
      calls.push(renderer.info.render.calls);
      tris.push(renderer.info.render.triangles);
      if (f % 5 === 0) programs.push(renderer.info.programs.length);
      if (f % 40 === 0) trace.push([f, +body.pos.x.toFixed(1), +body.pos.z.toFixed(1), leg, +d.toFixed(1)]);
      // Yield so the tab does not get killed for a long task.
      if (f % 10 === 0) {
        // eslint-disable-next-line no-console
        if (f % 60 === 0) console.log(`walk ${f}/${frames}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    city.key.shadow.mapSize.set(shadowSize, shadowSize);
    if (city.key.shadow.map) { city.key.shadow.map.dispose(); city.key.shadow.map = null; }
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    glow.setSize(window.innerWidth, window.innerHeight, 1);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    const pct = (arr, p) => {
      const a = [...arr].sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(a.length * p))];
    };
    return {
      frames,
      substeps: frames * SUB,
      callsMean: Math.round(calls.reduce((a, b) => a + b, 0) / calls.length),
      callsP95: pct(calls, 0.95),
      callsMax: Math.max(...calls),
      trisMean: Math.round(tris.reduce((a, b) => a + b, 0) / tris.length),
      trisP95: pct(tris, 0.95),
      frameMsMean: +(frameMs.reduce((a, b) => a + b, 0) / frameMs.length).toFixed(2),
      frameMsP95: +pct(frameMs, 0.95).toFixed(2),
      programsStart: startPrograms,
      programsEnd: renderer.info.programs.length,
      programsSeries: programs,
      ungrounded,
      stuck,
      legsReached: leg,
      routeLength: route.length,
      finalPos: { x: +body.pos.x.toFixed(1), z: +body.pos.z.toFixed(1) },
      trace,
    };
  }, { seconds: WALK_SECONDS });

  phase('scripted walk');
  console.log(`walk ${walk.frames} frames  draws mean ${walk.callsMean} p95 ${walk.callsP95} max ${walk.callsMax}`);
  console.log(`      tris mean ${walk.trisMean} p95 ${walk.trisP95}   frame ${walk.frameMsMean} ms (p95 ${walk.frameMsP95})`);
  console.log(`      programs ${walk.programsStart} -> ${walk.programsEnd}   legs ${walk.legsReached}/${walk.routeLength}  end ${JSON.stringify(walk.finalPos)}`);


  ok(walk.callsP95 <= DRAW_P95_LIMIT,
    `draw calls p95 is ${walk.callsP95}, limit ${DRAW_P95_LIMIT}`);
  ok(walk.programsEnd <= walk.programsStart,
    `renderer.info.programs grew ${walk.programsStart} -> ${walk.programsEnd} during the walk `
    + '(shader recompile — check for a light whose .visible is being toggled)');
  ok(walk.ungrounded < walk.substeps * 0.12,
    `the player was airborne for ${walk.ungrounded}/${walk.substeps} physics steps — the ground is not solid under the route`);
  ok(walk.stuck < walk.substeps * 0.10,
    `the player was wedged for ${walk.stuck}/${walk.substeps} physics steps — geometry is trapping the body`);
  ok(walk.legsReached >= walk.routeLength,
    `the walk only reached ${walk.legsReached} of ${walk.routeLength} waypoints — somewhere is unreachable`);

  // ------------------------------------------------------------ screenshots
  const shots = [];
  if (SHOTS) {
    const VIEWS = [
      { name: 'city-plaza-arrival', pos: [0, 5.4, 44], look: [0, 3.6, 4] },
      { name: 'city-plaza-portals', pos: [0, 4.2, 26], look: [0, 4.4, -8] },
      { name: 'city-street-row', pos: [-34, 4.4, 1], look: [-80, 2.2, 1] },
      { name: 'city-market', pos: [10, 4.6, 56], look: [-3, 2.6, 26] },
      { name: 'city-breach-road', pos: [0, 8.0, -92], look: [0, 4.5, -130] },
      { name: 'city-overlook', pos: [-62, 4.4, 0], look: [-96, -6, -4] },
      { name: 'city-eye', pos: [26, 3.0, 34], look: [-10, 4.0, -6] },
      { name: 'city-aerial', pos: [-108, 92, 128], look: [0, 0, -16] },
      { name: 'city-aerial-north', pos: [0, 126, 52], look: [0, 0, -70] },
      { name: 'city-gate-look-back', pos: [0, 5.2, -78], look: [0, 5.0, 10] },
    ];
    for (const v of VIEWS) {
      await page.evaluate(({ pos, look }) => {
        const { renderer, scene, camera, city, glow } = window.__city;
        camera.position.set(pos[0], pos[1], pos[2]);
        camera.lookAt(look[0], look[1], look[2]);
        city.update(0.016, camera.position);
        renderer.info.autoReset = false;
        renderer.info.reset();
        glow.render(scene, camera);
        renderer.info.autoReset = false;
        window.__lastCalls = renderer.info.render.calls;
        window.__lastTris = renderer.info.render.triangles;
      }, v);
      const info = await page.evaluate(() => ({ calls: window.__lastCalls, tris: window.__lastTris }));
      const p = shotPath(`${v.name}.png`);
      await page.screenshot({ path: p });
      shots.push({ name: v.name, path: p, ...info });
      phase(`shot ${v.name}`);
      console.log(`shot ${v.name.padEnd(20)} ${String(info.calls).padStart(4)} draws  ${String(info.tris).padStart(7)} tris  -> ${p}`);
    }
  }

  // ------------------------------------------- runtime density (phone fence)
  // WORLD_SPEC's PHONE BUDGET DRIFT risk names "the tier-scaled scatter counts"
  // as the fence for this wave's ~2x geometry. It only IS a fence if it engages
  // mid-session: instanceScale was read once at build, so a device the governor
  // had just stepped down kept every triangle of the tier it was struggling at
  // until the player next re-entered the city from a gate — and this wave's
  // headline is a long city+frontier session that need never enter one.
  const density = await page.evaluate(() => {
    const { city } = window.__city;
    const V = Object.getPrototypeOf(city.group.position).constructor;
    const snap = () => {
      const s = city.stats;
      return {
        density: s.density,
        tris: s.triangles,
        frontierTris: s.frontier ? s.frontier.triangles : 0,
        instances: s.instances,
        collidersOff: city.obstacles.filter((o) => o.off).length,
      };
    };
    // Probe: does a solid still push a body out after its instance stopped
    // drawing? An invisible wall is worse than the triangles it saved.
    const push = (o) => {
      const v = new V(o.pos.x, 0, o.pos.z);
      city.resolve(v, 0.4);
      return +Math.hypot(v.x - o.pos.x, v.z - o.pos.z).toFixed(3);
    };
    const built = snap();
    city.setInstanceDensity(0.4);              // the `low` tier's instanceScale
    const low = snap();
    const thinned = city.obstacles.find((o) => o.off) || null;
    const kept = city.obstacles.find((o) => !o.off && o.i != null) || null;
    low.pushOutOfThinned = thinned ? push(thinned) : null;
    low.pushOutOfKept = kept ? push(kept) : null;
    city.setInstanceDensity(built.density);    // hand the world back
    const restored = snap();
    return { built, low, restored };
  });
  phase('runtime density');
  console.log(`density lever: ${density.built.tris} tris at ${density.built.density}`
    + ` -> ${density.low.tris} at 0.4 (${density.low.collidersOff} colliders off)`
    + ` -> ${density.restored.tris} restored`);
  // Bars, not targets. The lever only touches the random-placement scatter
  // fields, so the merged ground, the walls, the buildings, the interiors and
  // the street props it deliberately leaves alone put a ceiling on how much it
  // can ever shed. Measured at build density 1.0: 971,794 -> 651,906 world
  // (0.67) and 483,436 -> 200,378 frontier (0.41). The bars sit just outside
  // those so a REGRESSION (the lever silently doing nothing, which is exactly
  // what shipped) fails and ordinary tuning does not.
  ok(density.low.tris <= density.built.tris * 0.75,
    `a step to the low tier only shed ${density.built.tris - density.low.tris} of ${density.built.tris} triangles`);
  ok(density.low.frontierTris <= density.built.frontierTris * 0.55,
    `the Verge only shed ${density.built.frontierTris - density.low.frontierTris}`
    + ` of ${density.built.frontierTris} triangles — its scatter is the largest single block in the world`);
  ok(density.low.instances < density.built.instances,
    'stepping down the tier did not reduce the drawn instance count');
  ok(density.restored.tris === density.built.tris
    && density.restored.instances === density.built.instances,
    `stepping back up restored ${density.restored.tris}/${density.built.tris} triangles`);
  ok(density.restored.collidersOff === 0,
    `${density.restored.collidersOff} colliders stayed switched off after the tier came back up`);
  ok(density.low.collidersOff > 0,
    'no colliders were switched off — thinned bushes and trees are still solid');
  ok(density.low.pushOutOfThinned === 0,
    `a thinned instance still pushes a body ${density.low.pushOutOfThinned} m — invisible wall`);
  ok(density.low.pushOutOfKept > 0,
    'the probe found no live scatter collider at all — this phase is measuring nothing');

  // ---------------------------------------------------- the fallback path
  // Everything above ran with citykit.glb loaded. The procedural stand-ins are
  // what ships if the GLB ever fails to decode on a device, and a code path
  // that has never once been executed is not a fallback, it is a second bug.
  // Run it LAST, because disposeCityKit() destroys the kit for good.
  const fallback = await page.evaluate(async () => {
    const { city, cityMod, scene, renderer, camera, quality, THREE } = window.__city;
    const kit = await import('/src/world/citykit.js');
    city.dispose();
    kit.disposeCityKit();

    // The nine spec exports that do not need the GLB at all.
    const mods = Object.keys(kit.MODULES).map((k) => kit.moduleGeometry(k));
    const props = Object.keys(kit.PROPS).map((k) => kit.propGeometry(k));
    const mats = kit.cityMaterials();
    let rs = 12345;
    const rnd = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
    const facade = kit.buildFacade(rnd, { width: 8, depth: 12, floors: 3, style: 'stone' });
    const block = kit.buildBlock(rnd, { x: 10, z: -4, w: 24, d: 14, style: 'timber' });
    const field = kit.makePropField('lamp', 8);

    const plain = new cityMod.City(scene, renderer, camera, quality);
    plain.build(20260806, { level: 60 });
    camera.position.set(0, 5.4, 44);
    camera.lookAt(0, 3.6, 4);
    plain.update(0.016, camera.position);
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.render(scene, camera);
    const out = {
      kitLoaded: kit.cityKitLoaded(),
      modGeoms: mods.filter((g) => g && g.attributes.position.count > 0).length,
      propGeoms: props.filter((g) => g && g.attributes.position.count > 0).length,
      mats: Object.keys(mats).length,
      facadeVerts: facade.geometry.attributes.position.count,
      facadeHeight: +facade.height.toFixed(2),
      blockBoxes: block.boxes.length,
      blockObstacles: block.obstacles.length,
      fieldIsInstanced: !!field.isInstancedMesh,
      stats: (({ drawGroups, instances, triangles, portals, wildGates }) => ({ drawGroups, instances, triangles, portals, wildGates }))(plain.stats),
      calls: renderer.info.render.calls,
      heightMatches: (() => {
        const ray = new THREE.Raycaster(); ray.far = 400;
        const d = new THREE.Vector3(0, -1, 0); const o = new THREE.Vector3();
        let worst = 0;
        for (let i = 0; i < 40; i++) {
          const x = (i * 37 % 160) - 80, z = (i * 61 % 160) - 80;
          const h = plain.heightAt(x, z);
          o.set(x, h + 50, z); ray.set(o, d);
          const hit = ray.intersectObject(plain.ground, false);
          if (hit.length) worst = Math.max(worst, Math.abs(hit[0].point.y - h));
        }
        return +worst.toFixed(5);
      })(),
    };
    window.__fallbackCity = plain;
    return out;
  });
  console.log('procedural fallback:', JSON.stringify(fallback));
  const fp = shotPath('city-fallback-noglb.png');
  await page.screenshot({ path: fp });
  console.log(`shot city-fallback-noglb   -> ${fp}`);
  ok(fallback.kitLoaded === false, 'disposeCityKit() left the kit flagged as loaded');
  ok(fallback.modGeoms === 12, `moduleGeometry returned ${fallback.modGeoms}/12 usable geometries without the GLB`);
  ok(fallback.propGeoms === 9, `propGeometry returned ${fallback.propGeoms}/9 usable geometries without the GLB`);
  ok(fallback.mats === 5, `cityMaterials returned ${fallback.mats} materials, spec says 5`);
  ok(fallback.facadeVerts > 0 && fallback.facadeHeight > 0, 'buildFacade produced nothing');
  ok(fallback.blockBoxes > 0 && fallback.blockObstacles > 0, 'buildBlock returned no collision');
  ok(fallback.fieldIsInstanced, 'makePropField did not return an InstancedMesh');
  ok(fallback.stats.portals - fallback.stats.wildGates === 6,
    `the procedural city built ${fallback.stats.portals - fallback.stats.wildGates} town portals`);
  ok(fallback.stats.wildGates === 2,
    `the procedural Verge built ${fallback.stats.wildGates} wild gates, spec says 2`);
  ok(fallback.calls > 10, `the procedural city only issued ${fallback.calls} draw calls — it is empty`);
  ok(fallback.heightMatches <= HEIGHT_TOLERANCE,
    `procedural city heightAt is off the mesh by ${fallback.heightMatches}`);

  const pageErrors = errors.filter((e) => !/favicon/i.test(e));
  ok(pageErrors.length === 0, `page errors:\n${pageErrors.slice(0, 3).join('\n')}`);

  const report = {
    when: new Date().toISOString(),
    build, height, holes, reach, walk, shots, fallback,
    limits: { DRAW_P95_LIMIT, HEIGHT_TOLERANCE, SAMPLES, WALK_SECONDS },
    failures: fail,
    warnings: warn,
  };
  const file = writeReport('city-test', report);
  console.log(`\nreport -> ${file}`);
} finally {
  await browser.close();
  await server.stop();
}

if (fail.length) {
  console.error(`\nFAIL (${fail.length})`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS — city hub verified');
