// Contact sheets for the Wave 2 content-pack deliverables, rendered through
// the REAL loader stack (three.js GLTFLoader + meshopt decoder + SkeletonUtils
// .clone) — not through Blender, whose workbench ignores KHR_texture_transform
// and once produced a convincing false alarm about "wrong colours" (see
// tools/build-creatures-glb.mjs, palette survival check). If a piece renders
// wrong HERE, it will render wrong in the game; if it renders right here, the
// whole decode path is proven at the same time.
//
//   GB_PORT=5210 GB_OUT=/tmp/shots node tools/asset-contact-sheet.mjs
//   node tools/asset-contact-sheet.mjs --only dungeonkit|adventurers
//
// OUTPUTS (into GB_OUT)
//   dungeonkit-sheet.png    every manifest piece, labelled grid
//   adventurers-sheet.png   each character posed mid-idle via its own
//                           <key>__idle_a clip on a SkeletonUtils.clone, plus
//                           the props row — so clip binding is exercised, not
//                           just geometry
//
// The sheet render doubles as an assert: any manifest key that does not
// resolve via getObjectByName, or any idle clip that does not bind, fails the
// run. A blank tile cannot slip through as "probably fine".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPhonePage, ensureServer, shotPath, PORT } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The page-side renderer lives in tools/contact-sheet-page.mjs and is
// imported THROUGH the vite dev server, so its bare 'three' specifiers
// resolve exactly like the game's own modules do (one shared three instance
// — import maps over blob modules do not reach this Chromium build, and
// mixing a hand-resolved three with the loader's own would be two instances).
async function renderSheet(page, opts) {
  return page.evaluate(async (opts) => {
    const mod = await import('/tools/contact-sheet-page.mjs');
    return mod.makeSheet(opts);
  }, opts);
}

function saveDataUrl(dataUrl, file) {
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}

async function main() {
  const only = (() => {
    const i = process.argv.indexOf('--only');
    return i >= 0 ? process.argv[i + 1] : null;
  })();

  const { stop } = await ensureServer();
  const browser = await launchBrowser();
  try {
    // Landscape viewport per harness rule (portrait trips the rotate gate on
    // real pages; this synthetic page keeps the convention anyway).
    const { page, errors } = await newPhonePage(browser, { width: 892, height: 412 });
    // NOT an app route: the dev server SPA-fallbacks unknown paths to
    // index.html, which starts booting the whole game and then throws when
    // setContent pulls the DOM out from under it. Landing on a static JSON
    // keeps the origin (so /tools and /models URLs resolve) with no app code.
    await page.goto(`http://localhost:${PORT}/models/particles.json`, { waitUntil: 'domcontentloaded' });
    await page.setContent('<!doctype html><html><head></head><body></body></html>');

    const out = [];
    if (!only || only === 'dungeonkit') {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/dungeonkit.json'), 'utf8'));
      const keys = manifest.pieces.map((p) => p.key);
      const res = await renderSheet(page, {
        glbUrl: '/models/dungeonkit.glb', entries: keys, tile: 150, cols: 12, poseClips: null,
      });
      if (res.missing.length) {
        throw new Error(`dungeonkit sheet: ${res.missing.length} key(s) did not resolve through ` +
          `three.js getObjectByName: ${res.missing.slice(0, 8).join(', ')}`);
      }
      const blank = Object.entries(res.litByKey).filter(([, lit]) => lit === 0).map(([k]) => k);
      if (blank.length) {
        throw new Error(`dungeonkit sheet: blank tile(s) — geometry rendered zero pixels: ` +
          `${blank.slice(0, 8).join(', ')}`);
      }
      const file = saveDataUrl(res.dataUrl, shotPath('dungeonkit-sheet.png'));
      console.log(`[sheet] dungeonkit: ${res.tiles}/${keys.length} pieces -> ${file}`);
      out.push(file);
    }

    if (!only || only === 'adventurers') {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/adventurers.json'), 'utf8'));
      const chars = Object.keys(manifest.characters);
      const props = Object.keys(manifest.props);
      const poseClips = Object.fromEntries(chars.map((k) => [k, `${k}__idle_a`]));
      const res = await renderSheet(page, {
        glbUrl: '/models/adventurers.glb', entries: [...chars, ...props], tile: 300, cols: 5, poseClips,
      });
      if (res.missing.length) {
        throw new Error(`adventurers sheet: failed to resolve: ${res.missing.join(', ')}`);
      }
      const blank = Object.entries(res.litByKey).filter(([, lit]) => lit === 0).map(([k]) => k);
      if (blank.length) {
        throw new Error(`adventurers sheet: blank tile(s) — geometry rendered zero pixels: ${blank.join(', ')}`);
      }
      const file = saveDataUrl(res.dataUrl, shotPath('adventurers-sheet.png'));
      console.log(`[sheet] adventurers: ${res.tiles} tiles (${chars.length} idle-posed characters + ` +
        `${props.length} props), ${res.clips} clips in file -> ${file}`);
      out.push(file);
    }

    if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
    return out;
  } finally {
    await browser.close();
    await stop();
  }
}

main().catch((e) => {
  console.error(`[sheet] FAILED: ${e.message}`);
  process.exit(1);
});
