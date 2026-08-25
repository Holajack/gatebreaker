// Wave B5a smoke: the world map panel.
//
// Proves, against the real app in a real (headless) browser:
//   1. boot -> PLAY -> city mounts;
//   2. the HUD map button (#btnMap, injected by mapui.js) opens #map;
//   3. the chart renders one pip per city portal (>= 6: the plaza five + the
//      Breach; wild gates add more when the Verge has stamped them);
//   4. tapping a pip writes the name/rank/distance footer line;
//   5. hardware back (Escape rides the same handleBack) closes the panel and
//      leaves the city MOUNTED — no rebuild, no teleport, no soft-lock;
//   6. zero page errors end to end.
//
//   GB_PORT=5173 node tools/mapui-smoke.mjs
import { ensureServer, launchBrowser, newPhonePage, gotoGame, writeReport } from './_harness.mjs';

const srv = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
await gotoGame(page);

const report = { steps: [], errors };
const step = (name, ok, detail) => {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? `  — ${JSON.stringify(detail)}` : ''}`);
};

// 1. Into town.
await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page.waitForTimeout(800);
const cityBefore = await page.evaluate(() => ({
  portals: window.__game.mode.city.portals.length,
  // Object identity marker: stamp the live City so we can prove back() did
  // not tear it down and rebuild (the shopui-header failure mode).
  stamped: (window.__game.mode.city.__smokeStamp = 'b5a'),
  player: { x: window.__game.player.pos.x, z: window.__game.player.pos.z },
}));
step('city mounted', cityBefore.portals >= 6, cityBefore);

// 2. Open via the HUD button.
step('#btnMap exists in HUD', await page.locator('#hud #btnMap').count() === 1);
await page.click('#btnMap');
await page.waitForSelector('#map:not(.hidden)', { timeout: 5000 });
step('#map opened', true);

// 3. Pips.
const pips = await page.evaluate(() => ({
  pips: document.querySelectorAll('#map .map-chart g.pip').length,
  portals: window.__game.mode.city.portals.length,
  legendChips: document.querySelectorAll('#map .map-legend span').length,
  title: document.querySelector('#map h2')?.textContent,
}));
step('one pip per portal, >= 6', pips.pips === pips.portals && pips.pips >= 6, pips);
step('legend present', pips.legendChips >= 6, { chips: pips.legendChips });
step('panel titled from descriptor slug', pips.title === 'THRESHOLD', pips.title);

// 4. Tap a pip -> footer line.
await page.evaluate(() => {
  document.querySelector('#map .map-chart g.pip').dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
});
const foot = await page.evaluate(() => document.querySelector('#map .map-foot')?.textContent || '');
step('pip tap writes footer (name · rank · distance)',
  /RANK [EDCBAS]/.test(foot) && /\d+ m/.test(foot), foot);

// 5. Back closes it without a city rebuild.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
  mapHidden: document.getElementById('map').classList.contains('hidden'),
  isOpen: window.__game.mapUI.isOpen,
  mode: window.__game.mode?.name,
  sameCity: window.__game.mode?.city?.__smokeStamp === 'b5a',
  appCurrent: window.__app.current,
  player: { x: window.__game.player.pos.x, z: window.__game.player.pos.z },
}));
const samePlace = Math.hypot(after.player.x - cityBefore.player.x, after.player.z - cityBefore.player.z) < 0.5;
step('back closed the panel', after.mapHidden && !after.isOpen, after);
step('city untouched (same object, same spot, still city screen)',
  after.mode === 'city' && after.sameCity && after.appCurrent === 'city' && samePlace, after);

// 6. Router path: app.go('map') -> back -> no orphaned hidden state.
await page.evaluate(() => window.__app.go('map'));
await page.waitForSelector('#map:not(.hidden)', { timeout: 5000 });
const routed = await page.evaluate(() => ({
  current: window.__app.current, isOpen: window.__game.mapUI.isOpen,
}));
step('router entry opens panel + flag', routed.current === 'map' && routed.isOpen, routed);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const routedBack = await page.evaluate(() => ({
  current: window.__app.current,
  mapHidden: document.getElementById('map').classList.contains('hidden'),
  mode: window.__game.mode?.name,
}));
step('router back returns to city, no soft-lock',
  routedBack.current === 'city' && routedBack.mapHidden && routedBack.mode === 'city', routedBack);

step('zero page errors', errors.length === 0, errors.slice(0, 3));

const ok = report.steps.every((s) => s.ok);
const file = writeReport('mapui-smoke', report);
console.log(`${ok ? 'ALL PASS' : 'FAILURES'} — report: ${file}`);
await browser.close();
await srv.stop();
process.exit(ok ? 0 : 1);
