// A screen router for the DOM overlays.
//
// Before this existed, transitions were hardcoded callback chains split across
// main.js, ui.js and game.js, and UI.show/hide were unguarded classList
// toggles with no exclusivity — two screens could (and did) end up visible at
// once. AppState makes exactly one exclusive screen visible at a time, keeps a
// short back stack, and gives main.js two hooks (onEnter/onExit) to hang the
// heavy work off.
//
// It deliberately does NOT know what a City or a Gate is. It toggles divs and
// fires callbacks; everything else is main.js's job.

export const SCREENS = [
  'boot', 'title', 'city', 'gates', 'run', 'hud', 'levelup', 'pause',
  'results', 'how', 'barracks', 'assay', 'trial', 'map',
];

// `hud` and `pause` ride on top of whatever is underneath rather than replacing
// it, so go() must never hide them and never treat them as a destination.
export const OVERLAYS = ['hud', 'pause'];

// Screens with no DOM of their own. 'city' and 'run' ARE states — they decide
// which GameMode is mounted — but what they show is the 3D scene, so going to
// one simply means "hide every menu". They are deliberately in SCREENS rather
// than special-cased, because that is what makes go('city') hide the results
// panel without anyone remembering to.
export const SCENE_SCREENS = ['city', 'run'];

// Never worth returning to with the back button: a run you already finished,
// and the boot splash.
const TRANSIENT = new Set(['boot', 'run', 'results']);

const BACK_STACK_LIMIT = 8;

const el = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

export class AppState {
  constructor({ onEnter, onExit } = {}) {
    this.onEnter = onEnter || null;
    this.onExit = onExit || null;
    this._current = 'boot';
    this._payload = {};
    this._stack = [];
    this._guards = new Map();
    this._overlays = new Set();
  }

  get current() { return this._current; }

  get payload() { return this._payload; }

  is(screen) { return this._current === screen; }

  /**
   * Register a veto for one transition. `fn()` returning false blocks it.
   * `from` may be '*' to guard every entry into `to`.
   */
  guard(from, to, fn) {
    this._guards.set(`${from}>${to}`, fn);
  }

  _allowed(from, to) {
    const exact = this._guards.get(`${from}>${to}`);
    if (exact && exact() === false) return false;
    const wild = this._guards.get(`*>${to}`);
    if (wild && wild() === false) return false;
    return true;
  }

  /** Show `screen` exclusively, pushing the current one onto the back stack. */
  go(screen, payload = {}) {
    return this._transition(screen, payload, true);
  }

  /** Same as go(), but the current screen is not remembered. */
  replace(screen, payload = {}) {
    return this._transition(screen, payload, false);
  }

  _transition(screen, payload, push) {
    if (!SCREENS.includes(screen)) return false;
    if (OVERLAYS.includes(screen)) { this.overlay(screen, true); return true; }
    const prev = this._current;
    if (!this._allowed(prev, screen)) return false;

    if (prev && prev !== screen) {
      this.onExit?.(prev, screen);
      if (push && !TRANSIENT.has(prev)) {
        this._stack.push({ screen: prev, payload: this._payload });
        if (this._stack.length > BACK_STACK_LIMIT) this._stack.shift();
      }
    }

    // Hide EVERY exclusive screen before showing the target. This one line is
    // the whole reason the router exists.
    for (const id of SCREENS) {
      if (OVERLAYS.includes(id)) continue;
      el(id)?.classList.add('hidden');
    }
    el(screen)?.classList.remove('hidden');

    this._current = screen;
    this._payload = payload || {};
    // Arriving somewhere the stack already ends with means back() would put you
    // right back where you are. Results -> city is the case that produces this.
    while (this._stack.length && this._stack[this._stack.length - 1].screen === screen) {
      this._stack.pop();
    }
    this.onEnter?.(screen, this._payload, prev);
    return true;
  }

  /**
   * Pop one entry. Returns false when there is nowhere to go — which is the
   * signal Android's hardware back uses to decide whether to exit the app.
   */
  back() {
    const entry = this._stack.pop();
    if (!entry) return false;
    // Do not re-push: back() must not build a loop between two screens.
    return this._transition(entry.screen, entry.payload, false);
  }

  /** Show or hide a non-exclusive layer (`hud`, `pause`). */
  overlay(screen, on) {
    if (!SCREENS.includes(screen)) return;
    const node = el(screen);
    if (node) node.classList.toggle('hidden', !on);
    if (on) this._overlays.add(screen); else this._overlays.delete(screen);
  }

  /** True when `screen` is currently shown as an overlay. */
  hasOverlay(screen) { return this._overlays.has(screen); }

  /** Drop the history without changing what is on screen. */
  clearStack() { this._stack.length = 0; }

  /** The screens currently on the back stack, oldest first. Testing aid. */
  get stack() { return this._stack.map((s) => s.screen); }
}

export default AppState;
