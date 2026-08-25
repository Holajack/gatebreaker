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
import { dailyState } from '../game/progression.js';

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

  show() {
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

    // Guild Ledger strip.
    const d = dailyState(save);
    this._daily.textContent = '';
    const lab = document.createElement('span');
    lab.textContent = 'GUILD LEDGER';
    const val = document.createElement('b');
    val.textContent = d.claimed ? 'FULFILLED TODAY' : `${d.progress} / ${d.target} GATES`;
    this._daily.appendChild(lab);
    this._daily.appendChild(val);

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
