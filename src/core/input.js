// Unified input: virtual thumbstick + on-screen skill buttons + keyboard fallback.

export class Input {
  constructor() {
    this.move = { x: 0, y: 0 };      // normalized -1..1, y is "forward"
    this.pressed = new Set();        // skill keys buffered for this frame
    this.held = new Set();
    this.keys = new Set();

    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._radius = 52;

    this._bindStick();
    this._bindButtons();
    this._bindKeys();
  }

  _bindStick() {
    const stick = document.getElementById('stick');
    const nub = document.getElementById('stickNub');
    if (!stick) return;

    const setNub = (dx, dy) => {
      nub.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const start = (e) => {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      this._stickId = e.changedTouches ? t.identifier : 'mouse';
      const r = stick.getBoundingClientRect();
      this._radius = r.width * 0.38;
      this._stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      move(e);
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
    };

    stick.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    stick.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
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
    const map = {
      j: 'attack', J: 'attack',
      k: 'slash', K: 'slash',
      l: 'nova', L: 'nova',
      u: 'summon', U: 'summon',
      Shift: 'dash',
      ' ': 'jump',
    };
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.key.toLowerCase());
      const s = map[e.key];
      if (s) { this.pressed.add(s); this.held.add(s); }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      const s = map[e.key];
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
      const l = Math.hypot(kx, ky);
      return { x: kx / l, y: ky / l };
    }
    return this.move;
  }

  consume(skill) {
    if (this.pressed.has(skill)) { this.pressed.delete(skill); return true; }
    return false;
  }

  isHeld(skill) { return this.held.has(skill); }

  endFrame() { this.pressed.clear(); }
}
