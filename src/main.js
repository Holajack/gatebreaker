import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import * as Save from './core/save.js';
import { UI } from './ui/ui.js';
import { Game } from './game/game.js';
import { loadHdri } from './render/env.js';
import { loadItemModels, getItemMesh, itemModelStats } from './render/models.js';
import { loadIconIndex } from './ui/icons.js';
import { preloadCharacters, characterStats } from './game/entities.js';
import { FrameClock } from './core/frameclock.js';
import { AppState } from './core/appstate.js';
import { preloadCity } from './world/city.js';
import { ShopUI } from './ui/shopui.js';
import { InventoryUI } from './ui/inventoryui.js';
import * as Weapons from './game/weapons.js';

const canvas = document.getElementById('scene');
const audio = new Audio();
const input = new Input();
let saveData = Save.load();

const persist = () => Save.save(saveData);

const ui = new UI({
  audio,
  onPlayGate: (i) => {
    audio.unlock();
    game.startGate(i);
  },
  onResume: () => game.pause(false),
  onQuit: () => { game.quit(); },
  onReset: () => {
    Save.wipe();
    saveData = Save.freshSave();
    game.save = saveData;
    ui.attach(saveData);
    game.refreshDerived(true);
    ui.refreshTitle();
    ui.toast('HUNTER DATA ERASED');
  },
});
ui.attach(saveData);
ui.onStatChange = persist;

// ---------------------------------------------------------------------------
// THE ROUTER
// ---------------------------------------------------------------------------
// The flow the owner asked for, spelled out:
//
//   title -> CITY -> walk to a portal -> run -> results -> back to the CITY,
//   standing beside the portal you used.
//
// The gate LIST survives, but only as fast travel from the Assay Hall. It is no
// longer the way in, because menu -> gate -> boss -> menu was the thing that
// made the game feel like a wave shooter with a lobby.
const app = new AppState({
  onEnter(screen, payload) {
    switch (screen) {
      case 'title':
        game.quit();
        ui.refreshTitle();
        break;
      case 'city':
        audio.unlock();
        game.enterCity(payload);
        break;
      case 'gates':
        openGateList();
        break;
      case 'run':
        game.beginRun(payload);
        break;
      default:
        break;
    }
  },
});

const game = new Game({
  canvas, input, audio, ui,
  saveData,
  onSave: persist,
  appState: app,
});
ui.game = game;

// The Exchange's counter. Constructed once, here, rather than by CityMode:
// CityMode is torn down and rebuilt on every city entry, and a panel that
// rebuilt its DOM on each of those would leak a #shop node per visit. It hangs
// off the game so citymode.confirmPrompt can reach it without importing the UI
// layer. Deliberately NOT an AppState screen — see the header of shopui.js.
game.shopUI = new ShopUI({ game, audio });

// The hunter's sheet. Constructed here for the same reason the shop is: it
// outlives every city rebuild, and a panel that built its DOM per open would
// leak an #inv node per visit. Deliberately NOT an AppState screen — see the
// header of inventoryui.js.
game.invUI = new InventoryUI({ game, audio });

// Three ways in, one of them a thumb: the HUD button, the pause panel and
// desktop's I key. Delegated from document so the HUD button works in the city
// and in a gate without ui.js needing to know the panel exists.
function toggleInventory() {
  if (!game.invUI) return;
  audio.ui();
  // ONE overlay at a time: the shop and the sheet both hide #cityUi and both
  // claim the back button, so opening one over the other would leave whichever
  // lost the race unreachable.
  if (game.shopUI?.isOpen) game.shopUI.close();
  game.invUI.toggle();
}
document.addEventListener('click', (e) => {
  if (!e.target?.closest?.('#btnInventory, #btnInventoryPause')) return;
  e.stopPropagation();
  e.preventDefault();
  // Opened FROM the pause screen: hide pause, and put it back on close.
  // Without the return path the game stays paused with nothing on screen —
  // #pause is what owns RESUME, and hiding it without a way back is a
  // soft-lock, not a menu.
  const fromPause = !document.getElementById('pause')?.classList.contains('hidden');
  if (fromPause) ui.hide('pause');
  toggleInventory();
  if (fromPause && game.invUI?.isOpen) game.invUI.onClose = () => ui.showPause();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'i' && e.key !== 'I') return;
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  toggleInventory();
});

// ui.js still owns the gate-list DOM; main.js owns where its two entry points
// lead. Both of them — the title's play button and the results panel's
// CONTINUE — used to open that list, and both should now put you in the city.
// Overriding the one method reroutes both without editing ui.js.
const openGateList = ui.showGates.bind(ui);
ui.showGates = () => app.go('city', { atPortal: game.lastGateRank });

// Two buttons in ui.js hardcode "and then show the title", which is wrong once
// the city exists: BACK out of the fast-travel list belongs to whatever opened
// it, and abandoning a gate belongs to the city. Intercepting in the capture
// phase on document beats editing ui.js from here.
document.addEventListener('click', (e) => {
  const btn = e.target?.closest?.('#btnGatesBack, #btnQuit');
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  audio.ui();
  if (btn.id === 'btnGatesBack') {
    if (!app.back()) app.go('title');
  } else {
    ui.hide('pause');
    app.go('city', { atPortal: game.lastGateRank });
  }
}, true);

// Android hardware back. Capacitor routes it to WebView history when no plugin
// claims it, so a pushed history entry plus popstate is what actually fires on
// the device; the other two listeners cover Cordova-style shells and desktop.
function handleBack() {
  if (!document.getElementById('pause')?.classList.contains('hidden')) {
    ui.hide('pause');
    game.pause(false);
    return;
  }
  // The shop rides with the other classList-toggled overlays: back / Escape
  // closes the panel and leaves you standing in the doorway you opened it
  // from, which is what walking out of a shop means. It closes through its own
  // method rather than ui.hide so its isOpen flag cannot go stale.
  // The sheet is checked first because it is the one that can be opened from
  // inside a gate, where the pause panel below would otherwise swallow the
  // press. Only one overlay is ever open (see toggleInventory), so the order
  // here is about which check runs, not about nesting.
  if (game.invUI?.isOpen) { game.invUI.close(); return; }
  if (game.shopUI?.isOpen) { game.shopUI.close(); return; }
  for (const id of ['how', 'levelup']) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) { ui.hide(id); return; }
  }
  if (app.is('run') && game.state === 'playing') { ui.showPause(); return; }
  app.back();
}
history.pushState({ gb: true }, '');
window.addEventListener('popstate', () => {
  history.pushState({ gb: true }, '');   // stay one entry deep, forever
  handleBack();
});
document.addEventListener('backbutton', (e) => { e.preventDefault?.(); handleBack(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') handleBack(); });

// Any first touch/click satisfies the browser autoplay gate.
const unlock = () => audio.unlock();
window.addEventListener('touchstart', unlock, { once: true });
window.addEventListener('mousedown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

// Keep the screen awake during a run. Touch games can go a long time between
// taps and Android will happily dim the display mid-boss-fight.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* denied or unsupported — not fatal */ }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && game.state === 'playing') requestWakeLock();
});
window.addEventListener('touchstart', requestWakeLock, { once: true });

// Pause automatically when the app is backgrounded — important on Android,
// where leaving the activity otherwise leaves you taking hits off-screen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Android kills backgrounded apps without warning, so flush progress here.
    persist();
    if (game.state === 'playing') ui.showPause();
  }
});

// ---- boot sequence: warm up the renderer before showing the title ----
const bootMessages = [
  'Calibrating rift resonance…',
  'Compiling shaders…',
  'Resolving sky radiance…',
  'Seeding rift geometry…',
  'Ready.',
];
let hdriReady = false;
loadHdri().then((tex) => { hdriReady = Boolean(tex); });

// The 106-model CC0 item pack is ~737 KB and loads in one request, so it rides
// the same splash the HDRI already covers instead of hitching the first drop.
// Both of these resolve FALSE rather than throwing when the file is absent:
// the game is fully offline and must still boot with public/models/ deleted,
// falling back to the procedural weapons in weapons.js.
let itemsReady = false;
const itemsPromise = loadItemModels().then((ok) => {
  itemsReady = true;
  if (ok) game.useItemModels(getItemMesh);
  else console.warn('[items] models/items.glb unavailable — using procedural weapons');
  return ok;
});
loadIconIndex();

// The 3.2 MB skinned-character pack. entities.js kicks this off lazily on the
// first makeHumanoid anyway, but by then the player already exists as a
// procedural box-man and visibly pops when the real body swaps in. Starting it
// here puts the whole load under the splash. Resolves FALSE, never throws.
// The 1.2 MB city kit. The city is now the FIRST place the player stands, so
// this cannot be lazy: City.build() is synchronous and silently falls back to
// blocky procedural stand-ins for every piece the kit has not supplied yet.
// Resolves FALSE rather than throwing when the file is absent.
let cityReady = false;
const cityPromise = preloadCity().then((ok) => {
  cityReady = true;
  if (!ok) console.warn('[city] models/citykit.glb unavailable — using procedural pieces');
  return ok;
});

let charsReady = false;
const charsPromise = preloadCharacters().then((ok) => {
  charsReady = true;
  if (!ok) console.warn('[characters] models/characters.glb unavailable — using the procedural rig');
  return ok;
});

// Exposed so the smoke test can assert the pack actually resolved rather than
// inferring it from pixels.
window.__items = { ready: () => itemsReady, stats: itemModelStats, promise: itemsPromise };
window.__characters = { ready: () => charsReady, promise: charsPromise, stats: characterStats };
// Not `__city` — tools/city-test.mjs already owns that name for its own scene.
window.__citykit = { ready: () => cityReady, promise: cityPromise };

let bootStep = 0;
const bootTimer = setInterval(() => {
  bootStep++;
  const pct = Math.min(100, bootStep * 25);
  document.getElementById('bootFill').style.width = `${pct}%`;
  document.getElementById('bootMsg').textContent = bootMessages[Math.min(bootStep, bootMessages.length - 1)];
  if (bootStep >= 4 && ((hdriReady && itemsReady && charsReady && cityReady) || bootStep >= 8)) {
    clearInterval(bootTimer);
    setTimeout(() => {
      // replace(), not go(): the splash is not somewhere back should return to.
      // This also hides #boot, because the router hides every other screen.
      app.replace('title');
    }, 380);
  }
}, 260);

// Mid-range Androids ship 72/90/120/144 Hz panels, so requestAnimationFrame
// fires far faster than 60. FrameClock measures the real panel rate and paces
// against it; the old inline accumulator here aliased 90 Hz down to 45 fps,
// which the quality governor then read as a slow device.
const clock = new FrameClock({
  targetFps: 60,
  onFrame: (dt) => game.update(dt),
});
// Keep the governor's thresholds on the same target the clock is pacing to.
game.quality?.setTargetFps(clock.targetFps);
// The modes retarget this on mount: 60 in a gate, 30 in the city.
game.frameClock = clock;
clock.start();

// Exposed for automated smoke tests; harmless in production.
window.__game = game;
window.__clock = clock;
window.__app = app;
// The LIVE weapons module, for tools/grip-audit.mjs and tools/grip-probe.mjs.
// A tool that reaches for it with its own `await import('/src/game/weapons.js')`
// gets a SECOND module instance whose `_getModel` is still null — measured:
// weaponCacheStats() came back all zeroes and every pack lookup silently fell
// through to the procedural builder, so an entire grip audit ran against
// weapons the player never sees. Handing the real one out is cheaper than
// re-learning that.
window.__weapons = Weapons;
