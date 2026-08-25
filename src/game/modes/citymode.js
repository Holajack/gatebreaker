import * as THREE from 'three';
import { GameMode, registerMode } from './mode.js';
import { City, DISTRICTS, PORTAL_COLORS } from '../../world/city.js';
import { CityUI } from '../../ui/cityui.js';
import { FLAT_GROUND } from '../physics.js';
import { animateRig } from '../entities.js';
import { GATES } from '../config.js';
// THE REACH (CLASSES_SPEC step 7): the S portal's prompt line goes
// save-dependent the way the Assay Hall door did in step 5 — the trial offer
// must be visible AT THE GATE, and this prompt is the S gate's doorstep.
import { canAscend } from '../classes.js';
import { makeDayState } from '../../render/daynight.js';

// How far past a portal's own radius the prompt still shows. Generous, because
// a phone player steers with a thumb and "stand exactly here" is not a thing
// you can ask of one.
const PROMPT_SLACK = 2.2;

// What is actually behind each service door, for the ones that lead somewhere.
// Anything not listed falls through to 'NOT YET OPEN', which cityui.js softens
// to 'CLOSED' — see its setPrompt.
const INTERACT_SUB = {
  assay: 'RIFT CONTRACTS',
  exchange: 'WEAPONS FOR ASH',
};

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
// 10,10 is the owner's call after playing 8,8: he wanted to see more around
// him. The hero still projects to ~85 px on a 720 p frame (8,8 was ~105, the
// old 11,11 ~75), so he stays readable while the street regains depth.
const CAM_OFFSET = new THREE.Vector3(0, 10, 10);
// Boom floor when a building blocks the probe. Scaled with CAM_OFFSET (5.0 at
// 11,11, 3.6 at 8,8) so a blocked boom retreats to the same fraction of its
// full length instead of jumping to half of it.
const CAM_MIN = 4.5;
const CAM_PROBE_STEPS = 7;
const EYE = 1.55;             // where the collision probe leaves the body

// --- interiors -------------------------------------------------------------
// WORLD_SPEC step 9: five service buildings are walked into, so the camera has
// to come with you. Three numbers do all of it.
//
// The boom shortens to 5.0 m with the pitch preserved, which at the shipped 45
// degrees puts the eye ~3.5 m above the floor and ~3.5 m back — above a 2 m
// wall, inside a room 6-10 m across. Anything longer and the camera sits in the
// street looking at a roofless box from outside.
const CAM_INSIDE = 5.0;
// Half of the spec's 0.5 m hysteresis band, applied either side of the
// footprint edge. Without it the doorway threshold flickers the roof on and off
// at walking pace, which is worse than either state.
const INSIDE_HYST = 0.25;
// The boom floor drops indoors: CAM_MIN 3.6 is most of CAM_INSIDE, so a blocked
// probe would barely shorten the boom at all and the camera would stay wedged
// in the wall it just hit.
const CAM_MIN_INSIDE = 2.4;

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
    // Which enterable the player is inside, as MODE state. It is deliberately
    // not world state: the hysteresis band belongs to whoever is watching the
    // player move, and two watchers with two thresholds flicker against each
    // other at the doorway.
    this._insideId = null;

    // One DayState for the life of the mode. game.worldClock.sample() writes
    // into it and allocates nothing, so the whole day/night system costs zero
    // garbage per frame — the update loops in this repo are held to that.
    this._day = makeDayState();

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
    // A fresh City means fresh (visible) roofs; the stale id from the last visit
    // would otherwise suppress the first _updateInside flip.
    this._insideId = null;
    // City.build assembles the town at its authored 15:00 look. Apply the real
    // hour here so arriving at midnight does not flash one afternoon frame.
    this._applyDay();
    this._syncHud();
  }

  _spawnVector(spawnAt, atPortal) {
    const city = this.city;
    if (spawnAt) return _v.copy(spawnAt).clone();
    if (atPortal) {
      // atPortal is a stable portal id ('plaza-e', 'wild-wildgate_e', ...) or,
      // from legacy callers, a bare rank. Id match first — it is exact — then
      // rank, whose first match is always the plaza gate (built before the
      // frontier's wild ones).
      const portal = city.portals.find((q) => q.id === atPortal)
        || city.portals.find((q) => q.rank === atPortal);
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
    // ...and then TAKE THE OVERLAY WITH US. registerMode('city') builds a NEW
    // CityMode on every mount, so a CityUI that is only hidden here leaves its
    // #cityUi div in the document forever: after one gate round trip the page
    // has two #cityConfirm buttons, after ten it has eleven. Everything still
    // *plays* — a real tap hits the live button's own listener — but the ids
    // are duplicated, document.getElementById returns the dead one, and the
    // node count grows without bound. Found by the step-12 sweep, which could
    // not click the wild gate's confirm because it kept resolving the corpse.
    this.ui?.dispose();
    this.ui = null;
    // Put every roof back BEFORE the City goes. Interiors.dispose() does it too
    // and setInside is idempotent, but "roof-restore-on-exit races with
    // dispose" is a named edge case in the spec and this is the one line that
    // makes the race impossible rather than merely unlikely.
    this.city?.interiors?.setInside(null);
    this._insideId = null;
    this.city?.dispose();
    // Hand the body back to the arena environment so a gate does not start the
    // player standing on a heightfield that no longer exists.
    g.player.body.setEnvironment(FLAT_GROUND, g._arenaResolve);
    // A yaw dragged while wandering the hub must not carry into the gate — the
    // arena spawn is authored around the default framing.
    g.input.resetLook?.();
    this._prompt = null;
    this._camReady = false;
    this._insideId = null;
  }

  // -------------------------------------------------------------- per frame

  updateAlways(dt) {
    // Sample and apply BEFORE city.update: update() ends by snapping the shadow
    // frustum along city._lightDir, and applying the day state afterwards would
    // aim every frame's shadows along the previous frame's sun. The clock
    // itself is ticked once, in game.update, for every mode.
    this._applyDay();
    this.city?.update(dt, this.game.player.pos);
  }

  /** Push the current hour onto the city. Cheap enough to run behind a pause. */
  _applyDay() {
    const clock = this.game.worldClock;
    if (!clock || !this.city) return;
    this.city.applyDayState(clock.sample(this._day));
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

    this._updateInside();
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

  /**
   * Am I indoors? Flip the roof, and remember it for the camera.
   *
   * The hysteresis is asymmetric on purpose: you have to get INSIDE_HYST inside
   * the footprint before the roof lifts, and you have to get INSIDE_HYST clear
   * of it before it drops back. The door cell is the only place the two
   * thresholds are ever crossed in the same second, and 0.5 m of band is about
   * a stride at hub walking speed.
   */
  _updateInside() {
    const interiors = this.city?.interiors;
    if (!interiors) { this._insideId = null; return; }
    const p = this.game.player.pos;
    const grow = this._insideId ? INSIDE_HYST : -INSIDE_HYST;
    const hit = interiors.buildingAt(p, grow);
    const id = hit ? hit.id : null;
    if (id === this._insideId) return;
    this._insideId = id;
    interiors.setInside(id);
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
        // The portal's stable id rides the prompt so confirmPrompt can hand
        // game.enterGate the exact portal — not just a rank a wild twin might
        // share. Named portalId (not id) because interact prompts already use
        // id for the interactable's key.
        portalId: portal.id,
        rank: portal.rank,
        // Verge wild gates yield emberdust at ANY rank (RPG_SPEC gate3
        // recipe); game.enterGate only knows if the prompt tells it.
        wild: Boolean(portal.wild),
        locked: Boolean(portal.locked),
        label: `${portal.rank}-GRADE GATE`,
        // The S portal is THE REACH for an ascension-eligible save — same
        // save-dependent-door pattern as _assaySub. game._beginGate arms the
        // actual trial flag; this line only makes the offer visible where the
        // migration promised it ("gets the trial offer at the S gate").
        sub: portal.locked
          ? `SEALED · REQUIRES LEVEL ${gate?.reqLevel ?? '?'}`
          : (portal.rank === 'S' && canAscend(this.game.save)
            ? 'THE REACH · THE ASCENSION TRIAL AWAITS'
            : (gate?.name || 'ENTER THE GATE')),
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
        // cityui.js rewrites 'NOT YET OPEN' to 'CLOSED' for the doors that
        // still lead nowhere; the two that DO lead somewhere say what is
        // behind them. The Assay Hall's line is save-dependent (STEP 5): from
        // level 20 the assayer's desk is where classes are sworn.
        sub: it.id === 'assay' ? this._assaySub() : (INTERACT_SUB[it.id] || 'NOT YET OPEN'),
      });
      return;
    }
    this._setPrompt(null);
  }

  _setPrompt(prompt) {
    this._prompt = prompt;
    this.ui?.setPrompt(prompt);
  }

  /**
   * What the Assay Hall door promises (CLASSES_SPEC STEP 5). Below level 20
   * the assayer has nothing to measure and the door keeps its shipped line;
   * from 20 the class business headlines — 'YOUR CLASS AWAITS' is the
   * migration's flag made visible at the exact door that honours it.
   */
  _assaySub() {
    const s = this.game.save;
    if ((s?.level || 0) < 20) return INTERACT_SUB.assay;
    return s.className ? 'CLASSES · RIFT CONTRACTS' : 'YOUR CLASS AWAITS';
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

    // ONE scale factor for the whole rig indoors, and it has to be one: the
    // first cut shortened only the boom and left the 3.4 m look-target bias
    // alone, which at a 5 m boom put the camera 3.5 m straight up above the
    // player's head looking at the floor. The bias exists to push the hero
    // below centre on an 11.3 m boom; at 5 m it is two thirds of the rig.
    // k = 1 outdoors, so the shipped camera is untouched bit for bit.
    const inside = Boolean(this._insideId);
    const boomLen = Math.hypot(CAM_OFFSET.y, CAM_OFFSET.z);
    const k = inside ? CAM_INSIDE / boomLen : 1;
    const bias = 3.4 * k;

    _v.copy(p.pos).addScaledVector(p.vel, 0.18);
    if (yaw === 0 && pitch === 0) {
      // Untouched orbit is the shipped camera, bit for bit — the branch every
      // scripted run exercises.
      _v.z -= bias;
    } else {
      // Look-target bias slides along the camera's ground forward so the hero
      // sits below centre from every angle.
      _v.x -= Math.sin(yaw) * bias;
      _v.z -= Math.cos(yaw) * bias;
    }
    // A teleport (arrival, or a rescue off the cliff) must not be followed by a
    // 200 m camera sweep across the map. Snap instead.
    const snap = !this._camReady;
    if (snap) { this._camLook.copy(_v); this._camReady = true; }
    this._camLook.lerp(_v, Math.min(1, dt * 6));

    // Indoors the boom shortens but keeps its DIRECTION, so the pitch the
    // player dragged survives walking through a door.
    if (yaw === 0 && pitch === 0) {
      _want.set(
        this._camLook.x + CAM_OFFSET.x * k,
        this._camLook.y + CAM_OFFSET.y * k,
        this._camLook.z + CAM_OFFSET.z * k,
      );
    } else {
      // CAM_OFFSET swung around Y by the drag; the boom probe below then
      // marches along this rotated boom, so buildings still push the camera
      // in no matter which side of the street it orbits to.
      const boom = boomLen * k;
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
        const floor = this._insideId ? CAM_MIN_INSIDE : CAM_MIN;
        return Math.max(floor, full * ((i - 1) / CAM_PROBE_STEPS));
      }
    }
    return 0;
  }

  _boomBlocked(x, y, z) {
    const city = this.city;
    if (y < city.heightAt(x, z) + 0.6) return true;
    // Buildings carry no height in `boxes`, and every one of them is taller
    // than the boom ever gets, so an XZ test is the correct test.
    //
    // EXCEPT the building you are standing in. Its walls are wall-RUN boxes
    // (0.2 m slabs on the slab lines), the boom from a player inside crosses
    // one of them on its way up and out, and the height-free test cannot know
    // the camera is above a 2 m wall whose roof is currently hidden. So the
    // occupied building's own boxes are skipped: without this the boom collapses
    // to CAM_MIN the moment you cross the threshold and the camera sits in the
    // doorway looking at the back of your head. Every OTHER building still
    // blocks, including the other four enterables.
    const inside = this._insideId;
    for (const b of city.boxes) {
      if (inside && b.interiorId === inside) continue;
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
      g.enterGate(prompt.rank, { wild: Boolean(prompt.wild), portalId: prompt.portalId });
      return { action: 'enterGate', rank: prompt.rank };
    }

    if (prompt.id === 'exchange') {
      // The weapon shop. game.shopUI is constructed once in main.js and
      // outlives this mode, so opening it neither builds DOM nor touches the
      // scene — the city keeps ticking behind the panel, and the panel's own
      // backdrop is what stops the thumbstick underneath it.
      if (g.shopUI?.open()) return { action: 'open', id: 'exchange' };
    }

    if (prompt.id === 'assay') {
      // The assayer's desk (CLASSES_SPEC STEP 5): from level 20 the door opens
      // the class panel, which carries the fast-travel list one tap inside it.
      // Below 20 AssayUI.open() declines and the door stays the shipped
      // contracts list — which is also what flow-test's level-1 save asserts.
      if (g.assayUI?.open()) return { action: 'open', id: 'assay' };
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
