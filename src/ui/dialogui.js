// The dialogue overlay — Wave C's story surface. Until this file, story text
// had exactly one channel: a 2.4-second toast (the audit's finding, verbatim:
// the whole archon ascension identity died in a toast nobody could re-read).
//
// It follows shopui.js's documented overlay recipe to the letter: an overlay,
// NOT an AppState screen (go('city') rebuilds the town — a paragraph of
// dialogue must not cost 200 draw calls and a teleport); own injected sheet on
// the Wave A tokens; shipped .panel/.btn classes; createElement/textContent
// only, because a markup sink is a markup sink whatever you believe about its
// inputs today — and STORY text is the definition of an input that grows.
//
// SHAPE: show(script) where script is
//   { speaker, lines: [string, ...], onDone?, portrait? }
// Lines advance on tap/ENTER (whole panel is the tap target — this is a phone
// game; a 44px NEXT button under a thumb mid-combat is a miss). The LAST tap
// closes and fires onDone. No typewriter effect v1: lines render whole — a
// phone player mid-cooldown reads faster than any reveal animation, and the
// bible's tone rule caps lines at three sentences anyway.
//
// WIRING (owner: main.js, when the Wave B agents release it): construct once,
// game.dialog = new DialogUI(); add '#dialog' to the hardware-back chain
// (back = advance, exactly like tap — never "close and lose the line").

const CSS = `
#dialog { z-index: var(--z-modal); }
body.gb-dialog #cityUi { display: none !important; }

#dialog .dlg-panel {
  max-width: 520px; width: calc(100% - 48px);
  position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
  cursor: pointer;
}
#dialog .dlg-speaker {
  font-size: 11.5px; letter-spacing: .22em; color: var(--gold);
  margin-bottom: 6px;
}
#dialog .dlg-line {
  font-size: 14.5px; line-height: 1.55; letter-spacing: .02em;
  color: var(--ui-city-text-bright, #eaf0ff);
  min-height: 3.1em;
}
#dialog .dlg-more {
  margin-top: 8px; font-size: 10px; letter-spacing: .18em; text-align: right;
  color: var(--ui-city-sub, #97a4c8); opacity: .85;
}
@media (max-height: 520px) {
  #dialog .dlg-panel { bottom: 12px; }
  #dialog .dlg-line { font-size: 13px; min-height: 2.6em; }
}
`;

export class DialogUI {
  constructor() {
    this._root = null;
    this._script = null;
    this._i = 0;
    this._speakerEl = null;
    this._lineEl = null;
    this._moreEl = null;
  }

  get open() { return Boolean(this._script); }

  _ensure() {
    if (this._root) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'dialog';
    root.className = 'screen overlay hidden';

    const panel = document.createElement('div');
    panel.className = 'panel dlg-panel';
    this._speakerEl = document.createElement('div');
    this._speakerEl.className = 'dlg-speaker';
    this._lineEl = document.createElement('div');
    this._lineEl.className = 'dlg-line';
    this._moreEl = document.createElement('div');
    this._moreEl.className = 'dlg-more';
    panel.appendChild(this._speakerEl);
    panel.appendChild(this._lineEl);
    panel.appendChild(this._moreEl);
    root.appendChild(panel);

    // The whole panel advances — and so does the backdrop: a thumb that
    // misses a phone panel by 20px still meant "next".
    root.addEventListener('click', (e) => { e.stopPropagation(); this.advance(); });
    document.body.appendChild(root);
    this._root = root;
  }

  /** Open a script. Replaces any script already up (last writer wins). */
  show(script) {
    if (!script || !script.lines?.length) return;
    this._ensure();
    this._script = script;
    this._i = 0;
    this._render();
    this._root.classList.remove('hidden');
    document.body.classList.add('gb-dialog');
  }

  /**
   * Router-driven teardown: hide, drop the body class, discard the script
   * WITHOUT firing onDone — a transition away from the city (death mid-read,
   * a tool driving __app.go) must not count as "read"; the script re-offers
   * on the next natural trigger. advance() stays the only completing path.
   * Mirrors MapUI.close()'s reconcile contract in main.js.
   */
  close() {
    this._script = null;
    this._root?.classList.add('hidden');
    document.body.classList.remove('gb-dialog');
  }

  /** Tap / hardware-back: next line, or close after the last. */
  advance() {
    if (!this._script) return;
    this._i++;
    if (this._i >= this._script.lines.length) {
      const done = this._script.onDone;
      this._script = null;
      this._root.classList.add('hidden');
      document.body.classList.remove('gb-dialog');
      done?.();
      return;
    }
    this._render();
  }

  _render() {
    const s = this._script;
    this._speakerEl.textContent = s.speaker || '';
    this._lineEl.textContent = s.lines[this._i];
    const left = s.lines.length - this._i - 1;
    this._moreEl.textContent = left > 0 ? `TAP · ${left} MORE` : 'TAP TO CLOSE';
  }
}
