// Renders the launcher icons and splash screens with headless Chromium, so the
// repo carries no binary art that has to be hand-maintained. Re-run after
// changing the mark: `node tools/make-icons.mjs`
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const RES = path.resolve('android/app/src/main/res');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// The rift mark: a gate ring with a blade through it.
const mark = (size, { bleed = false } = {}) => `
<div style="width:${size}px;height:${size}px;display:grid;place-items:center;
     background:${bleed ? 'transparent' : 'radial-gradient(circle at 50% 38%,#241a4d,#05060d 72%)'};
     border-radius:${bleed ? 0 : size * 0.18}px;overflow:hidden">
  <svg width="${size * (bleed ? 0.56 : 0.74)}" height="${size * (bleed ? 0.56 : 0.74)}" viewBox="0 0 100 100">
    <defs>
      <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#9dd8ff"/>
      </linearGradient>
      <linearGradient id="r" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#a78bff"/><stop offset="100%" stop-color="#22d3ee"/>
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="33" fill="none" stroke="url(#r)" stroke-width="6"/>
    <rect x="30" y="30" width="40" height="40" fill="none" stroke="#7c5cff"
          stroke-width="3" opacity=".75" transform="rotate(45 50 50)"/>
    <g>
      <rect x="46.5" y="12" width="7" height="62" fill="url(#b)"/>
      <rect x="38" y="70" width="24" height="5.5" rx="1.5" fill="#c9d4ff"/>
      <rect x="47.5" y="75" width="5" height="13" rx="2" fill="#6b74a8"/>
      <circle cx="50" cy="10" r="4.5" fill="#ffc24b"/>
    </g>
  </svg>
</div>`;

const DENSITIES = [
  ['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432],
];

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();

// Chromium refuses viewports smaller than its minimum window size, so render
// into a roomy page and clip to the mark element instead of resizing the page.
async function shot(html, size, out) {
  const pad = Math.max(600, size + 80);
  await page.setViewportSize({ width: pad, height: pad });
  await page.setContent(
    `<body style="margin:0;background:transparent">
       <div id="mark" style="width:${size}px;height:${size}px">${html}</div>
     </body>`,
    { waitUntil: 'domcontentloaded' },
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.locator('#mark').screenshot({ path: out, omitBackground: true });
}

for (const [density, icon, adaptive] of DENSITIES) {
  const dir = path.join(RES, `mipmap-${density}`);
  await shot(mark(icon), icon, path.join(dir, 'ic_launcher.png'));
  await shot(mark(icon), icon, path.join(dir, 'ic_launcher_round.png'));
  // Adaptive foreground must sit inside the safe zone; the launcher masks it.
  await shot(mark(adaptive, { bleed: true }), adaptive, path.join(dir, 'ic_launcher_foreground.png'));
  console.log(`icons: ${density}`);
}

// Splash screens, portrait and landscape, for every density bucket.
const SPLASH = [
  ['port-mdpi', 320, 480], ['port-hdpi', 480, 800], ['port-xhdpi', 720, 1280],
  ['port-xxhdpi', 960, 1600], ['port-xxxhdpi', 1280, 1920],
  ['land-mdpi', 480, 320], ['land-hdpi', 800, 480], ['land-xhdpi', 1280, 720],
  ['land-xxhdpi', 1600, 960], ['land-xxxhdpi', 1920, 1280],
];
for (const [bucket, w, h] of SPLASH) {
  const html = `
    <div style="width:${w}px;height:${h}px;display:grid;place-items:center;
         background:radial-gradient(ellipse at 50% 42%,#1a1440 0%,#05060d 70%)">
      <div style="text-align:center;font-family:sans-serif">
        ${mark(Math.min(w, h) * 0.34, { bleed: true })}
        <div style="color:#e8ecff;letter-spacing:.24em;font-size:${Math.min(w, h) * 0.052}px;
             font-weight:800;margin-top:${Math.min(w, h) * 0.02}px">GATEBREAKER</div>
        <div style="color:#22d3ee;letter-spacing:.42em;font-size:${Math.min(w, h) * 0.026}px;
             margin-top:6px">RIFT ASCENSION</div>
      </div>
    </div>`;
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0">${html}</body>`, { waitUntil: 'domcontentloaded' });
  const dir = path.join(RES, `drawable-${bucket}`);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'splash.png') });
  console.log(`splash: ${bucket}`);
}

// Default drawable/splash.png fallback.
await page.setViewportSize({ width: 720, height: 1280 });
await page.screenshot({ path: path.join(RES, 'drawable', 'splash.png') });

await browser.close();
console.log('done');
