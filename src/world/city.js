import * as THREE from 'three';
import { mulberry32, fbm } from './terrain.js';
import {
  KIT_CELL, KIT_STOREY, KitField, cityKitLoaded, cityMaterials,
  disposeCityKit, cityKitStats, loadCityKit,
} from './citykit.js';
import { GLOW_LAYER } from '../render/glow.js';
import { makeSky } from '../render/sky.js';
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
export const DISTRICTS = [
  { id: 'plaza',    name: 'THE GATE PLAZA', pos: { x: 0, z: 0 },       pad: PLAZA_R, service: null },
  { id: 'assay',    name: 'THE ASSAY HALL', pos: { x: 0, z: -38 },     pad: 15, service: 'assay' },
  { id: 'ashworks', name: 'THE ASHWORKS',   pos: { x: 44, z: 4 },      pad: 16, service: 'barracks' },
  { id: 'exchange', name: 'THE EXCHANGE',   pos: { x: -4, z: 34 },     pad: 15, service: 'exchange' },
  { id: 'row',      name: 'QUARTER ROW',    pos: { x: -52, z: 2 },     pad: 14, service: null },
  { id: 'breach',   name: 'THE BREACH',     pos: { x: 0, z: BREACH_Z }, pad: 18, service: null },
];

// Doors the player can stand in front of. Radii are generous because a phone
// player steers with a thumb, not a mouse.
const INTERACTABLES = [
  { id: 'barracks', label: 'THE ASHWORKS',   pos: { x: 44, z: 12 },  radius: 4.5 },
  { id: 'assay',    label: 'THE ASSAY HALL', pos: { x: 0, z: -30 },  radius: 4.5 },
  { id: 'trial',    label: 'THE SEALED STAIR', pos: { x: -7, z: -38 }, radius: 3.5 },
  { id: 'exchange', label: 'THE EXCHANGE',   pos: { x: -4, z: 26 },  radius: 4.5 },
  { id: 'stash',    label: 'THE STASH',      pos: { x: 6, z: 34 },   radius: 3.5 },
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

const smoothstep = (a, b, x) => {
  if (b === a) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// HeightField — the single source of truth for "where is the ground"
// ---------------------------------------------------------------------------

class HeightField {
  constructor({ size, cell, seed }) {
    this.size = size;
    this.half = size / 2;
    this.cell = cell;
    this.n = Math.round(size / cell);          // cells per side
    this.stride = this.n + 1;
    this.h = new Float32Array(this.stride * this.stride);
    this.seed = seed >>> 0;
    this.flats = [];
  }

  /** Level a disc into the field. `height` null means "level to its centre". */
  addFlat({ x, z, radius, feather = 6, height = null }) {
    this.flats.push({ x, z, radius, feather, height });
    return this;
  }

  /** The undisturbed shape: gentle roll, a west cliff, and a boundary ridge. */
  raw(x, z) {
    const s = 1 / 96;
    let h = (fbm(x * s, z * s, this.seed, 3) - 0.5) * 5.2;
    h += (fbm(x * s * 3.1 + 17, z * s * 3.1 - 9, this.seed + 41, 2) - 0.5) * 1.6;

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
    // by resolve()'s WALK_LIMIT well before the lip, so it is not a fall hazard.
    const r = Math.max(Math.abs(x), Math.abs(z));
    h = lerp(-46, h, 1 - smoothstep(140, 156, r));

    // The Breach approach climbs: walking out to the S gate is uphill.
    const bd = Math.hypot(x, z - BREACH_Z);
    h += smoothstep(62, 16, bd) * 7.5;
    return h;
  }

  bake() {
    const { n, stride, cell, half } = this;
    for (let jz = 0; jz <= n; jz++) {
      const z = -half + jz * cell;
      for (let ix = 0; ix <= n; ix++) {
        const x = -half + ix * cell;
        let v = this.raw(x, z);
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
    this.portals = [];
    this.interactables = [];
    this.obstacles = [];      // { pos:{x,z}, radius } — round props
    this.boxes = [];          // { x, z, w, d, rot } — buildings and walls
    this.fields = [];         // KitField instances
    this.districts = DISTRICTS;
    this.streets = [];
    this.built = false;

    this._navGrid = null;
    this._t = 0;
    this._envRT = null;
    this._ownedGeometries = [];
    this._ownedMaterials = [];
    this._hash = null;
    this._hashCell = 8;
    this._triangles = 0;
    this._prevScene = null;
  }

  // ------------------------------------------------------------------ build

  /**
   * Assemble the city. Synchronous by design: citykit.glb must already be
   * loaded (await loadCityKit() during boot) or every piece silently falls
   * back to its procedural twin — which still builds a coherent, walkable,
   * collidable city, just a blockier one.
   */
  build(seed = 20260806, save = null) {
    this.dispose();
    const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);

    // 1. Ground first: everything else is placed onto it.
    this.field = new HeightField({ size: WORLD_HALF * 2, cell: GROUND_CELL, seed });
    for (const d of this.districts) {
      this.field.addFlat({ x: d.pos.x, z: d.pos.z, radius: d.pad, feather: 12, height: d.id === 'plaza' ? 0 : null });
    }
    this.field.bake();

    this.streets = buildStreets();

    // 2. Lay the town out on the 2 m kit grid, then carve a pad under every
    //    building so no wall floats and no doorstep is a cliff.
    const buildings = this._layout(rnd);
    for (const b of buildings) {
      this.field.addFlat({
        x: b.cx, z: b.cz,
        radius: Math.max(b.w, b.d) * 0.5 + 1.4,
        feather: 4.5,
        height: this.field.height(b.cx, b.cz),
      });
    }
    this.field.bake();

    // 3. Geometry.
    this._buildSkyAndLight();
    this._buildGround();
    this._buildCityWall();
    this._buildBuildings(buildings, rnd);
    this._buildProps(rnd, buildings);
    this._buildPortals(rnd, save);
    this._buildInteractables();

    for (const f of this.fields) { f.finalize().addTo(this.group); this._triangles += f.triangles; }
    this._buildHash();
    this.built = true;
    return this;
  }

  // --------------------------------------------------------------- teardown

  dispose() {
    this.group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    for (const g of this._ownedGeometries) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedGeometries.length = 0;
    this._ownedMaterials.length = 0;
    for (const f of this.fields) f.dispose();
    this.fields.length = 0;
    this.group.clear();

    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this._prevScene) {
      this.scene.fog = this._prevScene.fog;
      this.scene.background = this._prevScene.background;
      this.scene.environment = this._prevScene.environment;
      this._prevScene = null;
    }

    this.portals.length = 0;
    this.interactables.length = 0;
    this.obstacles.length = 0;
    this.boxes.length = 0;
    this.field = null;
    this._hash = null;
    this._navGrid = null;
    this._triangles = 0;
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
    };

    this.sky = makeSky(SKY_BIOME, { stars: 0.0, aurora: 0.12 });
    this.group.add(this.sky);
    this._ownedGeometries.push(this.sky.geometry);
    this._ownedMaterials.push(this.sky.material);

    this.scene.fog = new THREE.Fog(CITY_BIOME.fog, 130, 430);
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
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    const idx = new Uint32Array(n * n * 6);

    // No convertSRGBToLinear anywhere in this file: ColorManagement is on, so
    // new THREE.Color(hex) is already in the linear working space and a second
    // conversion squares it — every surface came out at an eighth brightness
    // and read as a lighting bug rather than a colour bug. See citykit.js.
    const grass = new THREE.Color(0x6d8c4a);
    const dry = new THREE.Color(0xa08f60);
    const rock = new THREE.Color(0x8a8f9e);
    const road = new THREE.Color(0xbbb29a);
    const flag = new THREE.Color(0xc3c6bb);
    const ash = new THREE.Color(0x5c5763);
    const c = new THREE.Color();

    for (let jz = 0; jz <= n; jz++) {
      const z = -f.half + jz * f.cell;
      for (let ix = 0; ix <= n; ix++) {
        const x = -f.half + ix * f.cell;
        const k = jz * stride + ix;
        pos[k * 3] = x;
        pos[k * 3 + 1] = f.h[k];
        pos[k * 3 + 2] = z;

        // Base: grass, drying out toward the walls, rock on steep faces.
        const r = Math.max(Math.abs(x), Math.abs(z));
        c.copy(grass).lerp(dry, smoothstep(WALL_HALF - 26, WALL_HALF + 40, r));
        c.lerp(rock, Math.min(1, f.slope(x, z) / 0.5) * 0.85);

        // Paving.
        let pave = 0;
        for (const s of this.streets) {
          const d = distToSegment(x, z, s);
          if (d < s.w + 2.4) pave = Math.max(pave, 1 - smoothstep(s.w - 0.6, s.w + 2.4, d));
        }
        if (pave > 0) c.lerp(road, pave);

        const dPlaza = Math.hypot(x, z);
        if (dPlaza < PLAZA_R + 2) c.lerp(flag, 1 - smoothstep(PLAZA_R - 1, PLAZA_R + 2, dPlaza));

        const dBreach = Math.hypot(x, z - BREACH_Z);
        if (dBreach < 20) c.lerp(ash, 1 - smoothstep(13, 20, dBreach));

        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      }
    }

    // Winding (a, c, b) / (a, d, c) puts the face normal up, and matches the
    // a-c diagonal that HeightField.height() interpolates across.
    let o = 0;
    for (let jz = 0; jz < n; jz++) {
      for (let ix = 0; ix < n; ix++) {
        const a = jz * stride + ix;
        const b = a + 1;
        const d = a + stride;
        const cc = d + 1;
        idx[o++] = a; idx[o++] = cc; idx[o++] = b;
        idx[o++] = a; idx[o++] = d; idx[o++] = cc;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'city_ground';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.ground = mesh;
    this.group.add(mesh);
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
    this._triangles += n * n * 2;
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

    // Three walls, each broken by one gate on its centre line.
    const straight = (axis, sign) => {
      for (const side of [-1, 1]) {
        const a0 = side < 0 ? -H : GATE;
        const a1 = side < 0 ? -GATE : H;
        if (axis === 'x') {
          const z = sign * H;
          const y = this._wallBase(0, z);
          push(a0, a1, y, y + WH, z - T / 2, z + T / 2, 0xa39b8b);
          push(a0, a1, y + WH, y + WH + 0.7, z - T / 2 - 0.25, z + T / 2 + 0.25, 0x8b8577);
          runs.push({ x: (a0 + a1) / 2, z, w: a1 - a0, d: T, rot: 0 });
        } else {
          const x = sign * H;
          const y = this._wallBase(x, 0);
          push(x - T / 2, x + T / 2, y, y + WH, a0, a1, 0xa39b8b);
          push(x - T / 2 - 0.25, x + T / 2 + 0.25, y + WH, y + WH + 0.7, a0, a1, 0x8b8577);
          runs.push({ x, z: (a0 + a1) / 2, w: T, d: a1 - a0, rot: 0 });
        }
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
        if (near < 22) anchors.push({ ci, cj, near });
      }
    }
    for (let i = anchors.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
    }
    anchors.sort((a, b) => a.near - b.near);

    const out = [];
    const styles = ['timber', 'timber', 'stone', 'brick'];
    for (const a of anchors) {
      if (out.length >= BUILDING_BUDGET) break;
      // Try the biggest wing that fits, then step down. Taking the first
      // random size and giving up leaves half the block empty, which is what
      // makes a procedural town read as a scatter of sheds.
      const alongZ = rnd() < 0.5;
      let wc = 0, dc = 0;
      for (const len of [7, 6, 5, 4, 3, 2]) {
        const w = alongZ ? 2 : len;
        const d = alongZ ? len : 2;
        if (free(a.ci, a.cj, w, d)) { wc = w; dc = d; break; }
      }
      if (!wc) continue;
      mark(a.ci, a.cj, wc, dc);

      const cx = (a.ci + (wc - 1) / 2) * KIT_CELL;
      const cz = (a.cj + (dc - 1) / 2) * KIT_CELL;
      out.push({
        ci: a.ci, cj: a.cj, wc, dc,
        cx, cz,
        w: wc * KIT_CELL, d: dc * KIT_CELL,
        ridgeAlongZ: alongZ,
        floors: 1 + Math.floor(rnd() * 2.4),       // 1..3, weighted to 1-2
        style: styles[Math.floor(rnd() * styles.length)],
      });
    }
    return out;
  }

  // -------------------------------------------------------------- buildings

  _buildBuildings(buildings, rnd) {
    const wallKeys = {
      timber: ['town_wall_wood', 'town_wall_wood_window_shutters', 'town_wall_wood_door'],
      stone: ['town_wall', 'town_wall_window_small', 'town_wall_door'],
      brick: ['town_wall', 'town_wall_window_small', 'town_wall_door'],
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

      for (let fl = 0; fl < b.floors; fl++) {
        const y = base + fl * KIT_STOREY;
        // Doors only on the ground floor; windows are common; plain wall is
        // the default because it is 32 triangles against a door's 376.
        const pick = () => {
          if (fl === 0 && rnd() < 0.07) return keys[2];
          if (rnd() < 0.28) return keys[1];
          return keys[0];
        };
        for (let j = j0; j <= j1; j++) {
          emit(pick(), i1 * KIT_CELL, y, j * KIT_CELL, 0);
          emit(pick(), i0 * KIT_CELL, y, j * KIT_CELL, Math.PI);
        }
        for (let i = i0; i <= i1; i++) {
          emit(pick(), i * KIT_CELL, y, j0 * KIT_CELL, Math.PI / 2);
          emit(pick(), i * KIT_CELL, y, j1 * KIT_CELL, -Math.PI / 2);
        }
      }

      // Gable. The low edge of each `town_roof` faces outward and the two
      // halves meet on the ridge; see _layout for why the gable axis is 2 wide.
      const ry = base + b.floors * KIT_STOREY;
      if (b.ridgeAlongZ) {
        for (let j = j0; j <= j1; j++) {
          emit('town_roof', i0 * KIT_CELL, ry, j * KIT_CELL, 0);
          emit('town_roof', i1 * KIT_CELL, ry, j * KIT_CELL, Math.PI);
        }
      } else {
        for (let i = i0; i <= i1; i++) {
          emit('town_roof', i * KIT_CELL, ry, j0 * KIT_CELL, -Math.PI / 2);
          emit('town_roof', i * KIT_CELL, ry, j1 * KIT_CELL, Math.PI / 2);
        }
      }

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

    const glowGeo = new THREE.PlaneGeometry(0.85, 0.6);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffcf8c, toneMapped: false });
    this._ownedGeometries.push(glowGeo);
    this._ownedMaterials.push(glowMat);
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
    const q = this.quality?.current || { instanceScale: 1 };
    const density = Math.max(0.35, Math.min(1.35, q.instanceScale ?? 1));
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

    // --- plaza ring: pillars and banners -----------------------------------
    const pillar = add('town_pillar_stone', 40);
    const banner = add('town_banner_red', 30);
    const banner2 = add('town_banner_green', 30);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = Math.cos(a) * (PLAZA_R + 2.4), z = -Math.sin(a) * (PLAZA_R + 2.4);
      const y = this.field.height(x, z);
      pillar.place(x, y, z, -a);
      const b = i % 2 ? banner : banner2;
      b.place(x, y + 1.6, z, -a + Math.PI);
      this.obstacles.push({ pos: { x, z }, radius: 0.5 });
    }

    // --- fountain: one in the plaza, one on Quarter Row --------------------
    const fountain = add('town_fountain_round', 2);
    for (const p of [{ x: 0, z: 17.5 }, { x: -58, z: -12 }]) {
      fountain.place(p.x, this.field.height(p.x, p.z), p.z, 0);
      this.obstacles.push({ pos: { x: p.x, z: p.z }, radius: 2.4 });
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
    for (let i = 0; i < 18; i++) {
      const x = -30 - i * 2.8 + (rnd() - 0.5) * 3;
      const z = (rnd() < 0.5 ? -1 : 1) * (7 + rnd() * 3);
      if (this._blockedForProp(x, z, 1)) continue;
      bench.place(x, this.field.height(x, z), z, z < 0 ? 0 : Math.PI);
      this.obstacles.push({ pos: { x, z }, radius: 0.7 });
    }
    // The overlook bench, facing the drop.
    bench.place(CLIFF_X + 4.5, this.field.height(CLIFF_X + 4.5, 0), 0, Math.PI / 2);

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
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd18a, toneMapped: false });
    this._ownedGeometries.push(geo);
    this._ownedMaterials.push(mat);
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

  // ---------------------------------------------------------------- portals

  _buildPortals(rnd, save) {
    const level = Number(save?.level) || 1;

    // Geometry and materials shared across all six portals: six Groups of four
    // meshes, twenty-four draw calls, two geometries.
    const daisGeo = mergeAll([
      cylinder(4.9, 5.4, 0.34, 24, 0x9aa0b0),
      cylinder(3.9, 4.2, 0.72, 24, 0xb4bac8),
      cylinder(3.5, 3.5, 0.84, 24, 0x8f95a6),
    ]);
    const daisMat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0.06,
    });
    this._ownedGeometries.push(daisGeo);
    this._ownedMaterials.push(daisMat);

    const ovalGeo = new THREE.CircleGeometry(1, 40);
    ovalGeo.scale(2.15, 2.9, 1);
    const ringGeo = new THREE.TorusGeometry(1, 0.075, 8, 44);
    ringGeo.scale(2.3, 3.05, 1);
    const markGeo = new THREE.RingGeometry(4.4, 5.0, 44);
    markGeo.rotateX(-Math.PI / 2);
    this._ownedGeometries.push(ovalGeo, ringGeo, markGeo);

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

      const g = new THREE.Group();
      g.name = `portal_${rank.toLowerCase()}`;
      g.position.set(px, py, pz);
      // Face the plaza centre (the Breach faces back down its road).
      g.rotation.y = outside ? 0 : Math.atan2(-px, -pz);
      g.scale.setScalar(scale);

      const dais = new THREE.Mesh(daisGeo, daisMat);
      dais.receiveShadow = true;
      dais.castShadow = true;
      g.add(dais);

      // GLOW_LAYER carries the portal SURFACE and nothing else — not the ring,
      // not the ground marker. Glow.render composites additively through
      // pow(1 - exp(-g), 1/2.2), so anything on that layer at full intensity
      // blows to white and takes a 60 px halo with it; at 0.55 the portal reads
      // as its own colour with a rim of light instead of a headlight.
      const ovalMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(0.55),
        transparent: true, opacity: 0.5, side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false,
      });
      const oval = new THREE.Mesh(ovalGeo, ovalMat);
      oval.position.set(0, 3.4, 0);
      oval.layers.enable(GLOW_LAYER);
      g.add(oval);

      const ringMat = new THREE.MeshStandardMaterial({
        color: 0x171a2a, roughness: 0.42, metalness: 0.55,
        emissive: new THREE.Color(color), emissiveIntensity: 0.85,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(0, 3.4, 0);
      ring.castShadow = false;
      g.add(ring);

      const markMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.26, side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false,
      });
      const marker = new THREE.Mesh(markGeo, markMat);
      marker.position.y = 1.32;
      g.add(marker);

      this._ownedMaterials.push(ovalMat, ringMat, markMat);
      this.group.add(g);
      this._triangles += 240;

      const locked = level < (gate?.reqLevel ?? 1);
      const portal = {
        rank,
        gate: gate || null,
        pos: new THREE.Vector3(px, py, pz),
        radius: (outside ? 6.5 : 5.2),
        color,
        locked,
        anomaly: false,
        group: g,
        phase: rnd() * 6.283,
        meshes: { dais, oval, ring, marker },
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

  _applyPortalState(p) {
    const { oval, ring, marker } = p.meshes;
    const base = new THREE.Color(p.locked ? dim(p.color) : p.color);
    oval.material.color.copy(base).multiplyScalar(0.55);
    ring.material.emissive.copy(base);
    ring.material.emissiveIntensity = p.locked ? 0.24 : 0.85;
    marker.material.color.copy(base);
    marker.material.opacity = p.locked ? 0.1 : 0.26;
    oval.material.opacity = p.locked ? 0.18 : 0.44;
  }

  _buildInteractables() {
    for (const it of INTERACTABLES) {
      this.interactables.push({
        id: it.id,
        label: it.label,
        radius: it.radius,
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
        oval.material.color.copy(_c1).multiplyScalar(0.55);
        ring.material.emissive.copy(_c1);
        marker.material.color.copy(_c1);
        ring.material.emissiveIntensity = 0.8 + k * 1.1;
      }

      if (!p.locked) {
        oval.material.opacity = 0.42 + pulse * 0.16;
        marker.material.opacity = 0.17 + pulse * 0.14;
      }
    }

    if (playerPos) this.updateShadowCamera(playerPos, 22);
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
    _snapM.lookAt(_lightDir, _origin, THREE.Object3D.DEFAULT_UP);
    _snapV.copy(target).applyMatrix4(_snapM);
    _snapV.x = Math.round(_snapV.x / texel) * texel;
    _snapV.y = Math.round(_snapV.y / texel) * texel;
    _snapV.applyMatrix4(_snapM.invert());
    key.target.position.copy(_snapV);
    key.position.copy(_snapV).addScaledVector(_lightDir, extent * 3.0);
    key.target.updateMatrixWorld();
    key.updateMatrixWorld();
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
    // away, so the edge of the world is a view rather than a pit.
    const lim = WALK_LIMIT - radius;
    if (pos.x > lim) { pos.x = lim; slide(-1, 0); }
    // WEST IS DIFFERENT. The ground falls 34 m away west of CLIFF_X, and the
    // parapet at line ~630 only spans the walled stretch (|z| < WALL_HALF).
    // North and south of that, -WALK_LIMIT let a player stroll straight off a
    // cliff onto a void floor with no way back up. The lip itself is the world
    // bound now, which is what the comment above always claimed it was.
    const westLim = CLIFF_X + 1 + radius;
    if (pos.x < westLim) { pos.x = westLim; slide(1, 0); }
    if (pos.z > lim) { pos.z = lim; slide(0, -1); }
    if (pos.z < -lim) { pos.z = -lim; slide(0, 1); }
  }

  // ------------------------------------------------------------------ query

  heightAt(x, z) { return this.field ? this.field.height(x, z) : 0; }

  groundNormal(x, z, out) {
    const o = out || { x: 0, y: 1, z: 0 };
    if (!this.field) { o.x = 0; o.y = 1; o.z = 0; return o; }
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
      const d = Math.hypot(pos.x - it.pos.x, pos.z - it.pos.z);
      if (d < it.radius && d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  setPortalState(rank, { locked, anomaly } = {}) {
    const p = this.portals.find((q) => q.rank === rank);
    if (!p) return;
    if (typeof locked === 'boolean') p.locked = locked;
    if (typeof anomaly === 'boolean') p.anomaly = anomaly;
    this._applyPortalState(p);
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
    grid.blockOutside?.((x, z) => !(this.field.slope(x, z) < 0.45 && x > CLIFF_X - 1));
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
      // Per-field triangle cost. Global instancing trades culling for draw
      // calls, so this is the number that has to be watched instead.
      fields: this.fields
        .map((f) => ({ key: f.key, count: f.count, triangles: f.triangles }))
        .sort((a, b) => b.triangles - a.triangles),
      kit: cityKitStats(),
    };
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const _snapM = new THREE.Matrix4();
const _snapV = new THREE.Vector3();
const _lightDir = new THREE.Vector3(58, 74, 40).normalize();
const _origin = new THREE.Vector3();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

function dim(hex) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(0.34);
  return c.getHex();
}

function cylinder(rTop, rBottom, h, seg, hex) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1);
  g.translate(0, h / 2, 0);
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

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

/** Convenience for callers that want the kit ready before build(). */
export async function preloadCity() {
  return loadCityKit();
}

export { KIT_CELL, cityKitLoaded, cityMaterials, disposeCityKit };
