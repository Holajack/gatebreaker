// Unified input: virtual thumbstick + on-screen skill buttons + drag-to-orbit
// camera + keyboard/mouse for desktop.

// Orbit feel, tuned by dragging on a 1280x720 window: a 300 px sweep is a
// quarter turn, which crosses a phone screen in one thumb stroke without ever
// spinning past what the eye can track.
//
// Pitch was originally a 12° garnish around the rig's authored 45°. The owner
// played it and wanted real vertical control, so the band is now 35° either
// side: 10° (a low chase angle down the street) to 80° (near top-down). Both
// ends stay safe without new clamps — measured at full tilt-up the camera is
// still 7.0 m above the player in the city and 9.4 m in the arena, and the
// city's boom probe keeps its own terrain floor on top of that.
const YAW_PER_PX = Math.PI / 600;
const PITCH_PER_PX = 0.0015;
const PITCH_MAX = (35 * Math.PI) / 180;

export class Input {
  constructor() {
    this.move = { x: 0, y: 0 };      // normalized -1..1, y is "forward"
    this.pressed = new Set();        // skill keys buffered for this frame
    this.held = new Set();
    this.keys = new Set();

    // Camera state lives on the input because both consumption sites (arena
    // and city) must rotate the stick through the SAME yaw the follow rig
    // uses — one owner, no drift. pitch is an offset around the rig default.
    this.look = { yaw: 0, pitch: 0 };
    this._world = { x: 0, z: 0 };    // sampleWorld scratch, never reallocated
    this._kbd = { x: 0, y: 0 };      // sample() keyboard scratch, same rule

    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._radius = 52;
    this._orbitId = null;
    this._orbitLast = { x: 0, y: 0 };

    this._bindStick();
    this._bindOrbit();
    this._bindButtons();
    this._bindKeys();
  }

  // Floating thumbstick: the ring is placed under whichever finger lands in the
  // left zone rather than sitting at one fixed spot, so the thumb never has to
  // hunt for it. If a drag runs past the ring's edge the origin trails the
  // finger, which keeps long sweeps from pinning at full tilt in a stale
  // direction.
  _bindStick() {
    const zone = document.getElementById('stickZone');
    const stick = document.getElementById('stick');
    const nub = document.getElementById('stickNub');
    if (!zone || !stick || !nub) return;

    const setNub = (dx, dy) => {
      nub.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    // Where the hint ring rests when nobody is touching it.
    const park = () => {
      if (this._stickId !== null) return;
      const r = zone.getBoundingClientRect();
      this._place(stick, r.left + r.width * 0.4, r.bottom - Math.min(r.height * 0.42, 150));
    };
    this._park = park;

    const start = (e) => {
      if (this._stickId !== null) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      this._stickId = e.changedTouches ? t.identifier : 'mouse';
      this._radius = (stick.getBoundingClientRect().width || 132) * 0.38;
      this._stickOrigin = { x: t.clientX, y: t.clientY };
      this._place(stick, t.clientX, t.clientY);
      stick.classList.add('active');
      setNub(0, 0);
      e.preventDefault();
    };

    const move = (e) => {
      if (this._stickId === null) return;
      let t = e;
      if (e.changedTouches) {
        t = [...e.changedTouches].find((c) => c.identifier === this._stickId);
        if (!t) return;
      }
      let dx = t.clientX - this._stickOrigin.x;
      let dy = t.clientY - this._stickOrigin.y;
      const len = Math.hypot(dx, dy) || 1;

      // Drag past the rim and the origin follows, so the ring stays under the
      // thumb and direction keeps tracking instead of saturating.
      if (len > this._radius) {
        this._stickOrigin.x += dx * (1 - this._radius / len);
        this._stickOrigin.y += dy * (1 - this._radius / len);
        this._place(stick, this._stickOrigin.x, this._stickOrigin.y);
      }

      const clamped = Math.min(len, this._radius);
      dx = (dx / len) * clamped;
      dy = (dy / len) * clamped;
      setNub(dx, dy);
      // Deadzone keeps a resting thumb from creeping the character.
      const mag = clamped / this._radius;
      const dead = 0.16;
      if (mag < dead) {
        this.move.x = 0; this.move.y = 0;
      } else {
        const scaled = (mag - dead) / (1 - dead);
        this.move.x = (dx / clamped) * scaled;
        this.move.y = (-dy / clamped) * scaled;
      }
      e.preventDefault();
    };

    const end = (e) => {
      if (this._stickId === null) return;
      if (e.changedTouches && ![...e.changedTouches].some((c) => c.identifier === this._stickId)) return;
      this._stickId = null;
      this.move.x = 0; this.move.y = 0;
      setNub(0, 0);
      stick.classList.remove('active');
      park();
    };

    zone.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    zone.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    window.addEventListener('resize', park);
    window.addEventListener('orientationchange', () => setTimeout(park, 60));
    park();
  }

  // Drag anywhere on the bare canvas to orbit. Hit-testing is free: the stick
  // zone, the skill buttons and every panel sit ABOVE the canvas in the
  // stacking order, so a pointer whose start target is the canvas itself is by
  // construction in open screen — the buttons keep winning without any
  // geometry checks here. 1:1 and inertia-free on purpose; a camera that
  // coasts after the thumb stops is a camera the player fights.
  _bindOrbit() {
    const canvas = document.getElementById('scene');
    if (!canvas) return;

    const start = (e) => {
      if (this._orbitId !== null) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      this._orbitId = e.changedTouches ? t.identifier : 'mouse';
      this._orbitLast.x = t.clientX;
      this._orbitLast.y = t.clientY;
      e.preventDefault();
    };

    const move = (e) => {
      if (this._orbitId === null) return;
      let t = e;
      if (e.changedTouches) {
        t = [...e.changedTouches].find((c) => c.identifier === this._orbitId);
        if (!t) return;
      } else if (this._orbitId !== 'mouse') return;
      const dx = t.clientX - this._orbitLast.x;
      const dy = t.clientY - this._orbitLast.y;
      this._orbitLast.x = t.clientX;
      this._orbitLast.y = t.clientY;
      // Drag right = look right. Yaw is unclamped and unwrapped — sampleWorld
      // only ever feeds it to sin/cos.
      //
      // Drag UP tilts the view up (the boom swings DOWN toward the horizon);
      // drag DOWN tilts it toward top-down. Every rig computes its boom angle
      // as `atan2(offset.y, offset.z) + pitch`, so a bigger pitch RAISES the
      // camera and therefore looks further DOWN — which read as inverted to the
      // owner. Screen dy is already positive-down, so `+ dy` is the
      // non-inverted mapping and this one sign fixes city, arena and dungeon
      // together.
      this.look.yaw -= dx * YAW_PER_PX;
      this.look.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.look.pitch + dy * PITCH_PER_PX));
      e.preventDefault();
    };

    const end = (e) => {
      if (this._orbitId === null) return;
      if (e.changedTouches && ![...e.changedTouches].some((c) => c.identifier === this._orbitId)) return;
      this._orbitId = null;
    };

    canvas.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    canvas.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
  }

  /** Snap the camera state back to the rig default. Modes call this on entry
   *  so a yaw carried out of the city cannot whip the gate camera (and vice
   *  versa) across the transition. */
  resetLook() {
    this.look.yaw = 0;
    this.look.pitch = 0;
  }

  _place(el, x, y) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  _bindButtons() {
    document.querySelectorAll('.skill-btn').forEach((btn) => {
      const skill = btn.dataset.skill;
      const down = (e) => {
        this.pressed.add(skill);
        this.held.add(skill);
        e.preventDefault();
        e.stopPropagation();
      };
      const up = () => this.held.delete(skill);
      btn.addEventListener('touchstart', down, { passive: false });
      btn.addEventListener('touchend', up);
      btn.addEventListener('touchcancel', up);
      btn.addEventListener('mousedown', down);
      btn.addEventListener('mouseup', up);
      btn.addEventListener('mouseleave', up);
    });
  }

  _bindKeys() {
    // Two homes per skill: JKLU mirrors the on-screen button cluster for
    // right-hand-on-keys play, QERF keeps everything under the left hand so
    // WASD + mouse-orbit needs no hand travel. Lowercased lookup so Shift
    // combinations and caps lock cannot orphan a held key.
    const map = {
      j: 'attack', f: 'attack',
      k: 'slash', q: 'slash',
      l: 'nova', e: 'nova',
      u: 'summon', r: 'summon',
      shift: 'dash',
      ' ': 'jump',
    };
    window.addEventListener('keydown', (e) => {
      // e.repeat guard: a held key must land ONE press, not one per OS repeat.
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      this.keys.add(key);
      const s = map[key];
      if (s) { this.pressed.add(s); this.held.add(s); }
    });
    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      this.keys.delete(key);
      const s = map[key];
      if (s) this.held.delete(s);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.held.clear(); });
  }

  // Merge keyboard WASD into the stick vector each frame.
  sample() {
    let kx = 0, ky = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) kx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) kx += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) ky += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) ky -= 1;
    if (kx || ky) {
      // Scratch, not a literal: this runs every frame while a key is held and
      // update loops are a no-allocation zone.
      const l = Math.hypot(kx, ky);
      const k = this._kbd;
      k.x = kx / l;
      k.y = ky / l;
      return k;
    }
    return this.move;
  }

  // The stick is camera-space; the body wants world-space. Rotating through
  // the camera yaw here is what makes orbiting safe: "up" is always "away from
  // the camera", so no orientation can invert the controls. The yaw === 0 fast
  // path is not an optimization — it reproduces the pre-orbit mapping
  // (x, -y) bit for bit, so an untouched camera behaves exactly as shipped.
  sampleWorld() {
    const mv = this.sample();
    const w = this._world;
    const yaw = this.look.yaw;
    if (yaw === 0) {
      w.x = mv.x;
      w.z = -mv.y;
    } else {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      w.x = mv.x * c - mv.y * s;
      w.z = -mv.x * s - mv.y * c;
    }
    return w;
  }

  consume(skill) {
    if (this.pressed.has(skill)) { this.pressed.delete(skill); return true; }
    return false;
  }

  isHeld(skill) { return this.held.has(skill); }

  endFrame() { this.pressed.clear(); }
}
