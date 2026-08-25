// tools/forest-test.mjs — verify THE BIRCHREACH, the forest region (Wave B4b).
//
//   node tools/forest-test.mjs [--walk-seconds 175] [--no-shots] [--headed]
//                              [--swiftshader]
//
// city-test proves Threshold, village-test proves the settlement seam; this
// proves the seam generalises past TOWNS — that the same machinery builds a
// region with zero buildings, no wall, no services and no street, whose whole
// identity is a winding track, two clearings and the trees. Cloned from
// village-test's harness pattern (itself city-test's) so all three suites
// measure with one ruler.
//
// What it asserts, and why:
//
//   * PROGRAM BASELINE VS THE CITY (the per-new-area fence): Threshold builds
//     first and is warmed until every material compiles; the forest may not
//     end above that count. The forest draws naturekit species Threshold
//     never placed, so this is also the proof that "new species" means new
//     GEOMETRY, never a new material variant.
//   * DRAW CALLS p95 on the spine walk, with the forest's own budget row
//     (measured, then fenced — see DRAW_P95_LIMIT's note).
//   * THE WALKABLE-CORRIDOR LAW, twice: statically (no registered obstacle
//     narrows the spine corridor below a body's width) and honestly — the
//     real CharacterBody walks the spine END TO END, then both branches to
//     both clearings, and every waypoint must be reached.
//   * TREES ARE REAL COLLIDERS: forest solids are in city.obstacles and
//     resolve() actually pushes a body out of them (movement honesty — a
//     forest of ghost trunks is scenery, not a region).
//   * THE HIDDEN-GATE LAW: 'wild-birchreach' (the mandated id) builds
//     hidden, stays hidden while the walk is elsewhere, and flips to
//     discovered+unhidden the moment the body reaches its clearing.
//   * The descriptor's promises hold in the BUILT world: zero buildings,
//     no wall/breach/lanterns/gardens/town-kit trees, zero town portals with
//     the 'way' slot inert, empty interactables, canopy fog/palette applied,
//     banner list following the region, heavy birch fields placed.
//   * heightAt agrees with the mesh; no holes; symmetric cliffless bounds;
//     the wild gate settles a dropped body; THRESHOLD **AND** EMBERFALL
//     descriptors deep-compare untouched afterwards, and a Threshold rebuild
//     comes back whole.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
// 175 s, not the village's 90: the route is ~1.3 km — the whole spine end to
// end plus both branch tracks out to their clearings and back.
const WALK_SECONDS = Number(arg('walk-seconds', 175));
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');
const SWIFTSHADER = argv.includes('--swiftshader');

// The forest's own budget row (Threshold 220, village 160). MEASURED on the
// full route walk: p95 landed at 132 draws (mean 120, max 136) — the forest
// trades the town's building/prop fields for ~26 always-visible naturekit
// meshes and still comes in under the village. 165 is measurement + ~25%
// headroom: loose enough for machine variance, tight enough that one species
// row whose variants explode the per-piece mesh count blows the fence.
const DRAW_P95_LIMIT = 165;
const HEIGHT_TOLERANCE = 0.05;
const SAMPLES = 200;
// The corridor law's floor: minimum clear half-width left on the spine's
// centerline after every obstacle's radius is subtracted. 0.9 = two body
// radii — a 0.45 m body passes even a worst-case pinch with a full body of
// slack. (The builder's own law is stronger — track w 3 + corridor 1.2 —
// so a failure here means a solid was placed OUTSIDE _natureSpotOk.)
const CORRIDOR_MIN_CLEAR = 0.9;

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
    canvas.id = 'foresttest';
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

    // TWO mutation canaries this time: the forest is the third settlement,
    // and a builder writing through its spec could corrupt either sibling.
    const thresholdSnapshot = JSON.stringify(settlements.THRESHOLD);
    const emberfallSnapshot = JSON.stringify(settlements.EMBERFALL);

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
    // B5 retarget: city.portals now carries waygates too (travel went live);
    // the "6 town portals" truth is the RANK ladder's, so ways are excluded.
    const thresholdPortals = city.portals.filter((p) => !p.wild && !p.way).length;
    city.dispose();

    window.__ft = {
      THREE, renderer, scene, camera, quality, glow, cityMod, settlements, kit,
      thresholdSnapshot, emberfallSnapshot,
    };
    return { kitLoaded, buildMs, programsBaseline, thresholdPortals };
  });
  phase('threshold baseline');
  console.log(`threshold: build ${baseline.buildMs} ms, programs ${baseline.programsBaseline}, portals ${baseline.thresholdPortals}`);
  ok(baseline.kitLoaded, 'citykit.glb failed to load — the world would fall back to procedural pieces');
  ok(baseline.thresholdPortals === 6, `threshold baseline built ${baseline.thresholdPortals} town portals, expected 6`);

  // ---------------------------------------------------------------- build
  const build = await page.evaluate(() => {
    const { THREE, renderer, scene, camera, quality, glow, cityMod, settlements } = window.__ft;
    const t0 = performance.now();
    const city = new cityMod.City(scene, renderer, camera, quality, settlements.THE_BIRCHREACH);
    city.build(20260806, { level: 60 });
    const buildMs = Math.round(performance.now() - t0);
    // The B6 grade row rides the shared composite — uniforms only, no program.
    glow.setGrade(settlements.THE_BIRCHREACH.palettes.grade || null);
    window.__ft.city = city;

    const spec = settlements.THE_BIRCHREACH;
    const fieldKeys = {};
    for (const f of city.stats.fields) fieldKeys[f.key] = (fieldKeys[f.key] || 0) + f.count;

    return {
      buildMs,
      slug: city.spec.slug,
      stats: (({ drawGroups, instances, triangles, buildings, portals, wildGates, density }) => (
        { drawGroups, instances, triangles, buildings, portals, wildGates, density }))(city.stats),
      portals: city.portals.map((p) => ({
        id: p.id, rank: p.rank, wild: Boolean(p.wild), hidden: Boolean(p.hidden),
        locked: Boolean(p.locked),
        pos: { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2) },
        meshes: p.group.children.length,
      })),
      hasWallMesh: Boolean(city.group.getObjectByName('city_wall')),
      breachFields: city.fields.filter((f) => /breach/.test(f.name || f.key)).length,
      // B5 retarget: the slot is live and renamed ('way-threshold' was
      // duplicated across settlements; ids are world-unique now).
      wayInDescriptor: spec.portals.placements.some((pl) => pl.kind === 'way' && pl.id === 'way-birchreach-trail'),
      wayBuilt: city.portals.filter((p) => p.way).map((p) => ({ id: p.id, to: { ...p.way } })),
      buildings: city.layoutMeta.length,
      boxes: city.boxes.length,
      interiorsPlanned: city.interiors.stats.planned,
      interactables: city.interactables.map((i) => i.id),
      banners: cityMod.DISTRICTS.map((d) => d.id),
      streets: city.streets.length,
      tracks: city.tracks.length,
      fieldKeys,
      obstacles: city.obstacles.length,
      frontier: (({ pois, wildGates, emptyFields, poiList }) => ({ pois, wildGates, emptyFields, poiList }))(city.frontier.stats),
      fog: {
        near: scene.fog?.near, far: scene.fog?.far,
        color: scene.fog ? scene.fog.color.getHex() : null,
      },
      grade: spec.palettes.grade || null,
      pointLights: (() => { let n = 0; scene.traverse((o) => { if (o.isPointLight) n++; }); return n; })(),
      spawn: (() => { const s = city.spawnPoint(); return { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) }; })(),
      thresholdUntouched: JSON.stringify(settlements.THRESHOLD) === window.__ft.thresholdSnapshot,
      emberfallUntouched: JSON.stringify(settlements.EMBERFALL) === window.__ft.emberfallSnapshot,
    };
  });
  phase('forest build');
  console.log(`birchreach build: ${build.buildMs} ms   stats ${JSON.stringify(build.stats)}`);
  console.log(`portals: ${build.portals.map((p) => `${p.id}@${p.pos.x},${p.pos.z}${p.hidden ? ' (hidden)' : ''}`).join('  ') || 'none'}`);
  console.log(`banners ${build.banners.join(',')}   obstacles ${build.obstacles}   fog ${JSON.stringify(build.fog)}`);
  console.log(`frontier pois ${JSON.stringify(build.frontier.poiList.map((p) => `${p.id}@${p.x},${p.z}`))}`);

  ok(build.slug === 'birchreach', `built settlement slug is '${build.slug}'`);
  ok(build.thresholdUntouched, 'building THE BIRCHREACH mutated the THRESHOLD descriptor — the seam leaks shared state');
  ok(build.emberfallUntouched, 'building THE BIRCHREACH mutated the EMBERFALL descriptor — the seam leaks shared state');
  ok(build.pointLights === 0, `${build.pointLights} PointLight(s) in the forest scene; the law says zero`);

  // NOT a town: zero of everything a town is made of.
  ok(build.buildings === 0, `the forest has ${build.buildings} buildings — the descriptor promises ZERO`);
  ok(build.boxes === 0, `${build.boxes} building boxes registered in a buildingless region`);
  ok(build.interiorsPlanned === 0, `${build.interiorsPlanned} enterables planned, expected 0`);
  ok(build.interactables.length === 0, `forest has interactable prompts ${build.interactables.join(',')}`);
  ok(!build.hasWallMesh, 'a city_wall mesh exists — the forest is wall-less by descriptor');
  ok(build.breachFields === 0, `${build.breachFields} breach ruin fields built in a settlement with no breach`);
  ok(build.streets === 0, `${build.streets} built streets — every Birchreach edge is class 'track'`);
  ok(build.tracks === 14, `${build.tracks} track segments, the graph authors 14 (winding spine + two branches)`);
  // The descriptor-gated town families really stood down (each would be a
  // dead draw call per frame forever in a region that can never use it).
  for (const k of ['town_lantern', 'town_hedge', 'town_fence', 'town_tree', 'town_tree_high', 'town_rock_large', 'town_rock_small', 'town_stall_red']) {
    ok(!(k in build.fieldKeys), `town family '${k}' built a field in the forest (its descriptor gate failed)`);
  }

  // The forest actually grew: the descriptor's birch rows placed at density.
  const birchCount = Object.entries(build.fieldKeys)
    .filter(([k]) => k.startsWith('birchtree_')).reduce((a, [, n]) => a + n, 0);
  ok(birchCount >= 300, `only ${birchCount} birch instances placed (rows target ~370 at density 1)`);
  for (const k of ['birchtree_2', 'birchtree_3', 'birchtree_4', 'birchtree_autumn_2', 'treestump_moss', 'plant_2']) {
    ok((build.fieldKeys[k] || 0) > 0, `forest row '${k}' placed zero instances`);
  }
  // Trees registered as REAL colliders: the obstacle list of a zero-building,
  // zero-lantern region is almost entirely forest solids (+2 dais/stamp sets).
  ok(build.obstacles >= 320, `only ${build.obstacles} obstacles registered — forest solids are missing from collision`);

  // Portals: NO rank town gates; ONE wild gate wearing the mandated id,
  // HIDDEN — plus, since B5, the trailhead WAYGATE (travel went live, so the
  // region holds 2 portals total: 1 wild + 1 way).
  ok(build.stats.portals === 2 && build.stats.wildGates === 1,
    `expected 2 portals (hidden wild + trailhead waygate), got ${build.stats.portals} (${build.stats.wildGates} wild)`);
  const wild = build.portals.find((p) => p.id === 'wild-birchreach');
  ok(Boolean(wild), "missing portal 'wild-birchreach' — the hidden clearing gate (the mandated stable id)");
  if (wild) {
    ok(wild.rank === 'E', `wild-birchreach is rank ${wild.rank}, spec says E`);
    ok(wild.hidden === true, 'wild-birchreach built UN-hidden — the forest kept nothing');
    ok(!wild.locked, 'wild-birchreach is locked at level 60 — E rank must be open');
    ok(wild.meshes === 4, `wild-birchreach has ${wild.meshes} meshes, spec says 4`);
  }
  // B5 RETARGET ("inert until B5" expired when B5 landed): the slot builds
  // the trailhead waygate now, linked reciprocally to Emberfall's end gate.
  ok(build.wayInDescriptor, "the descriptor lost its 'way-birchreach-trail' slot");
  ok(build.wayBuilt.length === 1 && build.wayBuilt[0].id === 'way-birchreach-trail'
    && build.wayBuilt[0].to.toSettlement === 'emberfall'
    && build.wayBuilt[0].to.toPortalId === 'way-emberfall-end',
  `the trailhead waygate is wrong: ${JSON.stringify(build.wayBuilt)}`);
  ok(build.frontier.pois === 2, `forest Verge has ${build.frontier.pois} POIs, spec says 2 (camp + hidden gate)`);
  for (const p of build.frontier.poiList) {
    ok(p.violations.length === 0, `POI ${p.id} breaks rules: ${p.violations.join(',')}`);
  }
  ok(build.banners.join(',') === 'trailhead,whitewood,hollow,birchen_camp,birchreach',
    `banner list is ${build.banners.join(',')} — DISTRICTS did not follow the region`);

  // Canopy mood: the descriptor's dense fog row is ON the scene, verbatim.
  ok(build.fog.near === 78 && build.fog.far === 300,
    `scene fog is ${build.fog.near}/${build.fog.far}, descriptor says 78/300 (the canopy row)`);
  ok(build.fog.color === 0xaebfa8,
    `scene fog color is 0x${(build.fog.color || 0).toString(16)}, descriptor says 0xaebfa8`);
  ok(build.grade && build.grade.vignette === 0.2, 'the region grade row is missing from the descriptor');

  // --------------------------------------------------- corridor law, static
  // Sample the SPINE edges' centerlines (the graph's first 8 edges — branch
  // termini deliberately excluded: they end INSIDE clearing pads where the
  // stamps stand their own solids). Every obstacle must leave at least
  // CORRIDOR_MIN_CLEAR of free half-width at every sample.
  const corridor = await page.evaluate(({ minClear }) => {
    const city = window.__ft.city;
    const spine = city.tracks.slice(0, 8);
    let worst = Infinity, worstAt = null;
    for (const s of spine) {
      const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
      const steps = Math.max(2, Math.ceil(len / 2));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = s.x1 + (s.x2 - s.x1) * t;
        const z = s.z1 + (s.z2 - s.z1) * t;
        for (const o of city.obstacles) {
          if (o.off) continue;
          const clear = Math.hypot(x - o.pos.x, z - o.pos.z) - o.radius;
          if (clear < worst) { worst = clear; worstAt = { x: +x.toFixed(1), z: +z.toFixed(1), r: o.radius }; }
        }
      }
    }
    return { worst: +worst.toFixed(2), worstAt, obstacles: city.obstacles.length };
  }, { minClear: CORRIDOR_MIN_CLEAR });
  phase('corridor scan');
  console.log(`spine corridor: worst clearance ${corridor.worst} m at ${JSON.stringify(corridor.worstAt)}`);
  ok(corridor.worst >= CORRIDOR_MIN_CLEAR,
    `an obstacle narrows the spine to ${corridor.worst} m clear (law: >= ${CORRIDOR_MIN_CLEAR}) at ${JSON.stringify(corridor.worstAt)}`);

  // ------------------------------------------- trees block (collider honesty)
  const block = await page.evaluate(() => {
    const { THREE } = window.__ft;
    const city = window.__ft.city;
    // Forest solids in the core: modest radii, inside the walk cap, away from
    // the trailhead — i.e. trees/stumps, not dais or stamp architecture.
    const trees = city.obstacles.filter((o) => !o.off
      && o.radius >= 0.3 && o.radius <= 1.3
      && Math.max(Math.abs(o.pos.x), Math.abs(o.pos.z)) < 120
      && Math.hypot(o.pos.x, o.pos.z) > 15).slice(0, 8);
    const out = [];
    for (const o of trees) {
      const v = new THREE.Vector3(o.pos.x, 0, o.pos.z);   // dead centre of the trunk
      city.resolve(v, 0.45);
      out.push({
        r: +o.radius.toFixed(2),
        pushed: +Math.hypot(v.x - o.pos.x, v.z - o.pos.z).toFixed(2),
      });
    }
    return out;
  });
  phase('collider honesty');
  ok(block.length >= 5, `found only ${block.length} core forest solids to probe`);
  for (const b of block) {
    ok(b.pushed >= b.r - 0.05,
      `a body resolved INSIDE a tree trunk (radius ${b.r}, pushed only ${b.pushed}) — ghost tree`);
  }

  // -------------------------------------------- heightAt vs the real mesh
  const height = await page.evaluate(({ n, half }) => {
    const { THREE, city } = { ...window.__ft, city: window.__ft.city };
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
  }, { n: SAMPLES, half: 60 });
  phase('heightAt sampling');
  console.log(`heightAt vs mesh: worst ${height.worst} over ${height.tested} points`);
  ok(height.misses === 0, `${height.misses}/${height.tested} height samples missed the forest ground mesh`);
  ok(height.worst <= HEIGHT_TOLERANCE,
    `heightAt disagrees with the rendered ground by ${height.worst} at ${JSON.stringify(height.worstAt)}`);

  // ---------------------------------------------------- no holes anywhere
  const holes = await page.evaluate(({ n }) => {
    const { THREE } = window.__ft;
    const city = window.__ft.city;
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
  const bounds = await page.evaluate(() => {
    const { THREE } = window.__ft;
    const city = window.__ft.city;
    const lim = city.spec.verge.limit;
    const probe = (x, z) => {
      const v = new THREE.Vector3(x, 0, z);
      city.resolve(v, 0.6);
      return { x: +v.x.toFixed(2), z: +v.z.toFixed(2) };
    };
    return { lim, east: probe(400, 0), west: probe(-400, 0), north: probe(0, -400), south: probe(0, 400) };
  });
  phase('resolve bounds');
  console.log(`bounds at limit ${bounds.lim}:`, JSON.stringify(bounds));
  ok(Math.abs(bounds.east.x - (bounds.lim - 0.6)) < 0.01, `east bound clamps at ${bounds.east.x}`);
  ok(Math.abs(bounds.west.x - -(bounds.lim - 0.6)) < 0.01,
    `west bound clamps at ${bounds.west.x} — a cliffless region must bound symmetrically`);
  ok(Math.abs(bounds.north.z - -(bounds.lim - 0.6)) < 0.01, `north bound clamps at ${bounds.north.z}`);
  ok(Math.abs(bounds.south.z - (bounds.lim - 0.6)) < 0.01, `south bound clamps at ${bounds.south.z}`);

  // --------------------------------------- portal settle (the wild gate)
  const reach = await page.evaluate(async () => {
    const { THREE } = window.__ft;
    const city = window.__ft.city;
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
  // The spine END TO END (the task's traversability law), then the camp
  // branch to its clearing, then the hidden-gate branch to its clearing —
  // every leg ON the graph's own nodes, so steering straight through the wood
  // would report the corridor's absence, not the region's reachability.
  const walk = await page.evaluate(async ({ seconds }) => {
    const { THREE, renderer, scene, camera, glow } = window.__ft;
    const city = window.__ft.city;
    const { CharacterBody } = await import('/src/game/physics.js');

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

    // The graph's nodes, by name — the route IS the descriptor's road data.
    const N = city.spec.streets.graph.nodes;
    const P = (name) => ({ x: N[name].x, z: N[name].z });
    const route = [
      // spine, south half out and back
      P('trail_s'), P('s1'), P('s2'), P('s3'), P('spine_s'),
      P('s3'), P('s2'), P('s1'), P('trail_s'),
      // spine, north half out — END TO END is spine_s (above) to spine_n
      P('trail_n'), P('n1'), P('n2'), P('n3'), P('spine_n'),
      // back up to the camp branch and out to the camp clearing's rim
      P('n3'), P('n2'), P('n1'), P('c1'), P('c2'),
      // 10 m short of the camp's AUTHORED centre — deep inside the 24 m
      // discovery ring even against the +-7 m seeded jitter and the 3.2 m
      // waypoint slop (the first cut stood at 176,-58 and this seed's jitter
      // put the ring's far edge 24.5 m away: discovered false, measured).
      { x: 186, z: -60 },
      P('c2'), P('c1'), P('n1'), P('trail_n'),
      // down to the hidden-gate branch and out to ITS clearing
      P('trail_s'), P('s1'), P('s2'), P('s3'), P('w1'), P('w2'),
      { x: -66, z: 186 },                       // inside the hidden gate's ring
      P('w2'), P('w1'), P('s3'),
    ];

    // The hidden law, mid-walk: before the body has been anywhere near the
    // south-west clearing, the gate must still be hidden.
    const hiddenAtStart = Boolean(city.portals.find((p) => p.id === 'wild-birchreach')?.hidden);

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

      // city.update drives frontier.update, which is what flips POI
      // discovery — the walk exercises the REAL discovery path.
      city.update(dt * SUB, body.pos);

      renderer.info.autoReset = false;
      renderer.info.reset();
      glow.render(scene, camera);
      calls.push(renderer.info.render.calls);
      tris.push(renderer.info.render.triangles);
      if (f % 10 === 0) await new Promise((r) => setTimeout(r, 0));
      if (leg >= route.length) break;
    }
    city.key.shadow.mapSize.set(shadowSize, shadowSize);
    if (city.key.shadow.map) { city.key.shadow.map.dispose(); city.key.shadow.map = null; }
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    glow.setSize(window.innerWidth, window.innerHeight, 1);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    const gate = city.portals.find((p) => p.id === 'wild-birchreach');
    const pois = city.frontier.pois.map((p) => ({ id: p.id, discovered: p.discovered }));

    const pct = (arr, p) => {
      const a = [...arr].sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(a.length * p))];
    };
    return {
      frames: calls.length,
      substeps: calls.length * SUB,
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
      hiddenAtStart,
      hiddenAtEnd: Boolean(gate?.hidden),
      pois,
    };
  }, { seconds: WALK_SECONDS });

  phase('scripted walk');
  console.log(`walk ${walk.frames} frames  draws mean ${walk.callsMean} p95 ${walk.callsP95} max ${walk.callsMax}  tris mean ${walk.trisMean}`);
  console.log(`      programs ${walk.programsStart} -> ${walk.programsEnd} (threshold baseline ${baseline.programsBaseline})   legs ${walk.legsReached}/${walk.routeLength}  end ${JSON.stringify(walk.finalPos)}`);
  console.log(`      hidden gate: at start ${walk.hiddenAtStart}, at end ${walk.hiddenAtEnd}   pois ${JSON.stringify(walk.pois)}`);

  ok(walk.callsP95 <= DRAW_P95_LIMIT,
    `forest draw calls p95 is ${walk.callsP95}, budget ${DRAW_P95_LIMIT}`);
  ok(walk.programsEnd <= walk.programsStart,
    `renderer.info.programs grew ${walk.programsStart} -> ${walk.programsEnd} during the walk (shader recompile)`);
  ok(walk.programsEnd <= baseline.programsBaseline,
    `the forest ended at ${walk.programsEnd} programs vs Threshold's ${baseline.programsBaseline} — a new material variant snuck in`);
  ok(walk.ungrounded < walk.substeps * 0.12,
    `airborne ${walk.ungrounded}/${walk.substeps} steps — the ground is not solid under the route`);
  ok(walk.stuck < walk.substeps * 0.10,
    `wedged ${walk.stuck}/${walk.substeps} steps — geometry traps the body on the tracks`);
  ok(walk.legsReached >= walk.routeLength,
    `the walk reached ${walk.legsReached} of ${walk.routeLength} waypoints — the spine or a branch is not traversable`);
  // The hidden-gate law, proven by the walk itself.
  ok(walk.hiddenAtStart, 'the gate was already un-hidden before the walk began');
  ok(!walk.hiddenAtEnd, 'the walk reached the clearing but the gate is STILL hidden — discovery never cleared portal.hidden');
  for (const p of walk.pois) {
    ok(p.discovered, `POI ${p.id} was walked to but never discovered`);
  }

  // ------------------------------------------------------------ screenshots
  const shots = [];
  if (SHOTS) {
    const VIEWS = [
      { name: 'forest-trailhead', pos: [7, 4.4, 20], look: [0, 3, -10] },
      { name: 'forest-spine', pos: [2, 3.6, 44], look: [-8, 2.8, 20] },
      { name: 'forest-whitewood', pos: [-2, 4.2, -56], look: [-14, 3, -78] },
      { name: 'forest-camp-branch', pos: [40, 4.5, -40], look: [70, 3, -46] },
      { name: 'forest-hidden-gate', pos: [-52, 5, 172], look: [-70, 3.4, 198] },
      { name: 'forest-aerial', pos: [-90, 90, 110], look: [0, 0, 0] },
    ];
    for (const v of VIEWS) {
      await page.evaluate(({ pos, look }) => {
        const { renderer, scene, camera, glow } = window.__ft;
        const city = window.__ft.city;
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
  const back = await page.evaluate(() => {
    const { THREE, renderer, camera, quality, cityMod } = window.__ft;
    window.__ft.city.dispose();
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
    baseline, build, corridor, block, height, holes, bounds, reach, walk, shots, back,
    limits: { DRAW_P95_LIMIT, HEIGHT_TOLERANCE, SAMPLES, WALK_SECONDS, CORRIDOR_MIN_CLEAR },
    failures: fail,
    warnings: warn,
  };
  const file = writeReport('forest-test', report);
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
console.log('\nPASS — THE BIRCHREACH verified');
