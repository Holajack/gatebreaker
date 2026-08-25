import { GATES, SKILLS, STATS, xpForLevel, rankOf } from '../game/config.js';
import { allocate, effectiveStat } from '../game/progression.js';
import { rosterSummary } from '../game/shadows.js';
// The identity layers (CLASSES_SPEC step 3). Direction is DERIVED from spent
// points — the panel names what the player already did, it never asks — and
// the mastery lines are the per-stat qualitative payoff for going deep.
import {
  DIRECTIONS, MASTERY_THRESHOLDS, CLASSES, directionOf, masteryTier, resonanceOf,
} from '../game/classes.js';
// The ascension layer (CLASSES_SPEC step 7): the archon offer panel, the HUD
// resource meter, and the contextual tag on the Bind slot. ARCHONS is data
// for names/identities/resource rules; canAscend lights THE REACH line on the
// S-gate row.
import { ARCHONS, canAscend } from '../game/classes.js';

const $ = (id) => document.getElementById(id);

// interlock.noNewButtons: ONE contextual archon slot, five meanings. These
// are the tags the Bind button wears once ascended — the BEHAVIOURS behind
// them (Legion Step, Ashfall, the freeze-detonate, Tempest Step, Wild Form)
// are steps 8-10's business; step 7 ships the identity, not the mechanics,
// so the tag marks the slot while the tap stays Bind for every path. One
// word each: the tag sits INSIDE the 58 px circle (the button clips overflow
// for its cooldown wipe, so nothing outside the rim survives).
const ARCHON_ULTIMATE = {
  shadow: 'LEGION',
  flame: 'ASHFALL',
  frost: 'SHATTER',
  storm: 'TEMPEST',
  beast: 'WILD',
};

// Injected once, on first use — ui.js owns no stylesheet, and these handful
// of rules are not worth a styles.css merge seam (the cityui precedent).
const ARCHON_CSS = `
#archonPanel{z-index:var(--z-archon)}
#archonPanel .gate .aff{margin-left:auto;font-size:10px;letter-spacing:.12em;
  color:var(--gold);border:1px solid rgba(255,194,75,.45);border-radius:999px;
  padding:2px 8px;white-space:nowrap;align-self:center}
#archonPanel .gate small{white-space:normal}
#archonMeter{margin-top:3px}
#archonMeter .am-row{display:flex;justify-content:space-between;
  font-size:10px;letter-spacing:.14em;color:var(--gold);font-weight:700}
#archonMeter .am-bar{height:4px;margin-top:2px;border-radius:2px;
  background:rgba(255,194,75,.18);overflow:hidden}
#archonMeter .am-bar i{display:block;height:100%;width:0%;
  background:var(--gold)}
.skill-btn .archon-tag{position:absolute;top:7px;left:50%;
  transform:translateX(-50%);font-size:6.5px;letter-spacing:.08em;
  font-weight:700;color:var(--gold);white-space:nowrap;pointer-events:none}
`;
let archonStyleEl = null;
function ensureArchonStyle() {
  if (archonStyleEl) return;
  archonStyleEl = document.createElement('style');
  archonStyleEl.id = 'archonUiStyle';
  archonStyleEl.textContent = ARCHON_CSS;
  document.head.appendChild(archonStyleEl);
}

export class UI {
  constructor({ audio, onPlayGate, onResume, onQuit, onReset }) {
    this.audio = audio;
    this.onPlayGate = onPlayGate;
    this.onResume = onResume;
    this.onQuit = onQuit;
    this.onReset = onReset;
    this.save = null;
    this.game = null;
    this._lastResult = null;
    this._cds = {};
    this._bind();
  }

  attach(save) { this.save = save; }

  _bind() {
    const click = (id, fn) => {
      const el = $(id);
      if (el) el.addEventListener('click', () => { this.audio.ui(); fn(); });
    };

    click('btnPlay', () => this.showGates());
    click('btnHow', () => this.show('how'));
    click('btnHowClose', () => this.hide('how'));
    click('btnGatesBack', () => { this.hide('gates'); this.show('title'); });
    click('btnReset', () => this._showEraseConfirm());

    // Hunter body select. The contract with the combat layer is exactly
    // save.playerBody === 'male' | 'female'; entities.js picks the rig and
    // clips off that field. game.setPlayerBody is what makes the flip land NOW
    // — the hero was already built at boot, and without the in-place rebuild
    // the persisted choice would only show up next session.
    const body = (id, value) => {
      const el = $(id);
      if (el) el.addEventListener('click', () => {
        if (!this.save || this.save.playerBody === value) return;
        this.audio.ui();
        this.save.playerBody = value;
        this.onStatChange?.();   // main.js wires this to persist()
        this.game?.setPlayerBody?.(value);
        this._refreshBodySelect();
      });
    };
    body('btnBodyMale', 'male');
    body('btnBodyFemale', 'female');

    // Desktop nicety — the CSS removes the button where the pointer is coarse.
    // Browsers only grant fullscreen from a user gesture, so a button is the
    // polite web analogue of the Android build's immersive mode; the request
    // can still be refused (iframe policy, kiosk shells) and that is fine.
    click('btnFullscreen', () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.()?.catch?.(() => {});
    });

    click('btnPause', () => { this.showPause(); });
    click('btnResume', () => { this.hide('pause'); this.onResume(); });
    click('btnAllocate', () => { this.hide('pause'); this.showLevelUp(true); });
    click('btnQuit', () => {
      this.hide('pause');
      this.onQuit();
      this.show('title');
      this.refreshTitle();
    });

    click('btnStatsDone', () => {
      this.hide('levelup');
      if (this._returnToPause) { this._returnToPause = false; this.showPause(); }
      else if (this._afterStats) { const fn = this._afterStats; this._afterStats = null; fn(); }
    });

    click('btnResultsOk', () => {
      this.hide('results');
      if (this.save.points > 0) {
        this._afterStats = () => { this.showGates(); };
        this.showLevelUp(false, this._lastResult?.levelsGained > 0);
      } else {
        this.showGates();
      }
    });

    $('btnPause')?.addEventListener('touchstart', (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------- screens
  show(id) { $(id)?.classList.remove('hidden'); }
  hide(id) { $(id)?.classList.add('hidden'); }

  showHud(on) {
    const hud = $('hud');
    if (!hud) return;
    hud.classList.toggle('hidden', !on);
  }

  refreshTitle() {
    if (!this.save) return;
    // A story-driven game addresses its hunter BY NAME from the front door
    // (Wave G; save.hunterName has persisted since the paperdoll wave but the
    // title never used it — the rename flow was buried in the inventory).
    const name = (this.save.hunterName || '').trim();
    $('titleName').textContent = name
      ? `${name} · ${rankOf(this.save.level)}-GRADE`
      : `${rankOf(this.save.level)}-GRADE BREAKER`;
    $('titleLevel').textContent = `LV ${this.save.level}`;
    this._refreshBodySelect();
  }

  _refreshBodySelect() {
    const current = this.save?.playerBody === 'female' ? 'female' : 'male';
    document.querySelectorAll('.body-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.body === current);
    });
  }

  showGates() {
    this.hide('title');
    this.show('gates');
    const list = $('gateList');
    list.innerHTML = '';
    GATES.forEach((g, i) => {
      const locked = this.save.level < g.reqLevel;
      const best = this.save.cleared[g.rank];
      // THE REACH (CLASSES_SPEC unlock.trial): for an ascension-eligible save
      // the S gate IS the trial, and its row says so in gold — the migration
      // promise that a returning 55+ save "gets the trial offer at the S
      // gate". The gate itself is unchanged; game._beginGate arms the flag.
      const trial = g.rank === 'S' && !locked && canAscend(this.save);
      const el = document.createElement('button');
      el.className = `gate${locked ? ' locked' : ''}`;
      el.innerHTML = `
        <span class="rank rank-${g.rank}">${g.rank}</span>
        <span class="meta">
          <b>${g.name}</b>
          <small${trial ? ' style="color:var(--gold)"' : ''}>${locked ? `REQUIRES LEVEL ${g.reqLevel}` : (trial ? 'THE REACH — THE ASCENSION TRIAL AWAITS' : g.blurb)}</small>
        </span>
        <span class="clear">${best != null ? `BEST ${Math.floor(best / 60)}:${String(best % 60).padStart(2, '0')}` : ''}</span>
      `;
      if (!locked) {
        el.addEventListener('click', () => {
          this.audio.ui();
          this.hide('gates');
          this.onPlayGate(i);
        });
      }
      list.appendChild(el);
    });
  }

  // ------------------------------------------------------- erase confirm
  //
  // The ERASE BREAKER DATA gate used to be a native confirm(): the ONE piece
  // of browser/OS chrome in the whole game, in the system font, and inside
  // the Android WebView it looks like a permissions dialog rather than a game
  // asking a question. This is the same .screen/.panel/.btn stack every other
  // question uses. Built lazily — a save that never erases pays no DOM — and
  // with createElement/textContent throughout: all strings are authored here,
  // but a markup sink is a markup sink whatever we believe about its inputs
  // today. Cancel is the styled default; the destructive button wears the
  // danger colour and never .primary.
  _ensureEraseConfirm() {
    if (this._erasePanel) return this._erasePanel;
    const screen = document.createElement('div');
    screen.id = 'eraseConfirm';
    screen.className = 'screen overlay hidden';
    // A modal question lives on the ladder's modal rung, DECLARED — without
    // this it would sit at .screen's --z-screen:20 and beat the equally-z'd
    // title screen only by body-append order, a tie the next appended screen
    // could flip.
    screen.style.zIndex = 'var(--z-modal)';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const h = document.createElement('h2');
    h.textContent = 'ERASE BREAKER DATA';
    h.style.color = 'var(--danger)';
    panel.appendChild(h);
    const sub = document.createElement('p');
    sub.className = 'panel-sub';
    // The exact sentence the old confirm() asked — same decision, new chrome.
    sub.textContent = 'Erase all Breaker progress? This cannot be undone.';
    panel.appendChild(sub);
    const keep = document.createElement('button');
    keep.className = 'btn primary';
    keep.id = 'eraseCancel';
    keep.type = 'button';
    keep.textContent = 'KEEP MY BREAKER';
    keep.addEventListener('click', () => { this.audio.ui(); this.hide('eraseConfirm'); });
    panel.appendChild(keep);
    const erase = document.createElement('button');
    erase.className = 'btn';
    erase.id = 'eraseYes';
    erase.type = 'button';
    erase.textContent = 'ERASE EVERYTHING';
    erase.style.borderColor = 'rgba(255,77,109,.6)';
    erase.style.color = 'var(--danger)';
    erase.addEventListener('click', () => {
      this.audio.ui();
      this.hide('eraseConfirm');
      // Same wire as the old confirm()'s true branch: main.js owns the wipe.
      this.onReset();
    });
    panel.appendChild(erase);
    screen.appendChild(panel);
    document.body.appendChild(screen);
    this._erasePanel = screen;
    return screen;
  }

  _showEraseConfirm() {
    this._ensureEraseConfirm();
    this.show('eraseConfirm');
  }

  showPause() {
    if (!this.game) return;
    // The game's OWN derived block, not a fresh naked derive(): refreshDerived
    // folds armour and the class layer (CLASSES_SPEC step 3), and a pause card
    // that disagrees with the combat numbers is a pause card that lies. Built
    // with createElement/textContent — same markup-sink rule inventoryui.js
    // records — which the old template string predated.
    const d = this.game.derived;
    const s = this.save;
    const roster = rosterSummary(s);
    const dir = directionOf(s);
    const cls = CLASSES[s.className];
    const res = resonanceOf(s);
    const box = $('pauseStats');
    box.textContent = '';
    const addRow = (label, value) => {
      const r = document.createElement('div');
      r.className = 'row';
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('b');
      v.textContent = value;
      r.appendChild(l);
      r.appendChild(v);
      box.appendChild(r);
    };
    addRow('Breaker', `LV ${s.level} · ${rankOf(s.level)}-grade`);
    // The identity layers, in stacking order. Direction is derived from spent
    // points; class is the Assay Hall commitment (— until level 20 makes one
    // choosable, which is exactly what the dash tells the player).
    addRow('Direction', dir === 'unsworn' ? 'UNSWORN' : DIRECTIONS[dir].name);
    addRow('Class', cls ? `${cls.name}${res > 0 ? ` · RESONANT ${res}` : ''}` : '—');
    // The third identity layer, only once it exists — an unascended save's
    // pause card stays row-identical to the step-5 baseline.
    if (ARCHONS[s.archon]) addRow('Archon', ARCHONS[s.archon].name);
    addRow('Attack', String(Math.round(d.atk)));
    addRow('Health', String(d.maxHp));
    addRow('Mana', String(d.maxMp));
    addRow('Crit', `${(d.crit * 100).toFixed(1)}%`);
    addRow('Unspent points', String(s.points));
    addRow('Ash', String(Math.floor(s.ash || 0)));
    addRow('Cinderbound', `${this.game.shadows.length} afield · ${roster.count}/${roster.capacity} bound`);
    addRow('Strongest', roster.strongest ? roster.strongest.name : '—');
    addRow('Total kills', String(s.totalKills));
    this.show('pause');
    this.game.pause(true);
  }

  showLevelUp(fromPause = false, leveled = false) {
    this._returnToPause = fromPause;
    // Only claim a level-up when one actually happened this run; otherwise
    // this is just the allocation screen for points banked earlier.
    const h = document.querySelector('#levelup h2');
    if (h) {
      h.textContent = leveled ? 'LEVEL UP' : 'ALLOCATE STAT POINTS';
      h.classList.toggle('glow', Boolean(leveled));
    }
    this._renderStats();
    this.show('levelup');
  }

  /** The mastery line for one stat: the deepest mastery already earned and the
   *  next spent-point threshold, from classes.js data. Spent points only —
   *  autoStats never counts (CLASSES_SPEC masteryRules), which is why the line
   *  shows `spent/threshold` rather than the effective value beside it. */
  _masteryLine(statKey) {
    const dir = DIRECTIONS[statKey];
    const tier = masteryTier(this.save, statKey);
    const spent = (this.save.stats || {})[statKey] || 0;
    const next = MASTERY_THRESHOLDS[tier];
    const earned = tier > 0 ? dir.masteries[tier - 1].name : null;
    if (!earned) return `${dir.name} — NEXT ${spent}/${next}`;
    return next ? `${dir.name} · ${earned} — NEXT ${spent}/${next}` : `${dir.name} · ${earned} — MASTERED`;
  }

  _renderStats() {
    const grid = $('statGrid');
    grid.innerHTML = '';
    $('pointsLeft').textContent = this.save.points;

    // Direction header, once, above the grid (CLASSES_SPEC masteryRules
    // uiSurface). Derived from spent points — the game NAMES what the player
    // has been doing, it never asks — and UNSWORN is a real, non-punished
    // state with its own line rather than an error.
    const dir = directionOf(this.save);
    const head = document.createElement('div');
    head.className = 'readout';
    head.style.marginBottom = '6px';
    head.style.letterSpacing = '.12em';
    const headB = document.createElement('b');
    if (dir === 'unsworn') {
      headB.textContent = 'NO DIRECTION SET — SPEND DEEPER';
      headB.style.color = 'var(--dim)';
    } else {
      headB.textContent = `YOUR PATH READS AS ${DIRECTIONS[dir].name}`;
    }
    head.appendChild(headB);
    grid.appendChild(head);

    // The class summary, above the grid (CLASSES_SPEC module map for ui.js).
    // Only for a sworn save — a null-class panel stays pixel-identical to the
    // shipped one, which is STEP 3's screenshot contract. Benefit and drawback
    // render at the SAME type size (the spec's non-negotiable presentation
    // rule); colour is the only difference.
    const cls = CLASSES[this.save.className];
    if (cls) {
      const res = resonanceOf(this.save);
      const box = document.createElement('div');
      box.className = 'readout';
      box.style.marginBottom = '6px';
      const title = document.createElement('b');
      title.textContent = res > 0 ? `${cls.name} · RESONANT ${res}` : cls.name;
      if (res > 0) title.style.color = 'var(--gold)';
      box.appendChild(title);
      const ben = document.createElement('small');
      ben.textContent = cls.benefitText;
      ben.style.cssText = 'display:block;font-size:11px;color:var(--accent2)';
      const dbk = document.createElement('small');
      dbk.textContent = cls.drawbackText;
      dbk.style.cssText = 'display:block;font-size:11px;color:var(--danger)';
      box.appendChild(ben);
      box.appendChild(dbk);
      grid.appendChild(box);
    }

    STATS.forEach((st) => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      // Static markup + textContent fills below; st.name/desc are config
      // constants but the mastery line is assembled, and the markup-sink rule
      // does not care what we believe about inputs today.
      row.innerHTML = `
        <span class="lbl"><b>${st.name}</b><small>${st.desc}</small><small class="mastery"></small></span>
        <span class="val">${effectiveStat(this.save, st.key)}</span>
        <button class="plus" ${this.save.points > 0 ? '' : 'disabled'}>+</button>
      `;
      const mastery = row.querySelector('.mastery');
      mastery.textContent = this._masteryLine(st.key);
      mastery.style.display = 'block';
      mastery.style.color = masteryTier(this.save, st.key) > 0 ? 'var(--accent2)' : 'var(--dim)';
      row.querySelector('.plus').addEventListener('click', () => {
        // progression.allocate is the single place allocation happens; this
        // panel used to decrement save.points and bump save.stats by hand.
        if (!allocate(this.save, st.key)) return;
        this.audio.ui();
        if (this.game) this.game.refreshDerived();
        this.onStatChange?.();
        this._renderStats();
      });
      grid.appendChild(row);
    });

    // Show which skills the current level has unlocked.
    const unlocked = Object.entries(SKILLS)
      .filter(([, v]) => v.unlockLevel > 1)
      .map(([k, v]) => {
        const has = this.save.level >= v.unlockLevel;
        return `<div class="row"><span>${v.name}</span><b style="color:${has ? '#4ade80' : '#8a93b8'}">${has ? 'UNLOCKED' : `LV ${v.unlockLevel}`}</b></div>`;
      }).join('');
    const box = document.createElement('div');
    box.className = 'readout';
    box.style.marginTop = '6px';
    box.innerHTML = unlocked;
    grid.appendChild(box);
  }

  showResults(result) {
    this._lastResult = result;
    $('resultTitle').textContent = result.title;
    $('resultTitle').className = result.cleared ? 'glow' : '';
    $('resultBody').innerHTML = result.rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
      .join('');
    this.show('results');
  }

  // -------------------------------------------------------- ascension offer
  //
  // THE REACH's verdict panel (CLASSES_SPEC step 7). Shown by game.js at the
  // Rift Archon's corpse; lists archonOffers(save) — the top two paths this
  // save's own counters earned plus SHADOW, never fewer than two — and
  // commits through the onChoose callback (game._offerAscension wraps
  // ascend(), which enforces the same offer list). Its own node, NOT the
  // appstate 'archon'-less router: it must be able to sit ON TOP of the
  // results panel (z 70 > the overlay stack) because the arena clears the
  // gate in the same frame the boss dies. Built lazily so a save that never
  // ascends pays no DOM. createElement/textContent throughout — identity
  // lines are authored data, but the markup-sink rule does not care what we
  // believe about inputs today.
  _ensureArchonPanel() {
    if (this._archonPanel) return this._archonPanel;
    ensureArchonStyle();
    const screen = document.createElement('div');
    screen.id = 'archonPanel';
    screen.className = 'screen overlay hidden';
    const panel = document.createElement('div');
    panel.className = 'panel wide';
    const h = document.createElement('h2');
    h.className = 'glow';
    h.textContent = 'THE REACH ANSWERS';
    panel.appendChild(h);
    const sub = document.createElement('p');
    sub.className = 'panel-sub';
    sub.textContent = 'The Rift Archon falls. Your own record wrote this list — take a path, or walk out unchanged.';
    panel.appendChild(sub);
    this._archonList = document.createElement('div');
    this._archonList.className = 'gate-list';
    this._archonList.id = 'archonList';
    panel.appendChild(this._archonList);
    const later = document.createElement('button');
    later.className = 'btn ghost';
    later.id = 'archonLater';
    later.type = 'button';
    // Declining is a real option ("It is not auto-ascended") — the offer
    // returns on the next eligible S clear, since nothing here is consumed.
    later.textContent = 'NOT YET';
    later.addEventListener('click', () => { this.audio.ui(); this.hide('archonPanel'); });
    panel.appendChild(later);
    screen.appendChild(panel);
    document.body.appendChild(screen);
    this._archonPanel = screen;
    return screen;
  }

  showArchonOffer({ save, offers, onChoose }) {
    this._ensureArchonPanel();
    const list = this._archonList;
    list.textContent = '';
    const aff = save?.archonState?.affinity || {};
    for (const key of offers) {
      const path = ARCHONS[key];
      if (!path) continue;
      const row = document.createElement('button');
      row.className = 'gate';
      row.type = 'button';
      row.dataset.archon = key;
      const rank = document.createElement('span');
      rank.className = 'rank rank-S';
      rank.textContent = path.name[0];
      const meta = document.createElement('span');
      meta.className = 'meta';
      const name = document.createElement('b');
      name.textContent = path.name;
      const line = document.createElement('small');
      line.textContent = path.identity;
      meta.appendChild(name);
      meta.appendChild(line);
      const pill = document.createElement('span');
      pill.className = 'aff';
      // The counter that put this path on the list — "depending on their
      // development" made visible. SHADOW can arrive at 0: it is always
      // offerable because Bind is available to every build.
      pill.textContent = `AFFINITY ${aff[key] || 0}`;
      row.appendChild(rank);
      row.appendChild(meta);
      row.appendChild(pill);
      row.addEventListener('click', () => {
        this.audio.ui();
        if (onChoose?.(key)) this.hide('archonPanel');
      });
      list.appendChild(row);
    }
    this.show('archonPanel');
  }

  /**
   * The archon HUD surface, refreshed from updateHud: the resource meter in
   * the vitals stack ("ascending sets save.archon and LIGHTS THE METER, and
   * that is all" — step 7's whole HUD contract) and the contextual tag on the
   * Bind slot (interlock.theOneSlot; the tap stays Bind until steps 8-10
   * give the five meanings their mechanics). Lazy: a save that never ascends
   * builds no nodes and pays one boolean check per frame.
   */
  _updateArchonHud(s) {
    const key = s.archon;
    if (!key && !this._archonMeter) return;
    if (this._archonMeter === undefined || this._archonHudKey !== key) {
      this._archonHudKey = key;
      // (Re)build for the current path — a handful of nodes, once per
      // ascension, not per frame.
      ensureArchonStyle();
      if (!this._archonMeter) {
        const vitals = document.querySelector('#hud .vitals');
        const meter = document.createElement('div');
        meter.id = 'archonMeter';
        const row = document.createElement('div');
        row.className = 'am-row';
        this._amName = document.createElement('b');
        this._amVal = document.createElement('span');
        row.appendChild(this._amName);
        row.appendChild(this._amVal);
        const bar = document.createElement('div');
        bar.className = 'am-bar';
        this._amFill = document.createElement('i');
        bar.appendChild(this._amFill);
        meter.appendChild(row);
        meter.appendChild(bar);
        this._amBar = bar;
        vitals?.appendChild(meter);
        this._archonMeter = meter;
      }
      const path = ARCHONS[key];
      this._archonMeter.classList.toggle('hidden', !path);
      if (path) {
        this._amName.textContent = path.name;
        // SHADOW and BEAST bank nothing — their resource is an army and a
        // cooldown — so they light the name line and no bar.
        this._amBar.style.display = path.resourceRules.max > 0 ? '' : 'none';
      }
      // The contextual tag on the Bind slot.
      const btn = document.querySelector('.skill-btn[data-skill="summon"]');
      if (btn) {
        let tag = btn.querySelector('.archon-tag');
        if (path) {
          if (!tag) {
            tag = document.createElement('span');
            tag.className = 'archon-tag';
            btn.appendChild(tag);
          }
          tag.textContent = ARCHON_ULTIMATE[key];
        } else if (tag) tag.remove();
      }
    }
    const path = ARCHONS[key];
    if (!path || path.resourceRules.max <= 0) { if (!path) return; this._amVal.textContent = ''; return; }
    // Per-frame value write, cached so an idle meter costs no DOM churn.
    const v = Math.floor(s.archonState?.resource || 0);
    if (this._amShown !== v) {
      this._amShown = v;
      this._amVal.textContent = `${path.resourceName} ${v}/${path.resourceRules.max}`;
      this._amFill.style.width = `${Math.min(100, (v / path.resourceRules.max) * 100)}%`;
    }
  }

  // ------------------------------------------------------------- HUD
  setObjective(title, count) {
    $('objTitle').textContent = title;
    $('objCount').textContent = count;
  }

  setCombo(n) {
    const el = $('comboText');
    if (!el) return;
    if (n > 1) {
      el.textContent = `${n} HIT CHAIN`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  flashLevelUp(level, points) {
    const el = document.createElement('div');
    el.className = 'levelup-flash';
    el.innerHTML = `<b>LEVEL ${level}</b><small>+${points} STAT POINTS</small>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }

  toast(msg, kind = '') {
    const wrap = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  updateHud(game) {
    const p = game.player;
    const d = game.derived;
    const s = game.save;

    $('hpFill').style.width = `${Math.max(0, (p.hp / d.maxHp) * 100)}%`;
    $('hpText').textContent = `${Math.ceil(p.hp)} / ${d.maxHp}`;
    $('mpFill').style.width = `${Math.max(0, (p.mp / d.maxMp) * 100)}%`;
    $('mpText').textContent = `${Math.ceil(p.mp)} / ${d.maxMp}`;
    $('xpFill').style.width = `${(s.xp / xpForLevel(s.level)) * 100}%`;
    $('hudLevel').textContent = `LV ${s.level}`;
    const rank = rankOf(s.level);
    const badge = $('hudRank');
    // SOVEREIGN sits above the published ladder and does not fit the badge.
    badge.textContent = rank === 'SOVEREIGN' ? 'SOV' : rank;
    badge.className = `rank-badge rank-${rank}`;

    const points = $('pointsBadge');
    if (points) {
      const n = s.points;
      points.classList.toggle('hidden', n <= 0);
      if (n > 0) points.textContent = `${n} STAT POINT${n > 1 ? 'S' : ''} READY`;
    }

    // The archon meter + contextual Bind tag (CLASSES_SPEC step 7).
    this._updateArchonHud(s);

    if (game._classTrial) {
      // THE SEALED STAIR (Wave F.2): the clock IS the score — no kill
      // counter, no "x / y" clear condition, because the trial has neither.
      // M:SS off runTime, the same unscaled clock awardClassTier will read,
      // so what the hunter watches is exactly what the stair judges.
      // [strings] migrate the title when strings.js is free.
      const t = Math.floor(game.runTime);
      this.setObjective('THE STAIR', `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
    } else if (game.bossActive && game.boss) {
      this.setObjective(game.boss.base.name, `${Math.ceil((game.boss.hp / game.boss.maxHp) * 100)}%`);
    } else {
      // Clamp: the boss kill increments `killed` past gate.enemies, and in a
      // crawl the HUD stays up through the exit-portal walk — "13 / 12" read
      // as a bug. (The arena clears instantly on boss death, so this is a
      // no-op there.)
      this.setObjective(`${game.gate.rank}-GRADE RIFT`, `${Math.min(game.killed, game.gate.enemies)} / ${game.gate.enemies}`);
    }

    // cooldown wipes on the skill buttons
    document.querySelectorAll('.skill-btn').forEach((btn) => {
      const key = btn.dataset.skill;
      let cd = p.cds[key] ?? 0;
      let max = SKILLS[key]?.cd || 1;
      // SHADOW ARCHON (step 8): the slot's TAP is LEGION STEP, so while its
      // 45 s runs the wipe must read Legion's clock — showing Bind's short cd
      // on a button whose tap is the ultimate would lie about what a tap
      // does. Bind (the hold) keeps the wipe whenever Legion is ready.
      if (key === 'summon' && s.archon === 'shadow' && (game._legionT || 0) > 0) {
        cd = game._legionT;
        max = ARCHONS.shadow.resourceRules.ultimateCooldown;
      }
      const fill = btn.querySelector('.cd');
      if (fill) fill.style.transform = `scaleY(${Math.max(0, cd / max)})`;
      const sk = SKILLS[key];
      const locked = sk && s.level < sk.unlockLevel;
      const noMana = sk && sk.mp > 0 && p.mp < sk.mp;
      btn.classList.toggle('disabled', Boolean(locked || noMana));
    });
  }
}
