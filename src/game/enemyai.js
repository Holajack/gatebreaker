// Enemy steering, lifted out of Game._updateEnemies.
//
// WHAT MOVED HERE
// game.js carried a three-branch `if (ai === 'ranged') ... else ...` switch that
// steered every enemy in a dead-straight line at the player, plus an O(n^2)
// neighbour-repulsion pass. Both are now functions so the AI can be changed
// without touching combat, damage or spawning.
//
// WHAT IS NEW, AND WHY
// 1. FLOW-FIELD AWARENESS. steerAgent() asks ctx.navGrid.flowAt() first. When
//    there is no grid — which is every gate today, because the arena is a convex
//    disc — flowAt returns false and the agent falls through to exactly the
//    straight-line steer that shipped. No grid means no behaviour change.
//
// 2. A STUCK BREAKER. Straight-line steering deadlocks against ANY convex
//    blocker, and the current arena is full of them. Measured, not theorised:
//    a level-1 E-gate run parks the player at (8.33, 4.64) and a brute at
//    (7.64, 8.01) with a radius-1.27 pillar sitting on the midpoint between
//    them; both press head-on into opposite faces, both slide the same way
//    round, and the pair holds distance 3.44 for 2,258+ frames. Nothing in the
//    old code could ever break that. An agent that stops making progress now
//    commits to a lateral detour, alternating side each time, until it does.
//
// 3. RANGED COMMITMENT. `ranged` held a standoff band forever: close inside
//    range*0.55 - 3 and it backpedals, sit in the band and it never advances.
//    Against a player who cannot out-run it that is an unwinnable stalemate.
//    Casters now spend their patience: after a few shots, or a few seconds of
//    holding, they COMMIT — walk in, no retreat — for a fixed window, then
//    resume the standoff. The fight always comes back into reach on a timer,
//    and the enemy is never passive: it keeps firing the whole time.
//
// Pure data. No THREE, no DOM — this file is imported by headless Node tests.

export const BEHAVIORS = ['chase', 'lunge', 'ranged', 'flank', 'siege'];

// --- tuning ---------------------------------------------------------------
// Every constant that shapes the anti-stall is here, in one block, so it can be
// tuned without reading the steering code.
export const AI_TUNING = {
  // Stuck detection is windowed, not instantaneous. Every `probeInterval`
  // seconds the agent asks two questions: did I actually move, and did the gap
  // actually close? Both are compared against what free movement would have
  // achieved, so the test scales with the archetype's speed and cannot be
  // fooled by a target that is simply running away faster than the agent.
  probeInterval: 0.4,
  probeMoveFrac: 0.3,        // moved < 30% of free travel => physically blocked
  probeProgressFrac: 0.3,    // ...and closed < 30% of free travel
  blockedWindows: 2,         // consecutive blocked windows before a detour
  // Seconds of no progress while trying to close before a detour fires
  // (derived; kept as a readable number for tests and tuning).
  stuckAfter: 0.8,
  // How long a detour runs, and how far off-axis it steers.
  detourTime: 1.1,
  detourMax: 3.5,             // detours lengthen while an episode drags on
  detourGrowth: 0.7,
  detourAngle: 1.15,          // radians (~66 deg) off the straight line
  detourInward: 0.3,          // fraction of straight-line blended back in
  // COMMIT TO ONE SIDE. Flipping side on every attempt is a livelock: the
  // agent goes left for a second, right for a second, and nets zero. Measured
  // — an alternating brute logged 200 detours in 400 s without ever getting
  // round a pillar. Hold the side like a wall-follower and only concede it
  // after this many failed attempts.
  detourFlipAfter: 3,
  // Seconds of unobstructed movement that end a stuck episode.
  episodeReset: 3.0,
  // Every Nth failed attempt, peel off entirely and re-approach: backing away
  // breaks contact with the blocker, so the next approach comes in at a
  // different angle instead of resuming the same shoving match.
  backoffEvery: 4,
  backoffTime: 0.7,
  backoffSpeed: 0.7,
  // Ranged commitment.
  standoffPatience: 4.0,      // seconds of holding before committing
  commitShots: 3,             // ...or this many shots, whichever lands first
  commitTime: 3.0,            // seconds spent closing, no retreat allowed
  commitRange: 2.2,           // how close a committed ranged agent wants to be
  // Siege (lancer) charge cycle.
  siegeWindup: 0.9,
  siegeCooldown: 3.2,
  siegeImpulse: 26,
  // Lunge (stalker).
  lungeImpulse: 16,
  lungeCdMin: 3.4,
  lungeCdRand: 2.0,
  lungeMax: 9,
  lungeMin: 3.2,
  // Flank (howler) orbit band.
  flankBand: 0.75,            // fraction of range it wants to sit at
  flankStrafe: 0.55,
};

// config.js `ai` strings -> BEHAVIORS. Kept as a table so adding an archetype
// to ENEMY_TYPES never needs a code change here.
const AI_TO_BEHAVIOR = {
  chase: 'chase',
  lunge: 'lunge',
  ranged: 'ranged',
  charge: 'siege',
  support: 'flank',
  flank: 'flank',
  siege: 'siege',
};

export function behaviorForAi(ai) {
  return AI_TO_BEHAVIOR[ai] || 'chase';
}

const _flow = { x: 0, z: 0 };

/**
 * @typedef {object} Agent
 * Per-entity AI memory. Cheap: one flat object, no allocation per frame.
 */

/**
 * @param {object} entity  the game.js enemy record (reads .base, .speed, .radius)
 * @param {string} [behavior] a BEHAVIORS entry, or a raw ENEMY_TYPES.ai string
 */
export function makeAgent(entity, behavior) {
  const base = (entity && entity.base) || {};
  const raw = behavior || base.ai || 'chase';
  const kind = BEHAVIORS.includes(raw) ? raw : behaviorForAi(raw);
  return {
    behavior: kind,
    range: base.range ?? 2,
    speed: entity?.speed ?? base.speed ?? 3,
    // stuck breaker (windowed probe; see tickAggro)
    probeT: 0,
    probeX: NaN,
    probeZ: NaN,
    probeDist: Infinity,
    blockedWindows: 0,
    closeWantFrames: 0,
    stuckTime: 0,
    detour: 0,
    detourEpisode: 0,
    sinceDetour: Infinity,
    backoff: 0,
    // Randomised so two enemies jammed against the same wall peel off opposite
    // ways instead of shuffling along it in convoy.
    detourSide: Math.random() < 0.5 ? 1 : -1,
    detours: 0,
    // ranged commitment
    standoff: 0,
    shots: 0,
    commit: 0,
    commits: 0,
    // archetype timers
    lungeCd: 0,
    siegeCd: 0,
    siegeWindup: 0,
    // aggro
    aggro: 1,
    alert: 0,
    // Reused steering output. steerAgent returns THIS object, so a caller must
    // read it before the next call for the same agent rather than storing it.
    // At 50 enemies x 60 Hz a fresh literal per frame is 3,000 short-lived
    // objects a second, which on Android is a GC hitch nobody can explain.
    _out: {
      moveX: 0, moveZ: 0, wantAttack: false, yaw: 0, telegraph: 0,
      attackKind: 'melee', impulseX: 0, impulseZ: 0, desiredSpeed: 0,
      detouring: false, committing: false, onFlow: false,
    },
  };
}

/**
 * @typedef {object} SteerContext
 * @property {object|null} navGrid   a NavGrid, or null for straight-line only
 * @property {{x:number,z:number}} targetPos
 * @property {{x:number,z:number}} selfPos
 * @property {number} distance
 * @property {boolean} losBlocked   caller-supplied "something is in the way"
 * @property {number} aggression    difficulty.js aggression multiplier
 * @property {number} dt
 */

/**
 * Advance the agent's patience/aggro bookkeeping.
 *
 * steerAgent() calls this itself. Call it directly only for agents you are NOT
 * steering this frame (staggered, telegraphing, spawning) so their timers do
 * not freeze — double-calling in one frame only advances the timers twice,
 * which is harmless but pointless.
 */
export function tickAggro(agent, ctx, dt) {
  if (!agent) return;
  const T = AI_TUNING;
  const dist = ctx.distance;

  // --- progress tracking -------------------------------------------------
  // "Did I move, and did it help?" is the only reliable stuck signal: it
  // catches pillars, walls, corners and other enemies bodyblocking without
  // needing to know which. Sampled over a window rather than per frame, because
  // per-frame deltas at 60 Hz are smaller than the noise from collision
  // resolution and crowd separation.
  const self = ctx.selfPos;
  if (Number.isNaN(agent.probeX)) {
    agent.probeX = self.x;
    agent.probeZ = self.z;
    agent.probeDist = dist;
  }
  agent.probeT += dt;
  if (agent.probeT >= T.probeInterval) {
    const moved = Math.hypot(self.x - agent.probeX, self.z - agent.probeZ);
    const closed = agent.probeDist - dist;
    // What unobstructed travel over this window would have looked like. Enemy
    // velocity actually settles around 1.28x this (accel 9 against damping 7),
    // so the fractions below sit a long way clear of normal movement.
    const free = (agent.speed || 3) * agent.probeT;
    const wanted = agent.closeWantFrames > 0;
    const blocked = moved < free * T.probeMoveFrac && closed < free * T.probeProgressFrac;
    if (wanted && blocked && agent.detour <= 0) agent.blockedWindows++;
    else agent.blockedWindows = 0;
    agent.stuckTime = agent.blockedWindows * T.probeInterval;
    agent.probeT = 0;
    agent.probeX = self.x;
    agent.probeZ = self.z;
    agent.probeDist = dist;
    agent.closeWantFrames = 0;
  }

  if (agent.backoff > 0) agent.backoff -= dt;

  if (agent.detour > 0) {
    agent.detour -= dt;
    agent.sinceDetour = 0;
    if (agent.detour <= 0) {
      agent.detour = 0;
      agent.stuckTime = 0;
      agent.blockedWindows = 0;
      agent.probeT = 0;
      agent.probeX = self.x;
      agent.probeZ = self.z;
      agent.probeDist = dist;
    }
  } else {
    agent.sinceDetour += dt;
    // A clean stretch means whatever was in the way is behind us; the next
    // stuck episode starts fresh and gets to pick its own side.
    if (agent.sinceDetour > T.episodeReset) agent.detourEpisode = 0;
  }

  // --- ranged patience ---------------------------------------------------
  if (agent.commit > 0) {
    agent.commit -= dt;
    if (agent.commit <= 0) {
      agent.commit = 0;
      agent.standoff = 0;
      agent.shots = 0;
    }
  } else if (agent.behavior === 'ranged' || agent.behavior === 'flank') {
    // Patience only accrues while the agent is in weapons range and therefore
    // has the option of just standing there. Chasing from far away is fine.
    if (dist <= agent.range) agent.standoff += dt;
    if (agent.standoff >= T.standoffPatience || agent.shots >= T.commitShots) {
      agent.commit = T.commitTime;
      agent.commits++;
      agent.standoff = 0;
      agent.shots = 0;
      agent.blockedWindows = 0;
      agent.stuckTime = 0;
    }
  }

  if (agent.lungeCd > 0) agent.lungeCd -= dt;
  if (agent.siegeCd > 0) agent.siegeCd -= dt;
  if (agent.alert > 0) agent.alert -= dt;
}

/**
 * Produce this frame's movement intent.
 *
 * @returns {{moveX:number, moveZ:number, wantAttack:boolean, yaw:number,
 *            telegraph:number, impulseX:number, impulseZ:number,
 *            attackKind:'melee'|'ranged', desiredSpeed:number}}
 *
 * moveX/moveZ is a desired velocity in world units per second (direction times
 * speed, sign included). game.js applies it exactly the way it applied
 * `toPlayer * desiredSpeed` before:
 *     e.vel.x += out.moveX * 9 * dt;
 *     e.vel.z += out.moveZ * 9 * dt;
 * impulseX/impulseZ is a one-shot velocity kick (the stalker lunge, the lancer
 * charge) and is zero on almost every frame.
 */
export function steerAgent(agent, ctx, dt) {
  const T = AI_TUNING;
  tickAggro(agent, ctx, dt);

  const dist = ctx.distance;
  const aggression = ctx.aggression ?? 1;
  const speed = (agent.speed ?? 3) * aggression;

  // Straight-line unit vector to the target — the fallback, and the reference
  // frame every detour and strafe is expressed in.
  let sx = ctx.targetPos.x - ctx.selfPos.x;
  let sz = ctx.targetPos.z - ctx.selfPos.z;
  const slen = Math.hypot(sx, sz);
  if (slen > 1e-6) { sx /= slen; sz /= slen; } else { sx = 0; sz = 1; }

  // Preferred travel direction: the flow field when one exists and is usable,
  // otherwise the straight line. This is the whole degradation contract —
  // no grid, no change.
  let px = sx;
  let pz = sz;
  let onFlow = false;
  if (ctx.navGrid && ctx.navGrid.flowAt(ctx.selfPos.x, ctx.selfPos.z, _flow)) {
    px = _flow.x;
    pz = _flow.z;
    onFlow = true;
  }

  const out = agent._out || (agent._out = {});
  out.moveX = 0; out.moveZ = 0;
  out.wantAttack = false;
  out.yaw = Math.atan2(sx, sz);
  out.telegraph = 0;
  out.attackKind = 'melee';
  out.impulseX = 0; out.impulseZ = 0;
  out.desiredSpeed = 0;
  out.detouring = false;
  out.committing = agent.commit > 0;
  out.onFlow = onFlow;

  let desired = 0;         // + closes, - retreats
  let strafe = 0;          // lateral component, fraction of speed

  switch (agent.behavior) {
    case 'ranged': {
      // Original standoff: hold at range*0.55, advance past +2, retreat inside -3.
      const ideal = agent.range * 0.55;
      if (agent.commit > 0) {
        // Committed: close the gap and do not back off, whatever the band says.
        if (dist > T.commitRange) desired = speed;
      } else {
        if (dist > ideal + 2) desired = speed;
        else if (dist < ideal - 3) desired = -speed * 0.8;
      }
      // It keeps shooting either way. Committing must not read as retreating.
      out.attackKind = 'ranged';
      if (dist < agent.range) { out.wantAttack = true; out.telegraph = 0.55; }
      break;
    }

    case 'lunge': {
      if (dist > agent.range) desired = speed;
      if (dist < T.lungeMax && dist > T.lungeMin && agent.lungeCd <= 0) {
        agent.lungeCd = T.lungeCdMin + Math.random() * T.lungeCdRand;
        out.impulseX = sx * T.lungeImpulse;
        out.impulseZ = sz * T.lungeImpulse;
      }
      if (dist <= agent.range + 0.4) { out.wantAttack = true; out.telegraph = 0.42; }
      break;
    }

    case 'siege': {
      // Lancer: hangs back, winds up visibly, then commits a straight charge.
      // Long telegraph is the fairness valve — it hits hard.
      if (agent.siegeWindup > 0) {
        agent.siegeWindup -= dt;
        desired = 0;
        if (agent.siegeWindup <= 0) {
          agent.siegeCd = T.siegeCooldown;
          out.impulseX = sx * T.siegeImpulse;
          out.impulseZ = sz * T.siegeImpulse;
        }
      } else if (dist > agent.range) {
        desired = speed;
        if (dist < 14 && dist > agent.range + 1.5 && agent.siegeCd <= 0) {
          agent.siegeWindup = T.siegeWindup;
        }
      }
      if (dist <= agent.range + 0.4) { out.wantAttack = true; out.telegraph = 0.5; }
      break;
    }

    case 'flank': {
      // Howler: orbits at the fringe buffing its friends, but it is on the same
      // commitment clock as a caster, so it cannot orbit forever either.
      const band = agent.range * T.flankBand;
      if (agent.commit > 0) {
        if (dist > T.commitRange) desired = speed;
      } else if (dist > band + 2) desired = speed * 0.9;
      else if (dist < band - 3) desired = -speed * 0.6;
      else strafe = T.flankStrafe * agent.detourSide;
      out.attackKind = 'ranged';
      if (dist < agent.range) { out.wantAttack = true; out.telegraph = 0.55; }
      break;
    }

    case 'chase':
    default: {
      if (dist > agent.range) desired = speed;
      if (dist <= agent.range + 0.4) { out.wantAttack = true; out.telegraph = 0.42; }
      break;
    }
  }

  // --- stuck breaker -----------------------------------------------------
  // Only fires when the agent WANTS to close. An agent deliberately holding
  // station is not stuck, it is doing its job.
  const wantsToClose = desired > 0;
  if (wantsToClose) agent.closeWantFrames++;

  // Mid-episode the agent has already proved something is in the way, so one
  // blocked window is enough to resume; a cold start needs two, which is what
  // keeps normal movement free of spurious detours.
  const midEpisode = agent.detourEpisode > 0 && agent.sinceDetour <= T.episodeReset;
  const needWindows = midEpisode ? 1 : T.blockedWindows;

  if (agent.detour <= 0 && wantsToClose && agent.blockedWindows >= needWindows) {
    if (agent.detourEpisode === 0) {
      // Fresh episode: pick a side at random so a crowd jammed on the same
      // corner does not queue up behind one another.
      agent.detourSide = Math.random() < 0.5 ? 1 : -1;
    } else if ((agent.detourEpisode % T.detourFlipAfter) === 0) {
      // This side has failed detourFlipAfter times running. Try the other way.
      agent.detourSide = -agent.detourSide;
    }
    agent.detourEpisode++;
    agent.detour = Math.min(
      T.detourMax,
      T.detourTime * (1 + T.detourGrowth * (agent.detourEpisode - 1)),
    );
    if (agent.detourEpisode % T.backoffEvery === 0) agent.backoff = T.backoffTime;
    agent.detours++;
    agent.blockedWindows = 0;
    agent.stuckTime = 0;
    agent.sinceDetour = 0;
  }

  if (agent.backoff > 0 && wantsToClose) {
    // Peel off. Straight back, away from the target, for a beat.
    out.moveX = -sx * speed * T.backoffSpeed;
    out.moveZ = -sz * speed * T.backoffSpeed;
    out.desiredSpeed = -speed * T.backoffSpeed;
    out.detouring = true;
    return out;
  }

  if (agent.detour > 0 && wantsToClose) {
    // Steer well off the preferred direction — the same side for the whole
    // episode, like a wall-follower — with a little inward bias so the detour
    // spirals in rather than orbiting. When a flow field exists this rotates
    // the FLOW, so the detour still respects the geometry.
    const a = T.detourAngle * agent.detourSide;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rx = px * ca - pz * sa;
    const rz = px * sa + pz * ca;
    px = rx + px * T.detourInward;
    pz = rz + pz * T.detourInward;
    const l = Math.hypot(px, pz) || 1;
    px /= l; pz /= l;
    out.detouring = true;
  }

  if (desired !== 0) {
    if (desired > 0) {
      out.moveX = px * desired;
      out.moveZ = pz * desired;
    } else {
      // Retreat backs away from the target itself, never along the flow field
      // (which points at it).
      out.moveX = sx * desired;
      out.moveZ = sz * desired;
    }
  }
  if (strafe !== 0) {
    out.moveX += -sz * strafe * speed;
    out.moveZ += sx * strafe * speed;
  }
  out.desiredSpeed = desired;

  // Attacks that actually fire are counted by the caller via noteAttack(); the
  // agent cannot know whether game.js honoured wantAttack (cooldowns live
  // there).
  return out;
}

/**
 * Call when the caller actually commits the attack steerAgent asked for. This
 * is what drives "commit after N shots" — without it a caster on a long
 * cooldown would commit purely on the patience timer.
 */
export function noteAttack(agent) {
  if (!agent) return;
  if (agent.behavior === 'ranged' || agent.behavior === 'flank') agent.shots++;
}

/** Reset the stuck breaker, e.g. after a knockback or a target switch. */
export function resetProgress(agent, distance = Infinity) {
  if (!agent) return;
  agent.probeT = 0;
  agent.probeX = NaN;
  agent.probeZ = NaN;
  agent.probeDist = distance;
  agent.blockedWindows = 0;
  agent.closeWantFrames = 0;
  agent.stuckTime = 0;
  agent.detour = 0;
}

// --------------------------------------------------------------- crowding

// Spatial hash scratch, reused between calls so separate() allocates nothing
// in steady state.
const _bins = new Map();

/**
 * Push overlapping entities apart, in place.
 *
 * Replaces Game._separate. That version was called once per enemy from inside
 * the update loop and compared against every other enemy — O(n^2) total, fine
 * at 10 enemies and quadratic-fatal at the 30-50 an S-rank gate or a city
 * street implies. Small crowds keep the exact naive pass (identical numbers to
 * what shipped); large crowds switch to a uniform spatial hash and stop at
 * maxPairs.
 *
 * @param {Array<{pos:{x:number,z:number}, radius:number}>} entities
 * @param {number} radiusScale widen or narrow personal space
 * @param {number} maxPairs    hard ceiling on pair tests per call
 */
export function separate(entities, radiusScale = 1, maxPairs = 900) {
  const n = entities.length;
  if (n < 2) return;

  const resolvePair = (a, b) => {
    const dx = a.pos.x - b.pos.x;
    const dz = a.pos.z - b.pos.z;
    const min = (a.radius + b.radius) * radiusScale;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min || d2 <= 0.0001) return;
    const d = Math.sqrt(d2);
    // Each side moves half the overlap. The old code ran the pair twice (once
    // per entity) at 0.5 each, so the net displacement is unchanged.
    const push = ((min - d) / d) * 0.5;
    a.pos.x += dx * push; a.pos.z += dz * push;
    b.pos.x -= dx * push; b.pos.z -= dz * push;
  };

  // Small crowd: the naive all-pairs pass, byte-for-byte the behaviour that
  // shipped. 40 entities is 780 pairs, under the default cap.
  if ((n * (n - 1)) / 2 <= maxPairs) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) resolvePair(entities[i], entities[j]);
    }
    return;
  }

  // Large crowd: bin by a cell the size of the widest personal space, then only
  // test the 4 forward-neighbour bins so each pair is visited once.
  let maxR = 0;
  for (let i = 0; i < n; i++) if (entities[i].radius > maxR) maxR = entities[i].radius;
  const cell = Math.max(0.5, maxR * 2 * radiusScale);
  _bins.clear();
  for (let i = 0; i < n; i++) {
    const e = entities[i];
    const key = `${Math.floor(e.pos.x / cell)},${Math.floor(e.pos.z / cell)}`;
    let bin = _bins.get(key);
    if (!bin) { bin = []; _bins.set(key, bin); }
    bin.push(e);
  }

  let pairs = 0;
  const NEIGH = [[1, 0], [0, 1], [1, 1], [-1, 1]];
  for (const [key, bin] of _bins) {
    for (let i = 0; i < bin.length && pairs < maxPairs; i++) {
      for (let j = i + 1; j < bin.length && pairs < maxPairs; j++) {
        resolvePair(bin[i], bin[j]); pairs++;
      }
    }
    if (pairs >= maxPairs) break;
    const comma = key.indexOf(',');
    const cx = Number(key.slice(0, comma));
    const cz = Number(key.slice(comma + 1));
    for (const [ox, oz] of NEIGH) {
      const other = _bins.get(`${cx + ox},${cz + oz}`);
      if (!other) continue;
      for (let i = 0; i < bin.length && pairs < maxPairs; i++) {
        for (let j = 0; j < other.length && pairs < maxPairs; j++) {
          resolvePair(bin[i], other[j]); pairs++;
        }
      }
    }
    if (pairs >= maxPairs) break;
  }
  _bins.clear();
}
