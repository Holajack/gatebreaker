// The journal — the quest ledger's panel (Wave C). shopui overlay recipe:
// overlay not screen, own sheet on the tokens, shipped .panel/.btn/.gate
// classes, createElement/textContent only.
//
// v1 reads quests.journal(save) each open (a handful of rows; no live
// binding needed — the ledger only moves at run boundaries). The Guild
// Ledger daily strip rides along at the top: the daily contract finally has
// a surface that is not a results row.
//
// WIRING (owner: main.js when free): construct once with {game}, open from
// the city UI's button row / pause menu; '#journal' joins the back chain.

import { journal, QUESTS } from '../game/quests.js';
// THE LADDER PAST 53 (Wave F.4): the ledger strip grows the streak flame
// count, and the weekly hunt gets its own strip below it — the same surface
// the daily earned in Wave C, because a contract with no surface is a
// contract nobody hunts. weeklyState is the pure read side (never writes;
// an unstamped week shows the contract tickWeekly WILL stamp). BOSSES is the
// display-name table for boss-week targets — config is THREE-free, so the
// import costs the panel nothing.
import { dailyState, dailyStreak, weeklyState } from '../game/progression.js';
import { BOSSES } from '../game/config.js';
import { t } from '../game/strings.js';

const CSS = `
#journal { z-index: var(--z-modal); }
body.gb-journal #cityUi { display: none !important; }

#journal .jr-daily {
  display: flex; justify-content: space-between; gap: 12px;
  border: 1px solid var(--edge); border-radius: 10px;
  padding: 9px 14px; font-size: 12px; letter-spacing: .12em;
  background: rgba(124,92,255,.07); margin-bottom: 10px;
}
#journal .jr-daily b { color: var(--gold); }
#journal .jr-quest { display: block; }
#journal .jr-quest .jr-title { letter-spacing: .14em; font-size: 12.5px; }
#journal .jr-quest .jr-sub {
  font-size: 11px; color: var(--ui-city-sub, #97a4c8); margin-top: 2px;
  letter-spacing: .06em;
}
#journal .jr-done {
  font-size: 10.5px; letter-spacing: .16em; margin-top: 10px;
  color: var(--ui-city-sub, #97a4c8);
}
`;

export class JournalUI {
  constructor({ game }) {
    this.game = game;
    this._root = null;
    this._list = null;
    this._daily = null;
    this._weekly = null;
    this._doneRow = null;
  }

  get open() { return Boolean(this._root && !this._root.classList.contains('hidden')); }

  _ensure() {
    if (this._root) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'journal';
    root.className = 'screen overlay hidden';
    const panel = document.createElement('div');
    panel.className = 'panel';

    const h = document.createElement('h2');
    h.textContent = 'CONTRACTS';
    panel.appendChild(h);

    this._daily = document.createElement('div');
    this._daily.className = 'jr-daily';
    panel.appendChild(this._daily);

    // The weekly hunt strip (Wave F.4) — same class, same sheet, stacked
    // directly under the daily so the two contract cadences read as one
    // ledger family rather than two mechanics.
    this._weekly = document.createElement('div');
    this._weekly.className = 'jr-daily';
    panel.appendChild(this._weekly);

    this._list = document.createElement('div');
    panel.appendChild(this._list);

    this._doneRow = document.createElement('div');
    this._doneRow.className = 'jr-done';
    panel.appendChild(this._doneRow);

    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = 'BACK';
    back.addEventListener('click', () => this.hide());
    panel.appendChild(back);

    root.appendChild(panel);
    document.body.appendChild(root);
    this._root = root;
  }

  /**
   * HUD open button beside the map's — same injected pattern, same Wave G
   * rehome note (all injected buttons consolidate into city chrome later).
   */
  injectHudButton() {
    const bar = document.querySelector('#hud .hud-top');
    if (!bar || document.getElementById('btnJournal')) return;
    // Sprite icon, not a font glyph (Wave G — see index.html's symbol defs).
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'glyph');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-journal');
    svg.appendChild(use);
    btn.appendChild(svg);
    btn.id = 'btnJournal';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Contracts');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.game.audio?.ui?.();
      if (this.open) this.hide(); else this.show();
    });
    const anchor = document.getElementById('btnMap');
    if (anchor) bar.insertBefore(btn, anchor); else bar.appendChild(btn);
  }

  show() {
    // ONE overlay at a time — the same law every panel enforces.
    const g = this.game;
    if (g?.shopUI?.isOpen) g.shopUI.close();
    if (g?.assayUI?.isOpen) g.assayUI.close();
    if (g?.invUI?.isOpen) g.invUI.close();
    if (g?.mapUI?.isOpen) g.mapUI.close();
    this._ensure();
    this._render();
    this._root.classList.remove('hidden');
    document.body.classList.add('gb-journal');
    return true;
  }

  hide() {
    this._root?.classList.add('hidden');
    document.body.classList.remove('gb-journal');
  }

  _render() {
    const save = this.game.save;

    // Guild Ledger strip. The streak flame count (Wave F.4) rides the label
    // side as its own element — dailyStreak owns the honesty of the number
    // (0 the moment the chain breaks), so the strip renders it only when a
    // live chain exists and never shows a stale integer.
    const d = dailyState(save);
    this._daily.textContent = '';
    const lab = document.createElement('span');
    lab.textContent = 'GUILD LEDGER';
    const flames = dailyStreak(save);
    if (flames > 0) {
      const fl = document.createElement('b');
      fl.textContent = `  ${t('ladder.streak.flame', { flames })}`;
      lab.appendChild(fl);
    }
    const val = document.createElement('b');
    val.textContent = d.claimed ? 'FULFILLED TODAY' : `${d.progress} / ${d.target} GATES`;
    this._daily.appendChild(lab);
    this._daily.appendChild(val);

    // Weekly hunt strip (Wave F.4). Contract line + progress, or the
    // fulfilled stamp; the ' · ' join of two mechanical fragments is the F.3
    // band-row precedent. Boss-week targets render the BOSSES display name —
    // the save stores the stable key, the player reads the head's name.
    const w = weeklyState(save);
    this._weekly.textContent = '';
    const wlab = document.createElement('span');
    wlab.textContent = t('ladder.weekly.title');
    const wval = document.createElement('b');
    const desc = t(`ladder.weekly.desc.${w.kind}`, {
      target: w.target, boss: BOSSES[w.boss]?.name ?? w.boss,
    });
    wval.textContent = w.claimed
      ? t('ladder.weekly.fulfilled')
      : `${desc}  ·  ${t('ladder.weekly.progress', w)}`;
    this._weekly.appendChild(wlab);
    this._weekly.appendChild(wval);

    // Active quests as .gate rows (the shipped list-row class).
    this._list.textContent = '';
    const j = journal(save);
    if (!j.active.length) {
      const none = document.createElement('div');
      none.className = 'jr-quest jr-sub';
      none.textContent = 'NO OPEN CONTRACTS. THE ASSAY HALL POSTS NEW WORK.';
      this._list.appendChild(none);
    }
    for (const q of j.active) {
      const row = document.createElement('div');
      row.className = 'gate jr-quest';
      const title = document.createElement('div');
      title.className = 'jr-title';
      title.textContent = q.title;
      const sub = document.createElement('div');
      sub.className = 'jr-sub';
      sub.textContent = q.count > 1 ? `${q.progress} / ${q.count}` : 'IN PROGRESS';
      row.appendChild(title);
      row.appendChild(sub);
      this._list.appendChild(row);
    }

    this._doneRow.textContent = j.done.length
      ? `${j.done.length} / ${QUESTS.length} CONTRACTS CLOSED`
      : '';
  }
}
