// tools/citylife-test.mjs — WORLD_SPEC steps 10 + 11: schedules, hunters, companion.
//
//   node tools/citylife-test.mjs [--no-shots] [--headed]
//
// Drives the REAL game (title -> PLAY -> CityMode) rather than a bare City,
// because everything here is clock-fed: City.applyDayState is what forwards the
// hour into Citizens.setPhaseHour, and a City built in an empty page never gets
// one. Setting game.worldClock and letting frames run is the only honest way to
// see a schedule change.
//
// What it asserts, and why each one is here:
//
//   * POPULATION per tier: 16 normally, 8 at a forced `low` — and at low the
//     crowd keeps BOTH kinds of person, because slicing the roster in order
//     would silently delete every hunter and nothing else would notice.
//   * NO GLOW ON ANY BODY. Mechanical scan of every material under every NPC
//     root: emissive must be black and the rim uniforms must be absent. This
//     includes the COMPANION's body — the wisp Points node is the single
//     exemption, by name, so the exemption cannot quietly widen.
//   * SCHEDULES actually move people: at dawn and at dusk a majority of freshly
//     picked civilian targets land near that phase's anchors, and at midday
//     they do not (the spec says day behaviour is unchanged).
//   * NIGHT DE-POP: >= 60% of civilians visible at noon, <= 50% at 23:00, and
//     never a flip while the citizen is on camera and close.
//   * The crowd stays inside the world across 30 s of simulation.
//   * HUNTER BEAT over a fast-forwarded hour: at least one full despawn ->
//     respawn cycle, never more than one hunter mid-beat, and never the portal
//     the player is standing at.
//   * COMPANION exists iff save.shadows.roster is non-empty, heels within
//     range, teleports when abandoned, and costs what it costs (reported).
//   * Three city rebuilds leak no geometries, textures or programs — with a
//     companion in the roster, which is the configuration that mints the extra
//     material, geometry and Points program.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');

// The companion is one skinned body + one Points node. Two draws for the body
// (creatures merge per material) plus the wisps is the ceiling; anything more
// means the material override stopped merging and the city has 3 draw calls of
// headroom left (step 9's report).
const COMPANION_DRAW_BUDGET = 5;

const fail = [];
let _t0 = Date.now();
const phase = (name) => {
  const now = Date.now();
  console.log(`  [${((now - _t0) / 1000).toFixed(1)}s] ${name}`);
  _t0 = now;
};
const ok = (cond, msg) => { if (!cond) fail.push(msg); return cond; };

const report = {};

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: true });
// Landscape: index.html's rotate gate swallows pointer events in portrait.
const { page, errors } = await newPhonePage(browser, { width: 900, height: 506, dpr: 1 });

/** Set the world clock and let the mode push it through applyDayState. */
async function setHour(h, settleMs = 260) {
  await page.evaluate((hh) => {
    window.__game.worldClock.setHours(hh);
    window.__game.mode._applyDay();
  }, h);
  await page.waitForTimeout(settleMs);
}

try {
  await gotoGame(page, { waitMs: 1600 });
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city'
    && window.__game.mode.city?.built, null, { timeout: 30000 });
  // RETARGET 2026-08-26: dismiss the first-arrival welcome (see _harness.dismissDialog)
  await page.evaluate(() => { const d = window.__game?.dialog; for (let i = 0; d?.open && i < 12; i++) d.advance(); });
  await page.waitForTimeout(900);
  // PIN THE TIER. The frame-rate governor is free to step the quality tier at
  // any moment, and it takes two things with it that this test measures: the
  // crowd size (8 at low) and the shadow define on every material in the scene
  // (a tier step recompiles programs and re-allocates the shadow map, which
  // reads as a leak). Everything below except the population section runs
  // against a pinned medium.
  await page.evaluate(async () => {
    const { setCharacterQuality } = await import('/src/render/characters.js');
    window.__game.quality?.lock?.('medium');
    setCharacterQuality('medium');
  });
  phase('city mounted');

  // ------------------------------------------------------------ population
  const pop = await page.evaluate(async () => {
    const { setCharacterQuality } = await import('/src/render/characters.js');
    const g = window.__game;
    const out = {};
    const build = async () => {
      g.mode.city.dispose();
      g.mode.city.build(g.mode._seed, g.save);
      await new Promise((r) => setTimeout(r, 120));
      const c = g.mode.city.citizens;
      return {
        stats: c.stats,
        // !n.station: the two frontier-camp hunters and the farmstead civilian
        // are stationed 200 m outside the wall and are not part of the TOWN
        // crowd these population asserts are about. citizens.stats.camp counts
        // them; frontier-test asserts they exist.
        hunters: c.npcs.filter((n) => n.hunter && !n.station).length,
        civilians: c.npcs.filter((n) => !n.hunter && !n.companion && !n.station).length,
        camp: c.stats.camp,
      };
    };
    const tier0 = 'medium';                 // pinned above
    out.normal = await build();
    setCharacterQuality('low');
    out.low = await build();
    // Hand the tier back, and rebuild once more so everything below runs
    // against the pinned configuration rather than the forced one.
    setCharacterQuality(tier0);
    out.restored = await build();
    out.tier = tier0;
    return out;
  });
  report.population = pop;
  console.log(`population  ${pop.tier}: ${pop.normal.stats.count} (${pop.normal.civilians} civ + ${pop.normal.hunters} hunters)`
    + `   forced low: ${pop.low.stats.count} (${pop.low.civilians} + ${pop.low.hunters})`);
  ok(pop.normal.stats.count === 16, `crowd is ${pop.normal.stats.count}, expected 16 at ${pop.tier}`);
  ok(pop.low.stats.count === 8, `crowd at forced low is ${pop.low.stats.count}, expected 8`);
  ok(pop.low.hunters >= 2 && pop.low.civilians >= 2,
    `low tier kept ${pop.low.civilians} civilians and ${pop.low.hunters} hunters — the crowd lost a whole kind of person`);
  ok(pop.restored.stats.count === 16, 'the tier did not restore to a full crowd');
  // WORLD_SPEC frontier.pois: camp_hunters_east is "... + 2 hunter NPCs at high
  // tier", camp_farmstead "... + 1 NPC". Both shipped as furniture once, with
  // the npcs field left sitting in frontier.js reaching nothing — hence a count,
  // not a screenshot.
  console.log(`frontier camps: ${JSON.stringify(pop.normal.stats.campPois)}`
    + `   forced low: ${pop.low.stats.camp}`);
  ok(pop.normal.stats.camp === 3,
    `the frontier camps hold ${pop.normal.stats.camp} people, expected 3`, pop.normal.stats.campPois);
  ok(pop.normal.stats.campPois.camp_hunters_east === 2
    && pop.normal.stats.campPois.camp_farmstead === 1,
    'the camps are populated per the spec table (2 hunters east, 1 at the outfarm)',
    pop.normal.stats.campPois);
  ok(pop.low.stats.camp === 0,
    `low tier spawned ${pop.low.stats.camp} camp NPCs — the spec gates them at high tier`);
  phase('population per tier');

  // -------------------------------------------------- the companion exists
  // Done HERE, before everything else, so every scan below (glow, leaks,
  // stability) covers the companion path rather than the roster-empty one.
  const bind = await page.evaluate(async () => {
    const { makeShadow, addShadow } = await import('/src/game/shadows.js');
    const g = window.__game;
    const emptyRoster = g.save.shadows.roster.length === 0;
    const before = g.mode.city.citizens.stats.companion;
    if (emptyRoster) {
      addShadow(g.save, makeShadow(g.save, { type: 'grunt', level: g.save.level || 1 }));
    }
    g.mode.city.dispose();
    g.mode.city.build(g.mode._seed, g.save);
    await new Promise((r) => setTimeout(r, 200));
    const sp = g.mode.city.spawnPoint();
    g.player.body.reset(sp.x, sp.y, sp.z);
    await new Promise((r) => setTimeout(r, 150));
    return {
      emptyRoster, before,
      after: g.mode.city.citizens.stats.companion,
      roster: g.save.shadows.roster.length,
      skinned: Boolean(g.mode.city.citizens.companion?.inst),
    };
  });
  report.bind = bind;
  console.log(`companion gate: roster ${bind.emptyRoster ? 'empty' : 'non-empty'} -> companion ${bind.before}`
    + `, after binding one -> ${bind.after} (skinned=${bind.skinned})`);
  ok(bind.emptyRoster ? bind.before === false : bind.before === true,
    'the companion did not follow save.shadows.roster emptiness');
  ok(bind.after === true, 'the roster has a shadow but no companion spawned');
  phase('companion gating');

  // --------------------------------------------------------- the glow scan
  // Mechanical, over every material under every NPC root. This is the hard
  // constraint of the whole project expressed as a test.
  const glow = await page.evaluate(() => {
    const g = window.__game;
    const offenders = [];
    let materials = 0, bodies = 0, exempt = 0;
    for (const n of g.mode.city.citizens.npcs) {
      bodies++;
      n.root.traverse((o) => {
        // The one sanctioned glow category: the companion's wisp particles,
        // exempted BY NODE NAME so a body can never inherit the exemption.
        if (o.name === 'companion_wisps') { exempt++; return; }
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of mats) {
          materials++;
          const e = m.emissive ? m.emissive.getHex() : 0;
          const rimmed = Boolean(m.rimUniforms || m.userData?.rim);
          if (e !== 0 || rimmed) {
            offenders.push({
              npc: n.companion ? 'companion' : (n.hunter ? 'hunter' : 'civilian'),
              node: o.name || o.type,
              emissive: `#${e.toString(16).padStart(6, '0')}`,
              rimmed,
            });
          }
        }
      });
    }
    return { offenders, materials, bodies, exempt };
  });
  report.glowScan = glow;
  console.log(`glow scan: ${glow.materials} materials over ${glow.bodies} bodies, ${glow.exempt} exempt wisp nodes, ${glow.offenders.length} offenders`);
  ok(glow.offenders.length === 0,
    `NPC bodies with emissive or a rim: ${JSON.stringify(glow.offenders.slice(0, 4))}`);
  ok(glow.materials > 0, 'the glow scan found no materials at all — it is not scanning anything');
  ok(glow.exempt === 1,
    `the scan saw ${glow.exempt} wisp nodes, expected exactly 1 — either the companion body is not being scanned or the exemption has spread`);
  phase('no-glow scan');

  // ------------------------------------------------------------- schedules
  // Ask _pickPoint itself, many times, at each phase. Watching sixteen people
  // walk for a simulated day would take a simulated day; the schedule IS the
  // target distribution, so measure that directly.
  const sched = await page.evaluate(async () => {
    const g = window.__game;
    const c = g.mode.city.citizens;
    const near = (x, z, list) => {
      let best = Infinity;
      for (const a of list) best = Math.min(best, Math.hypot(x - a.x, z - a.z));
      return best;
    };
    const sample = (hour, phaseName) => {
      c.setPhaseHour(hour);
      const list = c._anchors[phaseName] || [];
      let hits = 0;
      const N = 400;
      const out = { x: 0, z: 0 };
      for (let i = 0; i < N; i++) {
        // phaseOff 0: the jitter is per-NPC and would smear the measurement
        // across the boundary; the sampled hours below are mid-phase anyway.
        c._pickPoint(false, c._rnd, null, out, 0);
        if (near(out.x, out.z, list) < 6) hits++;
      }
      return { hits, n: N, frac: hits / N, anchors: list.length };
    };
    return {
      anchors: {
        dawn: c._anchors.dawn.length,
        dusk: c._anchors.dusk.length,
        night: c._anchors.night.length,
      },
      gates: c._gates.slice(),
      dawn: sample(6, 'dawn'),
      day: sample(12, 'dawn'),      // measured against DAWN anchors on purpose
      dayVsDusk: sample(12, 'dusk'),
      dusk: sample(18.5, 'dusk'),
      night: sample(23, 'night'),
    };
  });
  report.schedules = sched;
  console.log(`anchors dawn=${sched.anchors.dawn} dusk=${sched.anchors.dusk} night=${sched.anchors.night}   gates=${sched.gates.length}`);
  console.log(`  targets near anchors: dawn ${(sched.dawn.frac * 100).toFixed(0)}%  dusk ${(sched.dusk.frac * 100).toFixed(0)}%`
    + `  night ${(sched.night.frac * 100).toFixed(0)}%   (noon vs the same lists: ${(sched.day.frac * 100).toFixed(0)}% / ${(sched.dayVsDusk.frac * 100).toFixed(0)}%)`);
  ok(sched.anchors.dawn >= 3 && sched.anchors.dusk >= 2 && sched.anchors.night >= 3,
    `an anchor list came out empty or nearly so: ${JSON.stringify(sched.anchors)} — the bake fell back to the plaza`);
  ok(sched.gates.length >= 2, `only ${sched.gates.length} wall gates were found by probe`);
  // The bias is 0.6/0.6/0.7 with 5 m of spread on top, so "most of them" is the
  // honest bar; the point is the phase moves the crowd, not that it herds it.
  ok(sched.dawn.frac >= 0.5, `dawn only aimed ${(sched.dawn.frac * 100).toFixed(0)}% of legs at the market`);
  ok(sched.dusk.frac >= 0.5, `dusk only aimed ${(sched.dusk.frac * 100).toFixed(0)}% of legs at Quarter Row`);
  ok(sched.night.frac >= 0.6, `night only aimed ${(sched.night.frac * 100).toFixed(0)}% of legs at the lanterns`);
  ok(sched.dawn.frac > sched.day.frac + 0.25,
    `dawn (${sched.dawn.frac.toFixed(2)}) is not meaningfully different from noon (${sched.day.frac.toFixed(2)}) — the schedule is not biting`);
  ok(sched.dusk.frac > sched.dayVsDusk.frac + 0.25,
    `dusk (${sched.dusk.frac.toFixed(2)}) is not meaningfully different from noon (${sched.dayVsDusk.frac.toFixed(2)})`);
  phase('schedule bias');

  // ------------------------------------------------------------ night pop
  await setHour(12, 700);
  const noon = await page.evaluate(() => {
    const c = window.__game.mode.city.citizens;
    const civ = c.npcs.filter((n) => !n.hunter && !n.companion && !n.station);
    return { visible: civ.filter((n) => n.root.visible).length, total: civ.length, phase: c.stats.phase };
  });
  // Park the player far from the crowd so the "off camera AND >25 m" rule can
  // actually fire, then give the scan several intervals to walk everyone.
  await page.evaluate(() => {
    const g = window.__game;
    const city = g.mode.city;
    g.player.body.reset(-60, city.heightAt(-60, -60) + 0.1, -60);
  });
  await setHour(23, 400);
  await page.waitForTimeout(3200);
  const night = await page.evaluate(() => {
    const c = window.__game.mode.city.citizens;
    const civ = c.npcs.filter((n) => !n.hunter && !n.companion && !n.station);
    return {
      visible: civ.filter((n) => n.root.visible).length,
      total: civ.length,
      phase: c.stats.phase,
      hunters: c.npcs.filter((n) => n.hunter && !n.station && n.root.visible).length,
    };
  });
  report.nightPop = { noon, night };
  console.log(`civilians visible: noon ${noon.visible}/${noon.total} (${noon.phase})   23:00 ${night.visible}/${night.total} (${night.phase}), hunters out ${night.hunters}`);
  ok(noon.visible / noon.total >= 0.6, `only ${noon.visible}/${noon.total} civilians are out at noon`);
  ok(night.visible / night.total <= 0.5, `${night.visible}/${night.total} civilians are still out at 23:00 — the night de-pop did not fire`);
  ok(night.hunters >= 3, `only ${night.hunters} hunters are out at night — hunters are supposed to be unaffected`);

  // Never de-pop in view: stand IN the crowd at night and confirm nobody
  // vanishes off the player's own screen.
  const inView = await page.evaluate(async () => {
    const g = window.__game;
    const c = g.mode.city.citizens;
    // Teleport to whichever visible civilian is nearest the plaza and watch.
    const civ = c.npcs.filter((n) => !n.hunter && !n.companion && !n.station && n.root.visible);
    if (!civ.length) return { watched: 0, vanished: 0 };
    const target = civ[0];
    g.player.body.reset(target.pos.x + 2.0, g.mode.city.heightAt(target.pos.x + 2, target.pos.z) + 0.1, target.pos.z + 2.0);
    const before = civ.map((n) => n.root.visible);
    for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
    let vanished = 0;
    civ.forEach((n, i) => {
      const d = Math.hypot(n.pos.x - g.player.pos.x, n.pos.z - g.player.pos.z);
      if (before[i] && !n.root.visible && d < 25) vanished++;
    });
    return { watched: civ.length, vanished };
  });
  report.nightInView = inView;
  console.log(`de-pop in view: ${inView.vanished} of ${inView.watched} watched civilians vanished within 25 m`);
  ok(inView.vanished === 0, `${inView.vanished} citizens de-popped inside the 25 m no-pop radius`);
  phase('night population');

  // ------------------------------------------------------------- stability
  //
  // From here on the simulation is STEPPED rather than rendered: Citizens.update
  // is called directly with a fixed dt, which is the same function City.update
  // calls with the same arguments. Through SwiftShader the rendered loop runs at
  // ~15 fps and the frame clock scales game time down with it, so "30 seconds"
  // of rendered test is about 7 seconds of world — and the hunter beat's away
  // timer alone is 30-90 s of world. Stepping measures the behaviour honestly
  // instead of measuring the software rasteriser.
  const stable = await page.evaluate(async () => {
    const g = window.__game;
    const c = g.mode.city.citizens;
    const p = g.player.pos;
    let bad = 0, worst = 0, campWorst = 0;
    const DT = 1 / 30;
    for (let i = 0; i < 900; i++) {          // 30 s of world time
      c.update(DT, p);
      if (i % 10) continue;
      for (const n of c.npcs) {
        if (!Number.isFinite(n.pos.x) || !Number.isFinite(n.pos.z) || !Number.isFinite(n.pos.y)) { bad++; continue; }
        // A frontier camper LIVES at 200 m, so the town's edge bar is not his
        // bar. His is "did he stay at his camp", measured off his own post.
        if (n.station) {
          const d = Math.hypot(n.pos.x - n.station.x, n.pos.z - n.station.z);
          if (d > campWorst) campWorst = d;
          continue;
        }
        const r = Math.max(Math.abs(n.pos.x), Math.abs(n.pos.z));
        if (r > worst) worst = r;
      }
      if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return {
      bad, worst: +worst.toFixed(1), campWorst: +campWorst.toFixed(1),
      count: c.npcs.length, campers: c.campers.length,
    };
  });
  report.stability = stable;
  console.log(`30 s simulation: ${stable.bad} non-finite samples, furthest citizen ${stable.worst} m from the centre`);
  ok(stable.bad === 0, `${stable.bad} NPC positions went non-finite`);
  // WALK_LIMIT is 134 without a frontier and VERGE_LIMIT 258 with one; the
  // crowd should never leave the town, so this bar is the town's own edge.
  ok(stable.worst < 140, `a citizen walked to ${stable.worst} m — outside the town resolve() is meant to hold`);
  // The campers' own bar: CAMP_RADIUS is 5 m and resolve() can push a metre or
  // two off a fence, so anything past 12 m means a camper is walking to town.
  ok(stable.campWorst < 12,
    `a frontier camper wandered ${stable.campWorst} m from his post over 30 s`);
  phase('30 s stability');

  // -------------------------------------------------- determinism + mixer
  const det = await page.evaluate(async () => {
    const g = window.__game;
    const snap = async () => {
      g.mode.city.dispose();
      g.mode.city.build(20260806, g.save);
      await new Promise((r) => setTimeout(r, 140));
      const c = g.mode.city.citizens;
      return JSON.stringify({
        npcs: c.npcs.map((n) => [+n.pos.x.toFixed(4), +n.pos.z.toFixed(4), +n.phaseOff.toFixed(4), n.hunter, n.companion]),
        anchors: [c._anchors.dawn.length, c._anchors.dusk.length, c._anchors.night.length],
        gates: c._gates.map((q) => [q.x, q.z]),
      });
    };
    const a = await snap();
    const b = await snap();

    // The half-rate mixer past 30 m. Spy on the real call rather than trusting
    // the flag: this is a CPU saving and the only proof is fewer calls.
    const c = g.mode.city.citizens;
    const far = c.npcs.find((n) => n.inst && !n.companion);
    let calls = 0;
    const orig = far.inst.animate.bind(far.inst);
    far.inst.animate = (o) => { calls++; return orig(o); };
    // Park the camera 80 m away from him; the citizen keeps steering either way.
    g.mode.city.camera.position.set(far.pos.x + 80, 20, far.pos.z + 80);
    g.mode.city.camera.updateMatrixWorld();
    for (let i = 0; i < 60; i++) c.update(1 / 30, g.player.pos);
    const farCalls = calls;
    calls = 0;
    g.mode.city.camera.position.set(far.pos.x + 4, 6, far.pos.z + 4);
    g.mode.city.camera.updateMatrixWorld();
    for (let i = 0; i < 60; i++) c.update(1 / 30, g.player.pos);
    const nearCalls = calls;
    far.inst.animate = orig;
    return { same: a === b, farCalls, nearCalls };
  });
  report.determinism = det;
  console.log(`determinism: two builds of seed 20260806 identical = ${det.same}`
    + `   mixer calls over 60 steps: ${det.nearCalls} near / ${det.farCalls} far`);
  ok(det.same, 'two City.build(20260806) runs produced different citizens — generation is not deterministic');
  ok(det.nearCalls >= 55, `a citizen next to the camera only animated ${det.nearCalls}/60 steps`);
  ok(det.farCalls <= det.nearCalls * 0.6,
    `a citizen 80 m from the camera animated ${det.farCalls}/60 steps — the half-rate mixer throttle is not firing`);
  phase('determinism + mixer throttle');

  // ----------------------------------------------------------- hunter beat
  // Fast-forward the beat instead of waiting for it: the roll is in GAME hours
  // and setPhaseHour is what banks them, so feeding hours directly exercises
  // exactly the production path at 60x.
  const beat = await page.evaluate(async () => {
    const g = window.__game;
    // A level-1 save has exactly ONE unlocked gate, and the test stands the
    // player on it — so the "never the prompted portal" rule correctly leaves
    // the hunter nothing to walk to and the beat never fires. That is right
    // behaviour and a useless measurement, so give the save the ranks a player
    // who has bound a shadow would actually have.
    g.save.level = Math.max(g.save.level || 1, 24);
    g.mode.city.dispose();
    g.mode.city.build(g.mode._seed, g.save);
    await new Promise((r) => setTimeout(r, 200));
    const c = g.mode.city.citizens;
    const unlocked = g.mode.city.portals.filter((p) => !p.locked && !p.wild).length;
    // Stand the player ON a portal so the "never the prompted portal" rule has
    // something to refuse.
    const p0 = g.mode.city.portals.find((p) => !p.locked && !p.wild);
    if (p0) g.player.body.reset(p0.pos.x, g.mode.city.heightAt(p0.pos.x, p0.pos.z) + 0.1, p0.pos.z);
    // Put the hunters on the plaza first. The beat is real behaviour either
    // way, but a hunter who rolls his beat from the Breach road spends a
    // minute walking and the test would be measuring pathing, not the beat.
    let k = 0;
    for (const n of c.npcs) {
      if (!n.hunter || n.station) continue;   // camp hunters keep their post
      const a = (k++ / 6) * Math.PI * 2;
      n.pos.set(Math.cos(a) * 14, 0, Math.sin(a) * 14);
      n.pos.y = g.mode.city.heightAt(n.pos.x, n.pos.z);
      n.root.position.copy(n.pos);
      n.root.visible = true;
      // Clean slate: the sections above already stepped the world, so a hunter
      // can be mid-beat here and a half-observed cycle would prove nothing.
      n.beat = 0;
      n.beatPortal = null;
      n.beatT = 0;
      n.beatIn = 0.01;      // roll on the next frame
      n.root.scale.setScalar(n.baseScale);
    }
    c._beatBusy = null;

    let hour = 12;
    let cycles = 0, maxBusy = 0, promptedPicks = 0, faced = 0, picks = 0;
    const seen = new Set();
    const wasGone = new Map();
    const prevBeat = new Map();
    const DT = 1 / 30;
    const t0 = Date.now();
    // Stepped, not rendered (see the stability note): one full beat is a walk
    // plus 4-8 s of standing plus 30-90 s away, which is minutes of world time.
    // The clock is advanced by hand at the same time so the ROLL — which counts
    // in game hours — fires too.
    let steps = 0;
    while (steps < 40000 && (cycles < 1 || picks < 1)) {
      steps++;
      hour += 0.01;
      c.setPhaseHour(hour % 24);
      c.update(DT, g.player.pos);
      if (steps % 300 === 0) await new Promise((r) => setTimeout(r, 0));
      let busy = 0;
      for (const n of c.npcs) {
        if (!n.hunter || n.station) continue;
        if (n.beat !== 0) busy++;
        if (n.beat === 2) faced++;
        // Measure the PICK, not the frames after it: the rule is about which
        // portal he chooses given where the player is standing at that moment.
        if (prevBeat.get(n) === 0 && n.beat === 1 && n.beatPortal) {
          picks++;
          seen.add(n.beatPortal.rank);
          const prompted = g.mode.city.portalAt(g.player.pos);
          if (prompted && n.beatPortal === prompted) promptedPicks++;
        }
        prevBeat.set(n, n.beat);
        const gone = n.beat === 4;
        if (wasGone.get(n) && !gone && n.root.visible) cycles++;
        wasGone.set(n, gone);
      }
      maxBusy = Math.max(maxBusy, busy);
    }
    return {
      cycles, maxBusy, promptedPicks, faced, picks,
      portals: Array.from(seen),
      elapsedMs: Date.now() - t0,
      worldSeconds: Math.round(steps * DT),
      unlocked,
      standingOn: p0 ? p0.rank : null,
      prompted: g.mode.city.portalAt(g.player.pos)?.rank ?? null,
    };
  });
  report.beat = beat;
  console.log(`hunter beat: ${beat.cycles} full despawn->respawn cycle(s) over ${beat.worldSeconds}s of world time (${(beat.elapsedMs / 1000).toFixed(0)}s wall)`
    + `, ${beat.picks} picks over ${beat.unlocked} unlocked town portals, max concurrent ${beat.maxBusy}, used ${JSON.stringify(beat.portals)}`
    + `, player prompted at ${beat.prompted} (standing on ${beat.standingOn})`);
  ok(beat.prompted !== null,
    'the player was not actually standing at a portal, so the "never the prompted portal" rule was never exercised');
  ok(beat.cycles >= 1, 'no hunter completed a despawn -> respawn cycle over a fast-forwarded hour');
  ok(beat.maxBusy <= 1, `${beat.maxBusy} hunters were mid-beat at once — the rule is one`);
  ok(beat.picks >= 1, 'no hunter ever rolled a portal beat');
  ok(beat.promptedPicks === 0, `a hunter chose the portal the player was prompted at (${beat.promptedPicks} of ${beat.picks} picks)`);
  ok(beat.faced > 0, 'no hunter was ever observed standing and facing a gate');
  phase('hunter portal beat');

  // -------------------------------------------------------------- companion
  const comp = await page.evaluate(async () => {
    const g = window.__game;
    const c = g.mode.city.citizens;
    const n = c.companion;
    const sp = g.mode.city.spawnPoint();
    g.player.body.reset(sp.x, sp.y, sp.z);
    await new Promise((r) => setTimeout(r, 200));

    // Walk a lap of the plaza at 6 m/s — the player's OWN top speed from
    // config.js DERIVED, so this is the hardest case the hub can produce.
    // Stepped, like everything else from the stability section on.
    const DT = 1 / 30;
    const R = 11, SPEED = 6.0;
    const lap = (2 * Math.PI * R) / SPEED;
    let worst = 0, idleSeen = 0;
    // Two laps: the first is the catch-up from standing, the second is the
    // steady state, and only a companion that keeps station passes both.
    for (let s = 0; s < Math.round((lap * 2) / DT); s++) {
      const a = ((s * DT) / lap) * Math.PI * 2;
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      g.player.pos.set(x, g.mode.city.heightAt(x, z) + 0.1, z);
      c.update(DT, g.player.pos);
      if (s * DT > lap) worst = Math.max(worst, Math.hypot(n.pos.x - g.player.pos.x, n.pos.z - g.player.pos.z));
    }
    // Stand still: he should settle at heel rather than orbiting.
    for (let i = 0; i < 300; i++) {
      c.update(DT, g.player.pos);
      if (i >= 120 && Math.hypot(n.pos.x - g.player.pos.x, n.pos.z - g.player.pos.z) < 3.2) idleSeen++;
    }
    // Abandon him: past 25 m he steps out of the player's shadow instead of
    // jogging the length of the town.
    g.player.pos.set(70, g.mode.city.heightAt(70, 60) + 0.1, 60);
    c.update(DT, g.player.pos);
    const afterTeleport = Math.hypot(n.pos.x - g.player.pos.x, n.pos.z - g.player.pos.z);
    g.player.body.reset(g.player.pos.x, g.player.pos.y, g.player.pos.z);

    // He does not follow you indoors: the door gap is sized for one body.
    // Stand the player at the tavern counter, with the mode's own inside flag
    // set, and check where the shadow waits.
    const b = g.mode.city.interiors?.byId?.get('tavern_row');
    let indoor = null;
    if (b) {
      g.mode.city.interiors.setInside(b.id);
      g.player.pos.set(b.cx, g.mode.city.heightAt(b.cx, b.cz) + 0.1, b.cz);
      for (let i = 0; i < 400; i++) c.update(DT, g.player.pos);
      indoor = {
        insideFootprint: n.pos.x > b.x0 && n.pos.x < b.x1 && n.pos.z > b.z0 && n.pos.z < b.z1,
        toDoor: +Math.hypot(n.pos.x - b.door.outX, n.pos.z - b.door.outZ).toFixed(2),
      };
      g.mode.city.interiors.setInside(null);
    }

    // What it costs, by hiding it and re-sampling.
    const sample = async (on) => {
      n.root.visible = on;
      let calls = 0, tris = 0;
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (i >= 6) { calls += g.renderer.info.render.calls; tris += g.renderer.info.render.triangles; }
      }
      return { calls: Math.round(calls / 10), tris: Math.round(tris / 10) };
    };
    g.player.body.reset(0, g.mode.city.heightAt(0, 8) + 0.1, 8);
    for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
    const withHim = await sample(true);
    const without = await sample(false);
    n.root.visible = true;

    return {
      after: c.stats.companion,
      roster: g.save.shadows.roster.length,
      skinned: Boolean(n.inst),
      worstFollow: +worst.toFixed(2),
      idleSeen,
      indoor,
      afterTeleport: +afterTeleport.toFixed(2),
      wisps: Boolean(n.root.getObjectByName('companion_wisps')),
      draws: withHim.calls - without.calls,
      tris: withHim.tris - without.tris,
      crowd: c.stats.count,
    };
  });
  report.companion = comp;
  console.log(`companion: exists=${comp.after} skinned=${comp.skinned} wisps=${comp.wisps}`
    + `  worst follow gap ${comp.worstFollow} m, settled ${comp.idleSeen}/180 steps, after abandonment ${comp.afterTeleport} m`
    + `  cost +${comp.draws} draws / +${comp.tris} tris`);
  ok(comp.after === true, 'the roster has a shadow but no companion spawned');
  ok(comp.crowd === 16, `the companion was folded into the crowd count (${comp.crowd}, expected 16)`);
  ok(comp.wisps, 'the companion has no wisp node');
  ok(comp.worstFollow < 8, `the companion fell ${comp.worstFollow} m behind a player circling the plaza at 6 m/s`);
  if (comp.indoor) {
    console.log(`  indoors: companion inside the tavern footprint = ${comp.indoor.insideFootprint}, ${comp.indoor.toDoor} m from its door pad`);
    ok(!comp.indoor.insideFootprint, 'the companion walked into the tavern — he is meant to wait at the door');
    ok(comp.indoor.toDoor < 4.0, `the companion parked ${comp.indoor.toDoor} m from the tavern door, not at it`);
  }
  ok(comp.idleSeen >= 170, `the companion only settled at heel for ${comp.idleSeen}/180 steps with the player standing still`);
  ok(comp.afterTeleport <= 4.0, `after being abandoned the companion is ${comp.afterTeleport} m away — the 25 m teleport did not fire`);
  ok(comp.draws <= COMPANION_DRAW_BUDGET, `the companion costs ${comp.draws} draw calls, budget ${COMPANION_DRAW_BUDGET}`);
  phase('companion');

  // ------------------------------------------------------------ leak check
  //
  // Measured as a CURVE, not as a before/after pair. Both counters climb for
  // the first rebuild or two purely from lazy allocation — three creates a
  // program and uploads a skeleton's bone texture the first time an object is
  // actually rendered, and the companion's wisps are the last thing in the city
  // to be drawn. A before/after pair cannot tell that apart from a leak; a leak
  // grows on EVERY rebuild, so the assert is that the tail is flat.
  //
  // NINE rebuilds, not seven. The warm-up is per SKINNED INSTANCE (three uploads
  // a bone texture the first time each one is rendered) and the crowd grew by
  // the three frontier campers, which pushed the last of the lazy uploads into
  // rebuild 4 often enough to fail a four-sample tail measured from seven. The
  // property is unchanged and still strict — four consecutive identical
  // readings, and a real leak grows on every rebuild — the warm-up simply gets
  // the room it now needs.
  const leak = await page.evaluate(async () => {
    const g = window.__game;
    const rebuild = async () => {
      g.mode.city.dispose();
      g.mode.city.build(g.mode._seed, g.save);
      await new Promise((r) => setTimeout(r, 150));
    };
    const sp = g.mode.city.spawnPoint();
    g.player.body.reset(sp.x, sp.y, sp.z);
    g.mode._insideId = null;
    const curve = [];
    for (let i = 0; i < 9; i++) {
      await rebuild();
      await new Promise((r) => setTimeout(r, 380));
      curve.push({
        i,
        geometries: g.renderer.info.memory.geometries,
        textures: g.renderer.info.memory.textures,
        programs: g.renderer.info.programs.length,
      });
    }
    return { curve, stats: g.mode.city.citizens.stats, roster: g.save.shadows.roster.length };
  });
  report.leak = leak;
  const tail = leak.curve.slice(-4);
  const flat = (k) => tail.every((r) => r[k] === tail[0][k]);
  console.log(`rebuild x9 (roster ${leak.roster}):`);
  console.log(`  geometries ${leak.curve.map((r) => r.geometries).join(' ')}`);
  console.log(`  textures   ${leak.curve.map((r) => r.textures).join(' ')}`);
  console.log(`  programs   ${leak.curve.map((r) => r.programs).join(' ')}`);
  ok(flat('geometries'), `geometries still growing over the last four rebuilds: ${tail.map((r) => r.geometries).join(' ')}`);
  ok(flat('textures'), `textures still growing over the last four rebuilds: ${tail.map((r) => r.textures).join(' ')}`);
  ok(flat('programs'), `the program cache is still growing over the last four rebuilds: ${tail.map((r) => r.programs).join(' ')}`);
  ok(leak.stats.count === 16 && leak.stats.companion === true,
    `after seven rebuilds the crowd is ${JSON.stringify(leak.stats)}`);
  phase('leak check');

  // ---------------------------------------------------------- screenshots
  const shots = [];
  if (SHOTS) {
    const views = [
      { name: 'citylife-companion-plaza', hour: 15, at: 'companion' },
      { name: 'citylife-dawn-market', hour: 6, at: 'market' },
      { name: 'citylife-dusk-row', hour: 18.5, at: 'row' },
      { name: 'citylife-night-lanterns', hour: 22, at: 'plaza' },
      { name: 'citylife-hunter-portal', hour: 15, at: 'portal' },
    ];
    for (const v of views) {
      await setHour(v.hour, 200);
      await page.evaluate((view) => {
        const g = window.__game;
        const city = g.mode.city;
        const c = city.citizens;
        let x = 6, z = 16, yaw = Math.PI;
        if (view.at === 'companion' && c.companion) {
          // Walk the player across the plaza first so the companion ends up
          // trailing him properly, then frame the pair from the SIDE: with the
          // camera directly behind the player the shadow at his heel is the one
          // thing guaranteed to be under the camera and out of shot.
          const n = c.companion;
          n.pos.set(6, city.heightAt(6, 20), 20);
          for (let s = 0; s < 240; s++) {
            const zz = 20 - (s / 240) * 8;
            g.player.pos.set(4, city.heightAt(4, zz) + 0.1, zz);
            c.update(1 / 30, g.player.pos);
          }
          x = g.player.pos.x; z = g.player.pos.z;
          yaw = Math.PI;                       // walking toward -z
          window.__shotSide = true;
        } else if (view.at === 'market' || view.at === 'row' || view.at === 'plaza') {
          // SIMULATE the phase first, then frame whatever the crowd did. A shot
          // taken at the anchor the instant the clock changes shows an empty
          // street and proves nothing — the people have to have walked there.
          const key = view.at === 'market' ? 'dawn' : (view.at === 'row' ? 'dusk' : 'night');
          const civ = c.npcs.filter((n) => !n.hunter && !n.companion && !n.station);
          for (const n of civ) c._newTarget(n);
          const DT = 1 / 30;
          for (let s = 0; s < 4500; s++) {          // 150 s of world time
            c.setPhaseHour(view.hour);
            c.update(DT, g.player.pos);
          }
          // Frame the citizen who is closest to one of this phase's anchors,
          // and count how many of his colleagues are with him — a centroid of
          // "everyone near an anchor" can land on empty pavement between two
          // groups, which is exactly the shot this replaced.
          const list = c._anchors[key];
          let bestN = null, bestD = Infinity, near = 0;
          for (const n of civ) {
            if (!n.root.visible) continue;
            let d = Infinity;
            for (const a of list) d = Math.min(d, Math.hypot(n.pos.x - a.x, n.pos.z - a.z));
            if (d < 10) near++;
            if (d < bestD) { bestD = d; bestN = n; }
          }
          const cx = bestN ? bestN.pos.x : list[0].x;
          const cz = bestN ? bestN.pos.z : list[0].z;
          window.__shotInfo = { key, near, total: civ.length, bestD: +bestD.toFixed(1) };
          // Stand back along the vector from town centre so the camera looks in
          // at the gathering rather than at the nearest wall.
          const len = Math.hypot(cx, cz) || 1;
          x = cx + (cx / len) * 8;
          z = cz + (cz / len) * 8;
          yaw = Math.atan2(cx - x, cz - z);
        } else if (view.at === 'portal') {
          // Drive the REAL beat rather than posing a hunter: park him next to
          // an unlocked dais, roll his beat, and step until he is actually
          // standing in front of it (BEAT_FACE). A hand-placed body would show
          // the stand-off distance the shot code guessed, not the one the
          // implementation uses.
          const p = city.portals.find((q) => !q.locked && !q.wild) || city.portals[0];
          const h = c.npcs.find((n) => n.hunter && !n.station);
          if (h) {
            const len = Math.hypot(p.pos.x, p.pos.z) || 1;
            h.pos.set(p.pos.x - (p.pos.x / len) * 12, 0, p.pos.z - (p.pos.z / len) * 12);
            h.pos.y = city.heightAt(h.pos.x, h.pos.z);
            // beatIn <= 0 is the roll condition, and it only ticks down when the
            // CLOCK moves — a constant hour banks zero game hours, so the timer
            // is put past zero directly and the hour still nudged forward.
            h.beat = 0; h.beatPortal = null; h.beatT = 0; h.beatIn = -1;
            h.root.visible = true;
            c._beatBusy = null;
            // Keep the player away so his own prompt cannot veto this portal.
            g.player.pos.set(0, city.heightAt(0, 40) + 0.1, 40);
            let hh = 15;
            for (let s = 0; s < 4000 && h.beat !== 2; s++) {
              hh += 0.0005;
              c.setPhaseHour(hh);
              c.update(1 / 30, g.player.pos);
            }
          }
          const px = h ? h.pos.x : p.pos.x;
          const pz = h ? h.pos.z : p.pos.z;
          const l2 = Math.hypot(px, pz) || 1;
          // Stand INSIDE the ring and look outward, so the hunter and the dais
          // he is facing are both in frame.
          x = px - (px / l2) * 8 + 2;
          z = pz - (pz / l2) * 8;
          yaw = Math.atan2(px - x, pz - z);
        }
        g.player.body.reset(x, city.heightAt(x, z) + 0.1, z);
        g.player.yaw = yaw;
        // look.yaw orbits the camera BEHIND the player (interior-test uses the
        // same convention with the door's outward normal), so the camera has to
        // sit opposite the thing being framed or it looks back at his face.
        g.input.look.yaw = yaw + Math.PI + (window.__shotSide ? Math.PI * 0.45 : 0);
        window.__shotSide = false;
        g.input.look.pitch = 0.12;
        g.mode._camReady = false;
      }, v);
      await page.waitForTimeout(1200);
      const p = shotPath(`${v.name}.png`);
      await page.screenshot({ path: p });
      const info = await page.evaluate(() => {
        const i = window.__shotInfo; window.__shotInfo = null; return i;
      });
      shots.push({ name: v.name, path: p, info });
      console.log(`shot ${v.name.padEnd(28)} ${info ? `${info.near}/${info.total} civilians within 10 m of a ${info.key} anchor` : ''}`);
    }
  }
  report.shots = shots;
  phase('screenshots');

  report.errors = errors;
  ok(errors.length === 0, `page errors: ${errors.slice(0, 2).join(' | ')}`);
} catch (e) {
  fail.push(`threw: ${e.message}\n${e.stack}`);
} finally {
  report.fail = fail;
  const file = writeReport('citylife-test.json', report);
  console.log(`report -> ${file}`);
  await browser.close();
  await server.stop();
}

if (fail.length) {
  console.error(`\nFAIL — ${fail.length} problem(s):`);
  for (const f of fail) console.error(`  * ${f}`);
  process.exit(1);
}
console.log('\nPASS — schedules, hunters and the companion');
