// Adaptive quality governor.
//
// Phones vary enormously and we ship one APK for all of them. Rather than
// guessing from device strings, measure actual frame cost and step the tier up
// or down. Everything expensive in the renderer reads its settings from here.

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
  },
};

const ORDER = ['low', 'medium', 'high', 'ultra'];

export class Quality {
  constructor({ onChange, startTier = null } = {}) {
    this.onChange = onChange;
    this.locked = false;           // set true if the player picks a tier manually
    this.index = ORDER.indexOf(startTier || Quality.guessStartTier());
    if (this.index < 0) this.index = 1;
    this.current = TIERS[ORDER[this.index]];

    this._samples = [];
    this._cooldown = 2.5;          // let things settle before judging
    this._sinceChange = 0;
  }

  /** A cheap first guess so we don't spend the first seconds at the wrong tier. */
  static guessStartTier() {
    const mem = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    const dpr = window.devicePixelRatio || 1;
    if (mem >= 8 && cores >= 8) return 'ultra';
    if (mem >= 6 && cores >= 6) return 'high';
    if (mem <= 2 || cores <= 4) return 'low';
    return dpr >= 2.5 ? 'medium' : 'high';
  }

  setTier(name) {
    const i = ORDER.indexOf(name);
    if (i < 0 || i === this.index) return;
    this.index = i;
    this.current = TIERS[ORDER[i]];
    this._sinceChange = 0;
    this._samples.length = 0;
    this.onChange?.(this.current);
  }

  lock(name) {
    if (name) this.setTier(name);
    this.locked = true;
  }

  /**
   * Feed one frame's delta. We track a rolling median rather than a mean so a
   * single GC pause or a level-load hitch can't yank the whole tier down.
   */
  update(dt) {
    if (this.locked) return;
    this._sinceChange += dt;
    if (this._cooldown > 0) { this._cooldown -= dt; return; }

    this._samples.push(dt);
    if (this._samples.length < 90) return;

    const sorted = [...this._samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // 95th percentile catches sustained hitching that the median hides.
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    this._samples.length = 0;

    // Don't thrash: require a few seconds at a tier before moving again.
    if (this._sinceChange < 4) return;

    const fps = 1 / median;
    if ((fps < 46 || p95 > 0.055) && this.index > 0) {
      this.setTier(ORDER[this.index - 1]);
    } else if (fps > 58 && p95 < 0.021 && this.index < ORDER.length - 1) {
      this.setTier(ORDER[this.index + 1]);
    }
  }
}
