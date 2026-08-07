// Shared Playwright harness for everything in tools/.
//
// Every tool in here used to hardcode a Chromium path from a Linux box
// (/opt/pw-browsers/chromium-1194/...), a Linux scratch directory, and a
// different dev-server port each (4178/4180/4190/4191/4193/4200/4212) while
// vite.config.js serves 5173. None of it ran anywhere but the machine it was
// written on. This module owns all of those decisions in one place so a tool
// is just the test, not the plumbing.
//
// Overrides, all optional:
//   GB_PORT    dev-server port                (default 5173, matching vite.config.js)
//   GB_OUT     screenshot / report directory  (default $TMPDIR/gatebreaker-shots)
//   GB_CHROME  browser executable             (default: whatever playwright installed)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const PORT = Number(process.env.GB_PORT || 5173);
export const OUT = process.env.GB_OUT || `${process.env.TMPDIR || '/tmp'}/gatebreaker-shots`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resolve the browser through playwright itself. A literal path is what broke
// every tool in here; the only escape hatch is an explicit env override.
function resolveChrome() {
  if (process.env.GB_CHROME) return process.env.GB_CHROME;
  const p = chromium.executablePath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `Playwright's chromium is not installed (expected ${p}).\n`
      + 'Run:  npx playwright install chromium',
    );
  }
  return p;
}

export async function launchBrowser({ headless = true, swiftshader = true } = {}) {
  // SwiftShader keeps headless WebGL deterministic across machines and CI; the
  // real GPU path is available for eyeballing shader work locally.
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (swiftshader) args.push('--use-gl=swiftshader', '--enable-unsafe-swiftshader');
  return chromium.launch({ headless, executablePath: resolveChrome(), args });
}

// A phone-shaped page with error and console capture already wired, because
// every tool wants both and half of them used to forget the pageerror hook.
//
// LANDSCAPE BY DEFAULT, and it must stay that way. index.html ships a
// rotate-gate overlay that covers the whole screen whenever innerHeight >
// innerWidth, and it swallows pointer events. The old 412x892 portrait default
// meant every tool that did not pass its own size (smoke, loot, playtest,
// pillartest, screenshots) hung on its first page.click() with a baffling
// "<div id="rotate"> intercepts pointer events". 892x412 is the same size the
// tools that already worked were passing by hand.
export async function newPhonePage(browser, { width = 892, height = 412, dpr = 2, hmr = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  // Vite's HMR client full-reloads the page whenever anyone saves a file in
  // src/. Mid-test that destroys the execution context and the tool dies with
  // a baffling "Execution context was destroyed" — which is exactly what
  // happens when two people work on this repo at once. Stub the client out so
  // a tool run is a snapshot of the code as it was when the page loaded.
  if (!hmr) {
    await page.route('**/@vite/client', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, dispose(){}, prune(){}, invalidate(){} });\n'
        + 'export const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\n',
    }));
  }
  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack || ''}`));
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  return { page, errors, logs };
}

const reachable = async (url) => {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    // Any response at all means something is listening; a 404 is still a server.
    await fetch(url, { method: 'HEAD', signal: ac.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
};

export async function ensureServer({ port = PORT, timeoutMs = 20000 } = {}) {
  const url = `http://localhost:${port}/`;
  if (await reachable(url)) return { url, stop: async () => {} };

  // --strictPort so we fail loudly instead of silently testing a different port
  // than the one the caller asked for — the original sin of the old tools.
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  const keep = (b) => { tail.push(String(b)); if (tail.length > 40) tail.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  const stop = async () => {
    if (child.exitCode != null || child.killed) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  };
  // Never leave a stray vite behind if the tool throws.
  process.once('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`vite exited early:\n${tail.join('')}`);
    if (await reachable(url)) return { url, stop };
    await new Promise((r) => setTimeout(r, 300));
  }
  await stop();
  throw new Error(`vite did not come up on ${url} within ${timeoutMs}ms:\n${tail.join('')}`);
}

// Boot the game and return only once it is actually interactive: the boot
// overlay is gone, the title is up, and window.__game exists.
export async function gotoGame(page, { path: route = '/', waitMs = 2400 } = {}) {
  await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__game), null, { timeout: 30000 });
  // The boot sequence waits on the HDRI, so this is the real readiness signal.
  await page.waitForSelector('#title:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(waitMs);
}

// Convenience on top of gotoGame: walk the real UI path into a gate. Additive
// to the spec's export list — eight tools were each open-coding these clicks.
//
// The title's PLAY button now enters the CITY, not the gate list — that is the
// whole point of build steps 8/9, and the owner's single biggest complaint. The
// gate list survives as fast travel from the Assay Hall, and AppState is how a
// tool gets there without walking a thumbstick across a plaza. Tools that want
// to test the WALKED route should drive city.portals themselves; see
// tools/flow-test.mjs.
export async function enterGate(page, { rank = null, waitMs = 2200 } = {}) {
  await page.click('#btnPlay');
  // Give the city a moment to mount, then jump to the fast-travel list.
  await page.waitForFunction(
    () => Boolean(window.__app) || document.querySelector('#gateList .gate'),
    null, { timeout: 15000 },
  ).catch(() => {});
  if (!(await page.locator('#gateList .gate').count())) {
    await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 20000 })
      .catch(() => {});
    await page.evaluate(() => window.__app?.go('gates'));
  }
  await page.waitForSelector('#gateList .gate', { timeout: 10000 });
  const sel = rank
    ? `#gateList .gate:not(.locked):has(.rank-${rank})`
    : '#gateList .gate:not(.locked)';
  const target = page.locator(sel).first();
  if (!(await target.count())) throw new Error(`no unlocked gate matching ${sel}`);
  await target.click();
  await page.waitForTimeout(waitMs);
}

export function writeReport(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name.endsWith('.json') ? name : `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// Run a probe against window.__game. The probe is called as fn(game, args),
// where args is the array of everything passed after fn — a function cannot be
// spread across the page bridge, so the extras arrive as one array.
export async function evalGame(page, fn, ...args) {
  const handle = await page.evaluateHandle(() => {
    if (!window.__game) throw new Error('window.__game is undefined — the game has not booted');
    return window.__game;
  });
  try {
    return await handle.evaluate(fn, args);
  } finally {
    await handle.dispose();
  }
}

// Shared shot path so every tool lands in the same directory.
export function shotPath(name) {
  fs.mkdirSync(OUT, { recursive: true });
  return path.join(OUT, name);
}
