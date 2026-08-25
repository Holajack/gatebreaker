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
    maxSkinnedBodies: 12,
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
    maxSkinnedBodies: 16,
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
    maxSkinnedBodies: 20,
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
    maxSkinnedBodies: 24,
    cityChunkRadius: 4,
    instanceScale: 1.25,
  },
};

// --------------------------------------------------- skinned-body ceiling
//
// `maxSkinnedBodies` is the ONE ceiling on how many GLB-backed, skeleton-driven
// bodies may stand in a scene at once — enemies, the boss, the player and the
// bound shadow army all draw from it. It exists because characters.js and
// creatures.js each carried a private budget (medium 14 apiece, and creatures
// exempted shadows from theirs entirely), so nothing in the game had an opinion
// about the TOTAL: a full shadow company stacked on top of a full wave instead
// of trading against it.
//
// SIZED OFF MEASUREMENT, AND THE MEASUREMENT SAID SOMETHING SURPRISING.
// tools/density-probe.mjs, E and D crawls on SwiftShader, composed peak frames:
//
//   a skinned body      ~5.5k geometry triangles (4.1k-8.5k across the packs),
//                       ~15k of renderer.info.render.triangles once it has gone
//                       through the main pass, the key light's depth map and the
//                       glow pass, and ~7 draw calls
//   the PROCEDURAL body ~0.5k geometry, ~1.4k frame triangles — and ~17 DRAW
//                       CALLS, because it is six separate boxes and a weapon
//                       where the skinned one is a single merged mesh
//
// So falling back past the ceiling buys triangles at the price of draw calls,
// at roughly 14k triangles for 10 extra calls per body — a bad trade on a phone,
// where calls are the tighter budget. (This is not news to the codebase: build
// step 5 existed to take a character from 21.3 calls to <= 12, and the
// procedural rig is what it was taking them FROM.)
//
// That reshapes what this ceiling is for. It is a SAFETY FENCE, not a routine
// clamp: sized to sit above normal play at every tier, and to bite only where
// the deepest gate meets the weakest device.
//
//   peak live bodies = maxFieldShadows + waveSize + player + boss
//   low     4 + 12 + 2 = 18 vs 12  -> the C cavern sheds ~6 on a low phone
//   medium  6 + 12 + 2 = 20 vs 16  -> C sheds ~4; E (14) and D (17) barely touch
//   high    9 + 12 + 2 = 23 vs 20  -> C sheds ~3
//   ultra  12 + 12 + 2 = 26 vs 24  -> C sheds ~2
//
// The SHADOW SUB-CEILING is the tier's own maxFieldShadows and nothing tighter.
// A full company always fits; what it cannot do is take a slot an enemy would
// have had, which is the "a big army trades against enemy count instead of
// stacking on top of it" behaviour this fence was asked for — the trade happens
// through the shared total, not by degrading the army for its own sake.

/** The tier's total live skinned-body ceiling. */
export function skinnedBodyCeiling(tier) {
  const t = typeof tier === 'string' ? TIERS[tier] : tier;
  const n = t?.maxSkinnedBodies;
  return Number.isFinite(n) && n > 0 ? n : TIERS.medium.maxSkinnedBodies;
}

/** How many of those slots the bound shadow army may take. */
export function skinnedShadowCeiling(tier) {
  const t = typeof tier === 'string' ? TIERS[tier] : tier;
  const n = t?.maxFieldShadows;
  return Math.max(1, Math.min(skinnedBodyCeiling(tier) - 1,
    Number.isFinite(n) && n > 0 ? n : TIERS.medium.maxFieldShadows));
}

// The ledger itself. Module-level rather than per-renderer because there is
// exactly one scene at a time and both character modules are singletons for the
// same reason; a second scene would need this to move, and nothing else.
let _bodies = 0;
let _shadowBodies = 0;

/** Live counts, for tools and asserts. */
export function skinnedBodyCensus() {
  return { bodies: _bodies, shadows: _shadowBodies };
}

/**
 * Is there room for one more? `isShadow` routes the caller to the shadow
 * sub-ceiling as well as the total.
 */
export function skinnedBodyAvailable(tier, isShadow = false) {
  if (_bodies >= skinnedBodyCeiling(tier)) return false;
  if (isShadow && _shadowBodies >= skinnedShadowCeiling(tier)) return false;
  return true;
}

/** Claim a slot. Callers that bypass the check (player, boss) still claim. */
export function acquireSkinnedBody(isShadow = false) {
  _bodies++;
  if (isShadow) _shadowBodies++;
}

/** Hand a slot back. Clamped: a double-release must not mint free slots. */
export function releaseSkinnedBody(isShadow = false) {
  _bodies = Math.max(0, _bodies - 1);
  if (isShadow) _shadowBodies = Math.max(0, _shadowBodies - 1);
}

/** Bulk release, for the model modules' own teardown counters. */
export function releaseSkinnedBodies(bodies = 0, shadows = 0) {
  _bodies = Math.max(0, _bodies - Math.max(0, bodies));
  _shadowBodies = Math.max(0, _shadowBodies - Math.max(0, shadows));
}

export const ORDER = ['low', 'medium', 'high', 'ultra'];

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
