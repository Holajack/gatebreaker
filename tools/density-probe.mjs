// Scratch probe: measure the SKINNED-BODY cost of a composed in-gate frame.
//
// Not a shipped suite (no asserts) — it exists so the density wave can quote
// before/after numbers measured the same way twice.
//
//   GB_PORT=5260 node tools/density-probe.mjs [label]
//
// It composes the worst honest frame deterministically rather than waiting for
// a real fight to happen to be at its peak: a full field shadow army plus a
// full live wave of enemies packed in front of the camera inside a combat room,
// then the boss chamber with the boss and its adds. Every entity is also
// measured HIDDEN so the shell (scenery) cost is separable from the entities —
// DUNGEON_SPEC's <=24 draws / <=130k budget is a SHELL budget ("delta between
// empty scene and built dungeon"), and conflating the two is what produced the
// "the budget is blown" claim this wave had to check.

import { ensureServer, launchBrowser, newPhonePage, gotoGame, evalGame, writeReport, shotPath } from './_harness.mjs';

const LABEL = process.argv[2] || 'probe';
const SHADOWS = Number(process.env.GB_SHADOWS || 5);
// GB_BASELINE=1 reconstructs the PRE-wave behaviour at runtime on the same
// seed: waveSize back to E 3 / D 4, no boss adds, no entity LOD, and the shared
// skinned-body ceiling lifted out of the way. Same dungeon, same shadow army,
// so the delta is the change and nothing else.
const BASELINE = process.env.GB_BASELINE === '1';
// GB_TIER pins the quality tier. The ceiling this wave adds is per-tier, so a
// probe that lets the governor pick is measuring a different fence each run.
const TIER = process.env.GB_TIER || 'high';

const srv = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
await gotoGame(page);

await evalGame(page, (g) => {
  g.save.level = 30;
  g.save.autoStats = 29;
  g.refreshDerived?.(true);
});

const out = {};

for (const rank of ['E', 'D']) {
  const idx = { E: 0, D: 1 }[rank];
  out[rank] = await evalGame(page, async (g, [index, shadows, baseline, tier]) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };

    // _beginGate mixes Math.random into the run seed, so two probe runs are
    // otherwise two different dungeons and the before/after delta is noise.
    g.quality.lock(tier);
    const realRandom = Math.random;
    Math.random = () => 0.42;
    g.startGate(index);
    Math.random = realRandom;
    await frames(20);
    g.mode._introSkip = true;           // the walk-in holds the director idle
    await frames(40);

    const d = g.world;
    const dir = g.mode?.director || null;
    const L = d.layout;

    if (baseline) {
      const old = { E: 3, D: 4, C: 6 }[g.gate.rank] ?? g.gate.waveSize;
      g.gate.waveSize = old;
      if (dir) { dir.waveSize = old; dir._adds.live = 0; dir._adds.total = 0; }
      // No LOD: every body casts whenever the tier casts, every rig ticks.
      g._entityLod = function noLod(e, dt) {
        if (!e._lodMeshes) {
          const meshes = [];
          e.mesh.traverse((o) => { if (o.isMesh && !o.isDecal) meshes.push(o); });
          e._lodMeshes = meshes;
        }
        for (const m of e._lodMeshes) m.castShadow = this.quality.current.shadows;
        return dt;
      };
      g.quality.current.maxSkinnedBodies = 99;
    }

    const census = (tag) => {
      g.renderer.info.autoReset = false;
      g.renderer.info.reset();
      g.glow.render(g.scene, g.camera);
      const info = g.renderer.info.render;
      const res = { tag, calls: info.calls, triangles: info.triangles };
      g.renderer.info.autoReset = true;
      let meshes = 0; let tris = 0; let bodies = 0; const per = [];
      g.scene.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        for (let p = o; p; p = p.parent) if (!p.visible) return;
        const geo = o.geometry;
        const t = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count || 0) / 3;
        meshes++; tris += t; per.push(Math.round(t));
        if (t > 400) bodies++;          // the 132-tri eye motes are not bodies
      });
      res.skinnedMeshes = meshes;
      res.skinnedBodies = bodies;
      res.skinnedTris = Math.round(tris);
      res.perMesh = per.sort((a, b) => b - a);
      res.enemies = g.enemies.length;
      res.shadows = g.shadows.length;
      res.corpses = g.corpses.length;
      return res;
    };

    // Hide every entity so the residue is the SHELL.
    const shellOnly = (tag) => {
      const hidden = [];
      const hide = (m) => { if (m && m.visible) { m.visible = false; hidden.push(m); } };
      for (const e of [...g.enemies, ...g.shadows, ...g.corpses, ...g.pickups, ...g.projectiles]) { hide(e.mesh); hide(e.bar); }
      hide(g.player.mesh);
      const r = census(tag);
      for (const m of hidden) m.visible = true;
      return r;
    };

    const result = {
      gate: g.gate.rank,
      tier: g.quality.current.name,
      ceiling: g.quality.current.maxSkinnedBodies,
      enemiesTotal: g.gate.enemies,
      waveSize: dir?.waveSize ?? g.gate.waveSize,
      configWaveSize: g.gate.waveSize,
      fieldCapacity: g.fieldCapacity(),
      samples: [],
      roomSizes: L.rooms.filter((r) => r.kind === 'combat')
        .map((r) => ({ w: r.w, d: r.d, area: Math.round(r.w * r.d), budget: r.budget })),
      bossRoom: (() => { const b = L.rooms[L.bossRoom]; return { w: b.w, d: b.d, area: Math.round(b.w * b.d) }; })(),
    };

    // ---------------------------------------------------------- room peak
    const combat = L.rooms.filter((r) => r.kind === 'combat');
    const room = combat.reduce((a, b) => (a.w * a.d >= b.w * b.d ? a : b));
    // Mark the room CLEARED before standing in it: otherwise the director seals
    // it and runs its own fight on top of the synthetic wave, and the sample is
    // measuring an unrepeatable mixture of the two.
    if (dir) { dir.states[room.id] = 3; dir._active = -1; }
    g.player.pos.set(room.centre.x, 0, room.centre.z);
    g.player.body?.reset?.(room.centre.x, 0, room.centre.z);
    await frames(4);

    // Field army to the tier cap (or the requested count, whichever is lower).
    let guard = 0;
    while (g.shadows.length < shadows && guard++ < 40) {
      const p = g.player.pos.clone();
      p.x += ((guard % 5) - 2) * 1.4;
      p.z += (Math.floor(guard / 5) - 2) * 1.4;
      if (!g._spawnShadow(p, true)) break;
    }

    // A full live wave, packed in the camera's view so nothing frustum-culls out.
    const n = result.waveSize;
    const spawnRing = (count, radius) => {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const p = g.player.pos.clone();
        p.x += Math.cos(a) * radius;
        p.z += Math.sin(a) * radius;
        g._spawnEnemy(p, null);
      }
    };
    spawnRing(n, 6.5);
    for (const e of g.enemies) { e.spawning = 0; e.mesh.position.y = 0; }
    await frames(6);
    result.samples.push(census('room-peak'));
    result.samples.push(shellOnly('room-shell'));

    // The same wave standing where the director actually puts it: on the room's
    // own spawn points, spread across the whole floor. This is the frame a
    // player sees for most of a fight, and the one the distance LOD is for —
    // 'room-peak' above is the pathological case where every body is inside the
    // shadow-cast range at once.
    {
      const pts = room.spawnPoints;
      g.enemies.forEach((e, i) => {
        const pt = pts[(i * 7) % pts.length] || room.centre;
        e.pos.set(pt.x, 0, pt.z);
        e.mesh.position.copy(e.pos);
      });
      await frames(6);
      result.samples.push(census('room-spread'));
    }

    // ---------------------------------------------------------- boss peak
    const boss = L.rooms[L.bossRoom];
    for (const door of L.doors) d.setDoorSealed(door.id, false);
    if (dir) {
      for (const r of L.rooms) if (r.kind === 'combat') dir.states[r.id] = 3;
      dir._active = -1;
    }
    // Clear the trash so the boss frame is the boss frame. The instance MUST be
    // disposed, not just unparented: it holds a slot in quality.js's shared
    // skinned-body ledger, and an undisposed body silently starves every later
    // spawn in the probe (this cost one measurement run to find).
    while (g.enemies.length) {
      const e = g.enemies[0];
      g.scene.remove(e.mesh); g.scene.remove(e.bar);
      e.mesh.userData.character?.dispose?.();
      g.enemies.shift();
    }
    g.player.pos.set(boss.centre.x, 0, boss.centre.z + 8);
    g.player.body?.reset?.(boss.centre.x, 0, boss.centre.z + 8);
    await frames(120);          // let the director trigger the chamber
    result.bossSpawnPoints = boss.spawnPoints?.length ?? 0;
    // Boss adds trickle over ~15 s of play. Rather than idle for it, zero the
    // add timer each frame until the chamber is at its live cap.
    const want = 1 + (dir?._adds?.live ?? 0);
    for (let i = 0; i < 400 && g.enemies.length < want; i++) {
      if (dir?._adds) dir._adds.timer = 0;
      await frame();
    }
    for (const e of g.enemies) { e.spawning = 0; e.mesh.position.y = 0; }
    await frames(10);
    result.bossPhase = dir?.state;
    result.bossAdds = dir?._adds ? { ...dir._adds } : null;
    result.samples.push(census('boss-peak'));
    result.samples.push(shellOnly('boss-shell'));

    return result;
  }, idx, SHADOWS, BASELINE, TIER);

  await page.screenshot({ path: shotPath(`${LABEL}-${rank}.png`) });
}

out.errors = errors;
for (const rank of ['E', 'D']) {
  const x = out[rank];
  console.log(`\n=== ${rank}  tier=${x.tier} ceiling=${x.ceiling}  waveSize=${x.waveSize}  `
    + `total=${x.enemiesTotal}  fieldCap=${x.fieldCapacity}`);
  console.log(`    rooms: ${x.roomSizes.map((r) => `${r.w}x${r.d}=${r.area}m2 b${r.budget}`).join('  ')}`);
  console.log(`    boss:  ${x.bossRoom.w}x${x.bossRoom.d}=${x.bossRoom.area}m2   phase=${x.bossPhase} `
    + `spawnPoints=${x.bossSpawnPoints} adds=${JSON.stringify(x.bossAdds)}`);
  for (const s of x.samples) {
    console.log(`    ${s.tag.padEnd(11)} calls=${String(s.calls).padStart(4)} tris=${String(s.triangles).padStart(7)} `
      + `skinnedBodies=${String(s.skinnedBodies).padStart(3)} skinnedTris=${String(s.skinnedTris).padStart(6)} `
      + `enemies=${s.enemies} shadows=${s.shadows} corpses=${s.corpses}`);
  }
}
writeReport(`${LABEL}.json`, out);
if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '));

await browser.close();
await srv.stop();
