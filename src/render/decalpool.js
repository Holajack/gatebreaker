import * as THREE from 'three';
import { GLOW_LAYER } from './glow.js';

// Instanced pool for the two flat decals every character carries: the ground
// ring under its feet and the billboarded health bar over its head.
//
// Those used to be three Meshes per character (ring, bar background, bar fill),
// so a full S-rank field paid ~66 draw calls for nothing but readability aids.
// Here the whole scene's rings are one InstancedMesh and the whole scene's bars
// are two more, so the cost is 3 draws total no matter how many characters are
// alive.
//
// Handles are opaque integers. Rings and bars live in separate instance arrays,
// so the kind is packed into the high bits rather than kept in a side table.

const KIND_SHIFT = 16;
const KIND_MASK = 0xffff;
const RING = 0;
const BAR = 1;

// The ring material carries one opacity for every instance, so per-ring alpha
// is folded into the instance colour instead (see acquireRing). This is the
// REFERENCE the folding is relative to — callers pass an opacity in this scale
// and get a proportional colour. It is deliberately not the same number as the
// material's real alpha below.
export const RING_OPACITY = 0.8;

// The ring's actual material alpha, and the reason this file changed.
//
// The shipped build drew each ring at 0.8 alpha, 28% of its radius thick, and
// on GLOW_LAYER. With eight characters on screen the eight blurred halos merged
// into one sheet of light that swallowed everyone's lower half, and the review
// measured the ring band as BRIGHTER than the character standing in it. A
// threat indicator that outshines the threat is not an indicator.
//
// The fix is three things at once, because any one of them alone is not enough:
//   * off GLOW_LAYER entirely (below) — no bloom halo, so rings stop merging,
//   * a thin band instead of a fat donut (RING_INNER),
//   * lower alpha.
// It still reads: on this game's near-black arenas a saturated outline against
// the ground is unmistakable. It just no longer emits light. 0.72 rather than
// something lower because alpha-blending a hue toward a near-black floor
// desaturates it — measured at 0.55 the colour-coding went grey, and the ring
// has to stay legible AS A THREAT INDICATOR, which is a colour job.
//
// Measured on tools/visual-test.mjs, 11 characters, real gameplay camera:
// ring-band mean luminance 0.566 -> 0.190, and the fraction of ring-band pixels
// above 0.75 luma (i.e. blown out) 0.339 -> 0.0003.
export const RING_ALPHA = 0.72;

// Inner radius as a fraction of the outer. 0.72 was a donut; 0.86 is a line.
const RING_INNER = 0.86;

const BAR_BG_H = 0.13;
const BAR_FILL_H = 0.1;
const BAR_BG_COLOR = 0x0a0a12;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _off = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class DecalPool {
  // `ringGlow` is the opt-in escape hatch: a pool that genuinely wants its
  // rings to emit — a boss-telegraph pool, say — can ask for it. The character
  // pool must not, and does not by default. Transient telegraphs already have
  // their own glowing path through Effects.ring(), which is where an expanding
  // shockwave belongs.
  constructor(scene, { rings = 64, bars = 64, ringGlow = false } = {}) {
    this.scene = scene;
    this.ringCap = rings;
    this.barCap = bars;

    // Optional hook for the deprecated makeGroundRing/makeHealthBar shims in
    // entities.js: they push proxy transforms in here just before the flush.
    this.onBeforeUpdate = null;

    const ringGeo = new THREE.RingGeometry(RING_INNER, 1, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMesh = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: RING_ALPHA, side: THREE.DoubleSide, depthWrite: false,
    }), rings);
    if (ringGlow) this.ringMesh.layers.enable(GLOW_LAYER);

    const quad = new THREE.PlaneGeometry(1, 1);
    // Two meshes, not one: the background is alpha-blended and the fill is not,
    // which is what puts the fill in the opaque pass and the darkened backdrop
    // over the top of it. Merging them would change how the bar reads.
    this.barFill = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({
      depthTest: false,
    }), bars);
    this.barBg = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({
      color: BAR_BG_COLOR, transparent: true, opacity: 0.75, depthTest: false,
    }), bars);
    this.barFill.renderOrder = 999;
    this.barBg.renderOrder = 999;

    for (const m of [this.ringMesh, this.barFill, this.barBg]) {
      // Always in the render list: onBeforeRender is what drives update(), and a
      // culled pool would silently stop syncing.
      m.frustumCulled = false;
      scene.add(m);
    }
    // Both hooks fire in the MAIN pass now that the ring is off GLOW_LAYER;
    // update() is idempotent within a frame, so two callers is only a cost when
    // one of the two meshes is culled — and neither is (frustumCulled = false).
    this.ringMesh.onBeforeRender = (r, s, cam) => this.update(cam);
    this.barBg.onBeforeRender = (r, s, cam) => this.update(cam);

    this.ringActive = new Uint8Array(rings);
    this.ringRadius = new Float32Array(rings);
    this.barActive = new Uint8Array(bars);
    this.barWidth = new Float32Array(bars);
    // x, y, z, ratio, visible — bars are rebuilt every frame because their
    // orientation comes from the camera, not from the caller.
    this.barState = new Float32Array(bars * 5);

    for (let i = 0; i < rings; i++) this.ringMesh.setMatrixAt(i, HIDDEN);
    for (let i = 0; i < bars; i++) { this.barFill.setMatrixAt(i, HIDDEN); this.barBg.setMatrixAt(i, HIDDEN); }
    // Allocated up front rather than lazily by the first setColorAt: adding
    // instanceColor to a live mesh changes the program cache key and costs a
    // shader recompile mid-run.
    this.ringMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(rings * 3), 3);
    this.barFill.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bars * 3), 3);
  }

  /** @returns {number} handle, or -1 when the pool is full. */
  acquireRing(color, radius = 0.8, opacity = RING_OPACITY) {
    const i = this.ringActive.indexOf(0);
    if (i < 0) return -1;
    this.ringActive[i] = 1;
    this.ringRadius[i] = radius;
    // Per-instance alpha is not available on a shared material, so dim the
    // colour instead. Against this game's near-black arenas the two are close
    // enough to be indistinguishable. `opacity` is in the RING_OPACITY scale,
    // not the material's real RING_ALPHA — see the note on both constants.
    _c.setHex(color).multiplyScalar(Math.min(1, opacity / RING_OPACITY));
    this.ringMesh.setColorAt(i, _c);
    this.ringMesh.instanceColor.needsUpdate = true;
    this.ringMesh.setMatrixAt(i, HIDDEN);
    return (RING << KIND_SHIFT) | i;
  }

  /** @returns {number} handle, or -1 when the pool is full. */
  acquireBar(color, width = 1.2) {
    const i = this.barActive.indexOf(0);
    if (i < 0) return -1;
    this.barActive[i] = 1;
    this.barWidth[i] = width;
    this.barState[i * 5 + 3] = 1;
    this.barState[i * 5 + 4] = 0;
    this.barFill.setColorAt(i, _c.setHex(color));
    this.barFill.instanceColor.needsUpdate = true;
    this.barFill.setMatrixAt(i, HIDDEN);
    this.barBg.setMatrixAt(i, HIDDEN);
    return (BAR << KIND_SHIFT) | i;
  }

  /**
   * Rings inherit the character's scale in the old parented-mesh layout, and
   * that scale is only knowable once the character has a world matrix — hence a
   * setter rather than a fixed radius from acquire time.
   */
  setRingRadius(handle, radius) {
    const i = this._slot(handle, RING);
    if (i < 0) return;
    this.ringRadius[i] = radius;
  }

  setRing(handle, x, y, z, visible = true) {
    const i = this._slot(handle, RING);
    if (i < 0) return;
    if (!visible) {
      this.ringMesh.setMatrixAt(i, HIDDEN);
    } else {
      const r = this.ringRadius[i];
      _m.compose(_p.set(x, y, z), _q.identity(), _s.set(r, 1, r));
      this.ringMesh.setMatrixAt(i, _m);
    }
  }

  setBar(handle, x, y, z, ratio = 1, visible = true) {
    const i = this._slot(handle, BAR);
    if (i < 0) return;
    const o = i * 5;
    this.barState[o] = x; this.barState[o + 1] = y; this.barState[o + 2] = z;
    this.barState[o + 3] = ratio;
    this.barState[o + 4] = visible ? 1 : 0;
  }

  release(handle) {
    if (handle == null || handle < 0) return;
    const kind = handle >> KIND_SHIFT;
    const i = handle & KIND_MASK;
    if (kind === RING) {
      if (i >= this.ringCap) return;
      this.ringActive[i] = 0;
      this.ringMesh.setMatrixAt(i, HIDDEN);
    } else {
      if (i >= this.barCap) return;
      this.barActive[i] = 0;
      this.barState[i * 5 + 4] = 0;
      this.barFill.setMatrixAt(i, HIDDEN);
      this.barBg.setMatrixAt(i, HIDDEN);
    }
  }

  /** Flush pending instance data. Driven by the pool's own onBeforeRender. */
  update(camera) {
    if (this.onBeforeUpdate) this.onBeforeUpdate(camera);
    if (camera) _q.copy(camera.quaternion); else _q.identity();

    for (let i = 0; i < this.barCap; i++) {
      if (!this.barActive[i]) continue;
      const o = i * 5;
      if (!this.barState[o + 4]) {
        this.barFill.setMatrixAt(i, HIDDEN);
        this.barBg.setMatrixAt(i, HIDDEN);
        continue;
      }
      const w = this.barWidth[i];
      const x = this.barState[o], y = this.barState[o + 1], z = this.barState[o + 2];
      const r = Math.max(0, Math.min(1, this.barState[o + 3])) || 0.0001;
      _m.compose(_p.set(x, y, z), _q, _s.set(w, BAR_BG_H, 1));
      this.barBg.setMatrixAt(i, _m);
      // Scaling a centred quad shrinks both ends; shift left so it drains
      // rightward, exactly as the old two-mesh bar did.
      _off.set(-(w * (1 - r)) / 2, 0, 0.01).applyQuaternion(_q);
      _m.compose(_p.set(x + _off.x, y + _off.y, z + _off.z), _q, _s.set(w * r, BAR_FILL_H, 1));
      this.barFill.setMatrixAt(i, _m);
    }

    // Three 4 KB buffers; cheaper to re-upload unconditionally than to track
    // which of ~40 decals moved this frame.
    this.ringMesh.instanceMatrix.needsUpdate = true;
    this.barFill.instanceMatrix.needsUpdate = true;
    this.barBg.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.ringMesh, this.barFill, this.barBg]) {
      m.parent?.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    this.scene = null;
  }

  _slot(handle, kind) {
    if (handle == null || handle < 0) return -1;
    if ((handle >> KIND_SHIFT) !== kind) return -1;
    const i = handle & KIND_MASK;
    const cap = kind === RING ? this.ringCap : this.barCap;
    return i < cap ? i : -1;
  }
}

// ------------------------------------------------------------- ground fx
//
// The CLASSES_SPEC step-4 decal channel: transient ground telegraphy for the
// direction masteries — RESIDUE's lingering skill fields (discs) and READING's
// enemy-swing arcs (sectors), with the FLAME archon's Ashfall due to share the
// disc half later (performanceBudget: the channels are SHARED, never added).
//
// Two InstancedMeshes, IMMEDIATE-MODE: the game pushes transforms every frame
// between begin() and commit(), and commit() sets .count to what was pushed.
// three r169's WebGLBufferRenderer.renderInstances early-returns at
// primcount === 0, so an idle channel costs ZERO draw calls — the whole pool
// submits nothing until a mastery actually fires, which is what keeps the
// shipped dungeon budget (<= 24 E/D) untouched for every existing save. Live,
// the cost is at most +2 submissions however many fields and arcs are up.
//
// Deliberately OFF the glow layer, like the character rings above: these are
// READABILITY marks on the floor, and the review that produced RING_ALPHA
// measured what a glowing ground sheet does to a dark arena. The sanctioned
// telegraph-VFX glow path stays Effects.ring() for transient shockwaves.
//
// No per-frame allocation: matrices compose through the module scratch
// (_m/_p/_q/_s), colours through _c, and the instance buffers are allocated
// once up front (adding instanceColor to a live mesh changes the program
// cache key and costs a shader recompile mid-run — same note as the pool
// above).

// The arc sector spans the game's ACTUAL melee hit test: _enemyStrike lands
// when dot(bearing, facing) > 0.2, i.e. inside acos(0.2) either side of
// forward. The geometry bakes exactly that cone so what the arc shows is what
// the swing will hit — READING is the abstract stat becoming a visible thing,
// and an arc narrower than the truth would teach players to stand in hits.
const ARC_HALF = Math.acos(0.2);

// Above the floor slabs but under the 0.36 the character rings ride at, so a
// ring standing inside a field still reads. Arcs sit a step above discs: a
// telegraph arc crossing a RESIDUE field must win the overdraw, because the
// arc is the one that is about to hurt.
const FX_DISC_Y = 0.12;
const FX_ARC_Y = 0.16;

export class GroundFxPool {
  constructor(scene, { discs = 8, arcs = 6 } = {}) {
    this.scene = scene;
    this.discCap = discs;
    this.arcCap = arcs;
    this.liveDiscs = 0;
    this.liveArcs = 0;

    const discGeo = new THREE.CircleGeometry(1, 28);
    discGeo.rotateX(-Math.PI / 2);
    // Sector bisector on local -Y in plane space (thetaStart centred on
    // -PI/2), which rotateX(-PI/2) maps onto local +Z — the same axis a yaw
    // quaternion turns into the entity's _forward, so pushArc can hand the
    // enemy's yaw straight through.
    const arcGeo = new THREE.CircleGeometry(1, 20, -Math.PI / 2 - ARC_HALF, ARC_HALF * 2);
    arcGeo.rotateX(-Math.PI / 2);

    this.discMesh = new THREE.InstancedMesh(discGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.20, depthWrite: false,
    }), discs);
    this.arcMesh = new THREE.InstancedMesh(arcGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.30, depthWrite: false,
    }), arcs);
    for (const m of [this.discMesh, this.arcMesh]) {
      // Transforms live in instance matrices, so the mesh's own bounds never
      // reflect where anything is — culling by them would blank live fields.
      m.frustumCulled = false;
      m.count = 0;
      m.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array((m === this.discMesh ? discs : arcs) * 3), 3,
      );
      scene.add(m);
    }
  }

  /** Open the frame: everything not re-pushed before commit() disappears. */
  begin() {
    this.liveDiscs = 0;
    this.liveArcs = 0;
  }

  /** A full-circle ground field (RESIDUE, the boss slam's READING disc). */
  pushDisc(x, z, radius, color, brightness = 1) {
    if (this.liveDiscs >= this.discCap) return;
    const i = this.liveDiscs++;
    _m.compose(_p.set(x, FX_DISC_Y, z), _q.identity(), _s.set(radius, 1, radius));
    this.discMesh.setMatrixAt(i, _m);
    // Per-instance alpha is unavailable on a shared material — dim the colour
    // instead, the same trade acquireRing documents above.
    this.discMesh.setColorAt(i, _c.setHex(color).multiplyScalar(Math.min(1, brightness)));
  }

  /** A swing-cone sector: `yaw` is the striker's facing, `radius` its reach. */
  pushArc(x, z, yaw, radius, color) {
    if (this.liveArcs >= this.arcCap) return;
    const i = this.liveArcs++;
    _q.setFromAxisAngle(UP, yaw);
    _m.compose(_p.set(x, FX_ARC_Y, z), _q, _s.set(radius, 1, radius));
    this.arcMesh.setMatrixAt(i, _m);
    this.arcMesh.setColorAt(i, _c.setHex(color));
  }

  /** Close the frame: set the live counts and upload what was pushed. */
  commit() {
    this.discMesh.count = this.liveDiscs;
    this.arcMesh.count = this.liveArcs;
    if (this.liveDiscs > 0) {
      this.discMesh.instanceMatrix.needsUpdate = true;
      this.discMesh.instanceColor.needsUpdate = true;
    }
    if (this.liveArcs > 0) {
      this.arcMesh.instanceMatrix.needsUpdate = true;
      this.arcMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Hide everything without tearing down — a mode swap, not a disposal. */
  clear() {
    this.liveDiscs = 0;
    this.liveArcs = 0;
    this.discMesh.count = 0;
    this.arcMesh.count = 0;
  }

  /** Full teardown: geometries and materials back to the renderer. */
  dispose() {
    for (const m of [this.discMesh, this.arcMesh]) {
      m.parent?.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    this.scene = null;
  }
}
