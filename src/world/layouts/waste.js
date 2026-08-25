// Waste kind — Wave E task E-A, THE RIVEN WASTE (A rank): an open landscape
// run. One large organic field (~120 m across) under rolling analytic terrain,
// entered through the same +Z arrival tunnel as every other interior, with a
// marked ROUTE of three objective sites (spawn camps, cleared site by site —
// the encounter director gates each on the previous, the "compass" gating
// that replaces the crawl's door seals) and the boss rising at a final fourth
// site, exit portal behind it. Scattered rock outcrops / ruin clusters are
// the cover AND the landmarks — COVER_KINDS vocabulary at landscape scale.
//
// Split per the Wave E generator law: one file per layout kind, shared
// plumbing in core.js, dispatch in core.js generateLayout. The shared
// contract in core.js's header binds this file in full: DETERMINISM IS
// LOAD-BEARING, no Math.random / Date.now, forked mulberry32 streams only,
// THREE-free and Node-importable. Consumers import ../dungeonlayout.js,
// never this file.
//
// THE SHAPE. The mask is the cavern's disc-union walk scaled up (few, very
// large discs) so the floor reads as one open field with lobed edges, rimmed
// by the same wall-run/rock-fill enclosure every interior uses — a canyon rim,
// not corridors. What makes it a LANDSCAPE is the height function: the
// tower's heightAt seam (dungeonmode already binds any layout.heightAt into
// the player body, dungeon.js already floors enemies/props/cover with it)
// carrying a SMOOTH analytic wave field instead of the tower's quantized
// plateaus. layout.smoothHeight = true tells dungeon.js's floor builder to
// sample cell CORNERS (continuous terrain, no risers) instead of stamping
// flat treads.
//
// TERRAIN SAFETY MARGINS, all three load-bearing:
//   slope   the sum of every wave's peak gradient (amp * 2*pi / wavelength)
//           is capped at TERRAIN_MAX_SLOPE = 0.30 by construction — the body
//           flips into its sliding state at slope 0.55, so rolling ground can
//           never strand a walker (the gen soak samples real gradients and
//           asserts <= 0.42, margin over the analytic bound for the envelope
//           term).
//   spawn   an envelope zeroes the field at and south of the tunnel head and
//           fades it in over TERRAIN_FADE m — heightAt(0,0) === 0 exactly, so
//           the arrival, the intro auto-walk and the sealed portal all sit on
//           the flat datum every other kind spawns on.
//   data    the wave table (layout.terrain) is plain JSON; heightAt is a
//           function property rebuilt from it, so the soak's byte-compare
//           rides the data it closes over — tower.js's exact identity rule.
//
// THE ROUTE. Sites are disc trigger rooms in the cavern's grammar (radius on
// the record, roomAt tests discs, NO doors, so the director's seal machinery
// no-ops), but unlike cavern zones they are ORDERED: layout.route lists the
// combat sites in clear order and the director refuses to trigger site N+1
// (or the boss) early — the deep-door gate reshaped for a world with no
// doors. Every consecutive route leg (entry -> s1 -> s2 -> s3 -> boss) is
// guaranteed a straight walkable CORRIDOR at selection time (corridorClear:
// >= 2 cells of floor around every metre of the segment), the cover placer
// keeps that corridor clean (ROUTE_CORRIDOR_HALF), and the post-placement
// connectivity sweep (wasteFieldFill, the crawl's per-door guarantee
// generalized to route waypoints) proves it against the REAL obstacle field,
// pruning the offending outcrop when geometry conspires.
//
// ROAM POINTS. Each site carries `roam` (how many of its budget bodies meet
// the player ON THE WAY) and `roamPoints` (where they rise: along the leg
// from the previous route stop). The director spawns them when the previous
// site clears — encounters.js owns the WHEN, this file owns the WHERE, and
// both are pure functions of the seed.
//
// STREAMS. layoutRnd / decorRnd(reserved) / encounterRnd(reserved) / coverRnd
// are the standard forks; terrainRnd is a FIFTH fork (0x68e31da4 — collides
// with none in use: 0x9e3779b9 / 0x5f356495 / 0x1f123bb5 / 0x7feb352d layout
// family, 0x94d049bb parapets, 0x85ebca6b shell, 0x27d4eb2f dressing,
// 0x632be59b enemy count, 0xc2b2ae35 waveSize) so retuning the ground swell
// can never move a site or an outcrop, and vice versa. Every lattice point in
// the outcrop sweep draws a FIXED roll count before any rejection — the
// cavern stalagmite loop's rule.

import { mulberry32 } from '../../core/rng.js';
import { ObstacleField } from '../obstacles.js';
import {
  CELL, DOOR_THICKNESS, randint, originHalf, boundsFromMask,
  buildWallRuns, assignBudgets, bossAnchor, exitAnchor,
  COVER_KINDS, NAV_BODY_RADIUS,
} from './core.js';
import { discSpawnPoints } from './cavern.js';

// Slope budget shared between generation and the soak: the sum of per-wave
// peak gradients never exceeds this (see the header's slope note).
export const TERRAIN_MAX_SLOPE = 0.30;
// Metres over which the flat spawn datum fades into the rolling field.
const TERRAIN_FADE = 18;
const TERRAIN_WAVES = 5;
const WAVELEN = [26, 44];     // metres, per wave

// The route corridor half-width the cover placer keeps clean, metres. A dash
// is 7.5 m; an 8 m clean lane means the marked route is always sprintable
// even before the connectivity sweep has its say.
export const ROUTE_CORRIDOR_HALF = 4.0;

// Connectivity-sweep lattice pitch, metres. Coarser than the crawl's per-room
// NAV_FILL_STEP (0.5) because the field is ~2,800 open cells of 4 m^2, but
// still fine enough that a body-radius fill cannot jump a 0.6 m wall box or
// squeeze past a footprint the resolve() pass would stop (max gap a step can
// cross is < 2 * step; the REAL bound is the thinnest body-inflated band —
// a stub outcrop's 0.5 m depth + 2 x 0.45 m body radius = 1.4 m — and the
// requirement is band > WASTE_FILL_STEP (0.75), which holds with ~2x margin.
// (An earlier comment claimed >= 1.5 m; review corrected the arithmetic.)
export const WASTE_FILL_STEP = 0.75;

/** Rebuild the analytic height function from its serialized wave table —
 * exported so dungeon.js, the soak and this file all construct the SAME
 * function from the SAME data (one computation site, tower.js's rule). */
export function terrainHeightFn(terrain) {
  const { waves, fadeZ, fade } = terrain;
  return (x, z) => {
    // Envelope: 0 at/south of the tunnel head plane, 1 a fade-length north.
    const t = (fadeZ - z) / fade;
    if (t <= 0) return 0;
    const k = t >= 1 ? 1 : t * t * (3 - 2 * t);
    let h = 0;
    for (const wv of waves) {
      h += wv.amp * Math.sin(((x * wv.dx + z * wv.dz) * Math.PI * 2) / wv.len + wv.phase);
    }
    return h * k;
  };
}

export function tryGenerateWaste(rank, params, enemies, seed) {
  const layoutRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const coverRnd = mulberry32((seed ^ 0x7feb352d) >>> 0);
  const terrainRnd = mulberry32((seed ^ 0x68e31da4) >>> 0);

  const w = params.grid;
  const h = params.grid;
  const mask = new Uint8Array(w * h);
  const at = (gx, gz) => gx + gz * w;
  const isFloor = (gx, gz) => gx >= 0 && gz >= 0 && gx < w && gz < h && mask[at(gx, gz)] === 1;

  // Disc carve/clear — byte-for-byte the cavern's helpers (cell units, floats,
  // cells claim by centre).
  const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const carveDisc = (cx, cz, rc) => {
    const x0 = Math.max(1, Math.floor(cx - rc));
    const x1 = Math.min(w - 2, Math.ceil(cx + rc));
    const z0 = Math.max(1, Math.floor(cz - rc));
    const z1 = Math.min(h - 2, Math.ceil(cz + rc));
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx + 0.5 - cx;
        const dz = gz + 0.5 - cz;
        if (dx * dx + dz * dz <= rc * rc) mask[at(gx, gz)] = 1;
      }
    }
  };

  // --- entry tunnel from +Z (the arrival grammar every interior shares) ----
  const tw = params.tunnelWidth;
  const tunnelLen = randint(layoutRnd, params.tunnelLen[0], params.tunnelLen[1]);
  const tx0 = Math.floor((w - tw) / 2);
  const southPlaneRow = h - 1;                    // 1-row rock border kept
  const tunnelTop = southPlaneRow - tunnelLen;    // rows tunnelTop..h-2
  for (let gz = tunnelTop; gz < southPlaneRow; gz++) {
    for (let gx = tx0; gx < tx0 + tw; gx++) mask[at(gx, gz)] = 1;
  }
  const tunnelCX = tx0 + tw / 2;

  // --- the open field: FEW, VERY LARGE discs -------------------------------
  // The cavern walks 11-16 discs of 8-18 m to get chambers-and-necks; the
  // waste walks params.discs (5-7) of discR (20-32 m) so the union reads as
  // ONE field with lobed edges rather than a cave system. Same overlap
  // guarantee, same -Z drift.
  const discs = [];
  const nDiscs = randint(layoutRnd, params.discs[0], params.discs[1]);
  let px = tunnelCX;
  let pz = tunnelTop;
  for (let i = 0; i < nDiscs; i++) {
    const rc = (params.discR[0] + layoutRnd() * (params.discR[1] - params.discR[0])) / CELL;
    if (i === 0) pz = tunnelTop - Math.max(1, rc * 0.55);
    let cx = clampNum(px, rc + 2, w - 2 - rc);
    let cz = clampNum(pz, rc + 2, h - 2 - rc);
    if (discs.length) {
      const prev = discs[discs.length - 1];
      const dx = cx - prev.cx;
      const dz = cz - prev.cz;
      const dist = Math.hypot(dx, dz) || 1;
      // Deeper overlap than the cavern's 1.5 cells: the waste must not roll
      // narrow necks between its lobes, they would choke the route corridors.
      const maxD = prev.rc + rc - 6;
      if (dist > maxD) {
        cx = prev.cx + (dx / dist) * maxD;
        cz = prev.cz + (dz / dist) * maxD;
      }
    }
    carveDisc(cx, cz, rc);
    discs.push({ cx, cz, rc });
    const ang = layoutRnd() * Math.PI * 2;
    const step = rc * (0.55 + layoutRnd() * 0.4);
    px = cx + Math.cos(ang) * step;
    pz = cz - Math.abs(Math.sin(ang)) * step * 0.9 - rc * 0.2;
  }

  // --- smoothing + reachability sweep (the cavern's, verbatim shape) -------
  {
    const snap = mask.slice();
    const f = (gx, gz) => (gx >= 0 && gz >= 0 && gx < w && gz < h && snap[gx + gz * w] === 1 ? 1 : 0);
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const n4 = f(gx - 1, gz) + f(gx + 1, gz) + f(gx, gz - 1) + f(gx, gz + 1);
        if (snap[at(gx, gz)]) {
          if (n4 <= 1) mask[at(gx, gz)] = 0;
        } else if (n4 >= 3) mask[at(gx, gz)] = 1;
      }
    }
  }
  const spawnCell = at(tx0 + Math.floor(tw / 2), southPlaneRow - 1);
  const bfs = new Int32Array(w * h).fill(-1);
  {
    const q = [spawnCell];
    bfs[spawnCell] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cgx = cur % w;
      const cgz = (cur / w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cgx + dx;
        const nz = cgz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = at(nx, nz);
        if (!mask[ni] || bfs[ni] >= 0) continue;
        bfs[ni] = bfs[cur] + 1;
        q.push(ni);
      }
    }
    for (let i = 0; i < w * h; i++) if (mask[i] && bfs[i] < 0) mask[i] = 0;
  }

  // --- world translation (the shared arrival maths) ------------------------
  const southPlane = southPlaneRow * CELL;
  const originX = -tunnelCX * CELL;
  const originZ = -(southPlane - 1.6);
  const toX = (cx) => originX + cx * CELL;
  const toZ = (cz) => originZ + cz * CELL;

  // --- terrain: the rolling analytic height field (terrainRnd ONLY) --------
  // FIXED roll count: TERRAIN_WAVES x 3 draws, before anything reads them.
  // Per-wave amplitude derives from an equal share of the slope budget —
  // amp = share * len / (2*pi) — so the WORST-CASE aligned gradient is
  // TERRAIN_MAX_SLOPE by construction, not by tuning luck.
  const waves = [];
  for (let i = 0; i < TERRAIN_WAVES; i++) {
    const ang = terrainRnd() * Math.PI * 2;
    const len = WAVELEN[0] + terrainRnd() * (WAVELEN[1] - WAVELEN[0]);
    const phase = terrainRnd() * Math.PI * 2;
    const share = TERRAIN_MAX_SLOPE / TERRAIN_WAVES;
    waves.push({
      dx: Math.cos(ang),
      dz: Math.sin(ang),
      len,
      amp: (share * len) / (Math.PI * 2),
      phase,
    });
  }
  const terrain = { waves, fadeZ: toZ(tunnelTop), fade: TERRAIN_FADE };
  const heightAt = terrainHeightFn(terrain);

  // --- route selection: 3 sites + the boss site, corridor-guaranteed -------
  // The cavern's candidate/spread machinery, with one added acceptance rule:
  // a stop must have a straight walkable corridor back to the PREVIOUS stop
  // (>= 2 cells of floor around every metre of the segment), because the
  // waste's whole identity is "follow the compass across the open" — a route
  // leg that detours around a rock lobe is a corridor the cover placer and
  // the roam points cannot reason about.
  const openR = (gx, gz, rc) => {
    const r2 = rc * rc;
    for (let dz = -rc; dz <= rc; dz++) {
      for (let dx = -rc; dx <= rc; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        if (!isFloor(gx + dx, gz + dz)) return false;
      }
    }
    return true;
  };
  const corridorClear = (ax, az, bx, bz) => {
    // Cell units. Every ~1 cell along the segment keeps a 2-cell floor disc.
    const dist = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(dist));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const gx = Math.round(ax + (bx - ax) * t - 0.5);
      const gz = Math.round(az + (bz - az) * t - 0.5);
      if (!openR(gx, gz, 2)) return false;
    }
    return true;
  };
  const inTunnel = (gx, gz) => gx >= tx0 - 1 && gx <= tx0 + tw && gz >= tunnelTop - 1;

  const entryC = { cx: discs[0].cx, cz: discs[0].cz };
  const entryRc = Math.min(discs[0].rc, 4.5);

  const gatherCandidates = (clearRc) => {
    const out = [];
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const i = at(gx, gz);
        if (!mask[i] || bfs[i] < 0) continue;
        if (!openR(gx, gz, clearRc)) continue;
        if (inTunnel(gx, gz)) continue;
        const cx = gx + 0.5;
        const cz = gz + 0.5;
        if (Math.hypot(cx - entryC.cx, cz - entryC.cz) < entryRc + 5) continue;
        out.push({ gx, gz, d: bfs[i] });
      }
    }
    return out;
  };

  // Combat-site candidates: cavern's zone bar (6 -> 5 cells clear).
  let siteCands = [];
  for (const clearRc of [6, 5]) {
    siteCands = gatherCandidates(clearRc);
    if (siteCands.length >= params.sites * 3) break;
  }
  siteCands.sort((a, b) => a.d - b.d || (a.gx + a.gz * w) - (b.gx + b.gz * w));
  // Boss-site candidates: the open-field 5-dash bar. 10 cells clear = 20 m of
  // free radius = 40 m across = 5.3 dashes; the 9-cell relax rung still gives
  // 36 m = 4.8, which the soak's freeRadius assert (>= 4.5 dashes) allows.
  let bossCands = [];
  for (const clearRc of [10, 9]) {
    bossCands = gatherCandidates(clearRc);
    if (bossCands.length >= 3) break;
  }
  if (!bossCands.length) return { depth: -1 };   // cramped roll — regen seed+1
  bossCands.sort((a, b) => b.d - a.d || (a.gx + a.gz * w) - (b.gx + b.gz * w));

  const maxD = siteCands.length ? siteCands[siteCands.length - 1].d : 0;
  let stops = null;   // [{gx,gz,d} x sites] in route order, corridor-chained
  for (let relax = 0; relax < 3 && !stops; relax++) {
    const spacing = (params.siteSpacing / CELL) * (1 - relax * 0.2);
    const picked = [];
    let prev = { gx: Math.round(entryC.cx - 0.5), gz: Math.round(entryC.cz - 0.5) };
    for (let k = 1; k <= params.sites; k++) {
      const target = (maxD * k) / (params.sites + 0.6);
      let best = null;
      let bestScore = Infinity;
      for (const c of siteCands) {
        let clear = true;
        for (const s of picked) {
          if (Math.hypot(c.gx - s.gx, c.gz - s.gz) < spacing) { clear = false; break; }
        }
        if (!clear) continue;
        // Monotonic depth: the route must walk AWAY from the entry.
        if (picked.length && c.d <= picked[picked.length - 1].d) continue;
        const score = Math.abs(c.d - target);
        if (score >= bestScore) continue;
        if (!corridorClear(prev.gx + 0.5, prev.gz + 0.5, c.gx + 0.5, c.gz + 0.5)) continue;
        bestScore = score;
        best = c;
      }
      if (!best) break;
      picked.push(best);
      prev = best;
    }
    if (picked.length === params.sites) stops = picked;
  }
  if (!stops) return { depth: -1 };

  // Boss stop: deepest candidate with a clear corridor from the last site,
  // held off every site by the site spacing.
  const lastStop = stops[stops.length - 1];
  let bossStop = null;
  for (const c of bossCands) {
    if (c.d <= lastStop.d) continue;
    let clear = true;
    for (const s of stops) {
      if (Math.hypot(c.gx - s.gx, c.gz - s.gz) < params.siteSpacing / CELL) { clear = false; break; }
    }
    if (!clear) continue;
    if (!corridorClear(lastStop.gx + 0.5, lastStop.gz + 0.5, c.gx + 0.5, c.gz + 0.5)) continue;
    bossStop = c;
    break;
  }
  if (!bossStop) return { depth: -1 };

  // --- rooms: entry + 3 sites + boss, all discs (cavern grammar) -----------
  const outRooms = [];
  const pushDiscRoom = (kind, cx, cz, radiusM) => {
    const id = outRooms.length;
    const centre = { x: toX(cx), z: toZ(cz) };
    outRooms.push({
      id,
      kind,
      radius: radiusM,
      x: centre.x - radiusM,
      z: centre.z - radiusM,
      w: radiusM * 2,
      d: radiusM * 2,
      centre,
      floorY: 0,               // stamped from heightAt below
      doors: [],
      spawnPoints: [],
      budget: 0,
    });
    return id;
  };
  pushDiscRoom('entry', entryC.cx, entryC.cz, entryRc * CELL);
  for (const s of stops) pushDiscRoom('combat', s.gx + 0.5, s.gz + 0.5, params.siteRadius);
  const bossId = pushDiscRoom('boss', bossStop.gx + 0.5, bossStop.gz + 0.5, params.bossRadius);
  const route = outRooms.filter((r) => r.kind === 'combat').map((r) => r.id);

  // --- doors: the entry arch ONLY — the waste has nothing to seal ----------
  const doorRecs = [
    { plane: 'z', at: tunnelTop, lo: tx0, hi: tx0 + tw - 1, roomA: 0, roomB: -1 },
  ];
  const outDoors = doorRecs.map((d, i) => {
    const span = (d.hi - d.lo + 1) * CELL;
    const mid = originHalf(d.lo, d.hi);
    return {
      id: i, x: toX(mid), z: toZ(d.at), w: span, d: DOOR_THICKNESS, rot: 0, roomA: d.roomA, roomB: d.roomB,
    };
  });
  outRooms[0].doors.push(0);

  const outCorridors = [
    { x: toX(tx0 + tw / 2), z: toZ(tunnelTop + tunnelLen / 2), w: tw * CELL, d: tunnelLen * CELL },
  ];

  // --- wall runs (the canyon rim), height-stamped --------------------------
  // buildWallRuns merges the floor/rock boundary blind to height; each run
  // then records base/top = the min/max terrain height of its floor-side
  // cells, the tower's exact post-walk (dungeon.js draws each rim slab from
  // base to top + wallHeight and dungeonmode's boom probe reads run.top).
  const wallRuns = buildWallRuns(mask, w, h, at, originX, originZ);
  const FLOOR_SIDE = { s: [0, -1], n: [0, 1], e: [-1, 0], w: [1, 0] };
  for (const run of wallRuns) {
    const [fx, fz] = FLOOR_SIDE[run.face];
    const horizontal = run.w > run.d;
    const len = Math.round((horizontal ? run.w : run.d) / CELL);
    let base = Infinity;
    let top = -Infinity;
    for (let i = 0; i < len; i++) {
      const cx = horizontal ? run.x - run.w / 2 + (i + 0.5) * CELL : run.x + fx * CELL * 0.5;
      const cz = horizontal ? run.z + fz * CELL * 0.5 : run.z - run.d / 2 + (i + 0.5) * CELL;
      const y = heightAt(cx, cz);
      if (y < base) base = y;
      if (y > top) top = y;
    }
    run.base = Number.isFinite(base) ? base : 0;
    run.top = Number.isFinite(top) ? top : run.base;
  }

  // --- spawn points, terrain-stamped; budgets ------------------------------
  for (const r of outRooms) {
    r.spawnPoints = discSpawnPoints(r, mask, w, h, at, originX, originZ, layoutRnd);
    for (const p of r.spawnPoints) p.y = heightAt(p.x, p.z);
    r.floorY = heightAt(r.centre.x, r.centre.z);
  }
  const criticalPath = [0, ...route, bossId];
  assignBudgets(outRooms, criticalPath, enemies);

  // --- roam points: where a site's advance pack meets the player -----------
  // Along the leg from the previous route stop, at fixed fractions with a
  // lateral jitter (FIXED two rolls per point); a jittered point that leaves
  // the corridor's guaranteed floor falls back to the segment point itself.
  // `roam` bodies come OUT of the site's own budget so gate.enemies stays the
  // exact kill-metering total.
  const ROAM_FRACS = [0.38, 0.58, 0.78];
  for (let i = 0; i < route.length; i++) {
    const site = outRooms[route[i]];
    const from = i === 0 ? outRooms[0].centre : outRooms[route[i - 1]].centre;
    site.roam = Math.min(ROAM_FRACS.length, Math.max(0, Math.floor(site.budget / 4)));
    site.roamPoints = [];
    for (const f of ROAM_FRACS) {
      const jx = (layoutRnd() - 0.5) * 6;   // fixed rolls, drawn every point
      const jz = (layoutRnd() - 0.5) * 6;
      const bx = from.x + (site.centre.x - from.x) * f;
      const bz = from.z + (site.centre.z - from.z) * f;
      let x = bx + jx;
      let z = bz + jz;
      const gx = Math.floor((x - originX) / CELL);
      const gz = Math.floor((z - originZ) / CELL);
      if (!openR(gx, gz, 1)) { x = bx; z = bz; }
      site.roamPoints.push({ x, z, y: heightAt(x, z) });
    }
  }

  const { bounds, radius } = boundsFromMask(mask, w, h, at, originX, originZ);

  // --- outcrops: the landscape cover field (coverRnd ONLY) -----------------
  const cover = buildWasteCover(outRooms, route, bossId, wallRuns, params, coverRnd, {
    mask, w, h, at, originX, originZ, isFloor, inTunnel, heightAt,
  });

  // --- connectivity guarantee, generalized to route waypoints --------------
  // The crawl proves every DOOR reachable over the real combined obstacle
  // field; the waste has one door, so the invariant that matters is every
  // ROUTE WAYPOINT: site centres, spawn points, roam points, the boss rise
  // anchor and the exit portal, all reachable from the spawn at body radius.
  // Same idiom as enforceRoomDoorReachability: place first, then prune the
  // outcrop nearest any waypoint the field cut off. Bounded, deterministic,
  // and in practice a no-op — the corridor + clearance rules above make a
  // real failure geometric conspiracy, not chance.
  {
    const bossRoom = outRooms[bossId];
    const bAnchor = bossAnchor(bossRoom, null);
    const eAnchor = exitAnchor(bossRoom, null);
    const waypoints = [];
    for (const r of outRooms) {
      waypoints.push({ x: r.centre.x, z: r.centre.z });
      for (const p of r.spawnPoints) waypoints.push(p);
      for (const p of r.roamPoints || []) waypoints.push(p);
    }
    waypoints.push(bAnchor, eAnchor);
    let pruneExhausted = true;
    for (let iter = 0; iter < 12; iter++) {
      const field = buildWasteField(wallRuns, cover);
      const fill = wasteFieldFill(field, {
        mask, w, h, originX, originZ, cell: CELL,
      }, heightAt);
      const bad = waypoints.find((p) => !fill.reachedAt(p.x, p.z));
      if (!bad) { pruneExhausted = false; break; }
      // Prune the outcrop nearest the severed waypoint; ties to the later
      // (newer) piece, mirroring the crawl's prune.
      let victim = -1;
      let victimD = Infinity;
      for (let i = 0; i < cover.length; i++) {
        const c = cover[i];
        const d = Math.hypot(c.x - bad.x, c.z - bad.z);
        if (d <= victimD) { victimD = d; victim = i; }
      }
      if (victim < 0) break;
      cover.splice(victim, 1);
    }
    // Loud on exhaustion (review fix): the crawl's enforceRoomDoorReachability
    // warns when its prune cap trips, and a live pathological seed severing a
    // waypoint with no log trace is a bug nobody can chase. The soak's
    // zero-tolerance assert covers its 200 seeds, not every seed forever.
    if (pruneExhausted) {
      console.warn('[waste] route-connectivity prune cap (12) exhausted — a waypoint may be severed');
    }
  }

  // Prune the spawn menu against the FINAL cover set (buildCover's last pass,
  // reshaped for terrain: a body must not rise inside an outcrop).
  for (const r of outRooms) {
    if (!cover.length) break;
    r.spawnPoints = r.spawnPoints.filter((p) => !cover.some((q) => (
      Math.abs(p.x - q.x) < q.ex + params.cover.spawnClear
      && Math.abs(p.z - q.z) < q.ez + params.cover.spawnClear
    )));
  }

  const decor = {
    torches: [], columns: [], props: [], alcoves: [], crystals: [], stalagmites: [], cover,
  };

  const layout = {
    kind: 'waste',
    rank,
    cell: CELL,
    w,
    h,
    originX,
    originZ,
    mask,
    terrain,
    smoothHeight: true,       // dungeon.js floor builder: corner-sampled, no risers
    route,
    rooms: outRooms,
    doors: outDoors,
    corridors: outCorridors,
    wallRuns,
    decor,
    criticalPath,
    bossRoom: bossId,
    depth: criticalPath.length - 1,
    entry: { x: 0, z: 0, yaw: 0 },
    bounds,
    radius,
    params: {
      wallHeight: params.wallHeight,
      wallHeightLow: params.wallHeightLow,
      torchSpacing: 0,
      fog: params.fog,
    },
  };
  // THE heightAt seam (tower.js's rule to the letter): a function property —
  // JSON.stringify drops it, so the determinism byte-compare rides the DATA
  // it closes over (layout.terrain), which is exactly right.
  layout.heightAt = heightAt;
  return layout;
}

// ---------------------------------------------------------------------------
// outcrops — COVER_KINDS at landscape scale, coverRnd ONLY
// ---------------------------------------------------------------------------
// A jittered lattice over the whole field (the crawl's buildCover sweep,
// unbounded by room rects) placing single pieces and occasional two-piece
// ruin clusters. Every clearance the crawl's placer enforces per room is
// enforced here per field: dash lanes between footprints, a rock-rim inset,
// door/tunnel approaches, the boss and exit anchors — plus the waste's own
// rules, ROUTE CORRIDORS (nothing lands within ROUTE_CORRIDOR_HALF of a
// route leg) and roam points. FIXED SEVEN ROLLS per lattice point, drawn
// before any rejection — the cavern stalagmite loop's rule — so retuning one
// clearance can never re-dress the whole field.
function buildWasteCover(rooms, route, bossId, wallRuns, params, rnd, ctx) {
  const cfg = params.cover;
  const out = [];
  if (!cfg) return out;
  const { isFloor, inTunnel, heightAt, originX, originZ } = ctx;

  const extents = (kind, yaw) => {
    const k = COVER_KINDS[kind];
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    return { ex: k.hx * c + k.hz * s, ez: k.hx * s + k.hz * c };
  };

  // Route legs (entry -> s1 -> s2 -> s3 -> boss) as segments for the
  // corridor keep-out. Point-to-segment distance, world metres.
  const legs = [];
  {
    const order = [0, ...route, bossId];
    for (let i = 0; i + 1 < order.length; i++) {
      legs.push([rooms[order[i]].centre, rooms[order[i + 1]].centre]);
    }
  }
  const segDist = (px, pz, a, b) => {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz || 1;
    let t = ((px - a.x) * abx + (pz - a.z) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t));
  };

  const bossRoom = rooms[bossId];
  const bAnchor = bossAnchor(bossRoom, null);
  const eAnchor = exitAnchor(bossRoom, null);

  const tryPut = (x, z, yaw, kind) => {
    const { ex, ez } = extents(kind, yaw);
    const reach = Math.max(ex, ez);
    // Rim inset: full floor in a disc that covers the footprint plus the
    // wall band — the lattice analogue of the crawl's wallInset.
    const gx = Math.floor((x - originX) / CELL);
    const gz = Math.floor((z - originZ) / CELL);
    const rimCells = Math.ceil((reach + cfg.wallInset) / CELL);
    for (let dz = -rimCells; dz <= rimCells; dz++) {
      for (let dx = -rimCells; dx <= rimCells; dx++) {
        if (dx * dx + dz * dz > rimCells * rimCells) continue;
        if (!isFloor(gx + dx, gz + dz)) return false;
      }
    }
    if (inTunnel(gx, gz)) return false;
    // Route corridors stay sprintable — THE waste clearance.
    for (const [a, b] of legs) {
      if (segDist(x, z, a, b) < ROUTE_CORRIDOR_HALF + reach) return false;
    }
    // Site centres open (the camp's fight floor), boss/exit anchors clear.
    for (const r of rooms) {
      if (Math.hypot(x - r.centre.x, z - r.centre.z) < cfg.siteClear + reach) return false;
    }
    if (Math.hypot(x - bAnchor.x, z - bAnchor.z) < cfg.bossClear + reach) return false;
    if (Math.hypot(x - eAnchor.x, z - eAnchor.z) < cfg.exitClear + reach) return false;
    // Roam points: an advance body must not rise inside a rock.
    for (const r of rooms) {
      for (const p of r.roamPoints || []) {
        if (Math.hypot(x - p.x, z - p.z) < cfg.roamClear + reach) return false;
      }
    }
    // Dash lanes between footprints (world-aligned AABB, the crawl's test).
    for (const q of out) {
      if (Math.abs(q.x - x) < q.ex + ex + cfg.lane
        && Math.abs(q.z - z) < q.ez + ez + cfg.lane) return false;
    }
    out.push({
      x, z, yaw, kind, room: -1, ex, ez, y: heightAt(x, z),
    });
    return true;
  };

  // The sweep. Lattice pitch in metres over the layout's world bounds.
  const x0 = originX + CELL;
  const z0 = originZ + CELL;
  const spanX = ctx.w * CELL - 2 * CELL;
  const spanZ = ctx.h * CELL - 2 * CELL;
  const nx = Math.max(1, Math.round(spanX / cfg.step));
  const nz = Math.max(1, Math.round(spanZ / cfg.step));
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      // FIXED seven rolls per lattice point, before any rejection.
      const ox = (rnd() - 0.5) * 2 * cfg.jitter;
      const oz = (rnd() - 0.5) * 2 * cfg.jitter;
      const keep = rnd() < cfg.chance;
      const kindRoll = rnd();
      const yawRoll = rnd();
      const clusterRoll = rnd();
      const clusterAng = rnd() * Math.PI * 2;
      if (!keep) continue;
      const x = x0 + (i + 0.5) * (spanX / nx) + ox;
      const z = z0 + (j + 0.5) * (spanZ / nz) + oz;
      // Free yaw on the open field: there is no architecture to square to,
      // and a tilted ruin fragment reads as a ruin. The AABB lane test is
      // conservative for tilted pieces, which can only WIDEN a lane.
      const yaw = yawRoll * Math.PI * 2;
      const kind = kindRoll < cfg.rubbleShare ? 'rubble'
        : kindRoll < cfg.rubbleShare + cfg.stubShare ? 'stub' : 'pillar';
      const placed = tryPut(x, z, yaw, kind);
      // Ruin cluster: a second piece leaning nearby — the landmark read.
      if (placed && clusterRoll < cfg.clusterChance) {
        const d = cfg.lane + 3.2;
        tryPut(x + Math.cos(clusterAng) * d, z + Math.sin(clusterAng) * d,
          yaw + Math.PI / 2, kind === 'pillar' ? 'rubble' : 'pillar');
      }
    }
  }

  // Render budget by DOWNGRADE, the crawl's rule: overflow rubble becomes a
  // pillar in the same slot (strictly smaller footprint — every lane holds).
  const piles = out.filter((c) => c.kind === 'rubble');
  if (cfg.rubbleCap > 0 && piles.length > cfg.rubbleCap) {
    const drop = piles.length - cfg.rubbleCap;
    for (let i = 0; i < drop; i++) {
      const c = piles[Math.floor((i * piles.length) / drop)];
      c.kind = 'pillar';
      c.ex = COVER_KINDS.pillar.hx;
      c.ez = COVER_KINDS.pillar.hz;
    }
  }
  // Hard piece cap (dungeon.js DRESS_LIMITS.cover truncates at 60 — a silent
  // truncation there would strip collision the soak measured, so the placer
  // enforces the same number by even-stride REMOVAL, never exceeding it).
  if (out.length > cfg.maxPieces) {
    const keep = [];
    for (let i = 0; i < cfg.maxPieces; i++) {
      keep.push(out[Math.floor((i * out.length) / cfg.maxPieces)]);
    }
    out.length = 0;
    out.push(...keep);
  }
  return out;
}

// ---------------------------------------------------------------------------
// connectivity field + fill — exported for tools/dungeon-gen-test.mjs, so the
// soak's zero-tolerance waypoint reachability runs the SAME code the
// generator's own guarantee runs (floodFillRoom's no-two-copies rule).
// ---------------------------------------------------------------------------

/** The real collision picture a Dungeon build registers for the waste, minus
 * the THREE half: rim wall runs + every outcrop footprint. */
export function buildWasteField(wallRuns, cover) {
  const f = new ObstacleField({ stepOver: 0.4 });
  for (const run of wallRuns) {
    f.addBox(run.x, run.z, run.w, run.d, run.rot, { tag: 'wall', nav: false });
  }
  for (const c of cover) {
    const k = COVER_KINDS[c.kind];
    if (k.shape === 'circle') f.addCircle(c.x, c.z, k.r, { nav: false, tag: 'cover' });
    else f.addBox(c.x, c.z, k.hx * 2, k.hz * 2, c.yaw, { top: k.top + (c.y || 0), nav: false, tag: 'cover' });
  }
  return f.build();
}

/**
 * Field-wide body-radius flood fill from the spawn (0,0), masked to floor
 * cells, feetY = the terrain height at each sample (collision tops are
 * absolute, so a piece's blocking height rides its ground). Returns a
 * `reachedAt(x, z)` probe over the fill lattice.
 */
export function wasteFieldFill(field, grid, heightAt, {
  bodyRadius = NAV_BODY_RADIUS, fillStep = WASTE_FILL_STEP,
} = {}) {
  const { mask, w, h, originX, originZ, cell } = grid;
  const nx = Math.round((w * cell) / fillStep);
  const nz = Math.round((h * cell) / fillStep);
  const open = new Uint8Array(nx * nz);
  const px = (i) => originX + (i + 0.5) * fillStep;
  const pz = (j) => originZ + (j + 0.5) * fillStep;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = px(i);
      const z = pz(j);
      const gx = Math.floor((x - originX) / cell);
      const gz = Math.floor((z - originZ) / cell);
      if (gx < 0 || gz < 0 || gx >= w || gz >= h || !mask[gx + gz * w]) continue;
      if (field.blocked(x, z, bodyRadius, 0.4, heightAt(x, z))) continue;
      open[i + j * nx] = 1;
    }
  }
  const seen = new Uint8Array(nx * nz);
  const si = Math.floor((0 - originX) / fillStep);
  const sj = Math.floor((0 - originZ) / fillStep);
  const start = si + sj * nx;
  if (si >= 0 && sj >= 0 && si < nx && sj < nz && open[start]) {
    seen[start] = 1;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi] % nx;
      const cj = (q[qi] / nx) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + dx;
        const nj = cj + dz;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const k = ni + nj * nx;
        if (!open[k] || seen[k]) continue;
        seen[k] = 1;
        q.push(k);
      }
    }
  }
  return {
    nx,
    nz,
    open,
    seen,
    // A waypoint is "reached" when any lattice cell in the 3x3 around its
    // containing cell is seen — waypoints sit on arbitrary world points, not
    // lattice centres, and the cell under one can be shaded by a footprint
    // the body would simply stand beside.
    reachedAt(x, z) {
      const bi = Math.floor((x - originX) / fillStep);
      const bj = Math.floor((z - originZ) / fillStep);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = bi + di;
          const j = bj + dj;
          if (i >= 0 && j >= 0 && i < nx && j < nz && seen[i + j * nx]) return true;
        }
      }
      return false;
    },
  };
}
