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
//   C. regression_arena: a B-rank run must still be the arena, wave-driven,
//      byte-identical in flow; and the forceOpen dev override must pin the
//      arena for E (every older tool depends on it).
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

const SEEDS = { E: 90210, D: 40417, C: 51877 };
const DRAW_BUDGET = 24;       // spec performance.drawCallBudget, E/D interior
const DRAW_BUDGET_CAVERN = 30;  // C adds dome, stalagmite/stalactite fields, crystals
const TRI_BUDGET_KIT = 130000;  // spec performance.triangleBudget, kit loaded
const TRI_BUDGET_PROC = 45000;  // procedural-only bound (fallback phase F)

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);

try {
  await gotoGame(page);

  // Prime the modules once; vite serves /src straight to the page.
  await page.evaluate(async () => {
    const [{ Dungeon }, cfg] = await Promise.all([
      import('/src/world/dungeon.js'),
      import('/src/game/config.js'),
    ]);
    window.__dt = { Dungeon, GATES: cfg.GATES };
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
      const frame = () => {
        r.render(g.scene, g.camera);
        return { calls: r.info.render.calls, tris: r.info.render.triangles };
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

      const d = new Dungeon(g.scene, g.renderer, g.camera);
      d.build(gate, seed);
      const built = frame();
      out.drawCalls = built.calls - base.calls;
      out.triangles = built.tris - base.tris;

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

      // bossSpawn inside the boss room, roomAt agreeing everywhere.
      const bs = d.bossSpawn();
      out.boss = {
        inBossRoom: d.roomAt(bs.x, bs.z) === L.bossRoom,
        spawnPoints: d.spawnPointsFor(L.bossRoom).length,
      };
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
    check(`${rank}: bossSpawn in boss room (${res.boss.spawnPoints} pts)`, res.boss.inBossRoom && res.boss.spawnPoints >= 4);
    check(`${rank}: roomAt agrees`, res.roomAt.centresAgree && res.roomAt.tunnelIsNoRoom);
    check(`${rank}: nav flow reaches boss room`, res.nav.goalSet && res.nav.bossReaches);
    check(`${rank}: no GPU leak (geo ${res.leak.geoBefore}->${res.leak.geoAfter}, tex ${res.leak.texBefore}->${res.leak.texAfter})`,
      res.leak.geoAfter <= res.leak.geoBefore + 2 && res.leak.texAfter <= res.leak.texBefore + 2);
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
    tp(cx, pr0.centre.z);
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

  // ------------------------------------------------------------- phase C
  // regression_arena (spec testStrategy): a B-rank run must be the arena,
  // untouched by every seam edit — same world object, wave-driven spawns,
  // kill-tail refill still live. forceBiome pins the palette so the shot is
  // diffable run to run.
  await page.evaluate(() => window.__app.go('title'));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const g = window.__game;
    g.save.level = 40;   // B requires 19; the regression is about flow, not fairness
    g.refreshDerived(true);
    g.enterGate('B', { forceBiome: 'emberfall' });
  });
  await page.waitForFunction(
    () => window.__game?.mode?.name === 'dungeon' && window.__game.state === 'playing',
    null, { timeout: 15000 },
  );
  await page.waitForTimeout(1200);
  const shotB = shotPath('dungeon-regression-b-arena.png');
  await page.screenshot({ path: shotB });
  report.screenshots.push(shotB);

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
  check('C: B rank mounts the arena world (kind undefined, not encounter-driven)',
    reg.isArena && reg.kind === null && !reg.encounterDriven, JSON.stringify(reg));
  check('C: forceBiome rode the AppState payload', reg.biome === 'emberfall', String(reg.biome));
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
