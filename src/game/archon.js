// The shared ARCHON substrate (CLASSES_SPEC build-order STEP 6): per-target
// status stacks with expiry, a capped InstancedMesh VFX pool, the
// non-emissive tint ramp, and the per-path resource meter.
//
// THIS MODULE IS THE PARITY GUARANTEE. FLAME, FROST and STORM are thin
// configurations of exactly these four exports (STEP 9/10); SHADOW and BEAST
// use only the resource half. It is built BEFORE any individual path on
// purpose: three ad-hoc implementations of the same machinery — three stack
// expiry rules, three InstancedMesh pools, three leak surfaces, three
// opinions about whether a tint is emissive — is precisely how the non-shadow
// paths would ship worse than the head-started SHADOW, and it is the shape of
// all three GPU leaks this project has already shipped.
//
// THIS MODULE IS LIVE. (Its header claimed "no path uses this yet" long after
// steps 8-10 shipped — stale load-bearing doc, audit finding, fixed.) game.js
// imports ARCHON_PATHS / StatusTable / ArchonPool / ResourceMeter /
// tintForStacks / TINT_TARGETS and runs every path's combat machinery;
// tools/classes-test.mjs still drives it headless (StatusTable /
// ResourceMeter / tintForStacks are THREE-data-free enough for bare node) and
// in the browser (ArchonPool's one-draw-call and dispose-to-baseline asserts).
//
// HARD RULES, enforced here and asserted by the test:
//   * NO EMISSIVE, NO RIM. Enemies and the player are living characters;
//     tintForStacks returns a material COLOUR and nothing else, ArchonPool's
//     material is MeshBasicMaterial (which does not even own an .emissive),
//     and nothing here touches GLOW_LAYER or rim.js.
//   * NO WALL CLOCK, NO Math.random. Everything advances on tick(dt) — the
//     caller's sim step — so hit-stop, pause and replay all behave, and a
//     rebuild replays byte-identically.
//   * ZERO PER-FRAME ALLOCATION. Stack entries are pooled and reused, the
//     pool writes matrices through module-scratch objects, and tick() never
//     creates an object, an array or a closure.
//   * ONE DISPOSAL SURFACE. ArchonPool.dispose() and StatusTable.disposeAll()
//     are the only teardown verbs, and dispose() returns renderer.info.memory
//     to its pre-build values (asserted in the browser).

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// PATH CONFIGURATIONS (CLASSES_SPEC build-order STEP 9)
// ---------------------------------------------------------------------------
//
// FLAME and FROST as DATA — thin configurations of the four substrate exports
// below, exactly as the STEP 6 header promised. game.js's hit hooks read these
// numbers; tools/classes-test.mjs pins them against the spec's own arithmetic
// (the worked examples: 220% x 841 = 1,850 per combustion, 45% x 841 = 378/s
// under Ashfall, barrier cap 35% x 4,944 = 1,730). The RESOURCE rules (Ember
// max 100 / gain 2 / decay 3; Barrier max 35 / gain 0.4 / decay 2) live in
// classes.js ARCHONS.*.resourceRules on purpose and are NOT duplicated here:
// classes.js is the meter's one source (archonResourceRules), this table is
// the combat mechanics' one source, and a number that lived in both would be
// the drift this module exists to prevent.

export const ARCHON_PATHS = {
  flame: {
    key: 'flame',
    // Stack rule for the shared StatusTable. Expiry 4 s is the pressure
    // window: at the worked example's ~2.7 hits/s a target is refreshed long
    // before it lapses, but disengaging for four seconds lets a room cool —
    // Pyre is maintained by landing hits, not fire-and-forget.
    stacks: { pyre: { max: 10, expiry: 4 } },
    // PYRE: each stack ticks 2% of derived.atk per second, so a 10-stack
    // target burns for 20% atk/s (spec wording verbatim).
    pyre: { dotFracPerStackPerSecond: 0.02 },
    // COMBUSTION at 10 stacks: 220% of derived.atk in a 4 m radius, stacks
    // reset, 4 re-seeded on every OTHER enemy caught. The combusting target
    // itself takes no blast and keeps no seed — the spec's worked example
    // prices the per-target cycle at 10 stacks / 2.7 hits/s = 3.7 s, which is
    // only true if the target restarts from zero; and a self-blast landing
    // inside the _damageEnemy call that triggered it would double-kill
    // through the outer call's own death check. Neighbours cascading at
    // 6 + 4 stacks IS the path (roomDps 1.30 by CASCADE).
    // chainCap is a WATCHDOG, not a balance knob: a combustion seeds
    // 4 x 8 = 32 stacks into a packed room while consuming 10, so among
    // bodies too tough for the blasts to kill the chain is self-sustaining
    // by design (roomDps 1.30 by CASCADE — live rooms die of it first, which
    // is what terminates it in play). 64 links is more than any survivable
    // room ever fires and bounds the single-frame worst case.
    combustion: { atStacks: 10, atkPct: 2.2, radius: 4, reseed: 4, chainCap: 64 },
    // ASHFALL (the ultimate, at 100 Ember, spent in full): the floor burns
    // for 8 s in a 14 m radius at 45% atk/s, seeding 1 stack per second.
    ashfall: { seconds: 8, radius: 14, atkFracPerSecond: 0.45, stacksPerSecond: 1 },
    // One pooled InstancedMesh of flame quads, max 64 (vfxBudget verbatim).
    fx: { kind: 'flame', maxInstances: 64 },
  },
  frost: {
    key: 'frost',
    // Rime holds 6 s — earned hit by hit, but a control stack that lapsed
    // faster than a Pyre stack would punish exactly the slow, deliberate
    // play the path sells.
    stacks: { rime: { max: 10, expiry: 6 } },
    // RIME: -6% enemy move AND attack speed per stack, floor at -60%.
    rime: { slowPerStack: 0.06, maxSlow: 0.60 },
    // FREEZE at the 10th stack: 2.2 s solid, +45% damage taken, stacks clear
    // on thaw. The pose is the existing stagger hold — no new animation.
    freeze: { atStacks: 10, seconds: 2.2, bonusTakenPct: 0.45 },
    // SHATTER: a hit on a frozen enemy exceeding 15% of its max HP splits
    // 300% of THAT HIT among all OTHER enemies within 6 m (+3 Rime each).
    // The shattered target is the split's origin, not a recipient — same
    // no-self-blast reasoning as combustion above.
    shatter: { hitFracOfMaxHp: 0.15, splitPct: 3.0, radius: 6, reseed: 3 },
    // The manual freeze-detonate (the contextual slot's FROST meaning): a
    // 20%-of-maxHp strike on the nearest frozen target inside 16 m — over
    // the 15% shatter line by construction, so the tap IS a shatter. It
    // costs nothing (classes.js resourceRules.ultimateCost 0): its price is
    // the ten hits of setup.
    detonate: { range: 16, hitFracOfMaxHp: 0.20 },
    // Rime shard quads, max 48 (vfxBudget verbatim).
    fx: { kind: 'frost', maxInstances: 48 },
  },
  storm: {
    key: 'storm',
    // No stacks: ARC is a discharge, not a status — the STORM ARCHON's state
    // is the Charge meter (classes.js resourceRules: max 200, +1/metre,
    // -8/s stationary), which is why "a Storm Archon who stops moving is a
    // plain hunter, and that is the deal" (spec wording).
    // ARC: every landed player hit discharges Charge and chains to up to
    // 4 ADDITIONAL enemies within 8 m for 55% of derived.atk each. No
    // Charge, no chain.
    //
    // discharge 4 — THE STEP 11 PARITY TUNE (was 10). The spec's own route
    // argument prices Arc as "every single landed hit into five hits", but
    // at the shipped economy (+1 Charge per metre, a fight moved at roughly
    // the build's own ~10 m/s of real kiting) a 10-point discharge sustains
    // chains on only ~1 hit in 3 (gain ~10/s against a ~22/s ask at the
    // yardstick's ~2.2 hits/s), and the parity harness prices storm's
    // composite ~0.09 under the band. 4 ≈ the metres actually covered per
    // hit interval, so the stated route holds SUSTAINED at the shipped gain
    // rate and storm lands inside the 0.06 band. Chain damage (55% x atk),
    // the 4-chain cap, the radius and the whole Tempest economy are
    // untouched — the tune changes how often the bar pays, never how much.
    arc: { discharge: 4, chains: 4, radius: 8, atkPct: 0.55 },
    // TEMPEST STEP (the ultimate, at 200 Charge, spent in full): 6 s of move
    // speed +55% under the HARD ABSOLUTE 14 u/s ceiling, dash cooldown zero,
    // a 90%-of-atk bolt down every dash line, basic attacks free of their
    // cooldown, and NO Charge regeneration for the duration.
    //
    // hardSpeedCap is THE game-wide ceiling, not a tempest-local number: the
    // collision solver, camera follow and walk cycle were all tuned around a
    // base of 6.0 with an agility bonus asymptotic to 4.2 (config.js
    // STAT_RATES.agi records what an uncapped speed term did), and TEMPO's
    // clamp in game.js already answered to the same 14. It lives here as
    // data so game.js's one clamp site and the node suite pin one source.
    // boltHalfWidth 1.2 m ~ the player's own melee reach slack: the dash
    // line is a blade, not a room.
    tempest: { seconds: 6, speedBonus: 0.55, hardSpeedCap: 14, boltAtkPct: 0.9, boltHalfWidth: 1.2 },
    // One pooled InstancedMesh of THIN BOX SEGMENTS for the chains (max 40
    // segments, one draw — vfxBudget verbatim); endpoints reuse fx.burst.
    fx: { kind: 'storm', maxInstances: 40 },
  },
  beast: {
    key: 'beast',
    // PACT: five slots, one per gate rank band (E/D share a slot — bands
    // below), bound from a boss or elite corpse through the EXISTING
    // extraction path. Exactly ONE pact beast fields at a time, at 4.0x a
    // normal shadow's shadowCombat() numbers, and it consumes the ENTIRE
    // field-shadow allowance — one ally, not thirteen, which is what keeps
    // the path inside quality.js maxFieldShadows with no special case.
    // grade 5 is WARLORD (config.js SHADOW_GRADES[5]): the worked example's
    // own arithmetic — brute base 78 hp / 11 atk x WARLORD 2.5 x the owner
    // terms = 1,014 / 218, x 4.0 -> 4,056 / 871 — prices pacts at exactly
    // this grade, so it is the bind grade, not a promotion ladder.
    pact: { mul: 4.0, grade: 5, bands: { E: 0, D: 0, C: 1, B: 2, A: 3, S: 4 } },
    // WILD FORM: 12 s in the shape of the active pact beast — 2.2x attack
    // power, 1.5x move speed (under the same 14 u/s ceiling), 40% flat
    // damage reduction, no skills and no items. The cooldown numbers (90 s,
    // -6 s per kill made while transformed) are classes.js
    // ARCHONS.beast.resourceRules on the same no-duplication rule as the
    // meters above. NO GLOW ON THE PLAYER: the form is sold by the rig swap
    // (SkeletonUtils.clone via the _makeBoundBody path), a desaturated
    // palette, and one fx.burst/ring/shake at the transition — never a rim.
    wildForm: { seconds: 12, atkMul: 2.2, speedMul: 1.5, flatDr: 0.40 },
    // No fx entry and no stacks ON PURPOSE: BEAST uses only the substrate's
    // resource half (an inert max-0 meter). The pact beast is one body
    // inside the existing field budget and Wild Form is a mesh swap — zero
    // new pools (vfxBudget verbatim), and game.js gates pool construction
    // on this very absence.
  },
};

// ---------------------------------------------------------------------------
// STATUS STACKS
// ---------------------------------------------------------------------------

// Per-kind defaults. A path configuration (STEP 9/10) passes its own rules —
// Pyre { max 10, expiry 4 }, Rime { max 10, expiry 6 } — these exist so a
// bare `new StatusTable()` is still a working table rather than a trap.
const DEFAULT_RULE = { max: 10, expiry: 6 };

/**
 * Per-target stack integers with expiry — the one stack machine every
 * stacking path shares. Targets are the live enemy records themselves (any
 * object identity works); kinds are short strings ('pyre', 'rime').
 *
 * Expiry is REFRESH-ON-APPLY: a stack application resets the kind's whole
 * expiry clock rather than aging each stack separately. That is the cheap
 * rule (one timer per target-kind, not one per stack) and the right one for
 * both shipped designs — Pyre and Rime are pressure the player maintains by
 * continuing to land hits, not a bookkeeping ledger of ten independent DoTs.
 */
export class StatusTable {
  constructor(rules = {}) {
    this.rules = rules;
    // target -> { [kind]: entry }, entries pooled below so churn from dying
    // enemies does not allocate at apply time after warm-up.
    this._map = new Map();
    this._entryPool = [];
    this._rowPool = [];
  }

  _rule(kind) { return this.rules[kind] || DEFAULT_RULE; }

  /**
   * Add n stacks (default 1) of `kind` to `target`. Returns the NEW count
   * after the rule's max clamp — the caller reads a 10 back to know a
   * combustion/freeze threshold has been reached. n <= 0 is a no-op returning
   * the current count, so a consumer can poll via apply(t, k, 0).
   */
  apply(target, kind, n = 1) {
    if (!target) return 0;
    let row = this._map.get(target);
    if (n <= 0 && !row) return 0;
    if (!row) {
      row = this._rowPool.pop() || {};
      this._map.set(target, row);
    }
    let e = row[kind];
    if (n <= 0 && !e) return 0;
    if (!e) {
      e = this._entryPool.pop() || { n: 0, t: 0 };
      row[kind] = e;
    }
    const rule = this._rule(kind);
    if (n > 0) {
      e.n = Math.min(rule.max, e.n + Math.floor(n));
      e.t = rule.expiry;   // refresh-on-apply — see class comment
    }
    return e.n;
  }

  /** Current stack count, zero-allocation, zero side effects. */
  get(target, kind) {
    const e = this._map.get(target)?.[kind];
    return e ? e.n : 0;
  }

  /** Seconds until this target-kind expires (0 when absent) — HUD/test read. */
  remaining(target, kind) {
    const e = this._map.get(target)?.[kind];
    return e ? e.t : 0;
  }

  /**
   * Age every entry by dt; an entry whose clock reaches zero drops to zero
   * stacks and returns to the pool. Iterating a Map while deleting from it is
   * defined behaviour (entries visited once), so this needs no snapshot and
   * allocates nothing.
   */
  tick(dt) {
    for (const [target, row] of this._map) {
      let live = 0;
      for (const kind in row) {
        const e = row[kind];
        e.t -= dt;
        if (e.t <= 0) {
          e.n = 0; e.t = 0;
          this._entryPool.push(e);
          delete row[kind];
        } else live++;
      }
      if (live === 0) {
        this._map.delete(target);
        this._rowPool.push(row);
      }
    }
  }

  /** Drop every stack on one target — the kill/despawn hook. */
  clear(target) {
    const row = this._map.get(target);
    if (!row) return;
    for (const kind in row) {
      const e = row[kind];
      e.n = 0; e.t = 0;
      this._entryPool.push(e);
      delete row[kind];
    }
    this._map.delete(target);
    this._rowPool.push(row);
  }

  /** Full teardown (run end / path swap). The pools survive for reuse. */
  disposeAll() {
    for (const target of this._map.keys()) this.clear(target);
  }

  /** Live target count — the leak tripwire the test pins after disposeAll. */
  get size() { return this._map.size; }
}

// ---------------------------------------------------------------------------
// TINT — the sanctioned visual for stacks on a LIVING character
// ---------------------------------------------------------------------------

// Full-stack tint targets, one per stacking kind, drawn from the game's own
// biome/fx palette (config.js BIOMES accents) so a tinted enemy still sits in
// the scene: flame = emberfall's 0xff6b2b, frost = deepglass's 0x66e0ff,
// storm = the dash/nova 0x9dd8ff.
// Exported: THE canonical per-element palette. game.js's conjured arrows (and
// anything else needing an element's colour) read this instead of minting the
// two-home hardcodes this file's header forbids.
export const TINT_TARGETS = {
  pyre: 0xff6b2b,
  flame: 0xff6b2b,
  rime: 0x66e0ff,
  frost: 0x66e0ff,
  arc: 0x9dd8ff,
  storm: 0x9dd8ff,
};
const TINT_NEUTRAL = 0xffffff;

// Module scratch — tintForStacks is called per enemy per stack change, and
// returning a fresh Color each time is exactly the per-frame allocation the
// spec bans. Callers COPY the result into their material colour (which
// material.color.copy does anyway); nobody may hold the reference.
const _tint = new THREE.Color();
const _tintTarget = new THREE.Color();

/**
 * The material COLOUR for n stacks of `kind` — and colour is ALL it is.
 * White (multiplicative identity: material.color scales the map, so white is
 * "untouched") at 0 stacks, ramping toward the kind's hue, saturating at 10.
 * The 0.65 ceiling keeps the character readable AS a character — a fully
 * hue-crushed body reads as a different creature, not a status.
 *
 * NEVER an emissive, NEVER a rim: rim.js's own header records why living
 * characters do not glow in this game, and the enforcement here is that this
 * function returns a Color the consumer writes to material.color and there is
 * no other channel.
 */
export function tintForStacks(kind, n) {
  const target = TINT_TARGETS[kind] ?? TINT_NEUTRAL;
  const k = Math.min(1, Math.max(0, n / 10)) * 0.65;
  _tint.setHex(TINT_NEUTRAL);
  _tintTarget.setHex(target);
  return _tint.lerp(_tintTarget, k);
}

// ---------------------------------------------------------------------------
// VFX POOL
// ---------------------------------------------------------------------------

// Per-kind quad colour + default size, matching the tint targets above.
// STORM's slots are SEGMENTS, not quads (its vfxBudget: "one pooled
// InstancedMesh of thin box segments for the chains"): a unit box stretched
// along Z between two world points, oriented per slot rather than
// billboarded, drawn by the same one InstancedMesh.
const POOL_STYLES = {
  flame: { color: 0xff6b2b, size: 0.55 },
  frost: { color: 0x66e0ff, size: 0.45 },
  storm: { color: 0x9dd8ff, size: 0.35, segment: true, thickness: 0.07 },
};

const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scaleV = new THREE.Vector3();
const _posV = new THREE.Vector3();
// Segment scratch (spawnSegment only): the chain direction and its
// orientation. Module-lived like the four above — spawnSegment runs per arc
// link inside combat hooks, a no-allocation zone.
const _segDir = new THREE.Vector3();
const _segQuat = new THREE.Quaternion();
const _Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * The one archon VFX allocator: a single InstancedMesh of camera-facing quads
 * with a HARD instance cap, so a whole path's status VFX is ONE draw call and
 * one disposal surface. Only ONE pool is ever alive in a run — you have
 * exactly one archon path — which is how the +3-draw-call budget in
 * balanceAndMigration.performanceBudget holds.
 *
 * Slots are a ring: when every instance is live, spawn() reuses the OLDEST —
 * a hard cap by construction, never a growing array. Dead instances collapse
 * to scale 0 (a degenerate quad rasterises nothing), which is the same trick
 * the fx particle pools use, so count never changes and no per-spawn
 * geometry work happens.
 */
export class ArchonPool {
  constructor(scene, { kind = 'flame', maxInstances = 64 } = {}) {
    const style = POOL_STYLES[kind] || POOL_STYLES.flame;
    this.kind = kind;
    this.max = maxInstances;
    this.scene = scene;
    // Segment pools keep a per-slot orientation + length instead of
    // billboarding (a lightning chain that turned to face the camera would
    // visibly detach from its endpoints). Same slot ring, same one draw.
    this.segment = Boolean(style.segment);
    // MeshBasicMaterial ON PURPOSE: it has no emissive term at all, so this
    // pool CANNOT violate the no-glow rule whatever a future path config
    // passes in. Unlit + additive-free transparency, off no layers but 0.
    // FrontSide, and it is load-bearing twice over: the quads billboard to
    // the camera so back faces are never seen, AND three renders transparent
    // DoubleSide materials in TWO passes (back then front) — DoubleSide here
    // would silently double the pool's draw-call bill and break the
    // one-pool-one-call budget the test pins.
    this.material = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    // Unit-depth box for segments (scale.z carries the world length), the
    // shipped camera-facing quad otherwise.
    this.geometry = this.segment
      ? new THREE.BoxGeometry(style.thickness, style.thickness, 1)
      : new THREE.PlaneGeometry(style.size, style.size);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, maxInstances);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The quads drift around characters' heads and feet; a tight per-instance
    // sphere is not worth maintaining for 64 quads — skip culling like the
    // particle pools do.
    this.mesh.frustumCulled = false;
    // Per-slot state, allocated ONCE here, reused forever.
    this._life = new Float32Array(maxInstances);   // seconds remaining
    this._maxLife = new Float32Array(maxInstances);
    this._px = new Float32Array(maxInstances);
    this._py = new Float32Array(maxInstances);
    this._pz = new Float32Array(maxInstances);
    this._vy = new Float32Array(maxInstances);
    this._scale = new Float32Array(maxInstances);
    // Segment-only slot state: length along Z and the slot's own quaternion.
    // Allocated for every pool (256 floats — cheaper than a subclass) so
    // tick() stays one loop with one branch.
    this._len = new Float32Array(maxInstances);
    this._qx = new Float32Array(maxInstances);
    this._qy = new Float32Array(maxInstances);
    this._qz = new Float32Array(maxInstances);
    this._qw = new Float32Array(maxInstances);
    this._next = 0;                                // ring cursor
    // Everything starts dead: scale 0 rasterises nothing.
    _quat.identity();
    for (let i = 0; i < maxInstances; i++) {
      _mat4.compose(_posV.set(0, -999, 0), _quat, _scaleV.set(0, 0, 0));
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (scene) scene.add(this.mesh);
    this._disposed = false;
  }

  /**
   * Light one quad at pos. Reuses the oldest slot when full — the cap is the
   * cap. opts: life (s), scale, rise (u/s upward drift).
   */
  spawn(pos, { life = 0.6, scale = 1, rise = 0.8 } = {}) {
    const i = this._next;
    this._next = (this._next + 1) % this.max;
    this._life[i] = life;
    this._maxLife[i] = life;
    this._px[i] = pos.x;
    this._py[i] = pos.y;
    this._pz[i] = pos.z;
    this._vy[i] = rise;
    this._scale[i] = scale;
    // A bare spawn() on a segment pool is a unit stub with identity
    // orientation — kept working so the two pool flavours share one API.
    this._len[i] = 1;
    this._qx[i] = 0; this._qy[i] = 0; this._qz[i] = 0; this._qw[i] = 1;
    return i;
  }

  /**
   * Light one SEGMENT from a to b (segment pools; on a quad pool this is just
   * a spawn at the midpoint). The slot stores midpoint + orientation + length
   * so tick() can shrink the THICKNESS over the last 40% of life while the
   * endpoints stay pinned — a chain that visibly thins out rather than
   * receding from what it connects. Zero allocation: all math through the
   * module scratch.
   */
  spawnSegment(a, b, { life = 0.22, scale = 1 } = {}) {
    _segDir.copy(b).sub(a);
    const len = _segDir.length();
    _posV.copy(a).add(b).multiplyScalar(0.5);
    if (!this.segment || len < 1e-4) return this.spawn(_posV, { life, scale, rise: 0 });
    _segDir.divideScalar(len);
    _segQuat.setFromUnitVectors(_Z_AXIS, _segDir);
    const i = this.spawn(_posV, { life, scale, rise: 0 });
    this._len[i] = len;
    this._qx[i] = _segQuat.x; this._qy[i] = _segQuat.y;
    this._qz[i] = _segQuat.z; this._qw[i] = _segQuat.w;
    return i;
  }

  /**
   * Age every live quad and write matrices. `camera` (optional) billboards
   * the quads to face it — pass the game camera; without one they stay
   * axis-aligned, which the headless test uses. Zero allocation: all math
   * goes through the module scratch objects.
   */
  tick(dt, camera = null) {
    if (this._disposed) return;
    if (camera) _quat.copy(camera.quaternion);
    else _quat.identity();
    for (let i = 0; i < this.max; i++) {
      if (this._life[i] <= 0) continue;
      this._life[i] -= dt;
      if (this._life[i] <= 0) {
        _mat4.compose(_posV.set(0, -999, 0), _quat, _scaleV.set(0, 0, 0));
        this.mesh.setMatrixAt(i, _mat4);
        continue;
      }
      this._py[i] += this._vy[i] * dt;
      // Shrink-out over the last 40% of life — reads as burn-off/melt without
      // an opacity attribute (per-instance opacity would need a shader).
      const f = this._life[i] / this._maxLife[i];
      const s = this._scale[i] * (f < 0.4 ? f / 0.4 : 1);
      if (this.segment) {
        // Slot orientation, never the camera; the shrink hits thickness
        // only, so the segment thins in place with both endpoints pinned.
        _segQuat.set(this._qx[i], this._qy[i], this._qz[i], this._qw[i]);
        _mat4.compose(
          _posV.set(this._px[i], this._py[i], this._pz[i]),
          _segQuat,
          _scaleV.set(s, s, this._len[i]),
        );
      } else {
        _mat4.compose(
          _posV.set(this._px[i], this._py[i], this._pz[i]),
          _quat,
          _scaleV.set(s, s, s),
        );
      }
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Live instance count — test/HUD read, allocation-free. */
  get liveCount() {
    let n = 0;
    for (let i = 0; i < this.max; i++) if (this._life[i] > 0) n++;
    return n;
  }

  /**
   * THE one teardown verb. Removes the mesh and disposes geometry + material,
   * returning renderer.info.memory to its pre-build values (asserted in the
   * browser suite). Idempotent, because the run-end and the path-swap paths
   * can both reasonably call it.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.scene) this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    // InstancedMesh owns an instanceMatrix buffer attribute; dropping the
    // mesh reference is enough once geometry/material are disposed, but call
    // its own dispose for the instance buffers on newer three versions.
    this.mesh.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// RESOURCE METER
// ---------------------------------------------------------------------------

/**
 * One path's banked resource (Ember / Barrier / Charge), driven by the rules
 * object classes.js archonResourceRules(key) returns:
 *   { max, gainPer, decayPerSecond, ultimateCost }.
 *
 * gain(events) banks events x gainPer — the rules already speak in events
 * (+2 Ember PER stack consumed, +1 Charge PER metre, +0.4% Barrier PER Rime
 * applied), so the call sites pass counts and the rate lives in one place.
 * tick(dt, decaying) applies decay only when the path's own condition says so
 * (Ember decays OUT OF COMBAT, Charge decays WHILE STATIONARY) — the meter
 * cannot know combat state, so the boolean is the caller's job.
 *
 * A path with max 0 (SHADOW, BEAST — their "resource" is a cooldown) yields
 * an inert meter: gain clamps to 0, ready is false, and the HUD shows no bar.
 */
export class ResourceMeter {
  constructor(rules = {}) {
    this.rules = rules;
    this._value = 0;
  }

  get value() { return this._value; }
  get max() { return this.rules.max || 0; }

  /** value >= ultimateCost, for paths whose ultimate spends the meter. */
  get ready() {
    const cost = this.rules.ultimateCost || 0;
    return cost > 0 && this._value >= cost;
  }

  gain(events = 1) {
    const per = this.rules.gainPer || 0;
    this._value = Math.min(this.max, this._value + events * per);
    return this._value;
  }

  /**
   * The persistence seam (STEP 9): save.archonState.resource carries the bank
   * across gate entries, and _beginGate re-arms a meter FROM the save rather
   * than from zero — a full Ember bar must survive walking out to repair.
   * Clamped into [0, max] like every save-fed number, so a hand-edited save
   * cannot overfill the meter.
   */
  set(v) {
    const n = Number(v);
    this._value = Number.isFinite(n) ? Math.max(0, Math.min(this.max, n)) : 0;
    return this._value;
  }

  /** Spend a raw amount (the ultimate passes its own cost). Clamps at 0. */
  spend(amount) {
    this._value = Math.max(0, this._value - Math.max(0, amount));
    return this._value;
  }

  /** Spend the ultimate's full cost if banked. Returns whether it fired. */
  fireUltimate() {
    if (!this.ready) return false;
    this.spend(this.rules.ultimateCost);
    return true;
  }

  tick(dt, decaying = true) {
    if (decaying && (this.rules.decayPerSecond || 0) > 0) {
      this._value = Math.max(0, this._value - this.rules.decayPerSecond * dt);
    }
    return this._value;
  }

  reset() { this._value = 0; }
}
