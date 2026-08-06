import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import * as Save from './core/save.js';
import { UI } from './ui/ui.js';
import { Game } from './game/game.js';
import { loadHdri } from './render/env.js';

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

let bootStep = 0;
const bootTimer = setInterval(() => {
  bootStep++;
  const pct = Math.min(100, bootStep * 25);
  document.getElementById('bootFill').style.width = `${pct}%`;
  document.getElementById('bootMsg').textContent = bootMessages[Math.min(bootStep, bootMessages.length - 1)];
  if (bootStep >= 4 && (hdriReady || bootStep >= 8)) {
    clearInterval(bootTimer);
    setTimeout(() => {
      document.getElementById('boot').classList.add('hidden');
      ui.show('title');
      ui.refreshTitle();
    }, 380);
  }
}, 260);

// Mid-range Androids ship 90Hz and 120Hz panels, so requestAnimationFrame
// fires far faster than 60. Without this cap the frame budget looks like
// 8.3ms instead of 16.6ms and the quality governor concludes the device is
// slow, degrading visuals for no reason.
const TARGET_DT = 1 / 60;
let last = performance.now();
let acc = 0;

function frame(now) {
  // Schedule first, so a throw inside update() can't kill the loop.
  requestAnimationFrame(frame);
  acc += (now - last) / 1000;
  last = now;
  if (acc < TARGET_DT - 0.0015) return;
  const dt = Math.min(acc, 0.05);
  acc = 0;
  game.update(dt);
}
requestAnimationFrame(frame);

// Exposed for automated smoke tests; harmless in production.
window.__game = game;
