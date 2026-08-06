import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import * as Save from './core/save.js';
import { UI } from './ui/ui.js';
import { Game } from './game/game.js';
import { loadHdri } from './render/env.js';
import { loadItemModels, getItemMesh, itemModelStats } from './render/models.js';
import { loadIconIndex } from './ui/icons.js';
import { FrameClock } from './core/frameclock.js';

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

const game = new Game({
  canvas, input, audio, ui,
  saveData,
  onSave: persist,
});
ui.game = game;

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

// Exposed so the smoke test can assert the pack actually resolved rather than
// inferring it from pixels.
window.__items = { ready: () => itemsReady, stats: itemModelStats, promise: itemsPromise };

let bootStep = 0;
const bootTimer = setInterval(() => {
  bootStep++;
  const pct = Math.min(100, bootStep * 25);
  document.getElementById('bootFill').style.width = `${pct}%`;
  document.getElementById('bootMsg').textContent = bootMessages[Math.min(bootStep, bootMessages.length - 1)];
  if (bootStep >= 4 && ((hdriReady && itemsReady) || bootStep >= 8)) {
    clearInterval(bootTimer);
    setTimeout(() => {
      document.getElementById('boot').classList.add('hidden');
      ui.show('title');
      ui.refreshTitle();
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
clock.start();

// Exposed for automated smoke tests; harmless in production.
window.__game = game;
window.__clock = clock;
