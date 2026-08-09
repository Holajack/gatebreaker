import * as THREE from 'three';
import { mulberry32, fbm } from './terrain.js';
import {
  KIT_CELL, KIT_STOREY, KitField, cityKitLoaded, cityMaterials,
  disposeCityKit, cityKitStats, loadCityKit, loadDungeonKit, pieceGeometryColored,
} from './citykit.js';
import { NatureField, loadNatureKit, natureKitStats } from './naturekit.js';
import { Citizens } from './citizens.js';
// Cyclic on purpose and safe: frontier.js imports terrain constants + HeightField
// + groundBase from here, this file imports only the Frontier class and
// VERGE_LIMIT, and both are read inside methods, never during module evaluation.
import { Frontier, VERGE_LIMIT } from './frontier.js';
// The five enterable service buildings. Cyclic in the same safe way frontier.js
// is: interiors.js imports nothing from here at module scope, and this file
// touches Interiors only inside build()/dispose().
import { Interiors } from './interiors.js';
// Placement parameters as DATA. This file enforces them while it builds;
// tools/ imports validateLayout from the same module and asserts them off
// city.layoutMeta afterwards, so builder and test read one table.
import {
  LAYOUT_RULES, DISTRICT_PROFILES, districtOfPoint, silhouetteTuple,
  corridorCap, pointSegDistance, segParam, compareAlongStreet,
} from './layoutrules.js';
import { GLOW_LAYER } from '../render/glow.js';
import { makeSky, updateSkyState } from '../render/sky.js';
import { buildBiomeEnvironment } from '../render/env.js';
import { GATES } from '../game/config.js';

// ---------------------------------------------------------------------------
// THRESHOLD — the city hub
// ---------------------------------------------------------------------------
// A walkable town grown around a permanent gate cluster. Walled on three sides,
// cliff on the fourth, six rank portals: E/D/C/B/A stand on one plaza ring so
// all five colours read from a single standing position, and S is outside the
// north wall so reaching it costs a walk.
//
// This module builds a PLACE. It owns geometry, ground, collision and portal
// visuals. It does not own the game mode, the camera, input, prompts or entry
// — those belong to src/game/modes/citymode.js and src/ui/cityui.js.
//
// -- The three decisions worth arguing about --------------------------------
//
// 1. THE GROUND IS ITS OWN AUTHORITY. A baked heightfield array is generated
//    first; the visual mesh is that array, and heightAt() interpolates inside
//    the exact triangle the mesh drew. Not "similar" — the same numbers. The
//    heightfield/collision/nav disagreements this avoids are invisible until a
//    player falls through the world, and then they are unfindable.
//
// 2. NO POINT LIGHTS, EVER. overworld.js:293 toggled PointLight.visible as the
//    player walked. NUM_POINT_LIGHTS is part of three's program cache key, so
//    every toggle recompiles every material in the scene. Portal glow and lit
//    windows here are emissive geometry on GLOW_LAYER instead.
//
// 3. ONE InstancedMesh PER PIECE TYPE FOR THE WHOLE CITY, not per chunk. The
//    spec asks for per-64 m-chunk groups toggled by Group.visible; that is the
//    right answer when each chunk is ONE merged mesh, and the wrong answer for
//    instanced fields, because a field split across N visible chunks multiplies
//    its draw calls by N. A 64 m chunk of this town contains 10-14 distinct
//    piece types, so chunking would cost ~250 draw calls at the spec's own
//    cityChunkRadius of 4 against ~40 for global fields. Measured numbers are
//    in tools/city-test.mjs. Triangle count is the price paid instead, and it
//    is capped by BUILDING_BUDGET rather than by culling.

export const PORTAL_COLORS = {
  E: 0x8b97c9,
  D: 0x2ad4c0,
  C: 0x4ade80,
  B: 0xa78bfa,
  A: 0xffc24b,
  S: 0xff4d6d,
  ANOMALY: 0xff7af0,
};

// Geometry of the town, in metres. Everything else derives from these.
// 340 x 340 m of ground, of which 176 x 176 is inside the wall — the spec's
// figure. The walled part is deliberately the smaller share: a hub you cross
// in 25 seconds with something every 15 m beats a bigger one you cross in 50
// seconds with nothing in between, and the Breach road spends the rest.
const WALL_HALF = 88;           // walled interior spans -88..88 on x and z
const WORLD_HALF = 170;         // heightfield half-extent (340 m square)
const GROUND_CELL = 3.4;        // heightfield / ground-mesh resolution
const PLAZA_R = 26;             // flagstone disc at the centre
const PORTAL_RING = 22;         // where E..A stand
const BREACH_Z = -126;          // the S portal, outside the north wall
const CLIFF_X = -WALL_HALF;     // ground falls away west of here
const BUILDING_BUDGET = 92;     // hard cap; see decision 3 above
const WALK_LIMIT = 134;         // how far out resolve() lets anything walk

// --- the frontier's half of the terrain contract ---------------------------
// These live HERE, not in frontier.js, because city.js owns HeightField and the
// shared analytic surface both fields sample. frontier.js imports them; the only
// thing that flows the other way is the Frontier class itself and VERGE_LIMIT,
// and both are read at call time, so the import cycle never touches a binding
// during module evaluation.
//
// 6.8 is EXACTLY 2 x GROUND_CELL and 285.6 is EXACTLY 42 x 6.8, which is what
// makes the two lattices interlock: 170 = 25 x 6.8, so every second city vertex
// lands on a frontier vertex and no seam vertex is ever orphaned.
export const FRONTIER_CELL = GROUND_CELL * 2;   // 6.8
export const FRONTIER_HALF = FRONTIER_CELL * 42; // 285.6

// Where the ground stops being ground and falls into sky. Without a frontier
// this is the shipped 140..156 lip; with one it moves out past the walk limit.
const CITY_EDGE = [140, 156];
export const VERGE_EDGE = [264, 278];

// heightAt authority: city field inside, frontier field outside, linear blend
// between. Chebyshev radius (max(|x|,|z|)), matching the square lip and the
// square ground meshes — a circular band would cut corners off the seam.
//
// SPEC DEVIATION, and it is a correctness fix rather than a preference. The
// spec says 166..174; the city field's data ENDS at WORLD_HALF = 170, and
// HeightField.height clamps outside that, so a band reaching to 174 mixes in a
// clamped edge value. Measured, that injected up to 1.29 m of error at r 176 —
// which is precisely the ledge at the seam the band exists to prevent. 162..170
// sits wholly inside both fields' real data. It costs nothing: the stitch makes
// the two fields identical from 155 outward, so the band is a formality either
// way, and the frontier is authoritative from 170 where the city's data stops.
export const BLEND_R0 = 162;
export const BLEND_R1 = 170;

// Where the city field stops being its own fine surface and becomes a resampled
// copy of the frontier's coarse one. See HeightField.bake.
const STITCH_R0 = 138;
const STITCH_R1 = 155;

// -Z is north. Angles below are measured with 0 = east and +ve toward north,
// so the arc reads E..A left-to-right when the player walks in from the south.
const PORTAL_ANGLES = { E: 198, D: 144, C: 90, B: 36, A: -18 };

/**
 * The six districts of Threshold. `pos` is the interaction / arrival point,
 * `pad` is the radius of level ground carved under it.
 *
 * NOTE: the spec's export comment says "5 entries" but cityHub.districts lists
 * six. Six are built and six are exported — the Breach is a place you walk to,
 * not a footnote. Consume these by `id`, never by index.
 */
const TOWN_DISTRICTS = [
  { id: 'plaza',    name: 'THE GATE PLAZA', pos: { x: 0, z: 0 },       pad: PLAZA_R, service: null },
  { id: 'assay',    name: 'THE ASSAY HALL', pos: { x: 0, z: -38 },     pad: 15, service: 'assay' },
  { id: 'ashworks', name: 'THE ASHWORKS',   pos: { x: 44, z: 4 },      pad: 16, service: 'barracks' },
  { id: 'exchange', name: 'THE EXCHANGE',   pos: { x: -4, z: 34 },     pad: 15, service: 'exchange' },
  { id: 'row',      name: 'QUARTER ROW',    pos: { x: -52, z: 2 },     pad: 14, service: null },
  { id: 'breach',   name: 'THE BREACH',     pos: { x: 0, z: BREACH_Z }, pad: 18, service: null },
];

/**
 * The banner list. citymode._updateDistrict walks THIS array every frame and
 * names whatever pad the player is standing in.
 *
 * It is LIVE rather than frozen because that is the whole discovery system for
 * the Verge: the spec asks for "a one-time named toast (existing district-banner
 * pattern)" when you first reach a POI, and the banner already exists, already
 * fires on change, and already reads well 200 m from town. Frontier.build
 * registers one entry per POI and Frontier.dispose takes them straight back off,
 * so a rebuilt city never accumulates them.
 *
 * City.build reads TOWN_DISTRICTS, NOT this — the six town pads carve flats into
 * the city heightfield and drive the layout occupancy grid, and a POI 200 m out
 * flattening the city field's clamped rim is exactly the seam bug BLEND_R0 was
 * moved to avoid. Generation and signage are deliberately different lists.
 */
export const DISTRICTS = TOWN_DISTRICTS.slice();

/** Add a Verge POI to the banner list. Returns the entry so the caller can drop it. */
export function registerVergeDistrict(entry) {
  DISTRICTS.push(entry);
  return entry;
}

/** Truncate back to the town six. Idempotent — dispose paths run twice here. */
export function clearVergeDistricts() {
  DISTRICTS.length = TOWN_DISTRICTS.length;
}

// Doors the player can stand in front of. Radii are generous because a phone
// player steers with a thumb, not a mouse.
//
// `open` gates the PROMPT, not the record. A door whose feature does not exist
// yet must not stop the player and announce "NOT YET OPEN" — the playtest
// called the stash prompt out as exactly that. The closed entries stay in
// this.interactables (their districts, pads and layout all still stand, and
// the ids are part of the module's contract), but interactAt() skips them, so
// nothing in the world advertises a system that is not built. Flip `open` when
// the feature ships — citymode's confirmPrompt already routes by id.
//
// assay sits at z = -32, not -30: at -30 its 4.5 m radius overlapped the C
// portal's prompt zone (radius 5.2 + 2.2 slack from y = -22) and the two
// systems fought over the same strip of pavement.
const INTERACTABLES = [
  { id: 'barracks', label: 'THE ASHWORKS',   pos: { x: 44, z: 12 },  radius: 4.5, open: false },
  { id: 'assay',    label: 'THE ASSAY HALL', pos: { x: 0, z: -32 },  radius: 4.5, open: true },
  { id: 'trial',    label: 'THE SEALED STAIR', pos: { x: -7, z: -38 }, radius: 3.5, open: false },
  // OPEN as of the weapon shop: game/shop.js + ui/shopui.js are behind this
  // prompt, and citymode.confirmPrompt routes 'exchange' to them. This is the
  // `open` flip the comment above describes, not a new mechanism.
  { id: 'exchange', label: 'THE EXCHANGE',   pos: { x: -4, z: 26 },  radius: 4.5, open: true },
  { id: 'stash',    label: 'THE STASH',      pos: { x: 6, z: 34 },   radius: 3.5, open: false },
];

// Late afternoon, not dusk.
//
// Dusk was the first attempt and it was wrong for a reason worth writing down:
// the base scene got dark enough that the additive glow pass — which composites
// pow(1 - exp(-g), 1/2.2), so even a near-zero blurred value lands visibly
// above black — washed the entire frame. Every street lamp and lit window on
// GLOW_LAYER became a screen-wide haze and the city read as coloured fog. The
// portals still pop in daylight because they are saturated primaries against a
// muted stone-and-timber palette; a whole town you cannot see does not.
//
// GLOW_LAYER now carries the six portals and nothing else.
const CITY_BIOME = {
  fog: 0xb6c6dc, ground: 0x5d6a4c, accent: 0xffd9a8,
  sky: 0x74a2da, pillar: 0x8a90a0, detail: 0xd8e0ee,
};

// The same palette pre-brightened for makeSky().
//
// sky.js feeds its colours to a raw ShaderMaterial through
// convertSRGBToLinear(), and three's ColorManagement has ALREADY converted the
// hex on construction — so the sky shader receives linear(linear(c)) and
// renders roughly one gamma step too dark. That is sky.js's convention and
// every other biome in the game is authored against it; correcting it here
// would silently re-tone six dungeons. Compensating locally is the change that
// does not reach outside this file.
const SKY_BIOME = {
  fog: 0xdfe8f4, ground: 0x9aa885, accent: 0xffeccd,
  sky: 0xb6d3f5, pillar: 0xc2c7d2, detail: 0xeef2f8,
};

// --------------------------------------------------------------- day/night
//
// The shipped 15:00 fog distances. applyDayState scales BOTH by dayState
// fogScale (1.0 by day, 0.88 at deep night) rather than re-authoring them per
// keyframe: the near/far pair is a single "how far can you see" knob and
// keeping one multiplier on it is what stops the two ends drifting apart.
const FOG_NEAR = 130;
const FOG_FAR = 430;

// The lit-window quad and the lamp bulb each have ONE shared toneMapped:false
// MeshBasicMaterial, so the whole day ramp is two colour writes per frame.
//
// Windows scale from their lit hex straight down by dayState.windowGlow — at
// 15:00 that is 0.2, dim enough to read as daylight on glass rather than a lamp
// left on. Lamp bulbs LERP to an unlit-glass hex instead of scaling to black:
// a bulb multiplied to zero is a black dot in a bright lantern head, which
// reads as a missing texture, not as an unlit lamp. This is also the fix for
// the honesty bug of every street lamp glowing at three in the afternoon.
const WINDOW_LIT = 0xffcf8c;
const LAMP_LIT = 0xffd18a;
const LAMP_UNLIT = 0x4a4038;

// The dusk portal pop, WORLD_SPEC duskPortalGlow. These raise ONLY the six
// portals' own material values. GLOW_LAYER membership and the global glow
// strength are untouched on purpose — the postmortem above is exactly what
// happens when a dark frame meets a stronger additive composite.
const PORTAL_OVAL_MUL = [0.55, 0.80];       // oval colour multiplier, base -> dusk
const PORTAL_RING_EMIT = [0.85, 1.35];      // ring emissiveIntensity, base -> dusk
const PORTAL_MARK_OPACITY = [0.26, 0.38];   // ground marker opacity, base -> dusk
// dayState.portalBoost runs 1.0 (day) to 1.6 (dusk/night); normalise it to the
// 0..1 the three ramps above are authored in.
const PORTAL_BOOST_SPAN = 0.6;

// Blue-hour floor. daynight.js already floors the key at 0.18; this is the
// hemisphere half of the same rule, restated where it is APPLIED so a future
// keyframe edit cannot quietly take the city to true black and hand the glow
// composite a frame it will wash out.
const HEMI_NIGHT_FLOOR = 0.30;

const smoothstep = (a, b, x) => {
  if (b === a) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// HeightField — the single source of truth for "where is the ground"
// ---------------------------------------------------------------------------

/**
 * THE analytic ground surface. Both HeightFields — the city's 3.4 m one and the
 * frontier's 6.8 m one — sample this and nothing else, so the two can never
 * drift apart the way two copies of the same maths always eventually do.
 *
 * `edge` is [r0, r1], the Chebyshev band over which the world falls into sky.
 * It is the ONLY thing that differs between the two builds: without a frontier
 * the world ends at 140..156 exactly as shipped; with one it ends at 264..278
 * and the same call returns real terrain where the old lip used to be.
 *
 * The west cliff is unchanged and its void floor still falls away at 140..156,
 * because that is the shot the owner liked and it is the one place the world is
 * MEANT to visibly stop. The two edge terms are combined with max() rather than
 * applied in sequence: lerping toward -46 twice squares the weight and lands
 * the shipped city 12 m lower than it renders today.
 */
export function groundBase(x, z, seed, edge = CITY_EDGE) {
  const s = 1 / 96;
  let h = (fbm(x * s, z * s, seed, 3) - 0.5) * 5.2;
  h += (fbm(x * s * 3.1 + 17, z * s * 3.1 - 9, seed + 41, 2) - 0.5) * 1.6;

  // West cliff: the ground simply stops. Spread over 16 m so the mesh's own
  // linear interpolation still tracks it and heightAt cannot drift.
  const onLedge = smoothstep(CLIFF_X - 16, CLIFF_X - 1, x);
  h = lerp(-34, h, onLedge);

  // The world ENDS rather than being fenced in by a ridge.
  //
  // The first version raised a 44 m boundary ridge on the other three sides.
  // It worked from the air and ruined every eye-level shot: from Quarter Row
  // and from the Breach road it read as a flat grey backdrop flat filling the
  // horizon, because a 44 m wall 60 m away is exactly that. Dropping the
  // ground away instead puts sky on the horizon in all directions, matches
  // the west cliff, and suits a world with rifts in it. The player is stopped
  // by resolve()'s walk limit well before the lip, so it is not a fall hazard.
  const r = Math.max(Math.abs(x), Math.abs(z));
  const worldEdge = smoothstep(edge[0], edge[1], r);
  // West of the cliff the void floor keeps its ORIGINAL fall-away, whatever the
  // world edge is doing, so the Overlook does not become a 160 m grey shelf.
  const westEdge = smoothstep(CITY_EDGE[0], CITY_EDGE[1], r) * (1 - onLedge);
  h = lerp(-46, h, 1 - Math.max(worldEdge, westEdge));

  // The Breach approach climbs: walking out to the S gate is uphill.
  const bd = Math.hypot(x, z - BREACH_Z);
  h += smoothstep(62, 16, bd) * 7.5;
  return h;
}

/** 0 inside r0, 1 past r1 — how much of the coarse lattice a vertex takes on. */
function stitchWeight(x, z, stitch) {
  return smoothstep(stitch.r0, stitch.r1, Math.max(Math.abs(x), Math.abs(z)));
}

export class HeightField {
  /**
   * `edge` is the [r0, r1] band where the world falls into sky. It is a
   * constructor argument rather than a constant because the city field and the
   * frontier field are the SAME surface with the edge in a different place —
   * see groundBase.
   *
   * `stitch` (frontier builds only) makes this field resample itself onto a
   * coarser lattice near its rim. Non-null means { cell, r0, r1 }.
   */
  constructor({ size, cell, seed, edge = CITY_EDGE, stitch = null }) {
    this.size = size;
    this.half = size / 2;
    this.cell = cell;
    this.n = Math.round(size / cell);          // cells per side
    this.stride = this.n + 1;
    this.h = new Float32Array(this.stride * this.stride);
    this.seed = seed >>> 0;
    this.edge = edge;
    this.stitch = stitch;
    this.flats = [];
  }

  /** Level a disc into the field. `height` null means "level to its centre". */
  addFlat({ x, z, radius, feather = 6, height = null }) {
    this.flats.push({ x, z, radius, feather, height });
    return this;
  }

  /** The undisturbed shape at this field's own edge placement. */
  raw(x, z) {
    return groundBase(x, z, this.seed, this.edge);
  }

  /**
   * The same surface evaluated on the STITCH lattice instead of this field's
   * own. This is the whole LOD trick and it is worth being precise about:
   *
   * The frontier lattice is anchored on multiples of FRONTIER_CELL (6.8) and
   * 6.8 = 2 x 3.4, so every city cell lies wholly inside one frontier TRIANGLE
   * (the fine vertex at the cell's centre sits exactly on the coarse diagonal).
   * A linear interpolation between three points that all lie on one plane is
   * that plane. So once the stitch weight reaches 1 the city field is not
   * "close to" the frontier field — it IS it, to float precision, vertex for
   * vertex AND everywhere between vertices.
   *
   * That is what buys a seam with no crack, no z-fight and no 0.4 m step: the
   * naive version (two fields, same maths, different cell size) disagrees by up
   * to 0.46 m on the Breach-bump gradient, measured, which is a visible ledge
   * you can walk off.
   */
  _coarse(x, z) {
    const c = this.stitch.cell;
    const ix = Math.floor(x / c), jz = Math.floor(z / c);
    const u = x / c - ix, v = z / c - jz;
    const gx = ix * c, gz = jz * c;
    // Split on the a-c diagonal, exactly as height() does.
    const ha = groundBase(gx, gz, this.seed, this.edge);
    const hc = groundBase(gx + c, gz + c, this.seed, this.edge);
    if (u >= v) {
      const hb = groundBase(gx + c, gz, this.seed, this.edge);
      return ha + (hb - ha) * (u - v) + (hc - ha) * v;
    }
    const hd = groundBase(gx, gz + c, this.seed, this.edge);
    return ha + (hc - ha) * u + (hd - ha) * (v - u);
  }

  bake() {
    const { n, stride, cell, half } = this;
    for (let jz = 0; jz <= n; jz++) {
      const z = -half + jz * cell;
      for (let ix = 0; ix <= n; ix++) {
        const x = -half + ix * cell;
        let v = this.raw(x, z);
        if (this.stitch) v = lerp(v, this._coarse(x, z), stitchWeight(x, z, this.stitch));
        for (const f of this.flats) {
          const d = Math.hypot(x - f.x, z - f.z);
          const w = 1 - smoothstep(f.radius, f.radius + f.feather, d);
          if (w <= 0) continue;
          const target = f.height == null ? this.raw(f.x, f.z) : f.height;
          v = lerp(v, target, w);
        }
        this.h[jz * stride + ix] = v;
      }
    }
    return this;
  }

  at(ix, jz) {
    const i = Math.min(this.n, Math.max(0, ix));
    const j = Math.min(this.n, Math.max(0, jz));
    return this.h[j * this.stride + i];
  }

  /**
   * Ground height, evaluated inside the exact triangle the ground mesh drew.
   * Allocation-free: physics.js calls this per entity per frame.
   *
   * The quad (ix,jz) is split on the a-c diagonal, matching buildGeometry():
   *   a = (ix, jz)      b = (ix+1, jz)
   *   d = (ix, jz+1)    c = (ix+1, jz+1)
   */
  height(x, z) {
    const { cell, half } = this;
    const fx = (x + half) / cell;
    const fz = (z + half) / cell;
    let ix = Math.floor(fx), jz = Math.floor(fz);
    if (ix < 0) ix = 0; else if (ix > this.n - 1) ix = this.n - 1;
    if (jz < 0) jz = 0; else if (jz > this.n - 1) jz = this.n - 1;
    const u = Math.min(1, Math.max(0, fx - ix));
    const v = Math.min(1, Math.max(0, fz - jz));
    const ha = this.at(ix, jz);
    const hc = this.at(ix + 1, jz + 1);
    if (u >= v) {
      const hb = this.at(ix + 1, jz);
      return ha + (hb - ha) * (u - v) + (hc - ha) * v;
    }
    const hd = this.at(ix, jz + 1);
    return ha + (hc - ha) * u + (hd - ha) * (v - u);
  }

  /** Face normal of that same triangle, written into `out`. */
  normal(x, z, out) {
    const { cell, half } = this;
    const fx = (x + half) / cell;
    const fz = (z + half) / cell;
    let ix = Math.floor(fx), jz = Math.floor(fz);
    if (ix < 0) ix = 0; else if (ix > this.n - 1) ix = this.n - 1;
    if (jz < 0) jz = 0; else if (jz > this.n - 1) jz = this.n - 1;
    const u = Math.min(1, Math.max(0, fx - ix));
    const v = Math.min(1, Math.max(0, fz - jz));
    const ha = this.at(ix, jz);
    const hc = this.at(ix + 1, jz + 1);
    let dhdx, dhdz;
    if (u >= v) {
      const hb = this.at(ix + 1, jz);
      dhdx = (hb - ha) / cell;
      dhdz = (hc - hb) / cell;
    } else {
      const hd = this.at(ix, jz + 1);
      dhdx = (hc - hd) / cell;
      dhdz = (hd - ha) / cell;
    }
    const len = Math.hypot(dhdx, 1, dhdz) || 1;
    out.x = -dhdx / len;
    out.y = 1 / len;
    out.z = -dhdz / len;
    return out;
  }

  slope(x, z) {
    _n.x = 0; _n.y = 1; _n.z = 0;
    this.normal(x, z, _n);
    return 1 - Math.max(0, Math.min(1, _n.y));
  }
}

const _n = { x: 0, y: 1, z: 0 };

// ---------------------------------------------------------------------------
// Street plan
// ---------------------------------------------------------------------------
// Streets are painted into the ground's vertex colours rather than tiled with
// road pieces: paving that IS the ground can never step, float or disagree
// with heightAt, and it costs zero draw calls and zero triangles.

function buildStreets() {
  const seg = (x1, z1, x2, z2, w) => ({ x1, z1, x2, z2, w });
  const s = [
    // Four avenues out of the plaza.
    seg(0, -PLAZA_R, 0, -WALL_HALF + 2, 6),
    seg(0, PLAZA_R, 0, WALL_HALF - 2, 6),
    seg(PLAZA_R, 0, WALL_HALF - 2, 0, 6),
    seg(-PLAZA_R, 0, CLIFF_X + 4, 0, 6),
    // The Breach road, outside the north gate.
    seg(0, -WALL_HALF, 0, BREACH_Z + 14, 4.5),
  ];
  // Ring road at 58 m, as a 20-gon so it stays cheap to rasterise.
  const R = 58, N = 20;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    s.push(seg(Math.cos(a0) * R, -Math.sin(a0) * R, Math.cos(a1) * R, -Math.sin(a1) * R, 4.5));
  }
  // Cross streets, so no block is more than ~20 m from a way through.
  for (const k of [-1, 1]) {
    s.push(seg(k * 32, -WALL_HALF + 5, k * 32, WALL_HALF - 5, 4));
    s.push(seg(-WALL_HALF + 5, k * 32, WALL_HALF - 5, k * 32, 4));
    s.push(seg(k * 66, -68, k * 66, 68, 3.4));
    s.push(seg(-68, k * 66, 68, k * 66, 3.4));
  }
  return s;
}

function distToSegment(x, z, s) {
  const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - s.x1) * dx + (z - s.z1) * dz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(x - (s.x1 + dx * t), z - (s.z1 + dz * t));
}

// ---------------------------------------------------------------------------
// Portal visuals — shared by the plaza gates and the Verge's wild gates
// ---------------------------------------------------------------------------
//
// Extracted from City._buildPortals rather than reimplemented in frontier.js.
// A wild gate that merely LOOKS like a portal is a maintenance trap: the dusk
// boost, the anomaly flicker and the locked treatment all reach into
// portal.meshes by name, and the first divergence between the two builders
// would show up as one gate in the world that does not react to dusk. There is
// one builder, so there cannot be two behaviours.

/** Triangles in one portal's four meshes. Measured, not derived — see stats. */
const PORTAL_TRIANGLES = 240;

/**
 * THE DOORSTEP MEMORY, and it is module-level for a reason worth writing down.
 *
 * citymode._spawnVector picks the portal to step out of with
 * `portals.find(p => p.rank === atPortal)`, and a wild gate shares its rank with
 * a plaza gate — so returning from the wild E gate 200 m out would drop the
 * player back on the plaza. game.js and citymode.js are not this step's files
 * and the spec's requirement is precisely that they work UNMODIFIED, so the fix
 * lives where the array does: remember the last portal the player stood at, and
 * if it was a wild one, order it ahead of its plaza twin on the next build.
 *
 * It cannot be a City field: game._setMode destroys the CityMode AND its City on
 * every gate entry and constructs fresh ones on the way back, so anything stored
 * on the instance is gone by the time it would be read. It cannot live on `game`
 * either without editing game.js. A module-level slot is what is left, and it is
 * honest about what it is: one page runs one player.
 *
 * Written by City._notePortalProximity, consumed (and cleared) by
 * City._promoteReturnPortal.
 */
let _lastWildPortal = null;   // { rank, x, z } | null

/**
 * The buffers four-mesh portals share. One set per City; frontier.js borrows
 * the City's rather than minting its own, so two wild gates cost zero extra
 * geometries and the City's owned lists remain the only disposal path.
 *
 * @returns {{dais, oval, ring, mark, daisMat, geometries: THREE.BufferGeometry[], materials: THREE.Material[]}}
 */
export function portalGeometries() {
  const dais = mergeAll([
    cylinder(4.9, 5.4, 0.34, 24, 0x9aa0b0),
    cylinder(3.9, 4.2, 0.72, 24, 0xb4bac8),
    cylinder(3.5, 3.5, 0.84, 24, 0x8f95a6),
  ]);
  const daisMat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0.06,
  });
  const oval = new THREE.CircleGeometry(1, 40);
  oval.scale(2.15, 2.9, 1);
  const ring = new THREE.TorusGeometry(1, 0.075, 8, 44);
  ring.scale(2.3, 3.05, 1);
  const mark = new THREE.RingGeometry(4.4, 5.0, 44);
  mark.rotateX(-Math.PI / 2);
  return {
    dais, oval, ring, mark, daisMat,
    geometries: [dais, oval, ring, mark],
    materials: [daisMat],
  };
}

/**
 * Build one portal's four meshes under `parent` and return them.
 *
 * The three coloured materials are PER PORTAL (each one animates its own pulse
 * and its own anomaly flicker) and are handed back in `materials` for the caller
 * to register for disposal — this function owns nothing it does not return.
 * Geometry is passed in via `geos`; omitting it mints a private set, which is
 * returned in `geometries` for the same reason.
 *
 * @param {THREE.Object3D} parent
 * @param {{rank?:string,color?:number,scale?:number,locked?:boolean,yaw?:number,geos?:object}} opts
 */
export function buildPortalVisual(parent, {
  rank = 'E', color = 0xffffff, scale = 1, locked = false, yaw = 0, geos = null,
} = {}) {
  const own = geos ? null : portalGeometries();
  const g = geos || own;

  const group = new THREE.Group();
  group.name = `portal_${String(rank).toLowerCase()}`;
  group.rotation.y = yaw;
  group.scale.setScalar(scale);

  const dais = new THREE.Mesh(g.dais, g.daisMat);
  dais.receiveShadow = true;
  dais.castShadow = true;
  group.add(dais);

  // GLOW_LAYER carries the portal SURFACE and nothing else — not the ring,
  // not the ground marker. Glow.render composites additively through
  // pow(1 - exp(-g), 1/2.2), so anything on that layer at full intensity
  // blows to white and takes a 60 px halo with it; at 0.55 the portal reads
  // as its own colour with a rim of light instead of a headlight.
  const ovalMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(locked ? dim(color) : color).multiplyScalar(0.55),
    transparent: true, opacity: locked ? 0.18 : 0.5, side: THREE.DoubleSide,
    depthWrite: false, toneMapped: false,
  });
  const oval = new THREE.Mesh(g.oval, ovalMat);
  oval.position.set(0, 3.4, 0);
  oval.layers.enable(GLOW_LAYER);
  group.add(oval);

  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x171a2a, roughness: 0.42, metalness: 0.55,
    emissive: new THREE.Color(locked ? dim(color) : color),
    emissiveIntensity: locked ? 0.24 : 0.85,
  });
  const ring = new THREE.Mesh(g.ring, ringMat);
  ring.position.set(0, 3.4, 0);
  ring.castShadow = false;
  group.add(ring);

  const markMat = new THREE.MeshBasicMaterial({
    color: locked ? dim(color) : color,
    transparent: true, opacity: locked ? 0.1 : 0.26, side: THREE.DoubleSide,
    depthWrite: false, toneMapped: false,
  });
  const marker = new THREE.Mesh(g.mark, markMat);
  marker.position.y = 1.32;
  group.add(marker);

  parent.add(group);
  return {
    group, dais, oval, ring, marker,
    meshes: { dais, oval, ring, marker },
    materials: [ovalMat, ringMat, markMat],
    geometries: own ? own.geometries : [],
  };
}

// ---------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------

export class City {
  constructor(scene, renderer, camera, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.quality = quality;

    this.group = new THREE.Group();
    this.group.name = 'city';
    scene.add(this.group);

    this.field = null;
    this.frontier = null;     // the Verge, when built. See build(opts.frontier).
    this.interiors = null;    // the five enterable shells. See interiors.js.
    this.portals = [];
    this.interactables = [];
    this.obstacles = [];      // { pos:{x,z}, radius } — round props
    this.boxes = [];          // { x, z, w, d, rot } — buildings and walls
    this.fields = [];         // KitField instances
    this.districts = TOWN_DISTRICTS;
    this.streets = [];
    this.built = false;
    // The retained _layout output — a few KB of plain objects, kept because
    // validateLayout() cannot re-derive style/floors/district/door from the
    // instanced fields once they are merged into KitFields. Dev-invaluable,
    // free on the device.
    this.layoutMeta = [];
    // Why the layout came out the size it did — see _layout's tallies.
    this.layoutStats = null;
    // The prop placements the spacing rules govern. Same reason: once a stall
    // is an instance matrix inside a shared field there is no way back to a
    // position list.
    this.propMeta = { fountains: [], benches: [], stalls: [] };

    this._navGrid = null;
    this._t = 0;
    this._envRT = null;
    this._ownedGeometries = [];
    this._ownedMaterials = [];
    this._hash = null;
    this._hashCell = 8;
    this._triangles = 0;
    // --- runtime density (the phone-budget fence, see setInstanceDensity) ---
    // Fields this City is willing to THIN without a rebuild, each with the
    // obstacle records its instances own so collision can be switched off with
    // them. Populated by _buildNature; the Verge keeps its own list.
    this._scatter = [];
    // this._triangles at full density, so the lever can subtract rather than
    // re-derive a number that also counts merged meshes and interiors.
    this._triangleBase = 0;
    // The density the world was BUILT at. The lever can only shed relative to
    // this — instances that were never placed cannot be conjured at runtime.
    this._buildDensity = 1;
    this._density = 1;
    this._prevScene = null;
    this.citizens = null;
    this._flags = null;
    this._flagMesh = null;
    // Portal buffers, minted in _buildPortals and borrowed by the Verge's wild
    // gates. Owned by _ownedGeometries; this is a handle, not a second owner.
    this._portalGeos = null;


    // --- day/night state -------------------------------------------------
    // The shadow snap aims along THIS vector. It used to be a module-level
    // constant, which was correct only while the sun never moved; it is
    // per-City now because two Cities (a rebuild mid-teardown) must not share
    // one aim. applyDayState feeds it from the clock, ALREADY QUANTISED by
    // daynight.js to 0.75-degree steps on a grid anchored on this exact
    // vector — so 15:00 reproduces the shipped direction bit for bit, and no
    // intermediate hour re-snaps the shadow texel grid often enough to make
    // every edge in the city crawl. Do NOT re-quantise here: quantising a
    // quantised value on a second grid re-introduces the crawl.
    this._lightDir = new THREE.Vector3(58, 74, 40).normalize();
    this._windowMat = null;
    this._lampMat = null;
    // Portal dusk boost, normalised 0..1. -1 forces the first applyDayState to
    // push it through even when the clock opens at exactly 1.0.
    this._portalU = -1;
  }

  // ------------------------------------------------------------------ build

  /**
   * Assemble the city. Synchronous by design: citykit.glb must already be
   * loaded (await loadCityKit() during boot) or every piece silently falls
   * back to its procedural twin — which still builds a coherent, walkable,
   * collidable city, just a blockier one.
   */
  build(seed = 20260806, save = null, opts = {}) {
    this.dispose();
    // dispose() detaches the group from the scene; a rebuilt City must come
    // back, whether this instance is fresh or reused across city entries.
    if (!this.group.parent) this.scene.add(this.group);
    const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);

    // The Verge is ON unless a caller explicitly opts out. Default-off would
    // mean the only configuration anyone ever plays is the one no test covers;
    // opting out exists so a harness can measure the town on its own and so a
    // future low-end tier has a lever that is not "delete the file".
    const wantFrontier = opts.frontier !== false;
    // The density every instanced field is SIZED at, captured ONCE here rather
    // than read separately by each builder. It is what "full" means for this
    // build, and setInstanceDensity measures against it: the runtime lever can
    // shed instances that were placed, never conjure ones that were not.
    const q0 = this.quality?.current || { instanceScale: 1 };
    this._buildDensity = Math.max(0.35, Math.min(1.35, q0.instanceScale ?? 1));
    this._density = this._buildDensity;
    // Read once here rather than threaded through every builder: the Verge's
    // wild gates need it for their initial locked state and are built five
    // steps later, by a different file.
    this._saveLevel = Number(save?.level) || 1;

    // 1. Ground first: everything else is placed onto it.
    //
    // With a frontier, this field's rim is resampled onto the frontier lattice
    // (stitch) and its own lip moves out past the walk limit, so the town's
    // ground and the Verge's are one continuous surface rather than two that
    // nearly agree. Without a frontier both arguments fall back to the shipped
    // values and this line builds byte-for-byte the field it always did.
    this.field = new HeightField({
      size: WORLD_HALF * 2,
      cell: GROUND_CELL,
      seed,
      edge: wantFrontier ? VERGE_EDGE : CITY_EDGE,
      stitch: wantFrontier ? { cell: FRONTIER_CELL, r0: STITCH_R0, r1: STITCH_R1 } : null,
    });
    for (const d of this.districts) {
      this.field.addFlat({ x: d.pos.x, z: d.pos.z, radius: d.pad, feather: 12, height: d.id === 'plaza' ? 0 : null });
    }
    this.field.bake();

    this.streets = buildStreets();

    // 1b. The five enterable service buildings CLAIM THEIR PLOTS FIRST.
    //
    // Order is load-bearing three ways and every one of them is a bug if it
    // slips: _layout's occupancy grid asks interiors.blocksCell so no
    // procedural terrace lands on a shop; plan() levels each plot into the
    // field before the bake() below; and the solid footprint boxes it parks in
    // this.boxes are what keep _buildProps's lanterns and _buildNature's trees
    // out of the front rooms — neither of those knows interiors.js exists, and
    // both already test this.boxes.
    this.interiors = new Interiors(this).plan();

    // 2. Lay the town out on the 2 m kit grid, then carve a pad under every
    //    building so no wall floats and no doorstep is a cliff.
    const buildings = this._layout(rnd);
    // Retained for validateLayout(). Same object identity as what the builders
    // mutate below (topY lands in _buildBuildings), so this is a handle, not a
    // copy that can drift out of date.
    this.layoutMeta = buildings;
    for (const b of buildings) {
      this.field.addFlat({
        x: b.cx, z: b.cz,
        radius: Math.max(b.w, b.d) * 0.5 + 1.4,
        feather: 4.5,
        height: this.field.height(b.cx, b.cz),
      });
    }
    // The five enterable plots level LAST. bake() applies flats in order and a
    // later one overrides an earlier one, so a neighbouring building's pad —
    // which reaches several metres past its own footprint — was tilting the
    // ground up through the floor of a room the player stands in. Nothing else
    // in town has an interior, so nothing else noticed.
    this.interiors.levelPlots();
    this.field.bake();

    // 3. Geometry.
    this._buildSkyAndLight();
    this._buildGround();
    this._buildCityWall();
    this._buildBuildings(buildings, rnd);
    this._buildProps(rnd, buildings);
    this._buildPortals(rnd, save);
    this._buildFlags(rnd);
    this._buildNature(rnd);

    // The Verge, before _buildHash and before attachNavGrid: its trees, bushes
    // and rocks are real colliders and they go into this.obstacles like every
    // other solid, so collision and the navgrid stay single-owner. It runs
    // AFTER _buildNature on purpose — _natureSpotOk linear-scans this.obstacles,
    // and 500 frontier solids would turn the town's own scatter placement into
    // a quadratic that costs a quarter of a second on a phone for no benefit.
    if (wantFrontier) {
      this.frontier = new Frontier(this, rnd).build();
      this._triangles += this.frontier.triangles;
      // After the wild gates exist, and before anything reads portals by rank.
      this._promoteReturnPortal();
    }

    this._buildInteractables();

    // The shells, AFTER _buildInteractables (their prompts move inside) and
    // after every prop pass (the reserved footprints have done their job), but
    // BEFORE _buildHash: build() swaps each solid footprint for four wall-run
    // boxes with a hole in one of them, and the hash is what collision reads.
    // Forked stream, never the town's own: a rebuild must reproduce, and the
    // window dice in here must not shift the procedural city by one draw.
    this.interiors.build(mulberry32((seed ^ 0x5bf03635) >>> 0));
    this._triangles += this.interiors.triangles;

    for (const f of this.fields) { f.finalize().addTo(this.group); this._triangles += f.triangles; }
    // Full-density cost, banked before anything can thin it. setInstanceDensity
    // subtracts from this rather than re-summing, because _triangles also counts
    // merged ground, walls, buildings and interiors that no lever touches.
    this._triangleBase = this._triangles;
    this._buildHash();

    // Last, and after _buildHash on purpose: the crowd steers with the same
    // resolve() the player uses, so the spatial hash must already exist.
    this.citizens = new Citizens(this);
    // `save` is read-only here and only for the companion: citizens.js takes
    // roster slot 0 and walks it around the city with the player (WORLD_SPEC
    // step 11). A save with an empty roster spawns nobody extra.
    this.citizens.build(rnd, { save });

    this.built = true;
    return this;
  }

  // --------------------------------------------------------------- teardown

  dispose() {
    // Citizens first: their skinned meshes hold shared geometry/materials the
    // instance refcounts, plus per-instance skeleton bone textures — the
    // generic traversal below knows nothing about either.
    if (this.citizens) { this.citizens.dispose(); this.citizens = null; }
    // Before the traversal below, for the same reason as citizens: the Frontier
    // owns NatureFields whose geometry and materials are SHARED with the kit and
    // must not be dropped by a generic traverse, and its own merged ground mesh,
    // which must.
    if (this.frontier) { this.frontier.dispose(); this.frontier = null; }
    // Before the traversal too: the five shells own merged geometries but SHARE
    // cityMaterials().shell and City's own window material, and a generic
    // traverse cannot tell the difference.
    if (this.interiors) { this.interiors.dispose(); this.interiors = null; }
    this._flags = null;
    this._flagMesh = null;
    this.group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    for (const g of this._ownedGeometries) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedGeometries.length = 0;
    this._ownedMaterials.length = 0;
    for (const f of this.fields) f.dispose();
    this.fields.length = 0;
    // The key light's depth map is a render target, not a mesh resource, so
    // neither the InstancedMesh traversal nor the owned lists above ever saw
    // it — one leaked depth texture per city visit (same bug world.js clear()
    // fixes for gates). Detach the group too: clear() empties it but leaves
    // the husk on the scene, and city<->gate cycling strands one per mount.
    this.key?.shadow?.map?.dispose();
    if (this.key?.shadow) this.key.shadow.map = null;
    this.key = null;
    this.hemi = null;
    this.sky = null;
    // Both live in _ownedMaterials and were disposed above; these are the
    // applyDayState handles, and a dangling ref to a disposed material is a
    // write into nothing that silently does nothing.
    this._windowMat = null;
    this._lampMat = null;
    // Disposed with _ownedGeometries above; this is the handle frontier.js
    // borrows, and a dangling one would hand a rebuilt Verge dead buffers.
    this._portalGeos = null;
    this._portalU = -1;
    this._lightDir.set(58, 74, 40).normalize();
    this.group.clear();
    this.group.removeFromParent();

    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this._prevScene) {
      this.scene.fog = this._prevScene.fog;
      this.scene.background = this._prevScene.background;
      this.scene.environment = this._prevScene.environment;
      // Restored explicitly: a midnight city that dimmed the scene to 0.30 and
      // then handed the scene to a gate would light the whole dungeon wrong,
      // and nothing in the gate path would report it.
      this.scene.environmentIntensity = this._prevScene.environmentIntensity ?? 1;
      this._prevScene = null;
    }

    this.portals.length = 0;
    this.interactables.length = 0;
    this.obstacles.length = 0;
    this.boxes.length = 0;
    this.layoutMeta = [];
    this.layoutStats = null;
    this.propMeta = { fountains: [], benches: [], stalls: [] };
    this.field = null;
    this._hash = null;
    this._navGrid = null;
    this._triangles = 0;
    // The sheddable-field registry holds live references to fields the loop
    // above just disposed; carrying it across a rebuild would have the density
    // lever writing counts into dead InstancedMeshes.
    this._scatter.length = 0;
    this._triangleBase = 0;
    this._density = this._buildDensity;
    this.built = false;
  }

  // ------------------------------------------------------------ sky + light

  _buildSkyAndLight() {
    // Captured as one object, including the nulls. Storing them as three
    // "or null" fields and then restoring only the non-null ones leaves the
    // city's fog and environment behind on the scene after dispose(), which
    // the next mode inherits and nothing reports.
    this._prevScene = {
      fog: this.scene.fog,
      background: this.scene.background,
      environment: this.scene.environment,
      // applyDayState now writes environmentIntensity too, and it is a SCENE
      // field, not a city one — leaving a 0.3 midnight value behind would dim
      // every gate the player walks into next.
      environmentIntensity: this.scene.environmentIntensity,
    };

    // sun: true opts this dome into the sun/moon disc and the steerable rift
    // azimuth. Only the city asks for it: arenas and the six dungeon biomes are
    // frozen-light rifts with no sky to move, and leaving them on the default
    // keeps their compiled program and their pixels exactly as shipped.
    this.sky = makeSky(SKY_BIOME, { stars: 0.0, aurora: 0.12, sun: true });
    this.group.add(this.sky);
    this._ownedGeometries.push(this.sky.geometry);
    this._ownedMaterials.push(this.sky.material);

    this.scene.fog = new THREE.Fog(CITY_BIOME.fog, FOG_NEAR, FOG_FAR);
    this._envRT = buildBiomeEnvironment(this.renderer, CITY_BIOME);
    this.scene.environment = this._envRT.texture;

    // Exactly one hemisphere and one directional. No PointLight — see the
    // header. Adding even one here changes the program cache key for every
    // material in the scene.
    const hemi = new THREE.HemisphereLight(CITY_BIOME.sky, CITY_BIOME.ground, 1.05);
    hemi.position.set(0, 60, 0);
    this.group.add(hemi);
    this.hemi = hemi;

    const q = this.quality?.current || { shadows: true, shadowMapSize: 1024 };
    const key = new THREE.DirectionalLight(0xfff0d6, 2.45);
    key.position.set(58, 74, 40);
    key.castShadow = !!q.shadows;
    key.shadow.mapSize.set(q.shadowMapSize || 1024, q.shadowMapSize || 1024);
    key.shadow.bias = 0;
    key.shadow.normalBias = 0.05;
    key.shadow.camera.near = 1;
    this.group.add(key);
    this.group.add(key.target);
    this.key = key;
  }

  // ----------------------------------------------------------------- ground

  _buildGround() {
    const f = this.field;
    const n = f.n, stride = f.stride;
    const verts = stride * stride;

    // No convertSRGBToLinear anywhere in this file: ColorManagement is on, so
    // new THREE.Color(hex) is already in the linear working space and a second
    // conversion squares it — every surface came out at an eighth brightness
    // and read as a lighting bug rather than a colour bug. See citykit.js.
    //
    // THREE grass tones, not one. A single 0x6d8c4a across 340 m of ground was
    // the most-criticised frame in the game: at eye level nearly half the
    // screen was one flat pale plane. Two independent low-frequency fbm fields
    // drift between a warm and a cool grass on top of the base — big soft
    // patches, ~40-60 m across. The first cut of this used gentler tones and
    // ±7% jitter and was INVISIBLE in a screenshot once ACES tone mapping and
    // fog had flattened it; these values are tuned against rendered frames,
    // not against the hex swatches.
    const grass = new THREE.Color(0x6d8c4a);
    const grassWarm = new THREE.Color(0x8f9c3e);
    const grassCool = new THREE.Color(0x49764a);
    const dry = new THREE.Color(0xa08f60);
    const rock = new THREE.Color(0x8a8f9e);
    const road = new THREE.Color(0xbbb29a);
    const roadWorn = new THREE.Color(0x958a67);
    const kerb = new THREE.Color(0x6e6a55);
    const flag = new THREE.Color(0xc6c9be);
    const flagAlt = new THREE.Color(0x9ba18d);
    const ash = new THREE.Color(0x5c5763);
    const c = new THREE.Color();
    const c2 = new THREE.Color();
    const seed = f.seed;

    // Deterministic hash — mulberry-style integer mix over grid indices, so
    // the jitter is stable for a given seed and costs no state.
    const hash2 = (ix2, jz2) => {
      let h = (ix2 * 374761393 + jz2 * 668265263 + seed) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };

    // PASS 1 — zone colour and "worked stone" weight per grid vertex.
    // No jitter here: jitter is per FACE in pass 2, because a per-vertex
    // offset interpolates across a 3.4 m triangle into a soft gradient the
    // eye reads as mush, while a constant offset per face is what actually
    // reads as low-poly patchwork.
    const gpos = new Float32Array(verts * 3);
    const vcol = new Float32Array(verts * 3);
    const vstone = new Float32Array(verts);   // 1 = paving/flagstone, damps jitter

    for (let jz = 0; jz <= n; jz++) {
      const z = -f.half + jz * f.cell;
      for (let ix = 0; ix <= n; ix++) {
        const x = -f.half + ix * f.cell;
        const k = jz * stride + ix;
        gpos[k * 3] = x;
        gpos[k * 3 + 1] = f.h[k];
        gpos[k * 3 + 2] = z;

        // Base: grass with large-scale hue drift, drying out toward the
        // walls, rock on steep faces.
        const r = Math.max(Math.abs(x), Math.abs(z));
        c.copy(grass);
        c.lerp(grassWarm, smoothstep(0.38, 0.62, fbm(x * 0.016 + 31, z * 0.016 - 8, seed + 101, 2)));
        c.lerp(grassCool, smoothstep(0.45, 0.68, fbm(x * 0.041 - 12, z * 0.041 + 4, seed + 202, 2)) * 0.9);
        c.lerp(dry, smoothstep(WALL_HALF - 26, WALL_HALF + 40, r));
        c.lerp(rock, Math.min(1, f.slope(x, z) / 0.5) * 0.85);

        // Paving, with a kerb band just outside each street's width. The band
        // is ~2 m wide because the grid is 3.4 m: a true 0.5 m kerb would land
        // on almost no vertices and read as random dashes, while this catches
        // the row of vertices along every edge and reads as a darker seam
        // between paving and grass.
        let pave = 0;
        let kerbW = 0;
        for (const s of this.streets) {
          const d = distToSegment(x, z, s);
          if (d < s.w + 2.4) {
            pave = Math.max(pave, 1 - smoothstep(s.w - 0.6, s.w + 2.4, d));
            kerbW = Math.max(kerbW,
              smoothstep(s.w - 0.6, s.w + 0.1, d) * (1 - smoothstep(s.w + 1.7, s.w + 3.0, d)));
          }
        }
        if (pave > 0) {
          // Wear drift along the surface so paving is not one flat tone: a
          // browner, dustier patchwork at a shorter wavelength than the grass.
          c2.copy(road).lerp(roadWorn, smoothstep(0.35, 0.7, fbm(x * 0.055 + 7, z * 0.055 + 19, seed + 57, 2)));
          c.lerp(c2, pave);
        }
        if (kerbW > 0) c.lerp(kerb, kerbW * 0.8);

        // Plaza flagstones: concentric rings crossed with 10 sectors in two
        // tones, offset like brickwork by the ring index. Feature sizes are
        // dictated by the 3.4 m grid: the first cut used 3.9 m rings and 20
        // sectors, which is under the sampling rate — vertices caught tones
        // near-randomly and the face-mean turned the pattern into noise. At
        // 6.5 m rings and 36° sectors every plate spans ≥2 cells and survives.
        const dPlaza = Math.hypot(x, z);
        const inPlaza = dPlaza < PLAZA_R + 2;
        if (inPlaza) {
          const ringI = Math.floor(dPlaza / 6.5);
          const sectorI = Math.floor((Math.atan2(z, x) + Math.PI) / (Math.PI / 5));
          c2.copy((ringI + sectorI) % 2 ? flagAlt : flag);
          c.lerp(c2, 1 - smoothstep(PLAZA_R - 1, PLAZA_R + 2, dPlaza));
        }

        const dBreach = Math.hypot(x, z - BREACH_Z);
        if (dBreach < 20) c.lerp(ash, 1 - smoothstep(13, 20, dBreach));

        vcol[k * 3] = c.r; vcol[k * 3 + 1] = c.g; vcol[k * 3 + 2] = c.b;
        vstone[k] = Math.max(pave, inPlaza ? 1 : 0);
      }
    }

    // PASS 2 — NON-INDEXED triangles with one flat colour per face.
    //
    // This is deliberate and it is the whole fix. The indexed mesh with
    // smoothed normals and interpolated colours was "the worst thing in the
    // game": every variation averaged away and 45% of an eye-level frame read
    // as one untextured plane. Un-welding trades ~10k shared vertices for 60k
    // (≈2 MB of attributes, still far under one character mesh) and buys per-
    // face colour + per-face normals — real low-poly patchwork, the same
    // language as the flat-shaded kit pieces standing on it.
    //
    // Face colour = mean of its three corner zone colours (so street/plaza
    // edges keep their soft blend) × a face-constant luminance jitter: ±10%
    // on grass and ash, ±4.5% on paving and flagstones where heavy noise
    // reads as dirt rather than texture.
    //
    // Triangle split and winding — (a, cc, b) / (a, d, cc) on the a-c
    // diagonal — are EXACTLY what HeightField.height() interpolates across;
    // the vertex positions are untouched, so heightAt still agrees with the
    // rendered mesh to the millimetre and the city-test raycast check keeps
    // passing.
    const triCount = n * n * 2;
    const pos = new Float32Array(triCount * 9);
    const col = new Float32Array(triCount * 9);
    let o = 0;
    const corners = [0, 0, 0];
    for (let jz = 0; jz < n; jz++) {
      for (let ix = 0; ix < n; ix++) {
        const a = jz * stride + ix;
        const b = a + 1;
        const d = a + stride;
        const cc = d + 1;
        for (let t = 0; t < 2; t++) {
          if (t === 0) { corners[0] = a; corners[1] = cc; corners[2] = b; } else { corners[0] = a; corners[1] = d; corners[2] = cc; }
          let mr = 0, mg = 0, mb = 0, ms = 0;
          for (let v = 0; v < 3; v++) {
            const k = corners[v];
            mr += vcol[k * 3]; mg += vcol[k * 3 + 1]; mb += vcol[k * 3 + 2];
            ms += vstone[k];
          }
          const amp = ms > 1.5 ? 0.035 : 0.10;
          const jit = (1 + (hash2(ix * 2 + t, jz * 2 + 1013) - 0.5) * 2 * amp) / 3;
          mr *= jit; mg *= jit; mb *= jit;
          for (let v = 0; v < 3; v++) {
            const k = corners[v];
            pos[o] = gpos[k * 3]; col[o++] = mr;
            pos[o] = gpos[k * 3 + 1]; col[o++] = mg;
            pos[o] = gpos[k * 3 + 2]; col[o++] = mb;
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();     // non-indexed, so these ARE face normals
    geo.computeBoundingSphere();

    // flatShading matches the arena ground and every kit material. With the
    // mesh un-welded the normals above are already per-face, so this is
    // belt-and-braces consistency rather than the mechanism.
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.97, metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'city_ground';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.ground = mesh;
    this.group.add(mesh);
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
    this._triangles += triCount;
  }

  // ------------------------------------------------------------- city wall

  _buildCityWall() {
    const H = WALL_HALF;
    const parts = [];
    const push = (x0, x1, y0, y1, z0, z1, hex) => {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const cl = new THREE.Color(hex);
      const cnt = g.attributes.position.count;
      const arr = new Float32Array(cnt * 3);
      for (let i = 0; i < cnt; i++) { arr[i * 3] = cl.r; arr[i * 3 + 1] = cl.g; arr[i * 3 + 2] = cl.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(g);
    };

    const GATE = 7;             // half-width of each gate opening
    const T = 1.8;              // wall thickness
    const WH = 6.6;             // wall height
    const runs = [];            // {x, z, w, d} collision boxes

    // SEGMENTED runs, not monoliths. The first wall pushed one 81 m slab per
    // half-side, based at a single _wallBase sample — over sloping ground the
    // far end either floated (daylight underneath) or towered a full storey
    // over the terrain, which is exactly what the playtest called out. Short
    // segments each read their OWN ground; MAXSTEP caps how far one segment's
    // base may sit above a neighbour's, and it only ever clamps DOWNWARD, so a
    // capped segment buries deeper instead of ever lifting off the ground.
    // OVER makes adjacent slabs interpenetrate so a stepped joint shows a
    // stone face, never a gap.
    const SEG = 9;              // target segment length
    const SINK = 0.9;           // below the lowest sampled ground on the span
    const MAXSTEP = 1.3;        // max rise base-to-base between neighbours
    const OVER = 0.45;          // horizontal overlap at every joint

    // Lowest ground across a segment span, sampled on both faces — the mesh
    // is 3.4 m cells, so ~2 m sampling cannot miss a dip deeper than SINK.
    const spanLow = (axis, fixed, m0, m1) => {
      let lo = Infinity;
      const steps = Math.max(2, Math.ceil((m1 - m0) / 2));
      for (let i = 0; i <= steps; i++) {
        const a = m0 + ((m1 - m0) * i) / steps;
        for (const off of [-T, 0, T]) {
          const x = axis === 'x' ? a : fixed + off;
          const z = axis === 'x' ? fixed + off : a;
          lo = Math.min(lo, this.field.height(x, z));
        }
      }
      return lo;
    };

    // Three walls, each broken by one gate on its centre line.
    const straight = (axis, sign) => {
      for (const side of [-1, 1]) {
        const a0 = side < 0 ? -H : GATE;
        const a1 = side < 0 ? -GATE : H;
        const fixed = sign * H;
        const nSeg = Math.max(1, Math.round((a1 - a0) / SEG));
        const segLen = (a1 - a0) / nSeg;

        const bases = [];
        for (let s = 0; s < nSeg; s++) {
          bases.push(spanLow(axis, fixed, a0 + s * segLen, a0 + (s + 1) * segLen) - SINK);
        }
        for (let s = 1; s < nSeg; s++) bases[s] = Math.min(bases[s], bases[s - 1] + MAXSTEP);
        for (let s = nSeg - 2; s >= 0; s--) bases[s] = Math.min(bases[s], bases[s + 1] + MAXSTEP);

        for (let s = 0; s < nSeg; s++) {
          const m0 = a0 + s * segLen - OVER;
          const m1 = a0 + (s + 1) * segLen + OVER;
          const y = bases[s];
          // Alternating two-tone courses: with every segment at its own base
          // the joints are visible anyway, so lean in — slight tone steps are
          // what makes the run read as laid blocks rather than as seams.
          const tone = s % 2 ? 0xa39b8b : 0x9c9484;
          const cap = s % 2 ? 0x8b8577 : 0x857f6f;
          if (axis === 'x') {
            push(m0, m1, y, y + WH, fixed - T / 2, fixed + T / 2, tone);
            push(m0, m1, y + WH, y + WH + 0.7, fixed - T / 2 - 0.25, fixed + T / 2 + 0.25, cap);
          } else {
            push(fixed - T / 2, fixed + T / 2, y, y + WH, m0, m1, tone);
            push(fixed - T / 2 - 0.25, fixed + T / 2 + 0.25, y + WH, y + WH + 0.7, m0, m1, cap);
          }
        }
        // Collision stays one box per half-side: the visual segments never
        // deviate from the run's line, so the equivalent collider is the same
        // rectangle it always was — and ~8x fewer hash entries.
        if (axis === 'x') runs.push({ x: (a0 + a1) / 2, z: fixed, w: a1 - a0, d: T, rot: 0 });
        else runs.push({ x: fixed, z: (a0 + a1) / 2, w: T, d: a1 - a0, rot: 0 });
      }
      // Gate towers either side of the opening.
      for (const s2 of [-1, 1]) {
        const gx = axis === 'x' ? s2 * GATE : sign * H;
        const gz = axis === 'x' ? sign * H : s2 * GATE;
        const y = this._wallBase(gx, gz);
        push(gx - 2.2, gx + 2.2, y, y + WH + 3, gz - 2.2, gz + 2.2, 0xb0a795);
        runs.push({ x: gx, z: gz, w: 4.4, d: 4.4, rot: 0 });
      }
    };
    straight('x', -1);          // north
    straight('z', 1);           // east
    straight('x', 1);           // south

    // West side is a cliff, not a wall: a low parapet so a player who walks to
    // the overlook admires the view instead of falling off it.
    const py = this._wallBase(CLIFF_X + 1, 0);
    push(CLIFF_X + 0.4, CLIFF_X + 1.2, py, py + 1.15, -H, H, 0xa39b8b);
    runs.push({ x: CLIFF_X + 0.8, z: 0, w: 0.8, d: H * 2, rot: 0 });

    const geo = mergeAll(parts);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0.02,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'city_wall';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
    this.boxes.push(...runs);
    this._triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  }

  // The wall follows the ground; sample the lowest corner so it never floats.
  _wallBase(x, z) {
    let lo = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) lo = Math.min(lo, this.field.height(x + i * 3, z + j * 3));
    }
    return lo - 0.6;
  }

  // ---------------------------------------------------------------- layout

  /**
   * Place buildings on the 2 m kit grid.
   *
   * Every wing is 2 cells (4 m) across its gable axis. That is not a stylistic
   * choice: `town_roof` is a single pitch, so a clean ridge is exactly two
   * columns of it meeting in the middle. Three cells wide gives a sawtooth,
   * four gives two ridges and a valley with nothing to cap it.
   *
   * WORLD_SPEC step 8 layered four rules on top of that, all from
   * layoutrules.js so the harness asserts the same numbers this enforces:
   *
   *   DISTRICTS      every anchor resolves to a quarter, and the quarter's
   *                  profile decides style, storeys and roof family. The town
   *                  now has a shape (1-2 storey Row, 3-4 storey civic ring,
   *                  one 5-storey spire) instead of a uniform extrusion.
   *   CORRIDORS      a footprint that stands in a gate-to-plaza sightline is
   *                  capped at 2 storeys, whatever its profile says.
   *   ANTI-REPETITION no 3 identical (style, floors, ridge) tuples in a row
   *                  along one street, and no identical pair within 12 m. An
   *                  anchor that cannot satisfy this with ANY tuple its
   *                  profile allows is SKIPPED rather than forced — an empty
   *                  plot reads as a yard, a third identical shed reads as a
   *                  bug, and the owner named exactly that.
   *   FRONTAGE       every building gets one door, on the face that looks at
   *                  its own street, recorded in layoutMeta so a doorway that
   *                  opens into a neighbour's wall fails a test.
   */
  _layout(rnd) {
    const cellsHalf = Math.floor((WALL_HALF - 6) / KIT_CELL);
    const dim = cellsHalf * 2 + 1;
    const occ = new Uint8Array(dim * dim);
    const idxOf = (ci, cj) => (cj + cellsHalf) * dim + (ci + cellsHalf);
    const inRange = (ci, cj) => ci >= -cellsHalf && ci <= cellsHalf && cj >= -cellsHalf && cj <= cellsHalf;

    // Pre-block everything a building may not stand on.
    for (let cj = -cellsHalf; cj <= cellsHalf; cj++) {
      for (let ci = -cellsHalf; ci <= cellsHalf; ci++) {
        const x = ci * KIT_CELL, z = cj * KIT_CELL;
        let blocked = false;
        if (Math.hypot(x, z) < PLAZA_R + 5) blocked = true;
        if (!blocked) {
          for (const s of this.streets) {
            if (distToSegment(x, z, s) < s.w + 1.4) { blocked = true; break; }
          }
        }
        if (!blocked) {
          for (const d of this.districts) {
            if (d.id === 'plaza' || d.id === 'breach') continue;
            if (Math.hypot(x - d.pos.x, z - d.pos.z) < d.pad * 0.62) { blocked = true; break; }
          }
        }
        if (!blocked && this.field.slope(x, z) > 0.30) blocked = true;
        // The five enterable shells claimed their plots before this ran, and a
        // procedural building on top of one is a door that opens into brick.
        if (!blocked && this.interiors?.blocksCell(x, z)) blocked = true;
        if (blocked) occ[idxOf(ci, cj)] = 1;
      }
    }

    const free = (ci0, cj0, wc, dc) => {
      for (let j = cj0 - 1; j <= cj0 + dc; j++) {
        for (let i = ci0 - 1; i <= ci0 + wc; i++) {
          if (!inRange(i, j)) return false;
          if (occ[idxOf(i, j)]) return false;
        }
      }
      return true;
    };
    const mark = (ci0, cj0, wc, dc) => {
      for (let j = cj0 - 1; j <= cj0 + dc; j++) {
        for (let i = ci0 - 1; i <= ci0 + wc; i++) if (inRange(i, j)) occ[idxOf(i, j)] = 1;
      }
    };

    // Candidate anchors: the cells that face a street, shuffled. Building out
    // from the street rather than from a uniform scatter is what makes a town
    // read as streets-with-frontage instead of boxes-on-a-plane.
    const anchors = [];
    for (let cj = -cellsHalf; cj <= cellsHalf; cj++) {
      for (let ci = -cellsHalf; ci <= cellsHalf; ci++) {
        if (occ[idxOf(ci, cj)]) continue;
        const x = ci * KIT_CELL, z = cj * KIT_CELL;
        let near = Infinity;
        for (const s of this.streets) near = Math.min(near, distToSegment(x, z, s));
        if (near < LAYOUT_RULES.frontageMax) anchors.push({ ci, cj, near });
      }
    }
    for (let i = anchors.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
    }
    anchors.sort((a, b) => a.near - b.near);

    const out = [];
    // Accepted buildings grouped by the street they front, kept sorted by
    // position along it — this is what the maxIdenticalRun test walks, and
    // rebuilding it per candidate would be quadratic for no reason.
    const byStreet = new Map();
    // Why the town has the building count it has. Without this, "the layout
    // rules cost us N buildings" is a guess, and the two ways a plot goes
    // empty (no footprint fits / no legal tuple) want completely different
    // fixes.
    const tallies = { anchors: anchors.length, noFit: 0, noTuple: 0, budget: 0 };

    // Assemble one layout record. Everything downstream (the roof family, the
    // door, the validator) reads these fields, so they are computed once here.
    const record = (ci, cj, wc, dc, alongZ) => {
      const cx = (ci + (wc - 1) / 2) * KIT_CELL;
      const cz = (cj + (dc - 1) / 2) * KIT_CELL;
      const b = {
        id: `b${out.length}`,
        ci, cj, wc, dc, cx, cz,
        ax: ci * KIT_CELL, az: cj * KIT_CELL,     // the anchor cell, for frontage
        w: wc * KIT_CELL, d: dc * KIT_CELL,
        ridgeAlongZ: alongZ,
        district: districtOfPoint(cx, cz, this.districts),
        street: null, streetT: 0, streetPt: null,
        floors: 1, style: 'timber', roof: 'gable', cap: Infinity,
        isSpire: false, chimney: false, awning: false,
        door: null, topY: 0,
      };
      // The street this building fronts is the NEAREST one, singular. "Along
      // any street" needs a total order per street, and a building counted on
      // four overlapping ring segments has no place in any of them.
      let bestD = Infinity;
      this.streets.forEach((s, i) => {
        const dd = pointSegDistance(cx, cz, s);
        if (dd < bestD) { bestD = dd; b.street = i; b.streetT = segParam(cx, cz, s); }
      });
      b.cap = corridorCap(b);
      return b;
    };

    // Would accepting `b` with this tuple break an anti-repetition rule?
    const conflicts = (b) => {
      const tuple = silhouetteTuple(b);
      const minR = LAYOUT_RULES.minSpacing.identicalSilhouettePair;
      for (const o of out) {
        if (silhouetteTuple(o) !== tuple) continue;
        if (Math.hypot(o.cx - b.cx, o.cz - b.cz) < minR) return true;
      }
      const list = byStreet.get(b.street);
      if (list) {
        // Insert into the sorted street order and look at the neighbours only;
        // a run longer than the cap can only be created at the seam.
        let k = 0;
        while (k < list.length && compareAlongStreet(list[k], b) < 0) k++;
        let run = 1;
        for (let i = k - 1; i >= 0 && silhouetteTuple(list[i]) === tuple; i--) run++;
        for (let i = k; i < list.length && silhouetteTuple(list[i]) === tuple; i++) run++;
        if (run > LAYOUT_RULES.antiRepetition.maxIdenticalRun) return true;
      }
      return false;
    };

    const accept = (b) => {
      out.push(b);
      if (b.street != null) {
        if (!byStreet.has(b.street)) byStreet.set(b.street, []);
        const list = byStreet.get(b.street);
        let k = 0;
        while (k < list.length && compareAlongStreet(list[k], b) < 0) k++;
        list.splice(k, 0, b);
      }
      mark(b.ci, b.cj, b.wc, b.dc);
    };

    // --- the landmark, placed FIRST ---------------------------------------
    //
    // The one 5-storey building in town is not whatever the shuffle happens to
    // land on: it is a deliberate site beside the Assay Hall, far enough off
    // the north avenue that it is the corridor's BACKGROUND rather than the
    // thing blocking it (which is also what validateLayout asserts).
    const S = LAYOUT_RULES.spireSite;
    {
      let bestCell = null, bestScore = Infinity;
      for (let cj = -cellsHalf; cj <= cellsHalf; cj++) {
        for (let ci = -cellsHalf; ci <= cellsHalf; ci++) {
          if (!free(ci, cj, 2, 2)) continue;
          const cx = (ci + 0.5) * KIT_CELL, cz = (cj + 0.5) * KIT_CELL;
          if (Math.abs(cx) < S.minAbsX) continue;
          if (Math.hypot(cx - S.prefer.x, cz - S.prefer.z) > S.maxR) continue;
          const probe = { cx, cz, w: 2 * KIT_CELL, d: 2 * KIT_CELL };
          if (Number.isFinite(corridorCap(probe))) continue;
          const score = Math.hypot(cx - S.prefer.x, cz - S.prefer.z);
          if (score < bestScore) { bestScore = score; bestCell = { ci, cj }; }
        }
      }
      if (bestCell) {
        const b = record(bestCell.ci, bestCell.cj, 2, 2, true);
        b.isSpire = true;
        b.floors = LAYOUT_RULES.landmarkHeights.spire;
        b.style = 'stone';
        b.roof = 'spire';
        this._placeDoor(b);
        accept(b);
      }
    }

    for (const a of anchors) {
      if (out.length >= BUILDING_BUDGET) { tallies.budget++; continue; }
      // Try the biggest wing that fits, then step down. Taking the first
      // random size and giving up leaves half the block empty, which is what
      // makes a procedural town read as a scatter of sheds.
      const firstAlongZ = rnd() < 0.5;
      // Preferred sizes/styles are rolled ONCE per anchor, outside the
      // orientation retry, so a plot that has to flip its ridge still keeps
      // the same dice — otherwise the retry would consume rng draws and the
      // seed would stop meaning what it meant.
      const styleRoll = rnd();
      const floorRoll = rnd();
      const shuffleRoll = rnd();

      let chosen = null;
      let fitted = false;
      // Ridge orientation is a third of the silhouette tuple, so flipping it is
      // the cheapest legal way out of an anti-repetition dead end — and it is
      // free, because a wing that fits one way usually fits the other. Without
      // this retry the Outskirts profile (one style, one storey) could only
      // ever resolve a conflict by leaving the plot empty, and the town lost a
      // fifth of its buildings.
      for (const alongZ of [firstAlongZ, !firstAlongZ]) {
        let wc = 0, dc = 0;
        for (const len of [7, 6, 5, 4, 3, 2]) {
          const w = alongZ ? 2 : len;
          const d = alongZ ? len : 2;
          if (free(a.ci, a.cj, w, d)) { wc = w; dc = d; break; }
        }
        if (!wc) continue;
        fitted = true;

        const b = record(a.ci, a.cj, wc, dc, alongZ);
        const profile = DISTRICT_PROFILES[b.district] || DISTRICT_PROFILES.outskirts;
        // Ordinary buildings never reach the spire's storey count, whatever
        // the profile range says — the Assay quarter's range only goes that
        // high because the spire lives in it.
        const ceiling = Math.min(b.cap, LAYOUT_RULES.landmarkHeights.spire - 1);

        // The tuple the dice WANT, then every other legal tuple in a shuffled
        // order. Preference first keeps the district's character; the
        // fallbacks are what stop three identical sheds in a row.
        //
        // The floor range is clamped to the ceiling at BOTH ends. Clamping
        // only the top empties the option list for a 3-4 storey civic plot
        // that a sightline corridor caps at 2, and an empty option list means
        // no building at all — the corridors would have come out as bald
        // strips rather than as low ones.
        const loF = Math.max(1, Math.min(profile.floors[0], ceiling));
        const hiF = Math.max(loF, Math.min(profile.floors[1], ceiling));
        const wanted = {
          style: profile.styles[Math.floor(styleRoll * profile.styles.length)],
          floors: loF + Math.floor(floorRoll * (hiF - loF + 1)),
        };
        const options = [];
        for (const st of new Set(profile.styles)) {
          for (let fl = loF; fl <= hiF; fl++) options.push({ style: st, floors: fl });
        }
        // Deterministic rotation instead of a fresh shuffle: same reason as
        // the rolls above — the retry must not advance the stream.
        const rot = Math.floor(shuffleRoll * options.length);
        const ordered = options.slice(rot).concat(options.slice(0, rot));
        ordered.sort((p, q) => (
          (p.style === wanted.style && p.floors === wanted.floors ? 0 : 1)
          - (q.style === wanted.style && q.floors === wanted.floors ? 0 : 1)));

        for (const o of ordered) {
          b.style = o.style;
          b.floors = Math.max(1, Math.min(o.floors, ceiling));
          if (!conflicts(b)) { chosen = { b, profile }; break; }
        }
        if (chosen) break;
      }
      // No legal tuple in either orientation: leave the plot empty. See the
      // header note — a yard is a better answer than a duplicate.
      if (!chosen) { if (fitted) tallies.noTuple++; else tallies.noFit++; continue; }

      const { b, profile } = chosen;
      b.roof = profile.roof || 'gable';
      b.chimney = profile.chimneyChance ? rnd() < profile.chimneyChance : false;
      b.awning = Boolean(profile.awnings);
      this._placeDoor(b);
      accept(b);
    }
    this.layoutStats = { ...tallies, placed: out.length };
    return out;
  }

  /**
   * Put ONE door on the face that looks at this building's own street.
   *
   * The old rule was `rnd() < 0.07` per ground-floor wall cell, which produced
   * terraces with four doors and terraces with none, half of them opening into
   * the neighbour's gable. A single street-facing door is both cheaper (a door
   * piece is 376 triangles against a plain wall's 32) and the thing that makes
   * a street read as frontage — Lynch's PATHS, which is the whole point of
   * anchoring buildings to streets in the first place.
   */
  _placeDoor(b) {
    const s = b.street != null ? this.streets[b.street] : null;
    // Aim at the nearest point on the street, falling back to the town centre
    // so a building with no street still gets a door somewhere sensible.
    let tx = 0, tz = 0;
    if (s) {
      const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
      const t = b.streetT;
      tx = s.x1 + dx * t; tz = s.z1 + dz * t;
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
    // The cell on that face closest to the street.
    let ci, cj;
    if (face.axis === 'z') {
      ci = face.i;
      cj = Math.max(j0, Math.min(j1, Math.round(tz / KIT_CELL)));
    } else {
      cj = face.j;
      ci = Math.max(i0, Math.min(i1, Math.round(tx / KIT_CELL)));
    }
    const x = ci * KIT_CELL, z = cj * KIT_CELL;
    b.door = {
      ci, cj, x, z, yaw: face.yaw,
      // Where you stand to use it: one metre of wall plus a body's width.
      outX: x + face.nx * (KIT_CELL * 0.5 + 1.1),
      outZ: z + face.nz * (KIT_CELL * 0.5 + 1.1),
    };
  }

  /**
   * The Assay spire's cap: flat deck + town_wall_half parapet + a pointed top.
   *
   * pieceGeometryColored bakes the kit atlas into vertex colours, which is the
   * documented way to take kit pieces OUT of the instancing path, so this
   * merges onto cityMaterials().shell — the same material the procedural
   * fallback already uses, so no new material is minted and nothing new has to
   * be disposed beyond the one geometry.
   *
   * The point is ONE piece scaled to the tower's 2x2 footprint, not four
   * cell-sized ones: four little pyramids on one roof is a crown, and the town
   * needs a spire. Uniform scale, so flat-shaded normals are untouched.
   */
  _buildSpireCap(b, ry, i0, i1, j0, j1) {
    const geos = [];
    const put = (key, x, y, z, yaw, scale = 1) => {
      const g = pieceGeometryColored(key).clone();
      _spq.setFromAxisAngle(_spUp, yaw);
      _sps.set(scale, scale, scale);
      _spp.set(x, y, z);
      _spm.compose(_spp, _spq, _sps);
      g.applyMatrix4(_spm);
      if (!g.attributes.normal) g.computeVertexNormals();
      geos.push(g);
    };
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) put('town_roof_flat', i * KIT_CELL, ry, j * KIT_CELL, 0);
    }
    for (let j = j0; j <= j1; j++) {
      put('town_wall_half', i1 * KIT_CELL, ry, j * KIT_CELL, 0);
      put('town_wall_half', i0 * KIT_CELL, ry, j * KIT_CELL, Math.PI);
    }
    for (let i = i0; i <= i1; i++) {
      put('town_wall_half', i * KIT_CELL, ry, j0 * KIT_CELL, Math.PI / 2);
      put('town_wall_half', i * KIT_CELL, ry, j1 * KIT_CELL, -Math.PI / 2);
    }
    put('town_roof_high_point', (i0 + 0.5) * KIT_CELL, ry + 0.28, (j0 + 0.5) * KIT_CELL, 0, 2);

    const geo = mergeAll(geos);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, cityMaterials().shell);
    mesh.name = 'city_spire_cap';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    // The geometry is ours; the material belongs to citykit and is freed by
    // disposeCityKit, exactly as every KitField's is.
    this._ownedGeometries.push(geo);
    this._triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  }

  // -------------------------------------------------------------- buildings

  _buildBuildings(buildings, rnd) {
    const wallKeys = {
      timber: ['town_wall_wood', 'town_wall_wood_window_shutters', 'town_wall_wood_door'],
      stone: ['town_wall', 'town_wall_window_small', 'town_wall_door'],
      brick: ['town_wall', 'town_wall_window_small', 'town_wall_door'],
      // The civic style is stone with the kit's other window: the atlas gives
      // every town_* wall the same plaster, so a district's identity has to
      // come from which PIECES it uses, not from a tint we do not control.
      civic: ['town_wall', 'town_wall_window_stone', 'town_wall_door'],
    };

    // Roof families, keyed by DISTRICT_PROFILES.roof.
    //
    // ridge/left/right, NOT the spec's town_roof_gable_end: measured, not
    // assumed. town_roof_gable_end is a one-cell double-pitch whose ridge runs
    // through the cell CENTRE, so it cannot terminate this town's 2-cell gable
    // (ridge on the cell BOUNDARY) — dropped on the end of a run it reads as a
    // dormer stuck on sideways. town_roof_left / town_roof_right are the same
    // single pitch as town_roof plus the bargeboard and the closing gable
    // face, so swapping them in at the two ends of a ridge run closes the open
    // triangle exactly as the spec intended, for +20 triangles a piece.
    // Evidence: the assembly probes rendered for this step.
    const ROOFS = {
      gable: { mid: 'town_roof', left: 'town_roof_left', right: 'town_roof_right' },
      high: { mid: 'town_roof_high', left: 'town_roof_high_left', right: 'town_roof_high_right' },
    };

    // Two passes. The first decides every placement and tallies them per piece
    // type; the second allocates fields at the exact size and fills them. An
    // InstancedMesh cannot grow, and a field that quietly runs out of capacity
    // is a building with three walls — a bug that only shows up from one angle.
    const jobs = [];
    const tally = new Map();
    const emit = (key, x, y, z, yaw) => {
      jobs.push({ key, x, y, z, yaw });
      tally.set(key, (tally.get(key) || 0) + 1);
    };
    const lights = [];

    for (const b of buildings) {
      const base = this.field.height(b.cx, b.cz) - 0.12;
      const i0 = b.ci, i1 = b.ci + b.wc - 1;
      const j0 = b.cj, j1 = b.cj + b.dc - 1;
      const keys = wallKeys[b.style] || wallKeys.timber;
      const door = b.door;

      for (let fl = 0; fl < b.floors; fl++) {
        const y = base + fl * KIT_STOREY;
        // Windows are common; plain wall is the default because it is 32
        // triangles against a door's 376. The DOOR is no longer a dice roll —
        // _layout put exactly one on the street-facing face, and this is the
        // cell it named.
        const pick = (ci, cj, yaw) => {
          if (fl === 0 && door && door.ci === ci && door.cj === cj
            && Math.abs(Math.atan2(Math.sin(yaw - door.yaw), Math.cos(yaw - door.yaw))) < 0.01) return keys[2];
          if (rnd() < 0.28) return keys[1];
          return keys[0];
        };
        for (let j = j0; j <= j1; j++) {
          emit(pick(i1, j, 0), i1 * KIT_CELL, y, j * KIT_CELL, 0);
          emit(pick(i0, j, Math.PI), i0 * KIT_CELL, y, j * KIT_CELL, Math.PI);
        }
        for (let i = i0; i <= i1; i++) {
          emit(pick(i, j0, Math.PI / 2), i * KIT_CELL, y, j0 * KIT_CELL, Math.PI / 2);
          emit(pick(i, j1, -Math.PI / 2), i * KIT_CELL, y, j1 * KIT_CELL, -Math.PI / 2);
        }
      }

      // Roof. The low edge of each pitch faces outward and the two halves meet
      // on the ridge; see _layout for why the gable axis is 2 wide.
      //
      // The left/right rule is LOCAL, which is why it survives both ridge
      // orientations: a pitch piece takes `left` at its own local -Z end of the
      // run and `right` at its local +Z end. Local +Z maps to world (sin yaw,
      // cos yaw), so for the ridge-along-Z case that is left at world -Z for
      // the yaw-0 column and right at world -Z for the yaw-PI one.
      const ry = base + b.floors * KIT_STOREY;
      // Only the spire leaves the instanced roof families; anything else with
      // an unknown roof name falls back to the plain gable rather than
      // silently growing a second spire.
      const fam = b.isSpire ? null : (ROOFS[b.roof] || ROOFS.gable);
      if (fam) {
        if (b.ridgeAlongZ) {
          for (let j = j0; j <= j1; j++) {
            const lo = j === j0, hi = j === j1;
            emit(lo ? fam.left : hi ? fam.right : fam.mid, i0 * KIT_CELL, ry, j * KIT_CELL, 0);
            emit(lo ? fam.right : hi ? fam.left : fam.mid, i1 * KIT_CELL, ry, j * KIT_CELL, Math.PI);
          }
        } else {
          for (let i = i0; i <= i1; i++) {
            const lo = i === i0, hi = i === i1;
            emit(lo ? fam.right : hi ? fam.left : fam.mid, i * KIT_CELL, ry, j0 * KIT_CELL, -Math.PI / 2);
            emit(lo ? fam.left : hi ? fam.right : fam.mid, i * KIT_CELL, ry, j1 * KIT_CELL, Math.PI / 2);
          }
        }
      } else {
        // The spire: a flat deck, a parapet ring and a pointed cap, built as
        // ONE MERGED MESH rather than three instanced fields.
        //
        // A pitched roof needs a 2-cell gable axis and a square tower has no
        // long axis to run one along, so the deck is the only roof that works
        // here at all — but there is exactly one of these buildings in town,
        // and three InstancedMeshes holding 4, 8 and 1 instances is three
        // permanent draw calls with no pool behind them. Merged, the whole cap
        // is one draw on the shared vertex-colour material.
        this._buildSpireCap(b, ry, i0, i1, j0, j1);
      }

      // Chimneys and awnings — the two district props that hang off the
      // building rather than standing beside it. Both are +X-edge wall pieces,
      // so they take a wall's yaw, but neither goes where the naive placement
      // puts it and both were caught by looking at the render, not the code:
      //
      // CHIMNEY: it has to stand on an EAVE face, never a gable end. The eave
      // walls are the ones parallel to the ridge, so which pair they are flips
      // with ridgeAlongZ. Placed on the gable end instead, the 1.25 m stack
      // sits where the roof is at full ridge height and vanishes inside it —
      // 16 instanced chimneys and not one of them visible from anywhere.
      //
      // AWNING: town_overhang spans local x 0.28..0.85 and a wall's outer face
      // is at 1.0, so placed on the wall's own cell the awning hangs INSIDE
      // the building. Shifting the placement 0.72 m along the outward normal
      // puts its inner edge exactly on the wall face, projecting 0.57 m over
      // the door.
      if (b.chimney) {
        if (b.ridgeAlongZ) {
          const cj = j0 + Math.floor(rnd() * (j1 - j0 + 1));
          emit('town_chimney_top', i1 * KIT_CELL, ry + 0.30, cj * KIT_CELL, 0);
        } else {
          const ci = i0 + Math.floor(rnd() * (i1 - i0 + 1));
          emit('town_chimney_top', ci * KIT_CELL, ry + 0.30, j1 * KIT_CELL, -Math.PI / 2);
        }
      }
      if (b.awning && door) {
        const nx = Math.cos(door.yaw), nz = -Math.sin(door.yaw);
        emit('town_overhang', door.x + nx * 0.72, base, door.z + nz * 0.72, door.yaw);
      }
      b.topY = (b.roof === 'spire' ? ry + 0.28 + 4.0
        : b.roof === 'flat' ? ry + 1.0
          : b.roof === 'high' ? ry + 2.28 : ry + 1.25);

      // Lit windows on the long faces: the cheapest thing in the whole build
      // that says "people live here".
      const nLights = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < nLights; k++) {
        const fl = Math.floor(rnd() * b.floors);
        const y = base + fl * KIT_STOREY + 1.12;
        const side = rnd() < 0.5 ? -1 : 1;
        if (b.ridgeAlongZ) {
          lights.push({
            x: side < 0 ? i0 * KIT_CELL - 1.03 : i1 * KIT_CELL + 1.03,
            y,
            z: (j0 + rnd() * (j1 - j0 + 1) - 0.5) * KIT_CELL,
            yaw: side < 0 ? -Math.PI / 2 : Math.PI / 2,
          });
        } else {
          lights.push({
            x: (i0 + rnd() * (i1 - i0 + 1) - 0.5) * KIT_CELL,
            y,
            z: side < 0 ? j0 * KIT_CELL - 1.03 : j1 * KIT_CELL + 1.03,
            yaw: side < 0 ? Math.PI : 0,
          });
        }
      }

      // Collision: the real rectangle, not a circle around it. A circle round
      // a 4 x 14 m terrace would swallow the street either side.
      this.boxes.push({ x: b.cx, z: b.cz, w: b.w + 0.2, d: b.d + 0.2, rot: 0 });
    }

    const F = new Map();
    for (const [key, n] of tally) F.set(key, new KitField(key, n, { name: key }));
    for (const j of jobs) F.get(j.key).place(j.x, j.y, j.z, j.yaw);
    for (const f of F.values()) { if (f.count > 0) this.fields.push(f); else f.dispose(); }

    // The five enterables' hearth and lamp quads ride this field too. They are
    // the same thing — a warm rectangle that brightens after dusk — and sharing
    // the field means interiors.js adds no draw call, no material and no shader
    // program to light its rooms. See interiors.glowLights().
    for (const l of (this.interiors?.glowLights() || [])) lights.push(l);

    const glowGeo = new THREE.PlaneGeometry(0.85, 0.6);
    const glowMat = new THREE.MeshBasicMaterial({ color: WINDOW_LIT, toneMapped: false });
    this._ownedGeometries.push(glowGeo);
    this._ownedMaterials.push(glowMat);
    // One shared material for every lit window in town, so the day ramp is a
    // single colour write per frame no matter how many quads there are.
    this._windowMat = glowMat;
    const glow = new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, lights.length));
    glow.name = 'city_windows';
    // Deliberately NOT on GLOW_LAYER — see the CITY_BIOME note. 130 blurred
    // quads scattered across the frame is a haze, not a highlight.
    const M = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const P = new THREE.Vector3();
    const S = new THREE.Vector3(1, 1, 1);
    const UP = new THREE.Vector3(0, 1, 0);
    lights.forEach((l, i) => {
      Q.setFromAxisAngle(UP, l.yaw);
      P.set(l.x, l.y, l.z);
      M.compose(P, Q, S);
      glow.setMatrixAt(i, M);
    });
    glow.count = lights.length;
    glow.instanceMatrix.needsUpdate = true;
    glow.computeBoundingSphere();
    this.group.add(glow);
    this._triangles += lights.length * 2;
  }

  // ------------------------------------------------------------------ props

  _buildProps(rnd, buildings) {
    const density = this._buildDensity;
    const add = (key, capacity) => {
      const f = new KitField(key, Math.max(1, Math.ceil(capacity)), { name: key });
      this.fields.push(f);
      return f;
    };

    // --- lanterns along every street, both kerbs ---------------------------
    const lantern = add('town_lantern', 230 * density + 20);
    for (const s of this.streets) {
      const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
      const step = 21 / density;
      const nx = (s.x2 - s.x1) / (len || 1), nz = (s.z2 - s.z1) / (len || 1);
      for (let t = step * 0.5; t < len; t += step) {
        for (const side of [-1, 1]) {
          const x = s.x1 + nx * t - nz * side * (s.w + 1.1);
          const z = s.z1 + nz * t + nx * side * (s.w + 1.1);
          if (Math.hypot(x, z) < PLAZA_R - 2) continue;
          if (this._blockedForProp(x, z, 0.6)) continue;
          if (lantern.place(x, this.field.height(x, z), z, rnd() * 6.283)) {
            this.obstacles.push({ pos: { x, z }, radius: 0.35 });
          }
        }
      }
    }
    // Lamp flames, so the streets read at night without a single PointLight.
    this._buildLampGlow(lantern);

    // --- plaza ring: pillars ------------------------------------------------
    // The pillars used to alternate the kit's red/green banners — decorative
    // noise in exactly the colour language the portals use for RANK. The ring
    // now carries rank-coloured cloth instead (_buildFlags), so the plaza
    // reads as gate signage rather than as bunting.
    const pillar = add('town_pillar_stone', 40);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = Math.cos(a) * (PLAZA_R + 2.4), z = -Math.sin(a) * (PLAZA_R + 2.4);
      const y = this.field.height(x, z);
      pillar.place(x, y, z, -a);
      this.obstacles.push({ pos: { x, z }, radius: 0.5 });
    }

    // --- fountain: one in the plaza, one on Quarter Row --------------------
    const fountain = add('town_fountain_round', 2);
    for (const p of [{ x: 0, z: 17.5 }, { x: -58, z: -12 }]) {
      fountain.place(p.x, this.field.height(p.x, p.z), p.z, 0);
      this.obstacles.push({ pos: { x: p.x, z: p.z }, radius: 2.4 });
      this.propMeta.fountains.push({ x: p.x, z: p.z });
    }

    // --- market street: stalls and carts by the Exchange -------------------
    const stallR = add('town_stall_red', 14);
    const stallG = add('town_stall_green', 14);
    const cart = add('town_cart', 16);
    for (let i = 0; i < 12; i++) {
      const side = i % 2 ? 1 : -1;
      const x = -4 + side * 8.5 + (rnd() - 0.5) * 1.2;
      const z = 31 + (i >> 1) * 5.4;
      const y = this.field.height(x, z);
      (i % 3 ? stallR : stallG).place(x, y, z, side < 0 ? Math.PI / 2 : -Math.PI / 2);
      this.obstacles.push({ pos: { x, z }, radius: 1.3 });
      // Recorded so minSpacing.stalls_outside_market is an assertion rather
      // than a comment: stalls belong to the Exchange strip and nowhere else.
      this.propMeta.stalls.push({ x, z });
      if (rnd() < 0.4) {
        const cxp = x + side * 3.2, czp = z + 1.6;
        cart.place(cxp, this.field.height(cxp, czp), czp, rnd() * 6.283);
        this.obstacles.push({ pos: { x: cxp, z: czp }, radius: 1.2 });
      }
    }

    // --- Quarter Row: benches, hedges, fences, washing poles ---------------
    const bench = add('town_stall_bench', 26);
    const hedge = add('town_hedge', 420 * density + 20);
    const fence = add('town_fence', 560 * density + 20);
    // minSpacing.benches is enforced HERE, not just asserted: the old spacing
    // was 2.8 m of x-step against a 6 m rule, and two benches back to back on
    // the same side of the walk is the "duplicated for no reason" reading at
    // street furniture scale.
    const benchMin = LAYOUT_RULES.minSpacing.benches;
    const benchOk = (x, z) => {
      for (const p of this.propMeta.benches) if (Math.hypot(p.x - x, p.z - z) < benchMin) return false;
      return true;
    };
    for (let i = 0; i < 18; i++) {
      const x = -30 - i * 2.8 + (rnd() - 0.5) * 3;
      const z = (rnd() < 0.5 ? -1 : 1) * (7 + rnd() * 3);
      if (this._blockedForProp(x, z, 1)) continue;
      if (!benchOk(x, z)) continue;
      bench.place(x, this.field.height(x, z), z, z < 0 ? 0 : Math.PI);
      this.obstacles.push({ pos: { x, z }, radius: 0.7 });
      this.propMeta.benches.push({ x, z });
    }
    // The overlook bench, facing the drop.
    if (benchOk(CLIFF_X + 4.5, 0)) {
      bench.place(CLIFF_X + 4.5, this.field.height(CLIFF_X + 4.5, 0), 0, Math.PI / 2);
      this.propMeta.benches.push({ x: CLIFF_X + 4.5, z: 0 });
    }

    // Garden walls around a share of the buildings.
    for (const b of buildings) {
      if (rnd() > 0.82 * density) continue;
      const f = rnd() < 0.45 ? hedge : fence;
      const i0 = b.ci - 2, i1 = b.ci + b.wc + 1;
      const j0 = b.cj - 2, j1 = b.cj + b.dc + 1;
      for (let i = i0; i <= i1; i++) {
        for (const [j, yaw] of [[j0, Math.PI / 2], [j1, -Math.PI / 2]]) {
          const x = i * KIT_CELL, z = j * KIT_CELL;
          if (this._blockedForProp(x, z, 1.1)) continue;
          if (rnd() < 0.22) continue;                 // gaps make gates
          f.place(x, this.field.height(x, z), z, yaw);
        }
      }
      for (let j = j0 + 1; j <= j1 - 1; j++) {
        for (const [i, yaw] of [[i0, Math.PI], [i1, 0]]) {
          const x = i * KIT_CELL, z = j * KIT_CELL;
          if (this._blockedForProp(x, z, 1.1)) continue;
          if (rnd() < 0.22) continue;
          f.place(x, this.field.height(x, z), z, yaw);
        }
      }
    }

    // --- trees: gardens, plaza edge, and the outskirts ---------------------
    const tree = add('town_tree', 90 * density + 10);
    const treeH = add('town_tree_high', 70 * density + 10);
    let placed = 0;
    for (let tries = 0; tries < 2400 && placed < 120 * density; tries++) {
      const x = (rnd() * 2 - 1) * (WALL_HALF + 42);
      const z = (rnd() * 2 - 1) * (WALK_LIMIT - 6);
      if (Math.abs(z) < WALL_HALF && Math.abs(x) < WALL_HALF) {
        // Inside the walls trees only go in gardens, never on paving.
        if (this._blockedForProp(x, z, 2.4)) continue;
        if (Math.hypot(x, z) < PLAZA_R + 4) continue;
      } else {
        if (x < CLIFF_X) continue;
        if (Math.hypot(x, z - BREACH_Z) < 30) continue;
        if (this.field.slope(x, z) > 0.42) continue;
      }
      const y = this.field.height(x, z);
      const f = rnd() < 0.45 ? treeH : tree;
      if (!f.place(x, y, z, rnd() * 6.283, 0.85 + rnd() * 0.5)) continue;
      this.obstacles.push({ pos: { x, z }, radius: 0.75 });
      placed++;
    }

    // --- rock scatter outside the wall -------------------------------------
    const rockL = add('town_rock_large', 40);
    const rockS = add('town_rock_small', 60);
    for (let i = 0; i < Math.round(70 * density); i++) {
      const a = rnd() * Math.PI * 2;
      const r = WALL_HALF + 10 + rnd() * 40;
      const x = Math.cos(a) * r, z = -Math.sin(a) * r;
      if (x < CLIFF_X || Math.max(Math.abs(x), Math.abs(z)) > WALK_LIMIT - 8) continue;
      if (Math.hypot(x, z - BREACH_Z) < 22) continue;
      const y = this.field.height(x, z);
      const big = rnd() < 0.4;
      (big ? rockL : rockS).place(x, y, z, rnd() * 6.283, 0.7 + rnd() * 0.7);
      this.obstacles.push({ pos: { x, z }, radius: big ? 1.7 : 1.1 });
    }
  }

  // A bright bulb in each lantern head. Kept off GLOW_LAYER on purpose: a
  // hundred blurred halos is the same screen-wide wash the window quads were.
  _buildLampGlow(lanternField) {
    const n = lanternField.count;
    if (!n) return;
    const geo = new THREE.SphereGeometry(0.26, 6, 4);
    const mat = new THREE.MeshBasicMaterial({ color: LAMP_LIT, toneMapped: false });
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
    this._lampMat = mat;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = 'city_lamp_glow';
    const src = lanternField.meshes[0];
    const M = new THREE.Matrix4();
    const T = new THREE.Matrix4().makeTranslation(0, 2.98, 0);
    for (let i = 0; i < n; i++) {
      src.getMatrixAt(i, M);
      M.multiply(T);
      mesh.setMatrixAt(i, M);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this._triangles += n * 24;
  }

  _blockedForProp(x, z, clearance) {
    for (const s of this.streets) if (distToSegment(x, z, s) < s.w + clearance) return true;
    for (const b of this.boxes) {
      if (Math.abs(x - b.x) < b.w / 2 + clearance && Math.abs(z - b.z) < b.d / 2 + clearance) return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- nature

  /**
   * Ground scatter from nature.glb — grass tufts, flowers, low plants, bushes
   * and mossy rocks — so the space between streets reads as ground cover
   * instead of bare vertex paint. The 1.4 MB pack has shipped in the APK since
   * the first asset pass and was imported by nothing; this is what draws it.
   *
   * Two honesty rules, both load-bearing:
   *   * Everything under stepHeight (0.4 m, physics.js) is walk-through
   *     decoration with no collider — brushing through grass is expected,
   *     clipping through a bush is a bug. Tuft scales are chosen so they top
   *     out at ~0.4 m.
   *   * Everything taller (bushes, rocks) goes into this.obstacles exactly
   *     like the round props above, BEFORE _buildHash and attachNavGrid run,
   *     so collision and the navgrid stay honest.
   *
   * Runs after _buildPortals on purpose: the portal-surround exclusion in
   * _natureSpotOk reads this.portals.
   */
  _buildNature(rnd) {
    const density = this._buildDensity;

    // n is the count at density 1 (~430 instances, ~90k triangles — the grass
    // meshes are 192 tris each, which is why the counts are bounded and the
    // quality governor's instanceScale multiplies them). sx/sy are scale
    // ranges — see NatureField.place for why grass squashes vertically
    // instead of shrinking. solid is the obstacle radius at scale 1, or 0 for
    // walk-through decoration. clump seeds 2-4 neighbours around a successful
    // placement, which is what makes grass read as growth instead of confetti.
    // Tuft footprints are pushed WIDE (sx up to 1.7) while sy keeps them
    // under stepHeight: a 0.3 m tuft is four pixels at fifteen metres and the
    // first screenshots of this pass looked bare despite 490 placed instances.
    // Width is what makes ground cover read; height is what breaks the
    // walk-through rule. The two scales are independent on purpose.
    const SCATTER = [
      { key: 'grass_short', n: 200, sx: [1.1, 1.7], sy: [0.85, 1.0], solid: 0, clump: true },
      { key: 'grass',       n: 130, sx: [1.0, 1.35], sy: [0.34, 0.42], solid: 0, clump: true },
      { key: 'grass_2',     n: 80,  sx: [1.0, 1.35], sy: [0.28, 0.34], solid: 0, clump: true },
      { key: 'flowers',     n: 40,  sx: [1.0, 1.4], sy: [0.42, 0.48], solid: 0, clump: true },
      { key: 'plant_1',     n: 40,  sx: [0.9, 1.3], sy: [0.6, 0.78],  solid: 0, clump: false },
      { key: 'bush_1',      n: 16,  sx: [0.75, 1.05], sy: null, solid: 0.85, clump: false },
      { key: 'bush_2',      n: 12,  sx: [0.75, 1.05], sy: null, solid: 0.7,  clump: false },
      { key: 'rock_moss_2', n: 18,  sx: [0.7, 1.15], sy: null, solid: 0.4,  clump: false },
      { key: 'rock_moss_5', n: 16,  sx: [0.7, 1.15], sy: null, solid: 0.5,  clump: false },
    ];

    for (const spec of SCATTER) {
      const target = Math.max(1, Math.round(spec.n * density));
      // Grass casts no shadow: ~400 tuft silhouettes through the shadow pass
      // cost real fill on a phone and their shadows are subpixel anyway.
      // Bushes and rocks do cast — a shadow is most of what visually grounds
      // a solid object the player can collide with.
      const field = new NatureField(spec.key, target + 4, { castShadow: spec.solid > 0 });
      this.fields.push(field);
      // Sheddable at runtime: sampling below is random over the whole town, so
      // the tail of the placement order is a spatially uniform subset. `solids`
      // is index-aligned with the field's instances so setInstanceDensity can
      // switch a thinned bush's collider off with it — a shed instance that
      // still blocks the player is an invisible wall, which is worse than the
      // triangles it saved.
      const group = { field, solids: [] };
      this._scatter.push(group);
      let placed = 0;
      for (let tries = 0; tries < target * 14 && placed < target; tries++) {
        // Sampling is biased toward where the player LOOKS, not uniform.
        // Uniform over the 268 m square put most of the scatter in the outer
        // belt; the first screenshots of this pass showed grass on the
        // horizon and bare paint at the player's feet. 40% of tries now hug a
        // street verge (0.5-3 m past the kerb — every eye-level frame is
        // mostly street corridor), 40% the walled interior, 20% the outskirts.
        let x, z;
        const pick = rnd();
        if (pick < 0.4 && !spec.solid) {
          const s = this.streets[Math.floor(rnd() * this.streets.length)];
          const t = rnd();
          const nx = s.x2 - s.x1, nz = s.z2 - s.z1;
          const len = Math.hypot(nx, nz) || 1;
          const side = rnd() < 0.5 ? -1 : 1;
          const off = s.w + 0.5 + rnd() * 2.5;
          x = s.x1 + nx * t - (nz / len) * side * off;
          z = s.z1 + nz * t + (nx / len) * side * off;
        } else {
          const range = pick < 0.8 ? WALL_HALF - 3 : WALL_HALF + 40;
          x = (rnd() * 2 - 1) * range;
          z = (rnd() * 2 - 1) * range;
        }
        if (!this._natureSpotOk(x, z, spec.solid > 0 ? 1.2 : 0.35)) continue;
        placed += this._placeNature(group, spec, x, z, rnd);
        if (spec.clump) {
          const extra = 3 + Math.floor(rnd() * 4);
          for (let e = 0; e < extra && placed < target; e++) {
            const a = rnd() * 6.283;
            const rr = 0.6 + rnd() * 1.6;
            const nx = x + Math.cos(a) * rr, nz = z + Math.sin(a) * rr;
            if (!this._natureSpotOk(nx, nz, 0.35)) continue;
            placed += this._placeNature(group, spec, nx, nz, rnd);
          }
        }
      }
    }
  }

  _placeNature(group, spec, x, z, rnd) {
    const field = group.field;
    const s = spec.sx[0] + rnd() * (spec.sx[1] - spec.sx[0]);
    const sy = spec.sy ? spec.sy[0] + rnd() * (spec.sy[1] - spec.sy[0]) : s;
    // Sunk 3 cm so a base edge never floats above a flat-shaded facet.
    if (!field.place(x, this.field.height(x, z) - 0.03, z, rnd() * 6.283, s, sy)) return 0;
    if (spec.solid > 0) {
      // `i` is this obstacle's INSTANCE INDEX in the field, which is what makes
      // "thin the tail" and "switch off the colliders of the thinned tail" the
      // same decision. resolve() skips an obstacle with off === true.
      const o = { pos: { x, z }, radius: spec.solid * s, i: field.count - 1, off: false };
      this.obstacles.push(o);
      group.solids.push(o);
    }
    return 1;
  }

  /**
   * Where ground scatter may stand: on grass or the dry belt, off every
   * surface that is already something — streets and kerbs, the plaza and its
   * pillar ring, district pads, portal surrounds, the Breach ash, building
   * plots, existing props — and never on rock-steep faces or past the lip.
   */
  _natureSpotOk(x, z, clearance) {
    if (x < CLIFF_X + 3) return false;
    if (Math.max(Math.abs(x), Math.abs(z)) > WALK_LIMIT - 6) return false;
    if (Math.hypot(x, z) < PLAZA_R + 3) return false;
    if (Math.hypot(x, z - BREACH_Z) < 23) return false;
    for (const d of this.districts) {
      if (d.id === 'plaza' || d.id === 'breach') continue;
      if (Math.hypot(x - d.pos.x, z - d.pos.z) < d.pad) return false;
    }
    for (const p of this.portals) {
      if (Math.hypot(x - p.pos.x, z - p.pos.z) < p.radius + 2.5) return false;
    }
    if (this.field.slope(x, z) > 0.45) return false;
    if (this._blockedForProp(x, z, clearance)) return false;
    // Not inside an existing prop's collider: a tuft poking out of a fountain
    // bowl or a tree trunk reads as a bug, not as undergrowth. Linear scan is
    // fine at build time — _buildHash has not run yet, and this is a few
    // million scalar ops once per city entry, not per frame.
    for (const o of this.obstacles) {
      const dx = x - o.pos.x, dz = z - o.pos.z;
      if (dx * dx + dz * dz < o.radius * o.radius) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- portals

  _buildPortals(rnd, save) {
    const level = Number(save?.level) || 1;

    // Geometry shared across all six portals AND the Verge's wild gates: six
    // Groups of four meshes, twenty-four draw calls, four geometries. Built and
    // owned here because City is the portal system's owner; frontier.js reads
    // this handle rather than minting a second set, so a wild gate is the same
    // buffers on the GPU as a plaza gate and the disposal story stays single.
    const geos = portalGeometries();
    this._portalGeos = geos;
    this._ownedGeometries.push(...geos.geometries);
    this._ownedMaterials.push(...geos.materials);

    const ranks = ['E', 'D', 'C', 'B', 'A', 'S'];
    for (const rank of ranks) {
      const gate = GATES.find((g) => g.rank === rank);
      const outside = rank === 'S';
      const a = (PORTAL_ANGLES[rank] ?? 0) * Math.PI / 180;
      const px = outside ? 0 : Math.cos(a) * PORTAL_RING;
      const pz = outside ? BREACH_Z : -Math.sin(a) * PORTAL_RING;
      const py = this.field.height(px, pz);
      const scale = outside ? 1.85 : 1;
      const color = PORTAL_COLORS[rank];
      const locked = level < (gate?.reqLevel ?? 1);

      const built = buildPortalVisual(this.group, {
        rank,
        color,
        scale,
        locked,
        // Face the plaza centre (the Breach faces back down its road).
        yaw: outside ? 0 : Math.atan2(-px, -pz),
        geos,
      });
      built.group.position.set(px, py, pz);
      this._ownedMaterials.push(...built.materials);
      this._triangles += PORTAL_TRIANGLES;

      const portal = {
        rank,
        gate: gate || null,
        pos: new THREE.Vector3(px, py, pz),
        radius: (outside ? 6.5 : 5.2),
        color,
        locked,
        anomaly: false,
        wild: false,
        group: built.group,
        phase: rnd() * 6.283,
        meshes: built.meshes,
        _flick: 0,
      };
      this.portals.push(portal);
      this._applyPortalState(portal);

      // The dais is solid; you walk up to a portal, not through its plinth.
      this.obstacles.push({ pos: { x: px, z: pz }, radius: 2.6 * scale });
    }

    this._buildBreachPlatform(rnd);
  }

  /** A cracked ruin platform under the S portal, outside the city's protection. */
  _buildBreachPlatform(rnd) {
    const cx = 0, cz = BREACH_Z;
    // ruin_floor_squarelarge is 118 triangles; ruin_floor_standard is 1,304 for
    // the same 2 m tile, and 69 of them was a quarter of the city's entire
    // triangle budget spent on a platform nobody stands closer than 3 m to.
    const floor = new KitField('ruin_floor_squarelarge', 130, { name: 'breach_floor' });
    const col = new KitField('ruin_column_round', 18, { name: 'breach_column' });
    const arch = new KitField('ruin_arch_gothic', 8, { name: 'breach_arch' });
    const rubble = new KitField('ruin_wall_broken', 26, { name: 'breach_rubble' });
    const stag = new KitField('ruin_statue_stag', 2, { name: 'breach_statue' });

    for (let i = -5; i <= 5; i++) {
      for (let j = -5; j <= 5; j++) {
        const x = cx + i * KIT_CELL, z = cz + j * KIT_CELL;
        const d = Math.hypot(i, j);
        if (d > 5.4) continue;
        if (d > 3.6 && rnd() < 0.42) continue;         // crumbled edge
        floor.place(x, this.field.height(x, z) + 0.1, z, 0);
      }
    }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const x = cx + Math.cos(a) * 12.5, z = cz - Math.sin(a) * 12.5;
      const y = this.field.height(x, z);
      if (rnd() < 0.35) { col.place(x, y, z, rnd() * 6.283, 0.8 + rnd() * 0.5); continue; }
      rubble.place(x, y, z, -a);
      this.obstacles.push({ pos: { x, z }, radius: 0.9 });
    }
    for (const s of [-1, 1]) {
      const x = cx + s * 7.5, z = cz + 9;
      arch.place(x, this.field.height(x, z), z, 0);
      const sx = cx + s * 9.5, sz = cz - 6;
      stag.place(sx, this.field.height(sx, sz), sz, -s * Math.PI / 2);
      this.obstacles.push({ pos: { x: sx, z: sz }, radius: 1.0 });
    }
    for (const f of [floor, col, arch, rubble, stag]) {
      if (f.count > 0) this.fields.push(f); else f.dispose();
    }
  }

  // ------------------------------------------------------------- rank flags

  /**
   * Rank signage in cloth, derived from this.portals — never from a hardcoded
   * rank list, so a city built with only E and D gates shows exactly two
   * colours. Three layers, cheapest first:
   *
   *   * every plaza pillar carries a hanging cloth coloured by the NEAREST
   *     plaza portal, so the ring reads as coloured sectors from anywhere on
   *     the flagstones — an arriving player takes one look and knows which
   *     gates this city holds;
   *   * two flying flags flank each plaza portal's dais;
   *   * portals outside the wall (the S Breach today) get a flag pair where
   *     their road leaves the wall gate and another where it arrives, because
   *     "there is a red gate out there" is worth saying at the gate mouth.
   *
   * All the cloth is ONE non-indexed mesh (two triangles per flag) whose
   * vertices _updateFlags rewrites in place each frame — one draw call, zero
   * per-frame allocation. Poles and pillar posts are one merged static mesh.
   * Nothing here is emissive: rank colour is dye, not light; glow stays
   * reserved for the portals themselves.
   */
  _buildFlags(rnd) {
    const plaza = this.portals.filter((p) => Math.hypot(p.pos.x, p.pos.z) < PLAZA_R + 4);
    const away = this.portals.filter((p) => !plaza.includes(p));
    const flags = [];       // { fly, x, z, topY, w, h, yaw, phase, color }
    const poles = [];

    // Wind is one direction for the whole city; flags flying every which way
    // read as bugs, not weather. Slightly north of east, so plaza flags face
    // the arriving player's camera.
    const WIND = Math.atan2(-0.42, 0.91);

    const pole = (x, z, h, r0 = 0.075, r1 = 0.05) => {
      const y = this.field.height(x, z);
      const g = new THREE.CylinderGeometry(r1, r0, h, 5, 1);
      g.translate(x, y + h / 2, z);
      paintGeo(g, 0x6b5138);
      poles.push(g);
      this.obstacles.push({ pos: { x, z }, radius: 0.28 });
      return y + h;
    };

    // --- pillar-ring sectors ----------------------------------------------
    if (plaza.length) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const x = Math.cos(a) * (PLAZA_R + 2.4), z = -Math.sin(a) * (PLAZA_R + 2.4);
        let best = plaza[0], bestD = Infinity;
        for (const p of plaza) {
          const pa = Math.atan2(-p.pos.z, p.pos.x);
          let d = Math.abs(pa - a);
          if (d > Math.PI) d = Math.PI * 2 - d;
          if (d < bestD) { bestD = d; best = p; }
        }
        // A short standard on the pillar top; the cloth hangs from it. The
        // kit pillar is 2 m tall, so the cloth band sits at 2.0-3.4 m — eye
        // level from across the plaza.
        const y = this.field.height(x, z);
        const g = new THREE.CylinderGeometry(0.042, 0.055, 1.55, 5, 1);
        g.translate(x, y + 1.95 + 0.775, z);
        paintGeo(g, 0x6b5138);
        poles.push(g);
        flags.push({
          fly: false, x, z, topY: y + 3.42, w: 0.62, h: 1.7,
          yaw: Math.atan2(-z, -x),        // face the plaza centre
          phase: rnd() * 6.283, color: best.color,
        });
      }
    }

    // --- flying pairs flanking each plaza dais ----------------------------
    for (const p of plaza) {
      const len = Math.hypot(p.pos.x, p.pos.z) || 1;
      const tx = -p.pos.z / len, tz = p.pos.x / len;
      for (const s of [-1, 1]) {
        const x = p.pos.x + tx * s * 6.8;
        const z = p.pos.z + tz * s * 6.8;
        const top = pole(x, z, 4.6);
        flags.push({
          fly: true, x, z, topY: top - 0.12, w: 1.45, h: 0.85,
          yaw: WIND, phase: rnd() * 6.283, color: p.color,
        });
      }
    }

    // --- road pairs for portals outside the wall --------------------------
    for (const p of away) {
      // The only out-of-wall road today runs due north; if another is ever
      // added, generalise the gate mouth below — the colours already follow
      // the portal, which is the part that must not be hardcoded.
      const spots = [
        { x: -6.8, z: p.pos.z + 15 }, { x: 6.8, z: p.pos.z + 15 },   // arrival
        { x: -(7 + 1.7), z: -WALL_HALF + 8 }, { x: 7 + 1.7, z: -WALL_HALF + 8 }, // gate mouth
      ];
      for (const sp of spots) {
        if (this._blockedForProp(sp.x, sp.z, 0.5)) continue;
        const top = pole(sp.x, sp.z, 4.6);
        flags.push({
          fly: true, x: sp.x, z: sp.z, topY: top - 0.12, w: 1.45, h: 0.85,
          yaw: WIND, phase: rnd() * 6.283, color: p.color,
        });
      }
    }

    if (!flags.length) return;

    // Poles: one merged static draw.
    const poleGeo = mergeAll(poles);
    const poleMat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0.0,
    });
    const poleMesh = new THREE.Mesh(poleGeo, poleMat);
    poleMesh.name = 'city_flag_poles';
    poleMesh.castShadow = false;    // a 5 cm pole's shadow is subpixel noise
    poleMesh.receiveShadow = false;
    this.group.add(poleMesh);
    this._ownedGeometries.push(poleGeo);
    this._ownedMaterials.push(poleMat);
    this._triangles += (poleGeo.index ? poleGeo.index.count : poleGeo.attributes.position.count) / 3;

    // Cloth: 6 verts per flag, rewritten each frame in _updateFlags.
    const n = flags.length;
    const pos = new Float32Array(n * 18);
    const nor = new Float32Array(n * 18);
    const col = new Float32Array(n * 18);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // A shade more saturated than the portal glow itself: cloth is lit and
      // fogged where the portal is emissive, so dye at the portal's exact hex
      // came out grey-ish in the rendered frame.
      c.setHex(flags[i].color).offsetHSL(0, 0.12, 0);
      // Bottom of the cloth drops to 68% — the two-tone is what stops a flat
      // quad from reading as a coloured sticker.
      for (let v = 0; v < 6; v++) {
        const dimmed = v === 2 || v === 4 || v === 5;   // verts written as bottom
        const k = dimmed ? 0.68 : 1.0;
        col[i * 18 + v * 3] = c.r * k;
        col[i * 18 + v * 3 + 1] = c.g * k;
        col[i * 18 + v * 3 + 2] = c.b * k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'city_flags';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Hand-set bounds instead of per-frame recompute: the cloth never moves
    // more than ~1.6 m from its pole, so pad the static extent and be done.
    this._flags = flags;
    this._flagMesh = mesh;
    this._updateFlags(0);
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 3;
    this.group.add(mesh);
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
    this._triangles += n * 2;
  }

  /** Rewrite every cloth vertex for time t. Scalar math only — no allocation. */
  _updateFlags(t) {
    const flags = this._flags;
    if (!flags) return;
    const pos = this._flagMesh.geometry.attributes.position;
    const nor = this._flagMesh.geometry.attributes.normal;
    const P = pos.array, N = nor.array;
    let o = 0;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      let x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3;
      if (f.fly) {
        // Hoist edge on the pole; the fly edge swings around it and flutters.
        const sway = Math.sin(t * 1.7 + f.phase) * 0.22;
        const d = f.yaw + sway;
        const dx = Math.cos(d), dz = Math.sin(d);
        const flut = Math.sin(t * 3.1 + f.phase * 1.7) * 0.09;
        x0 = f.x; y0 = f.topY; z0 = f.z;                                   // hoist top
        x1 = f.x + dx * f.w; y1 = f.topY - 0.10 + flut * 0.5; z1 = f.z + dz * f.w; // fly top
        x2 = f.x; y2 = f.topY - f.h; z2 = f.z;                             // hoist bottom
        x3 = f.x + dx * f.w; y3 = f.topY - f.h - 0.16 + flut; z3 = f.z + dz * f.w; // fly bottom
      } else {
        // Hanging standard: fixed top bar, tapered bottom edge that breathes.
        // The taper is what makes it read as a BANNER; a straight rectangle
        // hanging off a post read as a blank sign in the first screenshots.
        const dx = Math.cos(f.yaw), dz = Math.sin(f.yaw);
        const tx = -dz, tz = dx;
        const sw = Math.sin(t * 1.9 + f.phase) * 0.07 + 0.05;
        const hw = f.w / 2;
        const bw = hw * 0.55;
        x0 = f.x - tx * hw; y0 = f.topY; z0 = f.z - tz * hw;               // top A
        x1 = f.x + tx * hw; y1 = f.topY; z1 = f.z + tz * hw;               // top B
        x2 = f.x - tx * bw + dx * sw; y2 = f.topY - f.h; z2 = f.z - tz * bw + dz * sw; // bottom A
        x3 = f.x + tx * bw + dx * sw; y3 = f.topY - f.h; z3 = f.z + tz * bw + dz * sw; // bottom B
      }
      // Two triangles: (t0, t1, b0) and (b0, t1, b1). The colour attribute
      // was laid down against this exact vertex order in _buildFlags.
      P[o] = x0; P[o + 1] = y0; P[o + 2] = z0;
      P[o + 3] = x1; P[o + 4] = y1; P[o + 5] = z1;
      P[o + 6] = x2; P[o + 7] = y2; P[o + 8] = z2;
      P[o + 9] = x1; P[o + 10] = y1; P[o + 11] = z1;
      P[o + 12] = x2; P[o + 13] = y2; P[o + 14] = z2;
      P[o + 15] = x3; P[o + 16] = y3; P[o + 17] = z3;
      // One face normal per triangle, DoubleSide handles the back.
      let ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
      let bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      let il = 1 / (Math.hypot(nx, ny, nz) || 1);
      for (let v = 0; v < 3; v++) {
        N[o + v * 3] = nx * il; N[o + v * 3 + 1] = ny * il; N[o + v * 3 + 2] = nz * il;
      }
      ax = x2 - x1; ay = y2 - y1; az = z2 - z1;
      bx = x3 - x1; by = y3 - y1; bz = z3 - z1;
      nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx;
      il = 1 / (Math.hypot(nx, ny, nz) || 1);
      for (let v = 3; v < 6; v++) {
        N[o + v * 3] = nx * il; N[o + v * 3 + 1] = ny * il; N[o + v * 3 + 2] = nz * il;
      }
      o += 18;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  /**
   * The dusk boost, 0 by day and 1 at the portal hour. A sealed portal never
   * lifts: its whole job is to look like a thing you cannot use yet, and a
   * gate that brightens at dusk while still refusing entry reads as a bug.
   */
  get _portalLift() { return this._portalU > 0 ? this._portalU : 0; }

  _applyPortalState(p) {
    const { oval, ring, marker } = p.meshes;
    const base = new THREE.Color(p.locked ? dim(p.color) : p.color);
    const u = p.locked ? 0 : this._portalLift;
    oval.material.color.copy(base).multiplyScalar(lerp(PORTAL_OVAL_MUL[0], PORTAL_OVAL_MUL[1], u));
    ring.material.emissive.copy(base);
    ring.material.emissiveIntensity = p.locked
      ? 0.24
      : lerp(PORTAL_RING_EMIT[0], PORTAL_RING_EMIT[1], u);
    marker.material.color.copy(base);
    marker.material.opacity = p.locked ? 0.1 : lerp(PORTAL_MARK_OPACITY[0], PORTAL_MARK_OPACITY[1], u);
    oval.material.opacity = p.locked ? 0.18 : 0.44;
  }

  _buildInteractables() {
    for (const it of INTERACTABLES) {
      this.interactables.push({
        id: it.id,
        label: it.label,
        radius: it.radius,
        open: it.open !== false,
        pos: new THREE.Vector3(it.pos.x, this.field.height(it.pos.x, it.pos.z), it.pos.z),
      });
    }
  }

  // ------------------------------------------------------------ per frame

  update(dt, playerPos) {
    if (!this.built) return;
    this._t += dt;
    const t = this._t;

    if (this.sky) {
      this.sky.material.uniforms.uTime.value = t;
      // The dome is 300 m across and the city is 400 m; without this the
      // horizon clips off behind the player at the far end of the map. The
      // mesh has matrixAutoUpdate off, so the update has to be explicit.
      if (playerPos) {
        this.sky.position.set(playerPos.x, 0, playerPos.z);
        this.sky.updateMatrix();
      }
    }

    // The dusk boost as MULTIPLIERS, so the two animated channels below scale
    // with it instead of fighting it. _applyPortalState sets the resting
    // values; these keep the pulse and the anomaly flicker in proportion.
    const lift = this._portalLift;
    const ovalMul = lerp(PORTAL_OVAL_MUL[0], PORTAL_OVAL_MUL[1], lift);
    const emitScale = lerp(1, PORTAL_RING_EMIT[1] / PORTAL_RING_EMIT[0], lift);
    const markScale = lerp(1, PORTAL_MARK_OPACITY[1] / PORTAL_MARK_OPACITY[0], lift);

    for (const p of this.portals) {
      const { oval, ring, marker } = p.meshes;
      oval.rotation.z += dt * 0.28;
      ring.rotation.z -= dt * 0.11;
      const pulse = 0.5 + Math.sin(t * 1.7 + p.phase) * 0.5;

      if (p.anomaly && !p.locked) {
        // The tell. Rank is a sensor reading taken from outside and it can be
        // wrong; the flicker is the player's only warning before entry.
        p._flick += dt;
        const jitter = Math.sin(t * 21 + p.phase * 4) * 0.5 + 0.5;
        const k = jitter > 0.62 ? 1 : Math.pow(jitter, 3);
        _c1.setHex(p.color);
        _c2.setHex(PORTAL_COLORS.ANOMALY);
        _c1.lerp(_c2, k);
        oval.material.color.copy(_c1).multiplyScalar(ovalMul);
        ring.material.emissive.copy(_c1);
        marker.material.color.copy(_c1);
        ring.material.emissiveIntensity = (0.8 + k * 1.1) * emitScale;
      }

      if (!p.locked) {
        oval.material.opacity = 0.42 + pulse * 0.16;
        marker.material.opacity = (0.17 + pulse * 0.14) * markScale;
      }
    }

    this._updateFlags(t);
    this.citizens?.update(dt, playerPos);
    this.frontier?.update(dt, playerPos);

    if (playerPos) {
      this._notePortalProximity(playerPos);
      this.updateShadowCamera(playerPos, 22);
    }
  }

  /** Fit the shadow frustum to the player and quantise it to whole texels. */
  updateShadowCamera(target, extent = 18) {
    const key = this.key;
    if (!key || !key.castShadow) return;
    const cam = key.shadow.camera;
    if (cam.right !== extent) {
      cam.left = -extent; cam.right = extent;
      cam.top = extent; cam.bottom = -extent;
      cam.near = 1; cam.far = extent * 5.5;
      cam.updateProjectionMatrix();
    }
    const texel = (extent * 2) / (key.shadow.mapSize.x || 1024);
    const dir = this._lightDir;
    _snapM.lookAt(dir, _origin, THREE.Object3D.DEFAULT_UP);
    _snapV.copy(target).applyMatrix4(_snapM);
    _snapV.x = Math.round(_snapV.x / texel) * texel;
    _snapV.y = Math.round(_snapV.y / texel) * texel;
    _snapV.applyMatrix4(_snapM.invert());
    key.target.position.copy(_snapV);
    key.position.copy(_snapV).addScaledVector(dir, extent * 3.0);
    key.target.updateMatrixWorld();
    key.updateMatrixWorld();
  }

  // ------------------------------------------------------------- day/night

  /**
   * Push one sampled DayState (src/render/daynight.js) onto the city.
   *
   * Call order matters exactly once: this must run BEFORE updateShadowCamera
   * in the same frame, or the snap aims along last frame's sun. citymode's
   * updateAlways applies the state and THEN calls City.update, whose last act
   * is that snap.
   *
   * Everything below is a value write. NOTHING here adds, removes or toggles a
   * light, swaps a material, changes a material feature flag or touches
   * castShadow — all of those are in three's program cache key and any of them
   * would recompile every material in the scene mid-frame on a phone. That
   * invariance is the regression this step is most likely to break, which is
   * why the harness asserts renderer.info.programs.length across a full cycle.
   *
   * Allocates nothing: the state object is caller-owned and every target here
   * is an existing Color/Vector3/uniform.
   */
  applyDayState(state) {
    if (!this.built || !state) return;

    // --- key light. ONE DirectionalLight serves sun AND moon; only its
    // colour, its intensity and its aim ever change.
    const key = this.key;
    if (key) {
      key.color.copy(state.keyColor);
      key.intensity = state.keyIntensity;
      // Already quantised upstream. Copying an unchanged vector is cheaper than
      // branching on it, and the snap itself is what the quantisation protects.
      this._lightDir.copy(state.shadowDir);
    }

    // --- ambient fill, with the blue-hour floor restated at the point of use.
    const hemi = this.hemi;
    if (hemi) {
      hemi.color.copy(state.hemiSky);
      hemi.groundColor.copy(state.hemiGround);
      hemi.intensity = Math.max(HEMI_NIGHT_FLOOR, state.hemiIntensity);
    }

    // --- fog and image-based fill.
    const fog = this.scene.fog;
    if (fog) {
      fog.color.copy(state.fogColor);
      fog.near = FOG_NEAR * state.fogScale;
      fog.far = FOG_FAR * state.fogScale;
    }
    // v1 keeps the single afternoon PMREM and modulates its contribution.
    // Rebuilding the environment per keyframe is 4 x PMREM per city and is
    // explicitly deferred (WORLD_SPEC auditFindings.skyPipeline).
    this.scene.environmentIntensity = state.envIntensity;

    // --- dome. Feeds the PRE-BRIGHTENED sky palette; updateSkyState applies
    // the second sRGB conversion itself, so do not pre-convert here.
    if (this.sky) updateSkyState(this.sky, state);

    // --- lit windows and lamp bulbs: two colour writes for the whole town.
    if (this._windowMat) {
      this._windowMat.color.setHex(WINDOW_LIT).multiplyScalar(state.windowGlow);
    }
    if (this._lampMat) this._lampMat.color.copy(_lampOff).lerp(_lampOn, state.lampGlow);

    // --- portals. Only re-walk the six when the boost has actually moved: at
    // a 24-minute cycle it crosses one of these steps a few times a minute,
    // and the per-frame pulse in update() already carries the multipliers.
    const u = Math.min(1, Math.max(0, (state.portalBoost - 1) / PORTAL_BOOST_SPAN));
    if (Math.abs(u - this._portalU) > 0.004) {
      this._portalU = u;
      for (const p of this.portals) this._applyPortalState(p);
    }

    // Schedules (WORLD_SPEC step 10) hang off the same hour. The guard keeps
    // this file from depending on a citizens API that does not exist yet.
    this.citizens?.setPhaseHour?.(state.hours);
  }

  // -------------------------------------------------------------- collision

  /**
   * Spatial hash over boxes and circles. resolve() is called once per entity
   * per physics step; a linear scan of ~400 colliders per call is exactly the
   * kind of thing that looks fine on a desktop and costs 4 ms on a phone.
   */
  _buildHash() {
    const cell = this._hashCell;
    const map = new Map();
    const put = (k, v) => {
      let arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      arr.push(v);
    };
    const stamp = (minx, minz, maxx, maxz, entry) => {
      const i0 = Math.floor(minx / cell), i1 = Math.floor(maxx / cell);
      const j0 = Math.floor(minz / cell), j1 = Math.floor(maxz / cell);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) put(`${i},${j}`, entry);
    };
    const pad = 2.0;    // widest entity radius we ever resolve against
    for (const b of this.boxes) {
      stamp(b.x - b.w / 2 - pad, b.z - b.d / 2 - pad, b.x + b.w / 2 + pad, b.z + b.d / 2 + pad,
        { box: b });
    }
    for (const o of this.obstacles) {
      stamp(o.pos.x - o.radius - pad, o.pos.z - o.radius - pad,
        o.pos.x + o.radius + pad, o.pos.z + o.radius + pad, { circle: o });
    }
    this._hash = map;
  }

  // -------------------------------------------------- runtime phone budget

  /**
   * Re-point every sheddable instanced field at a new quality tier's density,
   * WITHOUT a rebuild.
   *
   * WHY THIS EXISTS. instanceScale used to be read exactly once, at build time.
   * The frame-rate governor could step a struggling device from ultra to low —
   * turning shadows off, dropping the pixel ratio, cutting the character budget
   * — and the world kept every triangle it had been sized with until the player
   * next re-entered the city from a gate. Measured on this wave's city: ultra
   * vs low is 1,136,880 vs 600,774 world triangles, and the stale-tier penalty
   * (536,106) is nearly three times what it was before the Verge existed. The
   * headline feature of this wave is a long walkable city+frontier session that
   * need never touch a gate, so "it fixes itself on the next gate run" stopped
   * being an answer.
   *
   * WHAT IT DOES NOT DO. It cannot add instances that were never placed, so a
   * step UP only restores what this build holds (the next City.build at the
   * higher tier does the rest); it does not touch street-ordered KitField props,
   * whose placement order is spatial and would thin one quarter of town; and it
   * does not re-bake the navgrid — the city's grid has no runtime consumer
   * (see attachNavGrid) and collision reads this.obstacles through the hash,
   * which is why thinned colliders are switched off in place instead.
   *
   * Costs nothing per instance: InstancedMesh.count is a draw-range write, not
   * a reallocation, and it is not part of three's program cache key.
   *
   * @param {number} scale  a quality tier's instanceScale
   * @returns {?object} what changed, or null if nothing did
   */
  setInstanceDensity(scale) {
    if (!this.built) return null;
    const want = Math.max(0.35, Math.min(1.35, Number(scale) || 1));
    if (want === this._density) return null;
    this._density = want;
    // Relative to the build. At or above the built density every field is whole.
    const f = Math.min(1, want / (this._buildDensity || 1));
    let shed = 0;
    let offCount = 0;
    for (const g of this._scatter) {
      const full = g.field.trianglesFull;
      g.field.setDensity(f);
      const live = g.field.live;
      shed += full - g.field.triangles;
      for (const o of g.solids) {
        o.off = o.i >= live;
        if (o.off) offCount++;
      }
    }
    if (this.frontier) {
      const fr = this.frontier.setInstanceDensity(f);
      shed += fr.triangles;
      offCount += fr.collidersOff;
    }
    this._triangles = this._triangleBase - shed;
    return { density: want, buildDensity: this._buildDensity, shedTriangles: shed, collidersOff: offCount };
  }

  /** Push `pos` out of the city's solids. Matches World.resolve's signature. */
  resolve(pos, radius, vel = null) {
    if (!this._hash) return;
    const slide = (nx, nz) => {
      if (!vel) return;
      const into = vel.x * nx + vel.z * nz;
      if (into >= 0) return;
      vel.x -= nx * into;
      vel.z -= nz * into;
    };

    const cell = this._hashCell;
    const i = Math.floor(pos.x / cell), j = Math.floor(pos.z / cell);
    const bucket = this._hash.get(`${i},${j}`);
    if (bucket) {
      for (const e of bucket) {
        if (e.box) {
          const b = e.box;
          const hx = b.w / 2 + radius;
          const hz = b.d / 2 + radius;
          const dx = pos.x - b.x;
          const dz = pos.z - b.z;
          if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) continue;
          // Least-penetration axis: pushing out of the deep axis would shove a
          // player who brushes a wall corner clean across the building.
          const px = hx - Math.abs(dx);
          const pz = hz - Math.abs(dz);
          if (px < pz) {
            const s = dx < 0 ? -1 : 1;
            pos.x = b.x + s * hx;
            slide(s, 0);
          } else {
            const s = dz < 0 ? -1 : 1;
            pos.z = b.z + s * hz;
            slide(0, s);
          }
        } else {
          const o = e.circle;
          // A scatter instance the density lever has stopped DRAWING must also
          // stop blocking: an invisible bush you cannot walk through is a worse
          // bug than the triangles it saved. Only setInstanceDensity ever sets
          // this, and only on scatter, so every other solid skips one boolean.
          if (o.off) continue;
          const dx = pos.x - o.pos.x;
          const dz = pos.z - o.pos.z;
          const min = o.radius + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= min * min) continue;
          let nx, nz;
          if (d2 > 1e-6) { const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; } else { nx = 1; nz = 0; }
          pos.x = o.pos.x + nx * min;
          pos.z = o.pos.z + nz * min;
          slide(nx, nz);
        }
      }
    }

    // Hard world bound, kept INSIDE the lip where the ground starts falling
    // away, so the edge of the world is a view rather than a pit. With the Verge
    // built that lip is 124 m further out, and this is the line that lets the
    // player leave town at all.
    const lim = (this.frontier ? VERGE_LIMIT : WALK_LIMIT) - radius;
    if (pos.x > lim) { pos.x = lim; slide(-1, 0); }
    // WEST IS DIFFERENT. The ground falls 34 m away west of CLIFF_X, and the
    // parapet at line ~630 only spans the walled stretch (|z| < WALL_HALF).
    // North and south of that, -WALK_LIMIT let a player stroll straight off a
    // cliff onto a void floor with no way back up. The lip itself is the world
    // bound now, which is what the comment above always claimed it was.
    //
    // This clamp is deliberately UNCONDITIONAL in z, which is what "the cliff
    // line continues as a frontier fence north and south of the wall" means: the
    // Verge opens the map to 258 m on the other three sides but the drop stays
    // the drop for its whole length, all the way out to the Verge's own bound.
    const westLim = CLIFF_X + 1 + radius;
    if (pos.x < westLim) { pos.x = westLim; slide(1, 0); }
    if (pos.z > lim) { pos.z = lim; slide(0, -1); }
    if (pos.z < -lim) { pos.z = -lim; slide(0, 1); }
  }

  // ------------------------------------------------------------------ query

  /**
   * Ground height, blending authority across the seam.
   *
   * citymode's bound _height/_resolve/_normal closures do NOT know the frontier
   * exists — the delegation lives here so the disposal registry, the spatial
   * hash and the physics environment stay single-owner.
   *
   * The blend is belt-and-braces rather than load-bearing: the stitch in
   * HeightField.bake makes the two fields identical from r 155 outward, so
   * inside the band the lerp is between two numbers that already agree. It is
   * kept because "the two fields agree exactly" is a property a future edit to
   * groundBase could quietly break, and a 0.4 m seam step is a bug you find by
   * falling through it.
   */
  heightAt(x, z) {
    if (!this.field) return 0;
    const f = this.frontier;
    if (!f) return this.field.height(x, z);
    const r = Math.max(Math.abs(x), Math.abs(z));
    if (r <= BLEND_R0) return this.field.height(x, z);
    if (r >= BLEND_R1) return f.heightAt(x, z);
    const t = (r - BLEND_R0) / (BLEND_R1 - BLEND_R0);
    return lerp(this.field.height(x, z), f.heightAt(x, z), t);
  }

  groundNormal(x, z, out) {
    const o = out || { x: 0, y: 1, z: 0 };
    if (!this.field) { o.x = 0; o.y = 1; o.z = 0; return o; }
    // Hard switch at the middle of the blend band rather than a lerp: two face
    // normals averaged across a seam produce a direction that matches neither
    // surface, and this feeds foot placement, not lighting. The surfaces are
    // identical here (see heightAt), so the switch is continuous in practice.
    const f = this.frontier;
    if (f && Math.max(Math.abs(x), Math.abs(z)) > (BLEND_R0 + BLEND_R1) / 2) {
      return f.groundNormal(x, z, o);
    }
    return this.field.normal(x, z, o);
  }

  portalAt(pos) {
    for (const p of this.portals) {
      const dx = pos.x - p.pos.x;
      const dz = pos.z - p.pos.z;
      if (dx * dx + dz * dz < p.radius * p.radius) return p;
    }
    return null;
  }

  nearestPortal(pos) {
    let best = null, bestD = Infinity;
    for (const p of this.portals) {
      const d = Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { portal: best, distance: bestD } : null;
  }

  interactAt(pos) {
    let best = null, bestD = Infinity;
    for (const it of this.interactables) {
      // Closed doors never prompt — see the `open` note on INTERACTABLES.
      if (!it.open) continue;
      const d = Math.hypot(pos.x - it.pos.x, pos.z - it.pos.z);
      if (d < it.radius && d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  /**
   * Set the state of EVERY portal of this rank, not the first one found.
   *
   * citymode.refreshPortalLocks walks GATES and calls this once per rank, which
   * is what locks a gate the save cannot enter yet. Once the Verge exists there
   * are two C portals — the plaza's and the wild one — and a `find` would have
   * left the wild C unlocked at level 1 forever, which is the one gameplay rule
   * the spec states outright for it ("locked until save.level >= 11").
   */
  setPortalState(rank, { locked, anomaly } = {}) {
    for (const p of this.portals) {
      if (p.rank !== rank) continue;
      if (typeof locked === 'boolean') p.locked = locked;
      if (typeof anomaly === 'boolean') p.anomaly = anomaly;
      this._applyPortalState(p);
    }
  }

  /**
   * Remember the last portal the player stood at, so a wild gate can be stepped
   * back out of. Called once per frame from update(); no allocation, and the
   * loop is the eight portals a city has.
   *
   * Standing at a PLAZA portal clears the memory, which is what stops "walked
   * past the wild gate once" from redirecting a later plaza-gate return.
   */
  _notePortalProximity(pos) {
    for (let i = 0; i < this.portals.length; i++) {
      const p = this.portals[i];
      const dx = pos.x - p.pos.x;
      const dz = pos.z - p.pos.z;
      // Slightly wider than citymode's PROMPT_SLACK (2.2): the memory must be
      // set on every frame the ENTER prompt is showing, including the frame the
      // player presses it on.
      const r = p.radius + 3.0;
      if (dx * dx + dz * dz > r * r) continue;
      _lastWildPortal = p.wild ? { rank: p.rank, x: p.pos.x, z: p.pos.z } : null;
      return;
    }
  }

  /** Order the remembered wild gate ahead of its plaza twin, then forget it. */
  _promoteReturnPortal() {
    const want = _lastWildPortal;
    if (!want) return;
    _lastWildPortal = null;
    const i = this.portals.findIndex((p) => p.wild && p.rank === want.rank
      && Math.abs(p.pos.x - want.x) < 2 && Math.abs(p.pos.z - want.z) < 2);
    if (i <= 0) return;
    this.portals.unshift(this.portals.splice(i, 1)[0]);
  }

  /**
   * The player arrives on the plaza, facing the portals.
   *
   * The nominal point (0, PLAZA_R - 8) sits 0.5 m from the centre of the plaza
   * fountain, which is a 2.4 m solid: the player spawned INSIDE it and could
   * walk south, east and west but exactly 0 m north toward the portals. So
   * the nominal point is a hint, not a promise — probe outward from it with
   * the real collision resolver and return the first spot that is actually
   * standable. That also keeps this honest if anyone adds another prop here.
   */
  spawnPoint(radius = 0.6) {
    // Offset in x on purpose: dead on the z axis the fountain sits directly
    // between the player and every portal, so the first thing a new player
    // does — push the stick forward — walks him into a wall a metre away.
    // From here the plaza opens ahead and the fountain is a landmark to his
    // left rather than a roadblock.
    const nominal = { x: 7, z: PLAZA_R - 5 };
    const clear = (x, z) => {
      if (!this._hash) return true;
      const p = new THREE.Vector3(x, 0, z);
      this.resolve(p, radius);
      return Math.hypot(p.x - x, p.z - z) < 1e-3;
    };
    if (clear(nominal.x, nominal.z)) {
      return new THREE.Vector3(nominal.x, this.heightAt(nominal.x, nominal.z), nominal.z);
    }
    // Rings outward, south first — the player should end up looking INTO the
    // plaza, not out of it, so bias toward the near lip.
    for (let r = 2; r <= 14; r += 1.5) {
      for (let k = 0; k < 12; k++) {
        // k=0 is due south of the nominal point, then alternate east/west.
        const a = Math.PI / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 7);
        const x = nominal.x + Math.cos(a) * r;
        const z = nominal.z + Math.sin(a) * r;
        if (clear(x, z)) return new THREE.Vector3(x, this.heightAt(x, z), z);
      }
    }
    return new THREE.Vector3(nominal.x, this.heightAt(nominal.x, nominal.z), nominal.z);
  }

  // ---------------------------------------------------------------- nav

  /**
   * src/world/navgrid.js is a sibling agent's file and does not exist yet, so
   * this cannot import it — an unresolved import is a build failure, not a
   * graceful degradation. Integration wires it with:
   *
   *   const g = new NavGrid({ originX: -200, originZ: -200, size: 400, cell: 2 });
   *   city.attachNavGrid(g);
   *
   * navBlockers exposes exactly what NavGrid.blockBox / blockCircle want, and
   * `boxes` are real rectangles precisely so a 4 x 14 m terrace is not
   * rasterised as a circle that seals the street either side of it.
   */
  get navGrid() { return this._navGrid; }

  get navBlockers() {
    return {
      boxes: this.boxes,
      circles: this.obstacles,
      cell: KIT_CELL,
      originX: -WORLD_HALF,
      originZ: -WORLD_HALF,
      size: WORLD_HALF * 2,
      walkable: (x, z) => this.field.slope(x, z) < 0.45 && x > CLIFF_X - 1,
    };
  }

  attachNavGrid(grid) {
    this._navGrid = grid || null;
    if (!grid) return null;
    grid.clear?.();
    for (const b of this.boxes) grid.blockBox?.(b.x, b.z, b.w, b.d, b.rot || 0);
    for (const o of this.obstacles) grid.blockCircle?.(o.pos.x, o.pos.z, o.radius);
    // NOT negated. NavGrid.blockOutside's predicate returns true for cells
    // INSIDE the playable region and it blocks everything else; this line used
    // to pass the complement, which blocked every walkable cell in the town and
    // left the cliff face open. Nothing caught it because nothing consumes the
    // city's navgrid at runtime yet (citizens steer with resolve()) and no test
    // had ever baked one — WORLD_SPEC step 9's "NPCs can path inside" assert is
    // what finally did. Same expression as navBlockers.walkable, deliberately.
    grid.blockOutside?.((x, z) => this.field.slope(x, z) < 0.45 && x > CLIFF_X - 1);
    grid.bake?.();
    return grid;
  }

  // ---------------------------------------------------------------- stats

  get stats() {
    let drawGroups = 0;
    let instances = 0;
    this.group.traverse((o) => {
      if (o.isInstancedMesh) { drawGroups++; instances += o.count; } else if (o.isMesh) drawGroups++;
    });
    return {
      drawGroups,
      chunksVisible: 1,          // honest: the city is one always-visible group
      instances,
      triangles: Math.round(this._triangles),
      buildings: this.boxes.length,
      portals: this.portals.length,
      // The Verge's wild gates live in this.portals too (that is what makes the
      // compass and the prompt work on them unmodified), so `portals` alone can
      // no longer answer "does the town have its six".
      wildGates: this.frontier ? this.frontier.wildGates.length : 0,
      // Per-field triangle cost. Global instancing trades culling for draw
      // calls, so this is the number that has to be watched instead.
      fields: this.fields
        .concat(this.frontier ? this.frontier.fields : [])
        // `count` is what was PLACED, `live` what is currently drawn — they
        // differ exactly when the runtime density lever has thinned a field.
        .map((f) => ({
          key: f.key, count: f.count, live: f.live ?? f.count, triangles: f.triangles,
        }))
        .sort((a, b) => b.triangles - a.triangles),
      // What the phone-budget fence is currently set to, so a harness can tell
      // a stale tier from an applied one without guessing from triangle counts.
      density: this._density,
      buildDensity: this._buildDensity,
      kit: cityKitStats(),
      nature: natureKitStats(),
      citizens: this.citizens ? this.citizens.stats : null,
      frontier: this.frontier ? this.frontier.stats : null,
      interiors: this.interiors ? this.interiors.stats : null,
    };
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const _snapM = new THREE.Matrix4();
const _snapV = new THREE.Vector3();
// The light direction USED to live here as a module constant. It is per-City
// state now (this._lightDir, fed by applyDayState) because the sun moves —
// see the constructor.
const _origin = new THREE.Vector3();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
// Lamp-bulb ramp endpoints, built once. Parsing two hexes every frame to lerp
// between two constants is the sort of thing that is invisible on a desktop.
const _lampOff = new THREE.Color(LAMP_UNLIT);
const _lampOn = new THREE.Color(LAMP_LIT);

function dim(hex) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(0.34);
  return c.getHex();
}

function paintGeo(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function cylinder(rTop, rBottom, h, seg, hex) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1);
  g.translate(0, h / 2, 0);
  return paintGeo(g, hex);
}

// Scratch transforms for _buildSpireCap. Module-level because the build path
// runs once per city and a fresh Matrix4 per kit piece is still garbage the
// phone has to collect during a load screen.
const _spm = /* @__PURE__ */ new THREE.Matrix4();
const _spq = /* @__PURE__ */ new THREE.Quaternion();
const _spp = /* @__PURE__ */ new THREE.Vector3();
const _sps = /* @__PURE__ */ new THREE.Vector3(1, 1, 1);
const _spUp = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

// Stack geometries without importing BufferGeometryUtils twice; the daises and
// the wall are the only merges city.js does itself.
function mergeAll(geos) {
  if (geos.length === 1) return geos[0];
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
    const p = g.attributes.position.array;
    const nn = g.attributes.normal.array;
    const cc = g.attributes.color ? g.attributes.color.array : null;
    const cnt = g.attributes.position.count;
    pos.set(p, vo * 3);
    nor.set(nn, vo * 3);
    if (cc) col.set(cc, vo * 3);
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
 * Convenience for callers that want the kits ready before build().
 *
 * Returns the CITY kit's result, matching the old contract — main.js warns on
 * false with a citykit-specific message. The nature kit rides along: its
 * failure is non-fatal by design (the scatter falls back to procedural tufts
 * inside naturekit.js) and it logs its own warning, so no caller changes.
 */
export async function preloadCity() {
  const [cityOk, natureOk, dungeonOk] = await Promise.all([
    loadCityKit(), loadNatureKit(), loadDungeonKit(),
  ]);
  if (!natureOk) console.warn('[city] models/nature.glb unavailable — using procedural ground scatter');
  // DUNGEON_SPEC STEP 9: the dungeon kit rides the same boot preload so a
  // gate entry never races the fetch. Non-fatal by design — the dressing
  // pass degrades to the dungeon_* PROC twins in citykit.js.
  if (!dungeonOk) console.warn('[city] models/dungeonkit.glb unavailable — dungeon dressing falls back to procedural twins');
  return cityOk;
}

export { KIT_CELL, cityKitLoaded, cityMaterials, disposeCityKit };
