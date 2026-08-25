// tools/village-test.mjs — verify EMBERFALL, the second settlement (Wave B4a).
//
//   node tools/village-test.mjs [--walk-seconds 90] [--no-shots] [--headed]
//                               [--swiftshader]
//
// city-test proves Threshold; this proves THE SEAM — that City builds a town
// it has never seen from data alone, under the same laws. Cloned from
// city-test's harness pattern on purpose (same renderer setup, same walk
// loop, same p95 discipline) so the two suites measure with one ruler.
//
// What it asserts, and why:
//
//   * PROGRAM BASELINE VS THE CITY. Threshold is built FIRST, warmed until
//     every material has compiled, and its program count recorded; then it is
//     disposed and Emberfall is built in the same renderer. The village may
//     not end above that baseline: a second settlement that needs even one
//     NEW shader program has snuck in a material variant (the 50->83 gate
//     creep, settlement edition), and this is the fence the cohesion plan
//     demands per new area.
//   * DRAW CALLS p95 <= 160 on a scripted walk. Smaller town, smaller budget
//     — Threshold's is 220 — and p95 rather than mean for city-test's reason:
//     the mean hides the one lane where the budget blows.
//   * ZERO program growth DURING the walk (the PointLight regression fence).
//   * The descriptor's promises hold in the BUILT world: no wall mesh, no
//     breach platform, exactly two town portals with the mandated stable ids,
//     the 'way' slot inert (data present, nothing built), one enterable
//     wearing the settlement's name, ~20 buildings under the hamlet profile,
//     meadow-only Verge with 2 POIs and ZERO wild gates.
//   * heightAt agrees with the rendered mesh; no holes; both portals settle a
//     dropped body; spawn/resolve are sane — including the WEST bound, which
//     without a cliff must clamp symmetrically instead of at the cliff line.
//   * THRESHOLD IS UNTOUCHED: the descriptor deep-compares equal after the
//     village builds (shared-state mutation is the seam's failure mode), and
//     a Threshold rebuild afterwards comes back with its six portals and its
//     six banner districts.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const WALK_SECONDS = Number(arg('walk-seconds', 90));
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');
// Same opt-out as city-test: everything asserted is resolution/backend
// independent; SwiftShader only slows the walk ~50x.
const SWIFTSHADER = argv.includes('--swiftshader');

const DRAW_P95_LIMIT = 160;      // the village's own budget row (city: 220)
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

  // -------------------------------------------- Threshold program baseline
  const baseline = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const cityMod = await import('/src/world/city.js');
    const settlements = await import('/src/world/settlements.js');
    const kit = await import('/src/world/citykit.js');
    const { Glow } = await import('/src/render/glow.js');
    const { Quality } = await import('/src/core/quality.js');

    const kitLoaded = await kit.loadCityKit();

    const canvas = document.createElement('canvas');
    canvas.id = 'villagetest';
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

    // The mutation canary: the settlement seam's one failure mode is a
    // builder writing THROUGH a spec into shared data, and a deep snapshot
    // costs nothing here. Descriptors are pure data by their own rule 1, so
    // JSON round-trips them faithfully.
    const thresholdSnapshot = JSON.stringify(settlements.THRESHOLD);

    // Threshold, warmed exactly the way city-test warms before its programs
    // assert: force every material through a real draw from several angles,
    // then compile, then take the number.
    const city = new cityMod.City(scene, renderer, camera, quality);
    const t0 = performance.now();
    city.build(20260806, { level: 60 });
    const buildMs = Math.round(performance.now() - t0);
    for (const v of [[0, 6, 46], [0, 120, 40], [-90, 8, 0], [60, 10, -60], [0, 20, -140], [80, 60, 80]]) {
      camera.position.set(v[0], v[1], v[2]);
      camera.lookAt(0, 2, 0);
      city.update(0.016, camera.position);
      glow.render(scene, camera);
    }
    renderer.compile(scene, camera);
    const programsBaseline = renderer.info.programs.length;
    // B5 retarget: city.portals now carries the settlement's WAYGATES too
    // (kind:'way' — travel went live); the "6 town portals" truth is about
    // the RANK ladder, so ways are excluded from the count, not added to it.
    const thresholdPortals = city.portals.filter((p) => !p.wild && !p.way).length;
    const thresholdDistricts = cityMod.DISTRICTS.map((d) => d.id);
    city.dispose();

    window.__vt = {
      THREE, renderer, scene, camera, quality, glow, cityMod, settlements, kit,
      thresholdSnapshot,
    };
    return {
      kitLoaded, buildMs, programsBaseline, thresholdPortals, thresholdDistricts,
    };
  });
  phase('threshold baseline');
  console.log(`threshold: build ${baseline.buildMs} ms, programs ${baseline.programsBaseline}, portals ${baseline.thresholdPortals}`);
  ok(baseline.kitLoaded, 'citykit.glb failed to load — both towns would fall back to procedural pieces');
  ok(baseline.thresholdPortals === 6, `threshold baseline built ${baseline.thresholdPortals} town portals, expected 6`);

  // ---------------------------------------------------------------- build
  const build = await page.evaluate(() => {
    const { THREE, renderer, scene, camera, quality, glow, cityMod, settlements } = window.__vt;
    const t0 = performance.now();
    const city = new cityMod.City(scene, renderer, camera, quality, settlements.EMBERFALL);
    city.build(20260806, { level: 60 });
    const buildMs = Math.round(performance.now() - t0);
    // The B6 grade row rides the same composite Threshold uses — uniforms
    // only, so this must not add a program (the walk assert below holds it).
    glow.setGrade(settlements.EMBERFALL.palettes.grade || null);
    window.__vt.city = city;

    const wallMesh = city.group.getObjectByName('city_wall') || null;
    return {
      buildMs,
      slug: city.spec.slug,
      stats: (({ drawGroups, instances, triangles, buildings, portals, wildGates, density }) => (
        { drawGroups, instances, triangles, buildings, portals, wildGates, density }))(city.stats),
      fields: city.stats.fields.slice(0, 12),
      portals: city.portals.map((p) => ({
        id: p.id, rank: p.rank, color: p.color, wild: Boolean(p.wild),
        pos: { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2) },
        meshes: p.group.children.length,
      })),
      hasWallMesh: Boolean(wallMesh),
      breachFields: city.fields.filter((f) => /breach/.test(f.name || f.key)).length,
      wayInDescriptor: settlements.EMBERFALL.portals.placements.some((pl) => pl.kind === 'way'),
      // B5 retarget: the way slots are LIVE portals now. Collect them so the
      // asserts below can check ids + destination payloads.
      waysBuilt: city.portals.filter((p) => p.way).map((p) => ({ id: p.id, to: { ...p.way } })),
      buildings: city.layoutMeta.length,
      layoutStats: city.layoutStats,
      floors: city.layoutMeta.reduce((m, b) => { m[b.floors] = (m[b.floors] || 0) + 1; return m; }, {}),
      districtsOfStock: [...new Set(city.layoutMeta.map((b) => b.district))],
      banners: cityMod.DISTRICTS.map((d) => d.id),
      interiors: city.interiors.stats,
      frontier: (({ pois, wildGates, emptyFields, poiList }) => ({ pois, wildGates, emptyFields, poiList }))(city.frontier.stats),
      interactables: city.interactables.map((i) => i.id),
      pointLights: (() => { let n = 0; scene.traverse((o) => { if (o.isPointLight) n++; }); return n; })(),
      spawn: (() => { const s = city.spawnPoint(); return { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) }; })(),
      thresholdUntouched: JSON.stringify(settlements.THRESHOLD) === window.__vt.thresholdSnapshot,
    };
  });
  phase('village build');
  console.log(`emberfall build: ${build.buildMs} ms   stats ${JSON.stringify(build.stats)}`);
  console.log(`portals: ${build.portals.map((p) => `${p.id}@${p.pos.x},${p.pos.z}`).join('  ')}`);
  console.log(`buildings ${build.buildings} floors ${JSON.stringify(build.floors)} plots ${JSON.stringify(build.layoutStats)}`);
  console.log(`banners ${build.banners.join(',')}   interiors ${JSON.stringify(build.interiors.buildings)}`);
  console.log(`frontier pois ${JSON.stringify(build.frontier.poiList.map((p) => `${p.id}@${p.x},${p.z}`))} empty fields ${JSON.stringify(build.frontier.emptyFields)}`);

  ok(build.slug === 'emberfall', `built settlement slug is '${build.slug}'`);
  ok(build.thresholdUntouched, 'building EMBERFALL mutated the THRESHOLD descriptor — the seam leaks shared state');
  ok(build.pointLights === 0, `${build.pointLights} PointLight(s) in the village scene; the law says zero`);
  // The mandated RANK ids and only them; the waygates ride alongside.
  //
  // B5 RETARGET (this suite's "inert until the Travel task" truth expired
  // when the Travel task landed): kind:'way' placements BUILD portals now —
  // renamed/added as 'way-emberfall-green' (↔ Threshold's north gate) and
  // 'way-emberfall-end' (↔ THE BIRCHREACH's trailhead) — so the village
  // carries 2 rank gates + 2 waygates, and the old "the slot must not build"
  // assert flips into "the slots must build, with the right destinations".
  const town = build.portals.filter((p) => !p.wild && !p.id.startsWith('way-'));
  ok(town.length === 2, `expected 2 rank town portals, got ${town.length}`);
  ok(town.some((p) => p.id === 'green-e' && p.rank === 'E'), "missing portal 'green-e' (rank E on the green's edge)");
  ok(town.some((p) => p.id === 'end-d' && p.rank === 'D'), "missing portal 'end-d' (rank D at the village's end)");
  for (const p of build.portals) ok(p.meshes === 4, `portal ${p.id} has ${p.meshes} meshes, spec says 4`);
  ok(build.wayInDescriptor, "the descriptor lost its 'way' placement slots");
  ok(build.waysBuilt.length === 2, `expected 2 built waygates, got ${JSON.stringify(build.waysBuilt)}`);
  ok(build.waysBuilt.some((w) => w.id === 'way-emberfall-green'
    && w.to.toSettlement === 'threshold' && w.to.toPortalId === 'way-threshold-north'),
  `the green waygate's link is wrong: ${JSON.stringify(build.waysBuilt)}`);
  ok(build.waysBuilt.some((w) => w.id === 'way-emberfall-end'
    && w.to.toSettlement === 'birchreach' && w.to.toPortalId === 'way-birchreach-trail'),
  `the village-end waygate's link is wrong: ${JSON.stringify(build.waysBuilt)}`);
  ok(!build.hasWallMesh, 'a city_wall mesh exists — EMBERFALL is wall-less by descriptor (wall.built false)');
  ok(build.breachFields === 0, `${build.breachFields} breach ruin fields built in a settlement with no breach`);
  // "~20 buildings": the budget row says 22; under ~14 the hamlet reads as a
  // scatter of sheds, which is the exact failure the layout rules exist for.
  ok(build.buildings >= 14 && build.buildings <= 22,
    `village has ${build.buildings} buildings, wanted ~20 (14..22)`);
  ok(build.districtsOfStock.length === 1 && build.districtsOfStock[0] === 'hamlet',
    `building stock spans districts ${build.districtsOfStock.join(',')}, expected the single 'hamlet' profile`);
  ok(!Object.keys(build.floors).some((f) => Number(f) > 2),
    `a village building has ${Math.max(...Object.keys(build.floors).map(Number))} storeys — the hamlet caps at 2`);
  ok(build.interiors.planned === 1, `${build.interiors.planned} enterables planned, expected 1 (the waystation)`);
  ok(build.interiors.buildings.some((b) => b.id === 'tavern_row'),
    'the waystation did not claim a plot (tavern_row row missing from interiors)');
  ok(build.interactables.length === 0,
    `village has interactable prompts ${build.interactables.join(',')} — the waystation is walk-in`);
  ok(build.frontier.pois === 2, `village Verge has ${build.frontier.pois} POIs, spec says 2`);
  ok(build.frontier.wildGates === 0, `village Verge built ${build.frontier.wildGates} wild gates, spec says NONE`);
  for (const p of build.frontier.poiList) {
    ok(p.violations.length === 0, `POI ${p.id} breaks rules: ${p.violations.join(',')}`);
  }
  ok(build.banners.join(',') === 'green,wayrest,end,ember_wayfarers_camp,ember_barrow_ring',
    `banner list is ${build.banners.join(',')} — DISTRICTS did not follow the built settlement`);
  const way = build.interiors.buildings.find((b) => b.id === 'tavern_row');
  console.log(`waystation at ${way ? `${way.x},${way.z}` : 'NOWHERE'}   spawn ${JSON.stringify(build.spawn)}`);

  // The renamed sign: settlement names ride spec.interiors.names.
  const wayName = await page.evaluate(() => window.__vt.city.interiors.buildings[0]?.name || null);
  ok(wayName === 'THE WAYSTATION', `the enterable is named '${wayName}', expected 'THE WAYSTATION'`);

  // ------------------------------------------------------- layout validation
  const layout = await page.evaluate(async () => {
    const rules = await import('/src/world/layoutrules.js');
    const v = rules.validateLayout(window.__vt.city);
    return { ok: v.ok, violations: v.violations.slice(0, 12), buildings: v.buildings };
  });
  phase('layout rules');
  ok(layout.ok, `validateLayout failed for the village: ${layout.violations.map((v) => `${v.rule}: ${v.detail}`).join(' | ')}`);

  // -------------------------------------------- heightAt vs the real mesh
  const height = await page.evaluate(({ n, half }) => {
    const { THREE, city } = { ...window.__vt, city: window.__vt.city };
    const ray = new THREE.Raycaster();
    ray.far = 400;
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    let worst = 0, worstAt = null, misses = 0, tested = 0;
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
      if (d > worst) { worst = d; worstAt = { x: +x.toFixed(2), z: +z.toFixed(2) }; }
    }
    return { tested, misses, worst: +worst.toFixed(5), worstAt };
  }, { n: SAMPLES, half: 50 });
  phase('heightAt sampling');
  console.log(`heightAt vs mesh: worst ${height.worst} over ${height.tested} points`);
  ok(height.misses === 0, `${height.misses}/${height.tested} height samples missed the village ground mesh`);
  ok(height.worst <= HEIGHT_TOLERANCE,
    `heightAt disagrees with the rendered ground by ${height.worst} at ${JSON.stringify(height.worstAt)}`);

  // ---------------------------------------------------- no holes anywhere
  const holes = await page.evaluate(({ n }) => {
    const { THREE } = window.__vt;
    const city = window.__vt.city;
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
      const x = (rnd() * 2 - 1) * half;
      const z = (rnd() * 2 - 1) * half;
      o.set(x, 400, z);
      ray.set(o, down);
      if (!ray.intersectObject(city.ground, false).length) bad.push({ x: +x.toFixed(1), z: +z.toFixed(1) });
    }
    return { n, bad };
  }, { n: SAMPLES });
  phase('hole sampling');
  ok(holes.bad.length === 0, `${holes.bad.length}/${holes.n} positions have no ground: ${JSON.stringify(holes.bad.slice(0, 5))}`);

  // ------------------------------------------------------ resolve() bounds
  // The west side is the new behaviour: no cliff, so the bound must be the
  // symmetric walk limit, not the cliff line (and not the -320 sentinel).
  const bounds = await page.evaluate(() => {
    const { THREE } = window.__vt;
    const city = window.__vt.city;
    const lim = city.spec.verge.limit;
    const probe = (x, z) => {
      const v = new THREE.Vector3(x, 0, z);
      city.resolve(v, 0.6);
      return { x: +v.x.toFixed(2), z: +v.z.toFixed(2) };
    };
    return {
      lim,
      east: probe(400, 0),
      west: probe(-400, 0),
      north: probe(0, -400),
      south: probe(0, 400),
    };
  });
  phase('resolve bounds');
  console.log(`bounds at limit ${bounds.lim}:`, JSON.stringify(bounds));
  ok(Math.abs(bounds.east.x - (bounds.lim - 0.6)) < 0.01, `east bound clamps at ${bounds.east.x}`);
  ok(Math.abs(bounds.west.x - -(bounds.lim - 0.6)) < 0.01,
    `west bound clamps at ${bounds.west.x} — a cliffless settlement must bound symmetrically at -(limit - r)`);
  ok(Math.abs(bounds.north.z - -(bounds.lim - 0.6)) < 0.01, `north bound clamps at ${bounds.north.z}`);
  ok(Math.abs(bounds.south.z - (bounds.lim - 0.6)) < 0.01, `south bound clamps at ${bounds.south.z}`);

  // --------------------------------------- portal reachability (settle test)
  const reach = await page.evaluate(async () => {
    const { THREE } = window.__vt;
    const city = window.__vt.city;
    const { CharacterBody } = await import('/src/game/physics.js');
    const body = new CharacterBody({ radius: 0.45 });
    body.setEnvironment(
      (x, z) => city.heightAt(x, z),
      city.resolve.bind(city),
      (x, z, out) => city.groundNormal(x, z, out),
    );
    const out = [];
    for (const p of city.portals) {
      const yaw = p.group.rotation.y;
      const sx = p.pos.x + Math.sin(yaw) * (p.radius - 0.6);
      const sz = p.pos.z + Math.cos(yaw) * (p.radius - 0.6);
      body.reset(sx, city.heightAt(sx, sz) + 2.5, sz);
      for (let i = 0; i < 120; i++) body.step(1 / 60);
      const hit = city.portalAt(body.pos);
      out.push({
        id: p.id,
        grounded: body.grounded,
        inRange: !!hit && hit.id === p.id,
        y: +body.pos.y.toFixed(2),
        groundY: +city.heightAt(body.pos.x, body.pos.z).toFixed(2),
      });
    }
    return out;
  });
  phase('portal settle');
  for (const r of reach) {
    ok(r.grounded, `portal ${r.id}: the body never settled (y=${r.y}, ground=${r.groundY})`);
    ok(Math.abs(r.y - r.groundY) < 0.12, `portal ${r.id}: body rests ${(r.y - r.groundY).toFixed(2)} off the ground`);
    ok(r.inRange, `portal ${r.id}: standing at its trigger radius does not register portalAt()`);
  }

  // ------------------------------------------------------- the scripted walk
  const walk = await page.evaluate(async ({ seconds }) => {
    const { THREE, renderer, scene, camera, glow } = window.__vt;
    const city = window.__vt.city;
    const { CharacterBody } = await import('/src/game/physics.js');

    // Tiny-resolution walk, exactly like city-test: draw calls, programs and
    // triangles are resolution-independent, which is all this loop asserts.
    const RW = 320, RH = 200;
    renderer.setSize(RW, RH, false);
    glow.setSize(RW, RH, 1);
    camera.aspect = RW / RH;
    camera.updateProjectionMatrix();
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

    const stand = (p) => {
      const yaw = p.group.rotation.y;
      const r = p.radius - 0.8;
      return { x: p.pos.x + Math.sin(yaw) * r, z: p.pos.z + Math.cos(yaw) * r };
    };
    const byId = (id) => city.portals.find((p) => p.id === id);
    // The route follows the STREETS (one lane through, two side lanes) plus a
    // standing-spot detour per gate — same discipline as city-test: steering
    // straight at landmarks across plots reports the pathfinder's absence,
    // not the town's reachability.
    const route = [
      stand(byId('green-e')),
      { x: 0, z: 0 },
      { x: 0, z: -20 }, { x: 0, z: -36 }, { x: 0, z: -50 }, { x: 0, z: -20 },
      { x: -28, z: -20 }, { x: -48, z: -20 }, { x: -28, z: -20 },
      { x: 28, z: -20 }, { x: 48, z: -20 }, { x: 28, z: -20 },
      { x: 0, z: -20 }, { x: 0, z: 0 },
      { x: 0, z: 18 }, { x: -28, z: 18 }, { x: -48, z: 18 }, { x: -28, z: 18 },
      { x: 0, z: 18 }, { x: 28, z: 18 }, { x: 48, z: 18 }, { x: 28, z: 18 },
      { x: 0, z: 18 }, { x: 0, z: 34 }, { x: 0, z: 42 },
      stand(byId('end-d')),
      { x: 0, z: 42 }, { x: 0, z: 18 }, { x: 0, z: 0 },
    ];

    const calls = [];
    const tris = [];
    const camPos = new THREE.Vector3();
    const look = new THREE.Vector3();
    let leg = 0;
    let ungrounded = 0;
    let stuck = 0;
    const prev = body.pos.clone();

    const dt = 1 / 60;
    const SUB = 4;
    const frames = Math.round(seconds * 60 / SUB);

    // Warm-up before the baseline, city-test's reason verbatim: first
    // compilation is not RE-compilation.
    for (const v of [[0, 6, 30], [0, 120, 40], [-60, 8, 0], [40, 10, -40], [0, 20, -90], [60, 60, 60]]) {
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

      renderer.info.autoReset = false;
      renderer.info.reset();
      glow.render(scene, camera);
      calls.push(renderer.info.render.calls);
      tris.push(renderer.info.render.triangles);
      if (f % 10 === 0) await new Promise((r) => setTimeout(r, 0));
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
      programsStart: startPrograms,
      programsEnd: renderer.info.programs.length,
      ungrounded,
      stuck,
      legsReached: leg,
      routeLength: route.length,
      finalPos: { x: +body.pos.x.toFixed(1), z: +body.pos.z.toFixed(1) },
    };
  }, { seconds: WALK_SECONDS });

  phase('scripted walk');
  console.log(`walk ${walk.frames} frames  draws mean ${walk.callsMean} p95 ${walk.callsP95} max ${walk.callsMax}  tris mean ${walk.trisMean}`);
  console.log(`      programs ${walk.programsStart} -> ${walk.programsEnd} (threshold baseline ${baseline.programsBaseline})   legs ${walk.legsReached}/${walk.routeLength}  end ${JSON.stringify(walk.finalPos)}`);

  ok(walk.callsP95 <= DRAW_P95_LIMIT,
    `village draw calls p95 is ${walk.callsP95}, budget ${DRAW_P95_LIMIT}`);
  ok(walk.programsEnd <= walk.programsStart,
    `renderer.info.programs grew ${walk.programsStart} -> ${walk.programsEnd} during the walk (shader recompile)`);
  // The cohesion plan's per-new-area fence: the village compiles ZERO shader
  // programs Threshold had not already paid for.
  ok(walk.programsEnd <= baseline.programsBaseline,
    `the village ended at ${walk.programsEnd} programs vs Threshold's ${baseline.programsBaseline} — a new material variant snuck in`);
  ok(walk.ungrounded < walk.substeps * 0.12,
    `airborne ${walk.ungrounded}/${walk.substeps} steps — the ground is not solid under the route`);
  ok(walk.stuck < walk.substeps * 0.10,
    `wedged ${walk.stuck}/${walk.substeps} steps — geometry traps the body`);
  ok(walk.legsReached >= walk.routeLength,
    `the walk reached ${walk.legsReached} of ${walk.routeLength} waypoints — somewhere is unreachable`);

  // ------------------------------------------------------------ screenshots
  const shots = [];
  if (SHOTS) {
    const VIEWS = [
      { name: 'village-green', pos: [0, 4.6, 26], look: [0, 3.2, -6] },
      { name: 'village-lane', pos: [2.5, 3.4, -34], look: [0, 2.8, 10] },
      { name: 'village-waystation', pos: [-8, 4.2, 14], look: [-24, 2.4, 28] },
      { name: 'village-end-gate', pos: [-4, 4.4, 34], look: [8, 3.6, 48] },
      { name: 'village-aerial', pos: [-80, 78, 96], look: [0, 0, 0] },
      { name: 'village-verge-west', pos: [-70, 6, 0], look: [-160, 3, 40] },
    ];
    for (const v of VIEWS) {
      await page.evaluate(({ pos, look }) => {
        const { renderer, scene, camera, glow } = window.__vt;
        const city = window.__vt.city;
        camera.position.set(pos[0], pos[1], pos[2]);
        camera.lookAt(look[0], look[1], look[2]);
        city.update(0.016, camera.position);
        renderer.info.autoReset = false;
        renderer.info.reset();
        glow.render(scene, camera);
        window.__lastCalls = renderer.info.render.calls;
      }, v);
      const info = await page.evaluate(() => ({ calls: window.__lastCalls }));
      const p = shotPath(`${v.name}.png`);
      await page.screenshot({ path: p });
      shots.push({ name: v.name, path: p, ...info });
      console.log(`shot ${v.name.padEnd(22)} ${String(info.calls).padStart(4)} draws -> ${p}`);
    }
    phase('shots');
  }

  // -------------------------------------------------- back to Threshold
  // The seam works BOTH ways or it does not work: after the village, a
  // Threshold rebuild in the same process must come back whole — six town
  // portals, six banner districts, its own slug — with the banner list
  // following the swap.
  const back = await page.evaluate(() => {
    const { THREE, renderer, camera, quality, cityMod } = window.__vt;
    window.__vt.city.dispose();
    const scene2 = new THREE.Scene();
    const t = new cityMod.City(scene2, renderer, camera, quality);
    t.build(20260806, { level: 60 });
    const out = {
      slug: t.spec.slug,
      // B5 retarget: ways excluded — the count below is the rank ladder's.
      townPortals: t.portals.filter((p) => !p.wild && !p.way).map((p) => p.id),
      banners: cityMod.DISTRICTS.map((d) => d.id),
      sPortalZ: +(t.portals.find((p) => p.rank === 'S')?.pos.z ?? 0).toFixed(1),
      buildings: t.layoutMeta.length,
    };
    t.dispose();
    return out;
  });
  phase('threshold return');
  console.log('threshold rebuild:', JSON.stringify(back));
  ok(back.slug === 'threshold', 'the return build is not Threshold');
  ok(back.townPortals.length === 6, `Threshold rebuilt with ${back.townPortals.length} town portals`);
  ok(back.sPortalZ < -110, `Threshold's S portal is at z=${back.sPortalZ}, expected outside the north wall`);
  ok(back.banners.slice(0, 6).join(',') === 'plaza,assay,ashworks,exchange,row,breach',
    `banner list after the return is ${back.banners.join(',')}`);

  const pageErrors = errors.filter((e) => !/favicon/i.test(e));
  ok(pageErrors.length === 0, `page errors:\n${pageErrors.slice(0, 3).join('\n')}`);

  const report = {
    when: new Date().toISOString(),
    baseline, build, layout, height, holes, bounds, reach, walk, shots, back,
    limits: { DRAW_P95_LIMIT, HEIGHT_TOLERANCE, SAMPLES, WALK_SECONDS },
    failures: fail,
    warnings: warn,
  };
  const file = writeReport('village-test', report);
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
console.log('\nPASS — EMBERFALL verified');
