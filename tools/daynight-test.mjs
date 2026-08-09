// tools/daynight-test.mjs — the day/night cycle, in the running game.
//
//   node tools/daynight-test.mjs [--headed] [--no-shots] [--no-swiftshader]
//
// WORLD_SPEC step 3's VERIFY clause. Four things are worth a test here and
// they are all regressions this repo has actually shipped before:
//
//   * THE 15:00 CONTRACT. The owner signed off on one frame. daynight.js
//     asserts the SAMPLER reproduces its constants; this asserts the LIVE CITY
//     does — that applyDayState at 15:00 leaves scene.fog, the hemisphere, the
//     key light and the shadow aim holding the exact numbers city.js used to
//     hardcode. Identity, not tolerance: "close enough" is how a signed-off
//     frame drifts one keyframe edit at a time.
//
//   * PROGRAM-COUNT INVARIANCE across a full 24 h. three bakes the light count,
//     the shadow-casting-light count and every material feature flag into its
//     program cache key. A "moon light" at dusk, or a castShadow toggled when
//     the sun sets, recompiles every material in the scene mid-frame on a
//     phone — and the profile blames the draw call, not the cause. If this
//     number moves, something in the cycle is doing structural work.
//
//   * LUMINANCE ORDERING WITH A FLOOR. Night must be darker than dusk which
//     must be darker than noon — and night must NOT be black. city.js's glow
//     postmortem is the reason: the additive composite lands visibly above
//     black, so a dark base frame reads as coloured haze over the whole
//     screen. The floor is the blue hour.
//
//   * THE DUSK PORTAL POP happening in the PORTALS' own materials. If the
//     portals get brighter at dusk because someone raised the global glow
//     strength instead, that is the wash bug wearing a different hat.
//
// Plus the shadow-aim quantisation, which has no visual assert available to a
// still frame: unquantised, every shadow edge in the city crawls as the sun
// moves. It is checked as arithmetic on the live city._lightDir instead.

import fs from 'node:fs';
import sharp from 'sharp';
import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame, writeReport, shotPath, OUT,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const SHOTS = !argv.includes('--no-shots');
// SwiftShader by default (harness rule: reproducible pixels across machines).
// The luminance asserts are gross frame statistics and hold on either backend;
// the opt-out exists because a 226k-triangle city through a software
// rasteriser costs the better part of a second per frame.
const SWIFTSHADER = !argv.includes('--no-swiftshader');

// The shipped look, restated here rather than imported. A test that reads its
// expectations out of the module under test asserts only self-consistency.
const ANCHOR = {
  hour: 15.0,
  fog: 0xb6c6dc, fogNear: 130, fogFar: 430,
  keyColor: 0xfff0d6, keyIntensity: 2.45,
  hemiSky: 0x74a2da, hemiGround: 0x5d6a4c, hemiIntensity: 1.05,
  envIntensity: 1.0,
  lightDir: [58, 74, 40],
};

// Mean frame luminance, 0..255. Night has to clear this or the glow pass has a
// black canvas to wash. Well under the measured blue hour, so it fails on a
// genuinely black frame rather than on tone-mapping drift.
const NIGHT_LUMA_FLOOR = 6;

// How bright the brightest night hour is allowed to be, as a fraction of the
// DIMMEST daylight hour. This used to be 0.35 and it was raised deliberately,
// so the number is worth its paragraph.
//
// The first cut of the night keyframes measured 0.30 here — and was a BLACK
// SCREEN outside the walls: the plaza's ~100 lamp bulbs and lit windows carried
// the whole frame statistic while the Verge's world region sat at 10-13/255 with
// 65-91% of its pixels under 16. One hemisphere light and one directional serve
// the entire world by rule, so there is no way to light the open country without
// lighting the town with it; the night rows were raised until the verge-night
// phase below passes, which lands the brightest night hour (midnight, moon at
// its 40-degree peak) at 53.3 against a 144.5 morning = 0.369.
//
// 0.40 keeps this a real guard — a washed-out night, or the glow-pass regression
// the city.js postmortem is about, lands well above it — while no longer
// encoding "night is unplayably dark" as the pass condition.
const NIGHT_DAY_RATIO = 0.40;

// ------------------------------------------------------- verge night floor
// The assert that would have caught the black screen. Everything above measures
// the LAMP-LIT plaza; these stand the player in each of the three biome bands
// with no lamp, window or portal in frame and measure the WORLD REGION only —
// sky cropped off the top (a dark sky is correct and would mask the ground), HUD
// margins cropped off the sides. Fractions of the viewport, so the box follows
// if the page size ever changes.
const WORLD_BOX = { x0: 0.26, y0: 0.52, x1: 0.74, y1: 0.88 };
// Standing spots, one per band, at Chebyshev radius ~215 (well past the wall,
// inside VERGE_LIMIT) and all EAST of CLIFF_X — resolve() shoves anything west
// of the cliff back into town, which silently turns a "frontier" measurement
// into another plaza one.
const VERGE_SPOTS = [
  { name: 'meadow', x: 215, z: 0 },
  { name: 'amber', x: 78, z: 215 },
  { name: 'ash', x: 78, z: -215 },
];
const VERGE_HOURS = [21.0, 0.0, 5.5];
// Median, not mean: a single bright thing in frame (the selection ring, a star)
// drags a mean and cannot rescue a picture you still cannot read.
//
// BOTH BARS SIT BETWEEN TWO MEASURED POPULATIONS, which is the only honest place
// for them. Before the night rows were raised: median 10-13 with 65-98% of the
// region under 16/255, across all three bands and all three night hours. After:
// median 18-25 with 1-23% under 16. The spread inside each population is the
// orbit camera settling on a different yaw from run to run, not noise in the
// lighting, so the bars are set to clear the worst POST sample and fail the best
// PRE one by a wide margin in both directions.
const VERGE_MEDIAN_FLOOR = 15;
// And the shape of the histogram, because a median can clear a floor while most
// of the frame is still crushed. Under 16/255 is indistinguishable from black on
// a phone at normal brightness.
const VERGE_DARK_MAX_PCT = 35;

const fail = [];
const notes = [];
const ok = (cond, msg, extra) => {
  if (!cond) fail.push(extra === undefined ? msg : `${msg}  [${JSON.stringify(extra)}]`);
  else notes.push(`pass  ${msg}${extra === undefined ? '' : `  ${JSON.stringify(extra)}`}`);
  return cond;
};

let _t0 = Date.now();
const phase = (name) => {
  const now = Date.now();
  console.log(`  [${((now - _t0) / 1000).toFixed(1)}s] ${name}`);
  _t0 = now;
};

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: SWIFTSHADER });
// Landscape: index.html's rotate gate covers a portrait page and swallows the
// click that gets us into the city.
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 1 });

const report = {};

try {
  await gotoGame(page, { waitMs: 1600 });
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 40000 });
  await page.waitForTimeout(2500);
  phase('city mounted');

  // Freeze everything that is not the light. The clock is pinned by replacing
  // tick(), which is the honest way to hold an hour: the sampler, the mode and
  // the city all keep running exactly as they do in play, they simply keep
  // being handed the same time.
  await evalGame(page, (g) => {
    g.worldClock.tick = () => {};
    const c = g.mode.city;
    if (c.citizens) c.citizens.group.visible = false;
    // Adaptive quality rescales the drawing buffer off measured frame time, so
    // two runs of the same build resample differently and every luminance
    // number moves. Pin it.
    g.quality.update = () => {};
  });

  // Set an hour and let the render loop actually draw it. Two frames, because
  // the first one may already have been scheduled with the old state.
  const setHour = async (h) => {
    await page.evaluate((hh) => new Promise((res) => {
      window.__game.worldClock.setHours(hh);
      requestAnimationFrame(() => requestAnimationFrame(res));
    }), h);
  };

  // ------------------------------------------------------- the 15:00 anchor
  await setHour(ANCHOR.hour);
  const live = await evalGame(page, (g) => {
    const c = g.mode.city;
    const d = c._lightDir;
    return {
      fog: g.scene.fog.color.getHex(),
      fogNear: g.scene.fog.near,
      fogFar: g.scene.fog.far,
      keyColor: c.key.color.getHex(),
      keyIntensity: c.key.intensity,
      hemiSky: c.hemi.color.getHex(),
      hemiGround: c.hemi.groundColor.getHex(),
      hemiIntensity: c.hemi.intensity,
      envIntensity: g.scene.environmentIntensity,
      lightDir: [d.x, d.y, d.z],
      hours: g.worldClock.hours,
    };
  });
  report.anchor = live;

  // Vector3.normalize() is divideScalar(length()), i.e. multiply by 1/sqrt(sum
  // of squares. Reproduce THAT, not an equivalent-on-paper formula: Math.hypot
  // and a division give a different last bit, and the assert below is an
  // identity check on purpose.
  const wantDir = (() => {
    const [x, y, z] = ANCHOR.lightDir;
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    return [x * inv, y * inv, z * inv];
  })();
  ok(live.fog === ANCHOR.fog, 'scene fog colour is the shipped 0xb6c6dc at 15:00', live.fog.toString(16));
  ok(live.fogNear === ANCHOR.fogNear && live.fogFar === ANCHOR.fogFar,
    'fog distances are the shipped 130/430 at 15:00', [live.fogNear, live.fogFar]);
  ok(live.keyColor === ANCHOR.keyColor, 'key light colour is the shipped 0xfff0d6', live.keyColor.toString(16));
  ok(live.keyIntensity === ANCHOR.keyIntensity, 'key intensity is the shipped 2.45', live.keyIntensity);
  ok(live.hemiSky === ANCHOR.hemiSky && live.hemiGround === ANCHOR.hemiGround,
    'hemisphere colours are the shipped pair', [live.hemiSky.toString(16), live.hemiGround.toString(16)]);
  ok(live.hemiIntensity === ANCHOR.hemiIntensity, 'hemisphere intensity is the shipped 1.05', live.hemiIntensity);
  ok(live.envIntensity === ANCHOR.envIntensity, 'environmentIntensity is 1.0 at 15:00', live.envIntensity);
  // Identity, not distance: daynight.js anchors its quantisation grid ON this
  // vector precisely so the shipped shadow direction survives bit for bit, and
  // city.js is forbidden from re-quantising it.
  ok(live.lightDir.every((v, i) => v === wantDir[i]),
    'shadow aim is bit-identical to the shipped normalize(58,74,40)', live.lightDir);
  phase('15:00 anchor');

  // ------------------------------------------------- sampler does not allocate
  const alloc = await evalGame(page, (g) => {
    const out = g.mode._day;
    return { same: g.worldClock.sample(out) === out };
  });
  ok(alloc.same, 'sample() writes into the caller-owned DayState (no per-frame allocation)');

  // -------------------------------------------------- shadow aim quantisation
  // Walk the live city's aim vector across the whole cycle and measure the
  // angle between consecutive samples. A continuous re-aim gives a smooth
  // sub-tenth-of-a-degree drift and crawling shadow edges; a quantised one
  // gives long stretches of exactly zero and occasional discrete steps.
  const quant = await evalGame(page, (g) => {
    const c = g.mode.city;
    const clock = g.worldClock;
    const keep = clock.hours;
    const st = g.mode._day;
    const steps = [];
    let px = 0, py = 0, pz = 0;
    // 24000 samples is one every 3.6 s of game time. The density matters: a
    // CONTINUOUS re-aim would show ~0.015 deg between neighbours, which is what
    // makes "the smallest step we ever see is 0.35 deg" evidence of a grid
    // rather than a coincidence of the sampling rate.
    const N = 24000;
    for (let i = 0; i <= N; i++) {
      clock.setHours((i / N) * 24);
      c.applyDayState(clock.sample(st));
      const d = c._lightDir;
      if (i > 0) {
        const dot = Math.min(1, Math.max(-1, px * d.x + py * d.y + pz * d.z));
        steps.push({ deg: Math.acos(dot) * 180 / Math.PI, key: c.key.intensity });
      }
      px = d.x; py = d.y; pz = d.z;
    }
    clock.setHours(keep);
    c.applyDayState(clock.sample(st));
    // acos near dot = 1 amplifies float noise into ~1e-6 degrees, so "did not
    // move" needs a real epsilon rather than a comparison against zero. 1e-3
    // deg is three orders below the quantum and three above the noise.
    const moved = steps.filter((s) => s.deg > 1e-3);
    // The sun/moon hand-off is a 180-degree flip of the aim BY CONSTRUCTION:
    // there is no continuous path between a body setting and its opposite
    // number rising. daynight.js hides it by dipping the key to its 0.18 floor
    // exactly there, so the flip lands on the frame that contributes almost
    // nothing. Separate the two populations and hold each to its own rule
    // instead of averaging them into one meaningless number.
    const swaps = moved.filter((s) => s.deg > 2.0);
    const smooth = moved.filter((s) => s.deg <= 2.0);
    return {
      samples: steps.length,
      movedFrames: moved.length,
      minStep: smooth.length ? Math.min(...smooth.map((s) => s.deg)) : 0,
      maxStep: smooth.length ? Math.max(...smooth.map((s) => s.deg)) : 0,
      swapCount: swaps.length,
      swapKeyMax: swaps.length ? Math.max(...swaps.map((s) => s.key)) : 0,
    };
  });
  report.quantisation = quant;
  // If the aim were continuous, EVERY sample would move. It moves on roughly
  // one sample in twelve, which is the grid.
  ok(quant.movedFrames < quant.samples * 0.2,
    'the shadow aim holds still between quantised steps', quant);
  // Elevation and azimuth are quantised on SEPARATE 0.75-degree grids, so a
  // step that crosses only the azimuth grid subtends 0.75 * cos(elevation) as a
  // great-circle angle — 0.35 deg at the 62-degree culmination. That is still a
  // discrete step, which is all the anti-crawl rule asks; the floor below is
  // that geometric minimum, not a relaxed 0.75.
  ok(quant.minStep >= 0.30,
    'no sub-quantum re-aim: every step clears 0.75 deg * cos(peak elevation)',
    quant.minStep);
  ok(quant.maxStep <= 2.0,
    'no ordinary aim step is larger than one quantum and a bit', quant.maxStep);
  ok(quant.swapCount === 2,
    'exactly two large re-aims per cycle — the two horizon hand-offs', quant.swapCount);
  ok(quant.swapKeyMax <= 0.181,
    'both hand-offs happen while the key light sits on its 0.18 floor', quant.swapKeyMax);
  phase('shadow quantisation');

  // ------------------------------------------------------- portal dusk boost
  const readPortals = () => evalGame(page, (g) => {
    const c = g.mode.city;
    const p = c.portals.find((q) => !q.locked);
    return {
      rank: p.rank,
      emissive: p.meshes.ring.material.emissiveIntensity,
      ovalLuma: p.meshes.oval.material.color.r + p.meshes.oval.material.color.g
        + p.meshes.oval.material.color.b,
      markerOpacity: p.meshes.marker.material.opacity,
      glowStrength: g.glow?.strength ?? null,
      // GLOW_LAYER is 1 (src/render/glow.js). Counted rather than imported so
      // this probe stays a single page-side expression.
      glowLayerCount: (() => {
        let n = 0;
        g.scene.traverse((o) => { if (o.isMesh && o.layers.isEnabled(1)) n++; });
        return n;
      })(),
    };
  });

  await setHour(12.0);
  const pDay = await readPortals();
  await setHour(19.8);
  const pDusk = await readPortals();
  report.portals = { day: pDay, dusk: pDusk };

  ok(pDusk.emissive > pDay.emissive,
    'portal ring emissiveIntensity is higher at the dusk hour', [pDay.emissive, pDusk.emissive]);
  ok(pDusk.ovalLuma > pDay.ovalLuma,
    'portal oval colour is lifted at the dusk hour', [+pDay.ovalLuma.toFixed(3), +pDusk.ovalLuma.toFixed(3)]);
  ok(pDusk.markerOpacity > pDay.markerOpacity,
    'portal ground marker is stronger at the dusk hour', [pDay.markerOpacity, pDusk.markerOpacity]);
  // The whole point of duskPortalGlow: the pop is LOCAL to the six portals.
  ok(pDusk.glowStrength === pDay.glowStrength,
    'global glow strength is untouched by the dusk boost', [pDay.glowStrength, pDusk.glowStrength]);
  ok(pDusk.glowLayerCount === pDay.glowLayerCount,
    'GLOW_LAYER membership is untouched by the dusk boost', [pDay.glowLayerCount, pDusk.glowLayerCount]);
  phase('portal boost');

  // --------------------------------------- program count + light count, 24 h
  await setHour(ANCHOR.hour);
  const structure = () => evalGame(page, (g) => {
    let lights = 0, shadowCasters = 0;
    g.scene.traverse((o) => {
      if (o.isLight) { lights++; if (o.castShadow) shadowCasters++; }
    });
    return { programs: g.renderer.info.programs.length, lights, shadowCasters };
  });
  const before = await structure();
  const sweep = [];
  for (let h = 0; h < 24; h++) {
    await setHour(h + 0.5);
    sweep.push(await structure());
  }
  await setHour(ANCHOR.hour);
  const after = await structure();
  report.programs = { before, after, sweep };

  ok(after.programs === before.programs,
    'renderer program count is identical at 15:00 before and after a full 24 h',
    [before.programs, after.programs]);
  ok(sweep.every((s) => s.lights === before.lights),
    'the scene light COUNT never changes across the cycle (one light is sun and moon both)',
    before.lights);
  ok(sweep.every((s) => s.shadowCasters === before.shadowCasters),
    'castShadow is never toggled across the cycle', before.shadowCasters);
  const maxProg = Math.max(...sweep.map((s) => s.programs));
  ok(maxProg <= before.programs,
    'no material recompiles at any hour of the cycle', [before.programs, maxProg]);
  phase('program invariance over 24 h');

  // ------------------------------------------------------ luminance ordering
  // Frame statistics, not a golden image: this asks "is night darker than dusk
  // darker than noon, and is night still a picture" — which is the question the
  // glow postmortem actually poses.
  const HOURS = [
    { name: 'predawn', h: 5.0, band: 'night' },
    { name: 'dawn', h: 6.5, band: 'twilight', shot: true },
    { name: 'morning', h: 9.0, band: 'day' },
    { name: 'noon', h: 12.5, band: 'day', shot: true },
    { name: 'afternoon', h: 15.0, band: 'day' },
    { name: 'sunset', h: 18.5, band: 'twilight' },
    { name: 'dusk', h: 19.8, band: 'night', shot: true },
    { name: 'night', h: 22.0, band: 'night' },
    { name: 'midnight', h: 0.0, band: 'night', shot: true },
  ];
  const luma = {};
  for (const { name, h, shot } of HOURS) {
    await setHour(h);
    await page.waitForTimeout(500);
    const buf = await page.screenshot();
    const stats = await sharp(buf).stats();
    // Rec.601 on the channel means: a per-pixel pass is not worth the seconds
    // here, and brightness ordering is a gross property of the frame.
    const mean = 0.299 * stats.channels[0].mean
      + 0.587 * stats.channels[1].mean + 0.114 * stats.channels[2].mean;
    luma[name] = +mean.toFixed(3);
    if (SHOTS && shot) fs.writeFileSync(shotPath(`daynight-${name}.png`), buf);
  }
  report.luminance = luma;

  const nightBand = HOURS.filter((x) => x.band === 'night').map((x) => luma[x.name]);
  const dayBand = HOURS.filter((x) => x.band === 'day').map((x) => luma[x.name]);
  const brightest = Math.max(...Object.values(luma));

  ok(luma.noon === brightest, 'noon is the brightest hour of the cycle', luma);
  ok(Math.max(...nightBand) < Math.min(...dayBand) * NIGHT_DAY_RATIO,
    'every hour of the night band is a small fraction of every daylight hour',
    {
      nightMax: Math.max(...nightBand),
      dayMin: Math.min(...dayBand),
      ratio: +(Math.max(...nightBand) / Math.min(...dayBand)).toFixed(3),
      allowed: NIGHT_DAY_RATIO,
    });
  ok(Math.min(...nightBand) >= NIGHT_LUMA_FLOOR,
    'the darkest hour still keeps a blue-hour floor and is not a black frame',
    Math.min(...nightBand));
  ok(luma.dawn > Math.max(...nightBand) && luma.sunset > Math.max(...nightBand),
    'the twilight hours sit above the whole night band', [luma.dawn, luma.sunset]);
  ok(luma.dusk < luma.sunset,
    'the portal hour is darker than the sunset that precedes it', [luma.sunset, luma.dusk]);

  // RECORDED, NOT ASSERTED, and the reason is worth keeping next to the number.
  // WORLD_SPEC's verify prose asks for "night < dusk". It does not hold at the
  // MIDNIGHT keyframe and it cannot: dusk (19:48) has the moon on the shadow
  // clamp's 12-degree floor, where a directional light grazes the ground, while
  // at midnight the same moon is 40 degrees up and its light lands three times
  // more squarely — more than the drop from key 0.70 to 0.55 takes back. It DOES
  // hold at the 22:00 "night" keyframe. This is a property of daynight.js's
  // specced moon arc, not of the city wiring, so it is reported rather than
  // papered over.
  report.nightVsDusk = {
    dusk: luma.dusk, night22: luma.night, midnight: luma.midnight,
    holdsAt22: luma.night < luma.dusk,
    holdsAtMidnight: luma.midnight < luma.dusk,
  };
  phase('luminance ordering');

  // --------------------------------------------------- verge night floor
  // The plaza measurements above pass on a build whose frontier is pitch black,
  // which is exactly what shipped once. This walks out to open country and asks
  // the same question where nothing is lit.
  const vp = page.viewportSize();
  const crop = {
    left: Math.round(vp.width * WORLD_BOX.x0),
    top: Math.round(vp.height * WORLD_BOX.y0),
    width: Math.round(vp.width * (WORLD_BOX.x1 - WORLD_BOX.x0)),
    height: Math.round(vp.height * (WORLD_BOX.y1 - WORLD_BOX.y0)),
  };
  const worldRegion = async (buf) => {
    const { data, info } = await sharp(buf).extract(crop).raw()
      .toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const lum = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * info.channels;
      lum[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
    }
    let dark = 0;
    for (let i = 0; i < n; i++) if (lum[i] < 16) dark++;
    const sorted = Array.from(lum).sort((a, b) => a - b);
    return { median: sorted[n >> 1], darkPct: +((100 * dark) / n).toFixed(1) };
  };

  const verge = [];
  const hasFrontier = await evalGame(page, (g) => Boolean(g.mode.city.frontier));
  ok(hasFrontier, 'the city under test actually built its frontier (else this phase measures nothing)');
  for (const spot of VERGE_SPOTS) {
    // Teleport, then let the orbit camera fly the 200 m and settle: measuring
    // mid-flight samples the town it just left.
    await page.evaluate(({ x, z }) => {
      const g = window.__game;
      const y = g.mode.city.heightAt(x, z);
      g.player.body?.reset?.(x, y, z);
      g.player.pos.set(x, y, z);
    }, spot);
    await page.waitForTimeout(2500);
    const stood = await evalGame(page, (g) => [
      +g.player.pos.x.toFixed(1), +g.player.pos.z.toFixed(1),
    ]);
    // resolve() puts anything it does not like back on a street. A "verge"
    // sample taken in the plaza would pass this phase for the wrong reason.
    ok(Math.hypot(stood[0] - spot.x, stood[1] - spot.z) < 12,
      `the player is actually standing in the ${spot.name} band`, { want: [spot.x, spot.z], stood });
    for (const h of VERGE_HOURS) {
      await setHour(h);
      await page.waitForTimeout(500);
      const buf = await page.screenshot();
      const m = await worldRegion(buf);
      verge.push({ band: spot.name, hour: h, ...m });
      if (SHOTS && h === 21.0) fs.writeFileSync(shotPath(`daynight-verge-${spot.name}-2100.png`), buf);
    }
  }
  report.vergeNight = { crop, samples: verge };
  const worstMedian = verge.reduce((a, b) => (b.median < a.median ? b : a));
  const worstDark = verge.reduce((a, b) => (b.darkPct > a.darkPct ? b : a));
  ok(worstMedian.median >= VERGE_MEDIAN_FLOOR,
    'every biome band keeps a readable world region at every night hour', worstMedian);
  ok(worstDark.darkPct <= VERGE_DARK_MAX_PCT,
    'no night frame on the frontier is mostly crushed black', worstDark);
  phase('verge night floor');

  // ------------------------------------------------------- boot bias + save
  const persistence = await evalGame(page, (g) => {
    g.worldClock.setHours(9.25);
    g.onSave();
    return { saved: g.save.worldTime };
  });
  ok(Math.abs(persistence.saved - 9.25) < 1e-9,
    'the clock reaches save.worldTime on the existing save cadence', persistence.saved);
} catch (e) {
  fail.push(`THREW: ${e.message}\n${e.stack || ''}`);
} finally {
  report.pageErrors = errors;
  report.ok = fail.length === 0 && errors.length === 0;
  report.failures = fail;
  const file = writeReport('daynight-report.json', report);
  console.log('');
  for (const n of notes) console.log(n);
  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of errors) console.log(`  ${e}`);
  }
  console.log(`\nreport: ${file}`);
  if (SHOTS) console.log(`shots:  ${OUT}/daynight-{dawn,noon,dusk,midnight}.png`);
  if (fail.length) {
    console.log(`\nFAIL (${fail.length}):`);
    for (const f of fail) console.log(`  ${f}`);
  } else {
    console.log('\nALL DAY/NIGHT CHECKS PASS');
  }
  await browser.close();
  await server.stop();
  process.exit(fail.length || errors.length ? 1 : 0);
}
