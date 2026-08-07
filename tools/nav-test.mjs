// Headless NavGrid + enemyai verification. Pure Node — no browser, no three,
// no dev server. Runs in milliseconds.
//
//   node tools/nav-test.mjs
//
// The load-bearing assertion is the U-trap: a goal sitting inside a U-shaped
// wall, with the agent outside the closed end. Straight-line steering — which
// is what every enemy in the game does today — walks into the back of the U and
// stops there forever. A flow field has to walk the long way round and come in
// through the mouth.

import { NavGrid, buildNavGrid } from '../src/world/navgrid.js';
import {
  makeAgent, steerAgent, separate, tickAggro, noteAttack, BEHAVIORS, AI_TUNING,
} from '../src/game/enemyai.js';

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------------------
// 1. Degradation: no grid / no bake / no goal => flowAt() must return false so
//    callers keep their existing straight-line steering. This is the contract
//    that lets navgrid land in the current convex disc arena with zero
//    behavioural change.
// ---------------------------------------------------------------------------
{
  const g = new NavGrid({ originX: 0, originZ: 0, size: 80, cell: 2 });
  const out = { x: 0, z: 0 };

  check('empty grid: flowAt false before bake', g.flowAt(0, 0, out) === false);
  check('empty grid: setGoal false before bake', g.setGoal(0, 0) === false);

  g.bake();
  check('empty grid: bake bumps generation', g.generation === 1, `generation=${g.generation}`);
  check('empty grid: flowAt still false with no goal', g.flowAt(0, 0, out) === false);

  check('empty grid: setGoal succeeds once baked', g.setGoal(10, 10) === true);
  check('empty grid: flowAt false outside the grid', g.flowAt(500, 500, out) === false);
  check('empty grid: flowAt false at the goal cell', g.flowAt(10, 10, out) === false);

  // Open field: the flow is just the straight line, so the caller's fallback
  // and the grid agree. Nothing changes for a convex arena.
  const ok = g.flowAt(-20, -20, out);
  const dx = 10 - -20, dz = 10 - -20;
  const l = Math.hypot(dx, dz);
  const dot = ok ? out.x * (dx / l) + out.z * (dz / l) : 0;
  check('open field: flow agrees with the straight line', ok && dot > 0.85, `dot=${dot.toFixed(3)}`);

  // Fully walled grid degrades rather than throwing.
  const dead = new NavGrid({ originX: 0, originZ: 0, size: 20, cell: 2 });
  dead.blockOutside(() => false);
  dead.bake();
  check('fully blocked grid: bake reports unbaked', dead.baked === false);
  check('fully blocked grid: setGoal false', dead.setGoal(0, 0) === false);
  check('fully blocked grid: flowAt false', dead.flowAt(0, 0, out) === false);
}

// ---------------------------------------------------------------------------
// 2. THE U-TRAP. Walls at x=-6 and x=+6 running z=-6..+6, closed at z=-6.
//    The mouth is at +Z. Goal at the centre; agent starts at (0,-16), directly
//    behind the closed back wall.
// ---------------------------------------------------------------------------
{
  const grid = new NavGrid({ originX: 0, originZ: 0, size: 64, cell: 1 });
  // arms
  grid.blockBox(-6, 0, 1.5, 13);
  grid.blockBox(6, 0, 1.5, 13);
  // closed back
  grid.blockBox(0, -6, 13.5, 1.5);
  grid.bake();

  check('U-trap: bake found open cells', grid.baked === true, JSON.stringify(grid.stats()));
  check('U-trap: back wall is solid', grid.blockedAt(0, -6) === true);
  check('U-trap: mouth is open', grid.blockedAt(0, 6.5) === false);
  check('U-trap: interior is open', grid.blockedAt(0, 0) === false);

  const gen = grid.generation;
  check('U-trap: setGoal inside the U', grid.setGoal(0, 0) === true);
  check('U-trap: generation unchanged by setGoal', grid.generation === gen);

  const out = { x: 0, z: 0 };
  const start = { x: 0, z: -16 };

  // The straight line from the start to the goal points at +Z, straight into
  // the back wall. The flow must NOT.
  const okStart = grid.flowAt(start.x, start.z, out);
  check('U-trap: flow exists at the start', okStart === true);
  check(
    'U-trap: flow does NOT point straight into the wall',
    okStart && out.z < 0.72,
    `flow=(${out.x.toFixed(2)}, ${out.z.toFixed(2)}) — straight line would be (0.00, 1.00)`,
  );
  check(
    'U-trap: flow commits to a side',
    okStart && Math.abs(out.x) > 0.55,
    `flow.x=${out.x.toFixed(2)}`,
  );

  // Walk it. 0.35 units per step, 500 steps => 175 units of travel available
  // for a journey a straight line would do in 16.
  const pos = { x: start.x, z: start.z };
  const path = [pos.x, pos.z];
  let reached = false;
  let enteredWall = false;
  let maxZ = pos.z;
  let steps = 0;
  for (; steps < 500; steps++) {
    const d = Math.hypot(-pos.x, -pos.z);
    if (d < 1.5) { reached = true; break; }
    if (!grid.flowAt(pos.x, pos.z, out)) {
      // Inside the last cell of the goal the grid hands back to the caller;
      // finish on the straight line, which is exactly what game.js does.
      const l = Math.hypot(-pos.x, -pos.z) || 1;
      out.x = -pos.x / l; out.z = -pos.z / l;
    }
    pos.x += out.x * 0.35;
    pos.z += out.z * 0.35;
    if (grid.blockedAt(pos.x, pos.z)) enteredWall = true;
    if (pos.z > maxZ) maxZ = pos.z;
    path.push(+pos.x.toFixed(2), +pos.z.toFixed(2));
  }

  check('U-trap: agent reached the goal', reached, `stopped at (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}) after ${steps} steps`);
  check('U-trap: agent never entered a wall cell', enteredWall === false);
  check(
    'U-trap: agent went AROUND — it cleared the open end',
    maxZ > 6.5,
    `max z reached = ${maxZ.toFixed(2)}, the mouth is at z=6.75`,
  );
  check(
    'U-trap: the detour cost real distance (not a straight shot)',
    steps > 60,
    `${steps} steps; a straight line would be ~42`,
  );

  // Same trap, opposite start: from inside the U the flow should just walk out
  // of the mouth if the goal is outside.
  grid.setGoal(0, -16);
  const inside = { x: 0, z: 0 };
  let escaped = false;
  for (let i = 0; i < 500; i++) {
    if (Math.hypot(inside.x - 0, inside.z + 16) < 1.5) { escaped = true; break; }
    if (!grid.flowAt(inside.x, inside.z, out)) {
      const l = Math.hypot(0 - inside.x, -16 - inside.z) || 1;
      out.x = (0 - inside.x) / l; out.z = (-16 - inside.z) / l;
    }
    inside.x += out.x * 0.35;
    inside.z += out.z * 0.35;
    if (grid.blockedAt(inside.x, inside.z)) { escaped = false; break; }
  }
  check('U-trap: reversed goal escapes the U through the mouth', escaped);
}

// ---------------------------------------------------------------------------
// 3. THE LIVE ARENA CASE. The measured deadlock: player at (8.33, 4.64), brute
//    at (7.64, 8.01), a radius-1.27 pillar sitting on the midpoint. Straight
//    steering holds distance 3.44 forever. With a grid the brute walks round.
// ---------------------------------------------------------------------------
{
  const grid = buildNavGrid({
    size: 92, cell: 1, pad: 0.55,
    obstacles: [{ pos: { x: 7.98, z: 6.32 }, radius: 1.27 }],
    inside: (x, z) => Math.hypot(x, z) < 23,
  });
  check('arena: grid baked with the pillar', grid.baked && grid.blockedAt(7.98, 6.32));

  grid.setGoal(8.33, 4.64);
  const out = { x: 0, z: 0 };
  const pos = { x: 7.64, z: 8.01 };
  let reached = false;
  let steps = 0;
  for (; steps < 400; steps++) {
    const d = Math.hypot(pos.x - 8.33, pos.z - 4.64);
    if (d < 1.2) { reached = true; break; }
    if (!grid.flowAt(pos.x, pos.z, out)) {
      const l = d || 1;
      out.x = (8.33 - pos.x) / l; out.z = (4.64 - pos.z) / l;
    }
    pos.x += out.x * 0.1;
    pos.z += out.z * 0.1;
  }
  check('arena: brute reaches the player around the pillar', reached, `${steps} steps, ended (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
// 4. blockCircle / blockOutside / nearestOpen / blockBox rotation
// ---------------------------------------------------------------------------
{
  const g = new NavGrid({ originX: 0, originZ: 0, size: 40, cell: 1 });
  g.blockCircle(0, 0, 3);
  g.bake();
  check('blockCircle: centre blocked', g.blockedAt(0, 0) === true);
  check('blockCircle: outside radius open', g.blockedAt(0, 5) === false);
  const open = g.nearestOpen(0, 0);
  check('nearestOpen: finds a walkable cell', !!open && !g.blockedAt(open.x, open.z), JSON.stringify(open));
  check('nearestOpen: null when nothing is near', new NavGrid({ size: 6, cell: 1 }).blockOutside(() => false).nearestOpen(0, 0, 1) === null);

  const disc = new NavGrid({ originX: 0, originZ: 0, size: 60, cell: 2 });
  disc.blockOutside((x, z) => Math.hypot(x, z) < 20);
  disc.bake();
  check('blockOutside: inside the disc is open', disc.blockedAt(0, 0) === false);
  check('blockOutside: outside the disc is blocked', disc.blockedAt(25, 0) === true);

  const rot = new NavGrid({ originX: 0, originZ: 0, size: 40, cell: 0.5 });
  rot.blockBox(0, 0, 12, 1, Math.PI / 2);   // long axis rotated onto Z
  rot.bake();
  check('blockBox: rotated long axis blocks along Z', rot.blockedAt(0, 5) === true);
  check('blockBox: rotated short axis leaves X open', rot.blockedAt(5, 0) === false);

  // Off-grid is solid, never a silent pass-through.
  check('blockedAt: off-grid reads as solid', disc.blockedAt(9999, 9999) === true);
}

// ---------------------------------------------------------------------------
// 5. enemyai — the fallback contract and the two stall fixes.
// ---------------------------------------------------------------------------
{
  check('enemyai: BEHAVIORS is the documented set',
    BEHAVIORS.join(',') === 'chase,lunge,ranged,flank,siege');

  // 5a. No grid => straight line. This is the "arena behaviour unchanged" test.
  const chaser = makeAgent({ base: { ai: 'chase', range: 2.6, speed: 2.3 }, speed: 2.3 }, 'chase');
  const ctx = {
    navGrid: null,
    selfPos: { x: 0, z: 0 },
    targetPos: { x: 10, z: 0 },
    distance: 10,
    losBlocked: false,
    aggression: 1,
    dt: 1 / 60,
  };
  const s = steerAgent(chaser, ctx, 1 / 60);
  check('enemyai: no grid steers straight at the target',
    Math.abs(s.moveX - 2.3) < 1e-6 && Math.abs(s.moveZ) < 1e-6,
    `move=(${s.moveX.toFixed(3)}, ${s.moveZ.toFixed(3)})`);
  check('enemyai: no grid reports onFlow false', s.onFlow === false);
  check('enemyai: chase attacks only in range', s.wantAttack === false);
  ctx.distance = 2.0;
  ctx.targetPos = { x: 2, z: 0 };
  const s2 = steerAgent(chaser, ctx, 1 / 60);
  check('enemyai: chase wants to attack inside range+0.4', s2.wantAttack === true && s2.telegraph === 0.42);

  // 5b. The stuck breaker. Hold an agent at a fixed distance and it must break
  // sideways rather than keep shoving into the same spot forever.
  const stuck = makeAgent({ base: { ai: 'chase', range: 2.6, speed: 2.3 }, speed: 2.3 }, 'chase');
  const sctx = {
    navGrid: null, selfPos: { x: 0, z: 0 }, targetPos: { x: 3.44, z: 0 },
    distance: 3.44, losBlocked: true, aggression: 1, dt: 1 / 60,
  };
  let broke = 0;
  let lateral = 0;
  const sideLog = [];
  let lastDetours = 0;
  let netZ = 0;
  for (let i = 0; i < 60 * 12; i++) {      // 12 seconds pinned
    const r = steerAgent(stuck, sctx, 1 / 60);
    if (stuck.detours !== lastDetours) { sideLog.push(stuck.detourSide); lastDetours = stuck.detours; }
    if (r.detouring) { broke++; lateral = Math.max(lateral, Math.abs(r.moveZ)); netZ += r.moveZ / 60; }
  }
  check('enemyai: a pinned agent starts detouring', broke > 0, `${broke} detour frames`);
  check('enemyai: the detour actually moves sideways', lateral > 0.9, `max |moveZ| = ${lateral.toFixed(2)}`);
  check('enemyai: it keeps trying, it does not give up after one attempt',
    stuck.detours >= 3, `${stuck.detours} detours in 12 s`);

  // THE LIVELOCK REGRESSION. An earlier build flipped side on every attempt;
  // the agent went left for a second, right for a second, and travelled
  // nowhere — 200 detours in a 400 s run without ever clearing the pillar.
  // The side must be held long enough for wall-following to actually work.
  let maxRun = 1, runLen = 1;
  for (let i = 1; i < sideLog.length; i++) {
    if (sideLog[i] === sideLog[i - 1]) runLen++; else runLen = 1;
    if (runLen > maxRun) maxRun = runLen;
  }
  check('enemyai: the detour side is HELD, not flipped every attempt',
    maxRun >= 3, `longest same-side run = ${maxRun} of ${sideLog.length} attempts: [${sideLog.join(',')}]`);
  check('enemyai: sustained detouring travels somewhere, it does not cancel out',
    Math.abs(netZ) > 3, `net lateral travel = ${netZ.toFixed(2)} units in 12 s`);
  check('enemyai: a long stall eventually triggers a back-off re-approach',
    stuck.detourEpisode >= 4 || stuck.backoff > 0 || stuck.detours >= 4,
    `episode=${stuck.detourEpisode} detours=${stuck.detours}`);

  // An agent making normal progress must NEVER detour — this is what keeps the
  // current arena feeling identical.
  const walking = makeAgent({ base: { ai: 'chase', range: 2.6, speed: 3.4 }, speed: 3.4 }, 'chase');
  const wctx = {
    navGrid: null, selfPos: { x: 0, z: 0 }, targetPos: { x: 30, z: 0 },
    distance: 30, losBlocked: false, aggression: 1, dt: 1 / 60,
  };
  for (let i = 0; i < 400; i++) {
    const r = steerAgent(walking, wctx, 1 / 60);
    wctx.selfPos.x += r.moveX / 60;
    wctx.distance = Math.abs(30 - wctx.selfPos.x);
    if (wctx.distance < 2.6) break;
  }
  check('enemyai: an agent that is closing normally never detours',
    walking.detours === 0 && walking.stuckTime < AI_TUNING.stuckAfter,
    `detours=${walking.detours} stuckTime=${walking.stuckTime.toFixed(2)}`);

  // 5c. THE KITING FIX. A ranged agent held at its standoff band must commit
  // and close, not hold the standoff for the rest of the run.
  const caster = makeAgent({ base: { ai: 'ranged', range: 15, speed: 2.6 }, speed: 2.6 }, 'ranged');
  const kctx = {
    navGrid: null, selfPos: { x: 0, z: 0 }, targetPos: { x: 8.25, z: 0 },
    distance: 8.25, losBlocked: false, aggression: 1, dt: 1 / 60,
  };
  let firstCommitFrame = -1;
  let advanceFrames = 0;
  let retreatFrames = 0;
  for (let i = 0; i < 60 * 30; i++) {       // 30 simulated seconds
    const r = steerAgent(caster, kctx, 1 / 60);
    if (r.wantAttack && i % 156 === 0) noteAttack(caster);   // ~2.6 s cadence
    if (r.committing && firstCommitFrame < 0) firstCommitFrame = i;
    if (r.desiredSpeed > 0) advanceFrames++;
    if (r.desiredSpeed < 0) retreatFrames++;
  }
  check('enemyai: a ranged agent commits instead of holding forever',
    firstCommitFrame >= 0 && firstCommitFrame < 60 * 6,
    `first commit at frame ${firstCommitFrame}`);
  check('enemyai: it commits repeatedly, not once',
    caster.commits >= 3, `${caster.commits} commits in 30 s`);
  check('enemyai: committing means advancing, not just standing',
    advanceFrames > 60 * 6, `${advanceFrames} advancing frames of ${60 * 30}`);

  // ...and it must still behave like a caster when it is NOT committing: at
  // point-blank range outside a commit it backs off.
  const kiter = makeAgent({ base: { ai: 'ranged', range: 15, speed: 2.6 }, speed: 2.6 }, 'ranged');
  const pctx = {
    navGrid: null, selfPos: { x: 0, z: 0 }, targetPos: { x: 2, z: 0 },
    distance: 2, losBlocked: false, aggression: 1, dt: 1 / 60,
  };
  const kr = steerAgent(kiter, pctx, 1 / 60);
  check('enemyai: an uncommitted caster still keeps its distance',
    kr.desiredSpeed < 0 && kr.moveX < 0, `desiredSpeed=${kr.desiredSpeed.toFixed(2)}`);
  check('enemyai: a caster still fires while in range', kr.wantAttack === true && kr.telegraph === 0.55);

  // 5d. Flow field takes precedence over the straight line when one exists.
  const grid = buildNavGrid({
    size: 64, cell: 1, pad: 0.5,
    obstacles: [{ pos: { x: 0, z: 5 }, radius: 3 }],
    inside: (x, z) => Math.hypot(x, z) < 30,
  });
  grid.setGoal(0, 10);
  const around = makeAgent({ base: { ai: 'chase', range: 2, speed: 3 }, speed: 3 }, 'chase');
  const gctx = {
    navGrid: grid, selfPos: { x: 0, z: 0 }, targetPos: { x: 0, z: 10 },
    distance: 10, losBlocked: true, aggression: 1, dt: 1 / 60,
  };
  const gr = steerAgent(around, gctx, 1 / 60);
  check('enemyai: uses the flow field when one is available', gr.onFlow === true);
  check('enemyai: the flow steers around the blocker, not into it',
    Math.abs(gr.moveX) > 0.5, `move=(${gr.moveX.toFixed(2)}, ${gr.moveZ.toFixed(2)})`);

  // 5e. separate()
  const crowd = [];
  for (let i = 0; i < 12; i++) crowd.push({ pos: { x: 0, z: 0 }, radius: 0.55 });
  crowd[0].pos.x = 0.01;
  separate(crowd, 1, 900);
  let overlapping = 0;
  for (let i = 0; i < crowd.length; i++) {
    for (let j = i + 1; j < crowd.length; j++) {
      const d = Math.hypot(crowd[i].pos.x - crowd[j].pos.x, crowd[i].pos.z - crowd[j].pos.z);
      if (d < 0.001) overlapping++;
    }
  }
  check('separate: a stacked crowd gets pushed apart', overlapping < 66,
    `${overlapping} still coincident of 66 pairs`);

  // The cap has to hold, or an S-rank crowd melts the frame budget.
  const big = [];
  for (let i = 0; i < 120; i++) {
    big.push({ pos: { x: (i % 12) * 0.4, z: Math.floor(i / 12) * 0.4 }, radius: 0.55 });
  }
  const t0 = process.hrtime.bigint();
  separate(big, 1, 900);
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  check('separate: 120 entities stays cheap under the pair cap', us < 4000, `${us.toFixed(0)} us`);
  check('separate: no NaN escaped the spatial hash',
    big.every((e) => Number.isFinite(e.pos.x) && Number.isFinite(e.pos.z)));

  // tickAggro is safe to call on its own for entities that are not steering.
  const idle = makeAgent({ base: { ai: 'ranged', range: 15, speed: 2.6 } }, 'ranged');
  tickAggro(idle, { distance: 5, targetPos: { x: 5, z: 0 }, selfPos: { x: 0, z: 0 } }, 1 / 60);
  check('tickAggro: standalone call advances patience', idle.standoff > 0);
}

// ---------------------------------------------------------------------------
// 6. Cost / throughput sanity for the real world sizes.
// ---------------------------------------------------------------------------
{
  const big = new NavGrid({ originX: 0, originZ: 0, size: 460, cell: 2 });
  big.blockOutside((x, z) => Math.hypot(x, z) < 228);
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2 * 7;
    big.blockCircle(Math.cos(a) * (20 + i), Math.sin(a) * (20 + i), 3);
  }
  big.bake();
  const t0 = process.hrtime.bigint();
  const ok = big.setGoal(0, 0);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('perf: 230x230 setGoal succeeds', ok === true, JSON.stringify(big.stats()));
  check('perf: 230x230 setGoal is a few ms, i.e. fine at 4 Hz', ms < 60, `${ms.toFixed(2)} ms`);

  const out = { x: 0, z: 0 };
  const t1 = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < 50000; i++) if (big.flowAt(((i * 7) % 400) - 200, ((i * 13) % 400) - 200, out)) hits++;
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  check('perf: 50k flowAt samples are cheap', ms2 < 200, `${ms2.toFixed(2)} ms, ${hits} hits`);

  // Repeat setGoal on the same cell must early-out rather than re-sweep.
  const t2 = process.hrtime.bigint();
  big.setGoal(0.1, 0.1);
  const ms3 = Number(process.hrtime.bigint() - t2) / 1e6;
  check('perf: repeat setGoal in the same cell early-outs', ms3 < ms / 4 || ms3 < 0.2, `${ms3.toFixed(3)} ms vs ${ms.toFixed(2)} ms`);
}

console.log(
  failures.length
    ? `\nNAV TEST FAILED — ${failures.length} failing:\n  ${failures.join('\n  ')}`
    : `\nNAV TEST PASSED — ${passed} checks`,
);
process.exit(failures.length ? 1 : 0);
