// Solid-world verification.
//
//   node tools/collision-test.mjs            # logic + in-game browser leg
//   node tools/collision-test.mjs --no-browser
//   node tools/collision-test.mjs --only=perf
//
// The owner's report was "I can walk through a lot of the rocks and stuff
// that's in there." This tool is the thing that proves that is no longer true,
// so it drives the REAL CharacterBody from src/game/physics.js against the REAL
// ObstacleField from src/world/obstacles.js — no reimplementation of either.
//
// Both legs run headless. The browser leg is LANDSCAPE (892 x 412): index.html
// ships a rotate gate that covers the screen and swallows pointer events in
// portrait, so a portrait viewport hangs on the first click.

import { CharacterBody, FLAT_GROUND } from '../src/game/physics.js';
import { ObstacleField, obstacleField } from '../src/world/obstacles.js';
import { NavGrid } from '../src/world/navgrid.js';

const argv = process.argv.slice(2);
const NO_BROWSER = argv.includes('--no-browser');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

// config.js: derive().speed = 6.0 + 4.2 * (1 - e^-k), so 10.2 u/s is the
// player's maxSpeed ceiling at capped Agility. It is NOT the speed he reaches.
// Holding the stick, friction 9 rubs 13.9% off the velocity each frame while
// groundAccel 62 only adds 1.03 u/s back, so any maxSpeed above
// 1.03 / 0.139 = 7.42 u/s saturates there. (Below 7.42 the top-up is
// gap-limited and maxSpeed IS reached exactly, which is why the level-1
// maxSpeed of 6.0 behaves.) CRUISE is therefore measured, not assumed —
// setting maxSpeed to 10.2 and holding the stick would have quietly tested
// 7.42 and called it 10.2, and the 3x case would have tested 7.42 as well.
const WALK = 10.2;          // maxSpeed setting
const R = 0.6;              // player radius
const DT = 1 / 60;

let failures = 0;
let checks = 0;
const lines = [];

function log(s = '') { lines.push(s); console.log(s); }
function head(s) { log(''); log(s); log('-'.repeat(s.length)); }

function ok(name, pass, detail = '') {
  checks++;
  if (!pass) failures++;
  log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  return pass;
}

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : String(n));

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function body(field, { maxSpeed = WALK, radius = R, x = 0, z = 0, tune = null } = {}) {
  const b = new CharacterBody({ radius, maxSpeed, obstacles: field || null, ...(tune || {}) });
  b.setEnvironment(FLAT_GROUND, null, null, field || null);
  b.reset(x, 0, z);
  return b;
}

/**
 * A body that can actually SUSTAIN `speed`. Holding the stick is accel-limited,
 * so reaching 3x walk pace needs the acceleration raised to match — otherwise
 * the "high speed" case silently runs at walking pace and proves nothing.
 */
function sprintBody(field, speed, opts = {}) {
  return body(field, {
    maxSpeed: speed,
    tune: { groundAccel: speed * 60, friction: 9 },
    ...opts,
  });
}

/** Measured free-space sustained speed for the default player tuning. */
function measureCruise() {
  const b = body(null);
  for (let i = 0; i < 240; i++) { b.move(1, 0, 1); b.step(DT); }
  return b.horizontalSpeed();
}
const CRUISE = measureCruise();

/**
 * Signed clearance from the body's disc to a solid: negative means the body is
 * INSIDE it. This is the number that decides "did we walk through the rock".
 */
function clearance(field, i, x, z, radius) {
  const o = field.get(i);
  if (o.kind === 'circle') {
    return Math.hypot(x - o.x, z - o.z) - (o.radius + radius);
  }
  const c = Math.cos(o.rot);
  const s = Math.sin(o.rot);
  const rx = x - o.x;
  const rz = z - o.z;
  const lx = rx * c + rz * s;
  const lz = -rx * s + rz * c;
  // Outside distance for a rounded box; inside it is the (negative) depth.
  const dx = Math.abs(lx) - (o.w / 2 + radius);
  const dz = Math.abs(lz) - (o.d / 2 + radius);
  if (dx > 0 || dz > 0) return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
  return Math.max(dx, dz);
}

function minClearance(field, x, z, radius) {
  let m = Infinity;
  for (let i = 0; i < field.count; i++) {
    const c = clearance(field, i, x, z, radius);
    if (c < m) m = c;
  }
  return m;
}

/** Hold a heading for `seconds`, sampling every step. */
function drive(b, field, dx, dz, seconds, { impulse = 0 } = {}) {
  if (impulse > 0) b.addImpulse(dx * impulse, 0, dz * impulse);
  const steps = Math.round(seconds / DT);
  const track = [];
  let worst = Infinity;
  for (let i = 0; i < steps; i++) {
    b.move(dx, dz, 1);
    b.step(DT);
    const c = field.count ? minClearance(field, b.pos.x, b.pos.z, b.radius) : Infinity;
    if (c < worst) worst = c;
    track.push({ x: b.pos.x, z: b.pos.z, sp: b.horizontalSpeed(), clear: c });
  }
  return { track, worst, end: { x: b.pos.x, z: b.pos.z } };
}

/** Distance covered over the last `seconds` of a track — the stuck detector. */
function tailTravel(track, seconds = 1) {
  const n = Math.min(track.length, Math.round(seconds / DT));
  if (n < 2) return 0;
  const a = track[track.length - n];
  const b = track[track.length - 1];
  return Math.hypot(b.x - a.x, b.z - a.z);
}

// --------------------------------------------------------------------------
// 1. degradation — an empty registry must reproduce today's movement exactly
// --------------------------------------------------------------------------

function runDegradation() {
  head('1. EMPTY REGISTRY == TODAY (bit-exact)');

  const script = (b) => {
    const out = [];
    for (let i = 0; i < 600; i++) {
      const a = i * 0.017;
      b.move(Math.cos(a), Math.sin(a), i % 97 === 0 ? 0.4 : 1);
      if (i === 40) b.jump();
      if (i === 200) b.addImpulse(9, 0, -4, 8);
      b.setJumpHeld(i > 40 && i < 55);
      b.step(DT);
      out.push(b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z);
    }
    return out;
  };

  const none = script(body(null));
  const empty = script(body(new ObstacleField()));
  let maxDiff = 0;
  let exact = true;
  for (let i = 0; i < none.length; i++) {
    if (none[i] !== empty[i]) exact = false;
    maxDiff = Math.max(maxDiff, Math.abs(none[i] - empty[i]));
  }
  ok('empty ObstacleField is bit-identical to no field at all', exact,
    `maxdiff ${maxDiff}`);

  // A populated-but-distant field still takes the substep path, so it is only
  // required to agree to float noise, not bit-for-bit.
  const far = new ObstacleField();
  far.addCircle(900, 900, 3).build();
  const distant = script(body(far));
  let d2 = 0;
  for (let i = 0; i < none.length; i++) d2 = Math.max(d2, Math.abs(none[i] - distant[i]));
  ok('obstacles present but out of reach change nothing measurable', d2 < 1e-9,
    `maxdiff ${d2.toExponential(2)}`);

  const nullField = body(null);
  nullField.step(DT);
  ok('null field never throws', true);
}

// --------------------------------------------------------------------------
// 2. rock / monolith / building — solid, and you slide
// --------------------------------------------------------------------------

function runSolids() {
  head('2. ROCK, MONOLITH, BUILDING: SOLID AND SLIDING');

  // --- rock: the exact thing the owner walked through ---
  {
    const field = new ObstacleField();
    field.addCircle(6, 0, 1.2, { tag: 'rock', top: 2.2 }).build();
    const b = body(field);
    const r = drive(b, field, 1, 0, 4);
    ok('rock: body never enters the rock', r.worst > -1e-6, `min clearance ${f3(r.worst)}`);
    ok('rock: body gets past it instead of stopping dead', r.end.x > 7.5,
      `ended x=${f2(r.end.x)} z=${f2(r.end.z)}`);
    ok('rock: still moving at the end (not wedged)', tailTravel(r.track) > 3,
      `last 1s travel ${f2(tailTravel(r.track))}u`);
    // A head-on hit costs a frame or two of speed; what must not happen is a
    // SUSTAINED stall while the character grinds against the rock.
    let stall = 0;
    let worstStall = 0;
    for (const t of r.track) {
      stall = t.sp < CRUISE * 0.4 ? stall + DT : 0;
      if (stall > worstStall) worstStall = stall;
    }
    ok('rock: never below 40% of cruise for more than 0.2s', worstStall <= 0.2,
      `longest stall ${f3(worstStall)}s`);
  }

  // --- monolith: a rotated box, the arena pillar case ---
  {
    const field = new ObstacleField();
    field.addBox(6, 0, 1.8, 1.8, 0.6, { tag: 'monolith' }).build();
    const b = body(field);
    const r = drive(b, field, 1, 0, 4);
    ok('monolith: never penetrated', r.worst > -1e-6, `min clearance ${f3(r.worst)}`);
    ok('monolith: slides around it', r.end.x > 7.5, `ended x=${f2(r.end.x)} z=${f2(r.end.z)}`);
    ok('monolith: not wedged', tailTravel(r.track) > 3, `last 1s ${f2(tailTravel(r.track))}u`);
  }

  // --- building: 24 x 8 m block, the city case ---
  {
    const field = new ObstacleField();
    field.addBox(20, 0, 24, 8, 0).build();
    const b = body(field);
    const r = drive(b, field, 1, 0, 6);
    ok('building: never penetrated', r.worst > -1e-6, `min clearance ${f3(r.worst)}`);
    const zDrift = Math.abs(r.end.z);
    ok('building: slides along the wall rather than sticking', zDrift > 4,
      `z drift ${f2(zDrift)}u along a 24m face`);
    ok('building: cleared the corner and kept going', r.end.x > 8.2,
      `ended x=${f2(r.end.x)} z=${f2(r.end.z)}`);
    ok('building: moving at the end', tailTravel(r.track) > 3,
      `last 1s ${f2(tailTravel(r.track))}u`);
  }

  // --- oblique approach: the common case, must barely cost any speed ---
  {
    const field = new ObstacleField();
    field.addBox(20, 0, 24, 8, 0).build();
    const b = body(field, { z: -12 });
    const r = drive(b, field, 0.94, 0.34, 4);
    ok('glancing hit: no penetration', r.worst > -1e-6, `min clearance ${f3(r.worst)}`);
    const avg = r.track.slice(30).reduce((s, t) => s + t.sp, 0) / (r.track.length - 30);
    ok('glancing hit: average speed stays near free-running pace', avg > CRUISE * 0.9,
      `${f2(avg)} of ${f2(CRUISE)} u/s cruise`);
  }

  // --- concave corner: the classic ejection / trap case ---
  {
    const field = new ObstacleField();
    field.addBox(8, 0, 8, 1, 0);        // north wall
    field.addBox(4, 4, 1, 8, 0);        // west wall
    field.build();
    const b = body(field, { x: 8, z: 6 });
    const r = drive(b, field, -0.7, -0.7, 3);
    ok('inside corner: never squeezed through a wall', r.worst > -1e-6,
      `min clearance ${f3(r.worst)}`);
    ok('inside corner: settles against the corner, does not tunnel out',
      r.end.x > 4.4 && r.end.z > -0.2, `ended x=${f2(r.end.x)} z=${f2(r.end.z)}`);
  }

  // --- step-over: kerb-height rubble must not be a wall ---
  {
    const field = new ObstacleField();
    field.addCircle(6, 0, 1.0, { top: 0.22, tag: 'pebble' }).build();
    const b = body(field);            // stepHeight defaults to 0.4
    const r = drive(b, field, 1, 0, 2.2);
    ok('kerb-height rubble is stepped over, not walked into',
      Math.abs(r.end.z) < 0.05 && r.end.x > 9, `ended x=${f2(r.end.x)} z=${f2(r.end.z)}`);
    const tall = new ObstacleField();
    tall.addCircle(6, 0, 1.0, { top: 1.4 }).build();
    const b2 = body(tall);
    const r2 = drive(b2, tall, 1, 0, 2.2);
    ok('waist-height rubble of the same radius still blocks', Math.abs(r2.end.z) > 0.5,
      `deflected z=${f2(r2.end.z)}`);
  }
}

// --------------------------------------------------------------------------
// 3. tunnelling
// --------------------------------------------------------------------------

function runTunnelling() {
  head('3. NO TUNNELLING AT SPEED');

  const cases = [
    { name: 'thin wall 0.5m thick', build: (f) => f.addBox(6, 0, 0.5, 200, 0), gate: (t) => t.x < 5.75 },
    { name: 'bollard r=0.35', build: (f) => f.addCircle(6, 0, 0.35), gate: null },
    { name: 'lamp post r=0.22', build: (f) => f.addCircle(6, 0, 0.22), gate: null },
  ];

  // The capped walk, and 3x that. Both are VERIFIED speeds: the label prints
  // the mean speed actually achieved over the run, not the setting.
  for (const speed of [CRUISE, CRUISE * 3]) {
    for (const c of cases) {
      const field = new ObstacleField();
      c.build(field);
      field.build();
      const b = speed > CRUISE * 1.5
        ? sprintBody(field, speed, { x: -4 })
        : body(field, { x: -4 });
      const r = drive(b, field, 1, 0, 3);
      const reached = Math.max(...r.track.map((t) => t.sp));
      const label = `${c.name} @ ${f2(speed)} u/s (peak ${f2(reached)})`;
      ok(`${label}: never inside the solid`, r.worst > -1e-6,
        `min clearance ${f3(r.worst)}`);
      if (c.gate) {
        ok(`${label}: did not end up on the far side`, c.gate(r.end),
          `ended x=${f2(r.end.x)}`);
      } else {
        // A post is not a wall — you are meant to go round it. What must not
        // happen is passing through its centre line without ever touching it.
        const touched = r.track.some((t) => t.clear < 0.05);
        ok(`${label}: actually collided instead of passing through`, touched,
          `closest ${f3(r.worst)}`);
      }
    }
  }

  // Impulse-driven overspeed: knockback and dash bypass maxSpeed entirely.
  {
    const field = new ObstacleField();
    field.addBox(6, 0, 0.5, 200, 0).build();
    const b = body(field, { maxSpeed: WALK, x: -2 });
    const peak = 46;
    const r = drive(b, field, 1, 0, 2, { impulse: peak });
    ok(`knockback impulse ${peak} u/s into a 0.5m wall: no pass-through`,
      r.end.x < 5.75 && r.worst > -1e-6,
      `ended x=${f2(r.end.x)} min clearance ${f3(r.worst)}`);
  }

  // Absurd speed, to find where the substep budget actually runs out.
  {
    const field = new ObstacleField();
    field.addBox(6, 0, 0.5, 200, 0).build();
    let breakAt = null;
    for (let sp = 20; sp <= 600; sp += 10) {
      const b = body(field, { maxSpeed: WALK, x: -4 });
      const r = drive(b, field, 1, 0, 2, { impulse: sp });
      if (r.end.x > 6) { breakAt = sp; break; }
    }
    log(`  note  first impulse speed that defeats the 0.5m wall: `
      + `${breakAt ? `${breakAt} u/s` : 'none up to 600 u/s'}`
      + `  (sustained walk is ${f2(CRUISE)}, dash/knockback peaks near 46)`);
  }
}

// --------------------------------------------------------------------------
// 4. the nav grid must block exactly what the body collides with
// --------------------------------------------------------------------------

function runNav() {
  head('4. NAVGRID AGREES WITH COLLISION');

  const field = new ObstacleField();
  field.addCircle(-14, 6, 1.4, { tag: 'rock' });
  field.addCircle(9, -11, 0.8, { tag: 'monolith' });
  field.addBox(20, 0, 24, 8, 0, { tag: 'building' });
  field.addBox(-24, -20, 6, 18, 0.7, { tag: 'terrace' });
  field.addCircle(0, 30, 2, { nav: false, tag: 'portal-ring' });
  field.build();

  const grid = new NavGrid({ originX: 0, originZ: 0, size: 120, cell: 2 });
  field.applyToNavGrid(grid, { clear: true, bake: true });

  ok('navgrid blocks the rock centre', grid.blockedAt(-14, 6));
  ok('navgrid blocks the building centre', grid.blockedAt(20, 0));
  ok('navgrid blocks the rotated terrace', grid.blockedAt(-24, -20));
  ok('nav:false obstacles are solid but do not block pathing',
    !grid.blockedAt(0, 30) && field.blocked(0, 30, 0.6));
  ok('open ground stays open', !grid.blockedAt(40, 40));

  // The real guarantee: nothing the player cannot stand in is walkable to the
  // AI. Sampled over the whole grid, nav must be a superset of collision.
  // Round-trips through toNavBlockers() so this also proves that export is the
  // same content: nav:false props are deliberately absent from both sides.
  const navOnly = obstacleField(field.toNavBlockers());
  let solid = 0;
  let disagree = 0;
  for (let x = -58; x < 58; x += 0.5) {
    for (let z = -58; z < 58; z += 0.5) {
      if (!navOnly.blocked(x, z, 0)) continue;
      solid++;
      if (!grid.blockedAt(x, z)) disagree++;
    }
  }
  ok('every solid sample is a blocked nav cell', disagree === 0,
    `${solid} solid samples, ${disagree} disagreements`);

  const flowed = grid.setGoal(45, 45);
  ok('a flow field still bakes over the field', flowed, JSON.stringify(grid.stats()));

  // Walk the flow from behind the building to the goal: it must route around.
  const dir = { x: 0, z: 0 };
  let px = 4;
  let pz = 0;
  let entered = 0;
  let steps = 0;
  for (; steps < 900; steps++) {
    if (Math.hypot(px - 45, pz - 45) < 3) break;
    if (!grid.flowAt(px, pz, dir)) break;
    px += dir.x * 0.5;
    pz += dir.z * 0.5;
    if (field.blocked(px, pz, 0)) entered++;
  }
  ok('flow-field route never crosses a solid', entered === 0,
    `${steps} steps, ended ${f2(px)},${f2(pz)}`);
}

// --------------------------------------------------------------------------
// 5. broadphase cost
// --------------------------------------------------------------------------

function runPerf() {
  head('5. BROADPHASE COST');

  const build = (n) => {
    const f = new ObstacleField();
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const x = (rnd() - 0.5) * 300;
      const z = (rnd() - 0.5) * 300;
      if (i % 3 === 0) f.addBox(x, z, 4 + rnd() * 22, 4 + rnd() * 14, rnd() * Math.PI);
      else f.addCircle(x, z, 0.4 + rnd() * 2);
    }
    return f.build();
  };

  // Reference: the linear scan every resolve() in this repo does today.
  const linear = (f, pos, radius) => {
    let touched = 0;
    for (let i = 0; i < f.count; i++) {
      const o = f.get(i);
      const dx = pos.x - o.x;
      const dz = pos.z - o.z;
      const min = (o.radius || Math.max(o.w, o.d) / 2) + radius;
      if (dx * dx + dz * dz < min * min) touched++;
    }
    return touched;
  };

  for (const n of [64, 300, 600, 1200]) {
    const f = build(n);
    const s = f.stats();
    const pos = { x: 0, y: 0, z: 0 };
    const vel = { x: 1, z: 0 };
    const iters = 200000;

    // warm
    for (let i = 0; i < 20000; i++) {
      pos.x = (i % 300) - 150; pos.z = ((i * 7) % 300) - 150; pos.y = 0;
      f.resolve(pos, R, vel, 0.4);
    }
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      pos.x = (i % 300) - 150; pos.z = ((i * 7) % 300) - 150; pos.y = 0;
      vel.x = 1; vel.z = 0;
      f.resolve(pos, R, vel, 0.4);
    }
    let t1 = process.hrtime.bigint();
    const usHash = Number(t1 - t0) / 1000 / iters;

    const li = 20000;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < li; i++) {
      pos.x = (i % 300) - 150; pos.z = ((i * 7) % 300) - 150;
      linear(f, pos, R);
    }
    t1 = process.hrtime.bigint();
    const usLinear = Number(t1 - t0) / 1000 / li;

    log(`  ${String(n).padStart(4)} obstacles  `
      + `${s.buckets} buckets, avg ${f2(s.avgBucket)} / max ${s.maxBucket} per bucket  |  `
      + `resolve ${f3(usHash)} us   linear-scan ref ${f3(usLinear)} us   `
      + `${f2(usLinear / usHash)}x`);
    if (n === 600) {
      // 40 bodies x 60 Hz x up to 3 substeps is the worst realistic frame.
      const budget = usHash * 40 * 3;
      log(`        -> 40 entities x 3 substeps = ${f3(budget / 1000)} ms/frame at 600 obstacles`);
      ok('600-obstacle broadphase stays under 0.5 ms per frame for 40 entities',
        budget / 1000 < 0.5, `${f3(budget / 1000)} ms`);
    }
  }

  // Whole-body cost, which is what actually lands in the frame.
  {
    const f = build(600);
    const b = body(f, { x: -140, z: -140 });
    const iters = 120000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      b.move(Math.cos(i * 0.01), Math.sin(i * 0.01), 1);
      b.step(DT);
      if (i % 4000 === 0) b.reset(-140 + (i % 200), 0, -140 + ((i * 3) % 200));
    }
    const t1 = process.hrtime.bigint();
    log(`  CharacterBody.step with a 600-obstacle field: `
      + `${f3(Number(t1 - t0) / 1000 / iters)} us per body per frame`);
  }

  // Build cost — this is paid once on level entry, so it must not be a hitch.
  {
    const t0 = process.hrtime.bigint();
    const f = build(600);
    const t1 = process.hrtime.bigint();
    log(`  field build (600 obstacles, incl. broadphase pack): `
      + `${f3(Number(t1 - t0) / 1e6)} ms   ${JSON.stringify(f.stats())}`);
  }
}

// --------------------------------------------------------------------------
// 6. in the real game, in a landscape headless browser
// --------------------------------------------------------------------------

async function runBrowser() {
  head('6. LIVE GAME (headless, LANDSCAPE 892x412)');
  const h = await import('./_harness.mjs');
  const server = await h.ensureServer();
  const browser = await h.launchBrowser();
  // LANDSCAPE. Portrait raises index.html's rotate gate, which covers the
  // screen and swallows every pointer event.
  const { page, errors } = await h.newPhonePage(browser, { width: 892, height: 412 });
  try {
    await h.gotoGame(page, { waitMs: 1800 });
    const vp = page.viewportSize();
    ok('viewport is landscape', vp.width > vp.height, `${vp.width}x${vp.height}`);

    // The arena, because that is where the owner is: "I'm only in a dungeon...
    // I can walk through a lot of the rocks and stuff that's in there."
    const res = await h.evalGame(page, async (g) => {
      const mod = await import('/src/world/obstacles.js');
      const p = g.player;
      g.renderer.render = () => {};
      g.fx.damageNumber = () => {};
      g.startGate(0);

      const ROCK = { x: 6, z: 0, r: 1.2 };
      const run = (field, seconds) => {
        p.body.setObstacles(field);
        p.body.reset(0, 0, 0);
        p.hp = 9999;
        let worst = Infinity;
        const steps = Math.round(seconds * 60);
        for (let i = 0; i < steps; i++) {
          g.enemies.length = 0;              // keep the test about geometry
          g.projectiles.length = 0;
          p.invuln = 5;
          g.input.move.x = 1;
          g.input.move.y = 0;
          g.update(1 / 60);
          const d = Math.hypot(p.pos.x - ROCK.x, p.pos.z - ROCK.z) - (ROCK.r + p.body.radius);
          if (d < worst) worst = d;
        }
        return { worst, x: p.pos.x, z: p.pos.z };
      };

      const solid = new mod.ObstacleField();
      solid.addCircle(ROCK.x, ROCK.z, ROCK.r, { tag: 'rock' }).build();
      const withRock = run(solid, 3);
      const withoutRock = run(new mod.ObstacleField(), 3);

      // What the arena registers as solid TODAY, for the handoff.
      const arenaCircles = g.world.obstacles.length;
      let sceneryMeshes = 0;
      g.world.group.traverse((o) => { if (o.isInstancedMesh) sceneryMeshes += o.count; });

      return {
        withRock, withoutRock, arenaCircles, sceneryMeshes,
        fieldStats: solid.stats(),
        bodyBound: !!p.body.obstacles,
      };
    });

    log(`  rock run:  min clearance ${f3(res.withRock.worst)}  ended `
      + `x=${f2(res.withRock.x)} z=${f2(res.withRock.z)}`);
    log(`  empty run: min clearance ${f3(res.withoutRock.worst)}  ended `
      + `x=${f2(res.withoutRock.x)} z=${f2(res.withoutRock.z)}`);
    ok('live player cannot enter a registered rock', res.withRock.worst > -1e-4,
      `min clearance ${f3(res.withRock.worst)}`);
    ok('live player is deflected around it rather than stopped',
      Math.abs(res.withRock.z) > 0.4 && res.withRock.x > 7.5,
      `x=${f2(res.withRock.x)} z=${f2(res.withRock.z)}`);
    // The arena is seeded per run, so its own pillars can nudge the control
    // line; what matters is that with an empty registry the body walks clean
    // THROUGH the rock volume exactly as the shipped build does.
    ok('with an EMPTY field the live player still walks through the rock volume',
      res.withoutRock.worst < -0.5,
      `deepest penetration ${f3(-res.withoutRock.worst)}u, ended z=${f2(res.withoutRock.z)}`);
    ok('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    log(`  note  the shipped arena registers ${res.arenaCircles} solid circles `
      + `against ${res.sceneryMeshes} instanced scenery pieces — every one of `
      + `those is still walk-through until world.js adopts the field (handoff).`);
  } finally {
    await browser.close();
    await server.stop();
  }
}

/**
 * Not an assertion about my own files: a defect in src/world/city.js found
 * while wiring the browser leg, reported here because it blocks the owner's
 * first request ("start in the city, walk around"). Reported, never fixed —
 * city.js belongs to another agent.
 */
async function runCityProbe() {
  head('7. CITY SPAWN PROBE (report only, city.js is not this agent\'s file)');
  const h = await import('./_harness.mjs');
  const server = await h.ensureServer();
  const browser = await h.launchBrowser();
  const { page } = await h.newPhonePage(browser, { width: 892, height: 412 });
  try {
    await h.gotoGame(page, { waitMs: 1800 });
    await page.click('#btnPlay');
    await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 25000 });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const g = window.__game;
      const c = g.mode.city;
      const sp = c.spawnPoint();
      const probe = { x: sp.x, y: sp.y, z: sp.z };
      c.resolve(probe, 0.6, null);
      const spawnInsideSolid = Math.hypot(probe.x - sp.x, probe.z - sp.z) > 1e-6;

      const start = { x: g.player.pos.x, z: g.player.pos.z };
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const walk = dirs.map(([dx, dz]) => {
        const q = { x: start.x, y: g.player.pos.y, z: start.z };
        for (let i = 0; i < 80; i++) { q.x += dx * 0.05; q.z += dz * 0.05; c.resolve(q, 0.6, null); }
        return { dir: `${dx},${dz}`, travelled: +Math.hypot(q.x - start.x, q.z - start.z).toFixed(2) };
      });
      const near = [];
      for (const o of c.obstacles) {
        const d = Math.hypot(o.pos.x - start.x, o.pos.z - start.z);
        if (d < 5) near.push({ x: +o.pos.x.toFixed(1), z: +o.pos.z.toFixed(1), r: o.radius, d: +d.toFixed(2) });
      }
      return { spawn: [sp.x, sp.z], spawnInsideSolid, playerAt: [start.x, start.z], walk, near };
    });
    log(`  City.spawnPoint() = ${JSON.stringify(r.spawn)}  inside a solid: ${r.spawnInsideSolid}`);
    log(`  player spawned at ${JSON.stringify(r.playerAt)}`);
    log(`  4-way walk test (4 units requested): ${r.walk.map((w) => `${w.dir} -> ${w.travelled}u`).join('  ')}`);
    log(`  solids within 5u: ${JSON.stringify(r.near)}`);
    const blocked = r.walk.filter((w) => w.travelled < 1);
    if (r.spawnInsideSolid || blocked.length) {
      log('  ISSUE (city.js, handoff): the hub spawn is pinned against a solid.');
    }
  } finally {
    await browser.close();
    await server.stop();
  }
}

// --------------------------------------------------------------------------

const want = (name) => !ONLY || ONLY === name;

if (want('degrade')) runDegradation();
if (want('solids')) runSolids();
if (want('tunnel')) runTunnelling();
if (want('nav')) runNav();
if (want('perf')) runPerf();
if (!NO_BROWSER && want('browser')) {
  try {
    await runBrowser();
  } catch (e) {
    failures++;
    log(`  FAIL  browser leg threw: ${e.message}`);
  }
  try {
    await runCityProbe();
  } catch (e) {
    log(`  note  city probe unavailable: ${e.message}`);
  }
}

head('RESULT');
log(`  ${checks - failures}/${checks} checks passed`);
if (failures) log(`  ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
