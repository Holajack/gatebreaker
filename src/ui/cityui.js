// The city's diegetic overlay: portal / door prompt, district banner, and a
// compass with up to three rank-tinted pips — the nearest portals you are
// actually allowed to walk into, nearest largest (Wave B2: the gates spread
// into the districts, so one arrow stopped being wayfinding).
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
import {
  CLASS_LIST, CLASS_QUALITY, DIRECTIONS,
  directionOf, masteryTier, canChooseClass, chooseClass,
  canRechooseClass, rechooseClass, rechooseCost,
} from '../game/classes.js';

const CSS = `
/* The blue-white --ui-city-* family lives in styles.css's :root token block
   with the rest of the design tokens: this sheet is injected into the same
   document, so var() resolves against the same :root, and the street palette
   can no longer fork from the file that names it. */
#cityUi { position: fixed; inset: 0; pointer-events: none; z-index: var(--z-city);
  font-family: inherit; }
#cityUi.hidden { display: none; }

#cityDistrict {
  position: absolute; top: max(10px, env(safe-area-inset-top)); left: 50%;
  transform: translateX(-50%);
  padding: 5px 16px; border-radius: 999px;
  background: rgba(6,9,18,0.52); border: 1px solid var(--ui-city-border);
  color: var(--ui-city-text); font-size: 12px; letter-spacing: 0.22em; font-weight: 700;
  text-transform: uppercase; white-space: nowrap;
  opacity: 0; transition: opacity 320ms ease;
}
#cityDistrict.on { opacity: 1; }

#cityCompass {
  position: absolute; top: max(52px, calc(env(safe-area-inset-top) + 44px));
  left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; border-radius: 999px;
  background: rgba(6,9,18,0.42); border: 1px solid var(--ui-city-border-dim);
  color: var(--ui-city-text-dim); font-size: 11px; letter-spacing: 0.14em;
  opacity: 0; transition: opacity 260ms ease;
}
#cityCompass.on { opacity: 1; }
/* Pip 0 is the nearest target and reads first; pips 1-2 are the next-nearest
   gates at two-thirds size — present enough to steer by, small enough that
   the pill stays a glance, not a legend. */
#cityCompass .pip { width: 10px; height: 10px; display: block; }
/* Specificity must BEAT '#cityCompass .pip' (1,1,0) or the nearest-gate
   arrow silently renders 10px like the rest — a bare '#cityCompassArrow'
   (1,0,0) loses that fight (review finding, confirmed). */
#cityCompass .pip#cityCompassArrow { width: 14px; height: 14px; }

#cityPrompt {
  position: absolute; right: 18px; bottom: 116px;
  max-width: min(46vw, 340px);
  padding: 9px 14px; border-radius: 12px;
  background: rgba(6,9,18,0.72);
  border: 1px solid var(--ui-city-border-strong);
  border-left-width: 4px;
  color: var(--ui-city-text-bright); text-align: right;
  opacity: 0; transform: translateY(8px);
  transition: opacity 160ms ease, transform 160ms ease;
}
#cityPrompt.on { opacity: 1; transform: translateY(0); }
#cityPrompt b { display: block; font-size: 14px; letter-spacing: 0.16em;
  text-transform: uppercase; }
#cityPrompt small { display: block; margin-top: 2px; font-size: 11px;
  letter-spacing: 0.08em; color: var(--ui-city-sub); }
#cityPrompt.locked b { color: var(--ui-city-locked); }

#cityConfirm {
  position: absolute; right: 20px; bottom: 34px;
  width: 74px; height: 74px; min-width: 56px; min-height: 56px;
  border-radius: 50%; pointer-events: auto;
  display: none; align-items: center; justify-content: center;
  flex-direction: column; gap: 1px;
  background: rgba(14,20,38,0.9);
  border: 2px solid var(--ui-city-edge);
  color: var(--ui-city-text-bright); font-size: 10px; letter-spacing: 0.14em; font-weight: 700;
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
    // Up to THREE arrow pips (Wave B2): the gates live in the districts now,
    // and one arrow to "the nearest" says nothing about the other roads. The
    // first pip is the nearest target and renders larger; all three share one
    // build path so single-target callers (the legacy setCompass signature —
    // frontier POI discovery aims it at one thing) simply light pip 0.
    this.compassPips = [];
    for (let i = 0; i < 3; i++) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      if (i === 0) svg.id = 'cityCompassArrow';
      svg.setAttribute('class', `pip pip${i}`);
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M8 1 L13 14 L8 11 L3 14 Z');
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
      this.compassEl.appendChild(svg);
      this.compassPips.push(svg);
    }
    this.compassArrow = this.compassPips[0];
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
   * @param {{kind:'portal'|'interact'|'talk', label:string, rank?:string,
   *          locked?:boolean, sub?:string}|null} prompt
   * 'talk' (C-TALK) is a person, not a door: no rank, never locked, and the
   * confirm button captions TALK so a thumb knows it is starting a
   * conversation, not walking through something.
   */
  setPrompt(prompt) {
    const same = (
      (!prompt && !this._prompt)
      || Boolean(prompt && this._prompt
        && prompt.kind === this._prompt.kind
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
    this.promptEl.style.borderLeftColor = color ? hex(color) : 'var(--ui-city-edge-soft)';
    this.promptTitle.textContent = prompt.label || '';
    // citymode still labels unbuilt doors "NOT YET OPEN", which reads as a dev
    // teaser for missing content. Until every district door leads somewhere,
    // present the same door as a place that is merely shut right now.
    const sub = prompt.sub === 'NOT YET OPEN' ? 'CLOSED' : prompt.sub;
    this.promptSub.textContent = sub || (prompt.kind === 'portal' ? 'ENTER THE GATE' : 'OPEN');
    this.promptEl.classList.toggle('locked', Boolean(prompt.locked));
    this.promptEl.classList.add('on');

    this.confirmCaption.textContent = prompt.locked ? 'LOCKED'
      : prompt.kind === 'portal' ? 'ENTER'
        : prompt.kind === 'talk' ? 'TALK'
          : 'OPEN';
    this.confirmEl.classList.toggle('locked', Boolean(prompt.locked));
    this.confirmEl.style.borderColor = color && !prompt.locked ? hex(color) : 'var(--ui-city-edge)';
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
   * Aim the compass. Two shapes, one method:
   *
   *   setCompass([{ angle, distance, color }, ...])  — up to 3 targets,
   *     NEAREST FIRST (the caller sorts; this renders). Pip 0 is the big
   *     arrow and owns the distance text; extra pips render smaller in their
   *     own tint. Empty array hides the pill.
   *   setCompass(angleRad, distance, color)          — the legacy single-
   *     target signature, kept working verbatim (frontier POI discovery and
   *     any older caller aim one thing): it is the array form with one entry.
   *
   * @param {Array<{angle:number,distance:number,color:number}>|number} angleRad
   *   screen-space bearing(s), 0 = up
   * @param {number} [distance] metres (single-target form)
   * @param {number} [color] portal colour (single-target form)
   */
  setCompass(angleRad, distance, color) {
    const targets = Array.isArray(angleRad)
      ? angleRad
      : (Number.isFinite(angleRad) ? [{ angle: angleRad, distance, color }] : []);
    if (!targets.length) { this.compassEl.classList.remove('on'); return; }
    for (let i = 0; i < this.compassPips.length; i++) {
      const pip = this.compassPips[i];
      const t = targets[i];
      if (!t || !Number.isFinite(t.angle)) { pip.style.display = 'none'; continue; }
      pip.style.display = 'block';
      pip.style.transform = `rotate(${t.angle}rad)`;
      pip.style.color = hex(t.color || 0xbfd0ff);
    }
    this.compassText.textContent = `${Math.round(targets[0].distance)} M`;
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

// ---------------------------------------------------------------------------
// THE ASSAY HALL DESK — the class-choice panel (CLASSES_SPEC STEP 5).
//
// An OVERLAY, not an AppState screen, for exactly the reason shopui.js records:
// routing through the router would tear down and rebuild the whole city every
// time the player closed a menu he opened by standing in a doorway. Same
// pattern throughout — shipped .panel / .btn / .gate classes, own injected
// sheet for only what no existing screen has, createElement/textContent for
// every node (class names and texts are authored in classes.js, but a markup
// sink is a markup sink whatever you believe about its inputs today).
//
// THE ONE PRESENTATION RULE THAT IS NOT NEGOTIABLE (spec risk "drawback
// resentment"): drawbacks render in the SAME TYPE SIZE as benefits, on this
// panel, forever. A class whose downside a player did not read is a class they
// will blame the game for. Both lines are 11.5px below; only the colour
// differs.

const ASSAY_CSS = `
#assayPanel { z-index: var(--z-modal); }
body.gb-assay #cityUi { display: none !important; }

#assayPanel .assay-strip {
  display: flex; justify-content: space-between; gap: 12px;
  border: 1px solid var(--edge); border-radius: 10px;
  padding: 8px 14px; font-size: 12px; letter-spacing: .1em;
  background: rgba(124,92,255,.07);
}
#assayPanel .assay-strip b { color: var(--gold); }
#assayPanel .assay-strip .right { color: var(--dim); }
#assayPanel .assay-strip .right b { color: var(--ink); }

#assayPanel .assay-list { max-height: min(52vh, 360px); overflow-y: auto; }
/* The fold must never lie (fixup 1): on a 412 px-tall landscape phone the
   flex column squeezed the list to exactly one row, cut clean at the row
   boundary — the panel read as "BERSERKER — PICK A CLASS" and seven classes
   were invisible with no affordance at all. Two fixes below: _snapPeek()
   caps the list at n-and-a-half rows whenever at least 1.5 fit (a torn row
   IS the affordance), and .assay-more is the honest counter for viewports
   too short even for that. */
#assayPanel .assay-more {
  text-align: center; font-size: 10.5px; font-weight: 800;
  letter-spacing: .14em; color: var(--gold); line-height: 1.2;
  min-height: 13px; margin-top: -4px;
}
#assayPanel .assay-more.off { visibility: hidden; }
/* Short landscape phones: the flavour sentence costs a third of the
   roster's room, and the rows already carry the whole pitch (benefit AND
   drawback in equal type) — the panel sheds its subtitle before it hides a
   class. */
@media (max-height: 520px) {
  #assayPanel .panel-sub { display: none; }
  #assayPanel .panel { gap: 8px; padding: 14px 16px; }
}
/* The roster row is a .gate; these are only the parts a gate row has no slot
   for. The affinity pill reuses the gate list's swatch geometry. */
#assayPanel .gate { padding: 9px 12px; align-items: flex-start; }
#assayPanel .gate .aff {
  width: 44px; min-width: 44px; display: grid; place-items: center;
  border-radius: 9px; font-size: 10px; font-weight: 800; letter-spacing: .06em;
  padding: 6px 2px; border: 1px solid var(--edge); color: var(--dim);
  text-align: center; line-height: 1.4;
}
#assayPanel .gate.resonant .aff { color: var(--gold); border-color: rgba(255,194,75,.55); }
#assayPanel .gate .meta { min-width: 0; }
#assayPanel .gate .badge {
  display: inline-block; margin-left: 8px; font-size: 10px; font-weight: 800;
  letter-spacing: .12em; color: var(--gold);
}
#assayPanel .gate .fant { display: block; color: var(--dim); font-size: 11px; font-style: italic; }
/* Benefit and drawback: SAME SIZE, colour is the only difference. */
#assayPanel .gate .ben, #assayPanel .gate .dbk {
  display: block; font-size: 11.5px; line-height: 1.45; letter-spacing: .02em;
  white-space: normal;
}
#assayPanel .gate .ben { color: var(--accent2); }
#assayPanel .gate .dbk { color: var(--danger); }
#assayPanel .gate.sel { border-color: var(--gold); background: rgba(255,194,75,.08); }
#assayPanel .gate .sworn {
  margin-left: auto; white-space: nowrap; font-size: 10.5px; font-weight: 800;
  letter-spacing: .12em; color: var(--gold);
}
#assayPanel .assay-actions { display: flex; gap: 10px; }
#assayPanel .assay-actions .btn { flex: 1; }
#assayPanel .btn.confirm { border-color: rgba(255,194,75,.6); color: var(--gold); }
#assayPanel .btn.confirm:disabled { opacity: .45; }
`;

let _assayStyleEl = null;
function ensureAssayStyle() {
  if (_assayStyleEl && _assayStyleEl.isConnected) return;
  _assayStyleEl = document.createElement('style');
  _assayStyleEl.id = 'assayUiStyle';
  _assayStyleEl.textContent = ASSAY_CSS;
  document.head.appendChild(_assayStyleEl);
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const QUALITY_LABEL = { base: 'BASE', advanced: 'ADVANCED', sovereign: 'SOVEREIGN' };

export class AssayUI {
  /**
   * @param {{game:object, audio?:object, root?:HTMLElement}} opts
   *   `game` is the live Game: the panel reads game.save, commits through
   *   game/classes.js, re-derives through game.refreshDerived() (the single
   *   computation site) and persists through game.onSave() — one writer, so
   *   the choice and the wallet land in localStorage in the same write.
   */
  constructor({ game, audio = null, root = document.body } = {}) {
    ensureAssayStyle();
    this.game = game || null;
    this.audio = audio || game?.audio || null;
    this._open = false;
    this._selected = null;

    const screen = el('div', 'screen overlay hidden');
    screen.id = 'assayPanel';

    const panel = el('div', 'panel wide');
    panel.appendChild(el('h2', null, 'THE ASSAY HALL'));
    panel.appendChild(el('p', 'panel-sub',
      'The assayer measures what you already are. A class is a shape, not a strength — every benefit below is paid for.'));

    this.stripEl = el('div', 'assay-strip');
    this.stripPath = el('span');
    this.stripRight = el('span', 'right');
    this.stripEl.appendChild(this.stripPath);
    this.stripEl.appendChild(this.stripRight);
    panel.appendChild(this.stripEl);

    this.listEl = el('div', 'gate-list assay-list');
    this.listEl.id = 'assayList';
    panel.appendChild(this.listEl);

    // The below-the-fold counter ("▼ 6 MORE CLASSES BELOW"): visibility, not
    // display, so hiding it at the bottom of the scroll cannot reflow the
    // list it describes. Updated on scroll and on every render.
    this.moreEl = el('div', 'assay-more off');
    this.moreEl.id = 'assayMore';
    panel.appendChild(this.moreEl);
    this.listEl.addEventListener('scroll', () => this._syncMore());

    const actions = el('div', 'assay-actions');
    this.confirmBtn = el('button', 'btn confirm', 'CHOOSE');
    this.confirmBtn.id = 'assayConfirm';
    this.confirmBtn.type = 'button';
    this.confirmBtn.addEventListener('click', () => this._confirm());
    actions.appendChild(this.confirmBtn);
    panel.appendChild(actions);

    const footer = el('div', 'assay-actions');
    // The desk keeps its old job: the fast-travel list is one tap away, so
    // adding classes to the Assay Hall never took RIFT CONTRACTS off it.
    const gates = el('button', 'btn ghost', 'RIFT CONTRACTS');
    gates.id = 'assayGates';
    gates.type = 'button';
    gates.addEventListener('click', () => {
      this.audio?.ui?.();
      this.close();
      this.game?.appState?.go('gates', { from: 'city' });
    });
    const close = el('button', 'btn ghost', 'LEAVE');
    close.id = 'assayClose';
    close.type = 'button';
    close.addEventListener('click', () => { this.audio?.ui?.(); this.close(); });
    footer.appendChild(gates);
    footer.appendChild(close);
    panel.appendChild(footer);

    screen.appendChild(panel);
    root.appendChild(screen);
    this.root = screen;
  }

  get isOpen() { return this._open; }

  /**
   * Open the desk. Returns false below level 20 — the assayer has nothing to
   * measure yet, and citymode falls back to the shipped contracts list.
   */
  open() {
    const save = this.game?.save;
    if (!save || (save.level || 0) < 20) return false;
    this._selected = null;
    // Unhide BEFORE render: _snapPeek measures real row geometry, and a
    // display:none subtree measures as zero everywhere.
    this.root.classList.remove('hidden');
    document.body.classList.add('gb-assay');
    this._open = true;
    this.render();
    // The migration's promise (CLASSES_SPEC migration step 2): a save already
    // past the gate is told, in gold, that the choice is on the table.
    if (canChooseClass(save)) this.game?.ui?.toast?.('YOUR CLASS AWAITS', 'gold');
    return true;
  }

  close() {
    this.root.classList.add('hidden');
    document.body.classList.remove('gb-assay');
    this._open = false;
  }

  /** Rebuild the roster from the save. Eight rows — cheap enough to re-render on every commit. */
  render() {
    const save = this.game?.save;
    if (!save) return;
    const dir = directionOf(save);
    const dirTier = dir === 'unsworn' ? 0 : masteryTier(save, dir);

    // The header the spec asks for by name: legibility does more work than
    // the 12% does.
    this.stripPath.textContent = '';
    this.stripPath.appendChild(document.createTextNode('YOUR PATH SO FAR READS AS '));
    this.stripPath.appendChild(el('b', null, dir === 'unsworn' ? 'UNSWORN' : DIRECTIONS[dir].name));
    this.stripRight.textContent = '';
    if (canRechooseClass(save)) {
      // Reseal mode: the wallet matters, so show it beside the price.
      const cost = rechooseCost(save);
      this.stripRight.appendChild(document.createTextNode(cost > 0 ? `RESEAL ${cost} · ASH ` : 'FIRST RESEAL FREE · ASH '));
      this.stripRight.appendChild(el('b', null, String(Math.floor(save.ash || 0))));
    } else {
      // Choice mode: the earned quality is already banked for a post-40 save.
      this.stripRight.appendChild(document.createTextNode('CLASS QUALITY '));
      this.stripRight.appendChild(el('b', null, save.classTier
        ? `${QUALITY_LABEL[save.classTier]} x${CLASS_QUALITY[save.classTier].toFixed(2)}`
        : 'UNTRIED'));
    }

    // Resonant classes first (spec matchingPolicy.encouragementBeyondNumbers);
    // sort stability keeps CLASSES declaration order within each half.
    const roster = CLASS_LIST.slice().sort(
      (a, b) => Number(b.affinity.includes(dir)) - Number(a.affinity.includes(dir)),
    );
    this.listEl.textContent = '';
    for (const cls of roster) {
      this.listEl.appendChild(this._rowNode(cls, save, dir, dirTier));
    }
    this._syncConfirm();
    // Geometry passes after the DOM lands: rAF so the rows have laid out.
    requestAnimationFrame(() => { this._snapPeek(); });
  }

  /**
   * Never let the fold coincide with a row boundary (the failure a 412 px
   * landscape phone shipped with: exactly one fully-visible row, zero
   * scrollbar, and a panel that read as a single-class offer). Whenever at
   * least one-and-a-half rows fit, cap the list at n full rows plus half the
   * next — a torn row is a scroll affordance no one misreads. When even that
   * does not fit, leave the CSS height alone and let _syncMore's counter
   * carry the message.
   */
  _snapPeek() {
    const list = this.listEl;
    if (!list.isConnected || this.root.classList.contains('hidden')) return;
    list.style.maxHeight = '';                    // measure at the CSS ceiling
    const rows = list.children;
    if (rows.length >= 2 && list.scrollHeight > list.clientHeight + 4) {
      const r0 = rows[0].getBoundingClientRect();
      const r1 = rows[1].getBoundingClientRect();
      const pitch = r1.top - r0.top;              // row height + list gap
      if (pitch > 0) {
        const k = Math.floor((list.clientHeight - pitch * 0.5) / pitch);
        if (k >= 1) list.style.maxHeight = `${Math.round((k + 0.5) * pitch)}px`;
      }
    }
    this._syncMore();
  }

  /** The honest fold counter: how many class rows sit below the visible edge. */
  _syncMore() {
    const list = this.listEl;
    const more = this.moreEl;
    if (!more) return;
    const lim = list.getBoundingClientRect().bottom;
    let below = 0;
    // A row counts as "below" until a meaningful slice of it (12 px) shows.
    for (const row of list.children) {
      if (row.getBoundingClientRect().top > lim - 12) below++;
    }
    if (below <= 0) {
      more.classList.add('off');
    } else {
      more.textContent = `▼ ${below} MORE ${below === 1 ? 'CLASS' : 'CLASSES'} BELOW`;
      more.classList.remove('off');
    }
  }

  _rowNode(cls, save, dir, dirTier) {
    const resonant = cls.affinity.includes(dir);
    const row = el('button', 'gate');
    row.type = 'button';
    row.dataset.classKey = cls.key;
    if (resonant) row.classList.add('resonant');
    if (this._selected === cls.key) row.classList.add('sel');

    const aff = el('span', 'aff', cls.affinity.map((k) => k.toUpperCase()).join(' + '));
    row.appendChild(aff);

    const meta = el('span', 'meta');
    const name = el('b', null, cls.name);
    if (resonant) {
      // Gold, and tiered: RESONANT 0 is a match with no depth yet, and saying
      // the number is how the panel teaches that depth is what pays.
      name.appendChild(el('span', 'badge', dirTier > 0 ? `RESONANT ${dirTier}` : 'RESONANT'));
    }
    meta.appendChild(name);
    meta.appendChild(el('small', 'fant', cls.fantasy));
    meta.appendChild(el('small', 'ben', cls.benefitText));
    meta.appendChild(el('small', 'dbk', cls.drawbackText));
    row.appendChild(meta);

    if (save.className === cls.key) row.appendChild(el('span', 'sworn', 'SWORN'));

    row.addEventListener('click', () => {
      this.audio?.ui?.();
      this._selected = this._selected === cls.key ? null : cls.key;
      this.render();
    });
    return row;
  }

  /** The confirm button says exactly what committing costs, or why it cannot. */
  _syncConfirm() {
    const save = this.game?.save;
    const btn = this.confirmBtn;
    const cls = CLASS_LIST.find((c) => c.key === this._selected);
    if (!cls) {
      btn.textContent = canRechooseClass(save) ? 'PICK A CLASS TO RESEAL' : 'PICK A CLASS';
      btn.disabled = true;
      return;
    }
    if (save.className === cls.key) {
      btn.textContent = 'YOUR CURRENT OATH';
      btn.disabled = true;
      return;
    }
    if (canChooseClass(save)) {
      btn.textContent = `BECOME ${cls.name}`;
      btn.disabled = false;
      return;
    }
    const cost = rechooseCost(save);
    btn.textContent = cost > 0 ? `RESEAL AS ${cls.name} · ${cost} ASH` : `RESEAL AS ${cls.name} · FREE`;
    btn.disabled = cost > (save.ash || 0);
  }

  _confirm() {
    const g = this.game;
    const save = g?.save;
    const cls = CLASS_LIST.find((c) => c.key === this._selected);
    if (!g || !save || !cls) return;
    this.audio?.ui?.();
    if (canChooseClass(save)) {
      if (!chooseClass(save, cls.key)) return;
      g.ui?.toast?.(`SWORN: ${cls.name} · +1 RESPEC TOKEN`, 'gold');
    } else {
      const cost = rechooseCost(save);
      if (!rechooseClass(save, cls.key)) {
        g.ui?.toast?.('NOT ENOUGH ASH', 'danger');
        return;
      }
      g.ui?.toast?.(cost > 0 ? `RESEALED: ${cls.name} · -${cost} ASH` : `RESEALED: ${cls.name} · SEAL SPENT`, 'gold');
    }
    // The single computation site folds the new class in; onSave persists the
    // choice and (on a reseal) the spend in the same write — one writer, no
    // drift, exactly the shopui.js discipline.
    g.refreshDerived();
    g.onSave?.();
    this._selected = null;
    this.render();
  }
}

export default CityUI;
