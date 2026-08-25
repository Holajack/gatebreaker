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
//   coverRnd     = mulberry32((seed ^ 0x7feb352d) >>> 0)   interior cover field
//
// so decor tuning can never reshuffle rooms, and encounter tuning can never
// move a wall. No Math.random, no Date.now, anywhere in this file.
// coverRnd is its OWN stream and not a continuation of decorRnd for the same
// reason: retuning how much cover a room carries must not move a single torch
// sconce, because the sconces are what the 2-light pool anchors to.
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
// THREE-free, Node-importable (see obstacles.js's own header) — buildCover's
// connectivity guarantee below builds the same kind of real collision field
// dungeon.js registers at render time, so "is this room still walkable" is
// answered against what the player actually collides with, not against the
// placer's own bookkeeping.
import { ObstacleField } from './obstacles.js';
// The ONE physical constant this generator shares with the sim: the height
// every projectile flies at. config.js is THREE-free and DOM-free (its header
// says so, and it imports only rng.js), so pulling it in keeps the plain-Node
// soak working while removing the duplicated 1.2 that let the cover field be
// designed for a height nothing fired at. See COVER_MIN_TOP below.
import { PROJECTILE_Y } from '../game/config.js';

// ---------------------------------------------------------------------------
// ROOM SIZING IS MEASURED IN DASH UNITS. Read this before touching roomSize.
// ---------------------------------------------------------------------------
// config.js SKILLS.dash.distance = 7.5 m. A fighting room has to be sized
// against that number or the movement skill has nowhere to go:
//
//   regular combat room, short axis >= 3 dashes = 3 x 7.5 = 22.5 m
//     -> at CELL = 2 m that is 11.25 cells, so the SHORT-axis roll floor is
//        12 cells = 24 m = 3.2 dashes. Three dashes is the minimum that lets
//        a dodge land somewhere other than a wall and lets a pack flank.
//   boss chamber, both axes >= 5 dashes = 5 x 7.5 = 37.5 m
//     -> 19 cells = 38 m = 5.07 dashes (E), 21 cells = 42 m = 5.6 (D). Five
//        is the kiting number: read a telegraph, dash out, circle, re-enter.
//
// The pre-wave-3 numbers were E rooms 5-8 x 4-6 cells = 10-16 x 8-12 m, i.e.
// 1.1-1.6 dashes across the short axis — ONE dash crossed a whole room. The
// boss was 9x7 cells = 18x14 m, under two dashes, and it was GROWN from a
// regular roll so a crowded grid routinely under-delivered even that (measured
// boss short axis 8-14 m over 60 seeds). Hence tryGenerate's step 5: the boss
// chamber is now PLACED at its full size or the layout regenerates.
//
// GRID PACKING. Bigger rooms need a bigger grid, and the walk is a random
// placer, so it needs slack on top of the raw area. Worst case in cells, each
// rect inflated by its 1-cell rock shell:
//   E: entry 9x7 = 63, 5 regular at 16x15 = 240 each = 1200, boss 20x20 = 400,
//      ~7 corridors x 3x6 = ~126   ->  ~1789 of the 76x76 = 5776 grid = 31%.
//   D: entry 63, 5 regular at 17x16 = 272 each = 1360, vault 21x17 = 357,
//      boss 22x22 = 484, ~8 corridors = ~144  ->  ~2408 of 92x92 = 8464 = 28%.
// Both clear comfortably with the 40-try-per-room placer (measured: 0 shallow
// or failed layouts over 150 seeds per rank).
// Room COUNT came down (E 5-6 -> 4-5, D 7-8 -> 5-6) to pay for the area: at
// the old counts the enemy total needed to hold density would have tripled
// run length, and the floor bbox would have doubled the nav-grid sweep.
//
// `enemies` is the nominal room-budget total and only feeds headless tests.
// The live count is ROLLED PER RUN from config.js GATES[].enemyBand by
// Dungeon.build, which passes it through generateLayout's `enemies` option.
export const LAYOUT_PARAMS = {
  E: {
    kind: 'crawl',
    grid: 76,                       // 76 x 76 cells = 152 m
    rooms: [4, 5],                  // regular rooms, + entry + boss
    // Entry is a deploy pad, not a fight room: it stays small so its floor
    // area is not spent on the packing budget the fighting rooms need.
    entrySize: { w: [6, 8], d: [5, 6] },
    roomSize: { w: [12, 15], d: [12, 14] },   // 24-30 x 24-28 m (3.2-4.0 dashes)
    bossSize: { w: 19, d: 19 },               // 38 x 38 m (5.07 dashes)
    vault: null,
    corridorWidths: [2],
    // PACING (wave 3-A2). Rooms grew 5.5x but corridors did not, so the walk
    // between fights is now mostly room-crossing, not corridor: measured over
    // 60 seeds the corridors are 5.4% of the E floor area and ~24% of the
    // 151 m critical-path walk. Trimming the long tail 3-6 -> 2-5 cells
    // (6-12 m -> 4-10 m) took the E critical-path walk 152.4 -> 143.0 m and D
    // 184.3 -> 178.2 m over 150 seeds per rank, with boss depth unmoved
    // (E mean 4.18 -> 4.15) and zero shallow or failed layouts. 2-4 measured
    // 139.6 m but caps a corridor at 8 m, which flattens the reveal beat for
    // 2.4 m more; 2-5 is the honest sweet spot. This is a ~6% lever, not the
    // pacing fix — the fix is that rooms now carry cover and enemies, so the
    // floor you cross is floor you fight on.
    corridorLen: [2, 5],
    tunnelLen: [8, 10],
    loops: 1,
    minBossDepth: 3,
    wallHeight: 4,
    wallHeightLow: 2,               // face-'s' runs (fixed-camera occluders)
    torchSpacing: 6,
    torchMinGap: 10,      // m between kept sconces (spread, see buildDecor)
    torchCap: 40,         // hard cap; DRESS_LIMITS.torches is the render backstop
    propDensity: 'low',
    alcoves: false,
    treasure: { chance: 0.2, guaranteed: false },
    // Fog far has to clear the room: at far 34 the opposite wall of a 38 m
    // boss chamber was solid fog, so there was nothing to kite AROUND.
    fog: { near: 13, far: 44 },
    // Interior cover — see the INTERIOR COVER block above every constant.
    cover: {
      step: 7.0,          // candidate lattice pitch, m (just under one dash)
      jitter: 1.8,        // per-point jitter, m — kills the lattice read
      chance: 0.62,       // per-candidate keep roll
      rubbleShare: 0.55,  // rubble vs pillar mix on the scatter
      lane: 3.0,          // guaranteed clear floor between two footprints, m
      wallInset: 3.2,     // footprint edge to room wall, m (perimeter ring)
      doorClear: 5.5,     // door approach stays a clean lane, m
      spawnClear: 1.6,    // clear margin around every spawn point, m
      centreClear: 3.4,   // treasure chest + shrine footprint, m
      bossClear: 4.5,     // the boss's rise anchor, m
      exitClear: 3.5,     // the walk-out exit portal, m
      ringFrac: 0.48,     // dais ring radius as a fraction of the boss half-span
      ringSlots: 10,      // colonnade slots around that ring
      ringKeep: 0.76,     // per-slot keep roll — a BROKEN colonnade
      quadSlots: 7,       // rubble piles on the outer debris arc (see the arc
                          // note in buildCover for why this moved 4 -> 7)
      minPieces: 2,       // per-room floor; below it the lattice re-sweeps
      rubbleCap: 24,      // per-gate 788-tri budget guard; see the cap note
    },
    // Nominal = the midpoint of GATES.E enemyBand [30, 42], headless only. It
    // is written out rather than imported because config.js imports nothing
    // from here and this file must stay THREE-free and standalone for the Node
    // soak — so the ONE rule is: move a band in config.js, move the midpoint
    // here in the same edit, or the generation soak starts testing a lighter
    // dungeon than the one that ships. (30 + 42) / 2 = 36.
    enemies: 36,
  },
  D: {
    kind: 'crawl',
    grid: 92,                       // 92 x 92 cells = 184 m
    rooms: [5, 6],
    entrySize: { w: [6, 8], d: [5, 6] },
    roomSize: { w: [12, 16], d: [12, 15] },   // 24-32 x 24-30 m
    bossSize: { w: 21, d: 21 },               // 42 x 42 m (5.6 dashes)
    vault: { w: [17, 20], d: [13, 16] },      // one vault hall, 34-40 x 26-32 m
    corridorWidths: [2, 3],
    corridorLen: [2, 5],            // see the E note — same measurement, D
    tunnelLen: [9, 11],
    loops: 2,
    minBossDepth: 3,
    wallHeight: 4,
    wallHeightLow: 2,
    torchSpacing: 7,
    torchMinGap: 11,
    torchCap: 40,
    propDensity: 'medium',
    alcoves: true,
    treasure: { chance: 1, guaranteed: true },
    fog: { near: 13, far: 46 },
    // D is the ossuary: propDensity is already 'medium', so its cover field is
    // a shade denser and its colonnade a slot longer than E's. Everything else
    // is E's numbers — the clearances are body-sized, not rank-sized.
    cover: {
      step: 7.0,
      jitter: 1.8,
      chance: 0.68,
      rubbleShare: 0.55,
      lane: 3.0,
      wallInset: 3.2,
      doorClear: 5.5,
      spawnClear: 1.6,
      centreClear: 3.4,
      bossClear: 4.5,
      exitClear: 3.5,
      ringFrac: 0.48,
      ringSlots: 12,
      ringKeep: 0.76,
      quadSlots: 8,       // E's 7 + one slot for the wider 42 m chamber
      minPieces: 2,
      rubbleCap: 24,
    },
    enemies: 52,          // nominal = midpoint of GATES.D enemyBand [44, 60]
  },
  C: {
    kind: 'cavern',                 // STEP 8 — one huge organic chamber
    grid: 80,                       // 80 x 80 cells = 160 m
    rooms: [4, 5],                  // encounter ZONES (combat), + entry + boss
    discs: [11, 16],                // disc-union random walk, disc count
    discR: [8, 18],                 // walk disc radius, metres
    grottos: 2,                     // attached side grottos (3rd is the boss's)
    grottoR: [6, 9],                // side-grotto radius, metres
    // DASH UNITS, boss half: the grotto is the one C space that SEALS (neck
    // membrane), so it is the one that has to satisfy the 5-dash rule on its
    // own — 19-22 m radius = 38-44 m across = 5.1-5.9 dashes. It was 10-12 m
    // radius (20-24 m, 2.7-3.2 dashes): a sealed pen, not an arena.
    bossR: [19, 22],                // boss grotto radius, metres
    neckGap: [2, 3],                // rock cells between mass and boss grotto
    // Zones are TRIGGER discs in open cavern, not walls — the space a fight
    // gets is the surrounding mass (measured >= 40 m of open floor around
    // every zone centre in the soak), so the 3-dash rule is already satisfied
    // by the cavern itself and this radius only sets how far the aggro reaches.
    zoneRadius: 10,                 // encounter trigger disc radius, metres
    zoneSpacing: 16,                // min zone centre-to-centre, metres
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
    // No `cover` block on purpose: the cavern's cover IS the stalagmite field
    // above (spires at top 2.2-4.2 m block the 1.2 m caster line exactly like
    // the crawl's rubble), so a second placer here would double-dress it.
    enemies: 57,          // nominal = midpoint of GATES.C enemyBand [48, 66]
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

// How many alcove candidates get dressed at all (wall niche + furniture), and
// how many of those may carry a bookcase instead of a second pot. Exported
// and consumed by dungeon.js's own DRESS_LIMITS (its per-role draw-call
// backstop table) instead of duplicated there: this file already computes
// furniture in exactly this index window (see buildDecor's alcove block), so
// a drifted copy in dungeon.js could truncate the render at a DIFFERENT
// alcove than the one furniture was actually computed for.
export const ALCOVE_LIMITS = { count: 6, shelves: 3 };

function buildDecor(rooms, doors, wallRuns, params, rnd) {
  const torches = [];
  const columns = [];
  const props = [];
  const alcoves = [];

  // Torch sconces: along every wall run, one per ~torchSpacing metres, phase
  // jittered per run so parallel corridor walls alternate instead of pairing.
  const rawTorches = [];
  for (const run of wallRuns) {
    const len = Math.max(run.w, run.d);
    if (len < params.torchSpacing * 0.7) continue;
    const yaw = FACE_YAW[run.face];
    const along = run.w > run.d ? 'x' : 'z';
    let s = params.torchSpacing * (0.3 + rnd() * 0.4);
    for (; s < len; s += params.torchSpacing) {
      const t = s - len / 2;
      rawTorches.push({
        x: run.x + (along === 'x' ? t : 0),
        z: run.z + (along === 'z' ? t : 0),
        yaw,
      });
    }
  }
  // SPATIAL thinning, then a hard cap. Wave-3 rooms are ~5x the old area, so
  // the raw run-walk now yields 120+ sconces where it used to yield ~50 — and
  // the renderer's per-role cap took the FIRST n of them, which is scan order
  // (every n-face run, then s, then e, then w). That put every sconce in one
  // band of the dungeon and left whole rooms with none, which matters because
  // the sconce anchors are what the 2-light pool retargets to: no anchor in
  // the room means the room is lit by fill alone. Greedy min-gap keeps the
  // survivors spread over the whole floor plan instead, and the even-stride
  // backstop below preserves that spread if the cap still bites.
  const gap2 = (params.torchMinGap || 0) ** 2;
  for (const t of rawTorches) {
    let clear = true;
    for (const k of torches) {
      if ((t.x - k.x) ** 2 + (t.z - k.z) ** 2 < gap2) { clear = false; break; }
    }
    if (clear) torches.push(t);
  }
  const cap = params.torchCap || 0;
  if (cap > 0 && torches.length > cap) {
    const strided = [];
    for (let i = 0; i < cap; i++) strided.push(torches[Math.floor((i * torches.length) / cap)]);
    torches.length = 0;
    torches.push(...strided);
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

  // Alcoves (D+): midpoints of long room walls, each dressed with furniture
  // whose kind, position AND collision footprint are decided HERE — this used
  // to be computed a second time at RENDER time (dungeon.js's old
  // _buildDressing, off its OWN rnd stream), which is exactly the
  // "two computation sites" trap COVER_KINDS/bossAnchor/exitAnchor exist to
  // avoid elsewhere in this file: a hand-duplicated copy of the offset math
  // is how a wall-mounted bookcase's REAL 2.1 x 0.72 m collision box could
  // exist without buildCover ever knowing to route cover around it (the
  // reported pillar+bookcase softlock). dungeon.js now only CONSUMES
  // `alcove.furniture` — see its _buildDressing alcove loop.
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
    // Only the first ALCOVE_LIMITS.count candidates are ever dressed at all —
    // dungeon.js truncates layout.decor.alcoves to the same number before it
    // even draws the wall-niche piece, a draw-call backstop (DRESS_LIMITS),
    // so furniture computed past it would never be seen. Furniture is decided
    // in that same index space so the two can never disagree about which
    // alcove is "alcove #0" — the shared constant IS the agreement.
    // Every OTHER alcove in that window (i % 2 === 0) gets a wall-mounted
    // bookcase — deterministic by index, not a roll — up to
    // ALCOVE_LIMITS.shelves; the rest get a second pot instead. Both branches
    // still burn rnd() calls (pot kind + yaw) so decorRnd's draw count from
    // this loop matches what the old render-time version consumed, seed for
    // seed within this file's own determinism contract.
    let shelves = 0;
    const dressCount = Math.min(alcoves.length, ALCOVE_LIMITS.count);
    for (let i = 0; i < dressCount; i++) {
      const a = alcoves[i];
      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      const rx = Math.cos(a.yaw);     // local +X after rotation.y = yaw
      const rz = -Math.sin(a.yaw);
      const furniture = [];
      // Anchor sits on the room boundary; pots flank it at +-2.5 m along the
      // wall, 0.62 m proud of the wall's inner face (matches the niche's own
      // 0.34 m nudge plus the pot's own radius).
      const potSide = (s) => {
        const px = a.x + rx * s * 2.5 + fx * 0.62;
        const pz = a.z + rz * s * 2.5 + fz * 0.62;
        furniture.push({
          kind: rnd() < 0.5 ? 'potA' : 'potB',
          x: px,
          z: pz,
          yaw: rnd() * Math.PI * 2,
          collision: { shape: 'circle', r: 0.3, top: 0.4 },
        });
      };
      potSide(-1);
      if (i % 2 === 0 && shelves < ALCOVE_LIMITS.shelves) {
        shelves++;
        const bx = a.x + rx * 3.1 + fx * 0.68;
        const bz = a.z + rz * 3.1 + fz * 0.68;
        // Axis-aligned by construction (alcove yaws are cardinal): span
        // along the wall, honest top so bodies bump and bolts clear. This IS
        // the box buildCover's connectivity guarantee now sees.
        const alongX = Math.abs(rx) > 0.5;
        furniture.push({
          kind: 'bookcase',
          x: bx,
          z: bz,
          yaw: a.yaw,
          collision: {
            shape: 'box',
            w: alongX ? 2.1 : 0.72,
            d: alongX ? 0.72 : 2.1,
            top: 2.63,
          },
        });
      } else {
        potSide(1);
      }
      a.furniture = furniture;
    }
  }

  // crystals/stalagmites are the cavern kind's slots, cover is filled by
  // buildCover off its own stream — empty here so every consumer sees one
  // decor shape regardless of kind.
  return { torches, columns, props, alcoves, crystals: [], stalagmites: [], cover: [] };
}

// ---------------------------------------------------------------------------
// INTERIOR COVER — what makes a big room a fight instead of a walk.
// ---------------------------------------------------------------------------
// Wave 3 grew the rooms ~5.5x (see the DASH UNITS block at the top) because the
// owner wanted dashing and dodging to mean something, "especially for the boss
// room". Growing them alone did not deliver that. buildDecor above only ever
// puts columns at the four room CORNERS, so a 38 x 38 m E boss chamber measured
// 0 blocked cells out of 1296 on a 1 m grid at chest height, and 0 of 1500
// random sightlines blocked, on every seed probed. An empty box is not an
// arena: there is nothing to break line of sight on and nothing to dodge
// behind, only more floor to cross.
//
// So every non-entry room now carries a seed-derived INTERIOR cover field,
// generated here as pure numbers and rendered + registered by dungeon.js
// _buildDressing. Three rules decide every constant below.
//
//   (a) COVER MUST BREAK LINE OF SIGHT AT THE HEIGHT BOLTS ACTUALLY FLY.
//       Every projectile in the game travels in one horizontal plane at
//       config.js PROJECTILE_Y (1.6 m) — see the BOLT PLANE block there — so a
//       piece is only cover if its collision `top` clears it. COVER_MIN_TOP
//       below is that rule as a number, and tools/dungeon-gen-test.mjs asserts
//       every kind against it AND probes the built field's lineBlocked at
//       exactly PROJECTILE_Y.
//       This was the first pass's second hole: the field was designed and
//       verified at feetY 1.2 while the boss fired from 2.4. rubble's top is
//       1.75 — measured across one pile at 4.2 m each side, lineBlocked was
//       TRUE at 1.2 and FALSE at 2.2 — so a third of the boss chamber's cover
//       would still not have stopped a boss bolt even once the hit test was
//       fixed. One plane, one number, one assert.
//       Kerb-height clutter (crates/pots at top 0.4) deliberately does not
//       clear it — which is precisely why the existing prop clusters never
//       registered as cover at all.
//   (b) COVER MUST LEAVE DASH LANES. dash = 7.5 m. `lane` is the guaranteed
//       clear floor between any two pieces' world-aligned footprints; at 3.0 m
//       the tightest gap in a room is ~6 body widths and 40% of a dash. With
//       `wallInset` holding every piece 3.2 m off the walls, an unbroken
//       perimeter ring survives in every room, so no roll can seal one. That
//       is asserted, not assumed: tools/dungeon-gen-test.mjs flood-fills the
//       real ObstacleField at body radius and requires 100% of each room's
//       walkable floor to be one connected component.
//   (c) COVER MUST NOT LAND ON WHAT THE GAME PUTS THERE LATER: door
//       approaches, spawn points, the treasure chest, the boss's rise anchor,
//       the exit portal. Each has a named clearance in params.cover.
// Exported: dungeon.js _buildCover registers collision straight off this table
// and tools/ probe it, so the footprint a test measures is the footprint the
// player collides with — there is exactly one copy of these numbers.
// Rule (a) as a number. A cover piece's collision `top` must clear the bolt
// plane with margin: 1.6 + 0.1 = 1.7 m. The 0.1 m is not decoration — bolts are
// a 0.3 m icosahedron tested at radius 0.25, so a piece whose top landed
// exactly on the plane would clip bolts through its upper rim. rubble at 1.75
// is the tightest kind and clears it by 5 cm; anything new that does not clear
// COVER_MIN_TOP is scenery, not cover, and dungeon-gen-test fails it.
export const COVER_MIN_TOP = PROJECTILE_Y + 0.1;

export const COVER_KINDS = {
  // Collision footprint half-extents in the piece's LOCAL frame (x = long
  // axis) plus the collision top, sized from public/models/dungeonkit.json:
  //   pillar  dungeon_pillar        0.75 x 2.00 x 0.75 (136 tris), drawn to
  //           4 m via dungeon.js COLUMN_HEIGHT — full-height, always blocks
  //   rubble  dungeon_rubble_large  4.06 x 1.75 x 1.59 (788 tris) — the
  //           collapsed-wall pile; at 194 tris per metre of cover it is the
  //           cheapest line-of-sight blocker in the kit, so it carries the
  //           bulk of the field
  //   stub    dungeon_wall_broken   2.00 x 2.00 x 0.50 (784 tris) — a standing
  //           fragment of wall; only the boss colonnade uses it
  // Every footprint is held just inside its model so a body never visibly
  // clips the mesh it is hiding behind.
  // 0.38 = the pillar's 0.375 m model half-width rounded up a hair, so a body
  // stops a few millimetres short instead of visibly clipping the mesh.
  pillar: { shape: 'circle', hx: 0.38, hz: 0.38, r: 0.38, top: Infinity },
  rubble: { shape: 'box', hx: 1.95, hz: 0.75, top: 1.75, sx: 1, sy: 1, sz: 1 },
  // The stub is STRETCHED, and the footprint below already includes it.
  // dungeon_wall_broken is authored to the kit's 2 m storey; dropped 1:1 into a
  // 38 m chamber under 4 m walls it read as a crate on the eye-level frame, not
  // as the fragment of a wall that used to enclose the dais. 1.8 x 1.4 makes it
  // 3.6 m wide and 2.8 m tall, which reads as ruined architecture from both the
  // aerial and the player's camera. It costs nothing: same InstancedMesh, same
  // 784 triangles, just a bigger matrix. Collision follows the visual —
  // hx = 0.95 * 1.8 = 1.71 (held at 1.70), top = 2.0 * 1.4 = 2.8 — and depth is
  // left at 1 so it stays a wall rather than becoming a block.
  stub: { shape: 'box', hx: 1.70, hz: 0.25, top: 2.8, sx: 1.8, sy: 1.4, sz: 1 },
};

/**
 * The boss's rise anchor: the chamber centre pushed a quarter of the room away
 * from its door, so the rise reads from the entrance.
 *
 * Exported because TWO callers need the byte-identical point — Dungeon.bossSpawn
 * places the boss on it at runtime, and buildCover below must keep it clear of
 * scenery. Two copies of this formula would drift the first time either was
 * tuned, and the symptom would be a boss rising inside a pillar.
 * @returns {{x:number,z:number,dx:number,dz:number}} dx/dz = unit door->centre
 */
export function bossAnchor(room, door) {
  const c = room.centre;
  let dx = 0;
  let dz = -1;
  if (door) {
    dx = c.x - door.x;
    dz = c.z - door.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
  }
  return {
    x: Math.min(room.x + room.w - 1.5, Math.max(room.x + 1.5, c.x + dx * room.w * 0.25)),
    z: Math.min(room.z + room.d - 1.5, Math.max(room.z + 1.5, c.z + dz * room.d * 0.25)),
    dx,
    dz,
  };
}

/** Same contract for the walk-out exit portal: further along the same axis. */
export function exitAnchor(room, door) {
  const c = room.centre;
  const { dx, dz } = bossAnchor(room, door);
  return {
    x: Math.min(room.x + room.w - 2.2, Math.max(room.x + 2.2, c.x + dx * room.w * 0.42)),
    z: Math.min(room.z + room.d - 2.2, Math.max(room.z + 2.2, c.z + dz * room.d * 0.42)),
    dx,
    dz,
  };
}

// ---------------------------------------------------------------------------
// CONNECTIVITY GUARANTEE — the pillar+bookcase softlock fix.
// ---------------------------------------------------------------------------
// buildCover's clearance rules (wallInset/doorClear/lane/keepOut, above) only
// ever look at OTHER COVER. They have no idea buildDecor also put a column at
// every room corner, prop clusters near them, and — on D — a wall-mounted
// bookcase whose REAL collision box (dungeon.js _buildDressing) is 2.1 m wide
// and sticks 0.72 m off the wall. A pillar placed in good faith 3.0 m (the
// dash lane) from where a bookcase would later land can still, TOGETHER with
// that bookcase, narrow a corridor-to-room passage below body width — that is
// the exact softlock a player reported: no single system did anything wrong,
// and no single system could see the joint effect.
//
// So this is the one place that CAN see it: after a room's cover is placed,
// verify the REAL combined obstacle picture — walls, doors, every decor
// column/prop/alcove furniture piece, and the room's own just-placed cover —
// against the one invariant that actually matters here (every door in the
// room stays reachable from its open floor), and prune the newest non-anchor
// piece nearest any door the field cuts off until it is fixed. Same idiom as
// the spawn-point prune a few lines below: place first, then prune to restore
// the invariant, rather than trying to predict every joint interaction up
// front.
//
// The flood-fill and the field it runs over are deliberately the SAME shape
// tools/dungeon-gen-test.mjs's own regression check uses (floodFillRoom /
// doorReachableFrom are exported and imported there, not reimplemented) —
// two copies of a reachability algorithm is how a soak test quietly stops
// meaning what it claims to.

/** Player/enemy collision radius the connectivity guarantee is sized to —
 * shared with its regression test so the two can never disagree about what
 * "fits through a gap" means. Matches the body radius physics.js resolves. */
export const NAV_BODY_RADIUS = 0.45;
/** Flood-fill lattice pitch, metres — ditto. */
export const NAV_FILL_STEP = 0.5;

const FLOOD_NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Open-cell flood fill of `room` from its centre-most open cell, over a REAL
 * ObstacleField (or anything duck-typed to its `.blocked(x,z,r,stepOver,feetY)`
 * — buildCover's per-room check below composes two fields without paying to
 * rebuild the static one every room, so it hands in a plain object here, not
 * always a true ObstacleField instance).
 *
 * feetY 0 / stepOver 0.4: what a BODY can stand in, matching physics.js — kerb
 * -height rubble is walkable, a cover piece or a bookcase is not.
 * @returns {{nx:number,nz:number,open:Uint8Array,seen:Uint8Array,reached:number,total:number}}
 */
export function floodFillRoom(field, room, { bodyRadius = NAV_BODY_RADIUS, fillStep = NAV_FILL_STEP } = {}) {
  const nx = Math.round(room.w / fillStep);
  const nz = Math.round(room.d / fillStep);
  const open = new Uint8Array(nx * nz);
  let total = 0;
  let seed = -1;
  let seedD = Infinity;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = room.x + (i + 0.5) * fillStep;
      const z = room.z + (j + 0.5) * fillStep;
      if (field.blocked(x, z, bodyRadius, 0.4, 0)) continue;
      open[i + j * nx] = 1;
      total++;
      const d = Math.hypot(x - room.centre.x, z - room.centre.z);
      if (d < seedD) { seedD = d; seed = i + j * nx; }
    }
  }
  const seen = new Uint8Array(nx * nz);
  if (seed < 0) return { nx, nz, open, seen, reached: 0, total };
  seen[seed] = 1;
  const q = [seed];
  for (let qi = 0; qi < q.length; qi++) {
    const ci = q[qi] % nx;
    const cj = (q[qi] / nx) | 0;
    for (const [dx, dz] of FLOOD_NEIGHBOURS) {
      const ni = ci + dx;
      const nj = cj + dz;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const k = ni + nj * nx;
      if (!open[k] || seen[k]) continue;
      seen[k] = 1;
      q.push(k);
    }
  }
  return { nx, nz, open, seen, reached: q.length, total };
}

// A door sits ON the room's boundary — outside floodFillRoom's cell-centre
// lattice — so reachability is sampled a little way into the room along the
// door->centre direction, at a few insets rather than one: a single sample
// can straddle the lattice cell a wall corner's rounding shades into `open`.
const DOOR_REACH_INSETS = [0.8, 1.3, 2.0, 3.0];

/** True if `door` is reachable from a floodFillRoom() result for `room`. */
export function doorReachableFrom(fill, room, door, fillStep = NAV_FILL_STEP) {
  const dx0 = room.centre.x - door.x;
  const dz0 = room.centre.z - door.z;
  const len = Math.hypot(dx0, dz0) || 1;
  const ux = dx0 / len;
  const uz = dz0 / len;
  for (const inset of DOOR_REACH_INSETS) {
    const x = door.x + ux * inset;
    const z = door.z + uz * inset;
    const i = Math.floor((x - room.x) / fillStep);
    const j = Math.floor((z - room.z) / fillStep);
    if (i < 0 || j < 0 || i >= fill.nx || j >= fill.nz) continue;
    if (fill.seen[i + j * fill.nx]) return true;
  }
  return false;
}

/**
 * The static half of the connectivity field — everything buildCover does NOT
 * control and that does not change while it places one room's cover: walls,
 * every door registered OPEN (a sealed door is not what "can I walk this
 * room" is asking), and every decor column/prop/alcove-furniture piece.
 * Built ONCE per buildCover() call and reused across every room and every
 * prune retry, so the per-room check cost is the small cover-only field
 * below, not a walk of the whole layout's decor every time.
 */
function buildStaticConnectivityField(wallRuns, doors, decor) {
  const f = new ObstacleField({ stepOver: 0.4 });
  for (const run of wallRuns) f.addBox(run.x, run.z, run.w, run.d, run.rot, { tag: 'wall', nav: false });
  for (const d of doors) f.addBox(d.x, d.z, d.w, d.d, d.rot, { top: 0, nav: false, tag: 'membrane' });
  for (const c of decor.columns) f.addCircle(c.x, c.z, 0.34, { nav: false, tag: 'column' });
  for (const p of decor.props) {
    // Matches dungeon.js _buildDressing's registration exactly. statue/candles
    // carry no collision there either (the shrine's real position also
    // depends on its room's door, computed only at render time — approximating
    // it here would be a second, divergence-prone copy of _placeShrine's
    // math for a piece that already sits inside its OWN wide centreClear
    // keep-out, so it cannot be the thing that pinches a doorway).
    if (p.kind === 'crate') f.addCircle(p.x, p.z, 0.4, { top: 0.4, nav: false, tag: 'prop' });
    else if (p.kind === 'barrel') f.addCircle(p.x, p.z, 0.4, { top: 1.05, nav: false, tag: 'prop' });
    else if (p.kind === 'pot') f.addCircle(p.x, p.z, 0.3, { top: 0.4, nav: false, tag: 'prop' });
  }
  for (const a of decor.alcoves) {
    for (const item of a.furniture || []) {
      if (item.collision.shape === 'circle') {
        f.addCircle(item.x, item.z, item.collision.r, { top: item.collision.top, nav: false, tag: 'prop' });
      } else {
        f.addBox(item.x, item.z, item.collision.w, item.collision.d, 0, { top: item.collision.top, nav: false, tag: 'prop' });
      }
    }
  }
  return f.build();
}

/** The small, cheap-to-rebuild half: one room's OWN cover candidates. */
function buildRoomCoverField(roomCover) {
  const f = new ObstacleField({ stepOver: 0.4 });
  for (const c of roomCover) {
    const k = COVER_KINDS[c.kind];
    if (k.shape === 'circle') f.addCircle(c.x, c.z, k.r, { nav: false, tag: 'cover' });
    else f.addBox(c.x, c.z, k.hx * 2, k.hz * 2, c.yaw, { top: k.top, nav: false, tag: 'cover' });
  }
  return f.build();
}

const CONN_PRUNE_CAP = 16;

/**
 * Verify every one of `room`'s doors is reachable from its open floor over
 * the REAL combined obstacle picture, and prune `placed`/`out` (in place, by
 * reference) until it holds or the iteration cap is hit. Bounded, not
 * recursive, and never throws: the safety margins buildCover's clearance
 * rules already enforce (wallInset, doorClear, lane) make an actual failure
 * here exceedingly rare, and a dungeon that ships with one door slightly
 * over-cautiously stripped of cover is a far better failure mode than a
 * generator that can hang or crash.
 */
function enforceRoomDoorReachability(room, roomDoors, staticField, placed, out) {
  // A door blocked by the STATIC field (walls, columns, decor props, alcove
  // furniture — none of which this function can touch) can never be fixed by
  // pruning this room's own cover: cover only ADDS obstacles, so removing all
  // of it is a strict upper bound on what pruning can reach. Check that
  // cover-free baseline once, up front, so the loop below never burns its
  // budget stripping every non-anchor piece for a door pruning was never
  // going to unblock (see prune-loop docstring below).
  const staticFill = floodFillRoom(staticField, room);
  const unfixable = roomDoors.filter((d) => !doorReachableFrom(staticFill, room, d));
  if (unfixable.length) {
    // eslint-disable-next-line no-console
    console.warn(`buildCover: room ${room.id} door(s) ${unfixable.map((d) => d.id).join(',')} `
      + 'unreachable from the static field alone (walls/decor, not this room\'s '
      + 'cover) — pruning cover cannot fix this, leaving cover as-is');
  }
  const fixableDoors = unfixable.length ? roomDoors.filter((d) => !unfixable.includes(d)) : roomDoors;
  if (!fixableDoors.length) return;   // nothing pruning could possibly help

  for (let iter = 0; iter <= CONN_PRUNE_CAP; iter++) {
    const coverField = buildRoomCoverField(placed);
    const combined = {
      blocked: (x, z, r, stepOver, feetY) => (
        staticField.blocked(x, z, r, stepOver, feetY) || coverField.blocked(x, z, r, stepOver, feetY)
      ),
    };
    const fill = floodFillRoom(combined, room);
    const blockedDoor = fixableDoors.find((d) => !doorReachableFrom(fill, room, d));
    if (!blockedDoor) return;   // every fixable door reachable — the common case

    if (iter === CONN_PRUNE_CAP) {
      // Never infinite-loop: log and leave the room as-is. See the docstring
      // above for why this should not be reachable in practice.
      // eslint-disable-next-line no-console
      console.warn(`buildCover: room ${room.id} door ${blockedDoor.id} still `
        + `unreachable after ${CONN_PRUNE_CAP} prunes — leaving it as-is`);
      return;
    }

    // `anchor` pieces (the boss colonnade + debris arc) are never pruned —
    // they are the guaranteed heavy cover the kite loop is built from (see
    // the rubble-cap downgrade note above, same rule). Among the rest, drop
    // whichever sits nearest the blocked door; ties favour the most recently
    // placed (later in `placed`), since it is the newer piece that broke an
    // invariant an earlier one already satisfied.
    const candidates = placed.filter((p) => !p.anchor);
    if (!candidates.length) {
      // eslint-disable-next-line no-console
      console.warn(`buildCover: room ${room.id} door ${blockedDoor.id} unreachable `
        + 'but every remaining piece is an anchor — leaving it as-is');
      return;
    }
    let victim = candidates[0];
    let victimD = Math.hypot(victim.x - blockedDoor.x, victim.z - blockedDoor.z);
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      const d = Math.hypot(c.x - blockedDoor.x, c.z - blockedDoor.z);
      if (d <= victimD) { victim = c; victimD = d; }
    }
    const pi = placed.indexOf(victim);
    if (pi >= 0) placed.splice(pi, 1);
    const oi = out.indexOf(victim);
    if (oi >= 0) out.splice(oi, 1);
  }
}

/**
 * Build the interior cover field. coverRnd ONLY.
 * @param {Array} wallRuns layout.wallRuns — the connectivity guarantee's walls
 * @param {object} decor buildDecor's full output — columns/props/alcoves feed
 *   the same guarantee (see CONNECTIVITY GUARANTEE above)
 * @returns {Array<{x,z,yaw,kind,room,ex,ez}>} world metres; ex/ez are the
 *   world-aligned footprint half-extents dungeon.js registers collision from.
 */
function buildCover(rooms, doors, wallRuns, decor, params, rnd, bossRoomId) {
  const cfg = params.cover;
  const out = [];
  if (!cfg) return out;

  // World-aligned AABB half-extents of a yawed rect — the same
  // |hx·cos| + |hz·sin| bound ObstacleField.build() computes. It over-estimates
  // a diagonally yawed piece, and over-estimating can only WIDEN a lane, so
  // the conservative direction is the safe one here.
  const extents = (kind, yaw) => {
    const k = COVER_KINDS[kind];
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    return { ex: k.hx * c + k.hz * s, ez: k.hx * s + k.hz * c };
  };

  // See CONNECTIVITY GUARANTEE above. Built once, off walls/doors/decor —
  // none of which change while this function places cover — and reused by
  // every room's check below.
  const staticField = buildStaticConnectivityField(wallRuns, doors, decor);

  for (const r of rooms) {
    // The entry room is a deploy pad, not a fight room — the escort spawns
    // there on arrival and the auto-walk intro crosses it. Keep it empty.
    if (r.kind === 'entry') continue;
    const isBoss = r.id === bossRoomId;
    const placed = [];
    const myDoors = r.doors.map((id) => doors[id]).filter(Boolean);
    // Named keep-outs: points the GAME will occupy later, which the placer has
    // no other way to know about.
    const keepOut = [];
    if (isBoss) {
      const a = bossAnchor(r, myDoors[0] || null);
      const e = exitAnchor(r, myDoors[0] || null);
      keepOut.push({ x: a.x, z: a.z, r: cfg.bossClear });
      keepOut.push({ x: e.x, z: e.z, r: cfg.exitClear });
    }
    if (r.kind === 'treasure') {
      // encounters.js raises the weapon chest on the room centre and
      // _placeShrine puts the statue up to 1.8 m off it.
      keepOut.push({ x: r.centre.x, z: r.centre.z, r: cfg.centreClear });
    }
    // The boss chamber's dais: nothing but the colonnade itself inside this
    // radius, so the fight always opens on clean floor.
    const ringR = isBoss ? cfg.ringFrac * Math.min(r.w, r.d) * 0.5 : 0;

    const tryPut = (x, z, yaw, kind, onRing = false) => {
      const { ex, ez } = extents(kind, yaw);
      // (b) perimeter ring: the footprint stays wallInset off every room wall.
      if (x - ex < r.x + cfg.wallInset || x + ex > r.x + r.w - cfg.wallInset) return false;
      if (z - ez < r.z + cfg.wallInset || z + ez > r.z + r.d - cfg.wallInset) return false;
      // (c) door approach lanes — a piece parked in a doorway is a soft lock
      // for a pack routed through it by the flow field.
      const reach = Math.max(ex, ez);
      for (const d of myDoors) {
        if (Math.hypot(x - d.x, z - d.z) < cfg.doorClear + reach) return false;
      }
      // NOTE ON SPAWN POINTS. They are deliberately NOT a rejection test here.
      // spawnPointsFor emits every open cell thinned to 2.4 m, so a 38 x 38 m
      // boss chamber carries 110 of them — they blanket the floor, and treating
      // each as a keep-out rejected 100% of candidates (measured: 1 piece over
      // the whole E dungeon). They are a menu, not a set of fixed anchors. The
      // invariant that actually matters — no enemy ever rises inside a rock —
      // is enforced the other way round, by PRUNING the menu after the field is
      // placed. See the prune pass at the end of this function.
      for (const k of keepOut) {
        if (Math.hypot(x - k.x, z - k.z) < k.r + reach) return false;
      }
      // The dais stays clear of scatter; ring pieces ARE the dais edge.
      if (ringR && !onRing && Math.hypot(x - r.centre.x, z - r.centre.z) < ringR + cfg.lane) return false;
      // (b) dash lanes between pieces.
      for (const q of placed) {
        if (Math.abs(q.x - x) < q.ex + ex + cfg.lane
          && Math.abs(q.z - z) < q.ez + ez + cfg.lane) return false;
      }
      // `anchor` marks the boss chamber's designed pieces (colonnade + debris
      // arc) as opposed to lattice scatter. The rubble cap below downgrades
      // scatter first, so a busy gate can never quietly turn the boss arena's
      // heavy cover into thin pillars — that arc IS the kite loop.
      const rec = { x, z, yaw, kind, room: r.id, ex, ez, anchor: onRing };
      placed.push(rec);
      out.push(rec);
      return true;
    };

    // --- boss chamber: a BROKEN COLONNADE ring, placed first ---------------
    // The identity beat. A ring of alternating standing pillars and collapsed
    // wall fragments at ringR draws the edge of a ruined rotunda around the
    // dais the floor shader already tints paler (dungeon.js BOSS_FLOOR_MIX):
    // the chamber reads as a place with a centre, and the ring gives the kite
    // loop a shape to run — dash out through a gap, circle the outside, come
    // back in through another. Slots are dropped on a roll (ringKeep), and the
    // keep-out around the boss's own rise anchor drops the slots nearest it as
    // a side effect, so the dais always opens toward where the boss stands up.
    if (isBoss && ringR > 0) {
      // Tangential yaw for a piece at polar angle `a`. THREE rotation.y = t
      // maps local +X to world (cos t, -sin t); the ring tangent at `a` is
      // (-sin a, cos a); solving gives t = -a - PI/2. Radial (t = a) would
      // make the fragments read as spokes instead of an enclosing wall.
      const tangent = (a) => -a - Math.PI / 2;
      const phase = rnd() * Math.PI * 2;
      for (let i = 0; i < cfg.ringSlots; i++) {
        const keep = rnd() < cfg.ringKeep;   // fixed roll count per slot
        const wobble = (rnd() - 0.5) * 0.9;  // metres, so no two rings match
        if (!keep) continue;
        const a = phase + (i / cfg.ringSlots) * Math.PI * 2;
        const rr = ringR + wobble;
        tryPut(r.centre.x + Math.cos(a) * rr, r.centre.z + Math.sin(a) * rr,
          tangent(a), i % 2 === 0 ? 'stub' : 'pillar', true);
      }
      // Outer debris arc: `quadSlots` rubble piles on a second, wider ring.
      // These are the boss chamber's guaranteed heavy cover — the ring itself
      // is half pillars, and a 0.76 m pillar is thin cover, so seeds whose
      // colonnade rolled pillar-heavy measured 18% of sightlines blocked
      // against 44% for rubble-heavy ones. A fixed outer arc removes that
      // lottery and is what actually gives the kite loop its shape: run the
      // annulus between colonnade and debris, cut back in through a gap.
      //
      // FIXUP 1 WIDENED IT, 4 -> 7 (E) / 5 -> 8 (D). Measured over 40
      // seeds/rank, the first pass left the boss chamber marginally WORSE
      // dressed per unit area than an ordinary combat room (E 1.68% of cells
      // blocked and 18.2% of 6-12 m sightlines stopped, against 1.83% / 20.4%
      // for a normal room) — it only had more pieces because it is bigger. In
      // the one room the ask named, that is backwards. The arc is the right
      // lever because it is the only cover the chamber is GUARANTEED: at E
      // seven piles on the quadR = 14.07 m circle sit 2*pi*14.07/7 = 12.6 m
      // apart, so a 3.9 m pile every 12.6 m of the kite annulus — close enough
      // that circling always crosses one, far enough that the 3.0 m dash lane
      // between neighbours is never the binding constraint. Cost is 3 extra
      // 788-tri piles on an InstancedMesh that already exists: +2,364
      // triangles, +0 draw calls.
      //   quadR = ringR + lane + rubble.hx
      //         E: 9.12 + 3.0 + 1.95 = 14.07, usable half 19 - 3.2 = 15.8
      //         D: 10.08 + 3.0 + 1.95 = 15.03, usable half 21 - 3.2 = 17.8
      // so a broadside pile clears the wall band at both ranks by ~1 m.
      const quadR = ringR + cfg.lane + COVER_KINDS.rubble.hx;
      const quadPhase = rnd() * Math.PI * 2;
      for (let i = 0; i < cfg.quadSlots; i++) {
        const wobble = (rnd() - 0.5) * 1.2;
        const a = quadPhase + (i / cfg.quadSlots) * Math.PI * 2;
        const rr = quadR + wobble;
        tryPut(r.centre.x + Math.cos(a) * rr, r.centre.z + Math.sin(a) * rr,
          tangent(a), 'rubble', true);
      }
    }

    // --- scatter: jittered lattice over the room's usable band -------------
    // Density scales with area by construction — the lattice is sized in
    // metres, so a 24 x 24 m E combat room offers 3 x 3 candidates and a
    // 38 x 38 m boss chamber offers 5 x 5, before the clearance rules bite.
    const usableW = r.w - 2 * cfg.wallInset;
    const usableD = r.d - 2 * cfg.wallInset;
    const nx = Math.max(1, Math.round(usableW / cfg.step));
    const nz = Math.max(1, Math.round(usableD / cfg.step));
    // A room narrower than two wall bands has no interior to scatter into.
    // Not reachable at the shipped sizes (the smallest combat room is 24 m
    // against a 6.4 m band) — but this only skips the SWEEP, never the spawn
    // prune below, because the boss ring may already have placed pieces.
    const sweep = (force) => {
      if (usableW <= 0 || usableD <= 0) return;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          // FIXED roll count per lattice point, drawn BEFORE any rejection —
          // the cavern stalagmite loop's rule. Otherwise tuning one clearance
          // shifts the stream for every later point in the room and the whole
          // dungeon re-dresses itself.
          const ox = (rnd() - 0.5) * 2 * cfg.jitter;
          const oz = (rnd() - 0.5) * 2 * cfg.jitter;
          const keep = rnd() < cfg.chance;
          const kindRoll = rnd();
          const yawRoll = rnd();
          if (!keep && !force) continue;
          const x = r.x + cfg.wallInset + (i + 0.5) * (usableW / nx) + ox;
          const z = r.z + cfg.wallInset + (j + 0.5) * (usableD / nz) + oz;
          // Quarter yaws only on the scatter: a 4 m rubble pile squared to the
          // architecture reads as a collapsed wall, at 30 degrees it reads as
          // a fallen log, and the AABB lane test is exact rather than
          // conservative.
          const yaw = Math.floor(yawRoll * 4) * (Math.PI / 2);
          tryPut(x, z, yaw, kindRoll < cfg.rubbleShare ? 'rubble' : 'pillar');
        }
      }
    };
    sweep(false);
    // Guaranteed floor. Over 200 seeds per rank, exactly one room in ~1100
    // rolled its entire lattice away and came out empty — a 24 x 24 m fight
    // room with nothing in it, which is the exact defect this system exists to
    // remove. A second sweep over the SAME lattice with the keep roll forced
    // fixes it; every clearance rule still applies, so a room can only stay
    // thin if geometry (not luck) says so. The branch is a pure function of
    // the first sweep's outcome, so determinism holds.
    if (placed.length < cfg.minPieces) sweep(true);

    // --- connectivity guarantee (see CONNECTIVITY GUARANTEE above) ---------
    // Verify every door THIS ROOM'S OWN WALL carries is still reachable over
    // the REAL combined obstacle picture, and prune the newest non-anchor
    // piece nearest any door the field cuts off. `myDoors` is filtered to
    // d.roomA === r.id (not used as-is): per the WALL-RUN/DOOR header comment
    // at the top of this file, a room's `.doors` list carries BOTH ends of
    // every corridor touching it — its OWN wall opening (roomA) and the FAR
    // room's opening at the corridor's other end (roomB) — and that far
    // opening can sit metres outside this room's own footprint entirely, so
    // testing it against THIS room's flood fill would fail for every room,
    // every seed, regardless of cover.
    //
    // Runs BEFORE the spawn-point prune below so that pass sees the FINAL
    // cover set, not one a later prune here would still shrink.
    const ownDoors = myDoors.filter((d) => d.roomA === r.id);
    if (placed.length && ownDoors.length) {
      enforceRoomDoorReachability(r, ownDoors, staticField, placed, out);
    }

    // --- prune the spawn menu ---------------------------------------------
    // Drop every spawn point the new field would rise an enemy inside of (or
    // flush against). This is the enforcement side of rule (c): the pieces go
    // where the room wants them, and the menu shrinks to what is still open.
    // It cannot starve a room — every piece is >= wallInset off the walls and
    // >= lane from its neighbours, so the perimeter ring alone holds dozens of
    // points, and dungeon-gen-test asserts the surviving count.
    if (placed.length) {
      r.spawnPoints = r.spawnPoints.filter((p) => !placed.some((q) => (
        Math.abs(p.x - q.x) < q.ex + cfg.spawnClear
        && Math.abs(p.z - q.z) < q.ez + cfg.spawnClear
      )));
    }
  }

  // --- render budget, enforced by DOWNGRADE not truncation -----------------
  // The 788-triangle rubble pile is the cover system's dominant render cost
  // (pillar 136, stub 784 but boss-ring-only so <= 6 per gate). Measured over
  // 400 seeds per rank the placer emits E <= 22 piles and D <= 30, and the
  // worst D gate measured 29,256 cover triangles on top of a 93.2k shell —
  // 122.5k against DUNGEON_SPEC's 130k, only 5.8% of headroom on a budget the
  // rest of the frame is already straining. rubbleCap 24 drops that worst case
  // to ~25.3k (each downgrade saves 788 - 136 = 652), i.e. ~118.6k / 8.8%.
  //
  // Overflow is turned into a PILLAR in the same slot, never deleted: a
  // pillar's footprint is strictly smaller than the rubble the placer already
  // validated there, so every clearance and dash lane still holds, and the
  // room keeps a line-of-sight blocker instead of losing one. Even-stride
  // selection is the torch cap's pattern above — it spreads the downgrades
  // over the whole floor plan rather than gutting whichever room happens to
  // sit last in scan order.
  //
  // ORDER MATTERS: scatter piles are downgraded before the boss chamber's own
  // colonnade/debris-arc pieces (`anchor`). Those are the guaranteed heavy
  // cover the kite loop is built from, and an even stride over the whole list
  // would have quietly turned some of them into 0.76 m pillars on exactly the
  // seeds that placed the most cover. Anchors are still eligible if scatter
  // alone cannot pay the cap — the render budget stays hard.
  const piles = out.filter((c) => c.kind === 'rubble');
  if (cfg.rubbleCap > 0 && piles.length > cfg.rubbleCap) {
    const drop = piles.length - cfg.rubbleCap;
    const scatter = piles.filter((c) => !c.anchor);
    const pool = scatter.concat(piles.filter((c) => c.anchor));
    // Even stride over the PREFERRED prefix (scatter), widened to `drop` when
    // scatter alone is too small to pay the cap. span >= drop always, so the
    // stride is >= 1 and no piece is selected twice.
    const span = Math.min(pool.length, Math.max(drop, scatter.length));
    for (let i = 0; i < drop; i++) {
      const c = pool[Math.min(pool.length - 1, Math.floor((i * span) / drop))];
      c.kind = 'pillar';
      c.ex = COVER_KINDS.pillar.hx;
      c.ez = COVER_KINDS.pillar.hz;
    }
  }
  return out;
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
  // Interior candidates need FIGHTING ROOM, not just floor under the trigger.
  // The old test was a 5x5 floor neighbourhood (2 cells = 4 m clear), and the
  // soak found zone centres with as little as 5 m of open floor to the nearest
  // rock — a "huge cavern" fight in a lobe you cannot dash out of. The test is
  // now a clear DISC: openR(rc) demands every floor cell within rc cells, so
  // rc = 6 cells gives 12 m in every direction = 24 m across = 3.2 dashes,
  // the same bar the crawl's rooms have to clear. Tiers relax to 5 then 4
  // cells only if the roll leaves too few candidates, so a cramped cavern
  // degrades instead of failing outright.
  const openR = (gx, gz, rc) => {
    const r2 = rc * rc;
    for (let dz = -rc; dz <= rc; dz++) {
      for (let dx = -rc; dx <= rc; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        if (!isFloor(gx + dx, gz + dz)) return false;
      }
    }
    return true;
  };
  const inNeck = (gx, gz) => gx >= neckRect.gx - 1 && gx < neckRect.gx + neckRect.gw + 1
    && gz >= neckRect.gz - 1 && gz < neckRect.gz + neckRect.gd + 1;
  const gatherCandidates = (clearRc) => {
    const out = [];
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const i = at(gx, gz);
        if (!mask[i] || bfs[i] < 0) continue;
        if (!openR(gx, gz, clearRc)) continue;
        if (inNeck(gx, gz)) continue;
        const cx = gx + 0.5;
        const cz = gz + 0.5;
        if (Math.hypot(cx - neck.ccx, cz - neck.ccz) < bossRc + zoneRc * 0.5) continue;
        if (Math.hypot(cx - entryC.cx, cz - entryC.cz) < entryRc + zoneRc * 0.6) continue;
        out.push({ gx, gz, d: bfs[i] });
      }
    }
    return out;
  };
  // Deterministic tier walk: strictest clearance that still leaves candidates
  // to spread over the depth range. `nz * 3` is the "enough to choose from"
  // bar — fewer than that and the spread loop just clusters.
  let candidates = [];
  for (const clearRc of [6, 5, 4]) {
    candidates = gatherCandidates(clearRc);
    if (candidates.length >= nz * 3) break;
  }
  candidates.sort((a, b) => a.d - b.d || (a.gx + a.gz * w) - (b.gx + b.gz * w));
  // Spread the zones over the WHOLE BFS depth range (the "BFS-farthest chain"):
  // evenly spaced depth targets, each filled by the spacing-respecting
  // candidate nearest its target — a plain greedy would cluster every zone at
  // the shallow end and leave the deep half of the cavern empty.
  const maxD = candidates.length ? candidates[candidates.length - 1].d : 0;
  let zones = [];
  for (let relax = 0; relax < 3 && zones.length < params.rooms[0]; relax++) {
    // The relax rungs may NOT fall below one zone radius: a zone centre inside
    // another zone's trigger disc makes membership depend on record order, and
    // the soak caught exactly that (two zones 8.2 m apart at radius 10) once
    // the stricter clearance filter started pushing rolls onto the low rung.
    const spacing = Math.max(zoneRc,
      (params.zoneSpacing / CELL) * (1 - relax * 0.25));
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

  // `cover` stays empty for C: the stalagmite field above IS the cavern's
  // cover (see the LAYOUT_PARAMS.C note), and every consumer reads one shape.
  return { torches: [], columns: [], props: [], alcoves: [], crystals, stalagmites, cover: [] };
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
    cover: (layout.decor.cover || []).length,
    coverByKind: (layout.decor.cover || []).reduce((m, c) => {
      m[c.kind] = (m[c.kind] || 0) + 1;
      return m;
    }, {}),
    meanRoomCentreZ: meanZ / layout.rooms.length,
    bounds: layout.bounds,
    radius: layout.radius,
  };
}
