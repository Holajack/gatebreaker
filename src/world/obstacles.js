// Shared solid-world registry.
//
// WHY THIS EXISTS
// The owner played the shipped build and said "I can walk through a lot of the
// rocks and stuff that's in there." He is right, and it is not a bug in one
// file: today the ONLY solids in the game are (a) the arena's 10-18 pillars,
// which World.resolve scans linearly, and (b) the arena boundary. The 60
// scatter rocks in world.js are explicitly commented "pure decoration, no
// collision"; the biome props are the same; the city is almost entirely props
// and buildings, so in the hub the problem is total.
//
// The fix cannot be "add another loop to World.resolve", because four different
// builders (arena, biome kits, city, overworld) populate solids in four shapes,
// and three different consumers need them:
//
//   1. CharacterBody (player)     -> push out + SLIDE, must not tunnel
//   2. game.js enemy / shadow     -> the same push-out through world.resolve
//   3. NavGrid                    -> blocked cells, so the AI stops pathing
//                                    into the same rock the player bounces off
//
// If those three disagree the game feels broken in a way that is very hard to
// debug: an enemy paths into a rock the player cannot enter and jitters there
// forever. So there is one registry, and all three read it.
//
// DESIGN
// * Convex proxies only — circles and rotated boxes. No per-triangle collision.
//   A rock is a circle, a building is a box. At play distance nobody can tell,
//   and it is the difference between 3 us and 3 ms per frame on a phone.
// * Uniform-grid broadphase. A city has several hundred solids; a linear scan
//   per entity per physics substep is the classic "fine on desktop, 4 ms on a
//   phone" trap. Lookup is the 1-4 cells the entity's disc actually overlaps.
// * NO `import * as THREE`. tools/collision-test.mjs and tools/nav-test.mjs
//   import this in plain Node. Positions are read as {x, y, z} duck types, so a
//   THREE.Vector3 works without this module knowing what one is.
// * `top` gating: every obstacle has a height. Kerb-height rubble is stepped
//   over rather than walked into, and anything you can jump above stops being
//   solid while you are above it. Default is Infinity — a wall is a wall.
//
// DEGRADATION IS A HARD REQUIREMENT
// An empty field resolves to a no-op and physics.js skips its whole substep
// path, so a level that registers nothing behaves exactly as it does today,
// instruction for instruction.

const KIND_CIRCLE = 0;
const KIND_BOX = 1;

// Broadphase cell key. i and j are cell indices, masked to 16 bits: two cells
// 65,536 apart alias into one bucket, which is 500 km at the default cell size
// and would only ever cost a redundant narrowphase test, never a wrong answer.
function cellKey(i, j) {
  return (((i & 0xffff) << 16) | (j & 0xffff)) | 0;
}

export const OBSTACLE_DEFAULTS = {
  // 8 m buckets: big enough that a 30 m building stamps ~16 cells instead of
  // 900, small enough that a bucket holds a handful of props in a dense street.
  cell: 8,
  // Baseline "you can step over this" height, used when a caller does not pass
  // one. 0 means every registered solid blocks, which is the safe default for
  // callers like World.resolve that know nothing about the body's stepHeight.
  stepOver: 0,
  // A head-on hit has no tangent to slide along, so the body would stick to the
  // rock instead of going round it. This is how hard we nudge sideways; it is a
  // FIXED handedness so the nudge cannot flip sign between frames and buzz.
  slideNudge: 0.6,
};

export class ObstacleField {
  /**
   * @param {object} [opts]
   * @param {number} [opts.cell=8]      broadphase bucket size, world units
   * @param {number} [opts.stepOver=0]  default step-over height for resolve()
   */
  constructor(opts = {}) {
    const cell = opts.cell ?? OBSTACLE_DEFAULTS.cell;
    this.cell = cell > 0 ? cell : OBSTACLE_DEFAULTS.cell;
    this.stepOver = opts.stepOver ?? OBSTACLE_DEFAULTS.stepOver;
    this.slideNudge = opts.slideNudge ?? OBSTACLE_DEFAULTS.slideNudge;

    // Structure-of-arrays. Authoring pushes onto plain arrays; build() packs
    // them into typed arrays so the narrowphase reads contiguous memory.
    this._kind = [];
    this._x = [];
    this._z = [];
    this._a = [];        // circle: radius        box: half-width
    this._b = [];        // circle: radius (dup)  box: half-depth
    this._rot = [];
    this._top = [];
    this._nav = [];
    this._tags = [];

    this.count = 0;
    /** Smallest half-extent in the field — physics uses it to size substeps. */
    this.minExtent = Infinity;
    /** Bumped by build(); consumers can invalidate caches off it. */
    this.generation = 0;

    this._packed = null;
    this._cells = null;
    this._visit = null;
    this._stamp = 0;
    this._dirty = true;
    this._queryOut = [];

    // Contact report from the last resolve() call. physics.js reads this to
    // steer held input ALONG a wall instead of into it — without it, holding
    // "forward" against a building bleeds the slide off to friction in about a
    // third of a second and the character stalls flat against the wall, which
    // is precisely the "stopping dead feels broken" failure.
    this.contacts = 0;
    this.contactNX = 0;
    this.contactNZ = 0;
  }

  /** True when there is nothing to collide with — the degradation signal. */
  get empty() { return this.count === 0; }

  clear() {
    this._kind.length = 0;
    this._x.length = 0;
    this._z.length = 0;
    this._a.length = 0;
    this._b.length = 0;
    this._rot.length = 0;
    this._top.length = 0;
    this._nav.length = 0;
    this._tags.length = 0;
    this.count = 0;
    this.minExtent = Infinity;
    this._packed = null;
    this._cells = null;
    this._visit = null;
    this._dirty = true;
    this.generation++;
    return this;
  }

  // ------------------------------------------------------------- authoring

  /**
   * A round solid: rock, pillar, tree trunk, lamp post, barrel.
   * @param {number} x
   * @param {number} z
   * @param {number} radius
   * @param {object} [opts]
   * @param {number} [opts.top=Infinity] world Y of the top surface. Anything at
   *   or below `feetY + stepOver` is walked over instead of into.
   * @param {boolean} [opts.nav=true] also block navgrid cells
   * @param {string}  [opts.tag] debug label, e.g. 'rock' / 'building'
   * @returns {ObstacleField} this, so a builder can chain
   */
  addCircle(x, z, radius, opts = null) {
    if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return this;
    this._kind.push(KIND_CIRCLE);
    this._x.push(x);
    this._z.push(z);
    this._a.push(radius);
    this._b.push(radius);
    this._rot.push(0);
    this._top.push(opts && Number.isFinite(opts.top) ? opts.top : Infinity);
    this._nav.push(opts && opts.nav === false ? 0 : 1);
    this._tags.push((opts && opts.tag) || '');
    this.count++;
    if (radius < this.minExtent) this.minExtent = radius;
    this._dirty = true;
    return this;
  }

  /**
   * A rectangular solid: a building, a wall segment, a market stall. Boxes
   * matter — approximating a 4 x 20 m terrace with a circle either seals the
   * street beside it or leaks through the middle of it.
   * @param {number} rot radians about +Y
   */
  addBox(x, z, w, d, rot = 0, opts = null) {
    if (!(w > 0) || !(d > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return this;
    this._kind.push(KIND_BOX);
    this._x.push(x);
    this._z.push(z);
    this._a.push(w / 2);
    this._b.push(d / 2);
    this._rot.push(Number.isFinite(rot) ? rot : 0);
    this._top.push(opts && Number.isFinite(opts.top) ? opts.top : Infinity);
    this._nav.push(opts && opts.nav === false ? 0 : 1);
    this._tags.push((opts && opts.tag) || '');
    this.count++;
    const m = Math.min(w, d) / 2;
    if (m < this.minExtent) this.minExtent = m;
    this._dirty = true;
    return this;
  }

  /**
   * Bulk-add whatever a world builder already has. Every builder in this repo
   * hands out one of these shapes, and none of them are going to be rewritten
   * to match each other:
   *
   *   World.obstacles        [{ pos: Vector3, radius }]
   *   City.obstacles         [{ pos: {x,z}, radius }]
   *   City.boxes / citykit   [{ x, z, w, d, rot }]
   *   BiomeLayout            { obstacles: [...], boxes: [...] }
   *
   * so this takes any of them, plus `{ circles }` and bare `{x,z,radius}`.
   * @param {object|Array} source
   * @param {object} [opts] applied to every added record (top / nav / tag)
   */
  addAll(source, opts = null) {
    if (!source) return this;
    if (Array.isArray(source)) {
      for (const item of source) this._addAny(item, opts);
      return this;
    }
    if (Array.isArray(source.obstacles)) for (const o of source.obstacles) this._addAny(o, opts);
    if (Array.isArray(source.circles)) for (const o of source.circles) this._addAny(o, opts);
    if (Array.isArray(source.boxes)) for (const b of source.boxes) this._addAny(b, opts);
    // A lone record, not a container.
    if (!source.obstacles && !source.circles && !source.boxes) this._addAny(source, opts);
    return this;
  }

  _addAny(item, opts) {
    if (!item) return;
    const p = item.pos || item;
    const r = item.radius ?? item.r;
    if (r != null && r > 0) {
      this.addCircle(p.x, p.z, r, this._recordOpts(item, opts));
      return;
    }
    const w = item.w ?? item.width;
    const d = item.d ?? item.depth;
    if (w > 0 && d > 0) {
      this.addBox(p.x ?? item.x, p.z ?? item.z, w, d, item.rot ?? item.rotation ?? 0,
        this._recordOpts(item, opts));
    }
  }

  _recordOpts(item, opts) {
    // Per-record top/nav/tag win over the bulk defaults: a builder that already
    // knows a given prop is knee-high should not have to split its array.
    if (item.top == null && item.height == null && item.nav == null && item.tag == null) return opts;
    const out = opts ? { ...opts } : {};
    if (item.top != null) out.top = item.top;
    else if (item.height != null) out.top = item.height;
    if (item.nav != null) out.nav = item.nav;
    if (item.tag != null) out.tag = item.tag;
    return out;
  }

  /**
   * Pack the broadphase. Optional — resolve() rebuilds lazily if you forget —
   * but calling it once at the end of a world build keeps the cost off the
   * first frame, where it would show up as a hitch on entry.
   */
  build() {
    if (!this._dirty) return this;
    const n = this.count;
    const p = {
      kind: new Uint8Array(n),
      x: new Float64Array(n),
      z: new Float64Array(n),
      a: new Float64Array(n),
      b: new Float64Array(n),
      cos: new Float64Array(n),
      sin: new Float64Array(n),
      rot: new Float64Array(n),
      top: new Float64Array(n),
      nav: new Uint8Array(n),
      ex: new Float64Array(n),   // world-aligned half-extent, X
      ez: new Float64Array(n),   // world-aligned half-extent, Z
    };
    for (let i = 0; i < n; i++) {
      const kind = this._kind[i];
      p.kind[i] = kind;
      p.x[i] = this._x[i];
      p.z[i] = this._z[i];
      p.a[i] = this._a[i];
      p.b[i] = this._b[i];
      p.top[i] = this._top[i];
      p.nav[i] = this._nav[i];
      const rot = this._rot[i];
      p.rot[i] = rot;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      p.cos[i] = c;
      p.sin[i] = s;
      if (kind === KIND_CIRCLE) {
        p.ex[i] = this._a[i];
        p.ez[i] = this._a[i];
      } else {
        p.ex[i] = Math.abs(this._a[i] * c) + Math.abs(this._b[i] * s);
        p.ez[i] = Math.abs(this._a[i] * s) + Math.abs(this._b[i] * c);
      }
    }
    this._packed = p;

    const cell = this.cell;
    const scratch = new Map();
    for (let i = 0; i < n; i++) {
      const i0 = Math.floor((p.x[i] - p.ex[i]) / cell);
      const i1 = Math.floor((p.x[i] + p.ex[i]) / cell);
      const j0 = Math.floor((p.z[i] - p.ez[i]) / cell);
      const j1 = Math.floor((p.z[i] + p.ez[i]) / cell);
      for (let j = j0; j <= j1; j++) {
        for (let ci = i0; ci <= i1; ci++) {
          const k = cellKey(ci, j);
          let arr = scratch.get(k);
          if (!arr) { arr = []; scratch.set(k, arr); }
          arr.push(i);
        }
      }
    }
    const cells = new Map();
    for (const [k, arr] of scratch) cells.set(k, Int32Array.from(arr));
    this._cells = cells;
    this._visit = new Int32Array(n);
    this._stamp = 0;
    this._dirty = false;
    this.generation++;
    return this;
  }

  /**
   * O(1) height mutation for an existing record — how dungeon door membranes
   * toggle solid <-> open without a remove API: sealed = Infinity, open = 0
   * (a top at 0 is at-or-below every skip height, so resolve()/blocked()
   * ignore the record entirely). The broadphase does NOT rebuild: a record's
   * bucket stamp depends only on its footprint, which setTop never changes.
   *
   * There is deliberately NO index return from addCircle/addBox (they chain —
   * collision-test builds fields as .addCircle(...).build() everywhere): the
   * caller reads `field.count - 1` right after the add, which IS the new
   * record's index because count increments per add and nothing removes.
   *
   * @param {number} index record index (field.count - 1 at add time)
   * @param {number} top   new world-Y top surface
   * @returns {ObstacleField} this
   */
  setTop(index, top) {
    if (index < 0 || index >= this.count || !(Number.isFinite(top) || top === Infinity)) return this;
    this._top[index] = top;
    if (this._packed) this._packed.top[index] = top;
    return this;
  }

  // ------------------------------------------------------------ narrowphase

  /**
   * Push `pos` out of every solid it overlaps, and deflect `vel` along the
   * surface so the body SLIDES instead of stopping dead. Signature-compatible
   * with World.resolve / City.resolve / Overworld.resolve, so it can be dropped
   * in as the physics `resolve` callback directly.
   *
   * @param {{x:number,y:number,z:number}} pos mutated in place
   * @param {number} radius body radius
   * @param {{x:number,z:number}|null} vel mutated in place when given. Without
   *   it the body is pushed out but keeps driving into the wall, which reads as
   *   snagging — always pass it for anything the player controls.
   * @param {number} [stepOver] obstacles whose top is at or below
   *   `pos.y + stepOver` are ignored, i.e. stepped over. Defaults to the
   *   field's own stepOver so callers that know nothing about the body still
   *   get consistent behaviour.
   * @returns {boolean} true if anything was touched
   */
  resolve(pos, radius, vel = null, stepOver = this.stepOver) {
    this.contacts = 0;
    this.contactNX = 0;
    this.contactNZ = 0;
    if (this.count === 0) return false;      // exact no-op: today's behaviour
    if (this._dirty) this.build();
    const p = this._packed;
    const cell = this.cell;
    const feet = Number.isFinite(pos.y) ? pos.y : 0;
    const skip = feet + (stepOver > 0 ? stepOver : 0);

    // The disc, not the point: an obstacle in the next bucket over can still be
    // overlapping us. 1-4 buckets for any sane radius and cell size.
    const i0 = Math.floor((pos.x - radius) / cell);
    const i1 = Math.floor((pos.x + radius) / cell);
    const j0 = Math.floor((pos.z - radius) / cell);
    const j1 = Math.floor((pos.z + radius) / cell);
    const stamp = ++this._stamp;
    const visit = this._visit;
    let hit = false;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const bucket = this._cells.get(cellKey(i, j));
        if (bucket === undefined) continue;
        for (let b = 0; b < bucket.length; b++) {
          const idx = bucket[b];
          if (visit[idx] === stamp) continue;   // shared by two buckets
          visit[idx] = stamp;
          if (p.top[idx] <= skip) continue;     // kerb height: step over it
          if (p.kind[idx] === KIND_CIRCLE) {
            if (this._resolveCircle(idx, pos, radius, vel)) hit = true;
          } else if (this._resolveBox(idx, pos, radius, vel)) hit = true;
        }
      }
    }
    return hit;
  }

  _resolveCircle(idx, pos, radius, vel) {
    const p = this._packed;
    const dx = pos.x - p.x[idx];
    const dz = pos.z - p.z[idx];
    const min = p.a[idx] + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return false;
    let nx, nz;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      nx = dx / d;
      nz = dz / d;
    } else {
      // Dead centre. No meaningful push direction exists, so pick a fixed one;
      // otherwise anything that spawns on a rock's origin is stuck forever.
      nx = 1; nz = 0;
    }
    pos.x = p.x[idx] + nx * min;
    pos.z = p.z[idx] + nz * min;
    this._note(nx, nz);
    this._slide(vel, nx, nz);
    return true;
  }

  _resolveBox(idx, pos, radius, vel) {
    const p = this._packed;
    const c = p.cos[idx];
    const s = p.sin[idx];
    const rx = pos.x - p.x[idx];
    const rz = pos.z - p.z[idx];
    // Into the box's own frame (rotate by -rot).
    const lx = rx * c + rz * s;
    const lz = -rx * s + rz * c;
    const hx = p.a[idx] + radius;
    const hz = p.b[idx] + radius;
    if (lx <= -hx || lx >= hx || lz <= -hz || lz >= hz) return false;

    // Least-penetration axis. Pushing out along the deep axis would fling
    // someone who brushed a corner clean through the building.
    const px = hx - Math.abs(lx);
    const pz = hz - Math.abs(lz);
    let nlx, nlz;
    if (px <= pz) {
      nlx = lx < 0 ? -1 : 1;
      nlz = 0;
      const tx = nlx * hx;
      pos.x = p.x[idx] + tx * c - lz * s;
      pos.z = p.z[idx] + tx * s + lz * c;
    } else {
      nlx = 0;
      nlz = lz < 0 ? -1 : 1;
      const tz = nlz * hz;
      pos.x = p.x[idx] + lx * c - tz * s;
      pos.z = p.z[idx] + lx * s + tz * c;
    }
    // Normal back into world space.
    const nx = nlx * c - nlz * s;
    const nz = nlx * s + nlz * c;
    this._note(nx, nz);
    this._slide(vel, nx, nz);
    return true;
  }

  /** Average the frame's contact normals; two walls at a corner average sanely. */
  _note(nx, nz) {
    this.contacts++;
    this.contactNX += nx;
    this.contactNZ += nz;
  }

  _slide(vel, nx, nz) {
    if (!vel) return;
    const into = vel.x * nx + vel.z * nz;
    if (into >= 0) return;
    // Strip only the component driving into the surface; the tangent survives,
    // which IS the slide.
    vel.x -= nx * into;
    vel.z -= nz * into;
    const tangent = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const push = -into;
    if (tangent < push * 0.2) {
      // Perfectly head-on: there is no tangent left to slide along, so the body
      // would sit against the rock grinding. Nudge it round, always the same
      // way round so the nudge cannot alternate and vibrate.
      vel.x += -nz * push * this.slideNudge;
      vel.z += nx * push * this.slideNudge;
    }
  }

  // ------------------------------------------------------------------ query

  /** True if a disc of `radius` at (x, z) overlaps anything solid. */
  blocked(x, z, radius = 0, stepOver = this.stepOver, feetY = 0) {
    if (this.count === 0) return false;
    if (this._dirty) this.build();
    const p = this._packed;
    const cell = this.cell;
    const skip = feetY + (stepOver > 0 ? stepOver : 0);
    const i0 = Math.floor((x - radius) / cell);
    const i1 = Math.floor((x + radius) / cell);
    const j0 = Math.floor((z - radius) / cell);
    const j1 = Math.floor((z + radius) / cell);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const bucket = this._cells.get(cellKey(i, j));
        if (bucket === undefined) continue;
        for (let b = 0; b < bucket.length; b++) {
          const idx = bucket[b];
          if (p.top[idx] <= skip) continue;
          if (p.kind[idx] === KIND_CIRCLE) {
            const dx = x - p.x[idx];
            const dz = z - p.z[idx];
            const min = p.a[idx] + radius;
            if (dx * dx + dz * dz < min * min) return true;
          } else {
            const c = p.cos[idx];
            const s = p.sin[idx];
            const rx = x - p.x[idx];
            const rz = z - p.z[idx];
            const lx = rx * c + rz * s;
            const lz = -rx * s + rz * c;
            if (Math.abs(lx) < p.a[idx] + radius && Math.abs(lz) < p.b[idx] + radius) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * True if the straight segment (x0,z0)->(x1,z1) crosses anything solid at
   * `feetY` — the caster line-of-sight probe (game.js EDIT 5) and any future
   * AI peek. Implemented as sampled blocked() calls every `step` metres
   * (endpoints included), so a wall thinner than `step` could in principle
   * slip between samples — the dungeon's 0.6 m walls cannot, because the
   * 0.2 m probe radius closes the gap (1.2 m step needs only >= 1.0 m of
   * combined wall+2r, and 0.6 + 0.4 = 1.0). Cost is ~len/step broadphase
   * lookups; callers throttle (the AI probes on a 0.4 s cadence), never
   * per-frame across the whole field.
   *
   * The internal sample spacing is capped at (2*radius + 0.5) even when
   * `step` is larger: successive probe discs cover 2*radius + wallDepth of
   * the crossing axis, so at the default step 1.2 a 0.6 m dungeon wall hit
   * near-perpendicular could land exactly between two samples and leak a
   * caster shot through the wall. The 0.5 constant is the 0.6 m wall-run
   * thickness minus a 0.1 m phase-alignment margin.
   *
   * stepOver is passed as 0 so `feetY` alone decides what the line clears:
   * a projectile at 1.2 m sails over kerb-height crates (top 0.4), while
   * walls (top Infinity) always block.
   *
   * @param {number} x0 @param {number} z0 segment start
   * @param {number} x1 @param {number} z1 segment end
   * @param {object} [opts]
   * @param {number} [opts.step=1.2]   requested sample spacing, metres
   * @param {number} [opts.radius=0.2] probe disc radius
   * @param {number} [opts.feetY=1.2]  height the line travels at
   * @returns {boolean}
   */
  lineBlocked(x0, z0, x1, z1, { step = 1.2, radius = 0.2, feetY = 1.2 } = {}) {
    if (this.count === 0) return false;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const s = Math.max(0.05, Math.min(step > 0 ? step : 1.2, radius * 2 + 0.5));
    const n = Math.max(1, Math.ceil(len / s));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (this.blocked(x0 + dx * t, z0 + dz * t, radius, 0, feetY)) return true;
    }
    return false;
  }

  /** Indices of everything whose bucket the query disc touches. Debug / tests. */
  queryNear(x, z, radius = 0, out = this._queryOut) {
    out.length = 0;
    if (this.count === 0) return out;
    if (this._dirty) this.build();
    const cell = this.cell;
    const i0 = Math.floor((x - radius) / cell);
    const i1 = Math.floor((x + radius) / cell);
    const j0 = Math.floor((z - radius) / cell);
    const j1 = Math.floor((z + radius) / cell);
    const stamp = ++this._stamp;
    const visit = this._visit;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const bucket = this._cells.get(cellKey(i, j));
        if (bucket === undefined) continue;
        for (let b = 0; b < bucket.length; b++) {
          const idx = bucket[b];
          if (visit[idx] === stamp) continue;
          visit[idx] = stamp;
          out.push(idx);
        }
      }
    }
    return out;
  }

  /** Read one record back out, for tests and debug draw. */
  get(i) {
    if (i < 0 || i >= this.count) return null;
    const kind = this._kind[i] === KIND_CIRCLE ? 'circle' : 'box';
    return {
      kind,
      x: this._x[i],
      z: this._z[i],
      radius: this._kind[i] === KIND_CIRCLE ? this._a[i] : 0,
      w: this._kind[i] === KIND_BOX ? this._a[i] * 2 : 0,
      d: this._kind[i] === KIND_BOX ? this._b[i] * 2 : 0,
      rot: this._rot[i],
      top: this._top[i],
      nav: this._nav[i] === 1,
      tag: this._tags[i],
    };
  }

  // -------------------------------------------------------------------- nav

  /**
   * Stamp this field onto a NavGrid so the flow field routes enemies around
   * exactly the solids the player collides with. Duck-typed on purpose:
   * src/world/navgrid.js is not imported here, so this module stays
   * dependency-free and Node-importable.
   *
   * @param {object} grid anything with blockCircle / blockBox
   * @param {object} [opts]
   * @param {boolean} [opts.clear=false] grid.clear() first
   * @param {boolean} [opts.bake=false]  grid.bake() after — do this LAST, after
   *   any blockOutside() the caller also wants, since bake() freezes the mask
   * @returns {object} the grid
   */
  applyToNavGrid(grid, { clear = false, bake = false } = {}) {
    if (!grid) return grid;
    if (clear) grid.clear?.();
    for (let i = 0; i < this.count; i++) {
      if (this._nav[i] !== 1) continue;
      if (this._kind[i] === KIND_CIRCLE) {
        grid.blockCircle?.(this._x[i], this._z[i], this._a[i]);
      } else {
        grid.blockBox?.(this._x[i], this._z[i], this._a[i] * 2, this._b[i] * 2, this._rot[i]);
      }
    }
    if (bake) grid.bake?.();
    return grid;
  }

  /**
   * The same content in the exact shape navgrid.js's buildNavGrid() takes, for
   * callers that would rather construct the grid than stamp one:
   *   buildNavGrid({ ...field.toNavBlockers(), size, cell, pad, inside })
   */
  toNavBlockers() {
    const obstacles = [];
    const boxes = [];
    for (let i = 0; i < this.count; i++) {
      if (this._nav[i] !== 1) continue;
      if (this._kind[i] === KIND_CIRCLE) {
        obstacles.push({ pos: { x: this._x[i], z: this._z[i] }, radius: this._a[i] });
      } else {
        boxes.push({
          x: this._x[i], z: this._z[i],
          w: this._a[i] * 2, d: this._b[i] * 2, rot: this._rot[i],
        });
      }
    }
    return { obstacles, boxes };
  }

  // ------------------------------------------------------------------ stats

  stats() {
    if (this._dirty) this.build();
    let circles = 0;
    let boxes = 0;
    for (let i = 0; i < this.count; i++) {
      if (this._kind[i] === KIND_CIRCLE) circles++; else boxes++;
    }
    let maxBucket = 0;
    let stamped = 0;
    const buckets = this._cells ? this._cells.size : 0;
    if (this._cells) {
      for (const arr of this._cells.values()) {
        stamped += arr.length;
        if (arr.length > maxBucket) maxBucket = arr.length;
      }
    }
    return {
      count: this.count,
      circles,
      boxes,
      cell: this.cell,
      buckets,
      avgBucket: buckets ? stamped / buckets : 0,
      maxBucket,
      minExtent: this.minExtent,
      generation: this.generation,
    };
  }
}

/**
 * A permanently empty field. Handy as a default so call sites never branch on
 * null, and cheap: every method short-circuits on count === 0.
 */
export const EMPTY_FIELD = new ObstacleField();

/** Build a field straight from whatever a world builder already produced. */
export function obstacleField(source = null, opts = {}) {
  const f = new ObstacleField(opts);
  if (source) f.addAll(source);
  return f.build();
}

export default ObstacleField;
