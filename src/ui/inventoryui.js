// The hunter's sheet: eight equipment slots, everything the character is, and
// the stow/draw toggle the owner asked for in the plaza.
//
// It is an OVERLAY, not an AppState screen, and that is the same deliberate
// call shopui.js documents: AppState.go('city') calls Game.enterCity, which
// calls _setMode, which DISPOSES AND REBUILDS the entire city and teleports the
// player back to spawn. Routing this panel through the router would tear down
// 200-odd draw calls of town every time the player closed his own inventory.
// So it behaves like #shop and #levelup — a fixed overlay toggled by classList,
// with main.js's hardware-back chain taught one more id.
//
// Constructed ONCE, in main.js, beside the ShopUI. Rebuilding the DOM per open
// would leak an #inv node per visit; main.js already records that lesson about
// the shop.
//
// WAVE 3-A SCOPE, stated plainly because the panel states it too: the WEAPON
// slot is live, the five armour slots and the offhand exist in the save model
// and render as real empty slots, and nothing in here invents an armour stat or
// a set bonus. A slot that lies about what it does is worse than a slot that
// says "not yet".
//
// Every node is built with createElement/textContent. Weapon names come out of
// rollWeapon's buildName, but the repo's standing rule is that a markup sink is
// a markup sink whatever you believe about its inputs today.

import { EQUIP_SLOTS } from '../core/save.js';
import {
  rarityColor, RARITIES, weaponSummary, weaponStance, setStance, weaponModelName,
} from '../game/weapons.js';
import { STATS, STAT_RATES, derive, rankOf, xpForLevel } from '../game/config.js';
import { effectiveStat, shadowRosterCapacity, shadowFieldCapacity } from '../game/progression.js';
import { iconStyle } from './icons.js';

// Slot metadata. `kind` is the item kind the slot accepts, matching the save
// record's `k` field, so the GEAR list filter is a single comparison rather
// than a per-slot special case.
const SLOTS = {
  weapon: { name: 'WEAPON', kind: 'w', icon: 'sword', live: true, blurb: 'The family decides how combat FEELS: reach, arc, commitment, recovery.' },
  offhand: { name: 'OFFHAND', kind: 'o', icon: 'arrow', live: false, blurb: 'Quiver, focus or parry token. Arrives with the bow and the staff.' },
  head: { name: 'HEAD', kind: 'a', icon: 'crown', live: false, blurb: 'Perception: earlier enemy tells, harder crits.' },
  chest: { name: 'CHEST', kind: 'a', icon: 'armor_metal', live: false, blurb: 'The slab. The largest single armour contribution, and max health.' },
  hands: { name: 'HANDS', kind: 'a', icon: 'glove', live: false, blurb: 'Weapon handling: attack speed, and a shave off recovery.' },
  legs: { name: 'LEGS', kind: 'a', icon: 'armor_leather', live: false, blurb: 'Mobility: move speed and a wider perfect-dodge window.' },
  feet: { name: 'FEET', kind: 'a', icon: 'bone', live: false, blurb: 'Footing: stagger resistance, and less knockback taken.' },
  trinket: { name: 'TRINKET', kind: 't', icon: 'ring3', live: false, blurb: 'One exotic effect. No armour at all — leech, luck, ash-find.' },
};

// Rank pill classes already exist in styles.css (.rank-E .. .rank-SOVEREIGN),
// so the panel's rank badge is the same colour as the gate the player is
// allowed into. Reusing them is what keeps two screens from disagreeing.
const CSS = `
/* .screen is z-index 20 and #cityUi is 40, so without this the district
   banner and the live OPEN button render ON TOP of the panel and eat taps —
   the same fix #shop needed, for the same reason. */
#inv { z-index: 60; }
body.gb-inv #cityUi { display: none !important; }

#inv .panel { max-height: 92vh; gap: 10px; }
#inv .inv-wallet {
  display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  border: 1px solid var(--edge); border-radius: 10px;
  padding: 8px 12px; font-size: 12px; letter-spacing: .1em;
  background: rgba(124,92,255,.07);
}
#inv .inv-wallet b { color: var(--ink); }
#inv .inv-wallet .ash b { color: var(--gold); }
#inv .inv-wallet span { color: var(--dim); }

/* Two side-by-side scrolling columns, and this is not a style preference.
   Panel padding + h2 + the wallet strip eat ~120 px of a 412 px-tall landscape
   phone; ~290 px is left, and the sheet has strictly more content than the
   Exchange's eight-row shelf that already needed a scroll box. A single
   vertical list would be a peephole. */
#inv .cols { display: flex; gap: 10px; align-items: flex-start; }
#inv .slots {
  display: grid; grid-template-columns: repeat(2, 56px); gap: 5px; flex: 0 0 auto;
}
/* THE PANEL USES THE WHOLE PHONE. .panel.wide is 560 px, which on an 892 px
   landscape window left ~330 px of empty gutter while 63% of the sheet's body
   sat below a 214 px fold — the stash list was entirely off-screen with no cue
   that it existed. Nothing about a character sheet wants to be 560 px wide on a
   screen that is 892. The generic .panel cap stays put for every other overlay;
   only this one is content-dense enough to need the room. */
#inv .panel { width: min(880px, 100%); }

#inv .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
/* The tabs live OUTSIDE the scroll box now. They used to be the first children
   of the scrolling column, so scrolling the sheet carried the only control that
   switches tabs off the top of it. */
#inv .colwrap { position: relative; min-height: 0; }
#inv .col { max-height: min(52vh, 300px); overflow-y: auto; }

/* A scroll box a player cannot see is a scroll box a player will not use. The
   overlay scrollbars Chrome hands a touch device are invisible until you are
   already scrolling — i.e. exactly never, if you do not know there is more. So
   the track is always drawn, and a fade plus a chevron sits over the bottom
   edge until you reach the end. Both are pure affordance; neither moves
   content. */
#inv .col { scrollbar-width: thin; scrollbar-color: rgba(124,92,255,.6) rgba(255,255,255,.07); }
#inv .col::-webkit-scrollbar { width: 8px; }
#inv .col::-webkit-scrollbar-track { background: rgba(255,255,255,.07); border-radius: 4px; }
#inv .col::-webkit-scrollbar-thumb { background: rgba(124,92,255,.6); border-radius: 4px; }
#inv .morehint {
  position: absolute; left: 0; right: 0; bottom: 0; height: 34px;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 2px; pointer-events: none; opacity: 1; transition: opacity .15s;
  background: linear-gradient(to bottom, rgba(12,14,28,0), rgba(12,14,28,.94));
  color: var(--accent2); font-size: 9.5px; letter-spacing: .18em; font-weight: 800;
}
#inv .colwrap.at-end .morehint, #inv .colwrap.no-scroll .morehint { opacity: 0; }

/* The body splits again inside the column. On a landscape phone the sheet is
   wide and SHORT, so the fix for "the stash is below the fold" is to put the
   stash beside the equipped card rather than under it. Narrow windows stack. */
#inv .body2 { display: flex; gap: 10px; align-items: flex-start; }
#inv .body2 > .pane { flex: 1 1 0; min-width: 0; }
@media (max-width: 620px) { #inv .body2 { display: block; } }

#inv .slot {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 3px; border-radius: 9px; border: 1px solid transparent;
  background: rgba(124,92,255,.05); cursor: pointer; font: inherit; color: var(--dim);
}
/* 44 px is this repo's tap-target floor; the cell is a secondary target so it
   sits right on it rather than at cityui's 56 px thumb minimum. */
#inv .slot i { width: 44px; height: 44px; border-radius: 8px; border: 2px solid rgba(180,190,220,.22); }
#inv .slot small { font-size: 9px; letter-spacing: .06em; }
#inv .slot.sel { border-color: var(--accent); background: rgba(124,92,255,.2); }
#inv .slot.sel small { color: var(--ink); }
#inv .slot.locked { opacity: .55; }

#inv .tabs { display: flex; gap: 6px; margin-bottom: 8px; }
#inv .tabs button {
  flex: 1; padding: 7px 4px; border: 1px solid var(--edge); border-radius: 8px;
  background: transparent; color: var(--dim); font: inherit; font-size: 11px;
  letter-spacing: .12em; cursor: pointer;
}
#inv .tabs button.on { background: rgba(124,92,255,.18); color: var(--ink); border-color: var(--accent); font-weight: 800; }

/* shopui.js measured this: the gate row's 44 px swatch and 13 px padding fit
   two rows in a 412 px window, and 9px/36px fits nearly four. That is the
   difference between a list and a peephole, and it applies verbatim here. */
#inv .gate { padding: 8px 10px; gap: 10px; }
#inv .gate i { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 8px; }
#inv .gate .meta b { font-size: 13px; }
#inv .gate .meta small { font-size: 10.5px; }
#inv .gate .tagline { color: var(--dim); font-size: 10.5px; white-space: nowrap; letter-spacing: .08em; }
#inv .gate.on { border-color: var(--accent); background: rgba(124,92,255,.18); }
#inv .gate.on .tagline { color: var(--accent2); }

#inv .note {
  border: 1px dashed rgba(255,255,255,.16); border-radius: 10px;
  padding: 10px 12px; color: var(--dim); font-size: 11.5px; line-height: 1.7;
}
#inv .note b { color: var(--ink); }
#inv .sect { color: var(--accent2); font-size: 10.5px; letter-spacing: .18em; margin: 10px 0 3px; }
#inv .sect:first-child { margin-top: 0; }
#inv .readout .row small { color: var(--dim); font-size: 10px; letter-spacing: .04em; }
#inv .foot { display: flex; gap: 8px; }
#inv .foot .btn { padding: 10px; font-size: 13px; }

/* Desktop Chrome and portrait have the room to stack, so they do — two 300 px
   columns side by side on a 900 px-wide window is mostly empty gutter. */
@media (min-width: 700px) and (min-height: 620px) {
  #inv .cols { display: block; }
  #inv .slots { grid-template-columns: repeat(4, 56px); margin-bottom: 10px; }
  #inv .col { max-height: 44vh; }
}

/* A landscape phone is the tightest case in the game: ~412 px tall with a
   notch. Every row reclaimed here is a row of the sheet the player can read
   without scrolling, so the chrome gives up its height first. */
@media (orientation: landscape) and (max-height: 520px) {
  #inv .panel { max-height: 96vh; padding: 10px 14px; gap: 6px; }
  #inv .panel h2 { font-size: 15px; letter-spacing: .16em; }
  #inv .inv-wallet { padding: 4px 10px; font-size: 11px; }
  #inv .tabs { margin-bottom: 5px; }
  #inv .tabs button { padding: 5px 4px; }
  #inv .foot .btn { padding: 7px; font-size: 12px; }
  /* Let the scroll box take every pixel the panel is not using, instead of a
     52vh guess that left the panel itself scrolling underneath. The panel is
     the frame; exactly one thing inside it scrolls, and it is the column. */
  #inv .panel { overflow: hidden; }
  /* stretch, NOT the flex-start the wide layout wants: with flex-start the
     right-hand column keeps its CONTENT height, so it grows straight through
     the footer buttons instead of handing the overflow to its scroll box. */
  #inv .cols { flex: 1 1 auto; min-height: 0; align-items: stretch; }
  #inv .right { min-height: 0; }
  #inv .colwrap { flex: 1 1 auto; min-height: 0; display: flex; }
  #inv .col { flex: 1 1 auto; min-height: 0; max-height: none; }
}
`;

let _styleEl = null;
function ensureStyle() {
  if (_styleEl && _styleEl.isConnected) return;
  _styleEl = document.createElement('style');
  _styleEl.id = 'invUiStyle';
  _styleEl.textContent = CSS;
  document.head.appendChild(_styleEl);
}

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function row(label, value, sub) {
  const r = el('div', 'row');
  const left = el('span', null, label);
  if (sub) { const s = el('small', null, `  ${sub}`); left.appendChild(s); }
  r.appendChild(left);
  r.appendChild(el('b', null, value));
  return r;
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/** The icon key for a rolled weapon: the pack model name, lowercased. */
function weaponIcon(w) {
  if (!w) return null;
  const model = weaponModelName(w);
  if (model) return model.toLowerCase();
  // The polearm has no honest pack model and therefore no honest icon;
  // weapons.js's weaponModelName returns null on purpose. A grey cell is the
  // truthful answer and iconStyle already renders one for an unknown key.
  return null;
}

export class InventoryUI {
  /**
   * @param {{game:object, audio?:object, root?:HTMLElement}} opts
   *   `game` is the live Game. Equipping goes through game.equip, which is what
   *   persists (equip -> _persistLoadout -> onSave writes the WHOLE save). This
   *   panel never writes localStorage itself: two writers is how a wallet and
   *   an inventory drift apart.
   */
  constructor({ game, audio = null, root = document.body } = {}) {
    ensureStyle();
    this.game = game || null;
    this.audio = audio || game?.audio || null;
    this._open = false;
    this._slot = 'weapon';
    this._tab = 'gear';
    // Set on open() and honoured on close(): opening the sheet inside a gate
    // pauses the sim, opening it in the city does not. The asymmetry is
    // deliberate — a loadout decision under threat should not get you eaten,
    // and the city is safe (the Exchange does not pause either). Without this
    // flag, closing the panel in the city would un-pause a game that a
    // separate pause menu had legitimately paused.
    this._pausedByUs = false;
    // Set by whoever opened the panel; called once on close. main.js uses it to
    // put the PAUSE screen back when the sheet was opened from it — without
    // that, hiding #pause to show this and then closing this leaves the game
    // paused with no panel on screen and no way to resume. A soft-lock.
    this.onClose = null;

    const screen = el('div', 'screen overlay hidden');
    screen.id = 'inv';

    const panel = el('div', 'panel wide');
    panel.appendChild(el('h2', null, 'THE HUNTER'));

    const wallet = el('div', 'inv-wallet');
    const lv = el('span', null, 'LV ');
    this.lvValue = el('b', null, '1');
    lv.appendChild(this.lvValue);
    const rk = el('span', null, 'RANK ');
    this.rankValue = el('b', null, 'E');
    rk.appendChild(this.rankValue);
    const xp = el('span', null, 'NEXT ');
    this.xpValue = el('b', null, '0');
    xp.appendChild(this.xpValue);
    const ash = el('span', 'ash', 'ASH ');
    this.ashValue = el('b', null, '0');
    ash.appendChild(this.ashValue);
    wallet.append(lv, rk, xp, ash);
    panel.appendChild(wallet);

    const cols = el('div', 'cols');
    this.slotsEl = el('div', 'slots');
    this.slotsEl.id = 'invSlots';
    cols.appendChild(this.slotsEl);

    const right = el('div', 'right');
    this.tabsEl = el('div', 'tabs');
    for (const [key, label] of [['gear', 'GEAR'], ['stats', 'STATS']]) {
      const b = el('button', null, label);
      b.type = 'button';
      b.dataset.tab = key;
      b.addEventListener('click', () => { this.audio?.ui?.(); this._tab = key; this.render(); });
      this.tabsEl.appendChild(b);
    }
    right.appendChild(this.tabsEl);

    // The scroll box and its "there is more" affordance. Kept as real elements
    // rather than a CSS-only shadow because the hint has to know when it has
    // reached the end, and that is a scroll position, not a style.
    this.colWrap = el('div', 'colwrap');
    this.colEl = el('div', 'col');
    this.colEl.id = 'invCol';
    this.bodyEl = el('div', null);
    this.bodyEl.id = 'invBody';
    this.colEl.appendChild(this.bodyEl);
    this.colWrap.appendChild(this.colEl);
    this.moreHint = el('div', 'morehint', 'MORE BELOW  ▼');
    this.colWrap.appendChild(this.moreHint);
    this.colEl.addEventListener('scroll', () => this._updateScrollHint(), { passive: true });
    right.appendChild(this.colWrap);
    cols.appendChild(right);
    panel.appendChild(cols);

    const foot = el('div', 'foot');
    // The plaza show-off control, in the owner's own words: "the sword can be
    // visible or placed in the inventory". Long-pressing attack and desktop's
    // X key do the same thing; this is the discoverable one.
    this.stanceBtn = el('button', 'btn', 'SHEATHE');
    this.stanceBtn.id = 'invStance';
    this.stanceBtn.type = 'button';
    this.stanceBtn.addEventListener('click', () => this._toggleStance());
    foot.appendChild(this.stanceBtn);

    const close = el('button', 'btn ghost', 'CLOSE');
    close.id = 'invClose';
    close.type = 'button';
    close.addEventListener('click', () => { this.audio?.ui?.(); this.close(); });
    foot.appendChild(close);
    panel.appendChild(foot);

    screen.appendChild(panel);
    root.appendChild(screen);
    this.root = screen;
  }

  get isOpen() { return this._open; }

  open() {
    if (!this.game) return false;
    this._slot = 'weapon';
    this.render();
    this.root.classList.remove('hidden');
    document.body.classList.add('gb-inv');
    this._open = true;
    // In a gate this is a loadout decision under threat; in the city it is
    // shopping. See _pausedByUs.
    if (this.game.state === 'playing' && this.game.mode?.name !== 'city') {
      this.game.pause(true);
      this._pausedByUs = true;
    }
    return true;
  }

  close() {
    this.root.classList.add('hidden');
    document.body.classList.remove('gb-inv');
    this._open = false;
    if (this._pausedByUs) {
      this._pausedByUs = false;
      this.game?.pause?.(false);
    }
    const cb = this.onClose;
    // Cleared BEFORE the call: a handler that reopens the panel must not
    // inherit the previous caller's return path.
    this.onClose = null;
    cb?.();
  }

  toggle() { return this._open ? (this.close(), false) : this.open(); }

  // --------------------------------------------------------------- rendering

  render() {
    const g = this.game;
    if (!g) return;
    const save = g.save;
    this.lvValue.textContent = String(save.level || 1);
    this.rankValue.textContent = rankOf(save.level || 1);
    const need = xpForLevel(save.level || 1);
    this.xpValue.textContent = `${Math.max(0, need - (save.xp || 0))} XP`;
    this.ashValue.textContent = String(Math.floor(save.ash || 0));

    for (const b of this.tabsEl.children) b.classList.toggle('on', b.dataset.tab === this._tab);
    this._renderSlots();
    this._renderStanceBtn();

    this.bodyEl.textContent = '';
    if (this._tab === 'stats') this._renderStats();
    else this._renderGear();
    // Layout has to settle before scrollHeight means anything, and render() is
    // called while the panel is still hidden on open().
    requestAnimationFrame(() => this._updateScrollHint());
  }

  /** Two side-by-side panes inside the scroll box; CSS stacks them when narrow. */
  _panes() {
    const wrap = el('div', 'body2');
    const a = el('div', 'pane');
    const b = el('div', 'pane');
    wrap.append(a, b);
    this.bodyEl.appendChild(wrap);
    return [a, b];
  }

  _updateScrollHint() {
    const c = this.colEl;
    if (!c) return;
    const overflow = c.scrollHeight - c.clientHeight;
    this.colWrap.classList.toggle('no-scroll', overflow <= 4);
    // 4 px of slack: sub-pixel layout means scrollTop never exactly equals the
    // maximum, and a hint that never goes away is a hint players learn to
    // ignore.
    this.colWrap.classList.toggle('at-end', c.scrollTop >= overflow - 4);
  }

  _renderSlots() {
    const g = this.game;
    this.slotsEl.textContent = '';
    for (const id of EQUIP_SLOTS) {
      const meta = SLOTS[id];
      const btn = el('button', 'slot');
      btn.type = 'button';
      btn.dataset.slot = id;
      if (!meta.live) btn.classList.add('locked');
      if (id === this._slot) btn.classList.add('sel');

      const box = el('i');
      const held = id === 'weapon' ? g.weapon : null;
      // iconStyle already renders a neutral grey square for an unknown key, so
      // an EMPTY slot needs no placeholder markup of its own. An empty slot
      // still draws its TYPE icon, faded: eight identical grey squares tell the
      // player nothing about where a helmet goes, and the 9 px label under a
      // 44 px cell is not a legible answer on a phone.
      box.setAttribute('style', iconStyle(held ? weaponIcon(held) : meta.icon, 44));
      if (held) box.style.borderColor = hex(rarityColor(held.rarity));
      else box.style.opacity = '0.3';
      btn.appendChild(box);
      btn.appendChild(el('small', null, meta.name));
      btn.addEventListener('click', () => { this.audio?.ui?.(); this._slot = id; this._tab = 'gear'; this.render(); });
      this.slotsEl.appendChild(btn);
    }
  }

  _renderStanceBtn() {
    const g = this.game;
    const mesh = g?.player?.mesh;
    const sheathed = mesh ? weaponStance(mesh) === 'sheathed' : false;
    this.stanceBtn.textContent = sheathed ? 'DRAW' : 'SHEATHE';
    this.stanceBtn.disabled = !g?.weapon;
  }

  _toggleStance() {
    const g = this.game;
    this.audio?.ui?.();
    // Delegated to the game so ONE place owns the auto-sheath policy's opinion
    // about whether a stance change is currently legal (never mid-swing).
    const applied = g?.setStance?.(weaponStance(g.player.mesh) === 'sheathed' ? 'drawn' : 'sheathed', { manual: true });
    if (applied) this._renderStanceBtn();
  }

  // ------------------------------------------------------------------- gear

  _renderGear() {
    const g = this.game;
    const meta = SLOTS[this._slot];
    // Left pane: what is fitted. Right pane: what you could fit instead. The
    // whole point of the GEAR tab is swapping, so the list you swap FROM has to
    // share the fold with the thing you are swapping OUT.
    const [body, right] = this._panes();

    body.appendChild(el('div', 'sect', meta.name));
    body.appendChild(el('div', 'note', meta.blurb));

    if (!meta.live) {
      const note = el('div', 'note');
      note.appendChild(el('b', null, 'NOT YET FITTED.  '));
      note.appendChild(document.createTextNode(
        this._slot === 'offhand'
          ? 'The offhand opens with the bow and the staff. Nothing equips here today, and no hidden number is being applied.'
          : 'Armour is the next wave. The slot is real and your save already has a place for it, but there are no armour pieces, no armour stats and no set bonuses in this build — so this panel is not going to show you any.',
      ));
      body.appendChild(note);
      return;
    }

    // --- equipped
    const held = g.weapon;
    if (held) {
      body.appendChild(el('div', 'sect', 'EQUIPPED'));
      body.appendChild(this._itemRow(held, { equipped: true }));
      const stats = el('div', 'readout');
      for (const [k, v] of weaponSummary(held)) stats.appendChild(row(k, v));
      const mesh = g.player?.mesh;
      stats.appendChild(row('Carried', mesh && weaponStance(mesh) === 'sheathed' ? 'On the back' : 'In hand'));
      body.appendChild(stats);
      if (held.blurb) body.appendChild(el('div', 'note', held.blurb));
    }

    // --- stash
    const stash = Array.isArray(g.stash) ? g.stash : [];
    right.appendChild(el('div', 'sect', `IN THE STASH  (${stash.length})`));
    if (!stash.length) {
      right.appendChild(el('div', 'note', 'Nothing spare. Gates drop weapons and the Exchange sells them.'));
      return;
    }
    for (let i = 0; i < stash.length; i++) {
      right.appendChild(this._itemRow(stash[i], { index: i }));
    }
  }

  _itemRow(w, { equipped = false, index = -1 } = {}) {
    const g = this.game;
    const btn = el('button', 'gate');
    btn.type = 'button';
    if (equipped) btn.classList.add('on');

    const box = el('i');
    box.setAttribute('style', iconStyle(weaponIcon(w), 34));
    box.style.borderStyle = 'solid';
    box.style.borderWidth = '2px';
    box.style.borderColor = hex(rarityColor(w.rarity));
    btn.appendChild(box);

    const meta = el('span', 'meta');
    const name = el('b', null, w.name);
    name.style.color = hex(rarityColor(w.rarity));
    meta.appendChild(name);
    meta.appendChild(el('small', null,
      `${RARITIES[w.rarity]?.name || ''} ${w.arch.name}  ·  x${w.dmgMul.toFixed(2)} power  ·  LV ${w.level}`));
    btn.appendChild(meta);

    if (equipped) {
      btn.appendChild(el('span', 'tagline', 'EQUIPPED'));
      btn.disabled = true;
    } else {
      // The one comparison that matters, spelled out rather than left to the
      // player to work out from two power numbers: rollWeapon's `score` is the
      // single comparable value and _takeWeapon already auto-equips on it.
      const better = g.weapon ? w.score - g.weapon.score : 1;
      const tag = el('span', 'tagline', better > 0 ? `+${Math.round(better)}` : `${Math.round(better)}`);
      tag.style.color = better > 0 ? '#54e08a' : 'var(--danger)';
      btn.appendChild(tag);
      btn.addEventListener('click', () => this._equip(index));
    }
    return btn;
  }

  _equip(index) {
    const g = this.game;
    const w = g?.stash?.[index];
    if (!w) return;
    this.audio?.ui?.();
    // SWAP, not push: game.equipFromStash removes the incoming record before
    // pushing the outgoing one. Equipping straight through game.equip would
    // leave the stash entry behind and duplicate the item, which is harmless
    // at one slot and a 12-entry cap and is not harmless at eight and forty.
    g.equipFromStash(index);
    g.ui?.toast?.(`${w.name.toUpperCase()}  ·  EQUIPPED`);
    this.render();
  }

  // ------------------------------------------------------------------ stats

  _renderStats() {
    const g = this.game;
    const save = g.save;
    // IDENTITY + the six spendable stats on the left, everything they DERIVE on
    // the right: the two halves are read together ("I put a point in AGILITY,
    // what moved?") and stacking them put the derived block a full screen below
    // the stat it explains.
    const [body, right] = this._panes();
    const d = derive(save);
    const R = STAT_RATES;

    const idt = el('div', 'readout');
    body.appendChild(el('div', 'sect', 'IDENTITY'));
    idt.appendChild(row('Level', String(save.level || 1)));
    idt.appendChild(row('Rank', rankOf(save.level || 1)));
    idt.appendChild(row('XP', `${save.xp || 0} / ${xpForLevel(save.level || 1)}`));
    idt.appendChild(row('Unspent points', String(save.points || 0)));
    idt.appendChild(row('Kills', String(save.totalKills || 0)));
    idt.appendChild(row('Deaths', String(save.deaths || 0)));
    idt.appendChild(row('Gates cleared', String(Object.keys(save.cleared || {}).length)));
    body.appendChild(idt);

    body.appendChild(el('div', 'sect', 'STATS'));
    const st = el('div', 'readout');
    const auto = save.autoStats || 0;
    for (const s of STATS) {
      const spent = (save.stats || {})[s.key] || 0;
      st.appendChild(row(s.name, `${effectiveStat(save, s.key)}`, `${spent} spent + ${auto} granted`));
      st.appendChild(el('div', 'note', s.desc));
    }
    body.appendChild(st);

    right.appendChild(el('div', 'sect', 'DERIVED'));
    const dv = el('div', 'readout');
    dv.appendChild(row('Max health', String(d.maxHp)));
    dv.appendChild(row('Max mana', String(d.maxMp)));
    dv.appendChild(row('Attack power', d.atk.toFixed(1)));
    dv.appendChild(row('Move speed', d.speed.toFixed(2), `cap +${R.agi.speedCap}`));
    dv.appendChild(row('Crit chance', pct(d.crit), `cap ${pct(R.agi.critCap)}`));
    dv.appendChild(row('Crit damage', `x${d.critDmg.toFixed(2)}`));
    dv.appendChild(row('Attack speed', `+${pct(d.atkSpeed)}`, `cap ${pct(R.str.atkSpeedCap)}`));
    dv.appendChild(row('Skill power', `x${d.skillMul.toFixed(2)}`));
    dv.appendChild(row('Cooldown cut', pct(d.cdr), `cap ${pct(R.int.cdrCap)}`));
    dv.appendChild(row('Damage reduction', pct(d.dr), `cap ${pct(R.vit.drCap)}`));
    dv.appendChild(row('Health regen', `${d.hpRegen.toFixed(2)}/s`));
    dv.appendChild(row('Mana regen', `${d.mpRegen.toFixed(2)}/s`));
    dv.appendChild(row('Damage floor', pct(d.dmgFloor), 'the low end of every roll'));
    dv.appendChild(row('Enemy tell', `${Math.round(d.tellLeadMs)} ms`, 'warning before a hit lands'));
    dv.appendChild(row('Dodge window', `${Math.round(d.dodgeWindow * 1000)} ms`));
    dv.appendChild(row('Shadow damage', `x${d.shadowDmgMul.toFixed(2)}`));
    right.appendChild(dv);

    right.appendChild(el('div', 'sect', 'ARMOUR'));
    const ar = el('div', 'note');
    ar.appendChild(el('b', null, 'NO ARMOUR IN THIS BUILD.  '));
    ar.appendChild(document.createTextNode(
      `Your ${pct(d.dr)} damage reduction is all from VITALITY. Armour points, `
      + 'per-piece rolls and set bonuses land next wave; nothing on this screen is '
      + 'quietly counting a piece you are not wearing.',
    ));
    right.appendChild(ar);

    right.appendChild(el('div', 'sect', 'ARMY'));
    const ay = el('div', 'readout');
    const roster = save.shadows?.roster?.length || 0;
    ay.appendChild(row('Roster', `${roster} / ${shadowRosterCapacity(save)}`));
    ay.appendChild(row('On the field', String(shadowFieldCapacity(save, g.quality?.current)), 'clamped by the live quality tier'));
    right.appendChild(ay);
  }
}

export default InventoryUI;
