// Wave 3-A2 INTEGRATION VERIFIER — adversarial, no asserts, numbers only.
//
// Written by the integration pass, not by either feature agent, because both
// agents' reports quote numbers measured by instruments they wrote themselves.
// This one re-measures the four claims the orchestrator asked for, in one live
// gate each, and prints what it saw:
//
//   1. FIGHT FEEL — live enemy count vs the room it is standing in, with the
//      real game camera, mid-fight, in a regular room and in the boss chamber.
//   2. COVER — the LIVE ObstacleField probed on a 1 m lattice at the 1.2 m
//      height a caster bolt flies at (the baseline this replaces was 1/1296),
//      plus a flood fill for walkable connectivity and a caster LOS proof
//      through the actual _agentLosBlocked path the AI uses.
//   3. PERF — a composed in-gate frame with a 5-shadow army, reported plainly
//      against DUNGEON_SPEC's <=24 draws / <=130k triangles, and split into
//      shell (scenery only) vs entities so the comparison is honest about
//      which side of that line each number belongs on.
//
//   GB_PORT=5173 GB_OUT=<dir> node tools/wave3a2-verify.mjs
//
// Determinism: Math.random is pinned across startGate so both ranks build the
// same dungeon on every run of this tool.

import {
  ensureServer, launchBrowser, newPhonePage, gotoGame, evalGame, writeReport, shotPath,
} from './_harness.mjs';

const SHADOWS = Number(process.env.GB_SHADOWS || 5);
const TIER = process.env.GB_TIER || 'high';

const srv = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
await gotoGame(page);

// Level 30 so the shadow roster can actually field five soldiers and the
// player survives a real wave long enough to be photographed fighting it.
await evalGame(page, (g) => {
  g.save.level = 30;
  g.save.autoStats = 29;
  g.refreshDerived?.(true);
});

const out = { tier: TIER, shadowsRequested: SHADOWS, ranks: {}, screenshots: [] };

for (const rank of ['E', 'D']) {
  const idx = { E: 0, D: 1 }[rank];

  // --- mount the gate and walk into the biggest combat room ----------------
  const setup = await evalGame(page, async (g, [index, tier, shadows]) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
    g.quality.lock(tier);
    const real = Math.random;
    Math.random = () => 0.42;          // pin the run seed
    g.startGate(index);
    Math.random = real;
    await frames(20);
    g.mode._introSkip = true;
    await frames(40);

    const d = g.world;
    const L = d.layout;
    const dir = g.mode.director;
    const combat = L.rooms.filter((r) => r.kind === 'combat' || r.kind === 'treasure');
    const room = combat.reduce((a, b) => (a.w * a.d >= b.w * b.d ? a : b));

    // Field the shadow army BEFORE the fight, the way a player would.
    let guard = 0;
    while (g.shadows.length < shadows && guard++ < 40) {
      const p = g.player.pos.clone();
      p.x += ((guard % 3) - 1) * 1.6;
      p.z += (Math.floor(guard / 3) - 1) * 1.6;
      if (!g._spawnShadow(p, true)) break;
    }

    // STEP THE SIM, DO NOT WAIT ON WALL CLOCK. The first pass of this probe
    // used rAF frames, and on SwiftShader 240 frames is ~24 REAL seconds — by
    // the time it photographed the "peak" the shadow army had killed 9 of the
    // 11 bodies and the shot showed 2 enemies in a 780 m2 room, which is a
    // measurement artifact, not the game. Manual stepping with the renderer
    // stubbed makes the moment deterministic, and topping every combatant's HP
    // each step freezes the fight AT its peak instead of photographing its
    // tail. Nothing here changes what the DIRECTOR does — the wave that fills
    // the room is the wave the player meets.
    const origRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = () => {};
    const freeze = () => {
      g.player.invuln = 1e6;
      g.player.hp = g.derived.maxHp;
      for (const e of g.enemies) e.hp = e.maxHp;
      for (const s of g.shadows) s.hp = s.maxHp;
    };
    const step = (n) => { for (let i = 0; i < n; i++) { freeze(); g.update(1 / 60); } };
    g.player.pos.set(room.centre.x, 0, room.centre.z);
    g.player.body?.reset?.(room.centre.x, 0, room.centre.z);
    step(4);
    const dir0 = g.mode.director;
    const want = Math.min(dir0?.waveSize ?? 99, room.budget);
    // Trigger + 0.5 s seal grace, then trickle until the room is at its live
    // cap (TRICKLE_INTERVAL is ~1.1 s, so a full wave is a few seconds of sim).
    let steps = 0;
    while (g.enemies.length < want && steps < 1800) { step(10); steps += 10; }
    step(120);                 // 2 s for the pack to close and separate out
    freeze();
    g.renderer.render = origRender;
    await frames(3);

    return {
      simSteps: steps,
      wanted: want,
      seed: g.world.seed ?? null,
      gateRank: g.gate.rank,
      gateEnemies: g.gate.enemies,
      enemyBand: g.gate.enemyBand,
      waveSizeRolled: dir?.waveSize ?? null,
      waveBand: g.gate.waveBand,
      bossAdds: g.gate.bossAdds,
      roomId: room.id,
      room: { w: room.w, d: room.d, area: Math.round(room.w * room.d), budget: room.budget },
      allRooms: combat.map((r) => ({ w: r.w, d: r.d, area: Math.round(r.w * r.d), budget: r.budget })),
      bossRoom: (() => { const b = L.rooms[L.bossRoom]; return { w: b.w, d: b.d, area: Math.round(b.w * b.d) }; })(),
      liveEnemies: g.enemies.length,
      shadows: g.shadows.length,
      roomState: dir?.states?.[room.id] ?? null,
      allInRoom: g.enemies.every((e) => d.roomAt(e.pos.x, e.pos.z) === room.id),
      // How SPREAD the pack is: the radius of the smallest circle around the
      // live enemies, and the mean pairwise distance. A "clump" reads small on
      // both no matter how many bodies there are.
      spread: (() => {
        const es = g.enemies;
        if (es.length < 2) return null;
        let cx = 0; let cz = 0;
        for (const e of es) { cx += e.pos.x; cz += e.pos.z; }
        cx /= es.length; cz /= es.length;
        let maxR = 0; let sum = 0; let pairs = 0;
        for (let i = 0; i < es.length; i++) {
          maxR = Math.max(maxR, Math.hypot(es[i].pos.x - cx, es[i].pos.z - cz));
          for (let j = i + 1; j < es.length; j++) {
            sum += Math.hypot(es[i].pos.x - es[j].pos.x, es[i].pos.z - es[j].pos.z);
            pairs++;
          }
        }
        return { packRadius: +maxR.toFixed(2), meanPairDist: +(sum / pairs).toFixed(2) };
      })(),
    };
  }, idx, TIER, SHADOWS);

  // Mid-fight shot through the REAL game camera.
  const shotFight = shotPath(`fight-${rank}-room.png`);
  await page.screenshot({ path: shotFight });
  out.screenshots.push(shotFight);

  // --- perf census on that same frame --------------------------------------
  const perfRoom = await evalGame(page, async (g) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    // TWO NUMBERS, because the project has two and they are not the same thing.
    // glow.render(...) is the COMPOSITE the player actually gets — main pass,
    // the key light's shadow depth pass, and the glow/bloom pass — so a piece of
    // scenery is counted once per pass it appears in. renderer.render(...) is
    // ONE pass, and it is what DUNGEON_SPEC's <=24 draws / <=130k is defined
    // against ("delta between empty scene and built dungeon", measured that way
    // in tools/dungeon-test.mjs). Quoting a composite figure against a
    // single-pass budget is the exact confusion this run was sent to settle, so
    // both are recorded and labelled.
    const census = () => {
      g.renderer.info.autoReset = false;
      g.renderer.info.reset();
      g.renderer.render(g.scene, g.camera);
      const one = g.renderer.info.render;
      const single = { calls: one.calls, triangles: one.triangles };
      g.renderer.info.reset();
      g.glow.render(g.scene, g.camera);
      const i = g.renderer.info.render;
      const res = { calls: i.calls, triangles: i.triangles, single };
      g.renderer.info.autoReset = true;
      res.enemies = g.enemies.length;
      res.shadows = g.shadows.length;
      res.corpses = g.corpses.length;
      let bodies = 0; let tris = 0;
      g.scene.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        for (let p = o; p; p = p.parent) if (!p.visible) return;
        const t = o.geometry?.index ? o.geometry.index.count / 3
          : (o.geometry?.attributes?.position?.count || 0) / 3;
        tris += t;
        if (t > 400) bodies++;
      });
      res.skinnedBodies = bodies;
      res.skinnedTris = Math.round(tris);
      return res;
    };
    // THE SPEC'S BUDGET IS A DELTA, NOT AN ABSOLUTE. DUNGEON_SPEC's <=24 draws
    // / <=130k triangles is defined as the "delta between empty scene and built
    // dungeon" and tools/dungeon-test.mjs measures it that way. An absolute
    // frame count is a different quantity and comparing one to the other is
    // exactly the mistake this run was sent to settle, so measure BOTH:
    //   composed     the whole frame the player sees, every pass, entities in
    //   noEntities   the same frame with every body hidden
    //   empty        also with the dungeon itself hidden (city residue, HUD,
    //                fx pools, the glow pass's own cost)
    //   sceneryDelta noEntities - empty = the number the budget is about
    const hideAll = (alsoWorld) => {
      const hidden = [];
      const hide = (m) => { if (m && m.visible) { m.visible = false; hidden.push(m); } };
      for (const e of [...g.enemies, ...g.shadows, ...g.corpses, ...g.pickups, ...g.projectiles]) {
        hide(e.mesh); hide(e.bar);
      }
      hide(g.player.mesh);
      if (alsoWorld) hide(g.world.group);
      return hidden;
    };
    const shellOnly = () => {
      const hidden = hideAll(false);
      const r = census();
      for (const m of hidden) m.visible = true;
      return r;
    };
    const emptyOnly = () => {
      const hidden = hideAll(true);
      const r = census();
      for (const m of hidden) m.visible = true;
      return r;
    };
    await frame();
    const composed = census();
    const noEntities = shellOnly();
    const empty = emptyOnly();
    return {
      composed,
      noEntities,
      empty,
      sceneryDelta: {
        calls: noEntities.calls - empty.calls,
        triangles: noEntities.triangles - empty.triangles,
      },
      // The spec's quantity: single-pass delta, empty scene -> built dungeon.
      sceneryDeltaSinglePass: {
        calls: noEntities.single.calls - empty.single.calls,
        triangles: noEntities.single.triangles - empty.single.triangles,
      },
    };
  });

  // --- AERIAL of the same fight: everything in one frame -------------------
  const aerial = await evalGame(page, async (g, [roomId]) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const L = g.world.layout;
    const room = L.rooms[roomId];
    // Freeze the follow rig, then park the camera high enough that the whole
    // room fits. Restored by the caller before anything else is measured.
    g.__savedCam = g.mode.updateCamera;
    g.mode.updateCamera = () => {};
    // AN AERIAL HAS TO DEFEAT THE FOG, or it photographs a black rectangle —
    // which is what the first pass of this probe produced. Interior fog is
    // near 13 / far 44 and the aerial camera sits ~40 m up, so the entire room
    // is past `far`. Push fog out and add one bright hemisphere fill for the
    // duration of the shot; both are restored immediately after. This changes
    // only what the CAMERA can see — no geometry, no entity, no collision.
    g.__savedFog = g.scene.fog ? { near: g.scene.fog.near, far: g.scene.fog.far } : null;
    if (g.scene.fog) { g.scene.fog.near = 200; g.scene.fog.far = 400; }
    // Fog alone leaves the far end of a 42 m room very dark, because the only
    // real light is the two-lamp torch pool that follows the player. Lift every
    // ambient/hemisphere light in the scene for the shot and put it back after.
    g.__savedLights = [];
    g.scene.traverse((o) => {
      if (o.isAmbientLight || o.isHemisphereLight) {
        g.__savedLights.push([o, o.intensity]);
        o.intensity = Math.max(o.intensity, 1.6);
      }
    });
    const span = Math.max(room.w, room.d);
    g.camera.position.set(room.centre.x, span * 1.25, room.centre.z + span * 0.42);
    g.camera.lookAt(room.centre.x, 0, room.centre.z);
    for (let i = 0; i < 6; i++) await frame();
    return {
      live: g.enemies.length,
      shadows: g.shadows.length,
      playerInRoom: g.world.roomAt(g.player.pos.x, g.player.pos.z) === roomId,
    };
  }, setup.roomId);
  const shotAerial = shotPath(`fight-${rank}-room-aerial.png`);
  await page.screenshot({ path: shotAerial });
  out.screenshots.push(shotAerial);
  await evalGame(page, (g) => {
    g.mode.updateCamera = g.__savedCam;
    if (g.__savedFog && g.scene.fog) {
      g.scene.fog.near = g.__savedFog.near;
      g.scene.fog.far = g.__savedFog.far;
    }
    for (const [o, v] of (g.__savedLights || [])) o.intensity = v;
    g.__savedLights = [];
  });

  // --- boss chamber --------------------------------------------------------
  const bossSetup = await evalGame(page, async (g) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
    const d = g.world;
    const L = d.layout;
    const dir = g.mode.director;
    // Clear the crawl so the boss gate opens, without faking the boss fight.
    for (const r of L.rooms) if (r.kind === 'combat' || r.kind === 'treasure') dir.states[r.id] = 3;
    dir._active = -1;
    for (const door of L.doors) d.setDoorSealed(door.id, false);
    while (g.enemies.length) {
      const e = g.enemies[0];
      g.scene.remove(e.mesh); g.scene.remove(e.bar);
      e.mesh.userData.character?.dispose?.();
      g.enemies.shift();
    }
    const boss = L.rooms[L.bossRoom];
    // Stepped, not waited — see the note in the room section. Corpses from the
    // crawl are cleared above so the boss frame is the boss frame.
    const origRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = () => {};
    const freeze = () => {
      g.player.invuln = 1e6;
      g.player.hp = g.derived.maxHp;
      for (const e of g.enemies) e.hp = e.maxHp;
      for (const s of g.shadows) s.hp = s.maxHp;
    };
    const step = (n) => { for (let i = 0; i < n; i++) { freeze(); g.update(1 / 60); } };
    g.player.pos.set(boss.centre.x, 0, boss.centre.z + 8);
    g.player.body?.reset?.(boss.centre.x, 0, boss.centre.z + 8);
    step(150);                            // boss trigger + 1.2 s reveal hold
    // Adds trickle at BOSS_ADDS_INTERVAL over the whole fight; pull the timer
    // forward rather than simulating minutes of it. The LIVE CAP is untouched,
    // so the count photographed is the count a player meets at the peak.
    const want = 1 + (dir?._adds?.live ?? 0);
    for (let i = 0; i < 900 && g.enemies.length < want; i++) {
      if (dir?._adds) dir._adds.timer = 0;
      step(1);
    }
    step(120);
    freeze();
    g.renderer.render = origRender;
    await frames(3);
    return {
      phase: dir?.state,
      bossRoom: { w: boss.w, d: boss.d, area: Math.round(boss.w * boss.d) },
      adds: dir?._adds ? { ...dir._adds } : null,
      liveEnemies: g.enemies.length,
      bossPresent: g.enemies.some((e) => e.isBoss),
      shadows: g.shadows.length,
      gateEnemiesAfterAdds: g.gate.enemies,
      spread: (() => {
        const es = g.enemies;
        if (es.length < 2) return null;
        let cx = 0; let cz = 0;
        for (const e of es) { cx += e.pos.x; cz += e.pos.z; }
        cx /= es.length; cz /= es.length;
        let maxR = 0;
        for (const e of es) maxR = Math.max(maxR, Math.hypot(e.pos.x - cx, e.pos.z - cz));
        return { packRadius: +maxR.toFixed(2) };
      })(),
    };
  });

  const shotBoss = shotPath(`fight-${rank}-boss.png`);
  await page.screenshot({ path: shotBoss });
  out.screenshots.push(shotBoss);

  const perfBoss = await evalGame(page, async (g) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    // TWO NUMBERS, because the project has two and they are not the same thing.
    // glow.render(...) is the COMPOSITE the player actually gets — main pass,
    // the key light's shadow depth pass, and the glow/bloom pass — so a piece of
    // scenery is counted once per pass it appears in. renderer.render(...) is
    // ONE pass, and it is what DUNGEON_SPEC's <=24 draws / <=130k is defined
    // against ("delta between empty scene and built dungeon", measured that way
    // in tools/dungeon-test.mjs). Quoting a composite figure against a
    // single-pass budget is the exact confusion this run was sent to settle, so
    // both are recorded and labelled.
    const census = () => {
      g.renderer.info.autoReset = false;
      g.renderer.info.reset();
      g.renderer.render(g.scene, g.camera);
      const one = g.renderer.info.render;
      const single = { calls: one.calls, triangles: one.triangles };
      g.renderer.info.reset();
      g.glow.render(g.scene, g.camera);
      const i = g.renderer.info.render;
      const res = { calls: i.calls, triangles: i.triangles, single };
      g.renderer.info.autoReset = true;
      res.enemies = g.enemies.length;
      res.shadows = g.shadows.length;
      return res;
    };
    // THE SPEC'S BUDGET IS A DELTA, NOT AN ABSOLUTE. DUNGEON_SPEC's <=24 draws
    // / <=130k triangles is defined as the "delta between empty scene and built
    // dungeon" and tools/dungeon-test.mjs measures it that way. An absolute
    // frame count is a different quantity and comparing one to the other is
    // exactly the mistake this run was sent to settle, so measure BOTH:
    //   composed     the whole frame the player sees, every pass, entities in
    //   noEntities   the same frame with every body hidden
    //   empty        also with the dungeon itself hidden (city residue, HUD,
    //                fx pools, the glow pass's own cost)
    //   sceneryDelta noEntities - empty = the number the budget is about
    const hideAll = (alsoWorld) => {
      const hidden = [];
      const hide = (m) => { if (m && m.visible) { m.visible = false; hidden.push(m); } };
      for (const e of [...g.enemies, ...g.shadows, ...g.corpses, ...g.pickups, ...g.projectiles]) {
        hide(e.mesh); hide(e.bar);
      }
      hide(g.player.mesh);
      if (alsoWorld) hide(g.world.group);
      return hidden;
    };
    const shellOnly = () => {
      const hidden = hideAll(false);
      const r = census();
      for (const m of hidden) m.visible = true;
      return r;
    };
    const emptyOnly = () => {
      const hidden = hideAll(true);
      const r = census();
      for (const m of hidden) m.visible = true;
      return r;
    };
    await frame();
    const composed = census();
    const noEntities = shellOnly();
    const empty = emptyOnly();
    return {
      composed,
      noEntities,
      empty,
      sceneryDelta: {
        calls: noEntities.calls - empty.calls,
        triangles: noEntities.triangles - empty.triangles,
      },
      // The spec's quantity: single-pass delta, empty scene -> built dungeon.
      sceneryDeltaSinglePass: {
        calls: noEntities.single.calls - empty.single.calls,
        triangles: noEntities.single.triangles - empty.single.triangles,
      },
    };
  });

  const bossAerial = await evalGame(page, async (g) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const L = g.world.layout;
    const room = L.rooms[L.bossRoom];
    g.__savedCam = g.mode.updateCamera;
    g.mode.updateCamera = () => {};
    // AN AERIAL HAS TO DEFEAT THE FOG, or it photographs a black rectangle —
    // which is what the first pass of this probe produced. Interior fog is
    // near 13 / far 44 and the aerial camera sits ~40 m up, so the entire room
    // is past `far`. Push fog out and add one bright hemisphere fill for the
    // duration of the shot; both are restored immediately after. This changes
    // only what the CAMERA can see — no geometry, no entity, no collision.
    g.__savedFog = g.scene.fog ? { near: g.scene.fog.near, far: g.scene.fog.far } : null;
    if (g.scene.fog) { g.scene.fog.near = 200; g.scene.fog.far = 400; }
    // Fog alone leaves the far end of a 42 m room very dark, because the only
    // real light is the two-lamp torch pool that follows the player. Lift every
    // ambient/hemisphere light in the scene for the shot and put it back after.
    g.__savedLights = [];
    g.scene.traverse((o) => {
      if (o.isAmbientLight || o.isHemisphereLight) {
        g.__savedLights.push([o, o.intensity]);
        o.intensity = Math.max(o.intensity, 1.6);
      }
    });
    const span = Math.max(room.w, room.d);
    g.camera.position.set(room.centre.x, span * 1.15, room.centre.z + span * 0.40);
    g.camera.lookAt(room.centre.x, 0, room.centre.z);
    for (let i = 0; i < 6; i++) await frame();
    return { live: g.enemies.length };
  });
  const shotBossAerial = shotPath(`fight-${rank}-boss-aerial.png`);
  await page.screenshot({ path: shotBossAerial });
  out.screenshots.push(shotBossAerial);
  await evalGame(page, (g) => {
    g.mode.updateCamera = g.__savedCam;
    if (g.__savedFog && g.scene.fog) {
      g.scene.fog.near = g.__savedFog.near;
      g.scene.fog.far = g.__savedFog.far;
    }
    for (const [o, v] of (g.__savedLights || [])) o.intensity = v;
    g.__savedLights = [];
  });

  // --- COVER PROBE on the live field ---------------------------------------
  const cover = await evalGame(page, (g) => {
    const d = g.world;
    const L = d.layout;
    const field = d.obstacleField;
    const room = L.rooms[L.bossRoom];

    // 1 m lattice inset 1 m from the walls, sampled at bolt height. Same shape
    // as the adversarial baseline probe that read 1/1296.
    const nx = Math.floor(room.w - 2);
    const nz = Math.floor(room.d - 2);
    let blocked = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        if (field.blocked(room.x + 1.5 + i, room.z + 1.5 + j, 0, 0, 1.2)) blocked++;
      }
    }

    // Sightlines: chords >= 6 m across the chamber the caster bolt cannot make.
    let a = 0xdeadbeef;
    const rnd = () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let shots = 0; let stopped = 0; let guard = 0;
    while (shots < 800 && guard++ < 20000) {
      const ax = room.x + 1.5 + rnd() * (room.w - 3);
      const az = room.z + 1.5 + rnd() * (room.d - 3);
      const bx = room.x + 1.5 + rnd() * (room.w - 3);
      const bz = room.z + 1.5 + rnd() * (room.d - 3);
      if (Math.hypot(bx - ax, bz - az) < 6) continue;
      shots++;
      if (field.lineBlocked(ax, az, bx, bz)) stopped++;
    }

    // CASTER PROOF through the real AI path. Take a cover piece in the boss
    // chamber, stand the player on one side and a synthetic ranged agent on the
    // other, and ask _agentLosBlocked — the exact call enemyai.js gates its
    // standoff decision on. Then move the agent to a clean line as the control.
    const pieces = (L.decor.cover || []).filter((c) => c.room === L.bossRoom);
    let casterProof = null;
    for (const c of pieces) {
      // Probe across the piece's SHORT world axis so the line must cross it.
      const acrossX = c.ez >= c.ex;
      const off = 4.0;
      const px = acrossX ? c.x : c.x;
      const pz = acrossX ? c.z : c.z;
      const A = { x: acrossX ? px - off : px, z: acrossX ? pz : pz - off };
      const B = { x: acrossX ? px + off : px, z: acrossX ? pz : pz + off };
      const savedPlayer = g.player.pos.clone();
      g.player.pos.set(B.x, 0, B.z);
      const fake = {
        pos: { x: A.x, z: A.z },
        agent: { behavior: 'ranged', range: 20, losT: 0, losBlocked: false },
      };
      const blockedLos = g._agentLosBlocked(fake, Math.hypot(B.x - A.x, B.z - A.z), 1);
      // NEGATIVE CONTROL, and it has to be an honest one. The first version of
      // this probe slid both points to the same side of the piece and called
      // that "clear" — in D another cover piece happened to sit on that line
      // and the control came back blocked, which proves nothing either way. So
      // the control is now SEARCHED: walk the chamber for a 6 m chord the field
      // does not stop at all. If the pair is (blocked, clear) the probe has
      // shown cover is what did it, and not that everything is blocked.
      let clearLos = null;
      for (let t = 0; t < 400 && clearLos === null; t++) {
        const ang = (t / 400) * Math.PI * 2;
        const cx0 = room.centre.x + Math.cos(ang) * (room.w * 0.5 - 4);
        const cz0 = room.centre.z + Math.sin(ang) * (room.d * 0.5 - 4);
        const cx1 = cx0 + Math.cos(ang + Math.PI / 2) * 6;
        const cz1 = cz0 + Math.sin(ang + Math.PI / 2) * 6;
        if (Math.abs(cx1 - room.centre.x) > room.w * 0.5 - 2) continue;
        if (Math.abs(cz1 - room.centre.z) > room.d * 0.5 - 2) continue;
        g.player.pos.set(cx1, 0, cz1);
        const probe = {
          pos: { x: cx0, z: cz0 },
          agent: { behavior: 'ranged', range: 20, losT: 0, losBlocked: false },
        };
        if (!g._agentLosBlocked(probe, 6, 1)) clearLos = false;
      }
      g.player.pos.copy(savedPlayer);
      if (blockedLos) {
        casterProof = {
          piece: c.kind,
          at: [+c.x.toFixed(2), +c.z.toFixed(2)],
          throughCoverBlocked: blockedLos,
          // false => a clean 6 m chord exists, so the block above was the
          // cover and not a field that stops everything. null => none found.
          controlClearChordFound: clearLos === false,
        };
        break;
      }
    }

    // WALKABLE CONNECTIVITY of the boss chamber, flood filled on a 0.5 m
    // lattice at body radius through the REAL field.
    const step = 0.5;
    const gw = Math.floor((room.w - 1) / step);
    const gd = Math.floor((room.d - 1) / step);
    const ok = new Uint8Array(gw * gd);
    let walkable = 0;
    for (let j = 0; j < gd; j++) {
      for (let i = 0; i < gw; i++) {
        const x = room.x + 0.5 + i * step;
        const z = room.z + 0.5 + j * step;
        if (!field.blocked(x, z, 0.45, 0.4, 0)) { ok[i + j * gw] = 1; walkable++; }
      }
    }
    let comps = 0; let biggest = 0;
    const seen = new Uint8Array(gw * gd);
    for (let s = 0; s < ok.length; s++) {
      if (!ok[s] || seen[s]) continue;
      comps++;
      let size = 0;
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const k = stack.pop();
        size++;
        const ci = k % gw; const cj = (k - ci) / gw;
        const push = (ni, nj) => {
          if (ni < 0 || nj < 0 || ni >= gw || nj >= gd) return;
          const n = ni + nj * gw;
          if (ok[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        };
        push(ci - 1, cj); push(ci + 1, cj); push(ci, cj - 1); push(ci, cj + 1);
      }
      biggest = Math.max(biggest, size);
    }

    return {
      bossRoom: `${room.w}x${room.d}`,
      lattice: `${nx}x${nz}`,
      blockedCells: blocked,
      totalCells: nx * nz,
      blockedPct: +((100 * blocked) / (nx * nz)).toFixed(1),
      losShots: shots,
      losBlockedPct: +((100 * stopped) / shots).toFixed(1),
      coverPiecesGate: (L.decor.cover || []).length,
      coverPiecesBoss: pieces.length,
      coverByKind: (L.decor.cover || []).reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {}),
      casterProof,
      walkable: { cells: walkable, components: comps, largestPct: +((100 * biggest) / walkable).toFixed(1) },
      // NavGrid.flowAt returns false off-grid, unreachable AND near the goal
      // (navgrid.js), so querying the boss room CENTRE — which is usually where
      // the goal is — reports false for a perfectly healthy grid. The first
      // version of this probe did exactly that and printed a scary
      // navFlowReachesBoss=false. Sample a ring one room-radius out instead and
      // report the fraction of sampled points that produce a flow vector.
      navFlowRingPct: (() => {
        const grid = d.navGrid;
        if (!grid?.flowAt) return null;
        // flowAt is meaningless without a goal, and the first version of this
        // probe forgot to set one — it printed 0% for a perfectly healthy grid.
        // Goal at the entry, the same place tools/dungeon-test.mjs puts it.
        if (!grid.setGoal(L.rooms[0].centre.x, L.rooms[0].centre.z)) return null;
        const dir2 = { x: 0, z: 0 };
        let hit = 0; let n = 0;
        for (let t = 0; t < 24; t++) {
          const a2 = (t / 24) * Math.PI * 2;
          const x = room.centre.x + Math.cos(a2) * (Math.min(room.w, room.d) * 0.5 - 3);
          const z = room.centre.z + Math.sin(a2) * (Math.min(room.w, room.d) * 0.5 - 3);
          if (field.blocked(x, z, 0.45, 0.4, 0)) continue;
          n++;
          if (grid.flowAt(x, z, dir2)) hit++;
        }
        return n ? +((100 * hit) / n).toFixed(1) : null;
      })(),
    };
  });

  out.ranks[rank] = {
    setup, aerial, perfRoom, bossSetup, perfBoss, bossAerial, cover,
  };
}

out.errors = errors;
writeReport('wave3a2-verify.json', out);

const B = { calls: 24, tris: 130000 };
for (const rank of ['E', 'D']) {
  const x = out.ranks[rank];
  console.log(`\n================ ${rank} ================`);
  console.log(`gate.enemies=${x.setup.gateEnemies} band=${JSON.stringify(x.setup.enemyBand)}  `
    + `waveSize rolled=${x.setup.waveSizeRolled} band=${JSON.stringify(x.setup.waveBand)}  `
    + `bossAdds=${JSON.stringify(x.setup.bossAdds)}`);
  console.log(`ROOM  ${x.setup.room.w}x${x.setup.room.d} m (${x.setup.room.area} m2, budget ${x.setup.room.budget})  `
    + `LIVE=${x.setup.liveEnemies} + ${x.setup.shadows} shadows  allInRoom=${x.setup.allInRoom}  `
    + `spread=${JSON.stringify(x.setup.spread)}`);
  const line = (tag, p) => {
    console.log(`      ${tag} composed ${p.composed.calls} draws / ${p.composed.triangles} tris  |  `
      + `noEntities ${p.noEntities.calls}/${p.noEntities.triangles}  |  empty ${p.empty.calls}/${p.empty.triangles}`);
    console.log(`      ${' '.repeat(tag.length)} SCENERY DELTA ${p.sceneryDelta.calls} draws / ${p.sceneryDelta.triangles} tris `
      + `(composite, all passes)`);
    const sp = p.sceneryDeltaSinglePass;
    console.log(`      ${' '.repeat(tag.length)} SCENERY DELTA ${sp.calls} draws / ${sp.triangles} tris SINGLE PASS `
      + `vs the spec's <=${B.calls} / <=${B.tris}  =>  `
      + `${sp.calls > B.calls ? 'OVER' : 'ok'} / ${sp.triangles > B.tris ? 'OVER' : 'ok'}`);
  };
  line('ROOM ', x.perfRoom);
  console.log(`      skinnedBodies=${x.perfRoom.composed.skinnedBodies} `
    + `skinnedGeoTris=${x.perfRoom.composed.skinnedTris} corpses=${x.perfRoom.composed.corpses}`);
  console.log(`BOSS  ${x.bossSetup.bossRoom.w}x${x.bossSetup.bossRoom.d} m (${x.bossSetup.bossRoom.area} m2)  `
    + `LIVE=${x.bossSetup.liveEnemies} (boss present ${x.bossSetup.bossPresent}) adds=${JSON.stringify(x.bossSetup.adds)}  `
    + `phase=${x.bossSetup.phase}  gate.enemies now ${x.bossSetup.gateEnemiesAfterAdds}`);
  line('BOSS ', x.perfBoss);
  const c = x.cover;
  console.log(`COVER ${c.bossRoom} m: ${c.blockedCells}/${c.totalCells} cells blocked at 1.2 m (${c.blockedPct}%)  `
    + `LOS stopped ${c.losBlockedPct}% of ${c.losShots} chords`);
  console.log(`      pieces gate=${c.coverPiecesGate} boss=${c.coverPiecesBoss} ${JSON.stringify(c.coverByKind)}`);
  console.log(`      caster LOS proof: ${JSON.stringify(c.casterProof)}`);
  console.log(`      walkable ${c.walkable.cells} cells, ${c.walkable.components} component(s), `
    + `largest ${c.walkable.largestPct}%  navFlow on ${c.navFlowRingPct}% of a sampled ring`);
}
if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
console.log('\nscreenshots:\n' + out.screenshots.join('\n'));

await browser.close();
await srv.stop();
