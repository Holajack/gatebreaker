import * as THREE from 'three';
import { makeCharacter, charactersReady } from '../render/characters.js';

// ---------------------------------------------------------------------------
// CITIZENS — the ambient crowd of Threshold
// ---------------------------------------------------------------------------
// A hub with six portals and nobody in it reads as a diorama; the playtest
// asked for a city that feels lived in. This module owns that crowd and
// NOTHING else: no combat, no health, no interaction prompts. The City builds
// it, ticks it and disposes it — citizens never outlive the place they walk.
//
// Three design rules, each load-bearing:
//
// 1. CITIZENS ARE SET DRESSING, NOT ENTITIES. They are not in game.enemies,
//    they carry no colliders, and the player walks THROUGH one (with a polite
//    sidestep from the citizen) rather than being body-blocked in his own hub.
//    The sidestep is one-way: citizens move for the player, never the reverse.
//
// 2. THE SKINNED PACK IS A BUDGET, NOT A PROMISE. makeCharacter refuses past
//    the quality tier's cap (8 on low), and characters.glb may not have
//    shipped at all — both degrade to a procedural villager built here, so an
//    offline APK still has a populated hub. The procedural body deliberately
//    has NO glow, NO emissive eye mote: the telegraph flare is combat
//    language and these people are not combatants.
//
// 3. NO PER-FRAME ALLOCATION. Sixteen NPCs tick inside City.update on a
//    phone; everything below steers with scalar math on pre-built records.

const COUNT = 16;               // 12-20 per the brief; 16 fits the medium tier
const WALK_RADIUS = 0.4;        // resolve() radius — same slot a player uses
const AVOID_PLAYER = 1.7;       // start sidestepping inside this range
const SEPARATE = 0.8;           // citizens keep this much air between them
const SOCIAL_RANGE = 2.4;       // two walkers this close may stop and chat
const SOCIAL_COOLDOWN = 14;     // seconds before the same citizen chats again
const TURN_RATE = 5.0;          // rad/s — unhurried, nobody here is kiting

// state machine
const WALK = 0;
const IDLE = 1;
const WAVE = 2;

// The roster. Civilian archetypes were banned as ENEMIES (fighting a man in
// beach shorts undermined the tone); as townsfolk they are exactly right.
// Hunters use the soldier/medieval pools so the plaza reads as a guild town.
// Seeds repeat on purpose: two citizens sharing a seed share one merged
// geometry in characters.js's refcounted cache, which caps both build time
// and resident memory no matter what COUNT is raised to.
const ROSTER = [];
for (let i = 0; i < 10; i++) ROSTER.push({ archetype: 'grunt', seed: `citizen:${i % 8}`, hunter: false });
for (let i = 0; i < 3; i++) ROSTER.push({ archetype: 'lancer', seed: `hunter:${i}`, hunter: true });
for (let i = 0; i < 3; i++) ROSTER.push({ archetype: 'stalker', seed: `hunter:${3 + i}`, hunter: true });

export class Citizens {
  constructor(city) {
    this.city = city;
    this.group = new THREE.Group();
    this.group.name = 'city_citizens';
    this.npcs = [];
    this._t = 0;
    this._scanT = 0;
    this._rnd = null;
    this._ownedGeometries = [];
    this._ownedMaterials = [];
    this._procMat = null;
  }

  // ------------------------------------------------------------------ build

  build(rnd) {
    this._rnd = rnd;
    const count = Math.min(COUNT, ROSTER.length);
    for (let i = 0; i < count; i++) {
      const spec = ROSTER[i];
      const npc = this._spawn(spec, rnd);
      if (npc) this.npcs.push(npc);
    }
    this.city.group.add(this.group);
  }

  _spawn(spec, rnd) {
    const city = this.city;
    // Stand on a street. Streets are where the wandering happens, so spawning
    // on one guarantees the first waypoint is reachable without pathfinding.
    let x = 0, z = 20;
    for (let tries = 0; tries < 12; tries++) {
      const w = this._pickPoint(spec.hunter, rnd);
      let clear = true;
      for (const o of this.npcs) {
        const dx = w.x - o.pos.x, dz = w.z - o.pos.z;
        if (dx * dx + dz * dz < 9) { clear = false; break; }
      }
      if (clear || tries === 11) { x = w.x; z = w.z; break; }
    }

    const scale = 0.93 + rnd() * 0.1;
    let inst = null;
    if (charactersReady()) {
      inst = makeCharacter({
        seed: spec.seed,
        archetype: spec.archetype,
        scale,
        // No mote, no rim, no tint: a citizen is lit like everyone else and
        // glows like nobody. The pack palette is all the variety needed.
        glow: 0xffffff,
        color: 0xffffff,
        eyes: false,
        armed: false,
      });
    }
    const root = inst ? inst.root : this._buildVillager(rnd, scale);
    if (!root) return null;
    // Citizens cast NO shadow, ever. Not (only) for fill rate: a skinned
    // caster lazily compiles a skinned depth-material program the first time
    // it enters the shadow frustum, and tools/city-test.mjs rightly treats
    // any program-count growth mid-walk as the PointLight-recompile bug. A
    // contact shadow on set dressing is not worth reopening that class of
    // hitch on a phone.
    if (inst) inst.mesh.castShadow = false;

    const npc = {
      root,
      inst,                                     // null = procedural body
      rig: inst ? null : root.userData.villagerRig,
      pos: new THREE.Vector3(x, city.heightAt(x, z), z),
      yaw: rnd() * 6.283,
      speed: (spec.hunter ? 1.3 : 1.05) + rnd() * 0.35,
      state: IDLE,
      stateT: rnd() * 2,
      tx: x, tz: z,
      social: rnd() * SOCIAL_COOLDOWN,          // desynchronise first chats
      stuckT: 0,
      hunter: spec.hunter,
      phase: rnd() * 6.283,
    };
    city.resolve(npc.pos, WALK_RADIUS);
    npc.pos.y = city.heightAt(npc.pos.x, npc.pos.z);
    root.position.copy(npc.pos);
    root.rotation.y = npc.yaw;
    this.group.add(root);
    return npc;
  }

  /** A random spot on the street network. Civilians stay inside the walls. */
  _pickPoint(hunter, rnd, near = null, out = _wp) {
    const streets = this.city.streets;
    // The plaza is not a street, so a street-only wander never crosses it —
    // and the plaza is the one place the player is guaranteed to stand.
    // About a fifth of all legs cut across the flagstones instead.
    if (rnd() < 0.22) {
      const a = rnd() * 6.283;
      const r = 6 + rnd() * 17;
      out.x = Math.cos(a) * r;
      out.z = -Math.sin(a) * r;
      return out;
    }
    for (let tries = 0; tries < 8; tries++) {
      const s = streets[Math.floor(rnd() * streets.length) % streets.length];
      // The Breach road is outside the wall and ends at an S-rank rift;
      // window-shopping civilians have no business there. Hunters do.
      if (!hunter && (s.z1 < -88 || s.z2 < -88)) continue;
      const t = rnd();
      const lat = (rnd() - 0.5) * s.w * 0.9;
      const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
      const len = Math.hypot(dx, dz) || 1;
      const x = s.x1 + dx * t - (dz / len) * lat;
      const z = s.z1 + dz * t + (dx / len) * lat;
      // Wander locally. A citizen crossing the whole town in one leg spends
      // his life in transit and the streets never look occupied.
      if (near && Math.hypot(x - near.x, z - near.z) > 55 && tries < 7) continue;
      // Bias the crowd toward the centre: the plaza and the four avenues are
      // where the player actually stands, and sixteen people spread over
      // 340 m of map is an empty town from any one spot. Outer targets are
      // accepted with one-in-three odds, so the edges stay visited but the
      // core stays busy.
      if (Math.hypot(x, z) > 62 && rnd() < 0.67 && tries < 7) continue;
      out.x = x; out.z = z;
      return out;
    }
    out.x = 0; out.z = 20;
    return out;
  }

  // ---------------------------------------------------- procedural fallback

  /**
   * The no-GLB villager: a flat-shaded box-person in townsfolk colours.
   * Deliberately plainer than the enemy box-man in entities.js — no glowing
   * visor, no weapon — because those read as combat cues and this is a
   * bystander. Geometries are cached per palette entry on this Citizens
   * instance and disposed with it.
   */
  _buildVillager(rnd, scale) {
    if (!this._procMat) {
      this._procMat = new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0.0,
      });
      this._ownedMaterials.push(this._procMat);
    }
    const PALETTE = [
      { shirt: 0x8a6f4d, pants: 0x4a4438 }, { shirt: 0x6d7a8a, pants: 0x3d3a33 },
      { shirt: 0x7a8a5c, pants: 0x4d4030 }, { shirt: 0x9a7a6a, pants: 0x37404a },
      { shirt: 0x707a66, pants: 0x494036 }, { shirt: 0x8a8060, pants: 0x403a44 },
    ];
    const v = Math.floor(rnd() * PALETTE.length) % PALETTE.length;
    const p = PALETTE[v];
    const skin = 0xc9a482;

    const geo = (key, make) => {
      const k = `${key}:${v}`;
      let g = this._procGeo?.get(k);
      if (!g) {
        if (!this._procGeo) this._procGeo = new Map();
        g = make();
        this._procGeo.set(k, g);
        this._ownedGeometries.push(g);
      }
      return g;
    };
    const paint = (g, hex) => {
      const c = new THREE.Color(hex);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    };

    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const torso = new THREE.Mesh(geo('torso', () => {
      const g = new THREE.BoxGeometry(0.5, 0.62, 0.28);
      g.translate(0, 1.22, 0);
      return paint(g, p.shirt);
    }), this._procMat);
    body.add(torso);

    const head = new THREE.Mesh(geo('head', () => {
      const g = new THREE.BoxGeometry(0.26, 0.28, 0.26);
      g.translate(0, 1.71, 0);
      return paint(g, skin);
    }), this._procMat);
    body.add(head);

    const armGeo = geo('arm', () => {
      const g = new THREE.BoxGeometry(0.13, 0.58, 0.13);
      g.translate(0, -0.26, 0);
      return paint(g, p.shirt);
    });
    const legGeo = geo('leg', () => {
      const g = new THREE.BoxGeometry(0.16, 0.9, 0.16);
      g.translate(0, -0.42, 0);
      return paint(g, p.pants);
    });
    const armL = new THREE.Group(); armL.position.set(-0.33, 1.48, 0);
    const armR = new THREE.Group(); armR.position.set(0.33, 1.48, 0);
    armL.add(new THREE.Mesh(armGeo, this._procMat));
    armR.add(new THREE.Mesh(armGeo, this._procMat));
    const legL = new THREE.Group(); legL.position.set(-0.14, 0.9, 0);
    const legR = new THREE.Group(); legR.position.set(0.14, 0.9, 0);
    legL.add(new THREE.Mesh(legGeo, this._procMat));
    legR.add(new THREE.Mesh(legGeo, this._procMat));
    body.add(armL, armR, legL, legR);

    root.scale.setScalar(scale);
    root.userData.villagerRig = { body, armL, armR, legL, legR };
    return root;
  }

  // -------------------------------------------------------------- per frame

  update(dt, playerPos) {
    const npcs = this.npcs;
    if (!npcs.length) return;
    const city = this.city;
    const t = (this._t += dt);

    // Pairwise pass: separation every frame (128 distance checks for 16 NPCs
    // — cheaper than one bone-matrix upload), chats decided in the same loop.
    for (let i = 0; i < npcs.length; i++) {
      const a = npcs[i];
      for (let j = i + 1; j < npcs.length; j++) {
        const b = npcs[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < SEPARATE * SEPARATE && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = ((SEPARATE - d) / d) * 0.5;
          a.pos.x -= dx * push; a.pos.z -= dz * push;
          b.pos.x += dx * push; b.pos.z += dz * push;
        } else if (
          d2 < SOCIAL_RANGE * SOCIAL_RANGE
          && a.state === WALK && b.state === WALK
          && a.social <= 0 && b.social <= 0
        ) {
          // Two walkers meet: stop, face each other, one may wave. This tiny
          // beat is most of what "the city is alive" costs.
          a.social = SOCIAL_COOLDOWN + this._rnd() * 6;
          b.social = SOCIAL_COOLDOWN + this._rnd() * 6;
          a.yaw = Math.atan2(dx, dz);
          b.yaw = Math.atan2(-dx, -dz);
          const dur = 2.2 + this._rnd() * 2.2;
          this._setState(a, this._rnd() < 0.6 ? WAVE : IDLE, dur);
          this._setState(b, IDLE, dur);
        }
      }
    }

    for (const n of npcs) {
      n.social -= dt;
      n.stateT -= dt;
      let moving = false;

      if (n.state === WALK) {
        const dx = n.tx - n.pos.x;
        const dz = n.tz - n.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.3) {
          if (this._rnd() < 0.3) this._setState(n, IDLE, 1.5 + this._rnd() * 3);
          else this._newTarget(n);
        } else {
          const want = Math.atan2(dx, dz);
          let diff = want - n.yaw;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          n.yaw += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, diff));
          const step = n.speed * dt;
          n.pos.x += Math.sin(n.yaw) * step;
          n.pos.z += Math.cos(n.yaw) * step;
          moving = true;
          // Wedged against a building or another curiosity: shrug, go
          // somewhere else. Citizens have nowhere they NEED to be.
          const px = n.pos.x, pz = n.pos.z;
          city.resolve(n.pos, WALK_RADIUS);
          const pushed = Math.hypot(n.pos.x - px, n.pos.z - pz);
          n.stuckT = pushed > step * 0.55 ? n.stuckT + dt : 0;
          if (n.stuckT > 1.2) { n.stuckT = 0; this._newTarget(n); }
        }
      } else if (n.stateT <= 0) {
        this._newTarget(n);
        this._setState(n, WALK, 0);
      }

      // The polite sidestep. One-way: the citizen yields, the player's own
      // physics never sees the citizen at all.
      if (playerPos) {
        const dx = n.pos.x - playerPos.x;
        const dz = n.pos.z - playerPos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < AVOID_PLAYER * AVOID_PLAYER && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const k = ((AVOID_PLAYER - d) / d) * Math.min(1, dt * 6);
          n.pos.x += dx * k;
          n.pos.z += dz * k;
          city.resolve(n.pos, WALK_RADIUS);
        }
      }

      n.pos.y = city.heightAt(n.pos.x, n.pos.z);
      n.root.position.copy(n.pos);
      n.root.rotation.y = n.yaw;

      if (n.inst) {
        if (n.state === WAVE) n.inst.update(dt);   // let the Wave clip finish
        else n.inst.animate({ moving, speed: n.speed, dt });
      } else {
        this._animateVillager(n, t, moving);
      }
    }
  }

  _setState(n, state, dur) {
    if (state === WAVE) {
      // Wave is a skinned-clip luxury; the box villager just stands. clamp
      // holds the final frame — an unclamped LoopOnce action disables itself
      // when it finishes and the skeleton snaps to bind pose for a beat.
      if (n.inst && n.inst.play('wave', { once: true, clamp: true })) {
        n.state = WAVE;
        n.stateT = Math.max(0.9, n.inst.clipDuration('wave'));
        return;
      }
      state = IDLE;
    }
    n.state = state;
    n.stateT = dur;
    if (state === IDLE && n.inst) n.inst.play('idle', { fade: 0.2 });
  }

  _newTarget(n) {
    const w = this._pickPoint(n.hunter, this._rnd, n.pos);
    n.tx = w.x; n.tz = w.z;
    n.state = WALK;
    n.stateT = 0;
  }

  /** The whole procedural gait: swing limbs, bob a little. */
  _animateVillager(n, t, moving) {
    const rig = n.rig;
    if (!rig) return;
    if (moving) {
      const cyc = (t + n.phase) * 5.2;
      const s = Math.sin(cyc) * 0.55;
      rig.legL.rotation.x = s;
      rig.legR.rotation.x = -s;
      rig.armL.rotation.x = -s * 0.7;
      rig.armR.rotation.x = s * 0.7;
      rig.body.position.y = Math.abs(Math.sin(cyc)) * 0.035;
    } else {
      const idle = Math.sin((t + n.phase) * 1.6);
      rig.legL.rotation.x *= 0.8;
      rig.legR.rotation.x *= 0.8;
      rig.armL.rotation.x = idle * 0.06 - 0.03;
      rig.armR.rotation.x = -idle * 0.06 - 0.03;
      rig.body.position.y = idle * 0.02;
    }
  }

  // --------------------------------------------------------------- teardown

  dispose() {
    for (const n of this.npcs) {
      // CharacterInstance.dispose releases the refcounted merged geometry and
      // the per-instance skeleton bone texture — the two leaks a plain
      // traversal cannot see.
      if (n.inst) n.inst.dispose();
      n.root.removeFromParent();
    }
    this.npcs.length = 0;
    this.group.removeFromParent();
    for (const g of this._ownedGeometries) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedGeometries.length = 0;
    this._ownedMaterials.length = 0;
    this._procGeo = null;
    this._procMat = null;
  }

  get stats() {
    let skinned = 0;
    for (const n of this.npcs) if (n.inst) skinned++;
    return { count: this.npcs.length, skinned, procedural: this.npcs.length - skinned };
  }
}

const _wp = { x: 0, z: 0 };
