// Landscape-orientation combat shot. Phones get held sideways for this game
// far more than the portrait mock-ups suggest, and the HUD reflows.
//
//   node tools/landscape-shot.mjs [outName]
//
// Absorbed tools/land.mjs, which was the same script with a different port and
// a different output filename.

import { OUT, launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame, shotPath } from './_harness.mjs';

const name = process.argv[2] || 'L-landscape.png';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412 });

await gotoGame(page, { waitMs: 2200 });
await page.click('#btnPlay');
await page.waitForTimeout(400);
await page.click('#gateList .gate:not(.locked)');
await page.waitForTimeout(1800);

await evalGame(page, (g) => {
  g.player.invuln = 0;
  g.enemies.forEach((e, i) => {
    const a = (i / g.enemies.length) * Math.PI * 2;
    e.pos.set(Math.cos(a) * 5, 0, Math.sin(a) * 5 - 2);
    e.spawning = 0;
  });
});
await page.waitForTimeout(600);
await page.keyboard.press('j');
await page.waitForTimeout(300);
await page.screenshot({ path: shotPath(name) });

console.log(`wrote ${name} to ${OUT}`);
console.log('ERRORS:', errors.length ? errors.join('\n') : '(none)');
await browser.close();
await server.stop();
process.exit(errors.length ? 1 : 0);
