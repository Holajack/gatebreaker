import * as THREE from 'three';
import { GLOW_LAYER } from '../render/glow.js';

// Pooled particle bursts, floating damage numbers, camera shake and hit-stop.
// Everything here is allocation-light so long fights don't stutter on mobile.
//
// THIS MODULE IS WHERE GLOW BELONGS. The rest of the render stack has just had
// its glow taken off characters — a person should be lit, not luminous. What
// stays on GLOW_LAYER is the stuff that is supposed to be light in the fiction:
// impact sparks, shockwaves, novas, projectiles, portals. That is the whole
// point of keeping the machinery.
//
// The numbers below were still tuned for the box-man era, when a burst had to
// out-shout untextured geometry. They are pulled back so an effect READS as an
// effect over a character rather than replacing the character with a flare.

const MAX_PARTICLES = 420;

// ---- atlas flashes -------------------------------------------------------
//
// First consumer of public/models/particles.webp (the Kenney atlas staged in
// Wave 2-A). The manifest's own rule: white/grey masks, tint via material
// color, additive blending, SKILLS / TELEGRAPHS / PORTALS only — never a glow
// on a living character. These cells are [col,row] copied from
// public/models/particles.json's "sprites" table (cell 224, 5 cols x 5 rows);
// hardcoded rather than fetched because the manifest is versioned WITH the
// atlas by the same build tool, and a fetch here would push an async loading
// state into every synchronous caller. If pack-icons regenerates the atlas
// with a different layout, update these three pairs with it.
const FLASH_ATLAS_URL = 'models/particles.webp';
const FLASH_COLS = 5;
const FLASH_ROWS = 5;
const FLASH_SPRITES = {
  magic_01: [2, 1],   // pentagon rune ring — the manifest's stated cast flash
  magic_04: [4, 1],   // sparkle cluster — bolt impact
  spark_06: [2, 3],   // small spark — beam tick / chip hit
};
// 10 slots: a staff at full cadence holds ~3 casts + 3 impacts alive at once,
// and the beam adds one tick flash per 0.2 s. Oldest-slot reuse, like the
// particle cursor — a popped flash is invisible inside the burst that
// replaces it.
const MAX_FLASHES = 10;
const FLASH_OPACITY = 0.85;

// Particle alpha. Was 0.95 — effectively opaque, so a 60-particle nova put a
// wall of fully-bright tetrahedra over whoever it hit.
const PARTICLE_OPACITY = 0.82;

// Peak shockwave-ring alpha. Was 0.85. These fire on every kill, crit and nova,
// so with a busy field several are alive at once and they add.
const SHOCK_OPACITY = 0.68;

export class Effects {
  constructor(scene, camera, renderer) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;

    this.shake = 0;
    this.hitStop = 0;

    // --- particle pool: one InstancedMesh, transforms written per frame ---
    const geo = new THREE.TetrahedronGeometry(0.16, 0);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: PARTICLE_OPACITY, vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(GLOW_LAYER);
    this.mesh.count = MAX_PARTICLES;
    const colors = new Float32Array(MAX_PARTICLES * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    scene.add(this.mesh);

    this.parts = Array.from({ length: MAX_PARTICLES }, () => ({
      life: 0, maxLife: 1,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      spin: 0, size: 1, gravity: -12,
    }));
    this._cursor = 0;
    this.budget = MAX_PARTICLES;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    // --- expanding shockwave rings ---
    this.rings = [];
    this._ringGeo = new THREE.RingGeometry(0.9, 1, 40);
    // Pool ring meshes and cache materials by colour. three refcounts compiled
    // programs, so disposing the last material of a configuration DELETES the
    // WebGLProgram, and the next ring pays a full GLSL compile (8-60ms, main
    // thread). Rings fire on every kill, crit and nova.
    this._ringPool = [];
    this._ringMats = new Map();
    this._ringOpacity = new Map();

    this._dmgLayer = document.body;
    this._projected = new THREE.Vector3();

    // --- atlas flashes + the channel beam: both LAZY. The texture request
    // and the sprite pool only exist once something magical fires, so a
    // melee-only session never pays for them; a build shipped without
    // public/models/ fails the texture load once and flash() becomes a no-op
    // — every caller pairs a flash with a burst(), so the effect language
    // degrades to the procedural particles instead of vanishing.
    this._flashes = null;
    this._flashTex = null;
    this._flashDead = false;
    this._flashCursor = 0;
    this._beam = null;
    this._beamTTL = 0;
    this._beamMats = new Map();
  }

  _initFlashes() {
    this._flashes = [];
    new THREE.TextureLoader().load(
      FLASH_ATLAS_URL,
      (tex) => {
        if (this._flashDead) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        // 1120px NPOT atlas: mip generation costs upload time and the
        // sprites are always drawn near their native cell size.
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        this._flashTex = tex;
        for (const f of this._flashes) {
          // Each slot clones the texture so offset/repeat select its cell
          // per use; clones share the underlying image source, so the GPU
          // upload happens once.
          const t = tex.clone();
          t.repeat.set(1 / FLASH_COLS, 1 / FLASH_ROWS);
          f.sprite.material.map = t;
          f.sprite.material.needsUpdate = true;
        }
      },
      undefined,
      () => { this._flashDead = true; },   // offline build: no atlas, no flashes
    );
    for (let i = 0; i < MAX_FLASHES; i++) {
      const mat = new THREE.SpriteMaterial({
        map: null,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,   // the manifest's own instruction
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.layers.enable(GLOW_LAYER);     // skill VFX — the sanctioned glow
      this.scene.add(sprite);
      this._flashes.push({ sprite, life: 0, maxLife: 1, size: 1 });
    }
  }

  /**
   * One tinted atlas sprite that blooms and fades in place — the cast flash,
   * the bolt impact, the beam tick. `key` names a FLASH_SPRITES cell.
   */
  flash(pos, key, { size = 1, life = 0.25, color = 0xffffff } = {}) {
    if (this._flashDead) return;
    if (!this._flashes) this._initFlashes();
    const cell = FLASH_SPRITES[key];
    if (!cell) return;
    const f = this._flashes[this._flashCursor];
    this._flashCursor = (this._flashCursor + 1) % MAX_FLASHES;
    const m = f.sprite.material;
    if (m.map) {
      m.map.offset.set(cell[0] / FLASH_COLS, 1 - (cell[1] + 1) / FLASH_ROWS);
    }
    m.color.set(color);
    f.sprite.position.copy(pos);
    f.life = f.maxLife = life;
    f.size = size;
    // Visible even before the texture resolves: an untextured additive quad
    // for one frame is indistinguishable from the burst it rides with.
    f.sprite.visible = Boolean(m.map);
  }

  _beamMat(color) {
    let m = this._beamMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this._beamMats.set(color, m);
    }
    return m;
  }

  /**
   * Show the channel beam from `from` to `to` THIS frame. Callers refresh it
   * every frame they want it lit; update() hides it the moment refreshes
   * stop, so a caller that dies mid-channel cannot leave a beam in the air.
   * One unit box, stretched — created once, never disposed (cached material,
   * same recompile economics as the rings above).
   */
  beam(from, to, color = 0xb98bff) {
    if (!this._beam) {
      this._beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1), this._beamMat(color));
      this._beam.geometry.userData.shared = true;
      this._beam.layers.enable(GLOW_LAYER);
      this.scene.add(this._beam);
    }
    const b = this._beam;
    b.material = this._beamMat(color);
    const len = Math.max(0.1, from.distanceTo(to));
    b.position.copy(from).add(to).multiplyScalar(0.5);
    b.lookAt(to);
    b.scale.set(1, 1, len);
    b.visible = true;
    this._beamTTL = 0.05;   // ~3 frames of grace, then auto-hide
  }

  beamHide() {
    if (this._beam) this._beam.visible = false;
    this._beamTTL = 0;
  }

  burst(pos, count, color, opts = {}) {
    const {
      speed = 6, spread = 1, life = 0.6, size = 1, gravity = -12, up = 3,
    } = opts;
    this._c.set(color);
    for (let i = 0; i < count; i++) {
      const p = this.parts[this._cursor];
      this._cursor = (this._cursor + 1) % this.budget;
      p.life = p.maxLife = life * (0.6 + Math.random() * 0.7);
      p.pos.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.3) * spread;
      const sp = speed * (0.4 + Math.random() * 0.9);
      p.vel.set(Math.cos(a) * sp, up * Math.random() + el * sp, Math.sin(a) * sp);
      p.spin = (Math.random() - 0.5) * 14;
      p.size = size * (0.6 + Math.random() * 0.8);
      p.gravity = gravity;
      const idx = (this._cursor + this.budget - 1) % this.budget;
      this.mesh.instanceColor.setXYZ(idx, this._c.r, this._c.g, this._c.b);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  _ringMat(color) {
    let m = this._ringMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: SHOCK_OPACITY, side: THREE.DoubleSide, depthWrite: false,
      });
      this._ringMats.set(color, m);
    }
    return m;
  }

  ring(pos, color, maxRadius = 8, duration = 0.45) {
    let m = this._ringPool.pop();
    if (!m) {
      m = new THREE.Mesh(this._ringGeo, this._ringMat(color));
      m.rotation.x = -Math.PI / 2;
      m.layers.enable(GLOW_LAYER);
    } else {
      m.material = this._ringMat(color);
      m.visible = true;
    }
    m.position.copy(pos);
    m.position.y += 0.12;
    m.scale.setScalar(0.4);
    this.scene.add(m);
    this.rings.push({ mesh: m, t: 0, duration, maxRadius });
  }

  damageNumber(worldPos, amount, kind = '') {
    this._projected.copy(worldPos).project(this.camera);
    if (this._projected.z > 1) return;
    const x = (this._projected.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this._projected.y * 0.5 + 0.5) * window.innerHeight;
    const el = document.createElement('div');
    el.className = `dmg ${kind}`;
    el.textContent = kind === 'crit' ? `${amount}!` : amount;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this._dmgLayer.appendChild(el);
    setTimeout(() => el.remove(), 880);
  }

  setBudget(n) {
    // InstancedMesh.count is a free runtime clamp — no reallocation.
    this.budget = Math.max(24, Math.min(n, MAX_PARTICLES));
    this.mesh.count = this.budget;
  }

  addShake(amount) { this.shake = Math.min(1.2, this.shake + amount); }
  addHitStop(seconds) { this.hitStop = Math.max(this.hitStop, seconds); }

  update(dt) {
    // particles
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.parts[i];
      if (p.life <= 0) {
        // Park dead instances at origin with zero scale so they render as nothing.
        this._m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this._m);
        continue;
      }
      p.life -= dt;
      p.vel.y += p.gravity * dt;
      p.vel.multiplyScalar(1 - 1.6 * dt);
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.05) { p.pos.y = 0.05; p.vel.y = Math.abs(p.vel.y) * 0.35; p.vel.x *= 0.7; p.vel.z *= 0.7; }
      const t = Math.max(0, p.life / p.maxLife);
      const s = p.size * t;
      this._e.set(p.pos.x * p.spin, p.pos.y * p.spin, p.spin * (1 - t) * 3);
      this._q.setFromEuler(this._e);
      this._s.setScalar(s);
      this._m.compose(p.pos, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / r.duration;
      if (k >= 1) {
        this.scene.remove(r.mesh);
        // Recycle, never dispose — see the pool note in the constructor.
        this._ringPool.push(r.mesh);
        this.rings.splice(i, 1);
        continue;
      }
      const eased = 1 - Math.pow(1 - k, 2.4);
      r.mesh.scale.setScalar(0.4 + eased * r.maxRadius);
      const o = SHOCK_OPACITY * (1 - k);
      const prev = this._ringOpacity.get(r.mesh.material);
      if (prev === undefined || o > prev) this._ringOpacity.set(r.mesh.material, o);
    }
    this._ringOpacity.forEach((o, mat) => { mat.opacity = o; });
    this._ringOpacity.clear();

    // atlas flashes: bloom fast, fade linear
    if (this._flashes) {
      for (const f of this._flashes) {
        if (f.life <= 0) continue;
        f.life -= dt;
        if (f.life <= 0) { f.sprite.visible = false; continue; }
        const t = f.life / f.maxLife;                    // 1 -> 0
        const grow = 1 - (t * t);                        // ease-out bloom
        f.sprite.scale.setScalar(f.size * (0.5 + grow * 0.8));
        f.sprite.material.opacity = FLASH_OPACITY * t;
      }
    }

    // channel beam: auto-hide the moment refreshes stop arriving
    if (this._beamTTL > 0) {
      this._beamTTL -= dt;
      if (this._beamTTL <= 0 && this._beam) this._beam.visible = false;
    }

    // shake decay
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.6);
    if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);
  }

  applyShake(camera) {
    if (this.shake <= 0) return;
    const s = this.shake * this.shake * 0.55;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.position.z += (Math.random() - 0.5) * s;
  }
}
