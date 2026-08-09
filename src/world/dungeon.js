import * as THREE from 'three';
import { BIOMES } from '../game/config.js';
import { mulberry32 } from '../core/rng.js';
import { buildBiomeEnvironment } from '../render/env.js';
import { GLOW_LAYER } from '../render/glow.js';
import { ObstacleField } from './obstacles.js';
import { buildNavGrid } from './navgrid.js';
import { generateLayout, LAYOUT_PARAMS } from './dungeonlayout.js';
import {
  cityKitLoaded, dungeonKitLoaded, cityMaterials, pieceBounds,
  pieceGeometryColored,
} from './citykit.js';
import { natureKitLoaded, NatureField } from './naturekit.js';

// The interior gate world — DUNGEON_SPEC.json STEP 3.
//
// Implements the same duck-typed contract World (src/game/world.js) satisfies
// (build / clear / update / resolve / randomSpawn / updateShadowCamera /
// navGrid / obstacleField / radius), so game.js keeps talking to `this.world`
// and never learns which class is mounted. On top of that it carries the
// dungeon extensions the encounter director (STEP 5) consumes: roomAt,
// setDoorSealed, bossSpawn, spawnPointsFor, heightAt, layout, kind,
// encounterDriven.
//
// RENDERING PHILOSOPHY (spec "performance"): bulk architecture is merged
// vertex-coloured procedural geometry — ONE draw each for floors, wall slabs
// and rock fill — because kit pieces at ~1.3k tris per 2 m segment would blow
// the phone budget three hundred segments in. Kit dressing (doorframes,
// columns, torch sconces, props) is STEP 7 and rides the DUNGEON_MODULES
// table below: one KitField (single InstancedMesh) per piece TYPE, placed off
// the layout's decorRnd-generated anchors, procedural-first (every role has a
// bespoke PROC twin in citykit.js) with the kit upgrading it when the GLB is
// loaded. The shell alone is 6 draw calls against the <= 24 budget; dressing
// adds ~8-12 fields, capped by DRESS_LIMITS below.
//
// DETERMINISM IS LOAD-BEARING: context-loss recovery re-runs build(gate, seed)
// (game.js:213) and must reproduce the identical dungeon. The layout is
// deterministic by construction (dungeonlayout.js); everything visual in here
// draws from one forked mulberry32 stream (shellRnd) and nothing reads
// Math.random or Date.now.

// Role -> kit piece key. null = procedural-only. THE single indirection the
// tileset swap rides (spec "tilesets"); STEP 7 built the consumer, STEP 9
// pointed the structural roles at dungeonkit.glb (dungeon_*, KayKit Dungeon
// Remastered — loaded by loadDungeonKit into the same piece index as the
// city kit, so pieceBounds/pieceGeometryColored and the procedural-fallback
// discipline are unchanged). Roles the dungeon pack has no counterpart for
// (the 4 m arched alcove niche, clay pots, the fox statue, the freestanding
// bookcase — whose collision box is authored to the ruin piece) deliberately
// stay on citykit ruin_* pieces: both kits are always preloaded together.
//
// archway is one of them, for a reason worth recording: the dungeon pack's
// dungeon_wall_arched looks like the role on paper but its arch is a RECESSED
// FILLED PANEL, not an opening (verified on the rendered contact sheet, then
// in-game — it walls every doorway shut visually while collision stays open).
// ruin_arch_round is a true pass-through arch, so it keeps the role.
export const DUNGEON_MODULES = {
  wall: null,
  doorFrame: 'dungeon_wall_doorway',   // wall + SHUT wood door — the sealed way in
  archway: 'ruin_arch_round',
  column: 'dungeon_pillar',
  alcove: 'ruin_wall_archround',
  torch: 'dungeon_torch_mounted',
  potA: 'ruin_pot1',
  potB: 'ruin_pot2',
  crate: 'dungeon_box_large',
  barrel: 'dungeon_barrel_large',
  bookcase: 'ruin_bookcase_empty',
  statue: 'ruin_statue_fox',
  candles: 'dungeon_candle_triple',
  stalagmite: null,
};

// Per-rank themed overlays on the base table (spec "tilesets": the optional
// WARREN_MODULES / OSSUARY_MODULES / CAVERN_MODULES seam). Placement code
// reads modulesFor(rank) only, so a future dungeonkit.glb retheme of one rank
// is a table edit here — layout, collision, nav and tests stay untouched.
export const WARREN_MODULES = {};   // E: the plain baseline, deliberately
export const OSSUARY_MODULES = {
  // D leads with the small urn: clutter reads as rows of bone jars, matching
  // the canon "bone-alcove wall dressing (ruin_wall_archround + pots)".
  potA: 'ruin_pot2',
  potB: 'ruin_pot1',
};
// C: the cavern's own dressing (dome, stalagmites, crystals) is built by the
// cavern branch below, not this table — the kit roles it still uses are just
// the two door treatments (arch over the boss neck, the shut arrival door).
export const CAVERN_MODULES = {};
export function modulesFor(rank) {
  if (rank === 'D') return { ...DUNGEON_MODULES, ...OSSUARY_MODULES };
  if (rank === 'C') return { ...DUNGEON_MODULES, ...CAVERN_MODULES };
  return { ...DUNGEON_MODULES, ...WARREN_MODULES };
}

// STEP 7 palette tuning, dressing half: an instanceColor tint multiplied over
// the kit atlas (or the procedural twin's vertex colours). The warren reads
// cold and moonlit, the ossuary bone-warm. The other half — fog near/far and
// the shell's vertex palette — is already per-rank via LAYOUT_PARAMS + BIOMES.
const DRESS_TINT = { E: 0xaab3d8, D: 0xdcc9a8, C: 0xbfe6f5 };  // C: deepglass cold

// Hard per-role caps, applied by deterministic list truncation. Each role is
// +1 draw call (KitField per piece type) and the spec's risk list names
// "draw-call creep from dressing enthusiasm" as the failure mode — the caps
// keep the worst-case D layout inside <= 24 draws / <= 130k tris with the kit
// loaded, sized against performance.triangleBudget's per-role maxima.
const DRESS_LIMITS = {
  archways: 12, columns: 20, torches: 34, clutter: 16, alcoves: 6, shelves: 3,
};

// STEP 9 silhouette targets. The dungeon kit is authored to its 2 m storey
// while the shell's walls run 4 m, so the structural dressing roles stretch
// to fit the architecture instead of reading like dollhouse furniture. The
// scales derive from pieceBounds — static per piece, so determinism holds and
// a table swap (or the procedural twin, authored to the same bounds) lands at
// the same silhouette without touching this code.
const ARCH_HEIGHT = 3.6;      // crown under the 4 m walls, heads clear the arch
const DOOR_HEIGHT = 3.0;      // the sealed arrival door — tall gate, not hobbit
const COLUMN_HEIGHT = 4.0;    // full wall height, as the ruin columns were
const TORCH_TOP_Y = 1.75;     // sconce head just under the flame billboard (1.8)
const TORCH_WALL_GAP = 0.12;  // mount plate proud of the wall face, no z-fight

// Same key-light direction as world.js so updateShadowCamera's texel snapping
// stays a straight copy of the proven implementation.
const _lightDir = new THREE.Vector3(18, 34, 12).normalize();
const _snapM = new THREE.Matrix4();
const _snapV = new THREE.Vector3();

// Scratch for update(dt) — module-level, never allocated per frame (the
// world.js shard-loop rule; per-frame allocation is a shipped-bug class here).
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _zeroQ = new THREE.Quaternion();
const _c = new THREE.Color();

const DUST_COUNT = 48;
const MEMBRANE_HEIGHT = 3.4;      // fits under the 4 m walls, over any head
const EXIT_PORTAL_RISE = 2.0;     // seconds to full height (STEP 5 exit beat)
// STEP 6 entry beats: the arrival portal dims and seals over ~1.5 s (the way
// in shuts behind you — lore, not UI), and the tunnel's vertex colours ramp
// down to this floor multiplier at the sealed end so the walk-in reads as a
// descent out of the dark toward the torchlight.
const ENTRY_SEAL_TIME = 1.5;
const TUNNEL_DARK = 0.35;
// Arrival portal placement on the tunnel's south wall (world z = +1.55, spawn
// at +1.6 per the layout translation) — shared by the build and the seal anim.
const ENTRY_PORTAL_Z = 1.55;
const ENTRY_PORTAL_W = 3.2;
const TORCH_LIGHT_COLOR = 0xff9a4a;
const TORCH_LIGHT_INTENSITY = 2.6;
const TORCH_LIGHT_RANGE = 14;
// Cavern light anchors are bioluminescent crystal clusters, not fire: cooler,
// slightly dimmer, wider throw (STEP 8; spec generation.parameters.C).
const CRYSTAL_LIGHT_INTENSITY = 2.3;
const CRYSTAL_LIGHT_RANGE = 17;

// --- INTERIOR READABILITY (art pass) -------------------------------------
//
// WHY THE SHIPPED 1.4 CRAWL RENDERED BLACK. The BIOMES rows are authored for
// the OUTDOOR arena, where a sky dome and a sun carry the exposure. As indoor
// ALBEDO the same hexes are 1-4% linear reflectance — warren ground 0x1a1f38
// is (0.010, 0.014, 0.040) linear — and no amount of light rescues a surface
// that reflects one percent of it once ACES at exposure 1.25 has had its say.
// That is the "boss invisible against a near-black floor" and "one wall lit,
// the opposite wall pure black" the reviewers photographed.
//
// So the fix is three things at once, and it has to be all three:
//   1. LIFT THE ALBEDO (below): keep each biome's hue, raise the VALUE to what
//      quarried stone actually reflects, ease the saturation so the fill does
//      not read as a coloured wash. Shell geometry only — kit dressing keeps
//      its own atlas.
//   2. FILL FROM EVERY OTHER DIRECTION (hemisphere + interior IBL): the key is
//      a SINGLE directional light and always will be, because light count is
//      part of three's shader-program cache key. One face of every corridor
//      looks at it and the opposite face looks at nothing; a hemisphere is the
//      only free way to put a value on that second face.
//   3. TORCHES FROM BOTH SIDES (_retargetLights): the pooled lights used to
//      take the two nearest anchors, which in a corridor are usually the same
//      wall. They now take the nearest on each side of the camera.
// Deliberately NOT done: more lights (blows the spec's 2-3 pool and forces a
// recompile), and a global exposure lift (that is the city's frame too).
const FLOOR_VALUE = 0.28;    // min HSL lightness for floor stone
const WALL_VALUE = 0.32;     // ... for wall slabs (a shade above the floor)
const ROCK_DARKEN = 0.6;     // rock mass, as a fraction of the wall tone
const WALL_TOP_FALLOFF = 0.5;   // wall vertex colour at the lid vs at the floor
// Hemisphere fill. 0.35 was the spec's first guess, made against the
// unlifted outdoor palette; measured on the boss-chamber and tunnel frames it
// left both at ~0.05 mean luma with half the pixels effectively black.
const HEMI_INTENSITY = 1.4;
// Indirect exposure for the interior PMREM (env.js interior branch). Carries
// the soft floor bounce that keeps a body from reading as a silhouette.
const INTERIOR_ENV_INTENSITY = 1.5;
// Per-kind fill scale. The cavern was never the dark complaint — it is an open
// chamber under a 20 m dome with its own bioluminescent light sources, and it
// measured 2x the crawl's frame luminance BEFORE any of this. Giving it the
// crawl's full fill turns it into an overcast quarry; the crawl is a sealed
// corridor lit by two torches and needs every bit of it.
const FILL_SCALE = { crawl: 1.0, cavern: 0.6 };
// The key stays the only shadow caster and the only directional. It goes UP a
// little, not down: raising the ambient floor without it would flatten the
// contrast that makes the interior moody rather than merely lit.
const KEY_INTENSITY = 1.35;
// The boss chamber's floor gets its own raised pool of paler stone: the fight
// that most needs a readable silhouette and readable telegraphs was the one
// staged on the darkest surface in the game.
const BOSS_FLOOR_VALUE = 0.38;
const BOSS_FLOOR_MIX = 0.34;
// Cavern roof: coarse inverted dome y 16-22 (above the camera's 11 m, so the
// standard rig never meets it) with a hanging stalactite fringe under it.
const DOME_Y = [16, 22];
const DOME_TILE = 4;              // dome lattice pitch, cells (8 m)
const LIGHT_RETARGET_INTERVAL = 0.25;   // 4 Hz reassignment, per spec
const LIGHT_FADE_RATE = 1 / 0.15;       // 0.3 s total: fade out + fade in

export class Dungeon {
  constructor(scene, renderer, camera) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    // Shared collision registry, same stepOver as the arena so enemies step
    // over kerb-height rubble instead of jamming on it.
    this.obstacleField = new ObstacleField({ stepOver: 0.4 });
    this.navGrid = null;
    this.radius = 40;
    this.layout = null;
    this.kind = 'crawl';
    // The one flag game.js checks (STEP 4 seams) to hand spawn control to the
    // encounter director instead of the arena wave timer.
    this.encounterDriven = true;
    // Which room randomSpawn draws points from. The director moves it; until
    // then it is the entry room, which is where game.js's shadow-escort deploy
    // (min 4) lands — never the arena's blind polar fallback.
    this.activeRoomId = 0;
    // Pooled torch lights. 2 by default per spec; a mode may set 1..3 BEFORE
    // build (light COUNT changes force a full shader recompile, so it is a
    // build-time decision, not a frame-time one).
    this.lightBudget = 2;

    this._disposables = [];
    this._kitFields = [];                   // kit dressing meshes (STEP 7)
    this._natureFields = [];                // cavern stalagmite fields (STEP 8)
    this.dressing = null;                   // { kitLoaded, roles } for tests
    this._membraneFieldIndex = new Map();   // doorId -> obstacle record index
    this._membraneInstance = new Map();     // doorId -> membrane instance slot
    this._torchAnchors = [];                // flat [x, z, x, z, ...]
    this._torchLights = [];
    this._lightTimer = 0;
    // What the pooled lights imitate this build: torch fire (crawl) or
    // crystal glow (cavern). Colour/intensity are build-time decisions.
    this._lightIntensity = TORCH_LIGHT_INTENSITY;
    this._dust = null;
    this._dustData = null;
    this._crystals = null;                  // cavern crystal shard instances
    this._crystalBase = null;               // their base colour (pulse target)
    this._exitPortal = null;   // the walk-out return portal (STEP 5)
    this._exitRise = 0;
    // Arrival-portal seal animation (STEP 6): 0..1 progress, colour endpoints
    // baked at build. Purely visual — the wall behind it is a solid run.
    this._entrySeal = 1;
    this._entryFrom = null;
    this._entryTo = null;
    this._t = 0;
  }

  clear() {
    // Kit dressing FIRST, wrapper-only: the dressing meshes' geometry and
    // material are SHARED with citykit's caches (pieceGeometryColored /
    // cityMaterials) and must never be disposed here. InstancedMesh.dispose()
    // frees only the per-instance buffers; detaching before the traversal
    // below keeps its geometry/material disposal away from them — the same
    // rule city.js follows for its fields.
    for (const m of this._kitFields) {
      m.dispose();
      m.removeFromParent();
    }
    this._kitFields.length = 0;
    // Same shared-resource rule for the cavern's nature-kit stalagmite fields:
    // NatureField.dispose() frees only per-instance buffers and detaches, so
    // the traversal below never reaches the kit's shared geometry/materials.
    for (const f of this._natureFields) f.dispose();
    this._natureFields.length = 0;
    this.dressing = null;
    // Copy of world.js clear() — the disposal registry pattern that fixed the
    // twice-shipped GPU leak. Everything Dungeon creates is either reachable
    // from the group traversal or pushed into _disposables.
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      }
    });
    this.group.clear();
    this.obstacleField.clear();
    this.navGrid = null;
    this._disposables.forEach((d) => d.dispose?.());
    this._disposables.length = 0;
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    // The key light's depth map is a render target, not a mesh resource, so
    // the isMesh traversal above never saw it — one leaked depth texture per
    // gate without this.
    this.key?.shadow?.map?.dispose();
    if (this.key?.shadow) this.key.shadow.map = null;
    this.scene.environment = null;
    this.key = null;
    this._membraneFieldIndex.clear();
    this._membraneInstance.clear();
    this._torchAnchors.length = 0;
    this._torchLights.length = 0;
    this._membranes = null;
    this._flames = null;
    this._dust = null;
    this._dustData = null;
    this._crystals = null;
    this._crystalBase = null;
    this._exitPortal = null;
    this._exitRise = 0;
    this._entrySeal = 1;
    this._entryFrom = null;
    this._entryTo = null;
    this.layout = null;
    // Interior-only scene state: the crawl swaps the arena's sky dome for a
    // flat backdrop + fog. Undo both so whatever mounts next starts clean.
    this.scene.background = null;
    this.scene.fog = null;
  }

  /**
   * Full deterministic (re)build — also the context-loss repair path.
   * @param {object} gate config.js GATES row ({ rank, biome, enemies, ... })
   * @param {number} seed per-run gate seed
   * @returns {this}
   */
  build(gate, seed) {
    this.clear();
    const biome = BIOMES[gate.biome] || BIOMES.warren;
    this.biome = biome;
    // Optional per-gate crawl overrides live in the balance file (gate.crawl);
    // absent means LAYOUT_PARAMS defaults, per spec config.js note.
    const baseParams = LAYOUT_PARAMS[gate.rank] || LAYOUT_PARAMS.E;
    const params = gate.crawl ? { ...baseParams, ...gate.crawl } : baseParams;
    const layout = generateLayout({
      rank: gate.rank, seed, params, enemies: gate.enemies,
    });
    this.layout = layout;
    this.kind = layout.kind;
    this.activeRoomId = 0;
    // Contract: bounding radius from the layout bbox + 4, so the projectile
    // disc cull (game.js:1558) and legacy distance math stay safe unedited.
    this.radius = layout.radius + 4;

    // Shell visuals draw from their own forked stream: retuning colours can
    // never reshuffle the layout, and vice versa.
    const shellRnd = mulberry32((seed ^ 0x85ebca6b) >>> 0);

    // --- atmosphere -------------------------------------------------------
    // No sky dome indoors — the biggest arena fill cost deleted outright. The
    // fog far plane is the occlusion strategy; past it there is only this.
    this.scene.background = new THREE.Color(biome.sky);
    this.scene.fog = new THREE.Fog(biome.fog, layout.params.fog.near, layout.params.fog.far);

    // Interior image-based lighting: force the synthesized per-biome map. The
    // open-sky HDRI branch would light an enclosed burrow like a meadow.
    this.envRT = buildBiomeEnvironment(this.renderer, biome, { interior: true });
    this.scene.environment = this.envRT.texture;
    // Interior IBL carries the soft floor bounce (env.js interior branch); it
    // is a uniform, not a light, so raising it costs no shader recompile.
    this.scene.environmentIntensity = INTERIOR_ENV_INTENSITY * (FILL_SCALE[layout.kind] ?? 1);
    this.scene.environmentRotation.set(0, 0.4, 0);

    // --- merged shell geometry -------------------------------------------
    // Tunnel darkness gradient (STEP 6, entryExperience beat 3): south of the
    // entry room the vertex colours ramp down toward TUNNEL_DARK at the sealed
    // way in, with a faint torch-warm cast mid-tunnel that dies at both ends.
    // Pure function of the layout — determinism holds — and it only touches
    // z beyond the entry room's south edge, so the rest of the dungeon's
    // palette is byte-identical to STEP 3's.
    const room0 = layout.rooms[0];
    const tunnelBright = room0.z + room0.d;               // entry room's south edge
    const tunnelSpan = Math.max(1e-6, layout.bounds.maxZ - tunnelBright);
    const warm = new THREE.Color(TORCH_LIGHT_COLOR);
    const entryTint = (c, z) => {
      if (z <= tunnelBright) return c;
      const t = Math.min(1, (z - tunnelBright) / tunnelSpan);
      // 4t(1-t) peaks mid-tunnel and is 0 at both ends — continuous with the
      // untinted room palette on one side and the near-black seal on the other.
      c.lerp(warm, 4 * t * (1 - t) * 0.15);
      return c.multiplyScalar(1 - t * (1 - TUNNEL_DARK));
    };
    // C dais (spec bossChamberAndExit): the grotto's raised dais is a VISUAL
    // read on flat nav — sold here as a lightened stone circle with a darker
    // rim baked into the floor's vertex colours, so heightAt() stays 0 and no
    // body ever clips a real step.
    const isCavern = layout.kind === 'cavern';
    const bossRoom = layout.rooms[layout.bossRoom];
    let daisTint = null;
    if (isCavern) {
      const bossC = bossRoom.centre;
      const daisCol = new THREE.Color(biome.detail);
      daisTint = (c, x, z) => {
        const dd = Math.hypot(x - bossC.x, z - bossC.z);
        if (dd < 3.6) c.lerp(daisCol, 0.32);
        else if (dd < 4.5) c.multiplyScalar(0.78);
      };
    } else {
      // Crawl boss chamber (art pass): a soft pool of paler stone across the
      // fight floor. The reviewers could not find the boss's silhouette — a
      // 2.5x-scale dark body standing on the darkest surface in the game —
      // and a chamber floor a clear step brighter than its corridors is the
      // cheapest read there is for both the body and its floor telegraphs.
      // Vertex colour only, so heightAt() stays flat and nav is untouched.
      const bc = bossRoom.centre;
      const bossFloor = lift(new THREE.Color(biome.ground), BOSS_FLOOR_VALUE, 0.3);
      const bossR = Math.min(bossRoom.w, bossRoom.d) * 0.5;
      daisTint = (c, x, z) => {
        const dd = Math.hypot(x - bc.x, z - bc.z);
        if (dd > bossR) return;
        c.lerp(bossFloor, BOSS_FLOOR_MIX * smoothstep(1, 0.35, dd / bossR));
      };
    }
    this._buildFloor(layout, biome, shellRnd, entryTint, daisTint);
    this._buildWalls(layout, biome, entryTint);
    this._buildRockFill(layout, biome, entryTint);
    this._buildMembranes(layout, biome);
    // Light anchors: torch flames in the crawl, bioluminescent crystal
    // clusters in the cavern — whichever fills _torchAnchors feeds the pool.
    if (layout.decor.torches.length) this._buildTorches(layout, biome);
    if (isCavern) {
      this._buildCrystals(layout, biome, shellRnd);
      this._buildDome(layout, biome, shellRnd);
    }
    this._buildDust(layout, biome, shellRnd);
    // STEP 7 kit dressing + STEP 8 stalagmite field. Both register their own
    // collision circles/boxes, so they must run before obstacleField.build().
    this._buildDressing(layout, gate, seed);
    if (isCavern) this._buildStalagmites(layout, biome);

    // --- collision --------------------------------------------------------
    // Wall runs: one merged box per run, top Infinity — always solid.
    // nav:false is deliberate: navgrid's blockBox pads every blocker by
    // pad + 0.7072*cell (a conservative "cell straddles the edge" bump), so
    // stamping 0.6 m walls into a 1.25 m grid closes a 4 m corridor to a
    // 0.6 m navigable slit — worst phase, zero open columns. The `inside`
    // mask predicate below carries the walls instead, exactly as the spec's
    // collisionNav section intends ("the inside predicate carries the
    // walls"); collision stays authoritative through resolve().
    for (const run of layout.wallRuns) {
      this.obstacleField.addBox(run.x, run.z, run.w, run.d, run.rot, {
        tag: 'wall', nav: false,
      });
    }
    // Membrane boxes: pre-registered per door, top 0 = open (resolve and
    // blocked both skip solids at or below feet + stepOver). setDoorSealed
    // flips them to Infinity via setTop — the record index is count - 1 at
    // add time and stays valid because ObstacleField has no remove API.
    for (const d of layout.doors) {
      this.obstacleField.addBox(d.x, d.z, d.w, d.d, d.rot, {
        top: 0, nav: false, tag: 'membrane',
      });
      this._membraneFieldIndex.set(d.id, this.obstacleField.count - 1);
    }
    this.obstacleField.build();

    // --- navigation -------------------------------------------------------
    // The walkable region IS the floor mask; membranes stay out of the grid
    // (a sealed door must not reroute the flow field — enemies only ever
    // chase a player sealed in their own room, spec collisionNav).
    const bounds = layout.bounds;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + 8;
    this.navGrid = buildNavGrid({
      ...this.obstacleField.toNavBlockers(),
      originX: cx,
      originZ: cz,
      size,
      cell: 1.25,
      pad: 0.5,
      inside: (x, z) => this._floorAt(x, z),
    });

    // --- lighting ---------------------------------------------------------
    // Hemisphere fill — the second of the three readability moves (see the
    // INTERIOR READABILITY block). Sky colour is the biome accent pulled well
    // back in saturation: at full chroma a hemi at this intensity paints every
    // up-facing surface neon and the torches stop being the light source.
    // Ground colour is a floor bounce, which is what lands on undersides and
    // on the lower half of a body — the term that stops characters reading as
    // flat silhouettes in a dark room. Vertical wall faces take roughly half
    // of each, and those faces were the actual defect.
    const fill = FILL_SCALE[layout.kind] ?? 1;
    const hemiSky = lift(new THREE.Color(biome.accent), 0.62, 0.6);
    const hemiGround = lift(new THREE.Color(biome.ground), 0.28, 0.35);
    const hemi = new THREE.HemisphereLight(hemiSky, hemiGround, HEMI_INTENSITY * fill);
    this.group.add(hemi);

    // Key light + shadow stays indoors (spec "performance.lights"): it is the
    // only shadow caster and updateShadowCamera fits it to the player.
    const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
    key.position.set(18, 34, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.bias = 0;
    key.shadow.normalBias = 0.035;
    this.group.add(key);
    this.group.add(key.target);
    this.key = key;

    // Pooled torch lights: no per-torch lights, ever. The pool retargets to
    // the nearest anchors ahead of the camera at 4 Hz with an intensity fade
    // over the handoff. In the cavern the same pool plays crystal glow —
    // biome-accent colour, wider and a touch dimmer than fire.
    const lightColor = isCavern ? biome.accent : TORCH_LIGHT_COLOR;
    const lightRange = isCavern ? CRYSTAL_LIGHT_RANGE : TORCH_LIGHT_RANGE;
    this._lightIntensity = isCavern ? CRYSTAL_LIGHT_INTENSITY : TORCH_LIGHT_INTENSITY;
    const budget = Math.max(1, Math.min(3, this.lightBudget | 0));
    for (let i = 0; i < budget; i++) {
      const light = new THREE.PointLight(lightColor, 0, lightRange, 2);
      light.position.set(0, 2.0, 0);
      this.group.add(light);
      this._torchLights.push({
        light,
        anchor: -1,        // index into _torchAnchors currently lit
        target: -1,        // index the 4 Hz retarget wants next
        fade: 0,           // 0..1 intensity envelope
        phase: i * 2.39,   // decorrelates the flicker between pool lights
      });
    }
    this._lightTimer = 0;

    this._t = 0;
    return this;
  }

  // ------------------------------------------------------------- geometry

  /**
   * The floor: one merged vertex-coloured mesh.
   *
   * COLOUR (art pass). The first cut picked a colour per CELL from two rnd()
   * rolls. On a perfectly regular 2 m grid that is a checkerboard, which is
   * exactly what the C cavern was called — an architectural tiled hall where
   * an organic cave was wanted. The replacement is the language city.js's
   * ground uses:
   *   - low-frequency tone fields over WORLD position (wavelengths ~32 m,
   *     ~12 m and ~5.5 m — the shortest still nearly three cells) blend three
   *     rock tones into patches with no grid to lock onto, each field's noise
   *     domain rotated so the lattice cannot align with the floor;
   *   - every field is sampled at the TRIANGLE CENTROID, not the cell centre.
   *     This is the load-bearing one. Colour computed per cell quantises every
   *     patch boundary to a 2 m rectangle, so the moment the patches have
   *     enough contrast to see, they read as tiles again — the defect wearing
   *     a different hat. Per-face sampling puts the boundaries on triangle
   *     edges instead;
   *   - the split diagonal FLIPS on a hash bit, so the tessellation those
   *     boundaries follow is itself irregular rather than a herringbone;
   *   - and a small per-face luminance jitter on top, for low-poly stone.
   * All of it is integer-hash noise seeded off the shell stream: no rnd()
   * state, no Math.random, identical on a context-loss rebuild.
   */
  _buildFloor(layout, biome, rnd, entryTint, daisTint = null) {
    const { mask, w, h, cell, originX, originZ } = layout;
    const isCavern = layout.kind === 'cavern';
    // Three tones: the lifted floor stone, a greyer/cooler rock drawn from the
    // wall colour, and a damp darker one. Two fields pick between them.
    const ground = lift(new THREE.Color(biome.ground), FLOOR_VALUE);
    const rockTone = lift(new THREE.Color(biome.pillar), FLOOR_VALUE + 0.05, 0.34);
    const dampTone = ground.clone().multiplyScalar(0.48);
    const detail = new THREE.Color(biome.detail);
    // Patch amplitude: the cavern wants big blotchy mineral variation, the
    // worked-stone crawl wants a quieter floor that still is not a grid. The
    // per-triangle jitter stays SMALL on purpose — crank it and the eye starts
    // reading the tessellation again, which is the failure mode this whole
    // rewrite exists to avoid.
    const patchMix = isCavern ? 1.0 : 0.6;
    const detailMix = isCavern ? 0.09 : 0.12;
    const jitAmp = 0.05;
    // One roll off the shell stream seeds every hash below — determinism
    // holds and retuning the floor cannot reshuffle anything upstream.
    const ns = (rnd() * 0xffffffff) >>> 0;
    const cA = new THREE.Color();
    const cB = new THREE.Color();
    const positions = [];
    const colors = [];
    // One triangle's flat colour, from its centroid. Three tone fields at
    // descending wavelengths — ~32 m picks which rock a region is, ~12 m
    // stains it damp, ~5.5 m roughens the boundaries so patches have ragged
    // edges rather than soft blobs — then the biome's accent mineral in the
    // brightest pockets, the shell's own tints, and a small per-face jitter.
    const face = (out, x, z, jx, jz) => {
      out.copy(ground);
      out.lerp(rockTone, smoothstep(0.35, 0.68, fbm2(x * 0.031 + 13, z * 0.031 - 7, ns, 0)) * patchMix);
      out.lerp(dampTone, smoothstep(0.42, 0.78, fbm2(x * 0.085 - 5, z * 0.085 + 21, ns + 77, 1)) * patchMix);
      out.multiplyScalar(0.88 + 0.24 * fbm2(x * 0.18 + 41, z * 0.18 - 17, ns + 209, 2));
      out.lerp(detail, smoothstep(0.72, 0.98, fbm2(x * 0.14 - 31, z * 0.14 + 3, ns + 401, 3)) * detailMix);
      // Tunnel darkness ramp, then the boss-chamber / cavern-dais floor pool.
      entryTint(out, z);
      if (daisTint) daisTint(out, x, z);
      out.multiplyScalar(1 + (hashi(jx, jz, ns) - 0.5) * 2 * jitAmp);
    };
    const rock = (gx, gz) => gx < 0 || gz < 0 || gx >= w || gz >= h || !mask[gx + gz * w];
    // Corner AO: darken a floor corner by how much rock meets it — a cheap
    // baked contact shadow that sells "carved out of the mass" for free.
    const cornerShade = (gx, gz) => {
      let n = 0;
      if (rock(gx - 1, gz - 1)) n++;
      if (rock(gx, gz - 1)) n++;
      if (rock(gx - 1, gz)) n++;
      if (rock(gx, gz)) n++;
      return 1 - n * 0.11;
    };
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (!mask[gx + gz * w]) continue;
        const x0 = originX + gx * cell;
        const z0 = originZ + gz * cell;
        const x1 = x0 + cell;
        const z1 = z0 + cell;
        const s00 = cornerShade(gx, gz);
        const s10 = cornerShade(gx + 1, gz);
        const s01 = cornerShade(gx, gz + 1);
        const s11 = cornerShade(gx + 1, gz + 1);
        // Flip the split diagonal on a hash bit so the triangulation the patch
        // boundaries follow has no repeating direction. Both windings stay CCW
        // seen from above (+Y normal).
        const flip = hashi(gx, gz, ns + 5077) < 0.5;
        if (flip) {
          positions.push(
            x0, 0, z0, x0, 0, z1, x1, 0, z1,
            x0, 0, z0, x1, 0, z1, x1, 0, z0,
          );
        } else {
          positions.push(
            x0, 0, z0, x0, 0, z1, x1, 0, z0,
            x0, 0, z1, x1, 0, z1, x1, 0, z0,
          );
        }
        // Face colour, sampled at each triangle's own centroid.
        face(cA, (2 * x0 + x1) / 3,
          flip ? (z0 + 2 * z1) / 3 : (2 * z0 + z1) / 3, gx * 2, gz * 2 + 911);
        face(cB, (x0 + 2 * x1) / 3,
          flip ? (2 * z0 + z1) / 3 : (z0 + 2 * z1) / 3, gx * 2 + 1, gz * 2 + 911);
        if (flip) {
          pushShaded(colors, cA, s00); pushShaded(colors, cA, s01); pushShaded(colors, cA, s11);
          pushShaded(colors, cB, s00); pushShaded(colors, cB, s11); pushShaded(colors, cB, s10);
        } else {
          pushShaded(colors, cA, s00); pushShaded(colors, cA, s01); pushShaded(colors, cA, s10);
          pushShaded(colors, cB, s01); pushShaded(colors, cB, s11); pushShaded(colors, cB, s10);
        }
      }
    }
    const geo = bufferGeo(positions, colors);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0.04,
      envMapIntensity: 0.6, flatShading: true, dithering: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    // One merged draw covering the whole dungeon: its bound is the dungeon,
    // so frustum culling could only ever cull it when nothing is visible
    // anyway. Forcing it on keeps the draw-call budget measurable.
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._disposables.push(geo, mat);
  }

  _buildWalls(layout, biome, entryTint) {
    const { wallRuns, params } = layout;
    const base = lift(new THREE.Color(biome.pillar), WALL_VALUE);
    // Torchlit low, dark up high — but the old 0.45 put the top half of every
    // wall below the black point once the albedo underneath it was this dark.
    const top = base.clone().multiplyScalar(WALL_TOP_FALLOFF);
    const positions = [];
    const colors = [];
    for (const run of wallRuns) {
      // Fixed-camera heighting (spec "cameraGeometry"): face-'s' runs sit
      // between the +Z camera and the floor they bound, so they render at
      // wallHeightLow and never occlude a 4 m corridor; every other face gets
      // full enclosure height.
      const hgt = run.face === 's' ? params.wallHeightLow : params.wallHeight;
      // Per-VERTEX tint: the tunnel's side walls are single runs spanning its
      // whole length, so a per-run multiplier would flatten the ramp.
      pushBox(positions, colors, run.x, run.z, run.w, run.d, hgt, base, top, entryTint);
    }
    const geo = bufferGeo(positions, colors);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85, metalness: 0.08,
      envMapIntensity: 0.7, flatShading: true, dithering: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._disposables.push(geo, mat);
  }

  // Dark rock mass filling the solid cells around the floor: a lid surface
  // over a 3-cell band, with vertical skirts where the lid height steps. This
  // is what closes the world visually — past it, the fog and the flat sky
  // backdrop read as more rock.
  _buildRockFill(layout, biome, entryTint) {
    const { mask, w, h, cell, originX, originZ, params } = layout;
    const BAND = 3;
    const isFloor = (gx, gz) => gx >= 0 && gz >= 0 && gx < w && gz < h && mask[gx + gz * w];
    // Distance-to-floor (chebyshev, capped at BAND+1) for the fill band and
    // the darkness ramp. One pass over the grid; grids are <= 64x64.
    const dist = new Uint8Array(w * h).fill(BAND + 1);
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (!mask[gx + gz * w]) continue;
        for (let dz = -BAND; dz <= BAND; dz++) {
          for (let dx = -BAND; dx <= BAND; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dz));
            const i = nx + nz * w;
            if (d < dist[i]) dist[i] = d;
          }
        }
      }
    }
    // Lid height per rock cell. Rock in FRONT of floor (floor to its north —
    // between the +Z camera and that floor) stays at the low wall height or
    // it would occlude what the low south walls were lowered to reveal; rock
    // behind/beside floor rises to full height for enclosure.
    const lid = (gx, gz) => {
      for (let k = 1; k <= 3; k++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (isFloor(gx + dx, gz - k)) return params.wallHeightLow;
        }
      }
      return params.wallHeight;
    };
    // Near rock is lifted with the rest of the shell; FAR rock deliberately is
    // not — it fades into biome.sky because that IS the backdrop behind it,
    // and that dissolve is what closes the world off.
    const rockNear = lift(new THREE.Color(biome.pillar), WALL_VALUE, 0.3)
      .multiplyScalar(ROCK_DARKEN);
    const rockFar = new THREE.Color(biome.sky);
    const c0 = new THREE.Color();
    const c1 = new THREE.Color();
    const positions = [];
    const colors = [];
    const shade = (d) => Math.min(1, Math.max(0, (d - 0.6) / BAND));
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        const i = gx + gz * w;
        if (mask[i] || dist[i] > BAND) continue;
        const x0 = originX + gx * cell;
        const z0 = originZ + gz * cell;
        const x1 = x0 + cell;
        const z1 = z0 + cell;
        const y = lid(gx, gz);
        c0.copy(rockNear).lerp(rockFar, shade(dist[i]));
        entryTint(c0, z0 + cell / 2);   // tunnel ramp, per-cell like the floor
        // Lid quad.
        positions.push(
          x0, y, z0, x0, y, z1, x1, y, z1,
          x0, y, z0, x1, y, z1, x1, y, z0,
        );
        for (let k = 0; k < 6; k++) colors.push(c0.r, c0.g, c0.b);
        // Skirts wherever the neighbouring surface is lower: floor cells are
        // faced by the wall slabs already, so only band-internal steps and
        // the outer band edge (drop to 0, dissolving into the backdrop) need
        // closing. Neighbour order: n, s, w, e.
        const sides = [
          [gx, gz - 1, x0, z0, x1, z0],
          [gx, gz + 1, x1, z1, x0, z1],
          [gx - 1, gz, x0, z1, x0, z0],
          [gx + 1, gz, x1, z0, x1, z1],
        ];
        for (const [nx, nz, ax, az, bx, bz] of sides) {
          if (isFloor(nx, nz)) continue;   // wall slab already faces this
          const inBand = nx >= 0 && nz >= 0 && nx < w && nz < h
            && dist[nx + nz * w] <= BAND;
          const ny = inBand ? lid(nx, nz) : 0;
          if (ny >= y) continue;
          const nd = inBand ? dist[nx + nz * w] : BAND;
          c1.copy(rockNear).lerp(rockFar, shade(nd));
          entryTint(c1, (originZ + nz * cell) + cell / 2);
          positions.push(
            ax, y, az, ax, ny, az, bx, ny, bz,
            ax, y, az, bx, ny, bz, bx, y, bz,
          );
          colors.push(c0.r, c0.g, c0.b, c1.r, c1.g, c1.b, c1.r, c1.g, c1.b);
          colors.push(c0.r, c0.g, c0.b, c1.r, c1.g, c1.b, c0.r, c0.g, c0.b);
        }
      }
    }
    const geo = bufferGeo(positions, colors);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1.0, metalness: 0,
      envMapIntensity: 0.35, flatShading: true, dithering: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._disposables.push(geo, mat);
  }

  // One InstancedMesh carries every door membrane plus the entry portal quad
  // on the tunnel's south wall: individual seal/unseal is an instance-matrix
  // toggle, not a draw-call change.
  _buildMembranes(layout, biome) {
    const doors = layout.doors;
    const count = doors.length + 1;   // +1: the arrival portal behind spawn
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.34,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const accent = new THREE.Color(biome.accent);
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      this._membraneInstance.set(d.id, i);
      // Doors start OPEN (collision top 0), so their quads start hidden.
      this._setMembraneMatrix(mesh, i, d, false);
      mesh.setColorAt(i, accent);
    }
    // Arrival portal: the way in, glowing on the wall behind the spawn point.
    // The spawn sits 1.6 m north of the tunnel's south wall plane (world
    // z = +1.6 after translation), portal on that wall, facing north.
    _v.set(0, MEMBRANE_HEIGHT / 2, ENTRY_PORTAL_Z);
    _s.set(ENTRY_PORTAL_W, MEMBRANE_HEIGHT, 1);
    _m4.compose(_v, _zeroQ, _s);
    mesh.setMatrixAt(count - 1, _m4);
    mesh.setColorAt(count - 1, new THREE.Color(biome.accent).multiplyScalar(1.25));
    // STEP 6 entry beat 2: this quad dims and seals over ~1.5 s in update() —
    // bright accent down to a near-black seam on the rock. Progress restarts
    // at every build; a context-loss rebuild replaying the 1.5 s fade is
    // cosmetic and self-heals.
    this._entrySeal = 0;
    this._entryFrom = new THREE.Color(biome.accent).multiplyScalar(1.25);
    this._entryTo = new THREE.Color(biome.pillar).multiplyScalar(0.22);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Membranes and portals are on the sanctioned glow list (environment fire
    // is not; living characters never).
    mesh.layers.enable(GLOW_LAYER);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._membranes = mesh;
    this._disposables.push(geo, mat);
  }

  _setMembraneMatrix(mesh, slot, door, visible) {
    if (!visible) {
      // Zero scale = hidden without touching the draw count or instance order.
      _s.set(0.0001, 0.0001, 0.0001);
      _v.set(door.x, 0, door.z);
      _q.identity();
    } else {
      _v.set(door.x, MEMBRANE_HEIGHT / 2, door.z);
      // rot 0: opening's normal is n/s, span runs along X — the plane's
      // default orientation. rot PI/2: span along Z.
      _q.setFromEuler(_e.set(0, door.rot, 0));
      _s.set(door.w, MEMBRANE_HEIGHT, 1);
    }
    _m4.compose(_v, _q, _s);
    mesh.setMatrixAt(slot, _m4);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // Torch flames: one instanced octahedron per anchor. The kit sconce is
  // STEP 7 dressing; the flame and the light pool are the shell's job because
  // they ARE the interior lighting design.
  _buildTorches(layout, biome) {
    const torches = layout.decor.torches;
    this._torchAnchors.length = 0;
    const geo = new THREE.OctahedronGeometry(1, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffb35c, transparent: true, opacity: 0.92, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, torches.length));
    for (let i = 0; i < torches.length; i++) {
      const t = torches[i];
      // forward(yaw) = (-sin, 0, -cos): out of the wall, into the room.
      const fx = -Math.sin(t.yaw);
      const fz = -Math.cos(t.yaw);
      const x = t.x + fx * 0.45;
      const z = t.z + fz * 0.45;
      _v.set(x, 1.8, z);
      _q.identity();
      _s.set(0.13, 0.26, 0.13);
      _m4.compose(_v, _q, _s);
      mesh.setMatrixAt(i, _m4);
      this._torchAnchors.push(x, z);
    }
    if (!torches.length) mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    // NOT on GLOW_LAYER: the glow list is portals/skills/telegraphs/shadow
    // army only — environment fire does not qualify (spec "lights").
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._flames = mesh;
    this._disposables.push(geo, mat);
  }

  _buildDust(layout, biome, rnd) {
    const geo = new THREE.OctahedronGeometry(1, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(biome.accent).lerp(new THREE.Color(0xbbbbbb), 0.6),
      transparent: true, opacity: 0.28, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, DUST_COUNT);
    const { mask, w, h, cell, originX, originZ } = layout;
    // Deterministic rejection sample onto floor cells so the motes hang where
    // the player actually goes.
    this._dustData = [];
    for (let i = 0; i < DUST_COUNT; i++) {
      let gx = 0;
      let gz = 0;
      let found = false;
      for (let tries = 0; tries < 40 && !found; tries++) {
        gx = Math.floor(rnd() * w);
        gz = Math.floor(rnd() * h);
        found = !!mask[gx + gz * w];
      }
      this._dustData.push({
        x: originX + (gx + 0.5) * cell + (rnd() - 0.5) * cell,
        y: 0.5 + rnd() * 2.2,
        z: originZ + (gz + 0.5) * cell + (rnd() - 0.5) * cell,
        phase: rnd() * Math.PI * 2,
        speed: 0.15 + rnd() * 0.4,
        drift: 0.3 + rnd() * 0.5,
        scale: 0.02 + rnd() * 0.03,
      });
    }
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._dust = mesh;
    this._disposables.push(geo, mat);
  }

  // -------------------------------------------------------------- cavern
  //
  // STEP 8 extras: the C-rank chamber's roof read (inverted dome +
  // stalactite fringe), bioluminescent crystal clusters (the light-pool
  // anchors — torchSpacing is n/a for C), and the stalagmite cover field.

  /**
   * Crystal shard clusters at the layout's decor.crystals anchors: three
   * instanced octahedra per cluster on one MeshBasicMaterial (self-lit read
   * WITHOUT the glow layer — environment light sources are not portals), with
   * per-instance shade variation. Cluster centres feed _torchAnchors, so the
   * pooled lights hover over glowing crystal instead of torch fire.
   */
  _buildCrystals(layout, biome, rnd) {
    const list = layout.decor.crystals;
    const geo = new THREE.OctahedronGeometry(1, 0);
    const accent = new THREE.Color(biome.accent);
    const mat = new THREE.MeshBasicMaterial({ color: accent.clone() });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length * 3));
    let slot = 0;
    for (const c of list) {
      // forward(yaw) = (-sin, -cos): out of the wall, into the chamber; the
      // perpendicular spreads the two minor shards along the wall.
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      const rx = Math.cos(c.yaw);
      const rz = -Math.sin(c.yaw);
      const bx = c.x + fx * 0.45;
      const bz = c.z + fz * 0.45;
      this._torchAnchors.push(bx, bz);
      for (let k = 0; k < 3; k++) {
        const side = k === 0 ? 0 : (k === 1 ? -1 : 1);
        const hgt = k === 0 ? 0.75 + rnd() * 0.5 : 0.3 + rnd() * 0.25;
        _v.set(bx + rx * side * 0.4, hgt * 0.55, bz + rz * side * 0.4);
        _e.set((rnd() - 0.5) * 0.5, c.yaw + rnd() * Math.PI, (rnd() - 0.5) * 0.5);
        _q.setFromEuler(_e);
        _s.set(hgt * 0.28, hgt, hgt * 0.28);
        _m4.compose(_v, _q, _s);
        mesh.setMatrixAt(slot, _m4);
        _c.setScalar(0.75 + rnd() * 0.55);   // shade variation via instanceColor
        mesh.setColorAt(slot, _c);
        slot++;
      }
    }
    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = 'cavern_crystals';
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._crystals = mesh;
    this._crystalBase = accent;
    this._disposables.push(geo, mat);
  }

  /**
   * The cavern is the one interior with a visible roof read: a coarse
   * inverted heightfield of dark unlit triangles at y 16-22 over the floor's
   * band, plus a hanging stalactite fringe instanced beneath it. Both sit
   * above the camera's 11 m, so only up-shots (the intro's low camera, orbit
   * pitch) ever meet them — which is exactly when a cave needs a ceiling.
   */
  _buildDome(layout, biome, rnd) {
    const { mask, w, h, cell, originX, originZ } = layout;
    const T = DOME_TILE;
    const nx = Math.ceil(w / T);
    const nzT = Math.ceil(h / T);
    // Corner lattice first, ALL corners rolled in fixed order — coverage
    // culling below must never shift the stream.
    const hgt = new Float32Array((nx + 1) * (nzT + 1));
    const shade = new Float32Array((nx + 1) * (nzT + 1));
    for (let j = 0; j <= nzT; j++) {
      for (let i = 0; i <= nx; i++) {
        hgt[i + j * (nx + 1)] = DOME_Y[0] + rnd() * (DOME_Y[1] - DOME_Y[0]);
        shade[i + j * (nx + 1)] = 0.85 + rnd() * 0.3;
      }
    }
    const isFloor = (gx, gz) => gx >= 0 && gz >= 0 && gx < w && gz < h && mask[gx + gz * w] === 1;
    const covered = (i, j) => {
      for (let gz = j * T - 3; gz < (j + 1) * T + 3; gz++) {
        for (let gx = i * T - 3; gx < (i + 1) * T + 3; gx++) {
          if (isFloor(gx, gz)) return true;
        }
      }
      return false;
    };
    const near = new THREE.Color(biome.pillar).multiplyScalar(0.34);
    const far = new THREE.Color(biome.sky).multiplyScalar(0.9);
    const c0 = new THREE.Color();
    const positions = [];
    const colors = [];
    const corner = (i, j) => {
      const y = hgt[i + j * (nx + 1)];
      positions.push(originX + i * T * cell, y, originZ + j * T * cell);
      const t = (y - DOME_Y[0]) / (DOME_Y[1] - DOME_Y[0]);
      c0.copy(near).lerp(far, t).multiplyScalar(shade[i + j * (nx + 1)]);
      colors.push(c0.r, c0.g, c0.b);
    };
    for (let j = 0; j < nzT; j++) {
      for (let i = 0; i < nx; i++) {
        if (!covered(i, j)) continue;
        corner(i, j); corner(i, j + 1); corner(i + 1, j + 1);
        corner(i, j); corner(i + 1, j + 1); corner(i + 1, j);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    // Unlit and double-sided: the roof is a dark fog-fading backdrop, not a
    // lit surface — and it must never cast the whole cavern into key-light
    // shadow, so it stays out of the shadow pass entirely.
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'cavern_dome';
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._disposables.push(geo, mat);

    // Stalactite fringe: one InstancedMesh of down-pointing cones whose
    // attach point is the instance origin (geometry spans y -1..0).
    const coneGeo = new THREE.ConeGeometry(1, 1, 5);
    coneGeo.rotateX(Math.PI);
    coneGeo.translate(0, -0.5, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(biome.pillar).multiplyScalar(0.4),
    });
    const drops = [];
    for (let gz = 1; gz < h - 1; gz += 3) {
      for (let gx = 1; gx < w - 1; gx += 3) {
        // Fixed six rolls per lattice point, stream-stable like the layout's
        // own Poisson fields.
        const keep = rnd() < 0.5;
        const jx = rnd() * 3;
        const jz = rnd() * 3;
        const r = 0.22 + rnd() * 0.34;
        const len = 1.1 + rnd() * 2.1;
        const y = 14.8 + rnd() * 4;
        if (!keep) continue;
        const cgx = Math.floor(gx + jx);
        const cgz = Math.floor(gz + jz);
        if (!isFloor(cgx, cgz)) continue;
        drops.push({
          x: originX + (cgx + 0.5) * cell,
          z: originZ + (cgz + 0.5) * cell,
          r,
          len,
          y,
        });
      }
    }
    const cones = new THREE.InstancedMesh(coneGeo, coneMat, Math.max(1, drops.length));
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      _v.set(d.x, d.y, d.z);
      _q.identity();
      _s.set(d.r, d.len, d.r);
      _m4.compose(_v, _q, _s);
      cones.setMatrixAt(i, _m4);
    }
    cones.count = drops.length;
    cones.instanceMatrix.needsUpdate = true;
    cones.name = 'cavern_stalactites';
    cones.frustumCulled = false;
    this.group.add(cones);
    this._disposables.push(coneGeo, coneMat);
  }

  /**
   * The stalagmite cover field, from the layout's decor.stalagmites records
   * (positions, kinds and sizes are ALL layout data — this method only
   * materialises and registers them, so a context-loss rebuild reproduces the
   * exact field). Collision per spec cavernVariant: tall spires are full
   * cover with honest tops (they block bodies, bolts AND the flow field);
   * rubble is step-over at 0.4 like the crawl's pots, nav-transparent.
   *
   * Rendering: nature.glb rock pieces (rock_1 stretched tall for spires,
   * rock_6 for rubble) via NatureField when the kit is loaded — one draw per
   * piece kind — degrading to instanced vertex-tinted cones/boulders when it
   * is not. Offline-with-no-assets stays a shipping configuration.
   */
  _buildStalagmites(layout, biome) {
    const list = layout.decor.stalagmites;
    if (!list || !list.length) return;
    const field = this.obstacleField;
    const spires = [];
    const rubble = [];
    for (const s of list) {
      if (s.kind === 'spire') {
        field.addCircle(s.x, s.z, Math.max(0.3, s.r * 0.85), { top: s.h * 0.9, tag: 'stalagmite' });
        spires.push(s);
      } else {
        field.addCircle(s.x, s.z, s.r * 0.8, { top: 0.4, nav: false, tag: 'stalagmite' });
        rubble.push(s);
      }
    }
    if (natureKitLoaded()) {
      // rock_1: 0.49 x 0.88 x 0.47 m — scaled tall it reads as a cave tooth.
      const fs = new NatureField('rock_1', Math.max(1, spires.length), {
        castShadow: true, name: 'stalagmite_spire',
      });
      for (const s of spires) fs.place(s.x, -0.06, s.z, s.yaw, s.r / 0.24, s.h / 0.83);
      fs.finalize().addTo(this.group);
      this._natureFields.push(fs);
      // rock_6: 0.91 x 0.71 x 1.14 m — squat scatter boulders as-is.
      const fr = new NatureField('rock_6', Math.max(1, rubble.length), {
        castShadow: false, name: 'stalagmite_rubble',
      });
      for (const s of rubble) fr.place(s.x, -0.06, s.z, s.yaw, s.r / 0.5, s.h / 0.71);
      fr.finalize().addTo(this.group);
      this._natureFields.push(fr);
    } else {
      const rockCol = new THREE.Color(biome.pillar).lerp(new THREE.Color(biome.detail), 0.22);
      const place = (geo, items, name, castShadow) => {
        const mat = new THREE.MeshStandardMaterial({
          color: rockCol.clone(), flatShading: true, roughness: 0.9, metalness: 0.05,
        });
        const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
        for (let i = 0; i < items.length; i++) {
          const s = items[i];
          _v.set(s.x, 0, s.z);
          _q.setFromEuler(_e.set(0, s.yaw, 0));
          _s.set(s.r, s.h, s.r);
          _m4.compose(_v, _q, _s);
          mesh.setMatrixAt(i, _m4);
          _c.setScalar(0.82 + (i % 5) * 0.07);   // index-derived: no rnd needed
          mesh.setColorAt(i, _c);
        }
        mesh.count = items.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.name = name;
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this._disposables.push(geo, mat);
      };
      const spireGeo = new THREE.ConeGeometry(1, 1, 6);
      spireGeo.translate(0, 0.5, 0);
      const rubbleGeo = new THREE.DodecahedronGeometry(1, 0);
      rubbleGeo.scale(1, 0.72, 1);
      rubbleGeo.translate(0, 0.42, 0);
      place(spireGeo, spires, 'stalagmite_spire', true);
      place(rubbleGeo, rubble, 'stalagmite_rubble', false);
    }
    if (this.dressing) {
      this.dressing.stalagmites = {
        spires: spires.length,
        rubble: rubble.length,
        natureKit: natureKitLoaded(),
      };
    }
  }

  // ------------------------------------------------------------- dressing

  /**
   * STEP 7 — kit dressing over the procedural shell. One KitField per
   * DUNGEON_MODULES role that has placements (each is exactly one draw call;
   * the empty ones cost nothing). Anchors come from the layout's decorRnd
   * stream (frozen at STEP 1); everything extra this pass invents (pot picks,
   * column yaws, ossuary flanking) draws from its own seed fork, so retuning
   * dressing can never reshuffle rooms, packs, or the shell — and a context
   * loss rebuild reproduces the identical furniture.
   *
   * Collision follows spec collisionNav: columns/statues solid circles,
   * pots/crates step-over at top 0.4, barrels honest low cover — all
   * nav:false. The flow field's job is rooms and corridors; a 0.3 m circle is
   * trivially slid around by resolve(), while navgrid's pad (+~1.4 m) around
   * a door-flanking column would choke a 4 m door to under two open cells.
   */
  _buildDressing(layout, gate, seed) {
    const mods = modulesFor(gate.rank);
    const rnd = mulberry32((seed ^ 0x27d4eb2f) >>> 0);
    const placements = new Map();   // role -> [{x,y,z,yaw,sx,sy,sz}]
    const put = (role, x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1) => {
      if (!mods[role]) return;      // null role = procedural shell carries it
      let list = placements.get(role);
      if (!list) { list = []; placements.set(role, list); }
      list.push({ x, y, z, yaw, sx, sy, sz });
    };
    const field = this.obstacleField;

    // Archways over every door. The piece is narrower than the 4 m opening,
    // so it is stretched to fit — the span sets sx (legs land just inside the
    // jambs), ARCH_HEIGHT sets sy off the piece bounds (≈1 for the 3.53 m
    // ruin arch; a future shorter kit piece stretches instead of letting
    // heads clip its crown mid-door). No collision: the legs sit against the
    // wall-run ends that already carry the boxes.
    const archB = pieceBounds(mods.archway);
    const archW = archB?.size.x || 2.0;
    const archSy = ARCH_HEIGHT / (archB?.size.y || 2.0);
    for (const d of layout.doors.slice(0, DRESS_LIMITS.archways)) {
      put('archway', d.x, 0, d.z, d.rot, d.w / archW, archSy, 1);
    }

    // The arrival frame: a shut stone-and-timber door on the tunnel's south
    // wall, exactly where the entry membrane seals (STEP 6). The way in reads
    // as a door that closed behind you, not a wall that ate a portal.
    const dfB = pieceBounds(mods.doorFrame);
    const dfW = dfB?.size.x || 2.0;
    put('doorFrame', 0, 0, ENTRY_PORTAL_Z, 0,
      ENTRY_PORTAL_W / dfW, DOOR_HEIGHT / (dfB?.size.y || 2.0), 1);

    // Columns: room corners + every 3rd door flank (layout anchors), drawn up
    // to full wall height. Quarter yaws only — the variety is in the atlas
    // seams, and the collision circle assumes near-symmetry.
    const colSy = COLUMN_HEIGHT / (pieceBounds(mods.column)?.size.y || 2.0);
    for (const c of layout.decor.columns.slice(0, DRESS_LIMITS.columns)) {
      put('column', c.x, 0, c.z, Math.floor(rnd() * 4) * (Math.PI / 2), 1, colSy, 1);
      field.addCircle(c.x, c.z, 0.34, { nav: false, tag: 'column' });
    }

    // Torch sconces under the shell's flame billboards (flame at wall +0.45,
    // y 1.8): the sconce head tops out just beneath the flame. The mounted
    // piece is authored plate-at-origin extending local +Z, and forward(yaw)
    // is local -Z — so the piece takes yaw + PI to face the room, and the
    // anchor hugs the wall instead of floating the old centred sconce's 0.32.
    const torchB = pieceBounds(mods.torch);
    const torchY = TORCH_TOP_Y - (torchB?.max.y ?? 0.9);
    for (const t of layout.decor.torches.slice(0, DRESS_LIMITS.torches)) {
      const fx = -Math.sin(t.yaw);
      const fz = -Math.cos(t.yaw);
      put('torch', t.x + fx * TORCH_WALL_GAP, torchY, t.z + fz * TORCH_WALL_GAP,
        t.yaw + Math.PI);
    }

    // Clutter clusters + the treasure shrine, both from layout prop anchors.
    let clutter = 0;
    for (const p of layout.decor.props) {
      if (p.kind === 'statue') {
        this._placeShrine(layout, p, put, field);
        continue;
      }
      if (p.kind === 'candles') {
        put('candles', p.x, 0, p.z, p.yaw);
        continue;
      }
      if (clutter >= DRESS_LIMITS.clutter) continue;
      clutter++;
      if (p.kind === 'crate') {
        put('crate', p.x, 0, p.z, p.yaw);
        // Spec collisionNav: pots/crates are step-over rubble (top 0.4 = the
        // field's stepOver, so bodies walk over and bolts fly over).
        field.addCircle(p.x, p.z, 0.4, { top: 0.4, nav: false, tag: 'prop' });
      } else if (p.kind === 'barrel') {
        put('barrel', p.x, 0, p.z, p.yaw);
        // Honest top: barrels are hip-height cover — bodies bump, bolts at
        // flight height (1.2 + stepOver) still clear it.
        field.addCircle(p.x, p.z, 0.4, { top: 1.05, nav: false, tag: 'prop' });
      } else {
        put(rnd() < 0.5 ? 'potA' : 'potB', p.x, 0, p.z, p.yaw);
        field.addCircle(p.x, p.z, 0.3, { top: 0.4, nav: false, tag: 'prop' });
      }
    }

    // Alcoves (D+, layout gates them): the arched wall niche recessed into
    // long room walls — the ossuary's bone-alcove read, flanked per canon
    // with pots and, on alternating alcoves, an empty rack.
    let shelves = 0;
    const alcs = layout.decor.alcoves.slice(0, DRESS_LIMITS.alcoves);
    for (let i = 0; i < alcs.length; i++) {
      const a = alcs[i];
      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      const rx = Math.cos(a.yaw);     // local +X after rotation.y = yaw
      const rz = -Math.sin(a.yaw);
      // Anchor sits on the room boundary; the wall box is 0.6 m thick centred
      // on it, so 0.34 m of forward nudge parks the niche face just proud of
      // the wall's inner face.
      put('alcove', a.x + fx * 0.34, 0, a.z + fz * 0.34, a.yaw);
      const potSide = (s) => {
        const px = a.x + rx * s * 2.5 + fx * 0.62;
        const pz = a.z + rz * s * 2.5 + fz * 0.62;
        put(rnd() < 0.5 ? 'potA' : 'potB', px, 0, pz, rnd() * Math.PI * 2);
        field.addCircle(px, pz, 0.3, { top: 0.4, nav: false, tag: 'prop' });
      };
      potSide(-1);
      if (i % 2 === 0 && shelves < DRESS_LIMITS.shelves) {
        shelves++;
        const bx = a.x + rx * 3.1 + fx * 0.68;
        const bz = a.z + rz * 3.1 + fz * 0.68;
        put('bookcase', bx, 0, bz, a.yaw);
        // Axis-aligned by construction (alcove yaws are cardinal): span along
        // the wall, honest top so bodies bump and bolts clear.
        const alongX = Math.abs(rx) > 0.5;
        field.addBox(bx, bz, alongX ? 2.1 : 0.72, alongX ? 0.72 : 2.1, 0,
          { top: 2.63, nav: false, tag: 'prop' });
      } else {
        potSide(1);
      }
    }

    // Materialise: exactly ONE InstancedMesh per placed role. The geometry is
    // pieceGeometryColored — the whole kit piece merged to a vertex-coloured
    // single draw (KitField's per-material meshes tripled the count: the ruin
    // pieces average ~2.4 solid-colour materials each) — on the shared
    // flat-shaded vertex-colour material, tinted per rank via instanceColor.
    // Always drawn (frustumCulled false — spec performance.culling: fog is
    // the occlusion strategy, and a culled field would make the draw-call
    // budget assert lie about what a player's camera sees).
    const tint = _c.set(DRESS_TINT[gate.rank] ?? DRESS_TINT.E);
    const mat = cityMaterials().shell;
    const roles = {};
    let tris = 0;
    for (const [role, list] of placements) {
      const geo = pieceGeometryColored(mods[role]);
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.name = `dress_${role}`;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        _v.set(p.x, p.y, p.z);
        _q.setFromEuler(_e.set(0, p.yaw, 0));
        _s.set(p.sx, p.sy, p.sz);
        _m4.compose(_v, _q, _s);
        mesh.setMatrixAt(i, _m4);
        mesh.setColorAt(i, tint);
      }
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this._kitFields.push(mesh);
      roles[role] = list.length;
      const n = geo.index ? geo.index.count : geo.attributes.position.count;
      tris += Math.floor(n / 3) * list.length;
    }
    this.dressing = {
      // STEP 9: the roles span both kits (dungeon_* structure, ruin_* pieces
      // the dungeon pack has no counterpart for), so "kit-dressed" means both
      // GLBs decoded. False = at least one role is on its procedural twin,
      // which is what phase F of tools/dungeon-test.mjs asserts.
      kitLoaded: cityKitLoaded() && dungeonKitLoaded(),
      roles,
      fields: this._kitFields.length,
      drawCalls: this._kitFields.length,
      triangles: tris,
    };
  }

  /**
   * The treasure shrine. The layout anchors the statue on the room centre,
   * but encounters.js raises the weapon chest at that exact point — so the
   * statue steps back toward the rear wall (away from the room's first door,
   * the same axis bossSpawn pushes along) and faces the doorway, watching
   * whoever comes for the offering. Candle anchors stay where the layout put
   * them, flanking the chest.
   */
  _placeShrine(layout, anchor, put, field) {
    const roomId = this.roomAt(anchor.x, anchor.z);
    const r = layout.rooms[roomId >= 0 ? roomId : 0];
    const door = r.doors.length ? layout.doors[r.doors[0]] : null;
    let dx = 0;
    let dz = -1;
    if (door) {
      dx = r.centre.x - door.x;
      dz = r.centre.z - door.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
    }
    const sx = Math.min(r.x + r.w - 1.3, Math.max(r.x + 1.3, anchor.x + dx * 1.8));
    const sz = Math.min(r.z + r.d - 1.3, Math.max(r.z + 1.3, anchor.z + dz * 1.8));
    // forward(yaw) = (-sin, -cos) pointed back along the push, at the door.
    put('statue', sx, 0, sz, Math.atan2(dx, dz));
    field.addCircle(sx, sz, 0.7, { nav: false, tag: 'statue' });
  }

  // ------------------------------------------------------------ per-frame

  /** Atmosphere only — membrane pulse, torch pool, dust. Runs behind pause. */
  update(dt) {
    this._t += dt;

    if (this._membranes) {
      this._membranes.material.opacity = 0.3 + Math.sin(this._t * 1.7) * 0.07;
      // Arrival-portal seal (STEP 6): the way in dims and squeezes down to a
      // faint dark seam over ENTRY_SEAL_TIME. Instance-slot mutation only —
      // no draw-call change, no allocation, and it stops touching the buffers
      // once sealed.
      if (this._entrySeal < 1 && this._entryFrom) {
        this._entrySeal = Math.min(1, this._entrySeal + dt / ENTRY_SEAL_TIME);
        const k = this._entrySeal * this._entrySeal;   // ease-in: lingers, then shuts
        const slot = this._membranes.count - 1;
        _c.copy(this._entryFrom).lerp(this._entryTo, k);
        this._membranes.setColorAt(slot, _c);
        if (this._membranes.instanceColor) this._membranes.instanceColor.needsUpdate = true;
        const hh = MEMBRANE_HEIGHT * (1 - k * 0.9);
        _v.set(0, hh / 2 + 0.04, ENTRY_PORTAL_Z);
        _s.set(ENTRY_PORTAL_W, hh, 1);
        _m4.compose(_v, _zeroQ, _s);
        this._membranes.setMatrixAt(slot, _m4);
        this._membranes.instanceMatrix.needsUpdate = true;
      }
    }
    if (this._flames) {
      this._flames.material.opacity = 0.84 + Math.sin(this._t * 9.1) * Math.sin(this._t * 5.3) * 0.1;
    }
    if (this._crystals && this._crystalBase) {
      // Slow bioluminescent breathing — a material-colour mutate on scratch,
      // nothing allocated, nothing on the glow layer (environment light
      // sources are not portals; spec performance.lights).
      const k = 0.86 + 0.14 * Math.sin(this._t * 1.4);
      this._crystals.material.color.copy(this._crystalBase).multiplyScalar(k);
    }

    // Torch light pool: retarget at 4 Hz to the anchors nearest the camera's
    // ground focus (the camera rides 11 m behind the player, so cam - 9 on Z
    // is "around and slightly ahead of" them without needing a player ref).
    if (this._torchLights.length && this._torchAnchors.length) {
      this._lightTimer -= dt;
      if (this._lightTimer <= 0) {
        this._lightTimer = LIGHT_RETARGET_INTERVAL;
        this._retargetLights();
      }
      for (const slot of this._torchLights) {
        if (slot.target !== slot.anchor) {
          // Handoff: fade down in place, jump while dark, fade back up.
          slot.fade -= dt * LIGHT_FADE_RATE;
          if (slot.fade <= 0) {
            slot.fade = 0;
            slot.anchor = slot.target;
            if (slot.anchor >= 0) {
              slot.light.position.set(
                this._torchAnchors[slot.anchor * 2], 2.1,
                this._torchAnchors[slot.anchor * 2 + 1],
              );
            }
          }
        } else if (slot.fade < 1) {
          slot.fade = Math.min(1, slot.fade + dt * LIGHT_FADE_RATE);
        }
        const flicker = 0.82 + 0.18 * Math.sin(this._t * 11 + slot.phase) * Math.sin(this._t * 5.7 + slot.phase * 2);
        slot.light.intensity = slot.anchor >= 0
          ? this._lightIntensity * slot.fade * flicker
          : 0;
      }
    }

    // Exit portal: grow in over the rise time, then idle — ring spin + disc
    // pulse. Mutates existing transforms/material fields only; no allocation.
    if (this._exitPortal) {
      if (this._exitRise < 1) {
        this._exitRise = Math.min(1, this._exitRise + dt / EXIT_PORTAL_RISE);
        const k = 1 - (1 - this._exitRise) ** 3;   // ease-out: fast start, soft landing
        this._exitPortal.scale.setScalar(Math.max(0.001, k));
      }
      const ring = this._exitPortal.children[0];
      const disc = this._exitPortal.children[1];
      if (ring) ring.rotation.z += dt * 0.6;
      if (disc) disc.material.opacity = 0.36 + Math.sin(this._t * 2.3) * 0.1;
    }

    if (this._dust && this._dustData) {
      for (let i = 0; i < this._dustData.length; i++) {
        const d = this._dustData[i];
        _v.set(
          d.x + Math.sin(this._t * d.speed + d.phase) * d.drift,
          d.y + Math.sin(this._t * d.speed * 0.7 + d.phase * 2) * 0.35,
          d.z + Math.cos(this._t * d.speed * 0.8 + d.phase) * d.drift,
        );
        _e.set(this._t * 0.4, this._t * 0.3 + d.phase, 0);
        _q.setFromEuler(_e);
        _s.setScalar(d.scale);
        _m4.compose(_v, _q, _s);
        this._dust.setMatrixAt(i, _m4);
      }
      this._dust.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Reassign the pooled lights, 4 Hz.
   *
   * TWO-SIDED (art pass). Taking simply the N nearest anchors is what produced
   * the reviewers' corridor frame: torch anchors alternate along the two
   * parallel walls, the two nearest are usually on the SAME wall, and the
   * opposite wall got nothing but the hemisphere. So the pool now claims the
   * nearest anchor on each side of the camera's own right vector — one lamp
   * per wall — and any third slot takes the nearest unclaimed anchor. Same
   * light count, same 4 Hz, same crossfade; only which anchors win changes.
   */
  _retargetLights() {
    const cam = this.camera;
    const n = this._torchAnchors.length / 2;
    const lights = this._torchLights;
    const np = lights.length;
    // Camera basis on the ground plane, straight off its world matrix: column
    // 0 is right, column 2 is backward. The old code assumed the camera always
    // looked down -Z, which stopped being true when the orbit camera shipped.
    const e = cam.matrixWorld.elements;
    let fx = -e[8];
    let fz = -e[10];
    const flen = Math.hypot(fx, fz) || 1;
    fx /= flen; fz /= flen;
    const rx = e[0];
    const rz = e[2];
    // The camera rides ~11 m behind the player, so this lands around and
    // slightly ahead of them without needing a player reference.
    _focus.set(cam.position.x + fx * 9, 0, cam.position.z + fz * 9);

    let leftI = -1; let leftD = Infinity;
    let rightI = -1; let rightD = Infinity;
    let nearI = -1; let nearD = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = this._torchAnchors[i * 2] - _focus.x;
      const dz = this._torchAnchors[i * 2 + 1] - _focus.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearD) { nearD = d2; nearI = i; }
      if (dx * rx + dz * rz < 0) {
        if (d2 < leftD) { leftD = d2; leftI = i; }
      } else if (d2 < rightD) { rightD = d2; rightI = i; }
    }
    for (let li = 0; li < np; li++) _bestIdx[li] = -1;
    if (np === 1) {
      _bestIdx[0] = nearI;                       // one lamp: just the nearest
    } else {
      _bestIdx[0] = leftI >= 0 ? leftI : nearI;
      if (rightI >= 0 && rightI !== _bestIdx[0]) _bestIdx[1] = rightI;
    }
    // Any slot the side pass could not fill (a corridor with anchors on one
    // side only, or a 3-light pool) takes the nearest unclaimed anchor.
    for (let li = 0; li < np; li++) {
      if (_bestIdx[li] >= 0) continue;
      let pick = -1;
      let pd = Infinity;
      for (let i = 0; i < n; i++) {
        let taken = false;
        for (let k = 0; k < np; k++) if (_bestIdx[k] === i) { taken = true; break; }
        if (taken) continue;
        const dx = this._torchAnchors[i * 2] - _focus.x;
        const dz = this._torchAnchors[i * 2 + 1] - _focus.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < pd) { pd = d2; pick = i; }
      }
      _bestIdx[li] = pick;
    }
    // Keep lights that already sit on a chosen anchor; hand the rest the
    // leftovers so at most the changed ones crossfade.
    for (let li = 0; li < lights.length; li++) {
      const slot = lights[li];
      slot._keep = false;
      for (let k = 0; k < lights.length; k++) {
        if (slot.anchor >= 0 && _bestIdx[k] === slot.anchor) {
          _bestIdx[k] = -2;   // claimed
          slot._keep = true;
          slot.target = slot.anchor;
          break;
        }
      }
    }
    for (let li = 0; li < lights.length; li++) {
      const slot = lights[li];
      if (slot._keep) continue;
      for (let k = 0; k < lights.length; k++) {
        if (_bestIdx[k] >= 0) {
          slot.target = _bestIdx[k];
          _bestIdx[k] = -2;
          break;
        }
      }
      if (slot.anchor < 0 && slot.target >= 0) {
        // First assignment: place immediately, fade in from dark.
        slot.anchor = slot.target;
        slot.fade = 0;
        slot.light.position.set(
          this._torchAnchors[slot.anchor * 2], 2.1,
          this._torchAnchors[slot.anchor * 2 + 1],
        );
      }
    }
  }

  /** Same texel-snapped fitted shadow frustum as world.js; extent 12 indoors. */
  updateShadowCamera(target, extent = 12) {
    const key = this.key;
    if (!key || !key.castShadow) return;
    const cam = key.shadow.camera;
    if (cam.right !== extent) {
      cam.left = -extent; cam.right = extent;
      cam.top = extent; cam.bottom = -extent;
      cam.near = 1; cam.far = extent * 4.5;
      cam.updateProjectionMatrix();
    }
    const texel = (extent * 2) / key.shadow.mapSize.x;
    _snapM.lookAt(_lightDir, _v.set(0, 0, 0), THREE.Object3D.DEFAULT_UP);
    _snapV.copy(target).applyMatrix4(_snapM);
    _snapV.x = Math.round(_snapV.x / texel) * texel;
    _snapV.y = Math.round(_snapV.y / texel) * texel;
    _snapV.applyMatrix4(_snapM.invert());
    key.target.position.copy(_snapV);
    key.position.copy(_snapV).addScaledVector(_lightDir, extent * 2.6);
    key.target.updateMatrixWorld();
    key.updateMatrixWorld();
  }

  // ------------------------------------------------------------- contract

  /**
   * Push out of solids + slide, then a belt-and-braces bbox clamp: anything
   * that tunnels a wall in a spike frame gets caught by the box, mirroring
   * the arena's disc-clamp philosophy. Walls are the real boundary.
   */
  resolve(pos, radius, vel = null) {
    this.obstacleField.resolve(pos, radius, vel);
    const b = this.layout?.bounds;
    if (!b) return;
    if (pos.x < b.minX + radius) { pos.x = b.minX + radius; if (vel && vel.x < 0) vel.x = 0; }
    else if (pos.x > b.maxX - radius) { pos.x = b.maxX - radius; if (vel && vel.x > 0) vel.x = 0; }
    if (pos.z < b.minZ + radius) { pos.z = b.minZ + radius; if (vel && vel.z < 0) vel.z = 0; }
    else if (pos.z > b.maxZ - radius) { pos.z = b.maxZ - radius; if (vel && vel.z > 0) vel.z = 0; }
  }

  /**
   * A walkable point from the ACTIVE room's precomputed spawn points —
   * honouring minDist when possible, degrading to the point farthest from
   * `minDistFrom`, and compressing (deterministic jitter around a taken
   * point) when the escort outnumbers the room's points. Never the arena's
   * blind polar fallback: every return is on this room's floor.
   */
  randomSpawn(rnd, minDistFrom, minDist = 14) {
    const room = this.layout?.rooms?.[this.activeRoomId] || this.layout?.rooms?.[0];
    const pts = room?.spawnPoints;
    if (!pts || !pts.length) {
      // Degenerate layout guard — the entry anchor is floor by construction.
      return new THREE.Vector3(this.layout?.entry.x ?? 0, 0, this.layout?.entry.z ?? 0);
    }
    const start = Math.floor(rnd() * pts.length);
    let bestIdx = -1;
    let bestD = -1;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(start + i) % pts.length];
      const d = minDistFrom
        ? Math.hypot(p.x - minDistFrom.x, p.z - minDistFrom.z)
        : Infinity;
      if (d > minDist) return new THREE.Vector3(p.x, 0, p.z);
      if (d > bestD) { bestD = d; bestIdx = (start + i) % pts.length; }
    }
    // Nothing satisfies minDist (small room, big escort): compress around the
    // farthest point with a bounded jitter that stays >= 1 m off any wall
    // (spawn points are >= ~2 m clear by construction).
    const p = pts[bestIdx];
    return new THREE.Vector3(
      p.x + (rnd() - 0.5) * 1.4, 0, p.z + (rnd() - 0.5) * 1.4,
    );
  }

  /**
   * Room id containing (x, z), or -1 for corridors / tunnel / rock. Cavern
   * rooms are disc TRIGGER ZONES (they carry `radius`); crawl rooms are the
   * stamped rectangles. Open cavern floor between zones is deliberately -1 —
   * nothing triggers there, which is the zone design.
   */
  roomAt(x, z) {
    const rooms = this.layout?.rooms;
    if (!rooms) return -1;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (r.radius != null) {
        const dx = x - r.centre.x;
        const dz = z - r.centre.z;
        if (dx * dx + dz * dz <= r.radius * r.radius) return r.id;
      } else if (x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d) return r.id;
    }
    return -1;
  }

  /**
   * Seal or open a door: flips the membrane quad and the pre-registered
   * collision box (top Infinity = solid, 0 = walked over). O(1), no
   * broadphase rebuild — that is what ObstacleField.setTop is for.
   */
  setDoorSealed(doorId, sealed) {
    const idx = this._membraneFieldIndex.get(doorId);
    if (idx === undefined) return;
    this.obstacleField.setTop(idx, sealed ? Infinity : 0);
    const slot = this._membraneInstance.get(doorId);
    const door = this.layout?.doors?.[doorId];
    if (this._membranes && slot !== undefined && door) {
      this._setMembraneMatrix(this._membranes, slot, door, !!sealed);
    }
  }

  /** True if the door's membrane box is currently solid. */
  doorSealed(doorId) {
    const idx = this._membraneFieldIndex.get(doorId);
    if (idx === undefined) return false;
    return this.obstacleField.get(idx)?.top === Infinity;
  }

  /**
   * Boss chamber anchor: the far-centre — pushed away from the room's first
   * door so the rise animation reads from the entrance.
   */
  bossSpawn() {
    const layout = this.layout;
    if (!layout) return new THREE.Vector3(0, 0, -10);
    const r = layout.rooms[layout.bossRoom];
    const c = r.centre;
    const doorId = r.doors[0];
    const door = doorId !== undefined ? layout.doors[doorId] : null;
    if (!door) return new THREE.Vector3(c.x, 0, c.z);
    let dx = c.x - door.x;
    let dz = c.z - door.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    // Quarter-size push, clamped 1.5 m inside the room's walls.
    const px = Math.min(r.x + r.w - 1.5, Math.max(r.x + 1.5, c.x + dx * r.w * 0.25));
    const pz = Math.min(r.z + r.d - 1.5, Math.max(r.z + 1.5, c.z + dz * r.d * 0.25));
    return new THREE.Vector3(px, 0, pz);
  }

  spawnPointsFor(roomId) {
    return this.layout?.rooms?.[roomId]?.spawnPoints || [];
  }

  /**
   * Raise the walk-out return portal at the boss chamber's back wall (STEP 5:
   * the run ends by WALKING INTO this, not on the boss's last hit point). The
   * encounter director owns WHEN; the dungeon owns the mesh — same division as
   * the door membranes. Rises over EXIT_PORTAL_RISE seconds in update().
   * Idempotent; returns the portal's position (or null before build).
   */
  showExitPortal() {
    if (this._exitPortal) return this._exitPortal.position;
    const layout = this.layout;
    if (!layout) return null;
    const r = layout.rooms[layout.bossRoom];
    const c = r.centre;
    // Back wall = away from the chamber's entrance, the same axis bossSpawn
    // pushes along, extended further and clamped 2.2 m inside the walls.
    const doorId = r.doors[0];
    const door = doorId !== undefined ? layout.doors[doorId] : null;
    let dx = 0;
    let dz = -1;
    if (door) {
      dx = c.x - door.x;
      dz = c.z - door.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
    }
    const px = Math.min(r.x + r.w - 2.2, Math.max(r.x + 2.2, c.x + dx * r.w * 0.42));
    const pz = Math.min(r.z + r.d - 2.2, Math.max(r.z + 2.2, c.z + dz * r.d * 0.42));

    const accent = new THREE.Color(this.biome?.accent ?? 0x7c5cff);
    const group = new THREE.Group();
    const ringGeo = new THREE.TorusGeometry(1.5, 0.09, 6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: accent.clone().multiplyScalar(1.25),
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 1.9;
    const discGeo = new THREE.CircleGeometry(1.35, 20);
    const discMat = new THREE.MeshBasicMaterial({
      color: accent, transparent: true, opacity: 0.42,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.y = 1.9;
    group.add(ring);
    group.add(disc);
    group.position.set(px, 0, pz);
    // The plane faces back toward the entrance so the player walks into it
    // face-on. (-dx,-dz) is portal -> door.
    group.rotation.y = Math.atan2(-dx, -dz);
    group.scale.setScalar(0.001);   // update() grows it in over the rise
    // Portals are on the sanctioned glow list (spec: portals/skills/
    // telegraphs/shadow-army — never living characters, never scenery fire).
    ring.layers.enable(GLOW_LAYER);
    disc.layers.enable(GLOW_LAYER);
    this.group.add(group);
    this._exitPortal = group;
    this._exitRise = 0;
    this._disposables.push(ringGeo, ringMat, discGeo, discMat);
    return group.position;
  }

  // v1 floors are flat (FLAT_GROUND physics binding); the method exists so
  // sloped floors are a later body.setEnvironment drop-in, like city.js.
  heightAt() { return 0; }

  // ---------------------------------------------------------------- private

  _floorAt(x, z) {
    const l = this.layout;
    if (!l) return false;
    const gx = Math.floor((x - l.originX) / l.cell);
    const gz = Math.floor((z - l.originZ) / l.cell);
    if (gx < 0 || gz < 0 || gx >= l.w || gz >= l.h) return false;
    return l.mask[gx + gz * l.w] === 1;
  }
}

// Retarget scratch (pool is at most 3).
const _bestIdx = [-1, -1, -1];

// --------------------------------------------------------------- geo helpers

// Raise a biome colour to an indoor albedo, in place.
//
// The colour space argument is NOT optional and getting it wrong is a trap
// worth naming: three's get/setHSL default to the WORKING (linear) space, so
// `lift(warren.ground, 0.26)` without it takes linear lightness 0.025 to 0.26
// — a twelvefold albedo gain that renders as a lit showroom, not a dungeon.
// In sRGB the same call is the perceptual "make this dark navy a readable
// stone" it reads as, and one threshold then behaves the same across six
// biomes of wildly different hue.
const _hsl = { h: 0, s: 0, l: 0 };
function lift(color, minL, desat = 0.22) {
  color.getHSL(_hsl, THREE.SRGBColorSpace);
  color.setHSL(_hsl.h, _hsl.s * (1 - desat), Math.max(_hsl.l, minL), THREE.SRGBColorSpace);
  return color;
}

// Deterministic value noise over WORLD position, for the floor's organic
// variation. Self-contained (a dozen lines) rather than imported from
// terrain.js on purpose: the overworld modules are being reworked in the same
// wave, and the interior's look must not be hostage to that file's fate.
function hashi(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const _smooth = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = _smooth(x - xi);
  const v = _smooth(y - yi);
  const a = hashi(xi, yi, seed);
  const b = hashi(xi + 1, yi, seed);
  const c = hashi(xi, yi + 1, seed);
  const d = hashi(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
// Two octaves is enough: this drives big soft patches, and the fine detail is
// carried by the per-triangle jitter instead (where it reads as stone rather
// than as mush — city.js's ground learned the same lesson).
//
// The domain is ROTATED per field. Value noise lives on an integer lattice, so
// unrotated it hands back axis-aligned square blobs — which on an axis-aligned
// floor grid is just a coarser version of the checkerboard this replaces. The
// rotations are irrational-ish angles chosen so no two fields line up either.
const NOISE_ROT = [
  [0.8776, 0.4794],    // ~28.6 deg
  [-0.4161, 0.9093],   // ~114.6 deg
  [0.5403, -0.8415],   // ~-57.3 deg
  [0.7539, 0.6570],    // ~41.1 deg
];
// Returned STRETCHED to fill 0..1. Raw fbm of smoothed value noise is a sum of
// means: it lands in roughly 0.36..0.64 and almost never reaches either end, so
// thresholds picked against a nominal 0..1 range produce patches with almost no
// contrast — a floor that is technically varied and visibly uniform. The 3.2
// gain about the midpoint is measured against that spread.
function fbm2(x, y, seed, rot = 0) {
  const [c, s] = NOISE_ROT[rot];
  const rx = x * c - y * s;
  const ry = x * s + y * c;
  const raw = vnoise(rx, ry, seed) * 0.65
    + vnoise(ry * 2.07 + 5.1, rx * -2.07 - 3.3, seed + 1013) * 0.35;
  return Math.min(1, Math.max(0, (raw - 0.5) * 3.2 + 0.5));
}
const smoothstep = (a, b, t) => {
  const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

function pushShaded(colors, c, s) {
  colors.push(c.r * s, c.g * s, c.b * s);
}

// pushBox per-vertex tint scratch — build-time only, but the same
// no-reallocation habit as the frame loop.
const _tint = new THREE.Color();

function bufferGeo(positions, colors) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// An axis-aligned box slab from y 0 to `hgt`: 4 sides + top, no bottom.
// Vertex colour walks from `base` at the floor to `top` at the lid — torchlit
// low, dark up high, which is most of the "carved burrow" read. Optional
// `tint(color, z)` mutates a scratch copy per vertex — the STEP 6 tunnel
// darkness ramp, which must vary ALONG a run, not per run.
function pushBox(positions, colors, cx, cz, w, d, hgt, base, top, tint = null) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const pushC = (c, z) => {
    if (!tint) { colors.push(c.r, c.g, c.b); return; }
    _tint.copy(c);
    tint(_tint, z);
    colors.push(_tint.r, _tint.g, _tint.b);
  };
  const quad = (ax, az, bx, bz) => {
    // Two triangles: a-bottom, a-top, b-top / a-bottom, b-top, b-bottom.
    positions.push(
      ax, 0, az, ax, hgt, az, bx, hgt, bz,
      ax, 0, az, bx, hgt, bz, bx, 0, bz,
    );
    pushC(base, az); pushC(top, az); pushC(top, bz);
    pushC(base, az); pushC(top, bz); pushC(base, bz);
  };
  quad(x0, z1, x1, z1);   // south face
  quad(x1, z0, x0, z0);   // north face
  quad(x0, z0, x0, z1);   // west face
  quad(x1, z1, x1, z0);   // east face
  // Top lid.
  positions.push(
    x0, hgt, z0, x0, hgt, z1, x1, hgt, z1,
    x0, hgt, z0, x1, hgt, z1, x1, hgt, z0,
  );
  pushC(top, z0); pushC(top, z1); pushC(top, z1);
  pushC(top, z0); pushC(top, z1); pushC(top, z0);
}

export default Dungeon;
