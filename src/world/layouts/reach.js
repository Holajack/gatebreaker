// Reach kind — Wave E task E-S, ARCHON'S REACH (S rank): THE set-piece
// approach. Not a random walk — a scripted ascent with rolled joints: a long
// BROKEN CAUSEWAY (the tower's analytic height seam at grander scale — three
// 5 m climbs on 26-32 m stair spans instead of the tower's 3 m / 16-20 m)
// through TWO GAUNTLET ARENAS (sealed-room fights, the crawl's exact door/
// membrane vocabulary) to the RIFT ARCHON's summit: one large disc arena
// whose edge COLLAPSES in phases as the boss falls. The layout carries the
// phase radii as DATA (layout.arenaPhases); dungeon.js pre-registers the
// phase ring barriers and owns setArenaPhase; the encounter director watches
// boss hp and consumes the seam. The boss's own BRAIN stays game.js's —
// per-boss brains are the combat workflow's sequel, and nothing here touches
// them.
//
// Split per the Wave E generator law: one file per layout kind, shared
// plumbing in core.js, dispatch in core.js generateLayout. The shared
// contract in core.js's header binds this file in full: DETERMINISM IS
// LOAD-BEARING, no Math.random / Date.now, forked mulberry32 streams only,
// THREE-free and Node-importable. Consumers import ../dungeonlayout.js,
// never this file.
//
// THE SHAPE. rooms are a LINEAR chain — entry(0) -> gauntlet(1) ->
// gauntlet(2) -> summit(3) — each hop a RAMP causeway (crawl's
// corridorAndRoom candidate geometry, the tower's staircase decode over it).
// Heights are the tower's marker grammar verbatim (cellF plateau/ramp codes,
// analytic decode, rock dilation for the body's normal sampling) except that
// plateau codes index a LEVELS table (params.levels = [0, 5, 10, 15]) rather
// than multiplying one uniform rise — the reach's climbs are taller than any
// tread chain the tower rolls, and each causeway's tread height still clears
// the body's 0.4 m stepHeight by construction (5 m over 13-16 cells =
// 0.29-0.36 m per tread).
//
// BROKEN CAUSEWAY. After placement a notch pass (its own fifth stream,
// breakRnd) bites 1-2 cell deep, 2-4 cell long notches out of the causeway
// edges: the 8 m span narrows and weaves, walls trace the bites (buildWallRuns
// runs on the final mask, so every notch edge is a real collision run — the
// break reads as ruin, never as a fall hazard the soak can't bound). Three
// hard rules make the pass provably traversable: notches keep >= 2 cells of
// causeway width at every row (depth is capped at width - 2), keep 2 clear
// rows off both door shoulders, and keep >= 2 un-notched rows between any two
// notches so consecutive open spans always overlap. Fixed FOUR rolls per
// candidate row, drawn before any rejection — the cavern stalagmite loop's
// rule, so retuning break chance can never re-cut a different causeway.
//
// THE SUMMIT. Placed as a rect through the same placeable() shell discipline
// as every room, then re-carved: floor survives only inside the inscribed
// DISC (radius summitSize - 0.5 cells) plus the door's straight approach
// lane, so wall runs trace a circular arena. layout.arenaPhases carries
// { cx, cz, y, radii, thresholds }: radii[0] is the full fight disc,
// radii[1..] the collapse rings dungeon.js pre-registers barriers on. A
// short BROKEN RING of stub/pillar cover stands inside the FINAL radius
// (drawn first off coverRnd, so gauntlet cover tuning can never move it),
// held off the boss rise + exit anchors — LOS breaks that survive every
// phase. The collapse rings RETRACT when the boss dies (the director resets
// the phase in onBossDeath), so the exit portal's anchor only has to sit
// inside the FULL disc (radii[0]) — which it does by construction, and the
// soak asserts.
//
// STREAMS. layoutRnd / decorRnd / encounterRnd / coverRnd are the standard
// four forks; breakRnd is the fifth (0xb5297a4d — squirrel3's constant,
// collides with none in use: 0x9e3779b9 / 0x5f356495 / 0x1f123bb5 /
// 0x7feb352d layout family, 0x94d049bb parapets, 0x68e31da4 terrain,
// 0x85ebca6b shell, 0x27d4eb2f dressing, 0x632be59b enemy count,
// 0xc2b2ae35 waveSize).

import { mulberry32 } from '../../core/rng.js';
import {
  CELL, DOOR_THICKNESS, randint, originHalf, boundsFromMask,
  adjacency, bfsDepths, bfsPath, pickTreasure,
  buildWallRuns, assignBudgets, buildDecor, buildCover,
  bossAnchor, exitAnchor, COVER_KINDS,
} from './core.js';
import { corridorAndRoom, spawnPointsFor } from './crawl.js';

// The ascent folds but keeps marching away from the camera: heavier -Z than
// the tower's (the chain is only 3 hops, so it can afford the drift), with
// enough lateral weight that a 226 m straight line is the exception.
const REACH_DIR_WEIGHTS = [
  ['n', 0.44], ['e', 0.25], ['w', 0.25], ['s', 0.06],
];

function rollDir(rnd) {
  let t = rnd();
  for (const [d, w] of REACH_DIR_WEIGHTS) {
    t -= w;
    if (t < 0) return d;
  }
  return 's';
}

// cellF marker grammar (tower.js's): 0..levels.length-1 plateau level index,
// RAMP_BASE+k = causeway k's staircase, ROCK = unassigned pre-dilation.
const RAMP_BASE = 100;
const ROCK = 255;

export function tryGenerateReach(rank, params, enemies, seed) {
  const layoutRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const decorRnd = mulberry32((seed ^ 0x5f356495) >>> 0);
  const encounterRnd = mulberry32((seed ^ 0x1f123bb5) >>> 0);
  const coverRnd = mulberry32((seed ^ 0x7feb352d) >>> 0);
  const breakRnd = mulberry32((seed ^ 0xb5297a4d) >>> 0);

  const w = params.grid;
  const h = params.grid;
  const levels = params.levels;
  const mask = new Uint8Array(w * h);
  const cellF = new Uint8Array(w * h).fill(ROCK);
  const at = (gx, gz) => gx + gz * w;
  const inBounds = (gx, gz) => gx >= 1 && gz >= 1 && gx <= w - 2 && gz <= h - 2;

  const rooms = [];       // { id, gx, gz, gw, gd, kind, level }
  const corridors = [];   // { gx, gz, gw, gd, ramp? }
  const doors = [];       // crawl grammar
  const ramps = [];       // { gx, gz, gw, gd, axis, dir, y0, y1 }

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

  // placeable / inRects: byte-for-byte the crawl/tower shell discipline.
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

  // --- level 0: entry near the +Z edge + the arrival tunnel ----------------
  const tunnelLen = randint(layoutRnd, params.tunnelLen[0], params.tunnelLen[1]);
  const entrySize = params.entrySize || params.roomSize;
  const egw = randint(layoutRnd, entrySize.w[0], entrySize.w[1]);
  const egd = randint(layoutRnd, entrySize.d[0], entrySize.d[1]);
  const egx = Math.floor((w - egw) / 2) + randint(layoutRnd, -2, 2);
  const egz = h - 1 - tunnelLen - egd;
  carve(egx, egz, egw, egd, 0);
  rooms.push({ id: 0, gx: egx, gz: egz, gw: egw, gd: egd, kind: 'entry', level: 0 });
  const tx0 = egx + Math.floor((egw - 2) / 2);
  carve(tx0, egz + egd, 2, tunnelLen, 0);
  corridors.push({ gx: tx0, gz: egz + egd, gw: 2, gd: tunnelLen });
  doors.push({ plane: 'z', at: egz + egd, lo: tx0, hi: tx0 + 1, roomA: 0, roomB: -1 });

  // --- the analytic height function, grid half ------------------------------
  // Plateau: levels[code]. Causeway k: flat 2 m treads stepping y0 -> y1
  // along the climb axis, each tread (y1-y0)/(span+1) <= the body's 0.4 m
  // stepHeight at the shipped causewayLen band — the tower's decode with a
  // per-ramp rise instead of one module constant.
  const rampTreadY = (r, gx, gz) => {
    const along = r.axis === 'x' ? gx - r.gx : gz - r.gz;
    const span = r.axis === 'x' ? r.gw : r.gd;
    const idx = r.dir > 0 ? along : (span - 1 - along);
    const step = Math.max(0, Math.min(span - 1, idx));
    return r.y0 + ((r.y1 - r.y0) * (step + 1)) / (span + 1);
  };
  const cellHeight = (gx, gz) => {
    const code = cellF[at(gx, gz)];
    if (code === ROCK) return 0;
    if (code < RAMP_BASE) return levels[code] ?? 0;
    return rampTreadY(ramps[code - RAMP_BASE], gx, gz);
  };

  // One chain hop: causeway (ramp corridor) + room off `src`, carved and
  // registered. First fit wins — the reach is a set piece, not a wanderer;
  // the joints' variety comes from the direction/length/offset rolls.
  const tryAttach = (src, levelIdx, kind, sizeW, sizeD, cw, lenBand) => {
    for (let tries = 0; tries < 40; tries++) {
      const dir = rollDir(layoutRnd);
      const len = randint(layoutRnd, lenBand[0], lenBand[1]);
      const rw = randint(layoutRnd, sizeW[0], sizeW[1]);
      const rd = randint(layoutRnd, sizeD[0], sizeD[1]);
      const c = corridorAndRoom(src, dir, cw, len, rw, rd, layoutRnd);
      if (!c) continue;
      if (!placeable([c.corridor, c.room], [c.allowed])) continue;
      const id = rooms.length;
      const code = RAMP_BASE + ramps.length;
      carve(c.corridor.gx, c.corridor.gz, c.corridor.gw, c.corridor.gd, code);
      carve(c.room.gx, c.room.gz, c.room.gw, c.room.gd, levelIdx);
      rooms.push({ id, gx: c.room.gx, gz: c.room.gz, gw: c.room.gw, gd: c.room.gd, kind, level: levelIdx });
      corridors.push({ ...c.corridor, ramp: true });
      const horizontal = dir === 'e' || dir === 'w';
      ramps.push({
        gx: c.corridor.gx,
        gz: c.corridor.gz,
        gw: c.corridor.gw,
        gd: c.corridor.gd,
        axis: horizontal ? 'x' : 'z',
        dir: (dir === 'e' || dir === 's') ? 1 : -1,
        y0: levels[levelIdx - 1],
        y1: levels[levelIdx],
      });
      doors.push({ ...c.doorA, roomA: src.id, roomB: id });
      doors.push({ ...c.doorB, roomA: id, roomB: src.id });
      return { room: rooms[id], cand: c, dir };
    }
    return null;
  };

  // --- the ascent: gauntlet 1 -> gauntlet 2 -> summit -----------------------
  const g1 = tryAttach(rooms[0], 1, 'combat',
    params.roomSize.w, params.roomSize.d, params.causewayWidth, params.causewayLen);
  if (!g1) return { depth: -1 };
  const g2 = tryAttach(g1.room, 2, 'combat',
    params.roomSize.w, params.roomSize.d, params.causewayWidth, params.causewayLen);
  if (!g2) return { depth: -1 };
  const ss = params.summitSize;
  const summit = tryAttach(g2.room, 3, 'boss',
    [ss, ss], [ss, ss], params.causewayWidth, params.causewayLen);
  if (!summit) return { depth: -1 };
  const boss = summit.room.id;

  // --- summit re-carve: rect -> disc + door approach lane -------------------
  // The rect passed the shell check at full size; removing floor can only
  // shrink contact, so the shell rule still holds. The door strip's lane is
  // kept carved from the rect boundary straight in until it meets the disc,
  // so the causeway's mouth opens onto floor, not a rock ring.
  {
    const r = summit.room;
    const dcx = r.gx + r.gw / 2;
    const dcz = r.gz + r.gd / 2;
    const discR = r.gw / 2 - 0.5;   // cells; ~1 cell of rim at the corners
    const keep = new Set();
    const dB = summit.cand.doorB;   // the summit's own wall opening
    const dirIn = summit.dir === 'n' ? [0, -1] : summit.dir === 's' ? [0, 1]
      : summit.dir === 'e' ? [1, 0] : [-1, 0];
    for (let lane = dB.lo; lane <= dB.hi; lane++) {
      // First room cell just inside the door plane, then march inward.
      let gx = dB.plane === 'z' ? lane : (summit.dir === 'e' ? dB.at : dB.at - 1);
      let gz = dB.plane === 'z' ? (summit.dir === 's' ? dB.at : dB.at - 1) : lane;
      for (let s = 0; s < r.gw + r.gd; s++) {
        if (gx < r.gx || gz < r.gz || gx >= r.gx + r.gw || gz >= r.gz + r.gd) break;
        keep.add(at(gx, gz));
        const dx = gx + 0.5 - dcx;
        const dz = gz + 0.5 - dcz;
        if (dx * dx + dz * dz <= discR * discR) break;   // lane met the disc
        gx += dirIn[0];
        gz += dirIn[1];
      }
    }
    for (let gz = r.gz; gz < r.gz + r.gd; gz++) {
      for (let gx = r.gx; gx < r.gx + r.gw; gx++) {
        const dx = gx + 0.5 - dcx;
        const dz = gz + 0.5 - dcz;
        if (dx * dx + dz * dz <= discR * discR) continue;
        if (keep.has(at(gx, gz))) continue;
        mask[at(gx, gz)] = 0;
        cellF[at(gx, gz)] = ROCK;
      }
    }
  }

  // --- the BROKEN causeway: notch pass (breakRnd ONLY) ----------------------
  // See the header: >= 2 cells of width survive every row, 2 clear rows off
  // both door shoulders, >= 2 clear rows between notches. FIXED four rolls
  // per candidate row.
  if (params.breaks) {
    const bk = params.breaks;
    let carved = 0;
    for (const r of ramps) {
      const horizontal = r.axis === 'x';
      const len = horizontal ? r.gw : r.gd;
      const width = horizontal ? r.gd : r.gw;
      const maxDepth = Math.min(bk.depth[1], width - 2);
      let lastEnd = -10;
      for (let a = 2; a <= len - 1 - bk.span[0] - 2; a += 3) {
        const keep = breakRnd() < bk.chance;
        const side = breakRnd() < 0.5 ? 0 : 1;
        const gspan = randint(breakRnd, bk.span[0], bk.span[1]);
        const depth = Math.min(randint(breakRnd, bk.depth[0], bk.depth[1]), maxDepth);
        if (!keep || carved >= bk.max || depth < 1) continue;
        if (a < lastEnd + 2) continue;
        const end = Math.min(a + gspan, len - 2);
        if (end - a < bk.span[0]) continue;
        for (let i = a; i < end; i++) {
          for (let k = 0; k < depth; k++) {
            const across = side ? width - 1 - k : k;
            const gx = horizontal ? r.gx + i : r.gx + across;
            const gz = horizontal ? r.gz + across : r.gz + i;
            mask[at(gx, gz)] = 0;
            cellF[at(gx, gz)] = ROCK;
          }
        }
        lastEnd = end;
        carved++;
      }
    }
  }

  // --- classification + critical path --------------------------------------
  const graph = adjacency(rooms.length, doors);
  const depths = bfsDepths(graph, 0);
  const bossDepth = depths[boss];
  if (!(bossDepth > 0)) return { depth: -1 };
  const criticalPath = bfsPath(graph, 0, boss);

  // --- rock dilation: heights continue into the mass (tower.js verbatim) ----
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
    level: r.level,
    floorY: levels[r.level],
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

  // Consumed for stream parity with every other kind; the chain has no
  // off-path rooms, so the reach never rolls a treasure room (chance 0 in
  // LAYOUT_PARAMS.S makes that explicit).
  pickTreasure(outRooms, graph, criticalPath, params.treasure, encounterRnd);

  // --- wall runs, height-stamped (tower.js's post-walk) ---------------------
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
    const y = levels[r.level];
    for (const p of pts) p.y = y;
    outRooms[r.id].spawnPoints = pts;
  }
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

  // --- arena phase data (THE seam) ------------------------------------------
  const summitRoom = outRooms[boss];
  const arenaPhases = {
    cx: summitRoom.centre.x,
    cz: summitRoom.centre.z,
    y: summitRoom.floorY,
    radii: params.arenaRadii.slice(),
    thresholds: params.arenaThresholds.slice(),
  };

  // --- decor + cover --------------------------------------------------------
  const decor = buildDecor(outRooms, outDoors, wallRuns, params, decorRnd);
  // Summit ring FIRST (coverRnd): a broken stub/pillar circle inside the
  // FINAL collapse radius — LOS breaks the kite loop keeps in every phase.
  // Drawn before buildCover so gauntlet cover tuning can never move it.
  const summitDoor = summitRoom.doors.length ? outDoors[summitRoom.doors[0]] : null;
  const bAnchor = bossAnchor(summitRoom, summitDoor);
  const eAnchor = exitAnchor(summitRoom, summitDoor);
  const ringCover = buildSummitRing(summitRoom, params, coverRnd, bAnchor, eAnchor);
  // Gauntlets + entry go through the crawl's placer (entry stays empty by its
  // own rule); bossRoomId -1 keeps its colonnade pass off — the summit's
  // identity beat is the collapsing edge, not a rotunda.
  const nonSummit = outRooms.filter((r) => r.id !== boss);
  decor.cover = buildCover(nonSummit, outDoors, wallRuns, decor, params, coverRnd, -1);
  decor.cover.push(...ringCover);
  // The crawl's spawn-menu prune, applied to the summit against its ring.
  if (ringCover.length) {
    summitRoom.spawnPoints = summitRoom.spawnPoints.filter((p) => !ringCover.some((q) => (
      Math.abs(p.x - q.x) < q.ex + params.cover.spawnClear
      && Math.abs(p.z - q.z) < q.ez + params.cover.spawnClear
    )));
  }

  // Height-stamp decor + cover (tower.js's post-pass; consumes no rolls).
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
    kind: 'reach',
    rank,
    cell: CELL,
    w,
    h,
    originX,
    originZ,
    mask,
    cellF,
    levels: levels.slice(),
    ramps,
    arenaPhases,
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
    },
  };
  // THE heightAt seam (tower.js's rule to the letter): a function property —
  // JSON.stringify drops it, so the determinism byte-compare rides the data
  // it closes over (cellF + ramps + levels), which is exactly right.
  layout.heightAt = heightAtWorld;
  return layout;
}

// ---------------------------------------------------------------------------
// summit ring — the cover that survives every collapse phase. coverRnd ONLY.
// ---------------------------------------------------------------------------
// A broken circle of alternating wall stubs and pillars at
// summitRingFrac x the FINAL phase radius, tangent-yawed like the crawl's
// boss colonnade, held off the boss rise + exit anchors (which drops the
// slots nearest them — the ring opens toward where the boss stands up, the
// crawl's exact read). Fixed two rolls per slot after the phase roll; a
// guaranteed-floor re-sweep mirrors buildCover's (pure function of the first
// sweep's outcome, so determinism holds).
function buildSummitRing(room, params, rnd, bAnchor, eAnchor) {
  const cfg = params.cover;
  const out = [];
  if (!cfg) return out;
  const radii = params.arenaRadii;
  const ringR = radii[radii.length - 1] * (cfg.summitRingFrac ?? 0.62);
  const slots = cfg.summitRingSlots ?? 6;
  const keepChance = cfg.summitRingKeep ?? 0.85;
  const extents = (kind, yaw) => {
    const k = COVER_KINDS[kind];
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    return { ex: k.hx * c + k.hz * s, ez: k.hx * s + k.hz * c };
  };
  const tangent = (a) => -a - Math.PI / 2;
  const phase = rnd() * Math.PI * 2;
  const tryPut = (a, wobble, kind) => {
    const rr = ringR + wobble;
    const x = room.centre.x + Math.cos(a) * rr;
    const z = room.centre.z + Math.sin(a) * rr;
    const yaw = tangent(a);
    const { ex, ez } = extents(kind, yaw);
    const reach = Math.max(ex, ez);
    if (Math.hypot(x - bAnchor.x, z - bAnchor.z) < cfg.bossClear + reach) return false;
    if (Math.hypot(x - eAnchor.x, z - eAnchor.z) < cfg.exitClear + reach) return false;
    for (const q of out) {
      if (Math.abs(q.x - x) < q.ex + ex + cfg.lane
        && Math.abs(q.z - z) < q.ez + ez + cfg.lane) return false;
    }
    out.push({ x, z, yaw, kind, room: room.id, ex, ez, anchor: true });
    return true;
  };
  const sweep = (force) => {
    for (let i = 0; i < slots; i++) {
      const keep = rnd() < keepChance;      // fixed roll count per slot
      const wobble = (rnd() - 0.5) * 1.2;
      if (!keep && !force) continue;
      const a = phase + (i / slots) * Math.PI * 2;
      tryPut(a, wobble, i % 2 === 0 ? 'stub' : 'pillar');
    }
  };
  sweep(false);
  if (out.length < 3) sweep(true);
  return out;
}
