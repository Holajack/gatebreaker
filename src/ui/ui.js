import { GATES, SKILLS, STATS, xpForLevel, rankOf, derive } from '../game/config.js';
import { allocate, effectiveStat } from '../game/progression.js';
import { rosterSummary } from '../game/shadows.js';

const $ = (id) => document.getElementById(id);

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
    click('btnReset', () => {
      if (confirm('Erase all Breaker progress? This cannot be undone.')) this.onReset();
    });

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
    $('titleName').textContent = `${rankOf(this.save.level)}-GRADE BREAKER`;
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
      const el = document.createElement('button');
      el.className = `gate${locked ? ' locked' : ''}`;
      el.innerHTML = `
        <span class="rank rank-${g.rank}">${g.rank}</span>
        <span class="meta">
          <b>${g.name}</b>
          <small>${locked ? `REQUIRES LEVEL ${g.reqLevel}` : g.blurb}</small>
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

  showPause() {
    if (!this.game) return;
    const d = derive(this.save);
    const s = this.save;
    const roster = rosterSummary(s);
    $('pauseStats').innerHTML = `
      <div class="row"><span>Breaker</span><b>LV ${s.level} · ${rankOf(s.level)}-grade</b></div>
      <div class="row"><span>Attack</span><b>${Math.round(d.atk)}</b></div>
      <div class="row"><span>Health</span><b>${d.maxHp}</b></div>
      <div class="row"><span>Mana</span><b>${d.maxMp}</b></div>
      <div class="row"><span>Crit</span><b>${(d.crit * 100).toFixed(1)}%</b></div>
      <div class="row"><span>Unspent points</span><b>${s.points}</b></div>
      <div class="row"><span>Cinderbound</span><b>${this.game.shadows.length} afield · ${roster.count}/${roster.capacity} bound</b></div>
      <div class="row"><span>Strongest</span><b>${roster.strongest ? roster.strongest.name : '—'}</b></div>
      <div class="row"><span>Total kills</span><b>${s.totalKills}</b></div>
    `;
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

  _renderStats() {
    const grid = $('statGrid');
    grid.innerHTML = '';
    $('pointsLeft').textContent = this.save.points;
    STATS.forEach((st) => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `
        <span class="lbl"><b>${st.name}</b><small>${st.desc}</small></span>
        <span class="val">${effectiveStat(this.save, st.key)}</span>
        <button class="plus" ${this.save.points > 0 ? '' : 'disabled'}>+</button>
      `;
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

    if (game.bossActive && game.boss) {
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
      const cd = p.cds[key] ?? 0;
      const max = SKILLS[key]?.cd || 1;
      const fill = btn.querySelector('.cd');
      if (fill) fill.style.transform = `scaleY(${Math.max(0, cd / max)})`;
      const sk = SKILLS[key];
      const locked = sk && s.level < sk.unlockLevel;
      const noMana = sk && sk.mp > 0 && p.mp < sk.mp;
      btn.classList.toggle('disabled', Boolean(locked || noMana));
    });
  }
}
