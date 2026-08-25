// The settings screen — Wave G. Until this file the game had NO settings
// surface of any kind (audit): no mute, no haptics switch, no graphics
// override (the quality governor was auto-only), no way to re-read HOW TO
// PLAY mid-session. shopui's overlay recipe, tokens, createElement only.
//
// PERSISTENCE IS DEVICE-LOCAL, NOT SAVE DATA — a deliberate split: a graphics
// tier belongs to the PHONE (the same save on a weaker device wants a
// different tier), so settings live under their own localStorage key and
// never touch the save schema or its migration discipline.
//
// WIRING (main.js when free): game.settingsUI = new SettingsUI({ game, ui });
// gear button (title screen + pause panel), '#settings' in the back chain
// (close). Construction APPLIES stored settings immediately — audio/haptics/
// tier are live before any panel is ever opened.

import { ORDER } from '../core/quality.js';

const STORE_KEY = 'gatebreaker.settings.v1';

const CSS = `
#settings { z-index: var(--z-modal); }
body.gb-settings #cityUi { display: none !important; }

#settings .set-row {
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; padding: 10px 2px; border-bottom: 1px solid var(--ui-city-border-dim, rgba(190,210,255,.12));
}
#settings .set-row .lab { font-size: 12.5px; letter-spacing: .14em; }
#settings .set-row .sub {
  font-size: 10px; letter-spacing: .06em; margin-top: 2px;
  color: var(--ui-city-sub, #97a4c8);
}
#settings .seg { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
#settings .seg .btn { padding: 5px 9px; font-size: 10.5px; }
#settings .seg .btn.on { border-color: var(--gold); color: var(--gold); }
`;

function loadStored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
}

export class SettingsUI {
  constructor({ game, ui }) {
    this.game = game;
    this.ui = ui;
    this._root = null;
    this._stored = loadStored();
    this._apply();          // live before the panel ever opens
  }

  get open() { return Boolean(this._root && !this._root.classList.contains('hidden')); }

  /** Push stored state into the live systems. Total: absent means default. */
  _apply() {
    const s = this._stored;
    const audio = this.game.audio;
    if (audio) {
      if (s.sound === false) audio.enabled = false;
      audio.hapticsEnabled = s.haptics !== false;
    }
    // 'auto' (or absent) hands the governor control; a named tier pins it.
    const q = this.game.quality;
    if (q && s.tier && s.tier !== 'auto' && ORDER.includes(s.tier)) q.lock(s.tier);
  }

  _persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this._stored)); }
    catch { /* private mode — settings just don't survive the session */ }
  }

  _ensure() {
    if (this._root) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'settings';
    root.className = 'screen overlay hidden';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const h = document.createElement('h2');
    h.textContent = 'SETTINGS';
    panel.appendChild(h);

    const row = (label, sub) => {
      const r = document.createElement('div');
      r.className = 'set-row';
      const left = document.createElement('div');
      const lab = document.createElement('div');
      lab.className = 'lab';
      lab.textContent = label;
      left.appendChild(lab);
      if (sub) {
        const s = document.createElement('div');
        s.className = 'sub';
        s.textContent = sub;
        left.appendChild(s);
      }
      r.appendChild(left);
      panel.appendChild(r);
      return r;
    };

    const toggle = (r, get, set) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.type = 'button';
      const paint = () => { b.textContent = get() ? 'ON' : 'OFF'; b.classList.toggle('on', get()); };
      b.addEventListener('click', () => { set(!get()); paint(); this._persist(); this.game.audio?.ui?.(); });
      paint();
      r.appendChild(b);
    };

    toggle(row('SOUND'), () => this._stored.sound !== false, (v) => {
      this._stored.sound = v;
      if (this.game.audio) this.game.audio.enabled = v;
    });

    toggle(row('HAPTICS', 'Impact rumble on hits and dashes'),
      () => this._stored.haptics !== false, (v) => {
        this._stored.haptics = v;
        if (this.game.audio) this.game.audio.hapticsEnabled = v;
      });

    // Graphics: AUTO hands control back to the adaptive governor; a named
    // tier pins it via quality.lock — the API built for exactly this.
    const gr = row('GRAPHICS', 'AUTO adapts to your phone; a pinned tier stays put');
    const seg = document.createElement('div');
    seg.className = 'seg';
    const opts = ['auto', ...ORDER];
    const paintSeg = () => {
      const cur = this._stored.tier || 'auto';
      for (const b of seg.children) b.classList.toggle('on', b.dataset.tier === cur);
    };
    for (const t of opts) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.type = 'button';
      b.dataset.tier = t;
      b.textContent = t.toUpperCase();
      b.addEventListener('click', () => {
        this._stored.tier = t;
        const q = this.game.quality;
        if (q) { if (t === 'auto') q.lock(null); else q.lock(t); }
        paintSeg();
        this._persist();
        this.game.audio?.ui?.();
      });
      seg.appendChild(b);
    }
    paintSeg();
    gr.appendChild(seg);

    const how = document.createElement('button');
    how.className = 'btn ghost';
    how.type = 'button';
    how.textContent = 'HOW TO PLAY';
    how.addEventListener('click', () => { this.hide(); this.ui?.show?.('how'); });
    panel.appendChild(how);

    const back = document.createElement('button');
    back.className = 'btn';
    back.type = 'button';
    back.textContent = 'BACK';
    back.addEventListener('click', () => { this.game.audio?.ui?.(); this.hide(); });
    panel.appendChild(back);

    root.appendChild(panel);
    document.body.appendChild(root);
    this._root = root;
  }

  show() {
    const g = this.game;
    if (g?.shopUI?.isOpen) g.shopUI.close();
    if (g?.assayUI?.isOpen) g.assayUI.close();
    if (g?.invUI?.isOpen) g.invUI.close();
    if (g?.mapUI?.isOpen) g.mapUI.close();
    if (g?.journalUI?.open) g.journalUI.hide();
    this._ensure();
    this._root.classList.remove('hidden');
    document.body.classList.add('gb-settings');
    return true;
  }

  hide() {
    this._root?.classList.add('hidden');
    document.body.classList.remove('gb-settings');
    // Return-path hook (main.js sets it when opening FROM the pause panel,
    // clears it inside the callback — the inventory's onClose pattern).
    this.onHide?.();
  }
}
