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
//    Wave B amendments — the streets.graph 'track' edges and the district
//    portal placements — are DELIBERATE exceptions (owner-approved world
//    changes), each carrying its own rationale block; the rule still binds
//    everything else, and still binds the in-wall street transcription.
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

// The seven Verge POI anchors, hoisted so verge.pois and the street graph's
// track edges read the SAME literals — this kills EDIT drift (one copy moved,
// the other stale), not BUILD drift: frontier.js still jitters each built POI
// ±7 m off its anchor (seeded), so a track's painted terminus can land toward
// the pad's feather rather than its centre (~10 m worst case). The 10 m pad
// radius and the shared trodden hex absorb that; if it ever reads wrong, the
// fix is continuing the paint from anchor to the BUILT poi position at paint
// time, not tightening this table. Per-POI rationale stays on verge.pois.
const VERGE_POIS = [
  { id: 'verge_ruin_arch', x: 206, z: 10 },
  { id: 'camp_hunters_east', x: 192, z: -104 },
  { id: 'wildgate_e', x: 198, z: 96 },
  { id: 'camp_farmstead', x: 150, z: 200 },
  { id: 'verge_ruin_hall', x: 40, z: 210 },
  { id: 'wildgate_c', x: -62, z: 206 },
  { id: 'verge_watchtower', x: -30, z: -208 },
];
// Anchor lookup for the verge.pois entries below — id-keyed, never indexed,
// for the same reason districts are consumed by id.
const POI_AT = Object.fromEntries(VERGE_POIS.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
// The street graph (Wave B1) — roads as nodes + edges instead of a parameter
// blob. city.js's buildStreets() is a plain walker now: it emits one stamped
// segment per edge, IN EDGE ORDER, because segment order feeds the ground
// paint pass, _layout's frontage search and interiors' plot scoring — reorder
// an edge and the whole town re-derives.
//
// TRANSCRIPTION, NOT REDESIGN, for every class except 'track': each in-wall
// edge below reproduces the segment the old blob generated, byte for byte,
// including the float dust — ring_20 is ring_0 up to Math.sin(2*PI) ~ 2.4e-16,
// and it is kept as its own node because the old 20-gon's closing segment
// ended on exactly that value, and "identical in-wall surfaces" is asserted
// by tools/city-test.mjs against the stamped result, not against intent.
//
// 'track' edges are NEW (Wave B1's Verge roads): one kerbless packed-earth
// road from the city's nearest wall opening to each POI that had none, so
// approach paths read as built rather than scattered. They are handed back on
// a SEPARATE list by the walker (city.tracks, never city.streets): _layout,
// the lantern pass, interiors' plot search and validateLayout all iterate
// city.streets, and a track outside the wall must not shift a single one of
// their draws or distances. The watchtower track deliberately grazes the
// Breach ash ring (any straight line north does); the ash paint overrides the
// trodden earth there, which reads as the path burning out near the ruin.
const STREET_GRAPH = (() => {
  const nodes = {
    // Plaza lip and avenue ends. Avenues stop avenueStop=2 m inside the wall;
    // the west one stops overlookStop=4 m east of the cliff parapet instead.
    plaza_n: { x: 0, z: -PLAZA_R },
    plaza_s: { x: 0, z: PLAZA_R },
    plaza_e: { x: PLAZA_R, z: 0 },
    plaza_w: { x: -PLAZA_R, z: 0 },
    ave_n_end: { x: 0, z: -WALL_HALF + 2 },
    ave_s_end: { x: 0, z: WALL_HALF - 2 },
    ave_e_end: { x: WALL_HALF - 2, z: 0 },
    overlook: { x: -WALL_HALF + 4, z: 0 },
    // Wall openings. gate_n doubles as the Breach road's head, exactly where
    // the old blob started it; gate_e / gate_s exist for the track edges.
    gate_n: { x: 0, z: -WALL_HALF },
    gate_e: { x: WALL_HALF, z: 0 },
    gate_s: { x: 0, z: WALL_HALF },
    breach_road_end: { x: 0, z: BREACH_Z + 14 },   // 14 m short of the S portal
  };
  const edges = [];
  const E = (a, b, cls, w) => edges.push({ a, b, class: cls, w });

  // Four avenues out of the plaza, then the Breach road — same order, same
  // widths as the old literal list (order 1-5 of 33).
  E('plaza_n', 'ave_n_end', 'avenue', 6);
  E('plaza_s', 'ave_s_end', 'avenue', 6);
  E('plaza_e', 'ave_e_end', 'avenue', 6);
  E('plaza_w', 'overlook', 'avenue', 6);
  E('gate_n', 'breach_road_end', 'avenue', 4.5);

  // Ring road: the 58 m 20-gon (cheap to rasterise), edges 6-25. 21 nodes,
  // see the float-dust note above.
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    nodes[`ring_${i}`] = { x: Math.cos(a) * 58, z: -Math.sin(a) * 58 };
  }
  for (let i = 0; i < 20; i++) E(`ring_${i}`, `ring_${i + 1}`, 'ring', 4.5);

  // Cross streets, edges 26-33: mirrored across both axes AND both signs,
  // x-street then z-street per offset, inner pair (32) then outer (66) —
  // the old nested-loop emission order, preserved because it is load-bearing.
  for (const k of [-1, 1]) {
    for (const c of [{ off: 32, span: WALL_HALF - 5, w: 4 }, { off: 66, span: 68, w: 3.4 }]) {
      nodes[`lane_x${k * c.off}_n`] = { x: k * c.off, z: -c.span };
      nodes[`lane_x${k * c.off}_s`] = { x: k * c.off, z: c.span };
      E(`lane_x${k * c.off}_n`, `lane_x${k * c.off}_s`, 'lane', c.w);
      nodes[`lane_z${k * c.off}_w`] = { x: -c.span, z: k * c.off };
      nodes[`lane_z${k * c.off}_e`] = { x: c.span, z: k * c.off };
      E(`lane_z${k * c.off}_w`, `lane_z${k * c.off}_e`, 'lane', c.w);
    }
  }

  // Verge tracks (NEW): one per POI, from its nearest wall opening. Nearest is
  // computed rather than authored so a re-anchored POI cannot keep a stale
  // gate; the gate list is the three real openings (the west side is cliff).
  const gates = ['gate_n', 'gate_e', 'gate_s'];
  for (const p of VERGE_POIS) {
    nodes[`poi_${p.id}`] = { x: p.x, z: p.z };
    let best = gates[0], bestD = Infinity;
    for (const g of gates) {
      const d = Math.hypot(p.x - nodes[g].x, p.z - nodes[g].z);
      if (d < bestD) { bestD = d; best = g; }
    }
    E(best, `poi_${p.id}`, 'track', 3);
  }

  return { nodes, edges };
})();

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

  // The road network as DATA (Wave B1): a graph of junction nodes + classed
  // edges (avenue|ring|lane|track, width in metres) that buildStreets() walks
  // in edge order, plus the ONE trim vocabulary the ground painter consumes.
  // The graph itself is authored above (STREET_GRAPH) with the transcription
  // and ordering laws; the parameter blob it replaced generated the identical
  // in-wall segments.
  streets: {
    graph: STREET_GRAPH,

    // Trim vocabulary, named ONCE per settlement so kerb families cannot mix:
    // the painter reads these instead of burying the numbers per call site.
    //   kerb   — the darker seam band just outside a street's width. `in`/`out`
    //            are [start, end] offsets past s.w for the two smoothsteps
    //            whose product is the band (see city.js _buildGround); the
    //            band is ~2 m wide because the ground grid is 3.4 m — a true
    //            0.5 m kerb lands on almost no vertices and reads as dashes.
    //   pave   — the paved-surface feather, offsets past s.w.
    //   track  — the kerbless packed-earth treatment for 'track' edges: same
    //            feather vocabulary, no kerb band, the Verge's trodden-ground
    //            colour (the exact hex frontier.js uses for POI pads, so a
    //            track arriving at a pad is one continuous material) at less
    //            than full strength — earth over grass, not stone over it.
    trim: {
      kerb: { color: 0x6e6a55, in: [-0.6, 0.1], out: [1.7, 3.0], strength: 0.8 },
      pave: { feather: [-0.6, 2.4] },
      track: { color: 0x9c8f74, feather: [-0.6, 2.4], strength: 0.85 },
    },
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

  // Gate placement (Wave B2) — `placements` is AUTHORITATIVE and ORDERED:
  // city._buildPortals walks it top to bottom drawing one rnd() per entry, so
  // the E,D,C,B,A,S order is part of the settlement's RNG contract; reorder
  // it and every draw after the portals re-derives.
  //
  // Anchors:  { kind:'plaza-ring', angleDeg }  — on the plaza ring (`ring` m),
  //             0 = east, +ve toward north (-Z);
  //           { kind:'district', district, x, z } — an exact spot in a named
  //             district, ON or immediately beside a streets.graph edge;
  //           { kind:'breach' } — alone outside the north wall at breach.z.
  //
  // The owner's ask: "gates throughout the city instead of congregated". E
  // keeps the plaza ring — the assay yard is the first-minutes teaching
  // moment and the one gate a fresh save can enter must be the one the spawn
  // camera frames. The rest dissolve into the districts, each ON a road so
  // the B1 network leads you there: D beside the east avenue on the Ashworks
  // pad (the barracks district trains for exactly that gate), C on the north
  // avenue at the z=-66 cross — the road to the north wall, B on the z=66
  // cross past the market's last stall (the exchange district, whose Verge
  // band holds the Roofless Hall ruin the south tracks run to), A across the
  // city from D on the west avenue in Quarter Row. Spots are >=30 m apart,
  // inside building-exclusion corridors (street corridor or district-pad
  // core, so no procedural plot can ever claim them), and prompt-zone-clear
  // of every interactable — city._assertPortalPlacements() throws at build
  // time on any violation, which is what makes the assay z=-32 class of
  // hand-patched collision impossible to reintroduce silently.
  portals: {
    ring: 22,
    placements: [
      { id: 'plaza-e', rank: 'E', anchor: { kind: 'plaza-ring', angleDeg: 198 } },
      { id: 'gate-d', rank: 'D', anchor: { kind: 'district', district: 'ashworks', x: 44, z: -4 } },
      { id: 'gate-c', rank: 'C', anchor: { kind: 'district', district: 'assay', x: 5, z: -62 } },
      { id: 'gate-b', rank: 'B', anchor: { kind: 'district', district: 'exchange', x: 12, z: 66 } },
      { id: 'gate-a', rank: 'A', anchor: { kind: 'district', district: 'row', x: -60, z: 4 } },
      { id: 'breach-s', rank: 'S', anchor: { kind: 'breach' } },
    ],
    // FOR THE OWNER — the shipped plaza ring, kept as a paste-back: replace
    // `placements` above with this block to re-congregate E..A on the ring
    // (the 22 m arc reads E..A left-to-right walking in from the south).
    // placements: [
    //   { id: 'plaza-e', rank: 'E', anchor: { kind: 'plaza-ring', angleDeg: 198 } },
    //   { id: 'plaza-d', rank: 'D', anchor: { kind: 'plaza-ring', angleDeg: 144 } },
    //   { id: 'plaza-c', rank: 'C', anchor: { kind: 'plaza-ring', angleDeg: 90 } },
    //   { id: 'plaza-b', rank: 'B', anchor: { kind: 'plaza-ring', angleDeg: 36 } },
    //   { id: 'plaza-a', rank: 'A', anchor: { kind: 'plaza-ring', angleDeg: -18 } },
    //   { id: 'breach-s', rank: 'S', anchor: { kind: 'breach' } },
    // ],
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
        x: POI_AT.verge_ruin_arch.x, z: POI_AT.verge_ruin_arch.z, pad: 10, radius: 24, stamp: 'ruinArch',
      },
      {
        id: 'camp_hunters_east',
        name: "THE HUNTERS' CAMP",
        // npcs/npcHunter are read by citizens.js after City.build has run both
        // frontier and crowd — a staging post with nobody in it answers the
        // owner's "is anyone out here" with no.
        x: POI_AT.camp_hunters_east.x, z: POI_AT.camp_hunters_east.z, pad: 10, radius: 24, stamp: 'campHunters', npcs: 2, npcHunter: true,
      },
      {
        id: 'wildgate_e',
        name: 'AN UNWATCHED GATE',
        x: POI_AT.wildgate_e.x, z: POI_AT.wildgate_e.z, pad: 12, radius: 24, stamp: 'wildGate', rank: 'E',
      },
      {
        id: 'camp_farmstead',
        name: 'THE OUTFARM',
        x: POI_AT.camp_farmstead.x, z: POI_AT.camp_farmstead.z, pad: 10, radius: 24, stamp: 'campFarmstead', npcs: 1,
      },
      {
        id: 'verge_ruin_hall',
        name: 'THE ROOFLESS HALL',
        x: POI_AT.verge_ruin_hall.x, z: POI_AT.verge_ruin_hall.z, pad: 10, radius: 24, stamp: 'ruinHall',
      },
      {
        id: 'wildgate_c',
        name: 'A SEALED WILD GATE',
        x: POI_AT.wildgate_c.x, z: POI_AT.wildgate_c.z, pad: 12, radius: 24, stamp: 'wildGate', rank: 'C',
      },
      {
        id: 'verge_watchtower',
        name: 'THE ASHREACH WATCH',
        // North, on the Breach side: a tower on the skyline is the only
        // landmark out here that reads from inside the walls.
        x: POI_AT.verge_watchtower.x, z: POI_AT.verge_watchtower.z, pad: 10, radius: 24, stamp: 'watchtower',
      },
    ],
  },
};
