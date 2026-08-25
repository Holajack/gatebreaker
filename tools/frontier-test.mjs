// tools/frontier-test.mjs — verify THE VERGE (WORLD_SPEC steps 5 and 6).
//
//   node tools/frontier-test.mjs [--no-shots] [--headed] [--swiftshader]
//
// What it asserts, and why each one is here rather than "it looked fine":
//
//   * SEAM CONTINUITY. |cityField - frontierField| across the blend band on a
//     64-point ring, plus a denser sweep, plus the thing that actually matters:
//     City.heightAt is CONTINUOUS as you cross r = 170. The naive two-field
//     build disagrees by 0.46 m on the Breach gradient — a ledge you walk off.
//   * WALK LIMITS. A body dropped at (0, -200) stands on ground and stays put;
//     a body walked north from the plaza reaches past the OLD 134 m wall and is
//     stopped near 258; the west cliff clamp holds both inside the wall and
//     200 m north of it, which is the void gap the citymode VOID_Y comment
//     documents.
//   * NO HOLES out to the Verge bound: 400 sampled positions all have ground.
//   * BUDGET. Triangles and draw groups against the RECORDED city-only
//     baseline, and zero PointLights anywhere in the scene graph — the
//     overworld.js regression this wave deleted the file to prevent.
//   * DISPOSAL. Build, dispose and rebuild three times: geometry and texture
//     counts must come back to where they started.
//
// Screenshots (E / S / N / edge / aerial) are written to GB_OUT for the human
// pass; they are the point of step 6 and no assert can replace looking.

import fs from 'node:fs';
import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
  forceOpenGates,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');
// Same reasoning as city-test: a ~800k-triangle world through a software
// rasteriser costs about a second a frame. Everything asserted here is
// backend-independent; only the pixels differ and the pixels are for a human.
const SWIFTSHADER = argv.includes('--swiftshader');

// The town on its own (`opts.frontier: false`, high tier, level 60), which is
// what everything below measures the Verge AGAINST.
//
// Re-recorded at WORLD_SPEC step 8: the previous numbers (384354 / 93) were
// the town as "The Depths" left it, and step 8 deliberately rebuilt the
// skyline — district height profiles, a 5-storey spire, and the roof_high /
// left / right families that close the gable ends. The town is 424104 tris and
// 102 draw groups now, +10.3% and +9, both inside step 8's own +20% / +30
// acceptance. Moving a baseline is not the same as loosening a budget: the
// ratio below went DOWN at the same time.
//
// Re-recorded AGAIN at WORLD_SPEC step 9, and for the same kind of reason: the
// five enterable service buildings are new town geometry that the layout grid
// makes room for, so the town changed on purpose. 424104 -> 450784 tris
// (+6.3%) and 102 -> 104 draw groups (+2: one merged shell, one merged cap for
// all five). Six procedural buildings gave up their plots; the interiors cost
// ~43k triangles including floors, furniture and both storeys of wall.
//
// Re-recorded at Wave B2+B3 TOGETHER (the two agents landed in one tree, so
// the B2-only interim record of 451722/104 never matched a buildable state):
// B2 (gates into the districts) re-hangs the rank flags per-district and adds
// portal keep-outs to _blockedForProp (+938 tris of shifted street furniture);
// B3 (doors that don't lie) swaps every sealed building's painted-shut
// town_wall_door (376 tris) for town_wall_doorway_base (64) plus the shared
// city_door_voids InstancedMesh (~-310 tris per sealed building net), and the
// voids field adds draw groups. 450784 -> 432622 tris; groups 104 -> 108.
//
// Re-recorded at Wave B5 (waygates): Threshold's descriptor gained ONE
// kind:'way' placement beside the north gate, now built as a live portal.
// The delta is exactly one portal: +240 triangles (PORTAL_TRIANGLES, the
// four-mesh visual on the shared geometry set) and +4 draw groups (dais /
// oval / ring / marker — portals are deliberately not instanced, each
// animates its own materials). 432622 -> 432862; 108 -> 112.
const BASELINE = { triangles: 432862, drawGroups: 112 };
// The Verge roughly doubles the world, and STEP 7's POI stamps add ~100k on top
// of step 6's scatter. This ratio is an inventory guard against an accidental
// blowup, NOT the per-frame cost: POI stamps are merged meshes with tight
// bounding spheres and are frustum-culled from everywhere they are not. The
// global scatter fields, which are never culled, are what the eye-level figure
// below measures.
//
// 2.30, down from the 2.45 step 7 had to raise it to. Step 7 raised the RATIO
// because the denominator was stale, not because the Verge grew: against the
// re-recorded town the same world is 2.23x, so the guard fits again with 3%
// of headroom. Absolute ceiling: 975k tris, against step 7's 942k.
const TRI_BUDGET = 2.30;

const DRAW_LIMIT = 220;       // same ceiling city-test holds the walk to

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

  // ------------------------------------------------------------------ build
  const build = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const cityMod = await import('/src/world/city.js');
    const frontierMod = await import('/src/world/frontier.js');
    const kit = await import('/src/world/citykit.js');
    const nature = await import('/src/world/naturekit.js');
    const { Quality } = await import('/src/core/quality.js');

    await kit.loadCityKit();
    const natureLoaded = await nature.loadNatureKit();

    const canvas = document.createElement('canvas');
    canvas.id = 'frontiertest';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999';
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.6, 900);
    const quality = new Quality({ startTier: 'high' });

    // THE OPT-OUT CITY IS BUILT FIRST, and that ordering is load-bearing.
    // citizens.js hands the SECOND City built in a page a different mix of
    // skinned and procedural bodies (measured: 93 draw groups for the first
    // build, 128 for an otherwise identical second one). That is pre-existing
    // behaviour and nothing to do with the Verge, but it means only the first
    // build in a page is comparable to the recorded city-test baseline.
    const sceneB = new THREE.Scene();
    const cityB = new cityMod.City(sceneB, renderer, camera, quality);
    cityB.build(20260806, { level: 60 }, { frontier: false });
    const noFrontierStats = cityB.stats;
    const noFrontierField = {
      // the shipped lip must still be there when nobody asked for a Verge
      at150: +cityB.field.height(0, -150).toFixed(2),
      at168: +cityB.field.height(0, -168).toFixed(2),
      limit: (() => {
        const p = new THREE.Vector3(0, 0, -400);
        cityB.resolve(p, 0.45);
        return +p.z.toFixed(2);
      })(),
    };
    cityB.dispose();

    const t0 = performance.now();
    const city = new cityMod.City(scene, renderer, camera, quality);
    city.build(20260806, { level: 60 });
    const buildMs = performance.now() - t0;

    window.__vg = {
      THREE, renderer, scene, camera, city, cityMod, frontierMod, quality,
    };
    return {
      natureLoaded,
      buildMs: Math.round(buildMs),
      stats: city.stats,
      hasFrontier: !!city.frontier,
      vergeLimit: frontierMod.VERGE_LIMIT,
      poiMinR: frontierMod.POI_MIN_R,
      noFrontierStats: {
        triangles: noFrontierStats.triangles,
        drawGroups: noFrontierStats.drawGroups,
        frontier: noFrontierStats.frontier,
      },
      noFrontierField,
    };
  });

  phase('build');
  console.log('stats:', JSON.stringify(build.stats.frontier));
  console.log(`city+verge: ${build.stats.triangles} tris / ${build.stats.drawGroups} groups`
    + `   city only: ${build.noFrontierStats.triangles} / ${build.noFrontierStats.drawGroups}`
    + `   build ${build.buildMs} ms`);

  ok(build.hasFrontier, 'City.build did not construct a Frontier by default');
  ok(build.natureLoaded, 'nature.glb failed to load — the Verge fell back to procedural tufts');
  ok(build.vergeLimit === 258, `VERGE_LIMIT is ${build.vergeLimit}, spec says 258`);
  ok(build.noFrontierStats.frontier === null,
    'opts.frontier:false still built a Frontier');
  // The opt-out path must reproduce the recorded city EXACTLY. Anything else
  // means the shared groundBase/HeightField refactor moved the town.
  ok(build.noFrontierStats.triangles === BASELINE.triangles,
    `opts.frontier:false built ${build.noFrontierStats.triangles} tris, baseline is ${BASELINE.triangles}`);
  ok(build.noFrontierStats.drawGroups === BASELINE.drawGroups,
    `opts.frontier:false built ${build.noFrontierStats.drawGroups} draw groups, baseline is ${BASELINE.drawGroups}`);
  // The opt-out must reproduce the SHIPPED world edge, not a half-migrated one.
  ok(build.noFrontierField.at168 < -30,
    `without a Verge the world must still fall away by r=168; got y=${build.noFrontierField.at168}`);
  ok(Math.abs(build.noFrontierField.limit + 134) < 1.0,
    `without a Verge the walk limit must stay 134; body stopped at z=${build.noFrontierField.limit}`);

  // ------------------------------------------------------- seam continuity
  const seam = await page.evaluate(() => {
    const { city } = window.__vg;
    const f = city.frontier;
    const out = { ring: [], worstRing: 0, worstRingAt: null, worstSweep: 0, worstSweepAt: null, jump: 0, jumpAt: null };

    // The spec's assertion: a 64-point ring across the blend band. Radii are
    // 162/166/170 rather than 166/170/174 for the reason city.js documents at
    // BLEND_R0 — the city field HAS NO DATA past 170, so comparing the two
    // fields out there compares a real surface against a clamped edge value.
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const m = Math.max(Math.abs(ca), Math.abs(sa));
      for (const r of [162, 166, 170]) {
        const x = (r * ca) / m, z = (r * sa) / m;
        if (x < -88) continue;                  // the cliff void is not ground
        const d = Math.abs(city.field.height(x, z) - f.heightAt(x, z));
        if (d > out.worstRing) { out.worstRing = d; out.worstRingAt = { x: +x.toFixed(1), z: +z.toFixed(1), r }; }
      }
    }

    // Denser sweep over the whole overlap, since a 64-point ring can miss.
    for (let r = 156; r <= 170; r += 0.5) {
      for (let k = 0; k < 360; k++) {
        const a = (k / 360) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const m = Math.max(Math.abs(ca), Math.abs(sa));
        const x = (r * ca) / m, z = (r * sa) / m;
        if (x < -88) continue;
        const d = Math.abs(city.field.height(x, z) - f.heightAt(x, z));
        if (d > out.worstSweep) { out.worstSweep = d; out.worstSweepAt = { x: +x.toFixed(1), z: +z.toFixed(1) }; }
      }
    }

    // What the player actually feels: heightAt as a continuous function while
    // walking outward across the seam, in 0.25 m steps.
    for (let k = 0; k < 240; k++) {
      const a = (k / 240) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const m = Math.max(Math.abs(ca), Math.abs(sa));
      let prev = null;
      for (let r = 150; r <= 200; r += 0.25) {
        const x = (r * ca) / m, z = (r * sa) / m;
        if (x < -88) { prev = null; continue; }
        const h = city.heightAt(x, z);
        if (prev != null) {
          const j = Math.abs(h - prev);
          if (j > out.jump) { out.jump = j; out.jumpAt = { x: +x.toFixed(1), z: +z.toFixed(1) }; }
        }
        prev = h;
      }
    }
    return out;
  });
  phase('seam continuity');
  console.log(`seam: ring worst ${seam.worstRing.toFixed(4)} m   sweep worst ${seam.worstSweep.toFixed(4)} m`
    + `   max step per 0.25 m of walk ${seam.jump.toFixed(4)} m`);
  ok(seam.worstRing < 0.25,
    `blend-band ring disagreement ${seam.worstRing.toFixed(3)} m at ${JSON.stringify(seam.worstRingAt)} (limit 0.25)`);
  ok(seam.worstSweep < 0.25,
    `overlap sweep disagreement ${seam.worstSweep.toFixed(3)} m at ${JSON.stringify(seam.worstSweepAt)} (limit 0.25)`);
  ok(seam.jump < 0.35,
    `heightAt jumps ${seam.jump.toFixed(3)} m in one 0.25 m step at ${JSON.stringify(seam.jumpAt)} — the seam is a ledge`);

  // -------------------------------------------------- heightAt vs the mesh
  const mesh = await page.evaluate(() => {
    const { THREE, city } = window.__vg;
    const ray = new THREE.Raycaster();
    ray.far = 900;
    const down = new THREE.Vector3(0, -1, 0);
    const o = new THREE.Vector3();
    const target = city.frontier.ground;
    let seed = 24680;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let worst = 0, worstAt = null, misses = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      // Only where the frontier mesh is the VISIBLE surface: past the city rim,
      // inside the world edge, east of the cliff.
      const a = rnd() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const m = Math.max(Math.abs(ca), Math.abs(sa));
      const r = 180 + rnd() * 78;
      const x = (r * ca) / m, z = (r * sa) / m;
      if (x < -88) continue;
      n++;
      const h = city.heightAt(x, z);
      o.set(x, h + 80, z);
      ray.set(o, down);
      const hit = ray.intersectObject(target, false);
      if (!hit.length) { misses++; continue; }
      const d = Math.abs(hit[0].point.y - h);
      if (d > worst) { worst = d; worstAt = { x: +x.toFixed(1), z: +z.toFixed(1) }; }
    }
    // The seam skirt, measured rather than asserted from the source: over the
    // rim band the frontier mesh must sit AT or BELOW the walkable surface —
    // never above it, which is what would poke through the city ground mesh.
    let rimMin = Infinity, rimMax = -Infinity;
    for (let i = 0; i < 400; i++) {
      const a = rnd() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const m = Math.max(Math.abs(ca), Math.abs(sa));
      const r = 158 + rnd() * 20;
      const x = (r * ca) / m, z = (r * sa) / m;
      if (x < -88) continue;
      const h = city.heightAt(x, z);
      o.set(x, h + 80, z);
      ray.set(o, down);
      const hit = ray.intersectObject(target, false);
      if (!hit.length) continue;
      const gap = h - hit[0].point.y;   // +ve = mesh is below the surface
      if (gap < rimMin) rimMin = gap;
      if (gap > rimMax) rimMax = gap;
    }
    return {
      n, misses, worst: +worst.toFixed(5), worstAt,
      rimMin: +rimMin.toFixed(4), rimMax: +rimMax.toFixed(4),
    };
  });
  phase('heightAt vs frontier mesh');
  console.log(`frontier heightAt vs mesh: worst ${mesh.worst} over ${mesh.n} points (${mesh.misses} misses)`);
  ok(mesh.misses === 0, `${mesh.misses}/${mesh.n} Verge samples have no ground mesh under them`);
  ok(mesh.worst <= 0.05,
    `frontier heightAt disagrees with its rendered mesh by ${mesh.worst} at ${JSON.stringify(mesh.worstAt)}`);
  console.log(`seam skirt over r 158..178: mesh sits ${mesh.rimMin} .. ${mesh.rimMax} m below the walkable surface`);
  ok(mesh.rimMin >= -0.002,
    `the frontier mesh rises ${(-mesh.rimMin).toFixed(3)} m ABOVE the walkable surface at the seam — it will poke through the city ground`);
  ok(mesh.rimMax <= 1.25,
    `the seam skirt sinks ${mesh.rimMax} m, deeper than the 1.2 m it is built for`);

  // ------------------------------------------------------------ walk limits
  const walk = await page.evaluate(async () => {
    const { THREE, city } = window.__vg;
    const { CharacterBody } = await import('/src/game/physics.js');
    const body = new CharacterBody({ radius: 0.45 });
    body.setEnvironment(
      (x, z) => city.heightAt(x, z),
      city.resolve.bind(city),
      (x, z, out) => city.groundNormal(x, z, out),
    );

    // 1. Dropped out on the Verge, 200 m north: does he land and stay?
    body.reset(0, city.heightAt(0, -200) + 3, -200);
    for (let i = 0; i < 240; i++) body.step(1 / 60);
    const drop = {
      grounded: body.grounded,
      y: +body.pos.y.toFixed(2),
      groundY: +city.heightAt(body.pos.x, body.pos.z).toFixed(2),
      drift: +Math.hypot(body.pos.x - 0, body.pos.z + 200).toFixed(2),
      finite: Number.isFinite(body.pos.y),
    };

    // 2. Walk north out of the gate, past the Breach, until he stops.
    //
    // Not a straight push: a body driven dead-on into a round prop is pushed
    // straight back out and stalls forever with no lateral component to slide
    // on. (The first cut of this test started on the plaza and spent 90 s
    // wedged against the fountain, reporting "the 134 m wall is still there".)
    // So: steer toward a far target, and when 2 s of walking buys less than
    // half a metre, strafe for a second — the same thing a player's thumb does.
    const walkTo = (sx, sz, tx, tz, seconds) => {
      body.reset(sx, city.heightAt(sx, sz), sz);
      let minY = Infinity;
      let markX = sx, markZ = sz;
      let strafe = 0;
      let side = 1;
      const trail = [];
      const steps = Math.round(60 * seconds);
      for (let i = 0; i < steps; i++) {
        let dx = tx - body.pos.x;
        let dz = tz - body.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        if (strafe > 0) { const t = dx; dx = -dz * side; dz = t * side; strafe--; }
        body.move(dx, dz, 1);
        body.step(1 / 60);
        if (body.pos.y < minY) minY = body.pos.y;
        if (i > 0 && i % 120 === 0) {
          if (Math.hypot(body.pos.x - markX, body.pos.z - markZ) < 0.5 && strafe === 0) {
            strafe = 45;
            side = -side;
          }
          markX = body.pos.x; markZ = body.pos.z;
        }
        if (i % 900 === 0) trail.push(`${body.pos.x.toFixed(0)},${body.pos.z.toFixed(0)}`);
      }
      return {
        x: +body.pos.x.toFixed(2),
        z: +body.pos.z.toFixed(2),
        minY: +minY.toFixed(2),
        grounded: body.grounded,
        trail,
      };
    };

    const north = walkTo(0, -40, 0, -320, 110);
    // 3. Walk east, same idea, no Breach bump in the way.
    const east = walkTo(20, 0, 320, 0, 110);

    // 4. The west cliff fence, inside the wall AND far north of it — the gap
    //    the citymode VOID_Y comment says used to let you stroll off.
    const west = [];
    for (const z of [0, -60, -140, -200, -240, 140, 200]) {
      const p = new THREE.Vector3(-88 - 5, 0, z);
      city.resolve(p, 0.45);
      west.push({ z, x: +p.x.toFixed(2), pushed: p.x > -88 });
    }
    // 5. And walked into, not just resolved: hold west for 20 s from the road.
    body.reset(-40, city.heightAt(-40, -180), -180);
    let westMinY = Infinity;
    for (let i = 0; i < 60 * 20; i++) {
      body.move(-1, 0, 1);
      body.step(1 / 60);
      if (body.pos.y < westMinY) westMinY = body.pos.y;
    }
    const westWalk = { x: +body.pos.x.toFixed(2), minY: +westMinY.toFixed(2) };

    return { drop, north, east, west, westWalk };
  });
  phase('walk limits');
  console.log(`drop@(0,-200): grounded=${walk.drop.grounded} y=${walk.drop.y} ground=${walk.drop.groundY} drift=${walk.drop.drift}`);
  console.log(`north walk -> z=${walk.north.z} x=${walk.north.x} (minY ${walk.north.minY})  trail ${walk.north.trail.join(' > ')}`);
  console.log(`east  walk -> x=${walk.east.x} z=${walk.east.z} (minY ${walk.east.minY})  trail ${walk.east.trail.join(' > ')}`);
  console.log(`west fence -> ${walk.west.map((w) => `${w.z}:${w.x}`).join(' ')}   walked west -> x=${walk.westWalk.x} minY=${walk.westWalk.minY}`);

  ok(walk.drop.finite && walk.drop.grounded, 'a body dropped at (0,-200) never settled on the Verge');
  ok(Math.abs(walk.drop.y - walk.drop.groundY) < 0.12,
    `body at (0,-200) rests ${(walk.drop.y - walk.drop.groundY).toFixed(2)} m off the ground`);
  ok(walk.north.z < -200, `walking north stopped at z=${walk.north.z} — the old 134 m wall is still there`);
  ok(walk.north.z > -259, `walking north escaped past the Verge bound to z=${walk.north.z}`);
  ok(walk.north.minY > -20, `walking north fell to y=${walk.north.minY} — there is a hole on the Breach road`);
  ok(walk.east.x > 200 && walk.east.x < 259, `walking east ended at x=${walk.east.x}, expected ~258`);
  for (const w of walk.west) {
    ok(w.pushed, `west cliff clamp missing at z=${w.z}: resolve left x=${w.x}`);
  }
  ok(walk.westWalk.x > -90, `walked off the west cliff at z=-180: ended x=${walk.westWalk.x}`);
  ok(walk.westWalk.minY > -20, `walking west fell to y=${walk.westWalk.minY} — the void gap is not fenced`);

  // -------------------------------------------------------------- no holes
  const holes = await page.evaluate(() => {
    const { THREE, city } = window.__vg;
    const ray = new THREE.Raycaster();
    ray.far = 900;
    const down = new THREE.Vector3(0, -1, 0);
    const o = new THREE.Vector3();
    let seed = 13579;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const meshes = [city.ground, city.frontier.ground];
    const bad = [];
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const x = (rnd() * 2 - 1) * 256;
      const z = (rnd() * 2 - 1) * 256;
      if (x < -86) continue;               // west of the cliff is the void
      n++;
      o.set(x, 500, z);
      ray.set(o, down);
      if (!ray.intersectObjects(meshes, false).length) bad.push({ x: +x.toFixed(1), z: +z.toFixed(1) });
    }
    return { n, bad };
  });
  phase('hole sampling');
  ok(holes.bad.length === 0,
    `${holes.bad.length}/${holes.n} Verge positions have no ground: ${JSON.stringify(holes.bad.slice(0, 5))}`);

  // ------------------------------------------------- budget + light hygiene
  const budget = await page.evaluate(() => {
    const { scene, city, renderer, camera } = window.__vg;
    let pointLights = 0, dirLights = 0, hemis = 0, shadowCasters = 0;
    scene.traverse((o) => {
      if (o.isPointLight) pointLights++;
      if (o.isDirectionalLight) { dirLights++; if (o.castShadow) shadowCasters++; }
      if (o.isHemisphereLight) hemis++;
      if (o.isSpotLight) pointLights++;     // same program-key problem
    });
    // Draw calls from the one framing that sees the most of the Verge at once.
    camera.position.set(0, 96, 150);
    camera.lookAt(0, 0, -40);
    camera.updateMatrixWorld();
    renderer.info.reset();
    renderer.render(scene, camera);
    const aerial = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    camera.position.set(0, 3, -150);
    camera.lookAt(0, 2, -240);
    camera.updateMatrixWorld();
    renderer.info.reset();
    renderer.render(scene, camera);
    const eye = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    return {
      pointLights, dirLights, hemis, shadowCasters, aerial, eye,
      programs: renderer.info.programs.length,
      frontier: city.frontier.stats,
    };
  });
  phase('budget + lights');
  console.log(`lights: point=${budget.pointLights} dir=${budget.dirLights} hemi=${budget.hemis} shadowCasters=${budget.shadowCasters}`);
  console.log(`draws: aerial ${budget.aerial.calls} calls / ${budget.aerial.tris} tris   eye ${budget.eye.calls} / ${budget.eye.tris}`);
  console.log(`frontier: ${JSON.stringify(budget.frontier)}`);

  ok(budget.pointLights === 0, `${budget.pointLights} PointLights in the scene — the overworld.js regression is back`);
  ok(budget.dirLights === 1, `${budget.dirLights} DirectionalLights, spec says exactly 1`);
  ok(budget.hemis === 1, `${budget.hemis} HemisphereLights, spec says exactly 1`);
  ok(budget.shadowCasters === 1, `${budget.shadowCasters} shadow-casting lights, spec says exactly 1`);

  const triRatio = build.stats.triangles / BASELINE.triangles;
  ok(triRatio <= TRI_BUDGET,
    `world is ${build.stats.triangles} tris, ${triRatio.toFixed(2)}x the recorded ${BASELINE.triangles} baseline (budget ${TRI_BUDGET}x)`);
  ok(budget.aerial.calls <= DRAW_LIMIT,
    `the widest Verge framing costs ${budget.aerial.calls} draw calls (limit ${DRAW_LIMIT})`);
  ok(budget.eye.calls <= DRAW_LIMIT,
    `an eye-level Verge framing costs ${budget.eye.calls} draw calls (limit ${DRAW_LIMIT})`);
  ok(budget.frontier.solids > 200,
    `only ${budget.frontier.solids} Verge solids became colliders — the scatter did not place`);
  // A species whose placement predicate can never be satisfied is invisible in
  // every screenshot and costs its draw calls forever. Three of them shipped in
  // the first cut of the table (slope-gated, on terrain whose steepest point is
  // 0.042) and only a per-field instance count found them.
  ok(budget.frontier.emptyFields.length === 0,
    `species placed ZERO instances and were dropped: ${budget.frontier.emptyFields.join(', ')} — fix the table, do not rely on the drop`);

  // ----------------------------------------------------------- POI plumbing
  const poi = await page.evaluate(() => {
    const { THREE, city } = window.__vg;
    const f = city.frontier;
    const seen = [];
    f.onDiscover = (p) => seen.push(p.id);
    // Step 7 fills f.pois; the mechanism has to work before it does, or the
    // step-7 agent debugs two things at once.
    f.pois.push({ id: 'probe', pos: { x: 0, z: -210 }, radius: 14, discovered: false });
    const far = new THREE.Vector3(0, 0, -150);
    const near = new THREE.Vector3(0, 0, -206);
    f.update(0.016, far);
    const beforeCount = seen.length;
    f.update(0.016, near);
    f.update(0.016, near);
    const after = seen.slice();
    // Remove ONLY the probe. `f.pois.length = 0` was fine while step 7 had not
    // landed and is a booby trap now: it deletes the seven real POIs and every
    // assertion after this point silently measures an empty Verge.
    f.pois.pop();
    f.onDiscover = null;
    return { beforeCount, after, poisLeft: f.pois.length };
  });
  phase('POI discovery plumbing');
  ok(poi.beforeCount === 0, 'a POI fired its discovery hook from 60 m away');
  ok(poi.after.length === 1 && poi.after[0] === 'probe',
    `POI discovery fired ${poi.after.length} times, expected exactly once (${JSON.stringify(poi.after)})`);
  ok(poi.poisLeft === 7, `the discovery probe left ${poi.poisLeft} real POIs behind, expected 7`);

  // ------------------------------------------------- STEP 7: POIs + gates
  //
  // The rules in WORLD_SPEC.frontier.poiRules, checked against the BUILT
  // positions rather than the authored anchors — the placement pass jitters
  // them on a seeded stream, and a jitter that quietly breaks a rule is exactly
  // the kind of thing that only shows up as a tree growing through a wall.
  const stamps = await page.evaluate(() => {
    const { city, cityMod } = window.__vg;
    const f = city.frontier;
    const wilds = city.portals.filter((p) => p.wild);
    const solidsNear = (x, z, r) => city.obstacles.filter(
      (o) => Math.hypot(o.pos.x - x, o.pos.z - z) < r,
    ).length;
    return {
      poiList: f.stats.poiList,
      districts: cityMod.DISTRICTS.map((d) => d.id),
      meshNames: (() => {
        const n = [];
        f.group.traverse((o) => { if (o.isMesh && /^poi_|campfire/.test(o.name)) n.push(o.name); });
        return n;
      })(),
      wilds: wilds.map((p) => ({
        rank: p.rank,
        wild: p.wild,
        locked: p.locked,
        radius: p.radius,
        meshes: Object.keys(p.meshes || {}).length,
        children: p.group.children.length,
        x: +p.pos.x.toFixed(2),
        y: +p.pos.y.toFixed(2),
        z: +p.pos.z.toFixed(2),
        groundY: +city.heightAt(p.pos.x, p.pos.z).toFixed(2),
        gateName: p.gate?.name ?? null,
        solids: solidsNear(p.pos.x, p.pos.z, 12),
        // The whole reason wild gates live in city.portals.
        portalAtIsMe: city.portalAt({ x: p.pos.x + 1, y: 0, z: p.pos.z }) === p,
        nearestIsMe: city.nearestPortal({ x: p.pos.x + 1, y: 0, z: p.pos.z })?.portal === p,
      })),
      // Every stamp has to be reachable ON FOOT: resolve() must leave a body
      // standing at the POI centre exactly where it was put.
      standable: f.pois.map((p) => {
        const v = { x: p.pos.x, y: 0, z: p.pos.z + 12 };
        city.resolve(v, 0.45);
        return { id: p.id, drift: +Math.hypot(v.x - p.pos.x, v.z - (p.pos.z + 12)).toFixed(3) };
      }),
    };
  });
  phase('POI stamps + wild gates');
  console.log('POIs:', stamps.poiList.map((p) => `${p.id}@${p.x},${p.z}`).join('  '));
  console.log('wild gates:', JSON.stringify(stamps.wilds));

  ok(stamps.poiList.length === 7, `the Verge built ${stamps.poiList.length} POIs, spec lists 7`);
  for (const p of stamps.poiList) {
    ok(p.violations.length === 0, `POI ${p.id} breaks poiRules: ${p.violations.join(', ')}`);
  }
  for (const id of ['verge_ruin_arch', 'verge_ruin_hall', 'verge_watchtower',
    'camp_hunters_east', 'camp_farmstead', 'wildgate_e', 'wildgate_c']) {
    ok(stamps.poiList.some((p) => p.id === id), `POI "${id}" from the spec is missing`);
  }
  // Every non-gate POI must have actually put geometry in the world; a POI that
  // stamps nothing is a banner over an empty field.
  for (const p of stamps.poiList) {
    ok(stamps.meshNames.includes(`poi_${p.id}`), `POI ${p.id} stamped no geometry`);
  }
  ok(stamps.meshNames.includes('verge_campfire'), 'the hunters camp has no campfire');
  ok(stamps.poiList.find((p) => p.id === 'camp_hunters_east')?.npcAnchors === 2,
    'camp_hunters_east should expose 2 NPC anchors for citizens.js');
  for (const s of stamps.standable) {
    ok(s.drift < 0.001, `a body 12 m from ${s.id} is pushed ${s.drift} m by resolve() — the pad is not walkable`);
  }

  // Discovery: the POIs join the district banner list and leave it on dispose.
  for (const p of stamps.poiList) {
    ok(stamps.districts.includes(p.id), `POI ${p.id} registered no discovery banner`);
  }
  ok(stamps.districts.length === 13, `DISTRICTS holds ${stamps.districts.length} entries, expected 6 town + 7 Verge`);

  // Wild gates.
  ok(stamps.wilds.length === 2, `${stamps.wilds.length} wild gates, spec says 2`);
  const wE = stamps.wilds.find((p) => p.rank === 'E');
  const wC = stamps.wilds.find((p) => p.rank === 'C');
  ok(Boolean(wE), 'no rank-E wild gate');
  ok(Boolean(wC), 'no rank-C wild gate');
  // save.level here is 60 — C's reqLevel is 11, so both read unlocked. The
  // level-1 lock is checked on the real game page below.
  for (const w of stamps.wilds) {
    ok(w.wild === true, `wild gate ${w.rank} is not flagged wild:true`);
    ok(w.meshes === 4 && w.children === 4,
      `wild gate ${w.rank} has ${w.children} meshes, the shared portal build makes 4`);
    ok(w.portalAtIsMe, `portalAt() does not find the ${w.rank} wild gate from 1 m away`);
    ok(w.nearestIsMe, `nearestPortal() does not find the ${w.rank} wild gate from 1 m away`);
    ok(Math.abs(w.y - w.groundY) < 0.05,
      `wild gate ${w.rank} floats ${(w.y - w.groundY).toFixed(2)} m off its pad`);
    ok(Math.max(Math.abs(w.x), Math.abs(w.z)) >= build.poiMinR,
      `wild gate ${w.rank} sits inside POI_MIN_R at ${w.x},${w.z}`);
    ok(w.solids >= 4, `wild gate ${w.rank} has only ${w.solids} colliders around it — the ruin surround did not stamp`);
    ok(/UNSURVEYED/.test(w.gateName || ''), `wild gate ${w.rank} reuses the town gate's name (${w.gateName})`);
  }

  // -------------------------------------------------------------- disposal
  const leak = await page.evaluate(() => {
    const { renderer, scene, camera, city, cityMod } = window.__vg;
    // Render BETWEEN every rebuild. renderer.info.memory counts what is
    // actually uploaded, so a build/dispose loop with no frames in it reports a
    // fall to near zero and a leak test written that way passes on anything.
    const frame = () => {
      camera.position.set(0, 60, 120);
      camera.lookAt(0, 0, -60);
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
    };
    frame();
    const g0 = renderer.info.memory.geometries;
    const t0 = renderer.info.memory.textures;
    for (let i = 0; i < 3; i++) {
      city.dispose();
      city.build(20260806, { level: 60 });
      frame();
    }
    const g1 = renderer.info.memory.geometries;
    const t1 = renderer.info.memory.textures;
    return {
      g0, g1, t0, t1, frontier: !!city.frontier,
      districts: cityMod.DISTRICTS.length,
      pois: city.frontier?.pois.length ?? 0,
      wilds: city.portals.filter((p) => p.wild).length,
    };
  });
  phase('build/dispose x3');
  console.log(`geometries ${leak.g0} -> ${leak.g1}   textures ${leak.t0} -> ${leak.t1}`
    + `   districts ${leak.districts}  pois ${leak.pois}  wild ${leak.wilds}`);
  ok(leak.frontier, 'the Verge did not come back after a rebuild');
  // DISTRICTS is a module-level array the Verge appends to. If dispose does not
  // take its entries back off, three rebuilds leave 6 + 21 entries on it and
  // citymode names a POI at a player standing in the plaza.
  ok(leak.districts === 13,
    `DISTRICTS holds ${leak.districts} entries after 3 rebuilds, expected 13 — the Verge is leaking banners`);
  ok(leak.pois === 7 && leak.wilds === 2,
    `after 3 rebuilds: ${leak.pois} POIs and ${leak.wilds} wild gates, expected 7 and 2`);
  ok(leak.g1 <= leak.g0, `geometry leak across 3 city rebuilds: ${leak.g0} -> ${leak.g1}`);
  ok(leak.t1 <= leak.t0, `texture leak across 3 city rebuilds: ${leak.t0} -> ${leak.t1}`);

  // ----------------------------------------------------------- screenshots
  const shots = [];
  if (SHOTS) {
    const views = [
      ['verge-east', [150, 6, 6], [250, 2, 10]],
      ['verge-south', [10, 6, 150], [20, 2, 250]],
      ['verge-north-ash', [6, 8, -150], [2, 2, -250]],
      // Raised on purpose: at eye level the world edge hides behind the last
      // natural rise, which is exactly the shipped city lip's behaviour ("the
      // world ends in sky"). This vantage is the one that shows the drop, so a
      // human can confirm the lip is where the assertions say it is.
      ['verge-edge', [6, 42, -196], [2, -26, -300]],
      ['verge-seam', [8, 5, -160], [4, 1, -200]],
      // The spec's bird's-eye claim, framed from where a player can actually
      // stand to check it: the Breach road rise, looking back over the town.
      // A true 350 m aerial is mostly fog — FOG_FAR is 430 and that is a
      // gameplay decision the Verge does not get to overrule.
      ['verge-breach-rise', [0, 30, -190], [0, 0, 0]],
      ['verge-aerial', [130, 150, 175], [0, 0, -10]],
      ['verge-overlook-west', [-80, 12, -170], [-200, -20, -170]],
    ];
    for (const [name, pos, look] of views) {
      await page.evaluate(({ pos, look }) => {
        const { renderer, scene, camera, city } = window.__vg;
        camera.position.set(pos[0], pos[1], pos[2]);
        camera.lookAt(look[0], look[1], look[2]);
        camera.updateMatrixWorld();
        if (city.sky) { city.sky.position.set(pos[0], 0, pos[2]); city.sky.updateMatrix(); }
        renderer.info.reset();
        renderer.render(scene, camera);
      }, { pos, look });
      const file = shotPath(`${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      console.log(`shot ${name} -> ${file}`);
    }
  }
  phase('screenshots');

  // ------------------------------------------- STEP 7: the wild-gate ROUND TRIP
  //
  // A second page, on the REAL game, because this is the half of step 7 that no
  // City-in-a-canvas harness can answer: does walking into a wild gate reach the
  // same gate flow as a plaza portal, and does coming back out put you where you
  // left rather than on the plaza 200 m away?
  //
  // The prompt, the compass and enterGate work because the wild gate is an
  // entry in city.portals with the same shape as every other; the doorstep
  // works because portals carry stable ids that ride the run payload
  // (game.lastGatePortalId) back into citymode._spawnVector.
  const { page: gpage, errors: gerrors } = await newPhonePage(browser, { width: 900, height: 460, dpr: 1 });
  let roundTrip = null;
  try {
    await gotoGame(gpage, { waitMs: 2000 });
    await forceOpenGates(gpage);            // arena for E — faster and deterministic
    await gpage.click('#btnPlay');
    await gpage.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
    await gpage.waitForTimeout(900);

    const atGate = await gpage.evaluate(() => {
      const g = window.__game;
      const city = g.mode.city;
      const wilds = city.portals.filter((p) => p.wild);
      const w = wilds.find((p) => p.rank === 'E');
      const c = wilds.find((p) => p.rank === 'C');
      // Stand on the doorstep, town side, exactly where _spawnVector would put
      // a returning player.
      const len = Math.hypot(w.pos.x, w.pos.z) || 1;
      const sx = w.pos.x - (w.pos.x / len) * (w.radius + 1.6);
      const sz = w.pos.z - (w.pos.z / len) * (w.radius + 1.6);
      g.player.body.reset(sx, city.heightAt(sx, sz), sz);
      for (let i = 0; i < 8; i++) { g.mode.updateAlways(1 / 60); g.mode.update(1 / 60); }
      const p = g.mode.prompt;
      return {
        level: g.save.level,
        wilds: wilds.length,
        cLocked: c ? c.locked : null,
        eLocked: w.locked,
        prompt: p ? { kind: p.kind, rank: p.rank, locked: p.locked, sub: p.sub } : null,
        compassRank: (() => {
          let best = null, bd = Infinity;
          for (const q of city.portals) {
            if (q.locked) continue;
            const d = Math.hypot(g.player.pos.x - q.pos.x, g.player.pos.z - q.pos.z);
            if (d < bd) { bd = d; best = q; }
          }
          return best ? { rank: best.rank, wild: !!best.wild, d: +bd.toFixed(1) } : null;
        })(),
        gate: [+w.pos.x.toFixed(2), +w.pos.z.toFixed(2)],
        // DISCOVERY, end to end. The Verge registers a district per POI and
        // citymode._updateDistrict names it — this is the assertion that the
        // discovery system reaches the player rather than just existing.
        banner: (() => {
          const el = document.getElementById('cityDistrict');
          return el && el.classList.contains('on') ? el.textContent : null;
        })(),
        discovered: city.frontier.pois.filter((p) => p.discovered).map((p) => p.id),
      };
    });
    console.log('at the wild E gate:', JSON.stringify(atGate));
    ok(atGate.wilds === 2, `the live game built ${atGate.wilds} wild gates`);
    ok(atGate.level === 1, `expected a fresh save at level 1, got ${atGate.level}`);
    // The one gameplay rule the spec states outright for wild gates.
    ok(atGate.cLocked === true,
      'the rank-C wild gate is NOT locked at level 1 — spec says locked until level 11');
    ok(atGate.eLocked === false, 'the rank-E wild gate is locked at level 1');
    ok(atGate.prompt && atGate.prompt.kind === 'portal' && atGate.prompt.rank === 'E',
      `standing at the wild gate produced no portal prompt: ${JSON.stringify(atGate.prompt)}`);
    ok(atGate.compassRank && atGate.compassRank.wild,
      `the compass points at ${JSON.stringify(atGate.compassRank)} instead of the wild gate you are standing on`);
    ok(atGate.banner === 'AN UNWATCHED GATE',
      `standing at the wild E gate the discovery banner reads ${JSON.stringify(atGate.banner)}`);
    ok(atGate.discovered.includes('wildgate_e'),
      `POI discovery did not mark wildgate_e: ${JSON.stringify(atGate.discovered)}`);

    const entered = await gpage.evaluate(() => {
      const g = window.__game;
      const r = g.mode.confirmPrompt();
      return { action: r, mode: g.mode?.name ?? null, lastRank: g.lastGateRank };
    });
    await gpage.waitForTimeout(1600);
    const inGate = await gpage.evaluate(() => ({
      mode: window.__game.mode?.name ?? null,
      gateBuilt: Boolean(window.__game.gate),
      rank: window.__game.gate?.rank ?? null,
      seed: window.__game.seed ?? null,
    }));
    console.log('entered:', JSON.stringify(entered), JSON.stringify(inGate));
    ok(entered.action && entered.action.action === 'enterGate' && entered.action.rank === 'E',
      `confirming at the wild gate returned ${JSON.stringify(entered.action)}`);
    ok(inGate.mode === 'dungeon' && inGate.gateBuilt && inGate.rank === 'E',
      `the wild gate did not reach the gate flow: ${JSON.stringify(inGate)}`);

    await gpage.evaluate(() => window.__app.go('city'));
    await gpage.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
    await gpage.waitForTimeout(700);
    roundTrip = await gpage.evaluate(() => {
      const g = window.__game;
      const city = g.mode.city;
      const w = city.portals.find((p) => p.wild && p.rank === 'E');
      const town = city.portals.find((p) => !p.wild && p.rank === 'E');
      return {
        pos: [+g.player.pos.x.toFixed(2), +g.player.pos.z.toFixed(2)],
        toWild: +Math.hypot(g.player.pos.x - w.pos.x, g.player.pos.z - w.pos.z).toFixed(2),
        toTown: +Math.hypot(g.player.pos.x - town.pos.x, g.player.pos.z - town.pos.z).toFixed(2),
        wildAt: [+w.pos.x.toFixed(2), +w.pos.z.toFixed(2)],
        grounded: g.player.body.grounded,
        y: +g.player.pos.y.toFixed(2),
        ground: +city.heightAt(g.player.pos.x, g.player.pos.z).toFixed(2),
      };
    });
    console.log('returned:', JSON.stringify(roundTrip));
    ok(roundTrip.toWild < 12,
      `returning from the wild gate landed ${roundTrip.toWild} m from it `
      + `(${roundTrip.toTown} m from the plaza twin) — the doorstep promotion did not fire`);
    ok(Math.abs(roundTrip.y - roundTrip.ground) < 0.6,
      `the returning player is ${(roundTrip.y - roundTrip.ground).toFixed(2)} m off the ground`);
    for (const e of gerrors) fail.push(`wild-gate page error: ${e.split('\n')[0]}`);
  } finally {
    await gpage.close();
  }
  phase('wild-gate round trip');

  const report = {
    ok: fail.length === 0,
    baseline: BASELINE,
    stats: build.stats,
    noFrontier: build.noFrontierStats,
    seam,
    meshAgreement: mesh,
    walk,
    budget,
    leak,
    poiStamps: stamps,
    roundTrip,
    shots,
    pageErrors: errors,
  };
  const file = writeReport('frontier-test.json', report);
  console.log(`report -> ${file}`);

  for (const e of errors) fail.push(`page error: ${e.split('\n')[0]}`);
} finally {
  await browser.close();
  await server.stop();
}

for (const w of warn) console.log(`WARN  ${w}`);
if (fail.length) {
  console.log(`\nFAIL — ${fail.length} problem(s):`);
  for (const f of fail) console.log(`  * ${f}`);
  process.exit(1);
}
console.log('\nPASS — the Verge verified');
