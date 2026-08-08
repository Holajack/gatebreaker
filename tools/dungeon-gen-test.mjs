// Dungeon layout generation soak — DUNGEON_SPEC.json testStrategy.unit_generation.
//
//   node tools/dungeon-gen-test.mjs             # 200 seeds x {E, D}
//   node tools/dungeon-gen-test.mjs --seeds=20  # quick pass
//
// Plain Node, no browser, no vite: dungeonlayout.js is deliberately THREE-free
// so this can hammer hundreds of layouts per second. Per layout it asserts the
// spec's invariants (reachability, boss depth, door spans, room counts/sizes,
// mask consistency, the (0,0) entry translation with -Z drift, spawn-point
// wall clearance and spacing, exact budget sums) and byte-compares a repeat
// generation of the same seed — determinism is the context-loss repair path,
// so it is tested as a hard invariant, not a nice-to-have.
//
// Writes a stats JSON (writeReport shape, honours GB_OUT) for tuning eyeballs.
// C runs the STEP 8 cavern kind through its own invariant set (zones are
// discs, zones carry no doors, the boss grotto is unreachable with its neck
// membrane blocked, the stalagmite field honours every clearing radius).

import { generateLayout, layoutStats, LAYOUT_PARAMS } from '../src/world/dungeonlayout.js';
import { writeReport } from './_harness.mjs';

const argv = process.argv.slice(2);
const SEEDS = Number((argv.find((a) => a.startsWith('--seeds=')) || '').split('=')[1]) || 200;
const RANKS = ['E', 'D', 'C'];

let checks = 0;
let failures = 0;
const failLines = [];

function ok(pass, label) {
  checks++;
  if (!pass) {
    failures++;
    if (failLines.length < 40) failLines.push(label);
  }
  return pass;
}

// Stable byte serialization: JSON with typed arrays as base64.
function serialize(layout) {
  return Buffer.from(JSON.stringify(layout, (k, v) => (
    v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v
  )));
}

const f1 = (n) => n.toFixed(1);

// Point-to-axis-aligned-box surface distance (every run has rot 0).
function runDistance(p, run) {
  const dx = Math.max(Math.abs(p.x - run.x) - run.w / 2, 0);
  const dz = Math.max(Math.abs(p.z - run.z) - run.d / 2, 0);
  return Math.hypot(dx, dz);
}

function checkLayout(rank, seed, layout, params) {
  if (layout.kind === 'cavern') return checkCavernLayout(rank, seed, layout, params);
  const tag = `${rank}/${seed}`;
  const R = layout.rooms;

  // --- reachability: BFS over doors, every room reached from entry ---------
  const adj = Array.from({ length: R.length }, () => []);
  for (const d of layout.doors) {
    if (d.roomA >= 0 && d.roomB >= 0) {
      adj[d.roomA].push(d.roomB);
      adj[d.roomB].push(d.roomA);
    }
  }
  const seen = new Set([0]);
  const q = [0];
  while (q.length) {
    const cur = q.shift();
    for (const nb of adj[cur]) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  ok(seen.size === R.length, `${tag}: ${R.length - seen.size} unreachable room(s)`);

  // --- boss depth ----------------------------------------------------------
  ok(layout.depth >= params.minBossDepth,
    `${tag}: boss depth ${layout.depth} < ${params.minBossDepth}`);
  ok(R[layout.bossRoom].kind === 'boss', `${tag}: bossRoom is ${R[layout.bossRoom].kind}`);
  ok(layout.criticalPath[0] === 0 && layout.criticalPath.at(-1) === layout.bossRoom,
    `${tag}: criticalPath endpoints ${layout.criticalPath[0]}..${layout.criticalPath.at(-1)}`);

  // --- door spans ----------------------------------------------------------
  for (const d of layout.doors) {
    ok(d.w >= 4, `${tag}: door ${d.id} span ${d.w} < 4 m`);
  }

  // --- room counts and sizes -----------------------------------------------
  const kinds = { entry: 0, combat: 0, treasure: 0, boss: 0 };
  for (const r of R) kinds[r.kind]++;
  ok(kinds.entry === 1 && kinds.boss === 1, `${tag}: entry/boss counts ${kinds.entry}/${kinds.boss}`);
  const regular = R.length - 2;
  ok(regular >= params.rooms[0] && regular <= params.rooms[1],
    `${tag}: ${regular} regular rooms outside ${params.rooms}`);
  if (params.treasure.guaranteed) {
    // "Exactly one" holds whenever the topology allows it: a rare pure-chain
    // layout can put EVERY room on the critical path, and treasure is defined
    // as off-path — zero is only legal in exactly that case.
    const onPath = new Set(layout.criticalPath);
    const offPath = R.filter((r) => (r.kind === 'combat' || r.kind === 'treasure') && !onPath.has(r.id));
    ok(kinds.treasure === 1 || (kinds.treasure === 0 && offPath.length === 0),
      `${tag}: ${kinds.treasure} treasure rooms with ${offPath.length} off-path candidates`);
  } else {
    ok(kinds.treasure <= 1, `${tag}: ${kinds.treasure} treasure rooms, expected 0-1`);
  }
  const sizeOk = ({ w, d }, s) =>
    w >= s.w[0] * 2 && w <= s.w[1] * 2 && d >= s.d[0] * 2 && d <= s.d[1] * 2;
  for (const r of R) {
    if (r.kind === 'boss') {
      // The boss room starts as a regular roll (or the D vault hall) and is
      // grown TOWARD bossSize, refusing sides that touch other floor — so its
      // legal range is [roomSize min .. max(bossSize, vault max)].
      const maxW = Math.max(params.bossSize.w, params.vault ? params.vault.w[1] : 0) * 2;
      const maxD = Math.max(params.bossSize.d, params.vault ? params.vault.d[1] : 0) * 2;
      ok(r.w >= params.roomSize.w[0] * 2 && r.w <= maxW
        && r.d >= params.roomSize.d[0] * 2 && r.d <= maxD,
      `${tag}: boss room ${r.w}x${r.d} outside roll..bossSize/vault range`);
    } else {
      const fits = sizeOk(r, params.roomSize) || (params.vault && sizeOk(r, params.vault));
      ok(fits, `${tag}: room ${r.id} (${r.kind}) ${r.w}x${r.d} outside size params`);
    }
  }

  // --- mask consistency ----------------------------------------------------
  // Reclaim every cell from the exported rects; assert single ownership, that
  // claims match the mask exactly, that no two rooms touch directly, and that
  // every room<->corridor adjacency is covered by a registered door — a bare
  // (door-less) opening would let enemies walk past a sealed membrane.
  const { w, h, cell, originX, originZ, mask } = layout;
  const gx = (x) => Math.round((x - originX) / cell);
  const gz = (z) => Math.round((z - originZ) / cell);
  const claim = new Int16Array(w * h).fill(-1);   // -1 rock, -2 corridor, id room
  let doubleClaim = 0;
  const stamp = (r, val) => {
    const x0 = gx(r.x ?? r.cx);
    const z0 = gz(r.z ?? r.cz);
    for (let z = z0; z < z0 + Math.round(r.d / cell); z++) {
      for (let x = x0; x < x0 + Math.round(r.w / cell); x++) {
        if (claim[x + z * w] !== -1) doubleClaim++;
        claim[x + z * w] = val;
      }
    }
  };
  for (const r of R) stamp(r, r.id);
  for (const c of layout.corridors) stamp({ x: c.x - c.w / 2, z: c.z - c.d / 2, w: c.w, d: c.d }, -2);
  ok(doubleClaim === 0, `${tag}: ${doubleClaim} double-claimed cells (room/corridor overlap)`);
  let claimMismatch = 0;
  for (let i = 0; i < w * h; i++) {
    if ((mask[i] === 1) !== (claim[i] !== -1)) claimMismatch++;
  }
  ok(claimMismatch === 0, `${tag}: ${claimMismatch} cells where mask and room/corridor rects disagree`);

  // Door openings in grid space, for the adjacency coverage check.
  const doorCells = new Set();
  for (const d of layout.doors) {
    const span = Math.round(d.w / cell);
    if (d.rot === 0) {
      const plane = Math.round((d.z - originZ) / cell);
      const lo = Math.round((d.x - d.w / 2 - originX) / cell);
      for (let i = 0; i < span; i++) doorCells.add(`z:${plane}:${lo + i}`);
    } else {
      const plane = Math.round((d.x - originX) / cell);
      const lo = Math.round((d.z - d.w / 2 - originZ) / cell);
      for (let i = 0; i < span; i++) doorCells.add(`x:${plane}:${lo + i}`);
    }
  }
  let roomTouch = 0;
  let bareOpening = 0;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w - 1; x++) {
      const a = claim[x + z * w];
      const b = claim[x + 1 + z * w];
      if (a === -1 || b === -1 || a === b) continue;
      if (a >= 0 && b >= 0) { roomTouch++; continue; }
      if (!doorCells.has(`x:${x + 1}:${z}`)) bareOpening++;
    }
  }
  for (let z = 0; z < h - 1; z++) {
    for (let x = 0; x < w; x++) {
      const a = claim[x + z * w];
      const b = claim[x + (z + 1) * w];
      if (a === -1 || b === -1 || a === b) continue;
      if (a >= 0 && b >= 0) { roomTouch++; continue; }
      if (!doorCells.has(`z:${z + 1}:${x}`)) bareOpening++;
    }
  }
  ok(roomTouch === 0, `${tag}: ${roomTouch} direct room-to-room adjacencies (no separating wall)`);
  ok(bareOpening === 0, `${tag}: ${bareOpening} room/corridor adjacencies not covered by a door`);

  // --- entry translation + drift -------------------------------------------
  ok(layout.entry.x === 0 && layout.entry.z === 0 && layout.entry.yaw === 0,
    `${tag}: entry ${JSON.stringify(layout.entry)}`);
  ok(mask[gx(0) + gz(0) * w] === 1, `${tag}: spawn (0,0) is not on floor`);
  const meanZ = R.reduce((s, r) => s + r.centre.z, 0) / R.length;
  ok(meanZ < 0, `${tag}: mean room centre z ${f1(meanZ)} — no -Z drift`);

  // --- spawn points --------------------------------------------------------
  for (const r of R) {
    ok(r.spawnPoints.length >= 2,
      `${tag}: room ${r.id} (${r.kind}) has ${r.spawnPoints.length} spawn points`);
    for (const p of r.spawnPoints) {
      let minD = Infinity;
      for (const run of layout.wallRuns) {
        const d = runDistance(p, run);
        if (d < minD) minD = d;
      }
      ok(minD >= 1.5, `${tag}: room ${r.id} spawn point ${f1(minD)} m from a wall run`);
    }
    for (let i = 0; i < r.spawnPoints.length; i++) {
      for (let j = i + 1; j < r.spawnPoints.length; j++) {
        const a = r.spawnPoints[i];
        const b = r.spawnPoints[j];
        ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2.4,
          `${tag}: room ${r.id} spawn points ${i}/${j} closer than 2.4 m`);
      }
    }
  }

  // --- budgets -------------------------------------------------------------
  const total = R.reduce((s, r) => s + r.budget, 0);
  ok(total === params.enemies, `${tag}: budgets sum ${total} != gate.enemies ${params.enemies}`);
  for (const r of R) {
    if (r.kind === 'combat') ok(r.budget >= 1, `${tag}: combat room ${r.id} budget ${r.budget}`);
    else ok(r.budget === 0, `${tag}: ${r.kind} room ${r.id} has budget ${r.budget}`);
  }
}

// ---------------------------------------------------------------------------
// cavern invariants — DUNGEON_SPEC STEP 8
// ---------------------------------------------------------------------------

function checkCavernLayout(rank, seed, layout, params) {
  const tag = `${rank}/${seed}`;
  const R = layout.rooms;
  const { w, h, cell, originX, originZ, mask } = layout;
  const gxOf = (x) => Math.floor((x - originX) / cell);
  const gzOf = (z) => Math.floor((z - originZ) / cell);
  const floorAt = (x, z) => {
    const gx = gxOf(x);
    const gz = gzOf(z);
    return gx >= 0 && gz >= 0 && gx < w && gz < h && mask[gx + gz * w] === 1;
  };

  // --- rooms: 1 entry + [4,5] zones + 1 boss, all discs on floor -----------
  const kinds = { entry: 0, combat: 0, treasure: 0, boss: 0 };
  for (const r of R) kinds[r.kind]++;
  ok(kinds.entry === 1 && kinds.boss === 1 && kinds.treasure === 0,
    `${tag}: kinds ${JSON.stringify(kinds)}`);
  ok(kinds.combat >= params.rooms[0] && kinds.combat <= params.rooms[1],
    `${tag}: ${kinds.combat} zones outside ${params.rooms}`);
  for (const r of R) {
    ok(r.radius > 0, `${tag}: room ${r.id} has no trigger-disc radius`);
    ok(floorAt(r.centre.x, r.centre.z), `${tag}: room ${r.id} centre is not on floor`);
  }
  // Zone separation: no zone centre may sit inside another zone's disc, or
  // trigger membership turns on record order.
  const zones = R.filter((r) => r.kind === 'combat');
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const d = Math.hypot(
        zones[i].centre.x - zones[j].centre.x, zones[i].centre.z - zones[j].centre.z,
      );
      ok(d >= params.zoneRadius, `${tag}: zones ${zones[i].id}/${zones[j].id} ${f1(d)} m apart`);
    }
  }

  // --- boss depth / path ----------------------------------------------------
  ok(layout.depth >= params.minBossDepth, `${tag}: depth ${layout.depth} < ${params.minBossDepth}`);
  ok(R[layout.bossRoom].kind === 'boss', `${tag}: bossRoom is ${R[layout.bossRoom].kind}`);
  ok(layout.criticalPath[0] === 0 && layout.criticalPath.at(-1) === layout.bossRoom,
    `${tag}: criticalPath endpoints ${layout.criticalPath[0]}..${layout.criticalPath.at(-1)}`);

  // --- doors: entry arch + boss neck ONLY; zones are doorless --------------
  ok(layout.doors.length === 2, `${tag}: ${layout.doors.length} doors, expected 2`);
  for (const d of layout.doors) ok(d.w >= 4, `${tag}: door ${d.id} span ${d.w} < 4 m`);
  for (const r of R) {
    if (r.kind === 'combat') {
      ok(r.doors.length === 0, `${tag}: zone ${r.id} carries doors — zones must never seal`);
    }
  }
  const bossDoorIds = R[layout.bossRoom].doors;
  ok(bossDoorIds.length === 1, `${tag}: boss grotto has ${bossDoorIds.length} doors, expected 1`);

  // --- reachability, and the neck as the ONLY way in ------------------------
  // BFS over the floor mask from the spawn cell; optionally with the boss
  // door's span stamped solid, which must sever the grotto — that is the
  // membrane arch doing its one job.
  const bossDoor = layout.doors[bossDoorIds[0]];
  const bfsReach = (blockBossDoor) => {
    const seen = new Uint8Array(w * h);
    const sx = gxOf(0);
    const sz = gzOf(0);
    const start = sx + sz * w;
    if (!mask[start]) return seen;
    const blocked = (gx, gz) => {
      if (!blockBossDoor) return false;
      const x = originX + (gx + 0.5) * cell;
      const z = originZ + (gz + 0.5) * cell;
      const [ax, az] = bossDoor.rot === 0 ? [x - bossDoor.x, z - bossDoor.z] : [z - bossDoor.z, x - bossDoor.x];
      return Math.abs(ax) <= bossDoor.w / 2 + 0.1 && Math.abs(az) <= 1.4;
    };
    seen[start] = 1;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cgx = cur % w;
      const cgz = (cur / w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cgx + dx;
        const nz = cgz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nx + nz * w;
        if (!mask[ni] || seen[ni] || blocked(nx, nz)) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    return seen;
  };
  const reach = bfsReach(false);
  const reached = (seen, x, z) => seen[gxOf(x) + gzOf(z) * w] === 1;
  for (const r of R) {
    ok(reached(reach, r.centre.x, r.centre.z), `${tag}: room ${r.id} centre unreachable from spawn`);
    for (const p of r.spawnPoints) {
      ok(reached(reach, p.x, p.z), `${tag}: room ${r.id} spawn point unreachable`);
    }
  }
  const sealed = bfsReach(true);
  const bossC = R[layout.bossRoom].centre;
  ok(!reached(sealed, bossC.x, bossC.z),
    `${tag}: boss grotto reachable AROUND the neck membrane — the seal is decorative`);

  // --- entry translation + drift -------------------------------------------
  ok(layout.entry.x === 0 && layout.entry.z === 0 && layout.entry.yaw === 0,
    `${tag}: entry ${JSON.stringify(layout.entry)}`);
  ok(floorAt(0, 0), `${tag}: spawn (0,0) is not on floor`);
  const meanZ = R.reduce((s, r) => s + r.centre.z, 0) / R.length;
  ok(meanZ < 0, `${tag}: mean room centre z ${f1(meanZ)} — no -Z drift`);

  // --- spawn points ---------------------------------------------------------
  for (const r of R) {
    const need = r.kind === 'entry' ? 4 : 6;   // escort min 4; waveSize C is 6
    ok(r.spawnPoints.length >= need,
      `${tag}: room ${r.id} (${r.kind}) has ${r.spawnPoints.length} spawn points, need ${need}`);
    for (const p of r.spawnPoints) {
      let minD = Infinity;
      for (const run of layout.wallRuns) {
        const d = runDistance(p, run);
        if (d < minD) minD = d;
      }
      ok(minD >= 1.5, `${tag}: room ${r.id} spawn point ${f1(minD)} m from a wall run`);
      ok(Math.hypot(p.x - r.centre.x, p.z - r.centre.z) <= r.radius,
        `${tag}: room ${r.id} spawn point outside its trigger disc`);
    }
    for (let i = 0; i < r.spawnPoints.length; i++) {
      for (let j = i + 1; j < r.spawnPoints.length; j++) {
        const a = r.spawnPoints[i];
        const b = r.spawnPoints[j];
        ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2.4,
          `${tag}: room ${r.id} spawn points ${i}/${j} closer than 2.4 m`);
      }
    }
  }

  // --- budgets -------------------------------------------------------------
  const total = R.reduce((s, r) => s + r.budget, 0);
  ok(total === params.enemies, `${tag}: budgets sum ${total} != gate.enemies ${params.enemies}`);
  for (const r of R) {
    if (r.kind === 'combat') ok(r.budget >= 1, `${tag}: zone ${r.id} budget ${r.budget}`);
    else ok(r.budget === 0, `${tag}: ${r.kind} room ${r.id} has budget ${r.budget}`);
  }

  // --- stalagmite field + crystals -----------------------------------------
  const sgs = layout.decor.stalagmites;
  ok(sgs.length >= 25, `${tag}: only ${sgs.length} stalagmites — no cover field`);
  ok(sgs.some((s) => s.kind === 'spire') && sgs.some((s) => s.kind === 'rubble'),
    `${tag}: stalagmite field missing a kind`);
  let clearingViolations = 0;
  for (const s of sgs) {
    if (!floorAt(s.x, s.z)) clearingViolations++;
    for (const r of R) {
      if (Math.hypot(s.x - r.centre.x, s.z - r.centre.z) < 3.2) clearingViolations++;
      for (const p of r.spawnPoints) {
        if (Math.hypot(s.x - p.x, s.z - p.z) < 2.0) clearingViolations++;
      }
    }
    for (const d of layout.doors) {
      if (Math.hypot(s.x - d.x, s.z - d.z) < 2.8) clearingViolations++;
    }
  }
  ok(clearingViolations === 0,
    `${tag}: ${clearingViolations} stalagmite clearing violations (cover sealing a spawn/door)`);
  ok(layout.decor.crystals.length >= 10,
    `${tag}: only ${layout.decor.crystals.length} crystal clusters — the light pool starves`);
  ok(layout.decor.torches.length === 0, `${tag}: cavern rolled torches`);
}

function asciiMap(layout) {
  const { w, h, mask } = layout;
  const grid = [];
  for (let z = 0; z < h; z++) {
    let row = '';
    for (let x = 0; x < w; x++) row += mask[x + z * w] ? '.' : '#';
    grid.push(row);
  }
  const mark = (x, z, ch) => {
    const gx = Math.round((x - layout.originX) / layout.cell - 0.5);
    const gz = Math.round((z - layout.originZ) / layout.cell - 0.5);
    if (gz >= 0 && gz < h && gx >= 0 && gx < w) {
      grid[gz] = grid[gz].slice(0, gx) + ch + grid[gz].slice(gx + 1);
    }
  };
  for (const r of layout.rooms) {
    mark(r.centre.x, r.centre.z, { entry: 'E', combat: 'C', treasure: 'T', boss: 'B' }[r.kind]);
  }
  mark(0, 0, 'S');
  return grid;
}

// ---------------------------------------------------------------------------

const t0 = process.hrtime.bigint();
const stats = {};
const maps = {};

for (const rank of RANKS) {
  const params = LAYOUT_PARAMS[rank];
  const agg = {
    layouts: 0,
    depth: { min: Infinity, max: -Infinity, sum: 0 },
    rooms: { min: Infinity, max: -Infinity, sum: 0 },
    floorCells: { min: Infinity, max: -Infinity, sum: 0 },
    doors: { min: Infinity, max: -Infinity, sum: 0 },
    wallRuns: { min: Infinity, max: -Infinity, sum: 0 },
    spawnPoints: { min: Infinity, max: -Infinity, sum: 0 },
    treasureRooms: 0,
    determinismFailures: 0,
  };
  for (let i = 0; i < SEEDS; i++) {
    // Spread the seed space instead of 0..199 — layout must not depend on
    // "small" seeds, and _beginGate hands out full 32-bit ones.
    const seed = ((i * 2654435761) ^ 0x1234abcd) >>> 0;
    const layout = generateLayout({ rank, seed });
    checkLayout(rank, seed, layout, params);

    // Determinism: a repeat generation must be byte-identical.
    const again = generateLayout({ rank, seed });
    const same = serialize(layout).equals(serialize(again));
    if (!same) agg.determinismFailures++;
    ok(same, `${rank}/${seed}: repeat generation differs (DETERMINISM BROKEN)`);

    const s = layoutStats(layout);
    agg.layouts++;
    for (const [key, val] of [
      ['depth', s.depth], ['rooms', s.rooms], ['floorCells', s.floorCells],
      ['doors', s.doors], ['wallRuns', s.wallRuns], ['spawnPoints', s.spawnPoints],
    ]) {
      const a = agg[key];
      a.min = Math.min(a.min, val);
      a.max = Math.max(a.max, val);
      a.sum += val;
    }
    agg.treasureRooms += s.kinds.treasure || 0;
    if (i === 0) maps[rank] = asciiMap(layout);
  }
  for (const key of ['depth', 'rooms', 'floorCells', 'doors', 'wallRuns', 'spawnPoints']) {
    agg[key].mean = +(agg[key].sum / agg.layouts).toFixed(2);
    delete agg[key].sum;
  }
  agg.treasureRate = +(agg.treasureRooms / agg.layouts).toFixed(2);
  stats[rank] = agg;
}

const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`dungeon-gen soak: ${SEEDS} seeds x {${RANKS.join(', ')}} in ${ms.toFixed(0)} ms`);
for (const rank of RANKS) {
  const s = stats[rank];
  console.log(`  ${rank}: depth ${s.depth.min}-${s.depth.max} (mean ${s.depth.mean})  `
    + `rooms ${s.rooms.min}-${s.rooms.max}  doors ${s.doors.min}-${s.doors.max}  `
    + `floorCells ${s.floorCells.min}-${s.floorCells.max}  `
    + `wallRuns ${s.wallRuns.min}-${s.wallRuns.max}  `
    + `spawnPts ${s.spawnPoints.min}-${s.spawnPoints.max}  `
    + `treasure rate ${s.treasureRate}`);
}
if (maps.E) {
  console.log('\nfirst E layout (S spawn, E entry, C combat, T treasure, B boss):');
  for (const row of maps.E) console.log(`  ${row}`);
}
if (maps.C) {
  console.log('\nfirst C cavern (S spawn, E entry, C zone, B boss grotto):');
  for (const row of maps.C) console.log(`  ${row}`);
}

const file = writeReport('dungeon-gen-report', {
  seeds: SEEDS,
  ranks: RANKS,
  ms: +ms.toFixed(0),
  checks,
  failures,
  stats,
  failLines,
  maps,
});
console.log(`\nreport: ${file}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURE(S)`);
  for (const l of failLines) console.log(`  FAIL ${l}`);
}
process.exit(failures ? 1 : 0);
