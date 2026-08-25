// DUNGEON_SPEC STEP 3 + STEP 4 verification — the procedural dungeon shell
// and the mode/game seams that mount it.
//
//   GB_PORT=5213 npm run test:dungeon
//
//   A. Standalone mount at the title screen, per rank E and D:
//      draw-call + triangle budget deltas (kit-loaded budgets since STEP 7),
//      DUNGEON_MODULES dressing roles present, layout determinism, contract
//      surface, containment probes into EVERY wall run, membrane seal/unseal
//      crossing probes, randomSpawn room guarantee, nav reachability, the
//      clear() GPU-leak assert (the leak class that actually shipped twice),
//      and a kit-dressed screenshot per rank.
//   F. STEP 7/9 procedural fallback: a fresh page with citykit.glb AND
//      dungeonkit.glb blocked at
//      the route layer must still render EVERY dressing role (identical
//      placement counts — same seed, same layout) inside the procedural
//      budgets. Offline-with-no-assets is a shipping configuration here.
//   B. STEP 4 seams + STEP 6 entry experience: a real E-gate entry boots
//      NATIVELY into the crawl — DungeonMode world selection, EDIT 1 spawn
//      gating (dormant rooms), obstacle binding — and walks the player IN:
//      2.4 s auto-walk intro with input suppressed, low shoulder camera
//      easing to the follow rig, HUD/toast deferred to intro end (EDIT 7
//      final form), entry membrane sealing, and the tap-to-skip path —
//      plus player-visible screenshots.
//   W. STEP 5 integration_walkthrough: the encounter director end-to-end on
//      the same mounted E gate — trigger-on-entry, seal-during-combat with a
//      field-level crossing probe, waveSize metering, clear-and-reopen,
//      boss-door gating on allCleared, boss anchor + sealed chamber, the
//      walk-in exit portal (NOT an instant results screen), and the EDIT 4/5
//      caster-behind-wall probe with a positive control.
//   D. STEP 8 cavern mount: the C-rank layout through the same standalone
//      lens — cavern draw/tri budgets (<= 30 per spec), contract surface with
//      disc roomAt, determinism, containment probes, the boss-neck membrane
//      seal/cross probes, nav flow, crystal light anchors, dome/stalactite/
//      stalagmite presence, leak assert, and a dressed screenshot.
//   X. STEP 8 walkthrough: a NATIVE C-gate run — cavern mounts from a player
//      tap, zone aggro with NO door seals (kiting out of the zone keeps the
//      pack chasing), the boss grotto membrane holding until allCleared, the
//      boss fight behind the resealed neck, and the exit-portal walk-out.
//   T. Wave E task E-B: the B-rank ASCENT tower mount — budgets, the live
//      heightAt seam (terraces + stair treads), ramp-mouth membranes across a
//      height step, one-way parapet ledges, per-floor containment, leak
//      discipline, and a dressed screenshot.
//   V. Wave E task E-A: the A-rank RIVEN WASTE mount, standalone — budgets on
//      an open landscape (fewer walls, terrain triangles), the SMOOTH
//      heightAt seam (rolling analytic terrain, spawn on the datum), route +
//      compass-beacon contract, rim containment, outcrop collision on
//      terrain, determinism, leak discipline, and a dressed screenshot.
//   Y. Wave E task E-A walkthrough: a NATIVE A-gate run — the compass gate
//      (site N+1 and the boss refuse to trigger early with NO membranes
//      anywhere), roaming packs rising on the route legs, site-by-site
//      kill metering, the boss rising at the final open site, and the
//      exit-portal walk-out behind it.
//   C. regression_arena: an S-rank run must still be the arena, wave-driven,
//      byte-identical in flow (retargeted B -> A when B became the tower,
//      A -> S when A became the waste — S is the last arena rank until its
//      own Wave E task); and the forceOpen dev override must pin the arena
//      for E (every older tool depends on it).
//
// Landscape viewport (harness default) is load-bearing: portrait trips the
// rotate gate and swallows pointers.

import {
  OUT, launchBrowser, newPhonePage, ensureServer, gotoGame, enterGate,
  writeReport, shotPath,
} from './_harness.mjs';

const fails = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(name);
}

// B: 70388 is picked ON PURPOSE for its 3 parapet gaps over 5 floors — the
// phase-T ledge one-way probe needs a seed that actually rolled one.
const SEEDS = { E: 90210, D: 40417, C: 51877, B: 70388, A: 31337 };
const DRAW_BUDGET = 24;       // spec performance.drawCallBudget, E/D interior
const DRAW_BUDGET_CAVERN = 30;  // C adds dome, stalagmite/stalactite fields, crystals
const TRI_BUDGET_KIT = 130000;  // spec performance.triangleBudget, kit loaded
const TRI_BUDGET_PROC = 45000;  // procedural-only bound (fallback phase F)

// WHAT A FRAME ACTUALLY SUBMITS — the number this file used to be blind to.
//
// renderer.info.reset() runs AFTER WebGLShadowMap.render() inside
// WebGLRenderer.render (three r169, three.module.js:29935 vs :29941), so with
// info.autoReset at its default the key light's depth pass is ERASED from the
// counters. Every draw/triangle figure this suite has ever printed was the
// colour pass only: measured E 15 draws / 65,931 tris for a shell that submits
// 20 / 109,008 in a live frame. DUNGEON_SPEC.risks names this assert as the
// guard against "draw-call creep from dressing enthusiasm", and it was blind in
// exactly the direction the wave-3-A2 cover field moved.
//
// So phase A now measures BOTH, and asserts both:
//   colour pass       drawCalls / triangles   — the old semantics, old budget
//   whole frame       frame.drawCalls / frame.triangles — colour + depth pass
// The frame ceilings below are MEASURED, not aspirational, and each is a
// regression guard rather than an endorsement. Instrument: the same delta this
// phase already takes (built dungeon minus empty scene), with info.autoReset
// false, the mounted city hidden (otherwise the dungeon's own key light runs a
// depth pass over the CITY's casters and the delta stops being the dungeon's),
// and updateShadowCamera fitted to the boss chamber.
//
// Sweep of 8 seeds per rank, this tree vs a clean `git archive HEAD`:
//   E  HEAD 20-28 draws / 103,470-117,152 tris   now 19-22 / 103,675-123,965
//   D  HEAD 32    draws / 171,584-183,896 tris   now 27-28 / 168,779-182,327
// E is inside the spec's 24 / 130k on every seed sampled — which HEAD was NOT
// (28 draws on its worst seed). D is over on both axes and always has been:
// its dressing set (alcove niches, two pot rows, bookcases) is 19 colour-pass
// draws before a single shadow. This wave LOWERS D on both axes; it does not
// fix it. FRAME_BUDGET.D is therefore the measured ceiling plus headroom, and
// bringing D to the E budget is a dressing pass of its own, not a number to
// quietly widen again.
const FRAME_BUDGET = {
  E: { draws: 24, tris: 130000 },     // the spec budget, met on every seed
  D: { draws: 30, tris: 190000 },     // measured 27-28 / 182,327 worst seed
  // B (Wave E tower): D's dressing set minus alcoves, plus the terraced
  // shell's risers/staircase shafts (more triangles, zero extra draws — the
  // risers ride the ONE floor mesh). Measured ceiling + headroom, same
  // regression-guard-not-endorsement stance as D's row.
  B: { draws: 30, tris: 210000 },
  // S (Wave E reach): the shell alone — measured whole-frame 28 draws /
  // 90-92k tris over 4 seeds, plus headroom (review fix: the reach had no
  // row, so only phase Z's live-gate ceilings — which include the player,
  // shadows and fx — guarded it; those ceilings now DERIVE from this row so
  // the bar has one home).
  S: { draws: 30, tris: 130000 },
  // A (Wave E waste): the spec budget, and the roomiest fit of any rank —
  // an open landscape is ONE smooth floor mesh, a rim, and <= 58 outcrop
  // instances across five dressing fields; there are no torch sconces, no
  // alcoves, no clutter rows at all. The task brief's "watch tri budget on
  // terrain" is this row: the corner-sampled heightmap floor rides the same
  // single mesh as every kind's floor, so terrain costs vertices, never
  // draws.
  A: { draws: 24, tris: 130000 },
};

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);

try {
  await gotoGame(page);

  // Prime the modules once; vite serves /src straight to the page.
  await page.evaluate(async () => {
    const [{ Dungeon }, cfg, layout] = await Promise.all([
      import('/src/world/dungeon.js'),
      import('/src/game/config.js'),
      import('/src/world/dungeonlayout.js'),
    ]);
    window.__dt = {
      Dungeon,
      GATES: cfg.GATES,
      // The bolt plane and the cover contract built against it — phase A probes
      // the field at the height the game actually fires at, not a literal.
      PROJECTILE_Y: cfg.PROJECTILE_Y,
      COVER_KINDS: layout.COVER_KINDS,
      COVER_MIN_TOP: layout.COVER_MIN_TOP,
      // Phase Z pins the S anomaly roll to zero through this live reference
      // (config's exported const object — property writes stick).
      ANOMALY_CHANCE: cfg.ANOMALY_CHANCE,
    };
  });

  const report = { ranks: {}, screenshots: [] };

  // ------------------------------------------------------------- phase A
  for (const rank of ['E', 'D']) {
    const res = await page.evaluate(async ({ rank, seed }) => {
      const { Dungeon, GATES } = window.__dt;
      const g = window.__game;
      const gate = GATES.find((x) => x.rank === rank);
      const r = g.renderer;
      const out = { rank };

      // Explicit synchronous renders so the numbers are OURS: autoReset (the
      // default) zeroes info at the start of each render() and the game's own
      // RAF frame cannot interleave inside one evaluate.
      //
      // TWO numbers per sample. autoReset=false keeps the counters alive across
      // WebGLShadowMap.render(), so `calls`/`tris` include the key light's depth
      // pass — what the GPU is actually asked for. The second render with
      // autoReset back on reproduces the historical colour-pass-only figure so
      // the old budget keeps its old meaning. See FRAME_BUDGET above.
      const frame = () => {
        r.info.autoReset = false;
        r.info.reset();
        r.render(g.scene, g.camera);
        const withShadow = { calls: r.info.render.calls, tris: r.info.render.triangles };
        r.info.autoReset = true;
        r.render(g.scene, g.camera);
        return {
          calls: r.info.render.calls,
          tris: r.info.render.triangles,
          frameCalls: withShadow.calls,
          frameTris: withShadow.tris,
        };
      };
      // The mounted city would otherwise be re-drawn by the DUNGEON's key light
      // in the depth pass, putting city geometry inside a dungeon delta.
      const cityGroup = g.world?.group || null;
      const cityWasVisible = cityGroup ? cityGroup.visible : false;
      if (cityGroup) cityGroup.visible = false;
      // Fit the shadow camera the way the game does (extent 12, the default in
      // Dungeon.updateShadowCamera) so the depth pass is a real one.
      const aimShadow = (dd) => {
        const c = dd.layout.rooms[dd.layout.bossRoom]?.centre || { x: 0, z: 0 };
        dd.updateShadowCamera({ x: c.x, y: 0, z: c.z }, 12);
        r.shadowMap.needsUpdate = true;
      };
      // Warm-up build+clear BEFORE the baseline snapshot: the first env build
      // ever lazily allocates the PMREM generator's persistent internals
      // (module-level cache, disposed only on context loss). Without this the
      // first rank misreads that one-time warm-up as a per-build leak — the
      // assert below is about the steady-state build/clear cycle.
      {
        const wd = new Dungeon(g.scene, g.renderer, g.camera);
        wd.build(gate, seed);
        r.render(g.scene, g.camera);
        wd.clear();
        g.scene.remove(wd.group);
        r.render(g.scene, g.camera);
      }
      const memBefore = {
        geo: r.info.memory.geometries, tex: r.info.memory.textures,
      };
      const base = frame();

      // COVER A/B (wave 3-A2). The interior cover field is the one dressing
      // system big enough to argue about, so its cost is MEASURED rather than
      // estimated: the same gate and seed built once with params.cover nulled
      // out (gate.crawl overrides LAYOUT_PARAMS in Dungeon.build) and once
      // normally. The delta between the two is what cover actually costs this
      // frame, and it lands in the report next to the budget.
      {
        const noCover = new Dungeon(g.scene, g.renderer, g.camera);
        noCover.build({ ...gate, crawl: { ...(gate.crawl || {}), cover: null } }, seed);
        aimShadow(noCover);
        const nc = frame();
        out.noCover = {
          drawCalls: nc.calls - base.calls,
          triangles: nc.tris - base.tris,
          frameDrawCalls: nc.frameCalls - base.frameCalls,
          frameTriangles: nc.frameTris - base.frameTris,
        };
        // The navgrid must come out BIT-IDENTICAL with and without cover.
        // Cover registers nav:false on purpose (navgrid pads every blocker by
        // ~1.38 m, which would close the 3 m dash lanes the placer guarantees),
        // and "the flow field is untouched" is a claim worth proving rather
        // than arguing: a hash of the baked blocked mask settles it.
        const hash = (grid) => {
          let hv = 0x811c9dc5;
          for (let i = 0; i < grid.blocked.length; i++) {
            hv ^= grid.blocked[i];
            hv = Math.imul(hv, 0x01000193) >>> 0;
          }
          return `${grid.w}x${grid.h}:${hv.toString(16)}`;
        };
        out.noCover.navHash = hash(noCover.navGrid);
        noCover.clear();
        g.scene.remove(noCover.group);
        r.render(g.scene, g.camera);
      }
      const base2 = frame();

      const d = new Dungeon(g.scene, g.renderer, g.camera);
      d.build(gate, seed);
      aimShadow(d);
      const built = frame();
      out.drawCalls = built.calls - base2.calls;
      out.triangles = built.tris - base2.tris;
      // What the GPU is actually asked for: colour pass + the key light's
      // shadow-depth pass. See FRAME_BUDGET at the top of this file.
      out.frame = {
        drawCalls: built.frameCalls - base2.frameCalls,
        triangles: built.frameTris - base2.frameTris,
        shadowCasters: 0,
        drawables: 0,
      };
      d.group.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isLine) return;
        out.frame.drawables++;
        if (o.castShadow) out.frame.shadowCasters++;
      });
      // Every render that counts is done; the city goes back before the
      // evidence shot and the later phases that expect it mounted.
      if (cityGroup) cityGroup.visible = cityWasVisible;

      const L = d.layout;
      out.contract = {
        kind: d.kind,
        encounterDriven: d.encounterDriven === true,
        heightAt: d.heightAt(123, -45) === 0,
        radiusPadded: d.radius >= L.radius + 4 - 1e-9,
        hasNavGrid: !!d.navGrid && d.navGrid.baked,
        rooms: L.rooms.length,
        doors: L.doors.length,
        wallRuns: L.wallRuns.length,
        torches: L.decor.torches.length,
        obstacleCount: d.obstacleField.count,
      };

      // Determinism: a second build from the same seed must agree. The gen
      // test byte-compares layouts across 200 seeds; this pins the in-world
      // path (world.build is the context-loss repair path).
      const d2 = new Dungeon(g.scene, g.renderer, g.camera);
      d2.build(gate, seed);
      const sig = (dd) => JSON.stringify({
        rooms: dd.layout.rooms.map((rm) => [rm.id, rm.kind, rm.x, rm.z, rm.w, rm.d, rm.budget]),
        doors: dd.layout.doors.map((dr) => [dr.id, dr.x, dr.z, dr.w, dr.rot, dr.roomA, dr.roomB]),
        runs: dd.layout.wallRuns.map((wr) => [wr.x, wr.z, wr.w, wr.d, wr.face]),
        mask: Array.from(dd.layout.mask).join(''),
      });
      out.deterministic = sig(d) === sig(d2);
      d2.clear();
      g.scene.remove(d2.group);

      const floorAt = (x, z) => {
        const gx = Math.floor((x - L.originX) / L.cell);
        const gz = Math.floor((z - L.originZ) / L.cell);
        if (gx < 0 || gz < 0 || gx >= L.w || gz >= L.h) return false;
        return L.mask[gx + gz * L.w] === 1;
      };

      // Containment: drive a body into EVERY wall run; resolve must hold it
      // on the floor side of the boundary plane.
      const OUTWARD = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
      out.wallProbe = { probed: 0, skipped: 0, breaches: [] };
      for (let i = 0; i < L.wallRuns.length; i++) {
        const run = L.wallRuns[i];
        const [tx, tz] = OUTWARD[run.face];
        const sx = run.x - tx * 1.2;
        const sz = run.z - tz * 1.2;
        // Mid-run corners of L-shaped floor can put the 1.2 m inset inside
        // another wall; those runs are exercised by their neighbours' probes.
        if (!floorAt(sx, sz)) { out.wallProbe.skipped++; continue; }
        const pos = { x: sx, y: 0, z: sz };
        const vel = { x: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = tx * 4; vel.z = tz * 4;   // keep driving into the wall
          pos.x += vel.x * 0.05;
          pos.z += vel.z * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        const along = (pos.x - run.x) * tx + (pos.z - run.z) * tz;
        // The wall's floor-side face is 0.3 m before the plane; a resolved
        // body centre must sit at least its radius short of the face.
        if (along > -0.55 || !floorAt(pos.x, pos.z)) {
          out.wallProbe.breaches.push({ i, face: run.face, along: +along.toFixed(3) });
        }
        out.wallProbe.probed++;
      }

      // Membrane seal / unseal: crossing probe through a real interior door.
      const door = L.doors.find((dr) => dr.roomA >= 0 && dr.roomB >= 0);
      const cross = (dr) => {
        const [tx, tz] = dr.rot === 0 ? [0, 1] : [1, 0];
        const pos = { x: dr.x - tx * 1.5, y: 0, z: dr.z - tz * 1.5 };
        const vel = { x: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = tx * 4; vel.z = tz * 4;
          pos.x += vel.x * 0.05;
          pos.z += vel.z * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        return (pos.x - dr.x) * tx + (pos.z - dr.z) * tz > dr.d / 2 + 0.3;
      };
      out.membrane = { doorId: door?.id ?? -1 };
      if (door) {
        out.membrane.openCrosses = cross(door);
        d.setDoorSealed(door.id, true);
        out.membrane.sealedReported = d.doorSealed(door.id);
        out.membrane.sealedCrosses = cross(door);
        d.setDoorSealed(door.id, false);
        out.membrane.reopenedCrosses = cross(door);
        out.membrane.reopenedReported = d.doorSealed(door.id);
      }

      // randomSpawn: entry-room guarantee for the shadow escort (min 4; probe
      // more, at the deploy call's own minDist).
      let sRnd = 1234567;
      const rnd = () => {
        // Tiny LCG; the test only needs variety, not the game's PRNG.
        sRnd = (sRnd * 1664525 + 1013904223) >>> 0;
        return sRnd / 4294967296;
      };
      out.spawns = { inEntry: 0, total: 8 };
      for (let i = 0; i < 8; i++) {
        const p = d.randomSpawn(rnd, { x: 0, y: 0, z: 0 }, 4);
        if (d.roomAt(p.x, p.z) === 0 && p.y === 0) out.spawns.inEntry++;
      }

      // bossSpawn inside the boss room, roomAt agreeing everywhere, and — new
      // this wave — standing on floor rather than inside its own scenery.
      const bs = d.bossSpawn();
      out.boss = {
        inBossRoom: d.roomAt(bs.x, bs.z) === L.bossRoom,
        spawnPoints: d.spawnPointsFor(L.bossRoom).length,
        anchorClear: !d.obstacleField.blocked(bs.x, bs.z, 0.45, 0.4, 0),
      };

      // COVER, measured on the LIVE field the player collides with. The
      // generator can claim anything; this is the number the "38 x 38 m empty
      // box" regression is judged on, taken exactly as the adversarial probe
      // took it: a 1 m lattice inset 1 m from the walls, plus the fraction of
      // >= 6 m chords across the chamber a bolt cannot make.
      //
      // SAMPLED AT THE BOLT PLANE, config.PROJECTILE_Y. The first pass measured
      // at 1.2 m while the boss fired from 2.4 m, so every cover number it
      // published was taken at a height nothing in the game shot at. Now there
      // is one plane and the probe uses it; `bossBoltPlaneAgrees` below fails
      // loudly if game code ever moves it above rubble's 1.75 m top, which is
      // the failure this probe could not previously see.
      {
        const room = L.rooms[L.bossRoom];
        const boltY = window.__dt.PROJECTILE_Y;
        let a = 0x9e3779b9 ^ seed;   // test-local stream; nothing downstream
        const rnd = () => {
          a |= 0; a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const nx = Math.floor(room.w - 2);
        const nz = Math.floor(room.d - 2);
        let cells = 0;
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            if (d.obstacleField.blocked(room.x + 1.5 + i, room.z + 1.5 + j, 0, 0, boltY)) cells++;
          }
        }
        let shots = 0;
        let stopped = 0;
        let guard = 0;
        while (shots < 600 && guard++ < 12000) {
          const ax = room.x + 1.5 + rnd() * (room.w - 3);
          const az = room.z + 1.5 + rnd() * (room.d - 3);
          const bx = room.x + 1.5 + rnd() * (room.w - 3);
          const bz = room.z + 1.5 + rnd() * (room.d - 3);
          if (Math.hypot(bx - ax, bz - az) < 6) continue;
          shots++;
          if (d.obstacleField.lineBlocked(ax, az, bx, bz, { feetY: boltY })) stopped++;
        }
        // EVERY cover kind must clear the bolt plane, and the plane must be one
        // number. COVER_MIN_TOP is PROJECTILE_Y + 0.1 in dungeonlayout.js; a
        // kind that only clears 1.2 is scenery a bolt flies over.
        const kinds = window.__dt.COVER_KINDS;
        out.cover = {
          pieces: L.decor.cover.length,
          bossPieces: L.decor.cover.filter((c) => c.room === L.bossRoom).length,
          bossRoom: `${room.w}x${room.d}`,
          blockedCells: cells,
          totalCells: nx * nz,
          losBlockedPct: shots ? +((100 * stopped) / shots).toFixed(1) : 0,
          boltY,
          minTop: window.__dt.COVER_MIN_TOP,
          kindsClearBolt: Object.entries(kinds)
            .filter(([, k]) => !(k.top >= window.__dt.COVER_MIN_TOP)).map(([n]) => n),
          // The live field, probed across a real piece: a chord through the
          // centre of one boss-chamber rubble pile must be stopped AT the bolt
          // plane. `over` is the same chord 0.6 m higher, which rubble does not
          // stop — recorded so the margin is visible rather than assumed.
          throughPiece: (() => {
            const pile = L.decor.cover.find((c) => c.room === L.bossRoom && c.kind === 'rubble');
            if (!pile) return null;
            const s = 4.2;
            return {
              at: d.obstacleField.lineBlocked(pile.x - s, pile.z, pile.x + s, pile.z, { feetY: boltY })
                || d.obstacleField.lineBlocked(pile.x, pile.z - s, pile.x, pile.z + s, { feetY: boltY }),
              over: d.obstacleField.lineBlocked(pile.x - s, pile.z, pile.x + s, pile.z, { feetY: boltY + 0.6 })
                || d.obstacleField.lineBlocked(pile.x, pile.z - s, pile.x, pile.z + s, { feetY: boltY + 0.6 }),
            };
          })(),
        };
      }
      out.roomAt = {
        centresAgree: L.rooms.every((rm) => d.roomAt(rm.centre.x, rm.centre.z) === rm.id),
        tunnelIsNoRoom: d.roomAt(0, 0) === -1,
      };

      // Nav reachability: flow toward the entry room must reach the boss room.
      const entryC = L.rooms[0].centre;
      const bossC = L.rooms[L.bossRoom].centre;
      const dir = { x: 0, z: 0 };
      out.nav = {
        goalSet: d.navGrid.setGoal(entryC.x, entryC.z),
        bossReaches: false,
        // Same hash as the no-cover build above; see the note there.
        hash: (() => {
          let hv = 0x811c9dc5;
          for (let i = 0; i < d.navGrid.blocked.length; i++) {
            hv ^= d.navGrid.blocked[i];
            hv = Math.imul(hv, 0x01000193) >>> 0;
          }
          return `${d.navGrid.w}x${d.navGrid.h}:${hv.toString(16)}`;
        })(),
      };
      if (out.nav.goalSet) out.nav.bossReaches = d.navGrid.flowAt(bossC.x, bossC.z, dir);

      // STEP 7: the dressing manifest — which roles landed, at what cost.
      out.dressing = d.dressing;
      // Leave the dungeon mounted for the kit-dressed screenshot; the clear +
      // leak assert runs in a second evaluate below.
      window.__dtLive = { d, memBefore };
      return out;
    }, { rank, seed: SEEDS[rank] });

    // Kit-dressed evidence shot: park the camera over the first combat room
    // (game-camera geometry: +11 up, +11 south) with the title overlay out of
    // the way. The title screen's own RAF keeps running: it MUTATES g.camera
    // (orbit sweep) and then calls renderer.render every tick. So REDIRECT
    // renderer.render to re-pin the camera and draw our frame on every tick.
    // The old trick (no-op stub + one manual frame) raced the compositor:
    // with preserveDrawingBuffer false the held frame can be invalidated
    // before page.screenshot() re-composites it, and one suite run shipped a
    // pure-black dungeon-c-cavern.png as its "evidence". Re-pinning INSIDE
    // the redirect matters: pinning once and merely re-presenting would
    // capture the title's swept camera, not the dressed aerial.
    await page.evaluate(() => {
      const g = window.__game;
      const { d } = window.__dtLive;
      const room = d.layout.rooms.find((r) => r.kind === 'combat') || d.layout.rooms[0];
      document.getElementById('title').classList.add('hidden');
      const orig = g.renderer.render.bind(g.renderer);
      window.__dtLive.restoreRender = g.renderer.render;
      const present = () => {
        g.camera.position.set(room.centre.x, 11, room.centre.z + 11);
        g.camera.lookAt(room.centre.x, 1, room.centre.z);
        orig(g.scene, g.camera);
      };
      g.renderer.render = present;
      present();
    });
    const shotDress = shotPath(`dungeon-${rank.toLowerCase()}-dressed.png`);
    await page.screenshot({ path: shotDress });
    report.screenshots.push(shotDress);

    // Disposal: everything back, within the PMREM generator's +2 slack.
    const leak = await page.evaluate(() => {
      const g = window.__game;
      const { d, memBefore, restoreRender } = window.__dtLive;
      const r = g.renderer;
      if (restoreRender) r.render = restoreRender;
      d.clear();
      g.scene.remove(d.group);
      r.render(g.scene, g.camera);
      document.getElementById('title').classList.remove('hidden');
      window.__dtLive = null;
      return {
        geoBefore: memBefore.geo,
        geoAfter: r.info.memory.geometries,
        texBefore: memBefore.tex,
        texAfter: r.info.memory.textures,
      };
    });
    res.leak = leak;

    report.ranks[rank] = res;
    const c = res.contract;
    // STEP 7: the page preloads citykit.glb during boot, so these are the
    // kit-loaded budgets; the procedural bound is phase F's job.
    const triBudget = res.dressing?.kitLoaded ? TRI_BUDGET_KIT : TRI_BUDGET_PROC;
    check(`${rank}: draw-call delta ${res.drawCalls} <= ${DRAW_BUDGET}`, res.drawCalls <= DRAW_BUDGET && res.drawCalls >= 5);
    check(`${rank}: triangle delta ${res.triangles} <= ${triBudget} (kit ${res.dressing?.kitLoaded})`,
      res.triangles <= triBudget && res.triangles > 1000);
    {
      // The number the old assert could not see. frame.* includes the key
      // light's depth pass; see FRAME_BUDGET.
      const fb = FRAME_BUDGET[rank];
      const f = res.frame;
      check(`${rank}: WHOLE-FRAME draw delta ${f.drawCalls} <= ${fb.draws} `
        + `(${f.drawables} drawables, ${f.shadowCasters} of them shadow casters)`,
      f.drawCalls <= fb.draws && f.drawCalls >= res.drawCalls);
      check(`${rank}: WHOLE-FRAME triangle delta ${f.triangles} <= ${fb.tris} `
        + `(colour pass alone ${res.triangles})`,
      f.triangles <= fb.tris && f.triangles >= res.triangles);
    }
    {
      const roles = res.dressing?.roles || {};
      const wantAlways = ['archway', 'doorFrame', 'column', 'torch'];
      const missing = wantAlways.filter((k) => !(roles[k] > 0));
      if (rank === 'D' && !(roles.alcove > 0)) missing.push('alcove');
      check(`${rank}: dressing roles placed ${JSON.stringify(roles)}`,
        res.dressing?.kitLoaded === true && missing.length === 0,
        missing.length ? `missing ${missing.join(',')}` : '');
    }
    check(`${rank}: contract surface`, c.kind === 'crawl' && c.encounterDriven && c.heightAt && c.radiusPadded && c.hasNavGrid);
    check(`${rank}: deterministic rebuild`, res.deterministic);
    check(`${rank}: wall containment ${res.wallProbe.probed} probed, ${res.wallProbe.skipped} skipped`,
      res.wallProbe.breaches.length === 0 && res.wallProbe.probed > 20
      && res.wallProbe.skipped < res.wallProbe.probed * 0.25,
      res.wallProbe.breaches.length ? JSON.stringify(res.wallProbe.breaches.slice(0, 4)) : '');
    check(`${rank}: membrane open crosses`, res.membrane.openCrosses === true);
    check(`${rank}: membrane sealed blocks`, res.membrane.sealedReported === true && res.membrane.sealedCrosses === false);
    check(`${rank}: membrane reopens`, res.membrane.reopenedCrosses === true && res.membrane.reopenedReported === false);
    check(`${rank}: randomSpawn stays in entry room ${res.spawns.inEntry}/${res.spawns.total}`, res.spawns.inEntry === res.spawns.total);
    check(`${rank}: bossSpawn in boss room (${res.boss.spawnPoints} pts), on clear floor`,
      res.boss.inBossRoom && res.boss.spawnPoints >= 4 && res.boss.anchorClear === true);
    {
      // Wave 3-A2: the boss chamber must not be an empty box. Before this wave
      // the same probe read 0 blocked cells of 1296 and 0.0% of sightlines
      // stopped on every seed measured; the 200-seed soak in
      // tools/dungeon-gen-test.mjs puts the live floor at ~19% and the mean at
      // ~36% (E) / ~39% (D), so 15% is a tripwire, not a target.
      const cv = res.cover;
      check(`${rank}: boss chamber ${cv.bossRoom} m carries cover — `
        + `${cv.bossPieces} pieces, ${cv.blockedCells}/${cv.totalCells} cells blocked at the bolt plane `
        + `(y ${cv.boltY}), ${cv.losBlockedPct}% of sightlines stopped`,
      cv.bossPieces >= 5 && cv.blockedCells > 0 && cv.losBlockedPct >= 15);
      check(`${rank}: every cover kind clears the bolt plane (top >= ${cv.minTop} m)`,
        cv.kindsClearBolt.length === 0,
        cv.kindsClearBolt.length ? `below the plane: ${cv.kindsClearBolt.join(',')}` : '');
      check(`${rank}: live field stops a bolt across a boss-chamber rubble pile at y ${cv.boltY} `
        + `(and passes it at y ${(cv.boltY + 0.6).toFixed(1)}, which is why the plane is a constant)`,
      cv.throughPiece?.at === true && cv.throughPiece?.over === false);
      check(`${rank}: cover costs +${res.frame.drawCalls - res.noCover.frameDrawCalls} draws / `
        + `+${res.frame.triangles - res.noCover.frameTriangles} tris on the WHOLE frame `
        + `(+${res.drawCalls - res.noCover.drawCalls} / +${res.triangles - res.noCover.triangles} colour pass), `
        + `${cv.pieces} pieces gate-wide`,
      // Two extra draw calls is the whole system's structural cost: `pillar`
      // re-uses the existing column InstancedMesh, so only coverRubble and
      // coverStub are new fields. More than that means a role leaked in — and
      // it is asserted on the WHOLE-frame number now, because the first pass of
      // this system cost 4 (both fields cast shadows, so each paid twice) while
      // this assert, blind to the depth pass, reported 2 and passed.
      res.frame.drawCalls - res.noCover.frameDrawCalls <= 2
        && res.drawCalls - res.noCover.drawCalls <= 2
        && res.frame.triangles <= FRAME_BUDGET[rank].tris);
    }
    check(`${rank}: roomAt agrees`, res.roomAt.centresAgree && res.roomAt.tunnelIsNoRoom);
    check(`${rank}: nav flow reaches boss room`, res.nav.goalSet && res.nav.bossReaches);
    check(`${rank}: cover leaves the navgrid bit-identical (${res.nav.hash})`,
      res.nav.hash === res.noCover.navHash,
      res.nav.hash === res.noCover.navHash ? '' : `no-cover ${res.noCover.navHash}`);
    check(`${rank}: no GPU leak (geo ${res.leak.geoBefore}->${res.leak.geoAfter}, tex ${res.leak.texBefore}->${res.leak.texAfter})`,
      res.leak.geoAfter <= res.leak.geoBefore + 2 && res.leak.texAfter <= res.leak.texBefore + 2);
  }

  // ------------------------------------------------------------- phase S
  // Wave 3 "room to fight in" + "randomised enemy count", measured through the
  // MOUNTED world rather than the pure generator (the gen soak covers the
  // generator). Two claims:
  //   1. Rooms are sized in DASH UNITS — config.js SKILLS.dash.distance is
  //      7.5 m, combat rooms clear 3 dashes across their short axis, boss
  //      chambers clear 5 on both axes.
  //   2. gate.enemies is ROLLED per run inside the gate's band, varies across
  //      seeds, is identical for a repeated seed (the context-loss rebuild
  //      contract), and equals the sum of the room budgets the layout hands
  //      the director — a mismatch would desync the HUD counter from the world.
  {
    const space = await page.evaluate(async ({ ranks }) => {
      const { Dungeon, GATES } = window.__dt;
      const g = window.__game;
      const out = {};
      for (const rank of ranks) {
        const gate = GATES.find((x) => x.rank === rank);
        const nominal = gate.enemies;
        const rolls = [];
        let dims = null;
        let budgetSum = -1;
        let repeat = null;
        for (let i = 0; i < 10; i++) {
          const seed = 4242 + i * 7919;
          const d = new Dungeon(g.scene, g.renderer, g.camera);
          d.build(gate, seed);
          rolls.push(gate.enemies);
          if (i === 0) {
            const L = d.layout;
            const fight = L.rooms.filter((r) => r.kind === 'combat' || r.kind === 'treasure');
            const boss = L.rooms[L.bossRoom];
            dims = {
              rooms: fight.length,
              shortMin: Math.min(...fight.map((r) => Math.min(r.w, r.d))),
              longMax: Math.max(...fight.map((r) => Math.max(r.w, r.d))),
              floor: fight.reduce((s, r) => s + r.w * r.d, 0),
              bossW: boss.w, bossD: boss.d,
              bossIsDisc: boss.radius > 0,
            };
            budgetSum = L.rooms.reduce((s, r) => s + r.budget, 0);
            // Same gate, same seed, fresh Dungeon: the roll must repeat.
            const d2 = new Dungeon(g.scene, g.renderer, g.camera);
            d2.build(gate, seed);
            repeat = gate.enemies;
            d2.clear();
            g.scene.remove(d2.group);
          }
          d.clear();
          g.scene.remove(d.group);
        }
        out[rank] = {
          band: gate.enemyBand, nominal, rolls, repeat, budgetSum, dims,
        };
      }
      return out;
    }, { ranks: ['E', 'D', 'C', 'B'] });
    report.space = space;
    const DASH = 7.5;
    for (const rank of ['E', 'D', 'C', 'B']) {
      const s = space[rank];
      const d = s.dims;
      // C's fight "rooms" are trigger discs in open cavern — the gen soak
      // measures their free floor by ray march; here only the sealed boss
      // grotto carries the 5-dash claim.
      if (!d.bossIsDisc) {
        check(`${rank}: combat rooms ${d.shortMin} m short axis = ${(d.shortMin / DASH).toFixed(2)} dashes >= 3`,
          d.shortMin >= 3 * DASH, `${d.rooms} rooms, ${d.floor} m2 of fighting floor`);
      }
      check(`${rank}: boss chamber ${d.bossW}x${d.bossD} m = ${(Math.min(d.bossW, d.bossD) / DASH).toFixed(2)} dashes across >= 5`,
        Math.min(d.bossW, d.bossD) >= 5 * DASH);
      const lo = Math.min(...s.rolls);
      const hi = Math.max(...s.rolls);
      const distinct = new Set(s.rolls).size;
      if (Array.isArray(s.band)) {
        check(`${rank}: enemy count rolls ${lo}-${hi} inside band ${JSON.stringify(s.band)}, ${distinct} distinct over 10 seeds`,
          lo >= s.band[0] && hi <= s.band[1] && distinct >= 3,
          JSON.stringify(s.rolls));
      } else {
        // B carries no enemyBand yet — rollEnemyCount's documented fallback
        // is the flat gate.enemies, every seed, every rebuild.
        check(`${rank}: bandless gate holds the flat count ${s.nominal} on every seed`,
          lo === s.nominal && hi === s.nominal, JSON.stringify(s.rolls));
      }
      check(`${rank}: same seed re-rolls the same count (${s.repeat})`,
        s.repeat === s.rolls[0]);
      check(`${rank}: room budgets sum ${s.budgetSum} = rolled gate.enemies ${s.rolls[0]}`,
        s.budgetSum === s.rolls[0]);
    }
  }

  // ------------------------------------------------------------- phase D
  // STEP 8 cavern mount. Same standalone lens as phase A, cavern-specific
  // asserts: <= 30 draws (spec drawCallBudget for C), disc roomAt semantics,
  // the boss-neck membrane as the grotto's ONLY way in, crystal light
  // anchors, roof + cover meshes, and the same leak discipline.
  {
    const res = await page.evaluate(async ({ seed }) => {
      const { Dungeon, GATES } = window.__dt;
      const g = window.__game;
      const gate = GATES.find((x) => x.rank === 'C');
      const r = g.renderer;
      const out = {};
      const frame = () => {
        r.render(g.scene, g.camera);
        return { calls: r.info.render.calls, tris: r.info.render.triangles };
      };
      {
        // PMREM warm-up, as in phase A.
        const wd = new Dungeon(g.scene, g.renderer, g.camera);
        wd.build(gate, seed);
        r.render(g.scene, g.camera);
        wd.clear();
        g.scene.remove(wd.group);
        r.render(g.scene, g.camera);
      }
      const memBefore = { geo: r.info.memory.geometries, tex: r.info.memory.textures };
      const base = frame();
      const d = new Dungeon(g.scene, g.renderer, g.camera);
      d.build(gate, seed);
      const built = frame();
      out.drawCalls = built.calls - base.calls;
      out.triangles = built.tris - base.tris;

      const L = d.layout;
      out.contract = {
        kind: d.kind,
        encounterDriven: d.encounterDriven === true,
        heightAt: d.heightAt(50, -60) === 0,
        radiusPadded: d.radius >= L.radius + 4 - 1e-9,
        hasNavGrid: !!d.navGrid && d.navGrid.baked,
        rooms: L.rooms.length,
        zones: L.rooms.filter((rm) => rm.kind === 'combat').length,
        doors: L.doors.length,
        wallRuns: L.wallRuns.length,
        stalagmites: L.decor.stalagmites.length,
        crystals: L.decor.crystals.length,
        lightAnchors: d._torchAnchors.length / 2,
        obstacleCount: d.obstacleField.count,
      };
      out.dressing = d.dressing;
      out.meshes = {
        dome: !!d.group.getObjectByName('cavern_dome'),
        stalactites: !!d.group.getObjectByName('cavern_stalactites'),
        crystals: !!d.group.getObjectByName('cavern_crystals'),
        spires: d.group.getObjectByName('stalagmite_spire') !== undefined
          || d._natureFields.length > 0,
      };

      // Determinism: rebuild from the same seed must agree (context-loss
      // repair path), including the stalagmite field the cover fights use.
      const d2 = new Dungeon(g.scene, g.renderer, g.camera);
      d2.build(gate, seed);
      const sig = (dd) => JSON.stringify({
        rooms: dd.layout.rooms.map((rm) => [rm.id, rm.kind, rm.centre.x, rm.centre.z, rm.radius, rm.budget]),
        doors: dd.layout.doors.map((dr) => [dr.id, dr.x, dr.z, dr.w, dr.rot, dr.roomA]),
        sgs: dd.layout.decor.stalagmites.map((s) => [s.x, s.z, s.kind, s.r, s.h]),
        mask: Array.from(dd.layout.mask).join(''),
      });
      out.deterministic = sig(d) === sig(d2);
      d2.clear();
      g.scene.remove(d2.group);

      const floorAt = (x, z) => {
        const gx = Math.floor((x - L.originX) / L.cell);
        const gz = Math.floor((z - L.originZ) / L.cell);
        if (gx < 0 || gz < 0 || gx >= L.w || gz >= L.h) return false;
        return L.mask[gx + gz * L.w] === 1;
      };

      // Disc roomAt: centres agree, the tunnel is no room, and open floor
      // between zone discs is -1 (nothing triggers there — the zone design).
      let openFloorIsNoRoom = true;
      outer: for (let gz = 0; gz < L.h; gz++) {
        for (let gx = 0; gx < L.w; gx++) {
          if (!L.mask[gx + gz * L.w]) continue;
          const x = L.originX + (gx + 0.5) * L.cell;
          const z = L.originZ + (gz + 0.5) * L.cell;
          if (L.rooms.every((rm) => Math.hypot(x - rm.centre.x, z - rm.centre.z) > rm.radius + 0.2)) {
            openFloorIsNoRoom = d.roomAt(x, z) === -1;
            break outer;
          }
        }
      }
      out.roomAt = {
        centresAgree: L.rooms.every((rm) => d.roomAt(rm.centre.x, rm.centre.z) === rm.id),
        tunnelIsNoRoom: d.roomAt(0, 0) === -1,
        openFloorIsNoRoom,
      };

      // Containment probes into every wall run (phase A's probe, cavern
      // boundaries are staircases so more insets land off-floor and skip).
      const OUTWARD = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
      out.wallProbe = { probed: 0, skipped: 0, breaches: [] };
      for (let i = 0; i < L.wallRuns.length; i++) {
        const run = L.wallRuns[i];
        const [tx, tz] = OUTWARD[run.face];
        const sx = run.x - tx * 1.2;
        const sz = run.z - tz * 1.2;
        if (!floorAt(sx, sz)) { out.wallProbe.skipped++; continue; }
        const pos = { x: sx, y: 0, z: sz };
        const vel = { x: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = tx * 4; vel.z = tz * 4;
          pos.x += vel.x * 0.05;
          pos.z += vel.z * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        const along = (pos.x - run.x) * tx + (pos.z - run.z) * tz;
        if (along > -0.55 || !floorAt(pos.x, pos.z)) {
          out.wallProbe.breaches.push({ i, face: run.face, along: +along.toFixed(3) });
        }
        out.wallProbe.probed++;
      }

      // The boss-neck membrane: open crossing, sealed crossing, reopen —
      // driven along the neck axis from the mass side toward the grotto.
      const bossRoom = L.rooms[L.bossRoom];
      const door = L.doors[bossRoom.doors[0]];
      const [ntx, ntz] = door.rot === 0 ? [0, 1] : [1, 0];
      const nsgn = Math.sign((bossRoom.centre.x - door.x) * ntx + (bossRoom.centre.z - door.z) * ntz) || 1;
      const crossNeck = () => {
        const pos = { x: door.x - nsgn * ntx * 1.5, y: 0, z: door.z - nsgn * ntz * 1.5 };
        const vel = { x: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = nsgn * ntx * 4; vel.z = nsgn * ntz * 4;
          pos.x += vel.x * 0.05; pos.z += vel.z * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        return ((pos.x - door.x) * ntx + (pos.z - door.z) * ntz) * nsgn > door.d / 2 + 0.3;
      };
      out.membrane = { openCrosses: crossNeck() };
      d.setDoorSealed(door.id, true);
      out.membrane.sealedReported = d.doorSealed(door.id);
      out.membrane.sealedCrosses = crossNeck();
      d.setDoorSealed(door.id, false);
      out.membrane.reopenedCrosses = crossNeck();

      // randomSpawn stays in the entry disc; bossSpawn is in the grotto.
      let sRnd = 987654;
      const rnd = () => {
        sRnd = (sRnd * 1664525 + 1013904223) >>> 0;
        return sRnd / 4294967296;
      };
      out.spawns = { inEntry: 0, total: 8 };
      for (let i = 0; i < 8; i++) {
        const p = d.randomSpawn(rnd, { x: 0, y: 0, z: 0 }, 4);
        if (d.roomAt(p.x, p.z) === 0 && p.y === 0) out.spawns.inEntry++;
      }
      const bs = d.bossSpawn();
      out.boss = {
        inBossRoom: d.roomAt(bs.x, bs.z) === L.bossRoom,
        spawnPoints: d.spawnPointsFor(L.bossRoom).length,
      };

      // Nav: flow toward the entry reaches the grotto (through the open neck
      // and around every nav-registered spire).
      const dirv = { x: 0, z: 0 };
      out.nav = { goalSet: d.navGrid.setGoal(L.rooms[0].centre.x, L.rooms[0].centre.z), bossReaches: false };
      if (out.nav.goalSet) out.nav.bossReaches = d.navGrid.flowAt(bossRoom.centre.x, bossRoom.centre.z, dirv);

      window.__dtLive = { d, memBefore };
      return out;
    }, { seed: SEEDS.C });

    // Dressed screenshot over the first zone — per-tick pinned-camera
    // redirect, as in phase A (the no-op freeze-frame raced the compositor
    // and once produced a pure-black cavern "evidence" shot; the title RAF
    // also mutates g.camera every tick, so the pin must be inside the
    // redirect — see the phase A comment).
    await page.evaluate(() => {
      const g = window.__game;
      const { d } = window.__dtLive;
      const room = d.layout.rooms.find((r) => r.kind === 'combat') || d.layout.rooms[0];
      document.getElementById('title').classList.add('hidden');
      const orig = g.renderer.render.bind(g.renderer);
      window.__dtLive.restoreRender = g.renderer.render;
      const present = () => {
        g.camera.position.set(room.centre.x, 11, room.centre.z + 11);
        g.camera.lookAt(room.centre.x, 1, room.centre.z);
        orig(g.scene, g.camera);
      };
      g.renderer.render = present;
      present();
    });
    const shotCavern = shotPath('dungeon-c-cavern.png');
    await page.screenshot({ path: shotCavern });
    report.screenshots.push(shotCavern);
    const leak = await page.evaluate(() => {
      const g = window.__game;
      const { d, memBefore, restoreRender } = window.__dtLive;
      const r = g.renderer;
      if (restoreRender) r.render = restoreRender;
      d.clear();
      g.scene.remove(d.group);
      r.render(g.scene, g.camera);
      document.getElementById('title').classList.remove('hidden');
      window.__dtLive = null;
      return {
        geoBefore: memBefore.geo,
        geoAfter: r.info.memory.geometries,
        texBefore: memBefore.tex,
        texAfter: r.info.memory.textures,
      };
    });
    res.leak = leak;
    report.ranks.C = res;
    const c = res.contract;
    check(`D: cavern draw-call delta ${res.drawCalls} <= ${DRAW_BUDGET_CAVERN}`,
      res.drawCalls <= DRAW_BUDGET_CAVERN && res.drawCalls >= 5);
    check(`D: cavern triangle delta ${res.triangles} <= ${TRI_BUDGET_KIT}`,
      res.triangles <= TRI_BUDGET_KIT && res.triangles > 1000);
    check('D: contract surface (kind cavern, zones, nav, radius)',
      c.kind === 'cavern' && c.encounterDriven && c.heightAt && c.radiusPadded && c.hasNavGrid
      && c.zones >= 4 && c.zones <= 5 && c.doors === 2,
      JSON.stringify(c));
    check(`D: cavern furniture present (dome/stalactites/crystals/spires) with ${c.stalagmites} stalagmites, ${c.lightAnchors} light anchors`,
      res.meshes.dome && res.meshes.stalactites && res.meshes.crystals && res.meshes.spires
      && c.stalagmites >= 25 && c.lightAnchors >= 10,
      JSON.stringify(res.meshes));
    check('D: deterministic rebuild (incl. stalagmite field)', res.deterministic);
    check('D: disc roomAt semantics', res.roomAt.centresAgree && res.roomAt.tunnelIsNoRoom && res.roomAt.openFloorIsNoRoom,
      JSON.stringify(res.roomAt));
    check(`D: wall containment ${res.wallProbe.probed} probed, ${res.wallProbe.skipped} skipped`,
      res.wallProbe.breaches.length === 0 && res.wallProbe.probed > 40,
      res.wallProbe.breaches.length ? JSON.stringify(res.wallProbe.breaches.slice(0, 4)) : '');
    check('D: boss-neck membrane opens/seals/reopens',
      res.membrane.openCrosses === true && res.membrane.sealedReported === true
      && res.membrane.sealedCrosses === false && res.membrane.reopenedCrosses === true,
      JSON.stringify(res.membrane));
    check(`D: randomSpawn stays in entry zone ${res.spawns.inEntry}/${res.spawns.total}`,
      res.spawns.inEntry === res.spawns.total);
    check(`D: bossSpawn in the grotto (${res.boss.spawnPoints} pts)`,
      res.boss.inBossRoom && res.boss.spawnPoints >= 6);
    check('D: nav flow reaches the grotto', res.nav.goalSet && res.nav.bossReaches);
    check(`D: no GPU leak (geo ${res.leak.geoBefore}->${res.leak.geoAfter}, tex ${res.leak.texBefore}->${res.leak.texAfter})`,
      res.leak.geoAfter <= res.leak.geoBefore + 2 && res.leak.texAfter <= res.leak.texBefore + 2);
  }

  // ------------------------------------------------------------- phase T
  // Wave E task E-B: THE ASCENT — the B-rank tower mount, through the same
  // standalone lens as phases A/D. Tower-specific claims on top of the shared
  // ones: heightAt is live (entry 0, boss on the top floor), the player-body
  // seam data is present (layout.heightAt + params.fallDamage), stair-mouth
  // membranes seal ACROSS a height step, wall containment holds at each run's
  // own floor, parapet-gap ledges are one-way BY HEIGHT, and resolve()'s
  // settle walks a body up treads / drops it off a ledge.
  {
    const res = await page.evaluate(async ({ seed }) => {
      const { Dungeon, GATES } = window.__dt;
      const g = window.__game;
      const gate = GATES.find((x) => x.rank === 'B');
      const r = g.renderer;
      const out = {};
      const frame = () => {
        r.info.autoReset = false;
        r.info.reset();
        r.render(g.scene, g.camera);
        const withShadow = { calls: r.info.render.calls, tris: r.info.render.triangles };
        r.info.autoReset = true;
        r.render(g.scene, g.camera);
        return {
          calls: r.info.render.calls,
          tris: r.info.render.triangles,
          frameCalls: withShadow.calls,
          frameTris: withShadow.tris,
        };
      };
      const cityGroup = g.world?.group || null;
      const cityWasVisible = cityGroup ? cityGroup.visible : false;
      if (cityGroup) cityGroup.visible = false;
      const aimShadow = (dd) => {
        const c = dd.layout.rooms[dd.layout.bossRoom]?.centre || { x: 0, z: 0 };
        dd.updateShadowCamera({ x: c.x, y: dd.layout.rooms[dd.layout.bossRoom]?.floorY || 0, z: c.z }, 12);
        r.shadowMap.needsUpdate = true;
      };
      {
        // PMREM warm-up, as in phase A.
        const wd = new Dungeon(g.scene, g.renderer, g.camera);
        wd.build(gate, seed);
        r.render(g.scene, g.camera);
        wd.clear();
        g.scene.remove(wd.group);
        r.render(g.scene, g.camera);
      }
      const memBefore = { geo: r.info.memory.geometries, tex: r.info.memory.textures };
      const base = frame();
      const d = new Dungeon(g.scene, g.renderer, g.camera);
      d.build(gate, seed);
      aimShadow(d);
      const built = frame();
      out.drawCalls = built.calls - base.calls;
      out.triangles = built.tris - base.tris;
      out.frame = {
        drawCalls: built.frameCalls - base.frameCalls,
        triangles: built.frameTris - base.frameTris,
      };

      const L = d.layout;
      const bossRoom = L.rooms[L.bossRoom];
      out.contract = {
        kind: d.kind,
        encounterDriven: d.encounterDriven === true,
        radiusPadded: d.radius >= L.radius + 4 - 1e-9,
        hasNavGrid: !!d.navGrid && d.navGrid.baked,
        floors: L.floorCount,
        ramps: L.ramps.length,
        gaps: L.gaps.length,
        heightEntry: d.heightAt(0, 0),
        heightBoss: d.heightAt(bossRoom.centre.x, bossRoom.centre.z),
        bossFloorY: bossRoom.floorY,
        hasHeightFn: typeof L.heightAt === 'function',
        hasFallDamage: !!L.params.fallDamage,
        rooms: L.rooms.length,
        doors: L.doors.length,
      };

      // Determinism: in-world rebuild agreement, heights included.
      const d2 = new Dungeon(g.scene, g.renderer, g.camera);
      d2.build(gate, seed);
      const sig = (dd) => JSON.stringify({
        rooms: dd.layout.rooms.map((rm) => [rm.id, rm.kind, rm.floor, rm.x, rm.z, rm.w, rm.d, rm.budget]),
        doors: dd.layout.doors.map((dr) => [dr.id, dr.x, dr.z, dr.y, dr.w, dr.rot, dr.roomA, dr.roomB]),
        runs: dd.layout.wallRuns.map((wr) => [wr.x, wr.z, wr.w, wr.d, wr.face, wr.base, wr.top]),
        gaps: dd.layout.gaps.map((gp) => [gp.x, gp.z, gp.w, gp.rot, gp.yTop, gp.yLand]),
        mask: Array.from(dd.layout.mask).join(''),
        cellF: Array.from(dd.layout.cellF).join(','),
      });
      out.deterministic = sig(d) === sig(d2);
      d2.clear();
      g.scene.remove(d2.group);

      const floorAt = (x, z) => {
        const gx = Math.floor((x - L.originX) / L.cell);
        const gz = Math.floor((z - L.originZ) / L.cell);
        if (gx < 0 || gz < 0 || gx >= L.w || gz >= L.h) return false;
        return L.mask[gx + gz * L.w] === 1;
      };

      // Containment: phase A's drive-into-every-run probe, with the body's y
      // held at the run's OWN floor band (resolve's settle keeps it there —
      // that seam is under test too).
      const OUTWARD = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
      out.wallProbe = { probed: 0, skipped: 0, breaches: [] };
      for (let i = 0; i < L.wallRuns.length; i++) {
        const run = L.wallRuns[i];
        const [tx, tz] = OUTWARD[run.face];
        const sx = run.x - tx * 1.2;
        const sz = run.z - tz * 1.2;
        if (!floorAt(sx, sz)) { out.wallProbe.skipped++; continue; }
        const pos = { x: sx, y: d.heightAt(sx, sz), z: sz };
        const vel = { x: 0, y: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = tx * 4; vel.z = tz * 4; vel.y = 0;
          pos.x += vel.x * 0.05;
          pos.z += vel.z * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        const along = (pos.x - run.x) * tx + (pos.z - run.z) * tz;
        if (along > -0.55 || !floorAt(pos.x, pos.z)) {
          out.wallProbe.breaches.push({ i, face: run.face, along: +along.toFixed(3) });
        }
        out.wallProbe.probed++;
      }

      // A ramp-mouth membrane: seal/unseal crossing ACROSS the height step —
      // pick the boss room's door (always a ramp's high mouth).
      const door = L.doors[bossRoom.doors[0]];
      const [ntx, ntz] = door.rot === 0 ? [0, 1] : [1, 0];
      const nsgn = Math.sign((bossRoom.centre.x - door.x) * ntx + (bossRoom.centre.z - door.z) * ntz) || 1;
      const crossMouth = () => {
        const px = door.x - nsgn * ntx * 1.5;
        const pz = door.z - nsgn * ntz * 1.5;
        const pos = { x: px, y: d.heightAt(px, pz), z: pz };
        const vel = { x: 0, y: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = nsgn * ntx * 4; vel.z = nsgn * ntz * 4; vel.y = 0;
          pos.x += vel.x * 0.05; pos.z += vel.z * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        return {
          crossed: ((pos.x - door.x) * ntx + (pos.z - door.z) * ntz) * nsgn > door.d / 2 + 0.3,
          y: pos.y,
        };
      };
      const open1 = crossMouth();
      d.setDoorSealed(door.id, true);
      const sealed = crossMouth();
      d.setDoorSealed(door.id, false);
      const open2 = crossMouth();
      out.membrane = {
        openCrosses: open1.crossed,
        // The settle seam: driving up to and through the mouth climbed the
        // approach treads, so the body's y rose toward the door's own floor.
        climbedTo: +open1.y.toFixed(2),
        doorY: door.y,
        sealedCrosses: sealed.crossed,
        reopenedCrosses: open2.crossed,
      };

      // Parapet ledge (when this seed rolled one): one-way by height. From
      // the landing side the ledge box + the terrace face wall the body out;
      // from the lip the body walks over the plane and the settle drops it.
      out.ledge = null;
      if (L.gaps.length) {
        const gap = L.gaps[0];
        const [lx, lz] = gap.rot === 0 ? [0, 1] : [1, 0];
        // Outward = away from the gap's room.
        const room = L.rooms[gap.room];
        const osgn = Math.sign((gap.x - room.centre.x) * lx + (gap.z - room.centre.z) * lz) || 1;
        const drive = (fromBelow) => {
          const s0 = fromBelow ? 1 : -1;   // below: start outside, drive in
          const px = gap.x + osgn * lx * 1.5 * s0;
          const pz = gap.z + osgn * lz * 1.5 * s0;
          const pos = { x: px, y: d.heightAt(px, pz), z: pz };
          const vel = { x: 0, y: 0, z: 0 };
          for (let step = 0; step < 60; step++) {
            vel.x = -s0 * osgn * lx * 4; vel.z = -s0 * osgn * lz * 4; vel.y = 0;
            pos.x += vel.x * 0.05; pos.z += vel.z * 0.05;
            d.resolve(pos, 0.5, vel);
          }
          const along = ((pos.x - gap.x) * lx + (pos.z - gap.z) * lz) * osgn;
          return { along: +along.toFixed(2), y: +pos.y.toFixed(2) };
        };
        const up = drive(true);     // from the landing, into the cliff face
        const down = drive(false);  // from the lip, off the edge
        out.ledge = {
          yTop: gap.yTop,
          yLand: gap.yLand,
          up,
          down,
          // Up: never past the plane (along stays positive = still outside),
          // and never lifted to the top. Down: crossed the plane outward and
          // settled to the landing floor.
          blockedFromBelow: up.along > 0.2 && up.y < gap.yTop - 0.5,
          dropsFromAbove: down.along > 0.2 && down.y <= gap.yLand + 0.05,
        };
      }

      // randomSpawn: entry room, ground floor. bossSpawn: top floor, on its
      // own height, standing on clear floor at ITS feet height.
      let sRnd = 24680;
      const rnd = () => {
        sRnd = (sRnd * 1664525 + 1013904223) >>> 0;
        return sRnd / 4294967296;
      };
      out.spawns = { inEntry: 0, total: 8 };
      for (let i = 0; i < 8; i++) {
        const p = d.randomSpawn(rnd, { x: 0, y: 0, z: 0 }, 4);
        if (d.roomAt(p.x, p.z) === 0 && p.y === 0) out.spawns.inEntry++;
      }
      const bs = d.bossSpawn();
      out.boss = {
        inBossRoom: d.roomAt(bs.x, bs.z) === L.bossRoom,
        y: bs.y,
        spawnPoints: d.spawnPointsFor(L.bossRoom).length,
        anchorClear: !d.obstacleField.blocked(bs.x, bs.z, 0.45, 0.4, bs.y),
      };

      out.roomAt = {
        centresAgree: L.rooms.every((rm) => d.roomAt(rm.centre.x, rm.centre.z) === rm.id),
        tunnelIsNoRoom: d.roomAt(0, 0) === -1,
      };
      const dirv = { x: 0, z: 0 };
      out.nav = { goalSet: d.navGrid.setGoal(L.rooms[0].centre.x, L.rooms[0].centre.z), bossReaches: false };
      if (out.nav.goalSet) out.nav.bossReaches = d.navGrid.flowAt(bossRoom.centre.x, bossRoom.centre.z, dirv);

      out.dressing = d.dressing;
      window.__dtLive = { d, memBefore };
      return out;
    }, { seed: SEEDS.B });

    // Dressed evidence shot over a mid-floor room, camera riding its height —
    // per-tick pinned redirect, as in phases A/D.
    await page.evaluate(() => {
      const g = window.__game;
      const { d } = window.__dtLive;
      const rooms = d.layout.rooms.filter((r) => r.kind === 'combat' && r.floor >= 1);
      const room = rooms[0] || d.layout.rooms[d.layout.bossRoom];
      document.getElementById('title').classList.add('hidden');
      const orig = g.renderer.render.bind(g.renderer);
      window.__dtLive.restoreRender = g.renderer.render;
      const present = () => {
        g.camera.position.set(room.centre.x, (room.floorY || 0) + 11, room.centre.z + 11);
        g.camera.lookAt(room.centre.x, (room.floorY || 0) + 1, room.centre.z);
        orig(g.scene, g.camera);
      };
      g.renderer.render = present;
      present();
    });
    const shotTower = shotPath('dungeon-b-tower.png');
    await page.screenshot({ path: shotTower });
    report.screenshots.push(shotTower);
    const leak = await page.evaluate(() => {
      const g = window.__game;
      const { d, memBefore, restoreRender } = window.__dtLive;
      const r = g.renderer;
      if (restoreRender) r.render = restoreRender;
      d.clear();
      g.scene.remove(d.group);
      r.render(g.scene, g.camera);
      document.getElementById('title').classList.remove('hidden');
      window.__dtLive = null;
      return {
        geoBefore: memBefore.geo,
        geoAfter: r.info.memory.geometries,
        texBefore: memBefore.tex,
        texAfter: r.info.memory.textures,
      };
    });
    res.leak = leak;
    report.ranks.B = res;
    const c = res.contract;
    check(`T: tower draw-call delta ${res.drawCalls} <= ${FRAME_BUDGET.B.draws}`,
      res.drawCalls <= FRAME_BUDGET.B.draws && res.drawCalls >= 5);
    check(`T: tower WHOLE-FRAME ${res.frame.drawCalls} draws / ${res.frame.triangles} tris <= ${FRAME_BUDGET.B.draws} / ${FRAME_BUDGET.B.tris}`,
      res.frame.drawCalls <= FRAME_BUDGET.B.draws && res.frame.triangles <= FRAME_BUDGET.B.tris
      && res.frame.triangles >= res.triangles);
    check('T: contract surface (kind tower, height seam live, fallDamage data)',
      c.kind === 'tower' && c.encounterDriven && c.radiusPadded && c.hasNavGrid
      && c.hasHeightFn && c.hasFallDamage
      && c.floors >= 4 && c.floors <= 6 && c.ramps === c.floors - 1,
      JSON.stringify(c));
    check(`T: heightAt — entry 0, boss ${c.heightBoss} on top floor (${c.bossFloorY})`,
      c.heightEntry === 0 && c.heightBoss === c.bossFloorY && c.bossFloorY === (c.floors - 1) * 3);
    check('T: deterministic rebuild (heights, runs, gaps included)', res.deterministic);
    check(`T: wall containment at floor height — ${res.wallProbe.probed} probed, ${res.wallProbe.skipped} skipped`,
      res.wallProbe.breaches.length === 0 && res.wallProbe.probed > 20
      && res.wallProbe.skipped < res.wallProbe.probed * 0.4,
      res.wallProbe.breaches.length ? JSON.stringify(res.wallProbe.breaches.slice(0, 4)) : '');
    check(`T: ramp-mouth membrane seals across the height step (climbed to y ${res.membrane.climbedTo} toward door y ${res.membrane.doorY})`,
      res.membrane.openCrosses === true && res.membrane.sealedCrosses === false
      && res.membrane.reopenedCrosses === true
      && res.membrane.climbedTo > res.membrane.doorY - 1.2,
      JSON.stringify(res.membrane));
    if (res.ledge) {
      check(`T: parapet ledge is one-way (up blocked at y ${res.ledge.up.y}, drop lands at y ${res.ledge.down.y} of ${res.ledge.yLand.toFixed(1)})`,
        res.ledge.blockedFromBelow === true && res.ledge.dropsFromAbove === true,
        JSON.stringify(res.ledge));
    } else {
      console.log(`      (seed ${SEEDS.B} rolled no parapet gap — ledge probe covered by the gen soak's per-gap asserts)`);
    }
    check(`T: randomSpawn stays in the ground-floor entry ${res.spawns.inEntry}/${res.spawns.total}`,
      res.spawns.inEntry === res.spawns.total);
    check(`T: bossSpawn on the top floor at y ${res.boss.y} (${res.boss.spawnPoints} pts), clear floor`,
      res.boss.inBossRoom && res.boss.y === c.bossFloorY && res.boss.spawnPoints >= 4
      && res.boss.anchorClear === true);
    check('T: roomAt agrees', res.roomAt.centresAgree && res.roomAt.tunnelIsNoRoom);
    check('T: nav flow reaches the boss floor', res.nav.goalSet && res.nav.bossReaches);
    check(`T: dressing roles placed ${JSON.stringify(res.dressing?.roles || {})}`,
      res.dressing?.roles?.archway > 0 && res.dressing?.roles?.torch > 0
      && res.dressing?.roles?.column > 0);
    check(`T: no GPU leak (geo ${res.leak.geoBefore}->${res.leak.geoAfter}, tex ${res.leak.texBefore}->${res.leak.texAfter})`,
      res.leak.geoAfter <= res.leak.geoBefore + 2 && res.leak.texAfter <= res.leak.texBefore + 2);
  }

  // ------------------------------------------------------------- phase V
  // Wave E task E-A: THE RIVEN WASTE — the A-rank open-landscape mount,
  // through the same standalone lens as phases A/D/T. Waste-specific claims
  // on top of the shared ones: the SMOOTH height seam (rolling terrain,
  // spawn exactly on the datum, walkable gradients), route + compass-beacon
  // contract (one door, nothing else can seal), outcrop collision riding the
  // terrain, rim containment, and bossSpawn/exit anchors on clear ground.
  {
    const res = await page.evaluate(async ({ seed }) => {
      const { Dungeon, GATES } = window.__dt;
      const g = window.__game;
      const gate = GATES.find((x) => x.rank === 'A');
      const r = g.renderer;
      const out = {};
      const frame = () => {
        r.info.autoReset = false;
        r.info.reset();
        r.render(g.scene, g.camera);
        const withShadow = { calls: r.info.render.calls, tris: r.info.render.triangles };
        r.info.autoReset = true;
        r.render(g.scene, g.camera);
        return {
          calls: r.info.render.calls,
          tris: r.info.render.triangles,
          frameCalls: withShadow.calls,
          frameTris: withShadow.tris,
        };
      };
      const cityGroup = g.world?.group || null;
      if (cityGroup) cityGroup.visible = false;
      const aimShadow = (dd) => {
        const c = dd.layout.rooms[dd.layout.bossRoom]?.centre || { x: 0, z: 0 };
        dd.updateShadowCamera({ x: c.x, y: 0, z: c.z }, 12);
        r.shadowMap.needsUpdate = true;
      };
      {
        // PMREM warm-up, as in phase A.
        const wd = new Dungeon(g.scene, g.renderer, g.camera);
        wd.build(gate, seed);
        r.render(g.scene, g.camera);
        wd.clear();
        g.scene.remove(wd.group);
        r.render(g.scene, g.camera);
      }
      const memBefore = { geo: r.info.memory.geometries, tex: r.info.memory.textures };
      const base = frame();
      const d = new Dungeon(g.scene, g.renderer, g.camera);
      d.build(gate, seed);
      aimShadow(d);
      const built = frame();
      out.drawCalls = built.calls - base.calls;
      out.triangles = built.tris - base.tris;
      out.frame = {
        drawCalls: built.frameCalls - base.frameCalls,
        triangles: built.frameTris - base.frameTris,
      };

      const L = d.layout;
      const bossRoom = L.rooms[L.bossRoom];
      out.contract = {
        kind: d.kind,
        encounterDriven: d.encounterDriven === true,
        radiusPadded: d.radius >= L.radius + 4 - 1e-9,
        hasNavGrid: !!d.navGrid && d.navGrid.baked,
        hasHeightFn: typeof L.heightAt === 'function',
        smooth: L.smoothHeight === true,
        noFallDamage: !L.params.fallDamage,
        route: L.route,
        rooms: L.rooms.length,
        doors: L.doors.length,
        cover: L.decor.cover.length,
        heightEntry: d.heightAt(0, 0),
      };

      // Terrain: the datum + walkable-gradient claims, sampled live.
      {
        let maxSlope = 0;
        let maxH = 0;
        for (const rm of L.rooms) {
          for (const p of rm.spawnPoints.slice(0, 20)) {
            const y = d.heightAt(p.x, p.z);
            maxH = Math.max(maxH, Math.abs(y));
            const gx = (d.heightAt(p.x + 0.45, p.z) - d.heightAt(p.x - 0.45, p.z)) / 0.9;
            const gz = (d.heightAt(p.x, p.z + 0.45) - d.heightAt(p.x, p.z - 0.45)) / 0.9;
            maxSlope = Math.max(maxSlope, Math.hypot(gx, gz));
            if (Math.abs((p.y ?? -1) - y) > 1e-9) out.spawnYDrift = true;
          }
        }
        out.terrain = { maxSlope: +maxSlope.toFixed(3), maxH: +maxH.toFixed(2) };
      }

      // Determinism: in-world rebuild agreement — terrain and outcrops
      // included (the context-loss repair contract).
      const d2 = new Dungeon(g.scene, g.renderer, g.camera);
      d2.build(gate, seed);
      const sig = (dd) => JSON.stringify({
        rooms: dd.layout.rooms.map((rm) => [rm.id, rm.kind, rm.x, rm.z, rm.w, rm.d, rm.budget, rm.roam || 0]),
        route: dd.layout.route,
        doors: dd.layout.doors.map((dr) => [dr.id, dr.x, dr.z, dr.w, dr.rot, dr.roomA, dr.roomB]),
        runs: dd.layout.wallRuns.map((wr) => [wr.x, wr.z, wr.w, wr.d, wr.face, wr.base, wr.top]),
        cover: dd.layout.decor.cover.map((c) => [c.kind, c.x, c.z, c.yaw, c.y]),
        terrain: dd.layout.terrain,
        mask: Array.from(dd.layout.mask).join(''),
      });
      out.deterministic = sig(d) === sig(d2);
      d2.clear();
      g.scene.remove(d2.group);

      const floorAt = (x, z) => {
        const gx = Math.floor((x - L.originX) / L.cell);
        const gz = Math.floor((z - L.originZ) / L.cell);
        if (gx < 0 || gz < 0 || gx >= L.w || gz >= L.h) return false;
        return L.mask[gx + gz * L.w] === 1;
      };

      // Rim containment: the drive-into-every-run probe on the canyon rim,
      // body y riding the terrain settle.
      const OUTWARD = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
      out.wallProbe = { probed: 0, skipped: 0, breaches: [] };
      for (let i = 0; i < L.wallRuns.length; i++) {
        const run = L.wallRuns[i];
        const [tx, tz] = OUTWARD[run.face];
        const sx = run.x - tx * 1.2;
        const sz = run.z - tz * 1.2;
        if (!floorAt(sx, sz)) { out.wallProbe.skipped++; continue; }
        const pos = { x: sx, y: d.heightAt(sx, sz), z: sz };
        const vel = { x: 0, y: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = tx * 4; vel.z = tz * 4; vel.y = 0;
          pos.x += vel.x * 0.05;
          pos.z += vel.z * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        const along = (pos.x - run.x) * tx + (pos.z - run.z) * tz;
        if (along > -0.55 || !floorAt(pos.x, pos.z)) {
          out.wallProbe.breaches.push({ i, face: run.face, along: +along.toFixed(3) });
        }
        out.wallProbe.probed++;
      }

      // Outcrop collision rides the terrain: drive a body into the first
      // rubble/stub footprint — resolve must hold it out at its own ground.
      out.outcrop = null;
      const pile = L.decor.cover.find((c) => c.kind !== 'pillar');
      if (pile) {
        const pos = { x: pile.x - (pile.ex + 2.5), y: 0, z: pile.z };
        pos.y = d.heightAt(pos.x, pos.z);
        const vel = { x: 0, y: 0, z: 0 };
        for (let step = 0; step < 60; step++) {
          vel.x = 4; vel.z = 0; vel.y = 0;
          pos.x += vel.x * 0.05;
          d.resolve(pos, 0.5, vel);
        }
        out.outcrop = {
          kind: pile.kind,
          y: pile.y,
          heldOut: pos.x < pile.x - pile.ex + 0.2,
        };
      }

      // The compass beacon: a dungeon-owned toggle the director drives.
      const site0 = L.rooms[L.route[0]];
      d.setWaypoint(site0.id);
      out.beacon = {
        visibleOn: !!d._waypointBeacon?.visible,
        atSite: d._waypointBeacon
          ? Math.hypot(d._waypointBeacon.position.x - site0.centre.x,
            d._waypointBeacon.position.z - site0.centre.z) < 0.01
          : false,
      };
      d.setWaypoint(-1);
      out.beacon.hiddenOff = !d._waypointBeacon?.visible;

      // randomSpawn: entry disc, on the datum. bossSpawn: the final site's
      // rise anchor, on its own terrain height, standing on clear floor.
      let sRnd = 24680;
      const rnd = () => {
        sRnd = (sRnd * 1664525 + 1013904223) >>> 0;
        return sRnd / 4294967296;
      };
      out.spawns = { inEntry: 0, total: 8 };
      for (let i = 0; i < 8; i++) {
        const p = d.randomSpawn(rnd, { x: 0, y: 0, z: 0 }, 4);
        if (d.roomAt(p.x, p.z) === 0) out.spawns.inEntry++;
      }
      const bs = d.bossSpawn();
      out.boss = {
        inBossRoom: d.roomAt(bs.x, bs.z) === L.bossRoom,
        onTerrain: Math.abs(bs.y - d.heightAt(bs.x, bs.z)) < 1e-9,
        anchorClear: !d.obstacleField.blocked(bs.x, bs.z, 0.45, 0.4, bs.y),
        spawnPoints: d.spawnPointsFor(L.bossRoom).length,
      };

      out.roomAt = {
        centresAgree: L.rooms.every((rm) => d.roomAt(rm.centre.x, rm.centre.z) === rm.id),
        tunnelIsNoRoom: d.roomAt(0, 0) === -1,
      };
      const dirv = { x: 0, z: 0 };
      out.nav = { goalSet: d.navGrid.setGoal(L.rooms[0].centre.x, L.rooms[0].centre.z), bossReaches: false };
      if (out.nav.goalSet) out.nav.bossReaches = d.navGrid.flowAt(bossRoom.centre.x, bossRoom.centre.z, dirv);

      out.dressing = d.dressing;
      window.__dtLive = { d, memBefore };
      return out;
    }, { seed: SEEDS.A });

    // Dressed evidence shot over the middle route site — per-tick pinned
    // redirect, as in phases A/D/T.
    await page.evaluate(() => {
      const g = window.__game;
      const { d } = window.__dtLive;
      const site = d.layout.rooms[d.layout.route[1]] || d.layout.rooms[d.layout.route[0]];
      d.setWaypoint(site.id);
      document.getElementById('title').classList.add('hidden');
      const orig = g.renderer.render.bind(g.renderer);
      window.__dtLive.restoreRender = g.renderer.render;
      const y = d.heightAt(site.centre.x, site.centre.z);
      const present = () => {
        g.camera.position.set(site.centre.x, y + 13, site.centre.z + 14);
        g.camera.lookAt(site.centre.x, y + 1, site.centre.z - 6);
        orig(g.scene, g.camera);
      };
      g.renderer.render = present;
      present();
    });
    const shotWaste = shotPath('dungeon-a-waste.png');
    await page.screenshot({ path: shotWaste });
    report.screenshots.push(shotWaste);
    const leak = await page.evaluate(() => {
      const g = window.__game;
      const { d, memBefore, restoreRender } = window.__dtLive;
      const r = g.renderer;
      if (restoreRender) r.render = restoreRender;
      d.clear();
      g.scene.remove(d.group);
      r.render(g.scene, g.camera);
      document.getElementById('title').classList.remove('hidden');
      window.__dtLive = null;
      return {
        geoBefore: memBefore.geo,
        geoAfter: r.info.memory.geometries,
        texBefore: memBefore.tex,
        texAfter: r.info.memory.textures,
      };
    });
    res.leak = leak;
    report.ranks.A = res;
    const c = res.contract;
    check(`V: waste draw-call delta ${res.drawCalls} <= ${FRAME_BUDGET.A.draws}`,
      res.drawCalls <= FRAME_BUDGET.A.draws && res.drawCalls >= 5);
    check(`V: waste WHOLE-FRAME ${res.frame.drawCalls} draws / ${res.frame.triangles} tris <= ${FRAME_BUDGET.A.draws} / ${FRAME_BUDGET.A.tris}`,
      res.frame.drawCalls <= FRAME_BUDGET.A.draws && res.frame.triangles <= FRAME_BUDGET.A.tris
      && res.frame.triangles >= res.triangles);
    check('V: contract surface (kind waste, smooth height seam live, route of 3, ONE door)',
      c.kind === 'waste' && c.encounterDriven && c.radiusPadded && c.hasNavGrid
      && c.hasHeightFn && c.smooth && c.noFallDamage
      && Array.isArray(c.route) && c.route.length === 3 && c.doors === 1
      && c.rooms === 5 && c.cover >= 8,
      JSON.stringify(c));
    check(`V: terrain — spawn on the datum, slope ${res.terrain.maxSlope} walkable, swell ${res.terrain.maxH} m`,
      c.heightEntry === 0 && !res.spawnYDrift
      && res.terrain.maxSlope <= 0.45 && res.terrain.maxH > 0.15 && res.terrain.maxH < 3);
    check('V: deterministic rebuild (terrain, outcrops, route included)', res.deterministic);
    check(`V: rim containment on terrain — ${res.wallProbe.probed} probed, ${res.wallProbe.skipped} skipped`,
      res.wallProbe.breaches.length === 0 && res.wallProbe.probed > 20,
      res.wallProbe.breaches.length ? JSON.stringify(res.wallProbe.breaches.slice(0, 4)) : '');
    check('V: outcrop footprint holds a driven body out, on its own ground',
      !!res.outcrop && res.outcrop.heldOut === true, JSON.stringify(res.outcrop));
    check('V: compass beacon toggles (visible at the site, hidden on -1)',
      res.beacon.visibleOn && res.beacon.atSite && res.beacon.hiddenOff,
      JSON.stringify(res.beacon));
    check(`V: randomSpawn stays in the entry clearing ${res.spawns.inEntry}/${res.spawns.total}`,
      res.spawns.inEntry === res.spawns.total);
    check(`V: bossSpawn at the final site on clear terrain (${res.boss.spawnPoints} pts)`,
      res.boss.inBossRoom && res.boss.onTerrain && res.boss.anchorClear === true
      && res.boss.spawnPoints >= 1);
    check('V: roomAt agrees (discs; open field between sites is no-room)',
      res.roomAt.centresAgree && res.roomAt.tunnelIsNoRoom);
    check('V: nav flow crosses the field to the boss site', res.nav.goalSet && res.nav.bossReaches);
    check(`V: dressing roles placed ${JSON.stringify(res.dressing?.roles || {})}`,
      res.dressing?.roles?.archway > 0
      && ((res.dressing?.roles?.coverRubble || 0) + (res.dressing?.roles?.coverStub || 0)
        + (res.dressing?.roles?.column || 0)) >= 8);
    check(`V: no GPU leak (geo ${res.leak.geoBefore}->${res.leak.geoAfter}, tex ${res.leak.texBefore}->${res.leak.texAfter})`,
      res.leak.geoAfter <= res.leak.geoBefore + 2 && res.leak.texAfter <= res.leak.texBefore + 2);
  }

  // ------------------------------------------------------------- phase F
  // STEP 7 procedural fallback: block citykit.glb AND dungeonkit.glb (the
  // dressing roles span both since STEP 9) before boot on a FRESH page (kit
  // state is module-level, so the main page can't unload it) and rebuild the
  // same E layout. Every dressing role must still land — same counts,
  // because placement is layout + seed, not asset availability — on the
  // procedural twins, inside the tighter procedural budgets.
  {
    const { page: pf, errors: ferrors } = await newPhonePage(browser);
    await pf.route('**/citykit.glb', (route) => route.abort());
    await pf.route('**/dungeonkit.glb', (route) => route.abort());
    await gotoGame(pf);
    const fb = await pf.evaluate(async ({ seed }) => {
      const [{ Dungeon }, cfg, kit] = await Promise.all([
        import('/src/world/dungeon.js'),
        import('/src/game/config.js'),
        import('/src/world/citykit.js'),
      ]);
      const g = window.__game;
      const r = g.renderer;
      const gate = cfg.GATES.find((x) => x.rank === 'E');
      const frame = () => {
        r.render(g.scene, g.camera);
        return { calls: r.info.render.calls, tris: r.info.render.triangles };
      };
      {
        // Same PMREM warm-up as phase A so numbers are steady-state.
        const wd = new Dungeon(g.scene, g.renderer, g.camera);
        wd.build(gate, seed);
        r.render(g.scene, g.camera);
        wd.clear();
        g.scene.remove(wd.group);
      }
      const base = frame();
      const d = new Dungeon(g.scene, g.renderer, g.camera);
      d.build(gate, seed);
      const built = frame();
      const room = d.layout.rooms.find((rm) => rm.kind === 'combat') || d.layout.rooms[0];
      g.camera.position.set(room.centre.x, 11, room.centre.z + 11);
      g.camera.lookAt(room.centre.x, 1, room.centre.z);
      document.getElementById('title')?.classList.add('hidden');
      const present = r.render.bind(r);
      window.__dtLive = { d, restoreRender: r.render };
      r.render = () => {};   // freeze the title RAF on our frame
      present(g.scene, g.camera);
      return {
        kitLoaded: kit.cityKitLoaded(),
        dungeonKitLoaded: kit.dungeonKitLoaded(),
        dressing: d.dressing,
        drawCalls: built.calls - base.calls,
        triangles: built.tris - base.tris,
      };
    }, { seed: SEEDS.E });
    const shotFb = shotPath('dungeon-e-fallback.png');
    await pf.screenshot({ path: shotFb });
    report.screenshots.push(shotFb);
    await pf.evaluate(() => {
      const g = window.__game;
      if (window.__dtLive.restoreRender) g.renderer.render = window.__dtLive.restoreRender;
      window.__dtLive.d.clear();
      g.scene.remove(window.__dtLive.d.group);
      window.__dtLive = null;
    });
    report.fallback = fb;
    check('F: citykit.glb + dungeonkit.glb blocked — neither kit loaded',
      fb.kitLoaded === false && fb.dungeonKitLoaded === false && fb.dressing?.kitLoaded === false);
    const kitRoles = report.ranks.E.dressing.roles;
    check('F: every dressing role renders procedurally with identical counts',
      JSON.stringify(fb.dressing?.roles) === JSON.stringify(kitRoles),
      `kit ${JSON.stringify(kitRoles)} vs proc ${JSON.stringify(fb.dressing?.roles)}`);
    check(`F: fallback draw-call delta ${fb.drawCalls} <= ${DRAW_BUDGET}`,
      fb.drawCalls <= DRAW_BUDGET && fb.drawCalls >= 5);
    check(`F: fallback triangle delta ${fb.triangles} <= ${TRI_BUDGET_PROC}`,
      fb.triangles <= TRI_BUDGET_PROC && fb.triangles > 1000);
    const fbErr = ferrors.filter((e) => !/ResizeObserver/.test(e));
    check('F: no page errors on the blocked-asset boot', fbErr.length === 0, fbErr.slice(0, 2).join(' | '));
    await pf.close();
  }

  // ------------------------------------------------------------- phase B
  // STEP 4 shipped path: walking into an E gate mounts the crawl natively.
  // No world swap, no dev mount — these assertions are against exactly what
  // a player's tap produces. Since STEP 6 that includes the walk-in intro:
  // 2.4 s of auto-walk with input suppressed, HUD/toast deferred to intro
  // end, the low shoulder camera easing up to the follow rig.
  await enterGate(page, { rank: 'E', waitMs: 350 });   // land ~0.35 s into the intro
  const swap = await page.evaluate(() => {
    const g = window.__game;
    if (g.mode?.name !== 'dungeon') return { ok: false, why: `mode ${g.mode?.name}` };
    const d = g.world;
    if (!d.layout) return { ok: false, why: 'mounted world has no layout — arena?' };
    return {
      ok: true,
      kind: d.kind,
      isModeDungeon: g.mode.dungeon === d,
      notArena: d !== g._arenaWorld,
      encounterDriven: d.encounterDriven === true,
      // EDIT 1: dormant rooms — _beginGate's wave dump and the timer must not
      // have spawned anything without a director.
      spawned: g.spawned,
      enemies: g.enemies.length,
      // STEP 6: the intro owns the entry — HUD and toast must NOT be up yet.
      introActive: !!g.mode.intro,
      introT: g.mode.intro ? +g.mode.intro.t.toFixed(2) : -1,
      hudVisible: !document.getElementById('hud').classList.contains('hidden'),
      camY: +g.camera.position.y.toFixed(2),
      // The body collides against the crawl's field, not the arena's.
      obstaclesBound: g.player.body.obstacles === d.obstacleField,
      playerRoom: d.roomAt(g.player.pos.x, g.player.pos.z),
      playerZ: +g.player.pos.z.toFixed(2),
      state: g.state,
      entry: d.layout.rooms[0].centre,
      // Entry membrane: the arrival portal must be mid-seal (or about to be).
      entrySeal: +d._entrySeal.toFixed(2),
    };
  });
  check('B: E gate mounts the crawl natively', swap.ok === true, swap.why || '');
  check('B: mounted world is the mode\'s Dungeon, not the arena',
    swap.kind === 'crawl' && swap.isModeDungeon && swap.notArena && swap.encounterDriven);
  check('B: rooms are dormant (EDIT 1: no spawns without a director)',
    swap.spawned === 0 && swap.enemies === 0, `spawned=${swap.spawned} enemies=${swap.enemies}`);
  check('B: intro is running with HUD suppressed (STEP 6)',
    swap.introActive && !swap.hudVisible && swap.state === 'playing',
    `introT=${swap.introT} hud=${swap.hudVisible}`);
  check(`B: intro camera opens low over the shoulder (y ${swap.camY})`,
    swap.camY > 2.5 && swap.camY < 7);
  check(`B: entry membrane is sealing (${swap.entrySeal})`,
    swap.entrySeal > 0 && swap.entrySeal < 1);
  check('B: body collides against the crawl obstacle field', swap.obstaclesBound === true);
  check('B: player starts in the tunnel (no room)', swap.playerRoom === -1);

  // The player-visible entry shot: low camera, dark tunnel mouth, sealing
  // portal behind the player.
  const shotIntro = shotPath('dungeon-e-intro-shoulder.png');
  await page.screenshot({ path: shotIntro });
  report.screenshots.push(shotIntro);

  // Input suppression + auto-walk: inject a buffered attack and a full-tilt
  // stick mid-intro; the swing must never fire and the body must keep its own
  // 0.7x walk down -Z (the injected stick pushes +X and must not bend it).
  const introMid = await page.evaluate(() => {
    const g = window.__game;
    g.input.pressed.add('attack');
    g.input.move.x = 1;
    g.input.move.y = 0;
    return { z: g.player.pos.z, x: g.player.pos.x };
  });
  await page.waitForTimeout(300);
  const introProbe = await page.evaluate(({ z0, x0 }) => {
    const g = window.__game;
    const out = {
      stillIntro: !!g.mode.intro,
      swung: g.player.swing > 0,
      advanced: g.player.pos.z < z0 - 0.5,
      driftX: Math.abs(g.player.pos.x - x0),
      yaw: g.player.yaw,
    };
    g.input.move.x = 0;
    g.input.move.y = 0;
    return out;
  }, { z0: introMid.z, x0: introMid.x });
  check('B: input suppressed during intro (attack ignored, stick ignored), auto-walk advances',
    introProbe.stillIntro && !introProbe.swung && introProbe.advanced
    && introProbe.driftX < 0.2 && Math.abs(introProbe.yaw - Math.PI) < 1e-6,
    JSON.stringify(introProbe));

  // Natural completion: HUD + rank toast land AT intro end, not before.
  await page.waitForFunction(() => !window.__game.mode.intro, null, { timeout: 6000 });
  const introEnd = await page.evaluate(() => {
    const g = window.__game;
    return {
      hudVisible: !document.getElementById('hud').classList.contains('hidden'),
      toast: document.getElementById('toasts')?.textContent || '',
      playerZ: +g.player.pos.z.toFixed(2),
      state: g.state,
      entrySeal: g.world._entrySeal,
    };
  });
  check('B: HUD + rank toast fire at intro end (EDIT 7 final form)',
    introEnd.hudVisible && /GRADE RIFT/.test(introEnd.toast) && introEnd.state === 'playing',
    JSON.stringify({ toast: introEnd.toast, hud: introEnd.hudVisible }));
  check(`B: auto-walk carried the player down the tunnel (z ${introEnd.playerZ})`,
    introEnd.playerZ < -3.5);
  check('B: entry membrane fully sealed by intro end', introEnd.entrySeal === 1);

  // Interior camera: let real frames land, then confirm the follow rig is
  // live, finite, eased up from the shoulder shot, and not clamped into the
  // floor by a phantom probe hit.
  await page.waitForTimeout(700);
  const cam = await page.evaluate(() => {
    const g = window.__game;
    const c = g.camera.position;
    return {
      finite: Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z),
      aboveFloor: c.y > 2.0,
      easedUp: c.y > 8.5,
      southOfPlayer: c.z > g.player.pos.z + 4,
    };
  });
  check('B: interior camera is live, sane, and eased up from the intro',
    cam.finite && cam.aboveFloor && cam.easedUp && cam.southOfPlayer,
    JSON.stringify(cam));

  await page.waitForTimeout(700);
  const shot1 = shotPath('dungeon-e-tunnel.png');
  await page.screenshot({ path: shot1 });
  report.screenshots.push(shot1);

  // Walk the player into the entry room for the second shot.
  await page.evaluate(({ entry }) => {
    const g = window.__game;
    g.player.body.reset(entry.x, 0, entry.z + 2);
    g.player.pos.set(entry.x, 0, entry.z + 2);
  }, { entry: swap.entry });
  await page.waitForTimeout(1000);
  const shot2 = shotPath('dungeon-e-room.png');
  await page.screenshot({ path: shot2 });
  report.screenshots.push(shot2);

  const live = await page.evaluate(() => {
    const g = window.__game;
    return {
      playerRoom: g.world.roomAt(g.player.pos.x, g.player.pos.z),
      playerPos: { x: +g.player.pos.x.toFixed(2), z: +g.player.pos.z.toFixed(2) },
      state: g.state,
    };
  });
  check('B: player teleported into entry room', live.playerRoom === 0, JSON.stringify(live));

  // Skip-tap: re-enter the gate and tap mid-intro. The intro must end
  // immediately (well before its 2.4 s), with the HUD + toast landing on the
  // skip frame. Phase W then runs on this second mount. Entry is driven
  // directly (phase C's pattern) — the harness's UI walk was already
  // exercised above, and the stale gate list from that visit confuses its
  // count-based "am I on the list yet" heuristic on a second pass.
  await page.evaluate(() => window.__app.go('title'));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__game.enterGate('E'));
  await page.waitForTimeout(350);
  const preSkip = await page.evaluate(() => {
    const g = window.__game;
    return { introActive: !!g.mode.intro, t: g.mode.intro?.t ?? -1 };
  });
  check('B: re-entry starts a fresh intro', preSkip.introActive && preSkip.t < 1.2, `t=${preSkip.t}`);
  await page.mouse.click(446, 206);   // tap the open canvas — the skip gesture
  let skedEarly = false;
  try {
    await page.waitForFunction(() => !window.__game.mode.intro, null, { timeout: 900 });
    skedEarly = true;
  } catch { /* fell through to the natural 2.4 s end — the check below fails */ }
  const postSkip = await page.evaluate(() => {
    const g = window.__game;
    return {
      hudVisible: !document.getElementById('hud').classList.contains('hidden'),
      state: g.state,
      playerZ: +g.player.pos.z.toFixed(2),
    };
  });
  check('B: tap skips the intro — control and HUD land immediately',
    skedEarly && postSkip.hudVisible && postSkip.state === 'playing',
    JSON.stringify(postSkip));

  // ------------------------------------------------------------- phase W
  // STEP 5 walkthrough on the gate phase B mounted. Stepping is manual
  // (g.update in a loop with render stubbed) so every assertion lands on a
  // deterministic frame; screenshots restore the renderer between parts.

  // W part 1: trigger the first combat room, ride out the grace, verify the
  // seal both in director state and at the collision field.
  const w1 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const out = {};
    const origRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => { g.player.body.reset(x, 0, z); g.player.pos.set(x, 0, z); };

    // Visit order: critical-path combat rooms, then off-path side rooms —
    // allCleared demands EVERY combat room, not just the spine.
    const onPath = L.criticalPath.filter((id) => L.rooms[id].kind === 'combat');
    const side = L.rooms
      .filter((r) => r.kind === 'combat' && !onPath.includes(r.id))
      .map((r) => r.id);
    window.__wt = { order: [...onPath, ...side] };

    out.hasDirector = !!dir;
    out.combatRooms = window.__wt.order.length;
    out.phase = dir?.state;
    out.bossSealedAtStart = L.rooms[L.bossRoom].doors.every((id) => d.doorSealed(id));

    const first = L.rooms[window.__wt.order[0]];
    g.player.invuln = 30;   // the walkthrough is not a fairness test
    tp(first.centre.x, first.centre.z);
    step(3);
    out.triggered = dir.roomStates[first.id] === 1;
    step(40);   // ride out the 0.5 s seal grace
    out.combatState = dir.roomStates[first.id];
    out.doorsSealed = first.doors.every((id) => d.doorSealed(id));
    out.enemies = g.enemies.length;
    out.waveSize = g.gate.waveSize;
    out.budget = first.budget;
    out.spawned = g.spawned;
    out.allInRoom = g.enemies.every((e) => d.roomAt(e.pos.x, e.pos.z) === first.id);

    // Sealed-door crossing probe at the field level — the same resolve the
    // player's body runs. Drive from inside the room out through the door.
    const door = L.doors[first.doors[0]];
    const [tx, tz] = door.rot === 0 ? [0, 1] : [1, 0];
    const sgn = Math.sign((door.x - first.centre.x) * tx + (door.z - first.centre.z) * tz) || 1;
    const pos = { x: door.x - sgn * tx * 1.5, y: 0, z: door.z - sgn * tz * 1.5 };
    const vel = { x: 0, z: 0 };
    for (let s2 = 0; s2 < 60; s2++) {
      vel.x = sgn * tx * 4; vel.z = sgn * tz * 4;
      pos.x += vel.x * 0.05; pos.z += vel.z * 0.05;
      d.resolve(pos, 0.5, vel);
    }
    out.sealedHolds = ((pos.x - door.x) * tx + (pos.z - door.z) * tz) * sgn < -0.3;
    g.player.invuln = 0;    // the blink would hide the player in the shot
    g.renderer.render = origRender;
    return out;
  });
  check('W: director bound, rooms phase, boss chamber pre-sealed',
    w1.hasDirector && w1.phase === 'rooms' && w1.bossSealedAtStart && w1.combatRooms >= 3,
    `combatRooms=${w1.combatRooms}`);
  check('W: entry triggers the room, grace ends in COMBAT with doors sealed',
    w1.triggered && w1.combatState === 2 && w1.doorsSealed);
  check(`W: opening wave ${w1.enemies} = min(waveSize ${w1.waveSize}, budget ${w1.budget}), on this room's floor`,
    w1.enemies === Math.min(w1.waveSize, w1.budget) && w1.enemies === w1.spawned && w1.allInRoom);
  check('W: sealed membrane holds a driven body inside the room', w1.sealedHolds);

  await page.waitForTimeout(500);
  const shotSealed = shotPath('dungeon-e-combat-sealed.png');
  await page.screenshot({ path: shotSealed });
  report.screenshots.push(shotSealed);

  // W part 2: clear every combat room, verify metering + reopen + boss gate,
  // kill the boss, verify the exit portal rises and does NOT end the run, and
  // run the caster-behind-wall probe with a positive control.
  const w2 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const origRender = g.renderer.render.bind(g.renderer);
    const origDamage = g.fx.damageNumber.bind(g.fx);
    g.renderer.render = () => {};
    g.fx.damageNumber = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => { g.player.body.reset(x, 0, z); g.player.pos.set(x, 0, z); };
    const heal = () => { g.player.hp = g.derived.maxHp; g.player.invuln = 30; };
    const out = { rooms: [], problems: [] };
    const { order } = window.__wt;
    let maxConcurrent = 0;

    const clearActive = (roomId) => {
      let guard = 0;
      while (dir.roomStates[roomId] === 2 && guard++ < 200) {
        for (const e of [...g.enemies]) if (e.hp > 0) g._damageEnemy(e, 9e9);
        heal();
        step(80);   // 1.33 s — lets the 1.1 s trickle land, then dies next lap
        maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      }
      return guard < 200;
    };

    for (let i = 0; i < order.length; i++) {
      const roomId = order[i];
      const room = L.rooms[roomId];
      const killedBefore = g.killed;
      heal();
      tp(room.centre.x, room.centre.z);
      step(40);   // trigger + grace
      if (dir.roomStates[roomId] !== 2) { out.problems.push(`room ${roomId} state ${dir.roomStates[roomId]} not COMBAT`); break; }
      maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      if (!clearActive(roomId)) { out.problems.push(`room ${roomId} never cleared`); break; }
      // A door shared with the boss chamber is the boss GATE — it stays
      // sealed on clear until allCleared, so exclude it from "reopened".
      const bossDoorIds = L.rooms[L.bossRoom].doors;
      out.rooms.push({
        id: roomId,
        budget: room.budget,
        killedDelta: g.killed - killedBefore,
        cleared: dir.roomStates[roomId] === 3,
        doorsOpen: room.doors
          .filter((id2) => !bossDoorIds.includes(id2))
          .every((id2) => !d.doorSealed(id2)),
      });
      const bossSealed = L.rooms[L.bossRoom].doors.every((id2) => d.doorSealed(id2));
      if (i < order.length - 1 && !bossSealed) out.problems.push(`boss door open early, after room ${roomId}`);
      if (i === order.length - 1 && bossSealed) out.problems.push('boss door still sealed after allCleared');
    }
    out.maxConcurrent = maxConcurrent;
    out.waveSize = g.gate.waveSize;
    out.allCleared = dir.allCleared;
    out.killedTotal = g.killed;
    out.gateEnemies = g.gate.enemies;

    // Treasure room, when this seed rolled one: discovery pays a weapon.
    const treasure = L.rooms.find((r) => r.kind === 'treasure');
    if (treasure) {
      const pickBefore = g.pickups.filter((p) => p.kind === 'weapon').length;
      const stashBefore = g.stash.length;
      const weaponBefore = g.weapon;
      heal();
      tp(treasure.centre.x, treasure.centre.z);
      step(3);
      // The magnet can inhale the chest the same frame it spawns, so accept
      // any of: still on the floor, stashed, or auto-equipped.
      out.treasure = {
        cleared: dir.roomStates[treasure.id] === 3,
        weaponGained: g.pickups.filter((p) => p.kind === 'weapon').length > pickBefore
          || g.stash.length > stashBefore || g.weapon !== weaponBefore,
      };
    }

    // --- boss chamber ---
    const bossRoom = L.rooms[L.bossRoom];
    heal();
    tp(bossRoom.centre.x, bossRoom.centre.z);
    step(40);
    const anchor = d.bossSpawn();
    out.boss = {
      active: g.bossActive,
      phase: dir.state,
      doorsSealed: bossRoom.doors.every((id2) => d.doorSealed(id2)),
      nearAnchor: g.boss
        ? Math.hypot(g.boss.pos.x - anchor.x, g.boss.pos.z - anchor.z) < 2.5
        : false,
    };
    if (g.boss) { g.boss.spawning = 0; g._damageEnemy(g.boss, 9e9); }
    step(5);
    out.afterBoss = {
      bossActive: g.bossActive,
      phase: dir.state,
      stateStillPlaying: g.state === 'playing',
      portalExists: !!d._exitPortal,
      allDoorsOpen: L.doors.every((dr) => !d.doorSealed(dr.id)),
    };

    // The portal rises but must NOT clear the gate while the player is away.
    heal();
    step(200);   // 3.3 s >> the 2 s rise
    const pp = d._exitPortal ? d._exitPortal.position : { x: 0, z: 0 };
    out.portal = {
      risen: d._exitRise >= 1 && d._exitPortal.scale.x > 0.95,
      farFromPlayer: Math.hypot(g.player.pos.x - pp.x, g.player.pos.z - pp.z) > 1.6,
      stillPlaying: g.state === 'playing',
      pos: { x: +pp.x.toFixed(1), z: +pp.z.toFixed(1) },
    };

    // --- EDIT 4/5 probe: caster behind rock holds fire, nothing crosses ---
    // Pick an X lane on the first room's NORTH wall that is clear of every
    // door span, park the caster 2.5 m beyond it (solid rock/wall between)
    // and the player straight south of it inside the room — the vertical
    // line between them crosses the wall run and nothing else.
    const pr0 = L.rooms[order[0]];
    const northDoors = pr0.doors
      .map((id2) => L.doors[id2])
      .filter((dr) => dr.rot === 0 && Math.abs(dr.z - pr0.z) < 0.9);
    const clearOfDoors = (x) => northDoors.every((dr) => Math.abs(x - dr.x) > dr.w / 2 + 1.4);
    let cx = pr0.centre.x;
    for (const k of [0, 2, -2, 3, -3, 4, -4, 5, -5]) {
      const cand = pr0.centre.x + k;
      if (cand > pr0.x + 1.2 && cand < pr0.x + pr0.w - 1.2 && clearOfDoors(cand)) { cx = cand; break; }
    }
    const cz = pr0.z - 2.5;
    heal();
    // 5 m south of the north wall, NOT the room centre. Wave-3 rooms are 24 m+
    // deep, so centring the player put 16.5 m between them — past the caster's
    // engage range, which meant the probe was measuring "too far to care"
    // rather than "wall in the way". 5 m keeps the ~7.5 m separation this
    // probe has always tested, with the same single wall run between them.
    tp(cx, pr0.z + 5);
    // Stale bolts (a live boss volley would have expired by now, but be
    // airtight): the blocked assert is projectiles === 0 throughout.
    for (let i2 = g.projectiles.length - 1; i2 >= 0; i2--) g._removeProjectile(i2);
    g._spawnEnemy(g.player.pos.clone().set(cx, 0, cz), 'caster');
    const caster = g.enemies[g.enemies.length - 1];
    caster.spawning = 0;
    let projBlocked = 0;
    for (let s2 = 0; s2 < 260; s2++) {
      g.update(1 / 60);
      caster.pos.set(cx, 0, cz); caster.vel.set(0, 0, 0);   // pinned
      g.player.invuln = 5;
      projBlocked = Math.max(projBlocked, g.projectiles.length);
    }
    out.los = {
      blocked: caster.agent?.losBlocked === true,
      projectilesWhileBlocked: projBlocked,
      dist: +Math.hypot(cx - g.player.pos.x, cz - g.player.pos.z).toFixed(1),
    };
    // Positive control: same caster on a clear line INSIDE the room — proves
    // the probe would have caught a shot.
    const ox = cx;
    const oz = pr0.z + 1.5;
    caster.attackCd = 0.2;
    let projClear = 0;
    for (let s2 = 0; s2 < 260; s2++) {
      g.update(1 / 60);
      caster.pos.set(ox, 0, oz); caster.vel.set(0, 0, 0);
      g.player.invuln = 5;
      projClear = Math.max(projClear, g.projectiles.length);
    }
    out.losControl = {
      fired: projClear > 0,
      blocked: caster.agent?.losBlocked === true,
    };
    // Remove the probe caster WITHOUT crediting a kill (killed must stay at
    // the budget total for the results row).
    g.scene.remove(caster.mesh);
    g.scene.remove(caster.bar);
    caster.mesh.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      }
    });
    g.enemies.splice(g.enemies.indexOf(caster), 1);
    for (let i2 = g.projectiles.length - 1; i2 >= 0; i2--) g._removeProjectile(i2);

    // Park the player in the chamber for the portal screenshot, and flush the
    // toast backlog the compressed walkthrough queued up — thirty seconds of
    // run history stacked over one frame would bury the portal in the shot.
    g.player.invuln = 0;
    tp(bossRoom.centre.x, bossRoom.centre.z);
    document.querySelectorAll('#toasts > *').forEach((t) => t.remove());
    g.renderer.render = origRender;
    g.fx.damageNumber = origDamage;
    return out;
  });
  report.walkthrough = w2;
  check('W: every combat room cleared, doors reopened, kills = budgets',
    w2.problems.length === 0
    && w2.rooms.every((r) => r.cleared && r.doorsOpen && r.killedDelta === r.budget),
    w2.problems.join(' | ') || JSON.stringify(w2.rooms));
  check(`W: concurrent enemies never exceeded waveSize (${w2.maxConcurrent}/${w2.waveSize})`,
    w2.maxConcurrent > 0 && w2.maxConcurrent <= w2.waveSize);
  check(`W: allCleared with killed ${w2.killedTotal} = gate.enemies ${w2.gateEnemies}`,
    w2.allCleared && w2.killedTotal === w2.gateEnemies);
  if (w2.treasure) {
    check('W: treasure room paid out on discovery', w2.treasure.cleared && w2.treasure.weaponGained);
  }
  check('W: boss threshold seals the chamber and spawns the boss on its anchor',
    w2.boss.active && w2.boss.phase === 'boss' && w2.boss.doorsSealed && w2.boss.nearAnchor,
    JSON.stringify(w2.boss));
  check('W: boss death does NOT end the run — portal rises, membranes drop',
    !w2.afterBoss.bossActive && w2.afterBoss.phase === 'exit'
    && w2.afterBoss.stateStillPlaying && w2.afterBoss.portalExists && w2.afterBoss.allDoorsOpen,
    JSON.stringify(w2.afterBoss));
  check('W: risen portal does not clear the gate at a distance',
    w2.portal.risen && w2.portal.farFromPlayer && w2.portal.stillPlaying,
    JSON.stringify(w2.portal));
  check('W: caster behind a wall holds fire (EDIT 5) and no bolt crossed (EDIT 4)',
    w2.los.blocked && w2.los.projectilesWhileBlocked === 0, JSON.stringify(w2.los));
  check('W: positive control — the same caster fires with a clear line',
    w2.losControl.fired && w2.losControl.blocked === false, JSON.stringify(w2.losControl));

  await page.waitForTimeout(900);
  const shotPortal = shotPath('dungeon-e-exit-portal.png');
  await page.screenshot({ path: shotPortal });
  report.screenshots.push(shotPortal);

  // W part 3: the walk-in. Standing in the disc ends the run — results screen.
  const w3 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const pp = d._exitPortal.position;
    const before = g.state;
    g.player.body.reset(pp.x, 0, pp.z);
    g.player.pos.set(pp.x, 0, pp.z);
    const origRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = () => {};
    for (let i = 0; i < 5; i++) g.update(1 / 60);
    g.renderer.render = origRender;
    return {
      before,
      after: g.state,
      phase: dir.state,
      resultsShown: !document.getElementById('results').classList.contains('hidden'),
    };
  });
  report.walkIn = w3;
  check('W: walking into the portal clears the gate — results screen shows',
    w3.before === 'playing' && w3.after === 'over' && w3.phase === 'done' && w3.resultsShown,
    JSON.stringify(w3));

  await page.waitForTimeout(600);
  const shotResults = shotPath('dungeon-e-results.png');
  await page.screenshot({ path: shotResults });
  report.screenshots.push(shotResults);

  // ------------------------------------------------------------- phase X
  // STEP 8 walkthrough on a NATIVE C gate: zone aggro without door seals,
  // pursuit out of the trigger disc, the boss grotto membrane gating on
  // allCleared, the boss behind the resealed neck, and the walk-out.
  await page.evaluate(() => window.__app.go('title'));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const g = window.__game;
    g.save.level = 14;   // C requires 11; the walkthrough is about flow
    g.refreshDerived(true);
    g.enterGate('C');
  });
  await page.waitForFunction(
    () => window.__game?.mode?.name === 'dungeon' && window.__game.state === 'playing',
    null, { timeout: 15000 },
  );
  await page.waitForTimeout(350);
  const xswap = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    return {
      kind: d.kind,
      isModeDungeon: g.mode.dungeon === d,
      notArena: d !== g._arenaWorld,
      encounterDriven: d.encounterDriven === true,
      spawned: g.spawned,
      enemies: g.enemies.length,
      introActive: !!g.mode.intro,
      biome: g.gate?.biome,
      obstaclesBound: g.player.body.obstacles === d.obstacleField,
      bossSealed: d.layout
        ? d.layout.rooms[d.layout.bossRoom].doors.every((id) => d.doorSealed(id))
        : false,
      hasDirector: !!g.mode.director,
    };
  });
  check('X: C gate mounts the cavern natively',
    xswap.kind === 'cavern' && xswap.isModeDungeon && xswap.notArena && xswap.encounterDriven,
    JSON.stringify(xswap));
  check('X: zones dormant, intro running, director bound, boss neck pre-sealed',
    xswap.spawned === 0 && xswap.enemies === 0 && xswap.introActive
    && xswap.hasDirector && xswap.bossSealed && xswap.obstaclesBound);

  // The intro shot doubles as the cavern's player-visible entry evidence
  // (low camera looking down the tunnel at the crystal-lit chamber).
  await page.waitForTimeout(500);
  const shotCEntry = shotPath('dungeon-c-intro.png');
  await page.screenshot({ path: shotCEntry });
  report.screenshots.push(shotCEntry);

  // Skip the rest of the walk-in; the E phase already proved intro timing.
  await page.mouse.click(446, 206);
  await page.waitForFunction(() => !window.__game.mode.intro, null, { timeout: 4000 });
  await page.waitForTimeout(300);

  // X part 1: first zone — trigger, aggro without seals, pursuit.
  const x1 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const out = {};
    const origRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => { g.player.body.reset(x, 0, z); g.player.pos.set(x, 0, z); };

    const order = L.criticalPath.filter((id) => L.rooms[id].kind === 'combat');
    window.__xt = { order };
    out.zoneCount = order.length;

    const first = L.rooms[order[0]];
    g.player.invuln = 30;
    tp(first.centre.x, first.centre.z);
    step(3);
    out.triggered = dir.roomStates[first.id] === 1;
    step(40);   // ride out the grace
    out.combatState = dir.roomStates[first.id];
    // THE zone-mode assert: combat is live and NOT ONE membrane sealed except
    // the boss neck — nothing pens a cavern fight in.
    const bossDoorIds = L.rooms[L.bossRoom].doors;
    out.noSeals = L.doors.every((dr) => (
      bossDoorIds.includes(dr.id) ? d.doorSealed(dr.id) : !d.doorSealed(dr.id)
    ));
    out.enemies = g.enemies.length;
    out.expected = Math.min(g.gate.waveSize, first.budget);
    out.spawned = g.spawned;
    out.inZone = g.enemies.every((e) => (
      Math.hypot(e.pos.x - first.centre.x, e.pos.z - first.centre.z) <= first.radius + 1.5
    ));

    // Pursuit: the player retreats to the entry chamber mid-fight (guaranteed
    // floor, guaranteed nav-reachable); the pack must follow — aggro as one
    // group, and no membrane exists to hold them.
    const px = L.rooms[0].centre.x;
    const pz = L.rooms[0].centre.z;
    tp(px, pz);
    for (const e of g.enemies) e.spawning = 0;
    let before = Infinity;
    for (const e of g.enemies) {
      before = Math.min(before, Math.hypot(e.pos.x - px, e.pos.z - pz));
    }
    step(110);   // ~1.8 s of chase
    let after = Infinity;
    for (const e of g.enemies) {
      after = Math.min(after, Math.hypot(e.pos.x - g.player.pos.x, e.pos.z - g.player.pos.z));
    }
    out.pursuit = {
      before: +before.toFixed(1),
      after: +after.toFixed(1),
      stillCombat: dir.roomStates[first.id] === 2,
      enemiesAlive: g.enemies.length > 0,
    };
    g.player.invuln = 0;
    g.renderer.render = origRender;
    return out;
  });
  check(`X: zone triggers and fights in the open (${x1.zoneCount} zones)`,
    x1.triggered && x1.combatState === 2 && x1.zoneCount >= 4);
  check('X: NO doors seal for a zone fight (boss neck stays the only membrane)',
    x1.noSeals === true);
  check(`X: opening pack ${x1.enemies} = min(waveSize, budget ${x1.expected}), on the zone's floor`,
    x1.enemies === x1.expected && x1.enemies === x1.spawned && x1.inZone);
  check(`X: pack pursues out of the disc (${x1.pursuit.before} -> ${x1.pursuit.after} m)`,
    x1.pursuit.enemiesAlive && x1.pursuit.stillCombat
    && x1.pursuit.after < x1.pursuit.before - 1.0,
    JSON.stringify(x1.pursuit));

  await page.waitForTimeout(500);
  const shotCZone = shotPath('dungeon-c-zone-combat.png');
  await page.screenshot({ path: shotCZone });
  report.screenshots.push(shotCZone);

  // X part 2: neck holds, clear every zone, boss behind the resealed neck,
  // exit walk-out.
  const x2 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const origRender = g.renderer.render.bind(g.renderer);
    const origDamage = g.fx.damageNumber.bind(g.fx);
    g.renderer.render = () => {};
    g.fx.damageNumber = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => { g.player.body.reset(x, 0, z); g.player.pos.set(x, 0, z); };
    const heal = () => { g.player.hp = g.derived.maxHp; g.player.invuln = 30; };
    const out = { zones: [], problems: [] };
    const { order } = window.__xt;
    const bossRoom = L.rooms[L.bossRoom];
    const bossDoor = L.doors[bossRoom.doors[0]];

    // Sealed-neck crossing probe while zones remain: drive from the mass side
    // toward the grotto; the membrane must hold.
    const [ntx, ntz] = bossDoor.rot === 0 ? [0, 1] : [1, 0];
    const nsgn = Math.sign(
      (bossRoom.centre.x - bossDoor.x) * ntx + (bossRoom.centre.z - bossDoor.z) * ntz,
    ) || 1;
    {
      const pos = { x: bossDoor.x - nsgn * ntx * 1.5, y: 0, z: bossDoor.z - nsgn * ntz * 1.5 };
      const vel = { x: 0, z: 0 };
      for (let s2 = 0; s2 < 60; s2++) {
        vel.x = nsgn * ntx * 4; vel.z = nsgn * ntz * 4;
        pos.x += vel.x * 0.05; pos.z += vel.z * 0.05;
        d.resolve(pos, 0.5, vel);
      }
      out.neckHolds = ((pos.x - bossDoor.x) * ntx + (pos.z - bossDoor.z) * ntz) * nsgn < -0.3;
    }

    let maxConcurrent = 0;
    const clearActive = (roomId) => {
      let guard = 0;
      while (dir.roomStates[roomId] === 2 && guard++ < 200) {
        for (const e of [...g.enemies]) if (e.hp > 0) g._damageEnemy(e, 9e9);
        heal();
        step(80);
        maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      }
      return guard < 200;
    };
    for (let i = 0; i < order.length; i++) {
      const roomId = order[i];
      const room = L.rooms[roomId];
      heal();
      tp(room.centre.x, room.centre.z);
      step(40);
      if (dir.roomStates[roomId] !== 2 && dir.roomStates[roomId] !== 3) {
        out.problems.push(`zone ${roomId} state ${dir.roomStates[roomId]} after entry`);
        break;
      }
      maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      if (dir.roomStates[roomId] === 2 && !clearActive(roomId)) {
        out.problems.push(`zone ${roomId} never cleared`);
        break;
      }
      out.zones.push({ id: roomId, cleared: dir.roomStates[roomId] === 3 });
      const sealed = bossRoom.doors.every((id2) => d.doorSealed(id2));
      if (i < order.length - 1 && !sealed) out.problems.push(`boss neck open early after zone ${roomId}`);
      if (i === order.length - 1 && sealed) out.problems.push('boss neck still sealed after allCleared');
    }
    out.maxConcurrent = maxConcurrent;
    out.waveSize = g.gate.waveSize;
    out.allCleared = dir.allCleared;

    // Boss: cross into the grotto — the neck reseals behind, the boss rises
    // on its anchor, and death raises the exit portal instead of the results.
    heal();
    tp(bossRoom.centre.x, bossRoom.centre.z);
    step(40);
    const anchor = d.bossSpawn();
    out.boss = {
      active: g.bossActive,
      phase: dir.state,
      sealedBehind: bossRoom.doors.every((id2) => d.doorSealed(id2)),
      nearAnchor: g.boss
        ? Math.hypot(g.boss.pos.x - anchor.x, g.boss.pos.z - anchor.z) < 2.5
        : false,
    };
    if (g.boss) { g.boss.spawning = 0; g._damageEnemy(g.boss, 9e9); }
    step(5);
    out.afterBoss = {
      bossActive: g.bossActive,
      phase: dir.state,
      stillPlaying: g.state === 'playing',
      portalExists: !!d._exitPortal,
      allDoorsOpen: L.doors.every((dr) => !d.doorSealed(dr.id)),
    };
    heal();
    step(200);   // ride out the portal rise
    const pp = d._exitPortal ? d._exitPortal.position : { x: 0, z: 0 };
    g.player.invuln = 0;
    tp(pp.x, pp.z);
    for (let i2 = 0; i2 < 5; i2++) g.update(1 / 60);
    out.walkIn = {
      state: g.state,
      phase: dir.state,
      resultsShown: !document.getElementById('results').classList.contains('hidden'),
    };
    document.querySelectorAll('#toasts > *').forEach((t) => t.remove());
    g.renderer.render = origRender;
    g.fx.damageNumber = origDamage;
    return out;
  });
  report.cavernWalkthrough = x2;
  check('X: sealed neck holds a driven body out of the grotto', x2.neckHolds === true);
  check('X: every zone cleared; boss neck gated on allCleared',
    x2.problems.length === 0 && x2.zones.every((z) => z.cleared) && x2.allCleared,
    x2.problems.join(' | ') || JSON.stringify(x2.zones));
  check(`X: concurrent enemies never exceeded waveSize (${x2.maxConcurrent}/${x2.waveSize})`,
    x2.maxConcurrent > 0 && x2.maxConcurrent <= x2.waveSize);
  check('X: boss threshold reseals the neck and spawns the boss on its anchor',
    x2.boss.active && x2.boss.phase === 'boss' && x2.boss.sealedBehind && x2.boss.nearAnchor,
    JSON.stringify(x2.boss));
  check('X: boss death raises the portal, run ends on the walk-in',
    !x2.afterBoss.bossActive && x2.afterBoss.phase === 'exit' && x2.afterBoss.stillPlaying
    && x2.afterBoss.portalExists && x2.afterBoss.allDoorsOpen
    && x2.walkIn.state === 'over' && x2.walkIn.phase === 'done' && x2.walkIn.resultsShown,
    JSON.stringify({ afterBoss: x2.afterBoss, walkIn: x2.walkIn }));

  await page.waitForTimeout(600);
  const shotCResults = shotPath('dungeon-c-results.png');
  await page.screenshot({ path: shotCResults });
  report.screenshots.push(shotCResults);

  // ------------------------------------------------------------- phase Y
  // Wave E task E-A walkthrough on a NATIVE A gate: the compass gate holds
  // (site 2 and the boss refuse to trigger early with no membranes anywhere
  // to do the holding), roaming packs rise on the route legs and are metered
  // against their site's own budget, sites clear in order, the boss rises at
  // the final open site, and the run ends on the exit-portal walk-in.
  await page.evaluate(() => window.__app.go('title'));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const g = window.__game;
    g.save.level = 40;   // A requires 29; the walkthrough is about flow
    g.refreshDerived(true);
    g.enterGate('A');
  });
  await page.waitForFunction(
    () => window.__game?.mode?.name === 'dungeon' && window.__game.state === 'playing',
    null, { timeout: 15000 },
  );
  await page.waitForTimeout(350);
  const yswap = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    return {
      kind: d.kind,
      isModeDungeon: g.mode.dungeon === d,
      notArena: d !== g._arenaWorld,
      encounterDriven: d.encounterDriven === true,
      spawned: g.spawned,
      enemies: g.enemies.length,
      introActive: !!g.mode.intro,
      hasDirector: !!g.mode.director,
      hasRoute: Array.isArray(d.layout?.route) && d.layout.route.length === 3,
      heightBound: typeof d.layout?.heightAt === 'function',
      obstaclesBound: g.player.body.obstacles === d.obstacleField,
      beaconAtFirstSite: d._waypointBeacon ? d._waypointRoom === d.layout.route[0] : false,
    };
  });
  check('Y: A gate mounts the waste natively',
    yswap.kind === 'waste' && yswap.isModeDungeon && yswap.notArena && yswap.encounterDriven,
    JSON.stringify(yswap));
  check('Y: field dormant through the intro, director + route + compass bound',
    yswap.spawned === 0 && yswap.enemies === 0 && yswap.introActive
    && yswap.hasDirector && yswap.hasRoute && yswap.heightBound
    && yswap.obstaclesBound && yswap.beaconAtFirstSite);

  await page.waitForTimeout(500);
  const shotAEntry = shotPath('dungeon-a-intro.png');
  await page.screenshot({ path: shotAEntry });
  report.screenshots.push(shotAEntry);

  // Skip the walk-in; the E phase owns intro timing.
  await page.mouse.click(446, 206);
  await page.waitForFunction(() => !window.__game.mode.intro, null, { timeout: 4000 });
  await page.waitForTimeout(300);

  // Y part 1: first-leg roamers + the compass gate.
  const y1 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const out = {};
    const origRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => {
      const y = d.heightAt(x, z);
      g.player.body.reset(x, y, z);
      g.player.pos.set(x, y, z);
    };
    g.player.invuln = 30;

    // First live tick primed the first leg's roaming pack — on its own
    // roamPoints, spent from site 1's budget.
    step(3);
    const s1 = L.rooms[L.route[0]];
    out.roam = {
      expected: Math.min(s1.roam, s1.budget),
      spawned: g.spawned,
      enemies: g.enemies.length,
      onPoints: g.enemies.every((e) => (s1.roamPoints || []).some((p) => (
        Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 2.5
      ))),
    };

    // THE compass gate: standing in site 2's disc (or the boss's) does
    // NOTHING while site 1 is uncleared — there is no membrane to do the
    // holding, the director's route order IS the seal.
    const s2 = L.rooms[L.route[1]];
    tp(s2.centre.x, s2.centre.z);
    step(45);   // longer than the trigger grace
    out.gate = { site2State: dir.roomStates[s2.id], site2Spawns: g.spawned };
    const boss = L.rooms[L.bossRoom];
    tp(boss.centre.x, boss.centre.z);
    step(45);
    out.gate.bossState = dir.roomStates[boss.id];
    out.gate.bossActive = g.bossActive;

    // Site 1 triggers when the compass says so.
    tp(s1.centre.x, s1.centre.z);
    step(3);
    out.triggered = dir.roomStates[s1.id] === 1;
    step(45);
    out.combatState = dir.roomStates[s1.id];
    out.concurrent = g.enemies.length;
    out.waveSize = g.gate.waveSize;
    g.renderer.render = origRender;
    return out;
  });
  check(`Y: first-leg roaming pack rises on its route points (${y1.roam.enemies}/${y1.roam.expected})`,
    y1.roam.enemies === y1.roam.expected && y1.roam.enemies > 0
    && y1.roam.spawned === y1.roam.expected && y1.roam.onPoints,
    JSON.stringify(y1.roam));
  check('Y: compass gate — site 2 and the boss stay dormant underfoot until their turn',
    y1.gate.site2State === 0 && y1.gate.bossState === 0 && !y1.gate.bossActive
    && y1.gate.site2Spawns === y1.roam.spawned,
    JSON.stringify(y1.gate));
  check(`Y: site 1 triggers on entry and fights in the open (${y1.concurrent} live <= wave ${y1.waveSize})`,
    y1.triggered && y1.combatState === 2 && y1.concurrent > 0 && y1.concurrent <= y1.waveSize);

  await page.waitForTimeout(400);
  const shotASite = shotPath('dungeon-a-site-combat.png');
  await page.screenshot({ path: shotASite });
  report.screenshots.push(shotASite);

  // Y part 2: clear the route in order, boss at the final site, walk out.
  const y2 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const origRender = g.renderer.render.bind(g.renderer);
    const origDamage = g.fx.damageNumber.bind(g.fx);
    g.renderer.render = () => {};
    g.fx.damageNumber = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => {
      const y = d.heightAt(x, z);
      g.player.body.reset(x, y, z);
      g.player.pos.set(x, y, z);
    };
    const heal = () => { g.player.hp = g.derived.maxHp; g.player.invuln = 30; };
    const out = { sites: [], problems: [] };
    let maxConcurrent = 0;
    const clearActive = (roomId) => {
      let guard = 0;
      while (dir.roomStates[roomId] === 2 && guard++ < 200) {
        for (const e of [...g.enemies]) if (e.hp > 0) g._damageEnemy(e, 9e9);
        heal();
        step(80);
        maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      }
      return guard < 200;
    };
    for (let i = 0; i < L.route.length; i++) {
      const roomId = L.route[i];
      const room = L.rooms[roomId];
      heal();
      // Kill any live roamers of THIS site on the way in so the trigger's
      // opening wave arithmetic is exercised too, then enter.
      tp(room.centre.x, room.centre.z);
      step(45);
      if (dir.roomStates[roomId] !== 2 && dir.roomStates[roomId] !== 3) {
        out.problems.push(`site ${roomId} state ${dir.roomStates[roomId]} after entry`);
        break;
      }
      maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      if (dir.roomStates[roomId] === 2 && !clearActive(roomId)) {
        out.problems.push(`site ${roomId} never cleared`);
        break;
      }
      const rec = { id: roomId, cleared: dir.roomStates[roomId] === 3 };
      // The compass advanced: beacon on the next stop, next leg's roamers up.
      if (i < L.route.length - 1) {
        rec.beaconNext = d._waypointRoom === L.route[i + 1];
        rec.roamersUp = g.enemies.length > 0;
      } else {
        rec.beaconBoss = d._waypointRoom === L.bossRoom;
      }
      out.sites.push(rec);
    }
    out.allCleared = dir.allCleared;
    out.maxConcurrent = maxConcurrent;
    out.waveSize = g.gate.waveSize;

    // Boss: enter the final site — rises on its anchor, at terrain height.
    heal();
    const bossRoom = L.rooms[L.bossRoom];
    tp(bossRoom.centre.x, bossRoom.centre.z);
    step(45);
    const anchor = d.bossSpawn();
    out.boss = {
      active: g.bossActive,
      phase: dir.state,
      nearAnchor: g.boss
        ? Math.hypot(g.boss.pos.x - anchor.x, g.boss.pos.z - anchor.z) < 2.5
        : false,
      beaconDown: !d._waypointBeacon?.visible,
    };
    if (g.boss) { g.boss.spawning = 0; g._damageEnemy(g.boss, 9e9); }
    step(5);
    out.afterBoss = {
      bossActive: g.bossActive,
      phase: dir.state,
      stillPlaying: g.state === 'playing',
      portalExists: !!d._exitPortal,
    };
    heal();
    step(200);   // portal rise
    const pp = d._exitPortal ? d._exitPortal.position : { x: 0, z: 0 };
    g.player.invuln = 0;
    tp(pp.x, pp.z);
    for (let i2 = 0; i2 < 5; i2++) g.update(1 / 60);
    out.walkIn = {
      state: g.state,
      phase: dir.state,
      resultsShown: !document.getElementById('results').classList.contains('hidden'),
    };
    document.querySelectorAll('#toasts > *').forEach((t) => t.remove());
    g.renderer.render = origRender;
    g.fx.damageNumber = origDamage;
    return out;
  });
  report.wasteWalkthrough = y2;
  check('Y: sites clear in route order; compass advances (beacon + next-leg roamers)',
    y2.problems.length === 0 && y2.sites.length === 3 && y2.sites.every((s) => s.cleared)
    && y2.sites[0].beaconNext && y2.sites[1].beaconNext && y2.sites[2].beaconBoss
    && y2.allCleared,
    y2.problems.join(' | ') || JSON.stringify(y2.sites));
  check(`Y: concurrent enemies never exceeded waveSize (${y2.maxConcurrent}/${y2.waveSize})`,
    y2.maxConcurrent > 0 && y2.maxConcurrent <= y2.waveSize);
  check('Y: boss rises at the final open site on its anchor; compass stands down',
    y2.boss.active && y2.boss.phase === 'boss' && y2.boss.nearAnchor && y2.boss.beaconDown,
    JSON.stringify(y2.boss));
  check('Y: boss death raises the portal behind the site; run ends on the walk-in',
    !y2.afterBoss.bossActive && y2.afterBoss.phase === 'exit' && y2.afterBoss.stillPlaying
    && y2.afterBoss.portalExists
    && y2.walkIn.state === 'over' && y2.walkIn.phase === 'done' && y2.walkIn.resultsShown,
    JSON.stringify({ afterBoss: y2.afterBoss, walkIn: y2.walkIn }));

  await page.waitForTimeout(600);
  const shotAResults = shotPath('dungeon-a-results.png');
  await page.screenshot({ path: shotAResults });
  report.screenshots.push(shotAResults);

  // ------------------------------------------------------------- phase Z
  // Wave E task E-S walkthrough on a NATIVE S gate: ARCHON'S REACH mounts the
  // reach kind (broken causeway, two gauntlets, the collapsing summit).
  // Claims: the swap facts + heightAt + arenaPhases data are live; the
  // gauntlets seal and clear with the crawl's exact machinery; the summit
  // seals, the boss rises on its anchor, and the COLLAPSE SEAM fires — each
  // hp threshold seals its ring (probed at the collision field, the same
  // resolve the player's body runs) and pulls stranded bodies inside; the
  // rings retract on the boss's death; the exit portal rises inside the full
  // disc and the run ends on the walk-in.
  await page.evaluate(() => window.__app.go('title'));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const g = window.__game;
    g.save.level = 55;   // S requires 42; the walkthrough is about flow
    g.refreshDerived(true);
    // PIN THE KIND (review fix): ANOMALY_CHANCE.S = 0.26 let the anomaly
    // roll swap the S mount to another kind on ~1 run in 4 — phase Z's
    // arenaPhases asserts then dereferenced undefined and the suite was
    // nondeterministically red. Zeroing the chance in-page pins the reach.
    window.__dt.ANOMALY_CHANCE.S = 0;
    g.enterGate('S');
  });
  await page.waitForFunction(
    () => window.__game?.mode?.name === 'dungeon' && window.__game.state === 'playing',
    null, { timeout: 15000 },
  );
  await page.waitForTimeout(350);
  const zswap = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const ph = d.layout?.arenaPhases;
    return {
      kind: d.kind,
      isModeDungeon: g.mode.dungeon === d,
      notArena: d !== g._arenaWorld,
      encounterDriven: d.encounterDriven === true,
      spawned: g.spawned,
      enemies: g.enemies.length,
      introActive: !!g.mode.intro,
      hasDirector: !!g.mode.director,
      heightBound: typeof d.layout?.heightAt === 'function',
      summitHigh: d.layout ? d.layout.rooms[d.layout.bossRoom].floorY > 10 : false,
      obstaclesBound: g.player.body.obstacles === d.obstacleField,
      phases: ph ? { radii: ph.radii, thresholds: ph.thresholds } : null,
      arenaPhase: d.arenaPhase,
      ringsPrebuilt: Array.isArray(d._arenaRings) && d._arenaRings.length === (ph ? ph.radii.length - 1 : -1),
    };
  });
  check('Z: S gate mounts the reach natively',
    zswap.kind === 'reach' && zswap.isModeDungeon && zswap.notArena && zswap.encounterDriven,
    JSON.stringify(zswap));
  check('Z: dormant through the intro; heightAt + arenaPhases + rings pre-built',
    zswap.spawned === 0 && zswap.enemies === 0 && zswap.introActive
    && zswap.hasDirector && zswap.heightBound && zswap.summitHigh
    && zswap.obstaclesBound && !!zswap.phases && zswap.arenaPhase === 0 && zswap.ringsPrebuilt,
    JSON.stringify(zswap));

  await page.waitForTimeout(400);
  const shotSIntro = shotPath('dungeon-s-intro.png');
  await page.screenshot({ path: shotSIntro });
  report.screenshots.push(shotSIntro);

  // Skip the walk-in; the E phase owns intro timing.
  await page.mouse.click(446, 206);
  await page.waitForFunction(() => !window.__game.mode.intro, null, { timeout: 4000 });
  await page.waitForTimeout(300);

  // Budget guard (spec performance): standalone probes measured the reach
  // shell at 24 colour draws / 28 whole-frame / 90-97k tris over 4 seeds
  // (2026-08-25, city hidden, shadow fitted to the summit). This live-gate
  // measurement also carries the player + shadow escort, so the ceilings sit
  // a band above the shell numbers — a REGRESSION GUARD in D's "measured
  // ceiling" stance, not an endorsement of growth.
  const zbudget = await page.evaluate(() => {
    const g = window.__game;
    const r = g.renderer;
    r.info.autoReset = false;
    r.info.reset();
    r.render(g.scene, g.camera);
    const frame = { calls: r.info.render.calls, tris: r.info.render.triangles };
    r.info.autoReset = true;
    r.render(g.scene, g.camera);
    return { frame, colour: { calls: r.info.render.calls, tris: r.info.render.triangles } };
  });
  report.reachBudget = zbudget;
  check(`Z: reach budget — colour ${zbudget.colour.calls} draws / ${zbudget.colour.tris} tris, `
    + `frame ${zbudget.frame.calls} / ${zbudget.frame.tris}`,
  zbudget.colour.calls <= FRAME_BUDGET.S.draws + 4 && zbudget.frame.calls <= FRAME_BUDGET.S.draws + 14
    && zbudget.colour.tris <= FRAME_BUDGET.S.tris + 10000 && zbudget.frame.tris <= FRAME_BUDGET.S.tris + 60000,
  JSON.stringify(zbudget));

  // Z part 1: the gauntlets — the crawl's seal machinery at height.
  const z1 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const out = { gauntlets: [], problems: [] };
    const origRender = g.renderer.render.bind(g.renderer);
    const origDamage = g.fx.damageNumber.bind(g.fx);
    g.renderer.render = () => {};
    g.fx.damageNumber = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => {
      const y = d.heightAt(x, z);
      g.player.body.reset(x, y, z);
      g.player.pos.set(x, y, z);
    };
    const heal = () => { g.player.hp = g.derived.maxHp; g.player.invuln = 30; };
    out.bossSealedAtStart = L.rooms[L.bossRoom].doors.every((id) => d.doorSealed(id));
    let maxConcurrent = 0;
    const clearActive = (roomId) => {
      let guard = 0;
      while (dir.roomStates[roomId] === 2 && guard++ < 200) {
        for (const e of [...g.enemies]) if (e.hp > 0) g._damageEnemy(e, 9e9);
        heal();
        step(80);
        maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      }
      return guard < 200;
    };
    const order = L.criticalPath.filter((id) => L.rooms[id].kind === 'combat');
    for (const roomId of order) {
      const room = L.rooms[roomId];
      heal();
      tp(room.centre.x, room.centre.z);
      step(40);   // trigger + grace
      if (dir.roomStates[roomId] !== 2) {
        out.problems.push(`gauntlet ${roomId} state ${dir.roomStates[roomId]} not COMBAT`);
        break;
      }
      const sealed = room.doors.every((id2) => d.doorSealed(id2));
      const atHeight = g.enemies.every((e) => Math.abs(e.pos.y - room.floorY) < 1.2);
      maxConcurrent = Math.max(maxConcurrent, g.enemies.length);
      if (!clearActive(roomId)) { out.problems.push(`gauntlet ${roomId} never cleared`); break; }
      out.gauntlets.push({
        id: roomId,
        sealed,
        atHeight,
        cleared: dir.roomStates[roomId] === 3,
      });
    }
    out.maxConcurrent = maxConcurrent;
    out.waveSize = g.gate.waveSize;
    out.allCleared = dir.allCleared;
    out.bossOpenAfter = !L.rooms[L.bossRoom].doors.every((id) => d.doorSealed(id));
    g.renderer.render = origRender;
    g.fx.damageNumber = origDamage;
    return out;
  });
  check('Z: both gauntlets seal on entry (crawl vocabulary), fight at their floor height, and clear',
    z1.problems.length === 0 && z1.gauntlets.length === 2 && z1.bossSealedAtStart
    && z1.gauntlets.every((s) => s.sealed && s.atHeight && s.cleared)
    && z1.allCleared && z1.bossOpenAfter,
    z1.problems.join(' | ') || JSON.stringify(z1.gauntlets));
  check(`Z: concurrent enemies never exceeded waveSize (${z1.maxConcurrent}/${z1.waveSize})`,
    z1.maxConcurrent > 0 && z1.maxConcurrent <= z1.waveSize);

  await page.waitForTimeout(400);
  const shotSGauntlet = shotPath('dungeon-s-gauntlet.png');
  await page.screenshot({ path: shotSGauntlet });
  report.screenshots.push(shotSGauntlet);

  // Z part 2: the summit — boss, collapse phases, retraction, walk-out.
  const z2 = await page.evaluate(() => {
    const g = window.__game;
    const d = g.world;
    const dir = g.mode.director;
    const L = d.layout;
    const ph = L.arenaPhases;
    if (!ph) throw new Error('Z: no arenaPhases — S mounted a non-reach kind (anomaly not pinned?)');
    const origRender = g.renderer.render.bind(g.renderer);
    const origDamage = g.fx.damageNumber.bind(g.fx);
    g.renderer.render = () => {};
    g.fx.damageNumber = () => {};
    const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 60); };
    const tp = (x, z) => {
      const y = d.heightAt(x, z);
      g.player.body.reset(x, y, z);
      g.player.pos.set(x, y, z);
    };
    const heal = () => { g.player.hp = g.derived.maxHp; g.player.invuln = 30; };
    const out = {};
    const bossRoom = L.rooms[L.bossRoom];
    heal();
    tp(bossRoom.centre.x, bossRoom.centre.z);
    step(40);
    const anchor = d.bossSpawn();
    out.boss = {
      active: g.bossActive,
      phase: dir.state,
      doorsSealed: bossRoom.doors.every((id2) => d.doorSealed(id2)),
      nearAnchor: g.boss
        ? Math.hypot(g.boss.pos.x - anchor.x, g.boss.pos.z - anchor.z) < 2.5
        : false,
      anchorInDisc: Math.hypot(anchor.x - ph.cx, anchor.z - ph.cz) <= ph.radii[0],
    };
    if (g.boss) g.boss.spawning = 0;

    // A driven-body probe against a phase ring at radius R: park just inside,
    // drive straight out for 1 s of resolve steps, and report how far past R
    // it got. Same d.resolve the player's body runs.
    const ringHolds = (R) => {
      const pos = { x: ph.cx + R - 1.5, y: ph.y, z: ph.cz };
      const vel = { x: 4, y: 0, z: 0 };
      for (let s2 = 0; s2 < 60; s2++) {
        vel.x = 4; vel.z = 0;
        pos.x += vel.x * 0.05;
        d.resolve(pos, 0.5, vel);
      }
      return (pos.x - ph.cx) < R + 0.3;
    };
    out.ringOpenAtFull = !ringHolds(ph.radii[1]);   // phase 0: barrier down

    // Phase 1: cross the first hp threshold; park the player OUTSIDE the new
    // radius first so the pull-inside rescue is exercised too.
    heal();
    tp(ph.cx + ph.radii[1] + 2.5, ph.cz);
    if (g.boss) g.boss.hp = g.boss.maxHp * (ph.thresholds[0] - 0.02);
    step(3);
    out.phase1 = {
      arenaPhase: d.arenaPhase,
      dirPhase: dir._arenaPhase,
      ringHolds: ringHolds(ph.radii[1]),
      playerPulledIn: Math.hypot(g.player.pos.x - ph.cx, g.player.pos.z - ph.cz) <= ph.radii[1],
      enemiesInside: g.enemies.every((e) => (
        Math.hypot(e.pos.x - ph.cx, e.pos.z - ph.cz) <= ph.radii[1] + 0.5
      )),
    };
    // Phase 2: the last threshold.
    if (g.boss) g.boss.hp = g.boss.maxHp * (ph.thresholds[1] - 0.02);
    step(3);
    out.phase2 = {
      arenaPhase: d.arenaPhase,
      ringHolds: ringHolds(ph.radii[2]),
    };

    // Kill: rings retract with their maker; portal rises inside the disc.
    heal();
    if (g.boss) g._damageEnemy(g.boss, 9e9);
    step(5);
    out.afterBoss = {
      bossActive: g.bossActive,
      phase: dir.state,
      stillPlaying: g.state === 'playing',
      portalExists: !!d._exitPortal,
      arenaPhase: d.arenaPhase,
      ringsRetracted: !ringHolds(ph.radii[2]) && !ringHolds(ph.radii[1]),
    };
    heal();
    step(200);   // portal rise
    const pp = d._exitPortal ? d._exitPortal.position : { x: 0, z: 0 };
    out.portalInDisc = Math.hypot(pp.x - ph.cx, pp.z - ph.cz) <= ph.radii[0];
    g.player.invuln = 0;
    tp(pp.x, pp.z);
    for (let i2 = 0; i2 < 5; i2++) g.update(1 / 60);
    out.walkIn = {
      state: g.state,
      phase: dir.state,
      resultsShown: !document.getElementById('results').classList.contains('hidden'),
    };
    document.querySelectorAll('#toasts > *').forEach((t2) => t2.remove());
    g.renderer.render = origRender;
    g.fx.damageNumber = origDamage;
    return out;
  });
  report.reachWalkthrough = z2;
  check('Z: boss threshold seals the summit and the RIFT ARCHON rises on its anchor, inside the disc',
    z2.boss.active && z2.boss.phase === 'boss' && z2.boss.doorsSealed
    && z2.boss.nearAnchor && z2.boss.anchorInDisc,
    JSON.stringify(z2.boss));
  check('Z: collapse ring 1 — open at full hp, sealed past the first threshold, bodies pulled inside',
    z2.ringOpenAtFull && z2.phase1.arenaPhase === 1 && z2.phase1.dirPhase === 1
    && z2.phase1.ringHolds && z2.phase1.playerPulledIn && z2.phase1.enemiesInside,
    JSON.stringify(z2.phase1));
  check('Z: collapse ring 2 seals past the last threshold',
    z2.phase2.arenaPhase === 2 && z2.phase2.ringHolds, JSON.stringify(z2.phase2));
  check('Z: rings retract on the boss\'s death; portal rises inside the disc; run ends on the walk-in',
    !z2.afterBoss.bossActive && z2.afterBoss.phase === 'exit' && z2.afterBoss.stillPlaying
    && z2.afterBoss.portalExists && z2.afterBoss.arenaPhase === 0 && z2.afterBoss.ringsRetracted
    && z2.portalInDisc
    && z2.walkIn.state === 'over' && z2.walkIn.phase === 'done' && z2.walkIn.resultsShown,
    JSON.stringify({ afterBoss: z2.afterBoss, portalInDisc: z2.portalInDisc, walkIn: z2.walkIn }));

  await page.waitForTimeout(600);
  const shotSResults = shotPath('dungeon-s-results.png');
  await page.screenshot({ path: shotSResults });
  report.screenshots.push(shotSResults);

  // ------------------------------------------------------------- phase C
  // regression_arena (spec testStrategy): the arena path must stay untouched
  // by every seam edit — same world object, wave-driven spawns, kill-tail
  // refill still live. forceBiome pins the palette so the shot is diffable
  // run to run. RETARGETED B -> A -> S as each rank gained its interior, and
  // now (Wave E task E-S: S mounts the reach, phase Z owns it) NO rank is
  // canonically open — the regression rides the forceOpen dev override,
  // which is exactly the path every pre-crawl tool leans on and therefore
  // exactly the path this phase exists to keep honest.
  await page.evaluate(() => window.__app.go('title'));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const g = window.__game;
    g.save.level = 55;   // S requires 42; the regression is about flow, not fairness
    g.refreshDerived(true);
    g.enterGate('S', { forceOpen: true, forceBiome: 'archonreach' });
  });
  await page.waitForFunction(
    () => window.__game?.mode?.name === 'dungeon' && window.__game.state === 'playing',
    null, { timeout: 15000 },
  );
  await page.waitForTimeout(1200);
  const shotA = shotPath('dungeon-regression-s-arena.png');
  await page.screenshot({ path: shotA });
  report.screenshots.push(shotA);

  const reg = await page.evaluate(() => {
    const g = window.__game;
    const out = {
      isArena: g.world === g._arenaWorld,
      kind: g.world.kind ?? null,
      encounterDriven: Boolean(g.world.encounterDriven),
      biome: g.gate?.biome,
      spawnedAtEntry: g.spawned,
      waveSize: g.gate?.waveSize,
    };
    // Wave driver still owns spawns: kill the opening wave and step the sim;
    // the kill-tail (EDIT 1(c) arena branch) must refill through spawnTimer.
    const origRender = g.renderer.render;
    const origDmg = g.fx.damageNumber;
    g.renderer.render = () => {};
    g.fx.damageNumber = () => {};
    for (const e of [...g.enemies]) if (e.hp > 0) g._damageEnemy(e, 99999);
    let steps = 0;
    while (g.spawned <= out.spawnedAtEntry && steps < 600) { g.update(1 / 60); steps++; }
    out.spawnedAfter = g.spawned;
    out.steps = steps;
    g.renderer.render = origRender;
    g.fx.damageNumber = origDmg;
    return out;
  });
  report.regressionArena = reg;
  check('C: forceOpen S mounts the arena world (kind undefined, not encounter-driven)',
    reg.isArena && reg.kind === null && !reg.encounterDriven, JSON.stringify(reg));
  check('C: forceBiome rode the AppState payload', reg.biome === 'archonreach', String(reg.biome));
  check('C: opening wave fired inline (arena path unchanged)',
    reg.spawnedAtEntry === reg.waveSize, `spawned ${reg.spawnedAtEntry} of wave ${reg.waveSize}`);
  check('C: wave timer still drives spawns without a director',
    reg.spawnedAfter > reg.spawnedAtEntry, `${reg.spawnedAtEntry} -> ${reg.spawnedAfter} in ${reg.steps} steps`);

  // The dev override: E pinned open mounts the arena — every pre-crawl tool
  // (smoke, acceptance, loot, visual...) leans on this exact path.
  await page.evaluate(() => window.__app.go('title'));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__game.enterGate('E', { forceOpen: true, forceBiome: 'deepglass' }));
  await page.waitForFunction(
    () => window.__game?.mode?.name === 'dungeon' && window.__game.state === 'playing',
    null, { timeout: 15000 },
  );
  const forced = await page.evaluate(() => {
    const g = window.__game;
    return {
      isArena: g.world === g._arenaWorld,
      biome: g.gate?.biome,
      spawned: g.spawned,
    };
  });
  check('C: forceOpen pins the arena for E (old tools\' escape hatch)',
    forced.isArena && forced.spawned > 0, JSON.stringify(forced));
  check('C: forceBiome override applies with forceOpen', forced.biome === 'deepglass', String(forced.biome));

  const pageErrors = errors.filter((e) => !/ResizeObserver/.test(e));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  report.fails = fails;
  const reportFile = writeReport('dungeon-test-report.json', report);
  console.log(`\nreport: ${reportFile}\nshots:  ${OUT}`);
} finally {
  await browser.close();
  await server.stop();
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED:\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('\nALL PASS');
