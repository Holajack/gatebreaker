import * as THREE from 'three';

// Pooled projectiles (RPG_SPEC buildOrder step 8).
//
// Replaces the per-shot allocation in game.js: the shipped _spawnProjectile
// built an IcosahedronGeometry + a MeshBasicMaterial + a PointLight PER SHOT
// and disposed all three on removal. At bow cadence that is per-shot material
// creation, and weapons.js's own header measures a material-driven shader
// recompile at 8-60 ms on a mid-range Android; twelve bolts in flight was also
// twelve dynamic lights, which is a cliff and not a cost. Here every record and
// every mesh is preallocated once, geometry and materials are shared, and the
// PointLight is gone — the meshes ride the glow layer instead, which is the
// same emissive-only bloom trick edgeMat uses.
//
// THE INTEGRATION IS THE SHIPPED INTEGRATION. RPG_SPEC's contract for this
// step: "EVERY EXISTING CALLER PASSES g = 0 AND vy = 0, which reproduces
// today's flat integration EXACTLY — assert that byte-equality in the test
// rather than assuming it." The flat path below is pos.addScaledVector(dir,
// speed * dt), the identical expression the old loop ran, and the vy/g terms
// are only ever touched when one of them is non-zero — so an enemy caster bolt
// or a boss spread shot cannot change by a single float. tools/fight-test.mjs
// asserts the 240-step float-identity in node.
//
// This module is deliberately zero-dependency beyond three: the arrow geometry
// arrives through an injected accessor (weapons.js's sharedItemGeometry) so a
// headless node test can import and run the pool with no GLB, no renderer and
// no scene beyond a stub with add().

// Scratch — never returned, never retained. The projectile code in game.js
// once shipped a bug from a SHARED scratch vector (see the _aimDir note at the
// top of game.js); these are private to this module and touched by nothing
// else, which is the sanctioned pattern.
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class ProjectilePool {
  /**
   * @param {THREE.Scene|{add:Function}} scene
   * @param {object} [opts]
   * @param {number}   [opts.max=16]        records AND meshes, preallocated
   * @param {number}   [opts.glowLayer=-1]  layer index to enable on every mesh
   * @param {Function} [opts.arrowGeometry] () -> BufferGeometry | null. Called
   *   lazily at first arrow spawn (the item pack loads after the pool exists).
   *   The returned geometry is SHARED and never disposed here.
   * @param {Function} [opts.onRemove]      (record, reason) -> void, fired on
   *   every release. reason: 'cull' | 'hitPlayer' | 'hitEnemy' | 'manual' |
   *   'cycle' | 'clear'.
   */
  constructor(scene, { max = 16, glowLayer = -1, arrowGeometry = null, onRemove = null } = {}) {
    this.scene = scene;
    this.max = max;
    this.onRemove = onRemove;
    this._getArrowGeo = arrowGeometry;

    // Allocation ledger — tools/fight-test.mjs asserts these counters do not
    // move across 200 spawns, which is the "zero new geometries and zero new
    // materials" claim made checkable instead of assumed.
    this._made = { meshes: 0, geometries: 0, materials: 0 };

    // One shared bolt geometry (the shipped 0.3 icosahedron), one shared
    // procedural arrow for a build without public/models/. Both flagged shared
    // so a stray disposeObject3D cannot free them out from under the pool.
    this._boltGeo = new THREE.IcosahedronGeometry(0.3, 0);
    this._boltGeo.userData.shared = true;
    this._made.geometries++;
    // Fallback arrow: a thin shaft. Deliberately not vertex-coloured — the
    // pack material below needs a colour attribute this box does not carry.
    this._flatArrowGeo = new THREE.BoxGeometry(0.05, 1.0, 0.05);
    this._flatArrowGeo.userData.shared = true;
    this._made.geometries++;
    this._arrowGeo = null;       // resolved lazily from the accessor
    this._arrowTried = false;

    // Bolt materials keyed by colour. Enemy glow palettes are a small fixed
    // set (config.ENEMY_TYPES), so this map is bounded like every other cache.
    this._boltMats = new Map();
    this._arrowMatPack = null;   // vertex-coloured, for the pack geometry
    this._arrowMatFlat = null;   // plain, for the procedural fallback

    /** Live records, oldest first. game.js aliases this as `game.projectiles`
     *  so every existing reader (Nova's wipe, the fight suite) keeps working
     *  against the same array identity for the life of the Game. */
    this.live = [];
    this._free = [];

    for (let i = 0; i < max; i++) {
      const mesh = new THREE.Mesh(this._boltGeo, this._boltMat(0xffffff));
      mesh.visible = false;
      if (glowLayer >= 0) mesh.layers.enable(glowLayer);
      this._made.meshes++;
      scene.add(mesh);
      this._free.push({
        mesh,
        pos: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        vy: 0, g: 0,
        speed: 0, damage: 0, life: 0, color: 0xffffff,
        knock: 0, stagger: 0,
        kind: 'bolt',
        stuck: false, stuckT: 0,
        element: null,
        born: 0,
      });
    }
    this._births = 0;
  }

  _boltMat(color) {
    let m = this._boltMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color });
      m.userData.shared = true;
      this._boltMats.set(color, m);
      this._made.materials++;
    }
    return m;
  }

  _arrowAssets() {
    if (!this._arrowTried) {
      this._arrowTried = true;
      this._arrowGeo = this._getArrowGeo ? (this._getArrowGeo() || null) : null;
    }
    if (this._arrowGeo) {
      if (!this._arrowMatPack) {
        // MeshBasic on the glow layer, per the spec's performance rules: the
        // bloom pass renders emissive-only geometry unlit, so the arrow stays
        // legible at 46 m/s without costing a light or a lighting evaluation.
        this._arrowMatPack = new THREE.MeshBasicMaterial({ vertexColors: true });
        this._arrowMatPack.userData.shared = true;
        this._made.materials++;
      }
      return { geo: this._arrowGeo, mat: this._arrowMatPack };
    }
    if (!this._arrowMatFlat) {
      this._arrowMatFlat = new THREE.MeshBasicMaterial({ color: 0xcda877 });
      this._arrowMatFlat.userData.shared = true;
      this._made.materials++;
    }
    return { geo: this._flatArrowGeo, mat: this._arrowMatFlat };
  }

  /** Live (flying, not stuck) records of `kind`. */
  countFlying(kind) {
    let n = 0;
    for (let i = 0; i < this.live.length; i++) {
      const r = this.live[i];
      if (r.kind === kind && !r.stuck) n++;
    }
    return n;
  }

  /**
   * Free the best sacrificial record so a new spawn can proceed: the oldest
   * STUCK arrow first (they are scenery on borrowed time — "despawn on a pool
   * cycle" is the spec's own wording), then the oldest record of `kind`, then
   * simply the oldest. Oldest = lowest birth stamp, and live[] is push-ordered
   * so the first match wins.
   */
  reclaimOldest(kind = null) {
    let idx = -1;
    for (let i = 0; i < this.live.length; i++) {
      if (this.live[i].stuck) { idx = i; break; }
    }
    if (idx < 0 && kind) {
      for (let i = 0; i < this.live.length; i++) {
        if (this.live[i].kind === kind) { idx = i; break; }
      }
    }
    if (idx < 0 && this.live.length) idx = 0;
    if (idx < 0) return false;
    this.releaseAt(idx, 'cycle');
    return true;
  }

  /**
   * Take a record from the pool and launch it. Returns the record, or null
   * when the pool is somehow empty even after a reclaim (max = 0).
   * `from` and `dir` are COPIED — callers may pass scratch vectors.
   */
  spawn({
    from, dir, vy = 0, g = 0, speed = 16, damage = 0, color = 0xffffff,
    life = 4, kind = 'bolt', knock = 0, stagger = 0, element = null,
  }) {
    let rec = this._free.pop();
    if (!rec) {
      if (!this.reclaimOldest(kind)) return null;
      rec = this._free.pop();
      if (!rec) return null;
    }
    rec.kind = kind;
    rec.pos.copy(from);
    rec.dir.copy(dir);
    rec.vy = vy;
    rec.g = g;
    rec.speed = speed;
    rec.damage = damage;
    rec.life = life;
    rec.color = color;
    rec.knock = knock;
    rec.stagger = stagger;
    rec.stuck = false;
    rec.stuckT = 0;
    // Records are REUSED — stamp element on every spawn or a plain arrow
    // inherits a previous life's magic (same trap rec.staff already guards).
    rec.element = element;
    rec.born = this._births++;

    const mesh = rec.mesh;
    if (kind === 'arrow') {
      const { geo, mat } = this._arrowAssets();
      mesh.geometry = geo;
      // A CONJURED arrow (element stamped) keeps the arrow silhouette but
      // swaps the wooden pack material for the per-colour solid the bolts
      // already cache (_boltMat) — every pool mesh sits on the glow layer
      // (constructor), so the tint blooms and the shaft reads as made of
      // light, not wood. No new material system, no new programs: MeshBasic
      // per colour, bounded by the same Map the bolts bound.
      mesh.material = element ? this._boltMat(color) : mat;
      // Pack metre mismatch, same 0.62 the held Bow_Wooden uses.
      mesh.scale.setScalar(0.62);
      this._orientArrow(rec);
    } else {
      mesh.geometry = this._boltGeo;
      mesh.material = this._boltMat(color);
      mesh.scale.setScalar(1);
      mesh.rotation.set(0, 0, 0);
    }
    mesh.position.copy(rec.pos);
    mesh.visible = true;
    this.live.push(rec);
    return rec;
  }

  /** Point the arrow model's +Y (its shaft) along the live velocity vector. */
  _orientArrow(rec) {
    _v.set(rec.dir.x * rec.speed, rec.vy, rec.dir.z * rec.speed);
    const len = _v.length();
    if (len > 1e-6) rec.mesh.quaternion.setFromUnitVectors(_up, _v.divideScalar(len));
  }

  /** Release live[i] back to the pool. The mesh hides; nothing is disposed. */
  releaseAt(i, reason = 'manual') {
    const rec = this.live[i];
    if (!rec) return;
    if (this.onRemove) this.onRemove(rec, reason);
    rec.mesh.visible = false;
    this.live.splice(i, 1);
    this._free.push(rec);
  }

  release(rec, reason = 'manual') {
    const i = this.live.indexOf(rec);
    if (i >= 0) this.releaseAt(i, reason);
  }

  /**
   * Advance every live projectile one step.
   *
   * The bolt path below is the shipped game.js loop verbatim — same statement
   * order, same expressions, same culls — because enemy caster bolts and boss
   * spread shots must not change by a float (RPG_SPEC). Arrows add vy/g, a
   * ground/wall STICK instead of a burst, and an enemy hit test.
   *
   * @param {number} dt
   * @param {object} ctx
   * @param {object|null} ctx.obstacleField  world/obstacles field, or null
   * @param {number}      ctx.worldRadius    disc cull bound
   * @param {THREE.Vector3|null} ctx.playerPos  bolts test a 1.1 m sphere at y 1.2
   * @param {Array|null}  ctx.enemies        arrows test each enemy's torso
   * @param {Function}    [ctx.onHitPlayer]  (rec) -> void
   * @param {Function}    [ctx.onHitEnemy]   (rec, enemy) -> void
   */
  update(dt, ctx) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const pr = this.live[i];
      if (pr.stuck) {
        // Scenery. It despawns when the pool cycles (reclaimOldest) or on
        // clear(); ticking a timer here would just be a second, hidden cycle.
        continue;
      }
      pr.life -= dt;
      pr.pos.addScaledVector(pr.dir, pr.speed * dt);
      if (pr.vy !== 0 || pr.g !== 0) {
        // RPG_SPEC integration: explicit Euler, vertical only. Guarded so the
        // flat path above stays byte-identical for every g=0, vy=0 caller.
        pr.pos.y += pr.vy * dt;
        pr.vy -= pr.g * dt;
      }
      pr.mesh.position.copy(pr.pos);
      if (pr.kind === 'bolt') {
        pr.mesh.rotation.x += dt * 9;
        pr.mesh.rotation.y += dt * 7;
      } else {
        this._orientArrow(pr);
      }
      // A bolt dies on the first solid it enters. feetY is the projectile's
      // own height, so kerb-height props with real tops do not eat shots;
      // walls are top-Infinity and always block. The radius+2 disc cull stays
      // the outer bound in both worlds. (Shipped logic, moved not rewritten.)
      const gone = pr.life <= 0 || Math.hypot(pr.pos.x, pr.pos.z) > ctx.worldRadius + 2;
      const solid = !gone && ctx.obstacleField?.blocked(pr.pos.x, pr.pos.z, 0.25, 0, pr.pos.y);
      if (pr.kind === 'arrow') {
        // A conjured arrow DISSOLVES where a wooden one sticks: magic made of
        // light has no shaft to leave in the floor, and stuck wooden scenery
        // was exactly the fiction-breaker the magic-bow rework removes. The
        // release funnels through onRemove ('dissolve'), where game.js pops
        // the element-coloured burst. Backward loop — releaseAt(i) is safe.
        // Local floor for both landing tests (tower wiring): ctx.heightAt
        // is 0 in flat kinds (byte-identical) and the terrace height in the
        // tower, where the absolute 0.02 let arrows sail through floors.
        const gy = ctx.heightAt ? ctx.heightAt(pr.pos.x, pr.pos.z) : 0;
        if (pr.element && (solid || pr.pos.y <= gy + 0.02)) {
          this.releaseAt(i, 'dissolve');
          continue;
        }
        // Wooden arrows STICK where they land — half a step back along the
        // flight so the head reads as embedded rather than the whole shaft
        // swallowed.
        if (solid || pr.pos.y <= gy + 0.02) {
          if (pr.pos.y < gy + 0.02) pr.pos.y = gy + 0.02;
          pr.pos.addScaledVector(pr.dir, -pr.speed * dt * 0.5);
          pr.mesh.position.copy(pr.pos);
          pr.stuck = true;
          continue;
        }
        if (gone) { this.releaseAt(i, 'cull'); continue; }
        const es = ctx.enemies;
        if (es) {
          for (let k = 0; k < es.length; k++) {
            const e = es[k];
            if (e.hp <= 0) continue;
            // Torso sphere: chest height scales with the body and rides the
            // record's OWN y — an enemy still rising through the floor (or a
            // test-parked boss at y -500) must not eat an arrow flying at
            // chest height above it. The fight suite caught exactly that: a
            // ground-relative test credited a hit to a boss 500 m underground.
            const dy = pr.pos.y - (e.pos.y + 1.2 * (e.base?.scale || 1));
            const dx = pr.pos.x - e.pos.x;
            const dz = pr.pos.z - e.pos.z;
            const r = (e.radius || 0.6) + 0.55;
            if (dx * dx + dy * dy + dz * dz < r * r) {
              if (ctx.onHitEnemy) ctx.onHitEnemy(pr, e);
              this.releaseAt(i, 'hitEnemy');
              break;
            }
          }
        }
        continue;
      }
      // Bolt: shipped cull + player sphere test, same order, same numbers.
      if (gone || solid) {
        this.releaseAt(i, 'cull');
        continue;
      }
      if (ctx.playerPos
          // Chest above the player's OWN y (tower wiring): playerPos.y is the
          // feet; the old absolute 1.2 made bolts unhittable/unavoidable off
          // floor 0. Flat kinds: feet y is 0, byte-identical.
          && pr.pos.distanceTo(_v.copy(ctx.playerPos).setY(ctx.playerPos.y + 1.2)) < 1.1) {
        if (ctx.onHitPlayer) ctx.onHitPlayer(pr);
        this.releaseAt(i, 'hitPlayer');
      }
    }
  }

  /** Gate transition / context loss: everything back to the pool, silently. */
  clear() {
    for (let i = this.live.length - 1; i >= 0; i--) this.releaseAt(i, 'clear');
  }

  /** Allocation ledger for the zero-alloc assert. */
  stats() {
    return {
      meshes: this._made.meshes,
      geometries: this._made.geometries,
      materials: this._made.materials,
      live: this.live.length,
      free: this._free.length,
    };
  }

  /** Full teardown. The injected arrow geometry is weapons.js's to dispose. */
  dispose() {
    this.clear();
    for (const rec of this._free) {
      this.scene.remove?.(rec.mesh);
    }
    this._free.length = 0;
    this._boltGeo.dispose();
    this._flatArrowGeo.dispose();
    this._boltMats.forEach((m) => m.dispose());
    this._boltMats.clear();
    this._arrowMatPack?.dispose();
    this._arrowMatFlat?.dispose();
    this._arrowMatPack = null;
    this._arrowMatFlat = null;
  }
}
