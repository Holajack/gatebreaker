import * as THREE from 'three';
import { Terrain, mulberry32 } from './terrain.js';
import { GATES } from '../game/config.js';

// The explorable hub. One seeded heightfield, scattered landmarks, and a rift
// gate for each dungeon rank placed further out as the ranks get harder — so
// walking toward the horizon is itself the difficulty curve.

const GRASS_LIMIT = 2600;
const ROCK_LIMIT = 420;

export class Overworld {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.terrain = null;
    this.gates = [];
    this.obstacles = [];      // { pos, radius } for collision
    this.built = false;
    this._t = 0;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      }
    });
    this.group.clear();
    this.gates.length = 0;
    this.obstacles.length = 0;
    this.built = false;
  }

  build(seed = 20260804) {
    this.dispose();
    this.terrain = new Terrain({ seed, size: 460, maxHeight: 34 });
    const rnd = mulberry32(seed ^ 0x9e37);
    const q = this.quality.current;

    this._buildGround(q);
    this._buildRocks(rnd, q);
    this._buildMonoliths(rnd);
    this._buildGates(rnd);
    this.built = true;
    return this;
  }

  // ---------------------------------------------------------------- ground
  _buildGround(q) {
    // Resolution scales with quality; the height function is the same either
    // way so collision never disagrees with what you can see.
    const segs = q.name === 'low' ? 96 : q.name === 'medium' ? 144 : 192;
    const geo = new THREE.PlaneGeometry(this.terrain.size, this.terrain.size, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const lowland = new THREE.Color(0x2b3358);
    const upland = new THREE.Color(0x3d4470);
    const rock = new THREE.Color(0x555a7a);
    const rift = new THREE.Color(0x5b3f9c);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.terrain.height(x, z);
      pos.setY(i, h);

      // Tint by elevation, then blend toward rock on steep faces and toward
      // rift purple near the rim, so the boundary reads as corrupted ground.
      const t = Math.max(0, Math.min(1, (h + 2) / 26));
      c.copy(lowland).lerp(upland, t);
      const s = Math.max(0, Math.min(1, this.terrain.slope(x, z) / 0.6));
      c.lerp(rock, s * 0.75);
      const r = this.terrain.rim(x, z);
      if (r > 0.6) c.lerp(rift, Math.min(1, (r - 0.6) / 0.4) * 0.5);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.96, metalness: 0.02, flatShading: false,
      }),
    );
    mesh.receiveShadow = true;
    this.ground = mesh;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- props
  _buildRocks(rnd, q) {
    const count = Math.floor(ROCK_LIMIT * (q.name === 'low' ? 0.45 : q.name === 'medium' ? 0.75 : 1));
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a5070, roughness: 0.95, flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();

    let placed = 0;
    for (let i = 0; i < count * 4 && placed < count; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 18 + rnd() * (this.terrain.half * 0.88 - 18);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = this.terrain.height(x, z);
      const scale = 0.7 + rnd() * 3.4;
      v.set(x, h + scale * 0.25, z);
      e.set(rnd() * 3, rnd() * 3, rnd() * 3);
      qt.setFromEuler(e);
      s.set(scale, scale * (0.6 + rnd() * 0.6), scale);
      m.compose(v, qt, s);
      mesh.setMatrixAt(placed, m);
      // Only the big ones block movement; pebbles shouldn't snag the player.
      if (scale > 2.1) this.obstacles.push({ pos: new THREE.Vector3(x, 0, z), radius: scale * 0.75 });
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  _buildMonoliths(rnd) {
    // Tall landmarks on the skyline give the player something to navigate by.
    const geo = new THREE.CylinderGeometry(1.1, 1.7, 16, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2f2a4d, roughness: 0.72, metalness: 0.18, flatShading: true,
      emissive: new THREE.Color(0x3a2b7a), emissiveIntensity: 0.22,
    });
    const count = 22;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.castShadow = true;
    const m = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();

    let placed = 0;
    for (let i = 0; i < count * 5 && placed < count; i++) {
      const spot = this.terrain.findSpot(rnd, 40, this.terrain.half * 0.85, 12);
      if (!spot) continue;
      const scale = 0.8 + rnd() * 1.5;
      v.set(spot.x, spot.y + 8 * scale - 1.5, spot.z);
      e.set((rnd() - 0.5) * 0.16, rnd() * Math.PI, (rnd() - 0.5) * 0.16);
      qt.setFromEuler(e);
      s.set(scale, scale, scale);
      m.compose(v, qt, s);
      mesh.setMatrixAt(placed, m);
      this.obstacles.push({ pos: new THREE.Vector3(spot.x, 0, spot.z), radius: 1.8 * scale });
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- gates
  _buildGates(rnd) {
    // Ranks radiate outward: E near spawn, S at the far rim. Distance from
    // home is the difficulty gradient, so exploring further always means
    // meeting something worse.
    const inner = 46;
    const outer = this.terrain.half * 0.84;

    GATES.forEach((gate, i) => {
      const t = i / (GATES.length - 1);
      const ringMin = inner + t * (outer - inner) * 0.92;
      const ringMax = ringMin + 26;
      const spot = this.terrain.findSpot(rnd, ringMin, ringMax) || { x: ringMin, z: 0, y: 0 };

      const root = new THREE.Group();
      root.position.set(spot.x, spot.y, spot.z);

      const accent = new THREE.Color(GATE_TINT[gate.rank] ?? 0x7c5cff);

      // The portal disc — a flat swirling plane inside a stone arch.
      const portal = new THREE.Mesh(
        new THREE.CircleGeometry(3.4, 32),
        new THREE.MeshBasicMaterial({
          color: accent, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
        }),
      );
      portal.position.y = 4.0;
      root.add(portal);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.6, 0.32, 10, 40),
        new THREE.MeshStandardMaterial({
          color: 0x1d1b33, roughness: 0.5, metalness: 0.5,
          emissive: accent, emissiveIntensity: 0.85,
        }),
      );
      ring.position.y = 4.0;
      ring.castShadow = true;
      root.add(ring);

      // Base platform so the gate reads as built, not floating.
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(5.2, 6.0, 1.0, 8),
        new THREE.MeshStandardMaterial({ color: 0x272c48, roughness: 0.9, flatShading: true }),
      );
      base.position.y = 0.1;
      base.receiveShadow = true;
      root.add(base);

      const glow = new THREE.PointLight(accent, 3.2, 26, 2);
      glow.position.y = 4.2;
      root.add(glow);

      // Ground marker ring, visible from a long way off.
      const marker = new THREE.Mesh(
        new THREE.RingGeometry(6.4, 7.2, 40),
        new THREE.MeshBasicMaterial({
          color: accent, transparent: true, opacity: 0.45,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.y = 0.72;
      root.add(marker);

      this.group.add(root);
      this.gates.push({
        index: i,
        gate,
        root,
        portal,
        ring,
        glow,
        marker,
        accent,
        pos: new THREE.Vector3(spot.x, spot.y, spot.z),
        radius: 7.0,          // how close you must be to enter
        phase: rnd() * 6.28,
      });
      // Keep the player from walking through the arch itself.
      this.obstacles.push({ pos: new THREE.Vector3(spot.x, 0, spot.z), radius: 1.2 });
    });
  }

  /** The gate the player is standing in, or null. */
  gateAt(pos) {
    for (const g of this.gates) {
      const dx = pos.x - g.pos.x;
      const dz = pos.z - g.pos.z;
      if (dx * dx + dz * dz < g.radius * g.radius) return g;
    }
    return null;
  }

  nearestGate(pos) {
    let best = null, bestD = Infinity;
    for (const g of this.gates) {
      const d = Math.hypot(pos.x - g.pos.x, pos.z - g.pos.z);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best ? { gate: best, distance: bestD } : null;
  }

  update(dt, playerPos) {
    this._t += dt;
    for (const g of this.gates) {
      // Portals shimmer and slowly rotate; the marker pulses so it catches the
      // eye at distance without needing a minimap.
      g.portal.rotation.z += dt * 0.35;
      g.portal.material.opacity = 0.45 + Math.sin(this._t * 1.6 + g.phase) * 0.16;
      g.ring.rotation.z -= dt * 0.12;
      const pulse = 0.5 + Math.sin(this._t * 2.1 + g.phase) * 0.5;
      g.marker.material.opacity = 0.28 + pulse * 0.3;
      g.glow.intensity = 2.6 + pulse * 1.4;

      if (playerPos) {
        // Cull distant gate lights — point lights are the expensive part.
        const d = playerPos.distanceTo(g.pos);
        g.glow.visible = d < 90;
      }
    }
  }

  /** Push a position out of world props and keep it inside the bowl. */
  resolve(pos, radius, vel = null) {
    const slide = (nx, nz) => {
      if (!vel) return;
      const into = vel.x * nx + vel.z * nz;
      if (into >= 0) return;
      vel.x -= nx * into;
      vel.z -= nz * into;
      const tangent = Math.hypot(vel.x, vel.z);
      const push = Math.abs(into);
      if (tangent < push * 0.2) {
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
        // Dead centre: there is no meaningful direction to push along, so pick
        // a fixed one. Without this an entity spawned exactly on a prop's
        // origin can never escape it.
        nx = 1; nz = 0;
      }
      pos.x = o.pos.x + nx * min;
      pos.z = o.pos.z + nz * min;
      slide(nx, nz);
    }

    if (this.terrain.clampToWorld(pos, radius + 2)) {
      const d = Math.hypot(pos.x, pos.z) || 1;
      slide(-pos.x / d, -pos.z / d);
    }
  }

  heightAt(x, z) {
    return this.terrain.height(x, z);
  }
}

const GATE_TINT = {
  E: 0x8b97c9,
  D: 0x2ad4c0,
  C: 0x4ade80,
  B: 0xa78bfa,
  A: 0xffc24b,
  S: 0xff4d6d,
};
