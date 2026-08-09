// The Exchange's counter — the DOM panel behind the Exchange door prompt.
//
// It is an OVERLAY, not an AppState screen, and that is a deliberate call:
// AppState.go('city') calls Game.enterCity, which calls _setMode, which
// DISPOSES and REBUILDS the entire city. Routing a shop panel through the
// router would therefore tear down 200-odd draw calls of town — and teleport
// the player back to his spawn — every time he closed a menu he opened by
// standing in a doorway. So this behaves like #levelup and #how: a fixed
// overlay toggled by classList, with main.js's hardware-back handler taught
// one more id.
//
// It builds its own DOM and injects its own stylesheet, the pattern cityui.js
// established, so it shares neither a file nor a merge conflict with ui.js or
// styles.css. What it does NOT do is re-invent the look: the panel, the button
// and the row are the SHIPPED .panel / .btn / .gate classes from styles.css,
// and the injected sheet only adds the two things the shop needs that no
// existing screen has (a price column and a wallet strip).
//
// Every node is built with createElement/textContent. Weapon names are
// generated locally by weapons.js, but the repo's standing rule is that a
// markup sink is a markup sink whatever you believe about its inputs today.

import { shopStock, buy, ensureShopSave } from '../game/shop.js';
import { rarityColor, RARITIES } from '../game/weapons.js';

const CSS = `
/* .screen is z-index 20 and #cityUi is 40, so without this the district
   banner, the compass and — worse — the live OPEN button render ON TOP of the
   panel, and the button is the one node in cityui that takes pointer events.
   Raising the panel and hiding the city's overlay while it is up fixes both. */
#shop { z-index: 60; }
body.gb-shop #cityUi { display: none !important; }

#shop .shop-wallet {
  display: flex; justify-content: space-between; gap: 12px;
  border: 1px solid var(--edge); border-radius: 10px;
  padding: 9px 14px; font-size: 12.5px; letter-spacing: .1em;
  background: rgba(124,92,255,.07);
}
#shop .shop-wallet b { color: var(--gold); }
#shop .shop-wallet .held { color: var(--dim); }
#shop .shop-wallet .held b { color: var(--ink); }

/* The row is a .gate; these are only the parts a gate row has no slot for. */
#shop .gate .price {
  display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
  white-space: nowrap; font-size: 12px; letter-spacing: .08em;
}
#shop .gate .price b { color: var(--gold); font-size: 13px; }
#shop .gate .price small { color: var(--dim); font-size: 10.5px; }
#shop .gate.owned { opacity: .55; cursor: default; }
#shop .gate.owned .price b { color: var(--dim); }
#shop .gate.poor .price b { color: var(--danger); }
/* Tighter than a gate row on purpose: a gate list is six entries and the shelf
   is eight, on a 412 px-tall landscape phone, inside a scroll box. The gate
   row's 44 px swatch and 13 px padding fit two rows in the window; this fits
   nearly four, which is the difference between "a list" and "a peephole". */
#shop .gate { padding: 9px 12px; }
#shop .gate .tier {
  width: 36px; height: 36px; flex: 0 0 36px; display: grid; place-items: center;
  border-radius: 9px; font-size: 15px; font-weight: 800;
}
#shop .shop-list { max-height: min(52vh, 360px); overflow-y: auto; }
`;

let _styleEl = null;
function ensureStyle() {
  if (_styleEl && _styleEl.isConnected) return;
  _styleEl = document.createElement('style');
  _styleEl.id = 'shopUiStyle';
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

export class ShopUI {
  /**
   * @param {{game:object, audio?:object, root?:HTMLElement}} opts
   *   `game` is the live Game: the panel reads game.save, spends through
   *   game/shop.js and equips through game.equip, which is what persists the
   *   purchase (equip -> _persistLoadout -> onSave writes the WHOLE save,
   *   wallet included, so there is no second persistence path to forget).
   */
  constructor({ game, audio = null, root = document.body } = {}) {
    ensureStyle();
    this.game = game || null;
    this.audio = audio || game?.audio || null;
    this._open = false;

    const screen = el('div', 'screen overlay hidden');
    screen.id = 'shop';

    const panel = el('div', 'panel wide');
    panel.appendChild(el('h2', null, 'THE EXCHANGE'));
    panel.appendChild(el('p', 'panel-sub',
      'Ash buys steel. Rank buys the right to be sold it.'));

    const wallet = el('div', 'shop-wallet');
    wallet.id = 'shopWallet';
    const ashSpan = el('span', null, 'ASH ');
    this.ashValue = el('b', null, '0');
    ashSpan.appendChild(this.ashValue);
    const heldSpan = el('span', 'held', 'WIELDING ');
    this.heldValue = el('b', null, '—');
    heldSpan.appendChild(this.heldValue);
    wallet.appendChild(ashSpan);
    wallet.appendChild(heldSpan);
    panel.appendChild(wallet);

    this.listEl = el('div', 'gate-list shop-list');
    this.listEl.id = 'shopList';
    panel.appendChild(this.listEl);

    const close = el('button', 'btn ghost', 'LEAVE');
    close.id = 'shopClose';
    close.type = 'button';
    close.addEventListener('click', () => { this.audio?.ui?.(); this.close(); });
    panel.appendChild(close);

    screen.appendChild(panel);
    root.appendChild(screen);
    this.root = screen;
  }

  get isOpen() { return this._open; }

  open() {
    if (!this.game) return false;
    ensureShopSave(this.game.save);
    this.render();
    this.root.classList.remove('hidden');
    document.body.classList.add('gb-shop');
    this._open = true;
    return true;
  }

  close() {
    this.root.classList.add('hidden');
    document.body.classList.remove('gb-shop');
    this._open = false;
  }

  /** Rebuild the shelf from the save. Cheap — eight rows — so buying re-renders. */
  render() {
    const g = this.game;
    if (!g) return;
    const save = g.save;
    this.ashValue.textContent = String(Math.floor(save.ash || 0));
    const held = g.weapon;
    this.heldValue.textContent = held ? held.name : '—';
    this.heldValue.style.color = held ? hex(held.tint || 0xb9c0d4) : '';

    this.listEl.textContent = '';
    for (const row of shopStock(save)) {
      this.listEl.appendChild(this._rowNode(row, save));
    }
  }

  _rowNode(row, save) {
    const poor = !row.locked && !row.sold && (save.ash || 0) < row.price;
    const btn = el('button', 'gate');
    btn.type = 'button';
    if (row.locked) btn.classList.add('locked');
    if (row.sold) btn.classList.add('owned');
    if (poor) btn.classList.add('poor');

    // The tier pill reuses the gate list's rank swatches, so a tier-4 weapon
    // is the same colour as the B gate it drops in — the player already reads
    // that palette as "how deep is this".
    const tierRank = ['E', 'E', 'D', 'C', 'B', 'A'][row.tier] || 'E';
    const pill = el('span', `tier rank-${tierRank}`, `T${row.tier}`);
    btn.appendChild(pill);

    const meta = el('span', 'meta');
    const name = el('b', null, row.weapon ? row.weapon.name : row.name);
    if (row.weapon) name.style.color = hex(rarityColor(row.rarity));
    meta.appendChild(name);
    const sub = el('small', null, row.locked
      ? row.reason
      : `${RARITIES[row.rarity]?.name || ''} ${row.weapon.arch.name}  ·  x${row.weapon.dmgMul.toFixed(2)} power`);
    meta.appendChild(sub);
    btn.appendChild(meta);

    const price = el('span', 'price');
    if (row.locked) {
      price.appendChild(el('b', null, '—'));
      price.appendChild(el('small', null, `LV ${row.reqLevel}`));
    } else if (row.sold) {
      price.appendChild(el('b', null, 'BOUGHT'));
      price.appendChild(el('small', null, 'IN YOUR STASH'));
    } else {
      price.appendChild(el('b', null, String(row.price)));
      price.appendChild(el('small', null, 'ASH'));
    }
    btn.appendChild(price);

    if (!row.locked && !row.sold) {
      btn.addEventListener('click', () => this._buy(row.baseId));
    }
    return btn;
  }

  _buy(baseId) {
    const g = this.game;
    if (!g) return;
    const res = buy(g.save, baseId);
    if (!res.ok) {
      this.audio?.ui?.();
      g.ui?.toast?.(res.reason || 'NO', 'danger');
      return;
    }
    this.audio?.ui?.();
    // equip() sends the old weapon to the stash and calls _persistLoadout,
    // which writes the whole save — so the spend and the new weapon land in
    // localStorage in the same write. Nothing here persists separately, on
    // purpose: two writers is how a wallet and an inventory drift apart.
    g.equip(res.weapon);
    g.ui?.toast?.(`${res.weapon.name}  ·  -${res.price} ASH`, 'gold');
    this.render();
  }
}

export default ShopUI;
