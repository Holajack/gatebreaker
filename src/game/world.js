import * as THREE from 'three';
import { BIOMES } from './config.js';
import { buildBiomeEnvironment } from '../render/env.js';
import { makeSky } from '../render/sky.js';
import { GLOW_LAYER } from '../render/glow.js';

// Deterministic PRNG so a given seed always rebuilds the same gate layout.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _lightDir = new THREE.Vector3(18, 34, 12).normalize();
const _snapM = new THREE.Matrix4();
const _snapV = new THREE.Vector3();

export class World {
  constructor(scene, renderer, camera) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.obstacles = [];   // { pos: Vector3, radius: number }
    this.radius = 40;
    this._disposables = [];
  }

  clear() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      }
    });
    this.group.clear();
    this.obstacles.length = 0;
    this._disposables.forEach((d) => d.dispose?.());
    this._disposables.length = 0;
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    // The key light's depth map is a render target, not a mesh resource, so the
    // isMesh traversal above never saw it — one leaked depth texture per gate.
    this.key?.shadow?.map?.dispose();
    if (this.key?.shadow) this.key.shadow.map = null;
    this.scene.environment = null;
    this.sky = null;
    this.key = null;
  }

  build(gate, seed) {
    this.clear();
    const rnd = mulberry32(seed);
    const biome = BIOMES[gate.biome];
    this.radius = gate.arena / 2;
    this.biome = biome;

    // --- atmosphere ---
    this.scene.background = null;              // the dome is the background now
    this.scene.fog = new THREE.Fog(biome.fog, this.radius * 0.7, this.radius * 2.6);

    // Image-based lighting: this is what stops PBR geometry reading as flat.
    this.envRT = buildBiomeEnvironment(this.renderer, biome);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1.35;
    this.scene.environmentRotation.set(0, 0.4, 0);

    this.sky = makeSky(biome);
    this.group.add(this.sky);

    // --- ground ---
    const groundGeo = new THREE.CircleGeometry(this.radius, 72);
    groundGeo.rotateX(-Math.PI / 2);
    // Gentle vertex noise gives the floor some relief without a heightmap.
    const pos = groundGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const d = Math.hypot(x, z);
      const n = Math.sin(x * 0.16 + seed) * Math.cos(z * 0.14 - seed) * 0.5;
      pos.setY(i, d > this.radius * 0.97 ? 0 : n * 0.6);
    }
    groundGeo.computeVertexNormals();
    const ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshStandardMaterial({
        color: biome.ground, roughness: 0.92, metalness: 0.08,
        envMapIntensity: 0.7, flatShading: true, dithering: true,
      }),
    );
    ground.receiveShadow = true;
    this.group.add(ground);

    // --- glowing arena boundary (the rift membrane) ---
    const wallGeo = new THREE.CylinderGeometry(this.radius, this.radius, 9, 64, 1, true);
    const wallMat = new THREE.MeshBasicMaterial({
      color: biome.accent, transparent: true, opacity: 0.16,
      side: THREE.BackSide, depthWrite: false,
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = 4.5;
    this.group.add(wall);
    this.wall = wall;

    const rimGeo = new THREE.TorusGeometry(this.radius, 0.14, 8, 90);
    rimGeo.rotateX(Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: biome.accent }));
    rim.position.y = 0.1;
    rim.layers.enable(GLOW_LAYER);
    this.group.add(rim);

    // --- pillars / rubble: navigation obstacles the AI must path around ---
    const pillarCount = 10 + Math.floor(rnd() * 8);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: biome.pillar, roughness: 0.72, metalness: 0.15,
      envMapIntensity: 1.0, flatShading: true,
    });
    for (let i = 0; i < pillarCount; i++) {
      const a = rnd() * Math.PI * 2;
      const d = (0.28 + rnd() * 0.6) * this.radius;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = 3 + rnd() * 9;
      const r = 0.8 + rnd() * 1.7;
      const geo = new THREE.CylinderGeometry(r * 0.7, r, h, 5 + Math.floor(rnd() * 3));
      const m = new THREE.Mesh(geo, pillarMat);
      m.position.set(x, h / 2 - 0.4, z);
      m.rotation.y = rnd() * Math.PI;
      m.rotation.z = (rnd() - 0.5) * 0.12;
      m.castShadow = true;
      this.group.add(m);
      this.obstacles.push({ pos: new THREE.Vector3(x, 0, z), radius: r + 0.35 });
    }

    // --- low scatter rocks (pure decoration, no collision) ---
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: biome.pillar, roughness: 1, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 60);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (let i = 0; i < 60; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * this.radius * 0.95;
      const s = 0.2 + rnd() * 0.7;
      v.set(Math.cos(a) * d, s * 0.3, Math.sin(a) * d);
      e.set(rnd() * 3, rnd() * 3, rnd() * 3);
      q.setFromEuler(e);
      sc.set(s, s * 0.6, s);
      m4.compose(v, q, sc);
      rocks.setMatrixAt(i, m4);
    }
    rocks.instanceMatrix.needsUpdate = true;
    this.group.add(rocks);

    // --- floating shards drifting overhead ---
    const shardGeo = new THREE.OctahedronGeometry(0.5, 0);
    const shardMat = new THREE.MeshBasicMaterial({ color: biome.accent, transparent: true, opacity: 0.55 });
    this.shards = new THREE.InstancedMesh(shardGeo, shardMat, 44);
    this.shardData = [];
    for (let i = 0; i < 44; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * this.radius;
      this.shardData.push({
        base: new THREE.Vector3(Math.cos(a) * d, 3 + rnd() * 16, Math.sin(a) * d),
        phase: rnd() * Math.PI * 2,
        speed: 0.25 + rnd() * 0.6,
        scale: 0.3 + rnd() * 1.1,
        spin: (rnd() - 0.5) * 1.2,
      });
    }
    this.shards.layers.enable(GLOW_LAYER);
    this.group.add(this.shards);

    // --- lighting ---
    // The environment map now supplies ambient *with direction*, so a flat
    // AmbientLight would only double-count and wash the scene out.
    const hemi = new THREE.HemisphereLight(biome.accent, biome.ground, 0.5);
    this.group.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(18, 34, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    // normalBias offsets the sample along the surface normal instead of shifting
    // the depth comparison, so it kills acne without detaching contact shadows.
    key.shadow.bias = 0;
    key.shadow.normalBias = 0.035;
    this.group.add(key);
    this.group.add(key.target);   // without this its world matrix never updates
    this.key = key;

    // Back rim light, no shadow. Silhouette separation for almost nothing.
    const rimLight = new THREE.DirectionalLight(new THREE.Color(biome.accent), 1.1);
    rimLight.position.set(-14, 9, -22);
    this.group.add(rimLight);
    const fill = new THREE.PointLight(biome.accent, 1.5, this.radius * 1.8, 2);
    fill.position.set(0, 14, 0);
    this.group.add(fill);
    this.fillLight = fill;

    this._t = 0;
    return this;
  }

  /** Fit the shadow frustum tightly to the player and snap it to whole texels. */
  updateShadowCamera(target, extent = 14) {
    const key = this.key;
    if (!key || !key.castShadow) return;
    const cam = key.shadow.camera;
    if (cam.right !== extent) {
      cam.left = -extent; cam.right = extent;
      cam.top = extent; cam.bottom = -extent;
      cam.near = 1; cam.far = extent * 4.5;
      cam.updateProjectionMatrix();
    }
    // Quantise to shadow texels, else the depth map resamples every frame and
    // every shadow edge shimmers as the player walks.
    const texel = (extent * 2) / key.shadow.mapSize.x;
    _snapM.lookAt(_lightDir, new THREE.Vector3(0, 0, 0), THREE.Object3D.DEFAULT_UP);
    _snapV.copy(target).applyMatrix4(_snapM);
    _snapV.x = Math.round(_snapV.x / texel) * texel;
    _snapV.y = Math.round(_snapV.y / texel) * texel;
    _snapV.applyMatrix4(_snapM.invert());
    key.target.position.copy(_snapV);
    key.position.copy(_snapV).addScaledVector(_lightDir, extent * 2.6);
    key.target.updateMatrixWorld();
    key.updateMatrixWorld();
  }

  update(dt) {
    this._t += dt;
    if (this.sky) {
      this.sky.material.uniforms.uTime.value = this._t;
      if (this.camera) { this.sky.position.copy(this.camera.position); this.sky.updateMatrix(); }
    }
    if (this.shards) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const v = new THREE.Vector3();
      const s = new THREE.Vector3();
      for (let i = 0; i < this.shardData.length; i++) {
        const d = this.shardData[i];
        v.copy(d.base);
        v.y += Math.sin(this._t * d.speed + d.phase) * 1.6;
        e.set(this._t * d.spin, this._t * d.spin * 0.7, 0);
        q.setFromEuler(e);
        s.setScalar(d.scale);
        m.compose(v, q, s);
        this.shards.setMatrixAt(i, m);
      }
      this.shards.instanceMatrix.needsUpdate = true;
    }
    if (this.wall) {
      this.wall.material.opacity = 0.13 + Math.sin(this._t * 1.5) * 0.05;
    }
    if (this.fillLight) {
      this.fillLight.intensity = 1.4 + Math.sin(this._t * 2.1) * 0.35;
    }
  }

  // Push a position out of any obstacle and keep it inside the arena.
  // Pass `vel` to also deflect motion along the surface: without that, walking
  // straight at a pillar cancels itself out and the character sticks fast
  // instead of sliding around the edge.
  resolve(pos, radius, vel = null) {
    const slide = (nx, nz) => {
      if (!vel) return;
      const into = vel.x * nx + vel.z * nz;
      if (into >= 0) return;
      // Only strip the component pushing into the surface; keep the tangent.
      vel.x -= nx * into;
      vel.z -= nz * into;
      // A perfectly head-on approach leaves no tangent to slide along, which
      // reads as the character snagging on scenery. Nudge them around it.
      const tangent = Math.hypot(vel.x, vel.z);
      const push = Math.abs(into);
      if (tangent < push * 0.2) {
        // Always deflect the same way round, so the nudge can't flip sign
        // between frames and leave the character vibrating against a wall.
        vel.x += -nz * push * 0.6;
        vel.z += nx * push * 0.6;
      }
    };

    for (const o of this.obstacles) {
      const dx = pos.x - o.pos.x;
      const dz = pos.z - o.pos.z;
      const min = o.radius + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      let nx, nz;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        nx = dx / d; nz = dz / d;
      } else {
        // Dead centre: no meaningful push direction, so pick a fixed one.
        // Otherwise anything spawned on a pillar's origin is stuck forever.
        nx = 1; nz = 0;
      }
      pos.x = o.pos.x + nx * min;
      pos.z = o.pos.z + nz * min;
      slide(nx, nz);
    }

    const lim = this.radius - radius - 0.6;
    const dist = Math.hypot(pos.x, pos.z);
    if (dist > lim && dist > 0.0001) {
      const nx = -pos.x / dist, nz = -pos.z / dist; // inward normal at the wall
      pos.x = (pos.x / dist) * lim;
      pos.z = (pos.z / dist) * lim;
      slide(nx, nz);
    }
  }

  randomSpawn(rnd, minDistFrom, minDist = 14) {
    for (let i = 0; i < 30; i++) {
      const a = rnd() * Math.PI * 2;
      const d = (0.35 + rnd() * 0.6) * this.radius;
      const p = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
      if (!minDistFrom || p.distanceTo(minDistFrom) > minDist) return p;
    }
    const a = rnd() * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * this.radius * 0.8, 0, Math.sin(a) * this.radius * 0.8);
  }
}
