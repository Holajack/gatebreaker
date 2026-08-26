// tools/interior-test.mjs — WORLD_SPEC step 9: the five buildings you walk into.
//
//   node tools/interior-test.mjs [--no-shots] [--headed]
//
// This drives the REAL game (title -> PLAY -> CityMode), not a City built in a
// bare page, because half of what step 9 adds lives in citymode: the inside/
// outside hysteresis, the boom clamp, and the _boomBlocked exception for the
// building you are standing in. A test that builds its own City would assert
// the geometry and miss every one of those.
//
// What it asserts, and why each one is here:
//
//   * All five enterables found a plot, and no procedural building, prop, tree
//     or street overlaps any of them. A shop with a lantern in the front room
//     is the bug the reserved-footprint pass exists to prevent.
//   * The player WALKS IN through the door on the thumbstick vector, for all
//     five. Teleporting inside would pass with a solid wall.
//   * While inside: the camera boom is <= 5.5 m, and the occupied building's
//     cap (upper storey + roof) is excluded from the shared cap mesh's draw
//     groups. On exit both come back.
//   * The doorway threshold does not flicker: walking the door line at 30 fps
//     produces at most one state change per crossing.
//   * validateLayout(city).ok — step 8's rules still hold with five plots
//     carved out of the layout grid.
//   * A navgrid baked from city.boxes finds a path from the street to the
//     interior counter, i.e. the door gap survives rasterisation.
//   * Draw-call cost of the whole system, measured by hiding it (reported AND
//     asserted: step 9 is the step that nearly spent the city's headroom).
//   * Three city rebuild cycles leak no geometries, textures or programs.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');

// The whole system — one shell mesh, one cap mesh (two groups while indoors),
// and their shadow passes. Asserted rather than merely reported because step 9
// landed with 12 draw calls of headroom under city-test's 220 ceiling and four
// more build steps still to come.
const DRAW_BUDGET = 6;
const BOOM_INSIDE_MAX = 5.5;

const fail = [];
let _t0 = Date.now();
const phase = (name) => {
  const now = Date.now();
  console.log(`  [${((now - _t0) / 1000).toFixed(1)}s] ${name}`);
  _t0 = now;
};
const ok = (cond, msg) => { if (!cond) fail.push(msg); return cond; };

const report = {};

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: true });
// Landscape: index.html's rotate gate swallows pointer events in portrait.
const { page, errors } = await newPhonePage(browser, { width: 900, height: 506, dpr: 1 });

/** Drive the player with the exact vector the thumbstick writes. */
async function walkTo(page_, tx, tz, { timeoutMs = 20000, stopWithin = 0.9 } = {}) {
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
      return { d, x: p.x, z: p.z, inside: g.mode._insideId };
    }, [tx, tz]);
    if (last.d < stopWithin) break;
    await page_.waitForTimeout(90);
  }
  await page_.evaluate(() => {
    window.__game.input.move.x = 0;
    window.__game.input.move.y = 0;
  });
  await page_.waitForTimeout(220);
  return last;
}

try {
  await gotoGame(page, { waitMs: 1600 });
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city'
    && window.__game.mode.city?.built, null, { timeout: 30000 });
  // RETARGET 2026-08-26: dismiss the first-arrival welcome (see _harness.dismissDialog)
  await page.evaluate(() => { const d = window.__game?.dialog; for (let i = 0; d?.open && i < 12; i++) d.advance(); });
  await page.waitForTimeout(900);
  phase('city mounted');

  // ------------------------------------------------------------- placement
  const placement = await page.evaluate(async () => {
    const { validateLayout } = await import('/src/world/layoutrules.js');
    const { ENTERABLES } = await import('/src/world/interiors.js');
    const g = window.__game;
    const city = g.mode.city;
    const it = city.interiors;
    const inRect = (x, z, b, pad = 0) => x > b.x0 - pad && x < b.x1 + pad
      && z > b.z0 - pad && z < b.z1 + pad;

    // Anything from the procedural town standing inside one of the five.
    const intrusions = [];
    for (const b of it.buildings) {
      for (const lb of city.layoutMeta) {
        if (Math.abs(lb.cx - b.cx) < (lb.w + b.w) / 2 && Math.abs(lb.cz - b.cz) < (lb.d + b.d) / 2) {
          intrusions.push({ kind: 'building', id: lb.id, in: b.id });
        }
      }
      for (const o of city.obstacles) {
        if (o.interiorId === b.id) continue;                 // its own furniture
        if (inRect(o.pos.x, o.pos.z, b)) intrusions.push({ kind: 'prop', in: b.id, x: o.pos.x, z: o.pos.z });
      }
      for (const s of city.streets) {
        // Cheap: sample the street and reject a sample landing in the footprint.
        const n = 60;
        for (let k = 0; k <= n; k++) {
          const x = s.x1 + (s.x2 - s.x1) * (k / n);
          const z = s.z1 + (s.z2 - s.z1) * (k / n);
          if (inRect(x, z, b, s.w)) { intrusions.push({ kind: 'street', in: b.id }); break; }
        }
      }
    }

    // Wall-run collision: four runs, one of them split by the door.
    const runs = city.boxes.filter((x) => x.interiorId);
    const perBuilding = {};
    for (const r of runs) perBuilding[r.interiorId] = (perBuilding[r.interiorId] || 0) + 1;

    return {
      expected: ENTERABLES.map((e) => e.id),
      stats: it.stats,
      layout: validateLayout(city),
      intrusions,
      wallRuns: perBuilding,
      reservedLeft: city.boxes.filter((x) => x.reserved).length,
      capTotal: it._capTotal,
      groups: it.capMesh ? it.capMesh.geometry.groups.map((x) => [x.start, x.count]) : null,
      interactables: city.interactables.map((x) => ({
        id: x.id, x: +x.pos.x.toFixed(2), z: +x.pos.z.toFixed(2), interiorId: x.interiorId || null,
      })),
    };
  });
  report.placement = placement;
  phase('placement');
  console.log(`interiors: ${JSON.stringify(placement.stats.buildings.map((b) => `${b.id}@${b.x},${b.z}`))}`);
  console.log(`layout: ok=${placement.layout.ok} problems=${placement.layout.problems?.length ?? 0}`);

  ok(placement.stats.planned === placement.expected.length,
    `only ${placement.stats.planned}/${placement.expected.length} enterables found a plot (missing: ${placement.stats.missing.join(', ')})`);
  ok(placement.stats.missing.length === 0, `enterables with no plot: ${placement.stats.missing.join(', ')}`);
  ok(placement.intrusions.length === 0,
    `${placement.intrusions.length} things stand inside an enterable: ${JSON.stringify(placement.intrusions.slice(0, 5))}`);
  ok(placement.layout.ok,
    `validateLayout failed with five plots reserved: ${JSON.stringify(placement.layout.problems?.slice(0, 4))}`);
  ok(!placement.reservedLeft,
    `${placement.reservedLeft} reserved footprint boxes were never swapped for wall runs — the rooms are still solid`);
  for (const id of placement.expected) {
    // Three whole walls plus the split one = 5, or 4 when the door sits on the
    // last cell of its run and one segment comes out zero-length. Both are
    // correct; 3 or fewer means a wall is missing.
    ok(placement.wallRuns[id] >= 4 && placement.wallRuns[id] <= 5,
      `${id} has ${placement.wallRuns[id]} collision runs, expected 4 or 5`);
  }
  // The prompts that moved indoors have to actually be indoors.
  for (const p of placement.interactables) {
    if (!p.interiorId) continue;
    const b = placement.stats.buildings.find((x) => x.id === p.interiorId);
    ok(Math.abs(p.x - b.x) < b.w / 2 && Math.abs(p.z - b.z) < b.d / 2,
      `interactable "${p.id}" was relocated to (${p.x}, ${p.z}), outside ${p.interiorId}`);
  }

  // ------------------------------------------- inside reads as inside
  // With no new lights, the ONLY thing separating an interior from a courtyard
  // is that the inner faces of the ground walls are painted darker. It is four
  // lines of code and completely invisible in a diff, so it gets an assert:
  // sample the merged shell buffer either side of one 0.2 m wall slab.
  const shading = await page.evaluate(() => {
    const g = window.__game;
    const b = g.mode.city.interiors.byId.get('tavern_row');
    const geo = g.mode.city.interiors.shellMesh.geometry;
    const pos = geo.attributes.position, col = geo.attributes.color;
    const inner = [], outer = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (z < b.z0 || z > b.z1 || y < b.base + 0.2 || y > b.base + 1.9) continue;
      if (Math.abs(x - b.x0) < 0.02) outer.push(col.getX(i));
      else if (Math.abs(x - (b.x0 + 0.2)) < 0.02) inner.push(col.getX(i));
    }
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    return { innerN: inner.length, outerN: outer.length, ratio: mean(inner) / (mean(outer) || 1) };
  });
  report.shading = shading;
  console.log(`inner wall face is ${(shading.ratio * 100).toFixed(1)}% of the outer face`);
  ok(shading.innerN > 0 && shading.outerN > 0,
    'could not find both faces of a wall slab in the shell buffer');
  ok(shading.ratio > 0.80 && shading.ratio < 0.90,
    `inner wall faces are ${(shading.ratio * 100).toFixed(1)}% of the outer, spec says ~85%`);

  // ------------------------------------------------------- walk into each
  const walks = [];
  for (const b of placement.stats.buildings) {
    // Start two metres out from the doorstep, facing the door — the approach a
    // player makes, without the 60 m cross-town commute in between.
    await page.evaluate((id) => {
      const g = window.__game;
      const city = g.mode.city;
      const b2 = city.interiors.byId.get(id);
      const d = b2.door;
      const x = d.outX + d.nx * 2.2, z = d.outZ + d.nz * 2.2;
      g.player.body.reset(x, city.heightAt(x, z) + 0.2, z);
      g.mode._camReady = false;
    }, b.id);
    await page.waitForTimeout(300);

    const target = await page.evaluate((id) => {
      const d = window.__game.mode.city.interiors.byId.get(id).door;
      return { x: d.inX, z: d.inZ };
    }, b.id);
    await walkTo(page, target.x, target.z);

    const inside = await page.evaluate((id) => {
      const g = window.__game;
      const city = g.mode.city;
      const it = city.interiors;
      const rec = it.byId.get(id);
      const p = g.player.pos;
      const cam = g.camera.position;
      const groups = it.capMesh.geometry.groups.map((x) => [x.start, x.count]);
      const covered = groups.some(([s, c]) => rec.capRange.start >= s && rec.capRange.start < s + c);
      return {
        id,
        insideId: g.mode._insideId,
        pos: { x: +p.x.toFixed(2), z: +p.z.toFixed(2) },
        inFootprint: p.x > rec.x0 && p.x < rec.x1 && p.z > rec.z0 && p.z < rec.z1,
        boom: +Math.hypot(cam.x - p.x, cam.y - p.y, cam.z - p.z).toFixed(2),
        capCovered: covered,
        groupCount: groups.length,
      };
    }, b.id);
    walks.push(inside);
    console.log(`  ${b.id.padEnd(12)} in=${inside.inFootprint} at ${inside.pos.x},${inside.pos.z}  boom ${inside.boom} m  capHidden=${!inside.capCovered}`);

    ok(inside.inFootprint, `walking at ${b.id}'s doorway did not get inside (ended ${inside.pos.x}, ${inside.pos.z}) — the door gap is sealed`);
    ok(inside.insideId === b.id, `${b.id}: mode did not register the player as inside (got ${inside.insideId})`);
    ok(inside.boom <= BOOM_INSIDE_MAX, `${b.id}: camera boom is ${inside.boom} m inside, limit ${BOOM_INSIDE_MAX}`);
    ok(!inside.capCovered, `${b.id}: the roof is still being drawn while the player is inside it`);

    // ...and back out.
    const back = await page.evaluate((id) => {
      const d = window.__game.mode.city.interiors.byId.get(id).door;
      return { x: d.outX + d.nx * 2.5, z: d.outZ + d.nz * 2.5 };
    }, b.id);
    await walkTo(page, back.x, back.z);
    const out = await page.evaluate((id) => {
      const it = window.__game.mode.city.interiors;
      const rec = it.byId.get(id);
      const groups = it.capMesh.geometry.groups.map((x) => [x.start, x.count]);
      return {
        insideId: window.__game.mode._insideId,
        covered: groups.some(([s, c]) => rec.capRange.start >= s && rec.capRange.start < s + c),
        groupCount: groups.length,
      };
    }, b.id);
    ok(out.insideId === null, `${b.id}: still flagged inside after walking back out (${out.insideId})`);
    ok(out.covered && out.groupCount === 1,
      `${b.id}: the roof did not come back on exit (groups=${out.groupCount})`);
  }
  report.walks = walks;
  phase('walked all five');

  // --------------------------------------------------------- walls are solid
  //
  // The single most dangerous thing this step does is DELETE each building's
  // solid footprint box and replace it with four thin wall runs. Every other
  // assertion in this file gets EASIER if that swap is wrong: a building with
  // no collision at all admits the player through the doorway, reaches the
  // counter on the navgrid and hides its roof exactly like a correct one. So
  // walk face-first at the back wall — the one opposite the door, guaranteed
  // to have no gap in it — and require the player to be stopped by it.
  const walls = [];
  for (const b of placement.stats.buildings) {
    await page.evaluate((id) => {
      const g = window.__game;
      const city = g.mode.city;
      const rec = city.interiors.byId.get(id);
      const d = rec.door;
      // Straight out from the centre along the door's INWARD normal, i.e. on
      // the far side of the building from its own door.
      const half = Math.abs(d.nx) > 0.5 ? rec.w / 2 : rec.d / 2;
      const x = rec.cx + d.fx * (half + 3.0);
      const z = rec.cz + d.fz * (half + 3.0);
      g.player.body.reset(x, city.heightAt(x, z) + 0.2, z);
      g.mode._camReady = false;
    }, b.id);
    await page.waitForTimeout(300);
    // Aim past the far wall so the thumbstick never lets up.
    const through = await page.evaluate((id) => {
      const rec = window.__game.mode.city.interiors.byId.get(id);
      const d = rec.door;
      return { x: rec.cx - d.fx * 6, z: rec.cz - d.fz * 6 };
    }, b.id);
    await walkTo(page, through.x, through.z, { timeoutMs: 9000, stopWithin: 0.4 });
    const res = await page.evaluate((id) => {
      const g = window.__game;
      const rec = g.mode.city.interiors.byId.get(id);
      const p = g.player.pos;
      return {
        id,
        inside: p.x > rec.x0 && p.x < rec.x1 && p.z > rec.z0 && p.z < rec.z1,
        insideId: g.mode._insideId,
        pos: { x: +p.x.toFixed(2), z: +p.z.toFixed(2) },
      };
    }, b.id);
    walls.push(res);
    console.log(`  wall ${res.id.padEnd(12)} pushed through=${res.inside} at ${res.pos.x},${res.pos.z}`);
    ok(!res.inside,
      `${res.id}: walking at the blank back wall put the player INSIDE (${res.pos.x}, ${res.pos.z}) — the wall runs are not collidable`);
  }
  report.walls = walls;
  phase('walls are solid');

  // ------------------------------------------------------------ hysteresis
  // Step across the threshold at walking speed and count state changes. The
  // spec names doorway flicker as a known edge; this is the assert for it.
  const flicker = await page.evaluate(async () => {
    const g = window.__game;
    const city = g.mode.city;
    const b = city.interiors.byId.get('tavern_row');
    const d = b.door;
    let changes = 0;
    let prev = g.mode._insideId;
    // Sweep the body straight through the doorway in 3 cm steps, running the
    // mode's own test at each one — 30 fps at hub walking speed is ~20 cm a
    // frame, so this is a far crueller sampling than the game ever produces.
    for (let t = -2.2; t <= 2.2; t += 0.03) {
      const x = d.x + d.fx * t, z = d.z + d.fz * t;
      g.player.pos.x = x; g.player.pos.z = z;
      g.mode._updateInside();
      if (g.mode._insideId !== prev) { changes++; prev = g.mode._insideId; }
    }
    const enteredAt = prev;
    for (let t = 2.2; t >= -2.2; t -= 0.03) {
      const x = d.x + d.fx * t, z = d.z + d.fz * t;
      g.player.pos.x = x; g.player.pos.z = z;
      g.mode._updateInside();
      if (g.mode._insideId !== prev) { changes++; prev = g.mode._insideId; }
    }
    return { changes, enteredAt, endedAt: prev };
  });
  report.flicker = flicker;
  console.log(`threshold sweep in and out: ${flicker.changes} state changes (2 is perfect)`);
  ok(flicker.changes === 2,
    `walking in and back out of the tavern door flipped the interior state ${flicker.changes} times, expected 2`);
  ok(flicker.enteredAt === 'tavern_row' && flicker.endedAt === null,
    `the threshold sweep ended in the wrong state (${flicker.enteredAt} -> ${flicker.endedAt})`);

  // --------------------------------------------------------------- navgrid
  const nav = await page.evaluate(async () => {
    const { NavGrid } = await import('/src/world/navgrid.js');
    const g = window.__game;
    const city = g.mode.city;
    const out = {};
    for (const b of city.interiors.buildings) {
      // A FINE grid, deliberately: NavGrid.blockBox inflates every box by
      // cell * 0.7071 so a cell straddling an edge still blocks, and at the
      // town's 2 m nav cell that slack is wider than any doorway a human-sized
      // building can have. 0.5 m over a 44 m window is 7,744 cells — nothing.
      const grid = new NavGrid({ originX: b.cx, originZ: b.cz, size: 44, cell: 0.5 });
      city.attachNavGrid(grid);
      // The GOAL is where the counter's prompt puts you, or failing that the
      // spot a stride inside the door. Not the geometric room centre: in the
      // Exchange that is under the trade counter, and "you cannot stand inside
      // the furniture" is correct behaviour, not a nav failure.
      const prompt = city.interactables.find((x) => x.interiorId === b.id);
      const inside = prompt
        ? { x: prompt.pos.x, z: prompt.pos.z }
        : { x: b.door.x + b.door.fx * 1.6, z: b.door.z + b.door.fz * 1.6 };
      const outside = { x: b.door.outX + b.door.nx * 3.5, z: b.door.outZ + b.door.nz * 3.5 };
      const goalOk = grid.setGoal(inside.x, inside.z);
      // How much of the room is actually standable — a door that opens onto one
      // free cell is a cupboard, not an interior.
      let open = 0;
      for (let x = b.x0 + 0.5; x < b.x1; x += 0.5) {
        for (let z = b.z0 + 0.5; z < b.z1; z += 0.5) if (!grid.blockedAt(x, z)) open++;
      }
      out[b.id] = {
        goalOk,
        openCells: open,
        insideBlocked: grid.blockedAt(inside.x, inside.z),
        doorBlocked: grid.blockedAt(b.door.x, b.door.z),
        reachable: grid.reachable(outside.x, outside.z),
      };
    }
    city.attachNavGrid(null);
    return out;
  });
  report.nav = nav;
  for (const [id, r] of Object.entries(nav)) {
    console.log(`  nav ${id.padEnd(12)} goal=${r.goalOk} doorOpen=${!r.doorBlocked} reachableFromStreet=${r.reachable} open=${r.openCells} cells`);
    ok(!r.insideBlocked, `${id}: the counter you are meant to stand at is not walkable on the navgrid`);
    ok(r.openCells >= 12, `${id} has only ${r.openCells} walkable half-metre cells inside — that is a cupboard, not a room`);
    ok(!r.doorBlocked, `${id}: the doorway cell is blocked on the navgrid — nothing can path in`);
    ok(r.reachable, `${id}: the street outside cannot reach the counter inside`);
  }
  phase('navgrid');

  // ------------------------------------------------------------ draw cost
  const cost = await page.evaluate(async () => {
    const g = window.__game;
    const it = g.mode.city.interiors;
    const sample = async (on) => {
      it.shellMesh.visible = on;
      it.capMesh.visible = on;
      const calls = [];
      for (let i = 0; i < 22; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        calls.push(g.renderer.info.render.calls);
      }
      calls.sort((a, b) => a - b);
      return calls[Math.floor(calls.length / 2)];
    };
    // Stand somewhere all five could plausibly be on screen at once.
    g.player.body.reset(0, g.mode.city.heightAt(0, 34), 34);
    g.mode._camReady = false;
    await new Promise((r) => setTimeout(r, 300));
    const withThem = await sample(true);
    const without = await sample(false);
    it.shellMesh.visible = true;
    it.capMesh.visible = true;
    return { withThem, without, delta: withThem - without };
  });
  report.drawCost = cost;
  console.log(`draw cost of all five interiors: +${cost.delta} calls (${cost.without} -> ${cost.withThem})`);
  ok(cost.delta <= DRAW_BUDGET,
    `the five interiors cost ${cost.delta} draw calls, budget ${DRAW_BUDGET}`);
  phase('draw cost');

  // ------------------------------------------------------------ leak check
  const leak = await page.evaluate(async () => {
    const g = window.__game;
    const rebuild = async () => {
      g.mode.city.dispose();
      g.mode.city.build(g.mode._seed, g.save);
      await new Promise((r) => setTimeout(r, 80));
    };
    // Stand somewhere ordinary and rebuild ONCE before taking the baseline.
    // three compiles a program the first time an object is actually rendered,
    // so a cold reading counts lazy compiles as a leak — which is exactly the
    // false positive this measurement produced before the warm-up was added.
    const sp = g.mode.city.spawnPoint();
    g.player.body.reset(sp.x, sp.y, sp.z);
    g.mode._insideId = null;
    await rebuild();
    await new Promise((r) => setTimeout(r, 400));
    const before = { ...g.renderer.info.memory, programs: g.renderer.info.programs.length };
    for (let i = 0; i < 3; i++) await rebuild();
    await new Promise((r) => setTimeout(r, 400));
    const after = { ...g.renderer.info.memory, programs: g.renderer.info.programs.length };
    return { before, after, interiors: g.mode.city.interiors.stats.planned };
  });
  report.leak = leak;
  console.log(`rebuild x3: geometries ${leak.before.geometries} -> ${leak.after.geometries}, textures ${leak.before.textures} -> ${leak.after.textures}, programs ${leak.before.programs} -> ${leak.after.programs}`);
  ok(leak.after.geometries <= leak.before.geometries + 4,
    `three city rebuilds leaked ${leak.after.geometries - leak.before.geometries} geometries`);
  ok(leak.after.textures <= leak.before.textures + 1,
    `three city rebuilds leaked ${leak.after.textures - leak.before.textures} textures`);
  ok(leak.after.programs <= leak.before.programs,
    `three city rebuilds grew the program cache by ${leak.after.programs - leak.before.programs}`);
  ok(leak.interiors === 5, `after three rebuilds only ${leak.interiors} interiors exist`);
  phase('leak check');

  // ---------------------------------------------------------- screenshots
  const shots = [];
  if (SHOTS) {
    const views = [
      { name: 'interior-tavern-outside', id: 'tavern_row', at: 'out' },
      { name: 'interior-tavern-inside', id: 'tavern_row', at: 'in' },
      { name: 'interior-assay-inside', id: 'assay', at: 'in' },
      { name: 'interior-exchange-inside', id: 'exchange', at: 'in' },
      { name: 'interior-ashworks-inside', id: 'ashworks', at: 'in' },
      { name: 'interior-stash-inside', id: 'stash_annex', at: 'in' },
    ];
    for (const v of views) {
      await page.evaluate(({ id, at }) => {
        const g = window.__game;
        const city = g.mode.city;
        const b = city.interiors.byId.get(id);
        const d = b.door;
        const p = at === 'in'
          ? { x: b.cx + d.fx * 0.4, z: b.cz + d.fz * 0.4 }
          : { x: d.outX + d.nx * 5.0, z: d.outZ + d.nz * 5.0 };
        g.player.body.reset(p.x, city.heightAt(p.x, p.z) + 0.1, p.z);
        g.player.yaw = Math.atan2(d.fx, d.fz);          // facing into the room
        // Orbit the camera around to the door's side, so every shot looks AT
        // the doorway instead of at whichever wall happens to face world +Z.
        g.input.look.yaw = Math.atan2(d.nx, d.nz);
        g.input.look.pitch = 0;
        g.mode._camReady = false;
      }, v);
      // Long enough for _updateInside, the boom clamp and the lerp to settle.
      await page.waitForTimeout(1100);
      const p = shotPath(`${v.name}.png`);
      await page.screenshot({ path: p });
      shots.push({ name: v.name, path: p });
      console.log(`shot ${v.name.padEnd(26)} -> ${p}`);
    }
    // One from above with a roof off, so the human pass can see the plan.
    await page.evaluate(() => {
      const g = window.__game;
      const b = g.mode.city.interiors.byId.get('assay');
      g.player.body.reset(b.cx, g.mode.city.heightAt(b.cx, b.cz) + 0.1, b.cz);
      g.mode._camReady = false;
      g.input.look.yaw = 0;
      g.input.look.pitch = 0.55;
    });
    await page.waitForTimeout(1200);
    const p = shotPath('interior-assay-plan.png');
    await page.screenshot({ path: p });
    shots.push({ name: 'interior-assay-plan', path: p });
    console.log(`shot interior-assay-plan       -> ${p}`);
  }
  report.shots = shots;
  phase('screenshots');

  report.errors = errors;
  ok(errors.length === 0, `page errors: ${errors.slice(0, 2).join(' | ')}`);
} catch (e) {
  fail.push(`threw: ${e.message}\n${e.stack}`);
} finally {
  report.fail = fail;
  const file = writeReport('interior-test.json', report);
  console.log(`report -> ${file}`);
  await browser.close();
  await server.stop();
}

if (fail.length) {
  console.error(`\nFAIL — ${fail.length} problem(s):`);
  for (const f of fail) console.error(`  * ${f}`);
  process.exit(1);
}
console.log('\nPASS — the five service buildings admit the player');
