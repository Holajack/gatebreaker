// Flow-field navigation over a uniform grid.
//
// WHY THIS EXISTS
// The enemy AI steers straight at the player. That is correct in a convex disc
// and catastrophic anywhere else: put a pillar between an enemy and its target
// and the enemy presses into the pillar forever. The arena already reproduces
// this — a level-1 run can deadlock with the player pinned on one side of a
// 1.27 m pillar and a brute pinned on the other, frozen at distance 3.44 for
// thousands of frames. Concave city geometry makes it the normal case.
//
// DESIGN NOTES
// * NO `import * as THREE` at module scope. tools/nav-test.mjs and the headless
//   progression tests import this file in plain Node, where three is not
//   loadable. debugMesh() takes a THREE namespace (constructor option or
//   argument) instead.
// * Everything is typed arrays. A 460 m world at cell 2 is 230x230 = 52,900
//   cells; the Dijkstra below is a couple of milliseconds on a mid-range phone.
//   That is fine at the 4 Hz the caller is required to throttle setGoal() to,
//   and fatal every frame.
// * flowAt() returns FALSE rather than guessing whenever the sample is off the
//   grid, unreachable, or within a cell of the goal. The caller then falls back
//   to its existing straight-line steering. That is what lets this module drop
//   into the current disc arena without changing a single frame of behaviour:
//   no grid means no flow means today's code path.
//
// COORDINATES
// `originX` / `originZ` are the CENTRE of the square grid in world space, and
// `size` is its full width, so a grid built as { originX: 0, originZ: 0,
// size: 92 } covers -46..+46 on both axes.

// Integer edge weights: 10 orthogonal, 14 diagonal (the usual 10/14 rounding of
// 1 : sqrt2). Integers let the search use a bucket queue instead of a heap.
const W_ORTHO = 10;
const W_DIAG = 14;
const BUCKETS = W_DIAG + 1;
const INF = 0xffffffff;

// 8-neighbour offsets, orthogonals first so ties resolve to a straight step.
const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NZ = [0, 0, 1, -1, 1, -1, 1, -1];
const NW = [W_ORTHO, W_ORTHO, W_ORTHO, W_ORTHO, W_DIAG, W_DIAG, W_DIAG, W_DIAG];

export class NavGrid {
  /**
   * @param {object}  opts
   * @param {number}  opts.originX  world X of the grid centre
   * @param {number}  opts.originZ  world Z of the grid centre
   * @param {number}  opts.size     full width of the square grid, world units
   * @param {number} [opts.cell=2]  cell size, world units
   * @param {number} [opts.pad=0]   extra radius added to every blocker, so
   *                                agents of that radius never path into a wall
   * @param {object} [opts.THREE]   three namespace, only needed by debugMesh()
   */
  constructor({ originX = 0, originZ = 0, size = 92, cell = 2, pad = 0, THREE = null } = {}) {
    this.cell = cell > 0 ? cell : 2;
    this.pad = Math.max(0, pad);
    this.size = size;
    this.originX = originX;
    this.originZ = originZ;
    this.minX = originX - size / 2;
    this.minZ = originZ - size / 2;
    this.w = Math.max(1, Math.ceil(size / this.cell));
    this.h = this.w;
    this.maxX = this.minX + this.w * this.cell;
    this.maxZ = this.minZ + this.h * this.cell;

    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    this.cost = new Uint32Array(n);
    this.cost.fill(INF);

    this._THREE = THREE;
    this._generation = 0;
    this._baked = false;
    this._hasGoal = false;
    this._goalIndex = -1;
    this._goalX = 0;
    this._goalZ = 0;
    this._openCount = n;

    // Reused bucket queue. Plain arrays of ints; cleared, never reallocated.
    this._buckets = [];
    for (let i = 0; i < BUCKETS; i++) this._buckets.push([]);
  }

  get generation() { return this._generation; }
  get width() { return this.w; }
  get height() { return this.h; }
  /** True once bake() has run and at least one cell is walkable. */
  get baked() { return this._baked; }

  // ------------------------------------------------------------- authoring

  clear() {
    this.blocked.fill(0);
    this.cost.fill(INF);
    this._baked = false;
    this._hasGoal = false;
    this._goalIndex = -1;
    this._openCount = this.w * this.h;
    return this;
  }

  /** Mark every cell the circle touches (conservative: cell AABB vs circle). */
  blockCircle(x, z, radius) {
    const r = radius + this.pad;
    if (!(r > 0)) return this;
    const i0 = this._clampI(Math.floor((x - r - this.minX) / this.cell));
    const i1 = this._clampI(Math.floor((x + r - this.minX) / this.cell));
    const j0 = this._clampJ(Math.floor((z - r - this.minZ) / this.cell));
    const j1 = this._clampJ(Math.floor((z + r - this.minZ) / this.cell));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const cz0 = this.minZ + j * this.cell;
      const cz1 = cz0 + this.cell;
      const qz = z < cz0 ? cz0 : (z > cz1 ? cz1 : z);
      const dz = z - qz;
      for (let i = i0; i <= i1; i++) {
        const cx0 = this.minX + i * this.cell;
        const cx1 = cx0 + this.cell;
        const qx = x < cx0 ? cx0 : (x > cx1 ? cx1 : x);
        const dx = x - qx;
        if (dx * dx + dz * dz <= r2) this.blocked[j * this.w + i] = 1;
      }
    }
    this._baked = false;
    return this;
  }

  /**
   * Mark a rotated rectangle. Buildings are boxes; approximating a 30 m block
   * with a circle would make the streets either impassable or leaky.
   * @param {number} rot radians about +Y
   */
  blockBox(x, z, w, d, rot = 0) {
    const hw = Math.abs(w) / 2 + this.pad;
    const hd = Math.abs(d) / 2 + this.pad;
    const c = Math.cos(-rot);
    const s = Math.sin(-rot);
    // Conservative half-extent bump so a cell straddling the edge still blocks.
    const slack = this.cell * 0.7072;
    const ehw = hw + slack;
    const ehd = hd + slack;
    const reach = Math.hypot(hw, hd) + this.cell;
    const i0 = this._clampI(Math.floor((x - reach - this.minX) / this.cell));
    const i1 = this._clampI(Math.floor((x + reach - this.minX) / this.cell));
    const j0 = this._clampJ(Math.floor((z - reach - this.minZ) / this.cell));
    const j1 = this._clampJ(Math.floor((z + reach - this.minZ) / this.cell));
    for (let j = j0; j <= j1; j++) {
      const pz = this.minZ + (j + 0.5) * this.cell - z;
      for (let i = i0; i <= i1; i++) {
        const px = this.minX + (i + 0.5) * this.cell - x;
        const lx = px * c - pz * s;
        const lz = px * s + pz * c;
        if (lx >= -ehw && lx <= ehw && lz >= -ehd && lz <= ehd) {
          this.blocked[j * this.w + i] = 1;
        }
      }
    }
    this._baked = false;
    return this;
  }

  /**
   * Block everything the predicate rejects. `predicate(worldX, worldZ)` returns
   * true for cells INSIDE the playable region; everything else is walled off.
   * This is how a disc arena, a rect corridor or a ring boundary all become the
   * same thing to the search.
   */
  blockOutside(predicate) {
    for (let j = 0; j < this.h; j++) {
      const z = this.minZ + (j + 0.5) * this.cell;
      const row = j * this.w;
      for (let i = 0; i < this.w; i++) {
        const x = this.minX + (i + 0.5) * this.cell;
        if (!predicate(x, z)) this.blocked[row + i] = 1;
      }
    }
    this._baked = false;
    return this;
  }

  /**
   * Freeze the obstacle mask. Invalidates any goal and bumps `generation` so
   * consumers can drop cached paths.
   */
  bake() {
    let open = 0;
    for (let i = 0; i < this.blocked.length; i++) if (!this.blocked[i]) open++;
    this._openCount = open;
    this._baked = open > 0;
    this._hasGoal = false;
    this._goalIndex = -1;
    this._generation++;
    return this;
  }

  // ---------------------------------------------------------------- search

  /**
   * Recompute the integration field toward (x, z).
   * MUST be throttled by the caller to <= 4 Hz and only when the goal cell
   * actually changed — this is a full sweep of the grid.
   * @returns {boolean} false if the grid is unbaked or the goal is unreachable
   */
  setGoal(x, z) {
    if (!this._baked) return false;
    let gi = this.indexAt(x, z);
    if (gi < 0) return false;
    if (this.blocked[gi]) {
      const open = this.nearestOpen(x, z);
      if (!open) return false;
      gi = this.indexAt(open.x, open.z);
      if (gi < 0 || this.blocked[gi]) return false;
    }

    // Nothing to do if the goal cell and the obstacle set are both unchanged.
    if (this._hasGoal && gi === this._goalIndex) {
      this._goalX = x;
      this._goalZ = z;
      return true;
    }

    this.cost.fill(INF);
    for (let b = 0; b < BUCKETS; b++) this._buckets[b].length = 0;

    const cost = this.cost;
    const blocked = this.blocked;
    const w = this.w;
    const h = this.h;
    const buckets = this._buckets;

    let pending = 0;
    cost[gi] = 0;
    buckets[0].push(gi);
    pending++;

    let d = 0;
    while (pending > 0) {
      const bucket = buckets[d % BUCKETS];
      while (bucket.length) {
        const idx = bucket.pop();
        pending--;
        if (cost[idx] !== d) continue;          // stale entry, already improved
        const ci = idx % w;
        const cj = (idx - ci) / w;
        for (let k = 0; k < 8; k++) {
          const ni = ci + NX[k];
          const nj = cj + NZ[k];
          if (ni < 0 || ni >= w || nj < 0 || nj >= h) continue;
          const nIdx = nj * w + ni;
          if (blocked[nIdx]) continue;
          if (k >= 4) {
            // No corner cutting: a diagonal needs both orthogonals open, or
            // agents shave the corner of a building and end up inside it.
            if (blocked[cj * w + ni] || blocked[nj * w + ci]) continue;
          }
          const nd = d + NW[k];
          if (nd < cost[nIdx]) {
            cost[nIdx] = nd;
            buckets[nd % BUCKETS].push(nIdx);
            pending++;
          }
        }
      }
      d++;
    }

    this._hasGoal = true;
    this._goalIndex = gi;
    this._goalX = x;
    this._goalZ = z;
    return true;
  }

  /**
   * Unit direction of steepest descent toward the goal.
   * @param {{x:number,z:number}} out written in place
   * @returns {boolean} false => no usable flow, caller must fall back to its
   *          own straight-line steering. This is the degradation path that
   *          keeps the current convex arena bit-for-bit unchanged.
   */
  flowAt(x, z, out = { x: 0, z: 0 }) {
    if (!this._hasGoal) return false;
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || i >= this.w || j < 0 || j >= this.h) return false;
    const idx = j * this.w + i;

    const here = this.blocked[idx] ? INF : this.cost[idx];
    // Inside the goal cell (or its immediate ring) the grid is coarser than the
    // answer. Hand back to the caller's exact straight-line steer.
    if (here !== INF && here <= W_DIAG) return false;

    let bestIdx = -1;
    let bestCost = here;
    for (let k = 0; k < 8; k++) {
      const ni = i + NX[k];
      const nj = j + NZ[k];
      if (ni < 0 || ni >= this.w || nj < 0 || nj >= this.h) continue;
      const nIdx = nj * this.w + ni;
      if (this.blocked[nIdx]) continue;
      if (k >= 4 && !this.blocked[idx]) {
        if (this.blocked[j * this.w + ni] || this.blocked[nj * this.w + i]) continue;
      }
      const c = this.cost[nIdx];
      if (c === INF) continue;
      if (c < bestCost) { bestCost = c; bestIdx = nIdx; }
    }
    if (bestIdx < 0) return false;

    const bi = bestIdx % this.w;
    const bj = (bestIdx - bi) / this.w;
    let dx = this.minX + (bi + 0.5) * this.cell - x;
    let dz = this.minZ + (bj + 0.5) * this.cell - z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return false;
    out.x = dx / len;
    out.z = dz / len;
    return true;
  }

  blockedAt(x, z) {
    const idx = this.indexAt(x, z);
    if (idx < 0) return true;               // off-grid counts as solid
    return this.blocked[idx] === 1;
  }

  /** True when the cell is walkable AND the current goal can be reached. */
  reachable(x, z) {
    const idx = this.indexAt(x, z);
    if (idx < 0 || this.blocked[idx]) return false;
    if (!this._hasGoal) return false;
    return this.cost[idx] !== INF;
  }

  /** Spiral outward for a walkable cell centre. */
  nearestOpen(x, z, maxRings = 8) {
    const i0 = Math.floor((x - this.minX) / this.cell);
    const j0 = Math.floor((z - this.minZ) / this.cell);
    for (let r = 0; r <= maxRings; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          // ring only, not the filled square
          if (r > 0 && Math.abs(di) !== r && Math.abs(dj) !== r) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || i >= this.w || j < 0 || j >= this.h) continue;
          if (this.blocked[j * this.w + i]) continue;
          return {
            x: this.minX + (i + 0.5) * this.cell,
            z: this.minZ + (j + 0.5) * this.cell,
          };
        }
      }
    }
    return null;
  }

  // --------------------------------------------------------------- helpers

  indexAt(x, z) {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || i >= this.w || j < 0 || j >= this.h) return -1;
    return j * this.w + i;
  }

  contains(x, z) {
    return x >= this.minX && x < this.maxX && z >= this.minZ && z < this.maxZ;
  }

  cellCenter(i, j, out = { x: 0, z: 0 }) {
    out.x = this.minX + (i + 0.5) * this.cell;
    out.z = this.minZ + (j + 0.5) * this.cell;
    return out;
  }

  stats() {
    return {
      width: this.w, height: this.h, cell: this.cell,
      open: this._openCount, blocked: this.w * this.h - this._openCount,
      baked: this._baked, hasGoal: this._hasGoal, generation: this._generation,
    };
  }

  _clampI(i) { return i < 0 ? 0 : (i >= this.w ? this.w - 1 : i); }
  _clampJ(j) { return j < 0 ? 0 : (j >= this.h ? this.h - 1 : j); }

  /**
   * Debug visualisation: blocked cells as a red instanced grid, flow arrows as
   * a line segment soup. THREE is taken from the constructor option or passed
   * in here — this module must stay importable in plain Node.
   */
  debugMesh(THREE = this._THREE) {
    if (!THREE) {
      throw new Error('NavGrid.debugMesh needs a THREE namespace: new NavGrid({ THREE }) or debugMesh(THREE)');
    }
    const root = new THREE.Group();
    root.name = 'navgrid-debug';

    const half = this.cell * 0.46;
    const quad = new THREE.PlaneGeometry(half * 2, half * 2);
    quad.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff4d6d, transparent: true, opacity: 0.28, depthWrite: false,
    });
    let blockedCount = 0;
    for (let i = 0; i < this.blocked.length; i++) if (this.blocked[i]) blockedCount++;
    if (blockedCount > 0) {
      const inst = new THREE.InstancedMesh(quad, mat, blockedCount);
      const m = new THREE.Matrix4();
      let n = 0;
      for (let j = 0; j < this.h; j++) {
        for (let i = 0; i < this.w; i++) {
          if (!this.blocked[j * this.w + i]) continue;
          m.makeTranslation(
            this.minX + (i + 0.5) * this.cell, 0.06,
            this.minZ + (j + 0.5) * this.cell,
          );
          inst.setMatrixAt(n++, m);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      root.add(inst);
    } else {
      quad.dispose();
      mat.dispose();
    }

    if (this._hasGoal) {
      const pts = [];
      const dir = { x: 0, z: 0 };
      const step = Math.max(1, Math.floor(2 / this.cell));
      for (let j = 0; j < this.h; j += step) {
        for (let i = 0; i < this.w; i += step) {
          const x = this.minX + (i + 0.5) * this.cell;
          const z = this.minZ + (j + 0.5) * this.cell;
          if (!this.flowAt(x, z, dir)) continue;
          pts.push(x, 0.1, z, x + dir.x * this.cell * 0.6, 0.1, z + dir.z * this.cell * 0.6);
        }
      }
      if (pts.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        root.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x35e6ff })));
      }
    }
    return root;
  }
}

/**
 * Convenience: build a grid from the shape World/City already hand out —
 * circle obstacles, box obstacles and a bounds predicate.
 */
export function buildNavGrid({
  originX = 0, originZ = 0, size, cell = 2, pad = 0, THREE = null,
  obstacles = [], boxes = [], inside = null,
}) {
  const grid = new NavGrid({ originX, originZ, size, cell, pad, THREE });
  if (inside) grid.blockOutside(inside);
  for (const o of obstacles) {
    const p = o.pos || o;
    grid.blockCircle(p.x, p.z, o.radius ?? o.r ?? 1);
  }
  for (const b of boxes) grid.blockBox(b.x, b.z, b.w, b.d, b.rot || 0);
  grid.bake();
  return grid;
}

export default NavGrid;
