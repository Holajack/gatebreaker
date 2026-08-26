// Boot the BUILT bundle, not the dev server. `npm run build` succeeding proves
// the bundler is happy; it does not prove the minified, tree-shaken output
// runs — dead-code elimination and the vite-only import graph are exactly where
// a dev-server-green tree breaks in production.
//
//   npm run build && GB_PREVIEW_PORT=5273 node tools/preview-boot.mjs
//
// Starts `vite preview`, walks the real UI into an E gate, and reports whether
// the world mounted with its cover field intact plus every page error seen.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPhonePage } from './_harness.mjs';

const PORT = Number(process.env.GB_PREVIEW_PORT || 5273);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const tail = [];
child.stdout.on('data', (b) => tail.push(String(b)));
child.stderr.on('data', (b) => tail.push(String(b)));
process.once('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });

const url = `http://localhost:${PORT}/`;
const up = async () => {
  try { await fetch(url, { method: 'HEAD' }); return true; } catch { return false; }
};
const deadline = Date.now() + 25000;
while (Date.now() < deadline && !(await up())) await new Promise((r) => setTimeout(r, 300));
if (!(await up())) { console.log(`preview never came up:\n${tail.join('')}`); process.exit(1); }

const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__game), null, { timeout: 40000 });
await page.waitForSelector('#title:not(.hidden)', { timeout: 40000 });
await page.waitForTimeout(2000);

const booted = await page.evaluate(() => ({
  hasGame: Boolean(window.__game),
  mode: window.__game?.mode?.name ?? null,
}));

// Walk the real route in: PLAY -> city -> fast-travel gate list -> E gate.
await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 40000 })
  .catch(() => {});
// RETARGET 2026-08-26: dismiss the first-arrival welcome (see _harness.dismissDialog)
await page.evaluate(() => { const d = window.__game?.dialog; for (let i = 0; d?.open && i < 12; i++) d.advance(); });
await page.evaluate(() => window.__app?.go('gates'));
await page.waitForSelector('#gateList .gate', { timeout: 20000 });
await page.locator('#gateList .gate:not(.locked)').first().click();
await page.waitForTimeout(6000);

const inGate = await page.evaluate(() => {
  const g = window.__game;
  const L = g?.world?.layout;
  return {
    mode: g?.mode?.name ?? null,
    rank: g?.gate?.rank ?? null,
    kind: g?.world?.kind ?? null,
    rooms: L?.rooms?.length ?? 0,
    coverPieces: L?.decor?.cover?.length ?? 0,
    bossRoom: L ? `${L.rooms[L.bossRoom].w}x${L.rooms[L.bossRoom].d}` : null,
    gateEnemies: g?.gate?.enemies ?? null,
    waveSize: g?.mode?.director?.waveSize ?? null,
    obstacles: g?.world?.obstacleField?.count ?? 0,
  };
});

const shot = `${process.env.GB_OUT || '/tmp'}/preview-boot.png`;
await page.screenshot({ path: shot });

console.log('booted:', JSON.stringify(booted));
console.log('in gate:', JSON.stringify(inGate));
console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
console.log('shot:', shot);

await browser.close();
try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
process.exit(errors.length || inGate.mode !== 'dungeon' ? 1 : 0);
