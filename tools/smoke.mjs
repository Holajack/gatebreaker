import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '/tmp/claude-0/-home-user-collins-seo-website/d52ff8fd-7e89-591c-9ed1-ace0f798cd42/scratchpad';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2 });

const errors = [];
const logs = [];
page.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack}`));

await page.goto('http://localhost:4193/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/01-title.png` });

// Title -> gates
await page.click('#btnPlay');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-gates.png` });

// Enter the first gate
await page.click('#gateList .gate:not(.locked)');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/03-gate.png` });

// Simulate play: move + attack for a while
for (let i = 0; i < 6; i++) {
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  await page.waitForTimeout(500);
  await page.keyboard.up('w');
  await page.keyboard.up('d');
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  await page.keyboard.press('Shift');
  await page.waitForTimeout(300);
}
await page.screenshot({ path: `${OUT}/04-combat.png` });

// Probe internal state
const state = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  return {
    canvas: c ? `${c.width}x${c.height}` : 'none',
    hudVisible: !document.getElementById('hud').classList.contains('hidden'),
    objective: document.getElementById('objCount').textContent,
    hp: document.getElementById('hpText').textContent,
    mp: document.getElementById('mpText').textContent,
  };
});

console.log('STATE:', JSON.stringify(state, null, 2));
console.log('\n--- console logs ---');
console.log(logs.slice(0, 40).join('\n') || '(none)');
console.log('\n--- page errors ---');
console.log(errors.join('\n---\n') || '(none)');

fs.writeFileSync(`${OUT}/smoke-result.json`, JSON.stringify({ state, errors, logs }, null, 2));
await browser.close();
process.exit(errors.length ? 1 : 0);
