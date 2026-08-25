// ---------------------------------------------------------------------------
// PERFPROBE — the first real-hardware measurement channel this project has had.
// ---------------------------------------------------------------------------
// Every performance number in the repo so far came from SwiftShader CI runs or
// a desktop GPU; neither says anything about a $150 Android panel. This probe
// exists to close that gap: it rides the game's own frame callback, records
// raw dt into a ring, snapshots renderer.info every 500 ms, and hands the
// whole thing back as pasteable JSON — clipboard on demand, localStorage every
// 10 s so a session that crashes still leaves data behind.
//
// Wall-clock (Date.now) is ALLOWED in this file and nowhere near the sim: this
// is diagnostics, and nothing here feeds back into gameplay, RNG draws, or the
// quality governor. The one thing the probe touches per frame while OFF is a
// single boolean — zero-cost is the contract that lets the hook live in the
// hot loop permanently.
//
// Enable paths: ?perf=1 in the URL (read once at construction), or 5 rapid
// taps on the title screen's .build-stamp — the traditional "secret dev menu"
// gesture, delegated from document so it needs no markup edits and survives
// any title-screen rebuild.

const RING_CAP = 72000;        // 20 min of frames at 60 fps; wraps silently
const SNAP_CAP = 2400;         // 20 min of 500 ms snapshots; oldest dropped
const SNAP_INTERVAL = 0.5;     // seconds, accumulated off frame dt — NOT
                               // setInterval, so a backgrounded tab (rAF
                               // stopped) stops sampling instead of logging
                               // a wall of meaningless idle snapshots
const PERSIST_INTERVAL = 10;   // seconds between localStorage flushes
const OVERLAY_INTERVAL = 0.25; // seconds between overlay text refreshes
const TAP_WINDOW_MS = 1600;    // 5 taps inside this window arms the probe
const STORE_KEY = 'gatebreaker.perflog.v1';

export class PerfProbe {
  constructor({ game } = {}) {
    this.game = game;
    this.on = false;           // THE boolean — frame() checks this and bails

    // Ring state. Allocated lazily in _enable() so a player who never opens
    // the probe never pays the 288 KB Float32Array.
    this._ring = null;
    this._ringLen = 0;         // valid samples (caps at RING_CAP)
    this._ringHead = 0;        // next write index (wraps)
    this._snaps = [];
    this._startedAt = 0;       // Date.now at enable — diagnostics only

    // dt accumulators driven by frame(); all reset in _enable().
    this._snapAcc = 0;
    this._persistAcc = 0;
    this._overlayAcc = 0;

    // 1 s rolling fps + 5 s p95 windows for the overlay. One flat array of
    // [t, dt] pairs with a HEAD INDEX instead of front-splicing — no per-frame
    // allocation; compacted in frame() when the dead prefix grows.
    this._fpsWin = [];         // [t, dt] pairs, t = probe-relative seconds
    this._fpsWinStart = 0;     // index of the window's first live pair
    this._probeT = 0;

    // Whole-frame render counters latched by frame() (see its autoReset
    // block); read by _snapshot and the overlay instead of live info.
    this._lastCalls = null;
    this._lastTris = null;

    this._overlay = null;
    this._readout = null;

    // Enable path (a): URL query, read once at construction.
    try {
      if (new URLSearchParams(location.search).get('perf') === '1') this._enable();
    } catch { /* non-browser (node syntax check) — stay off */ }

    // Enable path (b): 5 rapid taps on the build stamp. Delegated from
    // document rather than bound to the element so this file never has to
    // care whether the title screen has been shown yet, and no markup edit
    // is needed. The counter self-resets when taps come slower than the
    // window — an idle player poking the stamp once does nothing.
    this._taps = [];
    this._onTap = (e) => {
      if (!e.target?.closest?.('.build-stamp')) return;
      const now = Date.now();
      this._taps.push(now);
      while (this._taps.length && now - this._taps[0] > TAP_WINDOW_MS) this._taps.shift();
      if (this._taps.length >= 5) {
        this._taps.length = 0;
        if (!this.on) this._enable();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('click', this._onTap, true);
    }
  }

  /**
   * Called from the game's single frame callback with the same clamped dt the
   * game just updated with. dt is SECONDS. When off this is one boolean check
   * and a return — the whole point of the design.
   */
  frame(dt) {
    if (!this.on) return;
    if (!(dt > 0)) return;     // stalls/tab-restore emit dt 0; not a sample

    // WHOLE-FRAME render counters. three's renderer.info auto-resets at the
    // START of every renderer.render() call, and on bloom tiers the frame's
    // LAST pass is the glow composite quad — so reading info live reports
    // ~1 call / 1 triangle exactly when tier says high/ultra. While the probe
    // is on we own the reset instead: autoReset off, latch the accumulated
    // totals here (after game.update rendered every pass), then reset for the
    // next frame. Restored in disable().
    const rinfo = this.game?.renderer?.info;
    if (rinfo) {
      if (rinfo.autoReset) rinfo.autoReset = false;   // late-appearing renderer
      this._lastCalls = rinfo.render.calls;
      this._lastTris = rinfo.render.triangles;
      rinfo.reset();
    }

    // Ring write. Wraps silently: a 25-minute session keeps the LAST 20 min,
    // which is the interesting part — late-session thermal throttling is the
    // thing desktop numbers can never show.
    this._ring[this._ringHead] = dt;
    this._ringHead = (this._ringHead + 1) % RING_CAP;
    if (this._ringLen < RING_CAP) this._ringLen++;

    this._probeT += dt;
    this._fpsWin.push(this._probeT, dt);
    // Trim to 5 s (the p95 window; the 1 s fps window is a sub-slice of it)
    // by advancing a head INDEX — splice() allocates a removed-elements array
    // every call, which is per-frame garbage inside the instrument measuring
    // frame health. Compact only when the dead prefix outgrows the window.
    while (this._fpsWinStart < this._fpsWin.length
      && this._probeT - this._fpsWin[this._fpsWinStart] > 5) this._fpsWinStart += 2;
    if (this._fpsWinStart > 4096) {
      this._fpsWin.splice(0, this._fpsWinStart);
      this._fpsWinStart = 0;
    }

    this._snapAcc += dt;
    if (this._snapAcc >= SNAP_INTERVAL) {
      this._snapAcc = 0;
      this._snapshot();
    }
    this._persistAcc += dt;
    if (this._persistAcc >= PERSIST_INTERVAL) {
      this._persistAcc = 0;
      this._persist();
    }
    this._overlayAcc += dt;
    if (this._overlayAcc >= OVERLAY_INTERVAL) {
      this._overlayAcc = 0;
      this._renderOverlay();
    }
  }

  // ---- capture ------------------------------------------------------------

  _snapshot() {
    const g = this.game;
    const r = g?.renderer;
    const info = r?.info;
    // performance.memory is Chrome-only (which is exactly the Android WebView
    // we ship in); null elsewhere rather than absent so every snapshot has
    // the same shape and the JSON diffs cleanly between devices.
    const heap = (typeof performance !== 'undefined' && performance.memory)
      ? performance.memory.usedJSHeapSize : null;
    this._snaps.push({
      t: Math.round(this._probeT * 1000) / 1000,       // probe-relative seconds
      // Latched whole-frame totals from frame(), NOT live info — live info
      // holds only the last pass's numbers (see the autoReset block there).
      calls: this._lastCalls ?? info?.render?.calls ?? null,
      tris: this._lastTris ?? info?.render?.triangles ?? null,
      programs: info?.programs?.length ?? null,
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      heap,
      dpr: (typeof devicePixelRatio !== 'undefined') ? devicePixelRatio : null,
      mode: g?.mode?.name ?? null,
      rank: g?.gate?.rank ?? null,
      tier: g?.quality?.current?.name ?? null,
    });
    if (this._snaps.length > SNAP_CAP) this._snaps.shift();
  }

  /** Percentiles over the ring — computed ONLY on COPY and the final
   *  disable() flush (see _summary's withDt): sorting 72k floats is a
   *  one-off cost the user asked for, never a recurring in-frame one. */
  _percentiles() {
    const n = this._ringLen;
    if (!n) return null;
    // Unwrap into a fresh array so the ring itself is never reordered.
    const a = new Float32Array(n);
    if (n < RING_CAP) {
      a.set(this._ring.subarray(0, n));
    } else {
      a.set(this._ring.subarray(this._ringHead));
      a.set(this._ring.subarray(0, this._ringHead), RING_CAP - this._ringHead);
    }
    a.sort();
    const ms = (q) => Math.round(a[Math.min(n - 1, Math.floor(q * n))] * 100000) / 100;
    return { p50: ms(0.5), p90: ms(0.9), p95: ms(0.95), p99: ms(0.99), max: ms(1), frames: n };
  }

  /**
   * The payload shape shared by COPY and the localStorage flush.
   * `withDt` gates the 72k-float percentile sort: COPY and the final
   * disable() flush pay it (one-off, user-initiated); the periodic 10 s
   * flush must NOT — a recurring multi-ms sort+stringify inside the frame
   * callback lands its own hitch in the very ring being measured, and worst
   * during the late-session throttling window that is the tool's whole point.
   */
  _summary(withDt) {
    return {
      v: 1,
      device: (typeof navigator !== 'undefined') ? navigator.userAgent : 'node',
      startedAt: this._startedAt,          // wall-clock ms; diagnostics only
      dtMs: withDt ? this._percentiles() : null,
      snapshots: this._snaps,
    };
  }

  /**
   * Crash-safe flush. The periodic path (`final` false) is snapshots-only and
   * DEFERRED off the frame callback — stringify + synchronous setItem of a
   * ~200 KB string is a guaranteed hitch on the phones this probe targets.
   * The `final` path (disable/X) runs inline with percentiles: the session is
   * over, nothing is being measured anymore.
   */
  _persist(final = false) {
    const write = () => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this._summary(final)));
      } catch { /* quota/private mode — the probe keeps running regardless */ }
    };
    if (final || typeof setTimeout === 'undefined') { write(); return; }
    setTimeout(write, 0);
  }

  // ---- enable / disable ---------------------------------------------------

  _enable() {
    if (this.on) return;
    this._ring = this._ring || new Float32Array(RING_CAP);
    this._ringLen = 0;
    this._ringHead = 0;
    this._snaps = [];
    this._probeT = 0;
    this._snapAcc = 0;
    this._persistAcc = 0;
    this._overlayAcc = 0;
    this._fpsWin.length = 0;
    this._fpsWinStart = 0;
    this._lastCalls = null;
    this._lastTris = null;
    this._startedAt = Date.now();
    this._buildOverlay();
    this.on = true;
  }

  disable() {
    if (!this.on) return;
    this.on = false;
    this._persist(true);       // one last full flush so X never loses the session
    // Hand renderer.info back to three's own per-render reset (see frame()).
    const rinfo = this.game?.renderer?.info;
    if (rinfo) { rinfo.autoReset = true; rinfo.reset(); }
    this._overlay?.remove();
    this._overlay = null;
    this._readout = null;
  }

  // ---- overlay ------------------------------------------------------------

  _buildOverlay() {
    if (this._overlay || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'perfProbe';
    // z-index 200: DELIBERATELY above the game's entire ladder (which tops
    // out at --z-archon:70, the #archonPanel rung) — a perf readout that a
    // menu can cover is a perf readout you can't trust during the exact
    // transitions you're measuring. pointer-events none on the box so it
    // never eats gameplay taps; only the two buttons opt back in.
    el.style.cssText = [
      'position:fixed', 'top:6px', 'right:6px', 'z-index:200',
      'pointer-events:none', 'background:rgba(0,0,0,0.72)', 'color:#8ef58e',
      'font:10px/1.5 monospace', 'padding:6px 8px', 'border-radius:4px',
      'white-space:pre', 'text-align:right', 'user-select:none',
    ].join(';');

    this._readout = document.createElement('div');
    this._readout.textContent = 'perf: arming…';
    el.appendChild(this._readout);

    const row = document.createElement('div');
    row.style.cssText = 'margin-top:4px;display:flex;gap:6px;justify-content:flex-end';
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'pointer-events:auto', 'font:10px monospace', 'color:#8ef58e',
        'background:#123312', 'border:1px solid #2a662a', 'border-radius:3px',
        'padding:2px 8px', 'cursor:pointer',
      ].join(';');
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      row.appendChild(b);
      return b;
    };
    mkBtn('COPY', () => this._copy());
    mkBtn('X', () => this.disable());
    el.appendChild(row);
    document.body.appendChild(el);
    this._overlay = el;
  }

  _renderOverlay() {
    if (!this._readout) return;
    // 1 s rolling fps + 5 s p95, both from the same window buffer. Copied and
    // sorted here, off the OVERLAY_INTERVAL — ≤ ~300 floats, not a cost.
    const w = this._fpsWin;
    let n1 = 0, sum1 = 0;
    const dts5 = [];
    for (let i = this._fpsWinStart; i < w.length; i += 2) {
      dts5.push(w[i + 1]);
      if (this._probeT - w[i] <= 1) { n1++; sum1 += w[i + 1]; }
    }
    const fps = n1 ? (n1 / sum1) : 0;
    dts5.sort((a, b) => a - b);
    const p95 = dts5.length ? dts5[Math.min(dts5.length - 1, Math.floor(0.95 * dts5.length))] * 1000 : 0;
    const g = this.game;
    const info = g?.renderer?.info;
    this._readout.textContent =
      `${fps.toFixed(0)} fps  p95 ${p95.toFixed(1)}ms\n` +
      `calls ${this._lastCalls ?? '-'}  prog ${info?.programs?.length ?? '-'}\n` +
      `${g?.quality?.current?.name ?? '-'} / ${g?.mode?.name ?? '-'}`;
  }

  _copy() {
    const json = JSON.stringify(this._summary(true));
    const done = () => { if (this._readout) this._readout.textContent = 'copied ✓'; };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json).then(done, () => this._copyFallback(json, done));
    } else {
      this._copyFallback(json, done);
    }
  }

  // Older WebViews (and any non-secure context) have no navigator.clipboard;
  // the textarea+execCommand dance still works everywhere we ship.
  _copyFallback(json, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = json;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch {
      if (this._readout) this._readout.textContent = 'copy failed';
    }
  }
}
