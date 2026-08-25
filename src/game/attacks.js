// Combat resolution: swept hitboxes, aim assist, enemy attack patterns, boss
// phases and hit reactions. Tables plus pure resolvers — nothing in here
// touches the scene, three, or game state it does not own, so the caller keeps
// full control over presentation and can unit-test the maths on its own.
//
// Deliberately free of `three`: every function works in scalars and writes into
// caller-supplied or module-scope scratch. A frame of combat allocates nothing.
//
// Three ideas hold the file together:
//
//   1. A hit is a *sweep*, not an instant. An attack arms a shape at the start
//      of its active window and advances it every frame; targets are collected
//      from the band actually covered since the previous frame. That is what
//      makes a slow overhead feel like it travels and stops a fast weapon from
//      whiffing through a target that walked across the arc between two frames.
//
//   2. Every attacker — grunt, brute, boss — runs the *same* four-stage state
//      machine (idle → windup → active → recover) over a data-only pattern.
//      Archetypes differ by their numbers and their tells, never by bespoke
//      code paths in game.js. "Stage" is always within one attack; "phase" is
//      always a boss health phase. The two never mean the same thing here.
//
//   3. Getting hit is a resource, not a flag. Light hits spend poise; only an
//      empty poise pool staggers. That is the difference between "every hit
//      cancels the enemy" and "chip at it until it breaks".

const TAU = Math.PI * 2;

function wrap(a) {
  // Angles arrive from atan2 already in (-PI, PI], but sums of them do not.
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

// Ease ids are stored as numbers on the sweep so the hot path never compares
// strings; the data tables still spell them out.
const EASE_LINEAR = 0, EASE_OUT = 1, EASE_IN = 2;
const EASE_IDS = { linear: EASE_LINEAR, out: EASE_OUT, in: EASE_IN };

function applyEase(id, k) {
  if (id === EASE_OUT) return 1 - (1 - k) * (1 - k);
  if (id === EASE_IN) return k * k;
  return k;
}

// THE DICE CONTRACT (Wave D stage 2). Every roll in this module is a combat
// DECISION, and combat decisions are SIM: a replayed gate seed must pick the
// same jab on the same frame. The original draft defaulted these rngs to
// Math.random; that default is deliberately GONE rather than kept as a quiet
// fallback, because a fallback is exactly how an unseeded roll would sneak
// back in through a new call site and split replays silently. A caller that
// forgets its stream fails loudly at dev time instead. game.js hands in its
// _combatRnd fork (mulberry32 off the gate seed, 0x94d049bb).
function requireRnd(rnd) {
  if (typeof rnd !== 'function') {
    throw new Error('attacks.js: seeded rng required — combat decisions are SIM, never Math.random');
  }
  return rnd;
}

/** Roll a value from a `[lo, hi]` table entry with a caller-supplied SEEDED rng. */
export function range2(band, rnd) {
  return band[0] + (band[1] - band[0]) * requireRnd(rnd)();
}

// ===========================================================================
// 1. SWEPT HITBOXES
// ===========================================================================

export const SHAPE = { CONE: 'cone', CAPSULE: 'capsule', CIRCLE: 'circle' };
const SHAPE_CONE = 0, SHAPE_CAPSULE = 1, SHAPE_CIRCLE = 2;
const SHAPE_IDS = { cone: SHAPE_CONE, capsule: SHAPE_CAPSULE, circle: SHAPE_CIRCLE };

/**
 * A reusable swept-hitbox. One per attacker; arm it, advance it, read hits.
 *
 * `already` is a plain array rather than a Set on purpose: it never holds more
 * than a handful of references, linear scan beats hashing at that size, and
 * `length = 0` reuses the same backing store forever. A Set would rehash as it
 * grew and hand the GC a new bucket table on every swing.
 */
export function makeSweep() {
  return {
    live: false,
    shape: SHAPE_CONE,
    ox: 0, oz: 0, yaw: 0,
    inner: 0, range: 2.5, arc: Math.PI * 0.6, thickness: 0.8,
    sweepArc: 0, sweepDir: 1,
    expand: false, ease: EASE_LINEAR,
    follow: true,        // does the shape ride the attacker, or stay where it was armed?
    duration: 0.12, t: 0, k: 0, prevK: 0,
    pass: 0,             // damage application index within a multi-hit window
    already: [],
  };
}

/**
 * Begin a sweep. `spec` is read once and copied out, so shared table data can
 * be passed straight in and is never mutated or retained.
 *
 * spec: { shape, range, inner, arc, thickness, sweepArc, sweepDir, expand,
 *         ease, follow, duration }
 */
export function armSweep(sw, spec, ox, oz, yaw) {
  sw.live = true;
  sw.shape = SHAPE_IDS[spec.shape] ?? SHAPE_CONE;
  sw.ox = ox; sw.oz = oz; sw.yaw = yaw;
  sw.inner = spec.inner ?? 0;
  sw.range = spec.range ?? 2.5;
  sw.arc = spec.arc ?? Math.PI * 0.6;
  sw.thickness = spec.thickness ?? 0.8;
  // A swing that only tests its final cone reads as a teleporting hitbox. The
  // sweep arc is how far the cone *travels* during the active window, on top of
  // its own width.
  sw.sweepArc = spec.sweepArc ?? 0;
  sw.sweepDir = spec.sweepDir ?? 1;
  sw.expand = !!spec.expand;
  sw.ease = EASE_IDS[spec.ease] ?? EASE_LINEAR;
  sw.follow = spec.follow !== false;
  sw.duration = Math.max(0.0001, spec.duration ?? 0.12);
  sw.t = 0; sw.k = 0; sw.prevK = 0;
  sw.pass = 0;
  sw.already.length = 0;
  return sw;
}

/**
 * Clear the already-hit list without disturbing the geometry — used between the
 * individual applications of a multi-hit window (a stalker's flurry) so each
 * jab can land on the same target while a single jab still cannot hit twice.
 */
export function rearmSweep(sw) {
  sw.already.length = 0;
  sw.pass++;
  return sw;
}

/**
 * Collapse the whole window into one test — for instantaneous area effects
 * (Nova, a skill that has no travel) that still want the shape and the
 * already-hit bookkeeping.
 */
export function sweepAll(sw) {
  sw.prevK = 0;
  sw.k = 1;
  sw.t = sw.duration;
  sw.live = false;
  return sw;
}

/** Advance the sweep. Pass the attacker's live transform when `follow`. */
export function advanceSweep(sw, dt, ox, oz, yaw) {
  if (!sw.live) return sw;
  if (sw.follow) {
    if (ox !== undefined) { sw.ox = ox; sw.oz = oz; }
    if (yaw !== undefined) sw.yaw = yaw;
  }
  sw.prevK = sw.k;
  sw.t += dt;
  sw.k = clamp01(sw.t / sw.duration);
  if (sw.t >= sw.duration) sw.live = false;
  return sw;
}

/** Anchor a sweep to a fixed world point (delayed ground AoE, hex pools). */
export function anchorSweep(sw, x, z) {
  sw.ox = x; sw.oz = z; sw.follow = false;
  return sw;
}

function sweptCone(sw, dx, dz, dist, tRadius) {
  const half = sw.arc * 0.5;
  // Angular slack for the target's own width — a brute standing at the edge of
  // the arc should be clipped by it, not missed by its centre point.
  const pad = dist > 0.001 ? Math.asin(clamp(tRadius / dist, 0, 1)) : Math.PI;
  const travel = sw.sweepArc * sw.sweepDir;
  const o0 = -travel * 0.5 + travel * applyEase(sw.ease, sw.prevK);
  const o1 = -travel * 0.5 + travel * applyEase(sw.ease, sw.k);
  const lo = Math.min(o0, o1) - half - pad;
  const hi = Math.max(o0, o1) + half + pad;
  if (hi - lo >= TAU) return true;
  const rel = wrap(Math.atan2(dx, dz) - sw.yaw);
  // The band can straddle the wrap point once sweepArc is wide, so test the
  // neighbouring turns too rather than normalising the band itself.
  return (rel >= lo && rel <= hi)
    || (rel + TAU >= lo && rel + TAU <= hi)
    || (rel - TAU >= lo && rel - TAU <= hi);
}

function sweptCapsule(sw, dx, dz, tRadius) {
  const fx = Math.sin(sw.yaw), fz = Math.cos(sw.yaw);
  // The thrust only ever extends during its active window, so the far end at
  // the current k already covers everything swept since the last frame.
  const len = lerp(sw.inner, sw.range, applyEase(sw.ease, sw.k));
  let along = dx * fx + dz * fz;
  along = clamp(along, sw.inner, len);
  const px = dx - fx * along;
  const pz = dz - fz * along;
  const reach = sw.thickness + tRadius;
  return px * px + pz * pz <= reach * reach;
}

function sweptCircle(sw, dist, tRadius) {
  if (!sw.expand) return dist - tRadius <= sw.range && dist + tRadius >= sw.inner;
  // An expanding shockwave is a moving annulus: it hits what its leading edge
  // crossed this frame, so standing inside a passed wave is safe.
  const r1 = lerp(sw.inner, sw.range, applyEase(sw.ease, sw.k)) + sw.thickness;
  const r0 = lerp(sw.inner, sw.range, applyEase(sw.ease, sw.prevK)) - sw.thickness;
  return dist - tRadius <= r1 && dist + tRadius >= r0;
}

/** Geometry test only — no bookkeeping. Useful for previews and AI checks. */
export function sweepContains(sw, tx, tz, tRadius = 0) {
  const dx = tx - sw.ox, dz = tz - sw.oz;
  if (sw.shape === SHAPE_CAPSULE) return sweptCapsule(sw, dx, dz, tRadius);
  const dist = Math.hypot(dx, dz);
  if (sw.shape === SHAPE_CIRCLE) return sweptCircle(sw, dist, tRadius);
  if (dist > sw.range + tRadius || dist < sw.inner - tRadius) return false;
  return sweptCone(sw, dx, dz, dist, tRadius);
}

/** Default rejection: dead, still rising out of the floor, or already hit. */
export function liveTarget(e) {
  return e && e.hp > 0 && !(e.spawning > 0);
}

/**
 * Collect everything the sweep newly covers into `out` (cleared first) and mark
 * it hit for the rest of this application. Returns the number of new hits.
 */
export function collectSweep(sw, list, out, filter = liveTarget) {
  out.length = 0;
  const already = sw.already;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!filter(e)) continue;
    let seen = false;
    for (let j = 0; j < already.length; j++) if (already[j] === e) { seen = true; break; }
    if (seen) continue;
    if (!sweepContains(sw, e.pos.x, e.pos.z, e.radius || 0)) continue;
    already.push(e);
    out.push(e);
  }
  return out.length;
}

// Sentinel so the player can share one already-hit list with enemy entities.
const PLAYER_TOKEN = { player: true };

/** Single-point version for the player, who is one target rather than a list. */
export function sweepHitsPoint(sw, tx, tz, tRadius = 0) {
  for (let j = 0; j < sw.already.length; j++) if (sw.already[j] === PLAYER_TOKEN) return false;
  if (!sweepContains(sw, tx, tz, tRadius)) return false;
  sw.already.push(PLAYER_TOKEN);
  return true;
}

// ===========================================================================
// 2. TARGET PRIORITY AND SOFT AIM ASSIST
// ===========================================================================

/**
 * On a thumbstick you are aiming with the same finger you are walking with, at
 * a target the size of a fingernail. Snapping to the *nearest* enemy is the
 * classic mistake: it steals the swing you aimed at the caster and gives it to
 * the grunt bumping your hip. Priority is therefore angle-first, distance
 * second, with small nudges for the things a player means to hit.
 */
export const AIM = {
  cone: Math.PI * 0.40,      // hard limit: nothing outside this is a candidate
  softCone: Math.PI * 0.13,  // inside this the swing snaps fully onto the target
  rangePad: 1.1,             // assist reaches slightly past the hitbox
  maxTurn: Math.PI * 0.6,    // a swing may never be rotated further than this
  angleWeight: 1.0,
  distWeight: 0.42,
  sticky: 0.30,              // stay on the enemy you were already fighting
  finishBonus: 0.20,         // below finishAt health, prefer the kill
  finishAt: 0.25,
  staggerBonus: 0.16,        // a staggered enemy is the one you set up
  bossBonus: 0.10,
  deadzone: 0.18,            // stick magnitude below this means "no aim input"
};

const _aim = { x: 0, z: 1, moved: false };

/**
 * Aim direction for this frame. Uses the stick when it is pushed, otherwise the
 * character's facing, so a standing attack goes where you are looking.
 * Returns shared scratch — read it, do not keep it.
 */
export function aimDirection(mvX, mvY, yaw, tune = AIM) {
  const mag = Math.hypot(mvX, mvY);
  if (mag > tune.deadzone) {
    // Stick +y is forward, which is -z in world space (matches game.js input).
    _aim.x = mvX / mag; _aim.z = -mvY / mag; _aim.moved = true;
  } else {
    _aim.x = Math.sin(yaw); _aim.z = Math.cos(yaw); _aim.moved = false;
  }
  return _aim;
}

/**
 * Best target for a swing from (ox,oz) pointing along (ax,az).
 * `prev` is the previously assisted target and gets the stickiness bonus.
 */
export function pickTarget(list, ox, oz, ax, az, reach, tune = AIM, prev = null, filter = liveTarget) {
  let best = null, bestScore = -Infinity;
  const maxDist = reach + tune.rangePad;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!filter(e)) continue;
    const dx = e.pos.x - ox, dz = e.pos.z - oz;
    const dist = Math.hypot(dx, dz);
    const r = e.radius || 0;
    if (dist > maxDist + r) continue;
    let ang;
    if (dist < 0.001) {
      ang = 0;
    } else {
      const dot = clamp((dx * ax + dz * az) / dist, -1, 1);
      // Credit the target's width: a brute you are half inside counts as dead
      // ahead even when its centre is off to one side.
      ang = Math.max(0, Math.acos(dot) - Math.asin(clamp(r / Math.max(dist, r), 0, 1)));
    }
    if (ang > tune.cone) continue;
    let score = (1 - ang / tune.cone) * tune.angleWeight
      + (1 - dist / (maxDist + r)) * tune.distWeight;
    if (e === prev) score += tune.sticky;
    if (e.maxHp && e.hp / e.maxHp < tune.finishAt) score += tune.finishBonus;
    if (e.stagger > 0) score += tune.staggerBonus;
    if (e.isBoss) score += tune.bossBonus;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

/**
 * Yaw for the swing: rotate toward the target, fully inside the soft cone and
 * tapering to nothing at the edge of the assist cone, clamped by maxTurn. The
 * taper is what keeps assist from feeling like the game grabbing your hand —
 * a deliberate swing past an enemy still misses it.
 */
export function assistedYaw(currentYaw, ox, oz, target, tune = AIM) {
  if (!target) return currentYaw;
  const dx = target.pos.x - ox, dz = target.pos.z - oz;
  if (dx * dx + dz * dz < 1e-6) return currentYaw;
  const want = Math.atan2(dx, dz);
  const diff = wrap(want - currentYaw);
  const mag = Math.abs(diff);
  if (mag > tune.cone) return currentYaw;
  const strength = mag <= tune.softCone
    ? 1
    : 1 - (mag - tune.softCone) / Math.max(1e-4, tune.cone - tune.softCone);
  const turn = clamp(diff * strength, -tune.maxTurn, tune.maxTurn);
  return wrap(currentYaw + turn);
}

/**
 * Small forward correction so a swing at something just out of reach still
 * connects. Returns metres to nudge along the swing direction, never enough to
 * cross the target or to replace an actual dash.
 */
export function aimStep(ox, oz, target, reach, maxStep = 1.1) {
  if (!target) return 0;
  const dist = Math.hypot(target.pos.x - ox, target.pos.z - oz) - (target.radius || 0);
  const gap = dist - reach * 0.9;
  return gap <= 0 ? 0 : Math.min(gap, maxStep);
}

// ===========================================================================
// 3. HIT REACTIONS: POISE, HITSTUN, DIRECTIONAL KNOCKBACK
// ===========================================================================

/**
 * Poise pools per archetype. `max` is the damage an enemy absorbs before it
 * breaks; `regen` refills it once `delay` seconds have passed without a hit, so
 * poise measures pressure within one engagement rather than across a fight.
 *
 * `mass` divides incoming knockback. `hitstunMul` scales how long a hit freezes
 * the target — a stalker flinches hard, a brute barely notices.
 */
export const POISE = {
  grunt:   { max: 46,  regen: 34, delay: 1.4, mass: 1.00, hitstunMul: 1.00, staggerTime: 0.75, maxHitstun: 0.20 },
  stalker: { max: 26,  regen: 44, delay: 1.0, mass: 0.62, hitstunMul: 1.35, staggerTime: 0.85, maxHitstun: 0.26 },
  brute:   { max: 120, regen: 28, delay: 2.0, mass: 2.30, hitstunMul: 0.45, staggerTime: 1.15, maxHitstun: 0.12 },
  caster:  { max: 30,  regen: 40, delay: 1.1, mass: 0.72, hitstunMul: 1.20, staggerTime: 0.95, maxHitstun: 0.24 },
  boss:    { max: 460, regen: 60, delay: 2.6, mass: 7.00, hitstunMul: 0.16, staggerTime: 1.30, maxHitstun: 0.07 },
  player:  { max: 90,  regen: 30, delay: 1.6, mass: 1.20, hitstunMul: 0.55, staggerTime: 0.45, maxHitstun: 0.16 },
};

/**
 * Poise cost of a hit, by the kind of attack that landed. Light hits chip; a
 * finisher or a heavy skill is meant to break a grunt outright. Balancing this
 * against POISE.max is the whole "chip toward a stagger" dial.
 */
export const POISE_DAMAGE = {
  light:    14,
  heavy:    30,
  finisher: 52,
  thrust:   18,
  skill:    46,
  nova:     70,
  shadow:   10,   // bound soldiers pressure, they do not break things
};

/** Hitstun seconds by attack kind, before the target's hitstunMul. */
export const HITSTUN = {
  light: 0.09, heavy: 0.15, finisher: 0.22, thrust: 0.10, skill: 0.18, nova: 0.26, shadow: 0.06,
};

export function poiseProfile(key, isBoss = false) {
  return POISE[isBoss ? 'boss' : key] || POISE.grunt;
}

export function makeReaction(key, isBoss = false) {
  const prof = poiseProfile(key, isBoss);
  return {
    prof,
    poise: prof.max,
    sinceHit: 99,
    hitstun: 0,
    stagger: 0,
    breaks: 0,       // staggers taken recently — feeds diminishing returns
    breakDecay: 0,
  };
}

/** Shared result of `applyHit`. Copy what you need; the next hit overwrites it. */
const _hit = {
  staggered: false, stagger: 0, hitstun: 0, poiseFrac: 1,
  knockX: 0, knockZ: 0, knockUp: 0, force: 0,
};

/**
 * Resolve one incoming hit against a target's reaction state.
 *
 * hit: {
 *   kind          key into POISE_DAMAGE / HITSTUN, default 'light'
 *   poiseDamage   explicit override
 *   hitstun       explicit override, seconds before hitstunMul
 *   knockback     impulse in metres/second before mass division
 *   dirX, dirZ    knockback direction; need not be normalised. Use
 *                 `hitAwayFrom` to fill it from two positions.
 *   lift          upward component (only meaningful once bodies leave y=0)
 *   guaranteed    ignore poise and stagger outright (finishers, boss slams)
 * }
 *
 * Returns shared scratch describing what the caller should now do.
 */
export function applyHit(react, hit) {
  const prof = react.prof;
  const kind = hit.kind || 'light';
  const poiseDmg = hit.poiseDamage ?? POISE_DAMAGE[kind] ?? POISE_DAMAGE.light;
  const stunBase = hit.hitstun ?? HITSTUN[kind] ?? HITSTUN.light;

  react.sinceHit = 0;
  react.poise = Math.max(0, react.poise - poiseDmg);

  // Every hit interrupting everything is why the old fights felt weightless in
  // one direction and unfair in the other. A hit buys a flinch; only an empty
  // poise pool buys an actual opening.
  const stun = Math.min(prof.maxHitstun, stunBase * prof.hitstunMul);
  react.hitstun = Math.max(react.hitstun, stun);

  let staggered = false;
  let granted = 0;
  if (hit.guaranteed || react.poise <= 0) {
    // Repeated breaks in quick succession give less each time, so a fast weapon
    // cannot stagger-lock a target into a corner forever. The pool refills on a
    // break, so the follow-up hits have to earn the next one over again.
    granted = prof.staggerTime / (1 + react.breaks * 0.6);
    react.stagger = Math.max(react.stagger, granted);
    react.poise = prof.max;
    react.breaks++;
    react.breakDecay = 4.0;
    staggered = true;
  }

  const dx = hit.dirX || 0, dz = hit.dirZ || 0;
  const len = Math.hypot(dx, dz);
  // A break is the moment the knockback finally moves them, which is what
  // sells poise as a mechanic without a UI element explaining it.
  const force = (hit.knockback || 0) / prof.mass * (staggered ? 1.5 : 1);
  _hit.staggered = staggered;
  // What *this* hit bought, which is less each time it breaks; react.stagger
  // itself keeps whichever window is longer.
  _hit.stagger = granted;
  _hit.hitstun = stun;
  _hit.poiseFrac = prof.max > 0 ? react.poise / prof.max : 1;
  _hit.force = force;
  _hit.knockX = len > 1e-5 ? (dx / len) * force : 0;
  _hit.knockZ = len > 1e-5 ? (dz / len) * force : 0;
  _hit.knockUp = (hit.lift || 0) / prof.mass;
  return _hit;
}

/**
 * The common case: push the target directly away from the attacker. Mutates
 * `hit` (which is expected to be the scratch from `patternHit`/`swingHit`) and
 * resolves it in one call.
 */
export function hitAwayFrom(react, hit, attackerX, attackerZ, targetX, targetZ) {
  hit.dirX = targetX - attackerX;
  hit.dirZ = targetZ - attackerZ;
  return applyHit(react, hit);
}

export function tickReaction(react, dt) {
  if (react.hitstun > 0) react.hitstun = Math.max(0, react.hitstun - dt);
  if (react.stagger > 0) react.stagger = Math.max(0, react.stagger - dt);
  if (react.breakDecay > 0) {
    react.breakDecay -= dt;
    if (react.breakDecay <= 0 && react.breaks > 0) { react.breaks--; react.breakDecay = react.breaks > 0 ? 4.0 : 0; }
  }
  react.sinceHit += dt;
  const prof = react.prof;
  if (react.sinceHit > prof.delay && react.poise < prof.max) {
    react.poise = Math.min(prof.max, react.poise + prof.regen * dt);
  }
  return react;
}

/** Movement authority this frame: staggered is rooted, hitstun merely slows. */
export function reactionMove(react) {
  if (react.stagger > 0) return 0;
  if (react.hitstun > 0) return 0.25;
  return 1;
}

/** Can this target start or continue an attack? */
export function canAct(react) { return react.stagger <= 0 && react.hitstun <= 0; }

/**
 * Whether a hit should abort an attack already underway. A stagger always
 * does. Flinching does not — trading with a brute mid-slam has to be a real
 * decision, not a free cancel.
 */
export function interrupts(react, stage) {
  if (react.stagger > 0) return true;
  return react.hitstun > 0 && stage === STAGE.WINDUP;
}

// ===========================================================================
// 4. TELEGRAPHS
// ===========================================================================

/**
 * A tell is a promise about what is coming. Three distinct channels so a player
 * can read a crowd at a glance without learning six different animations:
 *
 *   pose   — the body winds up. Cheap, short attacks. Read the silhouette.
 *   glow   — eyes and weapon flare, pulse accelerating into the hit. Ranged.
 *   ground — a marker drawn on the floor showing exactly where it will land.
 *            Reserved for the slow, heavy, must-dodge attacks.
 *
 * `flicker` is the feint: a tell that starts and then *drops*, which is the
 * only honest way to build a mixup the player can learn to respect.
 */
export const TELL = {
  pose:    { kind: 'pose',    eye: 1.7, marker: null,     shake: 0,    sound: 'swing' },
  glow:    { kind: 'glow',    eye: 2.6, marker: null,     shake: 0,    sound: 'charge' },
  ground:  { kind: 'ground',  eye: 2.0, marker: 'circle', shake: 0.06, sound: 'charge' },
  lane:    { kind: 'lane',    eye: 2.2, marker: 'capsule',shake: 0.05, sound: 'charge' },
  flicker: { kind: 'flicker', eye: 1.4, marker: null,     shake: 0,    sound: 'swing' },
};

// ONE home for the danger palette (review nit: these literals and config's
// TELL_* were two unlinked declarations of one law — a retune of either file
// silently split the vocabulary). config.js owns the values; these names
// stay for this file's own tellColorFor and every existing importer. The
// import is hoisted (legal at any top-level position); config imports
// nothing from this file, so no cycle.
import { TELL_DANGER_COLOR, TELL_WARN_COLOR } from './config.js';
export const DANGER_COLOR = TELL_DANGER_COLOR;
export const WARN_COLOR = TELL_WARN_COLOR;

export function tellSpec(pattern) { return TELL[pattern.tell] || TELL.pose; }

export function tellColor(pattern, fallback) {
  if (pattern.tellColor) return pattern.tellColor;
  return pattern.heavy ? DANGER_COLOR : (fallback ?? WARN_COLOR);
}

/**
 * 0 → 1 tell intensity across the windup, for eye flare, marker fill and
 * emissive. Each channel has its own curve because they read differently:
 * ground markers must be *complete* a beat before the hit lands, glows peak
 * exactly on it, and a feint collapses to nothing partway through.
 */
export function tellPulse(pattern, k, t = 0) {
  const kind = pattern.tell;
  if (kind === 'ground' || kind === 'lane') return clamp01(k / 0.82);
  if (kind === 'glow') return clamp01(k) * (0.72 + 0.28 * Math.sin(t * (10 + 28 * k)));
  if (kind === 'flicker') {
    const at = pattern.feint ?? 0.55;
    return k < at ? clamp01(k / at) : Math.max(0, 1 - (k - at) / 0.18) * 0.4;
  }
  return clamp01(k * k);
}

// ===========================================================================
// 5. ENEMY ATTACK PATTERNS
// ===========================================================================

// Pattern fields:
//   id/name    identity; `name` is only for debugging overlays
//   weight     selection weight inside the archetype's list
//   min/max    the distance band this pattern is chosen in
//   tell       key into TELL
//   windup     seconds from commit to the first damage application
//   active     seconds the hitbox stays live
//   recovery   seconds of helplessness afterwards — the punish window
//   cooldown   seconds before this same pattern may be chosen again
//   hits       damage applications spread across the active window
//   dmg        multiplier on the attacker's atk, per application
//   shape      sweep spec (see armSweep)
//   knock      knockback impulse, before target mass
//   poise      poise damage dealt to the player
//   lunge      forward impulse applied once, at the end of the windup
//   anchor     'self' | 'target' | 'lead' — where the shape is placed
//   heavy      true = red tell, and it staggers through poise
//   follow     id of a pattern this one chains into
//   retreat    backward impulse applied at the resolve — the hop-back that
//              makes a committed thrust a spacing statement, not a trade
//
// --- WAVE D STAGE 2: THE SHIPPING TRIM -------------------------------------
// This table is now LIVE — game.js selects every trash attack from it. It is
// trimmed to what stage 2's resolution can honestly deliver, and honesty is
// the trim rule: a pattern may only ship if its tell shape and its hit test
// agree. Two whole classes of entry are held back, not deleted from the
// design:
//
//   * APPROACH-CLOSING moves (the old grunt 'shove', stalker 'pounce', brute
//     'charge'). enemyai.js already owns the closing game — lungeImpulse and
//     siegeImpulse throw the body across exactly the bands those rows
//     covered, and steerAgent only raises wantAttack INSIDE melee reach
//     (range + 0.4), so a min-6m pattern in a melee roster is a row that can
//     never be drawn. They return when stage 3's swept hitboxes widen the ask
//     gate and the sweep can travel with the body.
//   * ANCHORED ground AoEs (the caster 'hexpool'). anchor:'lead' needs the
//     stage machine's windup-fraction snapshot (tickPattern's anchor event);
//     stage 2 keeps the shipped telegraph countdown as the clock, so a lead
//     anchor would either lie on the floor or hit off-tell. Returns with the
//     machine in stage 3.
//
// Rhythm, in one line each:
//   grunt   — honest mid-tempo pressure. Short jab, telegraphed overhead.
//   stalker — silence, then a burst, and one feint to punish players who
//             learned to dodge on the first frame of a tell.
//   brute   — rare, enormous, always announced on the floor. You have time.
//   caster  — never wants to be near you, and punishes you for arriving.
//   lancer  — one committed line. Thrust down the lane, hop back out.
//   howler  — punishes ignoring it: a room-crossing pounce, and a burst for
//             whoever comes to shut it up.

export const ENEMY_PATTERNS = {
  grunt: [
    {
      id: 'jab', name: 'Jab', weight: 3, min: 0, max: 2.9,
      tell: 'pose', windup: 0.34, active: 0.10, recovery: 0.28, cooldown: 1.2,
      hits: 1, dmg: 0.85, knock: 3.5, poise: 10,
      shape: { shape: SHAPE.CONE, range: 2.7, arc: Math.PI * 0.5, sweepArc: Math.PI * 0.35, duration: 0.10 },
    },
    {
      id: 'overhead', name: 'Overhead', weight: 1.4, min: 0, max: 3.4, heavy: true,
      tell: 'ground', windup: 0.74, active: 0.12, recovery: 0.58, cooldown: 3.4,
      hits: 1, dmg: 1.55, knock: 9, poise: 26, anchor: 'self',
      shape: { shape: SHAPE.CONE, range: 3.2, arc: Math.PI * 0.42, sweepArc: Math.PI * 0.5, ease: 'in', duration: 0.12 },
    },
    // 'shove' (min 2.4) held back — see the stage-2 trim note above.
  ],

  stalker: [
    {
      id: 'flurry', name: 'Flurry', weight: 2.6, min: 0, max: 2.6,
      tell: 'glow', windup: 0.20, active: 0.38, recovery: 0.62, cooldown: 2.4,
      hits: 3, dmg: 0.42, knock: 1.6, poise: 7,
      shape: { shape: SHAPE.CONE, range: 2.4, arc: Math.PI * 0.55, sweepArc: Math.PI * 0.6, duration: 0.13 },
    },
    // 'pounce' (min 3.6) held back — see the stage-2 trim note above; the
    // stalker's closing burst lives in enemyai.js's lungeImpulse today.
    {
      id: 'feint', name: 'Feint Slash', weight: 1.2, min: 0, max: 3.0, feint: 0.55,
      // The windup is long enough to bait a dodge, then the strike itself is
      // faster than anything else the stalker has. Learn the flicker or eat it.
      tell: 'flicker', windup: 0.66, active: 0.09, recovery: 0.40, cooldown: 6.5,
      hits: 1, dmg: 1.0, knock: 4, poise: 20,
      shape: { shape: SHAPE.CONE, range: 2.8, arc: Math.PI * 0.6, sweepArc: Math.PI * 0.7, duration: 0.09 },
    },
  ],

  brute: [
    {
      id: 'slam', name: 'Ground Slam', weight: 2.4, min: 0, max: 5.4, heavy: true,
      tell: 'ground', windup: 1.05, active: 0.16, recovery: 0.88, cooldown: 4.6,
      hits: 1, dmg: 1.6, knock: 17, poise: 40, anchor: 'self', shake: 0.7,
      shape: { shape: SHAPE.CIRCLE, range: 5.2, thickness: 0.9, expand: true, ease: 'out', follow: false, duration: 0.16 },
    },
    {
      id: 'backhand', name: 'Backhand Sweep', weight: 1.8, min: 0, max: 4.4,
      tell: 'pose', windup: 0.62, active: 0.30, recovery: 0.66, cooldown: 3.4,
      hits: 1, dmg: 1.05, knock: 11, poise: 28,
      shape: { shape: SHAPE.CONE, range: 4.2, arc: Math.PI * 0.55, sweepArc: Math.PI * 1.3, duration: 0.30 },
    },
    // 'charge' (min 6) held back — see the stage-2 trim note above; the
    // brute's room-crossing rush is enemyai.js siegeImpulse territory.
  ],

  caster: [
    {
      // min 0, not the draft's 4.5 standoff floor, for two reasons found the
      // hard way: (a) a floor above wardpulse's 4.2 ceiling leaves a mute
      // 4.2-4.5 band the caster's own backpedal walks it through, and (b) a
      // cornered caster whose ONLY close option is the pulse goes silent for
      // the pulse's entire 5.2 s cooldown after throwing it once — the
      // dungeon suite's LOS positive control (a pinned caster at 3.5 m that
      // must fire within ~4 s) measures exactly that silence. Point-blank
      // the pulse still leads by weight; the bolt is the fallback that keeps
      // a crowded caster dangerous, not the preference.
      id: 'bolt', name: 'Hexbolt', weight: 3, min: 0, max: 15,
      tell: 'glow', windup: 0.55, active: 0.06, recovery: 0.34, cooldown: 2.2,
      hits: 1, dmg: 1.0, poise: 14,
      projectile: { speed: 14, spread: 0, radius: 0.5 },
    },
    {
      id: 'volley', name: 'Hex Volley', weight: 1.7, min: 6, max: 16,
      tell: 'glow', windup: 0.85, active: 0.46, recovery: 0.52, cooldown: 4.8,
      hits: 3, dmg: 0.6, poise: 10,
      projectile: { speed: 12, spread: 0.20, radius: 0.5 },
    },
    // 'hexpool' (anchor 'lead') held back — see the stage-2 trim note above.
    {
      // Weight 3.5 (draft 2.2): with the bolt now reaching to 0 m, the pulse
      // needs the majority share inside its own band or "panic melee when
      // crowded" reads as "occasionally". 3.5 vs 3 puts the pulse first
      // ~54/46 up close while the bolt covers the pulse's cooldown.
      id: 'wardpulse', name: 'Ward Pulse', weight: 3.5, min: 0, max: 4.2,
      // Closing on a caster should cost something, or every caster is free.
      tell: 'glow', windup: 0.48, active: 0.14, recovery: 0.60, cooldown: 5.2,
      hits: 1, dmg: 0.7, knock: 15, poise: 24, anchor: 'self',
      shape: { shape: SHAPE.CIRCLE, range: 4.6, thickness: 0.8, expand: true, ease: 'out', follow: false, duration: 0.14 },
    },
  ],

  // --- SHIPPING ARCHETYPES the draft table never had (Wave D stage 2). Both
  // are B+ bodies from config.ENEMY_TYPES; their rows speak the same
  // vocabulary as everything above, and their numbers are cut against the
  // per-rank skew below — they only appear where the skew already favours
  // heavy, honest-but-brutal rosters.

  lancer: [
    {
      // The identity move the ask named: thrust down a drawn lane, then HOP
      // BACK OUT — `retreat` is the spacing statement that stops the lancer
      // trading like a grunt with a longer stick. Capsule range 4.4 = the
      // 3.2 m weapon reach plus the ~1.2 m the lunge impulse (10, under the
      // shared 7/s velocity damping) carries the body during the strike.
      id: 'skewer', name: 'Skewer', weight: 2.4, min: 0, max: 3.8, heavy: true,
      tell: 'lane', windup: 0.60, active: 0.16, recovery: 0.90, cooldown: 4.4,
      hits: 1, dmg: 1.45, knock: 11, poise: 30, lunge: 10, retreat: 13,
      shape: { shape: SHAPE.CAPSULE, inner: 0.3, range: 4.4, thickness: 1.0, ease: 'out', duration: 0.16 },
    },
    {
      // The keep-honest filler: without a light option the skewer's own
      // cooldown would leave the lancer mute in your face for seconds.
      id: 'lash', name: 'Haft Lash', weight: 2, min: 0, max: 3.4,
      tell: 'pose', windup: 0.38, active: 0.10, recovery: 0.40, cooldown: 1.6,
      hits: 1, dmg: 0.70, knock: 5, poise: 12,
      shape: { shape: SHAPE.CONE, range: 3.2, arc: Math.PI * 0.5, sweepArc: Math.PI * 0.4, duration: 0.10 },
    },
  ],

  howler: [
    {
      // The leap the ask named. Eligibility runs to 9 m because the howler
      // ORBITS at 9 m (flank band = range 12 x 0.75) — a leap it cannot throw
      // from its own preferred distance would never be seen. The lane is long
      // for the same reason: capsule range 8.8 = ~7.4 m of travel from the 52
      // impulse under 7/s damping plus body reach, so the red strip on the
      // floor is the strip the pounce actually crosses.
      id: 'leap', name: 'Riftpounce', weight: 2.4, min: 4.0, max: 9.0, heavy: true,
      tell: 'lane', windup: 0.72, active: 0.20, recovery: 1.00, cooldown: 5.6,
      hits: 1, dmg: 1.15, knock: 12, poise: 26, lunge: 52,
      shape: { shape: SHAPE.CAPSULE, inner: 0.4, range: 8.8, thickness: 1.15, ease: 'out', duration: 0.20 },
    },
    {
      // The AoE half: whoever closed to shut the howler up eats a radial
      // burst. Max 4.6 = the shape's own radius, so the tell disc never
      // claims floor the hit cannot touch and the pair covers 0-9 m with the
      // leap taking over exactly where the burst gives out.
      id: 'howlburst', name: 'Howlburst', weight: 2, min: 0, max: 4.6, heavy: true,
      tell: 'ground', windup: 0.80, active: 0.14, recovery: 0.85, cooldown: 5.0,
      hits: 1, dmg: 0.95, knock: 14, poise: 24, anchor: 'self',
      shape: { shape: SHAPE.CIRCLE, range: 4.4, thickness: 0.8, expand: true, ease: 'out', follow: false, duration: 0.14 },
    },
  ],
};

// --- PER-RANK ROSTER SKEW (Wave D stage 2) ---------------------------------
// The dungeon's difficulty curve, applied to attack SELECTION rather than to
// numbers: higher gates draw heavier, feintier rosters out of the SAME tables.
// Which archetypes are present at a rank is already data (creatures.json
// presence and ENEMY_TYPES.ai decide who spawns); this table is the second
// data hook — given who showed up, what do they reach for. Multipliers apply
// to a pattern's selection weight: `heavy` scales entries flagged heavy:true,
// `feint` scales entries with a feint fraction. E's feint 0 is deliberate and
// load-bearing: a feint teaches players to DISTRUST tells, and rank E is where
// they are still learning to trust them — the mixup only enters once the
// lesson it subverts has been learned. Kept here with the pattern tables (not
// in config.js) because the weights it scales live ten lines up; a designer
// retuning one will be looking at the other.
export const RANK_PATTERN_SKEW = {
  E: { heavy: 0.7, feint: 0.0 },
  D: { heavy: 0.85, feint: 0.5 },
  C: { heavy: 1.0, feint: 0.8 },
  B: { heavy: 1.15, feint: 1.0 },
  A: { heavy: 1.3, feint: 1.3 },
  S: { heavy: 1.5, feint: 1.6 },
};

export function rankSkew(rank) { return RANK_PATTERN_SKEW[rank] || RANK_PATTERN_SKEW.C; }

/**
 * Spacing behaviour between attacks, which is most of what separates these
 * archetypes on screen. `gcd` is the pause after a pattern ends before another
 * may start; `ideal` is the distance band the AI tries to hold; `strafe` is how
 * much of its speed goes sideways rather than straight at you.
 *
 * THE gcd BANDS ARE THE attackCd PAIRING (Wave D stage 2 balance guard).
 * game.js paces an enemy as `attackCd = windup + recovery + range2(gcd)`, so
 * each band below is DERIVED, not chosen: it is the archetype's target mean
 * attack cycle (config.ENEMY_TYPES.attackCd plus the old +0.2s mean jitter —
 * the number weapons.js's combo-recovery table is explicitly tuned against,
 * "a whiffed greataxe finisher costs 1.23s, almost exactly one free enemy
 * attack") minus the commit time (windup + recovery) of the archetype's
 * BREAD-AND-BUTTER pattern. Worked per row:
 *   grunt   1.5 + 0.2 = 1.7  − jab 0.62     → mean 1.08 → [0.75, 1.40]
 *   stalker 1.55 + 0.2 = 1.75 − flurry 0.82 → mean 0.95 → [0.70, 1.20]
 *           (stalker's attackCd row moved 1.2 → 1.55 in the same change —
 *            flurry's folded 3 x 0.42 = 1.26 dmg per cycle needed the cycle
 *            lengthened to hold the archetype's old ~0.71 atk/s pressure)
 *   brute   2.2 + 0.2 = 2.4  − backhand 1.28 → mean 1.35 (heavied slightly:
 *            [1.00, 1.70] — the slam pays its own extra 0.65 s of commit)
 *   caster  2.6 + 0.3 = 2.9  − bolt 0.89    → mean 2.0, shipped [1.50, 2.30]
 *           (hi shaved 2.5 → 2.3: the dungeon suite's LOS positive control
 *            gives a pinned caster ~4.3 s to pulse, cool down and STILL get a
 *            bolt in the air — the worst-case roll must land inside it)
 *   lancer  3.0 + 0.2 = 3.2  − skewer 1.50  → mean 1.70 → [1.20, 2.20]
 *   howler  4.0 + 0.3 = 4.3  − leap 1.72    → mean 2.60 → [2.10, 3.10]
 * Retune a pattern's windup/recovery or an attackCd row and the band on this
 * side must move with it, or the fight suite's pressure probes will drift.
 */
export const ENEMY_RHYTHM = {
  grunt:   { gcd: [0.75, 1.40], ideal: [1.6, 2.6],  strafe: 0.22, retreat: 0,    commit: 0.75, patience: 0.15 },
  stalker: { gcd: [0.70, 1.20], ideal: [2.6, 6.0],  strafe: 0.75, retreat: 0.55, commit: 0.95, patience: 0.55 },
  brute:   { gcd: [1.00, 1.70], ideal: [2.0, 3.2],  strafe: 0.05, retreat: 0,    commit: 1.00, patience: 0.05 },
  caster:  { gcd: [1.50, 2.30], ideal: [8.0, 13.0], strafe: 0.45, retreat: 0.85, commit: 0.60, patience: 0.35 },
  lancer:  { gcd: [1.20, 2.20], ideal: [2.4, 3.4],  strafe: 0.15, retreat: 0.20, commit: 0.90, patience: 0.20 },
  howler:  { gcd: [2.10, 3.10], ideal: [7.0, 10.0], strafe: 0.60, retreat: 0.70, commit: 0.50, patience: 0.50 },
};

export function rhythmFor(key) { return ENEMY_RHYTHM[key] || ENEMY_RHYTHM.grunt; }
export function patternsFor(key) { return ENEMY_PATTERNS[key] || ENEMY_PATTERNS.grunt; }

// ===========================================================================
// 6. BOSS PHASES
// ===========================================================================

export const BOSS_PATTERNS = {
  cleave: {
    id: 'cleave', name: 'Cleave', weight: 3, min: 0, max: 6.5,
    tell: 'pose', windup: 0.55, active: 0.26, recovery: 0.52, cooldown: 2.6,
    hits: 1, dmg: 1.0, knock: 12, poise: 34, shake: 0.3,
    shape: { shape: SHAPE.CONE, range: 6.0, arc: Math.PI * 0.5, sweepArc: Math.PI * 1.1, duration: 0.26 },
  },
  slam: {
    id: 'slam', name: 'Shockwave', weight: 2.6, min: 0, max: 12, heavy: true,
    tell: 'ground', windup: 0.85, active: 0.42, recovery: 0.80, cooldown: 5.0,
    hits: 1, dmg: 1.4, knock: 20, poise: 55, anchor: 'self', shake: 1.0,
    shape: { shape: SHAPE.CIRCLE, range: 11, thickness: 1.3, expand: true, ease: 'out', follow: false, duration: 0.42 },
  },
  spread: {
    id: 'spread', name: 'Spread Shot', weight: 2.2, min: 4, max: 26,
    tell: 'glow', windup: 0.70, active: 0.10, recovery: 0.55, cooldown: 4.2,
    hits: 1, dmg: 0.6, poise: 16,
    projectile: { speed: 15, count: 6, arc: 0.24, radius: 0.55 },
  },
  charge: {
    id: 'charge', name: 'Charge', weight: 2, min: 7, max: 30, heavy: true,
    tell: 'lane', windup: 0.72, active: 0.75, recovery: 1.05, cooldown: 6.5,
    hits: 1, dmg: 1.2, knock: 18, poise: 44, lunge: 34, shake: 0.5,
    shape: { shape: SHAPE.CAPSULE, inner: 0.5, range: 4.0, thickness: 1.8, duration: 0.75 },
    follow: 'cleave', followChance: 0.55,
  },
  sweepstorm: {
    id: 'sweepstorm', name: 'Sweep Storm', weight: 1.8, min: 0, max: 8,
    // Three full rotations. Standing behind it is not safe; running is.
    tell: 'pose', windup: 0.60, active: 0.90, recovery: 0.95, cooldown: 8.0,
    hits: 3, dmg: 0.75, knock: 9, poise: 26, shake: 0.35,
    shape: { shape: SHAPE.CONE, range: 6.5, arc: Math.PI * 0.6, sweepArc: TAU, duration: 0.30 },
  },
  pillars: {
    id: 'pillars', name: 'Rift Pillars', weight: 1.6, min: 3, max: 30, heavy: true,
    // Anchored ahead of where you are running: the answer is to change
    // direction, not to keep sprinting in a circle.
    tell: 'ground', windup: 1.00, active: 0.25, recovery: 0.60, cooldown: 9.0,
    hits: 1, dmg: 1.1, knock: 8, poise: 30, anchor: 'lead', lead: 0.7, shake: 0.5,
    shape: { shape: SHAPE.CIRCLE, range: 4.2, thickness: 0.8, expand: true, follow: false, duration: 0.25 },
    zones: 3, zoneSpread: 7,
  },
  ruin: {
    id: 'ruin', name: 'RUIN', weight: 1, min: 0, max: 40, heavy: true, desperation: true,
    // The desperation move: arena-wide, slowest tell in the game, and the only
    // honest answer is the dash you have been saving.
    tell: 'ground', windup: 1.45, active: 0.55, recovery: 1.30, cooldown: 11.0,
    hits: 1, dmg: 1.8, knock: 26, poise: 90, anchor: 'self', shake: 1.2,
    shape: { shape: SHAPE.CIRCLE, inner: 3.5, range: 26, thickness: 2.2, expand: true, ease: 'linear', follow: false, duration: 0.55 },
  },
};

/**
 * Phases are keyed to health and read top-down: the first entry whose `above`
 * the boss is still at wins. Each phase owns a pool, its own pacing, and a
 * `tellMul` that shortens telegraphs as the fight escalates — the same attacks
 * get harder to read rather than being replaced by different ones you have to
 * learn from scratch mid-fight.
 */
export const BOSS_PHASES = [
  {
    id: 'opening', name: 'THE WARDEN TESTS YOU', above: 0.70,
    pool: ['cleave', 'slam', 'spread'],
    pacing: [3.2, 4.6], tellMul: 1.15, speedMul: 1.0, atkMul: 1.0, chain: 0,
  },
  {
    id: 'pressure', name: 'IT STOPS HOLDING BACK', above: 0.40,
    pool: ['cleave', 'slam', 'spread', 'charge', 'sweepstorm'],
    pacing: [2.4, 3.6], tellMul: 1.0, speedMul: 1.10, atkMul: 1.08, chain: 1,
  },
  {
    id: 'enrage', name: 'ENRAGED', above: 0.15,
    pool: ['cleave', 'slam', 'charge', 'sweepstorm', 'pillars', 'spread'],
    pacing: [1.7, 2.7], tellMul: 0.84, speedMul: 1.28, atkMul: 1.22, chain: 2,
  },
  {
    id: 'desperate', name: 'IT IS DYING AND IT KNOWS', above: 0,
    pool: ['cleave', 'charge', 'sweepstorm', 'pillars', 'slam'],
    pacing: [1.3, 2.1], tellMul: 0.74, speedMul: 1.35, atkMul: 1.35, chain: 2,
    // Fires on its own timer on top of the pool, so the phase has a heartbeat.
    desperation: { id: 'ruin', every: [8.5, 12.0], firstDelay: 2.5 },
  },
];

export function bossPhaseIndex(hpFrac) {
  for (let i = 0; i < BOSS_PHASES.length; i++) if (hpFrac > BOSS_PHASES[i].above) return i;
  return BOSS_PHASES.length - 1;
}

export function bossPhase(hpFrac) { return BOSS_PHASES[bossPhaseIndex(hpFrac)]; }

// ===========================================================================
// 6b. PER-BOSS BRAINS (Wave D stage 2 — the shipping trim of the phase system)
// ===========================================================================
//
// The full BOSS_PATTERNS/BOSS_PHASES machine above is the stage-3+ design.
// What ships in stage 2 is this table: six named brains, one per config GATES
// boss, sequencing the THREE pattern implementations game.js already has —
// 'slam' (radial shockwave, r 11), 'fan' (7/9-bolt spread), 'charge' (lane
// rush, impulse 34) — plus the close-range bite _bossBrain keeps on its own
// attackCd clock. The win the ask names is per-boss SEQUENCING and tells, not
// new mechanics, so every knob here is a sequencing knob:
//
//   opener        the pattern the boss ALWAYS throws first — its signature
//                 hello, thrown from the seeded stream's first roll so a
//                 replayed gate opens the fight identically
//   openerFollow  optional forced second beat, for a 1-2 signature
//   pool          weighted roster with per-entry distance gates (min/max),
//                 drawn by ONE cumulative-weight roll. THE FAN LEADS EVERY
//                 POOL, deliberately: it is the only pattern that threatens
//                 at every range the arena allows (slam needs < 12 m, charge
//                 wants > ~6), so the pool's head is the entry that can never
//                 leave a roll mute — and the fight suite's pinned-dice probe
//                 (rnd forced to 0) reads exactly that head, at every trial
//                 distance, which is what lets it measure the fan pattern in
//                 isolation without caring which boss it drew.
//   pacing        [lo, hi] seconds between rolls; enragedPacing takes over at
//                 the shipped 40% enrage. The warden's bands are byte-for-byte
//                 the old shared brain's (4.4 + 1.6 roll / 3.0 + 1.6 roll) —
//                 rank E IS the shipped cadence; the ladder tightens above it.
//   escalate      the under-30%-hp turn: pacingMul compresses the roll gap,
//                 tellMul shortens the windups (same attacks read harder to
//                 react to — BOSS_PHASES' tellMul idea, one number), and
//                 `follow` chains a named resolve into a forced next pattern
//                 (rolled at chance, off the same seeded stream) — the moment
//                 a dying boss starts stringing 1-2s is the escalation a
//                 player actually FEELS, and it costs zero new mechanics.
//
// Distance gates echo BOSS_PATTERNS: slam max 12 is the "roll a slam out of
// range and it degrades to a charge" rule the dead 3-way roll had implicitly
// (its pattern-0-at-range fell through to the charge else), kept explicit.
export const BOSS_BRAINS = {
  warden: {
    // E — THE TUTORIAL BOSS. One lesson per pattern, near-even pool, the
    // shipped cadence, and it opens on the slam: the game's first red disc,
    // thrown in the first arena, at the shipped 0.75 s tell.
    opener: 'slam',
    pool: [
      { id: 'fan', w: 3 },
      { id: 'slam', w: 3, max: 12 },
      { id: 'charge', w: 2, min: 7 },
    ],
    pacing: [4.4, 6.0], enragedPacing: [3.0, 4.6],
    escalate: { below: 0.3, pacingMul: 0.85, tellMul: 0.92 },
  },
  gravelord: {
    // D — WEIGHT. Slam-forward pool; dying, its slams chain into charges:
    // the grave does not let you circle it and heal.
    opener: 'charge',
    pool: [
      { id: 'fan', w: 3 },
      { id: 'slam', w: 4, max: 12 },
      { id: 'charge', w: 2, min: 6 },
    ],
    pacing: [4.2, 5.7], enragedPacing: [2.9, 4.3],
    escalate: { below: 0.3, pacingMul: 0.8, tellMul: 0.9, follow: { after: 'slam', then: 'charge', chance: 0.6 } },
  },
  frostcaller: {
    // C — THE CASTER KING. Fan-dominant, opens on a fan, and its dying turn
    // is double volleys — the answer stays "move", it just stops pausing.
    opener: 'fan',
    pool: [
      { id: 'fan', w: 5 },
      { id: 'slam', w: 2, max: 11 },
      { id: 'charge', w: 2, min: 8 },
    ],
    pacing: [4.0, 5.4], enragedPacing: [2.8, 4.1],
    escalate: { below: 0.3, pacingMul: 0.75, tellMul: 0.9, follow: { after: 'fan', then: 'fan', chance: 0.5 } },
  },
  infernus: {
    // B — MOMENTUM. Charge-forward; dying, a charge that connects with the
    // wall becomes a slam on arrival.
    opener: 'slam',
    pool: [
      { id: 'fan', w: 2 },
      { id: 'charge', w: 4, min: 6 },
      { id: 'slam', w: 3, max: 12 },
    ],
    pacing: [3.7, 5.1], enragedPacing: [2.6, 3.9],
    escalate: { below: 0.3, pacingMul: 0.75, tellMul: 0.88, follow: { after: 'charge', then: 'slam', chance: 0.65 } },
  },
  weaver: {
    // A — MISDIRECTION. Even pool, the shortest tells before S, and dying
    // slams that hide a fan behind the dust.
    opener: 'fan',
    pool: [
      { id: 'fan', w: 3 },
      { id: 'slam', w: 3, max: 12 },
      { id: 'charge', w: 3, min: 6 },
    ],
    pacing: [3.4, 4.8], enragedPacing: [2.4, 3.6],
    escalate: { below: 0.3, pacingMul: 0.7, tellMul: 0.85, follow: { after: 'slam', then: 'fan', chance: 0.6 } },
  },
  archon: {
    // S — EVERYTHING, FASTEST. Signature 1-2 opener (charge into fan: rush
    // you, then punish the dodge lane), tightest pacing, hardest dying turn.
    opener: 'charge',
    openerFollow: 'fan',
    pool: [
      { id: 'fan', w: 3 },
      { id: 'slam', w: 3, max: 12 },
      { id: 'charge', w: 3, min: 6 },
    ],
    pacing: [3.0, 4.4], enragedPacing: [2.1, 3.2],
    escalate: { below: 0.3, pacingMul: 0.65, tellMul: 0.82, follow: { after: 'charge', then: 'fan', chance: 0.7 } },
  },
};

/** The brain for a GATES boss key. Warden fallback, mirroring patternsFor's
 *  grunt fallback: an unknown key fights like rank E, never crashes. */
export function bossBrainFor(key) { return BOSS_BRAINS[key] || BOSS_BRAINS.warden; }

/**
 * One cumulative-weight pick over a brain's pool. `roll` is a pre-drawn
 * [0,1) value rather than an rng — _bossBrain draws its EXACT two numbers per
 * decision (pattern, cadence) before branching, so the fork's draw order
 * stays a flat contract no matter which branch runs (opener, forced, pool).
 * Entries outside their distance gate are skipped in BOTH passes; if the
 * distance gates empty the pool entirely, the head entry is returned rather
 * than null — a boss turn is never silent (the head is the fan, the one
 * pattern with no gate, so in practice this is the fan answering "nothing
 * else reaches").
 */
export function selectBrainPattern(brain, roll, dist) {
  const pool = brain.pool;
  let total = 0;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (dist < (p.min ?? 0) || dist > (p.max ?? Infinity)) continue;
    total += p.w;
  }
  if (total <= 0) return pool[0].id;
  let r = roll * total;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (dist < (p.min ?? 0) || dist > (p.max ?? Infinity)) continue;
    r -= p.w;
    if (r <= 0) return p.id;
  }
  return pool[pool.length - 1].id;
}

// ===========================================================================
// 7. THE PATTERN STATE MACHINE
// ===========================================================================

export const STAGE = { IDLE: 'idle', WINDUP: 'windup', ACTIVE: 'active', RECOVER: 'recover' };

/**
 * One state object per attacker. `cds` is built once with a fixed key set so
 * the object keeps a single hidden class for the life of the entity.
 */
export function makeAttackPlan(key, isBoss = false) {
  const cdKeys = isBoss ? Object.keys(BOSS_PATTERNS) : patternsFor(key).map((p) => p.id);
  const cds = {};
  for (let i = 0; i < cdKeys.length; i++) cds[cdKeys[i]] = 0;
  return {
    key, isBoss,
    pattern: null,
    finished: null,    // the pattern that ended this frame, for endPattern
    cdKeys,
    stage: STAGE.IDLE,
    t: 0,
    fired: 0,          // damage applications already made this window
    gcd: 0,            // pause between patterns
    cds,
    last: '',
    forced: '',        // next pattern is scripted (a chain)
    chain: 0,          // chained attacks left in this string
    tellMul: 1,
    anchorX: 0, anchorZ: 0, anchored: false,
    feinted: false,
    phaseIndex: -1,
    desperationCd: 0,
  };
}

export function planReady(plan) { return plan.stage === STAGE.IDLE && plan.gcd <= 0; }

/** Total committed time of a pattern, for AI that wants to know the risk. */
export function patternDuration(pattern, tellMul = 1) {
  return pattern.windup * tellMul + pattern.active + pattern.recovery;
}

function usable(plan, pattern, dist) {
  if (plan.cds[pattern.id] > 0) return false;
  if (dist < (pattern.min ?? 0) || dist > (pattern.max ?? Infinity)) return false;
  return true;
}

/**
 * Selection weight of one pattern under the caller's context: the table
 * weight, times the no-repeat penalty, times the per-rank skew (ctx.heavyMul
 * / ctx.feintMul — see RANK_PATTERN_SKEW). One function used by BOTH passes
 * of selectPattern so the total and the roll can never disagree about a
 * weight — the classic cumulative-pick bug this shape exists to prevent.
 */
function patternWeight(plan, p, ctx) {
  let w = p.weight || 1;
  // Never the same pattern twice running, unless it is the only thing that
  // reaches — repetition is what made every archetype read as one attack.
  if (p.id === plan.last) w *= 0.15;
  if (p.heavy && ctx.heavyMul !== undefined) w *= ctx.heavyMul;
  if (p.feint !== undefined && ctx.feintMul !== undefined) w *= ctx.feintMul;
  return w;
}

/**
 * Choose a pattern for a normal enemy.
 * ctx: { dist, rnd (REQUIRED, seeded), hpFrac, heavyMul, feintMul }
 * Returns the pattern (shared table data — read only) or null to keep moving.
 * The rnd is drawn AT MOST ONCE, and only after at least one pattern proved
 * eligible — a null return consumes nothing, so an enemy re-asking every
 * frame across a dead distance band cannot spin the combat stream.
 */
export function selectPattern(plan, ctx) {
  const rnd = requireRnd(ctx.rnd);
  const list = patternsFor(plan.key);

  if (plan.forced) {
    let f = null;
    for (let i = 0; i < list.length; i++) if (list[i].id === plan.forced) { f = list[i]; break; }
    plan.forced = '';
    if (f && usable(plan, f, ctx.dist)) return f;
  }

  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!usable(plan, p, ctx.dist)) continue;
    total += patternWeight(plan, p, ctx);
  }
  if (total <= 0) return null;

  let roll = rnd() * total;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!usable(plan, p, ctx.dist)) continue;
    roll -= patternWeight(plan, p, ctx);
    if (roll <= 0) return p;
  }
  return null;
}

/**
 * Choose a pattern for a boss, honouring the current phase pool, the
 * no-repeat rule, and the phase's desperation move.
 * ctx: { dist, rnd, hpFrac }
 */
export function selectBossPattern(plan, ctx) {
  const rnd = requireRnd(ctx.rnd);
  const phase = BOSS_PHASES[plan.phaseIndex < 0 ? bossPhaseIndex(ctx.hpFrac ?? 1) : plan.phaseIndex];

  // A scripted string finishes before anything else takes the slot — a chain
  // the player is mid-way through reading must not be cut in half.
  if (plan.forced) {
    const f = BOSS_PATTERNS[plan.forced];
    plan.forced = '';
    if (f && usable(plan, f, ctx.dist)) return f;
  }

  if (phase.desperation && plan.desperationCd <= 0) {
    const d = BOSS_PATTERNS[phase.desperation.id];
    if (d && plan.cds[d.id] <= 0) return d;
  }

  const pool = phase.pool;
  let total = 0;
  for (let i = 0; i < pool.length; i++) {
    const p = BOSS_PATTERNS[pool[i]];
    if (!usable(plan, p, ctx.dist)) continue;
    total += (p.id === plan.last ? (p.weight || 1) * 0.1 : (p.weight || 1));
  }
  if (total <= 0) return null;

  let roll = rnd() * total;
  for (let i = 0; i < pool.length; i++) {
    const p = BOSS_PATTERNS[pool[i]];
    if (!usable(plan, p, ctx.dist)) continue;
    roll -= (p.id === plan.last ? (p.weight || 1) * 0.1 : (p.weight || 1));
    if (roll <= 0) return p;
  }
  return null;
}

/**
 * Update the boss's phase from its health. Returns the phase object on the
 * frame it changes (so the caller can announce it and throw an effect), else
 * null. Also seeds the phase's desperation timer.
 */
export function updateBossPhase(plan, hpFrac) {
  const idx = bossPhaseIndex(hpFrac);
  if (idx === plan.phaseIndex) return null;
  plan.phaseIndex = idx;
  const phase = BOSS_PHASES[idx];
  plan.tellMul = phase.tellMul;
  plan.chain = 0;
  if (phase.desperation) plan.desperationCd = phase.desperation.firstDelay;
  return phase;
}

/** Commit to a pattern. `tellMul` shortens or lengthens the windup only. */
export function beginPattern(plan, pattern, tellMul = plan.tellMul) {
  plan.pattern = pattern;
  plan.stage = STAGE.WINDUP;
  plan.t = 0;
  plan.fired = 0;
  plan.tellMul = tellMul;
  plan.anchored = false;
  plan.feinted = false;
  plan.last = pattern.id;
  plan.cds[pattern.id] = pattern.cooldown || 2;
  return pattern;
}

/** Abort mid-pattern — a stagger, a death, or the target vanishing. */
export function cancelPattern(plan) {
  plan.pattern = null;
  plan.stage = STAGE.IDLE;
  plan.t = 0;
  plan.fired = 0;
  plan.anchored = false;
  plan.chain = 0;
  plan.forced = '';
  return plan;
}

/** Windup progress 0 → 1, for driving tells. */
export function windupProgress(plan) {
  if (plan.stage !== STAGE.WINDUP || !plan.pattern) return 0;
  return clamp01(plan.t / Math.max(0.0001, plan.pattern.windup * plan.tellMul));
}

/** True while a feint's tell has dropped but the strike has not landed. */
export function isFeinting(plan) {
  const p = plan.pattern;
  if (!p || !p.feint || plan.stage !== STAGE.WINDUP) return false;
  return windupProgress(plan) >= p.feint;
}

// Reused every frame by every attacker. Copy fields out; never retain.
const _ev = {
  stage: STAGE.IDLE, pattern: null, entered: false, began: false,
  fire: 0, ended: false, anchor: false,
};

/**
 * Advance the plan by dt.
 *
 * Returns shared scratch:
 *   stage    the stage now in effect
 *   pattern  the pattern this frame belongs to — still set on the `ended`
 *            frame, so it can be handed straight to `endPattern`
 *   entered  true on the frame the stage changed — drive tells and animation
 *   began    true on the frame the active window opened. Arm the sweep on
 *            this, never on `entered`: a long frame can open and close a short
 *            active window in one tick, which would leave `stage` reading
 *            RECOVER while hits are still due.
 *   fire     damage applications due this frame; the caller loops that many
 *            times, rearming the sweep between them
 *   ended    true on the frame the whole pattern finished
 *   anchor   true on the frame an anchored shape should snapshot its position
 */
export function tickPattern(plan, dt) {
  _ev.entered = false; _ev.began = false; _ev.fire = 0; _ev.ended = false; _ev.anchor = false;

  if (plan.gcd > 0) plan.gcd = Math.max(0, plan.gcd - dt);
  if (plan.desperationCd > 0) plan.desperationCd = Math.max(0, plan.desperationCd - dt);
  const keys = plan.cdKeys;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    if (plan.cds[id] > 0) plan.cds[id] = Math.max(0, plan.cds[id] - dt);
  }

  const p = plan.pattern;
  _ev.pattern = p;
  if (!p) { _ev.stage = STAGE.IDLE; return _ev; }

  plan.t += dt;
  const windup = p.windup * plan.tellMul;

  if (plan.stage === STAGE.WINDUP) {
    // Anchored shapes snapshot the target's position the moment the tell is
    // fully drawn, not at the hit — that is what makes them dodgeable.
    if (!plan.anchored && p.anchor && p.anchor !== 'self' && plan.t >= windup * 0.82) {
      plan.anchored = true;
      _ev.anchor = true;
    }
    if (plan.t >= windup) {
      plan.stage = STAGE.ACTIVE;
      plan.t -= windup;
      _ev.entered = true;
      _ev.began = true;
      if (p.anchor === 'self' && !plan.anchored) { plan.anchored = true; _ev.anchor = true; }
    }
  }

  if (plan.stage === STAGE.ACTIVE) {
    const total = p.hits || 1;
    const span = total > 1 ? p.active / total : 0;
    while (plan.fired < total && plan.t >= span * plan.fired) { _ev.fire++; plan.fired++; }
    if (plan.t >= p.active) {
      plan.stage = STAGE.RECOVER;
      plan.t -= p.active;
      _ev.entered = true;
    }
  }

  if (plan.stage === STAGE.RECOVER && plan.t >= p.recovery) {
    plan.stage = STAGE.IDLE;
    plan.pattern = null;
    plan.finished = p;
    plan.t = 0;
    _ev.ended = true;
    _ev.entered = true;
  }

  _ev.stage = plan.stage;
  return _ev;
}

/**
 * Call on the frame `tickPattern` reports `ended`, passing `ev.pattern`. Sets
 * the pause before the next attack and resolves chains: a phase with
 * `chain > 0` lets a boss string attacks together with a much shorter gap,
 * which is most of what "pacing" means on screen.
 */
export function endPattern(plan, pattern = plan.finished, rnd) {
  requireRnd(rnd);
  const phase = plan.isBoss ? BOSS_PHASES[Math.max(0, plan.phaseIndex)] : null;
  if (pattern && pattern.follow && rnd() < (pattern.followChance ?? 0.5)) {
    plan.forced = pattern.follow;
    plan.gcd = 0.18;
    return plan;
  }
  if (phase) {
    if (plan.chain > 0) {
      plan.chain--;
      plan.gcd = 0.35;
    } else {
      plan.chain = phase.chain || 0;
      plan.gcd = range2(phase.pacing, rnd);
    }
    if (phase.desperation && pattern && pattern.desperation) {
      plan.desperationCd = range2(phase.desperation.every, rnd);
    }
  } else {
    plan.gcd = range2(rhythmFor(plan.key).gcd, rnd);
  }
  return plan;
}

// ===========================================================================
// 8. SHAPE / DAMAGE RESOLVERS
// ===========================================================================

/** Damage of one application of a pattern, given the attacker's atk. */
export function patternDamage(pattern, atk, phaseMul = 1) {
  return atk * (pattern.dmg ?? 1) * phaseMul;
}

/** The sweep spec for a pattern, or null if it is purely a projectile attack. */
export function patternShape(pattern) { return pattern.shape || null; }

/** Where an anchored pattern should place its shape, written into scratch. */
const _anchor = { x: 0, z: 0 };

export function patternAnchor(pattern, selfX, selfZ, targetX, targetZ, targetVX = 0, targetVZ = 0) {
  const mode = pattern.anchor || 'self';
  if (mode === 'target') { _anchor.x = targetX; _anchor.z = targetZ; }
  else if (mode === 'lead') {
    const l = pattern.lead ?? 0.4;
    _anchor.x = targetX + targetVX * l;
    _anchor.z = targetZ + targetVZ * l;
  } else { _anchor.x = selfX; _anchor.z = selfZ; }
  return _anchor;
}

/**
 * Build the hit descriptor for `applyHit` from a pattern. Shared scratch, so
 * pass it straight into applyHit and read the result before the next call.
 */
const _patternHit = {
  kind: 'heavy', poiseDamage: 0, hitstun: 0, knockback: 0,
  dirX: 0, dirZ: 0, lift: 0, guaranteed: false,
};

export function patternHit(pattern, dirX, dirZ) {
  _patternHit.kind = pattern.heavy ? 'heavy' : 'light';
  _patternHit.poiseDamage = pattern.poise ?? 12;
  _patternHit.hitstun = pattern.heavy ? 0.18 : 0.09;
  _patternHit.knockback = pattern.knock || 0;
  _patternHit.dirX = dirX; _patternHit.dirZ = dirZ;
  _patternHit.lift = pattern.lift || 0;
  _patternHit.guaranteed = !!pattern.heavy;
  return _patternHit;
}

/**
 * Player swing → hit descriptor. `kind` keys POISE_DAMAGE / HITSTUN, so a
 * weapon step only has to say what sort of hit it is.
 */
const _swingHit = {
  kind: 'light', poiseDamage: undefined, hitstun: undefined, knockback: 0,
  dirX: 0, dirZ: 0, lift: 0, guaranteed: false,
};

export function swingHit(kind, knockback, dirX, dirZ, guaranteed = false, poiseDamage) {
  _swingHit.kind = kind;
  _swingHit.poiseDamage = poiseDamage;
  _swingHit.hitstun = undefined;
  _swingHit.knockback = knockback;
  _swingHit.dirX = dirX; _swingHit.dirZ = dirZ;
  _swingHit.guaranteed = guaranteed;
  return _swingHit;
}

/**
 * Classify a weapons.js combo step so game.js does not have to. A step that
 * flags itself a finisher, or carries stagger, is a heavy hit; the widest
 * arcs are sweeps and the narrowest are thrusts.
 */
export function stepKind(step) {
  if (step.finisher) return 'finisher';
  if (step.stagger > 0 || step.knock >= 10) return 'heavy';
  if (step.arc <= Math.PI * 0.3) return 'thrust';
  return 'light';
}

/**
 * Sweep spec for a weapons.js combo step. Reads only fields that step objects
 * already carry (arc, range, active, hits), so attacks.js stays independent of
 * the weapon tables. Shared scratch — pass it to armSweep, which copies it.
 */
const _stepSpec = {
  shape: SHAPE.CONE, range: 3, arc: 1, sweepArc: 0, sweepDir: 1,
  inner: 0, thickness: 0.8, expand: false, ease: 'linear', follow: true, duration: 0.1,
};

export function stepSweepSpec(step, reachMul = 1, arcMul = 1, sweepDir = 1) {
  const arc = step.arc * arcMul;
  const radial = arc >= Math.PI * 1.99;
  _stepSpec.shape = radial ? SHAPE.CIRCLE : (arc <= Math.PI * 0.3 ? SHAPE.CAPSULE : SHAPE.CONE);
  _stepSpec.range = step.range * reachMul;
  _stepSpec.arc = arc;
  // The cone travels roughly its own width again across the active window;
  // a thrust extends instead of rotating, so it gets no sweep arc at all.
  _stepSpec.sweepArc = _stepSpec.shape === SHAPE.CONE ? arc * 0.9 : 0;
  _stepSpec.sweepDir = sweepDir;
  _stepSpec.inner = _stepSpec.shape === SHAPE.CAPSULE ? 0.3 : 0;
  _stepSpec.thickness = _stepSpec.shape === SHAPE.CAPSULE ? 0.55 : 0.9;
  _stepSpec.expand = radial;
  _stepSpec.ease = _stepSpec.shape === SHAPE.CAPSULE ? 'out' : 'linear';
  _stepSpec.follow = true;
  // Multi-hit steps rearm per application, so each pass owns a slice of the
  // window rather than one sweep spanning all of them.
  _stepSpec.duration = Math.max(0.02, step.active / (step.hits || 1));
  return _stepSpec;
}
