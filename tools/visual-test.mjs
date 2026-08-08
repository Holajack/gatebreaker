// tools/visual-test.mjs — the "does it look like a game or a light show?" tool.
//
//   node tools/visual-test.mjs --label before
//   ...edit src/render/*.js...
//   node tools/visual-test.mjs --label after
//   node tools/visual-test.mjs --compare before after
//
// WHY THIS EXISTS
// The owner's complaint about the shipped build was not a bug, it was a look:
// "can we make them normal character-looking instead of glowing different
// things". An independent review put numbers on the same thing — a thick
// blown-out ground ring per character that merges into a mass of light with
// eight of them on screen, and bloom that is stronger on the effects than on
// the characters carrying them.
//
// You cannot regression-test that with a draw-call budget. What you CAN do is
// pin the scene so it is byte-for-byte reproducible, shoot it from the real
// gameplay camera, and measure the mean luminance of the pixels that ARE a
// character against the mean luminance of the pixels that are the effect
// underneath it. If the ring band is brighter than the torso, the effect is
// winning and the render is a light show. That ratio is the assertion.
//
// DETERMINISM
// The game is paused and every character is teleported onto a fixed arc before
// the shot, so "before" and "after" are the same scene down to the pose. Left
// running, a wave AI would put the enemies somewhere different every run and
// the two images would not be comparable — which is the trap that makes most
// visual "tests" worthless.
//
// Requires the harness's LANDSCAPE viewport (index.html's rotate gate eats
// pointer events in portrait), so it uses newPhonePage's default 892x412.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, evalGame, OUT, forceOpenGates,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const LABEL = arg('label', 'shot');
const HEADED = argv.includes('--headed');
// SwiftShader by default: the whole point is that two runs on two days produce
// comparable pixels. The GPU path is available for eyeballing.
const GPU = argv.includes('--gpu');
const COMPARE = argv.indexOf('--compare');

// A fixed arc of characters in front of the player, at the distances the
// gameplay camera actually shows them at. Eight enemies plus the player plus
// the deployed shadows is the "8+ characters" case the review described.
const ENEMY_COUNT = 8;

const dir = () => { fs.mkdirSync(OUT, { recursive: true }); return OUT; };
const shot = (label) => path.join(dir(), `visual-${label}.png`);
const report = (label) => path.join(dir(), `visual-${label}.json`);

// ---------------------------------------------------------------- metrics

// Rec.709 luma on the sRGB values that actually land on the phone's screen.
// Deliberately NOT linearised: the complaint is about perceived brightness.
function lumaStats(raw, w, h, channels, boxes) {
  let sum = 0; let n = 0; let hot = 0;
  for (const b of boxes) {
    const x0 = Math.max(0, Math.round(b.x0)); const x1 = Math.min(w, Math.round(b.x1));
    const y0 = Math.max(0, Math.round(b.y0)); const y1 = Math.min(h, Math.round(b.y1));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * channels;
        const l = (0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2]) / 255;
        sum += l; n++;
        if (l > 0.75) hot++;
      }
    }
  }
  return n ? { mean: +(sum / n).toFixed(4), hotFraction: +(hot / n).toFixed(4), pixels: n } : null;
}

async function measure(pngPath, regions) {
  const img = sharp(pngPath);
  const { width, height, channels } = await img.metadata();
  const raw = await img.raw().toBuffer();
  const frame = [{ x0: 0, y0: 0, x1: width, y1: height }];
  return {
    size: { width, height },
    character: lumaStats(raw, width, height, channels, regions.character),
    ring: lumaStats(raw, width, height, channels, regions.ring),
    frame: lumaStats(raw, width, height, channels, frame),
  };
}

// ---------------------------------------------------------------- compare

if (COMPARE >= 0) {
  const [a, b] = [argv[COMPARE + 1], argv[COMPARE + 2]];
  const ra = JSON.parse(fs.readFileSync(report(a), 'utf8'));
  const rb = JSON.parse(fs.readFileSync(report(b), 'utf8'));
  const row = (k, f) => `  ${k.padEnd(22)} ${String(f(ra)).padStart(9)} -> ${String(f(rb)).padStart(9)}`;
  console.log(`\n${a}  ->  ${b}\n`);
  console.log(row('character mean luma', (r) => r.metrics.character.mean));
  console.log(row('character hot frac', (r) => r.metrics.character.hotFraction));
  console.log(row('ring mean luma', (r) => r.metrics.ring.mean));
  console.log(row('ring hot frac', (r) => r.metrics.ring.hotFraction));
  console.log(row('frame mean luma', (r) => r.metrics.frame.mean));
  console.log(row('frame hot frac', (r) => r.metrics.frame.hotFraction));
  console.log(row('ring / character', (r) => (r.metrics.ring.mean / r.metrics.character.mean).toFixed(3)));
  console.log(`\nimages:\n  ${shot(a)}\n  ${shot(b)}\n`);
  process.exit(0);
}

// ------------------------------------------------------------------- run

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: !GPU });
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });

try {
  // Game.startGate seeds the arena with `Math.random()`, so two runs get two
  // different rock fields and two different lighting moods and the "before"
  // and "after" frames are not comparable. Replacing Math.random before any
  // module evaluates makes the WHOLE boot reproducible — world seed, enemy
  // archetype rolls, particle jitter, everything.
  await page.addInitScript(() => {
    let s = 0x9e3779b9;
    Math.random = () => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });

  await gotoGame(page, { waitMs: 1600 });
  // Arena-behaviour tool: pin the flat arena for E/D via the sanctioned
  // forceOpen dev override (see _harness.forceOpenGates).
  await forceOpenGates(page);

  // Deliberately NOT the harness's enterGate(): that clicks through #gateList,
  // and the city hub landing mid-task moved Play from "pick a gate" to "walk to
  // a portal". Game.enterGate(rank) is the public API in EXPANSION_SPEC and it
  // does not care which screen you came from, so this tool keeps working while
  // the shell around it is still being built.
  await evalGame(page, (game) => game.enterGate('E'));
  await page.waitForTimeout(2800);

  // Pin the scene. Everything below runs inside the page against window.__game.
  const regions = await evalGame(page, (game, [count]) => {
    const THREE = game.scene.constructor === Object ? null : null; // unused; kept explicit
    void THREE;

    // 1. enough bodies on screen. _spawnEnemy is the real spawn path, so the
    //    materials, rings and bars are exactly the ones the game ships.
    let guard = 0;
    while (game.enemies.length < count && guard++ < 40) game._spawnEnemy();
    // Shadow soldiers are the one humanoid allowed to keep a rim, so the frame
    // has to contain some or the shot cannot show whether "restrained" landed.
    for (let i = 0; i < 3 && game._spawnShadow; i++) {
      game._spawnShadow(new game.player.pos.constructor(0, 0, 0), true, null);
    }

    // 2. freeze the simulation. `paused` keeps Game.update rendering (the glow
    //    composite is at the bottom of update, outside the state check) while
    //    skipping every _update* that would move anything.
    game.state = 'paused';
    game.fx.shake = 0;
    game._updateCamera = () => {};
    // THE PLAYER BLINKS. game.js:1072 toggles player.mesh.visible at 22 Hz for
    // the 1.2 s of spawn invulnerability. Pausing freezes that toggle wherever
    // it happened to be, so roughly half of all runs shot a frame with NO
    // PLAYER IN IT — and the missing player reads exactly like a rendering
    // regression, which cost an hour of bisecting render code that was fine.
    // Clear the invulnerability and force the mesh back on.
    game.player.invuln = 0;
    game.player.mesh.visible = true;

    // 3. deterministic arc in front of the player, at gameplay distances.
    const all = [];
    game.player.pos.set(0, 0, 0);
    game.player.mesh.position.set(0, 0, 0);
    game.player.mesh.rotation.set(0, 0, 0);
    game.player.mesh.updateMatrixWorld(true);
    all.push({ mesh: game.player.mesh, h: 2.0, ring: 1.0, kind: 'player' });

    const place = (list, kind, radius0) => {
      list.forEach((e, i) => {
        const a = -Math.PI / 2 + (i - (list.length - 1) / 2) * 0.30;
        const r = radius0 + (i % 3) * 1.6;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        e.spawning = 0;
        e.hurt = 0; e.stagger = 0; e.telegraph = 0; e.swing = 0;
        e.hp = e.maxHp * (0.35 + 0.65 * ((i % 4) / 3));
        e.pos.set(x, 0, z);
        e.vel.set(0, 0, 0);
        e.yaw = Math.PI;
        e.mesh.position.set(x, 0, z);
        e.mesh.rotation.set(0, Math.PI, 0);
        e.mesh.updateMatrixWorld(true);
        if (e.bar) {
          e.bar.position.set(x, 2.4 * (e.base?.scale || 1), z);
          e.bar.ratio = e.hp / e.maxHp;
          e.bar.updateMatrixWorld(true);
        }
        const scale = e.base?.scale || 1;
        all.push({ mesh: e.mesh, h: 2.0 * scale, ring: 0.85 * scale, kind });
      });
    };
    place(game.enemies, 'enemy', 5.5);
    place(game.shadows, 'shadow', 9.0);

    // 4. gameplay camera, pinned exactly where _updateCamera would put it.
    game.camLook.set(0, 0, -3.4);
    game.camPos.copy(game.camLook).add(game.camOffset);
    game.camera.position.copy(game.camPos);
    game.camera.lookAt(game.camLook.x, game.camLook.y + 1.2, game.camLook.z);
    game.camera.updateMatrixWorld(true);

    // 5. kill any in-flight particles so the shot is the STEADY state, not a
    //    spawn burst. Otherwise "after" would be measuring confetti.
    for (const p of game.fx.parts) p.life = 0;
    for (const r of game.fx.rings) r.t = r.duration + 1;

    // 6. project the two regions the argument is about, in device pixels.
    const cam = game.camera;
    const W = window.innerWidth; const H = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const v = new game.player.pos.constructor();
    const toPx = (x, y, z) => {
      v.set(x, y, z).project(cam);
      return { x: (v.x * 0.5 + 0.5) * W * dpr, y: (-v.y * 0.5 + 0.5) * H * dpr };
    };

    const character = []; const ring = [];
    for (const c of all) {
      const p = c.mesh.position;
      const feet = toPx(p.x, 0.36, p.z);
      const headP = toPx(p.x, c.h, p.z);
      const pxH = Math.abs(feet.y - headP.y);
      if (pxH < 12) continue;
      // TORSO+HEAD: the band a player actually reads a character by. Stops
      // above the knees so it never samples the ring it is standing in.
      const halfW = pxH * 0.26;
      character.push({
        x0: feet.x - halfW, x1: feet.x + halfW,
        y0: headP.y + pxH * 0.05, y1: headP.y + pxH * 0.62,
      });
      // RING BAND: the left and right lobes of the ground ring, which are the
      // only places ring pixels are not overlapped by the body above them.
      const edge = toPx(p.x + c.ring, 0.36, p.z);
      const rPx = Math.abs(edge.x - feet.x);
      const band = Math.max(3, rPx * 0.34);
      for (const s of [-1, 1]) {
        ring.push({
          x0: feet.x + s * rPx - band, x1: feet.x + s * rPx + band,
          y0: feet.y - band * 0.7, y1: feet.y + band * 0.7,
        });
      }
    }
    // 7. the one thing a screenshot cannot prove: WHICH materials carry a rim.
    //    rim.js writes userData.rim, so walk the real meshes and count.
    const rimAudit = { livingRimmed: 0, livingPlain: 0, shadowRimmed: 0, shadowPlain: 0 };
    const auditOne = (mesh, isShadow) => mesh.traverse((o) => {
      if (!o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m.isMeshStandardMaterial) continue;
        // material.rimUniforms, NOT userData.rim: characters.js overwrites
        // userData wholesale right after applyRim returns, so the userData copy
        // reports "no rim" on exactly the materials that have one.
        const rimmed = Boolean(m.rimUniforms);
        if (isShadow) rimAudit[rimmed ? 'shadowRimmed' : 'shadowPlain']++;
        else rimAudit[rimmed ? 'livingRimmed' : 'livingPlain']++;
      }
    });
    auditOne(game.player.mesh, false);
    for (const e of game.enemies) auditOne(e.mesh, false);
    for (const s of game.shadows) auditOne(s.mesh, true);

    return {
      character,
      ring,
      rimAudit,
      counts: { enemies: game.enemies.length, shadows: game.shadows.length, sampled: all.length },
    };
  }, ENEMY_COUNT);

  // Let a few frames land with the pinned camera and dead particles.
  await page.waitForTimeout(900);
  await page.screenshot({ path: shot(LABEL) });

  const metrics = await measure(shot(LABEL), regions);
  const out = {
    label: LABEL, counts: regions.counts, rimAudit: regions.rimAudit, metrics, errors,
  };
  fs.writeFileSync(report(LABEL), JSON.stringify(out, null, 2));

  const a = regions.rimAudit;
  console.log(`\n  rim policy           : living rimmed=${a.livingRimmed} plain=${a.livingPlain}`
    + `  |  shadow rimmed=${a.shadowRimmed} plain=${a.shadowPlain}`);
  console.log(`                         ${a.livingRimmed === 0 ? 'OK' : 'FAIL'}`
    + ' — no living character may carry a rim');

  console.log(`\n  characters on screen : ${regions.counts.sampled} `
    + `(${regions.counts.enemies} enemies, ${regions.counts.shadows} shadows, 1 player)`);
  console.log(`  character mean luma  : ${metrics.character.mean}   hot>0.75: ${metrics.character.hotFraction}`);
  console.log(`  ring band mean luma  : ${metrics.ring.mean}   hot>0.75: ${metrics.ring.hotFraction}`);
  console.log(`  whole frame          : ${metrics.frame.mean}   hot>0.75: ${metrics.frame.hotFraction}`);
  console.log(`  ring / character     : ${(metrics.ring.mean / metrics.character.mean).toFixed(3)}`
    + '   (>1 means the effect is brighter than the thing it belongs to)');
  if (errors.length) console.log(`\n  PAGE ERRORS:\n${errors.join('\n')}`);
  console.log(`\n  image  : ${shot(LABEL)}`);
  console.log(`  report : ${report(LABEL)}\n`);
} finally {
  await browser.close();
  await server.stop();
}
