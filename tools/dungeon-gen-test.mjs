// Dungeon layout generation soak — DUNGEON_SPEC.json testStrategy.unit_generation.
//
//   node tools/dungeon-gen-test.mjs             # 200 seeds x {E, D}
//   node tools/dungeon-gen-test.mjs --seeds=20  # quick pass
//
// Plain Node, no browser, no vite: dungeonlayout.js is deliberately THREE-free
// so this can hammer hundreds of layouts per second. Per layout it asserts the
// spec's invariants (reachability, boss depth, door spans, room counts/sizes,
// mask consistency, the (0,0) entry translation with -Z drift, spawn-point
// wall clearance and spacing, exact budget sums) and byte-compares a repeat
// generation of the same seed — determinism is the context-loss repair path,
// so it is tested as a hard invariant, not a nice-to-have.
//
// Writes a stats JSON (writeReport shape, honours GB_OUT) for tuning eyeballs.
// C runs the STEP 8 cavern kind through its own invariant set (zones are
// discs, zones carry no doors, the boss grotto is unreachable with its neck
// membrane blocked, the stalagmite field honours every clearing radius).

import {
  generateLayout, layoutStats, LAYOUT_PARAMS, COVER_KINDS, COVER_MIN_TOP,
  bossAnchor, exitAnchor,
} from '../src/world/dungeonlayout.js';
import { ObstacleField } from '../src/world/obstacles.js';
import { mulberry32 } from '../src/core/rng.js';
// THE LIVE WAVE, not a hardcoded number. Wave 3-A2 made concurrency a per-run
// ROLL out of GATES[].waveBand (E 6-8 / D 8-10 / C 10-12) and gave the boss
// chamber its own add pack, which stranded the two `need >= 6 // waveSize C is
// 6` constants that used to live below: they were the whole reason this soak
// could claim a room can hold its fight, and they were describing the game as
// it was two waves ago. config.js is THREE-free and importable here (its only
// import is core/rng.js), so the bar is read from the shipping table instead of
// copied next to it.
import { GATES, PROJECTILE_Y } from '../src/game/config.js';
import { writeReport } from './_harness.mjs';

/**
 * Spawn points a room must offer, by kind.
 *
 * _spawnOne walks the point ring with a cursor and reuses points when it runs
 * out, so a short menu does not crash — it stacks bodies on each other and lets
 * separate() shove them apart, which is exactly the "the room looks empty with
 * a clump in it" failure this wave was called in to fix. So the bar is the
 * WORST CASE the director can ask for:
 *   combat/treasure  the top of the gate's waveBand — every live body at once
 *   boss             1 boss + bossAdds.live
 *   entry            4, the shadow escort's deploy minimum (never a fight room)
 * Cover PRUNES this menu (buildCover's last pass drops points inside the new
 * field), so this is also the assert that stops a future cover retune from
 * quietly starving a room.
 */
function spawnPointsNeeded(rank, kind) {
  const gate = GATES.find((g) => g.rank === rank);
  if (kind === 'entry') return 4;
  if (kind === 'boss') return 1 + (gate?.bossAdds?.live ?? 0);
  const band = gate?.waveBand;
  return Array.isArray(band) ? Math.max(band[0], band[1]) : (gate?.waveSize ?? 6);
}

const argv = process.argv.slice(2);
const SEEDS = Number((argv.find((a) => a.startsWith('--seeds=')) || '').split('=')[1]) || 200;
const RANKS = ['E', 'D', 'C'];

let checks = 0;
let failures = 0;
const failLines = [];

function ok(pass, label) {
  checks++;
  if (!pass) {
    failures++;
    if (failLines.length < 40) failLines.push(label);
  }
  return pass;
}

// Stable byte serialization: JSON with typed arrays as base64.
function serialize(layout) {
  return Buffer.from(JSON.stringify(layout, (k, v) => (
    v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v
  )));
}

const f1 = (n) => n.toFixed(1);

// config.js SKILLS.dash.distance — room sizes are asserted in DASH UNITS, so
// the number lives here rather than as a magic 7.5 inside the checks.
const DASH = 7.5;

// Point-to-axis-aligned-box surface distance (every run has rot 0).
function runDistance(p, run) {
  const dx = Math.max(Math.abs(p.x - run.x) - run.w / 2, 0);
  const dz = Math.max(Math.abs(p.z - run.z) - run.d / 2, 0);
  return Math.hypot(dx, dz);
}

function checkLayout(rank, seed, layout, params) {
  if (layout.kind === 'cavern') return checkCavernLayout(rank, seed, layout, params);
  const tag = `${rank}/${seed}`;
  const R = layout.rooms;

  // --- reachability: BFS over doors, every room reached from entry ---------
  const adj = Array.from({ length: R.length }, () => []);
  for (const d of layout.doors) {
    if (d.roomA >= 0 && d.roomB >= 0) {
      adj[d.roomA].push(d.roomB);
      adj[d.roomB].push(d.roomA);
    }
  }
  const seen = new Set([0]);
  const q = [0];
  while (q.length) {
    const cur = q.shift();
    for (const nb of adj[cur]) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  ok(seen.size === R.length, `${tag}: ${R.length - seen.size} unreachable room(s)`);

  // --- boss depth ----------------------------------------------------------
  ok(layout.depth >= params.minBossDepth,
    `${tag}: boss depth ${layout.depth} < ${params.minBossDepth}`);
  ok(R[layout.bossRoom].kind === 'boss', `${tag}: bossRoom is ${R[layout.bossRoom].kind}`);
  ok(layout.criticalPath[0] === 0 && layout.criticalPath.at(-1) === layout.bossRoom,
    `${tag}: criticalPath endpoints ${layout.criticalPath[0]}..${layout.criticalPath.at(-1)}`);

  // --- door spans ----------------------------------------------------------
  for (const d of layout.doors) {
    ok(d.w >= 4, `${tag}: door ${d.id} span ${d.w} < 4 m`);
  }

  // --- room counts and sizes -----------------------------------------------
  const kinds = { entry: 0, combat: 0, treasure: 0, boss: 0 };
  for (const r of R) kinds[r.kind]++;
  ok(kinds.entry === 1 && kinds.boss === 1, `${tag}: entry/boss counts ${kinds.entry}/${kinds.boss}`);
  const regular = R.length - 2;
  ok(regular >= params.rooms[0] && regular <= params.rooms[1],
    `${tag}: ${regular} regular rooms outside ${params.rooms}`);
  if (params.treasure.guaranteed) {
    // "Exactly one" holds whenever the topology allows it: a rare pure-chain
    // layout can put EVERY room on the critical path, and treasure is defined
    // as off-path — zero is only legal in exactly that case.
    const onPath = new Set(layout.criticalPath);
    const offPath = R.filter((r) => (r.kind === 'combat' || r.kind === 'treasure') && !onPath.has(r.id));
    ok(kinds.treasure === 1 || (kinds.treasure === 0 && offPath.length === 0),
      `${tag}: ${kinds.treasure} treasure rooms with ${offPath.length} off-path candidates`);
  } else {
    ok(kinds.treasure <= 1, `${tag}: ${kinds.treasure} treasure rooms, expected 0-1`);
  }
  const sizeOk = ({ w, d }, s) =>
    w >= s.w[0] * 2 && w <= s.w[1] * 2 && d >= s.d[0] * 2 && d <= s.d[1] * 2;
  const entrySize = params.entrySize || params.roomSize;
  for (const r of R) {
    if (r.kind === 'boss') {
      // Since wave 3 the boss chamber is PLACED at bossSize, not grown toward
      // it — exact, or the layout regenerates. That is the whole point: the
      // grow path silently under-delivered the arena on a crowded grid.
      ok(r.w === params.bossSize.w * 2 && r.d === params.bossSize.d * 2,
        `${tag}: boss room ${r.w}x${r.d}, expected exactly ${params.bossSize.w * 2}x${params.bossSize.d * 2}`);
    } else if (r.kind === 'entry') {
      ok(sizeOk(r, entrySize), `${tag}: entry room ${r.w}x${r.d} outside entrySize`);
    } else {
      const fits = sizeOk(r, params.roomSize) || (params.vault && sizeOk(r, params.vault));
      ok(fits, `${tag}: room ${r.id} (${r.kind}) ${r.w}x${r.d} outside size params`);
    }
  }

  // --- DASH-UNIT sizing rule (the wave-3 "room to fight in" contract) -------
  // config.js SKILLS.dash.distance = 7.5 m. A combat room must be >= 3 dashes
  // across its SHORT axis or a dodge has nowhere to land; the boss chamber
  // must be >= 5 dashes on BOTH axes or the fight cannot be kited. These are
  // the numbers the owner asked for, so they are asserted, not assumed.
  for (const r of R) {
    if (r.kind === 'combat' || r.kind === 'treasure') {
      ok(Math.min(r.w, r.d) >= 3 * DASH,
        `${tag}: room ${r.id} short axis ${f1(Math.min(r.w, r.d))} m = ${(Math.min(r.w, r.d) / DASH).toFixed(2)} dashes < 3`);
    } else if (r.kind === 'boss') {
      ok(Math.min(r.w, r.d) >= 5 * DASH,
        `${tag}: boss ${f1(Math.min(r.w, r.d))} m = ${(Math.min(r.w, r.d) / DASH).toFixed(2)} dashes < 5`);
    }
  }

  // --- mask consistency ----------------------------------------------------
  // Reclaim every cell from the exported rects; assert single ownership, that
  // claims match the mask exactly, that no two rooms touch directly, and that
  // every room<->corridor adjacency is covered by a registered door — a bare
  // (door-less) opening would let enemies walk past a sealed membrane.
  const { w, h, cell, originX, originZ, mask } = layout;
  const gx = (x) => Math.round((x - originX) / cell);
  const gz = (z) => Math.round((z - originZ) / cell);
  const claim = new Int16Array(w * h).fill(-1);   // -1 rock, -2 corridor, id room
  let doubleClaim = 0;
  const stamp = (r, val) => {
    const x0 = gx(r.x ?? r.cx);
    const z0 = gz(r.z ?? r.cz);
    for (let z = z0; z < z0 + Math.round(r.d / cell); z++) {
      for (let x = x0; x < x0 + Math.round(r.w / cell); x++) {
        if (claim[x + z * w] !== -1) doubleClaim++;
        claim[x + z * w] = val;
      }
    }
  };
  for (const r of R) stamp(r, r.id);
  for (const c of layout.corridors) stamp({ x: c.x - c.w / 2, z: c.z - c.d / 2, w: c.w, d: c.d }, -2);
  ok(doubleClaim === 0, `${tag}: ${doubleClaim} double-claimed cells (room/corridor overlap)`);
  let claimMismatch = 0;
  for (let i = 0; i < w * h; i++) {
    if ((mask[i] === 1) !== (claim[i] !== -1)) claimMismatch++;
  }
  ok(claimMismatch === 0, `${tag}: ${claimMismatch} cells where mask and room/corridor rects disagree`);

  // Door openings in grid space, for the adjacency coverage check.
  const doorCells = new Set();
  for (const d of layout.doors) {
    const span = Math.round(d.w / cell);
    if (d.rot === 0) {
      const plane = Math.round((d.z - originZ) / cell);
      const lo = Math.round((d.x - d.w / 2 - originX) / cell);
      for (let i = 0; i < span; i++) doorCells.add(`z:${plane}:${lo + i}`);
    } else {
      const plane = Math.round((d.x - originX) / cell);
      const lo = Math.round((d.z - d.w / 2 - originZ) / cell);
      for (let i = 0; i < span; i++) doorCells.add(`x:${plane}:${lo + i}`);
    }
  }
  let roomTouch = 0;
  let bareOpening = 0;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w - 1; x++) {
      const a = claim[x + z * w];
      const b = claim[x + 1 + z * w];
      if (a === -1 || b === -1 || a === b) continue;
      if (a >= 0 && b >= 0) { roomTouch++; continue; }
      if (!doorCells.has(`x:${x + 1}:${z}`)) bareOpening++;
    }
  }
  for (let z = 0; z < h - 1; z++) {
    for (let x = 0; x < w; x++) {
      const a = claim[x + z * w];
      const b = claim[x + (z + 1) * w];
      if (a === -1 || b === -1 || a === b) continue;
      if (a >= 0 && b >= 0) { roomTouch++; continue; }
      if (!doorCells.has(`z:${z + 1}:${x}`)) bareOpening++;
    }
  }
  ok(roomTouch === 0, `${tag}: ${roomTouch} direct room-to-room adjacencies (no separating wall)`);
  ok(bareOpening === 0, `${tag}: ${bareOpening} room/corridor adjacencies not covered by a door`);

  // --- entry translation + drift -------------------------------------------
  ok(layout.entry.x === 0 && layout.entry.z === 0 && layout.entry.yaw === 0,
    `${tag}: entry ${JSON.stringify(layout.entry)}`);
  ok(mask[gx(0) + gz(0) * w] === 1, `${tag}: spawn (0,0) is not on floor`);
  const meanZ = R.reduce((s, r) => s + r.centre.z, 0) / R.length;
  ok(meanZ < 0, `${tag}: mean room centre z ${f1(meanZ)} — no -Z drift`);

  // --- spawn points --------------------------------------------------------
  for (const r of R) {
    const need = spawnPointsNeeded(rank, r.kind);
    ok(r.spawnPoints.length >= need,
      `${tag}: room ${r.id} (${r.kind}) has ${r.spawnPoints.length} spawn points, need ${need}`);
    for (const p of r.spawnPoints) {
      let minD = Infinity;
      for (const run of layout.wallRuns) {
        const d = runDistance(p, run);
        if (d < minD) minD = d;
      }
      ok(minD >= 1.5, `${tag}: room ${r.id} spawn point ${f1(minD)} m from a wall run`);
    }
    for (let i = 0; i < r.spawnPoints.length; i++) {
      for (let j = i + 1; j < r.spawnPoints.length; j++) {
        const a = r.spawnPoints[i];
        const b = r.spawnPoints[j];
        ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2.4,
          `${tag}: room ${r.id} spawn points ${i}/${j} closer than 2.4 m`);
      }
    }
  }

  // --- budgets -------------------------------------------------------------
  const total = R.reduce((s, r) => s + r.budget, 0);
  ok(total === params.enemies, `${tag}: budgets sum ${total} != gate.enemies ${params.enemies}`);
  for (const r of R) {
    if (r.kind === 'combat') ok(r.budget >= 1, `${tag}: combat room ${r.id} budget ${r.budget}`);
    else ok(r.budget === 0, `${tag}: ${r.kind} room ${r.id} has budget ${r.budget}`);
  }
}

// ---------------------------------------------------------------------------
// interior cover invariants (wave 3-A2)
// ---------------------------------------------------------------------------
// The cover field only earns its place if it does three things at once, so all
// three are measured against the REAL ObstacleField the game builds — not
// against the layout records, which is how a "1 blocked cell in 1296" boss
// chamber shipped while the generator claimed columns everywhere.
//
//   1. It breaks line of sight. lineBlocked() over random chords must actually
//      stop caster shots, or the cover is decorative.
//   2. It leaves the room traversable. A flood fill at body radius over the
//      real collision field must reach 100% of every room's open floor from
//      its centre — one connected component, no pocket walled off by scenery.
//   3. It clears everything the game puts down later: doors, the boss's rise
//      anchor, the exit portal, the treasure chest, and the spawn menu.
//
// obstacles.js is deliberately THREE-free (same discipline as dungeonlayout),
// so this all runs in plain Node at soak speed.

const BODY_RADIUS = 0.45;      // player/enemy collision radius, metres
const FILL_STEP = 0.5;         // flood-fill lattice pitch, metres
// LOS floor: measured over 8 seeds x 2 ranks the boss chambers block 30.7-45.3%
// of random sightlines (mean E 37.0 / D 39.2) against 0.0% before this wave.
// 15% is a regression tripwire well under the observed floor, not a target.
const LOS_FLOOR_BOSS = 0.15;

/** The collision field a Dungeon build registers, minus the THREE half. */
function coverField(layout) {
  const f = new ObstacleField({ stepOver: 0.4 });
  for (const run of layout.wallRuns) {
    f.addBox(run.x, run.z, run.w, run.d, run.rot, { tag: 'wall', nav: false });
  }
  // Membranes are registered open (top 0): the traversability question is
  // "can the player walk this room", not "can they walk a sealed door".
  for (const d of layout.doors) {
    f.addBox(d.x, d.z, d.w, d.d, d.rot, { top: 0, nav: false, tag: 'membrane' });
  }
  for (const c of layout.decor.columns.slice(0, 20)) {
    f.addCircle(c.x, c.z, 0.34, { nav: false, tag: 'column' });
  }
  for (const c of layout.decor.cover) {
    const k = COVER_KINDS[c.kind];
    if (k.shape === 'circle') f.addCircle(c.x, c.z, k.r, { nav: false, tag: 'cover' });
    else f.addBox(c.x, c.z, k.hx * 2, k.hz * 2, c.yaw, { top: k.top, nav: false, tag: 'cover' });
  }
  return f.build();
}

/**
 * Blocked cells / total on a 1 m lattice inset 1 m from the room's walls,
 * sampled AT THE BOLT PLANE (config.PROJECTILE_Y). The first pass of this
 * system sampled at a hardcoded 1.2 while the boss fired from 2.4, so every
 * cover figure it published described a height nothing shot at.
 */
function blockedCells(field, room) {
  const nx = Math.floor(room.w - 2);
  const nz = Math.floor(room.d - 2);
  let blocked = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (field.blocked(room.x + 1 + i + 0.5, room.z + 1 + j + 0.5, 0, 0, PROJECTILE_Y)) blocked++;
    }
  }
  return { blocked, total: nx * nz };
}

/** Fraction of >= 6 m chords a bolt cannot make, at the bolt plane. */
function losBlocked(field, room, rnd, n) {
  let blocked = 0;
  let drawn = 0;
  let guard = 0;
  while (drawn < n && guard++ < n * 20) {
    const ax = room.x + 1.5 + rnd() * (room.w - 3);
    const az = room.z + 1.5 + rnd() * (room.d - 3);
    const bx = room.x + 1.5 + rnd() * (room.w - 3);
    const bz = room.z + 1.5 + rnd() * (room.d - 3);
    if (Math.hypot(bx - ax, bz - az) < 6) continue;
    drawn++;
    if (field.lineBlocked(ax, az, bx, bz, { feetY: PROJECTILE_Y })) blocked++;
  }
  return drawn ? blocked / drawn : 0;
}

/** Open cells reachable from the room's centre-most open cell / open cells. */
function connectivity(field, room) {
  const nx = Math.round(room.w / FILL_STEP);
  const nz = Math.round(room.d / FILL_STEP);
  const open = new Uint8Array(nx * nz);
  let total = 0;
  let seed = -1;
  let seedD = Infinity;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = room.x + (i + 0.5) * FILL_STEP;
      const z = room.z + (j + 0.5) * FILL_STEP;
      // feetY 0 + stepOver 0.4: what a BODY can stand in, so kerb-height
      // rubble correctly counts as walkable and cover correctly does not.
      if (field.blocked(x, z, BODY_RADIUS, 0.4, 0)) continue;
      open[i + j * nx] = 1;
      total++;
      const d = Math.hypot(x - room.centre.x, z - room.centre.z);
      if (d < seedD) { seedD = d; seed = i + j * nx; }
    }
  }
  if (seed < 0) return { reached: 0, total: 0 };
  const seen = new Uint8Array(nx * nz);
  seen[seed] = 1;
  const q = [seed];
  for (let qi = 0; qi < q.length; qi++) {
    const ci = q[qi] % nx;
    const cj = (q[qi] / nx) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + dx;
      const nj = cj + dz;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const k = ni + nj * nx;
      if (!open[k] || seen[k]) continue;
      seen[k] = 1;
      q.push(k);
    }
  }
  return { reached: q.length, total };
}

function checkCover(rank, seed, layout, params, deep) {
  const cfg = params.cover;
  if (!cfg) {
    ok(layout.decor.cover.length === 0, `${rank}/${seed}: rank has no cover config but rolled cover`);
    return null;
  }
  const tag = `${rank}/${seed}`;
  const field = coverField(layout);
  const rnd = mulberry32((seed ^ 0xc0feba5e) >>> 0);   // test-local, not the generator's
  const byRoom = new Map();
  for (const c of layout.decor.cover) {
    if (!byRoom.has(c.room)) byRoom.set(c.room, []);
    byRoom.get(c.room).push(c);
  }

  // --- presence ------------------------------------------------------------
  for (const r of layout.rooms) {
    const list = byRoom.get(r.id) || [];
    if (r.kind === 'entry') {
      ok(list.length === 0, `${tag}: entry room carries ${list.length} cover pieces (it is a deploy pad)`);
      continue;
    }
    const need = r.kind === 'boss' ? 5 : cfg.minPieces;
    ok(list.length >= need,
      `${tag}: ${r.kind} room ${r.id} (${r.w}x${r.d}) has ${list.length} cover pieces, need ${need}`);
  }

  // --- clearances (rule (c)) ----------------------------------------------
  for (const r of layout.rooms) {
    const list = byRoom.get(r.id) || [];
    if (!list.length) continue;
    const myDoors = r.doors.map((id) => layout.doors[id]).filter(Boolean);
    const anchors = [];
    if (r.kind === 'boss') {
      const a = bossAnchor(r, myDoors[0] || null);
      const e = exitAnchor(r, myDoors[0] || null);
      anchors.push(['boss rise anchor', a, cfg.bossClear]);
      anchors.push(['exit portal', e, cfg.exitClear]);
    }
    if (r.kind === 'treasure') {
      anchors.push(['treasure centre', r.centre, cfg.centreClear]);
    }
    for (const c of list) {
      const reach = Math.max(c.ex, c.ez);
      ok(c.x - c.ex >= r.x + cfg.wallInset - 1e-9 && c.x + c.ex <= r.x + r.w - cfg.wallInset + 1e-9
        && c.z - c.ez >= r.z + cfg.wallInset - 1e-9 && c.z + c.ez <= r.z + r.d - cfg.wallInset + 1e-9,
      `${tag}: cover in room ${r.id} breaks the ${cfg.wallInset} m wall band`);
      for (const d of myDoors) {
        ok(Math.hypot(c.x - d.x, c.z - d.z) >= cfg.doorClear + reach - 1e-9,
          `${tag}: cover ${f1(Math.hypot(c.x - d.x, c.z - d.z))} m from door ${d.id} (need ${(cfg.doorClear + reach).toFixed(1)})`);
      }
      for (const [name, p, clear] of anchors) {
        ok(Math.hypot(c.x - p.x, c.z - p.z) >= clear + reach - 1e-9,
          `${tag}: cover sits on the ${name} in room ${r.id}`);
      }
      for (const p of r.spawnPoints) {
        ok(!(Math.abs(p.x - c.x) < c.ex + cfg.spawnClear && Math.abs(p.z - c.z) < c.ez + cfg.spawnClear),
          `${tag}: room ${r.id} spawn point survived inside a cover footprint`);
      }
    }
    // Dash lanes (rule (b)): every pair separated on at least one axis.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        ok(Math.abs(a.x - b.x) >= a.ex + b.ex + cfg.lane - 1e-9
          || Math.abs(a.z - b.z) >= a.ez + b.ez + cfg.lane - 1e-9,
        `${tag}: room ${r.id} cover pair ${i}/${j} leaves under ${cfg.lane} m of dash lane`);
      }
    }
  }

  // --- what the collision field actually measures ---------------------------
  const boss = layout.rooms[layout.bossRoom];
  const cells = blockedCells(field, boss);
  const los = losBlocked(field, boss, rnd, 600);
  // Rule (a) as a contract, not a comment: a piece whose collision top does
  // not clear the bolt plane is scenery. This is the assert that would have
  // caught the first pass designing the field for 1.2 m while the boss fired
  // from 2.4 — rubble tops out at 1.75, so it stops a 1.6 m bolt and does not
  // stop a 2.4 m one.
  for (const [name, k] of Object.entries(COVER_KINDS)) {
    ok(k.top >= COVER_MIN_TOP,
      `${tag}: COVER_KINDS.${name} top ${k.top} does not clear the bolt plane `
      + `(PROJECTILE_Y ${PROJECTILE_Y} + 0.1 = ${COVER_MIN_TOP})`);
  }
  ok(cells.blocked > 0,
    `${tag}: boss chamber blocks 0 of ${cells.total} cells at the bolt plane — it is an empty box`);
  ok(los >= LOS_FLOOR_BOSS,
    `${tag}: boss chamber blocks only ${(los * 100).toFixed(1)}% of sightlines (floor ${LOS_FLOOR_BOSS * 100}%)`);

  // --- traversability (rule (b)) -------------------------------------------
  // The expensive one, so it is strided: `deep` seeds fill every room, the
  // rest fill the boss chamber (the densest room and the only one with a
  // scripted composition).
  const fillRooms = deep ? layout.rooms : [boss];
  for (const r of fillRooms) {
    if (r.kind === 'entry') continue;
    const conn = connectivity(field, r);
    ok(conn.total > 0 && conn.reached === conn.total,
      `${tag}: room ${r.id} (${r.kind}) walkable floor is ${conn.total - conn.reached} of ${conn.total} cells cut off by cover`);
  }

  // --- is the boss chamber the BEST-dressed room, or just the biggest? -----
  // The room the owner named ("especially for the boss room") has to be the
  // one where cover matters most, and the first pass shipped the opposite:
  // measured over 40 seeds/rank the E chamber was 1.68% of cells blocked and
  // stopped 18.2% of sightlines against 1.83% / 20.4% for an ordinary combat
  // room — per unit area, no better dressed, just bigger. Density (blocked
  // cells / total cells) is the size-independent comparison; the peer figure
  // is the mean over the gate's ordinary combat rooms. Only on `deep` seeds:
  // it is another N room-fills of chords.
  let peerDensity = -1;
  let peerLos = -1;
  if (deep) {
    const peers = layout.rooms.filter((r) => r.kind !== 'entry' && r.id !== layout.bossRoom);
    if (peers.length) {
      let ds = 0;
      let ls = 0;
      for (const r of peers) {
        const c2 = blockedCells(field, r);
        ds += c2.total ? c2.blocked / c2.total : 0;
        ls += losBlocked(field, r, rnd, 200);
      }
      peerDensity = ds / peers.length;
      peerLos = ls / peers.length;
    }
  }

  return {
    pieces: layout.decor.cover.length,
    bossPieces: (byRoom.get(layout.bossRoom) || []).length,
    bossBlockedCells: cells.blocked,
    bossTotalCells: cells.total,
    bossLos: +(los * 100).toFixed(1),
    bossDensity: cells.total ? cells.blocked / cells.total : 0,
    peerDensity,
    peerLos,
  };
}

// ---------------------------------------------------------------------------
// cavern invariants — DUNGEON_SPEC STEP 8
// ---------------------------------------------------------------------------

function checkCavernLayout(rank, seed, layout, params) {
  const tag = `${rank}/${seed}`;
  const R = layout.rooms;
  const { w, h, cell, originX, originZ, mask } = layout;
  const gxOf = (x) => Math.floor((x - originX) / cell);
  const gzOf = (z) => Math.floor((z - originZ) / cell);
  const floorAt = (x, z) => {
    const gx = gxOf(x);
    const gz = gzOf(z);
    return gx >= 0 && gz >= 0 && gx < w && gz < h && mask[gx + gz * w] === 1;
  };

  // --- rooms: 1 entry + [4,5] zones + 1 boss, all discs on floor -----------
  const kinds = { entry: 0, combat: 0, treasure: 0, boss: 0 };
  for (const r of R) kinds[r.kind]++;
  ok(kinds.entry === 1 && kinds.boss === 1 && kinds.treasure === 0,
    `${tag}: kinds ${JSON.stringify(kinds)}`);
  ok(kinds.combat >= params.rooms[0] && kinds.combat <= params.rooms[1],
    `${tag}: ${kinds.combat} zones outside ${params.rooms}`);
  for (const r of R) {
    ok(r.radius > 0, `${tag}: room ${r.id} has no trigger-disc radius`);
    ok(floorAt(r.centre.x, r.centre.z), `${tag}: room ${r.id} centre is not on floor`);
  }
  // Zone separation: no zone centre may sit inside another zone's disc, or
  // trigger membership turns on record order.
  const zones = R.filter((r) => r.kind === 'combat');
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const d = Math.hypot(
        zones[i].centre.x - zones[j].centre.x, zones[i].centre.z - zones[j].centre.z,
      );
      ok(d >= params.zoneRadius, `${tag}: zones ${zones[i].id}/${zones[j].id} ${f1(d)} m apart`);
    }
  }

  // --- DASH-UNIT sizing rule, cavern form ----------------------------------
  // A zone is a trigger disc in open rock, not a walled room, so the thing to
  // measure is the FREE FLOOR around its centre: march rays until they hit
  // rock and take the worst. That has to clear 3 dashes across (>= 11.25 m of
  // free radius) exactly like a crawl room. The boss grotto DOES have walls
  // (it is the one C space that seals), so it takes the 5-dash boss rule.
  const freeRadius = (cx, cz) => {
    let worst = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      let d = 0;
      while (d < 90 && floorAt(cx + Math.cos(a) * d, cz + Math.sin(a) * d)) d += 0.5;
      if (d < worst) worst = d;
    }
    return worst;
  };
  for (const r of R) {
    if (r.kind === 'combat') {
      const fr = freeRadius(r.centre.x, r.centre.z);
      ok(fr >= 1.5 * DASH,
        `${tag}: zone ${r.id} free radius ${f1(fr)} m = ${(fr * 2 / DASH).toFixed(2)} dashes across < 3`);
    } else if (r.kind === 'boss') {
      ok(r.radius * 2 >= 5 * DASH,
        `${tag}: boss grotto ${f1(r.radius * 2)} m = ${(r.radius * 2 / DASH).toFixed(2)} dashes across < 5`);
    }
  }

  // --- boss depth / path ----------------------------------------------------
  ok(layout.depth >= params.minBossDepth, `${tag}: depth ${layout.depth} < ${params.minBossDepth}`);
  ok(R[layout.bossRoom].kind === 'boss', `${tag}: bossRoom is ${R[layout.bossRoom].kind}`);
  ok(layout.criticalPath[0] === 0 && layout.criticalPath.at(-1) === layout.bossRoom,
    `${tag}: criticalPath endpoints ${layout.criticalPath[0]}..${layout.criticalPath.at(-1)}`);

  // --- doors: entry arch + boss neck ONLY; zones are doorless --------------
  ok(layout.doors.length === 2, `${tag}: ${layout.doors.length} doors, expected 2`);
  for (const d of layout.doors) ok(d.w >= 4, `${tag}: door ${d.id} span ${d.w} < 4 m`);
  for (const r of R) {
    if (r.kind === 'combat') {
      ok(r.doors.length === 0, `${tag}: zone ${r.id} carries doors — zones must never seal`);
    }
  }
  const bossDoorIds = R[layout.bossRoom].doors;
  ok(bossDoorIds.length === 1, `${tag}: boss grotto has ${bossDoorIds.length} doors, expected 1`);

  // --- reachability, and the neck as the ONLY way in ------------------------
  // BFS over the floor mask from the spawn cell; optionally with the boss
  // door's span stamped solid, which must sever the grotto — that is the
  // membrane arch doing its one job.
  const bossDoor = layout.doors[bossDoorIds[0]];
  const bfsReach = (blockBossDoor) => {
    const seen = new Uint8Array(w * h);
    const sx = gxOf(0);
    const sz = gzOf(0);
    const start = sx + sz * w;
    if (!mask[start]) return seen;
    const blocked = (gx, gz) => {
      if (!blockBossDoor) return false;
      const x = originX + (gx + 0.5) * cell;
      const z = originZ + (gz + 0.5) * cell;
      const [ax, az] = bossDoor.rot === 0 ? [x - bossDoor.x, z - bossDoor.z] : [z - bossDoor.z, x - bossDoor.x];
      return Math.abs(ax) <= bossDoor.w / 2 + 0.1 && Math.abs(az) <= 1.4;
    };
    seen[start] = 1;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cgx = cur % w;
      const cgz = (cur / w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cgx + dx;
        const nz = cgz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nx + nz * w;
        if (!mask[ni] || seen[ni] || blocked(nx, nz)) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    return seen;
  };
  const reach = bfsReach(false);
  const reached = (seen, x, z) => seen[gxOf(x) + gzOf(z) * w] === 1;
  for (const r of R) {
    ok(reached(reach, r.centre.x, r.centre.z), `${tag}: room ${r.id} centre unreachable from spawn`);
    for (const p of r.spawnPoints) {
      ok(reached(reach, p.x, p.z), `${tag}: room ${r.id} spawn point unreachable`);
    }
  }
  const sealed = bfsReach(true);
  const bossC = R[layout.bossRoom].centre;
  ok(!reached(sealed, bossC.x, bossC.z),
    `${tag}: boss grotto reachable AROUND the neck membrane — the seal is decorative`);

  // --- entry translation + drift -------------------------------------------
  ok(layout.entry.x === 0 && layout.entry.z === 0 && layout.entry.yaw === 0,
    `${tag}: entry ${JSON.stringify(layout.entry)}`);
  ok(floorAt(0, 0), `${tag}: spawn (0,0) is not on floor`);
  const meanZ = R.reduce((s, r) => s + r.centre.z, 0) / R.length;
  ok(meanZ < 0, `${tag}: mean room centre z ${f1(meanZ)} — no -Z drift`);

  // --- spawn points ---------------------------------------------------------
  for (const r of R) {
    const need = spawnPointsNeeded(rank, r.kind);
    ok(r.spawnPoints.length >= need,
      `${tag}: room ${r.id} (${r.kind}) has ${r.spawnPoints.length} spawn points, need ${need}`);
    for (const p of r.spawnPoints) {
      let minD = Infinity;
      for (const run of layout.wallRuns) {
        const d = runDistance(p, run);
        if (d < minD) minD = d;
      }
      ok(minD >= 1.5, `${tag}: room ${r.id} spawn point ${f1(minD)} m from a wall run`);
      ok(Math.hypot(p.x - r.centre.x, p.z - r.centre.z) <= r.radius,
        `${tag}: room ${r.id} spawn point outside its trigger disc`);
    }
    for (let i = 0; i < r.spawnPoints.length; i++) {
      for (let j = i + 1; j < r.spawnPoints.length; j++) {
        const a = r.spawnPoints[i];
        const b = r.spawnPoints[j];
        ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2.4,
          `${tag}: room ${r.id} spawn points ${i}/${j} closer than 2.4 m`);
      }
    }
  }

  // --- budgets -------------------------------------------------------------
  const total = R.reduce((s, r) => s + r.budget, 0);
  ok(total === params.enemies, `${tag}: budgets sum ${total} != gate.enemies ${params.enemies}`);
  for (const r of R) {
    if (r.kind === 'combat') ok(r.budget >= 1, `${tag}: zone ${r.id} budget ${r.budget}`);
    else ok(r.budget === 0, `${tag}: ${r.kind} room ${r.id} has budget ${r.budget}`);
  }

  // --- stalagmite field + crystals -----------------------------------------
  const sgs = layout.decor.stalagmites;
  ok(sgs.length >= 25, `${tag}: only ${sgs.length} stalagmites — no cover field`);
  ok(sgs.some((s) => s.kind === 'spire') && sgs.some((s) => s.kind === 'rubble'),
    `${tag}: stalagmite field missing a kind`);
  let clearingViolations = 0;
  for (const s of sgs) {
    if (!floorAt(s.x, s.z)) clearingViolations++;
    for (const r of R) {
      if (Math.hypot(s.x - r.centre.x, s.z - r.centre.z) < 3.2) clearingViolations++;
      for (const p of r.spawnPoints) {
        if (Math.hypot(s.x - p.x, s.z - p.z) < 2.0) clearingViolations++;
      }
    }
    for (const d of layout.doors) {
      if (Math.hypot(s.x - d.x, s.z - d.z) < 2.8) clearingViolations++;
    }
  }
  ok(clearingViolations === 0,
    `${tag}: ${clearingViolations} stalagmite clearing violations (cover sealing a spawn/door)`);
  ok(layout.decor.crystals.length >= 10,
    `${tag}: only ${layout.decor.crystals.length} crystal clusters — the light pool starves`);
  ok(layout.decor.torches.length === 0, `${tag}: cavern rolled torches`);
}

function asciiMap(layout) {
  const { w, h, mask } = layout;
  const grid = [];
  for (let z = 0; z < h; z++) {
    let row = '';
    for (let x = 0; x < w; x++) row += mask[x + z * w] ? '.' : '#';
    grid.push(row);
  }
  const mark = (x, z, ch) => {
    const gx = Math.round((x - layout.originX) / layout.cell - 0.5);
    const gz = Math.round((z - layout.originZ) / layout.cell - 0.5);
    if (gz >= 0 && gz < h && gx >= 0 && gx < w) {
      grid[gz] = grid[gz].slice(0, gx) + ch + grid[gz].slice(gx + 1);
    }
  };
  for (const r of layout.rooms) {
    mark(r.centre.x, r.centre.z, { entry: 'E', combat: 'C', treasure: 'T', boss: 'B' }[r.kind]);
  }
  mark(0, 0, 'S');
  return grid;
}

// ---------------------------------------------------------------------------

// THE BOSS-CHAMBER CONCURRENCY INVARIANT (config.js bossAdds block).
// The chamber must be dense enough to be the fight the ask named, and never
// denser than a room of the same rank already peaks at — skinned characters
// are ~14k triangles each and are the frame's dominant cost, so peak
// CONCURRENCY, not room area, is the entity budget. Checked once, here, rather
// than per seed: it is a property of the tables, not of a layout.
for (const rank of ['E', 'D', 'C']) {
  const gate = GATES.find((g) => g.rank === rank);
  const live = gate.bossAdds?.live ?? 0;
  const hi = Math.max(gate.waveBand[0], gate.waveBand[1]);
  ok(live > 0 && live <= hi - 1,
    `${rank}: bossAdds.live ${live} must sit in 1..${hi - 1} — boss + adds may not exceed `
    + `an ordinary room's peak of ${hi} bodies`);
  ok((gate.bossAdds?.total ?? 0) >= live * 2,
    `${rank}: bossAdds.total ${gate.bossAdds?.total} is under 2x the live cap ${live} — `
    + 'the chamber empties out instead of refilling');
}

const t0 = process.hrtime.bigint();
const stats = {};
const maps = {};

for (const rank of RANKS) {
  const params = LAYOUT_PARAMS[rank];
  const agg = {
    layouts: 0,
    depth: { min: Infinity, max: -Infinity, sum: 0 },
    rooms: { min: Infinity, max: -Infinity, sum: 0 },
    floorCells: { min: Infinity, max: -Infinity, sum: 0 },
    doors: { min: Infinity, max: -Infinity, sum: 0 },
    wallRuns: { min: Infinity, max: -Infinity, sum: 0 },
    spawnPoints: { min: Infinity, max: -Infinity, sum: 0 },
    treasureRooms: 0,
    determinismFailures: 0,
    cover: {
      pieces: { min: Infinity, max: -Infinity, sum: 0 },
      bossPieces: { min: Infinity, max: -Infinity, sum: 0 },
      bossBlockedCells: { min: Infinity, max: -Infinity, sum: 0 },
      bossLos: { min: Infinity, max: -Infinity, sum: 0 },
      bossTotalCells: 0,
      samples: 0,
      deepFills: 0,
      // boss-vs-ordinary-room dressing, deep seeds only (see checkCover)
      cmp: { n: 0, bossD: 0, peerD: 0, bossL: 0, peerL: 0 },
    },
  };
  for (let i = 0; i < SEEDS; i++) {
    // Spread the seed space instead of 0..199 — layout must not depend on
    // "small" seeds, and _beginGate hands out full 32-bit ones.
    const seed = ((i * 2654435761) ^ 0x1234abcd) >>> 0;
    const layout = generateLayout({ rank, seed });
    checkLayout(rank, seed, layout, params);
    // Every-room flood fill on every 5th seed; boss chamber on all of them.
    // Full stride costs ~4x the soak's runtime for a check whose failure mode
    // is structural, not seed-rare.
    const deep = i % 5 === 0;
    const cover = layout.kind === 'crawl'
      ? checkCover(rank, seed, layout, params, deep) : null;
    if (cover) {
      const cs = agg.cover;
      cs.samples++;
      if (deep) cs.deepFills++;
      cs.bossTotalCells = cover.bossTotalCells;
      for (const key of ['pieces', 'bossPieces', 'bossBlockedCells', 'bossLos']) {
        cs[key].min = Math.min(cs[key].min, cover[key]);
        cs[key].max = Math.max(cs[key].max, cover[key]);
        cs[key].sum += cover[key];
      }
      if (cover.peerDensity >= 0) {
        cs.cmp.n++;
        cs.cmp.bossD += cover.bossDensity;
        cs.cmp.peerD += cover.peerDensity;
        cs.cmp.bossL += cover.bossLos / 100;
        cs.cmp.peerL += cover.peerLos;
      }
    }

    // Determinism: a repeat generation must be byte-identical.
    const again = generateLayout({ rank, seed });
    const same = serialize(layout).equals(serialize(again));
    if (!same) agg.determinismFailures++;
    ok(same, `${rank}/${seed}: repeat generation differs (DETERMINISM BROKEN)`);

    const s = layoutStats(layout);
    agg.layouts++;
    for (const [key, val] of [
      ['depth', s.depth], ['rooms', s.rooms], ['floorCells', s.floorCells],
      ['doors', s.doors], ['wallRuns', s.wallRuns], ['spawnPoints', s.spawnPoints],
    ]) {
      const a = agg[key];
      a.min = Math.min(a.min, val);
      a.max = Math.max(a.max, val);
      a.sum += val;
    }
    agg.treasureRooms += s.kinds.treasure || 0;
    if (i === 0) maps[rank] = asciiMap(layout);
  }
  for (const key of ['depth', 'rooms', 'floorCells', 'doors', 'wallRuns', 'spawnPoints']) {
    agg[key].mean = +(agg[key].sum / agg.layouts).toFixed(2);
    delete agg[key].sum;
  }
  agg.treasureRate = +(agg.treasureRooms / agg.layouts).toFixed(2);
  if (agg.cover.samples) {
    for (const key of ['pieces', 'bossPieces', 'bossBlockedCells', 'bossLos']) {
      agg.cover[key].mean = +(agg.cover[key].sum / agg.cover.samples).toFixed(2);
      delete agg.cover[key].sum;
    }
    const c = agg.cover.cmp;
    if (c.n) {
      c.bossDensityPct = +((100 * c.bossD) / c.n).toFixed(2);
      c.peerDensityPct = +((100 * c.peerD) / c.n).toFixed(2);
      c.bossLosPct = +((100 * c.bossL) / c.n).toFixed(1);
      c.peerLosPct = +((100 * c.peerL) / c.n).toFixed(1);
      // The chamber the ask named must be dressed at least as heavily as an
      // ordinary room of the same rank, per unit area. Compared on MEANS,
      // because a single seed's ring/arc rolls swing either way; 0.98 is float
      // slack, not a tolerance for being worse.
      //
      // SIGHTLINES ARE THE LOAD-BEARING ONE and are asserted at any sample
      // size: "can I break line of sight while I kite" is the thing cover is
      // for, and the margin is wide (measured E 40.2% vs 33.3%, D 44.1% vs
      // 35.7% over 40 deep seeds). Cell DENSITY is a weaker proxy — the boss
      // chamber deliberately keeps its dais clear, so a small sample can put
      // it a tenth of a point under an ordinary room — and needs the full soak
      // to be meaningful, so it only bites at >= 20 deep samples. The quick
      // `--seeds=25` pass prints it and moves on.
      if (c.n >= 20) {
        ok(c.bossDensityPct >= c.peerDensityPct * 0.98,
          `${rank}: boss chamber is dressed THINNER than an ordinary room — `
          + `${c.bossDensityPct}% of cells blocked vs ${c.peerDensityPct}% (mean of ${c.n} seeds)`);
      }
      ok(c.bossLosPct >= c.peerLosPct * 0.98,
        `${rank}: boss chamber stops fewer sightlines than an ordinary room — `
        + `${c.bossLosPct}% vs ${c.peerLosPct}% (mean of ${c.n} seeds)`);
    }
  } else {
    agg.cover = null;
  }
  stats[rank] = agg;
}

const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`dungeon-gen soak: ${SEEDS} seeds x {${RANKS.join(', ')}} in ${ms.toFixed(0)} ms`);
for (const rank of RANKS) {
  const s = stats[rank];
  console.log(`  ${rank}: depth ${s.depth.min}-${s.depth.max} (mean ${s.depth.mean})  `
    + `rooms ${s.rooms.min}-${s.rooms.max}  doors ${s.doors.min}-${s.doors.max}  `
    + `floorCells ${s.floorCells.min}-${s.floorCells.max}  `
    + `wallRuns ${s.wallRuns.min}-${s.wallRuns.max}  `
    + `spawnPts ${s.spawnPoints.min}-${s.spawnPoints.max}  `
    + `treasure rate ${s.treasureRate}`);
  if (s.cover) {
    const c = s.cover;
    console.log(`     cover: ${c.pieces.min}-${c.pieces.max} pieces/gate (mean ${c.pieces.mean}), `
      + `boss ${c.bossPieces.min}-${c.bossPieces.max} (mean ${c.bossPieces.mean})  `
      + `boss blocked cells ${c.bossBlockedCells.min}-${c.bossBlockedCells.max}/${c.bossTotalCells} `
      + `(mean ${c.bossBlockedCells.mean})  `
      + `boss sightlines blocked ${c.bossLos.min}-${c.bossLos.max}% (mean ${c.bossLos.mean}%)  `
      + `[${c.deepFills} all-room flood fills]`);
    if (c.cmp?.n) {
      console.log(`     boss vs ordinary room, per unit area: cells blocked `
        + `${c.cmp.bossDensityPct}% vs ${c.cmp.peerDensityPct}%, sightlines stopped `
        + `${c.cmp.bossLosPct}% vs ${c.cmp.peerLosPct}% (${c.cmp.n} seeds)`);
    }
  }
}
if (maps.E) {
  console.log('\nfirst E layout (S spawn, E entry, C combat, T treasure, B boss):');
  for (const row of maps.E) console.log(`  ${row}`);
}
if (maps.C) {
  console.log('\nfirst C cavern (S spawn, E entry, C zone, B boss grotto):');
  for (const row of maps.C) console.log(`  ${row}`);
}

const file = writeReport('dungeon-gen-report', {
  seeds: SEEDS,
  ranks: RANKS,
  ms: +ms.toFixed(0),
  checks,
  failures,
  stats,
  failLines,
  maps,
});
console.log(`\nreport: ${file}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURE(S)`);
  for (const l of failLines) console.log(`  FAIL ${l}`);
}
process.exit(failures ? 1 : 0);
