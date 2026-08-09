import * as THREE from 'three';
import {
  HeightField, VERGE_EDGE, FRONTIER_CELL, FRONTIER_HALF,
  PORTAL_COLORS, buildPortalVisual, registerVergeDistrict, clearVergeDistricts,
} from './city.js';
import { NatureField } from './naturekit.js';
import { pieceGeometryColored } from './citykit.js';
import { fbm } from './terrain.js';
import { GATES } from '../game/config.js';

// ---------------------------------------------------------------------------
// THE VERGE — the land outside the walls
// ---------------------------------------------------------------------------
//
// The town used to end at an invisible wall 134 m from the plaza with the
// ground visibly falling into sky 20 m past it. This is what is on the other
// side: 124 m more of walkable ground on three sides, dressed as three coloured
// wedges (green east, amber south, grey north) so the world reads as a place
// with directions in it rather than a arena with a skybox.
//
// FOUR DECISIONS, all of them things the first draft got wrong:
//
// 1. STATIC, NOT STREAMED. One coarse HeightField and a fixed set of global
//    InstancedMeshes, built once with the city and disposed with it. Chunk
//    streaming is a whole subsystem (load scheduling, seams that move, a
//    disposal story per chunk) for a 560 m map that fits in one buffer. The
//    escape hatch if this ever needs to be 2 km is a real one, but it is not
//    this wave's problem and pretending otherwise costs the wave.
//
// 2. THE COARSE FIELD IS AUTHORITATIVE AND THE CITY BENDS TO IT. The obvious
//    build — two fields sampling the same maths at 3.4 m and 6.8 m — disagrees
//    by up to 0.46 m where the Breach bump's gradient is steepest (measured,
//    not estimated). That is a ledge you can see and walk off at exactly the
//    place the player crosses. So city.js's field resamples ITSELF onto this
//    lattice near its rim (HeightField.bake's stitch), which makes the two
//    surfaces identical rather than similar. Everything else here — the seam
//    skirt, the blend band in City.heightAt — is belt-and-braces on top of a
//    seam that is already exact.
//
// 3. NO NEW LIGHTS, NO NEW MATERIAL VARIANTS. Same rule as city.js: light count
//    and castShadow are in three's program cache key. The Verge adds exactly
//    one merged ground mesh with the city's ground material settings and a
//    bounded set of NatureFields on kit materials the city already compiled.
//    A campfire in step 7 is an unlit additive quad for the same reason.
//
// 4. EVERY SOLID IS A COLLIDER AND EVERY BUFFER IS OWNED. Trees, bushes and
//    rocks push into city.obstacles BEFORE City._buildHash, so collision and
//    the navgrid see them. Geometry and materials this file creates go into its
//    own owned lists; geometry and materials it BORROWS from naturekit are
//    never disposed here. GPU leaks have shipped from this repo three times.

/** How far out resolve() lets anything walk once the Verge exists. */
export const VERGE_LIMIT = 258;

// The annulus, in whole lattice rings so every vertex is shared with the city
// field. 6.8 m per ring: 23 -> 156.4 m, 25 -> 170.0 m (the city ground mesh's
// own rim, to the millimetre), 41 -> 278.8 m.
const RING_IN = 23;
const RING_OUT = 41;
const RING_CITY_RIM = 25;
const CENTRE_IX = 42;              // FRONTIER_HALF / FRONTIER_CELL

// Seam skirt. The inner rings live UNDER the city ground mesh and are sunk so
// they can never poke through it, deepest at the inside and a hair's breadth at
// the shared rim. It is a hair rather than zero because two coplanar meshes
// z-fight, and 8 cm is well under stepHeight (0.4 m) so nothing walks off it.
const SINK = [1.2, 0.6, 0.08];     // indexed by (ringV - RING_IN) clamped

// Where scatter may stand, as Chebyshev radius. The inner bound sits outside
// the city ground mesh's rim so the Verge never dresses ground the town already
// dressed; the outer one keeps everything inside the walk limit, because a tree
// you can see but can never reach reads as a rendering bug.
const SCATTER_IN = 152;
const SCATTER_OUT = VERGE_LIMIT - 6;

// POIs (step 7) carve pads into THIS field only. Anything closer in than this
// would flatten ground the city field also owns, and the two would disagree —
// the stitch guarantees agreement for the undisturbed surface, not for flats.
export const POI_MIN_R = 186;

const BREACH_Z = -126;             // mirrors city.js; the ash ring's centre
const CLIFF_X = -88;

// THE ANNULUS STOPS WHERE THE CITY GROUND MESH ALREADY STOPPED, on the west
// side only. Carrying it out to 278 m painted the void floor below the cliff
// across 60% of the Overlook frame — a wide flat basin where the shipped game
// has a 34 m drop and then sky. The cliff is the one place the world is meant
// to visibly stop, so west of the city mesh's own rim the Verge simply is not
// there and the view is bit-for-bit the one that already exists.
const WEST_MESH_EDGE = -170;       // = -WORLD_HALF in city.js

const smoothstep = (a, b, x) => {
  if (b === a) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Azimuth with EAST = 0, SOUTH = 90, WEST = 180, NORTH = 270 — that is
// atan2(z, x) in this game's axes, where -z is north. The band arcs below are
// quoted in this frame and nowhere else; getting it wrong silently paints the
// meadow onto the Breach road.
function azimuth(x, z) {
  const a = (Math.atan2(z, x) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}
function angDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------------
// Biome bands
// ---------------------------------------------------------------------------
// Arcs are the spec's, restated as centre + falloff so the ground palette can
// cross-fade instead of drawing a hard pie-slice edge across open country. The
// west wedge (az ~170-190) has no band on purpose: that is the cliff void, and
// nothing stands on it.

const BANDS = {
  east_meadow: { centre: 0, soft: [55, 85], arc: [-60, 60] },
  south_amberwood: { centre: 115, soft: [50, 80], arc: [60, 170] },
  north_ashreach: { centre: 245, soft: [50, 85], arc: [190, 300] },
};

/**
 * Species table.
 *
 * `bands` lists the arcs a species may be sampled in; `verge` species ignore
 * the arcs and hug the lanes the town's avenues point down; `high` gates on
 * elevation. Counts are at density 1 and are multiplied by the quality
 * governor's instanceScale, exactly like the town's own scatter.
 *
 * Variant choice is a BUDGET decision, not an aesthetic one. Each family in
 * nature.glb has five variants and every one costs its own InstancedMesh (two
 * to four, in fact — the loader splits a piece per material). Every family at
 * full variety would be ~60 extra draw calls that are never culled.
 *
 * `solid` is the collider radius at scale 1, 0 for walk-through decoration —
 * the same honesty rule as city.js: anything under stepHeight is brush you push
 * through, anything taller is something you walk around.
 */
const E = 'east_meadow';
const S = 'south_amberwood';
const N = 'north_ashreach';

// Mesh counts in the comments are MEASURED (nature.glb splits a piece per
// material), because a species' real cost here is draw calls, not triangles: a
// global field is never frustum-culled, so every mesh is drawn every frame from
// everywhere in the world, including from inside the town with the Verge behind
// the camera. That is what caps this table at 15 entries.
const SPECIES = [
  // --- trees, 220 at density 1 ---------------------------------------------
  { key: 'commontree_4', bands: [E], n: 44, s: [0.9, 1.5], solid: 0.8, tree: true },        // 3
  { key: 'willow_3', bands: [E], n: 22, s: [0.9, 1.4], solid: 0.7, tree: true },            // 2
  { key: 'birchtree_2', bands: [S], n: 34, s: [0.9, 1.4], solid: 0.6, tree: true },         // 4
  { key: 'birchtree_autumn_3', bands: [S], n: 38, s: [0.9, 1.4], solid: 0.6, tree: true },  // 4
  { key: 'commontree_dead_3', bands: [N], n: 34, s: [0.9, 1.5], solid: 0.6, tree: true },   // 1
  { key: 'willow_dead_4', bands: [N], n: 22, s: [0.9, 1.4], solid: 0.55, tree: true },      // 1
  // Pines crown the RISES rather than the slopes the spec asks for. There are
  // no slopes: the shared surface's steepest point anywhere on the Verge is
  // 0.042, against the spec's "slope > 0.28" (measured over 25k samples). A
  // slope-gated species places exactly zero instances and still costs its draw
  // calls forever, which is what the first cut of this table shipped. Elevation
  // is the same intent — conifers on the high ground — against terrain that
  // exists: 0.9 m is roughly the top fifth of the Verge.
  { key: 'pinetree_5', bands: [E, N], n: 26, s: [0.9, 1.5], solid: 0.65, tree: true, high: 0.9 }, // 2
  // --- bushes, 120 ----------------------------------------------------------
  { key: 'bush_1', bands: [E], n: 50, s: [0.8, 1.2], solid: 0.85, clump: true },            // 1
  { key: 'bush_2', bands: [S], n: 40, s: [0.8, 1.2], solid: 0.7, clump: true },             // 1
  { key: 'bushberries_1', bands: [E], n: 30, s: [0.8, 1.1], solid: 0.75, clump: true },     // 2
  // --- rocks, 160. Moss is a BAND property: the spec's ashreach is "rock (no
  //     moss)", and a mossy boulder on burnt ground reads as the wrong asset
  //     rather than as variety.
  { key: 'rock_4', bands: [N], n: 80, s: [0.7, 1.6], solid: 0.75, clump: true },            // 1
  { key: 'rock_moss_5', bands: [E, S], n: 80, s: [0.7, 1.4], solid: 0.5, clump: true },     // 2
  // --- ground tufts, 140: along the lines the town's avenues point down -----
  { key: 'grass_short', n: 80, s: [1.1, 1.8], sy: [0.85, 1.0], solid: 0, clump: true, verge: true }, // 1
  { key: 'flowers', n: 30, s: [1.0, 1.5], sy: [0.42, 0.5], solid: 0, clump: true, verge: true, lanes: [0, 90] }, // 3
  { key: 'plant_3', n: 30, s: [0.9, 1.3], sy: [0.6, 0.85], solid: 0, clump: true, verge: true },     // 1
  // --- forest floor. woodlog was cut with the slope species: 3 meshes for 14
  //     knee-high props is the worst draw-call-per-pixel in the table.
  { key: 'treestump', bands: [S, N], n: 24, s: [0.8, 1.2], solid: 0.45 },                   // 3
];

// ---------------------------------------------------------------------------
// POIs — the reasons to walk
// ---------------------------------------------------------------------------
//
// Seven stamps, AUTHORED positions with a seeded jitter on top rather than a
// blind findSpot over the whole annulus. Two reasons, both learned from the
// screenshots the dressing pass produced:
//
//   * the postcard only works if it is ON the sightline. "verge_ruin_arch is
//     visible from the east gate" is a composition, not a probability — a
//     random spot that satisfies every rule in poiRules still lands behind the
//     player nine times in ten, and then the best thing in the Verge is
//     something you find by accident or not at all.
//   * the rules themselves have almost no bite out here. The Verge's steepest
//     slope anywhere is 0.042 against a "slope < 0.3" rule, and everything past
//     r 186 is automatically >= 100 m from the wall and >= 60 m from the ash
//     ring. A pure findSpot would be a random number generator wearing a
//     validator as a hat.
//
// So: an authored anchor per POI, a seeded +-7 m jitter (this is the "seeded"
// part, and it is real — the same seed always lands the same camp), and a
// validator that REJECTS the jitter and falls back to the anchor if any of the
// spec's rules or the pad-vs-seam rule below would be broken. _validatePlacement
// is also what frontier-test asserts against, so the rules are checked rather
// than asserted-by-comment.
//
// THE PAD RULE IS LOAD-BEARING AND IS NOT IN THE SPEC. Each POI carves a
// field.addFlat into the FRONTIER field only. The city field is stitched to the
// frontier's UNDISTURBED surface (city.js HeightField._coarse calls groundBase,
// not this field's baked array), so any flat that reaches inside City.BLEND_R1
// = 170 would make the two fields disagree by the depth of the pad, at exactly
// the radius where heightAt hands authority over. Hence: pad + feather <= 16 and
// every centre at Chebyshev radius >= POI_MIN_R (186), which leaves 170 clear
// with margin.
const POI_FEATHER = 6;

const POIS = [
  {
    id: 'verge_ruin_arch',
    name: 'THE SUNKEN ARCH',
    // Dead east on the east avenue's line (the street runs out along z = 0), so
    // it is the thing you see through the east gate when you look out of it.
    x: 206, z: 10, pad: 10, radius: 24, stamp: 'ruinArch',
  },
  {
    id: 'camp_hunters_east',
    name: "THE HUNTERS' CAMP",
    // npcs/npcHunter are read by citizens.js after City.build has run both this
    // file and the crowd (build order: frontier, then Citizens). They are the
    // whole reason a camp is a camp rather than a prop cluster — the spec's own
    // line is "fiction: other hunters stage here before gates", and a staging
    // post with nobody in it answers the owner's "is anyone out here" with no.
    x: 192, z: -104, pad: 10, radius: 24, stamp: 'campHunters', npcs: 2, npcHunter: true,
  },
  {
    id: 'wildgate_e',
    name: 'AN UNWATCHED GATE',
    x: 198, z: 96, pad: 12, radius: 24, stamp: 'wildGate', rank: 'E',
  },
  {
    id: 'camp_farmstead',
    name: 'THE OUTFARM',
    x: 150, z: 200, pad: 10, radius: 24, stamp: 'campFarmstead', npcs: 1,
  },
  {
    id: 'verge_ruin_hall',
    name: 'THE ROOFLESS HALL',
    x: 40, z: 210, pad: 10, radius: 24, stamp: 'ruinHall',
  },
  {
    id: 'wildgate_c',
    name: 'A SEALED WILD GATE',
    x: -62, z: 206, pad: 12, radius: 24, stamp: 'wildGate', rank: 'C',
  },
  {
    id: 'verge_watchtower',
    name: 'THE ASHREACH WATCH',
    // North, on the Breach side: a tower on the skyline is the only landmark
    // out here that reads from inside the walls.
    x: -30, z: -208, pad: 10, radius: 24, stamp: 'watchtower',
  },
];

// Rules from the spec's poiRules, as numbers so the validator and the harness
// can share them.
const POI_MIN_SEP = 55;          // metres between POI centres
const POI_MIN_WALL = 30;         // metres outside the city wall (WALL_HALF 88)
const POI_MIN_BREACH = 40;       // metres from the Breach ash ring's centre
const POI_MAX_SLOPE = 0.3;
const POI_SEAM_CLEAR = 170;      // = city.js BLEND_R1; pads must not reach it
const WALL_HALF = 88;

// ---------------------------------------------------------------------------

const _sm = new THREE.Matrix4();
const _sq = new THREE.Quaternion();
const _sp = new THREE.Vector3();
const _ss = new THREE.Vector3();
const _sup = new THREE.Vector3(0, 1, 0);
const _seuler = new THREE.Euler();

/** Paint a flat colour into a geometry's `color` attribute. Matches city.js. */
function paintGeo(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * Concatenate geometries into one buffer and DISPOSE the inputs.
 *
 * A local copy of city.js's mergeAll rather than an import: that one is private
 * to city.js and exporting it to reach across the import cycle for a build-time
 * helper is more coupling than a 25-line loop is worth.
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
 * A POI under construction: a list of local-space geometries plus the colliders
 * they imply.
 *
 * MERGED, NOT INSTANCED, and that is the whole draw-call argument for this step.
 * A KitField is a global InstancedMesh whose bounding sphere spans wherever its
 * instances landed; nineteen kit piece types across seven POIs would be ~30
 * InstancedMeshes drawn from everywhere in the world, against a measured 36
 * draw calls of headroom under city-test's 220 ceiling. One merged mesh per POI
 * is seven meshes with seven TIGHT bounding spheres, so a POI 200 m behind the
 * camera costs nothing at all. The price is that instancing's memory saving is
 * gone — irrelevant at ~30 pieces a stamp.
 */
class Stamp {
  constructor() {
    this.geos = [];
    this.solids = [];      // { x, z, radius } in LOCAL space
    this.tris = 0;
  }

  /** One kit piece, local space, y measured from the pad. */
  piece(key, x, y, z, yaw = 0, scale = 1, tilt = 0) {
    const g = pieceGeometryColored(key).clone();
    _seuler.set(tilt, yaw, 0);
    _sq.setFromEuler(_seuler);
    _ss.set(scale, scale, scale);
    _sp.set(x, y, z);
    _sm.compose(_sp, _sq, _ss);
    g.applyMatrix4(_sm);
    this.geos.push(g);
    this.tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    return this;
  }

  /** A procedural box, for the handful of things the kit has no piece for. */
  box(w, h, d, x, y, z, hex, yaw = 0, tilt = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    paintGeo(g, hex);
    _seuler.set(tilt, yaw, 0);
    _sq.setFromEuler(_seuler);
    _ss.set(1, 1, 1);
    _sp.set(x, y, z);
    _sm.compose(_sp, _sq, _ss);
    g.applyMatrix4(_sm);
    this.geos.push(g);
    this.tris += 12;
    return this;
  }

  solid(x, z, radius) { this.solids.push({ x, z, radius }); return this; }
}

export class Frontier {
  /**
   * @param {City} city  the owner: its group, its seed, its obstacle list.
   * @param {() => number} rnd  a forked mulberry32 stream from City.build. NO
   *   Math.random and no Date.now anywhere below — build(seed) must reproduce.
   */
  constructor(city, rnd) {
    this.city = city;
    this.rnd = rnd;
    this.group = new THREE.Group();
    this.group.name = 'frontier';

    this.field = null;
    this.fields = [];              // NatureField / KitField instances, owned here
    this.pois = [];                // { id, name, pos, radius, discovered, ... }
    this.wildGates = [];           // the subset of city.portals this file added
    this.ground = null;
    // One shared material for every POI stamp. The kit's colours are baked into
    // vertex data by pieceGeometryColored, so seven merged stamps are seven
    // draws on ONE program — and it is a Frontier material, not a borrowed
    // citykit one, so its lifetime is unambiguous.
    this._poiMat = null;
    this._fires = [];              // { mesh, mat, phase } — campfire flicker
    // Scatter fields this Verge is willing to THIN at runtime, each with the
    // obstacle records its instances own. See NatureField.setDensity and
    // City.setInstanceDensity: the Verge's scatter is the single largest
    // triangle block in the world and the one a stepped-down phone most needs
    // back. POI crop fields (wheat/corn) are deliberately NOT in here — they are
    // placed in authored rows, so a truncated tail is a half-ploughed field.
    this._scatter = [];
    this._triangleBase = 0;
    this.emptyFields = [];         // species that placed nothing; see build()

    this._ownedGeometries = [];
    this._ownedMaterials = [];
    this._triangles = 0;
    this._t = 0;
    // Set by whoever wants discovery banners. Left null so this module never
    // reaches into the UI: City has no toast and should not grow one.
    this.onDiscover = null;
    // Placement rejects against solids THIS file added. City solids all live
    // inside r 134 and the scatter belt starts at 152, so scanning the town's
    // 900 obstacles per try would be ~3 M comparisons to reject nothing.
    this._solids = [];
  }

  // ------------------------------------------------------------------ build

  build() {
    const city = this.city;
    const seed = city.field ? city.field.seed : 0;

    // Same class, same analytic surface, same world edge — only the cell size
    // differs. No stitch: this lattice IS the stitch target.
    this.field = new HeightField({
      size: FRONTIER_HALF * 2,
      cell: FRONTIER_CELL,
      seed,
      edge: VERGE_EDGE,
    }).bake();

    // POIs BEFORE the ground mesh: each one carves a flat pad, and the mesh is
    // the baked array. Same bake-place-rebake order City.build uses for its
    // building plots, for the same reason.
    this._placePois();
    for (const p of this.pois) {
      this.field.addFlat({
        x: p.pos.x, z: p.pos.z, radius: p.pad, feather: POI_FEATHER,
        height: this.field.height(p.pos.x, p.pos.z),
      });
    }
    this.field.bake();

    this._buildGround();
    this._buildPois();
    // Last: scatter rejects against the POI keep-outs _buildPois pushed into
    // _solids, so no tree grows through a watchtower.
    this._buildScatter();

    // A field that placed NOTHING still issues one draw call per mesh every
    // frame for the life of the city — three does not skip an InstancedMesh
    // whose count is 0, it just draws zero instances. The first version of the
    // species table had three such fields (six wasted calls, invisible in every
    // screenshot) because their placement predicate could never be satisfied.
    // Drop them here AND report them, so the next table edit that mis-specifies
    // a predicate fails the harness instead of quietly costing frames.
    this.emptyFields = [];
    const live = [];
    for (const f of this.fields) {
      if (f.count === 0) { this.emptyFields.push(f.key); f.dispose(); continue; }
      f.finalize().addTo(this.group);
      this._triangles += f.triangles;
      live.push(f);
    }
    this.fields = live;
    // A field that placed nothing was just disposed; a density group holding it
    // would write counts into a dead InstancedMesh.
    this._scatter = this._scatter.filter((g) => g.field.count > 0);
    this._triangleBase = this._triangles;
    city.group.add(this.group);
    return this;
  }

  /**
   * The Verge's half of City.setInstanceDensity — see the long note there.
   * `f` is a fraction of what this Verge was BUILT with, never an absolute tier
   * density, so the two halves of the world always thin by the same amount.
   *
   * @returns {{triangles:number, collidersOff:number}} what was shed
   */
  setInstanceDensity(f) {
    let shed = 0;
    let off = 0;
    for (const g of this._scatter) {
      const full = g.field.trianglesFull;
      g.field.setDensity(f);
      const live = g.field.live;
      shed += full - g.field.triangles;
      for (const o of g.solids) {
        o.off = o.i >= live;
        if (o.off) off++;
      }
    }
    this._triangles = this._triangleBase - shed;
    return { triangles: shed, collidersOff: off };
  }

  // ----------------------------------------------------------------- ground

  /**
   * The annulus, in the same non-indexed face-coloured language as the city
   * ground: one flat colour per triangle, a face-constant luminance jitter, no
   * texture. Anything else would read as a different game 30 m from the wall.
   */
  _buildGround() {
    const f = this.field;
    const stride = f.stride;
    const seed = f.seed;

    const meadow = new THREE.Color(0x6d8c4a);
    const meadowWarm = new THREE.Color(0x8f9c3e);
    const meadowCool = new THREE.Color(0x49764a);
    // Pushed toward russet from the first cut's 0xa8843a, which sat within a
    // few percent of the dry belt's 0xa08f60 — the south wedge was invisible
    // from the air and read as "more of the same dead grass" from the ground.
    // The band colours have to differ from the belt they emerge from, not just
    // from each other.
    const amber = new THREE.Color(0xa2762e);
    const amberDeep = new THREE.Color(0x7c5723);
    // THREE ash tones, for the reason the city ground has three grass tones: a
    // single 0x5c5763 across the whole north band rendered as one dead flat
    // purple plane filling half the frame, which is the exact criticism the
    // city ground pass was rewritten to answer.
    const ash = new THREE.Color(0x5c5763);
    const ashPale = new THREE.Color(0x736e7c);
    const ashWarm = new THREE.Color(0x6b5b52);
    const dry = new THREE.Color(0xa08f60);       // continues the city's belt
    const rock = new THREE.Color(0x8a8f9e);
    const trodden = new THREE.Color(0x9c8f74);   // ground people have stood on
    const c = new THREE.Color();
    const band = new THREE.Color();

    const hash2 = (ix, jz) => {
      let h = (ix * 374761393 + jz * 668265263 + seed) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };

    // Which cells are in the annulus, and how far each vertex is sunk.
    const ringOf = (i) => Math.abs(i - CENTRE_IX);
    const vSink = (i, j) => {
      const rv = Math.max(ringOf(i), ringOf(j));
      if (rv > RING_CITY_RIM) return 0;
      const k = Math.max(0, rv - RING_IN);
      return SINK[Math.min(SINK.length - 1, k)];
    };

    // PASS 1 — per-vertex position and zone colour, over the whole lattice.
    // Cheap enough (7225 vertices) to do without a sparse index, and the face
    // pass below wants random access to neighbours anyway.
    const verts = stride * stride;
    const gpos = new Float32Array(verts * 3);
    const vcol = new Float32Array(verts * 3);
    for (let jz = 0; jz <= f.n; jz++) {
      const z = -f.half + jz * f.cell;
      for (let ix = 0; ix <= f.n; ix++) {
        const x = -f.half + ix * f.cell;
        const k = jz * stride + ix;
        gpos[k * 3] = x;
        gpos[k * 3 + 1] = f.h[k] - vSink(ix, jz);
        gpos[k * 3 + 2] = z;

        // --- directional bands, cross-faded rather than sliced.
        const az = azimuth(x, z);
        const bE = BANDS.east_meadow, bS = BANDS.south_amberwood, bN = BANDS.north_ashreach;
        const wE = 1 - smoothstep(bE.soft[0], bE.soft[1], angDist(az, bE.centre));
        const wS = 1 - smoothstep(bS.soft[0], bS.soft[1], angDist(az, bS.centre));
        const wN = 1 - smoothstep(bN.soft[0], bN.soft[1], angDist(az, bN.centre));
        const tot = wE + wS + wN || 1;

        // Each band gets the city ground's trick of a low-frequency hue drift,
        // because one flat tone across 100 m of open country is the exact
        // failure the city ground pass was rewritten to fix.
        const drift = smoothstep(0.38, 0.64, fbm(x * 0.014 + 61, z * 0.014 - 23, seed + 303, 2));
        const drift2 = smoothstep(0.42, 0.7, fbm(x * 0.037 - 5, z * 0.037 + 17, seed + 404, 2));
        // Weighted sum by hand: THREE.Color has no addScaled, and building the
        // mix with chained lerps would make the third band's weight depend on
        // the first two instead of on its own arc.
        c.copy(meadow).lerp(meadowWarm, drift).lerp(meadowCool, drift2 * 0.85);
        band.setRGB((c.r * wE) / tot, (c.g * wE) / tot, (c.b * wE) / tot);
        c.copy(amber).lerp(amberDeep, drift);
        band.setRGB(band.r + (c.r * wS) / tot, band.g + (c.g * wS) / tot, band.b + (c.b * wS) / tot);
        c.copy(ash).lerp(ashPale, drift2).lerp(ashWarm, drift * 0.7);
        band.setRGB(band.r + (c.r * wN) / tot, band.g + (c.g * wN) / tot, band.b + (c.b * wN) / tot);

        c.copy(band);
        c.lerp(rock, Math.min(1, f.slope(x, z) / 0.42) * 0.9);
        // The dry belt does not stop at the wall — it fades out over the first
        // stretch of the Verge, which is what makes the town read as the middle
        // of something instead of a diorama dropped onto a lawn. It ends at
        // 184 m, not 212: at 212 the first eye-level screenshots from the wall
        // were 40% flat tan with the band colour only arriving on the horizon,
        // and the whole point of the bands is that you can see which way you
        // are walking from the ground you are standing on.
        c.lerp(dry, (1 - smoothstep(148, 184, Math.hypot(x, z))) * 0.8);
        // Ash widens around the Breach on every side, band or not.
        c.lerp(ash, 1 - smoothstep(30, 86, Math.hypot(x, z - BREACH_Z)));

        // POI pads read as pale trodden discs. This is DISCOVERABILITY, not
        // decoration: a stamp 200 m out is a few pixels of silhouette against a
        // band of the same green, and the ground reads long before the props do
        // — the pale disc is what makes you point the camera at it in the first
        // place. It costs 7 distance tests per vertex at build time and nothing
        // at all per frame.
        for (let pi = 0; pi < this.pois.length; pi++) {
          const p = this.pois[pi];
          const w = 1 - smoothstep(p.pad * 0.62, p.pad * 1.55,
            Math.hypot(x - p.pos.x, z - p.pos.z));
          if (w > 0) c.lerp(trodden, w * 0.72);
        }

        vcol[k * 3] = c.r; vcol[k * 3 + 1] = c.g; vcol[k * 3 + 2] = c.b;
      }
    }

    // PASS 2 — non-indexed faces over the annulus cells only.
    const cells = [];
    for (let jz = 0; jz < f.n; jz++) {
      for (let ix = 0; ix < f.n; ix++) {
        const rc = Math.max(ringOf(ix), ringOf(ix + 1), ringOf(jz), ringOf(jz + 1));
        if (rc < RING_IN || rc > RING_OUT) continue;
        // West of the city mesh's rim there is nothing to add — see
        // WEST_MESH_EDGE. Uses the cell's EAST bound so the cut lands on a
        // shared lattice line and the city mesh's own edge still meets ground.
        if (-f.half + (ix + 1) * f.cell <= WEST_MESH_EDGE) continue;
        cells.push(jz * f.n + ix);
      }
    }
    const triCount = cells.length * 2;
    const pos = new Float32Array(triCount * 9);
    const col = new Float32Array(triCount * 9);
    let o = 0;
    const corners = [0, 0, 0];
    for (const cell of cells) {
      const ix = cell % f.n;
      const jz = (cell - ix) / f.n;
      const a = jz * stride + ix;
      const b = a + 1;
      const d = a + stride;
      const cc = d + 1;
      for (let t = 0; t < 2; t++) {
        // Split on the a-c diagonal and wound exactly as HeightField.height
        // interpolates, so heightAt and the rendered surface cannot disagree.
        if (t === 0) { corners[0] = a; corners[1] = cc; corners[2] = b; } else { corners[0] = a; corners[1] = d; corners[2] = cc; }
        let mr = 0, mg = 0, mb = 0;
        for (let v = 0; v < 3; v++) {
          const k = corners[v];
          mr += vcol[k * 3]; mg += vcol[k * 3 + 1]; mb += vcol[k * 3 + 2];
        }
        const jit = (1 + (hash2(ix * 2 + t, jz * 2 + 977) - 0.5) * 0.2) / 3;
        mr *= jit; mg *= jit; mb *= jit;
        for (let v = 0; v < 3; v++) {
          const k = corners[v];
          pos[o] = gpos[k * 3]; col[o++] = mr;
          pos[o] = gpos[k * 3 + 1]; col[o++] = mg;
          pos[o] = gpos[k * 3 + 2]; col[o++] = mb;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();     // non-indexed, so these ARE face normals
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.97, metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'frontier_ground';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.ground = mesh;
    this.group.add(mesh);
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
    this._triangles += triCount;
  }

  // ------------------------------------------------------------------- POIs

  /**
   * Anchor + seeded jitter + validate. Fills this.pois with world positions;
   * nothing is built yet, because the pads have to be carved before the ground
   * mesh exists.
   */
  _placePois() {
    const rnd = this.rnd;
    for (const def of POIS) {
      let x = def.x, z = def.z;
      // Up to eight seeded tries at a jittered spot, then the anchor — which is
      // authored to satisfy every rule, so placement can never fail outright.
      for (let t = 0; t < 8; t++) {
        const jx = def.x + (rnd() * 2 - 1) * 7;
        const jz = def.z + (rnd() * 2 - 1) * 7;
        if (this._validatePlacement(def, jx, jz).length === 0) { x = jx; z = jz; break; }
      }
      this.pois.push({
        id: def.id,
        name: def.name,
        stamp: def.stamp,
        rank: def.rank || null,
        pad: def.pad,
        pos: new THREE.Vector3(x, 0, z),   // y filled in once the pad is baked
        radius: def.radius,
        discovered: false,
        // Where citizens.js should stand the camp's people, and how many of
        // them. Left as data rather than spawned here: citizens.js owns every
        // body in the world and City.build creates the crowd after the Verge, so
        // the anchors are ready before anything could want them.
        //
        // Carried onto the BUILT record, not just the private POIS table. The
        // first cut left npcs/npcHunter on the table only — nothing downstream
        // could see them, and both camps shipped empty while the source still
        // claimed they were populated.
        npcs: def.npcs || 0,
        npcHunter: Boolean(def.npcHunter),
        npcAnchors: [],
      });
    }
  }

  /**
   * The spec's poiRules, mechanically. Returns a list of broken rule names —
   * empty means the spot is legal. frontier-test calls this through the built
   * POI list rather than trusting a comment.
   */
  _validatePlacement(def, x, z, ignoreId = null) {
    const bad = [];
    const rc = Math.max(Math.abs(x), Math.abs(z));
    if (rc < POI_MIN_R) bad.push('poi_min_r');
    // The pad must not reach the radius where City.heightAt hands authority
    // from the city field to this one — see the note above POIS.
    if (rc - (def.pad + POI_FEATHER) <= POI_SEAM_CLEAR) bad.push('pad_reaches_seam');
    if (rc > SCATTER_OUT) bad.push('outside_walkable');
    if (x <= CLIFF_X) bad.push('west_of_cliff');
    if (Math.max(Math.abs(x), Math.abs(z)) - WALL_HALF < POI_MIN_WALL) bad.push('too_close_to_wall');
    if (Math.hypot(x, z - BREACH_Z) < POI_MIN_BREACH) bad.push('breach_ash');
    if (this.field && this.field.slope(x, z) > POI_MAX_SLOPE) bad.push('slope');
    for (const other of POIS) {
      if (other.id === def.id || other.id === ignoreId) continue;
      const p = this.pois.find((q) => q.id === other.id);
      const ox = p ? p.pos.x : other.x;
      const oz = p ? p.pos.z : other.z;
      if (Math.hypot(x - ox, z - oz) < POI_MIN_SEP) { bad.push('separation'); break; }
    }
    return bad;
  }

  /** Stamp every POI: geometry, colliders, banner entry, wild gates. */
  _buildPois() {
    this._poiMat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.87, metalness: 0.02,
    });
    this._ownedMaterials.push(this._poiMat);

    for (const poi of this.pois) {
      const x = poi.pos.x, z = poi.pos.z;
      const y = this.heightAt(x, z);
      poi.pos.y = y;

      const st = new Stamp();
      switch (poi.stamp) {
        case 'ruinArch': this._stampRuinArch(st); break;
        case 'ruinHall': this._stampRuinHall(st); break;
        case 'watchtower': this._stampWatchtower(st); break;
        case 'campHunters': this._stampCampHunters(st, poi, x, y, z); break;
        case 'campFarmstead': this._stampCampFarmstead(st, poi, x, y, z); break;
        case 'wildGate': this._stampWildGate(st, poi, x, y, z); break;
        default: break;
      }

      if (st.geos.length) {
        const geo = mergeAll(st.geos);
        const mesh = new THREE.Mesh(geo, this._poiMat);
        mesh.name = `poi_${poi.id}`;
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        this._ownedGeometries.push(geo);
        this._triangles += st.tris;
      }

      // Colliders, in world space, BEFORE City._buildHash — the whole reason
      // the Verge is built where it is in City.build.
      for (const s of st.solids) {
        const o = { pos: { x: x + s.x, z: z + s.z }, radius: s.radius };
        this._solids.push(o);
        this.city.obstacles.push(o);
      }
      // A keep-out so the scatter pass does not grow a willow through the hall.
      this._solids.push({ pos: { x, z }, radius: poi.pad + 1.5 });

      // The banner IS the discovery system (see city.js DISTRICTS).
      registerVergeDistrict({
        id: poi.id, name: poi.name, pos: { x, z },
        pad: Math.max(10, poi.radius - 8), service: null, verge: true,
      });
    }
  }

  // --- stamps ---------------------------------------------------------------
  // Local space: origin at the POI centre, y = 0 on the (flat) pad. Kit pieces
  // are placed by their authored pivots — ruin pieces stand on y = 0, town wall
  // pieces put their slab on the +X edge of a 2 m cell (citykit MODULES.edge),
  // which is what the wall rings below are working around.

  /**
   * A floor of 2 m tiles between r0 and r1, with a crumbled edge.
   *
   * r0 exists because the wild gates' first cut tiled a full disc and the
   * portal dais — 5.4 m at scale 1.5, so 8.1 m of solid cylinder — covered
   * every one of them. Sixty invisible tiles is 7k triangles of nothing.
   */
  _stampTiles(st, r1, rnd, keep = 0.58, r0 = 0) {
    const n = Math.ceil(r1 / 2);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const d = Math.hypot(i * 2, j * 2);
        if (d > r1 || d < r0) continue;
        if (d > r1 * 0.6 && rnd() > keep) continue;
        st.piece('ruin_floor_squarelarge', i * 2, 0.02, j * 2, 0);
      }
    }
  }

  /**
   * The postcard: an avenue of two gothic arches on a tiled pad, ringed by
   * standing and fallen columns.
   */
  _stampRuinArch(st) {
    const rnd = this.rnd;
    this._stampTiles(st, 7.5, rnd);
    // SCALED UP, and the reason is a screenshot. At scale 1 the arch is 3.76 m
    // and the columns are 4 m; from the east gate mouth — the sightline this
    // POI exists to sit on, 118 m away — the whole cluster was four grey pixels
    // on the horizon while the wild gate's 8.7 m oval read instantly. A postcard
    // you cannot see from where the composition points is not a postcard. 1.45x
    // puts the arches at 5.5 m and the standing columns at 5.4 m, which is tree
    // height out here, and costs zero extra triangles.
    for (const dz of [-3.6, 3.6]) {
      st.piece('ruin_arch_gothic', 0, 0, dz, 0, 1.45);
      st.solid(-2.0, dz, 0.7).solid(2.0, dz, 0.7);
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const cx = Math.cos(a) * 6.8, cz = Math.sin(a) * 6.8;
      // Two of five have come down. A ruin where every column still stands is
      // a colonnade, not a ruin.
      if (i % 2 === 0) {
        st.piece('ruin_column_round', cx, 0, cz, rnd() * 6.283, 1.25 + rnd() * 0.2);
        st.solid(cx, cz, 0.6);
      } else {
        st.piece('ruin_column_round_short', cx, 0, cz, rnd() * 6.283, 1);
        st.solid(cx, cz, 0.5);
      }
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.9;
      const cx = Math.cos(a) * 8.6, cz = Math.sin(a) * 8.6;
      st.piece('ruin_wall_broken', cx, 0, cz, -a, 0.9 + rnd() * 0.3);
      st.solid(cx, cz, 0.85);
    }
  }

  /**
   * "Interior without a roof" — the piece that teaches, for free, that ruins
   * out here can be walked into.
   */
  _stampRuinHall(st) {
    const rnd = this.rnd;
    const HX = 6, HZ = 4;
    // ruin_wall_archround is 4 m wide, pivot at its centre, thin along local z.
    // Long walls run along x; the ends run along z with a quarter turn.
    for (const sx of [-4, 0, 4]) {
      st.piece('ruin_wall_archround', sx, 0, HZ, 0);
      st.solid(sx, HZ, 1.0);
      // The north long wall keeps a 4 m gap in the middle: that gap IS the
      // doorway, and an entrance you can see through from outside is the only
      // thing that makes a walled rectangle read as enterable.
      if (sx !== 0) { st.piece('ruin_wall_archround', sx, 0, -HZ, Math.PI); st.solid(sx, -HZ, 1.0); }
    }
    for (const sz of [-2, 2]) {
      st.piece('ruin_wall_archround', HX, 0, sz, Math.PI / 2);
      st.solid(HX, sz, 1.0);
      st.piece('ruin_wall_archround', -HX, 0, sz, -Math.PI / 2);
      st.solid(-HX, sz, 1.0);
    }
    st.piece('ruin_window_bars', 2, 0, -HZ, Math.PI);
    st.piece('ruin_window_bars', -2, 0, HZ, 0);
    for (const s of [-1, 1]) {
      st.piece('ruin_bookcase_empty', s * 3.2, 0, HZ - 0.7, Math.PI);
      st.solid(s * 3.2, HZ - 0.7, 0.7);
    }
    for (let i = 0; i < 3; i++) {
      const px = (rnd() * 2 - 1) * (HX - 1.4);
      const pz = (rnd() * 2 - 1) * (HZ - 1.2);
      st.piece(i % 2 ? 'ruin_pot2' : 'ruin_pot1', px, 0, pz, rnd() * 6.283);
    }
    for (let i = -3; i <= 2; i++) {
      for (let j = -2; j <= 1; j++) st.piece('ruin_floor_squarelarge', i * 2 + 1, 0.02, j * 2 + 1, 0);
    }
  }

  /**
   * Three storeys of town wall on a plinth, with an exterior switchback of
   * stone stairs. The kit has no spiral piece and one is not invented here.
   */
  _stampWatchtower(st) {
    // Plinth.
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) st.piece('ruin_floor_squarelarge', i * 2, 0.04, j * 2, 0);
    }
    // Four faces of a 4 m box. town_wall's slab sits at local x 0.8..1.0 and
    // spans local z +-1, so a piece placed 0.9 m inside the face lands ON it.
    const face = [
      { yaw: 0, ox: 1.1, oz: 0, ax: 0, az: 1 },              // +X
      { yaw: Math.PI, ox: -1.1, oz: 0, ax: 0, az: 1 },       // -X
      { yaw: Math.PI / 2, ox: 0, oz: -1.1, ax: 1, az: 0 },   // -Z
      { yaw: -Math.PI / 2, ox: 0, oz: 1.1, ax: 1, az: 0 },   // +Z
    ];
    for (let storey = 0; storey < 3; storey++) {
      const y = 0.25 + storey * 2;
      for (const f of face) {
        for (const s of [-1, 1]) {
          const px = f.ox + f.ax * s;
          const pz = f.oz + f.az * s;
          // The way in is on the FIRST floor, at the top of the outside stair
          // below — which is what a watchtower on a hostile plain would do, and
          // it is also the only door placement the stair can honestly reach.
          const door = storey === 1 && f.yaw === -Math.PI / 2 && s === -1;
          st.piece(door ? 'town_wall_doorway_square' : 'town_wall', px, y, pz, f.yaw);
        }
      }
      // NO corner pillars. town_pillar_stone reads terracotta ORANGE against
      // the Kenney atlas's white walls (screenshot poi-verge-watchtower-air) and
      // the four wall slabs already close their own corners, so twelve of them
      // were paying 1.5k triangles to stripe the tower.
    }
    // The deck is ruin_floor_squarelarge, NOT town_roof_flat: the roof piece is
    // the kit's teal tile and a stone watchtower with a green lid reads as an
    // asset mistake, not as a colour choice.
    for (const cx of [-1, 1]) {
      for (const cz of [-1, 1]) st.piece('ruin_floor_squarelarge', cx, 6.3, cz, 0);
    }
    for (const f of face) {
      for (const s of [-1, 1]) {
        st.piece('town_wall_half', f.ox + f.ax * s, 6.35, f.oz + f.az * s, f.yaw);
      }
    }
    // ONE flight, on the ground, against the +Z face and rising to the first
    // floor. The first cut stacked three flights at y 0.25 / 2.25 / 4.25 around
    // the tower and the upper two hung in mid-air with nothing under them.
    st.piece('town_stairs_stone', 0, 0.25, 2.55, 0);
    // One collider for the whole shaft: a 3.2 m circle inscribes the 4.6 m
    // square closely enough that nothing reads as walking through stone, and it
    // is one hash entry instead of sixteen.
    st.solid(0, 0, 3.2);
  }

  /**
   * Where other hunters stage before a gate. The fiction of the whole Verge in
   * one stamp: someone else is out here doing what you are doing.
   */
  _stampCampHunters(st, poi, wx, wy, wz) {
    const rnd = this.rnd;
    // A fence arc facing away from town, so the camp reads as sheltered rather
    // than fenced in — and so you can walk straight into it from the road.
    const toTown = Math.atan2(-wz, -wx);
    for (let i = 0; i < 11; i++) {
      const a = toTown + Math.PI - 1.35 + (i / 10) * 2.7;
      const ca = Math.cos(a), sa = Math.sin(a);
      // town_fence's plank sits on its +X edge, 0.9 m out from the piece origin
      // (citykit MODULES.edge). Placing the origin 0.9 m INSIDE the arc puts the
      // plank on the arc, which is also where the collider goes — a fence you
      // stop 0.9 m short of is the classic invisible-wall bug report.
      st.piece('town_fence', ca * 7.6, 0, sa * 7.6, Math.atan2(-sa, ca));
      st.solid(ca * 8.5, sa * 8.5, 0.5);
    }
    st.piece('town_stall_red', -3.4, 0, -2.2, toTown);
    st.solid(-3.4, -2.2, 1.1);
    st.piece('town_stall', 3.6, 0, -2.6, toTown + Math.PI);
    st.solid(3.6, -2.6, 0.9);
    st.piece('town_cart', 4.4, 0, 3.2, toTown + 0.6);
    st.solid(4.4, 3.2, 1.2);
    for (let i = 0; i < 3; i++) {
      const a = 0.9 + i * 2.1;
      const bx = Math.cos(a) * 2.6, bz = Math.sin(a) * 2.6;
      st.piece('town_stall_bench', bx, 0, bz, a + Math.PI / 2);
      st.solid(bx, bz, 0.5);
    }
    // Fire ring + logs, procedural because the kit has no campfire. The FLAME
    // is a separate unlit mesh (see _buildCampfire) — an emissive quad merged
    // into the stamp would be lit by the sun and go grey at night, which is the
    // one hour a campfire has a job.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      st.box(0.42, 0.26, 0.42, Math.cos(a) * 1.05, 0.08, Math.sin(a) * 1.05, 0x6e6a66, a);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      st.box(0.16, 0.16, 1.5, Math.cos(a) * 0.3, 0.2, Math.sin(a) * 0.3, 0x4a3524, a, 0.42);
    }
    this._buildCampfire(wx, wy + 0.15, wz, rnd);
    poi.npcAnchors.push({ x: wx + 2.2, z: wz + 1.4 }, { x: wx - 2.6, z: wz - 1.2 });
  }

  /** The east-meadow anchor: somebody grows food out here. */
  _stampCampFarmstead(st, poi, wx, wy, wz) {
    const rnd = this.rnd;
    const HX = 7, HZ = 5;
    // See the hunters' camp: the plank sits 0.9 m off the piece origin, so the
    // origin goes inside the line and the collider goes on it.
    for (let i = -3; i <= 3; i++) {
      for (const s of [-1, 1]) {
        st.piece('town_fence', i * 2, 0, s * (HZ - 0.9), s > 0 ? -Math.PI / 2 : Math.PI / 2);
        st.solid(i * 2, s * HZ, 0.45);
      }
    }
    for (let j = -2; j <= 2; j++) {
      for (const s of [-1, 1]) {
        // The east run keeps a gap at j = 0: the way in.
        if (s > 0 && j === 0) continue;
        st.piece('town_fence', s * (HX - 0.9), 0, j * 2, s > 0 ? 0 : Math.PI);
        st.solid(s * HX, j * 2, 0.45);
      }
    }
    st.piece('town_cart', -HX + 2.2, 0, -HZ + 2.4, 0.8);
    st.solid(-HX + 2.2, -HZ + 2.4, 1.2);
    st.piece('town_stall', HX - 2.4, 0, HZ - 2.2, Math.PI);
    st.solid(HX - 2.4, HZ - 2.2, 0.9);

    // Crops as LOCAL instanced fields. A NatureField whose instances all sit in
    // one 14 x 10 m patch has a tight bounding sphere, so unlike the Verge's
    // global scatter it is frustum-culled from anywhere else in the world — the
    // draw-call objection to instancing does not apply at POI scale.
    const wheat = new NatureField('wheat', 64, { castShadow: false, name: 'outfarm_wheat' });
    const corn = new NatureField('corn_1', 24, { castShadow: false, name: 'outfarm_corn' });
    this.fields.push(wheat, corn);
    // Three rows, not five: wheat is 408 triangles a stalk and corn is 566, so
    // a "field" of them is the most expensive thing per pixel in the whole
    // Verge. Three rows plus the corn block still reads as a worked plot.
    for (let row = -1; row <= 1; row++) {
      for (let i = 0; i < 11; i++) {
        const cx = wx - 5.5 + i * 1.1 + (rnd() - 0.5) * 0.3;
        const cz = wz + row * 1.9 + (rnd() - 0.5) * 0.4;
        wheat.place(cx, this.heightAt(cx, cz) - 0.03, cz, rnd() * 6.283, 0.9 + rnd() * 0.4);
      }
    }
    for (let i = 0; i < 12; i++) {
      const cx = wx + 3.4 + (i % 3) * 1.3 + (rnd() - 0.5) * 0.3;
      const cz = wz - 3.6 + Math.floor(i / 3) * 1.3 + (rnd() - 0.5) * 0.3;
      corn.place(cx, this.heightAt(cx, cz) - 0.03, cz, rnd() * 6.283, 0.85 + rnd() * 0.3);
    }
    poi.npcAnchors.push({ x: wx - 2.4, z: wz + 2.6 });
  }

  /**
   * A wild gate: the city's own portal build, dropped on a broken ruin pad 200 m
   * from anyone who could regulate it.
   *
   * The portal object is appended to city.portals with wild:true, which is the
   * whole trick — portalAt, nearestPortal, the compass, the prompt, the dusk
   * boost and the anomaly flicker all walk that array and none of them needed a
   * line changed.
   */
  _stampWildGate(st, poi, wx, wy, wz) {
    const rnd = this.rnd;
    const city = this.city;
    const rank = poi.rank || 'E';
    const gate = GATES.find((g) => g.rank === rank) || null;
    const color = PORTAL_COLORS[rank] ?? 0xbfd0ff;
    // Bigger than a plaza gate, smaller than the Breach. At scale 1 the oval is
    // 4.3 x 5.8 m and simply does not read from the 120 m of open ground you
    // approach it across; at 1.5 the ring is the first thing you pick out.
    const scale = 1.5;
    // The save's level at build time. citymode.refreshPortalLocks re-applies
    // this a moment later through City.setPortalState (which now walks EVERY
    // portal of a rank, precisely so the wild C gate gets locked too), but a
    // gate that renders unlocked for one frame before being sealed is a flicker
    // the player sees on every city entry.
    const level = Number(city._saveLevel) || 1;
    const locked = level < (gate?.reqLevel ?? 1);

    // A broken apron OUTSIDE the dais — see _stampTiles' r0.
    this._stampTiles(st, 11.5, rnd, 0.5, 8.6);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.25;
      const cx = Math.cos(a) * 10.2, cz = Math.sin(a) * 10.2;
      if (i % 3 === 0) {
        st.piece('ruin_column_round', cx, 0, cz, rnd() * 6.283, 0.95);
        st.solid(cx, cz, 0.55);
      } else {
        st.piece('ruin_wall_broken', cx, 0, cz, -a, 1.1);
        st.solid(cx, cz, 0.9);
      }
    }

    const built = buildPortalVisual(this.group, {
      rank,
      color,
      scale,
      locked,
      yaw: Math.atan2(-wx, -wz),      // face the town, like the plaza gates
      geos: city._portalGeos,
    });
    built.group.position.set(wx, wy, wz);
    this._ownedMaterials.push(...built.materials);
    this._ownedGeometries.push(...built.geometries);   // empty when geos was shared
    this._triangles += 240;

    const portal = {
      rank,
      // A COPY of the gate row, renamed. citymode's prompt shows gate.name as
      // the sub-line, and "THE WARREN" on a gate nobody has surveyed undersells
      // the only thing that makes wild gates worth the walk.
      gate: gate ? { ...gate, name: `UNSURVEYED ${rank}-GRADE RIFT` } : null,
      pos: new THREE.Vector3(wx, wy, wz),
      radius: 6.0,
      color,
      locked,
      anomaly: false,
      wild: true,
      poi: poi.id,
      group: built.group,
      phase: rnd() * 6.283,
      meshes: built.meshes,
      _flick: 0,
    };
    city.portals.push(portal);
    this.wildGates.push(portal);
    city._applyPortalState(portal);
    poi.portal = portal;

    // The dais is solid, exactly as on the plaza.
    const o = { pos: { x: wx, z: wz }, radius: 2.6 * scale };
    this._solids.push(o);
    city.obstacles.push(o);
  }

  /**
   * An unlit flame. NO light and NOT on GLOW_LAYER: a PointLight would
   * recompile every material in the scene (city.js decision 2) and the additive
   * glow pass washes dark frames, which is the documented reason the dusk
   * portal pop raises material values instead of the bloom.
   */
  _buildCampfire(x, y, z, rnd) {
    const parts = [];
    for (let i = 0; i < 2; i++) {
      const g = new THREE.PlaneGeometry(0.9, 1.2, 1, 2);
      g.translate(0, 0.6, 0);
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v++) {
        const t = Math.min(1, pos.getY(v) / 1.2);
        // TAPERED, and dimmer than the first cut. A full-width untoned quad on
        // a MeshBasic material at opacity 0.85 rendered as a white sheet the
        // size of a door from 26 m out (screenshot poi-camp-hunters-east) —
        // brighter than anything else in the frame including the sky.
        pos.setX(v, pos.getX(v) * (1 - t * 0.88));
        col[v * 3] = 0.95 - t * 0.12;
        col[v * 3 + 1] = 0.62 - t * 0.42;
        col[v * 3 + 2] = 0.20 - t * 0.16;
      }
      pos.needsUpdate = true;
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.rotateY(i * Math.PI / 2);
      parts.push(g);
    }
    const geo = mergeAll(parts);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.72,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'verge_campfire';
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
    this._fires.push({ mesh, mat, phase: rnd() * 6.283 });
    this._triangles += 8;
  }

  // ---------------------------------------------------------------- scatter

  _buildScatter() {
    const city = this.city;
    const rnd = this.rnd;
    const q = city.quality?.current || { instanceScale: 1, shadows: true };
    // The town's own build density, not a second reading of the same tier: one
    // number decides what "full" means for every field in the world, which is
    // what lets City.setInstanceDensity thin both halves by the same fraction.
    const density = city._buildDensity ?? Math.max(0.35, Math.min(1.35, q.instanceScale ?? 1));

    // Shadow policy, decided at BUILD time and never touched afterwards.
    //
    // A global InstancedMesh is frustum-tested by its bounding sphere, and this
    // annulus's sphere contains the player at all times — so a casting tree
    // field renders ALL of its instances into the 44 m shadow frustum every
    // frame, whatever is actually near enough to cast into it. 220 trees at
    // ~1.4k triangles is ~300k triangles of depth pass for shadows that are
    // almost always off-frustum. Bushes and rocks are 100-360 triangles and buy
    // the contact shadow that stops a solid reading as a sticker, so they cast
    // at every tier; trees cast only where there is headroom for them.
    const treeShadows = !!q.shadows && (q.instanceScale ?? 1) >= 0.9;

    for (const spec of SPECIES) {
      const target = Math.max(1, Math.round(spec.n * density));
      const field = new NatureField(spec.key, target + 4, {
        castShadow: spec.solid > 0 && (spec.tree ? treeShadows : !!q.shadows),
        name: `verge_${spec.key}`,
      });
      this.fields.push(field);
      const group = { field, solids: [] };
      this._scatter.push(group);

      let placed = 0;
      const clearance = spec.solid > 0 ? 2.2 : 0.6;
      for (let tries = 0; tries < target * 26 && placed < target; tries++) {
        const p = this._pick(spec, rnd);
        if (!p || !this._spotOk(p.x, p.z, clearance, spec)) continue;
        placed += this._place(group, spec, p.x, p.z, rnd);
        if (spec.clump) {
          const extra = 2 + Math.floor(rnd() * 4);
          for (let e = 0; e < extra && placed < target; e++) {
            const a = rnd() * 6.283;
            const rr = (spec.solid > 0 ? 2.6 : 0.7) + rnd() * (spec.solid > 0 ? 4.0 : 1.7);
            const nx = p.x + Math.cos(a) * rr;
            const nz = p.z + Math.sin(a) * rr;
            if (!this._spotOk(nx, nz, clearance, spec)) continue;
            placed += this._place(group, spec, nx, nz, rnd);
          }
        }
      }
    }
  }

  /** One candidate point in the species' band, on the square annulus. */
  _pick(spec, rnd) {
    let az;
    if (spec.verge) {
      // Ground tufts hug the lines the town's four avenues point down — the
      // only "paths" the Verge has until step 7 lays camps and ruins on it.
      // Bare open country is meant to look bare; tufts belong where feet go.
      // Default lanes are east, south and the Breach road north. Flowers skip
      // the Breach road: blossom on burnt ground reads as the wrong asset.
      const lanes = spec.lanes || [0, 90, 270];
      const lane = lanes[Math.floor(rnd() * lanes.length)];
      az = lane + (rnd() * 2 - 1) * 11;
    } else if (spec.bands) {
      const arc = BANDS[spec.bands[Math.floor(rnd() * spec.bands.length)]].arc;
      az = arc[0] + rnd() * (arc[1] - arc[0]);
    } else {
      // Bandless fallback — every species in the table today names its bands,
      // but a terrain-gated one (see `high`) may not want an arc at all. Any
      // direction except the cliff wedge behind the town.
      az = rnd() * 320 - 140;      // -140..180, i.e. skips 180..220
    }
    const rad = (az * Math.PI) / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const m = Math.max(Math.abs(ca), Math.abs(sa)) || 1;
    // Chebyshev radius, so the sample lands on the SQUARE annulus the ground
    // mesh actually covers. Sampling a circle instead puts a third of the
    // meadow inside the town at 45 degrees.
    const rc = SCATTER_IN + rnd() * (SCATTER_OUT - SCATTER_IN);
    return { x: (rc * ca) / m, z: (rc * sa) / m };
  }

  /**
   * Where Verge scatter may stand: on the annulus, east of the cliff, off the
   * Breach ash, off anything already placed here, and on ground this species
   * can actually hold.
   */
  _spotOk(x, z, clearance, spec) {
    if (x < CLIFF_X + 8) return false;
    const rc = Math.max(Math.abs(x), Math.abs(z));
    if (rc < SCATTER_IN || rc > SCATTER_OUT) return false;
    if (Math.hypot(x, z - BREACH_Z) < 26) return false;
    if (this.field.slope(x, z) > 0.4) return false;
    if (spec.high != null && this.field.height(x, z) < spec.high) return false;
    for (const o of this._solids) {
      const dx = x - o.pos.x, dz = z - o.pos.z;
      const min = o.radius + clearance;
      if (dx * dx + dz * dz < min * min) return false;
    }
    return true;
  }

  _place(group, spec, x, z, rnd) {
    const field = group.field;
    const s = spec.s[0] + rnd() * (spec.s[1] - spec.s[0]);
    const sy = spec.sy ? spec.sy[0] + rnd() * (spec.sy[1] - spec.sy[0]) : s;
    // Sunk 3 cm so a base edge never floats above a flat-shaded facet, same as
    // the town's scatter. heightAt, not the mesh: the mesh is sunk near the
    // seam and a tree must stand on the surface the player walks on.
    if (!field.place(x, this.heightAt(x, z) - 0.03, z, rnd() * 6.283, s, sy)) return 0;
    if (spec.solid > 0) {
      // `i` ties this collider to its instance so a thinned tree stops blocking
      // when it stops drawing. _spotOk still scans _solids at BUILD time with
      // every entry live, so thinning never changes where anything was placed.
      const o = { pos: { x, z }, radius: spec.solid * s, i: field.count - 1, off: false };
      this._solids.push(o);
      this.city.obstacles.push(o);
      group.solids.push(o);
    }
    return 1;
  }

  // ------------------------------------------------------------------ query

  heightAt(x, z) { return this.field ? this.field.height(x, z) : 0; }

  groundNormal(x, z, out) {
    const o = out || { x: 0, y: 1, z: 0 };
    if (!this.field) { o.x = 0; o.y = 1; o.z = 0; return o; }
    return this.field.normal(x, z, o);
  }

  // -------------------------------------------------------------- per frame

  /**
   * Discovery, and (from step 7) campfire flicker and wild-gate pulses.
   *
   * Allocation-free by construction: no closures, no vectors, and the POI list
   * is walked with an index. This runs every frame in the hub.
   */
  update(dt, playerPos) {
    this._t += dt;
    const t = this._t;
    // Campfire flicker. Two sine terms at incommensurable rates so it never
    // reads as a loop, written straight onto existing objects — no vectors, no
    // colour temporaries, nothing allocated in a hub frame.
    for (let i = 0; i < this._fires.length; i++) {
      const f = this._fires[i];
      const a = Math.sin(t * 8.3 + f.phase);
      const b = Math.sin(t * 13.7 + f.phase * 2.1);
      f.mesh.scale.set(0.94 + b * 0.06, 1 + a * 0.16, 0.94 + b * 0.06);
      f.mat.opacity = 0.66 + a * 0.1 + b * 0.05;
    }
    if (!playerPos) return;
    for (let i = 0; i < this.pois.length; i++) {
      const p = this.pois[i];
      if (p.discovered) continue;
      const dx = playerPos.x - p.pos.x;
      const dz = playerPos.z - p.pos.z;
      if (dx * dx + dz * dz > p.radius * p.radius) continue;
      p.discovered = true;
      this.onDiscover?.(p);
    }
  }

  // --------------------------------------------------------------- teardown

  dispose() {
    // The banner list is a module-level array shared with citymode; leaving
    // seven Verge entries on it would name a POI at the player from inside a
    // town that no longer has a Verge.
    clearVergeDistricts();
    // NOT city.portals: City.dispose truncates that itself, and splicing the
    // wild gates out from here would race it. The wild gates' GROUPS hang off
    // this.group and go with group.clear() below; their materials are in
    // _ownedMaterials.
    this.wildGates.length = 0;
    this._fires.length = 0;
    for (const f of this.fields) f.dispose();
    this.fields.length = 0;
    for (const g of this._ownedGeometries) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedGeometries.length = 0;
    this._ownedMaterials.length = 0;
    this.group.clear();
    this.group.removeFromParent();
    this.emptyFields.length = 0;
    this.ground = null;
    this.field = null;
    this.pois.length = 0;
    // NOT city.obstacles: City.dispose truncates that list itself, and racing
    // it from here would splice entries the town still owns.
    this._solids.length = 0;
    this._scatter.length = 0;
    this._triangles = 0;
    this._triangleBase = 0;
  }

  // ------------------------------------------------------------------ stats

  get triangles() { return this._triangles; }

  get stats() {
    let drawGroups = 0;
    let instances = 0;
    this.group.traverse((o) => {
      if (o.isInstancedMesh) { drawGroups++; instances += o.count; } else if (o.isMesh) drawGroups++;
    });
    return {
      drawGroups,
      instances,
      triangles: Math.round(this._triangles),
      groundTriangles: this.ground ? this.ground.geometry.attributes.position.count / 3 : 0,
      solids: this._solids.length,
      emptyFields: this.emptyFields.slice(),
      pois: this.pois.length,
      wildGates: this.wildGates.length,
      // Everything the harness needs to check poiRules without re-deriving it.
      poiList: this.pois.map((p) => ({
        id: p.id,
        name: p.name,
        x: +p.pos.x.toFixed(2),
        y: +p.pos.y.toFixed(2),
        z: +p.pos.z.toFixed(2),
        pad: p.pad,
        radius: p.radius,
        rank: p.rank,
        discovered: p.discovered,
        npcAnchors: p.npcAnchors.length,
        violations: this._validatePlacement(
          POIS.find((d) => d.id === p.id), p.pos.x, p.pos.z, p.id,
        ),
      })),
      limit: VERGE_LIMIT,
    };
  }
}
