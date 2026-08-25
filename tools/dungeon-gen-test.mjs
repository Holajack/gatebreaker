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
  bossAnchor, exitAnchor, floodFillRoom, doorReachableFrom,
  NAV_BODY_RADIUS, NAV_FILL_STEP,
  // Waste (Wave E task E-A): the soak's route-waypoint reachability runs the
  // SAME field + fill the generator's own guarantee runs — floodFillRoom's
  // no-two-copies rule, again.
  buildWasteField, wasteFieldFill, terrainHeightFn,
  TERRAIN_MAX_SLOPE, ROUTE_CORRIDOR_HALF,
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
const RANKS = ['E', 'D', 'C', 'B', 'A', 'S'];

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

// Stable byte serialization: JSON with typed arrays as base64. The tower's
// layout.heightAt is a FUNCTION property — JSON.stringify drops it silently —
// so the byte-compare rides the data it closes over (cellF/ramps/floorRise),
// which is the right identity: same data, same function.
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
  if (layout.kind === 'tower') return checkTowerLayout(rank, seed, layout, params);
  if (layout.kind === 'waste') return checkWasteLayout(rank, seed, layout, params);
  if (layout.kind === 'reach') return checkReachLayout(rank, seed, layout, params);
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

// Player/enemy collision radius and flood-fill lattice pitch are imported
// (NAV_BODY_RADIUS / NAV_FILL_STEP) rather than redefined here — buildCover's
// OWN runtime connectivity guarantee (dungeonlayout.js, see the CONNECTIVITY
// GUARANTEE block above its buildCover) uses the exact same two numbers via
// the exact same floodFillRoom(), so this regression test and the code it is
// regression-testing can never quietly drift apart on what "fits through a
// gap" means.
//
// LOS floor: measured over 8 seeds x 2 ranks the boss chambers block 30.7-45.3%
// of random sightlines (mean E 37.0 / D 39.2) against 0.0% before this wave.
// 15% is a regression tripwire well under the observed floor, not a target.
const LOS_FLOOR_BOSS = 0.15;

// buildCover's connectivity guarantee keeps 100% of the floor its OWN cover
// pieces could plausibly cut off reachable — that is the actual bug this
// wave fixes, and it is asserted with zero tolerance below (per-door
// reachability) and via this same ratio for the room as a whole. This small
// allowance covers a SEPARATE, pre-existing, much smaller effect that
// including decor.props in the field (this wave, see coverField() above) now
// makes newly visible: buildDecor's prop clusters (crate/barrel/pot, corner-
// anchored — see buildDecor's "Prop clusters" comment) carry no clearance
// rule against nearby doors at all (unlike buildCover's own cover, which
// keeps doorClear/wallInset/lane), so a cluster can occasionally pinch a
// sliver of an otherwise-open corner into its own tiny, doorless pocket.
// buildCover cannot prune what it never placed, so this is NOT the bug this
// wave fixes and is out of this fix's scope — but it is real, so it is
// bounded and regression-guarded here rather than silently swallowed.
// Measured over 400 seeds (200/rank, E+D): 66 of ~1,600 room checks hit this,
// worst case 4 of 5,193 cells. A genuine chokepoint (a corridor, a scripted
// arena feature) cuts off HUNDREDS of cells at minimum, so this tolerance
// cannot mask one — and the per-door assertion right below has NO tolerance
// at all, because a door is the invariant that actually matters.
const STRAY_POCKET_TOLERANCE = 8;   // cells at FILL_STEP 0.5 (~2 m^2)

// Mirrors dungeon.js's own (unexported, THREE-adjacent — see this file's own
// "plain Node" header) DRESS_LIMITS.columns / .clutter: the per-role
// draw-call truncation that decides which columns/props actually DRAW and so
// actually carry collision. This test's job is what a Dungeon build really
// registers (its own docstring, below), not a conservative superset, so it
// has to mirror the truncation exactly rather than skip it. Move either
// number in dungeon.js, move its mirror here in the same edit.
const RENDER_COLUMNS_CAP = 20;
const RENDER_CLUTTER_CAP = 16;

/**
 * The collision field a Dungeon build registers, minus the THREE half —
 * walls, doors, and EVERY decor piece that carries real collision at render
 * time (dungeon.js _buildDressing): columns, crate/barrel/pot props, alcove
 * furniture (bookcase or pot, whichever buildDecor decided — see its alcove
 * block), and the placed cover. Props/alcoves joined the field in the same
 * wave that gave buildCover its own connectivity guarantee against them
 * (the reported pillar+bookcase softlock): before that, this test could not
 * have seen the bug it now regression-tests.
 */
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
  for (const c of layout.decor.columns.slice(0, RENDER_COLUMNS_CAP)) {
    f.addCircle(c.x, c.z, 0.34, { nav: false, tag: 'column' });
  }
  // crate/barrel/pot match dungeon.js's registration exactly, including its
  // clutter counter: statue/candles bypass that counter entirely (always
  // drawn, never collided — the shrine's real position is computed at render
  // time off its room's door, which is why it is not modelled here either;
  // see dungeonlayout.js's buildStaticConnectivityField for the same call),
  // so only crate/barrel/pot count toward the cap, in array order.
  let clutter = 0;
  for (const p of layout.decor.props) {
    if (p.kind === 'statue' || p.kind === 'candles') continue;
    if (clutter >= RENDER_CLUTTER_CAP) continue;
    clutter++;
    if (p.kind === 'crate') f.addCircle(p.x, p.z, 0.4, { top: 0.4, nav: false, tag: 'prop' });
    else if (p.kind === 'barrel') f.addCircle(p.x, p.z, 0.4, { top: 1.05, nav: false, tag: 'prop' });
    else if (p.kind === 'pot') f.addCircle(p.x, p.z, 0.3, { top: 0.4, nav: false, tag: 'prop' });
  }
  // Alcove furniture is NOT capped again here: buildDecor already truncates
  // which alcoves carry `furniture` to ALCOVE_LIMITS.count (dungeonlayout.js)
  // — the exact same number dungeon.js's DRESS_LIMITS.alcoves is defined
  // from — so `a.furniture` is already empty past that window.
  for (const a of layout.decor.alcoves) {
    for (const item of a.furniture || []) {
      if (item.collision.shape === 'circle') {
        f.addCircle(item.x, item.z, item.collision.r, { top: item.collision.top, nav: false, tag: 'prop' });
      } else {
        f.addBox(item.x, item.z, item.collision.w, item.collision.d, 0,
          { top: item.collision.top, nav: false, tag: 'prop' });
      }
    }
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

// Open-cell flood fill from the room's centre-most open cell is
// floodFillRoom() (dungeonlayout.js) — imported, not reimplemented, so this
// test and buildCover's own runtime connectivity guarantee can never
// silently drift onto two different definitions of "reachable". See that
// function's docstring for the feetY/stepOver rationale.

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

  // --- traversability (rule (b)) + the pillar+bookcase softlock -----------
  // Every room, every seed — this USED to be strided (deep seeds only, 1 in
  // 5) because a full flood fill over every room was ~4x the soak's runtime.
  // It no longer can be: buildCover's own runtime connectivity guarantee
  // (dungeonlayout.js) now does this exact check on every generated layout in
  // production, on the same collision picture (walls + doors + decor columns/
  // props/alcove furniture + cover) coverField() builds here — a strided soak
  // is not testing what actually ships. The failure mode this specifically
  // regression-tests (a pillar and a wall-mounted bookcase, each placed by a
  // system with no idea the other exists, jointly narrowing a passage below
  // body width) is a corridor-to-door pinch, not a room-wide floor collapse —
  // which is exactly what per-door reachability catches and the coarser
  // reached/total ratio below does not, since one pinched door can leave the
  // rest of a big room's ratio looking fine.
  for (const r of layout.rooms) {
    if (r.kind === 'entry') continue;
    const fill = floodFillRoom(field, r);
    const cutOff = fill.total - fill.reached;
    ok(fill.total > 0 && cutOff <= STRAY_POCKET_TOLERANCE,
      `${tag}: room ${r.id} (${r.kind}) walkable floor is ${cutOff} of ${fill.total} cells cut off `
      + `by cover (tolerance ${STRAY_POCKET_TOLERANCE} — see STRAY_POCKET_TOLERANCE)`);
    // d.roomA === r.id only: r.doors carries BOTH ends of every corridor
    // touching this room (its own wall opening AND the far room's, per the
    // WALL-RUN/DOOR header comment in dungeonlayout.js), and the far one can
    // sit outside this room's own footprint entirely — see buildCover's
    // `ownDoors` for the same filter, for the same reason.
    const ownDoors = r.doors.map((id) => layout.doors[id]).filter((d) => d && d.roomA === r.id);
    for (const d of ownDoors) {
      ok(doorReachableFrom(fill, r, d),
        `${tag}: room ${r.id} (${r.kind}) door ${d.id} is cut off from the room's open floor `
        + '(THE pillar+bookcase softlock class — buildCover should have pruned this)');
    }
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

// ---------------------------------------------------------------------------
// tower invariants — Wave E task E-B (THE ASCENT, B rank)
// ---------------------------------------------------------------------------
// Everything the crawl asserts, restated for a terraced layout, plus the
// tower's own contracts: analytic heights, stair treads under the body's
// stepHeight, per-floor reachability (walkable steps only — a drop is not a
// path UP), ramp mouths as the only between-floor doors, and parapet gaps
// that always land on floor INSIDE the layout. All zero tolerance.

const BODY_STEP = 0.4;        // physics.js BODY_DEFAULTS.stepHeight
const WALK_STEP = 0.45;       // step tolerance for the walkability BFS below

function checkTowerLayout(rank, seed, layout, params) {
  const tag = `${rank}/${seed}`;
  const R = layout.rooms;
  const { w, h, cell, originX, originZ, mask } = layout;
  const rise = params.floorRise;
  const gx = (x) => Math.round((x - originX) / cell);   // rect corners (integers)
  const gz = (z) => Math.round((z - originZ) / cell);
  const cgx = (x) => Math.floor((x - originX) / cell);  // point-in-cell lookups
  const cgz = (z) => Math.floor((z - originZ) / cell);
  const cellY = (cx, cz) => layout.heightAt(originX + (cx + 0.5) * cell, originZ + (cz + 0.5) * cell);
  const floorAt = (cx, cz) => cx >= 0 && cz >= 0 && cx < w && cz < h && mask[cx + cz * w] === 1;

  // --- door-graph reachability + depth + path -------------------------------
  const adj = Array.from({ length: R.length }, () => []);
  for (const d of layout.doors) {
    if (d.roomA >= 0 && d.roomB >= 0) {
      adj[d.roomA].push(d.roomB);
      adj[d.roomB].push(d.roomA);
    }
  }
  {
    const seen = new Set([0]);
    const q = [0];
    while (q.length) {
      const cur = q.shift();
      for (const nb of adj[cur]) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    ok(seen.size === R.length, `${tag}: ${R.length - seen.size} unreachable room(s)`);
  }
  ok(layout.depth >= params.minBossDepth,
    `${tag}: boss depth ${layout.depth} < ${params.minBossDepth}`);
  ok(R[layout.bossRoom].kind === 'boss', `${tag}: bossRoom is ${R[layout.bossRoom].kind}`);
  ok(layout.criticalPath[0] === 0 && layout.criticalPath.at(-1) === layout.bossRoom,
    `${tag}: criticalPath endpoints ${layout.criticalPath[0]}..${layout.criticalPath.at(-1)}`);

  // --- door spans -----------------------------------------------------------
  for (const d of layout.doors) ok(d.w >= 4, `${tag}: door ${d.id} span ${d.w} < 4 m`);

  // --- room counts, sizes, dash units ---------------------------------------
  const kinds = { entry: 0, combat: 0, treasure: 0, boss: 0 };
  for (const r of R) kinds[r.kind]++;
  ok(kinds.entry === 1 && kinds.boss === 1, `${tag}: entry/boss counts ${kinds.entry}/${kinds.boss}`);
  ok(kinds.treasure <= 1, `${tag}: ${kinds.treasure} treasure rooms, expected 0-1`);
  const fight = R.length - 2;
  ok(fight >= params.rooms[0] && fight <= params.rooms[1],
    `${tag}: ${fight} fight rooms outside ${params.rooms}`);
  const sizeOk = ({ w: rw, d: rd }, sz) =>
    rw >= sz.w[0] * 2 && rw <= sz.w[1] * 2 && rd >= sz.d[0] * 2 && rd <= sz.d[1] * 2;
  for (const r of R) {
    if (r.kind === 'boss') {
      ok(r.w === params.bossSize.w * 2 && r.d === params.bossSize.d * 2,
        `${tag}: boss room ${r.w}x${r.d}, expected exactly ${params.bossSize.w * 2}x${params.bossSize.d * 2}`);
      ok(Math.min(r.w, r.d) >= 5 * DASH, `${tag}: boss ${(Math.min(r.w, r.d) / DASH).toFixed(2)} dashes < 5`);
    } else if (r.kind === 'entry') {
      ok(sizeOk(r, params.entrySize), `${tag}: entry room ${r.w}x${r.d} outside entrySize`);
    } else {
      ok(sizeOk(r, params.roomSize), `${tag}: room ${r.id} (${r.kind}) ${r.w}x${r.d} outside roomSize`);
      ok(Math.min(r.w, r.d) >= 3 * DASH,
        `${tag}: room ${r.id} short axis ${(Math.min(r.w, r.d) / DASH).toFixed(2)} dashes < 3`);
    }
  }

  // --- floors + the analytic height contract --------------------------------
  const F = layout.floorCount;
  ok(F >= params.floors[0] && F <= params.floors[1], `${tag}: floorCount ${F} outside ${params.floors}`);
  const floorsSeen = new Set();
  for (const r of R) {
    floorsSeen.add(r.floor);
    ok(Math.abs(r.floorY - r.floor * rise) < 1e-9,
      `${tag}: room ${r.id} floorY ${r.floorY} != floor ${r.floor} * rise`);
    ok(Math.abs(layout.heightAt(r.centre.x, r.centre.z) - r.floorY) < 1e-9,
      `${tag}: heightAt(room ${r.id} centre) ${layout.heightAt(r.centre.x, r.centre.z)} != floorY ${r.floorY}`);
    for (const p of r.spawnPoints) {
      ok(Math.abs((p.y ?? -1) - r.floorY) < 1e-9,
        `${tag}: room ${r.id} spawn point y ${p.y} != floorY ${r.floorY}`);
    }
  }
  ok(floorsSeen.size === F, `${tag}: ${floorsSeen.size} distinct room floors vs floorCount ${F}`);
  ok(R[0].floor === 0 && layout.heightAt(0, 0) === 0, `${tag}: entry not at ground`);
  ok(R[layout.bossRoom].floor === F - 1,
    `${tag}: boss on floor ${R[layout.bossRoom].floor}, expected top (${F - 1})`);

  // --- ramps: one per floor pair, treads under the body's stepHeight --------
  ok(layout.ramps.length === F - 1, `${tag}: ${layout.ramps.length} ramps for ${F} floors`);
  for (let i = 0; i < layout.ramps.length; i++) {
    const r = layout.ramps[i];
    const span = r.axis === 'x' ? r.gw : r.gd;
    let prev = null;
    let maxStep = 0;
    for (let k = 0; k < span; k++) {
      const cx = r.axis === 'x' ? (r.dir > 0 ? r.gx + k : r.gx + r.gw - 1 - k) : r.gx;
      const cz = r.axis === 'x' ? r.gz : (r.dir > 0 ? r.gz + k : r.gz + r.gd - 1 - k);
      const y = cellY(cx, cz);
      if (prev !== null) {
        ok(y >= prev - 1e-9, `${tag}: ramp ${i} treads not monotonic`);
        maxStep = Math.max(maxStep, y - prev);
      }
      prev = y;
    }
    // Ends: first tread one step above y0, last one step below y0 + rise.
    ok(maxStep <= BODY_STEP + 1e-9,
      `${tag}: ramp ${i} tread step ${maxStep.toFixed(3)} > body stepHeight ${BODY_STEP}`);
    const first = cellY(
      r.axis === 'x' ? (r.dir > 0 ? r.gx : r.gx + r.gw - 1) : r.gx,
      r.axis === 'x' ? r.gz : (r.dir > 0 ? r.gz : r.gz + r.gd - 1),
    );
    ok(first - r.y0 > 0 && first - r.y0 <= BODY_STEP + 1e-9,
      `${tag}: ramp ${i} first tread ${(first - r.y0).toFixed(3)} above its low floor`);
  }
  // Every adjacent floor pair is joined by at least one door whose two rooms
  // sit one rise apart — the ramp mouths ARE the between-floor doors.
  for (let f = 0; f + 1 < F; f++) {
    const joined = layout.doors.some((d) => d.roomA >= 0 && d.roomB >= 0
      && Math.min(R[d.roomA].floor, R[d.roomB].floor) === f
      && Math.max(R[d.roomA].floor, R[d.roomB].floor) === f + 1);
    ok(joined, `${tag}: floors ${f}/${f + 1} share no ramp door`);
  }

  // --- claims: mask == rooms + corridors + gap lips; adjacency legality ----
  const claim = new Int16Array(w * h).fill(-1);   // -1 rock, -2 corridor, -3 gap lip, id room
  let doubleClaim = 0;
  const stamp = (r, val) => {
    const x0 = gx(r.x);
    const z0 = gz(r.z);
    for (let z = z0; z < z0 + Math.round(r.d / cell); z++) {
      for (let x = x0; x < x0 + Math.round(r.w / cell); x++) {
        if (claim[x + z * w] !== -1) doubleClaim++;
        claim[x + z * w] = val;
      }
    }
  };
  for (const r of R) stamp(r, r.id);
  for (const c of layout.corridors) stamp({ x: c.x - c.w / 2, z: c.z - c.d / 2, w: c.w, d: c.d }, -2);
  for (const g of layout.gaps) {
    for (const c of g.cells) {
      // Gap records carry only their OUTER lip row; the carved band may be
      // 1-3 cells deep, so claim the whole march back toward the room.
      const [ox, oz] = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] }[g.face];
      for (let k = 0; k < 3; k++) {
        const cx = c.gx + ox * k;
        const cz = c.gz + oz * k;
        if (claim[cx + cz * w] !== -1) break;   // reached the room's own claim
        claim[cx + cz * w] = -3;
      }
    }
  }
  ok(doubleClaim === 0, `${tag}: ${doubleClaim} double-claimed cells`);
  let claimMismatch = 0;
  for (let i = 0; i < w * h; i++) {
    if ((mask[i] === 1) !== (claim[i] !== -1)) claimMismatch++;
  }
  ok(claimMismatch === 0, `${tag}: ${claimMismatch} cells where mask and claims disagree`);

  // Door openings in grid space (crawl's bare-opening grammar).
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
  // Every floor-floor plan adjacency is either flat-walkable (|dh| <= step),
  // or a recorded parapet drop; region crossings need a door (flat) or a gap
  // lip (drop). Zero tolerance on all three counters.
  let roomTouch = 0;
  let bareOpening = 0;
  let strayCliff = 0;
  const dropMin = rise * 0.75;
  const dropMax = 2 * rise + 0.3;
  const gapCell = (cx, cz) => claim[cx + cz * w] === -3;
  const pairCheck = (ax, az, bx, bz, key) => {
    const a = claim[ax + az * w];
    const b = claim[bx + bz * w];
    if (a === -1 || b === -1 || a === b) return;
    const dh = Math.abs(cellY(ax, az) - cellY(bx, bz));
    if (dh > WALK_STEP) {
      // A cliff: legal ONLY when one side is a gap lip (or the lip's own
      // room) and the drop is in the parapet band.
      const viaGap = gapCell(ax, az) || gapCell(bx, bz);
      if (!(viaGap && dh >= dropMin && dh <= dropMax)) strayCliff++;
      return;
    }
    // Flat crossing between two REGIONS: rooms may never touch rooms; a gap
    // lip is its room's own balcony; everything else needs a door.
    if (a === -3 || b === -3) return;   // lip <-> its own room (same height)
    if (a >= 0 && b >= 0) { roomTouch++; return; }
    if (!doorCells.has(key)) bareOpening++;
  };
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w - 1; x++) pairCheck(x, z, x + 1, z, `x:${x + 1}:${z}`);
  }
  for (let z = 0; z < h - 1; z++) {
    for (let x = 0; x < w; x++) pairCheck(x, z, x, z + 1, `z:${z + 1}:${x}`);
  }
  ok(roomTouch === 0, `${tag}: ${roomTouch} direct room-to-room adjacencies`);
  ok(bareOpening === 0, `${tag}: ${bareOpening} flat region crossings not covered by a door`);
  ok(strayCliff === 0, `${tag}: ${strayCliff} height discontinuities outside recorded parapet gaps`);

  // --- parapet gaps: in range, landing on floor INSIDE the layout ----------
  ok(layout.gaps.length <= (params.parapets?.max ?? 0),
    `${tag}: ${layout.gaps.length} gaps over cap ${params.parapets?.max}`);
  for (const g of layout.gaps) {
    const room = R[g.room];
    ok(room && room.kind !== 'boss' && room.kind !== 'entry' && room.floor >= 1,
      `${tag}: gap on ${room?.kind} room ${g.room} (floor ${room?.floor})`);
    ok(Math.abs(g.yTop - room.floorY) < 1e-9, `${tag}: gap yTop ${g.yTop} != room floorY`);
    const drop = g.yTop - g.yLand;
    ok(drop >= dropMin - 1e-9 && drop <= dropMax + 1e-9,
      `${tag}: gap drop ${drop.toFixed(2)} outside [${dropMin}, ${dropMax}]`);
    const [ox, oz] = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[g.face];
    for (const c of g.cells) {
      ok(floorAt(c.gx, c.gz) && Math.abs(cellY(c.gx, c.gz) - g.yTop) < 1e-9,
        `${tag}: gap lip cell (${c.gx},${c.gz}) not floor at yTop`);
      const lx = c.gx + ox;
      const lz = c.gz + oz;
      // THE no-gap-exits-layout assert: one step off the lip is floor, in
      // bounds, at the recorded landing height — never rock, never void.
      ok(floorAt(lx, lz), `${tag}: gap at (${c.gx},${c.gz}) leads OUT of the layout`);
      const landDrop = g.yTop - cellY(lx, lz);
      ok(landDrop >= dropMin - 1e-9 && landDrop <= dropMax + 1e-9,
        `${tag}: gap landing height off by ${(landDrop - drop).toFixed(2)}`);
    }
  }

  // --- per-floor walkable reachability, ZERO tolerance ----------------------
  // BFS over the floor mask stepping only |dh| <= WALK_STEP: this walks each
  // floor AND its stair ramps but can never climb a parapet cliff — so it
  // proves every room, every spawn point and BOTH sides of every door are
  // reachable from the entry BY WALKING, exactly the crawl's guarantee lifted
  // into height. (checkCover's per-door obstacle-field reachability runs on
  // top of this in the main loop, same zero tolerance.)
  {
    const seen = new Uint8Array(w * h);
    const sx = cgx(0);
    const sz = cgz(0);
    const start = sx + sz * w;
    ok(mask[start] === 1, `${tag}: spawn (0,0) is not on floor`);
    seen[start] = 1;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cx = cur % w;
      const cz = (cur / w) | 0;
      const y0 = cellY(cx, cz);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nx + nz * w;
        if (!mask[ni] || seen[ni]) continue;
        if (Math.abs(cellY(nx, nz) - y0) > WALK_STEP) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    const reached = (x, z) => seen[cgx(x) + cgz(z) * w] === 1;
    for (const r of R) {
      ok(reached(r.centre.x, r.centre.z),
        `${tag}: room ${r.id} (${r.kind}, floor ${r.floor}) centre not WALK-reachable from entry`);
      for (const p of r.spawnPoints) {
        ok(reached(p.x, p.z), `${tag}: room ${r.id} spawn point not walk-reachable`);
      }
    }
    for (const d of layout.doors) {
      if (d.roomA < 0 || d.roomB < 0) continue;
      // Sample a cell either side of the membrane plane.
      const nx = d.rot === 0 ? 0 : 1;
      const nz = d.rot === 0 ? 1 : 0;
      ok(reached(d.x - nx * cell, d.z - nz * cell) && reached(d.x + nx * cell, d.z + nz * cell),
        `${tag}: door ${d.id} has an unreachable side`);
    }
  }

  // --- entry translation + drift -------------------------------------------
  ok(layout.entry.x === 0 && layout.entry.z === 0 && layout.entry.yaw === 0,
    `${tag}: entry ${JSON.stringify(layout.entry)}`);
  const meanZ = R.reduce((sum, r) => sum + r.centre.z, 0) / R.length;
  ok(meanZ < 0, `${tag}: mean room centre z ${f1(meanZ)} — no -Z drift`);

  // --- spawn points (the crawl's bars, plus y asserted above) ---------------
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

  // --- wall runs carry their floor band -------------------------------------
  for (const run of layout.wallRuns) {
    ok(Number.isFinite(run.base) && Number.isFinite(run.top) && run.top >= run.base - 1e-9,
      `${tag}: wall run without a sane base/top (${run.base}/${run.top})`);
  }

  // --- budgets --------------------------------------------------------------
  const total = R.reduce((sum, r) => sum + r.budget, 0);
  ok(total === params.enemies, `${tag}: budgets sum ${total} != gate.enemies ${params.enemies}`);
  for (const r of R) {
    if (r.kind === 'combat') ok(r.budget >= 1, `${tag}: combat room ${r.id} budget ${r.budget}`);
    else ok(r.budget === 0, `${tag}: ${r.kind} room ${r.id} has budget ${r.budget}`);
  }
}

// ---------------------------------------------------------------------------
// waste invariants — Wave E task E-A (THE RIVEN WASTE, A rank)
// ---------------------------------------------------------------------------
// The cavern's disc-room bars, restated for an open landscape, plus the
// waste's own contracts: the smooth analytic terrain (flat spawn datum,
// slope under the body's sliding threshold, heightAt === the serialized wave
// table), the ORDERED route (criticalPath is entry -> sites in order ->
// boss; exactly ONE door, the entry arch — nothing else can seal), roam
// points on walkable corridor floor, outcrop clearances (route corridors,
// site clearings, anchors, dash lanes), and the zero-tolerance route-waypoint
// reachability over the REAL obstacle field — the crawl's per-door guarantee
// generalized to what the waste actually navigates by.

function checkWasteLayout(rank, seed, layout, params) {
  const tag = `${rank}/${seed}`;
  const R = layout.rooms;
  const { w, h, cell, originX, originZ, mask } = layout;
  const cfg = params.cover;
  const floorAt = (x, z) => {
    const gx = Math.floor((x - originX) / cell);
    const gz = Math.floor((z - originZ) / cell);
    return gx >= 0 && gz >= 0 && gx < w && gz < h && mask[gx + gz * w] === 1;
  };

  // --- rooms: 1 entry + 3 route sites + 1 boss, all discs on floor ---------
  const kinds = { entry: 0, combat: 0, treasure: 0, boss: 0 };
  for (const r of R) kinds[r.kind]++;
  ok(kinds.entry === 1 && kinds.boss === 1 && kinds.treasure === 0,
    `${tag}: kinds ${JSON.stringify(kinds)}`);
  ok(kinds.combat === params.sites, `${tag}: ${kinds.combat} sites, expected ${params.sites}`);
  for (const r of R) {
    ok(r.radius > 0, `${tag}: room ${r.id} has no trigger-disc radius`);
    ok(floorAt(r.centre.x, r.centre.z), `${tag}: room ${r.id} centre is not on floor`);
  }

  // --- the route: ordered, complete, THE critical path ---------------------
  ok(Array.isArray(layout.route) && layout.route.length === params.sites,
    `${tag}: route ${JSON.stringify(layout.route)} is not ${params.sites} sites`);
  ok(layout.route.every((id) => R[id]?.kind === 'combat'),
    `${tag}: route contains a non-combat room`);
  ok(JSON.stringify(layout.criticalPath) === JSON.stringify([0, ...layout.route, layout.bossRoom]),
    `${tag}: criticalPath ${JSON.stringify(layout.criticalPath)} != entry->route->boss`);
  ok(layout.depth >= params.minBossDepth, `${tag}: depth ${layout.depth} < ${params.minBossDepth}`);
  ok(R[layout.bossRoom].kind === 'boss', `${tag}: bossRoom is ${R[layout.bossRoom].kind}`);

  // --- doors: the entry arch ONLY — the open waste can never seal ----------
  ok(layout.doors.length === 1, `${tag}: ${layout.doors.length} doors, expected 1 (entry arch)`);
  ok(layout.doors[0].w >= 4 && layout.doors[0].roomA === 0,
    `${tag}: entry door span ${layout.doors[0].w} / roomA ${layout.doors[0].roomA}`);
  for (const r of R) {
    if (r.kind !== 'entry') {
      ok(r.doors.length === 0, `${tag}: ${r.kind} room ${r.id} carries doors — nothing seals here`);
    }
  }

  // --- site separation. What is ACTUALLY guaranteed (review wording fix):
  // no stop's CENTRE lies inside another stop's trigger disc (d >= max radius,
  // generator floor 15.6 m) — trigger DISCS may overlap at their rims, and the
  // entry disc may graze a site's by ~1-2 m. Membership is nearest-centre, so
  // record order still cannot decide it; full disc disjointness (d >= r_i+r_j)
  // was never the generator's contract.
  const sites = R.filter((r) => r.kind === 'combat');
  const stopsAll = [...sites, R[layout.bossRoom]];
  for (let i = 0; i < stopsAll.length; i++) {
    for (let j = i + 1; j < stopsAll.length; j++) {
      const d = Math.hypot(
        stopsAll[i].centre.x - stopsAll[j].centre.x, stopsAll[i].centre.z - stopsAll[j].centre.z,
      );
      ok(d >= Math.max(stopsAll[i].radius, stopsAll[j].radius),
        `${tag}: stops ${stopsAll[i].id}/${stopsAll[j].id} ${f1(d)} m apart — overlapping trigger discs`);
    }
  }

  // --- DASH-UNIT sizing, open-field form (the cavern's freeRadius bar) -----
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
        `${tag}: site ${r.id} free radius ${f1(fr)} m = ${(fr * 2 / DASH).toFixed(2)} dashes across < 3`);
    } else if (r.kind === 'boss') {
      const fr = freeRadius(r.centre.x, r.centre.z);
      // Open-field boss: the fight space is the surrounding field, and the
      // generator's clear-disc tiers guarantee >= 4.5 dashes across even on
      // the relax rung (see waste.js's boss candidate comment).
      ok(fr * 2 >= 4.5 * DASH,
        `${tag}: boss site free ${f1(fr * 2)} m = ${(fr * 2 / DASH).toFixed(2)} dashes across < 4.5`);
    }
  }

  // --- terrain: the height contract ----------------------------------------
  ok(typeof layout.heightAt === 'function' && layout.smoothHeight === true,
    `${tag}: waste without a live smooth height function`);
  ok(layout.heightAt(0, 0) === 0, `${tag}: heightAt(0,0) = ${layout.heightAt(0, 0)} — spawn not on the datum`);
  // heightAt IS the serialized wave table: rebuild from layout.terrain and
  // compare — the byte-compare rides this data, so the two must be one.
  {
    const rebuilt = terrainHeightFn(layout.terrain);
    let mismatch = 0;
    let maxH = 0;
    let maxSlope = 0;
    for (let gz = 1; gz < h - 1; gz += 3) {
      for (let gx = 1; gx < w - 1; gx += 3) {
        const x = originX + (gx + 0.5) * cell;
        const z = originZ + (gz + 0.5) * cell;
        const y = layout.heightAt(x, z);
        if (Math.abs(y - rebuilt(x, z)) > 1e-12) mismatch++;
        if (!mask[gx + gz * w]) continue;
        maxH = Math.max(maxH, Math.abs(y));
        // Central-difference gradient at the body's normal-sample span.
        const gxg = (layout.heightAt(x + 0.45, z) - layout.heightAt(x - 0.45, z)) / 0.9;
        const gzg = (layout.heightAt(x, z + 0.45) - layout.heightAt(x, z - 0.45)) / 0.9;
        maxSlope = Math.max(maxSlope, Math.hypot(gxg, gzg));
      }
    }
    ok(mismatch === 0, `${tag}: ${mismatch} cells where heightAt disagrees with its own wave table`);
    const ampSum = layout.terrain.waves.reduce((s, wv) => s + wv.amp, 0);
    ok(maxH <= ampSum + 1e-9, `${tag}: terrain reaches ${f1(maxH)} m over the ${f1(ampSum)} m amp sum`);
    // Analytic bound is TERRAIN_MAX_SLOPE for the waves; the fade envelope's
    // derivative adds a bounded term — 0.42 keeps a wide margin under the
    // body's 0.55 sliding threshold either way.
    ok(maxSlope <= Math.max(0.42, TERRAIN_MAX_SLOPE + 0.12),
      `${tag}: terrain slope ${maxSlope.toFixed(3)} too steep for a walking body`);
    // The arrival stays flat: everywhere at/south of the fade plane is datum.
    let tunnelBumps = 0;
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (!mask[gx + gz * w]) continue;
        const z = originZ + (gz + 0.5) * cell;
        if (z >= layout.terrain.fadeZ && Math.abs(layout.heightAt(originX + (gx + 0.5) * cell, z)) > 1e-9) tunnelBumps++;
      }
    }
    ok(tunnelBumps === 0, `${tag}: ${tunnelBumps} floor cells south of the fade plane off the datum`);
  }

  // --- entry translation + drift -------------------------------------------
  ok(layout.entry.x === 0 && layout.entry.z === 0 && layout.entry.yaw === 0,
    `${tag}: entry ${JSON.stringify(layout.entry)}`);
  ok(floorAt(0, 0), `${tag}: spawn (0,0) is not on floor`);
  const meanZ = R.reduce((s, r) => s + r.centre.z, 0) / R.length;
  ok(meanZ < 0, `${tag}: mean room centre z ${f1(meanZ)} — no -Z drift`);

  // --- spawn points: cavern's bars + the terrain y stamp -------------------
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
      ok(minD >= 1.5, `${tag}: room ${r.id} spawn point ${f1(minD)} m from the rim`);
      ok(Math.hypot(p.x - r.centre.x, p.z - r.centre.z) <= r.radius,
        `${tag}: room ${r.id} spawn point outside its trigger disc`);
      ok(Math.abs((p.y ?? -1) - layout.heightAt(p.x, p.z)) < 1e-9,
        `${tag}: room ${r.id} spawn point y not terrain-stamped`);
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

  // --- roam points: on corridor floor, terrain-stamped, budget-consistent --
  const routeOrder = [0, ...layout.route, layout.bossRoom];
  const segDist = (px, pz, a, b) => {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz || 1;
    let t = ((px - a.x) * abx + (pz - a.z) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t));
  };
  for (let i = 0; i < layout.route.length; i++) {
    const site = R[layout.route[i]];
    const from = i === 0 ? R[0].centre : R[layout.route[i - 1]].centre;
    ok(site.roam >= 0 && site.roam <= (site.roamPoints?.length || 0)
      && site.roam <= site.budget,
    `${tag}: site ${site.id} roam ${site.roam} vs ${site.roamPoints?.length} points / budget ${site.budget}`);
    for (const p of site.roamPoints || []) {
      ok(floorAt(p.x, p.z), `${tag}: site ${site.id} roam point off the floor`);
      ok(Math.abs((p.y ?? -1) - layout.heightAt(p.x, p.z)) < 1e-9,
        `${tag}: site ${site.id} roam point y not terrain-stamped`);
      ok(segDist(p.x, p.z, from, site.centre) <= 8,
        `${tag}: site ${site.id} roam point ${f1(segDist(p.x, p.z, from, site.centre))} m off its route leg`);
    }
  }

  // --- budgets -------------------------------------------------------------
  const total = R.reduce((s, r) => s + r.budget, 0);
  ok(total === params.enemies, `${tag}: budgets sum ${total} != gate.enemies ${params.enemies}`);
  for (const r of R) {
    if (r.kind === 'combat') ok(r.budget >= 1, `${tag}: site ${r.id} budget ${r.budget}`);
    else ok(r.budget === 0, `${tag}: ${r.kind} room ${r.id} has budget ${r.budget}`);
  }

  // --- outcrops: clearances, lanes, corridor discipline, bolt-plane tops ---
  const cover = layout.decor.cover;
  ok(cover.length >= 8, `${tag}: only ${cover.length} outcrops — an empty plain, not a waste`);
  ok(cover.length <= cfg.maxPieces,
    `${tag}: ${cover.length} outcrops over the ${cfg.maxPieces} cap (dungeon.js would truncate collision)`);
  const usedKinds = new Set(cover.map((c) => c.kind));
  for (const k of usedKinds) {
    ok(COVER_KINDS[k] && COVER_KINDS[k].top >= COVER_MIN_TOP,
      `${tag}: outcrop kind ${k} does not clear the bolt plane`);
  }
  const bossRoomRec = R[layout.bossRoom];
  const bA = bossAnchor(bossRoomRec, null);
  const eA = exitAnchor(bossRoomRec, null);
  for (const c of cover) {
    const reach = Math.max(c.ex, c.ez);
    ok(Math.abs((c.y ?? -1) - layout.heightAt(c.x, c.z)) < 1e-9,
      `${tag}: outcrop y not terrain-stamped`);
    for (let i = 0; i + 1 < routeOrder.length; i++) {
      const a = R[routeOrder[i]].centre;
      const b = R[routeOrder[i + 1]].centre;
      ok(segDist(c.x, c.z, a, b) >= ROUTE_CORRIDOR_HALF + reach - 1e-9,
        `${tag}: outcrop ${f1(segDist(c.x, c.z, a, b))} m from route leg ${i} — the corridor is blocked`);
    }
    for (const r of R) {
      ok(Math.hypot(c.x - r.centre.x, c.z - r.centre.z) >= cfg.siteClear + reach - 1e-9,
        `${tag}: outcrop inside site ${r.id}'s clearing`);
    }
    ok(Math.hypot(c.x - bA.x, c.z - bA.z) >= cfg.bossClear + reach - 1e-9,
      `${tag}: outcrop on the boss rise anchor`);
    ok(Math.hypot(c.x - eA.x, c.z - eA.z) >= cfg.exitClear + reach - 1e-9,
      `${tag}: outcrop on the exit portal`);
    for (const r of R) {
      for (const p of r.spawnPoints) {
        ok(!(Math.abs(p.x - c.x) < c.ex + cfg.spawnClear && Math.abs(p.z - c.z) < c.ez + cfg.spawnClear),
          `${tag}: room ${r.id} spawn point survived inside an outcrop footprint`);
      }
      for (const p of r.roamPoints || []) {
        ok(Math.hypot(p.x - c.x, p.z - c.z) >= cfg.roamClear - 1e-9,
          `${tag}: site ${r.id} roam point inside an outcrop's roamClear`);
      }
    }
  }
  for (let i = 0; i < cover.length; i++) {
    for (let j = i + 1; j < cover.length; j++) {
      const a = cover[i];
      const b = cover[j];
      ok(Math.abs(a.x - b.x) >= a.ex + b.ex + cfg.lane - 1e-9
        || Math.abs(a.z - b.z) >= a.ez + b.ez + cfg.lane - 1e-9,
      `${tag}: outcrop pair ${i}/${j} leaves under ${cfg.lane} m of dash lane`);
    }
  }

  // --- wall runs carry their terrain band ----------------------------------
  for (const run of layout.wallRuns) {
    ok(Number.isFinite(run.base) && Number.isFinite(run.top) && run.top >= run.base - 1e-9,
      `${tag}: rim run without a sane base/top (${run.base}/${run.top})`);
  }

  // --- ZERO-TOLERANCE route-waypoint reachability --------------------------
  // The crawl proves every door reachable over the real combined field; the
  // waste has one door, so the same guarantee binds what it actually
  // navigates by: every site centre, every spawn point, every roam point,
  // the boss rise anchor and the exit portal, from the spawn, at body
  // radius, over walls + every outcrop — the SAME field and fill the
  // generator's own prune pass ran.
  {
    const field = buildWasteField(layout.wallRuns, cover);
    const fill = wasteFieldFill(field, { mask, w, h, originX, originZ, cell }, layout.heightAt);
    const way = [];
    for (const r of R) {
      way.push([`room ${r.id} centre`, r.centre]);
      r.spawnPoints.forEach((p, i) => way.push([`room ${r.id} spawn ${i}`, p]));
      (r.roamPoints || []).forEach((p, i) => way.push([`site ${r.id} roam ${i}`, p]));
    }
    way.push(['boss rise anchor', bA]);
    way.push(['exit portal', eA]);
    for (const [name, p] of way) {
      ok(fill.reachedAt(p.x, p.z),
        `${tag}: ${name} unreachable from spawn over the real obstacle field (ZERO tolerance)`);
    }
  }
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

// ---------------------------------------------------------------------------
// reach invariants — Wave E task E-S (ARCHON'S REACH, S rank)
// ---------------------------------------------------------------------------
// The crawl's shared bars (reachability, spans, dash units, budgets, entry
// translation, spawn clearance) plus the reach's own contracts: the linear
// chain shape, causeway treads under the body's stepHeight, the broken
// causeway's guaranteed >= 2-cell path at every row, the collapsing arena's
// phase data (descending radii that keep the boss rise + exit anchors on
// live floor to the LAST phase), the summit ring inside the final radius,
// and TWO zero-tolerance reachability proofs over the REAL obstacle picture:
// per-room per-door (the crawl's exact guarantee, floodFillRoom /
// doorReachableFrom — imported, never reimplemented) and whole-layout from
// the spawn (wasteFieldFill reused with the reach's analytic heightAt — the
// causeway-traversability proof, notches and cover included).

// The real collision picture a reach build registers, ABSOLUTE tops (pieces
// stand on their floor's height, dungeon.js's exact registration) — the
// crawl's coverField() with the tower/waste height stamp.
function reachField(layout) {
  const f = new ObstacleField({ stepOver: 0.4 });
  for (const run of layout.wallRuns) {
    f.addBox(run.x, run.z, run.w, run.d, run.rot, { tag: 'wall', nav: false });
  }
  for (const d of layout.doors) {
    f.addBox(d.x, d.z, d.w, d.d, d.rot, { top: 0, nav: false, tag: 'membrane' });
  }
  for (const c of layout.decor.columns.slice(0, RENDER_COLUMNS_CAP)) {
    f.addCircle(c.x, c.z, 0.34, { nav: false, tag: 'column' });
  }
  let clutter = 0;
  for (const p of layout.decor.props) {
    if (p.kind === 'statue' || p.kind === 'candles') continue;
    if (clutter >= RENDER_CLUTTER_CAP) continue;
    clutter++;
    const py = p.y || 0;
    if (p.kind === 'crate') f.addCircle(p.x, p.z, 0.4, { top: 0.4 + py, nav: false, tag: 'prop' });
    else if (p.kind === 'barrel') f.addCircle(p.x, p.z, 0.4, { top: 1.05 + py, nav: false, tag: 'prop' });
    else if (p.kind === 'pot') f.addCircle(p.x, p.z, 0.3, { top: 0.4 + py, nav: false, tag: 'prop' });
  }
  for (const c of layout.decor.cover) {
    const k = COVER_KINDS[c.kind];
    if (k.shape === 'circle') f.addCircle(c.x, c.z, k.r, { nav: false, tag: 'cover' });
    else f.addBox(c.x, c.z, k.hx * 2, k.hz * 2, c.yaw, { top: k.top + (c.y || 0), nav: false, tag: 'cover' });
  }
  return f.build();
}

function checkReachLayout(rank, seed, layout, params) {
  const tag = `${rank}/${seed}`;
  const R = layout.rooms;
  const { w, h, mask, originX, originZ, cell } = layout;
  const floorAt = (x, z) => {
    const gx = Math.floor((x - originX) / cell);
    const gz = Math.floor((z - originZ) / cell);
    return gx >= 0 && gz >= 0 && gx < w && gz < h && mask[gx + gz * w] === 1;
  };

  // --- the chain: entry -> gauntlet -> gauntlet -> summit ------------------
  ok(R.length === 4, `${tag}: reach has ${R.length} rooms, expected 4`);
  ok(R[0].kind === 'entry', `${tag}: room 0 kind ${R[0].kind}`);
  ok(R.filter((r) => r.kind === 'combat').length === 2,
    `${tag}: expected exactly 2 gauntlet rooms`);
  ok(R[layout.bossRoom].kind === 'boss', `${tag}: bossRoom is ${R[layout.bossRoom].kind}`);
  ok(layout.depth === 3, `${tag}: depth ${layout.depth}, the chain is 3 hops`);
  ok(layout.criticalPath.length === 4
    && layout.criticalPath[0] === 0
    && layout.criticalPath[3] === layout.bossRoom,
  `${tag}: criticalPath ${layout.criticalPath.join(',')}`);

  // --- door-graph reachability ---------------------------------------------
  const adj = Array.from({ length: R.length }, () => []);
  for (const d of layout.doors) {
    if (d.roomA >= 0 && d.roomB >= 0) {
      adj[d.roomA].push(d.roomB);
      adj[d.roomB].push(d.roomA);
    }
  }
  {
    const seen = new Set([0]);
    const q = [0];
    while (q.length) {
      const cur = q.shift();
      for (const nb of adj[cur]) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    ok(seen.size === R.length, `${tag}: ${R.length - seen.size} rooms unreachable in the door graph`);
  }
  const doorMin = layout.doors.reduce((m, d) => Math.min(m, d.w), Infinity);
  ok(doorMin >= 4, `${tag}: door span ${doorMin} under 4 m`);
  for (const d of layout.doors) {
    if (d.roomA >= 0) {
      ok(Math.abs((d.y || 0) - R[d.roomA].floorY) < 1e-6,
        `${tag}: door ${d.id} y ${d.y} != roomA floor ${R[d.roomA].floorY}`);
    }
  }

  // --- dash units + summit disc --------------------------------------------
  for (const r of R) {
    if (r.kind === 'combat') {
      ok(Math.min(r.w, r.d) >= 3 * DASH * 0.99,
        `${tag}: gauntlet ${r.id} short axis ${Math.min(r.w, r.d)} under 3 dashes`);
    }
  }
  const summit = R[layout.bossRoom];
  ok(floorAt(summit.centre.x, summit.centre.z), `${tag}: summit centre is not floor`);
  // Rect re-carved to a disc (+ the door's approach lane, which may hug a
  // corner): the floor fraction of the rect must be near pi/4, never the
  // full square.
  {
    let floorCells = 0;
    let total = 0;
    for (let zz = summit.z + 1; zz < summit.z + summit.d; zz += 2) {
      for (let xx = summit.x + 1; xx < summit.x + summit.w; xx += 2) {
        total++;
        if (floorAt(xx, zz)) floorCells++;
      }
    }
    ok(floorCells / total <= 0.85,
      `${tag}: summit floor fills ${(100 * (floorCells / total)).toFixed(0)}% of its rect — the disc re-carve failed`);
  }

  // --- the collapsing arena, as data ---------------------------------------
  const ph = layout.arenaPhases;
  ok(!!ph && Array.isArray(ph.radii) && Array.isArray(ph.thresholds),
    `${tag}: reach without arenaPhases`);
  if (ph) {
    ok(Math.abs(ph.cx - summit.centre.x) < 1e-6 && Math.abs(ph.cz - summit.centre.z) < 1e-6,
      `${tag}: arenaPhases centre off the summit centre`);
    ok(Math.abs((ph.y || 0) - summit.floorY) < 1e-6, `${tag}: arenaPhases y ${ph.y} != summit floor`);
    ok(ph.thresholds.length === ph.radii.length - 1,
      `${tag}: ${ph.thresholds.length} thresholds for ${ph.radii.length} radii`);
    for (let i = 1; i < ph.radii.length; i++) {
      ok(ph.radii[i] < ph.radii[i - 1] - 1,
        `${tag}: phase radii not strictly descending (${ph.radii.join(', ')})`);
    }
    for (let i = 0; i < ph.thresholds.length; i++) {
      ok(ph.thresholds[i] > 0 && ph.thresholds[i] < 1
        && (i === 0 || ph.thresholds[i] < ph.thresholds[i - 1]),
      `${tag}: thresholds not a descending hp ladder (${ph.thresholds.join(', ')})`);
    }
    // The full disc honours the 5-dash boss rule; the FINAL ring still holds
    // a fight (>= 10 m of live radius) AND both game anchors.
    ok(ph.radii[0] * 2 >= 5 * DASH, `${tag}: full arena ${ph.radii[0] * 2} m under 5 dashes`);
    const lastR = ph.radii[ph.radii.length - 1];
    ok(lastR >= 10, `${tag}: final phase radius ${lastR} — not an arena, a pen`);
    const summitDoor = summit.doors.length ? layout.doors[summit.doors[0]] : null;
    const bA = bossAnchor(summit, summitDoor);
    const eA = exitAnchor(summit, summitDoor);
    ok(Math.hypot(bA.x - ph.cx, bA.z - ph.cz) <= ph.radii[0] - 1,
      `${tag}: boss rise anchor outside the full arena`);
    // The rings retract on the boss's death (encounters.onBossDeath resets
    // the phase), so the walk-out only needs the FULL disc to hold it.
    ok(Math.hypot(eA.x - ph.cx, eA.z - ph.cz) <= ph.radii[0] - 0.9,
      `${tag}: exit anchor outside the full arena disc`);
  }

  // --- heights: the analytic contract --------------------------------------
  ok(typeof layout.heightAt === 'function', `${tag}: reach without a live heightAt`);
  ok(layout.heightAt(0, 0) === 0, `${tag}: spawn datum heightAt(0,0) = ${layout.heightAt(0, 0)}`);
  for (const r of R) {
    ok(Math.abs(layout.heightAt(r.centre.x, r.centre.z) - r.floorY) < 1e-6,
      `${tag}: room ${r.id} centre height ${layout.heightAt(r.centre.x, r.centre.z)} != floorY ${r.floorY}`);
  }
  // Every causeway tread clears the body's 0.4 m stepHeight, and the height
  // function is continuous along the climb (no cliff mid-ramp).
  ok(layout.ramps.length === 3, `${tag}: ${layout.ramps.length} causeways, expected 3`);
  for (const rp of layout.ramps) {
    const span = rp.axis === 'x' ? rp.gw : rp.gd;
    const tread = (rp.y1 - rp.y0) / (span + 1);
    ok(tread <= 0.4 + 1e-9, `${tag}: causeway tread ${tread.toFixed(3)} over the 0.4 m stepHeight`);
    // Centreline walk, one cell at a time, entry side to top side.
    const width = rp.axis === 'x' ? rp.gd : rp.gw;
    let prev = null;
    for (let i = 0; i < span; i++) {
      const gx = rp.axis === 'x' ? rp.gx + i : rp.gx + (rp.gw >> 1);
      const gz = rp.axis === 'x' ? rp.gz + (rp.gd >> 1) : rp.gz + i;
      const y = layout.heightAt(originX + (gx + 0.5) * cell, originZ + (gz + 0.5) * cell);
      if (prev !== null) {
        ok(Math.abs(y - prev) <= 0.45,
          `${tag}: causeway height step ${Math.abs(y - prev).toFixed(2)} between treads`);
      }
      prev = y;
    }
    // BROKEN, not severed: >= 2 cells of causeway floor at every row.
    for (let i = 0; i < span; i++) {
      let open = 0;
      for (let k = 0; k < width; k++) {
        const gx = rp.axis === 'x' ? rp.gx + i : rp.gx + k;
        const gz = rp.axis === 'x' ? rp.gz + k : rp.gz + i;
        if (mask[gx + gz * w]) open++;
      }
      ok(open >= 2, `${tag}: causeway row ${i} has ${open} open cells (need >= 2)`);
    }
  }

  // --- entry translation + drift -------------------------------------------
  ok(layout.entry.x === 0 && layout.entry.z === 0, `${tag}: entry not at origin`);
  ok(floorAt(0, 0), `${tag}: spawn (0,0) is not on floor`);
  const meanZ = R.reduce((s, r) => s + r.centre.z, 0) / R.length;
  ok(meanZ < 0, `${tag}: mean room centre z ${meanZ} — no -Z drift`);

  // --- spawn points ---------------------------------------------------------
  for (const r of R) {
    ok(r.spawnPoints.length >= spawnPointsNeeded(rank, r.kind),
      `${tag}: room ${r.id} (${r.kind}) has ${r.spawnPoints.length} spawn points, `
      + `needs ${spawnPointsNeeded(rank, r.kind)}`);
    for (const p of r.spawnPoints) {
      ok(Math.abs((p.y || 0) - r.floorY) < 1e-6,
        `${tag}: room ${r.id} spawn point y ${p.y} != floor ${r.floorY}`);
      for (const run of layout.wallRuns) {
        if (runDistance(p, run) < 1.5) {
          ok(false, `${tag}: room ${r.id} spawn point ${runDistance(p, run).toFixed(2)} m from a wall run`);
          break;
        }
      }
    }
  }

  // --- budgets --------------------------------------------------------------
  const budgetSum = R.reduce((s, r) => s + r.budget, 0);
  ok(budgetSum === params.enemies,
    `${tag}: budgets sum ${budgetSum} != enemies ${params.enemies}`);
  for (const r of R) {
    if (r.kind === 'combat') ok(r.budget >= 1, `${tag}: gauntlet ${r.id} budget ${r.budget}`);
  }

  // --- cover: gauntlets carry a field, the summit its ring ------------------
  const cfg = params.cover;
  const byRoom = new Map();
  for (const c of layout.decor.cover) {
    if (!byRoom.has(c.room)) byRoom.set(c.room, []);
    byRoom.get(c.room).push(c);
    ok(Math.abs((c.y || 0) - R[c.room].floorY) < 1e-6,
      `${tag}: cover piece y ${c.y} != its room's floor ${R[c.room].floorY}`);
  }
  ok((byRoom.get(0) || []).length === 0, `${tag}: entry room carries cover`);
  for (const r of R) {
    if (r.kind !== 'combat') continue;
    ok((byRoom.get(r.id) || []).length >= cfg.minPieces,
      `${tag}: gauntlet ${r.id} has ${(byRoom.get(r.id) || []).length} cover pieces`);
  }
  const ringPieces = byRoom.get(layout.bossRoom) || [];
  ok(ringPieces.length >= 3, `${tag}: summit ring has ${ringPieces.length} pieces (need >= 3)`);
  if (ph) {
    const lastR = ph.radii[ph.radii.length - 1];
    for (const c of ringPieces) {
      const d = Math.hypot(c.x - ph.cx, c.z - ph.cz) + Math.max(c.ex, c.ez);
      ok(d <= lastR - 0.5,
        `${tag}: summit ring piece reaches ${d.toFixed(1)} m — outside the final radius ${lastR}`);
    }
  }
  for (const r of R) {
    const list = byRoom.get(r.id) || [];
    for (const c of list) {
      for (const p of r.spawnPoints) {
        ok(!(Math.abs(p.x - c.x) < c.ex + cfg.spawnClear && Math.abs(p.z - c.z) < c.ez + cfg.spawnClear),
          `${tag}: room ${r.id} spawn point survived inside a cover footprint`);
      }
    }
  }
  for (const [name, k] of Object.entries(COVER_KINDS)) {
    ok(k.top >= COVER_MIN_TOP, `${tag}: COVER_KINDS.${name} top ${k.top} under the bolt plane`);
  }

  // --- ZERO-TOLERANCE reachability over the REAL field ----------------------
  const field = reachField(layout);
  // (1) The crawl's per-room per-door guarantee, height-aware: the fill's
  // open set is the room's actual FLOOR (mask-masked — the summit rect's
  // rock corners are not "cut-off floor"), blocked() sampled at the room's
  // own floor height so absolute cover tops read exactly as a body does.
  for (const r of R) {
    if (r.kind === 'entry') continue;
    const masked = {
      blocked: (x, z, rad, stepOver, feetY) => !floorAt(x, z)
        || field.blocked(x, z, rad, stepOver, r.floorY),
    };
    const fill = floodFillRoom(masked, r);
    const cutOff = fill.total - fill.reached;
    ok(fill.total > 0 && cutOff <= STRAY_POCKET_TOLERANCE,
      `${tag}: room ${r.id} (${r.kind}) walkable floor is ${cutOff} of ${fill.total} cells cut off`);
    const ownDoors = r.doors.map((id) => layout.doors[id]).filter((d) => d && d.roomA === r.id);
    for (const d of ownDoors) {
      ok(doorReachableFrom(fill, r, d),
        `${tag}: room ${r.id} (${r.kind}) door ${d.id} is cut off from the room's open floor`);
    }
  }
  // (2) Whole-layout from the spawn: the causeway-traversability proof —
  // wasteFieldFill reused with the reach's analytic heightAt, so a notch
  // pass, a cover roll and the door shoulders are all tested TOGETHER
  // against the same collision the player resolves.
  {
    const fill = wasteFieldFill(field, { mask, w, h, originX, originZ, cell }, layout.heightAt);
    const waypoints = [];
    for (const r of R) {
      // A gauntlet's CENTRE is a legal cover spot (only treasure rooms carry
      // a centreClear keep-out), so the waypoints that must hold are the ones
      // the game will stand a body on: every surviving spawn point, plus the
      // entry/summit centres, which stay clear by construction (deploy pad;
      // the ring holds off the middle).
      if (r.kind === 'entry' || r.kind === 'boss') {
        waypoints.push({ what: `room ${r.id} centre`, x: r.centre.x, z: r.centre.z });
      }
      for (const p of r.spawnPoints) waypoints.push({ what: `room ${r.id} spawn`, x: p.x, z: p.z });
    }
    if (ph) {
      const summitDoor = summit.doors.length ? layout.doors[summit.doors[0]] : null;
      const bA = bossAnchor(summit, summitDoor);
      const eA = exitAnchor(summit, summitDoor);
      waypoints.push({ what: 'boss rise anchor', x: bA.x, z: bA.z });
      waypoints.push({ what: 'exit anchor', x: eA.x, z: eA.z });
    }
    for (const p of waypoints) {
      if (!fill.reachedAt(p.x, p.z)) {
        ok(false, `${tag}: ${p.what} unreachable from the spawn over the real field`);
        break;
      }
    }
  }
}

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
    // `deep` now only gates the boss-vs-ordinary-room density/sightline
    // COMPARISON below (another N room-fills of random chords) — the
    // room-wide flood fill + per-door reachability check runs on every seed
    // regardless (see checkCover's traversability block for why it had to
    // stop being strided).
    const deep = i % 5 === 0;
    // The tower's rooms are the crawl's plateau rects, so the WHOLE cover
    // invariant set — including the zero-tolerance per-door reachability over
    // the real combined obstacle field — runs on it unchanged (each room's
    // check lives in its own floor's frame; collision tops are relative
    // per-room here and floor-offset at runtime, which are the same picture
    // for a body standing on that floor).
    const cover = layout.kind === 'crawl' || layout.kind === 'tower'
      ? checkCover(rank, seed, layout, params, deep) : null;
    if (cover) {
      const cs = agg.cover;
      cs.samples++;
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

// ---------------------------------------------------------------------------
// ANOMALY KIND SWAPS — Wave E task E-S item 3. An anomalous B+ gate may carry
// `anomalyKind`: Dungeon.build then generates the DONOR rank's whole params
// row under the anomalous gate's rank tag (dungeonmode rolls the kind off the
// anomaly stream; the copy bakes it, the context-loss rebuild reads the
// copy). Prove every legal (rank, donor-kind) pair generates valid layouts —
// the donor kind's OWN invariant set, run under the borrowing rank's tag —
// and rebuilds byte-identically. 'reach' never rolls as an anomaly (the S
// set-piece is singular), matching dungeonmode's pool.
// ---------------------------------------------------------------------------
{
  const DONORS = { crawl: 'E', cavern: 'C', tower: 'B', waste: 'A' };
  const ANOMALY_SEEDS = Math.max(4, Math.min(8, SEEDS >> 4));
  for (const rank of ['B', 'A', 'S']) {
    const own = LAYOUT_PARAMS[rank].kind;
    for (const [kind, donorRank] of Object.entries(DONORS)) {
      if (kind === own) continue;
      const params = LAYOUT_PARAMS[donorRank];
      for (let i = 0; i < ANOMALY_SEEDS; i++) {
        const seed = ((i * 2654435761) ^ 0x9e37cafe) >>> 0;
        const layout = generateLayout({ rank, seed, params });
        ok(layout.kind === kind, `anomaly ${rank}-as-${kind}/${seed}: generated kind ${layout.kind}`);
        checkLayout(rank, seed, layout, params);
        const again = generateLayout({ rank, seed, params });
        ok(serialize(layout).equals(serialize(again)),
          `anomaly ${rank}-as-${kind}/${seed}: repeat generation differs (DETERMINISM BROKEN)`);
      }
    }
  }
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
      + `[${c.samples} seeds x every room flood-filled + every door reachability-checked]`);
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
if (maps.B) {
  console.log('\nfirst B tower (S spawn, E entry, C combat, T treasure, B boss — floors climb toward B):');
  for (const row of maps.B) console.log(`  ${row}`);
}
if (maps.A) {
  console.log('\nfirst A waste (S spawn, E entry, C route site, B boss site — the compass walks E->C->C->C->B):');
  for (const row of maps.A) console.log(`  ${row}`);
}
if (maps.S) {
  console.log('\nfirst S reach (S spawn, E entry, C gauntlet, B summit — three broken causeways climb E->C->C->B):');
  for (const row of maps.S) console.log(`  ${row}`);
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
