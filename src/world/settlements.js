// ---------------------------------------------------------------------------
// SETTLEMENT DESCRIPTORS — a town's identity, as data
// ---------------------------------------------------------------------------
//
// Everything that makes Threshold THRESHOLD — extents, street plan, districts,
// portal placement, door positions, palettes, the five enterable plots and the
// Verge's authored tables — lives here as one plain object, so a second town
// can exist later by writing a second descriptor instead of forking city.js.
//
// THREE RULES, all load-bearing:
//
// 1. DEPENDENCY-FREE ON PURPOSE. This module imports nothing, ever. city.js,
//    frontier.js and interiors.js form a deliberate import cycle that survives
//    only because their cross-bindings are touched at call time; a leaf data
//    module is the one shape that can be read from any of them at module-eval
//    time without adding an edge to that cycle. Keep it that way.
//
// 2. THIS IS A MOVE, NOT A REDESIGN. Every number below is byte-for-byte the
//    constant it replaced in city.js / frontier.js / interiors.js, including
//    the derivations (cliffX = -wall.half, breach district pad at the breach
//    portal's z). tools/city-test.mjs and tools/frontier-test.mjs assert the
//    built layout and the 15:00 keyframe against the shipped values, so an
//    "improvement" here fails a test rather than quietly moving the town.
//
// 3. CONSUMERS READ, NEVER WRITE. City stores the descriptor as this.spec and
//    every builder reads through it inside functions; frontier.js and
//    interiors.js read their owner City's spec rather than mirroring numbers
//    (the three duplicate WALL_HALF declarations died here). A cloned
//    descriptor ({ ...THRESHOLD, slug: 'x' }) must build without touching
//    module state — city.js proves that at load with a construction probe.
//
// The terrain-lattice contract (6.8 = 2 x groundCell, 170 = 25 x 6.8, the
// stitch/blend bands) is DERIVED from wall.groundCell where it is used —
// city.js's FRONTIER_CELL/FRONTIER_HALF exports — and the band radii are
// stated here as data. The full rationale stays with the consumers.

// Local names so the numbers that must agree are authored exactly once.
const WALL_HALF = 88;     // walled interior spans -88..88 on x and z
const PLAZA_R = 26;       // flagstone disc at the centre
const BREACH_Z = -126;    // the S portal, outside the north wall

export const THRESHOLD = {
  slug: 'threshold',

  // Geometry of the town, in metres. Everything else derives from these.
  // 340 x 340 m of ground, of which 176 x 176 is inside the wall — the spec's
  // figure. See city.js's header for why the walled part is the smaller share.
  wall: {
    half: WALL_HALF,
    worldHalf: 170,        // heightfield half-extent (340 m square); 25 x 6.8
    groundCell: 3.4,       // heightfield / ground-mesh resolution
    plazaR: PLAZA_R,
    cliffX: -WALL_HALF,    // ground falls away west of here
    buildingBudget: 92,    // hard cap; see city.js decision 3
    walkLimit: 134,        // how far out resolve() lets anything walk (no Verge)
  },

  // The [r0, r1] Chebyshev bands of the shared analytic surface. cityEdge is
  // the shipped no-frontier lip; vergeEdge the with-frontier one; blend is
  // where City.heightAt hands authority to the frontier field; stitch is where
  // the city field resamples itself onto the coarse lattice. The seam
  // correctness argument for these exact numbers is with groundBase and
  // HeightField.bake in city.js — the values are identity, the reasoning is not.
  terrain: {
    cityEdge: [140, 156],
    vergeEdge: [264, 278],
    blend: [162, 170],
    stitch: [138, 155],
  },

  // buildStreets() parameters. Avenues run plaza -> wall on all four compass
  // lines (the west one stops at the cliff parapet instead of a gate); the
  // Breach road continues the north avenue outside the wall; cross streets are
  // mirrored in both axes per entry, span metres either side of centre.
  streets: {
    avenueW: 6,
    avenueStop: 2,         // avenues end this far inside the wall
    overlookStop: 4,       // the west avenue ends this far east of the cliff
    breachRoad: { w: 4.5, stop: 14 },  // ends 14 m short of the S portal
    ring: { r: 58, sides: 20, w: 4.5 },  // 20-gon: cheap to rasterise
    cross: [
      { off: 32, span: WALL_HALF - 5, w: 4 },
      { off: 66, span: 68, w: 3.4 },
    ],
  },

  /**
   * The six districts. `pos` is the interaction / arrival point, `pad` the
   * radius of level ground carved under it. Six, not the spec comment's five —
   * the Breach is a place you walk to, not a footnote. Consume by `id`, never
   * by index. (The full note is on city.js's DISTRICTS export.)
   */
  districts: [
    { id: 'plaza',    name: 'THE GATE PLAZA', pos: { x: 0, z: 0 },       pad: PLAZA_R, service: null },
    { id: 'assay',    name: 'THE ASSAY HALL', pos: { x: 0, z: -38 },     pad: 15, service: 'assay' },
    { id: 'ashworks', name: 'THE ASHWORKS',   pos: { x: 44, z: 4 },      pad: 16, service: 'barracks' },
    { id: 'exchange', name: 'THE EXCHANGE',   pos: { x: -4, z: 34 },     pad: 15, service: 'exchange' },
    { id: 'row',      name: 'QUARTER ROW',    pos: { x: -52, z: 2 },     pad: 14, service: null },
    { id: 'breach',   name: 'THE BREACH',     pos: { x: 0, z: BREACH_Z }, pad: 18, service: null },
  ],

  // -Z is north. Angles are measured with 0 = east and +ve toward north, so
  // the arc reads E..A left-to-right walking in from the south. `ring` is the
  // plaza radius E..A stand on; the S portal stands alone at breach.z.
  portals: {
    ring: 22,
    angles: { E: 198, D: 144, C: 90, B: 36, A: -18 },
    breach: { z: BREACH_Z },
  },

  // Doors the player can stand in front of. Radii are generous because a phone
  // player steers with a thumb. `open` gates the PROMPT, not the record — the
  // full contract (and the assay z = -32 collision story) is documented at
  // City._buildInteractables' consumption site.
  interactables: [
    { id: 'barracks', label: 'THE ASHWORKS',   pos: { x: 44, z: 12 },  radius: 4.5, open: false },
    { id: 'assay',    label: 'THE ASSAY HALL', pos: { x: 0, z: -32 },  radius: 4.5, open: true },
    { id: 'trial',    label: 'THE SEALED STAIR', pos: { x: -7, z: -38 }, radius: 3.5, open: false },
    // OPEN as of the weapon shop: game/shop.js + ui/shopui.js are behind this
    // prompt, and citymode.confirmPrompt routes 'exchange' to them.
    { id: 'exchange', label: 'THE EXCHANGE',   pos: { x: -4, z: 26 },  radius: 4.5, open: true },
    { id: 'stash',    label: 'THE STASH',      pos: { x: 6, z: 34 },   radius: 3.5, open: false },
  ],

  // Late afternoon, not dusk — the glow-wash postmortem lives with the
  // consumer in city.js. `sky` is the same palette pre-brightened for
  // makeSky()'s double-sRGB convention (also documented at the call site).
  palettes: {
    city: {
      fog: 0xb6c6dc, ground: 0x5d6a4c, accent: 0xffd9a8,
      sky: 0x74a2da, pillar: 0x8a90a0, detail: 0xd8e0ee,
    },
    sky: {
      fog: 0xdfe8f4, ground: 0x9aa885, accent: 0xffeccd,
      sky: 0xb6d3f5, pillar: 0xc2c7d2, detail: 0xeef2f8,
    },
    // The shipped 15:00 fog distances; applyDayState scales both by one knob.
    fog: { near: 130, far: 430 },
  },

  // The five enterable service buildings' settlement-specific placement data.
  // Structure (cells, style, dressing) stays with interiors.js's ENTERABLES;
  // WHERE each one wants to stand is town identity and lives here, keyed by
  // enterable id. The prefer-position rationales (slot widths, measured
  // failures) are with the ENTERABLES table.
  interiors: {
    // AUTHORITY WARNING — these two entries feed ONLY interiors._plotOk (the
    // keep-out that stops enterables landing on the strip / the spire). The
    // stalls themselves are hardcoded in city._buildProps (x = -4 ± 8.5,
    // z = 31 + k*5.4) and the spire's search point is LAYOUT_RULES.spireSite
    // (layoutrules.js) — three authoring points that must AGREE. Editing
    // these values does NOT move the stalls or the spire; it only moves the
    // keep-out. Folding layoutrules + the stall coords into the descriptor is
    // a flagged follow-up (see the Wave A report / AAA_COHESION_PLAN).
    marketZone: { x0: -18, x1: 10, z0: 24, z1: 68 },
    spireKeep: { x: 16, z: -38, r: 11 },
    prefer: {
      assay: { x: -14, z: -41 },
      ashworks: { x: 44, z: 13 },
      exchange: { x: 17, z: 42 },
      tavern_row: { x: -46, z: 11 },
      stash_annex: { x: -22, z: 41 },
    },
  },

  // The land outside the walls. Numbers only — the composition and validator
  // rationale (why POIs are authored, why the pad rule exists) stays with
  // frontier.js, which consumes these through its owner City's spec.
  verge: {
    limit: 258,            // how far resolve() lets anything walk with a Verge
    poiMinR: 186,          // POI pads carve the frontier field only; see frontier.js
    scatterIn: 152,        // scatter annulus inner bound (outer = limit - 6)
    poiFeather: 6,

    // Rules from the spec's poiRules, as numbers so the validator and the
    // harness share them. seamClear = terrain.blend[1]: pads must not reach
    // the radius where heightAt hands authority across the seam.
    poiRules: {
      minSep: 55,          // metres between POI centres
      minWall: 30,         // metres outside the city wall
      minBreach: 40,       // metres from the Breach ash ring's centre
      maxSlope: 0.3,
      seamClear: 170,
    },

    // Directional biome wedges, azimuth frame EAST = 0 / SOUTH = 90 (see
    // frontier.js azimuth()). The west wedge has no band: that is the cliff
    // void. Arcs as centre + falloff so the palette cross-fades.
    bands: {
      east_meadow: { centre: 0, soft: [55, 85], arc: [-60, 60] },
      south_amberwood: { centre: 115, soft: [50, 80], arc: [60, 170] },
      north_ashreach: { centre: 245, soft: [50, 85], arc: [190, 300] },
    },

    // Seven authored POI anchors, seeded +-7 m jitter on top, validator
    // fallback to the anchor — the "postcards on sightlines" argument is with
    // frontier.js's _placePois.
    pois: [
      {
        id: 'verge_ruin_arch',
        name: 'THE SUNKEN ARCH',
        // Dead east on the east avenue's line (the street runs out along
        // z = 0), so it is the thing you see through the east gate.
        x: 206, z: 10, pad: 10, radius: 24, stamp: 'ruinArch',
      },
      {
        id: 'camp_hunters_east',
        name: "THE HUNTERS' CAMP",
        // npcs/npcHunter are read by citizens.js after City.build has run both
        // frontier and crowd — a staging post with nobody in it answers the
        // owner's "is anyone out here" with no.
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
        // North, on the Breach side: a tower on the skyline is the only
        // landmark out here that reads from inside the walls.
        x: -30, z: -208, pad: 10, radius: 24, stamp: 'watchtower',
      },
    ],
  },
};
