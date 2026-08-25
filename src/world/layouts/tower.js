// Tower kind — Wave E task E-B, THE ASCENT (B rank): a terraced vertical
// crawl. 4-6 stacked floors, each a small cluster of crawl-vocabulary rooms,
// climb-connected by RAMP corridors — the heightAt()=0 contract finally breaks
// here. Split per the Wave E generator law: one file per layout kind, shared
// plumbing in core.js, dispatch in core.js generateLayout. The shared contract
// in core.js's header binds this file in full: DETERMINISM IS LOAD-BEARING,
// no Math.random / Date.now, forked mulberry32 streams only, THREE-free and
// Node-importable. Consumers import ../dungeonlayout.js, never this file.
//
// THE SHAPE. The tower is TERRACED, not stacked-in-plan: every floor's room
// cluster occupies its own region of the one 2 m grid, at floorIndex *
// floorRise metres of elevation, and the single mask / 2D ObstacleField / 2D
// NavGrid contracts every consumer already holds stay true. What makes it a
// tower is the height function: rooms and flat corridors are PLATEAUS, ramp
// corridors are STAIRCASES of per-cell treads (each tread a flat 2 m step of
// rise/(len+1) <= the body's 0.4 m stepHeight, so CharacterBody climbs them
// through its ordinary step-up and descends through its downhill snap — no
// slope maths, no heightfield bake). heightAt is ANALYTIC over layout data:
// a per-cell marker table (Uint8Array, serialized with the layout) decodes to
// floorIndex * floorRise for plateaus and to the tread formula for ramps;
// rock cells carry a dilated copy of their nearest floor's marker so the
// body's finite-difference ground-normal sampling never reads a cliff where
// it is standing next to a wall.
//
// PARAPET GAPS (traversal danger). Where an upper room ended up one rock cell
// from strictly lower floor, that rock lip may be carved open: a 2-3 cell
// notch in the wall with NO wall run and NO door — walk (or get knocked) off
// it and you drop to the floor below, eating fall damage scaled by the drop
// (dungeonmode.js reads params.fallDamage; the body solver already handles
// the drop itself). The drop is one-way by height: dungeon.js registers a
// thin 'ledge' obstacle box on the gap plane whose top IS the upper floor —
// a body on the lip walks over it (top <= feet + stepOver), a body below is
// walled out. Every gap lands on floor INSIDE the layout by construction,
// and tools/dungeon-gen-test.mjs asserts it per gap, zero tolerance.
//
// STREAMS. layoutRnd / decorRnd / encounterRnd / coverRnd are the standard
// four forks. parapetRnd is a FIFTH fork (0x94d049bb — murmur3 finaliser
// family, collides with none in use: see config.js rollWaveSize's constant
// note): gaps CARVE THE MASK, so they are structure, but they are tuned
// independently of the room walk — a gap-chance retune must not reshuffle a
// single room, and the gap pass runs after all placement so the reverse holds
// by ordering. Every candidate run consumes a FIXED three rolls (keep, span,
// offset) whether or not it carves — the cavern stalagmite loop's rule.

import { mulberry32 } from '../../core/rng.js';
import {
  CELL, DOOR_THICKNESS, randint, originHalf, boundsFromMask,
  adjacency, bfsDepths, bfsPath, pickTreasure,
  buildWallRuns, assignBudgets, buildDecor, buildCover,
} from './core.js';
import { corridorAndRoom, spawnPointsFor } from './crawl.js';

// The tower's own drift weights: more lateral wander than the crawl's, so the
// floor chain FOLDS across the grid instead of marching off the -Z edge — a
// straight-line 6-floor chain is ~170 cells and no grid pays for that. Net
// drift stays -Z (n 0.40 vs s 0.16), which keeps the crawl's "grows away from
// the camera" read and the soak's meanZ < 0 assert.
const TOWER_DIR_WEIGHTS = [
  ['n', 0.40], ['e', 0.22], ['w', 0.22], ['s', 0.16],
];

function rollDir(rnd) {
  let t = rnd();
  for (const [d, w] of TOWER_DIR_WEIGHTS) {
    t -= w;
    if (t < 0) return d;
  }
  return 's';
}

// cellF marker grammar (Uint8Array): 0..F-1 plateau floor index, RAMP_BASE+k
// = ramp k's staircase, ROCK = unassigned (only before dilation fills it).
const RAMP_BASE = 100;
const ROCK = 255;

export function tryGenerateTower(rank, params, enemies, seed) {
  const layoutRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const decorRnd = mulberry32((seed ^ 0x5f356495) >>> 0);
  const encounterRnd = mulberry32((seed ^ 0x1f123bb5) >>> 0);
  const coverRnd = mulberry32((seed ^ 0x7feb352d) >>> 0);
  const parapetRnd = mulberry32((seed ^ 0x94d049bb) >>> 0);

  const w = params.grid;
  const h = params.grid;
  const rise = params.floorRise;
  const mask = new Uint8Array(w * h);
  const cellF = new Uint8Array(w * h).fill(ROCK);
  const at = (gx, gz) => gx + gz * w;
  const inBounds = (gx, gz) => gx >= 1 && gz >= 1 && gx <= w - 2 && gz <= h - 2;

  const rooms = [];       // { id, gx, gz, gw, gd, kind, floor }
  const corridors = [];   // { gx, gz, gw, gd, ramp? }
  const doors = [];       // crawl grammar: { plane, at, lo, hi, roomA, roomB }
  const ramps = [];       // { gx, gz, gw, gd, axis:'x'|'z', dir:+1|-1, y0, len }

  const stampF = (gx, gz, gw, gd, code) => {
    for (let z = gz; z < gz + gd; z++) {
      for (let x = gx; x < gx + gw; x++) cellF[at(x, z)] = code;
    }
  };
  const carve = (gx, gz, gw, gd, code) => {
    for (let z = gz; z < gz + gd; z++) {
      for (let x = gx; x < gx + gw; x++) mask[at(x, z)] = 1;
    }
    stampF(gx, gz, gw, gd, code);
  };

  // placeable / inRects: byte-for-byte the crawl's shell discipline (see the
  // long docstring on crawl.js's placeable) — every new carving keeps a 1-cell
  // rock shell against all existing floor except at the exact door strips.
  function inRects(gx, gz, rects, grow) {
    for (const r of rects) {
      if (gx >= r.gx - grow && gx < r.gx + r.gw + grow
        && gz >= r.gz - grow && gz < r.gz + r.gd + grow) return true;
    }
    return false;
  }
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
              if (inRects(nx, nz, rects, 0)) continue;
              const grow = (dx === 0 || dz === 0) ? 0 : 1;
              if (!inRects(nx, nz, allowed, grow)) return false;
            }
          }
        }
      }
    }
    return true;
  }

  // --- floor 0: entry near the +Z edge + the arrival tunnel (crawl step 2) --
  const tunnelLen = randint(layoutRnd, params.tunnelLen[0], params.tunnelLen[1]);
  const entrySize = params.entrySize || params.roomSize;
  const egw = randint(layoutRnd, entrySize.w[0], entrySize.w[1]);
  const egd = randint(layoutRnd, entrySize.d[0], entrySize.d[1]);
  const egx = Math.floor((w - egw) / 2) + randint(layoutRnd, -2, 2);
  const egz = h - 1 - tunnelLen - egd;
  carve(egx, egz, egw, egd, 0);
  rooms.push({ id: 0, gx: egx, gz: egz, gw: egw, gd: egd, kind: 'entry', floor: 0 });
  const tx0 = egx + Math.floor((egw - 2) / 2);
  carve(tx0, egz + egd, 2, tunnelLen, 0);
  corridors.push({ gx: tx0, gz: egz + egd, gw: 2, gd: tunnelLen });
  doors.push({ plane: 'z', at: egz + egd, lo: tx0, hi: tx0 + 1, roomA: 0, roomB: -1 });

  // --- the analytic height function, grid half ------------------------------
  // Defined BEFORE the placer because the hug score below reads it while the
  // tower is still being carved (cellF/ramps grow as rooms land — the
  // function is a live view over them, valid at every point of generation).
  // Plateau: floorIndex * rise. Ramp k: flat 2 m treads stepping y0 ->
  // y0 + rise along the climb axis, each tread rise/(len+1) — <= 0.4 m at the
  // shipped rampLen band, which is what lets CharacterBody climb them through
  // its ordinary stepHeight with zero new physics.
  const rampTreadY = (r, gx, gz) => {
    const along = r.axis === 'x' ? gx - r.gx : gz - r.gz;
    const span = r.axis === 'x' ? r.gw : r.gd;
    const idx = r.dir > 0 ? along : (span - 1 - along);
    const step = Math.max(0, Math.min(span - 1, idx));
    return r.y0 + (rise * (step + 1)) / (span + 1);
  };
  const cellHeight = (gx, gz) => {
    const code = cellF[at(gx, gz)];
    if (code === ROCK) return 0;
    if (code < RAMP_BASE) return code * rise;
    return rampTreadY(ramps[code - RAMP_BASE], gx, gz);
  };

  // How hard a candidate room hugs the terrace below it: boundary cells with
  // a 1-3 cell rock band out to strictly-lower floor. The mid-floor placer
  // maximises this over its first few placeable candidates, which is what
  // makes the ascent SPIRAL over its own lower floors instead of marching
  // away from them — and is where the parapet-gap candidates come from.
  const hugScore = (room, floor) => {
    const roomY = floor * rise;
    let score = 0;
    for (const [ox, oz] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
      const horizontal = oz !== 0;
      const span = horizontal ? room.gw : room.gd;
      for (let i = 1; i < span - 1; i++) {
        const bx = horizontal ? room.gx + i : (ox > 0 ? room.gx + room.gw - 1 : room.gx);
        const bz = horizontal ? (oz > 0 ? room.gz + room.gd - 1 : room.gz) : room.gz + i;
        for (let k = 1; k <= 3; k++) {
          const mx = bx + ox * k;
          const mz = bz + oz * k;
          if (!inBounds(mx, mz) || mask[at(mx, mz)]) break;
          const fx = bx + ox * (k + 1);
          const fz = bz + oz * (k + 1);
          if (!inBounds(fx, fz) || !mask[at(fx, fz)]) continue;
          const drop = roomY - cellHeight(fx, fz);
          if (drop >= rise * 0.75 && drop <= 2 * rise + 0.3) score++;
          break;
        }
      }
    }
    return score;
  };

  // One placement attempt: corridor + room off `src`, carved and registered.
  // `rampTo` > 0 marks the corridor a staircase climbing to that floor.
  // Non-boss placements collect up to 12 placeable candidates and keep the
  // best hug (fixed exploration budget, ties to the earliest — a pure
  // function of the stream, so determinism holds); the boss takes the first
  // fit, because a 23-cell chamber is hard enough to seat without taste.
  const tryAttach = (src, floor, kind, size, cw, lenBand, rampTo) => {
    let best = null;
    let bestScore = -1;
    let found = 0;
    const wantBest = kind !== 'boss';
    for (let tries = 0; tries < 40; tries++) {
      const dir = rollDir(layoutRnd);
      const len = randint(layoutRnd, lenBand[0], lenBand[1]);
      const rw = randint(layoutRnd, size.w[0] ?? size.w, size.w[1] ?? size.w);
      const rd = randint(layoutRnd, size.d[0] ?? size.d, size.d[1] ?? size.d);
      const c = corridorAndRoom(src, dir, cw, len, rw, rd, layoutRnd);
      if (!c) continue;
      if (!placeable([c.corridor, c.room], [c.allowed])) continue;
      found++;
      const score = wantBest ? hugScore(c.room, floor) : 0;
      if (score > bestScore) { bestScore = score; best = { cand: c, dir, len }; }
      if (!wantBest || found >= 12) break;
    }
    if (best) {
      const { cand, dir, len } = best;
      const id = rooms.length;
      const code = rampTo > 0 ? RAMP_BASE + ramps.length : floor;
      carve(cand.corridor.gx, cand.corridor.gz, cand.corridor.gw, cand.corridor.gd, code);
      carve(cand.room.gx, cand.room.gz, cand.room.gw, cand.room.gd, floor);
      rooms.push({ id, gx: cand.room.gx, gz: cand.room.gz, gw: cand.room.gw, gd: cand.room.gd, kind, floor });
      corridors.push({ ...cand.corridor, ramp: rampTo > 0 });
      if (rampTo > 0) {
        // Staircase record: axis + climb direction from the roll, y0 from the
        // source floor. Treads are decoded from this by cellHeight below.
        const horizontal = dir === 'e' || dir === 'w';
        ramps.push({
          gx: cand.corridor.gx,
          gz: cand.corridor.gz,
          gw: cand.corridor.gw,
          gd: cand.corridor.gd,
          axis: horizontal ? 'x' : 'z',
          dir: (dir === 'e' || dir === 's') ? 1 : -1,
          y0: (rampTo - 1) * rise,
          len,
        });
      }
      doors.push({ ...cand.doorA, roomA: src.id, roomB: id });
      doors.push({ ...cand.doorB, roomA: id, roomB: src.id });
      return rooms[id];
    }
    return null;
  };

  // --- the ascent: floor 0's first fight room, then ramp-linked clusters ----
  const floorsRolled = randint(layoutRnd, params.floors[0], params.floors[1]);
  const c0 = tryAttach(rooms[0], 0, 'combat', params.roomSize,
    params.corridorWidths[Math.floor(layoutRnd() * params.corridorWidths.length)],
    params.corridorLen, 0);
  if (!c0) return { depth: -1 };
  // Every mid floor's FIRST room is mandatory (the ramp has to land
  // somewhere), so the extras budget is whatever maxCombat leaves after the
  // mandatory chain — a 6-floor roll gets one side chamber, a 4-floor roll
  // gets one per mid floor.
  let extrasLeft = Math.max(0, params.maxCombat - (floorsRolled - 1));
  let combatCount = 1;
  let last = c0;              // the room the next ramp climbs from
  let floorsBuilt = 1;
  let boss = -1;

  for (let f = 1; f < floorsRolled && boss < 0; f++) {
    const isTop = f === floorsRolled - 1;
    const kind = isTop ? 'boss' : 'combat';
    const size = isTop ? params.bossSize : params.roomSize;
    const first = tryAttach(last, f, kind, size, params.rampWidth, params.rampLen, f);
    if (!first) {
      // The grid refused this floor. If the tower already stands at least
      // params.floors[0] floors tall, cap it here and place the boss off the
      // current top instead of scrapping the whole attempt — determinism
      // holds (the failure is a pure function of the seed's rolls) and a
      // 4-floor ascent is a tower; a regen lottery is not.
      if (floorsBuilt >= params.floors[0]) break;
      return { depth: -1 };
    }
    floorsBuilt++;
    if (isTop) { boss = first.id; break; }
    combatCount++;
    last = first;
    // Fixed roll: does this floor carry a second room? (Flat corridor, same
    // floor — a side chamber, and pickTreasure's favourite leaf.)
    const extraRoll = randint(layoutRnd, params.roomsPerFloor[0], params.roomsPerFloor[1]);
    if (extraRoll > 1 && extrasLeft > 0) {
      const extra = tryAttach(first, f, 'combat', params.roomSize,
        params.corridorWidths[Math.floor(layoutRnd() * params.corridorWidths.length)],
        params.corridorLen, 0);
      // The extra room deliberately does NOT become the next ramp's source:
      // it stays a graph LEAF, which is what pickTreasure's off-path rule
      // feeds on — route the chain through it and the tower can never roll a
      // treasure room at all.
      if (extra) { combatCount++; extrasLeft--; }
    }
  }
  if (boss < 0) {
    // Capped early: the boss chamber crowns whatever the top floor became.
    const f = floorsBuilt;
    const bossRoom = tryAttach(last, f, 'boss', params.bossSize,
      params.rampWidth, params.rampLen, f);
    if (!bossRoom) return { depth: -1 };
    floorsBuilt++;
    boss = bossRoom.id;
  }
  const floorCount = floorsBuilt;

  // --- classification + critical path --------------------------------------
  const graph = adjacency(rooms.length, doors);
  const depths = bfsDepths(graph, 0);
  const bossDepth = depths[boss];
  if (!(bossDepth > 0)) return { depth: -1 };
  const criticalPath = bfsPath(graph, 0, boss);

  // --- parapet gaps ---------------------------------------------------------
  // Candidates: an upper room's boundary cell whose 1-3 cell rock band fronts
  // strictly lower floor — the same geometry the hug score maximised, so the
  // spiral placement above is what feeds this scan. Carving opens the WHOLE
  // band at the room's height: a flat balcony lip jutting over the drop, its
  // outer edge the ledge plane dungeon.js walls one-way by height. Ring rule
  // on every lip cell: lateral neighbours must be rock (no pre-existing
  // corridor running along the band), so carving can only ever join THIS room
  // to THAT drop. Fixed three rolls per candidate run; boss and entry rooms
  // never gap (a boss fight the player can fall out of mid-seal is a
  // softlock factory).
  const OUT4 = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
  const gaps = [];
  const dropMin = rise * 0.75;
  // ONE floor only (review fix): a two-floor 6.3 m lip put a height
  // discontinuity inside the ground-normal sampler's 0.9 m window steep
  // enough (> ~3.57 m) to flip the landing body into the SLIDING state — the
  // player skated off a clean drop. rise + 0.4 keeps every gap under the
  // sampler's slope limit with margin; the fall-damage table's one-floor row
  // (~7.5% maxHp) is unchanged.
  const dropMax = rise + 0.4;
  if (params.parapets) {
    for (const room of rooms) {
      if (room.floor < 1 || room.kind === 'entry' || room.kind === 'boss') continue;
      const roomY = room.floor * rise;
      for (const face of ['n', 's', 'e', 'w']) {
        const [ox, oz] = OUT4[face];
        const horizontal = face === 'n' || face === 's';
        const span = horizontal ? room.gw : room.gd;
        const sx = horizontal ? 1 : 0;   // lateral step, for the ring rule
        const sz = horizontal ? 0 : 1;
        // Boundary cells, corners excluded. A run groups consecutive cells of
        // the SAME band depth so the carved lip is a straight-edged balcony.
        const run = [];
        const runs = [];
        const flush = () => { if (run.length) runs.push(run.splice(0)); };
        for (let i = 1; i < span - 1; i++) {
          const bx = horizontal ? room.gx + i : (face === 'e' ? room.gx + room.gw - 1 : room.gx);
          const bz = horizontal ? (face === 's' ? room.gz + room.gd - 1 : room.gz) : room.gz + i;
          let depth = 0;
          let fx = 0;
          let fz = 0;
          for (let k = 1; k <= 3; k++) {
            const mx = bx + ox * k;
            const mz = bz + oz * k;
            if (!inBounds(mx, mz) || mask[at(mx, mz)]) break;
            const nx = bx + ox * (k + 1);
            const nz = bz + oz * (k + 1);
            if (!inBounds(nx, nz)) break;
            if (mask[at(nx, nz)]) { depth = k; fx = nx; fz = nz; break; }
          }
          let good = depth > 0;
          if (good) {
            const drop = roomY - cellHeight(fx, fz);
            good = drop >= dropMin && drop <= dropMax;
          }
          if (good) {
            for (let k = 1; k <= depth && good; k++) {
              const mx = bx + ox * k;
              const mz = bz + oz * k;
              if (mask[at(mx - sx, mz - sz)] || mask[at(mx + sx, mz + sz)]) good = false;
            }
          }
          if (good && run.length && run[run.length - 1].depth !== depth) flush();
          if (good) run.push({ bx, bz, depth, fx, fz });
          else flush();
        }
        flush();
        for (const cand of runs) {
          // FIXED roll count per candidate run, drawn before any rejection.
          const keep = parapetRnd() < params.parapets.chance;
          const spanRoll = randint(parapetRnd, params.parapets.span[0], params.parapets.span[1]);
          const offRoll = parapetRnd();
          if (!keep || gaps.length >= params.parapets.max) continue;
          if (cand.length < params.parapets.span[0]) continue;
          const gspan = Math.min(spanRoll, cand.length);
          const off = Math.floor(offRoll * (cand.length - gspan + 1));
          const cells = cand.slice(off, off + gspan);
          // Carve the whole band at the ROOM's height: a balcony, not a slope.
          const depth = cells[0].depth;
          const lip = [];
          let landSum = 0;
          for (const c of cells) {
            for (let k = 1; k <= depth; k++) {
              const mx = c.bx + ox * k;
              const mz = c.bz + oz * k;
              mask[at(mx, mz)] = 1;
              cellF[at(mx, mz)] = room.floor;
              if (k === depth) lip.push({ gx: mx, gz: mz });
            }
            landSum += cellHeight(c.fx, c.fz);
          }
          gaps.push({
            room: room.id,
            face,
            cellsG: lip,   // the OUTER row — the edge you step off
            yTop: roomY,
            yLand: landSum / cells.length,
          });
        }
      }
    }
  }

  // --- rock dilation: heights continue into the mass ------------------------
  // Ring 1 takes the MAX adjacent floor height (the body's normal sampling
  // beside an upper wall must read that wall's own floor, not the terrace
  // below); deeper rock BFS-inherits, FIFO in index order — deterministic.
  {
    const q = [];
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        const i = at(gx, gz);
        if (mask[i]) continue;
        let best = -1;
        let bestCode = ROCK;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          if (!mask[at(nx, nz)]) continue;
          const y = cellHeight(nx, nz);
          if (y > best) { best = y; bestCode = cellF[at(nx, nz)]; }
        }
        if (bestCode !== ROCK) { cellF[i] = bestCode; q.push(i); }
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cgx = cur % w;
      const cgz = (cur / w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cgx + dx;
        const nz = cgz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = at(nx, nz);
        if (mask[ni] || cellF[ni] !== ROCK) continue;
        cellF[ni] = cellF[cur];
        q.push(ni);
      }
    }
  }

  // --- world translation (crawl maths) --------------------------------------
  const southPlane = (egz + egd + tunnelLen) * CELL;
  const originX = -(tx0 + 1) * CELL;
  const originZ = -(southPlane - 1.6);

  const outRooms = rooms.map((r) => ({
    id: r.id,
    kind: r.kind,
    floor: r.floor,
    floorY: r.floor * rise,
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
  // door.y = the floor whose wall the opening sits in (roomA). A ramp's two
  // mouths therefore sit one floorRise apart — they ARE the between-floor
  // doors the encounter director seals.
  const outDoors = doors.map((d, i) => {
    const span = (d.hi - d.lo + 1) * CELL;
    const mid = originHalf(d.lo, d.hi);
    const y = d.roomA >= 0 ? outRooms[d.roomA].floorY : 0;
    return d.plane === 'z'
      ? { id: i, x: originX + mid * CELL, z: originZ + d.at * CELL, w: span, d: DOOR_THICKNESS, rot: 0, y, roomA: d.roomA, roomB: d.roomB }
      : { id: i, x: originX + d.at * CELL, z: originZ + mid * CELL, w: span, d: DOOR_THICKNESS, rot: Math.PI / 2, y, roomA: d.roomA, roomB: d.roomB };
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
    ramp: !!c.ramp,
  }));
  const outGaps = gaps.map((g) => {
    const cells = g.cellsG;
    const horizontal = g.face === 'n' || g.face === 's';
    const lo = Math.min(...cells.map((c) => (horizontal ? c.gx : c.gz)));
    const hi = Math.max(...cells.map((c) => (horizontal ? c.gx : c.gz)));
    const mid = originHalf(lo, hi);
    const span = (hi - lo + 1) * CELL;
    // The ledge plane: the OUTER edge of the carved lip.
    const lane = horizontal ? cells[0].gz : cells[0].gx;
    const plane = (g.face === 's' || g.face === 'e') ? lane + 1 : lane;
    return horizontal
      ? { room: g.room, face: g.face, x: originX + mid * CELL, z: originZ + plane * CELL, w: span, d: 0.5, rot: 0, yTop: g.yTop, yLand: g.yLand, cells }
      : { room: g.room, face: g.face, x: originX + plane * CELL, z: originZ + mid * CELL, w: span, d: 0.5, rot: Math.PI / 2, yTop: g.yTop, yLand: g.yLand, cells };
  });

  pickTreasure(outRooms, graph, criticalPath, params.treasure, encounterRnd);

  // --- wall runs, split by the floor they bound -----------------------------
  // buildWallRuns merges collinear boundary edges blind to height; the tower
  // re-walks each run's floor-side cells and records base (min) and top (max)
  // adjacent floor height. dungeon.js draws each slab from base to top +
  // wallHeight(/Low) — a ramp's side wall becomes one tall shaft slab, which
  // is both cheaper than per-tread segments and the right read for a stair.
  const wallRuns = buildWallRuns(mask, w, h, at, originX, originZ);
  const FLOOR_SIDE = { s: [0, -1], n: [0, 1], e: [-1, 0], w: [1, 0] };
  for (const run of wallRuns) {
    const [fx, fz] = FLOOR_SIDE[run.face];
    const horizontal = run.w > run.d;
    const len = Math.round((horizontal ? run.w : run.d) / CELL);
    let base = Infinity;
    let top = -Infinity;
    for (let i = 0; i < len; i++) {
      const cx = horizontal ? run.x - run.w / 2 + (i + 0.5) * CELL : run.x + fx * CELL * 0.5;
      const cz = horizontal ? run.z + fz * CELL * 0.5 : run.z - run.d / 2 + (i + 0.5) * CELL;
      const gx = Math.max(0, Math.min(w - 1, Math.floor((cx - originX) / CELL)));
      const gz = Math.max(0, Math.min(h - 1, Math.floor((cz - originZ) / CELL)));
      const y = cellHeight(gx, gz);
      if (y < base) base = y;
      if (y > top) top = y;
    }
    run.base = Number.isFinite(base) ? base : 0;
    run.top = Number.isFinite(top) ? top : run.base;
  }

  // --- spawn points + budgets -----------------------------------------------
  for (const r of rooms) {
    const pts = spawnPointsFor(r, mask, w, h, at, originX, originZ, layoutRnd);
    const y = r.floor * rise;
    for (const p of pts) p.y = y;
    outRooms[r.id].spawnPoints = pts;
  }
  // Parapet shoulders sit closer to a room's floor than the crawl's geometry
  // ever allows, so re-assert the 1.5 m wall clearance against the FINAL runs
  // (post-gap) by pruning rather than trusting construction. Deterministic:
  // pure filter, no rolls.
  const runDist = (p, run) => {
    const dx = Math.max(Math.abs(p.x - run.x) - run.w / 2, 0);
    const dz = Math.max(Math.abs(p.z - run.z) - run.d / 2, 0);
    return Math.hypot(dx, dz);
  };
  for (const r of outRooms) {
    r.spawnPoints = r.spawnPoints.filter((p) => {
      for (const run of wallRuns) {
        if (runDist(p, run) < 1.6) return false;
      }
      return true;
    });
  }
  assignBudgets(outRooms, criticalPath, enemies);

  const { bounds, radius } = boundsFromMask(mask, w, h, at, originX, originZ);

  // --- decor (decorRnd) + cover (coverRnd), then height-stamped -------------
  // Both placers are 2D and per-room, and every tower room is a flat plateau,
  // so their whole clearance/connectivity discipline holds unchanged in each
  // room's own frame; the stamp is a pure post-pass off the height table and
  // consumes no rolls.
  const decor = buildDecor(outRooms, outDoors, wallRuns, params, decorRnd);
  decor.cover = buildCover(outRooms, outDoors, wallRuns, decor, params, coverRnd, boss);
  const heightAtWorld = (x, z) => {
    const gx = Math.max(0, Math.min(w - 1, Math.floor((x - originX) / CELL)));
    const gz = Math.max(0, Math.min(h - 1, Math.floor((z - originZ) / CELL)));
    return cellHeight(gx, gz);
  };
  for (const t of decor.torches) t.y = heightAtWorld(t.x - Math.sin(t.yaw) * 0.6, t.z - Math.cos(t.yaw) * 0.6);
  for (const c of decor.columns) c.y = heightAtWorld(c.x, c.z);
  for (const p of decor.props) p.y = heightAtWorld(p.x, p.z);
  for (const c of decor.cover) c.y = outRooms[c.room].floorY;

  const layout = {
    kind: 'tower',
    rank,
    cell: CELL,
    w,
    h,
    originX,
    originZ,
    mask,
    cellF,
    floorRise: rise,
    floorCount,
    ramps,
    gaps: outGaps,
    rooms: outRooms,
    doors: outDoors,
    corridors: outCorridors,
    wallRuns,
    decor,
    criticalPath,
    bossRoom: boss,
    depth: bossDepth,
    entry: { x: 0, z: 0, yaw: 0 },
    bounds,
    radius,
    params: {
      wallHeight: params.wallHeight,
      wallHeightLow: params.wallHeightLow,
      torchSpacing: params.torchSpacing,
      fog: params.fog,
      floorRise: rise,
      fallDamage: params.fallDamage,
    },
  };
  // THE heightAt seam (docs/AAA_COHESION_PLAN.md Wave E): the per-layout
  // height function dungeon.js's stub defers to. A function property —
  // JSON.stringify drops it, so the determinism byte-compare rides the DATA
  // it closes over (cellF + ramps + floorRise), which is exactly right: two
  // layouts with identical data ARE the same height function.
  layout.heightAt = heightAtWorld;
  return layout;
}
