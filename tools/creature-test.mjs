// creature-test — are the enemies actually monsters now?
//
// Boots the real game in a LANDSCAPE phone viewport (index.html's rotate gate
// swallows pointer events in portrait), walks the UI into a gate, and then
// answers the four questions that decide whether this change shipped or only
// compiled:
//
//   1. Is every ENEMY and the BOSS backed by creatures.glb, and is the PLAYER
//      still a character out of characters.glb?
//   2. Does each instance own a PRIVATE skeleton? SkeletonUtils.clone is the
//      only clone that gives you one; Object3D.clone leaves every monster on
//      the source skeleton and the whole field animates as a single creature.
//      This is the single easiest thing to get wrong here, so it is checked by
//      uuid on both the Skeleton and its bones.
//   3. Do their mixers advance?
//   4. Is anything still holding the procedural plank? entities.swordMesh tags
//      itself `userData.procedural = 'sword'`, so this is exact rather than a
//      guess from pixels.
//
// It runs the gate TWICE: once with models/creatures.glb blocked at the network
// layer, which is the honest way to prove the offline fallback still boots and
// also gives the BEFORE numbers for triangles and draw calls, and once for
// real. Both runs screenshot at the live gameplay camera.
//
//   node tools/creature-test.mjs
//   GB_PORT=5173 node tools/creature-test.mjs

import fs from 'node:fs';
import {
  launchBrowser, newPhonePage, ensureServer, gotoGame,
  evalGame, writeReport, shotPath, OUT,
} from './_harness.mjs';

const RANK = process.env.GB_RANK || 'E';

// ---------------------------------------------------------------- probes
//
// Everything below runs INSIDE the page against window.__game. Keep them
// self-contained: nothing from this module's scope crosses the bridge.

function probeField(game) {
  const seen = [];
  const skeletons = new Map();
  const bones = new Map();
  let planks = 0;
  const plankHolders = [];

  const describe = (label, mesh) => {
    if (!mesh) return null;
    const inst = mesh.userData?.character || null;
    const entry = {
      label,
      backed: inst ? (inst.isCreature ? 'creature' : 'character') : 'procedural',
      bound: Boolean(inst?.isShadow),
      creature: inst?.creature || null,
      appearance: inst?.appearance?.key || null,
      weaponSlot: inst?.weaponSlot || null,
      state: inst?.state || null,
      mixerTime: inst?.mixer ? +inst.mixer.time.toFixed(4) : null,
      skeleton: inst?.skeleton?.uuid || null,
      bone0: inst?.skeleton?.bones?.[0]?.uuid || null,
      skinnedMeshes: 0,
      triangles: 0,
      plank: false,
      held: [],
      height: 0,
    };
    const box = { min: Infinity, max: -Infinity };
    mesh.updateWorldMatrix(true, true);
    mesh.traverse((o) => {
      if (o.userData?.procedural === 'sword') { entry.plank = true; }
      if (o.userData?.packModel) entry.held.push(o.userData.packModel);
      if (!o.isMesh) return;
      if (o.isSkinnedMesh) entry.skinnedMeshes++;
      const g = o.geometry;
      if (g) {
        const count = g.index ? g.index.count : (g.attributes.position?.count || 0);
        entry.triangles += Math.floor(count / 3);
      }
      // Skinned bounds are in quantised space, so the only honest height here
      // comes from the bone positions the animation actually drives.
    });
    mesh.traverse((o) => {
      if (!o.isBone) return;
      const y = o.getWorldPosition(new window.THREE_V3()).y;
      if (y < box.min) box.min = y;
      if (y > box.max) box.max = y;
    });
    entry.height = Number.isFinite(box.max) ? +(box.max - box.min).toFixed(2) : 0;
    if (entry.plank) { planks++; plankHolders.push(label); }
    if (entry.skeleton) {
      skeletons.set(entry.skeleton, (skeletons.get(entry.skeleton) || 0) + 1);
      bones.set(entry.bone0, (bones.get(entry.bone0) || 0) + 1);
    }
    seen.push(entry);
    return entry;
  };

  describe('player', game.player?.mesh);
  game.enemies.forEach((e, i) => describe(`${e.isBoss ? 'boss' : 'enemy'}:${e.key}:${i}`, e.mesh));
  game.shadows.forEach((s, i) => describe(`shadow:${i}`, s.mesh));
  game.corpses.forEach((c, i) => describe(`corpse:${i}`, c.mesh));

  const info = game.renderer?.info;
  return {
    entries: seen,
    planks,
    plankHolders,
    sharedSkeletons: Array.from(skeletons.values()).filter((n) => n > 1).length,
    sharedBoneRoots: Array.from(bones.values()).filter((n) => n > 1).length,
    render: info ? {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    } : null,
    packStats: window.__creatures?.stats ? window.__creatures.stats() : null,
    characterStats: window.__characters?.stats ? window.__characters.stats() : null,
    enemies: game.enemies.length,
    gate: game.gate ? { rank: game.gate.rank, name: game.gate.name, boss: game.gate.boss } : null,
  };
}

/**
 * One frame's worth of renderer.info.
 *
 * Reading info straight out is useless here: the game composites through a
 * multi-pass bloom chain, three resets info at the top of every render() while
 * autoReset is on, so a naive read reports the LAST pass only — which is why
 * the first version of this tool printed "1 triangle". Turning autoReset off
 * and bracketing exactly one animation frame gives the whole frame, every pass
 * included. It is one frame, not an average, so treat it as an order of
 * magnitude rather than a benchmark.
 */
async function probeCost(game) {
  const info = game.renderer?.info;
  if (!info) return null;
  const wasAuto = info.autoReset;
  await new Promise((res) => requestAnimationFrame(() => {
    info.autoReset = false;
    info.reset();
    requestAnimationFrame(() => res());
  }));
  const snap = {
    calls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
  };
  info.autoReset = wasAuto;
  info.reset();
  return snap;
}

/**
 * Drag every enemy into a ring around the player so the screenshot is of the
 * monsters and not of an empty arena. This is the shot that answers "what does
 * an enemy actually look like now", which no counter can answer.
 */
function muster(game) {
  const p = game.player.pos;
  const n = Math.max(1, game.enemies.length);
  game.enemies.forEach((e, i) => {
    const a = (i / n) * Math.PI * 2 + 0.4;
    const r = e.isBoss ? 7 : 4.6;
    e.pos.set(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r);
    e.mesh.position.copy(e.pos);
    e.spawning = 0;
    e.yaw = Math.atan2(p.x - e.pos.x, p.z - e.pos.z);
  });
  return game.enemies.length;
}

function probeMixers(game) {
  const out = {};
  game.enemies.forEach((e, i) => {
    const inst = e.mesh?.userData?.character;
    if (inst?.mixer) out[`${e.key}:${i}`] = +inst.mixer.time.toFixed(4);
  });
  return out;
}

/**
 * Raise a shadow soldier next to the player.
 *
 * Shadows are the OTHER thing that used to hold the plank. With the pack live
 * a fresh record is dealt a creature key and rises as a bound creature clone;
 * the humanoid-ghost path (the plank's old home) is still reachable when the
 * pack is absent, so the plank assertion keeps its case either way.
 */
function summonShadow(game) {
  try {
    const p = game.player.pos;
    const v = p.clone();
    v.x += 2.5;
    return Boolean(game._spawnShadow(v, true));
  } catch (e) {
    return String(e.message || e);
  }
}

// Kill the boss-gating so the boss shows up without a full clear, then read it.
function forceBoss(game) {
  if (game.bossActive) return true;
  try {
    game.killed = game.gate.enemies;
    game._spawnBoss();
    return true;
  } catch (e) {
    return String(e.message || e);
  }
}

// ------------------------------------------------------------------ run

/** Poll a page-side predicate against window.__game. Resolves false on timeout. */
async function waitFor(page, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await evalGame(page, fn)) return true;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(400);
  }
  return false;
}

async function runGate(browser, { blockCreatures, tag }) {
  const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });
  // Three's Vector3 is not reachable from the page bridge, so hand the probe a
  // constructor it can call. The game already imports three, this just names it.
  await page.addInitScript(() => {
    window.THREE_V3 = function V3() { this.x = 0; this.y = 0; this.z = 0; };
    window.THREE_V3.prototype.set = function set(x, y, z) {
      this.x = x; this.y = y; this.z = z; return this;
    };
    window.THREE_V3.prototype.setFromMatrixPosition = function setFromMatrixPosition(m) {
      const e = m.elements; this.x = e[12]; this.y = e[13]; this.z = e[14]; return this;
    };
  });
  if (blockCreatures) {
    await page.route('**/models/creatures.glb', (route) => route.abort());
    await page.route('**/models/creatures.json', (route) => route.abort());
  }

  await gotoGame(page, { waitMs: 2600 });
  // Drive the API rather than the menu. The entry flow is title -> CITY ->
  // walk to a portal now, and this test is about what is INSIDE the gate;
  // tools/flow-test.mjs owns the walk. game.enterGate routes through AppState
  // exactly as the portal does, so the mounted mode is the real one.
  await evalGame(page, (g, [rank]) => {
    if (typeof g.enterGate === 'function') return g.enterGate(rank);
    return g.startGate(0);
  }, RANK);

  // Wait on the GAME's clock, not the wall clock. Under swiftshader with six
  // enemies and a C-rank arena this page runs at single-digit fps, and the
  // enemies' rise-from-the-floor spawn is skipped by animateRig entirely — so a
  // fixed sleep sampled two identical frames and reported every mixer as
  // stalled. That was the tool being impatient, not the mixers being broken.
  await waitFor(page, (g) => g.enemies.length > 0 && g.enemies.every((e) => (e.spawning || 0) <= 0));
  await waitFor(page, (g) => g.enemies.every((e) => (e.mesh?.userData?.character?.mixer?.time ?? 0) > 0));

  const shadowOk = await evalGame(page, summonShadow);
  await page.waitForTimeout(600);

  const first = await evalGame(page, probeField);
  const mixersA = await evalGame(page, probeMixers);
  // Two rendered frames is the real requirement; 2.5s buys that at 3 fps.
  await page.waitForTimeout(2500);
  const mixersB = await evalGame(page, probeMixers);

  const advanced = Object.keys(mixersB).filter((k) => (mixersB[k] ?? 0) > (mixersA[k] ?? 0));
  const stalled = Object.keys(mixersB).filter((k) => !(mixersB[k] > (mixersA[k] ?? -1)));

  const cost = await evalGame(page, probeCost);

  const shot = shotPath(`creatures-${tag}.png`);
  await page.screenshot({ path: shot });

  // Close-up muster: the only view that answers "what does an enemy look like".
  await evalGame(page, muster);
  await page.waitForTimeout(1500);
  const musterShot = shotPath(`creatures-${tag}-muster.png`);
  await page.screenshot({ path: musterShot });

  // The boss is the other half of the routing change and never appears in a
  // two-second sample, so it is forced.
  const bossOk = await evalGame(page, forceBoss);
  await page.waitForTimeout(1400);
  await evalGame(page, muster);
  await page.waitForTimeout(1400);
  const withBoss = await evalGame(page, probeField);
  const bossCost = await evalGame(page, probeCost);
  const bossShot = shotPath(`creatures-${tag}-boss.png`);
  await page.screenshot({ path: bossShot });

  await page.close();
  return {
    tag,
    blockCreatures,
    errors: errors.slice(0, 8),
    shadowOk,
    field: first,
    cost,
    boss: { forced: bossOk, field: withBoss, cost: bossCost },
    mixers: { advanced: advanced.length, stalled, sampleA: mixersA, sampleB: mixersB },
    shots: { play: shot, muster: musterShot, boss: bossShot },
  };
}

const fail = [];
const note = (ok, msg) => { if (!ok) fail.push(msg); return ok; };

const server = await ensureServer();
const browser = await launchBrowser();
let report;
try {
  // BEFORE: creatures.glb blocked. Proves the fallback still plays and gives a
  // like-for-like triangle/draw-call baseline in the same scene.
  const before = await runGate(browser, { blockCreatures: true, tag: 'fallback' });
  const after = await runGate(browser, { blockCreatures: false, tag: 'live' });

  const liveEnemies = after.field.entries.filter((e) => e.label.startsWith('enemy:'));
  const liveBoss = after.boss.field.entries.filter((e) => e.label.startsWith('boss:'));
  const livePlayer = after.field.entries.find((e) => e.label === 'player');
  const fallbackEnemies = before.field.entries.filter((e) => e.label.startsWith('enemy:'));

  note(after.errors.length === 0, `page errors in the live run: ${after.errors.join(' | ')}`);
  note(before.errors.length === 0, `page errors in the fallback run: ${before.errors.join(' | ')}`);
  note(liveEnemies.length > 0, 'no enemies spawned in the live run');
  note(
    liveEnemies.every((e) => e.backed === 'creature'),
    `enemies not creature-backed: ${liveEnemies.filter((e) => e.backed !== 'creature').map((e) => `${e.label}=${e.backed}`).join(', ')}`,
  );
  note(
    liveBoss.length > 0 && liveBoss.every((e) => e.backed === 'creature'),
    `boss not creature-backed: ${liveBoss.map((e) => `${e.label}=${e.backed}`).join(', ') || 'no boss'}`,
  );
  note(
    livePlayer?.backed === 'character',
    `the player should stay a character, got ${livePlayer?.backed}`,
  );
  const liveShadows = after.field.entries.filter((e) => e.label.startsWith('shadow:'));
  note(after.shadowOk === true, `could not raise a shadow soldier: ${after.shadowOk}`);
  // Bind raises the fallen's OWN figure: with the pack live a fresh record is
  // dealt a creature key (lazy migration) and takes the field as a dark
  // creature clone wearing the bound treatment. The humanoid ghost is now the
  // pack-absent fallback only — the old "must stay humanoid" contract died
  // with that feature.
  note(
    liveShadows.length > 0 && liveShadows.every((e) => e.backed === 'creature' && e.bound),
    `shadows must be bound creature clones, got ${liveShadows.map((e) => `${e.backed}${e.bound ? '+bound' : ''}`).join(', ') || 'none'}`,
  );
  // Bound clones keep (darkened) kit/native weapons but drop items.glb-kind
  // ones, so an empty fist is legal; the procedural plank never is.
  note(
    liveShadows.every((e) => !e.plank),
    `shadow soldiers holding the procedural plank: ${liveShadows.filter((e) => e.plank).map((e) => e.label).join(', ')}`,
  );
  note(after.field.sharedSkeletons === 0, `${after.field.sharedSkeletons} skeletons shared between instances`);
  note(after.field.sharedBoneRoots === 0, `${after.field.sharedBoneRoots} bone roots shared between instances`);
  note(after.mixers.stalled.length === 0, `mixers not advancing: ${after.mixers.stalled.join(', ')}`);
  note(after.field.planks === 0, `procedural plank still held by: ${after.field.plankHolders.join(', ')}`);
  note(
    after.boss.field.planks === 0,
    `procedural plank on the boss field: ${after.boss.field.plankHolders.join(', ')}`,
  );
  note(
    (after.field.packStats?.mergeFailures ?? 0) === 0,
    `creature geometry merge failures: ${after.field.packStats?.mergeFailures}`,
  );
  // The fallback must still be a playable gate, not a crash.
  note(fallbackEnemies.length > 0, 'the creatures-blocked fallback spawned no enemies');

  const perEnemy = (f) => {
    const es = f.entries.filter((e) => e.label.startsWith('enemy:'));
    if (!es.length) return 0;
    return Math.round(es.reduce((a, e) => a + e.triangles, 0) / es.length);
  };

  report = {
    when: new Date().toISOString(),
    rank: RANK,
    pass: fail.length === 0,
    failures: fail,
    triangles: {
      fallbackScene: before.cost?.triangles,
      liveScene: after.cost?.triangles,
      fallbackDrawCalls: before.cost?.calls,
      liveDrawCalls: after.cost?.calls,
      fallbackBossScene: before.boss.cost?.triangles,
      liveBossScene: after.boss.cost?.triangles,
      fallbackBossDrawCalls: before.boss.cost?.calls,
      liveBossDrawCalls: after.boss.cost?.calls,
      fallbackEnemies: before.field.enemies,
      liveEnemies: after.field.enemies,
      fallbackPerEnemy: perEnemy(before.field),
      livePerEnemy: perEnemy(after.field),
    },
    creatures: liveEnemies.map((e) => ({
      label: e.label,
      creature: e.creature,
      weaponSlot: e.weaponSlot,
      held: e.held,
      meshes: e.skinnedMeshes,
      triangles: e.triangles,
      height: e.height,
      state: e.state,
    })),
    boss: liveBoss.map((e) => ({
      label: e.label, creature: e.creature, weaponSlot: e.weaponSlot,
      held: e.held, triangles: e.triangles, height: e.height,
    })),
    shadows: liveShadows.map((e) => ({
      label: e.label, backed: e.backed, bound: e.bound, held: e.held, plank: e.plank, triangles: e.triangles,
    })),
    fallback: fallbackEnemies.map((e) => ({
      label: e.label, backed: e.backed, appearance: e.appearance,
      held: e.held, plank: e.plank, triangles: e.triangles,
    })),
    packStats: after.field.packStats,
    characterStats: after.field.characterStats,
    shots: { before: before.shots, after: after.shots },
    raw: { before, after },
  };
} finally {
  await browser.close();
  await server.stop();
}

const file = writeReport('creature-test.json', report);

console.log(`\ncreature-test  rank ${report.rank}  ->  ${report.pass ? 'PASS' : 'FAIL'}`);
console.log(`report      ${file}`);
console.log(`screenshots ${OUT}`);
console.log('\nmonsters on the field:');
for (const c of report.creatures) {
  console.log(`  ${c.label.padEnd(22)} ${String(c.creature).padEnd(18)} `
    + `${String(c.weaponSlot).padEnd(8)} held=${c.held.join('+') || '-'} `
    + `${c.meshes} mesh ${c.triangles} tris  h=${c.height}`);
}
for (const b of report.boss) {
  console.log(`  ${b.label.padEnd(22)} ${String(b.creature).padEnd(18)} `
    + `${String(b.weaponSlot).padEnd(8)} held=${b.held.join('+') || '-'} `
    + `${b.triangles} tris  h=${b.height}`);
}
console.log('\nshadow soldiers (bound creature clones, never the plank):');
for (const s of report.shadows) {
  console.log(`  ${s.label.padEnd(22)} ${s.backed.padEnd(10)} bound=${s.bound} plank=${s.plank} `
    + `held=${s.held.join('+') || '-'} ${s.triangles} tris`);
}
console.log('\nfallback (creatures.glb blocked):');
for (const f of report.fallback) {
  console.log(`  ${f.label.padEnd(22)} ${f.backed.padEnd(10)} plank=${f.plank} `
    + `held=${f.held.join('+') || '-'} ${f.triangles} tris`);
}
console.log('\ncost (one whole frame, every bloom pass included):');
const t = report.triangles;
console.log(`  scene triangles   fallback ${t.fallbackScene}  ->  live ${t.liveScene}`);
console.log(`  scene draw calls  fallback ${t.fallbackDrawCalls}  ->  live ${t.liveDrawCalls}`);
console.log(`  + boss triangles  fallback ${t.fallbackBossScene}  ->  live ${t.liveBossScene}`);
console.log(`  + boss draws      fallback ${t.fallbackBossDrawCalls}  ->  live ${t.liveBossDrawCalls}`);
console.log(`  per enemy tris    fallback ${t.fallbackPerEnemy}  ->  live ${t.livePerEnemy}`);
console.log(`  enemies on field  fallback ${t.fallbackEnemies}  ->  live ${t.liveEnemies}`);

if (!report.pass) {
  console.log('\nfailures:');
  for (const f of report.failures) console.log(`  - ${f}`);
}
fs.writeFileSync(shotPath('creature-test-summary.txt'), report.failures.join('\n'));
process.exit(report.pass ? 0 : 1);
