import * as THREE from 'three';
import { GameMode, registerMode } from './mode.js';
import { City, DISTRICTS, PORTAL_COLORS } from '../../world/city.js';
import { CityUI } from '../../ui/cityui.js';
import { FLAT_GROUND } from '../physics.js';
import { animateRig } from '../entities.js';
import { GATES } from '../config.js';

// How far past a portal's own radius the prompt still shows. Generous, because
// a phone player steers with a thumb and "stand exactly here" is not a thing
// you can ask of one.
const PROMPT_SLACK = 2.2;

// city.js drops the ground to y = -34 west of x = -88 so the world ends in a
// view rather than a fence, and puts a parapet along the walled stretch of that
// edge. The parapet does not run the whole length — north of the wall, on the
// Breach road, you can walk straight off — and 34 m down there is no way back
// up. Nothing walkable inside the town is below this line, so anything under it
// is out of the world and gets carried home.
const VOID_Y = -10;

// Where the camera rests relative to the player when the orbit is untouched.
// Movement is camera-relative (input.sampleWorld rotates the stick through the
// drag yaw), so the player is free to swing this rig around Y without the
// controls inverting — the old "never rotate the city camera" rule died with
// the world-relative stick.
// Same 45° pitch as the arena camera (game.js's camOffset is 0,11,11) but
// CLOSER. Pulling back to see more of the town was the first attempt and it
// made the plaza read as a car park; matching the arena distance was the
// second, and at 11,11 the hero projects to ~75 px on a 720 p frame — a speck
// in an empty plaza. 8,8 puts him at ~105 px, readable, while the streets keep
// enough depth to navigate by. Buildings are handled by the boom probe below,
// not by backing off.
const CAM_OFFSET = new THREE.Vector3(0, 8, 8);
// Boom floor when a building blocks the probe. Scaled with CAM_OFFSET (was 5.0
// at 11,11) so a blocked boom retreats to the same fraction of its full length
// instead of jumping to half of it.
const CAM_MIN = 3.6;
const CAM_PROBE_STEPS = 7;
const EYE = 1.55;             // where the collision probe leaves the body

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _want = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();

/**
 * The hub. Walk the streets, read the portals, step through one.
 *
 * No combat, no enemies, no spawns. The only things this mode simulates are the
 * player's body, the camera, and which sign you are standing in front of.
 */
export class CityMode extends GameMode {
  constructor(game) {
    super(game);
    this.city = null;
    this.ui = null;
    this._prompt = null;
    this._seed = 20260806;
    this._cam = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camReady = false;
    this._compassT = 0;

    // Bound once. physics.js calls these every step and an inline arrow here
    // would allocate two closures per entity per frame.
    this._height = (x, z) => (this.city ? this.city.heightAt(x, z) : 0);
    this._resolve = (pos, radius, vel) => this.city?.resolve(pos, radius, vel);
    this._normal = (x, z, out) => (this.city
      ? this.city.groundNormal(x, z, out)
      : (out ? Object.assign(out, { x: 0, y: 1, z: 0 }) : { x: 0, y: 1, z: 0 }));
  }

  get name() { return 'city'; }

  // The hub is a place you stand around in. Half the frame rate of a gate is
  // half the battery, and nothing here is reaction-timed.
  get targetFps() { return 30; }

  get prompt() { return this._prompt; }

  // ------------------------------------------------------------------ mount

  enter({ spawnAt = null, atPortal = null } = {}) {
    const g = this.game;

    g.frameClock?.setTarget(30);
    g.quality?.setTargetFps(30);

    if (!this.city) this.city = new City(g.scene, g.renderer, g.camera, g.quality);
    this.city.build(this._seed, g.save);
    this.refreshPortalLocks();

    if (!this.ui) {
      this.ui = new CityUI({ onConfirm: () => this.confirmPrompt() });
    }
    this.ui.show(true);
    g.ui.showHud(true);

    // The body was built for the flat arena; the city is a heightfield with
    // real walls. physics.js was designed for exactly this swap.
    const p = g.player;
    p.body.setEnvironment(this._height, this._resolve, this._normal);
    p.alive = true;
    p.hurt = 0;
    p.swing = 0;
    p.invuln = 0;
    p.mesh.visible = true;

    const spot = this._spawnVector(spawnAt, atPortal);
    p.body.reset(spot.x, this.city.heightAt(spot.x, spot.z), spot.z);
    p.yaw = Math.atan2(-spot.x, -spot.z);   // face the plaza centre
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = p.yaw;

    // Snap the camera rather than sweeping it in from wherever the last gate
    // left it — a 200 m lerp across the map reads as a bug. The orbit resets
    // with it: a yaw dragged inside a gate must not whip the hub camera.
    g.input.resetLook?.();
    this._camLook.copy(p.pos);
    this._camLook.z -= 3.4;
    this._cam.copy(this._camLook).add(CAM_OFFSET);
    g.camera.position.copy(this._cam);
    g.camera.lookAt(this._camLook.x, this._camLook.y + 1.2, this._camLook.z);
    this._camReady = true;

    g.state = 'playing';
    g.audio.music(false);
    this._prompt = null;
    this._syncHud();
  }

  _spawnVector(spawnAt, atPortal) {
    const city = this.city;
    if (spawnAt) return _v.copy(spawnAt).clone();
    if (atPortal) {
      const portal = city.portals.find((q) => q.rank === atPortal);
      if (portal) {
        // Step out of the portal toward the plaza, not on top of the dais.
        const away = _v2.set(-portal.pos.x, 0, -portal.pos.z);
        if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
        away.normalize().multiplyScalar(portal.radius + 1.6);
        const x = portal.pos.x + away.x;
        const z = portal.pos.z + away.z;
        return new THREE.Vector3(x, city.heightAt(x, z), z);
      }
    }
    return city.spawnPoint();
  }

  /** Dim every portal the save cannot walk into yet. */
  refreshPortalLocks() {
    if (!this.city) return;
    const level = this.game.save?.level ?? 1;
    for (const g of GATES) {
      this.city.setPortalState(g.rank, { locked: level < g.reqLevel });
    }
  }

  exit() {
    const g = this.game;
    this.ui?.show(false);
    this.city?.dispose();
    // Hand the body back to the arena environment so a gate does not start the
    // player standing on a heightfield that no longer exists.
    g.player.body.setEnvironment(FLAT_GROUND, g._arenaResolve);
    // A yaw dragged while wandering the hub must not carry into the gate — the
    // arena spawn is authored around the default framing.
    g.input.resetLook?.();
    this._prompt = null;
    this._camReady = false;
  }

  // -------------------------------------------------------------- per frame

  updateAlways(dt) {
    this.city?.update(dt, this.game.player.pos);
  }

  update(dt) {
    const g = this.game;
    const p = g.player;
    const input = g.input;
    const body = p.body;

    body.maxSpeed = g.derived.speed;
    if (input.consume('jump')) body.jump();
    body.setJumpHeld(input.isHeld('jump'));

    // World-space stick — rotated through the drag yaw, so "up" stays "away
    // from the camera" from every angle the player can orbit to.
    const mv = input.sampleWorld();
    const moving = Math.abs(mv.x) > 0.01 || Math.abs(mv.z) > 0.01;
    body.move(mv.x, mv.z, 1);

    if (moving) {
      const targetYaw = Math.atan2(mv.x, mv.z);
      let diff = targetYaw - p.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      p.yaw += diff * Math.min(1, dt * 16);
    }

    body.step(dt);
    if (p.pos.y < VOID_Y || !Number.isFinite(p.pos.y)) this._recoverFromVoid();

    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = p.yaw;
    animateRig(p.mesh, {
      moving, speed: body.groundSpeed, t: g.time,
      attackPhase: 0, hurt: 0,
      airborne: !body.grounded,
      riseRate: p.vel.y,
      dt,
    });

    // Out of combat you mend. Walking back to the plaza after a mauling and
    // arriving at full health is the whole point of having a town.
    const d = g.derived;
    p.hp = Math.min(d.maxHp, p.hp + Math.max(d.hpRegen, d.maxHp * 0.05) * dt);
    p.mp = Math.min(d.maxMp, p.mp + Math.max(d.mpRegen, d.maxMp * 0.08) * dt);

    this._updatePrompt();
    this._updateDistrict();
    this._updateCompass(dt);
    this._syncHud();
  }

  /** Put a player who went over the west cliff back on the plaza. */
  _recoverFromVoid() {
    const g = this.game;
    const spot = this.city ? this.city.spawnPoint() : new THREE.Vector3(0, 0, 18);
    g.player.body.reset(spot.x, spot.y, spot.z);
    g.player.yaw = Math.PI;
    g.ui.toast('THE OVERLOOK IS NOT A ROAD');
    this._camReady = false;
  }

  _updatePrompt() {
    const city = this.city;
    if (!city) { this._setPrompt(null); return; }
    const p = this.game.player;

    const near = city.nearestPortal(p.pos);
    if (near && near.distance < near.portal.radius + PROMPT_SLACK) {
      const portal = near.portal;
      const gate = portal.gate || GATES.find((g) => g.rank === portal.rank);
      this._setPrompt({
        kind: 'portal',
        rank: portal.rank,
        locked: Boolean(portal.locked),
        label: `${portal.rank}-GRADE GATE`,
        sub: portal.locked
          ? `SEALED · REQUIRES LEVEL ${gate?.reqLevel ?? '?'}`
          : (gate?.name || 'ENTER THE GATE'),
      });
      return;
    }

    const it = city.interactAt(p.pos);
    if (it) {
      this._setPrompt({
        kind: 'interact',
        id: it.id,
        locked: false,
        label: it.label,
        sub: it.id === 'assay' ? 'RIFT CONTRACTS' : 'NOT YET OPEN',
      });
      return;
    }
    this._setPrompt(null);
  }

  _setPrompt(prompt) {
    this._prompt = prompt;
    this.ui?.setPrompt(prompt);
  }

  _updateDistrict() {
    const p = this.game.player;
    let best = null, bestScore = Infinity;
    for (const d of DISTRICTS) {
      const dist = Math.hypot(p.pos.x - d.pos.x, p.pos.z - d.pos.z);
      if (dist > d.pad + 10) continue;
      // Score by how far INSIDE the district you are, not by raw distance to
      // its marker. The plaza's pad is 26 m and the Exchange's is 15; by raw
      // distance, standing in the middle of the plaza announced the Exchange.
      const score = dist - d.pad;
      if (score < bestScore) { bestScore = score; best = d; }
    }
    this.ui?.setDistrict(best ? best.name : null);
  }

  _updateCompass(dt) {
    this._compassT -= dt;
    if (this._compassT > 0) return;
    this._compassT = 0.25;              // 4 Hz is plenty for an arrow
    const city = this.city;
    const p = this.game.player;
    if (!city) return;
    let best = null, bestD = Infinity;
    for (const portal of city.portals) {
      if (portal.locked) continue;
      const d = Math.hypot(p.pos.x - portal.pos.x, p.pos.z - portal.pos.z);
      if (d < bestD) { bestD = d; best = portal; }
    }
    if (!best) { this.ui?.setCompass(NaN, 0, 0); return; }
    // Screen space: with the orbit untouched the camera looks down -Z, so
    // world -Z is up on screen and a positive CSS rotation is clockwise from
    // there. A dragged yaw rotates the whole frame with it: the camera's
    // ground forward sits at world angle -yaw in this convention, so the
    // as-seen bearing is the world angle plus yaw — the arrow points at the
    // portal AS SEEN, not as mapped.
    const angle = Math.atan2(best.pos.x - p.pos.x, -(best.pos.z - p.pos.z))
      + this.game.input.look.yaw;
    this.ui?.setCompass(angle, bestD, PORTAL_COLORS[best.rank] || 0xbfd0ff);
  }

  // ---------------------------------------------------------------- camera

  updateCamera(dt) {
    const g = this.game;
    const p = g.player;
    const { yaw, pitch } = g.input.look;

    _v.copy(p.pos).addScaledVector(p.vel, 0.18);
    if (yaw === 0 && pitch === 0) {
      // Untouched orbit is the shipped camera, bit for bit — the branch every
      // scripted run exercises.
      _v.z -= 3.4;
    } else {
      // Look-target bias slides along the camera's ground forward so the hero
      // sits below centre from every angle.
      _v.x -= Math.sin(yaw) * 3.4;
      _v.z -= Math.cos(yaw) * 3.4;
    }
    // A teleport (arrival, or a rescue off the cliff) must not be followed by a
    // 200 m camera sweep across the map. Snap instead.
    const snap = !this._camReady;
    if (snap) { this._camLook.copy(_v); this._camReady = true; }
    this._camLook.lerp(_v, Math.min(1, dt * 6));

    if (yaw === 0 && pitch === 0) {
      _want.copy(this._camLook).add(CAM_OFFSET);
    } else {
      // CAM_OFFSET swung around Y by the drag; the boom probe below then
      // marches along this rotated boom, so buildings still push the camera
      // in no matter which side of the street it orbits to.
      const boom = Math.hypot(CAM_OFFSET.y, CAM_OFFSET.z);
      const pa = Math.atan2(CAM_OFFSET.y, CAM_OFFSET.z) + pitch;
      _want.set(
        this._camLook.x + Math.sin(yaw) * boom * Math.cos(pa),
        this._camLook.y + boom * Math.sin(pa),
        this._camLook.z + Math.cos(yaw) * boom * Math.cos(pa),
      );
    }
    const dist = this._clearCameraDistance(p.pos, _want);
    if (dist <= 0) {
      this._cam.copy(_want);
    } else {
      // Blocked: sit at the last unobstructed point along the boom.
      _dir.copy(_want).sub(p.pos).normalize();
      this._cam.copy(p.pos).addScaledVector(_dir, dist);
      const floor = (this.city ? this.city.heightAt(this._cam.x, this._cam.z) : 0) + 2.2;
      if (this._cam.y < floor) this._cam.y = floor;
    }

    if (snap) g.camera.position.copy(this._cam);
    else g.camera.position.lerp(this._cam, Math.min(1, dt * 7));
    g.camera.lookAt(this._camLook.x, this._camLook.y + 1.2, this._camLook.z);
    g.fx.applyShake(g.camera);
    this.city?.updateShadowCamera(p.pos, 22);
  }

  /**
   * March the boom from the player's eye out to the desired camera position and
   * return the distance at which it first hits a building, the ground, or
   * nothing at all. Returns 0 when the whole boom is clear.
   */
  _clearCameraDistance(from, want) {
    const city = this.city;
    if (!city) return 0;
    _probe.copy(want).sub(from);
    const full = _probe.length();
    if (full < 1e-3) return 0;
    // Walk OUTWARD and stop at the first hit, so a boom that clips one corner
    // near the player is not rescued by the far samples being clear.
    for (let i = 1; i <= CAM_PROBE_STEPS; i++) {
      const t = i / CAM_PROBE_STEPS;
      const x = from.x + _probe.x * t;
      const y = from.y + EYE + (_probe.y - EYE) * t;
      const z = from.z + _probe.z * t;
      if (this._boomBlocked(x, y, z)) {
        return Math.max(CAM_MIN, full * ((i - 1) / CAM_PROBE_STEPS));
      }
    }
    return 0;
  }

  _boomBlocked(x, y, z) {
    const city = this.city;
    if (y < city.heightAt(x, z) + 0.6) return true;
    // Buildings carry no height in `boxes`, and every one of them is taller
    // than the boom ever gets, so an XZ test is the correct test.
    for (const b of city.boxes) {
      if (Math.abs(x - b.x) < b.w / 2 + 0.4 && Math.abs(z - b.z) < b.d / 2 + 0.4) return true;
    }
    return false;
  }

  // --------------------------------------------------------------- actions

  /**
   * Act on whatever prompt is showing.
   * @returns {{action:'enterGate', rank:string}|{action:'open', id:string}|null}
   */
  confirmPrompt() {
    const g = this.game;
    const prompt = this._prompt;
    if (!prompt) return null;
    g.audio.ui?.();

    if (prompt.kind === 'portal') {
      const gate = GATES.find((x) => x.rank === prompt.rank);
      if (prompt.locked) {
        g.ui.toast(`THIS GATE IS SEALED · REQUIRES LEVEL ${gate?.reqLevel ?? '?'}`, 'danger');
        return null;
      }
      g.enterGate(prompt.rank);
      return { action: 'enterGate', rank: prompt.rank };
    }

    if (prompt.id === 'assay') {
      // The fast-travel desk. The gate list is a convenience for people who do
      // not want to walk, not the way in.
      g.appState?.go('gates', { from: 'city' });
      return { action: 'open', id: 'assay' };
    }
    g.ui.toast(`${prompt.label} IS NOT OPEN YET`);
    return { action: 'open', id: prompt.id };
  }

  /** Keep the vitals readable in the hub; ui.updateHud is gate-only. */
  _syncHud() {
    const g = this.game;
    const p = g.player;
    const d = g.derived;
    const el = (id) => document.getElementById(id);
    const hp = el('hpFill'); if (hp) hp.style.width = `${Math.max(0, (p.hp / d.maxHp) * 100)}%`;
    const hpT = el('hpText'); if (hpT) hpT.textContent = `${Math.ceil(p.hp)} / ${d.maxHp}`;
    const mp = el('mpFill'); if (mp) mp.style.width = `${Math.max(0, (p.mp / d.maxMp) * 100)}%`;
    const mpT = el('mpText'); if (mpT) mpT.textContent = `${Math.ceil(p.mp)} / ${d.maxMp}`;
    const lv = el('hudLevel'); if (lv) lv.textContent = `LV ${g.save.level}`;
  }

  resolveFor(entity) {
    this.city?.resolve(entity.pos, entity.radius, entity.vel);
  }
}

registerMode('city', (game) => new CityMode(game));

export default CityMode;
