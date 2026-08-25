// The world map — v1: one settlement, its gates, and the Verge (Wave B5a).
//
// It is an OVERLAY first and an AppState screen second, and the split is
// deliberate. The shopui.js header explains why a panel opened while standing
// in Threshold must NOT route through AppState.go: leaving 'city' and coming
// back calls Game.enterCity -> _setMode('city'), which DISPOSES and REBUILDS
// the whole town and teleports the player to spawn. So the map behaves exactly
// like #shop / #inv when opened in town: a fixed overlay toggled by classList,
// with main.js's hardware-back handler taught one more id. The 'map' entry in
// appstate's SCREENS exists for router-driven entries (a future title-screen
// map, tools driving __app), and main.js's back chain reconciles the two —
// see the note on close() below.
//
// v1 content per WAVE_B_SPEC B5: a stylized 2D panel, not a camera trick.
// Everything drawn is read from the LIVE city (game.mode?.city) at open time:
// portals (id/rank/pos/locked/wild) and the Verge's discovered POIs. Nothing
// is cached across opens, because discovery and lock state both change while
// the panel is closed — render() is cheap (a dozen SVG nodes) so rebuilding
// per open is the bug-free option, the same call shopui made.
//
// SVG via createElementNS is the drawing surface. That stays inside the repo's
// markup-sink rule: every node is createElement(NS) + setAttribute + textContent;
// no string of markup is ever parsed. The panel/button chrome reuses the
// SHIPPED .panel / .btn classes from styles.css, and the injected sheet speaks
// only var(--ui-*) / var(--z-*) tokens from the Wave A :root sheet.
//
// Determinism: this file draws NO random numbers. It is a read-only projection
// of world state and must stay that way — a map that touched an RNG stream
// would shift every draw after it.

import { PORTAL_COLORS, WAY_COLOR, resolvePortalPlacement } from '../world/city.js';
// The registry (Wave B5): the settlement switcher charts a REMOTE town from
// its descriptor alone — static placements through resolvePortalPlacement,
// no live City is ever built for a place you are merely looking at.
import { SETTLEMENTS } from '../world/settlements.js';

const CSS = `
/* Same stacking story as #shop: #cityUi (z 40) carries the live OPEN button,
   which would otherwise sit on top of the panel and eat taps. Modal token +
   hiding the city overlay while the map is up fixes both at once. */
#map { z-index: var(--z-modal); }
body.gb-map #cityUi { display: none !important; }

/* The chart itself: a dark ground the token text colours read against. The
   city-family tokens are used on purpose — the map is a diegetic surface (a
   hunter's chart of the streets), so it speaks the street vocabulary, not the
   menu purple. */
#map .map-chart {
  display: block; width: 100%; max-height: min(52vh, 340px);
  border: 1px solid var(--ui-city-border);
  border-radius: 12px;
  background: rgba(5, 8, 18, .85);
}
#map .map-legend {
  display: flex; flex-wrap: wrap; gap: 4px 14px; justify-content: center;
  font-size: 10.5px; letter-spacing: .12em; color: var(--ui-city-text-dim);
  margin: 8px 0 2px;
}
#map .map-legend i {
  display: inline-block; width: 9px; height: 9px; border-radius: 50%;
  margin-right: 5px; vertical-align: -1px;
}
#map .map-legend .poi i { border-radius: 1px; transform: rotate(45deg); }
#map .map-legend .wild i {
  background: transparent !important;
  border: 2px solid var(--ui-city-edge);
}
#map .map-foot {
  min-height: 18px; text-align: center; font-size: 12px;
  letter-spacing: .1em; color: var(--ui-city-text);
}
#map .map-foot b { color: var(--ui-city-text-bright); }
/* Pips are buttons in spirit: give the finger something to feel. */
#map .map-chart .pip { cursor: pointer; }

/* The settlement switcher (Wave B5): one chip per VISITED settlement. Same
   token vocabulary as the legend; the active chip is bold and bright, the
   rest are taps. */
#map .map-towns {
  display: flex; flex-wrap: wrap; gap: 6px; justify-content: center;
  margin: 0 0 8px;
}
#map .map-towns button {
  font: inherit; font-size: 11px; letter-spacing: .14em; cursor: pointer;
  padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--ui-city-edge);
  background: transparent; color: var(--ui-city-text-dim);
}
#map .map-towns button.active {
  font-weight: 700; color: var(--ui-city-text-bright);
  border-color: var(--ui-city-border);
}
/* The footer's TRAVEL action rides the shipped .btn look, shrunk to fit the
   one-line footer. */
#map .map-foot .map-travel {
  font: inherit; font-size: 11px; letter-spacing: .14em; cursor: pointer;
  margin-left: 10px; padding: 3px 12px; border-radius: 8px;
  border: 1px solid var(--ui-city-border);
  background: transparent; color: var(--ui-city-text-bright);
}
`;

let _styleEl = null;
function ensureStyle() {
  if (_styleEl && _styleEl.isConnected) return;
  _styleEl = document.createElement('style');
  _styleEl.id = 'mapUiStyle';
  _styleEl.textContent = CSS;
  document.head.appendChild(_styleEl);
}

const SVGNS = 'http://www.w3.org/2000/svg';

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
}

/** Reader-friendly name for a portal the descriptor gives no label to. */
function portalName(p) {
  if (p.kind === 'way' || p.way) return 'WAYGATE';
  if (p.wild) return `WILD ${p.rank} GATE`;
  if (p.id?.startsWith('breach-')) return 'THE BREACH';
  return `${p.rank} GATE`;
}

/** Display name for a settlement slug, off the descriptor's own name field. */
function settlementName(slug) {
  return SETTLEMENTS[slug]?.name || String(slug || 'threshold').toUpperCase();
}

export class MapUI {
  /**
   * @param {{game:object, audio?:object, root?:HTMLElement}} opts
   *   `game` is the live Game; the panel reads game.mode?.city (portals +
   *   frontier POIs) and game.player.pos, and writes NOTHING.
   */
  constructor({ game, audio = null, root = document.body } = {}) {
    ensureStyle();
    this.game = game || null;
    this.audio = audio || game?.audio || null;
    this._open = false;
    // See open(): true only when the map paused a live gate; close() unpauses
    // exactly then (the inventoryui pattern).
    this._pausedByUs = false;
    // main.js wires this so a router-entered map (app.current === 'map') can
    // hand the screen stack back on close. Overlay-entered opens leave it
    // doing nothing — see the header.
    this.onClosed = null;

    const screen = el('div', 'screen overlay hidden');
    // The id doubles as the AppState screen id: appstate's _transition toggles
    // #map by classList like every other exclusive screen, so a router entry
    // and an overlay entry flip the SAME node and can never show two copies.
    screen.id = 'map';

    const panel = el('div', 'panel wide');
    this.titleEl = el('h2', null, 'THRESHOLD');
    panel.appendChild(this.titleEl);
    panel.appendChild(el('p', 'panel-sub',
      'A hunter’s chart. Gates hold still; the Verge does not.'));

    // The settlement switcher (Wave B5): which town the chart below shows.
    // Rebuilt per render like the legend; hidden while only one town is known.
    this.townsEl = el('div', 'map-towns');
    panel.appendChild(this.townsEl);
    // Which settlement the panel is LOOKING at. null = the active one (the
    // live city); a visited slug = a remote chart drawn from its descriptor.
    // Reset on open — the map always opens on where you are standing.
    this._viewSlug = null;

    // The chart is rebuilt per open; this is its stable mount point.
    this.chartMount = el('div');
    panel.appendChild(this.chartMount);

    this.legendEl = el('div', 'map-legend');
    panel.appendChild(this.legendEl);

    this.footEl = el('div', 'map-foot');
    panel.appendChild(this.footEl);

    const close = el('button', 'btn ghost', 'CLOSE');
    close.id = 'mapClose';
    close.type = 'button';
    close.addEventListener('click', () => { this.audio?.ui?.(); this.close(); });
    panel.appendChild(close);

    screen.appendChild(panel);
    root.appendChild(screen);
    this.root = screen;

    this._injectHudButton();
  }

  /**
   * The temporary open path (B5a): a HUD icon button beside #btnInventory.
   * Created HERE rather than in index.html or cityui.js because cityui.js is
   * owned by another agent this stage — the orchestrator moves the button into
   * the city chrome when that file frees up. It rides #hud, so it exists in
   * town and in a gate; in a gate the panel shows the no-city line, which is
   * honest (the chart is drawn from the streets, and you are not on them).
   */
  _injectHudButton() {
    const bar = document.querySelector('#hud .hud-top');
    if (!bar || document.getElementById('btnMap')) return;
    const btn = el('button', 'icon-btn', '◈'); // ◈ — a chart pip
    btn.id = 'btnMap';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Map');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.audio?.ui?.();
      this.toggle();
    });
    const anchor = document.getElementById('btnInventory');
    if (anchor) bar.insertBefore(btn, anchor); else bar.appendChild(btn);
  }

  get isOpen() { return this._open; }

  toggle() { if (this._open) this.close(); else this.open(); }

  open() {
    // ONE overlay at a time — same law toggleInventory enforces: the shop, the
    // sheet, the desk and the map all hide #cityUi and all claim the back
    // button, so stacking two would strand whichever lost the race.
    const g = this.game;
    if (g?.shopUI?.isOpen) g.shopUI.close();
    if (g?.assayUI?.isOpen) g.assayUI.close();
    if (g?.invUI?.isOpen) g.invUI.close();
    if (g?.journalUI?.open) g.journalUI.hide();
    // In a GATE this is a full-screen modal over a live fight — pause, or the
    // player is eaten behind a map they opened (review finding; mirrors
    // inventoryui's _pausedByUs exactly, including the city asymmetry: town
    // is safe and does not pause).
    if (g && g.state === 'playing' && g.mode?.name !== 'city') {
      g.pause(true);
      this._pausedByUs = true;
    }
    // Always open on the town you are standing in; the switcher is a per-open
    // excursion, not a sticky preference.
    this._viewSlug = null;
    this.render();
    this.root.classList.remove('hidden');
    document.body.classList.add('gb-map');
    this._open = true;
    return true;
  }

  close() {
    this.root.classList.add('hidden');
    document.body.classList.remove('gb-map');
    this._open = false;
    if (this._pausedByUs) {
      this._pausedByUs = false;
      this.game?.pause?.(false);
    }
    // Router reconciliation hook — main.js pops the AppState stack here IF the
    // map was entered as a screen. Fired after the flags settle so a handler
    // that re-renders another screen never sees a half-closed map.
    this.onClosed?.();
  }

  // ------------------------------------------------------------- rendering

  /**
   * Rebuild the chart. Cheap; called once per open and per switcher tap.
   *
   * TWO VIEWS since Wave B5. The ACTIVE settlement (default) is drawn from
   * the LIVE city exactly as before — portals, lock state, discovered POIs,
   * the hunter's own dot. A REMOTE settlement (a tapped switcher chip, gated
   * on save.visited) is drawn from its DESCRIPTOR: static portal placements
   * through resolvePortalPlacement, nothing live, because no City exists for
   * it — two settlements never coexist, and the map must not pretend
   * otherwise. Remote charts carry no player dot, no distances, no lock
   * state and no Verge sites: it is what a hunter would remember of a town,
   * which is honestly less than what he can see standing in one.
   */
  render() {
    this.chartMount.textContent = '';
    this.legendEl.textContent = '';
    this.footEl.textContent = '';
    this.townsEl.textContent = '';

    const g = this.game;
    const city = g?.mode?.city || null;
    const activeSlug = city?.spec?.slug || g?.save?.settlement || 'threshold';
    const visited = Array.isArray(g?.save?.visited) ? g.save.visited : ['threshold'];
    // The viewed slug: a visited remote pick survives; anything else (stale
    // pick, the active town itself) collapses back to the active view.
    const view = (this._viewSlug && this._viewSlug !== activeSlug && visited.includes(this._viewSlug))
      ? this._viewSlug : activeSlug;
    this._viewSlug = view === activeSlug ? null : view;
    this.titleEl.textContent = settlementName(view);
    this._buildTowns(activeSlug, view, visited);

    if (view !== activeSlug) {
      this._renderRemote(view);
      return;
    }

    if (!city || !Array.isArray(city.portals) || !city.portals.length) {
      // Title screen / mid-gate: no live streets to chart. Diegetic, honest.
      this.footEl.appendChild(el('span', null,
        'The chart is drawn from the streets you walk. Open it in town.'));
      return;
    }

    const spec = city.spec || null;
    // A HIDDEN gate stays off the chart until found (review fix: the
    // Birchreach's secret wild gate — 'A GATE THE FOREST KEPT' — was drawn,
    // named, and tappable the moment the map opened). One filtered list
    // feeds the pips, the extent fit, and the legend, so they can never
    // disagree about what is known.
    const portals = city.portals.filter((p) => !p.hidden);
    const pois = (city.frontier?.pois || []).filter((p) => p.discovered);

    // ---- projection: world metres -> a fixed 200x200 viewBox --------------
    // Screen convention matches the compass (citymode._updateCompass): the
    // city camera looks down -Z, so world -Z is up on screen. SVG's y axis
    // grows downward, so svgY = worldZ * s puts the Breach (z = -126) at the
    // top — north where the player's thumb expects it.
    let extent = spec?.wall?.half || 88;
    for (const p of portals) extent = Math.max(extent, Math.abs(p.pos.x), Math.abs(p.pos.z));
    for (const p of pois) extent = Math.max(extent, Math.abs(p.pos.x), Math.abs(p.pos.z));
    const s = 92 / (extent + 8);   // 8 m breathing room inside the 100-unit half

    const svg = svgEl('svg', { viewBox: '-100 -100 200 200', class: 'map-chart' });

    // Wall: the walled interior really is a square (-half..half both axes),
    // so a square is what the chart shows.
    const half = (spec?.wall?.half || 88) * s;
    svg.appendChild(svgEl('rect', {
      x: -half, y: -half, width: half * 2, height: half * 2, rx: 6,
      fill: 'none', stroke: hex(0x3a4468), 'stroke-width': 1.5,
    }));

    // The plaza ring — the E gate's anchor; the other rank gates stand in
    // their districts since B2 (their pips draw from true portal pos).
    const ringR = (spec?.portals?.ring || 22) * s;
    svg.appendChild(svgEl('circle', {
      cx: 0, cy: 0, r: ringR,
      fill: 'none', stroke: hex(0x2b3352), 'stroke-width': 1, 'stroke-dasharray': '3 3',
    }));
    const plazaR = Math.max(3, (spec?.wall?.plazaR || 26) * s * 0.35);
    svg.appendChild(svgEl('circle', {
      cx: 0, cy: 0, r: plazaR, fill: hex(0x2b3352),
    }));

    // Discovered Verge POIs: small diamonds, drawn UNDER the pips so a wild
    // gate (which is both a POI site and a portal) reads as its pip.
    for (const poi of pois) {
      const x = poi.pos.x * s, y = poi.pos.z * s;
      svg.appendChild(svgEl('path', {
        d: `M ${x} ${y - 4} L ${x + 4} ${y} L ${x} ${y + 4} L ${x - 4} ${y} Z`,
        fill: hex(0x8a93b8), opacity: 0.9,
      }));
    }

    // Gate pips: rank colour straight off PORTAL_COLORS — the one palette the
    // player already reads as "how deep is this". Locked dims, wild gets an
    // outer ring. The <title> child is the desktop hover affordance; the tap
    // affordance is the footer line (see _describe).
    for (const portal of portals) {
      const x = portal.pos.x * s, y = portal.pos.z * s;
      const color = hex(portal.color ?? PORTAL_COLORS[portal.rank] ?? 0xbfd0ff);
      const gp = svgEl('g', { class: 'pip', opacity: portal.locked ? 0.35 : 1 });
      if (portal.wild) {
        gp.appendChild(svgEl('circle', {
          cx: x, cy: y, r: 8, fill: 'none', stroke: color, 'stroke-width': 1.5,
        }));
      }
      gp.appendChild(svgEl('circle', { cx: x, cy: y, r: 5, fill: color }));
      // Generous invisible hit disc: a 5-unit pip is a 9 px tap target on a
      // phone, which misses. 12 units is a thumb.
      const hit = svgEl('circle', { cx: x, cy: y, r: 12, fill: 'transparent' });
      const label = svgEl('title', {});
      label.textContent = portalName(portal);
      gp.appendChild(label);
      gp.appendChild(hit);
      gp.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.audio?.ui?.();
        this._describe(portal);
      });
      svg.appendChild(gp);
    }

    // The hunter: a plain bright dot, drawn last so it tops everything.
    const pp = this.game?.player?.pos;
    if (pp) {
      svg.appendChild(svgEl('circle', {
        cx: pp.x * s, cy: pp.z * s, r: 2.5, fill: hex(0xeaf0ff),
      }));
    }

    this.chartMount.appendChild(svg);
    this._buildLegend(portals, pois.length > 0);
  }

  /**
   * The switcher row: one chip per settlement the save has VISITED (registry
   * order, so chips never reshuffle), the active one bold. Discovery-gating
   * lives exactly here — an unvisited settlement gets no chip at all, so the
   * map cannot leak the name of a place the player has not found (Wave B5:
   * gating is a MAP concern only; the waygates themselves always work).
   */
  _buildTowns(activeSlug, viewSlug, visited) {
    const slugs = Object.keys(SETTLEMENTS).filter((s) => visited.includes(s));
    if (slugs.length < 2) return;   // one town known — no dimension to switch
    for (const slug of slugs) {
      const b = el('button', slug === activeSlug ? 'active' : null, settlementName(slug));
      b.type = 'button';
      if (slug === viewSlug) b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.audio?.ui?.();
        this._viewSlug = slug === activeSlug ? null : slug;
        this.render();
      });
      this.townsEl.appendChild(b);
    }
  }

  /**
   * A remote settlement's chart, from its descriptor alone — see render()'s
   * header for what is deliberately absent. Pips are the portals.placements:
   * rank gates in their rank dye, waygates in the network silver; taps
   * describe (the TRAVEL button is the ACTIVE view's affordance — you travel
   * from a waygate you can reach, not from a memory).
   */
  _renderRemote(slug) {
    const spec = SETTLEMENTS[slug];
    if (!spec) return;
    const sites = (spec.portals?.placements || []).map((pl) => {
      const site = resolvePortalPlacement(spec, pl);
      return {
        id: pl.id,
        rank: pl.rank || null,
        kind: pl.kind || 'gate',
        way: pl.kind === 'way' && pl.to
          ? { toSettlement: pl.to.settlement, toPortalId: pl.to.portalId }
          : null,
        color: pl.kind === 'way' ? WAY_COLOR : (PORTAL_COLORS[pl.rank] ?? 0xbfd0ff),
        pos: { x: site.x, z: site.z },
      };
    });

    let extent = spec.wall?.half || 88;
    for (const p of sites) extent = Math.max(extent, Math.abs(p.pos.x), Math.abs(p.pos.z));
    const s = 92 / (extent + 8);

    const svg = svgEl('svg', { viewBox: '-100 -100 200 200', class: 'map-chart' });
    // Only a settlement that BUILT a wall gets the square (Emberfall and the
    // forest have none — drawing one would chart a fiction).
    if (spec.wall?.built !== false) {
      const half = (spec.wall?.half || 88) * s;
      svg.appendChild(svgEl('rect', {
        x: -half, y: -half, width: half * 2, height: half * 2, rx: 6,
        fill: 'none', stroke: hex(0x3a4468), 'stroke-width': 1.5,
      }));
    }
    const ringR = (spec.portals?.ring || 22) * s;
    svg.appendChild(svgEl('circle', {
      cx: 0, cy: 0, r: ringR,
      fill: 'none', stroke: hex(0x2b3352), 'stroke-width': 1, 'stroke-dasharray': '3 3',
    }));
    const plazaR = Math.max(3, (spec.wall?.plazaR || 26) * s * 0.35);
    svg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: plazaR, fill: hex(0x2b3352) }));

    for (const p of sites) {
      const x = p.pos.x * s, y = p.pos.z * s;
      const gp = svgEl('g', { class: 'pip' });
      gp.appendChild(svgEl('circle', { cx: x, cy: y, r: 5, fill: hex(p.color) }));
      const hit = svgEl('circle', { cx: x, cy: y, r: 12, fill: 'transparent' });
      const label = svgEl('title', {});
      label.textContent = portalName(p);
      gp.appendChild(label);
      gp.appendChild(hit);
      gp.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.audio?.ui?.();
        this._describe(p, { remote: true });
      });
      svg.appendChild(gp);
    }

    this.chartMount.appendChild(svg);
    this._buildLegend(sites, false);
    this.footEl.appendChild(el('span', null, 'Charted from memory. Travel from a waygate.'));
  }

  /** One chip per rank actually present, plus the state modifiers. */
  _buildLegend(portals, anyPoi) {
    const ranks = [];
    // Waygates carry no rank (null) — they get their own chip below, not a
    // 'null' entry in the rank row.
    for (const p of portals) if (p.rank && !ranks.includes(p.rank)) ranks.push(p.rank);
    for (const rank of ranks) {
      const chip = el('span', null, null);
      const dot = document.createElement('i');
      dot.style.background = hex(PORTAL_COLORS[rank] ?? 0xbfd0ff);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(rank));
      this.legendEl.appendChild(chip);
    }
    if (portals.some((p) => p.kind === 'way' || p.way)) {
      const chip = el('span', null);
      const dot = document.createElement('i');
      dot.style.background = hex(WAY_COLOR);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode('WAYGATE'));
      this.legendEl.appendChild(chip);
    }
    if (portals.some((p) => p.wild)) {
      const chip = el('span', 'wild');
      chip.appendChild(document.createElement('i'));
      chip.appendChild(document.createTextNode('WILD'));
      this.legendEl.appendChild(chip);
    }
    if (portals.some((p) => p.locked)) {
      const chip = el('span', null);
      const dot = document.createElement('i');
      dot.style.background = hex(0xbfd0ff);
      dot.style.opacity = '0.35';
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode('LOCKED'));
      this.legendEl.appendChild(chip);
    }
    if (anyPoi) {
      const chip = el('span', 'poi');
      const dot = document.createElement('i');
      dot.style.background = hex(0x8a93b8);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode('VERGE SITE'));
      this.legendEl.appendChild(chip);
    }
  }

  /**
   * Tap-a-pip, v1: name + rank + walking distance in the footer. The spec's
   * preferred behaviour (aim the city compass at the tapped gate) needs a
   * target override on citymode's _updateCompass, which recomputes
   * nearest-unlocked every 250 ms and exposes no hook — and citymode.js is
   * outside this task's file set. Noted for the orchestrator; the footer line
   * is a v1 fallback OWNED HERE (not spec-attributed — review finding):
   * the spec's tap behavior is travel, which needs B5's waygates, and
   * compass aiming needs a citymode target-override hook; until either
   * exists the footer tells the player what they tapped.
   */
  _describe(portal, { remote = false } = {}) {
    this.footEl.textContent = '';
    const name = el('b', null, portalName(portal));
    this.footEl.appendChild(name);
    const bits = [];
    if (portal.way) bits.push(` · TO ${settlementName(portal.way.toSettlement)}`);
    else bits.push(` · RANK ${portal.rank}`);
    // Distance is a LIVE fact: only the active view has a player standing on
    // the same chart.
    const pp = remote ? null : this.game?.player?.pos;
    const dist = pp ? Math.round(Math.hypot(portal.pos.x - pp.x, portal.pos.z - pp.z)) : null;
    if (dist != null) bits.push(` · ${dist} m`);
    if (portal.locked) bits.push(' · SEALED');
    this.footEl.appendChild(document.createTextNode(bits.join('')));

    // TRAVEL (Wave B5): only on a way pip, only in the ACTIVE settlement's
    // view (remote pips are memories, not doors), and only to a destination
    // the save has VISITED — the one place travel is discovery-gated. It
    // routes through the SAME flow the doorstep confirm uses
    // (citymode.travelTo), after closing the map: the mode is about to tear
    // the whole town down, and the overlay must not outlive the city it was
    // charting.
    if (!remote && portal.way) {
      const g = this.game;
      const visited = Array.isArray(g?.save?.visited) ? g.save.visited : ['threshold'];
      const mode = g?.mode;
      if (mode?.name === 'city' && typeof mode.travelTo === 'function'
          && visited.includes(portal.way.toSettlement)) {
        const btn = el('button', 'map-travel', 'TRAVEL');
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.audio?.ui?.();
          const way = portal.way;   // survive the close/teardown
          this.close();
          mode.travelTo(way);
        });
        this.footEl.appendChild(btn);
      } else {
        this.footEl.appendChild(document.createTextNode(' · UNCHARTED'));
      }
    }
  }
}

export default MapUI;
