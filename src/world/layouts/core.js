// Pure dungeon layout generation — DUNGEON_SPEC.json STEP 1.
//
// NO `import * as THREE`, no DOM: tools/dungeon-gen-test.mjs imports this (through ../dungeonlayout.js) in
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

// THREE-free, Node-importable (see obstacles.js's own header) — buildCover's
// connectivity guarantee below builds the same kind of real collision field
// dungeon.js registers at render time, so "is this room still walkable" is
// answered against what the player actually collides with, not against the
// placer's own bookkeeping.
import { ObstacleField } from '../obstacles.js';
// The ONE physical constant this generator shares with the sim: the height
// every projectile flies at. config.js is THREE-free and DOM-free (its header
// says so, and it imports only rng.js), so pulling it in keeps the plain-Node
// soak working while removing the duplicated 1.2 that let the cover field be
// designed for a height nothing fired at. See COVER_MIN_TOP below.
import { PROJECTILE_Y } from '../../game/config.js';
// The kind generators. core.js <-> crawl.js/cavern.js is a deliberate ESM
// cycle: the kind modules import the shared plumbing below, and generateLayout
// dispatches back into them. Safe because neither side reads the other's
// bindings at module-evaluation time — only inside function bodies, after all
// three modules have finished evaluating.
import { tryGenerate } from './crawl.js';
import { tryGenerateCavern } from './cavern.js';
import { tryGenerateTower } from './tower.js';
import { tryGenerateWaste } from './waste.js';
import { tryGenerateReach } from './reach.js';

// The waste's field helpers travel through this module (and the facade) so
// tools/dungeon-gen-test.mjs runs the SAME reachability code the generator's
// own route-waypoint guarantee runs — floodFillRoom's no-two-copies rule.
export {
  buildWasteField, wasteFieldFill, terrainHeightFn,
  TERRAIN_MAX_SLOPE, ROUTE_CORRIDOR_HALF, WASTE_FILL_STEP,
} from './waste.js';

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
  B: {
    kind: 'tower',                  // Wave E task E-B — THE ASCENT (tower.js)
    grid: 100,                      // 100 x 100 cells = 200 m; the folded
                                    // 4-6 floor chain needs the slack (see
                                    // TOWER_DIR_WEIGHTS in tower.js)
    floors: [4, 6],                 // stacked floors, entry at 0, boss on top
    // 3.0 m per floor, and the number is load-bearing three times over:
    //   ramps  rise/(len+1) <= 0.33 m per tread at rampLen 8-10, under the
    //          body's 0.4 m stepHeight — the stair climbs with zero physics;
    //   edges  a 3 m drop across the 0.9 m normal-sample span keeps the
    //          ground normal above the 0.55 slope limit, so standing at a
    //          parapet edge never flips the body into its sliding state;
    //   jumps  jump apex is ~1.9 m, so a drop is one-way without any gate.
    floorRise: 3.0,
    rooms: [3, 6],                  // combat-room band (entry + boss excluded)
    roomsPerFloor: [1, 2],          // per mid floor; fixed roll, clamped by
    maxCombat: 6,                   //   this cap so 6-floor rolls stay lean
    entrySize: { w: [6, 8], d: [5, 6] },
    roomSize: { w: [12, 15], d: [12, 14] },   // 24-30 x 24-28 m (3.2+ dashes)
    bossSize: { w: 21, d: 21 },               // 42 x 42 m (5.6 dashes), on top
    corridorWidths: [2, 3],         // flat, intra-floor corridors
    corridorLen: [2, 4],
    rampWidth: 2,                   // 4 m stair — the door-span floor
    rampLen: [8, 10],               // treads 0.27-0.33 m; see floorRise
    tunnelLen: [8, 10],
    loops: 0,                       // the ascent is a chain; gaps are the loop
    minBossDepth: 4,                // >= floors[0] hops entry -> boss
    wallHeight: 4,
    wallHeightLow: 2,
    torchSpacing: 7,
    torchMinGap: 11,
    torchCap: 40,
    propDensity: 'medium',
    alcoves: false,                 // the alcove niche math is flat-wall D
                                    // furniture; the tower's identity beat is
                                    // its parapets, not bone shelves
    treasure: { chance: 0.55, guaranteed: false },
    // Parapet gaps — tower.js's candidate scan + fixed-roll carve. `span` in
    // cells (4-6 m notches), `max` per gate.
    parapets: { chance: 0.8, span: [2, 3], max: 4 },
    // Consumed by dungeonmode.js off layout.params: a landing above minSpeed
    // costs maxHp * (landSpeed - minSpeed) * scale. minSpeed 13 clears the
    // tallest ordinary jump's landing (~11.5 m/s) with margin; a one-floor
    // drop lands ~14.5 (7.5% maxHp), a two-floor drop ~20.5 (37%).
    fallDamage: { minSpeed: 13, scale: 0.05 },
    fog: { near: 14, far: 48 },
    // D's cover field, one shade denser nowhere — the tower's rooms are the
    // same plateau rects, so the whole clearance/connectivity discipline
    // transfers unchanged; heights are stamped after placement (tower.js).
    cover: {
      step: 7.0,
      jitter: 1.8,
      chance: 0.66,
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
      quadSlots: 8,
      minPieces: 2,
      rubbleCap: 24,
    },
    // GATES.B carries no enemyBand yet (rollEnemyCount falls back to the flat
    // gate.enemies = 32); nominal mirrors that number under the same ONE rule
    // as the other ranks: move it in config.js, move it here in the same edit.
    enemies: 32,
  },
  A: {
    kind: 'waste',                  // Wave E task E-A — THE RIVEN WASTE (waste.js)
    grid: 68,                       // 68 x 68 cells = 136 m; the disc union
                                    // carves a ~120 m open field inside it
    discs: [5, 7],                  // few, VERY large discs = one lobed field
    discR: [20, 32],                // metres — cavern's chambers were 8-18
    sites: 3,                       // the marked route: 3 objective camps
    siteRadius: 11,                 // trigger disc, metres (the crawl's zone 10
                                    // + 1: camps are approached across open
                                    // ground, the pull can start a step early)
    siteSpacing: 26,                // min stop-to-stop, metres — a route leg
                                    // is 3+ dashes of open travel
    bossRadius: 12,                 // the final site's trigger disc
    tunnelLen: [8, 10],
    tunnelWidth: 3,                 // cells (6 m), the cavern's arrival mouth
    loops: 0,
    // depth = criticalPath.length - 1 = entry + 3 sites + boss = 4; the regen
    // loop in generateLayout treats anything shallower as a failed roll.
    minBossDepth: 4,
    wallHeight: 6,                  // the canyon rim — cavern enclosure rules,
    wallHeightLow: 6,               //   camera boom probe is the net (no low
                                    //   south walls on a landscape rim)
    fog: { near: 20, far: 78 },     // open air: far must clear a 26-40 m route
                                    // leg AND the far rim, or the compass
                                    // points into a grey card
    // Outcrop field — COVER_KINDS at landscape scale (buildWasteCover).
    cover: {
      step: 9.0,          // lattice pitch, m — sparser than a room's 7.0:
                          // landmarks, not furniture
      jitter: 2.4,
      chance: 0.5,
      rubbleShare: 0.5,   // collapsed-wall piles carry the bulk
      stubShare: 0.25,    // stretched wall fragments = the ruin silhouettes
      clusterChance: 0.35, // second leaning piece = a landmark cluster
      lane: 3.0,          // the dash-lane rule, unchanged — body-sized
      wallInset: 2.5,     // footprint to the rock rim, m
      siteClear: 7.0,     // camps fight on open floor; the site's own cover
                          // is the field AROUND the clearing
      roamClear: 2.2,     // an advance body never rises inside a rock
      spawnClear: 1.6,
      bossClear: 4.5,
      exitClear: 3.5,
      rubbleCap: 30,      // 788-tri budget guard, downgrade-not-delete
      maxPieces: 58,      // hard cap UNDER dungeon.js DRESS_LIMITS.cover (60)
                          // so the render truncation there can never bite and
                          // silently strip collision the soak measured
    },
    // Nominal mirrors GATES.A's flat enemies = 38 (no enemyBand yet), same
    // ONE rule as every rank: move it in config.js, move it here in the same
    // edit, or the soak tests a lighter waste than the one that ships.
    enemies: 38,
  },
  S: {
    kind: 'reach',                  // Wave E task E-S — ARCHON'S REACH (reach.js)
    grid: 126,                      // 126 x 126 cells = 252 m; the worst-case
                                    // straight-north chain (tunnel 11 + entry 6
                                    // + 3 x (causeway 16 + room) + summit 25)
                                    // is ~120 cells, so even an unfolded roll
                                    // fits with margin
    // The ascent's plateau heights, indexed by room level (entry, gauntlet 1,
    // gauntlet 2, summit). 5 m per climb over 13-16 cell causeways keeps every
    // tread at 0.29-0.36 m — under the body's 0.4 m stepHeight, the tower's
    // exact zero-new-physics contract at half again the tower's rise.
    levels: [0, 5, 10, 15],
    entrySize: { w: [6, 8], d: [5, 6] },
    roomSize: { w: [13, 16], d: [13, 15] },   // gauntlets 26-32 x 26-30 m
    summitSize: 25,                 // cells; the disc is carved inside (r 24 m)
    // THE COLLAPSING ARENA, as data. radii[0] = the full fight disc; each
    // later entry is a collapse ring dungeon.js pre-registers a barrier on
    // and the director seals when boss hp crosses the matching threshold.
    // The rings RETRACT on the boss's death (encounters.onBossDeath resets
    // the phase), so the walk-out portal — exitAnchor pushes 0.42 x 50 m =
    // 21 m off centre — always rises on live, reachable floor inside
    // radii[0]; the boss rise anchor (0.25 x 50 = 12.5 m) also sits inside
    // it. The soak asserts both.
    arenaRadii: [23, 17, 12],
    arenaThresholds: [0.66, 0.33],  // boss hp fractions, one per collapse ring
    causewayWidth: 4,               // cells (8 m) — the notch pass bites it
                                    // down to a guaranteed >= 2-cell path
    causewayLen: [13, 16],          // cells; treads 5/(len+1) = 0.29-0.36 m
    corridorWidths: [2, 3],         // unused by the chain (kept for tooling
                                    // that reads the row generically)
    corridorLen: [2, 5],
    tunnelLen: [9, 11],
    loops: 0,
    minBossDepth: 3,                // entry -> g1 -> g2 -> summit
    wallHeight: 4,
    wallHeightLow: 2,
    torchSpacing: 7,
    torchMinGap: 11,
    torchCap: 40,
    propDensity: 'none',            // the reach is bare stone and sky — its
                                    // identity is the ascent, not clutter, and
                                    // every clutter kind is +1 draw call the
                                    // S budget spends on the collapse rings
                                    // instead (see buildDecor's 'none' rung)
    alcoves: false,
    treasure: { chance: 0, guaranteed: false },  // linear chain: no off-path
                                                 // leaf to hide one in; the
                                                 // roll is still consumed
    // Causeway notches — reach.js's break pass. span/depth in cells; max per
    // gate. depth is re-capped at width - 2 so a path always survives.
    breaks: { chance: 0.7, span: [2, 4], depth: [1, 2], max: 6 },
    fog: { near: 16, far: 60 },     // far must clear the 44 m summit disc AND
                                    // a 32 m causeway leg from its gauntlet
    cover: {
      step: 7.0,
      jitter: 1.8,
      chance: 0.66,
      rubbleShare: 0.55,
      lane: 3.0,
      wallInset: 3.2,
      doorClear: 5.5,
      spawnClear: 1.6,
      centreClear: 3.4,
      bossClear: 4.5,
      exitClear: 3.5,
      ringFrac: 0.48,     // unused (summit skips the colonnade); kept so the
      ringSlots: 12,      //   row stays shape-compatible with the tooling
      ringKeep: 0.76,
      quadSlots: 8,
      minPieces: 2,
      rubbleCap: 24,
      // The summit's own broken ring (reach.js buildSummitRing): inside the
      // FINAL collapse radius, so the kite loop keeps cover in every phase.
      summitRingFrac: 0.62,
      summitRingSlots: 6,
      summitRingKeep: 0.85,
    },
    // GATES.S carries no enemyBand yet (rollEnemyCount falls back to the flat
    // gate.enemies = 46); nominal mirrors it under the same ONE rule as every
    // rank: move it in config.js, move it here in the same edit.
    enemies: 46,
  },
};

export const CELL = 2;
export const DOOR_THICKNESS = 1.2;   // membrane box depth, per spec generation step 6
const WALL_THICKNESS = 0.6;   // wall-run obstacle box depth, spec step 7
const REGEN_TRIES = 8;        // bounded retry — the counter is part of the
                              // derivation, so seed -> same retries -> same
                              // layout (spec generation step 5)

export function randint(rnd, lo, hi) {
  return lo + Math.floor(rnd() * (hi - lo + 1));
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
      : params.kind === 'tower' ? tryGenerateTower
        : params.kind === 'waste' ? tryGenerateWaste
          : params.kind === 'reach' ? tryGenerateReach
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

export function originHalf(lo, hi) { return (lo + hi + 1) / 2; }

// Floor-mask bbox inflated by the wall-run thickness, plus the bounding radius
// from origin — the same numbers both kinds hand the world contract.
export function boundsFromMask(mask, w, h, at, originX, originZ) {
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
// graph
// ---------------------------------------------------------------------------

export function adjacency(n, doors) {
  const adj = Array.from({ length: n }, () => []);
  for (const d of doors) {
    if (d.roomA < 0 || d.roomB < 0) continue;
    if (!adj[d.roomA].includes(d.roomB)) adj[d.roomA].push(d.roomB);
    if (!adj[d.roomB].includes(d.roomA)) adj[d.roomB].push(d.roomA);
  }
  return adj;
}

export function bfsDepths(adj, from) {
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

export function bfsPath(adj, from, to) {
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
export function pickTreasure(rooms, adj, criticalPath, treasure, rnd) {
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
export function buildWallRuns(mask, w, h, at, originX, originZ) {
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
// budgets
// ---------------------------------------------------------------------------

// gate.enemies split over combat rooms proportional to area (min 2 each),
// remainder to the last pre-boss room, exact-sum guaranteed — the HUD counter
// and _clearGate both trust spawned totals, so this cannot be off by one.
export function assignBudgets(rooms, criticalPath, enemies) {
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

export const FACE_YAW = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 };
const PROP_KINDS = ['pot', 'crate', 'barrel'];

// How many alcove candidates get dressed at all (wall niche + furniture), and
// how many of those may carry a bookcase instead of a second pot. Exported
// and consumed by dungeon.js's own DRESS_LIMITS (its per-role draw-call
// backstop table) instead of duplicated there: this file already computes
// furniture in exactly this index window (see buildDecor's alcove block), so
// a drifted copy in dungeon.js could truncate the render at a DIFFERENT
// alcove than the one furniture was actually computed for.
export const ALCOVE_LIMITS = { count: 6, shelves: 3 };

export function buildDecor(rooms, doors, wallRuns, params, rnd) {
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
  // statue + candles shrine at their centre instead of clutter. 'none' (the S
  // reach) skips clutter outright — each clutter KIND is its own render field
  // (+1 draw), and the reach's identity is bare wind-scoured stone; the
  // per-room keep roll is still consumed, so the stream contract holds.
  const clusterChance = params.propDensity === 'medium' ? 0.7
    : params.propDensity === 'none' ? 0 : 0.4;
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
export function buildCover(rooms, doors, wallRuns, decor, params, rnd, bossRoomId) {
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
