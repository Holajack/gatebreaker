// Confirms the baked sky actually reaches the scene: the .hdr is fetched, the
// PMREM target is installed on scene.environment, and the exposure the quality
// tier picked is the one in the renderer.
//
//   node tools/hdri-check.mjs

import { OUT, launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame, shotPath } from './_harness.mjs';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412 });

const net = [];
page.on('response', (r) => { if (r.url().includes('.hdr')) net.push(`${r.status()} ${r.url().split('/').pop()}`); });

await gotoGame(page, { waitMs: 3500 });
await page.click('#btnPlay');
await page.waitForTimeout(400);
await page.click('#gateList .gate:not(.locked)');
await page.waitForTimeout(2000);

const info = await evalGame(page, (g) => ({
  envSet: Boolean(g.scene.environment),
  envIntensity: g.scene.environmentIntensity,
  envMapSize: g.scene.environment
    ? `${g.scene.environment.image?.width || '?'}x${g.scene.environment.image?.height || '?'}`
    : null,
  tier: g.quality?.current?.name,
  exposure: g.renderer.toneMappingExposure,
}));

console.log('hdr requests:', net.join(', ') || '(none)');
console.log(JSON.stringify(info, null, 2));
console.log('ERRORS:', errors.length ? errors.join('\n') : '(none)');

await evalGame(page, (g) => {
  g.player.invuln = 0;
  g.enemies.forEach((e, i) => {
    const a = (i / g.enemies.length) * Math.PI * 2;
    e.pos.set(Math.cos(a) * 5, 0, Math.sin(a) * 5 - 2);
    e.spawning = 0;
  });
});
await page.waitForTimeout(700);
await page.keyboard.press('j');
await page.waitForTimeout(300);
await page.screenshot({ path: shotPath('HDRI-lit.png') });

console.log(`wrote HDRI-lit.png to ${OUT}`);
await browser.close();
await server.stop();
process.exit(errors.length || !info.envSet ? 1 : 0);
