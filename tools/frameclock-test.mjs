// Headless frame-pacing test. No browser, no Playwright, no shared harness —
// it fakes requestAnimationFrame at a chosen refresh rate and drives the real
// FrameClock and Quality modules against it.
//
//   node tools/frameclock-test.mjs
//
// What it proves:
//  1. detectRefreshHz snaps jittery intervals to the real panel rate.
//  2. FrameClock renders within 2 fps of the target on 60/72/90/120/144 Hz.
//  3. The same holds for the 30 fps city target.
//  4. Quality does NOT ratchet down on a healthy 90 Hz device.
//  5. A tier lost to a genuine slowdown is recovered when the device speeds up.
//  6. The OLD main.js gate really did halve the rate on 72/90/144 Hz.

import { FrameClock, detectRefreshHz } from '../src/core/frameclock.js';
import {
  Quality, TIERS,
  skinnedShadowCeiling, skinnedBodyCensus, acquireSkinnedBody, releaseSkinnedBody,
} from '../src/core/quality.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`); }
};

// Deterministic jitter so runs are reproducible but not artificially perfect.
let seed = 1337;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/** Virtual rAF pump. Intervals are ms; jitter is +/- ms of scheduler noise. */
function makeDisplay(hz, jitterMs = 0.35) {
  let now = 0;
  const queue = [];
  let handle = 0;
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return ++handle; };
  globalThis.cancelAnimationFrame = () => { queue.length = 0; };
  const interval = 1000 / hz;
  return {
    get now() { return now; },
    /** Advance one display refresh and run whatever rAF callback is pending. */
    tick() {
      now += interval + (rnd() - 0.5) * 2 * jitterMs;
      const cb = queue.shift();
      if (cb) cb(now);
    },
    /** Simulate time passing with no callbacks at all (backgrounded app). */
    jump(ms) { now += ms; },
  };
}

console.log('\ndetectRefreshHz');
for (const hz of [60, 72, 90, 120, 144, 165]) {
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push(1000 / hz + (rnd() - 0.5) * 0.7);
  const got = detectRefreshHz(samples);
  ok(got === hz, `${hz} Hz intervals detect as ${hz}`, `got ${got}`);
}
{
  // A device dropping half its frames must NOT be reported as its panel rate.
  const samples = new Array(40).fill(1000 / 37);
  ok(detectRefreshHz(samples) === 37, 'unrecognised 37 Hz falls through unsnapped', `got ${detectRefreshHz(samples)}`);
}

/**
 * Run the real clock on a fake panel for `seconds` of virtual time. The first
 * `warmup` seconds are excluded from the rate: FrameClock deliberately renders
 * every callback while it measures the panel, so counting the boot burst would
 * measure calibration rather than pacing.
 */
function pace(hz, targetFps, seconds, warmup = 1) {
  const display = makeDisplay(hz);
  const dts = [];
  const steady = [];
  const clock = new FrameClock({
    targetFps,
    onFrame: (dt) => {
      dts.push(dt);
      if (display.now >= warmup * 1000) steady.push(dt);
    },
  });
  clock.start();
  const ticks = Math.round(hz * seconds);
  for (let i = 0; i < ticks; i++) display.tick();
  clock.stop();
  const elapsed = display.now / 1000;
  const steadySpan = elapsed - warmup;
  return { dts, steady, elapsed, fps: steady.length / steadySpan, bootFps: dts.length / elapsed, clock };
}

console.log('\nFrameClock pacing, 60 fps target');
for (const hz of [60, 72, 90, 120, 144]) {
  const r = pace(hz, 60, 10);
  const simulated = r.dts.reduce((a, b) => a + b, 0);
  ok(Math.abs(r.fps - 60) <= 2, `${hz} Hz panel renders 60 fps`,
    `${r.fps.toFixed(2)} fps, refreshHz=${r.clock.refreshHz}, cadence=${r.clock.cadence.toFixed(2)}, step=${r.clock.step}`);
  ok(Math.abs(simulated - r.elapsed) < 0.05, `${hz} Hz simulation tracks wall clock`,
    `sim ${simulated.toFixed(3)}s vs wall ${r.elapsed.toFixed(3)}s`);
  ok(Math.abs(r.clock.measuredFps - 60) <= 2, `${hz} Hz measuredFps reports ~60`,
    `${r.clock.measuredFps.toFixed(2)}`);
}

console.log('\nFrameClock pacing, 30 fps city target');
for (const hz of [60, 72, 90, 120, 144]) {
  const r = pace(hz, 30, 10);
  ok(Math.abs(r.fps - 30) <= 2, `${hz} Hz panel renders 30 fps`, `${r.fps.toFixed(2)} fps`);
}

console.log('\nFrameClock robustness');
{
  // 20 s backgrounded must cost exactly one clamped step, not a catch-up storm.
  const display = makeDisplay(90);
  const seen = [];
  const clock = new FrameClock({ targetFps: 60, onFrame: (dt, raw) => seen.push({ dt, raw }) });
  clock.start();
  for (let i = 0; i < 200; i++) display.tick();
  const before = seen.length;
  display.jump(20000);
  for (let i = 0; i < 200; i++) display.tick();
  const after = seen.slice(before);
  const maxDt = Math.max(...seen.map((s) => s.dt));
  const spike = after.find((s) => s.raw > 1);
  ok(spike !== undefined, 'the resume frame sees the real 20 s gap in rawDt', `raw ${spike?.raw.toFixed(2)}s`);
  ok(maxDt <= 0.05 + 1e-9, 'no simulation step exceeds the 0.05 clamp', `max ${maxDt.toFixed(4)}`);
  ok(after.length <= 200, 'resume renders no catch-up burst', `${after.length} frames from 200 callbacks`);
  ok(Math.abs(after.length / (200 / 90) - 60) <= 2, 'pacing is unchanged after resume',
    `${(after.length / (200 / 90)).toFixed(2)} fps`);
}
{
  const display = makeDisplay(90);
  let thrown = 0;
  const clock = new FrameClock({
    targetFps: 60,
    onFrame: () => { thrown++; if (thrown === 5) throw new Error('boom'); },
  });
  clock.start();
  for (let i = 0; i < 90; i++) {
    try { display.tick(); } catch { /* the host swallows it the same way */ }
  }
  clock.stop();
  ok(thrown > 40, 'a throw inside onFrame does not kill the loop', `${thrown} frames after the throw`);
}

const ORDER = ['low', 'medium', 'high', 'ultra'];
/** Feed frame times to a governor and report the WORST tier it ever visited. */
function govern(dts, { startTier, targetFps }) {
  let lowest = ORDER.indexOf(startTier);
  const q = new Quality({
    startTier,
    targetFps,
    onChange: (t) => { lowest = Math.min(lowest, ORDER.indexOf(t.name)); },
  });
  for (const dt of dts) q.update(dt);
  return { q, lowest: ORDER[lowest] };
}

console.log('\nQuality governor');
{
  // Exactly the scenario the owner is about to hit: healthy 90 Hz phone.
  const r = pace(90, 60, 60);
  for (const startTier of ['medium', 'high']) {
    const { q, lowest } = govern(r.steady, { startTier, targetFps: 60 });
    ok(ORDER.indexOf(lowest) >= ORDER.indexOf(startTier),
      `healthy 90 Hz device never drops below ${startTier}`,
      `lowest ${lowest}, final ${q.current.name}, fps ${q.fps.toFixed(1)}`);
  }
}
{
  const dts = [];
  for (let i = 0; i < 60 * 60; i++) dts.push(1 / 30 + (rnd() - 0.5) * 0.002);
  const { q, lowest } = govern(dts, { startTier: 'medium', targetFps: 30 });
  ok(lowest === 'medium', '30 fps city target is not treated as slow',
    `lowest ${lowest}, final ${q.current.name}`);
}
{
  const q = new Quality({ startTier: 'high', targetFps: 60 });
  // 40 fps for 20 s: a real slowdown, must cost tiers.
  for (let i = 0; i < 40 * 20; i++) q.update(1 / 40);
  const bottom = q.current.name;
  ok(bottom === 'low', 'a genuinely slow device is stepped down', `tier ${bottom}`);
  // Then the load lifts. The tier must climb back — the old code could not.
  for (let i = 0; i < 60 * 60; i++) q.update(1 / 60);
  ok(q.current.name !== bottom, 'tier recovers once frames are healthy again',
    `${bottom} -> ${q.current.name}`);
}
{
  const q = new Quality({ startTier: 'medium', targetFps: 60 });
  q.lock('low');
  for (let i = 0; i < 60 * 30; i++) q.update(1 / 60);
  ok(q.current.name === 'low', 'lock(name) pins the tier', `tier ${q.current.name}`);
  q.lock(null);
  for (let i = 0; i < 60 * 30; i++) q.update(1 / 60);
  ok(q.current.name !== 'low', 'lock(null) hands control back', `tier ${q.current.name}`);
}
{
  ok(ORDER.every((t) => typeof TIERS[t].maxFieldShadows === 'number'
    && typeof TIERS[t].cityChunkRadius === 'number'
    && typeof TIERS[t].instanceScale === 'number'), 'every tier carries the new spec fields',
    ORDER.map((t) => `${t}:${TIERS[t].maxFieldShadows}/${TIERS[t].cityChunkRadius}/${TIERS[t].instanceScale}`).join(' '));
}
{
  // The shared skinned-body ceiling (quality.js). Asserted as MONOTONIC and as
  // strictly above the tier's own field-shadow cap, because the two interact:
  // if maxSkinnedBodies ever fell to or below maxFieldShadows, a full shadow
  // company alone could consume the ceiling and every enemy in the gate would
  // spawn as a procedural fallback — the failure this ceiling exists to stop,
  // arriving through the ceiling itself.
  const vals = ORDER.map((t) => TIERS[t].maxSkinnedBodies);
  ok(vals.every((v) => Number.isInteger(v) && v > 0), 'every tier declares maxSkinnedBodies', vals.join('/'));
  ok(vals.every((v, i) => i === 0 || v >= vals[i - 1]), 'maxSkinnedBodies rises with the tier', vals.join(' <= '));
  ok(ORDER.every((t) => TIERS[t].maxSkinnedBodies > TIERS[t].maxFieldShadows),
    'maxSkinnedBodies leaves room for enemies above the shadow field cap',
    ORDER.map((t) => `${t}:${TIERS[t].maxSkinnedBodies}>${TIERS[t].maxFieldShadows}`).join(' '));

  // The shadow sub-ceiling has to be reachable AND has to leave slack: at least
  // one shadow may be skinned at every tier, and never the whole ceiling.
  const shadowCaps = ORDER.map((t) => skinnedShadowCeiling(TIERS[t]));
  ok(shadowCaps.every((v, i) => v >= 1 && v < TIERS[ORDER[i]].maxSkinnedBodies),
    'the shadow share of the ceiling is >= 1 and never the whole thing',
    ORDER.map((t, i) => `${t}:${shadowCaps[i]}/${TIERS[t].maxSkinnedBodies}`).join(' '));

  // And the ledger itself: acquire/release must balance, and a release with
  // nothing held must not mint slots (a double-dispose is a real code path —
  // disposeCharacterModels disposes every live instance and each one releases).
  const before = skinnedBodyCensus();
  acquireSkinnedBody(false);
  acquireSkinnedBody(true);
  const held = skinnedBodyCensus();
  releaseSkinnedBody(false);
  releaseSkinnedBody(true);
  releaseSkinnedBody(true);            // the double-release
  const after = skinnedBodyCensus();
  ok(held.bodies === before.bodies + 2 && held.shadows === before.shadows + 1,
    'acquireSkinnedBody counts totals and shadows separately', JSON.stringify(held));
  ok(after.bodies === before.bodies && after.shadows === before.shadows,
    'releaseSkinnedBody is clamped — a double release mints nothing', JSON.stringify(after));
}

console.log('\nOld main.js gate, for the record');
for (const hz of [60, 72, 90, 120, 144]) {
  // Verbatim copy of the loop this step replaced.
  const TARGET_DT = 1 / 60;
  let acc = 0;
  let rendered = 0;
  const interval = 1 / hz;
  const ticks = hz * 10;
  for (let i = 0; i < ticks; i++) {
    acc += interval;
    if (acc < TARGET_DT - 0.0015) continue;
    acc = 0;
    rendered++;
  }
  console.log(`  OLD   ${String(hz).padStart(3)} Hz -> ${(rendered / 10).toFixed(1)} fps`);
}

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
