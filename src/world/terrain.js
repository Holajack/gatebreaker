// Seeded heightfield generation for the overworld.
//
// Everything here is pure maths on a seeded PRNG — no THREE dependency — so the
// same height function drives mesh building, entity placement and collision,
// and a given seed always produces the identical world.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Value noise with smooth interpolation. Cheap, and plenty for stylised
// terrain where we want readable silhouettes rather than photoreal detail. ---
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Fractal brownian motion — layered noise octaves.
export function fbm(x, y, seed, octaves = 4, lacunarity = 2.03, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * The overworld heightfield.
 *
 * The shape is deliberately bowl-like: low and walkable in the middle where the
 * player spawns, rising to impassable ridges at the rim. That gives a natural
 * boundary without an invisible wall, and readable landmarks on the skyline.
 */
export class Terrain {
  constructor({ seed = 1337, size = 460, maxHeight = 34 } = {}) {
    this.seed = seed >>> 0;
    this.size = size;          // world spans -size/2 .. +size/2 on X and Z
    this.half = size / 2;
    this.maxHeight = maxHeight;
    this.rnd = mulberry32(this.seed);
  }

  /** Normalised distance from world centre, 0 at spawn, 1 at the rim. */
  rim(x, z) {
    return Math.min(1, Math.hypot(x, z) / this.half);
  }

  /** Terrain height in world units at (x, z). */
  height(x, z) {
    const s = 1 / 78;                       // base feature scale
    const base = fbm(x * s, z * s, this.seed, 4);
    const ridge = fbm(x * s * 2.7 + 40, z * s * 2.7 - 25, this.seed + 77, 3);

    // Rolling ground, gently undulating.
    let h = (base - 0.5) * 13;

    // Sharpened ridges: 1 - |2n-1| gives creases rather than blobs.
    const crease = 1 - Math.abs(ridge * 2 - 1);
    h += Math.pow(crease, 2.4) * 15;

    // Bowl: push the rim up hard so the world visually encloses itself.
    const r = this.rim(x, z);
    const wall = Math.pow(Math.max(0, r - 0.62) / 0.38, 2.1);
    h += wall * this.maxHeight;

    // Flatten a clearing at the spawn point so the player never starts on a slope.
    const spawnFlat = Math.max(0, 1 - Math.hypot(x, z) / 26);
    h *= 1 - smooth(spawnFlat) * 0.86;

    return h;
  }

  /** Surface normal, from finite differences of the height field. */
  normal(x, z, eps = 0.9) {
    const hL = this.height(x - eps, z), hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps), hU = this.height(x, z + eps);
    const nx = hL - hR;
    const nz = hD - hU;
    const ny = 2 * eps;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** 0 = flat ground, 1 = vertical cliff. */
  slope(x, z) {
    return 1 - Math.max(0, Math.min(1, this.normal(x, z).y));
  }

  /** Can the player stand here? Steep faces and the rim wall are off-limits. */
  walkable(x, z) {
    return this.rim(x, z) < 0.93 && this.slope(x, z) < 0.55;
  }

  /**
   * Find a walkable spot near a desired ring distance from the centre.
   * Used for placing gates, landmarks and roaming spawns.
   */
  findSpot(rnd, minRadius, maxRadius, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const a = rnd() * Math.PI * 2;
      const d = minRadius + rnd() * (maxRadius - minRadius);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (this.walkable(x, z)) return { x, z, y: this.height(x, z) };
    }
    // Fall back to the flattest of a few candidates rather than failing.
    let best = null, bestSlope = Infinity;
    for (let i = 0; i < 24; i++) {
      const a = rnd() * Math.PI * 2;
      const d = minRadius + rnd() * (maxRadius - minRadius);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const s = this.slope(x, z);
      if (s < bestSlope) { bestSlope = s; best = { x, z, y: this.height(x, z) }; }
    }
    return best;
  }

  /**
   * Keep a position inside the playable bowl. Returns true if it was clamped,
   * so callers can also kill inbound velocity.
   */
  clampToWorld(pos, margin = 6) {
    const limit = this.half * 0.93 - margin;
    const d = Math.hypot(pos.x, pos.z);
    if (d > limit && d > 0.0001) {
      pos.x = (pos.x / d) * limit;
      pos.z = (pos.z / d) * limit;
      return true;
    }
    return false;
  }
}
