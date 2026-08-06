// Refresh-rate aware frame pacing.
//
// requestAnimationFrame fires at the panel's refresh rate, never at ours. The
// old loop in main.js gated on accumulated time with a fixed 1.5 ms tolerance
// and then threw the remainder away, so on a 90 Hz panel every second callback
// was rejected and the game rendered 45 fps — which the quality governor then
// read as "slow device" and punished. Here we measure the real display interval
// once, then pace by COUNTING callbacks against a fractional cadence, so a
// 90 Hz panel alternates 1 and 2 callbacks per rendered frame and averages
// exactly 60.

// Panel rates Android actually ships. Anything measured within 8% of one of
// these is that panel plus jitter, not a genuinely odd refresh rate.
const PANEL_HZ = [60, 72, 90, 120, 144, 165];
const SNAP_TOLERANCE = 0.08;

const MAX_DT = 0.05;
// No real display interval is this long, so anything above it is a resume from
// background or a stalled main thread — poison for refresh detection.
const MAX_SAMPLE_MS = 100;
// Android switches panel modes at runtime (60 <-> 90 on battery saver), so we
// re-measure periodically instead of trusting the boot measurement forever.
const RECHECK_FRAMES = 120;
const RECHECK_DRIFT = 0.05;

/**
 * Snap a set of raw rAF intervals (in MILLISECONDS) to a display refresh rate.
 * Median, not mean, so one GC pause cannot drag the estimate down.
 */
export function detectRefreshHz(samples) {
  if (!samples || samples.length === 0) return 60;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return 60;
  const hz = 1000 / median;
  let best = 0;
  let bestErr = Infinity;
  for (const panel of PANEL_HZ) {
    const err = Math.abs(hz - panel) / panel;
    if (err < bestErr) { bestErr = err; best = panel; }
  }
  return bestErr <= SNAP_TOLERANCE ? best : Math.max(1, Math.round(hz));
}

export class FrameClock {
  constructor({ targetFps = 60, sampleFrames = 30, onFrame } = {}) {
    this.targetFps = targetFps > 0 ? targetFps : 60;
    this.sampleFrames = Math.max(4, sampleFrames);
    this.onFrame = onFrame;

    this._samples = [];      // calibration window
    this._recent = [];       // rolling window for re-checks
    this._refreshHz = this.targetFps;
    this._cadence = 1;       // rAF callbacks per rendered frame, may be fractional
    this._credit = 0;
    this._calibrated = false;
    this._sinceCheck = 0;

    this._running = false;
    this._handle = 0;
    this._last = 0;
    this._lastRender = 0;
    this._emaDt = 0;

    this._tick = this._tick.bind(this);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = globalThis.performance.now();
    this._lastRender = 0;
    this._handle = globalThis.requestAnimationFrame(this._tick);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    globalThis.cancelAnimationFrame?.(this._handle);
    this._handle = 0;
  }

  /** CityMode asks for 30, DungeonMode for 60. */
  setTarget(fps) {
    if (!(fps > 0) || fps === this.targetFps) return;
    this.targetFps = fps;
    this._credit = 0;
    this._recomputeCadence();
  }

  get refreshHz() { return this._refreshHz; }

  /**
   * Whole callbacks between rendered frames. Deliberately FLOOR of the exact
   * cadence, not round: Math.round(90 / 60) is 2, which is the 45 fps bug this
   * module exists to kill. The fractional remainder is carried in _credit, so
   * the average still lands on targetFps.
   */
  get step() { return Math.max(1, Math.floor(this._cadence + 1e-6)); }

  /** Exact callbacks-per-frame ratio, e.g. 1.5 on a 90 Hz panel at 60 fps. */
  get cadence() { return this._cadence; }

  /** Smoothed rendered fps. Averaged over dt, not over 1/dt, so the alternating
   *  11/22 ms cadence of a 90 Hz panel reads as 60 rather than 67. */
  get measuredFps() { return this._emaDt > 0 ? 1 / this._emaDt : 0; }

  _recomputeCadence() {
    // Below the target rate we render every callback — there is nothing to skip.
    this._cadence = Math.max(1, this._refreshHz / this.targetFps);
  }

  _sample(gapMs) {
    this._samples.push(gapMs);
    this._recent.push(gapMs);
    if (this._recent.length > RECHECK_FRAMES) this._recent.shift();
  }

  _tick(now) {
    if (!this._running) return;
    // Re-arm before running game code so a throw inside onFrame cannot kill the
    // loop — the old main.js loop relied on the same trick.
    this._handle = globalThis.requestAnimationFrame(this._tick);

    const t = typeof now === 'number' ? now : globalThis.performance.now();
    const gap = t - this._last;
    this._last = t;
    if (gap > 0 && gap < MAX_SAMPLE_MS) this._sample(gap);

    if (!this._calibrated) {
      // Render every callback while measuring: boot must not be slowed down by
      // the very code that exists to make it faster.
      this._render(t);
      if (this._samples.length >= this.sampleFrames) {
        this._refreshHz = detectRefreshHz(this._samples);
        this._samples.length = 0;
        this._calibrated = true;
        this._credit = 0;
        this._recomputeCadence();
      }
      return;
    }

    if (++this._sinceCheck >= RECHECK_FRAMES) {
      this._sinceCheck = 0;
      if (this._recent.length >= this.sampleFrames) {
        const hz = detectRefreshHz(this._recent);
        if (Math.abs(hz - this._refreshHz) / this._refreshHz > RECHECK_DRIFT) {
          this._refreshHz = hz;
          this._recomputeCadence();
        }
      }
    }

    this._credit += 1;
    if (this._credit + 1e-6 < this._cadence) return;
    this._credit -= this._cadence;
    // Never bank more than one frame: a stalled main thread must not buy itself
    // a burst of catch-up renders.
    if (this._credit < 0) this._credit = 0;
    if (this._credit > this._cadence) this._credit = this._cadence;
    this._render(t);
  }

  _render(t) {
    const raw = this._lastRender ? (t - this._lastRender) / 1000 : 1 / this.targetFps;
    this._lastRender = t;
    // Clamping here is what stops a backgrounded tab from resuming into a
    // multi-second simulation step.
    const dt = Math.min(Math.max(raw, 0), MAX_DT);
    // Slow EMA: the 1-then-2 callback cadence of a 90 Hz panel makes raw frame
    // times swing 11/22 ms, and a fast average would swing with them.
    if (dt > 0) this._emaDt = this._emaDt ? this._emaDt * 0.95 + dt * 0.05 : dt;
    this.onFrame?.(dt, raw);
  }
}
