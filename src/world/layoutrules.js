// ---------------------------------------------------------------------------
// TOWN LAYOUT RULES — the placement contract, as data
// ---------------------------------------------------------------------------
//
// WORLD_SPEC step 8. Kevin Lynch's five imageability elements mapped onto
// Threshold, so the numbers below are principled rather than taste:
//
//   PATHS     streets with building frontage      -> frontageMax, doors face the street
//   EDGES     the wall and the west cliff         -> already built, untouched here
//   DISTRICTS per-district identity profiles      -> DISTRICT_PROFILES
//   NODES     the plaza and the three land gates  -> sightlineCorridors protect them
//   LANDMARKS the Assay spire, the portal ring    -> landmarkHeights
//
// The owner's note — "things are duplicated for no reason" — is the
// anti-repetition rule, and it is the reason this file exists as DATA rather
// than as constants scattered through city.js: city._layout enforces these
// numbers while it places, and validateLayout() asserts the same numbers off
// the retained layout metadata. One source of truth, two consumers, so a
// builder that quietly stops enforcing a rule fails a test instead of shipping.
//
// DEPENDENCY-LIGHT ON PURPOSE: no THREE, no city.js. node imports this module
// directly in tools/, and city.js imports it, so a cycle here would be fatal.
// Every geometric helper it needs is a dozen lines and lives at the bottom.

/**
 * The parameter table. Distances are metres, floors are storeys of KIT_STOREY
 * (2.0 m) each.
 */
export const LAYOUT_RULES = {
  /** Max metres from a street for a building anchor. Codifies what _layout already did. */
  frontageMax: 22,

  /**
   * Walking in any LAND gate must show the plaza's pillar ring and the spire
   * behind it. Buildings whose footprint intersects one of these strips are
   * capped at maxFloors, which carves a low channel down each avenue.
   *
   * Three, not four: the west avenue ends at the cliff, not at a gate.
   */
  sightlineCorridors: [
    { id: 'north', from: { x: 0, z: -88 }, to: { x: 0, z: 0 }, halfWidth: 8, maxFloors: 2 },
    { id: 'east', from: { x: 88, z: 0 }, to: { x: 0, z: 0 }, halfWidth: 8, maxFloors: 2 },
    { id: 'south', from: { x: 0, z: 88 }, to: { x: 0, z: 0 }, halfWidth: 8, maxFloors: 2 },
  ],

  /**
   * Same-type minimum distances.
   *
   * `stalls_outside_market` is deliberately absurd: a market stall outside the
   * Exchange's market strip is not "too close to another stall", it is in the
   * wrong district, and 9999 is how that reads as one uniform rule instead of
   * a special case.
   *
   * `identicalSilhouettePair` is the anti-duplication rule in its spatial
   * form: two buildings whose centres are within 12 m may not share all three
   * of { style, floors, ridge orientation }.
   */
  minSpacing: {
    fountains: 45,
    benches: 6,
    stalls_outside_market: 9999,
    poi_frontier: 55,
    identicalSilhouettePair: 12,
  },

  /** Along any one street, at most this many consecutive identical tuples. */
  antiRepetition: { maxIdenticalRun: 2 },

  /** Every district pad must reach the plaza in at most this many turns. */
  desireLines: { everyDistrictPadToPlazaTurns: 1 },

  /**
   * Exactly ONE 5-storey building exists (the Assay spire). The frontier
   * watchtower is the only >2-storey structure outside the walls; that one is
   * frontier.js's to honour and is recorded here so both files read the same
   * table.
   */
  landmarkHeights: {
    spire: 5,
    civicRow: [3, 4],
    watchtowerVerge: 3,
  },

  /**
   * How a point becomes a district: three concentric bands, then Voronoi.
   *
   *   r <= plazaRingR    the civic ring that FACES the plaza
   *   r >  outskirtsR    the corner blocks against the wall
   *   otherwise          whichever service pad is nearest
   *
   * The radii are tuned against the real buildable area, which is the thing
   * that decides the skyline. A first cut put a claim radius around each
   * service pad and ran the bands after it; every pad sits inside 52 m of the
   * plaza, so the claims swallowed the civic ring entirely (zero plaza_ring
   * buildings) and two thirds of the town fell past the outskirts radius into
   * the one-storey timber profile — a FLATTER town than before the step, which
   * is the exact opposite of what was asked for. Bands first, no claims.
   */
  zones: {
    // The ring road sits at 58 m, so "inside the ring road" is both the civic
    // core and a boundary the player can see. A first pass used 44 and put
    // two buildings in the whole civic ring, which meant the roof_high family
    // cost three permanent draw calls to dress two houses.
    plazaRingR: 58,
    outskirtsR: 96,
    /** Districts that own building stock. `plaza` and `breach` are places, not quarters. */
    quarters: ['assay', 'ashworks', 'exchange', 'row'],
  },

  /**
   * The Exchange's market strip. Stalls live here and nowhere else; the
   * validator uses it to give minSpacing.stalls_outside_market something to
   * measure against.
   */
  marketZone: { x0: -18, x1: 10, z0: 24, z1: 68 },

  /** The spire wants to stand beside the north avenue, not in it. */
  spireSite: { prefer: { x: 16, z: -38 }, minAbsX: 11, maxR: 30 },
};

/**
 * Per-district identity. `floors` is an inclusive [min, max] range; `styles` is
 * a BAG, so a repeated entry weights that style (Quarter Row is mostly timber).
 *
 * `roof` is the family city._buildBuildings switches on:
 *   'gable' town_roof pair, left/right pieces closing both ends
 *   'high'  town_roof_high pair, high left/right closing both ends
 *   'flat'  town_roof_flat deck ringed by a town_wall_half parapet
 *   'spire' flat + parapet + a scaled town_roof_high_point cap
 */
export const DISTRICT_PROFILES = {
  plaza_ring: { styles: ['stone', 'civic'], floors: [3, 4], roof: 'high', props: 'pillars+banners' },
  // floors[1] is 5 because the SPIRE lives in this quarter. Ordinary assay
  // buildings are clamped to landmarkHeights.spire - 1 by the builder — there
  // is exactly one 5-storey building in town and it is not chosen at random.
  //
  // `roof: 'high'`, not 'flat': the spec's flat+parapet+roof_point line
  // describes the SPIRE, and giving the whole quarter flat decks cost two
  // permanent instanced fields (town_roof_flat, town_wall_half) for a look
  // nobody asked for. The spire still gets flat+parapet+point — as ONE merged
  // mesh, because it is one building and an InstancedMesh with a single
  // instance is a draw call with no pool behind it.
  assay: { styles: ['stone'], floors: [3, 5], roof: 'high', chimneyChance: 0.25, props: 'braziers' },
  ashworks: { styles: ['stone', 'brick'], floors: [2, 3], roof: 'gable', chimneyChance: 0.6, props: 'barrels, carts' },
  exchange: { styles: ['brick', 'timber'], floors: [2, 3], roof: 'gable', awnings: true, props: 'stalls+carts' },
  // Chimneys earn their instanced field on the Row: a 1-2 storey cottage with
  // a stack is the cheapest silhouette variation in the kit, and a field of 7
  // instances is a draw call spent on nothing.
  row: { styles: ['timber', 'timber', 'stone'], floors: [1, 2], roof: 'gable', chimneyChance: 0.4, props: 'hedges, fences, benches' },
  outskirts: { styles: ['timber'], floors: [1, 1], roof: 'gable', chimneyChance: 0.3, props: 'rocks' },
};

/**
 * Which quarter a point belongs to.
 *
 * `districts` is city.districts (the TOWN_DISTRICTS table) so the pads are not
 * duplicated here — if a district moves, this follows it.
 */
export function districtOfPoint(x, z, districts) {
  const Z = LAYOUT_RULES.zones;
  const rr = Math.hypot(x, z);
  if (rr <= Z.plazaRingR) return 'plaza_ring';
  if (rr > Z.outskirtsR) return 'outskirts';
  let best = null;
  let bestD = Infinity;
  for (const d of districts) {
    if (!Z.quarters.includes(d.id)) continue;
    const r = Math.hypot(x - d.pos.x, z - d.pos.z);
    if (r < bestD) { bestD = r; best = d.id; }
  }
  return best || 'outskirts';
}

/** The silhouette tuple the anti-repetition rules compare. */
export function silhouetteTuple(b) {
  return `${b.style}|${b.floors}|${b.ridgeAlongZ ? 'z' : 'x'}`;
}

/**
 * Total order along one street.
 *
 * The tie-breakers are load-bearing, not tidiness: buildings sit on a 2 m
 * grid, so plenty of them project to the SAME t (the pair facing each other
 * across a street, most obviously). With `streetT` alone the builder's
 * insertion order and the validator's sort disagreed about which of the tied
 * buildings came first, a run of 2 became a run of 3 after re-sorting, and the
 * validator failed a layout the builder had checked. Same comparator both
 * sides, no ties left.
 */
export function compareAlongStreet(a, b) {
  return (a.streetT - b.streetT) || (a.cx - b.cx) || (a.cz - b.cz);
}

/** The footprint rect of a layout entry, in metres. */
export function footprintRect(b) {
  return { x0: b.cx - b.w / 2, x1: b.cx + b.w / 2, z0: b.cz - b.d / 2, z1: b.cz + b.d / 2 };
}

/**
 * The tightest sightline cap that applies to a footprint, or Infinity.
 * Used by the builder while placing and by the validator afterwards, so the
 * two can never disagree about which buildings are "in the corridor".
 */
export function corridorCap(b) {
  const r = footprintRect(b);
  let cap = Infinity;
  for (const c of LAYOUT_RULES.sightlineCorridors) {
    if (segRectDistance(c.from.x, c.from.z, c.to.x, c.to.z, r) <= c.halfWidth) {
      cap = Math.min(cap, c.maxFloors);
    }
  }
  return cap;
}

// ---------------------------------------------------------------------------
// validateLayout
// ---------------------------------------------------------------------------

/**
 * Assert every rule above against a BUILT city. Dev/harness only — nothing on
 * the device calls this, and city.js never imports it.
 *
 * Reads: city.layoutMeta (the retained _layout output), city.streets,
 * city.districts and city.propMeta. Returns violations rather than throwing so
 * a tool can print all of them at once instead of one per run.
 */
export function validateLayout(city) {
  const violations = [];
  const bad = (rule, detail) => violations.push({ rule, detail });

  const B = city?.layoutMeta;
  if (!Array.isArray(B) || B.length === 0) {
    bad('layoutMeta', 'city.layoutMeta is missing or empty — _layout did not retain its output');
    return { ok: false, violations, buildings: 0 };
  }
  const streets = city.streets || [];
  if (!streets.length) bad('streets', 'city.streets is empty');

  // -- frontage ------------------------------------------------------------
  for (const b of B) {
    let near = Infinity;
    for (const s of streets) near = Math.min(near, pointSegDistance(b.ax, b.az, s));
    if (near > LAYOUT_RULES.frontageMax + 1e-6) {
      bad('frontage', `${b.id} anchor is ${near.toFixed(1)} m from the nearest street (max ${LAYOUT_RULES.frontageMax})`);
    }
  }

  // -- district profiles ---------------------------------------------------
  for (const b of B) {
    const p = DISTRICT_PROFILES[b.district];
    if (!p) { bad('profile', `${b.id} has unknown district "${b.district}"`); continue; }
    if (b.isSpire) continue;                        // the landmark has its own rule
    if (!p.styles.includes(b.style)) {
      bad('profile.style', `${b.id} is ${b.style} in ${b.district} (allowed: ${p.styles.join('/')})`);
    }
    if (b.floors < p.floors[0] || b.floors > p.floors[1]) {
      // A corridor cap legitimately pushes a building BELOW its profile floor.
      if (!(b.floors === b.cap && b.floors < p.floors[0])) {
        bad('profile.floors', `${b.id} has ${b.floors} floors in ${b.district} (profile ${p.floors[0]}..${p.floors[1]}, cap ${b.cap})`);
      }
    }
  }

  // -- sightline corridors -------------------------------------------------
  for (const b of B) {
    const cap = corridorCap(b);
    if (Number.isFinite(cap) && b.floors > cap) {
      bad('corridor', `${b.id} is ${b.floors} floors inside a sightline corridor capped at ${cap}`);
    }
  }

  // -- landmarks -----------------------------------------------------------
  const spires = B.filter((b) => b.isSpire);
  const fives = B.filter((b) => b.floors >= LAYOUT_RULES.landmarkHeights.spire);
  if (spires.length !== 1) bad('landmark.spire', `${spires.length} buildings are flagged as the spire, spec says exactly 1`);
  if (fives.length !== 1 || (fives[0] && !fives[0].isSpire)) {
    bad('landmark.spire', `${fives.length} buildings reach ${LAYOUT_RULES.landmarkHeights.spire} floors, spec says exactly 1 and it must be the spire`);
  }
  if (spires.length === 1) {
    const spire = spires[0];
    if (spire.floors !== LAYOUT_RULES.landmarkHeights.spire) {
      bad('landmark.spire', `the spire is ${spire.floors} floors, spec says ${LAYOUT_RULES.landmarkHeights.spire}`);
    }
    for (const b of B) {
      if (b === spire) continue;
      if (b.topY >= spire.topY) {
        bad('landmark.spire', `${b.id} tops out at ${b.topY.toFixed(1)} m, at or above the spire's ${spire.topY.toFixed(1)} m`);
      }
    }
    if (Number.isFinite(corridorCap(spire))) {
      bad('landmark.spire', 'the spire stands INSIDE a sightline corridor — it must be the background, not the obstruction');
    }
  }
  const civic = LAYOUT_RULES.landmarkHeights.civicRow;
  for (const b of B) {
    if (b.district !== 'plaza_ring' || b.isSpire) continue;
    if (Number.isFinite(b.cap) && b.cap < civic[0]) continue;   // corridor wins
    if (b.floors < civic[0] || b.floors > civic[1]) {
      bad('landmark.civicRow', `plaza-ring ${b.id} has ${b.floors} floors, civic row is ${civic[0]}..${civic[1]}`);
    }
  }
  for (const b of B) {
    if (Math.abs(b.cx) > 88 || Math.abs(b.cz) > 88) {
      bad('landmark.outsideWall', `${b.id} stands outside the wall at (${b.cx.toFixed(0)}, ${b.cz.toFixed(0)})`);
    }
  }

  // -- anti-repetition: pairwise ------------------------------------------
  const pairR = LAYOUT_RULES.minSpacing.identicalSilhouettePair;
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      if (silhouetteTuple(B[i]) !== silhouetteTuple(B[j])) continue;
      const dd = Math.hypot(B[i].cx - B[j].cx, B[i].cz - B[j].cz);
      if (dd < pairR) {
        bad('minSpacing.identicalSilhouettePair',
          `${B[i].id} and ${B[j].id} are both ${silhouetteTuple(B[i])} and only ${dd.toFixed(1)} m apart (min ${pairR})`);
      }
    }
  }

  // -- anti-repetition: runs along a street --------------------------------
  const maxRun = LAYOUT_RULES.antiRepetition.maxIdenticalRun;
  const byStreet = new Map();
  for (const b of B) {
    if (b.street == null) continue;
    if (!byStreet.has(b.street)) byStreet.set(b.street, []);
    byStreet.get(b.street).push(b);
  }
  for (const [sid, list] of byStreet) {
    list.sort(compareAlongStreet);
    let run = 1;
    for (let i = 1; i < list.length; i++) {
      run = silhouetteTuple(list[i]) === silhouetteTuple(list[i - 1]) ? run + 1 : 1;
      if (run > maxRun) {
        bad('antiRepetition.run',
          `street ${sid} has ${run} consecutive ${silhouetteTuple(list[i])} buildings (max ${maxRun}) at ${list[i].id}`);
      }
    }
  }

  // -- occupancy: no two footprints overlap --------------------------------
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j];
      if (a.ci + a.wc - 1 < b.ci || b.ci + b.wc - 1 < a.ci) continue;
      if (a.cj + a.dc - 1 < b.cj || b.cj + b.dc - 1 < a.cj) continue;
      bad('overlap', `${a.id} and ${b.id} share cells`);
    }
  }

  // -- doorways ------------------------------------------------------------
  //
  // A doorway must open onto somewhere you can stand: not into another
  // building's footprint, and within reach of a street. The navgrid's own
  // walkability is re-checked by the nav suite; this is the layout half of it,
  // which is the half a placement bug shows up in.
  for (const b of B) {
    if (!b.door) { bad('doorway', `${b.id} has no doorway`); continue; }
    let near = Infinity;
    for (const s of streets) near = Math.min(near, pointSegDistance(b.door.outX, b.door.outZ, s));
    if (near > LAYOUT_RULES.frontageMax + 4) {
      bad('doorway', `${b.id}'s doorway opens ${near.toFixed(1)} m from the nearest street`);
    }
    for (const o of B) {
      if (o === b) continue;
      const r = footprintRect(o);
      if (b.door.outX >= r.x0 && b.door.outX <= r.x1 && b.door.outZ >= r.z0 && b.door.outZ <= r.z1) {
        bad('doorway', `${b.id}'s doorway opens into ${o.id}`);
      }
    }
  }

  // -- desire lines --------------------------------------------------------
  //
  // Walk the street graph: level 0 is any segment that touches the plaza, and
  // a pad reached from a level-1 segment is one turn from the plaza. This is
  // the assertion that survives a future street edit, which is the only reason
  // the rule is worth encoding — it is trivially true of today's plan.
  const level = streetLevels(streets, LAYOUT_RULES.zones.plazaRingR);
  const maxTurns = LAYOUT_RULES.desireLines.everyDistrictPadToPlazaTurns;
  for (const d of city.districts || []) {
    if (d.id === 'plaza') continue;
    let bestIdx = -1, bestD = Infinity;
    streets.forEach((s, i) => {
      const dd = pointSegDistance(d.pos.x, d.pos.z, s);
      if (dd < bestD) { bestD = dd; bestIdx = i; }
    });
    const lv = bestIdx >= 0 ? level[bestIdx] : Infinity;
    if (!(lv <= maxTurns)) {
      bad('desireLines', `${d.id} reaches the plaza in ${lv === Infinity ? 'no' : lv} turns (max ${maxTurns})`);
    }
  }

  // -- prop spacing --------------------------------------------------------
  const P = city.propMeta || {};
  const spacing = (list, min, label) => {
    const pts = list || [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dd = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
        if (dd < min) bad(`minSpacing.${label}`, `two ${label} are ${dd.toFixed(1)} m apart (min ${min})`);
      }
    }
  };
  spacing(P.fountains, LAYOUT_RULES.minSpacing.fountains, 'fountains');
  spacing(P.benches, LAYOUT_RULES.minSpacing.benches, 'benches');
  const M = LAYOUT_RULES.marketZone;
  for (const s of P.stalls || []) {
    if (s.x < M.x0 || s.x > M.x1 || s.z < M.z0 || s.z > M.z1) {
      bad('minSpacing.stalls_outside_market', `a stall stands at (${s.x.toFixed(1)}, ${s.z.toFixed(1)}), outside the Exchange market strip`);
    }
  }

  return { ok: violations.length === 0, violations, buildings: B.length };
}

// ---------------------------------------------------------------------------
// geometry — small, local, THREE-free
// ---------------------------------------------------------------------------

/** Distance from a point to a street segment {x1,z1,x2,z2}. */
export function pointSegDistance(x, z, s) {
  const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - s.x1) * dx + (z - s.z1) * dz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(x - (s.x1 + dx * t), z - (s.z1 + dz * t));
}

/** Where along a street segment a point projects, normalised 0..1. */
export function segParam(x, z, s) {
  const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
  const l2 = dx * dx + dz * dz;
  if (l2 <= 0) return 0;
  return Math.min(1, Math.max(0, ((x - s.x1) * dx + (z - s.z1) * dz) / l2));
}

function pointRectDistance(px, pz, r) {
  const dx = Math.max(r.x0 - px, 0, px - r.x1);
  const dz = Math.max(r.z0 - pz, 0, pz - r.z1);
  return Math.hypot(dx, dz);
}

function segsCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Distance from a segment to an axis-aligned rect; 0 when they touch.
 *
 * The explicit edge-crossing test is not redundant with the corner/endpoint
 * minima: an avenue that runs clean THROUGH a building has both endpoints far
 * outside the rect and all four corners far from the line, and a corner-only
 * implementation reports a comfortable 10 m clearance for a wall standing in
 * the middle of the road.
 */
export function segRectDistance(x1, z1, x2, z2, r) {
  const inside = (px, pz) => px >= r.x0 && px <= r.x1 && pz >= r.z0 && pz <= r.z1;
  if (inside(x1, z1) || inside(x2, z2)) return 0;
  const seg = { x1, z1, x2, z2 };
  const edges = [
    [r.x0, r.z0, r.x1, r.z0], [r.x1, r.z0, r.x1, r.z1],
    [r.x1, r.z1, r.x0, r.z1], [r.x0, r.z1, r.x0, r.z0],
  ];
  for (const e of edges) if (segsCross(x1, z1, x2, z2, e[0], e[1], e[2], e[3])) return 0;
  let best = Math.min(pointRectDistance(x1, z1, r), pointRectDistance(x2, z2, r));
  for (const c of [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]]) {
    best = Math.min(best, pointSegDistance(c[0], c[1], seg));
  }
  return best;
}

/** Shortest distance between two street segments (0 when they meet). */
function segSegDistance(a, b) {
  if (segsCross(a.x1, a.z1, a.x2, a.z2, b.x1, b.z1, b.x2, b.z2)) return 0;
  return Math.min(
    pointSegDistance(a.x1, a.z1, b), pointSegDistance(a.x2, a.z2, b),
    pointSegDistance(b.x1, b.z1, a), pointSegDistance(b.x2, b.z2, a),
  );
}

/**
 * BFS over the street graph. Level 0 = a segment that reaches the plaza; level
 * n = n turns off one. Two segments are connected when they touch within half
 * their combined widths, which is what a junction is.
 */
export function streetLevels(streets, plazaR) {
  const n = streets.length;
  const level = new Array(n).fill(Infinity);
  const queue = [];
  streets.forEach((s, i) => {
    if (pointSegDistance(0, 0, s) <= plazaR + 1) { level[i] = 0; queue.push(i); }
  });
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (let j = 0; j < n; j++) {
      if (level[j] !== Infinity) continue;
      if (segSegDistance(streets[i], streets[j]) <= (streets[i].w + streets[j].w) * 0.5 + 0.5) {
        level[j] = level[i] + 1;
        queue.push(j);
      }
    }
  }
  return level;
}
