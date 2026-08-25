// Cavern kind — DUNGEON_SPEC STEP 8 (C rank): disc-union random walk, side
// grottos, sealed boss grotto behind a one-neck rock band, encounter zones
// instead of rooms, crystal + stalagmite dressing. Split out of
// dungeonlayout.js (Wave E prerequisite: one file per layout kind) — the
// shared contract lives in core.js's header and EVERY rule there binds this
// file too: determinism is load-bearing, no Math.random / Date.now, forked
// mulberry32 streams only, THREE-free and Node-importable.
// Consumers import ../dungeonlayout.js (the public facade), never this file.

import { mulberry32 } from '../../core/rng.js';
import {
  CELL, DOOR_THICKNESS, FACE_YAW, randint, originHalf,
  boundsFromMask, buildWallRuns, assignBudgets,
} from './core.js';

// ---------------------------------------------------------------------------
// cavern kind — DUNGEON_SPEC STEP 8 (C rank)
// ---------------------------------------------------------------------------
// One huge organic chamber instead of rooms-and-corridors: the floor mask is a
// union of random-walked discs plus attached side grottos, entered through the
// same +Z tunnel, with the boss grotto held OFF the mass behind a rock band
// and reattached by a single 2-cell neck — the one place a membrane arch can
// seal it (spec generation.cavernVariant). Encounter ZONES replace rooms: disc
// trigger records in the same rooms[] slot (kind/centre/spawnPoints/budget,
// plus `radius` — Dungeon.roomAt tests discs when radius is present), with NO
// doors on combat zones, so the director's seal machinery no-ops and packs
// aggro in the open. Downstream consumers (wall runs, budgets, translation,
// bounds) are byte-for-byte the crawl's own helpers.

const CARDINALS = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
};

function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function tryGenerateCavern(rank, params, enemies, seed) {
  const layoutRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const decorRnd = mulberry32((seed ^ 0x5f356495) >>> 0);

  const w = params.grid;
  const h = params.grid;
  const mask = new Uint8Array(w * h);
  const at = (gx, gz) => gx + gz * w;
  const isFloor = (gx, gz) => gx >= 0 && gz >= 0 && gx < w && gz < h && mask[at(gx, gz)] === 1;

  // Disc carve/probe in CELL units; centres are floats, cells claim by centre.
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
  const discClear = (cx, cz, rc) => {
    const x0 = Math.floor(cx - rc);
    const x1 = Math.ceil(cx + rc);
    const z0 = Math.floor(cz - rc);
    const z1 = Math.ceil(cz + rc);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx + 0.5 - cx;
        const dz = gz + 0.5 - cz;
        if (dx * dx + dz * dz > rc * rc) continue;
        if (gx < 1 || gz < 1 || gx > w - 2 || gz > h - 2) return false;
        if (mask[at(gx, gz)]) return false;
      }
    }
    return true;
  };

  // --- entry tunnel from +Z (3 cells wide) ---------------------------------
  const tw = params.tunnelWidth;
  const tunnelLen = randint(layoutRnd, params.tunnelLen[0], params.tunnelLen[1]);
  const tx0 = Math.floor((w - tw) / 2);
  const southPlaneRow = h - 1;                     // 1-row rock border kept
  const tunnelTop = southPlaneRow - tunnelLen;     // rows tunnelTop..h-2
  for (let gz = tunnelTop; gz < southPlaneRow; gz++) {
    for (let gx = tx0; gx < tx0 + tw; gx++) mask[at(gx, gz)] = 1;
  }
  const tunnelCX = tx0 + tw / 2;

  // --- disc-union random walk, -Z bias -------------------------------------
  // Each disc centre is derived from the previous with a step short enough to
  // guarantee overlap (union stays connected); the first disc swallows the
  // tunnel head so the tunnel opens INTO the cavern, never beside it.
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
      // Bounds clamping can stretch the step past the overlap guarantee —
      // pull the disc back toward its parent until they overlap by 1.5 cells.
      const prev = discs[discs.length - 1];
      const dx = cx - prev.cx;
      const dz = cz - prev.cz;
      const dist = Math.hypot(dx, dz) || 1;
      const maxD = prev.rc + rc - 1.5;
      if (dist > maxD) {
        cx = prev.cx + (dx / dist) * maxD;
        cz = prev.cz + (dz / dist) * maxD;
      }
    }
    carveDisc(cx, cz, rc);
    discs.push({ cx, cz, rc });
    const ang = layoutRnd() * Math.PI * 2;
    const step = rc * (0.8 + layoutRnd() * 0.5);
    px = cx + Math.cos(ang) * step;
    // |sin| keeps the lateral roll from cancelling the drift: the walk always
    // moves toward -Z (into the screen), the spec's growth direction.
    pz = cz - Math.abs(Math.sin(ang)) * step * 0.9 - rc * 0.25;
  }

  // --- attached side grottos ------------------------------------------------
  for (let k = 0; k < params.grottos; k++) {
    const base = discs[Math.floor(layoutRnd() * discs.length)];
    const rgc = (params.grottoR[0] + layoutRnd() * (params.grottoR[1] - params.grottoR[0])) / CELL;
    const ang = layoutRnd() * Math.PI * 2;
    // Offset < base.rc + rgc: the grotto always overlaps its base disc, so
    // attachment survives even when the bounds clamp nudges it.
    let gx = base.cx + Math.cos(ang) * (base.rc + rgc * 0.4);
    let gz = base.cz + Math.sin(ang) * (base.rc + rgc * 0.4);
    gx = clampNum(gx, rgc + 2, w - 2 - rgc);
    gz = clampNum(gz, rgc + 2, h - 2 - rgc);
    carveDisc(gx, gz, rgc);
  }

  // --- boss grotto: off the mass, one sealable neck -------------------------
  const bossRc = (params.bossR[0] + layoutRnd() * (params.bossR[1] - params.bossR[0])) / CELL;
  const gap = randint(layoutRnd, params.neckGap[0], params.neckGap[1]);
  // Anchor candidates: every walk disc, deepest (farthest from the tunnel
  // head) first, each trying cardinals ordered by how far they point from the
  // mass centroid — so the grotto prefers the deep rim but a cramped roll can
  // still land it off a shallower lobe instead of failing the whole attempt.
  let mx = 0;
  let mz = 0;
  for (const d of discs) { mx += d.cx; mz += d.cz; }
  mx /= discs.length; mz /= discs.length;
  const anchors = discs.slice().sort((a, b) => (
    Math.hypot(b.cx - tunnelCX, b.cz - tunnelTop) - Math.hypot(a.cx - tunnelCX, a.cz - tunnelTop)
  ));
  let neck = null;
  for (const anchor of anchors) {
    const away = { x: anchor.cx - mx, z: anchor.cz - mz };
    const dirOrder = Object.keys(CARDINALS).sort((a, b) => {
      const [ax, az] = CARDINALS[a];
      const [bx, bz] = CARDINALS[b];
      return (bx * away.x + bz * away.z) - (ax * away.x + az * away.z);
    });
    for (const dir of dirOrder) {
      const [sx, sz] = CARDINALS[dir];
      // March from the anchor centre to the mass boundary along this cardinal.
      let bx = Math.round(anchor.cx);
      let bz = Math.round(anchor.cz);
      if (!isFloor(bx, bz)) continue;
      while (isFloor(bx + sx, bz + sz)) { bx += sx; bz += sz; }
      // Centre one cell PAST band + radius so the anchor's own boundary cell
      // sits strictly outside the clearance probe — at exactly gap + bossRc
      // the probe rim grazes the mass and every cardinal fails on a curved
      // boundary (the bug class: 14/60 seeds with no legal grotto).
      const ccx = bx + 0.5 + sx * (gap + bossRc + 1);
      const ccz = bz + 0.5 + sz * (gap + bossRc + 1);
      if (ccx < bossRc + 2 || ccx > w - 2 - bossRc
        || ccz < bossRc + 2 || ccz > h - 2 - bossRc) continue;
      // The grotto disc plus a gap-wide shell must sit in clean rock: that
      // band is what makes the neck the ONLY way in.
      if (!discClear(ccx, ccz, bossRc + gap)) continue;
      neck = { dir, sx, sz, bx, bz, ccx, ccz };
      break;
    }
    if (neck) break;
  }
  if (!neck) return { depth: -1 };   // cramped roll — regen from seed+1
  carveDisc(neck.ccx, neck.ccz, bossRc);
  // Neck corridor: 2 cells wide along the cardinal, from the mass boundary
  // cell through the band into the grotto. Lane pair is centred on the march
  // line (bx or bz), so the door span always meets floor on both sides.
  const neckRect = neck.sx === 0
    ? { gx: neck.bx, gz: Math.min(neck.bz, Math.round(neck.ccz)), gw: 2, gd: Math.abs(Math.round(neck.ccz) - neck.bz) + 1 }
    : { gx: Math.min(neck.bx, Math.round(neck.ccx)), gz: neck.bz, gw: Math.abs(Math.round(neck.ccx) - neck.bx) + 1, gd: 2 };
  for (let gz = neckRect.gz; gz < neckRect.gz + neckRect.gd; gz++) {
    for (let gx = neckRect.gx; gx < neckRect.gx + neckRect.gw; gx++) {
      if (gx >= 1 && gz >= 1 && gx <= w - 2 && gz <= h - 2) mask[at(gx, gz)] = 1;
    }
  }
  // Membrane plane at the mass-side junction: the face of the boundary cell
  // that looks down the neck. Same door-record grammar as the crawl.
  const bossDoorRec = neck.sx === 0
    ? { plane: 'z', at: neck.sz < 0 ? neck.bz : neck.bz + 1, lo: neckRect.gx, hi: neckRect.gx + 1 }
    : { plane: 'x', at: neck.sx < 0 ? neck.bx : neck.bx + 1, lo: neckRect.gz, hi: neckRect.gz + 1 };

  // --- smoothing pass -------------------------------------------------------
  // One pass over a snapshot: lone floor nubs (<= 1 cardinal floor neighbour)
  // become rock, single-cell rock inlets (>= 3 floor neighbours) become floor
  // — this is what keeps the disc boundaries mergeable into sane wall runs.
  // The band around the boss grotto is >= 2 cells (discClear above), so no
  // band cell can reach 3 floor neighbours and the seal survives smoothing.
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

  // --- reachability sweep ---------------------------------------------------
  // BFS from the spawn cell; any floor the flood cannot reach (a clamped disc
  // that detached) is filled back to rock so wall runs and nav never see it.
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
  const bossCentreCell = at(Math.round(neck.ccx - 0.5), Math.round(neck.ccz - 0.5));
  if (bfs[bossCentreCell] < 0) return { depth: -1 };   // neck got severed

  // --- zone selection along the BFS-farthest chain --------------------------
  const nz = randint(layoutRnd, params.rooms[0], params.rooms[1]);
  const zoneRc = params.zoneRadius / CELL;
  const entryRc = Math.min(discs[0].rc, 4.5);
  const entryC = { cx: discs[0].cx, cz: discs[0].cz };
  // Interior candidates need FIGHTING ROOM, not just floor under the trigger.
  // The old test was a 5x5 floor neighbourhood (2 cells = 4 m clear), and the
  // soak found zone centres with as little as 5 m of open floor to the nearest
  // rock — a "huge cavern" fight in a lobe you cannot dash out of. The test is
  // now a clear DISC: openR(rc) demands every floor cell within rc cells, so
  // rc = 6 cells gives 12 m in every direction = 24 m across = 3.2 dashes,
  // the same bar the crawl's rooms have to clear. Tiers relax to 5 then 4
  // cells only if the roll leaves too few candidates, so a cramped cavern
  // degrades instead of failing outright.
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
  const inNeck = (gx, gz) => gx >= neckRect.gx - 1 && gx < neckRect.gx + neckRect.gw + 1
    && gz >= neckRect.gz - 1 && gz < neckRect.gz + neckRect.gd + 1;
  const gatherCandidates = (clearRc) => {
    const out = [];
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const i = at(gx, gz);
        if (!mask[i] || bfs[i] < 0) continue;
        if (!openR(gx, gz, clearRc)) continue;
        if (inNeck(gx, gz)) continue;
        const cx = gx + 0.5;
        const cz = gz + 0.5;
        if (Math.hypot(cx - neck.ccx, cz - neck.ccz) < bossRc + zoneRc * 0.5) continue;
        if (Math.hypot(cx - entryC.cx, cz - entryC.cz) < entryRc + zoneRc * 0.6) continue;
        out.push({ gx, gz, d: bfs[i] });
      }
    }
    return out;
  };
  // Deterministic tier walk: strictest clearance that still leaves candidates
  // to spread over the depth range. `nz * 3` is the "enough to choose from"
  // bar — fewer than that and the spread loop just clusters.
  let candidates = [];
  for (const clearRc of [6, 5, 4]) {
    candidates = gatherCandidates(clearRc);
    if (candidates.length >= nz * 3) break;
  }
  candidates.sort((a, b) => a.d - b.d || (a.gx + a.gz * w) - (b.gx + b.gz * w));
  // Spread the zones over the WHOLE BFS depth range (the "BFS-farthest chain"):
  // evenly spaced depth targets, each filled by the spacing-respecting
  // candidate nearest its target — a plain greedy would cluster every zone at
  // the shallow end and leave the deep half of the cavern empty.
  const maxD = candidates.length ? candidates[candidates.length - 1].d : 0;
  let zones = [];
  for (let relax = 0; relax < 3 && zones.length < params.rooms[0]; relax++) {
    // The relax rungs may NOT fall below one zone radius: a zone centre inside
    // another zone's trigger disc makes membership depend on record order, and
    // the soak caught exactly that (two zones 8.2 m apart at radius 10) once
    // the stricter clearance filter started pushing rolls onto the low rung.
    const spacing = Math.max(zoneRc,
      (params.zoneSpacing / CELL) * (1 - relax * 0.25));
    zones = [];
    for (let k = 1; k <= nz; k++) {
      const target = (maxD * k) / (nz + 0.35);   // last target short of the tip
      let best = null;
      let bestScore = Infinity;
      for (const c of candidates) {
        let clear = true;
        for (const zn of zones) {
          if (Math.hypot(c.gx - zn.gx, c.gz - zn.gz) < spacing) { clear = false; break; }
        }
        if (!clear) continue;
        const score = Math.abs(c.d - target);
        if (score < bestScore) { bestScore = score; best = c; }
      }
      if (best) zones.push(best);
    }
    zones.sort((a, b) => a.d - b.d || (a.gx + a.gz * w) - (b.gx + b.gz * w));
  }
  if (zones.length < params.rooms[0]) return { depth: -1 };

  // --- world translation (same maths as the crawl) --------------------------
  const southPlane = southPlaneRow * CELL;
  const originX = -tunnelCX * CELL;
  const originZ = -(southPlane - 1.6);
  const toX = (cx) => originX + cx * CELL;
  const toZ = (cz) => originZ + cz * CELL;

  // --- rooms: entry + zones + boss, all discs -------------------------------
  const outRooms = [];
  const pushDiscRoom = (kind, cx, cz, radiusM) => {
    const id = outRooms.length;
    outRooms.push({
      id,
      kind,
      radius: radiusM,
      x: toX(cx) - radiusM,
      z: toZ(cz) - radiusM,
      w: radiusM * 2,
      d: radiusM * 2,
      centre: { x: toX(cx), z: toZ(cz) },
      doors: [],
      spawnPoints: [],
      budget: 0,
    });
    return id;
  };
  pushDiscRoom('entry', entryC.cx, entryC.cz, entryRc * CELL);
  for (const zn of zones) pushDiscRoom('combat', zn.gx + 0.5, zn.gz + 0.5, params.zoneRadius);
  const bossId = pushDiscRoom('boss', neck.ccx, neck.ccz, bossRc * CELL);

  // --- doors: the entry arch and the boss neck membrane ---------------------
  const doorRecs = [
    { plane: 'z', at: tunnelTop, lo: tx0, hi: tx0 + tw - 1, roomA: 0, roomB: -1 },
    { ...bossDoorRec, roomA: bossId, roomB: -1 },
  ];
  const outDoors = doorRecs.map((d, i) => {
    const span = (d.hi - d.lo + 1) * CELL;
    const mid = originHalf(d.lo, d.hi);
    return d.plane === 'z'
      ? { id: i, x: toX(mid), z: toZ(d.at), w: span, d: DOOR_THICKNESS, rot: 0, roomA: d.roomA, roomB: d.roomB }
      : { id: i, x: toX(d.at), z: toZ(mid), w: span, d: DOOR_THICKNESS, rot: Math.PI / 2, roomA: d.roomA, roomB: d.roomB };
  });
  outRooms[0].doors.push(0);
  outRooms[bossId].doors.push(1);

  const outCorridors = [
    { x: toX(tx0 + tw / 2), z: toZ(tunnelTop + tunnelLen / 2), w: tw * CELL, d: tunnelLen * CELL },
    {
      x: toX(neckRect.gx + neckRect.gw / 2),
      z: toZ(neckRect.gz + neckRect.gd / 2),
      w: neckRect.gw * CELL,
      d: neckRect.gd * CELL,
    },
  ];

  // --- wall runs / spawn points / budgets -----------------------------------
  const wallRuns = buildWallRuns(mask, w, h, at, originX, originZ);
  for (const r of outRooms) {
    r.spawnPoints = discSpawnPoints(r, mask, w, h, at, originX, originZ, layoutRnd);
  }
  const criticalPath = [0, ...outRooms.filter((r) => r.kind === 'combat').map((r) => r.id), bossId];
  assignBudgets(outRooms, criticalPath, enemies);

  const { bounds, radius } = boundsFromMask(mask, w, h, at, originX, originZ);

  // --- decor: crystals + stalagmite field (decorRnd only) -------------------
  const decor = buildCavernDecor(outRooms, outDoors, wallRuns, params, decorRnd, {
    mask, w, h, at, originX, originZ, neckRect, tunnel: { tx0, tw, tunnelTop },
  });

  return {
    kind: 'cavern',
    rank,
    cell: CELL,
    w,
    h,
    originX,
    originZ,
    mask,
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
}

// Spawn points for a disc room: jittered cell centres inside the trigger disc
// whose full 8-neighbourhood is floor (>= ~2.5 m of wall clearance survives
// the jitter), greedy 2.4 m spacing — the crawl's guarantees, disc-shaped.
function discSpawnPoints(room, mask, w, h, at, originX, originZ, rnd) {
  const ccx = (room.centre.x - originX) / CELL;
  const ccz = (room.centre.z - originZ) / CELL;
  const rc = room.radius / CELL - 0.6;   // keep the jittered point inside
  const pts = [];
  const z0 = Math.max(1, Math.floor(ccz - rc));
  const z1 = Math.min(h - 2, Math.ceil(ccz + rc));
  const x0 = Math.max(1, Math.floor(ccx - rc));
  const x1 = Math.min(w - 2, Math.ceil(ccx + rc));
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      const dx = gx + 0.5 - ccx;
      const dz = gz + 0.5 - ccz;
      if (dx * dx + dz * dz > rc * rc) continue;
      let open = true;
      for (let oz = -1; oz <= 1 && open; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = gx + ox;
          const nz = gz + oz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h || !mask[at(nx, nz)]) { open = false; break; }
        }
      }
      if (!open) continue;
      pts.push({
        x: originX + (gx + 0.5) * CELL + (rnd() - 0.5),
        z: originZ + (gz + 0.5) * CELL + (rnd() - 0.5),
      });
    }
  }
  const kept = [];
  for (const p of pts) {
    let clear = true;
    for (const k of kept) {
      if ((p.x - k.x) ** 2 + (p.z - k.z) ** 2 < 2.4 * 2.4) { clear = false; break; }
    }
    if (clear) kept.push(p);
  }
  return kept;
}

// Cavern decor — decorRnd ONLY, like the crawl's. Crystals are the light-pool
// anchors (torchSpacing is n/a for C); the stalagmite field is the cover the
// zone fights are designed around, with clearing radii keeping every zone
// centre, spawn point and door approach open — cover that seals a spawn point
// is how enemies get stuck inside scenery (spec cavernVariant).
function buildCavernDecor(rooms, doors, wallRuns, params, rnd, ctx) {
  const { mask, w, h, at, originX, originZ, neckRect, tunnel } = ctx;
  const isFloor = (gx, gz) => gx >= 0 && gz >= 0 && gx < w && gz < h && mask[at(gx, gz)] === 1;

  // Crystal clusters along the wall runs (the torch-loop pattern at cavern
  // spacing) — the walls read bioluminescent and the light pool always has an
  // anchor near the player.
  const crystals = [];
  for (const run of wallRuns) {
    const len = Math.max(run.w, run.d);
    if (len < params.crystalSpacing * 0.6) continue;
    const yaw = FACE_YAW[run.face];
    const along = run.w > run.d ? 'x' : 'z';
    let s = params.crystalSpacing * (0.25 + rnd() * 0.5);
    for (; s < len; s += params.crystalSpacing) {
      const t = s - len / 2;
      crystals.push({
        x: run.x + (along === 'x' ? t : 0),
        z: run.z + (along === 'z' ? t : 0),
        yaw,
      });
    }
  }
  // One free-standing cluster near each zone centre, when the roll finds
  // floor: the fight arenas glow from within, not just at the rim.
  for (const r of rooms) {
    if (r.kind !== 'combat') continue;
    const ang = rnd() * Math.PI * 2;
    const cx = r.centre.x + Math.cos(ang) * 3.4;
    const cz = r.centre.z + Math.sin(ang) * 3.4;
    const gx = Math.floor((cx - originX) / CELL);
    const gz = Math.floor((cz - originZ) / CELL);
    let open = true;
    for (let oz = -1; oz <= 1 && open; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!isFloor(gx + ox, gz + oz)) { open = false; break; }
      }
    }
    if (open) crystals.push({ x: cx, z: cz, yaw: rnd() * Math.PI * 2 });
  }

  // Stalagmite field: jittered-grid Poisson over the floor, cleared around
  // zone centres, spawn points, door approaches, the tunnel and the neck.
  const sg = params.stalagmites;
  const stalagmites = [];
  const clearOf = (x, z) => {
    for (const r of rooms) {
      const dd = Math.hypot(x - r.centre.x, z - r.centre.z);
      if (dd < sg.zoneClear) return false;
      for (const p of r.spawnPoints) {
        if (Math.hypot(x - p.x, z - p.z) < sg.spawnClear) return false;
      }
    }
    for (const d of doors) {
      if (Math.hypot(x - d.x, z - d.z) < sg.doorClear) return false;
    }
    return true;
  };
  const step = sg.cellStep;
  for (let gz = 1; gz < h - 1; gz += step) {
    for (let gx = 1; gx < w - 1; gx += step) {
      // Fixed roll count per lattice point regardless of outcome, so the
      // stream never shifts when a clearing rule changes a neighbour.
      const jx = gx + Math.floor(rnd() * step);
      const jz = gz + Math.floor(rnd() * step);
      const keep = rnd() < sg.chance;
      const spire = rnd() < sg.spireChance;
      const ox = (rnd() - 0.5) * 1.4;
      const oz = (rnd() - 0.5) * 1.4;
      const rr = rnd();
      const hr = rnd();
      const yaw = rnd() * Math.PI * 2;
      if (!keep) continue;
      // Full 8-neighbourhood floor keeps every piece >= ~1.5 m off the walls.
      let open = true;
      for (let dz2 = -1; dz2 <= 1 && open; dz2++) {
        for (let dx2 = -1; dx2 <= 1; dx2++) {
          if (!isFloor(jx + dx2, jz + dz2)) { open = false; break; }
        }
      }
      if (!open) continue;
      // Never inside the tunnel or the neck — a spire in a 2-cell corridor is
      // a soft lock.
      if (jx >= tunnel.tx0 - 1 && jx <= tunnel.tx0 + tunnel.tw && jz >= tunnel.tunnelTop - 1) continue;
      if (jx >= neckRect.gx - 1 && jx < neckRect.gx + neckRect.gw + 1
        && jz >= neckRect.gz - 1 && jz < neckRect.gz + neckRect.gd + 1) continue;
      const x = originX + (jx + 0.5) * CELL + ox;
      const z = originZ + (jz + 0.5) * CELL + oz;
      if (!clearOf(x, z)) continue;
      stalagmites.push(spire
        ? { x, z, kind: 'spire', r: 0.35 + rr * 0.3, h: 2.2 + hr * 2.0, yaw }
        : { x, z, kind: 'rubble', r: 0.5 + rr * 0.4, h: 0.5 + hr * 0.4, yaw });
    }
  }

  // `cover` stays empty for C: the stalagmite field above IS the cavern's
  // cover (see the LAYOUT_PARAMS.C note), and every consumer reads one shape.
  return { torches: [], columns: [], props: [], alcoves: [], crystals, stalagmites, cover: [] };
}
