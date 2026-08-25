// PER-RANK IDENTITY ROWS — Wave E task E-S item 2.
//
// One table, one shape, six ranks: what makes an E gate FEEL different from an
// S gate beyond its layout kind, made SYSTEMATIC instead of scattered across
// mode constants. dungeonmode.js is the only consumer — it applies a row on
// enter() and restores the shipped defaults on exit(). THREE-free data (plain
// numbers and string keys) so headless tooling can read the table.
//
// FIELD CONTRACT (absent-means-default, the save format's rule — a null field
// keeps the shipped behaviour bit for bit):
//
//   biome        the rank's canonical BIOMES row id (config.js). Informational
//                here — gate.biome already carries it (and anomalies swap it);
//                the row records the canon so the table IS the identity sheet.
//   fogScale     fog DENSITY multiplier, applied by dungeonmode after the
//                world builds: near/far are DIVIDED by it, so > 1 is thicker
//                air, < 1 clearer. Layered ON TOP of the per-rank fog planes
//                LAYOUT_PARAMS already carries — that pair is sized to the
//                geometry ("far must clear the room"), this knob is mood.
//                Kept subtle at E/D/C on purpose: the ask is systematic, not
//                loud.
//   cam          interior follow-rig override { y, z } (the boom dungeonmode's
//                INTERIOR_CAM defaults). Slightly steeper/closer on the
//                vertical kinds (the tower's terraces and the reach's summit
//                read better from above), longer/flatter on the open waste.
//                null = the shared default.
//   camOffset    THE per-rank override seam for game.js's shared camOffset
//                (the OPEN/arena rig — reachable via the forceOpen dev
//                override now that every rank mounts an interior).
//                dungeonmode applies it on enter and restores the previous
//                vector on exit; game.js's camOffset READ is untouched. All
//                null today — the arena framing is owner-approved — but the
//                seam is live and a row edit is all a retune takes.
//   introKey     strings.js key for the gate's intro card line (fired at
//                intro end alongside the rank toast; Wave G's card surface
//                consumes the same key when it lands).
//   glowStrength glow.setStrength set-piece value for the run (shipped
//                default is 0.85 = MAX_STRENGTH; lower reads calmer). The
//                low ranks sit a notch under full so the climb up the ladder
//                is also a climb in bloom; restored on exit.
//   grade        glow.setGrade row ({ lift, glowSat, vignette } — Wave B6's
//                composite uniforms; high-tier garnish only, lower tiers ride
//                the palette/fog rows by design). null = shipped look.
export const RANK_IDENTITY = {
  E: {
    biome: 'warren',
    fogScale: 1.0,
    cam: null,
    camOffset: null,
    introKey: 'gate.intro.E',
    glowStrength: 0.72,
    grade: null,
  },
  D: {
    biome: 'ossuary',
    fogScale: 1.05,           // the ossuary hangs a little heavier
    cam: null,
    camOffset: null,
    introKey: 'gate.intro.D',
    glowStrength: 0.74,
    grade: { vignette: 0.06 },
  },
  C: {
    biome: 'deepglass',
    fogScale: 0.96,           // deepglass air is cold and clear
    cam: null,
    camOffset: null,
    introKey: 'gate.intro.C',
    glowStrength: 0.78,
    grade: { glowSat: 1.0, vignette: 0.04 },
  },
  B: {
    biome: 'emberfall',
    fogScale: 1.0,
    cam: { y: 16.6, z: 12.4 },   // steeper: the terraces stack in frame
    camOffset: null,
    introKey: 'gate.intro.B',
    glowStrength: 0.8,
    grade: { lift: [0.018, 0.006, 0], vignette: 0.1 },
  },
  A: {
    biome: 'rivenwaste',
    fogScale: 1.1,            // the waste breathes haze between the sites
    cam: { y: 14.8, z: 14.6 },   // longer + flatter: open-field read
    camOffset: null,
    introKey: 'gate.intro.A',
    glowStrength: 0.82,
    grade: { lift: [0.01, 0.004, 0.018], vignette: 0.08 },
  },
  S: {
    biome: 'archonreach',
    fogScale: 0.94,           // the summit must read to its collapsing rim
    cam: { y: 16.8, z: 12.0 },   // steepest boom in the game: the arena is a disc
    camOffset: null,
    introKey: 'gate.intro.S',
    glowStrength: 0.85,       // full send — MAX_STRENGTH, the set-piece rank
    grade: { lift: [0.02, 0, 0.01], glowSat: 0.92, vignette: 0.14 },
  },
};

export default RANK_IDENTITY;
