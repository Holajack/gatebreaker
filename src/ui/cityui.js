// The city's diegetic overlay: portal / door prompt, district banner, and a
// compass to the nearest portal you are actually allowed to walk into.
//
// Pure DOM and CSS. It builds its own nodes and injects its own stylesheet so
// it does not share a file — or a merge conflict — with ui.js or styles.css.
//
// Two layout rules that are not negotiable on a phone:
//   * the confirm button is >= 56 px and sits in the lower-RIGHT thumb arc,
//     clear of #stickZone on the left;
//   * nothing in here takes pointer events except that button, or it would eat
//     thumbstick drags that pass over it.
//
// Every node below is built with createElement/textContent rather than
// innerHTML. All of this content is authored here, but portal labels flow in
// from save data and district names from city.js, and a markup sink is a
// markup sink whatever you believe about its inputs today.

import { PORTAL_COLORS } from '../world/city.js';

const CSS = `
#cityUi { position: fixed; inset: 0; pointer-events: none; z-index: 40;
  font-family: inherit; }
#cityUi.hidden { display: none; }

#cityDistrict {
  position: absolute; top: max(10px, env(safe-area-inset-top)); left: 50%;
  transform: translateX(-50%);
  padding: 5px 16px; border-radius: 999px;
  background: rgba(6,9,18,0.52); border: 1px solid rgba(190,210,255,0.16);
  color: #dce6ff; font-size: 12px; letter-spacing: 0.22em; font-weight: 700;
  text-transform: uppercase; white-space: nowrap;
  opacity: 0; transition: opacity 320ms ease;
}
#cityDistrict.on { opacity: 1; }

#cityCompass {
  position: absolute; top: max(52px, calc(env(safe-area-inset-top) + 44px));
  left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; border-radius: 999px;
  background: rgba(6,9,18,0.42); border: 1px solid rgba(190,210,255,0.12);
  color: #b9c6e8; font-size: 11px; letter-spacing: 0.14em;
  opacity: 0; transition: opacity 260ms ease;
}
#cityCompass.on { opacity: 1; }
#cityCompassArrow { width: 14px; height: 14px; display: block; }

#cityPrompt {
  position: absolute; right: 18px; bottom: 116px;
  max-width: min(46vw, 340px);
  padding: 9px 14px; border-radius: 12px;
  background: rgba(6,9,18,0.72);
  border: 1px solid rgba(190,210,255,0.2);
  border-left-width: 4px;
  color: #eaf0ff; text-align: right;
  opacity: 0; transform: translateY(8px);
  transition: opacity 160ms ease, transform 160ms ease;
}
#cityPrompt.on { opacity: 1; transform: translateY(0); }
#cityPrompt b { display: block; font-size: 14px; letter-spacing: 0.16em;
  text-transform: uppercase; }
#cityPrompt small { display: block; margin-top: 2px; font-size: 11px;
  letter-spacing: 0.08em; color: #97a4c8; }
#cityPrompt.locked b { color: #ff9fb0; }

#cityConfirm {
  position: absolute; right: 20px; bottom: 34px;
  width: 74px; height: 74px; min-width: 56px; min-height: 56px;
  border-radius: 50%; pointer-events: auto;
  display: none; align-items: center; justify-content: center;
  flex-direction: column; gap: 1px;
  background: rgba(14,20,38,0.9);
  border: 2px solid rgba(190,210,255,0.55);
  color: #eaf0ff; font-size: 10px; letter-spacing: 0.14em; font-weight: 700;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  box-shadow: 0 0 18px rgba(0,0,0,0.5);
}
#cityConfirm.on { display: flex; }
#cityConfirm .glyph { font-size: 22px; line-height: 1; }
#cityConfirm:active { transform: scale(0.94); }
#cityConfirm.locked { opacity: 0.55; }

/* Dungeon-only HUD furniture has no meaning on the street. The thumbstick,
   the pause button and the vitals stay. */
body.gb-city #hud .skills { display: none !important; }
body.gb-city #hud .objective { display: none !important; }
body.gb-city #btnQuit { display: none !important; }
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

let _styleEl = null;
function ensureStyle() {
  if (_styleEl && _styleEl.isConnected) return;
  _styleEl = document.createElement('style');
  _styleEl.id = 'cityUiStyle';
  _styleEl.textContent = CSS;
  document.head.appendChild(_styleEl);
}

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

function div(id, parent) {
  const d = document.createElement('div');
  d.id = id;
  parent.appendChild(d);
  return d;
}

export class CityUI {
  constructor({ root = document.body, onConfirm } = {}) {
    ensureStyle();
    this.onConfirm = onConfirm || null;
    this._prompt = null;
    this._districtName = null;
    this._fired = 0;

    const wrap = div('cityUi', root);
    wrap.className = 'hidden';

    this.districtEl = div('cityDistrict', wrap);

    this.compassEl = div('cityCompass', wrap);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'cityCompassArrow';
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M8 1 L13 14 L8 11 L3 14 Z');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    this.compassEl.appendChild(svg);
    this.compassArrow = svg;
    this.compassText = document.createElement('span');
    this.compassText.id = 'cityCompassText';
    this.compassText.textContent = '—';
    this.compassEl.appendChild(this.compassText);

    this.promptEl = div('cityPrompt', wrap);
    this.promptTitle = document.createElement('b');
    this.promptSub = document.createElement('small');
    this.promptEl.appendChild(this.promptTitle);
    this.promptEl.appendChild(this.promptSub);

    const btn = document.createElement('button');
    btn.id = 'cityConfirm';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Confirm');
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = '◈';
    const caption = document.createElement('span');
    caption.textContent = 'ENTER';
    btn.appendChild(glyph);
    btn.appendChild(caption);
    wrap.appendChild(btn);

    this.root = wrap;
    this.confirmEl = btn;
    this.confirmCaption = caption;

    // touchstart as well as click: on Android the click delay makes a gate feel
    // like it did not register and players tap twice. The 400 ms latch keeps
    // the pair from firing the same confirmation twice.
    this._fire = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - this._fired < 400) return;
      this._fired = Date.now();
      this.onConfirm?.(this._prompt);
    };
    btn.addEventListener('touchstart', this._fire, { passive: false });
    btn.addEventListener('click', this._fire);
  }

  /**
   * @param {{kind:'portal'|'interact', label:string, rank?:string,
   *          locked?:boolean, sub?:string}|null} prompt
   */
  setPrompt(prompt) {
    const same = (
      (!prompt && !this._prompt)
      || Boolean(prompt && this._prompt
        && prompt.label === this._prompt.label
        && prompt.locked === this._prompt.locked
        && prompt.sub === this._prompt.sub)
    );
    this._prompt = prompt || null;
    if (same) return;

    if (!prompt) {
      this.promptEl.classList.remove('on');
      this.confirmEl.classList.remove('on', 'locked');
      return;
    }
    const color = prompt.rank ? PORTAL_COLORS[prompt.rank] : null;
    this.promptEl.style.borderLeftColor = color ? hex(color) : 'rgba(190,210,255,0.5)';
    this.promptTitle.textContent = prompt.label || '';
    // citymode still labels unbuilt doors "NOT YET OPEN", which reads as a dev
    // teaser for missing content. Until every district door leads somewhere,
    // present the same door as a place that is merely shut right now.
    const sub = prompt.sub === 'NOT YET OPEN' ? 'CLOSED' : prompt.sub;
    this.promptSub.textContent = sub || (prompt.kind === 'portal' ? 'ENTER THE GATE' : 'OPEN');
    this.promptEl.classList.toggle('locked', Boolean(prompt.locked));
    this.promptEl.classList.add('on');

    this.confirmCaption.textContent = prompt.locked ? 'LOCKED' : (prompt.kind === 'portal' ? 'ENTER' : 'OPEN');
    this.confirmEl.classList.toggle('locked', Boolean(prompt.locked));
    this.confirmEl.style.borderColor = color && !prompt.locked ? hex(color) : 'rgba(190,210,255,0.55)';
    this.confirmEl.classList.add('on');
  }

  /** The prompt currently on screen, or null. */
  get prompt() { return this._prompt; }

  setDistrict(name) {
    if (name === this._districtName) return;
    this._districtName = name || null;
    if (!name) { this.districtEl.classList.remove('on'); return; }
    this.districtEl.textContent = name;
    this.districtEl.classList.add('on');
  }

  /**
   * @param {number} angleRad screen-space bearing, 0 = up
   * @param {number} distance metres
   * @param {number} color portal colour
   */
  setCompass(angleRad, distance, color) {
    if (!Number.isFinite(angleRad)) { this.compassEl.classList.remove('on'); return; }
    this.compassArrow.style.transform = `rotate(${angleRad}rad)`;
    this.compassArrow.style.color = hex(color || 0xbfd0ff);
    this.compassText.textContent = `${Math.round(distance)} M`;
    this.compassEl.classList.add('on');
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('gb-city', Boolean(on));
    if (!on) {
      this.setPrompt(null);
      this.setDistrict(null);
      this.compassEl.classList.remove('on');
    }
  }

  dispose() {
    this.confirmEl.removeEventListener('touchstart', this._fire);
    this.confirmEl.removeEventListener('click', this._fire);
    this.root.remove();
    document.body.classList.remove('gb-city');
  }
}

export default CityUI;
