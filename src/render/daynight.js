import * as THREE from 'three';

// The world clock and the keyframe sampler — WORLD_SPEC dayNight.
//
// Pure data and arithmetic. THREE appears only as Color/Vector3 containers, so
// this module imports and runs in plain node with no browser and no renderer;
// that is deliberate, because the 15:00 contract below has to be checkable
// without booting the game.
//
// THREE LOAD-BEARING RULES LIVE HERE:
//
// (1) ONE LIGHT RIG. The sun and the moon are the SAME DirectionalLight. This
//     module never suggests otherwise: sample() emits ONE key colour, ONE key
//     intensity and ONE direction for every hour of the day. three bakes the
//     light count and the shadow-casting-light count into its program cache
//     key, so adding a "moon light" at dusk would recompile every material in
//     the scene on a phone, mid-frame.
//
// (2) THE 15:00 ROW IS THE SHIPPED GAME. city.js today builds fog 0xb6c6dc,
//     hemi 0x74a2da/0x5d6a4c at 1.05, and a key 0xfff0d6 at 2.45 aimed from
//     (58,74,40). The 15:00 keyframe reproduces those numbers exactly and the
//     sun path is FITTED THROUGH that direction rather than the other way
//     round. _verifyAnchor() asserts it; anything that breaks it changes the
//     frame the owner already signed off on.
//
// (3) DOUBLE-LINEAR SKY. Every keyframe carries TWO palettes: scenePalette
//     (fog/lights/env — plain working-space colour) and skyPalette (the
//     PRE-BRIGHTENED dome palette). sky.js converts a second time on the way
//     into the shader and city.js has always compensated with a brightened
//     SKY_BIOME; the keyframe table mirrors that convention exactly. The 15:00
//     skyPalette IS SKY_BIOME. "Fixing" the double conversion re-tones six
//     dungeons — see WORLD_SPEC auditFindings.skyPipeline.
//
// (4) THE NIGHT FLOOR IS MEASURED ON UNLIT GROUND, NOT IN THE PLAZA. The first
//     cut of the night rows was tuned in town and passed its luminance-floor
//     assert there — but the town's floor is made of ~100 lamp bulbs and lit
//     windows, and the Verge has neither. Measured on the world region (sky and
//     HUD cropped out) the plaza read 29-41/255 at night while the ash band read
//     10-13 with 82-91% of the frame under 16/255, i.e. black on a phone at
//     normal brightness, for the ~9 real minutes in every 24 that are night.
//     There is no per-region fix available: ONE hemisphere light and ONE
//     directional serve the whole world by rule (1), so the floor has to be
//     raised globally and the city simply gets a brighter night with it. The
//     lift is carried mostly by hemiSky — terrain normals point up, so that is
//     the term the open country actually reads — with a smaller lift on
//     hemiGround (moonlit bounce onto undersides and walls), a moderate one on
//     the key, and the SMALLEST one on envIntensity, because the baked HDRI is a
//     daylight probe and leaning on it at midnight tints the dark toward noon.
//     tools/daynight-test.mjs's verge-night phase is the mechanical guard: it
//     stands the player in each biome band with no lamp in frame and asserts the
//     same floor the plaza has always been asserted against.

const DEG = Math.PI / 180;

/** 24 real minutes = 24 game hours, so one real second is one game minute. */
export const CYCLE_MINUTES = 24;

// --------------------------------------------------------------- keyframes

// scenePalette drives fog / hemi / key / environmentIntensity; skyPalette
// drives the dome uniforms. Hours ascend and the table wraps 22.0 -> 24.0
// (= the 0.0 row), which is why deep night appears at both ends.
export const KEYFRAMES = [
  {
    hour: 0.0,
    name: 'deep night',
    // Lifted off the spec's design targets per rule (4): 0x2c3560/0x1e2233 at
    // 0.34 with a 0.55 key is a black frame anywhere the town's lamps do not
    // reach. Hue is unchanged — this is the same blue hour, exposed so you can
    // see the ground you are standing on.
    scenePalette: {
      fog: 0x262c48, keyColor: 0x9fb4e8, keyIntensity: 0.62,
      hemiSky: 0x44538f, hemiGround: 0x323a55, hemiIntensity: 1.02, envIntensity: 0.38,
    },
    skyPalette: { zenith: 0x0e1430, horizon: 0x232a4a, ground: 0x11131f, accent: 0x7c5cff },
    stars: 1.0, aurora: 0.45, windowGlow: 1.0, lampGlow: 1.0, portalBoost: 1.6,
    sunDisc: 0.0, moonDisc: 0.8,
  },
  {
    hour: 5.0,
    name: 'pre-dawn',
    scenePalette: {
      fog: 0x484b66, keyColor: 0xb8c2e0, keyIntensity: 0.70,
      hemiSky: 0x5a6799, hemiGround: 0x3c4058, hemiIntensity: 0.95, envIntensity: 0.42,
    },
    skyPalette: { zenith: 0x1c2440, horizon: 0x4a4668, ground: 0x1a1c2a, accent: 0x8a6cd0 },
    stars: 0.6, aurora: 0.25, windowGlow: 0.7, lampGlow: 0.8, portalBoost: 1.3,
    sunDisc: 0.0, moonDisc: 0.4,
  },
  {
    hour: 6.5,
    name: 'sunrise',
    scenePalette: {
      fog: 0xd9a37c, keyColor: 0xffb36b, keyIntensity: 1.45,
      hemiSky: 0x7a86b8, hemiGround: 0x4a4438, hemiIntensity: 0.70, envIntensity: 0.70,
    },
    skyPalette: { zenith: 0x4a6a9e, horizon: 0xf5b57a, ground: 0x6a5c50, accent: 0xffc98a },
    stars: 0.12, aurora: 0.0, windowGlow: 0.35, lampGlow: 0.3, portalBoost: 1.0,
    sunDisc: 0.9, moonDisc: 0.0,
  },
  {
    hour: 9.0,
    name: 'morning',
    scenePalette: {
      fog: 0xc4d2e4, keyColor: 0xfff4dd, keyIntensity: 2.2,
      hemiSky: 0x86aede, hemiGround: 0x5d6a4c, hemiIntensity: 1.0, envIntensity: 0.95,
    },
    skyPalette: { zenith: 0x9cc0ee, horizon: 0xe6edf6, ground: 0x9aa885, accent: 0xfff0d8 },
    stars: 0.0, aurora: 0.06, windowGlow: 0.15, lampGlow: 0.0, portalBoost: 1.0,
    sunDisc: 0.6, moonDisc: 0.0,
  },
  {
    hour: 12.5,
    name: 'noon',
    scenePalette: {
      fog: 0xc9d6e6, keyColor: 0xfff8ec, keyIntensity: 2.6,
      hemiSky: 0x7fb0e6, hemiGround: 0x66744f, hemiIntensity: 1.1, envIntensity: 1.0,
    },
    skyPalette: { zenith: 0x6fa8e8, horizon: 0xe8eef6, ground: 0xa2b08c, accent: 0xffffff },
    stars: 0.0, aurora: 0.0, windowGlow: 0.1, lampGlow: 0.0, portalBoost: 1.0,
    sunDisc: 0.55, moonDisc: 0.0,
  },
  {
    // THE CONTRACT ROW. Every constant here is what city.js hardcodes today.
    hour: 15.0,
    name: 'afternoon (SHIPPED LOOK — CONTRACT)',
    scenePalette: {
      fog: 0xb6c6dc, keyColor: 0xfff0d6, keyIntensity: 2.45,
      hemiSky: 0x74a2da, hemiGround: 0x5d6a4c, hemiIntensity: 1.05, envIntensity: 1.0,
    },
    // ... and this is SKY_BIOME, byte for byte.
    skyPalette: { zenith: 0xb6d3f5, horizon: 0xdfe8f4, ground: 0x9aa885, accent: 0xffeccd },
    stars: 0.0, aurora: 0.12, windowGlow: 0.2, lampGlow: 0.0, portalBoost: 1.0,
    sunDisc: 0.5, moonDisc: 0.0,
  },
  {
    hour: 18.5,
    name: 'sunset',
    scenePalette: {
      fog: 0xe0a988, keyColor: 0xff9a4d, keyIntensity: 1.6,
      hemiSky: 0x9080a8, hemiGround: 0x54463c, hemiIntensity: 0.75, envIntensity: 0.70,
    },
    skyPalette: { zenith: 0x5a5a96, horizon: 0xffb376, ground: 0x6a5648, accent: 0xff9e66 },
    stars: 0.05, aurora: 0.0, windowGlow: 0.5, lampGlow: 0.4, portalBoost: 1.2,
    sunDisc: 1.0, moonDisc: 0.0,
  },
  {
    hour: 19.8,
    name: 'dusk (portal hour)',
    scenePalette: {
      // 21:00 — the hour the black-frame report measured worst — is 57% of the
      // way from this row to the 22:00 one, so the night floor has to start
      // rising HERE or more than half the lift never reaches it.
      fog: 0x635d82, keyColor: 0xc0a8d8, keyIntensity: 0.80,
      hemiSky: 0x6a6fa4, hemiGround: 0x413c56, hemiIntensity: 0.86, envIntensity: 0.52,
    },
    skyPalette: { zenith: 0x2a3060, horizon: 0x8a6a9e, ground: 0x2a2438, accent: 0xb08ae0 },
    stars: 0.35, aurora: 0.2, windowGlow: 0.9, lampGlow: 1.0, portalBoost: 1.6,
    sunDisc: 0.15, moonDisc: 0.2,
  },
  {
    hour: 22.0,
    name: 'night',
    scenePalette: {
      fog: 0x262c48, keyColor: 0x9fb4e8, keyIntensity: 0.60,
      hemiSky: 0x44538f, hemiGround: 0x323a55, hemiIntensity: 0.98, envIntensity: 0.38,
    },
    skyPalette: { zenith: 0x0e1430, horizon: 0x232a4a, ground: 0x11131f, accent: 0x7c5cff },
    stars: 1.0, aurora: 0.4, windowGlow: 1.0, lampGlow: 1.0, portalBoost: 1.6,
    sunDisc: 0.0, moonDisc: 0.7,
  },
];

// The sampler reads from the prebuilt table below, not from KEYFRAMES, so a
// consumer that edited a row at runtime would change nothing and spend an hour
// finding out why. Freeze it: the table is a contract, not a tuning knob.
for (const k of KEYFRAMES) {
  Object.freeze(k.scenePalette);
  Object.freeze(k.skyPalette);
  Object.freeze(k);
}
Object.freeze(KEYFRAMES);

// Colours prebuilt once. new THREE.Color(hex) lands in the linear working
// space (ColorManagement is on), so lerping these IS the "lerp in linear
// colour space" the spec asks for — and building them here is what makes
// sample() allocation-free.
const _rows = KEYFRAMES.map((k) => ({
  hour: k.hour,
  fog: new THREE.Color(k.scenePalette.fog),
  keyColor: new THREE.Color(k.scenePalette.keyColor),
  keyIntensity: k.scenePalette.keyIntensity,
  hemiSky: new THREE.Color(k.scenePalette.hemiSky),
  hemiGround: new THREE.Color(k.scenePalette.hemiGround),
  hemiIntensity: k.scenePalette.hemiIntensity,
  envIntensity: k.scenePalette.envIntensity,
  zenith: new THREE.Color(k.skyPalette.zenith),
  horizon: new THREE.Color(k.skyPalette.horizon),
  ground: new THREE.Color(k.skyPalette.ground),
  accent: new THREE.Color(k.skyPalette.accent),
  stars: k.stars,
  aurora: k.aurora,
  windowGlow: k.windowGlow,
  lampGlow: k.lampGlow,
  portalBoost: k.portalBoost,
  sunDisc: k.sunDisc,
  moonDisc: k.moonDisc,
}));

// --------------------------------------------------------------- sun path

const SUNRISE_HOUR = 6.0;
const SUNSET_HOUR = 19.2;                       // 19:12
const DAY_SPAN = SUNSET_HOUR - SUNRISE_HOUR;    // 13.2 h of daylight
const NIGHT_SPAN = 24 - DAY_SPAN;               // 10.8 h of night
const AZ_SPAN_DAY = 190 * DEG;
// The body keeps sweeping the same way after dark, closing the circle over the
// short night. That is what keeps the direction CONTINUOUS across the horizon
// swap: there is no instant where the light teleports to the opposite side of
// the sky, which would flip every shadow in the city in one frame.
const AZ_SPAN_NIGHT = (360 - 190) * DEG;
const SUN_ELEV_MAX = 62 * DEG;
const MOON_ELEV_MAX = 40 * DEG;

// Shadow aim, per WORLD_SPEC auditFindings.shadowPath.
const SHADOW_MIN_ELEV = 12 * DEG;   // below this a 22 m ortho frustum acnes
const SHADOW_QUANT = 0.75 * DEG;    // re-aim in steps, or every edge crawls
const KEY_FLOOR = 0.18;             // shadowed surfaces never go black
// Half-width of the horizon swap: the key fades toward the floor as the body
// grazes the horizon and comes back up as its opposite number takes over, so
// the 180-degree hand-off happens while the directional contribution is
// nearly nothing. Narrow enough that the 18:30 sunset keyframe (sun at ~3
// degrees) still gets its full authored 1.6.
const HORIZON_FADE_ELEV = 2.5 * DEG;

// The rift band in sky.js is hardcoded at azimuth 0.75 rad. It only starts
// tracking the sun once the sun is low; at 15:00 the weight is exactly zero, so
// the shipped dome is untouched.
const DEFAULT_ACCENT_AZ = 0.75;
const ACCENT_TRACK_ELEV = 18 * DEG;

// Fog near/far tighten 12% at deep night for mystery. Driven off `stars`
// because that is the table's own night signal and it is already lerped —
// stepping the fog would read as a bug.
const FOG_NIGHT_TIGHTEN = 0.12;

// 22:00-04:00 opens on a sunrise instead. WORLD_SPEC: "nudge to 05:10".
const BOOT_BIAS_HOUR = 5.17;

// THE ANCHOR. Everything about the path is derived from the shipped light, so
// the fit cannot drift away from it by editing a constant somewhere else.
const ANCHOR_HOUR = 15.0;
const ANCHOR_DIR = new THREE.Vector3(58, 74, 40).normalize();
const ANCHOR_ELEV = Math.asin(ANCHOR_DIR.y);                  // 46.396 deg
const ANCHOR_AZ = Math.atan2(ANCHOR_DIR.z, ANCHOR_DIR.x);     // 34.598 deg
const ANCHOR_U = (ANCHOR_HOUR - SUNRISE_HOUR) / DAY_SPAN;

// Elevation is SUN_ELEV_MAX * sin(pi*u)^shape: it peaks at exactly 62 degrees
// at u = 0.5 (12:36, as specced) and the exponent is solved so the curve also
// passes through the anchor's 46.396 degrees at 15:00. A plain sine misses the
// anchor by ~6 degrees; a fitted exponent is the cheapest curve that honours
// both ends of the contract.
const ELEV_SHAPE = Math.log(ANCHOR_ELEV / SUN_ELEV_MAX) / Math.log(Math.sin(Math.PI * ANCHOR_U));

// Azimuth is linear in u across the 190-degree arc, positioned so the anchor
// lands on it. Solar noon therefore sits at az ~= 0, i.e. +X.
//
// HONEST CONSEQUENCE, flagged rather than hidden: city.js's compass is "-Z is
// north, +X is east", so this path has the body rising near the game's NORTH
// and setting near its SOUTH. The travel direction and the culmination point
// are internally consistent (it is a real sun path rotated 90 degrees); it is
// the world's compass labels that are out of phase with it. The anchor wins
// because WORLD_SPEC decision (2) makes the 15:00 frame byte-for-byte binding,
// and the shipped key light sits east-south-east — no arc from ENE to WSW can
// pass through it at 15:00. Re-aiming the compass is a cheap future fix;
// re-aiming the anchor is not.
const AZ_NOON = ANCHOR_AZ - AZ_SPAN_DAY * (ANCHOR_U - 0.5);
const AZ_SUNSET = AZ_NOON + AZ_SPAN_DAY * 0.5;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep01 = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** Wrap any hour value into [0, 24). */
function wrapHours(h) {
  if (!Number.isFinite(h)) return ANCHOR_HOUR;
  const w = h % 24;
  return w < 0 ? w + 24 : w;
}

// Scratch for the angle pair, so sample() allocates nothing.
const _ang = { elev: 0, az: 0 };

/** Celestial elevation/azimuth of the SUN at `h`; negative elevation at night. */
function sunAngles(h) {
  if (h >= SUNRISE_HOUR && h < SUNSET_HOUR) {
    const u = (h - SUNRISE_HOUR) / DAY_SPAN;
    _ang.elev = SUN_ELEV_MAX * Math.pow(Math.sin(Math.PI * u), ELEV_SHAPE);
    _ang.az = AZ_NOON + AZ_SPAN_DAY * (u - 0.5);
  } else {
    const nh = h < SUNRISE_HOUR ? h + 24 : h;         // 19.2 .. 30.0
    const v = (nh - SUNSET_HOUR) / NIGHT_SPAN;
    _ang.elev = -MOON_ELEV_MAX * Math.sin(Math.PI * v);
    _ang.az = AZ_SUNSET + AZ_SPAN_NIGHT * v;
  }
  // Fold into [-pi, pi]. The direction does not care (cos/sin are periodic and
  // the daytime arc never leaves the range, so the 15:00 anchor is untouched),
  // but accentAz is compared against the dome shader's atan2 output, which
  // does — an unfolded 4.6 rad would park the rift band on the wrong horizon
  // at dawn.
  if (_ang.az > Math.PI) _ang.az -= 2 * Math.PI;
  else if (_ang.az < -Math.PI) _ang.az += 2 * Math.PI;
  return _ang;
}

function setDir(out, elev, az) {
  const c = Math.cos(elev);
  out.set(c * Math.cos(az), Math.sin(elev), c * Math.sin(az));
}

/** Snap to the quantisation grid that has the shipped direction on it. */
function quantise(v, anchor) {
  return anchor + Math.round((v - anchor) / SHADOW_QUANT) * SHADOW_QUANT;
}

// ---------------------------------------------------------------- DayState

/**
 * A caller-owned scratch object. sample() writes into it and never allocates,
 * so a mode can hold one for the life of the session.
 */
export function makeDayState() {
  return {
    hours: ANCHOR_HOUR,
    // Where the body IS (may be below the horizon; sky.js draws the moon at
    // -sunDir, which is why one vector serves both discs).
    sunDir: new THREE.Vector3(),
    // Where the DirectionalLight aims from: whichever body is up, elevation
    // clamped and quantised for the shadow snap.
    shadowDir: new THREE.Vector3(),
    keyColor: new THREE.Color(),
    keyIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    fogColor: new THREE.Color(),
    fogScale: 1,
    envIntensity: 1,
    sky: {
      zenith: new THREE.Color(),
      horizon: new THREE.Color(),
      ground: new THREE.Color(),
      accent: new THREE.Color(),
      accentAz: DEFAULT_ACCENT_AZ,
    },
    stars: 0,
    aurora: 0,
    windowGlow: 0,
    lampGlow: 0,
    portalBoost: 1,
    sunDisc: 0,
    moonDisc: 0,
  };
}

/**
 * A cold start in the small hours would open on a black screen. The owner
 * asked for sunrises; bias toward one rather than punish them for quitting at
 * midnight. Identity for every other hour, so a session resumed at 14:00
 * resumes at 14:00.
 */
export function bootBias(hours) {
  const h = wrapHours(hours);
  return (h >= 22 || h < 4) ? BOOT_BIAS_HOUR : h;
}

// -------------------------------------------------------------- WorldClock

export class WorldClock {
  constructor({ hours = ANCHOR_HOUR } = {}) {
    this.hours = wrapHours(hours);
  }

  /** dt in real seconds. 24 real minutes make one full 24 h cycle. */
  tick(dtSeconds) {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    this.hours = wrapHours(this.hours + dtSeconds * (24 / (CYCLE_MINUTES * 60)));
  }

  setHours(h) {
    this.hours = wrapHours(h);
  }

  /** Fill a DayState from makeDayState(). Returns it; allocates nothing. */
  sample(out) {
    const h = this.hours;
    out.hours = h;

    // Segment. Nine rows, so a linear scan is cheaper than any index maths and
    // impossible to get wrong when someone edits the table.
    let i = _rows.length - 1;
    for (let j = 0; j < _rows.length - 1; j++) {
      if (h < _rows[j + 1].hour) { i = j; break; }
    }
    const a = _rows[i];
    const b = _rows[(i + 1) % _rows.length];
    const h0 = a.hour;
    const h1 = i === _rows.length - 1 ? 24 + b.hour : b.hour;
    // Easing, not a straight ramp: linear keyframe interpolation makes every
    // keyframe hour a visible crease in the light.
    const t = smoothstep01((h - h0) / (h1 - h0));

    out.fogColor.copy(a.fog).lerp(b.fog, t);
    out.keyColor.copy(a.keyColor).lerp(b.keyColor, t);
    out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
    out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
    out.hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);
    out.envIntensity = lerp(a.envIntensity, b.envIntensity, t);

    out.sky.zenith.copy(a.zenith).lerp(b.zenith, t);
    out.sky.horizon.copy(a.horizon).lerp(b.horizon, t);
    out.sky.ground.copy(a.ground).lerp(b.ground, t);
    out.sky.accent.copy(a.accent).lerp(b.accent, t);

    out.stars = lerp(a.stars, b.stars, t);
    out.aurora = lerp(a.aurora, b.aurora, t);
    out.windowGlow = lerp(a.windowGlow, b.windowGlow, t);
    out.lampGlow = lerp(a.lampGlow, b.lampGlow, t);
    out.portalBoost = lerp(a.portalBoost, b.portalBoost, t);
    out.sunDisc = lerp(a.sunDisc, b.sunDisc, t);
    out.moonDisc = lerp(a.moonDisc, b.moonDisc, t);

    out.fogScale = 1 - FOG_NIGHT_TIGHTEN * clamp01(out.stars);

    const { elev, az } = sunAngles(h);
    setDir(out.sunDir, elev, az);

    // The DirectionalLight follows whichever body is above the horizon. Same
    // light, same castShadow, only the aim and the colour change.
    const up = elev >= 0;
    const keyElev = up ? elev : -elev;
    const keyAz = up ? az : az + Math.PI;

    // Quantise FIRST, clamp second. The other order lets a grid step round the
    // clamped value back under 12 degrees; this way the low-sun hours pin to a
    // flat, perfectly stable 12 while the sky shows the true lower sun.
    const qEl = Math.max(SHADOW_MIN_ELEV, quantise(keyElev, ANCHOR_ELEV));
    const qAz = quantise(keyAz, ANCHOR_AZ);
    // The grid is anchored ON the shipped direction, so 15:00 lands on it
    // exactly. Copy the constant there rather than round-tripping it through
    // asin/atan2/cos/sin: the contract is that this IS city.js's _lightDir,
    // and float epsilon is not a reason to make that only nearly true.
    if (qEl === ANCHOR_ELEV && qAz === ANCHOR_AZ) out.shadowDir.copy(ANCHOR_DIR);
    else setDir(out.shadowDir, qEl, qAz);

    // Dip through the horizon swap so the 180-degree hand-off is invisible,
    // but never below the floor — a black-shadowed city is what the glow-wash
    // postmortem in city.js is about.
    const swap = smoothstep01(Math.abs(elev) / HORIZON_FADE_ELEV);
    out.keyIntensity = Math.max(KEY_FLOOR, lerp(a.keyIntensity, b.keyIntensity, t) * swap);

    // The rift band drifts onto the sun only while the sun is low.
    const track = 1 - smoothstep01(Math.abs(elev) / ACCENT_TRACK_ELEV);
    out.sky.accentAz = DEFAULT_ACCENT_AZ + (az - DEFAULT_ACCENT_AZ) * track;

    return out;
  }
}

// ------------------------------------------------------------- self-test

/**
 * The 15:00 contract, as code. Exported so a node one-liner, the harness and
 * any future tool all assert the SAME thing instead of three drifting copies.
 * Returns { ok, checks: [{ name, ok, got, want }] }.
 */
export function _verifyAnchor() {
  const clock = new WorldClock({ hours: ANCHOR_HOUR });
  const s = clock.sample(makeDayState());
  const want = new THREE.Vector3(58, 74, 40).normalize();
  const checks = [
    ['fog', s.fogColor.getHex(), 0xb6c6dc],
    ['keyColor', s.keyColor.getHex(), 0xfff0d6],
    ['keyIntensity', s.keyIntensity, 2.45],
    ['hemiSky', s.hemiSky.getHex(), 0x74a2da],
    ['hemiGround', s.hemiGround.getHex(), 0x5d6a4c],
    ['hemiIntensity', s.hemiIntensity, 1.05],
    ['envIntensity', s.envIntensity, 1.0],
    ['fogScale', s.fogScale, 1.0],
    // The dome at 15:00 must be SKY_BIOME, or the shipped sky changes tone.
    ['sky.zenith', s.sky.zenith.getHex(), 0xb6d3f5],
    ['sky.horizon', s.sky.horizon.getHex(), 0xdfe8f4],
    ['sky.ground', s.sky.ground.getHex(), 0x9aa885],
    ['sky.accent', s.sky.accent.getHex(), 0xffeccd],
    ['sky.accentAz', s.sky.accentAz, DEFAULT_ACCENT_AZ],
    ['stars', s.stars, 0.0],
    ['aurora', s.aurora, 0.12],
    ['lampGlow', s.lampGlow, 0.0],
    ['portalBoost', s.portalBoost, 1.0],
    // Bit-exact: this vector is city.js's module-level _lightDir.
    ['shadowDir.x', s.shadowDir.x, want.x],
    ['shadowDir.y', s.shadowDir.y, want.y],
    ['shadowDir.z', s.shadowDir.z, want.z],
  ].map(([name, got, wanted]) => ({ name, ok: got === wanted, got, want: wanted }));

  // sunDir is reconstructed through trig rather than copied, so it is held to
  // float tolerance rather than identity.
  const sunErr = Math.max(
    Math.abs(s.sunDir.x - want.x), Math.abs(s.sunDir.y - want.y), Math.abs(s.sunDir.z - want.z),
  );
  checks.push({ name: 'sunDir≈anchor', ok: sunErr < 1e-12, got: sunErr, want: '< 1e-12' });

  return { ok: checks.every((c) => c.ok), checks };
}
