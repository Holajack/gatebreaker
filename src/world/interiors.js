import * as THREE from 'three';
import { KIT_CELL, KIT_STOREY, pieceGeometryColored, cityMaterials } from './citykit.js';
import { pointSegDistance, segRectDistance } from './layoutrules.js';

// ---------------------------------------------------------------------------
// INTERIORS — the five service buildings you can walk into
// ---------------------------------------------------------------------------
//
// WORLD_SPEC decision 4: interiors are geometrically FREE in this kit (walls are
// 0.2 m edge slabs, so every building in town is already hollow; open doorway
// pieces, floor planks and one-storey stairs all exist). What is NOT free is
// systemic — per-wall collision, a camera boom that follows you inside, and
// hiding the roof of the one building you are in. All three are incompatible
// with the global-InstancedMesh strategy the other ~87 buildings must keep for
// draw-call reasons: you cannot hide one instance's roof, and you cannot give
// one instance its own collision.
//
// So five buildings leave the instancing path and become their own merged
// meshes. Two meshes each:
//
//   <id>_shell   floor planks + ground-storey walls + interior dressing
//   <id>_cap     upper-storey walls + flat roof deck + parapet
//
// `cap` is ONE mesh rather than the spec's separate roof and upper-wall meshes
// because they hide together, always, and the difference is five permanent draw
// calls against a measured 12 of headroom under city-test's 220 ceiling. The
// spec's two handles (roofMeshes / upperMeshes) both point at it, so a caller
// written against the spec's shape still works.
//
// Merged, not instanced, for the same reason frontier.js stamps its POIs: a
// merged mesh has a TIGHT bounding sphere, so a building on the far side of
// town costs nothing at all, whereas a global InstancedMesh is drawn from
// everywhere. Ten tightly-culled meshes is cheaper in practice than the two or
// three extra global fields the same pieces would have added.
//
// NO NEW LIGHTS (spec decision 1, city.js decision 2). Interiors read because
// the cap is hidden while you are inside, which lets the key and hemi straight
// in, because the inner faces of the ground walls are painted 15 % darker so
// inside reads as inside, and because each interior carries a couple of warm
// quads on the city's OWN shared window material — so they ramp with the clock
// for one extra draw call across all five buildings and zero extra materials.

// Mirrors of city.js's own constants. Imported would be cleaner; city.js does
// not export them, and reaching across the (deliberate, documented) import
// cycle for four numbers is worse coupling than four numbers. frontier.js
// mirrors the same three for the same reason.
const WALL_HALF = 88;
const PLAZA_R = 26;
// The market street's stalls are placed unconditionally by city._buildProps —
// they do not test this.boxes — so a shop dropped on the market strip gets a
// stall standing in its front room. This is that strip, padded.
const MARKET_ZONE = { x0: -18, x1: 10, z0: 24, z1: 68 };
// city._layout places the spire FIRST, searching within 30 m of this point for
// a free 2x2. Blocking cells near it is how you get a town with no landmark and
// a failing validateLayout, so the plot search stays clear of it.
const SPIRE_KEEP = { x: 16, z: -38, r: 11 };
// Clearance from a street EDGE to a footprint. 1.5 m is a body's width plus
// slack: enough that the doorstep is not in the gutter, small enough that a
// shop still fronts its street.
const STREET_CLEAR = 1.5;
// The door cell carries no collision at all — a 2.0 m gap, not the spec's 1.6.
// Two reasons, both measured: a phone player steers with a thumb, and at 1.6 m
// the 0.6 m-radius body has +/-0.2 m of aim; and NavGrid.blockBox inflates every
// box by cell*0.707, so at 1.6 m the two wall segments' slack meets in the
// middle of the doorway and no navgrid at any resolution finds a way in.
const DOOR_GAP = 2.0;
// Wall slabs are 0.2 m thick and sit on the OUTER 0.2 m of the perimeter cell
// ring (piece-local x 0.8..1.0), so this is the collision thickness too.
const WALL_T = 0.2;

/**
 * The five. `prefer` is where the building WANTS to stand — the plot search
 * takes the nearest legal footprint to it, so a street or district constant
 * that moves later moves the building instead of burying it in a road.
 *
 * `cells` is [width, depth] in 2 m kit cells. The spec's minimum viable
 * interior is 3x2; the smallest here is 3x3 (a 5.6 x 5.6 m room).
 *
 * `interactables` are ids from city.js's INTERACTABLES that move INSIDE this
 * building, in door-relative room coordinates. The door itself never gets a
 * prompt — you walk in, which is the owner's literal ask.
 */
export const ENTERABLES = [
  {
    id: 'assay',
    name: 'THE ASSAY HALL',
    // West of the north avenue, opposite the spire: the avenue runs straight
    // through the Assay pad at x = 0, and the spire has claimed the east side.
    prefer: { x: -14, z: -41 },
    cells: [5, 4],
    style: 'civic',
    dressing: 'assay',
  },
  {
    id: 'ashworks',
    name: 'THE ASHWORKS',
    prefer: { x: 44, z: 13 },
    cells: [4, 4],
    style: 'stone',
    dressing: 'ashworks',
  },
  {
    id: 'exchange',
    name: 'THE EXCHANGE',
    // EAST of the market street, not on it — see MARKET_ZONE. The west side is
    // a 8.5 m slot between the market strip and the x = -32 cross street, which
    // no legal 8 m footprint fits into on the 2 m grid; asking for it anyway
    // slid the Exchange 40 m out of its own district before this was measured.
    prefer: { x: 17, z: 42 },
    cells: [4, 3],
    style: 'stone',
    dressing: 'exchange',
  },
  {
    id: 'tavern_row',
    // Deliberately generic. WORLD_SPEC's open question flags that the tavern is
    // the only NEW service this wave and that a proper name needs the owner's
    // sign-off; an unsigned-off name is harder to take back than no name.
    name: 'THE TAVERN',
    prefer: { x: -46, z: 11 },
    cells: [4, 3],
    style: 'timber',
    dressing: 'tavern',
  },
  {
    id: 'stash_annex',
    name: 'THE STASH',
    // West of the market street, facing the Exchange across it. 3x2 — the
    // spec's minimum viable footprint — because that slot is bounded by the
    // market strip, the x = -32 cross street AND the 58 m ring road, and the
    // 3x3 version failed the ring by 0.2 m and slid 30 m out of the district.
    prefer: { x: -22, z: 41 },
    cells: [3, 2],
    style: 'timber',
    dressing: 'stash',
  },
];

// Which kit pieces each style builds its walls from: [plain, window, doorway].
// Mirrors city._buildBuildings.wallKeys so an enterable reads as part of the
// same town, with the open doorway swapped in for the solid door piece.
const WALL_KEYS = {
  timber: ['town_wall_wood', 'town_wall_wood_window_shutters', 'town_wall_wood_doorway_square_wide'],
  stone: ['town_wall', 'town_wall_window_small', 'town_wall_doorway_square_wide'],
  civic: ['town_wall', 'town_wall_window_stone', 'town_wall_doorway_square_wide'],
};

/**
 * Interior dressing, in DOOR-RELATIVE room coordinates:
 *
 *   u  -1..1 across the room, left to right as you walk in
 *   v  -1..1 from the door wall (-1) to the back wall (+1)
 *   y  metres above the floor
 *   t  quarter-turns. t = 0 points the piece's local +X deeper into the room,
 *      which is also the direction a wall-mounted piece (banner) faces to hang
 *      on the back wall's inner face.
 *   r  collision radius; omitted means walk-through decoration
 *
 * Everything is authored relative to the door so the counter faces you as you
 * come in whichever way the plot search ends up orienting the building.
 */
const DRESSING = {
  assay: [
    // The contract counter, two benches long, across the room.
    { key: 'town_stall_bench', u: -0.22, v: 0.18, t: 0, r: 0.5 },
    { key: 'town_stall_bench', u: 0.22, v: 0.18, t: 0, r: 0.5 },
    { key: 'ruin_candles_1', u: 0.0, v: 0.18, y: 0.451 },
    { key: 'ruin_bookcase_empty', u: -0.55, v: 0.92, t: 0, r: 0.6 },
    { key: 'ruin_bookcase_empty', u: 0.55, v: 0.92, t: 0, r: 0.6 },
    // The Sealed Stair: it climbs INTO the back wall and stops, which is what
    // a sealed stair is. The 'trial' interactable stands at its foot.
    { key: 'town_stairs_wood', u: 0.0, v: 0.86, t: 0, r: 0.8 },
  ],
  ashworks: [
    { key: 'town_stall', u: 0.0, v: 0.55, t: 1, r: 0.7 },
    { key: 'ruin_barrel', u: -0.7, v: 0.72, r: 0.42 },
    { key: 'ruin_barrel', u: -0.7, v: 0.3, r: 0.42 },
    { key: 'ruin_crate', u: 0.72, v: 0.74, r: 0.45 },
    { key: 'ruin_crate', u: 0.72, v: 0.34, r: 0.45 },
    { key: 'ruin_crate', u: 0.72, v: 0.74, y: 0.81 },
    { key: 'town_banner_red', u: -0.35, v: 1.0, t: 0 },
    { key: 'town_banner_red', u: 0.35, v: 1.0, t: 0 },
  ],
  exchange: [
    { key: 'town_stall', u: 0.0, v: 0.42, t: 1, r: 0.7 },
    { key: 'ruin_crate', u: -0.72, v: 0.85, r: 0.45 },
    { key: 'ruin_crate', u: -0.72, v: 0.85, y: 0.81 },
    { key: 'ruin_crate', u: 0.72, v: 0.85, r: 0.45 },
    { key: 'ruin_pot1', u: 0.74, v: 0.2, r: 0.4 },
    { key: 'ruin_pot2', u: 0.74, v: -0.15 },
    { key: 'ruin_pot3', u: -0.74, v: 0.28 },
  ],
  tavern: [
    { key: 'town_stall_bench', u: -0.6, v: 0.5, t: 1, r: 0.5 },
    { key: 'town_stall_bench', u: -0.6, v: -0.1, t: 1, r: 0.5 },
    { key: 'town_stall_bench', u: 0.62, v: 0.5, t: 1, r: 0.5 },
    { key: 'town_stall_stool', u: -0.15, v: 0.36 },
    { key: 'town_stall_stool', u: 0.14, v: -0.05 },
    { key: 'ruin_barrel', u: 0.66, v: -0.3, r: 0.42 },
    { key: 'ruin_barrel', u: 0.66, v: 0.05, r: 0.42 },
    // The hearth alcove. A stone box against the back wall with a warm quad in
    // it — see `glow` below for why the flame is not a light.
    { key: 'town_stall', u: 0.0, v: 0.94, t: 0, r: 0.7 },
    { key: 'ruin_candles_1', u: -0.55, v: -0.62, y: 0.451 },
  ],
  stash: [
    { key: 'ruin_crate', u: -0.6, v: 0.6, r: 0.45 },
    { key: 'ruin_crate', u: -0.6, v: 0.6, y: 0.81 },
    { key: 'ruin_crate', u: 0.6, v: 0.62, r: 0.45 },
    { key: 'ruin_crate', u: 0.62, v: 0.05, r: 0.45 },
    { key: 'ruin_trapdoor', u: 0.0, v: 0.1 },
    { key: 'ruin_barrel', u: -0.62, v: -0.1, r: 0.42 },
  ],
};

/**
 * Warm quads inside each interior, in the same door-relative coordinates.
 *
 * These are NOT lights and never will be: NUM_POINT_LIGHTS is part of three's
 * program cache key and city.js decision 2 exists because this repo shipped
 * that bug once. They are extra instances handed to city._buildBuildings for
 * the town's OWN lit-window InstancedMesh (see glowLights()) — so they ramp
 * with the hour on applyDayState's existing single colour write, and they cost
 * ZERO extra draw calls, materials, geometries or shader programs. A private
 * InstancedMesh here was the first cut and it cost one permanent draw call and
 * one extra program for the same pixels.
 */
const GLOWS = {
  assay: [{ u: 0.0, v: 0.9, y: 1.45 }],
  ashworks: [{ u: 0.0, v: 0.95, y: 1.4 }],
  exchange: [{ u: 0.0, v: 0.95, y: 1.4 }],
  tavern: [{ u: 0.0, v: 0.9, y: 0.75 }, { u: 0.0, v: 0.9, y: 1.5 }],
  stash: [{ u: 0.0, v: 0.95, y: 1.4 }],
};

/**
 * Which city.interactables move inside which building, and where.
 *
 * The prompt has to be somewhere you can stand, so these sit in FRONT of the
 * furniture they belong to, not on top of it.
 */
const INSIDE_PROMPTS = {
  assay: [
    { id: 'assay', u: 0.0, v: -0.15, radius: 2.6 },
    { id: 'trial', u: 0.0, v: 0.55, radius: 1.8 },
  ],
  ashworks: [{ id: 'barracks', u: 0.0, v: 0.05, radius: 2.4 }],
  exchange: [{ id: 'exchange', u: 0.0, v: -0.05, radius: 2.4 }],
  stash_annex: [{ id: 'stash', u: 0.0, v: -0.3, radius: 2.0 }],
};

// Scratch. Nothing in this module allocates per frame; these exist so the build
// path does not either, which matters when a city rebuild is a mode transition.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

/** Yaw that rotates a piece's local +X onto (dx, dz). */
function yawFor(dx, dz) { return Math.atan2(-dz, dx); }

// The sub-floor under the plank boards.
//
// A wood tone, NOT near-black. town_planks leaves wide gaps between its boards
// and the first cut filled them with 0x3a2718, which made every interior read
// as duckboards over a pit — the gaps were more of the floor's area than the
// boards were. This is the boards' own colour taken down a stop, so the gaps
// read as the joint between planks, which is what they are.
const SUBFLOOR = 0x7a5230;

/** One vertex-coloured box, centred at (x, y, z), ready to merge. */
function paintedBox(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * Concatenate geometries into one buffer and DISPOSE the inputs. A local copy
 * of the same helper city.js and frontier.js each keep private, for the same
 * reason they do: exporting a build-time loop across a documented import cycle
 * buys nothing.
 */
function mergeAll(geos) {
  let total = 0, idxTotal = 0;
  for (const g of geos) {
    total += g.attributes.position.count;
    idxTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const idx = new Uint32Array(idxTotal);
  let vo = 0, io = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, vo * 3);
    else col.fill(1, vo * 3, (vo + cnt) * 3);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io++] = gi[i] + vo;
    } else {
      for (let i = 0; i < cnt; i++) idx[io++] = i + vo;
    }
    vo += cnt;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * Darken the INNER half of a wall slab, in piece-local space, before the piece
 * is placed.
 *
 * Every town_wall_* piece occupies local x 0.8..1.0 with +X pointing out of the
 * building, so x < 0.9 is the face you see from inside. Painting it 15 % darker
 * is the whole "inside reads as inside" budget: flat-shaded low-poly with no
 * new lights has no other lever, and a uniform tint over the whole piece would
 * darken the street facade too.
 */
function shadeInnerFace(g, mul) {
  const pos = g.attributes.position;
  const col = g.attributes.color;
  if (!col) return g;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getX(i) >= 0.9) continue;
    col.setXYZ(i, col.getX(i) * mul, col.getY(i) * mul, col.getZ(i) * mul);
  }
  col.needsUpdate = true;
  return g;
}

export class Interiors {
  /**
   * @param {import('./city.js').City} city the owner: its field, its streets,
   *   its boxes, its obstacles, its group.
   */
  constructor(city) {
    this.city = city;
    this.group = new THREE.Group();
    this.group.name = 'interiors';

    /** @type {Array<object>} one record per enterable that found a plot. */
    this.buildings = [];
    this.byId = new Map();
    this.planned = false;
    this.built = false;
    /** The id currently flagged as "the player is inside", or null. */
    this.insideId = null;

    this._ownedGeometries = [];
    this._reserved = [];      // the footprint boxes plan() put in city.boxes
    this._triangles = 0;
    this.shellMesh = null;    // the one merged shell for all five, see build()
    this.capMesh = null;      // the one merged cap; hiding is per draw GROUP
    this._capTotal = 0;
  }

  get triangles() { return this._triangles; }

  // ------------------------------------------------------------------- plan

  /**
   * Choose the five plots and RESERVE them.
   *
   * Must run after city.streets exists and the first field bake, and BEFORE
   * city._layout: the layout's occupancy grid asks blocksCell() so no
   * procedural building lands on top of a shop, and the reserved footprint
   * boxes go into city.boxes so _buildProps and _buildNature — which both test
   * city.boxes and neither of which knows this module exists — keep their
   * lanterns, hedges and trees out of the front room.
   *
   * The reservation is a SOLID footprint on purpose. build() swaps it for the
   * wall-run boxes with the door gap later, which is exactly the spec's
   * "replace the single footprint box with 4 wall-run boxes": for the whole
   * prop-placement pass the building is opaque, so nothing can be placed in a
   * room you cannot see into yet.
   */
  plan() {
    const city = this.city;
    for (const def of ENTERABLES) {
      const plot = this._findPlot(def);
      if (!plot) continue;                       // reported via stats, never thrown
      const b = this._record(def, plot);
      this.buildings.push(b);
      this.byId.set(b.id, b);
      const box = { x: b.cx, z: b.cz, w: b.w, d: b.d, rot: 0, interiorId: b.id, reserved: true };
      this._reserved.push(box);
      city.boxes.push(box);
    }
    this.planned = true;
    return this;
  }

  /**
   * Level the five plots, LAST, immediately before City.build's second bake().
   *
   * Order is the whole point and it cost a floor to learn: HeightField.bake
   * applies flats in insertion order as `v = lerp(v, target, w)`, so a flat
   * added later with any weight at all pulls an earlier one's result toward its
   * own target. The procedural buildings' pads are radius+feather discs up to
   * 13 m across and blocksCell only keeps their FOOTPRINTS 2 m clear, so a
   * neighbour's pad reaches well inside a shop and lifted the terrain up
   * through its floor — visible as ground poking through the planks.
   *
   * Radius is the half-DIAGONAL, not the half-width: a disc that covers a
   * rectangle's edges still leaves its corners in the feather band.
   */
  levelPlots() {
    for (const b of this.buildings) {
      this.city.field.addFlat({
        x: b.cx, z: b.cz,
        radius: Math.hypot(b.w, b.d) * 0.5 + 0.8,
        feather: 4,
        height: this.city.field.height(b.cx, b.cz),
      });
    }
    return this;
  }

  /**
   * Does a footprint stand on this kit cell? city._layout's pre-block loop asks
   * once per cell, which is why this is a rect test and not a search.
   */
  blocksCell(x, z) {
    for (const b of this.buildings) {
      // One cell of margin, matching _layout's own free()/mark() convention:
      // a procedural terrace flush against a shop's gable is a wall you cannot
      // walk between and a door that opens into brick.
      if (x >= b.x0 - KIT_CELL && x <= b.x1 + KIT_CELL
        && z >= b.z0 - KIT_CELL && z <= b.z1 + KIT_CELL) return true;
    }
    return false;
  }

  /** The nearest legal footprint to `def.prefer`, or null. */
  _findPlot(def) {
    const [wc, dc] = def.cells;
    // Search the kit grid outward from the preferred cell. Deterministic: no
    // rng at all, so the five plots are a function of the street plan and the
    // terrain, and a re-run of the same seed puts them in the same place.
    const pci = Math.round(def.prefer.x / KIT_CELL - (wc - 1) / 2);
    const pcj = Math.round(def.prefer.z / KIT_CELL - (dc - 1) / 2);
    const span = 12;                              // +/- 24 m of search
    let best = null, bestScore = Infinity;
    for (let dj = -span; dj <= span; dj++) {
      for (let di = -span; di <= span; di++) {
        const ci = pci + di, cj = pcj + dj;
        const cx = (ci + (wc - 1) / 2) * KIT_CELL;
        const cz = (cj + (dc - 1) / 2) * KIT_CELL;
        const score = Math.hypot(cx - def.prefer.x, cz - def.prefer.z);
        if (score >= bestScore) continue;         // cheap reject before the work
        if (!this._plotOk(ci, cj, wc, dc)) continue;
        bestScore = score;
        best = { ci, cj, wc, dc };
      }
    }
    return best;
  }

  _plotOk(ci, cj, wc, dc) {
    const city = this.city;
    const x0 = ci * KIT_CELL - KIT_CELL / 2;
    const x1 = (ci + wc - 1) * KIT_CELL + KIT_CELL / 2;
    const z0 = cj * KIT_CELL - KIT_CELL / 2;
    const z1 = (cj + dc - 1) * KIT_CELL + KIT_CELL / 2;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;

    // Inside the walls, with room for the wall's own collision runs.
    if (Math.min(x0, z0) < -(WALL_HALF - 8) || Math.max(x1, z1) > WALL_HALF - 8) return false;

    // Off the plaza and its pillar ring.
    if (Math.hypot(Math.max(Math.abs(cx) - (x1 - x0) / 2, 0),
      Math.max(Math.abs(cz) - (z1 - z0) / 2, 0)) < PLAZA_R + 6) return false;

    // Clear of every street by STREET_CLEAR beyond its half width.
    const rect = { x0, x1, z0, z1 };
    for (const s of city.streets) {
      if (segRectDistance(s.x1, s.z1, s.x2, s.z2, rect) < s.w + STREET_CLEAR) return false;
    }

    // Off the market strip — city._buildProps plants its stalls there without
    // consulting anything.
    if (x1 > MARKET_ZONE.x0 && x0 < MARKET_ZONE.x1
      && z1 > MARKET_ZONE.z0 && z0 < MARKET_ZONE.z1) return false;

    // Leave the spire its site.
    if (Math.hypot(cx - SPIRE_KEEP.x, cz - SPIRE_KEEP.z)
      < SPIRE_KEEP.r + Math.max(x1 - x0, z1 - z0) / 2) return false;

    // The two fountains, which _buildProps also places unconditionally.
    for (const f of [{ x: 0, z: 17.5 }, { x: -58, z: -12 }]) {
      if (f.x > x0 - 4 && f.x < x1 + 4 && f.z > z0 - 4 && f.z < z1 + 4) return false;
    }

    // Buildable ground, sampled at the centre and the four corners: a shop half
    // on a bank has a floor you can see daylight under.
    const pts = [[cx, cz], [x0, z0], [x1, z0], [x0, z1], [x1, z1]];
    let lo = Infinity, hi = -Infinity;
    for (const [px, pz] of pts) {
      if (city.field.slope(px, pz) > 0.22) return false;
      const h = city.field.height(px, pz);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (hi - lo > 1.2) return false;

    // Not on another enterable, and not close enough to one to share a wall.
    for (const o of this.buildings) {
      if (x1 + 4 > o.x0 && x0 - 4 < o.x1 && z1 + 4 > o.z0 && z0 - 4 < o.z1) return false;
    }
    return true;
  }

  /** Assemble the plot record, including the door and its room frame. */
  _record(def, plot) {
    const { ci, cj, wc, dc } = plot;
    const b = {
      id: def.id,
      name: def.name,
      style: def.style,
      dressing: def.dressing,
      ci, cj, wc, dc,
      x0: ci * KIT_CELL - KIT_CELL / 2,
      x1: (ci + wc - 1) * KIT_CELL + KIT_CELL / 2,
      z0: cj * KIT_CELL - KIT_CELL / 2,
      z1: (cj + dc - 1) * KIT_CELL + KIT_CELL / 2,
      cx: (ci + (wc - 1) / 2) * KIT_CELL,
      cz: (cj + (dc - 1) / 2) * KIT_CELL,
      w: wc * KIT_CELL,
      d: dc * KIT_CELL,
      base: 0,
      solids: [],          // furniture colliders, world space
      door: null,
      meshes: { shell: null, cap: null },
      roofMeshes: [],
      upperMeshes: [],
      bounds: null,
    };
    b.bounds = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 };
    b.door = this._placeDoor(b);
    return b;
  }

  /**
   * One door, on the face that looks at this building's own street.
   *
   * Same rule city._placeDoor uses for the other 87 buildings, and for the same
   * reason (Lynch's PATHS: a street reads as frontage or it reads as a corridor
   * between sheds). The difference is that this door is a HOLE.
   */
  _placeDoor(b) {
    let best = null, bestD = Infinity;
    for (const s of this.city.streets) {
      const dd = pointSegDistance(b.cx, b.cz, s);
      if (dd < bestD) { bestD = dd; best = s; }
    }
    // Nearest point on that street, so the door faces the way people walk.
    let tx = 0, tz = 0;
    if (best) {
      const dx = best.x2 - best.x1, dz = best.z2 - best.z1;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((b.cx - best.x1) * dx + (b.cz - best.z1) * dz) / l2 : 0;
      t = Math.min(1, Math.max(0, t));
      tx = best.x1 + dx * t; tz = best.z1 + dz * t;
    }
    const vx = tx - b.cx, vz = tz - b.cz;
    const i0 = b.ci, i1 = b.ci + b.wc - 1;
    const j0 = b.cj, j1 = b.cj + b.dc - 1;

    let face;
    if (Math.abs(vx) >= Math.abs(vz)) {
      face = vx >= 0
        ? { i: i1, yaw: 0, nx: 1, nz: 0, axis: 'z' }
        : { i: i0, yaw: Math.PI, nx: -1, nz: 0, axis: 'z' };
    } else {
      face = vz >= 0
        ? { j: j1, yaw: -Math.PI / 2, nx: 0, nz: 1, axis: 'x' }
        : { j: j0, yaw: Math.PI / 2, nx: 0, nz: -1, axis: 'x' };
    }
    let ci, cj;
    if (face.axis === 'z') {
      ci = face.i;
      cj = Math.max(j0, Math.min(j1, Math.round(tz / KIT_CELL)));
    } else {
      cj = face.j;
      ci = Math.max(i0, Math.min(i1, Math.round(tx / KIT_CELL)));
    }
    const x = ci * KIT_CELL, z = cj * KIT_CELL;
    return {
      ci, cj, x, z, yaw: face.yaw,
      nx: face.nx, nz: face.nz,              // outward
      fx: -face.nx, fz: -face.nz,            // into the room
      axis: face.axis,
      outX: x + face.nx * (KIT_CELL * 0.5 + 1.2),
      outZ: z + face.nz * (KIT_CELL * 0.5 + 1.2),
      inX: x - face.nx * (KIT_CELL * 0.5 + 1.2),
      inZ: z - face.nz * (KIT_CELL * 0.5 + 1.2),
    };
  }

  // ------------------------------------------------------------------ build

  /**
   * Raise the five shells.
   *
   * Runs AFTER city._buildInteractables (so the prompts exist to be moved) and
   * BEFORE city._buildHash / the field finalize, because the wall-run boxes and
   * the furniture obstacles must be in the spatial hash and the navgrid feed.
   *
   * @param {() => number} rnd a forked mulberry32 stream. Window placement is
   *   the only thing that consumes it.
   */
  build(rnd) {
    if (!this.planned) this.plan();
    const city = this.city;

    // The reservation has done its job (props and nature are placed); take the
    // solid footprints back out before the wall runs go in, or the room stays
    // sealed to collision no matter how open the doorway looks.
    // Spliced IN PLACE, not filtered into a new array: city.navBlockers hands
    // this.boxes out by reference and dispose() truncates it by length, so the
    // array identity is part of City's contract.
    for (const box of this._reserved) {
      const k = city.boxes.indexOf(box);
      if (k >= 0) city.boxes.splice(k, 1);
    }
    this._reserved.length = 0;

    // TWO meshes for the whole system: one shell, one cap.
    //
    // Draw calls are this step's binding constraint. Step 8 left 12 of headroom
    // under city-test's 220 draw ceiling and the first cut of this file spent
    // 11 of them (walk p95 208 -> 219), with five more steps of the chain still
    // to land. Two structural facts buy almost all of it back:
    //
    //   * the SHELLS never change visibility, so five separate meshes were five
    //     draws buying nothing. One merge.
    //   * the CAPS do — but only ever ONE at a time, and a hidden middle slice
    //     of one merged buffer is expressible as two draw GROUPS. So the caps
    //     are one mesh that costs one draw outdoors and two indoors, instead of
    //     five meshes that cost up to five.
    //
    // The price is honest: both merged meshes span the town, so neither is ever
    // frustum-culled. One draw that always runs still beats five that usually
    // do, and it is bounded rather than scene-dependent.
    const shellGeos = [];
    const capGeos = [];
    for (const b of this.buildings) {
      b.base = city.field.height(b.cx, b.cz);
      this._buildShell(b, rnd, shellGeos, capGeos);
      this._collide(b);
      this._movePrompts(b);
    }
    if (shellGeos.length) {
      const geo = mergeAll(shellGeos);
      const mesh = new THREE.Mesh(geo, cityMaterials().shell);
      mesh.name = 'interior_shells';
      // NOT a shadow caster, and this is a measured trade rather than a slip.
      // The mesh spans the town, so it intersects the 22 m shadow frustum from
      // everywhere and would cost one shadow draw per frame forever. What it
      // would cast is the ground storey's own shadow — which at every sun
      // elevation the clock produces lies wholly INSIDE the shadow the cap
      // above it already casts. Zero visible difference outside; inside, where
      // the cap is hidden, the room is flat-lit, which the spec calls out as
      // the accepted limitation of a no-new-lights interior.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._ownedGeometries.push(geo);
      this._triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      this.shellMesh = mesh;
      for (const b of this.buildings) b.meshes.shell = mesh;
    }
    if (capGeos.length) {
      // Index offsets FIRST: mergeAll concatenates in order and disposes its
      // inputs, so the ranges have to be read before the merge.
      let start = 0;
      this.buildings.forEach((b, i) => {
        const g = capGeos[i];
        const count = g.index ? g.index.count : g.attributes.position.count;
        b.capRange = { start, count };
        start += count;
      });
      this._capTotal = start;
      const geo = mergeAll(capGeos);
      // A one-element material ARRAY, not a bare material: three only honours
      // geometry.groups when the material is an array, and groups are how one
      // building's roof disappears out of the middle of a shared buffer.
      const mesh = new THREE.Mesh(geo, [cityMaterials().shell]);
      mesh.name = 'interior_caps';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._ownedGeometries.push(geo);
      this._triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      this.capMesh = mesh;
      for (const b of this.buildings) {
        b.meshes.cap = mesh;
        // The spec's two handles. Both point at the shared cap mesh, and
        // visibility is per RANGE rather than per mesh — setInside() is the
        // sanctioned way to flip it; setting .visible on this mesh by hand
        // would take all five roofs off at once.
        b.roofMeshes = [mesh];
        b.upperMeshes = [mesh];
      }
      this._applyCapGroups();
    }

    city.group.add(this.group);
    this.built = true;
    return this;
  }

  /**
   * Floor + walls + dressing into the shared `shell` list, upper walls + roof
   * into this building's own cap mesh.
   */
  _buildShell(b, rnd, shell, capGeos) {
    const keys = WALL_KEYS[b.style] || WALL_KEYS.timber;
    const i0 = b.ci, i1 = b.ci + b.wc - 1;
    const j0 = b.cj, j1 = b.cj + b.dc - 1;
    const base = b.base;
    const cap = [];

    const put = (list, key, x, y, z, yaw = 0, scale = 1, inner = false) => {
      const g = pieceGeometryColored(key).clone();
      if (inner) shadeInnerFace(g, 0.85);
      _q.setFromAxisAngle(_up, yaw);
      _s.set(scale, scale, scale);
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      g.applyMatrix4(_m);
      if (!g.attributes.normal) g.computeVertexNormals();
      list.push(g);
    };

    // --- floor -------------------------------------------------------------
    //
    // TWO layers, and the sub-floor is not decoration. town_planks is 96
    // triangles for a 2 m tile because it is modelled as separate BOARDS with
    // real gaps between them; laid straight on the ground the room's floor was
    // striped with grass. A dark slab underneath is 12 triangles a building and
    // turns the gaps into shadow between boards, which is what they are.
    //
    // The stack sits 5 cm proud of the levelled pad rather than flush: flush
    // means the plank top face and the ground mesh are coplanar, and coplanar
    // is z-fighting across the whole floor. Collision is unaffected — heightAt
    // still returns the pad — so there is no step to trip over at the door,
    // only 5 cm of boot inside the boards that no camera in this game can see.
    const fy = base + 0.05;
    shell.push(paintedBox(
      b.x1 - b.x0 - 2 * WALL_T, 0.22, b.z1 - b.z0 - 2 * WALL_T,
      // Top 2 cm BELOW the boards: coplanar with them is z-fighting over the
      // whole floor, and 2 cm of relief is what makes a plank look like a plank.
      b.cx, fy - 0.13, b.cz, SUBFLOOR,
    ));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) put(shell, 'town_planks', i * KIT_CELL, fy - 0.12, j * KIT_CELL, 0);
    }

    // --- walls -------------------------------------------------------------
    const door = b.door;
    const wallAt = (list, ci, cj, y, yaw, ground) => {
      const isDoor = ground && ci === door.ci && cj === door.cj
        && Math.abs(Math.atan2(Math.sin(yaw - door.yaw), Math.cos(yaw - door.yaw))) < 0.01;
      const key = isDoor ? keys[2] : (rnd() < 0.34 ? keys[1] : keys[0]);
      put(list, key, ci * KIT_CELL, y, cj * KIT_CELL, yaw, 1, true);
    };
    for (let fl = 0; fl < 2; fl++) {
      const list = fl === 0 ? shell : cap;
      const y = base + fl * KIT_STOREY;
      for (let j = j0; j <= j1; j++) {
        wallAt(list, i1, j, y, 0, fl === 0);
        wallAt(list, i0, j, y, Math.PI, fl === 0);
      }
      for (let i = i0; i <= i1; i++) {
        wallAt(list, i, j0, y, Math.PI / 2, fl === 0);
        wallAt(list, i, j1, y, -Math.PI / 2, fl === 0);
      }
    }

    // --- roof: flat deck + parapet ------------------------------------------
    // Flat, not pitched, and that is a kit constraint rather than a taste: the
    // town's gable convention puts the ridge on a CELL BOUNDARY and needs the
    // gable axis to be exactly 2 cells (city._layout only ever emits len x 2).
    // These footprints are 3 and 4 cells deep because a 4 m deep room is a
    // corridor, so there is no ridge to run. WORLD_SPEC says as much: flat deck
    // plus town_wall_half parapet "unlocks taller square towers on any
    // footprint", and it gives the five service buildings a civic silhouette
    // that reads as different from the houses around them.
    const ry = base + 2 * KIT_STOREY;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) put(cap, 'town_roof_flat', i * KIT_CELL, ry, j * KIT_CELL, 0);
    }
    for (let j = j0; j <= j1; j++) {
      put(cap, 'town_wall_half', i1 * KIT_CELL, ry, j * KIT_CELL, 0);
      put(cap, 'town_wall_half', i0 * KIT_CELL, ry, j * KIT_CELL, Math.PI);
    }
    for (let i = i0; i <= i1; i++) {
      put(cap, 'town_wall_half', i * KIT_CELL, ry, j0 * KIT_CELL, Math.PI / 2);
      put(cap, 'town_wall_half', i * KIT_CELL, ry, j1 * KIT_CELL, -Math.PI / 2);
    }
    b.topY = ry + 1.0;

    // --- dressing ----------------------------------------------------------
    for (const item of (DRESSING[b.dressing] || [])) {
      const p = this._roomPoint(b, item.u, item.v);
      const yaw = yawFor(door.fx, door.fz) + (item.t || 0) * (Math.PI / 2);
      // On the FLOOR, not on the pad — furniture standing 5 cm under the boards
      // is the same z-fight the floor stack exists to avoid.
      put(shell, item.key, p.x, fy + (item.y || 0), p.z, yaw, item.scale || 1);
      if (item.r) b.solids.push({ x: p.x, z: p.z, radius: item.r });
    }

    capGeos.push(mergeAll(cap));
  }

  /**
   * A world point from door-relative room coordinates.
   *
   * `f` runs from the door into the room, `r` is 90 degrees off it. The room's
   * half-extents are swapped accordingly, so u = 1 is always "the right-hand
   * wall as you walk in" whichever way the plot search turned the building.
   */
  _roomPoint(b, u, v) {
    const inset = 0.7;                     // keep furniture off the wall slabs
    const hx = Math.max(0.2, b.w / 2 - WALL_T - inset);
    const hz = Math.max(0.2, b.d / 2 - WALL_T - inset);
    const f = { x: b.door.fx, z: b.door.fz };
    const r = { x: f.z, z: -f.x };
    const hf = Math.abs(f.x) > 0.5 ? hx : hz;
    const hr = Math.abs(r.x) > 0.5 ? hx : hz;
    return {
      x: b.cx + r.x * u * hr + f.x * v * hf,
      z: b.cz + r.z * u * hr + f.z * v * hf,
    };
  }

  /**
   * Wall-run collision: four 0.2 m boxes on the slab lines, with the door wall
   * split either side of a DOOR_GAP hole.
   *
   * city.boxes is already arbitrary rects (that is why a 4 x 14 m terrace is not
   * a circle that seals the street), so this needs no new collision code, and
   * the navgrid re-bakes off the same array — which is the whole reason NPCs can
   * follow you inside.
   */
  _collide(b) {
    const city = this.city;
    const push = (x, z, w, d) => {
      if (w <= 0.01 || d <= 0.01) return;
      city.boxes.push({ x, z, w, d, rot: 0, interiorId: b.id });
    };
    const door = b.door;
    const runs = [
      // axis 'z' faces are the +/-X walls; axis 'x' faces are the +/-Z walls.
      { axis: 'z', at: b.x0 + WALL_T / 2, side: -1 },
      { axis: 'z', at: b.x1 - WALL_T / 2, side: 1 },
      { axis: 'x', at: b.z0 + WALL_T / 2, side: -1 },
      { axis: 'x', at: b.z1 - WALL_T / 2, side: 1 },
    ];
    for (const run of runs) {
      const isDoorRun = (run.axis === 'z' && door.axis === 'z' && Math.sign(door.nx) === run.side)
        || (run.axis === 'x' && door.axis === 'x' && Math.sign(door.nz) === run.side);
      if (run.axis === 'z') {
        if (!isDoorRun) { push(run.at, b.cz, WALL_T, b.d); continue; }
        const gz0 = door.z - DOOR_GAP / 2, gz1 = door.z + DOOR_GAP / 2;
        push(run.at, (b.z0 + gz0) / 2, WALL_T, gz0 - b.z0);
        push(run.at, (gz1 + b.z1) / 2, WALL_T, b.z1 - gz1);
      } else {
        if (!isDoorRun) { push(b.cx, run.at, b.w, WALL_T); continue; }
        const gx0 = door.x - DOOR_GAP / 2, gx1 = door.x + DOOR_GAP / 2;
        push((b.x0 + gx0) / 2, run.at, gx0 - b.x0, WALL_T);
        push((gx1 + b.x1) / 2, run.at, b.x1 - gx1, WALL_T);
      }
    }
    for (const s of b.solids) {
      city.obstacles.push({ pos: { x: s.x, z: s.z }, radius: s.radius, interiorId: b.id });
    }
  }

  /** Move this building's prompts inside it. */
  _movePrompts(b) {
    for (const spec of (INSIDE_PROMPTS[b.id] || [])) {
      const it = this.city.interactables.find((x) => x.id === spec.id);
      if (!it) continue;
      const p = this._roomPoint(b, spec.u, spec.v);
      it.pos.set(p.x, this.city.field.height(p.x, p.z), p.z);
      it.radius = spec.radius;
      it.interiorId = b.id;
    }
  }

  /**
   * The interiors' warm quads, as extra instances for the CITY's own lit-window
   * field. Called by city._buildBuildings while it is still counting.
   *
   * Sharing the town's window InstancedMesh is worth a paragraph: it costs no
   * draw call, no material, no geometry and no shader program, and it inherits
   * applyDayState's single per-frame colour write, so a fire lit at dusk in the
   * tavern is the same code path as a lit window on the street. The alternative
   * — a private InstancedMesh here — measured one permanent draw call and one
   * extra program for identical pixels.
   *
   * Safe to call before build(): plots and doors are fixed by plan(), and the
   * field is already baked by the time _buildBuildings runs.
   */
  glowLights() {
    const out = [];
    for (const b of this.buildings) {
      b.base = this.city.field.height(b.cx, b.cz);
      // Face the quad back toward the door, i.e. into the room.
      const yaw = yawFor(-b.door.fx, -b.door.fz);
      for (const g of (GLOWS[b.dressing] || [])) {
        const p = this._roomPoint(b, g.u, g.v);
        out.push({ x: p.x, y: b.base + g.y, z: p.z, yaw });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ query

  /**
   * The enterable whose footprint contains `pos`, or null.
   *
   * Plain point-in-rect. Hysteresis is the CALLER's (citymode's) job — it is
   * mode state, not world state, and two callers with two thresholds would
   * flicker against each other at the threshold.
   *
   * @param {{x:number,z:number}} pos
   * @param {number} [grow] inflate the rect; the caller passes +/- half its
   *   hysteresis band.
   */
  buildingAt(pos, grow = 0) {
    for (const b of this.buildings) {
      if (pos.x >= b.x0 - grow && pos.x <= b.x1 + grow
        && pos.z >= b.z0 - grow && pos.z <= b.z1 + grow) return b;
    }
    return null;
  }

  /** Idempotent. null puts every cap back. */
  setInside(id) {
    if (id === this.insideId) return;
    this.insideId = id && this.byId.has(id) ? id : null;
    this._applyCapGroups();
  }

  /**
   * Draw the cap buffer as everything EXCEPT the occupied building's slice.
   *
   * One group when nobody is indoors, two when someone is (and one when the
   * occupied building happens to sit at either end of the buffer). Groups are
   * read fresh by the renderer every frame, so there is no dirty flag and no
   * per-frame work here at all — this runs once per threshold crossing.
   */
  _applyCapGroups() {
    const mesh = this.capMesh;
    if (!mesh) return;
    const geo = mesh.geometry;
    geo.clearGroups();
    const b = this.insideId ? this.byId.get(this.insideId) : null;
    if (!b || !b.capRange) { geo.addGroup(0, this._capTotal, 0); return; }
    const { start, count } = b.capRange;
    if (start > 0) geo.addGroup(0, start, 0);
    const end = start + count;
    if (end < this._capTotal) geo.addGroup(end, this._capTotal - end, 0);
  }

  get stats() {
    return {
      planned: this.buildings.length,
      missing: ENTERABLES.filter((e) => !this.byId.has(e.id)).map((e) => e.id),
      triangles: Math.round(this._triangles),
      // One shell + one cap, and the cap splits into two groups while the
      // player is indoors. The warm quads ride the city's own window field and
      // cost nothing here.
      drawGroups: (this.shellMesh ? 1 : 0)
        + (this.capMesh ? Math.max(1, this.capMesh.geometry.groups.length) : 0),
      inside: this.insideId,
      buildings: this.buildings.map((b) => ({
        id: b.id, x: b.cx, z: b.cz, w: b.w, d: b.d,
        door: { x: b.door.x, z: b.door.z, outX: b.door.outX, outZ: b.door.outZ },
      })),
    };
  }

  // --------------------------------------------------------------- teardown

  dispose() {
    this.setInside(null);
    if (this.shellMesh) { this.shellMesh.removeFromParent(); this.shellMesh = null; }
    if (this.capMesh) { this.capMesh.removeFromParent(); this.capMesh = null; }
    for (const b of this.buildings) {
      b.meshes.shell = null;
      b.meshes.cap = null;
      b.roofMeshes = [];
      b.upperMeshes = [];
    }
    // MATERIALS are citykit's (cityMaterials().shell, freed by disposeCityKit)
    // and City's; only these merged buffers are ours.
    for (const g of this._ownedGeometries) g.dispose();
    this._ownedGeometries.length = 0;
    this._capTotal = 0;
    this.group.clear();
    this.group.removeFromParent();
    this.buildings.length = 0;
    this.byId.clear();
    this._reserved.length = 0;
    this._triangles = 0;
    this.planned = false;
    this.built = false;
    this.insideId = null;
  }
}

export default Interiors;
