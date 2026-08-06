// Adaptive quality governor.
//
// Phones vary enormously and we ship one APK for all of them. Rather than
// guessing from device strings, measure actual frame cost and step the tier up
// or down. Everything expensive in the renderer reads its settings from here.
//
// Every threshold is expressed as a fraction of the CURRENT target fps. The old
// absolute `fps < 46` meant a 90 Hz phone rendering a perfectly healthy 45 fps
// (see frameclock.js) was pinned to 'low' forever, and it would have punished
// the 30 fps city target even harder.

export const TIERS = {
  low: {
    name: 'low',
    pixelRatio: 1.0,
    shadows: false,
    shadowMapSize: 512,
    bloom: false,
    particleScale: 0.45,
    grassDensity: 0,
    viewDistance: 130,
    anisotropy: 1,
    maxFieldShadows: 4,
    cityChunkRadius: 2,
    instanceScale: 0.4,
  },
  medium: {
    name: 'medium',
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    bloom: false,
    particleScale: 0.75,
    grassDensity: 0.5,
    viewDistance: 180,
    anisotropy: 2,
    maxFieldShadows: 6,
    cityChunkRadius: 3,
    instanceScale: 0.7,
  },
  high: {
    name: 'high',
    pixelRatio: 1.6,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    particleScale: 1.0,
    grassDensity: 1.0,
    viewDistance: 240,
    anisotropy: 4,
    maxFieldShadows: 9,
    cityChunkRadius: 4,
    instanceScale: 1.0,
  },
  ultra: {
    name: 'ultra',
    pixelRatio: 2.0,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    particleScale: 1.25,
    grassDensity: 1.35,
    viewDistance: 300,
    anisotropy: 8,
    maxFieldShadows: 12,
    cityChunkRadius: 4,
    instanceScale: 1.25,
  },
};

const ORDER = ['low', 'medium', 'high', 'ultra'];

const DOWN_FPS = 0.78;         // fraction of target that counts as "struggling"
const UP_FPS = 0.96;           // fraction of target that counts as "comfortable"
const DOWN_SUSTAIN = 2.5;      // seconds of struggling before we give something up
const UP_SUSTAIN = 6;          // seconds of comfort before we ask for more
// Hitch limits, kept as multiples of the target frame time so they mean the same
// thing at 30 as at 60. 3.3x is the old 55 ms downgrade limit at a 60 fps target.
// The upgrade limit is 1.6x rather than the old 1.26x (21 ms) because a 90 Hz
// panel paced to 60 legitimately alternates 11/22 ms frames — at 1.26x a healthy
// high-refresh phone could never climb a tier.
const DOWN_HITCH = 3.3;
const UP_HITCH = 1.6;

const WINDOW = 120;            // ~2 s of frames at 60
const MIN_SAMPLES = 45;
const EVAL_INTERVAL = 0.25;

export class Quality {
  constructor({ onChange, startTier = null, targetFps = 60 } = {}) {
    this.onChange = onChange;
    this.locked = false;           // set true if the player picks a tier manually
    this.targetFps = targetFps > 0 ? targetFps : 60;
    this.index = ORDER.indexOf(startTier || Quality.guessStartTier());
    if (this.index < 0) this.index = 1;
    this._current = TIERS[ORDER[this.index]];

    this._samples = [];
    this._cooldown = 2.5;          // let things settle before judging
    this._sinceEval = 0;
    this._downTime = 0;
    this._upTime = 0;
    this._upNeed = UP_SUSTAIN;
    this._sinceUpgrade = Infinity;
    this._fps = this.targetFps;
    this._p95 = 1 / this.targetFps;
  }

  /** A cheap first guess so we don't spend the first seconds at the wrong tier. */
  static guessStartTier() {
    // Guarded so the governor can be exercised headlessly in Node.
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const mem = nav.deviceMemory || 4;
    const cores = nav.hardwareConcurrency || 4;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (mem >= 8 && cores >= 8) return 'ultra';
    if (mem >= 6 && cores >= 6) return 'high';
    if (mem <= 2 || cores <= 4) return 'low';
    return dpr >= 2.5 ? 'medium' : 'high';
  }

  get current() { return this._current; }

  /** Smoothed frames per second as last measured. */
  get fps() { return this._fps; }

  setTier(name) {
    const i = ORDER.indexOf(name);
    if (i < 0 || i === this.index) return;
    this.index = i;
    this._current = TIERS[ORDER[i]];
    this._reset(1);
    this.onChange?.(this._current);
  }

  /** The city runs at 30, gates at 60; every threshold follows this. */
  setTargetFps(fps) {
    if (!(fps > 0) || fps === this.targetFps) return;
    this.targetFps = fps;
    // A new target invalidates any backoff learned against the old one.
    this._upNeed = UP_SUSTAIN;
    this._reset(1);
  }

  /** lock('high') pins a tier; lock(null) hands control back to the governor. */
  lock(name) {
    if (name) {
      this.setTier(name);
      this.locked = true;
    } else {
      this.locked = false;
      this._reset(1);
    }
  }

  _reset(cooldown) {
    this._samples.length = 0;
    this._cooldown = cooldown;
    this._sinceEval = 0;
    this._downTime = 0;
    this._upTime = 0;
  }

  /**
   * Feed one frame's delta. The rate term is the MEAN over the window, not the
   * median: at a 60 fps target on a 90 Hz panel the frame times alternate
   * 11/22 ms, so the median reads either 90 or 45 fps depending on which side of
   * the window it lands on — the mean reads the 60 that is actually happening.
   * The 95th percentile is kept separately because it is the only term that
   * catches sustained hitching a smooth average hides.
   */
  update(rawDt) {
    if (this.locked) return;
    const dt = Math.min(Math.max(rawDt, 1e-4), 0.25);
    if (this._cooldown > 0) { this._cooldown -= dt; return; }

    this._samples.push(dt);
    if (this._samples.length > WINDOW) this._samples.shift();
    this._sinceEval += dt;
    if (this._samples.length < MIN_SAMPLES || this._sinceEval < EVAL_INTERVAL) return;

    const elapsed = this._sinceEval;
    this._sinceEval = 0;

    let sum = 0;
    for (const s of this._samples) sum += s;
    const mean = sum / this._samples.length;
    const sorted = [...this._samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    this._fps = 1 / mean;
    this._p95 = p95;

    const targetDt = 1 / this.targetFps;
    if (this._fps < this.targetFps * DOWN_FPS || p95 > targetDt * DOWN_HITCH) {
      this._downTime += elapsed;
      this._upTime = 0;
    } else if (this._fps > this.targetFps * UP_FPS && p95 < targetDt * UP_HITCH) {
      this._upTime += elapsed;
      this._downTime = 0;
    } else {
      this._downTime = 0;
      this._upTime = 0;
    }

    this._sinceUpgrade += elapsed;

    if (this._downTime >= DOWN_SUSTAIN && this.index > 0) {
      // Backing off a tier we only just climbed to means that tier does not fit
      // this device: wait longer before trying it again. Recoverable, but not a
      // resolution strobe light.
      if (this._sinceUpgrade < UP_SUSTAIN + DOWN_SUSTAIN) this._upNeed = Math.min(this._upNeed * 2, 60);
      else this._upNeed = UP_SUSTAIN;
      this.setTier(ORDER[this.index - 1]);
    } else if (this._upTime >= this._upNeed && this.index < ORDER.length - 1) {
      // Upgrades are allowed from any tier at any time: a downgrade taken during
      // a bad load spike must be recoverable, not permanent.
      this._sinceUpgrade = 0;
      this.setTier(ORDER[this.index + 1]);
    }
  }
}
