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
  // Display name (Wave B5): what the map title, the settlement switcher chips
  // and the waygate prompts print. Authored per descriptor rather than derived
  // from the slug because 'birchreach' must read as 'THE BIRCHREACH' and a
  // formatter that knows which slugs take an article is a name table wearing
  // a trench coat.
  name: 'THRESHOLD',

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
      // THE WAYGATE (Wave B5 — travel is live). Threshold's link in the way
      // network: silver-white portal beside the north gate, paired with
      // Emberfall's green. kind:'way' entries draw ZERO from the settlement's
      // main build stream (_buildPortals builds them from its own forked
      // stream), so appending after the six rank entries leaves the E..S
      // rnd() contract — and every draw after it — exactly as shipped; only
      // the keep-out and the built visual are new.
      //
      // The spot: just east of the north gate mouth, outside the wall on the
      // Breach road's shoulder — "the road out of town" is where a gate to
      // another town reads as honest. (16,-100) is the placement-law solve:
      // >=30 m from breach-s at (0,-126) — 30.5 m, a 0.5 m margin over the
      // build-time throw, TIGHT ON PURPOSE (a nudge south FAILS THE BUILD;
      // move breach-s too or not at all) — and 39.6 m from gate-c at (5,-62),
      // and far enough north that _spawnVector's step-out along the
      // facing (portal.radius + 1.6 toward the plaza) lands ~5 m clear of the
      // wall face instead of against it.
      {
        id: 'way-threshold-north',
        kind: 'way',
        to: { settlement: 'emberfall', portalId: 'way-emberfall-green' },
        anchor: { kind: 'district', district: 'breach', x: 16, z: -100 },
      },
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

  // Authored prop placements (Wave B4a) — MOVED from city._buildProps'
  // literals, byte for byte, because "where the stalls stand" is town identity
  // exactly like "where the gates stand" (the interiors.marketZone AUTHORITY
  // WARNING below documents the drift this section retires: the stall strip
  // was authored in _buildProps, mirrored in layoutrules.marketZone and
  // mirrored again in interiors.marketZone). The LOOP SHAPES stay in
  // city._buildProps and read these numbers — the rnd() draw order per family
  // is part of the settlement's stream contract, and the four suites prove
  // the move changed nothing.
  //   plazaPillars — the stone ring count. Also gates _buildFlags' hanging
  //                  cloth standards: the little banner poles are authored to
  //                  stand ON the kit pillars, so no pillars means no
  //                  standards (a village green gets flying pairs instead).
  //   fountains    — placed unconditionally; interiors._plotOk keeps its
  //                  plots clear of these SAME entries (one table, two
  //                  consumers, no more hand-mirrored pair).
  //   market       — the Exchange stall strip (cx +- side, z0 + k*step).
  //   benchRow     — the Quarter Row bench walk (x0 - i*step, +-(zBase..+zSpread)).
  //   overlookBench— the one bench facing the west drop; cliff towns only.
  props: {
    plazaPillars: 24,
    fountains: [{ x: 0, z: 17.5 }, { x: -58, z: -12 }],
    market: { cx: -4, side: 8.5, z0: 31, step: 5.4, n: 12 },
    benchRow: { x0: -30, step: 2.8, n: 18, zBase: 7, zSpread: 3 },
    overlookBench: true,
  },

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

// ---------------------------------------------------------------------------
// EMBERFALL — the village (Wave B4a). The second settlement, and the proof
// that the descriptor seam Wave A cut is real: everything below is DATA and
// city.js builds it with the same code that builds Threshold.
// ---------------------------------------------------------------------------
//
// Identity in one line: a warm-amber farming hamlet on the same meadow, no
// wall, one lane through it, a green instead of a plaza, and two working
// gates. Rule 2 above ("a move, not a redesign") binds THRESHOLD only — this
// descriptor is NEW content and its numbers are authored here, first.
//
// SHARED-LATTICE LAW: wall.worldHalf / wall.groundCell / the terrain bands
// are BYTE-EQUAL to Threshold's on purpose. city.js's FRONTIER_CELL /
// FRONTIER_HALF / VERGE_EDGE / BLEND_* exports and frontier.js's ring
// constants are the tools' terrain contract and are Threshold-sourced; the
// engine reads all of them through spec.* at instance scope now, but a
// settlement that changed the lattice would still shear off the tools'
// single source of truth. A different-lattice settlement pays for that
// refactor when it exists (city.js line ~100 says the same).

const EF_HALF = 56;        // village core half-extent; no wall stands on it
const EF_GREEN_R = 12;     // the green — a small common, not a plaza

// Two Verge POI anchors, hoisted for the same edit-drift reason as
// VERGE_POIS above: the track edges and verge.pois must read one literal.
const EF_POIS = [
  { id: 'ember_wayfarers_camp', x: 196, z: -64 },
  { id: 'ember_barrow_ring', x: -48, z: 204 },
];
const EF_POI_AT = Object.fromEntries(EF_POIS.map((p) => [p.id, p]));

// The village street graph: ONE lane through (north-south, through the
// green), TWO side lanes (east-west, crossing it), and a track stub per POI.
// Edge order is the paint/layout/rnd contract exactly as it is for Threshold.
//
// The lane ends and the side-lane ends sit AT +-EF_HALF: the packed-earth
// track paint is gated to r > wall.half (city._buildGround), so a track's
// head must meet its lane exactly on that radius or the road shows a 4 m
// unpainted gap where neither treatment reaches. Threshold hides that cut
// inside its wall gates' footprint; a wall-less village has nowhere to hide
// it, so the geometry closes it instead.
const EMBERFALL_STREETS = (() => {
  const nodes = {
    green_n: { x: 0, z: -EF_GREEN_R },
    green_s: { x: 0, z: EF_GREEN_R },
    lane_n_end: { x: 0, z: -EF_HALF },
    lane_s_end: { x: 0, z: EF_HALF },
    side_n_w: { x: -EF_HALF, z: -20 },
    side_n_e: { x: EF_HALF, z: -20 },
    side_s_w: { x: -EF_HALF, z: 18 },
    side_s_e: { x: EF_HALF, z: 18 },
  };
  const edges = [];
  const E = (a, b, cls, w) => edges.push({ a, b, class: cls, w });
  E('green_n', 'lane_n_end', 'avenue', 5);      // the lane through, north half
  E('green_s', 'lane_s_end', 'avenue', 5);      // ...and south half
  E('side_n_w', 'side_n_e', 'lane', 3.6);
  E('side_s_w', 'side_s_e', 'lane', 3.6);
  for (const p of EF_POIS) nodes[`poi_${p.id}`] = { x: p.x, z: p.z };
  // Authored, not nearest-gate-computed: there are no gates, and each stub
  // reads best leaving the village the way its POI actually lies.
  E('side_n_e', 'poi_ember_wayfarers_camp', 'track', 3);
  E('lane_s_end', 'poi_ember_barrow_ring', 'track', 3);
  return { nodes, edges };
})();

export const EMBERFALL = {
  slug: 'emberfall',
  name: 'EMBERFALL',      // display name — see THRESHOLD.name

  // Forks the build stream off Threshold's: City.build XORs this into the
  // seed before minting its mulberry32 (0 / absent = the shipped Threshold
  // stream, bit for bit). Same seed, different town, different dice — the
  // "forked mulberry32 per new content" law.
  seedSalt: 0x45464131,

  wall: {
    // NO WALL. built:false skips _buildCityWall entirely — the settlement
    // boundary is the Verge blend itself, exactly as the spec asks. half
    // still names the core extent: the layout grid, the track-paint gate and
    // the flag families all measure against it.
    built: false,
    half: EF_HALF,
    worldHalf: 170,        // SHARED-LATTICE LAW — see the header above
    groundCell: 3.4,
    plazaR: EF_GREEN_R,
    // A green, not flagstones: _buildGround paints the disc as trodden grass
    // (the track vocabulary at half strength) instead of the plaza's ring-
    // and-sector stonework. Absent means flagstones, so Threshold is untouched.
    plazaStyle: 'green',
    // NO CLIFF. cliff:false switches off groundBase's west ledge terms and
    // resolve()'s cliff clamp (the west bound becomes symmetric with the
    // other three sides). cliffX is a SENTINEL pushed past the frontier
    // lattice's own extent (285.6) so every consumer that compares against
    // it — prop scatter, navgrid walkable, POI validation — passes without
    // growing a flag of its own. Do not author walkable content past it.
    cliff: false,
    cliffX: -320,
    buildingBudget: 22,    // "~20 buildings" — the anchors run out near here anyway
    walkLimit: 134,
  },

  // Byte-equal to Threshold's — SHARED-LATTICE LAW.
  terrain: {
    cityEdge: [140, 156],
    vergeEdge: [264, 278],
    blend: [162, 170],
    stitch: [138, 155],
  },

  streets: {
    graph: EMBERFALL_STREETS,
    // Same trim vocabulary as Threshold: one kerb family per WORLD, not just
    // per settlement, until an owner asks for a second — mixed kerbs inside
    // one settlement was the bug B1 killed, and two settlements ten minutes
    // apart with different kerb hexes would read as an asset mistake.
    trim: {
      kerb: { color: 0x6e6a55, in: [-0.6, 0.1], out: [1.7, 3.0], strength: 0.8 },
      pave: { feather: [-0.6, 2.4] },
      track: { color: 0x9c8f74, feather: [-0.6, 2.4], strength: 0.85 },
    },
  },

  // ONE district profile — the hamlet — via layoutrules.layoutTablesFor:
  // `single` short-circuits districtOfPoint (whose ring radii are civic-town
  // shapes this village does not have), and the rules row overrides only what
  // a hamlet needs: no spire, no sightline corridors, no market strip, wider
  // frontage slack (farmstead looseness — anchors drift further off the
  // lane), and maxWing 4 so the biggest building is an 8 m farmhouse rather
  // than a 14 m terrace. Unnamed rule fields inherit Threshold's table
  // (spacing, anti-repetition) because those are world laws, not town taste.
  layout: {
    single: 'hamlet',
    profiles: {
      hamlet: {
        styles: ['timber', 'timber', 'timber', 'stone'],
        floors: [1, 2],
        roof: 'gable',
        chimneyChance: 0.55,
        props: 'fences, carts',
      },
    },
    rules: {
      frontageMax: 26,
      maxWing: 4,
      sightlineCorridors: [],
      // spire is the storey CEILING + 1 (city._layout clamps ordinary stock
      // to spire - 1), so 3 caps the hamlet at 2 storeys with no spire built.
      landmarkHeights: { spire: 3, civicRow: [2, 2], watchtowerVerge: 3 },
      spireSite: null,
      marketZone: null,
      zones: null,
    },
  },

  // Three banner areas. Consume by id, never index (Threshold's law). None
  // carries a service — the waystation is a walk-in like the tavern.
  districts: [
    { id: 'green', name: 'THE EMBER GREEN', pos: { x: 0, z: 0 }, pad: EF_GREEN_R, service: null },
    { id: 'wayrest', name: 'THE WAYREST', pos: { x: -20, z: 22 }, pad: 12, service: null },
    { id: 'end', name: 'THE VILLAGE END', pos: { x: 0, z: 48 }, pad: 14, service: null },
  ],

  // Two working gates + one INERT waygate slot. NO breach key: this village
  // has no S-rank wound outside it, and every breach consumer in the engine
  // now guards on the key's absence.
  portals: {
    ring: 13.5,   // the green's lip: dais edge kisses the grass ring
    placements: [
      // E on the green's edge — the village's teaching gate, framed from the
      // spawn exactly as Threshold's assay yard is. 205 deg puts it west-of-
      // south so the lane through stays clear.
      { id: 'green-e', rank: 'E', anchor: { kind: 'plaza-ring', angleDeg: 205 } },
      // D at the village's end, beside the south lane — the walk to it IS the
      // village tour.
      { id: 'end-d', rank: 'D', anchor: { kind: 'district', district: 'end', x: 6, z: 46 } },
      // WAYGATES (Wave B5 — travel is live; kind:'way' entries now build a
      // silver-white portal from _buildPortals' forked way stream, still
      // drawing ZERO from the main build stream, so the rank draws above are
      // byte-stable). Their sites were prop keep-outs since B4a; ids were
      // renamed from the inert placeholder 'way-threshold' — that id was
      // duplicated by THE_BIRCHREACH's slot, and ids are a WORLD-unique
      // contract now that return payloads cross settlements (the collision
      // fix the B5 task mandates: rename, because the ids never shipped in a
      // live portal record or a save).
      //
      // The green waygate pairs with Threshold's north-gate waygate.
      {
        id: 'way-emberfall-green',
        kind: 'way',
        to: { settlement: 'threshold', portalId: 'way-threshold-north' },
        anchor: { kind: 'district', district: 'green', x: -9, z: -32 },
      },
      // The village-end waygate pairs with THE BIRCHREACH's trailhead: past
      // end-d, where the south lane leaves the core for the barrow track —
      // the walk to the forest gate IS the walk out of the village. (-1,79):
      // 33.7 m from end-d (clears the 30 m portal-separation throw) and
      // 6.1 m off the barrow track's centerline — OUTSIDE the corridor law's
      // 5.3 m (track w/2 + corridor + dais), the same law its Birchreach
      // sibling was moved for. The first anchor (-2,78) sat at 4.88 m while
      // its comment claimed clearance — review fix.
      {
        id: 'way-emberfall-end',
        kind: 'way',
        to: { settlement: 'birchreach', portalId: 'way-birchreach-trail' },
        anchor: { kind: 'district', district: 'end', x: -1, z: 79 },
      },
    ],
  },

  // No doors carry prompts: the waystation is walk-in (the tavern pattern),
  // and an empty list keeps citymode's id-routed confirm table honest.
  interactables: [],

  // Warm amber dusk against Threshold's cool blue afternoon — authored off
  // the same structure and the same double-sRGB sky convention (the sky row
  // is the city row pre-brightened; see city._buildSkyAndLight's note).
  // Fog pulls slightly closer than Threshold's: hazy warm air reads as a
  // different HOUR, which is most of a region identity on the tiers that
  // never run the grade composite.
  palettes: {
    city: {
      fog: 0xdcc09a, ground: 0x6b6544, accent: 0xffc98e,
      sky: 0xd9a866, pillar: 0x9a8a78, detail: 0xf0e0c8,
    },
    sky: {
      fog: 0xf2e3ca, ground: 0xa89f7c, accent: 0xffe7c2,
      sky: 0xe9cba2, pillar: 0xc9bda8, detail: 0xf8f0e0,
    },
    fog: { near: 118, far: 400 },
    // The B6 grade row (glow.setGrade consumes it; citymode already applies
    // it per build). Subtle by design: a warm lift a viewer feels rather
    // than sees, and a 0.12 vignette — the composite is high-tier garnish,
    // the palette rows above are the identity that reaches every tier.
    grade: { lift: [0.012, 0.005, 0.0], glowSat: 1.0, vignette: 0.12 },
  },

  // The hamlet's furniture. No pillar ring, no market, no overlook. The one
  // "fountain" is the village WELL — the kit audit found no well piece
  // (citykit has no 'well' key), so town_fountain_round stands in; flagged
  // for the later Blender pass in the Wave B4a report.
  props: {
    plazaPillars: 0,
    fountains: [{ x: 4.5, z: -3 }],
    market: null,
    benchRow: { x0: 16, step: 4, n: 5, zBase: 14, zSpread: 2 },
    overlookBench: false,
  },

  // ONE enterable: the waystation, riding the tavern's ENTERABLES row
  // (structure/dressing stay interiors.js's; the settlement renames and
  // places it). marketZone/spireKeep are null — no market, no spire — and
  // _plotOk guards both.
  interiors: {
    marketZone: null,
    spireKeep: null,
    names: { tavern_row: 'THE WAYSTATION' },
    prefer: { tavern_row: { x: -20, z: 27 } },
  },

  // Meadow-only Verge: ONE band whose soft window exceeds the 180-degree
  // maximum angular distance, so its weight is 1 at every azimuth — the
  // whole compass is meadow with zero engine change. The key stays
  // 'east_meadow' ON PURPOSE: band keys are ALSO the species selector
  // (frontier.js SPECIES rows name the arcs they may grow in), so the meadow
  // key is what plants meadow trees everywhere and silently benches the
  // amberwood/ashreach species. Two POIs, NO wild gates (no wildGate stamps).
  verge: {
    limit: 258,
    poiMinR: 186,
    scatterIn: 152,
    poiFeather: 6,
    // Tuft lanes for the Verge's ground cover, matching this village's own
    // roads: east/west side lanes and the north/south lane through. Absent
    // means Threshold's shipped [0, 90, 270].
    lanes: [0, 90, 180, 270],
    poiRules: { minSep: 55, minWall: 30, minBreach: 40, maxSlope: 0.3, seamClear: 170 },
    bands: {
      east_meadow: { centre: 0, soft: [181, 190], arc: [-180, 180] },
    },
    pois: [
      {
        id: 'ember_wayfarers_camp',
        name: "THE WAYFARERS' CAMP",
        // North-east, at the end of the north side lane's track: travellers
        // stage here the way hunters stage east of Threshold.
        x: EF_POI_AT.ember_wayfarers_camp.x, z: EF_POI_AT.ember_wayfarers_camp.z,
        pad: 10, radius: 24, stamp: 'campHunters', npcs: 2, npcHunter: true,
      },
      {
        id: 'ember_barrow_ring',
        name: 'THE BARROW RING',
        // South-west — a direction Threshold can never use (its west is the
        // cliff void); the first landmark that says this town's compass is
        // different. Reuses the ruinArch stamp: old stones on a meadow.
        x: EF_POI_AT.ember_barrow_ring.x, z: EF_POI_AT.ember_barrow_ring.z,
        pad: 10, radius: 24, stamp: 'ruinArch',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// THE BIRCHREACH — the forest region (Wave B4b). NOT a town: a traversable
// woodland on the same settlement machinery, and the proof that the machinery
// generalises past "place with buildings" — zero buildings, no wall, no
// services, and the whole identity carried by a winding track, two clearings
// and the trees themselves.
// ---------------------------------------------------------------------------
//
// Identity in one line: a birch wood under close green air, one packed-earth
// spine winding through it with two branch tracks, a hunters' camp clearing at
// the end of one branch and a gate the forest kept quiet at the end of the
// other.
//
// SHARED-LATTICE LAW binds here exactly as it binds EMBERFALL (see that
// header): worldHalf / groundCell / the terrain bands are byte-equal to
// Threshold's, and a different-lattice region pays for the exports refactor
// city.js line ~100 posts the bill for.
//
// WHAT IS DELIBERATELY ABSENT, so nobody "fixes" it back in:
//   * buildings — buildingBudget 0 AND an all-'track' street graph (zero
//     'streets' edges means zero frontage anchors, so the layout cannot place
//     stock even if the budget said otherwise). interiors.prefer is empty for
//     the same reason: no enterable claims a plot.
//   * town crowd — crowd.town false (a forest full of strolling civilians is
//     the town simulation wearing the wrong coat). The PEOPLE out here are the
//     camp's hunters, stationed by the existing citizens/camp machinery off
//     the POI's npcs row.
//   * lanterns / market / benches / town trees / outskirt rocks — the props
//     pass is descriptor-gated row by row; a forest lights itself with sky.
//   * a breach — no key, so every breach consumer skips (Emberfall's law).

const BR_HALF = 64;        // region core half-extent; no wall stands on it
const BR_TRAILHEAD_R = 9;  // the trailhead clearing at the origin

// The two clearing anchors, hoisted so the branch-track termini and
// verge.pois read the SAME literals (VERGE_POIS' edit-drift rationale).
const BR_POIS = [
  { id: 'birchen_camp', x: 196, z: -60 },
  { id: 'birchreach', x: -70, z: 198 },
];
const BR_POI_AT = Object.fromEntries(BR_POIS.map((p) => [p.id, p]));

// The forest street graph: ONE winding spine (south end to north end through
// the trailhead — the street graph does curves as node chains) and TWO
// branches, one east to the camp clearing, one south-west to the hidden gate's
// clearing. EVERY edge is class 'track': this region has no built roads, so
// city.streets comes back EMPTY and everything keyed to it (lanterns, layout
// frontage, kerb paint) is silently, correctly absent. Edge order is the
// paint/rnd contract exactly as everywhere else.
//
// streets.trim.track.inside (below) un-gates the packed-earth paint from the
// r > wall.half rule: Threshold hides its paint cut inside wall-gate
// footprints and Emberfall closes it geometrically at +-half, but a forest
// spine RUNS THROUGH the core, so the whole polyline must paint or the road
// vanishes for 128 m and reappears.
const BIRCHREACH_TRACKS = (() => {
  const nodes = {
    // Trailhead lip (the green disc at the origin is the spawn clearing).
    trail_n: { x: 0, z: -BR_TRAILHEAD_R },
    trail_s: { x: 0, z: BR_TRAILHEAD_R },
    // South half of the spine, winding to the region's south end.
    s1: { x: -8, z: 34 },
    s2: { x: 12, z: 62 },
    s3: { x: -10, z: 92 },
    spine_s: { x: 4, z: 120 },
    // North half, winding to the north end.
    n1: { x: 14, z: -36 },
    n2: { x: -10, z: -68 },
    n3: { x: 12, z: -100 },
    spine_n: { x: -4, z: -126 },
    // Camp branch, east off n1.
    c1: { x: 58, z: -44 },
    c2: { x: 118, z: -50 },
    // Hidden-gate branch, south-west off s3 — the track ends at the clearing,
    // but nothing announces what stands in it (see the poi's hidden flag).
    w1: { x: -44, z: 120 },
    w2: { x: -58, z: 158 },
  };
  for (const p of BR_POIS) nodes[`poi_${p.id}`] = { x: p.x, z: p.z };
  const edges = [];
  const E = (a, b) => edges.push({ a, b, class: 'track', w: 3 });
  // Spine first (south chain then north chain — the walk the test asserts),
  // then the branches. Order is load-bearing: it is the paint order and the
  // draw-order contract for every rnd() consumer after buildStreets.
  E('trail_s', 's1'); E('s1', 's2'); E('s2', 's3'); E('s3', 'spine_s');
  E('trail_n', 'n1'); E('n1', 'n2'); E('n2', 'n3'); E('n3', 'spine_n');
  E('n1', 'c1'); E('c1', 'c2'); E('c2', 'poi_birchen_camp');
  E('s3', 'w1'); E('w1', 'w2'); E('w2', 'poi_birchreach');
  return { nodes, edges };
})();

export const THE_BIRCHREACH = {
  slug: 'birchreach',
  name: 'THE BIRCHREACH',  // display name — see THRESHOLD.name

  // Forked build stream (the per-new-content mulberry32 law) — 'BRCH'.
  seedSalt: 0x42524348,

  wall: {
    built: false,          // no wall — the boundary is the Verge blend (Emberfall's law)
    half: BR_HALF,
    worldHalf: 170,        // SHARED-LATTICE LAW
    groundCell: 3.4,
    plazaR: BR_TRAILHEAD_R,
    plazaStyle: 'green',   // the trailhead is trodden earth, not flagstone
    cliff: false,
    cliffX: -320,          // sentinel past the lattice — Emberfall's rationale
    buildingBudget: 0,     // zero buildings; see WHAT IS DELIBERATELY ABSENT
    // 146, not Threshold's 134: _natureSpotOk caps core scatter at
    // walkLimit - 6 = 140, which is EXACTLY verge.scatterIn below — the core
    // forest and the Verge's birch ring meet with no bare belt between them.
    walkLimit: 146,
  },

  terrain: {
    cityEdge: [140, 156],
    vergeEdge: [264, 278],
    blend: [162, 170],
    stitch: [138, 155],
    // NEW (B4b, optional key): the ground painter's dry-out band, authored
    // instead of derived from wall.half. The default derivation
    // [half-26, half+40] is a TOWN shape — ground wears dusty toward the
    // walls — and with half=64 it would parch the whole wood from r=38 out.
    // [200, 320] pushes the dry-out past the city field's own 170 m extent:
    // the forest floor stays forest-coloured everywhere it is visible.
    dryBand: [200, 320],
  },

  streets: {
    graph: BIRCHREACH_TRACKS,
    // One trim family per WORLD (Emberfall's rationale), plus the ONE forest
    // deviation: track.inside un-gates the packed-earth paint inside
    // r <= wall.half. See the graph's header for why a wall-less forest
    // cannot hide the cut line the gate was written for.
    trim: {
      kerb: { color: 0x6e6a55, in: [-0.6, 0.1], out: [1.7, 3.0], strength: 0.8 },
      pave: { feather: [-0.6, 2.4] },
      track: { color: 0x9c8f74, feather: [-0.6, 2.4], strength: 0.85, inside: true },
    },
  },

  // ONE rule-override set, no profiles (B4b, measured failure): with zero
  // 'streets' edges the layout has no frontage anchors and buildingBudget is
  // 0 — but the MODULE rules (Threshold's own, which layoutTablesFor hands
  // back when spec.layout is absent) also FORCE-place the civic spire at
  // rules.spireSite, which is how the "buildingless" first cut of this region
  // grew one stone tower deep in the wood (tools/forest-test.mjs caught it:
  // buildings 1, expected 0). Null every authored-site rule; the spacing and
  // anti-repetition entries inherit as world laws, though nothing here can
  // trip them.
  layout: {
    rules: {
      sightlineCorridors: [],
      spireSite: null,
      marketZone: null,
      zones: null,
    },
  },

  // Three named stretches of the wood — banner areas AND small carved-level
  // scatter keep-outs, which is what makes each one read as a clearing along
  // the spine (the district pad is the existing "clearing" machinery; no new
  // engine). whitewood/hollow sit ON spine nodes n2/s2 so the walk crosses
  // all three names end to end. Consume by id, never index.
  districts: [
    { id: 'trailhead', name: 'THE BIRCHREACH', pos: { x: 0, z: 0 }, pad: BR_TRAILHEAD_R, service: null },
    { id: 'whitewood', name: 'THE WHITE WOOD', pos: { x: -10, z: -68 }, pad: 8, service: null },
    { id: 'hollow', name: 'THE LEANING HOLLOW', pos: { x: 12, z: 62 }, pad: 8, service: null },
  ],

  // NO rank portals: the region's only gate is the Verge's hidden wild E
  // (verge.pois below → portal id 'wild-birchreach', frontier's 'wild-' + poi
  // id law). The ONE placement is the waygate (Wave B5 — travel is live),
  // paired with Emberfall's village-end gate. ring is cosmetic here (mapui
  // draws it); no plaza-ring anchor exists to consume it.
  //
  // The anchor MOVED from the inert slot's (-7,18) to (-16,14): active
  // waygates carry the 2.6 m dais collider the inert keep-out never did, and
  // at (-7,18) that dais sat 3.9 m off the spine's trail_s→s1 centerline —
  // inside the builder's own corridor law (track w/2 + corridor 1.2 + solid
  // 2.6 = 5.3 m). 13.7 m off the centerline now; still on the trailhead
  // clearing's shoulder, and _spawnVector's step-out along the facing lands
  // an arriving traveller looking at the clearing. Id renamed from the
  // duplicated 'way-threshold' placeholder — see EMBERFALL's rationale.
  portals: {
    ring: BR_TRAILHEAD_R,
    placements: [
      {
        id: 'way-birchreach-trail',
        kind: 'way',
        to: { settlement: 'emberfall', portalId: 'way-emberfall-end' },
        anchor: { kind: 'district', district: 'trailhead', x: -16, z: 14 },
      },
    ],
  },

  // Nothing to prompt: no doors, no services. An empty list keeps citymode's
  // id-routed confirm table honest (Emberfall's law).
  interactables: [],

  // Close green air against Threshold's open blue and Emberfall's warm amber.
  // Fog pulls WELL in (78/300 vs Threshold's 130/430): under canopy the world
  // ends early, and dense fog is the canopy this build does not model — the
  // zero-PointLight, no-new-lighting law says mood is palette + fog + grade,
  // nothing else. Same double-sRGB sky convention as both towns.
  palettes: {
    city: {
      fog: 0xaebfa8, ground: 0x4c5c40, accent: 0xd9ecc0,
      sky: 0x8fae8e, pillar: 0x778272, detail: 0xdae6d2,
    },
    sky: {
      fog: 0xdfe9d8, ground: 0x93a583, accent: 0xf0f8dd,
      sky: 0xc2d8b8, pillar: 0xb8c2ae, detail: 0xeaf2e2,
    },
    fog: { near: 78, far: 300 },
    // The B6 grade row: a green lift, a touch of desaturation on the glow
    // pass and a heavier vignette than Emberfall's — the composite's share of
    // "under the canopy". Subtle by the same argument as Emberfall's row: the
    // palette above is the identity that reaches every tier.
    grade: { lift: [-0.006, 0.01, -0.004], glowSat: 0.95, vignette: 0.2 },
  },

  // The props pass, told to stand down row by row (each gate is descriptor
  // data; absent means the shipped town behaviour):
  //   townTrees/outskirtRocks false — the citykit's town_tree/town_rock
  //   families are a different silhouette language from the naturekit birches
  //   and would read as two forests interleaved (kit-mixing, the exact
  //   cohesion failure this program exists to kill).
  props: {
    plazaPillars: 0,
    fountains: [],
    market: null,
    benchRow: null,
    overlookBench: false,
    townTrees: false,
    outskirtRocks: false,
  },

  // No enterables (empty prefer = every ENTERABLES row skipped, the
  // absent-key law interiors._findPlot already enforces).
  interiors: {
    marketZone: null,
    spireKeep: null,
    prefer: {},
  },

  // No town roster (see the header). Camp hunters still spawn: citizens'
  // _spawnCamps reads the BUILT poi records, not this key.
  crowd: { town: false },

  // THE FOREST ITSELF (B4b, new descriptor key): heavy naturekit density
  // fields for the CORE — the region _natureSpotOk governs, which the
  // Threshold-tuned base scatter table only dusts. city._buildNature walks
  // these rows AFTER its base table (absent key = zero extra rnd() draws =
  // Threshold/Emberfall byte-identical), sampling 55% along the track verges
  // and the rest uniformly, through the same _natureSpotOk honesty gate:
  // solids join city.obstacles as real colliders, and _blockedForProp keeps
  // everything corridor-plus-clearance off every track centerline — the
  // walkable-corridor law tools/forest-test.mjs asserts with a real body.
  //
  // Species are the audit's birch-leaning mix, every key verified against
  // public/models/nature.json (nothing missing, no procedural stand-ins
  // needed): three white-bark birches + one autumn accent, a sparse common
  // tree so the wood is not a monoculture, moss stumps/logs as forest floor,
  // and plant/bush underbrush. Counts are at density 1 (~400 trees in the
  // core — the first cut's ~226 read as parkland from the air, and the
  // measured walk had 95 draws of headroom under Threshold's own budget, so
  // the wood spent some of it on being a wood) and thin with the quality
  // governor exactly like every other field.
  nature: {
    corridor: 1.2,          // solid clearance past a track's w — the corridor law
    rows: [
      { key: 'birchtree_2', n: 110, s: [0.95, 1.5], solid: 0.6 },
      { key: 'birchtree_3', n: 100, s: [0.9, 1.45], solid: 0.6 },
      { key: 'birchtree_4', n: 90, s: [0.95, 1.55], solid: 0.6 },
      { key: 'birchtree_autumn_2', n: 70, s: [0.9, 1.4], solid: 0.6 },
      { key: 'commontree_3', n: 32, s: [0.95, 1.5], solid: 0.75 },
      { key: 'treestump_moss', n: 20, s: [0.8, 1.2], solid: 0.45 },
      { key: 'woodlog_moss', n: 14, s: [0.85, 1.25], solid: 0.5 },
      { key: 'plant_2', n: 110, s: [0.9, 1.4], sy: [0.6, 0.85], solid: 0, clump: true },
      { key: 'bush_2', n: 40, s: [0.8, 1.15], solid: 0.7, clump: true },
    ],
  },

  // The Verge: the same birch wood continuing outward. scatterIn 140 meets
  // the core cap (see wall.walkLimit); 140 also sits INSIDE the stitch band
  // [138,155] where the two height fields have converged, so a tree placed at
  // frontier height cannot float above the city mesh the player walks on.
  verge: {
    limit: 258,
    poiMinR: 186,
    scatterIn: 140,
    poiFeather: 6,
    // The floor stays FOREST (B4b engine keys, both absent-means-shipped):
    //   tones — repaint the amberwood band green without renaming it (the
    //   key is the species selector; renaming it would bench every birch).
    //   Slightly deeper than the city grass trio so the outer wood reads as
    //   shade, not lawn.
    //   dryFade — strength 0: the shipped tan ring belongs to walled towns
    //   sitting in worn ground; here it painted a dead belt exactly at the
    //   core-mesh/annulus handover.
    tones: {
      south_amberwood: { base: 0x5f7a44, drift1: 0x87914a, drift2: 0x476b46 },
    },
    dryFade: { r: [148, 184], strength: 0 },
    // Tuft lanes follow THIS region's tracks: the spine runs north (270) and
    // south (90), the camp branch east (~0), the gate branch south-west
    // (~110 — azimuth of (-70,198) in frontier.js's EAST=0/SOUTH=90 frame).
    lanes: [0, 90, 110, 270],
    poiRules: { minSep: 55, minWall: 30, minBreach: 40, maxSlope: 0.3, seamClear: 170 },
    // ONE band, the Emberfall full-compass trick (soft window > the 180 deg
    // maximum angular distance = weight 1 everywhere). The key is
    // 'south_amberwood' ON PURPOSE: band keys select species (frontier.js
    // SPECIES), and amberwood is where the birches live — this is what turns
    // the whole ring birch and benches the meadow/ashreach species. Centre
    // keeps the band's Threshold value; with full weight it only steers the
    // ground palette's cross-fade, which has nothing to fade to.
    bands: {
      south_amberwood: { centre: 115, soft: [181, 190], arc: [-180, 180] },
    },
    pois: [
      {
        id: 'birchen_camp',
        name: 'THE BIRCHEN CAMP',
        // East, at the end of the camp branch: hunters staging in a clearing,
        // the existing campHunters stamp + citizens camp machinery whole.
        x: BR_POI_AT.birchen_camp.x, z: BR_POI_AT.birchen_camp.z,
        pad: 10, radius: 24, stamp: 'campHunters', npcs: 2, npcHunter: true,
      },
      {
        id: 'birchreach',
        name: 'A GATE THE FOREST KEPT',
        // South-west clearing. HIDDEN: the flag rides the built poi onto the
        // wild portal ('wild-birchreach' — the mandated id, from frontier's
        // 'wild-' + poi.id law), which keeps it off the compass until the
        // clearing itself is discovered on foot. E rank: the region's
        // teaching gate, it just doesn't advertise.
        x: BR_POI_AT.birchreach.x, z: BR_POI_AT.birchreach.z,
        pad: 12, radius: 24, stamp: 'wildGate', rank: 'E', hidden: true,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// THE REGISTRY (Wave B5) — slug -> descriptor, the one lookup travel speaks.
// ---------------------------------------------------------------------------
// citymode resolves `payload.settlement ?? game.settlementSpec ?? save.settlement
// ?? 'threshold'` through this table; main.js and mapui read it for the same
// slugs. It lives HERE because this file is the dependency-free leaf every
// consumer can already reach, and because a travel payload naming a slug that
// is not in this table must fail in exactly one place.
//
// INVARIANTS the table carries (tools/travel-test.mjs asserts both):
//   * every portals.placements id is unique across ALL settlements — return
//     payloads (game.lastGatePortalId, waygate `to.portalId`) cross settlement
//     boundaries, so id collisions would teleport travellers to the wrong town;
//   * every kind:'way' entry's `to` names a registry slug and an existing
//     placement id in that settlement (the links are hand-authored pairs).
export const SETTLEMENTS = {
  threshold: THRESHOLD,
  emberfall: EMBERFALL,
  birchreach: THE_BIRCHREACH,
};
