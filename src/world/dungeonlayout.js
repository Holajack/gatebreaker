// Pure dungeon layout generation — DUNGEON_SPEC.json STEP 1.
//
// NO `import * as THREE`, no DOM: tools/dungeon-gen-test.mjs imports this in
// plain Node and soaks hundreds of seeds per second, exactly like navgrid.js
// and obstacles.js. Positions are plain numbers / {x,z} ducks.
//
// DETERMINISM IS LOAD-BEARING. Context-loss recovery rebuilds the mounted
// world via world.build(gate, seed), so generateLayout(seed) must reproduce
// the identical layout byte-for-byte. Everything random reads one of three
// forked mulberry32 streams (the world.js cragRnd pattern):
//
//   layoutRnd    = mulberry32((seed ^ 0x9e3779b9) >>> 0)   rooms/corridors/
//                                                          loops/spawn jitter
//   decorRnd     = mulberry32((seed ^ 0x5f356495) >>> 0)   torches/columns/
//                                                          props/alcoves
//   encounterRnd = mulberry32((seed ^ 0x1f123bb5) >>> 0)   treasure roll
//
// so decor tuning can never reshuffle rooms, and encounter tuning can never
// move a wall. No Math.random, no Date.now, anywhere in this file.
//
// COORDINATES. The grid is w x h cells of `cell` = 2 m (matching citykit's
// KIT_CELL and its 2 m wall modules). Grid +X = world +X ("e"), grid +Z =
// world +Z ("s"). The fixed camera sits at +Z looking toward -Z, so "n" is
// into the screen. All exported coordinates are WORLD METRES, already
// translated so the entry spawn is (0, 0) and the dungeon grows toward -Z
// (player.yaw = 0 faces -Z after _beginGate, straight down the entry tunnel).
// mask[gx + gz * w] is 0 rock / 1 floor; worldX = originX + (gx + 0.5) * cell.
//
// WALL-RUN `face` CONVENTION (STEP 3/7 renderers key off this): face is the
// side of the adjacent floor that the run bounds — the compass direction FROM
// the floor cell TOWARD the rock. face 's' means the run is the floor's
// southern boundary (floor lies to the run's north). Because the camera looks
// from +Z, face-'s' runs sit between the camera and the floor they bound, so
// THOSE are the ones the renderer drops to params.wallHeightLow ("south-facing
// runs low" in the spec); every other face renders at params.wallHeight.
//
// DOOR RECORDS: w is the clear span across the opening in metres (>= 4), d is
// the membrane thickness (1.2 m, matching the spec's pre-registered membrane
// boxes). rot 0 = the opening's normal points n/s (span runs along X);
// rot = PI/2 = normal points e/w (span along Z). roomA is the room whose wall
// the door sits in; roomB is the room at the far end of the connecting
// corridor (-1 for the entry tunnel's junction, which leads outside).

import { mulberry32 } from '../core/rng.js';

// Every tunable per rank. `enemies` mirrors config.js GATES (E 12 / D 18 /
// C 26) as the default room-budget total; Dungeon.build passes the live
// gate.enemies through generateLayout's `enemies` option, so these defaults
// only feed headless tests. E/D are the crawl kind; C is the STEP 8 cavern.
export const LAYOUT_PARAMS = {
  E: {
    kind: 'crawl',
    grid: 48,                       // 48 x 48 cells = 96 m
    rooms: [5, 6],                  // regular rooms, + entry + boss
    roomSize: { w: [5, 8], d: [4, 6] },
    bossSize: { w: 9, d: 7 },
    vault: null,
    corridorWidths: [2],
    corridorLen: [3, 6],
    tunnelLen: [8, 10],
    loops: 1,
    minBossDepth: 3,
    wallHeight: 4,
    wallHeightLow: 2,               // face-'s' runs (fixed-camera occluders)
    torchSpacing: 6,
    propDensity: 'low',
    alcoves: false,
    treasure: { chance: 0.2, guaranteed: false },
    fog: { near: 12, far: 34 },
    enemies: 12,
  },
  D: {
    kind: 'crawl',
    grid: 56,                       // 56 x 56 cells = 112 m
    rooms: [7, 8],
    roomSize: { w: [5, 9], d: [4, 7] },
    bossSize: { w: 10, d: 8 },
    vault: { w: [10, 12], d: [6, 8] },  // one vault hall per layout
    corridorWidths: [2, 3],
    corridorLen: [3, 6],
    tunnelLen: [9, 11],
    loops: 2,
    minBossDepth: 4,
    wallHeight: 4,
    wallHeightLow: 2,
    torchSpacing: 7,
    propDensity: 'medium',
    alcoves: true,
    treasure: { chance: 1, guaranteed: true },
    fog: { near: 12, far: 36 },
    enemies: 18,
  },
  C: {
    kind: 'cavern',                 // STEP 8 — one huge organic chamber
    grid: 64,                       // 64 x 64 cells = 128 m
    rooms: [4, 5],                  // encounter ZONES (combat), + entry + boss
    discs: [9, 14],                 // disc-union random walk, disc count
    discR: [8, 18],                 // walk disc radius, metres
    grottos: 2,                     // attached side grottos (3rd is the boss's)
    grottoR: [6, 9],                // side-grotto radius, metres
    bossR: [10, 12],                // boss grotto radius, metres (~24x20 room)
    neckGap: [2, 3],                // rock cells between mass and boss grotto
    zoneRadius: 9,                  // encounter trigger disc radius, metres
    zoneSpacing: 14,                // min zone centre-to-centre, metres
    tunnelLen: [10, 12],
    tunnelWidth: 3,                 // cells (6 m)
    loops: 0,
    minBossDepth: 3,
    wallHeight: 6,
    wallHeightLow: 6,               // caves stay enclosed; the camera boom
                                    // probe (not wall lowering) is the net here
    crystalSpacing: 9,              // bioluminescent clusters along wall runs
    stalagmites: {
      cellStep: 2,                  // jittered-grid Poisson step, cells (4 m)
      chance: 0.62,                 // per-sample keep roll
      spireChance: 0.4,             // tall full-cover spire vs step-over rubble
      zoneClear: 3.5,               // clearing radius around zone centres, m
      spawnClear: 2.2,              // clearing radius around spawn points, m
      doorClear: 3.0,               // clearing radius around door centres, m
    },
    fog: { near: 18, far: 55 },
    enemies: 26,
  },
};

const CELL = 2;
const DOOR_THICKNESS = 1.2;   // membrane box depth, per spec generation step 6
const WALL_THICKNESS = 0.6;   // wall-run obstacle box depth, spec step 7
// The spec's -Z drift: growth direction weights n/e/w/s.
const DIR_WEIGHTS = [
  ['n', 0.45], ['e', 0.2], ['w', 0.2], ['s', 0.15],
];
const REGEN_TRIES = 8;        // bounded retry — the counter is part of the
                              // derivation, so seed -> same retries -> same
                              // layout (spec generation step 5)

function randint(rnd, lo, hi) {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

function rollDir(rnd) {
  let t = rnd();
  for (const [d, w] of DIR_WEIGHTS) {
    t -= w;
    if (t < 0) return d;
  }
  return 's';
}

/**
 * Generate a deterministic room-and-corridor crawl layout.
 * @param {object} o
 * @param {'E'|'D'} o.rank
 * @param {number} o.seed     per-run gate seed (game.js _beginGate)
 * @param {object} [o.params] tunables; default LAYOUT_PARAMS[rank]
 * @param {number} [o.enemies] room-budget total (gate.enemies); default
 *   params.enemies so headless tests need no gate object
 * @returns {object} DungeonLayout — see header comment for the full shape
 */
export function generateLayout({ rank, seed, params = LAYOUT_PARAMS[rank], enemies = params?.enemies } = {}) {
  if (!params) throw new Error(`generateLayout: no params for rank ${rank}`);
  const gen = params.kind === 'crawl' ? tryGenerate
    : params.kind === 'cavern' ? tryGenerateCavern
      : null;
  if (!gen) {
    throw new Error(`generateLayout: unknown kind '${params.kind}' (rank ${rank})`);
  }
  // Depth-gated regeneration: a too-shallow tree regenerates wholesale from
  // seed+attempt. Bounded, then accept the deepest attempt — determinism over
  // perfection (the retry counter is part of the derivation, so the same seed
  // walks the same attempts and lands on the same layout).
  let best = null;
  for (let attempt = 0; attempt < REGEN_TRIES; attempt++) {
    const layout = gen(rank, params, enemies, (seed + attempt) >>> 0);
    if (layout.depth >= params.minBossDepth) return layout;
    if (layout.depth >= 0 && (!best || layout.depth > best.depth)) best = layout;
  }
  if (!best) {
    // 8 deterministic attempts without even a structurally valid layout means
    // the params are broken (grid too small for the room count), not bad luck.
    throw new Error(`generateLayout: rank ${rank} seed ${seed} produced no valid layout in ${REGEN_TRIES} attempts`);
  }
  return best;
}

// ---------------------------------------------------------------------------
// single attempt
// ---------------------------------------------------------------------------

function tryGenerate(rank, params, enemies, seed) {
  const layoutRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const decorRnd = mulberry32((seed ^ 0x5f356495) >>> 0);
  const encounterRnd = mulberry32((seed ^ 0x1f123bb5) >>> 0);

  const w = params.grid;
  const h = params.grid;
  const mask = new Uint8Array(w * h);         // 0 rock, 1 floor
  // Ownership per cell: -1 rock, -2 corridor, >= 0 room id. Drives the pad
  // checks that keep 1 cell of rock between any two floor areas that are not
  // joined by a registered door — without it two rooms could touch and leak
  // enemies past a sealed membrane.
  const owner = new Int16Array(w * h).fill(-1);
  const at = (gx, gz) => gx + gz * w;
  const inBounds = (gx, gz) => gx >= 1 && gz >= 1 && gx <= w - 2 && gz <= h - 2;

  const rooms = [];      // { id, gx, gz, gw, gd, kind }
  const corridors = [];  // { gx, gz, gw, gd }
  const doors = [];      // { plane:'x'|'z', at, lo, hi, roomA, roomB }

  function carve(gx, gz, gw, gd, own) {
    for (let z = gz; z < gz + gd; z++) {
      for (let x = gx; x < gx + gw; x++) {
        mask[at(x, z)] = 1;
        owner[at(x, z)] = own;
      }
    }
  }

  /**
   * True when every cell of `rects` is in-bounds rock AND its 1-cell shell
   * (8-neighbourhood) contains no floor outside `rects` other than at the
   * `allowed` junction strips (the EXACT door spans where the new carving is
   * supposed to meet existing floor). Edge-sharing contact must land inside a
   * strip — an edge contact outside a door span would be a walkable opening
   * with no membrane, letting enemies stroll past a sealed door. Corner-only
   * (diagonal) contact is tolerated one cell around each strip because every
   * junction has it at the opening's shoulders, and it is not walkable: the
   * wall runs on both sides meet at that corner and collision seals it.
   */
  function placeable(rects, allowed) {
    for (const r of rects) {
      for (let z = r.gz; z < r.gz + r.gd; z++) {
        for (let x = r.gx; x < r.gx + r.gw; x++) {
          if (!inBounds(x, z)) return false;
          if (mask[at(x, z)]) return false;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dz === 0) continue;
              const nx = x + dx;
              const nz = z + dz;
              if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
              if (!mask[at(nx, nz)]) continue;
              if (inRects(nx, nz, rects, 0)) continue;      // our own carving
              const grow = (dx === 0 || dz === 0) ? 0 : 1;
              if (!inRects(nx, nz, allowed, grow)) return false;
            }
          }
        }
      }
    }
    return true;
  }

  function inRects(gx, gz, rects, grow) {
    for (const r of rects) {
      if (gx >= r.gx - grow && gx < r.gx + r.gw + grow
        && gz >= r.gz - grow && gz < r.gz + r.gd + grow) return true;
    }
    return false;
  }

  // --- step 2: entry room near the +Z edge, tunnel south of it -------------
  const tunnelLen = randint(layoutRnd, params.tunnelLen[0], params.tunnelLen[1]);
  const egw = randint(layoutRnd, params.roomSize.w[0], params.roomSize.w[1]);
  const egd = randint(layoutRnd, params.roomSize.d[0], params.roomSize.d[1]);
  const egx = Math.floor((w - egw) / 2) + randint(layoutRnd, -2, 2);
  const egz = h - 1 - tunnelLen - egd;         // bottom row + tunnel + 1 border
  carve(egx, egz, egw, egd, 0);
  rooms.push({ id: 0, gx: egx, gz: egz, gw: egw, gd: egd, kind: 'entry' });

  // Entry tunnel: 2 cells wide, centred on the entry room, running to +Z.
  const tx0 = egx + Math.floor((egw - 2) / 2);
  carve(tx0, egz + egd, 2, tunnelLen, -2);
  corridors.push({ gx: tx0, gz: egz + egd, gw: 2, gd: tunnelLen });
  // Junction door (the membrane the intro seals behind you). roomB -1: the
  // far side is the outside world, not a room.
  doors.push({ plane: 'z', at: egz + egd, lo: tx0, hi: tx0 + 1, roomA: 0, roomB: -1 });

  // --- step 3: frontier room walk ------------------------------------------
  const regular = randint(layoutRnd, params.rooms[0], params.rooms[1]);
  const targetRooms = regular + 1;             // +1: the future boss room
  // D carries one oversized vault hall; pick which placement slot it is now
  // so the roll count per room stays fixed.
  const vaultSlot = params.vault ? randint(layoutRnd, 0, targetRooms - 1) : -1;

  let placed = 0;
  while (placed < targetRooms) {
    let ok = false;
    for (let tries = 0; tries < 40 && !ok; tries++) {
      // Recency-weighted source pick: sqrt biases toward late rooms so the
      // dungeon wanders instead of starburst-ing off the entry.
      const src = rooms[Math.min(rooms.length - 1,
        Math.floor(Math.sqrt(layoutRnd()) * rooms.length))];
      const dir = rollDir(layoutRnd);
      const cw = params.corridorWidths[
        Math.floor(layoutRnd() * params.corridorWidths.length)];
      const len = randint(layoutRnd, params.corridorLen[0], params.corridorLen[1]);
      const size = placed === vaultSlot ? params.vault : params.roomSize;
      const rw = randint(layoutRnd, size.w[0], size.w[1]);
      const rd = randint(layoutRnd, size.d[0], size.d[1]);
      const cand = corridorAndRoom(src, dir, cw, len, rw, rd, layoutRnd);
      if (!cand) continue;
      if (!placeable([cand.corridor, cand.room], [cand.allowed])) continue;

      const id = rooms.length;
      carve(cand.room.gx, cand.room.gz, cand.room.gw, cand.room.gd, id);
      carve(cand.corridor.gx, cand.corridor.gz, cand.corridor.gw, cand.corridor.gd, -2);
      rooms.push({ id, gx: cand.room.gx, gz: cand.room.gz, gw: cand.room.gw, gd: cand.room.gd, kind: 'combat' });
      corridors.push(cand.corridor);
      doors.push({ ...cand.doorA, roomA: src.id, roomB: id });
      doors.push({ ...cand.doorB, roomA: id, roomB: src.id });
      ok = true;
    }
    if (!ok) break;   // grid too crowded — the caller's regen loop handles it
    placed++;
  }
  // Too few rooms is as bad as a shallow tree: signal regen via depth -1.
  if (placed < params.rooms[0] + 1) return { depth: -1 };

  // --- step 4: loops --------------------------------------------------------
  for (let li = 0; li < params.loops; li++) {
    tryLoop(rooms, doors, corridors, layoutRnd, placeable, carve);
  }

  // --- step 5: boss room = deepest room, re-stamped larger ------------------
  const graph = adjacency(rooms.length, doors);
  const depths = bfsDepths(graph, 0);
  let boss = -1;
  let bossDepth = -1;
  const entryC = roomCentre(rooms[0]);
  let bossDist = -1;
  for (const r of rooms) {
    if (r.id === 0) continue;
    const d = depths[r.id];
    const c = roomCentre(r);
    const dist = (c.x - entryC.x) ** 2 + (c.z - entryC.z) ** 2;
    if (d > bossDepth || (d === bossDepth && dist > bossDist)) {
      boss = r.id; bossDepth = d; bossDist = dist;
    }
  }
  if (boss < 0 || bossDepth < 0) return { depth: -1 };
  rooms[boss].kind = 'boss';
  growRoom(rooms[boss], params.bossSize, mask, owner, w, h, at, inBounds, carve);

  // --- step 6/8: classification + critical path -----------------------------
  const criticalPath = bfsPath(graph, 0, boss);
  pickTreasure(rooms, graph, criticalPath, params.treasure, encounterRnd);

  // --- world translation ----------------------------------------------------
  // Spawn: tunnel centreline, 1.6 m north of the tunnel's south wall plane —
  // clear of the 1.2 m-thick portal membrane box STEP 3 registers on it.
  const southPlane = (egz + egd + tunnelLen) * CELL;
  const originX = -(tx0 + 1) * CELL;
  const originZ = -(southPlane - 1.6);

  const outRooms = rooms.map((r) => ({
    id: r.id,
    kind: r.kind,
    x: originX + r.gx * CELL,
    z: originZ + r.gz * CELL,
    w: r.gw * CELL,
    d: r.gd * CELL,
    centre: {
      x: originX + (r.gx + r.gw / 2) * CELL,
      z: originZ + (r.gz + r.gd / 2) * CELL,
    },
    doors: [],
    spawnPoints: [],
    budget: 0,
  }));
  const outDoors = doors.map((d, i) => {
    const span = (d.hi - d.lo + 1) * CELL;
    const mid = originHalf(d.lo, d.hi);
    return d.plane === 'z'
      ? { id: i, x: originX + mid * CELL, z: originZ + d.at * CELL, w: span, d: DOOR_THICKNESS, rot: 0, roomA: d.roomA, roomB: d.roomB }
      : { id: i, x: originX + d.at * CELL, z: originZ + mid * CELL, w: span, d: DOOR_THICKNESS, rot: Math.PI / 2, roomA: d.roomA, roomB: d.roomB };
  });
  for (const d of outDoors) {
    if (d.roomA >= 0) outRooms[d.roomA].doors.push(d.id);
    if (d.roomB >= 0) outRooms[d.roomB].doors.push(d.id);
  }
  const outCorridors = corridors.map((c) => ({
    x: originX + (c.gx + c.gw / 2) * CELL,
    z: originZ + (c.gz + c.gd / 2) * CELL,
    w: c.gw * CELL,
    d: c.gd * CELL,
  }));

  // --- step 7: merged wall runs --------------------------------------------
  const wallRuns = buildWallRuns(mask, w, h, at, originX, originZ);

  // --- step 9: spawn points + budgets --------------------------------------
  for (const r of rooms) {
    outRooms[r.id].spawnPoints = spawnPointsFor(r, mask, w, h, at, originX, originZ, layoutRnd);
  }
  assignBudgets(outRooms, criticalPath, enemies);

  // --- bounds / radius ------------------------------------------------------
  const { bounds, radius } = boundsFromMask(mask, w, h, at, originX, originZ);

  // --- step 10: decor anchors (decorRnd only) -------------------------------
  const decor = buildDecor(outRooms, outDoors, wallRuns, params, decorRnd);

  return {
    kind: 'crawl',
    rank,
    cell: CELL,
    w,
    h,
    originX,
    originZ,
    mask,
    rooms: outRooms,
    doors: outDoors,
    corridors: outCorridors,
    wallRuns,
    decor,
    criticalPath,
    bossRoom: boss,
    depth: bossDepth,
    entry: { x: 0, z: 0, yaw: 0 },   // yaw 0 faces -Z, straight up the tunnel
    bounds,
    radius,
    params: {
      wallHeight: params.wallHeight,
      wallHeightLow: params.wallHeightLow,
      torchSpacing: params.torchSpacing,
      fog: params.fog,
    },
  };
}

function originHalf(lo, hi) { return (lo + hi + 1) / 2; }

function roomCentre(r) {
  return { x: r.gx + r.gw / 2, z: r.gz + r.gd / 2 };
}

// Floor-mask bbox inflated by the wall-run thickness, plus the bounding radius
// from origin — the same numbers both kinds hand the world contract.
function boundsFromMask(mask, w, h, at, originX, originZ) {
  let minGX = w; let maxGX = 0; let minGZ = h; let maxGZ = 0;
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (!mask[at(gx, gz)]) continue;
      if (gx < minGX) minGX = gx;
      if (gx > maxGX) maxGX = gx;
      if (gz < minGZ) minGZ = gz;
      if (gz > maxGZ) maxGZ = gz;
    }
  }
  const bounds = {
    minX: originX + minGX * CELL - WALL_THICKNESS,
    minZ: originZ + minGZ * CELL - WALL_THICKNESS,
    maxX: originX + (maxGX + 1) * CELL + WALL_THICKNESS,
    maxZ: originZ + (maxGZ + 1) * CELL + WALL_THICKNESS,
  };
  const radius = Math.max(
    Math.hypot(bounds.minX, bounds.minZ), Math.hypot(bounds.maxX, bounds.minZ),
    Math.hypot(bounds.minX, bounds.maxZ), Math.hypot(bounds.maxX, bounds.maxZ),
  );
  return { bounds, radius };
}

// ---------------------------------------------------------------------------
// frontier corridor + room candidate geometry
// ---------------------------------------------------------------------------

function corridorAndRoom(src, dir, cw, len, rw, rd, rnd) {
  // The opening strip must fit fully on the source wall.
  if (dir === 'n' || dir === 's') {
    if (src.gw < cw) return null;
    const c0 = src.gx + randint(rnd, 0, src.gw - cw);
    const rx = randint(rnd, c0 + cw - rw, c0);
    if (dir === 'n') {
      return {
        corridor: { gx: c0, gz: src.gz - len, gw: cw, gd: len },
        room: { gx: rx, gz: src.gz - len - rd, gw: rw, gd: rd },
        allowed: { gx: c0, gz: src.gz, gw: cw, gd: 1 },
        doorA: { plane: 'z', at: src.gz, lo: c0, hi: c0 + cw - 1 },
        doorB: { plane: 'z', at: src.gz - len, lo: c0, hi: c0 + cw - 1 },
      };
    }
    const base = src.gz + src.gd;
    return {
      corridor: { gx: c0, gz: base, gw: cw, gd: len },
      room: { gx: rx, gz: base + len, gw: rw, gd: rd },
      allowed: { gx: c0, gz: base - 1, gw: cw, gd: 1 },
      doorA: { plane: 'z', at: base, lo: c0, hi: c0 + cw - 1 },
      doorB: { plane: 'z', at: base + len, lo: c0, hi: c0 + cw - 1 },
    };
  }
  if (src.gd < cw) return null;
  const r0 = src.gz + randint(rnd, 0, src.gd - cw);
  const rz = randint(rnd, r0 + cw - rd, r0);
  if (dir === 'e') {
    const base = src.gx + src.gw;
    return {
      corridor: { gx: base, gz: r0, gw: len, gd: cw },
      room: { gx: base + len, gz: rz, gw: rw, gd: rd },
      allowed: { gx: base - 1, gz: r0, gw: 1, gd: cw },
      doorA: { plane: 'x', at: base, lo: r0, hi: r0 + cw - 1 },
      doorB: { plane: 'x', at: base + len, lo: r0, hi: r0 + cw - 1 },
    };
  }
  return {
    corridor: { gx: src.gx - len, gz: r0, gw: len, gd: cw },
    room: { gx: src.gx - len - rw, gz: rz, gw: rw, gd: rd },
    allowed: { gx: src.gx, gz: r0, gw: 1, gd: cw },
    doorA: { plane: 'x', at: src.gx, lo: r0, hi: r0 + cw - 1 },
    doorB: { plane: 'x', at: src.gx - len, lo: r0, hi: r0 + cw - 1 },
  };
}

// ---------------------------------------------------------------------------
// loops
// ---------------------------------------------------------------------------

// One loop ATTEMPT: pick a far-in-graph / near-in-space room pair and try to
// carve a straight or L corridor through rock. Loops give the flow field a
// second way in, which is what stops corridor camping from trivialising every
// fight — but a failed attempt is fine, the dungeon still works as a tree.
function tryLoop(rooms, doors, corridors, rnd, placeable, carve) {
  const graph = adjacency(rooms.length, doors);
  const pairs = [];
  for (let a = 0; a < rooms.length; a++) {
    const depthsFromA = bfsDepths(graph, a);
    for (let b = a + 1; b < rooms.length; b++) {
      if (depthsFromA[b] >= 0 && depthsFromA[b] < 3) continue;
      const ca = roomCentre(rooms[a]);
      const cb = roomCentre(rooms[b]);
      const eu = Math.hypot(ca.x - cb.x, ca.z - cb.z) * CELL;
      if (eu > 16) continue;
      pairs.push([a, b]);
    }
  }
  if (!pairs.length) return false;
  const pick = pairs[Math.floor(rnd() * pairs.length)];
  const A = rooms[pick[0]];
  const B = rooms[pick[1]];
  const cw = 2;

  for (let tries = 0; tries < 8; tries++) {
    const cand = loopCandidate(A, B, cw, rnd);
    if (!cand) continue;
    if (!placeable(cand.rects, cand.allowed)) continue;
    for (const r of cand.rects) {
      carve(r.gx, r.gz, r.gw, r.gd, -2);
      corridors.push(r);
    }
    doors.push({ ...cand.doorA, roomA: A.id, roomB: B.id });
    doors.push({ ...cand.doorB, roomA: B.id, roomB: A.id });
    return true;
  }
  return false;
}

function loopCandidate(A, B, cw, rnd) {
  // Straight horizontal: row spans overlap and there is rock between.
  const rowLo = Math.max(A.gz, B.gz);
  const rowHi = Math.min(A.gz + A.gd, B.gz + B.gd) - cw;
  if (rowHi >= rowLo) {
    const [L, R] = A.gx < B.gx ? [A, B] : [B, A];
    const gap = R.gx - (L.gx + L.gw);
    if (gap >= 2) {
      const r0 = randint(rnd, rowLo, rowHi);
      const rect = { gx: L.gx + L.gw, gz: r0, gw: gap, gd: cw };
      return {
        rects: [rect],
        allowed: [
          { gx: L.gx + L.gw - 1, gz: r0, gw: 1, gd: cw },
          { gx: R.gx, gz: r0, gw: 1, gd: cw },
        ],
        doorA: aSide(A, L, { plane: 'x', at: L.gx + L.gw, lo: r0, hi: r0 + cw - 1 },
          { plane: 'x', at: R.gx, lo: r0, hi: r0 + cw - 1 }),
        doorB: aSide(B, L, { plane: 'x', at: L.gx + L.gw, lo: r0, hi: r0 + cw - 1 },
          { plane: 'x', at: R.gx, lo: r0, hi: r0 + cw - 1 }),
      };
    }
  }
  // Straight vertical.
  const colLo = Math.max(A.gx, B.gx);
  const colHi = Math.min(A.gx + A.gw, B.gx + B.gw) - cw;
  if (colHi >= colLo) {
    const [T, Bo] = A.gz < B.gz ? [A, B] : [B, A];
    const gap = Bo.gz - (T.gz + T.gd);
    if (gap >= 2) {
      const c0 = randint(rnd, colLo, colHi);
      const rect = { gx: c0, gz: T.gz + T.gd, gw: cw, gd: gap };
      return {
        rects: [rect],
        allowed: [
          { gx: c0, gz: T.gz + T.gd - 1, gw: cw, gd: 1 },
          { gx: c0, gz: Bo.gz, gw: cw, gd: 1 },
        ],
        doorA: aSide(A, T, { plane: 'z', at: T.gz + T.gd, lo: c0, hi: c0 + cw - 1 },
          { plane: 'z', at: Bo.gz, lo: c0, hi: c0 + cw - 1 }),
        doorB: aSide(B, T, { plane: 'z', at: T.gz + T.gd, lo: c0, hi: c0 + cw - 1 },
          { plane: 'z', at: Bo.gz, lo: c0, hi: c0 + cw - 1 }),
      };
    }
  }
  // L: horizontal leg out of A, vertical leg into B.
  const r0 = randint(rnd, A.gz, A.gz + A.gd - cw);
  const c0 = randint(rnd, B.gx, B.gx + B.gw - cw);
  const goEast = c0 >= A.gx + A.gw;
  const goWest = c0 + cw - 1 < A.gx;
  if (!goEast && !goWest) return null;
  const hx0 = goEast ? A.gx + A.gw : c0;
  const hx1 = goEast ? c0 + cw - 1 : A.gx - 1;
  const hRect = { gx: hx0, gz: r0, gw: hx1 - hx0 + 1, gd: cw };
  const bBelow = B.gz >= r0 + cw;
  const bAbove = B.gz + B.gd <= r0;
  if (!bBelow && !bAbove) return null;
  const vz0 = bAbove ? B.gz + B.gd : r0 + cw;
  const vz1 = bAbove ? r0 - 1 : B.gz - 1;
  const rects = [hRect];
  if (vz1 >= vz0) rects.push({ gx: c0, gz: vz0, gw: cw, gd: vz1 - vz0 + 1 });
  return {
    rects,
    allowed: [
      goEast
        ? { gx: A.gx + A.gw - 1, gz: r0, gw: 1, gd: cw }
        : { gx: A.gx, gz: r0, gw: 1, gd: cw },
      bAbove
        ? { gx: c0, gz: B.gz + B.gd - 1, gw: cw, gd: 1 }
        : { gx: c0, gz: B.gz, gw: cw, gd: 1 },
    ],
    doorA: { plane: 'x', at: goEast ? A.gx + A.gw : A.gx, lo: r0, hi: r0 + cw - 1 },
    doorB: { plane: 'z', at: bAbove ? B.gz + B.gd : B.gz, lo: c0, hi: c0 + cw - 1 },
  };
}

// Which of the two straight-corridor door records belongs to room `room`
// (identified by whether it is the low-side room `low`).
function aSide(room, low, lowDoor, highDoor) {
  return room === low ? lowDoor : highDoor;
}

// ---------------------------------------------------------------------------
// boss re-stamp
// ---------------------------------------------------------------------------

// Grow the deepest room toward params.bossSize by annexing rock rows/columns.
// A side refuses to grow when its new cells' 1-cell shell would touch any
// floor that is not this room's own — corridor junctions sit in that shell, so
// connected sides stay put and door geometry never moves. Growth can therefore
// under-deliver on a crowded grid; that is accepted (the arena the fight needs
// is "bigger than a regular room", not "exactly 9x7").
function growRoom(room, size, mask, owner, w, h, at, inBounds, carve) {
  const clearFor = (gx, gz, gw, gd) => {
    for (let z = gz; z < gz + gd; z++) {
      for (let x = gx; x < gx + gw; x++) {
        if (!inBounds(x, z) || mask[at(x, z)]) return false;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
            if (mask[at(nx, nz)] && owner[at(nx, nz)] !== room.id) return false;
          }
        }
      }
    }
    return true;
  };
  // Fixed side order, north (deeper into the dungeon) first.
  const sides = ['n', 'w', 'e', 's'];
  let guard = 32;
  let grew = true;
  while (grew && guard-- > 0 && (room.gw < size.w || room.gd < size.d)) {
    grew = false;
    for (const side of sides) {
      if (side === 'n' && room.gd < size.d && clearFor(room.gx, room.gz - 1, room.gw, 1)) {
        carve(room.gx, room.gz - 1, room.gw, 1, room.id);
        room.gz -= 1; room.gd += 1; grew = true;
      } else if (side === 's' && room.gd < size.d && clearFor(room.gx, room.gz + room.gd, room.gw, 1)) {
        carve(room.gx, room.gz + room.gd, room.gw, 1, room.id);
        room.gd += 1; grew = true;
      } else if (side === 'w' && room.gw < size.w && clearFor(room.gx - 1, room.gz, 1, room.gd)) {
        carve(room.gx - 1, room.gz, 1, room.gd, room.id);
        room.gx -= 1; room.gw += 1; grew = true;
      } else if (side === 'e' && room.gw < size.w && clearFor(room.gx + room.gw, room.gz, 1, room.gd)) {
        carve(room.gx + room.gw, room.gz, 1, room.gd, room.id);
        room.gw += 1; grew = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

function adjacency(n, doors) {
  const adj = Array.from({ length: n }, () => []);
  for (const d of doors) {
    if (d.roomA < 0 || d.roomB < 0) continue;
    if (!adj[d.roomA].includes(d.roomB)) adj[d.roomA].push(d.roomB);
    if (!adj[d.roomB].includes(d.roomA)) adj[d.roomB].push(d.roomA);
  }
  return adj;
}

function bfsDepths(adj, from) {
  const depth = new Array(adj.length).fill(-1);
  depth[from] = 0;
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    for (const nb of adj[cur]) {
      if (depth[nb] >= 0) continue;
      depth[nb] = depth[cur] + 1;
      q.push(nb);
    }
  }
  return depth;
}

function bfsPath(adj, from, to) {
  const parent = new Array(adj.length).fill(-2);
  parent[from] = -1;
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    for (const nb of adj[cur]) {
      if (parent[nb] !== -2) continue;
      parent[nb] = cur;
      q.push(nb);
    }
  }
  if (parent[to] === -2) return [from];
  const path = [];
  for (let cur = to; cur !== -1; cur = parent[cur]) path.push(cur);
  return path.reverse();
}

// ---------------------------------------------------------------------------
// treasure
// ---------------------------------------------------------------------------

// Non-critical-path leaf rooms roll treasure (E: 20% chance of one; D+:
// exactly one, guaranteed). encounterRnd — treasure is an encounter knob and
// must never move a wall. Falls back from leaves to any off-path room so the
// D guarantee survives layouts whose every leaf ended up on the path.
function pickTreasure(rooms, adj, criticalPath, treasure, rnd) {
  const onPath = new Set(criticalPath);
  const eligible = rooms.filter((r) => r.kind === 'combat' && !onPath.has(r.id) && adj[r.id].length === 1);
  const fallback = rooms.filter((r) => r.kind === 'combat' && !onPath.has(r.id));
  const roll = rnd();                       // always consumed: stream stability
  const want = treasure.guaranteed || roll < treasure.chance;
  if (!want) return;
  const pool = eligible.length ? eligible : fallback;
  if (!pool.length) return;
  pool[Math.floor(rnd() * pool.length)].kind = 'treasure';
}

// ---------------------------------------------------------------------------
// wall runs
// ---------------------------------------------------------------------------

// March the floor/rock boundary and merge collinear boundary edges into runs.
// One run = one 0.6 m obstacle box + one merged render slab (STEP 3). Runs are
// centred ON the boundary plane, half in rock. Door openings are floor on both
// sides, so runs split there without any special casing.
function buildWallRuns(mask, w, h, at, originX, originZ) {
  const runs = [];
  // face 's': floor cell with rock to its +Z. Segments grouped per plane row.
  const scan = (face) => {
    const horizontal = face === 'n' || face === 's';
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    for (let o = 0; o < outer; o++) {
      let start = -1;
      for (let i = 0; i <= inner; i++) {
        const gx = horizontal ? i : o;
        const gz = horizontal ? o : i;
        let boundary = false;
        if (i < inner && mask[at(gx, gz)]) {
          const nx = gx + (face === 'e' ? 1 : face === 'w' ? -1 : 0);
          const nz = gz + (face === 's' ? 1 : face === 'n' ? -1 : 0);
          boundary = nx < 0 || nz < 0 || nx >= w || nz >= h || !mask[at(nx, nz)];
        }
        if (boundary && start < 0) start = i;
        if (!boundary && start >= 0) {
          runs.push(makeRun(face, o, start, i - 1, originX, originZ));
          start = -1;
        }
      }
    }
  };
  scan('n'); scan('s'); scan('e'); scan('w');
  return runs;
}

function makeRun(face, lane, lo, hi, originX, originZ) {
  const len = (hi - lo + 1) * CELL;
  const mid = (lo + hi + 1) / 2;
  if (face === 'n' || face === 's') {
    const plane = face === 's' ? lane + 1 : lane;
    return {
      x: originX + mid * CELL,
      z: originZ + plane * CELL,
      w: len,
      d: WALL_THICKNESS,
      rot: 0,
      face,
    };
  }
  const plane = face === 'e' ? lane + 1 : lane;
  return {
    x: originX + plane * CELL,
    z: originZ + mid * CELL,
    w: WALL_THICKNESS,
    d: len,
    rot: 0,
    face,
  };
}

// ---------------------------------------------------------------------------
// spawn points
// ---------------------------------------------------------------------------

// Jittered cell centres whose full 8-neighbourhood is floor — that keeps every
// point >= ~2 m clear of any wall run even after jitter (spec: >= 1.5 m), so a
// rise-from-floor spawn can never clip a wall. Greedy 2.4 m spacing.
function spawnPointsFor(room, mask, w, h, at, originX, originZ, rnd) {
  const pts = [];
  for (let gz = room.gz; gz < room.gz + room.gd; gz++) {
    for (let gx = room.gx; gx < room.gx + room.gw; gx++) {
      let open = true;
      for (let dz = -1; dz <= 1 && open; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h || !mask[at(nx, nz)]) { open = false; break; }
        }
      }
      if (!open) continue;
      pts.push({
        x: originX + (gx + 0.5) * CELL + (rnd() - 0.5),
        z: originZ + (gz + 0.5) * CELL + (rnd() - 0.5),
      });
    }
  }
  const kept = [];
  for (const p of pts) {
    let clear = true;
    for (const k of kept) {
      if ((p.x - k.x) ** 2 + (p.z - k.z) ** 2 < 2.4 * 2.4) { clear = false; break; }
    }
    if (clear) kept.push({ x: p.x, z: p.z });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

// gate.enemies split over combat rooms proportional to area (min 2 each),
// remainder to the last pre-boss room, exact-sum guaranteed — the HUD counter
// and _clearGate both trust spawned totals, so this cannot be off by one.
function assignBudgets(rooms, criticalPath, enemies) {
  const combat = rooms.filter((r) => r.kind === 'combat');
  if (!combat.length || !(enemies > 0)) return;
  let lastPreBoss = combat[combat.length - 1];
  for (let i = criticalPath.length - 2; i >= 0; i--) {
    const r = rooms[criticalPath[i]];
    if (r.kind === 'combat') { lastPreBoss = r; break; }
  }
  const min = Math.max(1, Math.min(2, Math.floor(enemies / combat.length)));
  let left = enemies - min * combat.length;
  for (const r of combat) r.budget = min;
  if (left > 0) {
    const totalArea = combat.reduce((s, r) => s + r.w * r.d, 0);
    const shares = combat.map((r) => (left * r.w * r.d) / totalArea);
    const floors = shares.map(Math.floor);
    let used = floors.reduce((s, f) => s + f, 0);
    combat.forEach((r, i) => { r.budget += floors[i]; });
    // Largest-remainder for the fractional leftovers, ties to earlier rooms.
    const order = shares
      .map((s, i) => [s - floors[i], i])
      .sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
    for (let k = 0; used < left; k++, used++) combat[order[k][1]].budget += 1;
  } else if (left < 0) {
    // More rooms than 2-per allows: shave the shortfall off the last pre-boss
    // room's floor-mates, never below 1.
    let need = -left;
    for (let i = combat.length - 1; i >= 0 && need > 0; i--) {
      const take = Math.min(need, combat[i].budget - 1);
      combat[i].budget -= take;
      need -= take;
    }
  }
  // Exact-sum backstop: any residue (all-shaved case) lands on lastPreBoss.
  const sum = combat.reduce((s, r) => s + r.budget, 0);
  if (sum !== enemies) lastPreBoss.budget += enemies - sum;
}

// ---------------------------------------------------------------------------
// decor anchors — decorRnd ONLY, so retuning dressing can never reshuffle
// rooms. Yaw is THREE rotation.y: forward(yaw) = (-sin yaw, 0, -cos yaw), so
// yaw 0 faces -Z. A torch on a face-'s' run has its floor to the north and
// faces yaw 0.
// ---------------------------------------------------------------------------

const FACE_YAW = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 };
const PROP_KINDS = ['pot', 'crate', 'barrel'];

function buildDecor(rooms, doors, wallRuns, params, rnd) {
  const torches = [];
  const columns = [];
  const props = [];
  const alcoves = [];

  // Torch sconces: along every wall run, one per ~torchSpacing metres, phase
  // jittered per run so parallel corridor walls alternate instead of pairing.
  for (const run of wallRuns) {
    const len = Math.max(run.w, run.d);
    if (len < params.torchSpacing * 0.7) continue;
    const yaw = FACE_YAW[run.face];
    const along = run.w > run.d ? 'x' : 'z';
    let s = params.torchSpacing * (0.3 + rnd() * 0.4);
    for (; s < len; s += params.torchSpacing) {
      const t = s - len / 2;
      torches.push({
        x: run.x + (along === 'x' ? t : 0),
        z: run.z + (along === 'z' ? t : 0),
        yaw,
      });
    }
  }

  // Columns: room corners (1 m inset), plus one beside every 3rd door.
  for (const r of rooms) {
    if (r.kind === 'entry') continue;
    const inset = 1.0;
    const cs = [
      { x: r.x + inset, z: r.z + inset },
      { x: r.x + r.w - inset, z: r.z + inset },
      { x: r.x + inset, z: r.z + r.d - inset },
      { x: r.x + r.w - inset, z: r.z + r.d - inset },
    ];
    for (const c of cs) if (rnd() < 0.8) columns.push(c);
  }
  doors.forEach((d, i) => {
    if (i % 3 !== 2) return;
    const side = rnd() < 0.5 ? -1 : 1;
    columns.push(d.rot === 0
      ? { x: d.x + side * (d.w / 2 + 0.6), z: d.z }
      : { x: d.x, z: d.z + side * (d.w / 2 + 0.6) });
  });

  // Prop clusters near room corners; density per rank. Treasure rooms get the
  // statue + candles shrine at their centre instead of clutter.
  const clusterChance = params.propDensity === 'medium' ? 0.7 : 0.4;
  for (const r of rooms) {
    if (r.kind === 'treasure') {
      props.push({ x: r.centre.x, z: r.centre.z, yaw: rnd() * Math.PI * 2, kind: 'statue' });
      props.push({ x: r.centre.x + 0.9, z: r.centre.z + 0.4, yaw: 0, kind: 'candles' });
      props.push({ x: r.centre.x - 0.8, z: r.centre.z + 0.6, yaw: 0, kind: 'candles' });
      continue;
    }
    if (r.kind === 'entry' || rnd() >= clusterChance) continue;
    const cx = r.x + (rnd() < 0.5 ? 1.6 : r.w - 1.6);
    const cz = r.z + (rnd() < 0.5 ? 1.6 : r.d - 1.6);
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      props.push({
        x: cx + (rnd() - 0.5) * 1.6,
        z: cz + (rnd() - 0.5) * 1.6,
        yaw: rnd() * Math.PI * 2,
        kind: PROP_KINDS[Math.floor(rnd() * PROP_KINDS.length)],
      });
    }
  }

  // Alcoves (D+): midpoints of long room walls.
  if (params.alcoves) {
    for (const r of rooms) {
      if (r.kind === 'entry') continue;
      if (r.w >= 10 && rnd() < 0.6) {
        alcoves.push({ x: r.centre.x, z: r.z, yaw: Math.PI });
      }
      if (r.d >= 10 && rnd() < 0.6) {
        alcoves.push({ x: r.x, z: r.centre.z, yaw: -Math.PI / 2 });
      }
    }
  }

  // crystals/stalagmites are the cavern kind's slots — empty here so every
  // consumer sees one decor shape regardless of kind.
  return { torches, columns, props, alcoves, crystals: [], stalagmites: [] };
}

// ---------------------------------------------------------------------------
// cavern kind — DUNGEON_SPEC STEP 8 (C rank)
// ---------------------------------------------------------------------------
// One huge organic chamber instead of rooms-and-corridors: the floor mask is a
// union of random-walked discs plus attached side grottos, entered through the
// same +Z tunnel, with the boss grotto held OFF the mass behind a rock band
// and reattached by a single 2-cell neck — the one place a membrane arch can
// seal it (spec generation.cavernVariant). Encounter ZONES replace rooms: disc
// trigger records in the same rooms[] slot (kind/centre/spawnPoints/budget,
// plus `radius` — Dungeon.roomAt tests discs when radius is present), with NO
// doors on combat zones, so the director's seal machinery no-ops and packs
// aggro in the open. Downstream consumers (wall runs, budgets, translation,
// bounds) are byte-for-byte the crawl's own helpers.

const CARDINALS = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
};

function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function tryGenerateCavern(rank, params, enemies, seed) {
  const layoutRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const decorRnd = mulberry32((seed ^ 0x5f356495) >>> 0);

  const w = params.grid;
  const h = params.grid;
  const mask = new Uint8Array(w * h);
  const at = (gx, gz) => gx + gz * w;
  const isFloor = (gx, gz) => gx >= 0 && gz >= 0 && gx < w && gz < h && mask[at(gx, gz)] === 1;

  // Disc carve/probe in CELL units; centres are floats, cells claim by centre.
  const carveDisc = (cx, cz, rc) => {
    const x0 = Math.max(1, Math.floor(cx - rc));
    const x1 = Math.min(w - 2, Math.ceil(cx + rc));
    const z0 = Math.max(1, Math.floor(cz - rc));
    const z1 = Math.min(h - 2, Math.ceil(cz + rc));
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx + 0.5 - cx;
        const dz = gz + 0.5 - cz;
        if (dx * dx + dz * dz <= rc * rc) mask[at(gx, gz)] = 1;
      }
    }
  };
  const discClear = (cx, cz, rc) => {
    const x0 = Math.floor(cx - rc);
    const x1 = Math.ceil(cx + rc);
    const z0 = Math.floor(cz - rc);
    const z1 = Math.ceil(cz + rc);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx + 0.5 - cx;
        const dz = gz + 0.5 - cz;
        if (dx * dx + dz * dz > rc * rc) continue;
        if (gx < 1 || gz < 1 || gx > w - 2 || gz > h - 2) return false;
        if (mask[at(gx, gz)]) return false;
      }
    }
    return true;
  };

  // --- entry tunnel from +Z (3 cells wide) ---------------------------------
  const tw = params.tunnelWidth;
  const tunnelLen = randint(layoutRnd, params.tunnelLen[0], params.tunnelLen[1]);
  const tx0 = Math.floor((w - tw) / 2);
  const southPlaneRow = h - 1;                     // 1-row rock border kept
  const tunnelTop = southPlaneRow - tunnelLen;     // rows tunnelTop..h-2
  for (let gz = tunnelTop; gz < southPlaneRow; gz++) {
    for (let gx = tx0; gx < tx0 + tw; gx++) mask[at(gx, gz)] = 1;
  }
  const tunnelCX = tx0 + tw / 2;

  // --- disc-union random walk, -Z bias -------------------------------------
  // Each disc centre is derived from the previous with a step short enough to
  // guarantee overlap (union stays connected); the first disc swallows the
  // tunnel head so the tunnel opens INTO the cavern, never beside it.
  const discs = [];
  const nDiscs = randint(layoutRnd, params.discs[0], params.discs[1]);
  let px = tunnelCX;
  let pz = tunnelTop;
  for (let i = 0; i < nDiscs; i++) {
    const rc = (params.discR[0] + layoutRnd() * (params.discR[1] - params.discR[0])) / CELL;
    if (i === 0) pz = tunnelTop - Math.max(1, rc * 0.55);
    let cx = clampNum(px, rc + 2, w - 2 - rc);
    let cz = clampNum(pz, rc + 2, h - 2 - rc);
    if (discs.length) {
      // Bounds clamping can stretch the step past the overlap guarantee —
      // pull the disc back toward its parent until they overlap by 1.5 cells.
      const prev = discs[discs.length - 1];
      const dx = cx - prev.cx;
      const dz = cz - prev.cz;
      const dist = Math.hypot(dx, dz) || 1;
      const maxD = prev.rc + rc - 1.5;
      if (dist > maxD) {
        cx = prev.cx + (dx / dist) * maxD;
        cz = prev.cz + (dz / dist) * maxD;
      }
    }
    carveDisc(cx, cz, rc);
    discs.push({ cx, cz, rc });
    const ang = layoutRnd() * Math.PI * 2;
    const step = rc * (0.8 + layoutRnd() * 0.5);
    px = cx + Math.cos(ang) * step;
    // |sin| keeps the lateral roll from cancelling the drift: the walk always
    // moves toward -Z (into the screen), the spec's growth direction.
    pz = cz - Math.abs(Math.sin(ang)) * step * 0.9 - rc * 0.25;
  }

  // --- attached side grottos ------------------------------------------------
  for (let k = 0; k < params.grottos; k++) {
    const base = discs[Math.floor(layoutRnd() * discs.length)];
    const rgc = (params.grottoR[0] + layoutRnd() * (params.grottoR[1] - params.grottoR[0])) / CELL;
    const ang = layoutRnd() * Math.PI * 2;
    // Offset < base.rc + rgc: the grotto always overlaps its base disc, so
    // attachment survives even when the bounds clamp nudges it.
    let gx = base.cx + Math.cos(ang) * (base.rc + rgc * 0.4);
    let gz = base.cz + Math.sin(ang) * (base.rc + rgc * 0.4);
    gx = clampNum(gx, rgc + 2, w - 2 - rgc);
    gz = clampNum(gz, rgc + 2, h - 2 - rgc);
    carveDisc(gx, gz, rgc);
  }

  // --- boss grotto: off the mass, one sealable neck -------------------------
  const bossRc = (params.bossR[0] + layoutRnd() * (params.bossR[1] - params.bossR[0])) / CELL;
  const gap = randint(layoutRnd, params.neckGap[0], params.neckGap[1]);
  // Anchor candidates: every walk disc, deepest (farthest from the tunnel
  // head) first, each trying cardinals ordered by how far they point from the
  // mass centroid — so the grotto prefers the deep rim but a cramped roll can
  // still land it off a shallower lobe instead of failing the whole attempt.
  let mx = 0;
  let mz = 0;
  for (const d of discs) { mx += d.cx; mz += d.cz; }
  mx /= discs.length; mz /= discs.length;
  const anchors = discs.slice().sort((a, b) => (
    Math.hypot(b.cx - tunnelCX, b.cz - tunnelTop) - Math.hypot(a.cx - tunnelCX, a.cz - tunnelTop)
  ));
  let neck = null;
  for (const anchor of anchors) {
    const away = { x: anchor.cx - mx, z: anchor.cz - mz };
    const dirOrder = Object.keys(CARDINALS).sort((a, b) => {
      const [ax, az] = CARDINALS[a];
      const [bx, bz] = CARDINALS[b];
      return (bx * away.x + bz * away.z) - (ax * away.x + az * away.z);
    });
    for (const dir of dirOrder) {
      const [sx, sz] = CARDINALS[dir];
      // March from the anchor centre to the mass boundary along this cardinal.
      let bx = Math.round(anchor.cx);
      let bz = Math.round(anchor.cz);
      if (!isFloor(bx, bz)) continue;
      while (isFloor(bx + sx, bz + sz)) { bx += sx; bz += sz; }
      // Centre one cell PAST band + radius so the anchor's own boundary cell
      // sits strictly outside the clearance probe — at exactly gap + bossRc
      // the probe rim grazes the mass and every cardinal fails on a curved
      // boundary (the bug class: 14/60 seeds with no legal grotto).
      const ccx = bx + 0.5 + sx * (gap + bossRc + 1);
      const ccz = bz + 0.5 + sz * (gap + bossRc + 1);
      if (ccx < bossRc + 2 || ccx > w - 2 - bossRc
        || ccz < bossRc + 2 || ccz > h - 2 - bossRc) continue;
      // The grotto disc plus a gap-wide shell must sit in clean rock: that
      // band is what makes the neck the ONLY way in.
      if (!discClear(ccx, ccz, bossRc + gap)) continue;
      neck = { dir, sx, sz, bx, bz, ccx, ccz };
      break;
    }
    if (neck) break;
  }
  if (!neck) return { depth: -1 };   // cramped roll — regen from seed+1
  carveDisc(neck.ccx, neck.ccz, bossRc);
  // Neck corridor: 2 cells wide along the cardinal, from the mass boundary
  // cell through the band into the grotto. Lane pair is centred on the march
  // line (bx or bz), so the door span always meets floor on both sides.
  const neckRect = neck.sx === 0
    ? { gx: neck.bx, gz: Math.min(neck.bz, Math.round(neck.ccz)), gw: 2, gd: Math.abs(Math.round(neck.ccz) - neck.bz) + 1 }
    : { gx: Math.min(neck.bx, Math.round(neck.ccx)), gz: neck.bz, gw: Math.abs(Math.round(neck.ccx) - neck.bx) + 1, gd: 2 };
  for (let gz = neckRect.gz; gz < neckRect.gz + neckRect.gd; gz++) {
    for (let gx = neckRect.gx; gx < neckRect.gx + neckRect.gw; gx++) {
      if (gx >= 1 && gz >= 1 && gx <= w - 2 && gz <= h - 2) mask[at(gx, gz)] = 1;
    }
  }
  // Membrane plane at the mass-side junction: the face of the boundary cell
  // that looks down the neck. Same door-record grammar as the crawl.
  const bossDoorRec = neck.sx === 0
    ? { plane: 'z', at: neck.sz < 0 ? neck.bz : neck.bz + 1, lo: neckRect.gx, hi: neckRect.gx + 1 }
    : { plane: 'x', at: neck.sx < 0 ? neck.bx : neck.bx + 1, lo: neckRect.gz, hi: neckRect.gz + 1 };

  // --- smoothing pass -------------------------------------------------------
  // One pass over a snapshot: lone floor nubs (<= 1 cardinal floor neighbour)
  // become rock, single-cell rock inlets (>= 3 floor neighbours) become floor
  // — this is what keeps the disc boundaries mergeable into sane wall runs.
  // The band around the boss grotto is >= 2 cells (discClear above), so no
  // band cell can reach 3 floor neighbours and the seal survives smoothing.
  {
    const snap = mask.slice();
    const f = (gx, gz) => (gx >= 0 && gz >= 0 && gx < w && gz < h && snap[gx + gz * w] === 1 ? 1 : 0);
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const n4 = f(gx - 1, gz) + f(gx + 1, gz) + f(gx, gz - 1) + f(gx, gz + 1);
        if (snap[at(gx, gz)]) {
          if (n4 <= 1) mask[at(gx, gz)] = 0;
        } else if (n4 >= 3) mask[at(gx, gz)] = 1;
      }
    }
  }

  // --- reachability sweep ---------------------------------------------------
  // BFS from the spawn cell; any floor the flood cannot reach (a clamped disc
  // that detached) is filled back to rock so wall runs and nav never see it.
  const spawnCell = at(tx0 + Math.floor(tw / 2), southPlaneRow - 1);
  const bfs = new Int32Array(w * h).fill(-1);
  {
    const q = [spawnCell];
    bfs[spawnCell] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cgx = cur % w;
      const cgz = (cur / w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cgx + dx;
        const nz = cgz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = at(nx, nz);
        if (!mask[ni] || bfs[ni] >= 0) continue;
        bfs[ni] = bfs[cur] + 1;
        q.push(ni);
      }
    }
    for (let i = 0; i < w * h; i++) if (mask[i] && bfs[i] < 0) mask[i] = 0;
  }
  const bossCentreCell = at(Math.round(neck.ccx - 0.5), Math.round(neck.ccz - 0.5));
  if (bfs[bossCentreCell] < 0) return { depth: -1 };   // neck got severed

  // --- zone selection along the BFS-farthest chain --------------------------
  const nz = randint(layoutRnd, params.rooms[0], params.rooms[1]);
  const zoneRc = params.zoneRadius / CELL;
  const entryRc = Math.min(discs[0].rc, 4.5);
  const entryC = { cx: discs[0].cx, cz: discs[0].cz };
  // Interior candidates: full 5x5 floor neighbourhood (2 cells clear of rock,
  // so the 9 m trigger disc and its spawn points have real floor around them),
  // outside the boss grotto, the neck, and the entry chamber.
  const open2 = (gx, gz) => {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!isFloor(gx + dx, gz + dz)) return false;
      }
    }
    return true;
  };
  const inNeck = (gx, gz) => gx >= neckRect.gx - 1 && gx < neckRect.gx + neckRect.gw + 1
    && gz >= neckRect.gz - 1 && gz < neckRect.gz + neckRect.gd + 1;
  const candidates = [];
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      const i = at(gx, gz);
      if (!mask[i] || bfs[i] < 0) continue;
      if (!open2(gx, gz)) continue;
      if (inNeck(gx, gz)) continue;
      const cx = gx + 0.5;
      const cz = gz + 0.5;
      if (Math.hypot(cx - neck.ccx, cz - neck.ccz) < bossRc + zoneRc * 0.5) continue;
      if (Math.hypot(cx - entryC.cx, cz - entryC.cz) < entryRc + zoneRc * 0.6) continue;
      candidates.push({ gx, gz, d: bfs[i] });
    }
  }
  candidates.sort((a, b) => a.d - b.d || (a.gx + a.gz * w) - (b.gx + b.gz * w));
  // Spread the zones over the WHOLE BFS depth range (the "BFS-farthest chain"):
  // evenly spaced depth targets, each filled by the spacing-respecting
  // candidate nearest its target — a plain greedy would cluster every zone at
  // the shallow end and leave the deep half of the cavern empty.
  const maxD = candidates.length ? candidates[candidates.length - 1].d : 0;
  let zones = [];
  for (let relax = 0; relax < 3 && zones.length < params.rooms[0]; relax++) {
    const spacing = (params.zoneSpacing / CELL) * (1 - relax * 0.25);
    zones = [];
    for (let k = 1; k <= nz; k++) {
      const target = (maxD * k) / (nz + 0.35);   // last target short of the tip
      let best = null;
      let bestScore = Infinity;
      for (const c of candidates) {
        let clear = true;
        for (const zn of zones) {
          if (Math.hypot(c.gx - zn.gx, c.gz - zn.gz) < spacing) { clear = false; break; }
        }
        if (!clear) continue;
        const score = Math.abs(c.d - target);
        if (score < bestScore) { bestScore = score; best = c; }
      }
      if (best) zones.push(best);
    }
    zones.sort((a, b) => a.d - b.d || (a.gx + a.gz * w) - (b.gx + b.gz * w));
  }
  if (zones.length < params.rooms[0]) return { depth: -1 };

  // --- world translation (same maths as the crawl) --------------------------
  const southPlane = southPlaneRow * CELL;
  const originX = -tunnelCX * CELL;
  const originZ = -(southPlane - 1.6);
  const toX = (cx) => originX + cx * CELL;
  const toZ = (cz) => originZ + cz * CELL;

  // --- rooms: entry + zones + boss, all discs -------------------------------
  const outRooms = [];
  const pushDiscRoom = (kind, cx, cz, radiusM) => {
    const id = outRooms.length;
    outRooms.push({
      id,
      kind,
      radius: radiusM,
      x: toX(cx) - radiusM,
      z: toZ(cz) - radiusM,
      w: radiusM * 2,
      d: radiusM * 2,
      centre: { x: toX(cx), z: toZ(cz) },
      doors: [],
      spawnPoints: [],
      budget: 0,
    });
    return id;
  };
  pushDiscRoom('entry', entryC.cx, entryC.cz, entryRc * CELL);
  for (const zn of zones) pushDiscRoom('combat', zn.gx + 0.5, zn.gz + 0.5, params.zoneRadius);
  const bossId = pushDiscRoom('boss', neck.ccx, neck.ccz, bossRc * CELL);

  // --- doors: the entry arch and the boss neck membrane ---------------------
  const doorRecs = [
    { plane: 'z', at: tunnelTop, lo: tx0, hi: tx0 + tw - 1, roomA: 0, roomB: -1 },
    { ...bossDoorRec, roomA: bossId, roomB: -1 },
  ];
  const outDoors = doorRecs.map((d, i) => {
    const span = (d.hi - d.lo + 1) * CELL;
    const mid = originHalf(d.lo, d.hi);
    return d.plane === 'z'
      ? { id: i, x: toX(mid), z: toZ(d.at), w: span, d: DOOR_THICKNESS, rot: 0, roomA: d.roomA, roomB: d.roomB }
      : { id: i, x: toX(d.at), z: toZ(mid), w: span, d: DOOR_THICKNESS, rot: Math.PI / 2, roomA: d.roomA, roomB: d.roomB };
  });
  outRooms[0].doors.push(0);
  outRooms[bossId].doors.push(1);

  const outCorridors = [
    { x: toX(tx0 + tw / 2), z: toZ(tunnelTop + tunnelLen / 2), w: tw * CELL, d: tunnelLen * CELL },
    {
      x: toX(neckRect.gx + neckRect.gw / 2),
      z: toZ(neckRect.gz + neckRect.gd / 2),
      w: neckRect.gw * CELL,
      d: neckRect.gd * CELL,
    },
  ];

  // --- wall runs / spawn points / budgets -----------------------------------
  const wallRuns = buildWallRuns(mask, w, h, at, originX, originZ);
  for (const r of outRooms) {
    r.spawnPoints = discSpawnPoints(r, mask, w, h, at, originX, originZ, layoutRnd);
  }
  const criticalPath = [0, ...outRooms.filter((r) => r.kind === 'combat').map((r) => r.id), bossId];
  assignBudgets(outRooms, criticalPath, enemies);

  const { bounds, radius } = boundsFromMask(mask, w, h, at, originX, originZ);

  // --- decor: crystals + stalagmite field (decorRnd only) -------------------
  const decor = buildCavernDecor(outRooms, outDoors, wallRuns, params, decorRnd, {
    mask, w, h, at, originX, originZ, neckRect, tunnel: { tx0, tw, tunnelTop },
  });

  return {
    kind: 'cavern',
    rank,
    cell: CELL,
    w,
    h,
    originX,
    originZ,
    mask,
    rooms: outRooms,
    doors: outDoors,
    corridors: outCorridors,
    wallRuns,
    decor,
    criticalPath,
    bossRoom: bossId,
    depth: criticalPath.length - 1,
    entry: { x: 0, z: 0, yaw: 0 },
    bounds,
    radius,
    params: {
      wallHeight: params.wallHeight,
      wallHeightLow: params.wallHeightLow,
      torchSpacing: 0,
      fog: params.fog,
    },
  };
}

// Spawn points for a disc room: jittered cell centres inside the trigger disc
// whose full 8-neighbourhood is floor (>= ~2.5 m of wall clearance survives
// the jitter), greedy 2.4 m spacing — the crawl's guarantees, disc-shaped.
function discSpawnPoints(room, mask, w, h, at, originX, originZ, rnd) {
  const ccx = (room.centre.x - originX) / CELL;
  const ccz = (room.centre.z - originZ) / CELL;
  const rc = room.radius / CELL - 0.6;   // keep the jittered point inside
  const pts = [];
  const z0 = Math.max(1, Math.floor(ccz - rc));
  const z1 = Math.min(h - 2, Math.ceil(ccz + rc));
  const x0 = Math.max(1, Math.floor(ccx - rc));
  const x1 = Math.min(w - 2, Math.ceil(ccx + rc));
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      const dx = gx + 0.5 - ccx;
      const dz = gz + 0.5 - ccz;
      if (dx * dx + dz * dz > rc * rc) continue;
      let open = true;
      for (let oz = -1; oz <= 1 && open; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = gx + ox;
          const nz = gz + oz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h || !mask[at(nx, nz)]) { open = false; break; }
        }
      }
      if (!open) continue;
      pts.push({
        x: originX + (gx + 0.5) * CELL + (rnd() - 0.5),
        z: originZ + (gz + 0.5) * CELL + (rnd() - 0.5),
      });
    }
  }
  const kept = [];
  for (const p of pts) {
    let clear = true;
    for (const k of kept) {
      if ((p.x - k.x) ** 2 + (p.z - k.z) ** 2 < 2.4 * 2.4) { clear = false; break; }
    }
    if (clear) kept.push(p);
  }
  return kept;
}

// Cavern decor — decorRnd ONLY, like the crawl's. Crystals are the light-pool
// anchors (torchSpacing is n/a for C); the stalagmite field is the cover the
// zone fights are designed around, with clearing radii keeping every zone
// centre, spawn point and door approach open — cover that seals a spawn point
// is how enemies get stuck inside scenery (spec cavernVariant).
function buildCavernDecor(rooms, doors, wallRuns, params, rnd, ctx) {
  const { mask, w, h, at, originX, originZ, neckRect, tunnel } = ctx;
  const isFloor = (gx, gz) => gx >= 0 && gz >= 0 && gx < w && gz < h && mask[at(gx, gz)] === 1;

  // Crystal clusters along the wall runs (the torch-loop pattern at cavern
  // spacing) — the walls read bioluminescent and the light pool always has an
  // anchor near the player.
  const crystals = [];
  for (const run of wallRuns) {
    const len = Math.max(run.w, run.d);
    if (len < params.crystalSpacing * 0.6) continue;
    const yaw = FACE_YAW[run.face];
    const along = run.w > run.d ? 'x' : 'z';
    let s = params.crystalSpacing * (0.25 + rnd() * 0.5);
    for (; s < len; s += params.crystalSpacing) {
      const t = s - len / 2;
      crystals.push({
        x: run.x + (along === 'x' ? t : 0),
        z: run.z + (along === 'z' ? t : 0),
        yaw,
      });
    }
  }
  // One free-standing cluster near each zone centre, when the roll finds
  // floor: the fight arenas glow from within, not just at the rim.
  for (const r of rooms) {
    if (r.kind !== 'combat') continue;
    const ang = rnd() * Math.PI * 2;
    const cx = r.centre.x + Math.cos(ang) * 3.4;
    const cz = r.centre.z + Math.sin(ang) * 3.4;
    const gx = Math.floor((cx - originX) / CELL);
    const gz = Math.floor((cz - originZ) / CELL);
    let open = true;
    for (let oz = -1; oz <= 1 && open; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!isFloor(gx + ox, gz + oz)) { open = false; break; }
      }
    }
    if (open) crystals.push({ x: cx, z: cz, yaw: rnd() * Math.PI * 2 });
  }

  // Stalagmite field: jittered-grid Poisson over the floor, cleared around
  // zone centres, spawn points, door approaches, the tunnel and the neck.
  const sg = params.stalagmites;
  const stalagmites = [];
  const clearOf = (x, z) => {
    for (const r of rooms) {
      const dd = Math.hypot(x - r.centre.x, z - r.centre.z);
      if (dd < sg.zoneClear) return false;
      for (const p of r.spawnPoints) {
        if (Math.hypot(x - p.x, z - p.z) < sg.spawnClear) return false;
      }
    }
    for (const d of doors) {
      if (Math.hypot(x - d.x, z - d.z) < sg.doorClear) return false;
    }
    return true;
  };
  const step = sg.cellStep;
  for (let gz = 1; gz < h - 1; gz += step) {
    for (let gx = 1; gx < w - 1; gx += step) {
      // Fixed roll count per lattice point regardless of outcome, so the
      // stream never shifts when a clearing rule changes a neighbour.
      const jx = gx + Math.floor(rnd() * step);
      const jz = gz + Math.floor(rnd() * step);
      const keep = rnd() < sg.chance;
      const spire = rnd() < sg.spireChance;
      const ox = (rnd() - 0.5) * 1.4;
      const oz = (rnd() - 0.5) * 1.4;
      const rr = rnd();
      const hr = rnd();
      const yaw = rnd() * Math.PI * 2;
      if (!keep) continue;
      // Full 8-neighbourhood floor keeps every piece >= ~1.5 m off the walls.
      let open = true;
      for (let dz2 = -1; dz2 <= 1 && open; dz2++) {
        for (let dx2 = -1; dx2 <= 1; dx2++) {
          if (!isFloor(jx + dx2, jz + dz2)) { open = false; break; }
        }
      }
      if (!open) continue;
      // Never inside the tunnel or the neck — a spire in a 2-cell corridor is
      // a soft lock.
      if (jx >= tunnel.tx0 - 1 && jx <= tunnel.tx0 + tunnel.tw && jz >= tunnel.tunnelTop - 1) continue;
      if (jx >= neckRect.gx - 1 && jx < neckRect.gx + neckRect.gw + 1
        && jz >= neckRect.gz - 1 && jz < neckRect.gz + neckRect.gd + 1) continue;
      const x = originX + (jx + 0.5) * CELL + ox;
      const z = originZ + (jz + 0.5) * CELL + oz;
      if (!clearOf(x, z)) continue;
      stalagmites.push(spire
        ? { x, z, kind: 'spire', r: 0.35 + rr * 0.3, h: 2.2 + hr * 2.0, yaw }
        : { x, z, kind: 'rubble', r: 0.5 + rr * 0.4, h: 0.5 + hr * 0.4, yaw });
    }
  }

  return { torches: [], columns: [], props: [], alcoves: [], crystals, stalagmites };
}

// ---------------------------------------------------------------------------
// stats — for the gen soak and tuning eyeballs
// ---------------------------------------------------------------------------

export function layoutStats(layout) {
  const kinds = { entry: 0, combat: 0, treasure: 0, boss: 0 };
  let spawnPoints = 0;
  let budgetTotal = 0;
  let meanZ = 0;
  for (const r of layout.rooms) {
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    spawnPoints += r.spawnPoints.length;
    budgetTotal += r.budget;
    meanZ += r.centre.z;
  }
  let floorCells = 0;
  for (let i = 0; i < layout.mask.length; i++) floorCells += layout.mask[i];
  const doorMinWidth = layout.doors.reduce((m, d) => Math.min(m, d.w), Infinity);
  return {
    rank: layout.rank,
    rooms: layout.rooms.length,
    kinds,
    depth: layout.depth,
    criticalPathLen: layout.criticalPath.length,
    floorCells,
    doors: layout.doors.length,
    doorMinWidth,
    wallRuns: layout.wallRuns.length,
    spawnPoints,
    budgetTotal,
    torches: layout.decor.torches.length,
    columns: layout.decor.columns.length,
    props: layout.decor.props.length,
    alcoves: layout.decor.alcoves.length,
    crystals: (layout.decor.crystals || []).length,
    stalagmites: (layout.decor.stalagmites || []).length,
    meanRoomCentreZ: meanZ / layout.rooms.length,
    bounds: layout.bounds,
    radius: layout.radius,
  };
}
