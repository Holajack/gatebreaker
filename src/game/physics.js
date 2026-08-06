import * as THREE from 'three';

/**
 * Character physics for the player, enemies and bound soldiers — one controller
 * that works both in the flat dungeon arena and on the overworld heightfield.
 *
 * The body deliberately does NOT own its vectors. Construct it around an
 * entity's existing `pos` and `vel` and every current read site
 * (`e.pos.distanceTo`, `mesh.position.copy(p.pos)`, camera lead off `p.vel`)
 * keeps working untouched, so call sites can migrate one at a time:
 *
 *   attachBody(this.player, { radius: 0.6, maxSpeed: this.derived.speed });
 *
 * The world is supplied as two callbacks, not imported, so the same body runs
 * in either level type:
 *
 *   arena:     body.setEnvironment(FLAT_GROUND, this._arenaResolve)
 *   overworld: body.setEnvironment(this._terrainHeight, this._overworldResolve)
 *
 * Build those callbacks ONCE (bind them in the Game constructor) — creating
 * them inline per frame allocates a closure per entity per frame.
 *
 * ---------------------------------------------------------------------------
 * PER-FRAME ORDER IN game.js — what to call, in this sequence
 * ---------------------------------------------------------------------------
 * Player (_updatePlayer, replacing the movement block):
 *
 *   1. body.maxSpeed = d.speed;                 // whenever derived stats change
 *   2. if (this.input.consume('jump')) body.jump();
 *      body.setJumpHeld(this.input.isHeld('jump'));
 *   3. const mv = this.input.sample();
 *      body.move(mv.x, -mv.y, p.swing > 0 ? 0.35 : 1);   // 0 throttle = coast
 *   4. skills that shove, authored in world units rather than force numbers:
 *      const v = body.impulseForDistance(SKILLS.dash.distance);
 *      body.addImpulse(dir.x * v, 0, dir.z * v);
 *      applyKnockback(e.body, dir, e.body.impulseForDistance(2.5));
 *   5. body.step(step);                          // integrates + collides + grounds
 *   6. read body.grounded / body.justLanded / body.landSpeed for fx and audio,
 *      and body.groundSpeed for animateRig's `speed`
 *   7. p.mesh.position.copy(p.pos); p.mesh.rotation.y = p.yaw;
 *
 * step() does the whole pipeline in the only order that is correct: timers ->
 * jump -> gravity -> friction -> acceleration -> slide -> integrate -> the
 * caller's horizontal resolve() -> ground contact. Nothing else may move `pos`
 * between those stages; crowd separation (_separate) must run AFTER step, and
 * must leave pos.y alone.
 *
 * Enemies and soldiers replace their `vel.addScaledVector(dir, speed*9*dt)` +
 * exponential drag + hard clamp + world.resolve() with:
 *
 *   e.body.move(toPlayer.x, toPlayer.z, chasing ? 1 : 0);
 *   e.body.step(dt);
 *
 * Backing off (the caster's `desiredSpeed = -e.speed * 0.8`) is
 * `move(-toPlayer.x, -toPlayer.z, 0.8)`, and the stalker's lunge becomes
 * `addImpulse` rather than a raw velocity add, so the max-speed clamp no longer
 * eats it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MAX-SPEED CLAMP IS GONE
 * ---------------------------------------------------------------------------
 * The old `if (sp > maxSpeed) scale down` ran every frame on the total
 * velocity, which meant a knockback or a lunge was deleted on the very frame it
 * was applied — impulses only ever worked because dashTimer widened the clamp.
 * Here acceleration can never push velocity past maxSpeed *along the input
 * direction* (so held input still tops out exactly at maxSpeed), while anything
 * above that came from an impulse and is bled off gradually by `overspeedDrag`.
 * Knockback, dash and lunge all survive and decay instead of vanishing.
 */

// One shared scratch normal: sampling the ground must not allocate.
const _n = { x: 0, y: 1, z: 0 };

/** Ground provider for the flat arena. Identity-checked to skip slope work. */
export const FLAT_GROUND = () => 0;

export const BODY_DEFAULTS = {
  // Heavier than earth gravity on purpose: at this character scale a realistic
  // 9.81 gives a floaty, slow-apex jump that fights the pace of the combat.
  gravity: 26,
  fallGravityScale: 1.35,   // fall faster than you rise — the standard snap trick
  terminalVelocity: 42,
  jumpSpeed: 10.0,          // apex ~1.9 units, a little over head height
  jumpCut: 0.42,            // velocity kept when the button is released mid-rise
  minJumpHeight: 1.05,      // a tap still clears this, however fast you let go
  coyoteTime: 0.12,         // grace to still jump after walking off an edge
  jumpBuffer: 0.15,         // grace to press jump before actually landing
  jumpWhileSliding: true,   // being trapped on a slope is worse than a free jump

  maxSpeed: 6,
  groundAccel: 62,          // ~0.1s from standstill to full speed
  airControl: 0.35,
  friction: 9,
  stopSpeed: 0.35,          // below this with no input, snap to rest
  overspeedDrag: 6,         // how fast the above-maxSpeed part of an impulse bleeds

  slopeLimit: 0.55,         // matches terrain.walkable(); 1 - normal.y
  slideAccel: 24,
  slideControl: 0.22,       // steering authority while sliding down a steep face

  stepHeight: 0.4,          // ledges up to this are climbed without leaving the ground
  snapDistance: 0.45,       // downhill stick tolerance, widened by travel speed
  skin: 0.02,
  maxStep: 0.05,            // never integrate a longer frame than this
  normalSampleDist: 0.35,   // resample the ground normal only after moving this far
  normalEps: 0.9,           // finite-difference span, matches Terrain.normal
};

export class CharacterBody {
  /**
   * @param {object} opts `pos`/`vel` are adopted by reference when given, plus
   *   `radius`, the `groundHeight`/`resolve`/`groundNormal` providers, and any
   *   key from BODY_DEFAULTS as a per-body override.
   */
  constructor(opts = {}) {
    this.pos = opts.pos || new THREE.Vector3();
    this.vel = opts.vel || new THREE.Vector3();
    this.radius = opts.radius ?? 0.5;

    // Tuning is copied flat onto the instance so one body can be retuned live
    // (the player's maxSpeed moves with every Agility point) without cloning a
    // config object per entity. Fixed key order keeps every body one shape.
    for (const k in BODY_DEFAULTS) this[k] = opts[k] ?? BODY_DEFAULTS[k];

    this.groundHeight = opts.groundHeight || FLAT_GROUND;
    this.groundNormal = opts.groundNormal || null;
    this.resolve = opts.resolve || null;
    this._flat = this.groundHeight === FLAT_GROUND;

    this.grounded = true;
    this.sliding = false;
    this.groundY = 0;
    this.groundSpeed = 0;
    this.airTime = 0;
    this.justLanded = false;
    this.justJumped = false;
    this.landSpeed = 0;

    this.nx = 0; this.ny = 1; this.nz = 0;

    this._coyote = 0;
    this._buffer = 0;
    this._jumpHeld = false;
    this._cut = true;             // true = no jump in flight left to cut short
    this._moveX = 0;
    this._moveZ = 0;
    this._throttle = 0;
    this._drag = 0;               // per-impulse overspeedDrag override, 0 = none
    // The floor a jump-cut may never reduce the rise below.
    this._minCutSpeed = jumpSpeedForHeight(this.minJumpHeight, this.gravity);
    this._impulseCache = new Map();
    this._sampleX = Infinity;     // forces a normal sample on the first step
    this._sampleZ = Infinity;
  }

  /**
   * Bind the body to a level. `groundHeight(x, z)` is required;
   * `resolve(pos, radius, vel)` matches World.resolve / Overworld.resolve;
   * `groundNormal(x, z, out)` is optional and, when absent, the normal is
   * derived from groundHeight by central differences.
   */
  setEnvironment(groundHeight, resolve = null, groundNormal = null) {
    this.groundHeight = groundHeight || FLAT_GROUND;
    this.resolve = resolve;
    this.groundNormal = groundNormal;
    this._flat = this.groundHeight === FLAT_GROUND;
    this._sampleX = Infinity;
    return this;
  }

  /**
   * Desired heading for this frame. Need not be normalized — its length is the
   * analog magnitude (a half-pushed stick walks). `throttle` scales the target
   * speed as well as the acceleration, so a swing-slowed walk tops out slower
   * instead of merely taking longer to reach full speed. It cannot exceed 1;
   * to sprint, raise maxSpeed, or the extra speed reads as an impulse and gets
   * bled straight back off.
   *
   * Must be called every frame you want movement: step() clears it, so an
   * entity that stops steering coasts to a halt on friction alone.
   */
  move(dx, dz, throttle = 1) {
    const len = Math.sqrt(dx * dx + dz * dz);
    // Written as a negated >= so NaN takes this branch instead of sailing past.
    if (!(len >= 1e-4) || !(throttle > 0)) {
      this._moveX = 0; this._moveZ = 0; this._throttle = 0;
      return this;
    }
    this._moveX = dx / len;
    this._moveZ = dz / len;
    this._throttle = Math.min(1, len) * Math.min(1, throttle);
    return this;
  }

  /** Buffer a jump press. Fires on the next step where ground or coyote allows. */
  jump() {
    this._buffer = this.jumpBuffer;
    this._jumpHeld = true;
    return this;
  }

  releaseJump() { this._jumpHeld = false; }

  setJumpHeld(held) { this._jumpHeld = !!held; }

  /** True while a buffered press is still waiting for ground. */
  get jumpPending() { return this._buffer > 0; }

  /** True while the character could jump right now (ground or coyote grace). */
  get canJump() { return this.grounded || this._coyote > 0; }

  /**
   * External shove — dash, lunge, knockback, boss charge. Free to exceed
   * maxSpeed; the excess decays at `overspeedDrag` rather than being clamped.
   *
   * `drag` overrides that rate until the excess is spent, which is how one body
   * can have both a long gliding dash and a short punchy knockback. It must
   * match the rate passed to impulseForDistance() or the distance won't hold.
   */
  addImpulse(x, y = 0, z = 0, drag = 0) {
    this.vel.x += x;
    this.vel.y += y;
    this.vel.z += z;
    this._drag = drag > 0 ? drag : 0;   // never inherit the previous impulse's decay
    return this;
  }

  /** Drop the body at (x, z) standing on the ground, at rest. */
  placeOnGround(x = this.pos.x, z = this.pos.z) {
    return this.reset(x, this.groundHeight(x, z), z);
  }

  /** Teleport and clear all motion and jump state. Use on gate start / respawn. */
  reset(x = this.pos.x, y = this.pos.y, z = this.pos.z) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.groundY = this.groundHeight(x, z);
    // Respawning above the floor should fall, not hang there for a frame.
    this.grounded = y <= this.groundY + this.skin;
    this.sliding = false;
    this.airTime = 0;
    this.justLanded = false;
    this.justJumped = false;
    this.landSpeed = 0;
    this._coyote = 0;
    this._buffer = 0;
    this._jumpHeld = false;
    this._cut = true;
    this._throttle = 0;
    this._drag = 0;
    this._sampleX = Infinity;
    return this;
  }

  horizontalSpeed() { return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z); }

  /** Height above the ground directly underfoot. */
  heightAboveGround() { return this.pos.y - this.groundY; }

  /**
   * Initial impulse speed that carries this body `distance` units before it
   * settles back to a walk — so dashes and knockbacks are authored in world
   * units instead of magic force numbers:
   *
   *   body.addImpulse(dx * body.impulseForDistance(7.5), 0, dz * ...)
   *
   * Bisects against a replay of the body's own decay rule rather than a closed
   * form: ground friction eats the impulse alongside `drag`, so distance * drag
   * overshoots badly, and a continuous solution misses the half-frame every
   * discrete step loses. A few thousand scalar iterations on a button press.
   */
  impulseForDistance(distance, drag = this.overspeedDrag) {
    if (!(distance > 0) || !(drag > 0)) return 0;
    // Memoised, and always solved at a fixed 1/60 rather than the last frame's
    // dt. Two reasons: Nova knocks back every enemy in radius, so this ran ~30
    // times in the one frame that already pays a hit-stop and a particle burst;
    // and during hit-stop `dt` is a twelfth of normal, which made each solve
    // seven times more expensive for a slightly worse answer. Solving at 1/60
    // and running anywhere from 1/120 to 1/20 costs under 0.1% of distance.
    const key = `${distance}|${drag}|${this.maxSpeed}|${this.friction}|${this.stopSpeed}`;
    const hit = this._impulseCache.get(key);
    if (hit !== undefined) return hit;

    const dt = 1 / 60;
    let lo = 0;
    let hi = distance * drag + this.maxSpeed * 2 + 1;
    for (let i = 0; i < 40 && this._travel(hi, drag, dt) < distance; i++) hi *= 1.6;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5;
      if (this._travel(mid, drag, dt) < distance) lo = mid; else hi = mid;
    }
    const v0 = (lo + hi) * 0.5;
    // Bounded so a caller sweeping continuous distances cannot grow it forever.
    if (this._impulseCache.size > 64) this._impulseCache.clear();
    this._impulseCache.set(key, v0);
    return v0;
  }

  /** Ground distance covered by an impulse of `v0`, integrated exactly as step() does. */
  _travel(v0, drag, dt) {
    if (!(drag > 0)) return Infinity;               // overspeed never bleeds off
    // With no ground friction the body coasts at maxSpeed forever, so "distance
    // until it settles" is only meaningful down to a walk, not to a stop.
    const floor = this.friction > 0
      ? Math.max(1e-3, this.stopSpeed)
      : Math.max(1e-3, this.maxSpeed);
    let sp = v0;
    let d = 0;
    for (let i = 0; i < 900 && sp > floor; i++) {
      sp = this._decay(sp, dt, true, drag);
      d += sp * dt;
    }
    return d;
  }

  /**
   * Speed after one frame of resistance. Below maxSpeed that is plain ground
   * friction; above it the walking part still rubs off while the excess — the
   * knockback or the dash — decays at its own slower rate, so an impulse
   * travels instead of evaporating, yet nothing coasts at maxSpeed forever.
   */
  _decay(sp, dt, rubbing, drag) {
    if (sp <= this.maxSpeed) return rubbing ? sp * Math.exp(-this.friction * dt) : sp;
    const base = rubbing ? this.maxSpeed * Math.exp(-this.friction * dt) : this.maxSpeed;
    return base + (sp - this.maxSpeed) * Math.exp(-drag * dt);
  }

  step(dt) {
    if (dt <= 0) return this;
    if (dt > this.maxStep) dt = this.maxStep;

    const pos = this.pos;
    const vel = this.vel;

    this.justLanded = false;
    this.justJumped = false;
    if (this._coyote > 0) this._coyote -= dt;
    if (this._buffer > 0) this._buffer -= dt;

    // --- what we are standing on ---
    const h0 = this.groundHeight(pos.x, pos.z);
    this._updateNormal(pos.x, pos.z);
    const steepness = 1 - this.ny;
    const steep = steepness > this.slopeLimit;
    const wasGrounded = this.grounded;
    this.sliding = wasGrounded && steep;

    // --- jump ---
    if (this._buffer > 0 && (wasGrounded || this._coyote > 0)
        && (!this.sliding || this.jumpWhileSliding)) {
      vel.y = this.jumpSpeed;
      this.grounded = false;
      this.sliding = false;
      this._buffer = 0;
      this._coyote = 0;
      this._cut = false;
      this.justJumped = true;
    }

    // --- gravity ---
    if (this.grounded) {
      if (vel.y < 0) vel.y = 0;
    } else {
      // Releasing early cuts the rise. Without this every jump is the same
      // height and the character reads as being on rails.
      // Skip the takeoff frame: the jump above set vel.y this very step, and a
      // tap that is already released by then would otherwise be cut before it
      // ever rose. Floor the result so the shortest possible tap still clears
      // minJumpHeight — without it a tap reached 17% of a held jump, which on
      // a touchscreen is every jump.
      if (!this._cut && !this._jumpHeld && !this.justJumped && vel.y > this._minCutSpeed) {
        vel.y = Math.max(vel.y * this.jumpCut, this._minCutSpeed);
        this._cut = true;
      }
      vel.y -= this.gravity * (vel.y < 0 ? this.fallGravityScale : 1) * dt;
      if (vel.y < -this.terminalVelocity) vel.y = -this.terminalVelocity;
    }

    // --- friction, and the bleed-off of anything above maxSpeed ---
    const rubbing = this.grounded && !this.sliding;
    let sp = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    if (sp <= this.maxSpeed) this._drag = 0;
    if (sp > 1e-5) {
      let target = this._decay(sp, dt, rubbing, this._drag || this.overspeedDrag);
      if (rubbing && this._throttle === 0 && target < this.stopSpeed) target = 0;
      if (target !== sp) {
        const k = target / sp;
        vel.x *= k;
        vel.z *= k;
        sp = target;
      }
    }

    // --- acceleration ---
    if (this._throttle > 0) {
      const want = this.maxSpeed * this._throttle;
      // Measure speed already going the way we want, and only ever top it up to
      // `want`. Velocity above that came from an impulse and is left alone, so
      // steering during a dash redirects it without cancelling it.
      const into = vel.x * this._moveX + vel.z * this._moveZ;
      const gap = want - into;
      if (gap > 0) {
        let accel = this.grounded ? this.groundAccel : this.groundAccel * this.airControl;
        if (this.sliding) accel *= this.slideControl;
        const add = Math.min(accel * this._throttle * dt, gap);
        vel.x += this._moveX * add;
        vel.z += this._moveZ * add;
      }
    }

    // --- slide down un-walkable ground ---
    if (this.sliding) {
      // For a heightfield the horizontal part of the surface normal points
      // straight downhill, so it doubles as the slide direction.
      const dl = Math.sqrt(this.nx * this.nx + this.nz * this.nz);
      if (dl > 1e-5) {
        const k = (this.slideAccel * steepness * dt) / dl;
        vel.x += this.nx * k;
        vel.z += this.nz * k;
      }
    }

    // --- integrate ---
    const px = pos.x;
    const pz = pos.z;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    if (this.resolve) this.resolve(pos, this.radius, vel);

    // --- ground contact at the destination ---
    const dx = pos.x - px;
    const dz = pos.z - pz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    let h1 = this.groundHeight(pos.x, pos.z);
    const rise = h1 - h0;
    if (wasGrounded && rise > this.stepHeight && rise > dist * this._riseRatio()) {
      // A face too tall and too steep to step onto: refuse the move outright.
      // Snapping up it instead would teleport characters onto cliffs.
      pos.x = px;
      pos.z = pz;
      if (dist > 1e-5) {
        const inv = 1 / dist;
        const into = vel.x * dx * inv + vel.z * dz * inv;
        if (into > 0) {
          vel.x -= dx * inv * into;
          vel.z -= dz * inv * into;
        }
      }
      h1 = h0;
    }

    if (pos.y <= h1 + this.skin) {
      // Covers both landing and the step-up: ground that rose under us by less
      // than stepHeight was never blocked above, so we simply stand on it.
      if (!wasGrounded && vel.y < 0) {
        this.justLanded = true;
        this.landSpeed = -vel.y;
      }
      pos.y = h1;
      if (vel.y < 0) vel.y = 0;
      this.grounded = true;
    } else if (wasGrounded && !this.justJumped && vel.y <= 0
               && pos.y - h1 <= this.snapDistance + dist * 2) {
      // Walking down a slope: stick to it. The tolerance scales with distance
      // travelled, otherwise anything moving fast launches off every crest.
      pos.y = h1;
      vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    this.groundY = h1;
    this.groundSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    if (this.grounded) {
      this.airTime = 0;
      this._coyote = this.coyoteTime;
      this._cut = true;
      this.sliding = steep;
    } else {
      this.airTime += dt;
      this.sliding = false;
    }

    this._throttle = 0;
    return this;
  }

  _riseRatio() {
    // Height gained per unit travelled that counts as a wall rather than a
    // ramp, derived from the same slope limit that decides walkability:
    // tan(acos(ny)), without the trig.
    const ny = Math.max(0.05, 1 - this.slopeLimit);
    return Math.sqrt(1 - ny * ny) / ny;
  }

  _updateNormal(x, z) {
    if (this._flat || this.slopeLimit >= 1) {
      this.nx = 0; this.ny = 1; this.nz = 0;
      return;
    }
    // A normal costs four more height samples, and terrain.height is layered
    // fbm — far too expensive to pay per entity per frame. The field is smooth,
    // so resample only once the body has actually moved somewhere new.
    const dx = x - this._sampleX;
    const dz = z - this._sampleZ;
    const d = this.normalSampleDist;
    if (dx * dx + dz * dz < d * d) return;
    this._sampleX = x;
    this._sampleZ = z;
    const r = this.groundNormal
      ? (this.groundNormal(x, z, _n) || _n)
      : sampleGroundNormal(this.groundHeight, x, z, this.normalEps, _n);
    // Terrain.normal(x, z, eps) takes a NUMBER third, not an out-object, so the
    // obvious adapter `(x,z,out) => terrain.normal(x,z,out)` yields NaN. NaN
    // fails every `> slopeLimit` test silently, which switches slope detection
    // off for the rest of the run and lets characters walk up cliffs. Validate
    // rather than trust.
    if (!(r && r.y > 0)) { this.nx = 0; this.ny = 1; this.nz = 0; return; }
    this.nx = r.x;
    this.ny = r.y;
    this.nz = r.z;
  }
}

// --------------------------------------------------------------- helpers

/**
 * Give an existing entity a body around the vectors it already has, so nothing
 * that reads `entity.pos` / `entity.vel` needs to change.
 */
export function attachBody(entity, opts = {}) {
  entity.body = new CharacterBody({
    pos: entity.pos,
    vel: entity.vel,
    radius: entity.radius,
    ...opts,
  });
  return entity.body;
}

/**
 * Shove `body` away along `dir` (any object with x/z; its length is ignored).
 * `lift` pops the target off the ground, `drag` sets how fast the shove decays.
 */
export function applyKnockback(body, dir, force, lift = 0, drag = 0) {
  const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
  if (len < 1e-5) {
    if (lift) body.addImpulse(0, lift, 0);
    return body;
  }
  return body.addImpulse((dir.x / len) * force, lift, (dir.z / len) * force, drag);
}

/**
 * Surface normal of a height function by central differences. Writes into
 * `out` and returns it, so hot paths can pass a reused object.
 */
const _sharedNormal = { x: 0, y: 1, z: 0 };

export function sampleGroundNormal(groundHeight, x, z, eps = 0.9, out = _sharedNormal) {
  const hL = groundHeight(x - eps, z);
  const hR = groundHeight(x + eps, z);
  const hD = groundHeight(x, z - eps);
  const hU = groundHeight(x, z + eps);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
  return out;
}

/** Upward velocity needed to reach `height` under `gravity`. */
export function jumpSpeedForHeight(height, gravity = BODY_DEFAULTS.gravity) {
  return Math.sqrt(2 * gravity * Math.max(0, height));
}

/**
 * Impulse speed for `distance` units of travel with no ground friction — an
 * airborne shove, or a quick estimate at config time. On the ground use
 * body.impulseForDistance(), which also accounts for friction.
 */
export function ballisticImpulse(distance, drag = BODY_DEFAULTS.overspeedDrag) {
  return distance * drag;
}

/** Shortest-arc step from one angle toward another. */
export function approachAngle(current, target, t) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * Math.min(1, Math.max(0, t));
}
