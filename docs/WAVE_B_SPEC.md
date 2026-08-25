# Wave B — World Cohesion: implementation spec

Consumes the Wave A settlement descriptor (src/world/settlements.js). Every
item below is per-settlement DATA unless marked engine. Standing laws apply
(one renderer, zero PointLights, meshopt, offline, deterministic streams,
byte-identity for Threshold wherever a step says "zero-change").

## B1. Road network as data (engine + data)
- Descriptor gains `streets.graph`: nodes (junctions, plaza, gatesites) +
  edges (avenue|ring|lane class, width). buildStreets() becomes a graph walker
  emitting the same stamped surfaces it does today. Threshold's graph is
  transcribed from the current hardcoded geometry — zero visual change,
  asserted by city-test.
- The Verge gets edges too: one road per POI that today has none, kerbless
  packed-earth class ('track'), stamped with the existing tile vocabulary so
  approach paths read as built, not scattered.
- One trim vocabulary: kerb/edge pieces chosen once in the descriptor
  (`streets.trim`), never per-call — kills mixed kerb families.

## B2. Gates into the districts (data + small engine)
- Descriptor `portals.placements`: array of { id, rank, x?, z?, district?,
  anchor: 'plaza-ring'|'district'|'breach'|'poi' }. Threshold KEEPS the
  plaza ring this step (zero-change), then a SECOND descriptor revision moves
  D/C/B/A into districts once B1's roads reach them (owner sees both on
  device; the 22 m ring was an owner-approved shot — he re-approves or we
  keep E+ring as the "assay yard" and spread only C/B/A).
- Wayfinding: compass gains multi-pip mode (nearest 3 unlocked portals,
  rank-colored); _buildFlags already derives banner colors from portals —
  verify it survives arbitrary positions (it should: nearest-portal sectors).
- Spawn/prompt assumptions to untangle (audit list): _spawnVector's
  step-toward-plaza vector (use portal-facing yaw instead), prompt-radius
  hand-spacing vs interactables (assert no overlaps at build time in dev),
  per-portal dais obstacle (already per-portal, fine).

## B3. Doors that don't lie (engine)
- ENTERABLES get an animated door leaf: town kit's door piece rotated on a
  hinge group, opened by proximity (same hysteresis machinery as roof-fade),
  0.35 s ease, no sound yet (Wave G audio pass).
- Sealed buildings: swap flat town_wall_door for town_wall_doorway_* + a
  recessed dark panel (0.4 m inset, near-black unlit material) — reads as
  depth, costs 2 tris, no new pieces.
- Roof-fade: replace the 0.25 m hysteresis pop with a 0.25 s opacity ramp
  (material opacity on the cap mesh only; it is already a separate merged mesh).
- Camera boom: lerp CAM_INSIDE transitions over 0.3 s instead of the snap.
- The three "CLOSED" venues: barracks + trial get "opens in a later chapter"
  story subs from the strings module (honest, diegetic); stash stays until
  Wave F decides its fate.

## B4. Second settlement + forest (data + assets)
- `EMBERFALL` (working name, owner can rename): village descriptor —
  ~20 buildings, no wall, one E gate + one D gate, own palette row (warm
  amber dusk vs Threshold's blue), own district profile (hamlet: low
  frontage, farmstead scatter), Verge bands reduced to meadow-only.
- `THE BIRCHREACH` (working name): forest region descriptor — traversable
  woodland: naturekit density fields along B1 track edges, 2 clearings
  (one camp POI, one HIDDEN wild gate), canopy handled by palette+fog (no
  new lighting), same heightfield machinery.
- Blender MCP fills kit gaps ONLY via tools/build-*-glb.mjs with procedural
  twins + manifest entries + lowercase keys + committed GLBs: candidate list
  (village well, fence runs, hay/cart props, forest floor pieces, birch
  variants) — audit each against the existing 245-piece citykit + 140-piece
  naturekit first; most may already exist.
- Perf: each new settlement clones city-test's harness (p95 draw calls,
  zero-program-growth, portal count) with its own budget row.

## B5. Waygates + world map (engine)
- Waygate = portal kind 'way' carrying { toSettlement, toPortalId }; enter →
  mode teardown → City.build(descriptor for target) → spawn at target portal.
  Rides the existing city<->dungeon rebuild cycle; two settlements NEVER
  coexist in a scene (InstancedMesh model, audit risk #1).
- save gains { settlement: 'threshold', discovered: [...] } absent-means-
  default; lastGatePortalId already settlement-safe (ids are namespaced by
  settlement slug from the descriptor).
- World map screen: isolated-layer camera over a MINIATURE bake? No — v1 is
  a stylized 2D panel (createElement + the token sheet): nodes for
  settlements, lines for roads, rank pips for known gates, tap to travel
  (unlocked = discovered). The previewCamera 3D map is a Wave G upgrade.
- AppState gains screen 'map'; overlay-panel recipe (shopui template).

## B6. Region grade identity (engine, small)
- glow.js COMPOSITE gains three uniforms: uGradeLift (vec3), uVignette
  (float), uGradeSat (float) — defaults = shipped look exactly (asserted by
  visual-test pixel probes). Descriptor palette row carries per-region values;
  dungeon biomes get rows in Wave E.

## Order: B1 → B2 → B3 ship as one APK (Threshold feels finished).
## B4 → B5 → B6 ship as the second APK (the world opens).
