// Crawl kind — the E/D rooms-and-corridors generator (DUNGEON_SPEC generation
// steps 2-11): frontier room walk, loops, full-size boss placement, treasure,
// grid-rect spawn points. Split out of dungeonlayout.js (Wave E prerequisite:
// one file per layout kind) — the shared contract lives in core.js's header
// and EVERY rule there binds this file too: determinism is load-bearing, no
// Math.random / Date.now, everything random reads the forked mulberry32
// streams tryGenerate derives below, THREE-free and Node-importable.
// Consumers import ../dungeonlayout.js (the public facade), never this file.

import { mulberry32 } from '../../core/rng.js';
import {
  CELL, DOOR_THICKNESS, randint, originHalf, boundsFromMask,
  adjacency, bfsDepths, bfsPath, pickTreasure,
  buildWallRuns, assignBudgets, buildDecor, buildCover,
} from './core.js';

// The spec's -Z drift: growth direction weights n/e/w/s.
const DIR_WEIGHTS = [
  ['n', 0.45], ['e', 0.2], ['w', 0.2], ['s', 0.15],
];

function rollDir(rnd) {
  let t = rnd();
  for (const [d, w] of DIR_WEIGHTS) {
    t -= w;
    if (t < 0) return d;
  }
  return 's';
}

// ---------------------------------------------------------------------------
// single attempt
// ---------------------------------------------------------------------------

export function tryGenerate(rank, params, enemies, seed) {
  const layoutRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const decorRnd = mulberry32((seed ^ 0x5f356495) >>> 0);
  const encounterRnd = mulberry32((seed ^ 0x1f123bb5) >>> 0);
  const coverRnd = mulberry32((seed ^ 0x7feb352d) >>> 0);

  const w = params.grid;
  const h = params.grid;
  const mask = new Uint8Array(w * h);         // 0 rock, 1 floor
  // NOTE: there is no per-cell ownership array any more. Its only reader was
  // the boss re-stamp's grow test, and the boss is now placed at full size
  // through the same placeable() pad check every other room uses — which reads
  // the mask alone and is what actually keeps 1 cell of rock between any two
  // floor areas not joined by a registered door.
  const at = (gx, gz) => gx + gz * w;
  const inBounds = (gx, gz) => gx >= 1 && gz >= 1 && gx <= w - 2 && gz <= h - 2;

  const rooms = [];      // { id, gx, gz, gw, gd, kind }
  const corridors = [];  // { gx, gz, gw, gd }
  const doors = [];      // { plane:'x'|'z', at, lo, hi, roomA, roomB }

  function carve(gx, gz, gw, gd) {
    for (let z = gz; z < gz + gd; z++) {
      for (let x = gx; x < gx + gw; x++) mask[at(x, z)] = 1;
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
  // Entry uses its OWN size band (params.entrySize): it is the safe deploy pad
  // the shadow escort lands in, never a fight room, so spending 600 m2 of the
  // packing budget on it would only cost the fighting rooms their space.
  const entrySize = params.entrySize || params.roomSize;
  const egw = randint(layoutRnd, entrySize.w[0], entrySize.w[1]);
  const egd = randint(layoutRnd, entrySize.d[0], entrySize.d[1]);
  const egx = Math.floor((w - egw) / 2) + randint(layoutRnd, -2, 2);
  const egz = h - 1 - tunnelLen - egd;         // bottom row + tunnel + 1 border
  carve(egx, egz, egw, egd);
  rooms.push({ id: 0, gx: egx, gz: egz, gw: egw, gd: egd, kind: 'entry' });

  // Entry tunnel: 2 cells wide, centred on the entry room, running to +Z.
  const tx0 = egx + Math.floor((egw - 2) / 2);
  carve(tx0, egz + egd, 2, tunnelLen);
  corridors.push({ gx: tx0, gz: egz + egd, gw: 2, gd: tunnelLen });
  // Junction door (the membrane the intro seals behind you). roomB -1: the
  // far side is the outside world, not a room.
  doors.push({ plane: 'z', at: egz + egd, lo: tx0, hi: tx0 + 1, roomA: 0, roomB: -1 });

  // --- step 3: frontier room walk ------------------------------------------
  // The boss chamber is NO LONGER one of these: it gets its own placement pass
  // at full size below, because growing a regular room toward bossSize
  // under-delivered on a crowded grid and the boss arena is the one room the
  // 5-dash rule cannot be allowed to miss.
  const targetRooms = randint(layoutRnd, params.rooms[0], params.rooms[1]);
  const regular = targetRooms;
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
      carve(cand.room.gx, cand.room.gz, cand.room.gw, cand.room.gd);
      carve(cand.corridor.gx, cand.corridor.gz, cand.corridor.gw, cand.corridor.gd);
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
  if (placed < params.rooms[0]) return { depth: -1 };

  // --- step 4: loops --------------------------------------------------------
  for (let li = 0; li < params.loops; li++) {
    tryLoop(rooms, doors, corridors, layoutRnd, placeable, carve);
  }

  // --- step 5: boss chamber, placed at FULL size off the deepest room -------
  // Order candidate anchors deepest-first (ties broken by distance from the
  // entry, then id, so the order is a pure function of the layout). The boss
  // hangs off the first anchor that has bossSize-worth of clean rock beside
  // it, which keeps it a sealed leaf one door deep from the run's far end.
  // No anchor works -> depth -1 -> generateLayout regenerates from seed+1,
  // and a full-size arena is worth a regeneration.
  const preGraph = adjacency(rooms.length, doors);
  const preDepths = bfsDepths(preGraph, 0);
  const entryC = roomCentre(rooms[0]);
  const anchors = rooms.filter((r) => r.id !== 0).sort((a, b) => {
    if (preDepths[b.id] !== preDepths[a.id]) return preDepths[b.id] - preDepths[a.id];
    const ca = roomCentre(a);
    const cb = roomCentre(b);
    const da = (ca.x - entryC.x) ** 2 + (ca.z - entryC.z) ** 2;
    const db = (cb.x - entryC.x) ** 2 + (cb.z - entryC.z) ** 2;
    return (db - da) || (a.id - b.id);
  });
  let boss = -1;
  for (const src of anchors) {
    for (let tries = 0; tries < 20 && boss < 0; tries++) {
      const dir = rollDir(layoutRnd);
      const cw = params.corridorWidths[
        Math.floor(layoutRnd() * params.corridorWidths.length)];
      const len = randint(layoutRnd, params.corridorLen[0], params.corridorLen[1]);
      const cand = corridorAndRoom(src, dir, cw, len,
        params.bossSize.w, params.bossSize.d, layoutRnd);
      if (!cand) continue;
      if (!placeable([cand.corridor, cand.room], [cand.allowed])) continue;
      const id = rooms.length;
      carve(cand.room.gx, cand.room.gz, cand.room.gw, cand.room.gd);
      carve(cand.corridor.gx, cand.corridor.gz, cand.corridor.gw, cand.corridor.gd);
      rooms.push({ id, gx: cand.room.gx, gz: cand.room.gz, gw: cand.room.gw, gd: cand.room.gd, kind: 'boss' });
      corridors.push(cand.corridor);
      doors.push({ ...cand.doorA, roomA: src.id, roomB: id });
      doors.push({ ...cand.doorB, roomA: id, roomB: src.id });
      boss = id;
    }
    if (boss >= 0) break;
  }
  if (boss < 0) return { depth: -1 };

  // --- step 6/8: classification + critical path -----------------------------
  const graph = adjacency(rooms.length, doors);
  const depths = bfsDepths(graph, 0);
  const bossDepth = depths[boss];
  if (!(bossDepth > 0)) return { depth: -1 };
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
  // --- step 11: interior cover (coverRnd only) ------------------------------
  // Runs after spawn points exist (step 9) because the placer has to keep them
  // clear, and on its own stream so cover tuning cannot move a torch. Takes
  // wallRuns and decor (columns/props/alcove furniture) so its connectivity
  // guarantee (see CONNECTIVITY GUARANTEE above buildCover) can check cover
  // against the REAL combined obstacle picture, not just itself.
  decor.cover = buildCover(outRooms, outDoors, wallRuns, decor, params, coverRnd, boss);

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

function roomCentre(r) {
  return { x: r.gx + r.gw / 2, z: r.gz + r.gd / 2 };
}

// ---------------------------------------------------------------------------
// frontier corridor + room candidate geometry
// ---------------------------------------------------------------------------

// Exported for the tower kind (layouts/tower.js): a ramp between two floors is
// EXACTLY this candidate geometry — a corridor rect + a room rect + two door
// records — with a longer corridor and a height gradient stamped over it.
// Pure function of its arguments (no module state), so sharing it cannot
// entangle the two kinds' streams.
export function corridorAndRoom(src, dir, cw, len, rw, rd, rnd) {
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
      carve(r.gx, r.gz, r.gw, r.gd);
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
// spawn points
// ---------------------------------------------------------------------------

// Jittered cell centres whose full 8-neighbourhood is floor — that keeps every
// point >= ~2 m clear of any wall run even after jitter (spec: >= 1.5 m), so a
// rise-from-floor spawn can never clip a wall. Greedy 2.4 m spacing.
// Exported for the tower kind, whose rooms are the same stamped rects; the
// tower stamps each point's floor height on top and adds one extra prune
// (points near its parapet-gap shoulders) after its wall runs exist.
export function spawnPointsFor(room, mask, w, h, at, originX, originZ, rnd) {
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
