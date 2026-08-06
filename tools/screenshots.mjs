// Marketing / review screenshots of the three screens that matter: title,
// gate select, and a live fight with the enemies pulled into frame.
//
//   node tools/screenshots.mjs

import { OUT, launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame, shotPath } from './_harness.mjs';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);

await gotoGame(page, { waitMs: 2000 });
await page.screenshot({ path: shotPath('A-title.png') });

await page.click('#btnPlay');
await page.waitForTimeout(500);
await page.screenshot({ path: shotPath('B-gates.png') });

await page.click('#gateList .gate:not(.locked)');
await page.waitForTimeout(1500);

// Pull the fight to the player so the shot is a fight and not an empty arena.
await evalGame(page, (g) => {
  g.player.invuln = 0;
  g.enemies.forEach((e, i) => {
    const a = (i / g.enemies.length) * Math.PI * 2;
    e.pos.set(Math.cos(a) * 4.5, 0, Math.sin(a) * 4.5 - 2);
    e.spawning = 0;
  });
});
await page.waitForTimeout(700);
for (let i = 0; i < 4; i++) { await page.keyboard.press('j'); await page.waitForTimeout(260); }
await page.screenshot({ path: shotPath('C-combat.png') });

console.log(`wrote A-title.png B-gates.png C-combat.png to ${OUT}`);
console.log('ERRORS:', errors.length ? errors.join('\n') : '(none)');
await browser.close();
await server.stop();
process.exit(errors.length ? 1 : 0);
