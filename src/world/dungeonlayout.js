// Pure dungeon layout generation — DUNGEON_SPEC.json STEP 1. PUBLIC MODULE.
//
// The generator was split per layout kind for Wave E (docs/AAA_COHESION_PLAN.md
// — new kinds 'tower' / 'waste' / 'reach' each get a file, not 800 more lines
// in one): the shared contract, kind dispatch and every exported name below
// live in layouts/core.js, the E/D rooms-and-corridors kind in
// layouts/crawl.js, the C open-cavern kind in layouts/cavern.js, and the B
// terraced-ascent kind (Wave E task E-B — layout.heightAt, stair ramps,
// parapet gaps) in layouts/tower.js. This file is
// a re-export facade so consumers (dungeon.js, tools/dungeon-gen-test.mjs,
// tools/dungeon-test.mjs's dynamic import) keep importing ONE module — and so
// the module identity of COVER_KINDS / LAYOUT_PARAMS / ALCOVE_LIMITS stays a
// single object everywhere, exactly as before the split.
//
// Everything in layouts/core.js's header — DETERMINISM IS LOAD-BEARING, the
// forked mulberry32 streams, coordinates, the wall-run `face` convention,
// door records — is the contract for this module's exports; read it first.

export {
  generateLayout, layoutStats, LAYOUT_PARAMS,
  ALCOVE_LIMITS, COVER_MIN_TOP, COVER_KINDS,
  bossAnchor, exitAnchor,
  NAV_BODY_RADIUS, NAV_FILL_STEP, floodFillRoom, doorReachableFrom,
  // Waste kind (Wave E task E-A, layouts/waste.js via core's re-export): the
  // route-waypoint connectivity helpers + terrain contract constants, so the
  // soak runs the exact code the generator's own guarantee runs.
  buildWasteField, wasteFieldFill, terrainHeightFn,
  TERRAIN_MAX_SLOPE, ROUTE_CORRIDOR_HALF, WASTE_FILL_STEP,
} from './layouts/core.js';
