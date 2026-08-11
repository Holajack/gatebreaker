// HOW MUCH OF THE ROOM CAN YOU ACTUALLY SEE, and is anything hiding under your
// own thumb?
//
// WHY this exists: the crawl rooms grew ~5.5x this wave and the camera did not,
// and the failure mode is silent — the frame still looks fine in a screenshot
// because what is missing is off it. So this measures the ground the camera
// reaches in the four directions from the player, in metres, and compares the
// near reach against ONE DASH. If a single dodge can put an enemy behind the
// bottom edge, the framing is wrong however pretty the shot is.
//
// It also projects every live enemy to screen space and asks whether it lands
// under the skill cluster, which is the other way an enemy goes invisible.
//
//   GB_PORT=5173 node tools/camera-frame.mjs

import fs from 'node:fs';
import { launchBrowser, newPhonePage, ensureServer, gotoGame, OUT, shotPath } from './_harness.mjs';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });

await gotoGame(page);
await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page.waitForTimeout(1500);

// Straight into an E crawl through the fast-travel list the harness knows.
await page.evaluate(() => window.__app?.go('gates'));
await page.waitForSelector('#gateList .gate', { timeout: 10000 });
await page.locator('#gateList .gate:not(.locked)').first().click();
await page.waitForTimeout(4000);

const report = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.__game;

  // Stand in the middle of a real combat room with a live wave up: an empty
  // entry room measures the framing but not the thing the framing is FOR.
  const dir = g.mode?.director;
  const L = g.world?.layout;
  if (dir && L) {
    const room = L.rooms.find((r) => dir.roomStates?.[r.id] === 0 && r.role !== 'entry')
      || L.rooms.find((r) => r.role !== 'entry');
    if (room) {
      g.player.body.reset(room.centre.x, 0, room.centre.z);
      g.player.pos.set(room.centre.x, 0, room.centre.z);
      g.player.invuln = 999;
      for (let i = 0; i < 200; i++) g.update(1 / 60);   // trigger + grace + spawn
    }
  }
  // Settle: the follow rig lerps, and a half-lerped camera measures nothing.
  for (let i = 0; i < 400; i++) g.update?.(1 / 60);
  g.camera.updateMatrixWorld(true);

  // Where a ray through a normalised screen point meets the floor plane.
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const reach = (nx, ny) => {
    ray.setFromCamera(new THREE.Vector2(nx, ny), g.camera);
    return ray.ray.intersectPlane(plane, hit) ? hit.clone() : null;
  };

  const p = g.player.pos;
  // Camera-relative ground axes, so a dragged orbit reports the same shape.
  const fwd = new THREE.Vector3();
  g.camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

  const along = (v, axis) => (v ? +v.clone().sub(p).dot(axis).toFixed(2) : null);
  const out = {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    fov: g.camera.fov,
    camOffset: { y: +g.camOffset.y.toFixed(2), z: +g.camOffset.z.toFixed(2) },
    mode: g.mode?.name || null,
    room: g.world?.layout ? 'crawl' : 'arena',
    reach: {
      forward: along(reach(0, 1), fwd),
      nearToCamera: along(reach(0, -1), fwd),
      left: along(reach(-1, 0), right),
      right: along(reach(1, 0), right),
    },
  };
  // One dash, from the same constants the dodge uses, so the comparison is not
  // a guess about "a dodge".
  out.dashDistance = +(g.player?.dashDist ?? g.DASH_DIST ?? 6.16).toFixed(2);

  // The thumb test: enemy screen positions against the skill cluster's rect.
  const cluster = document.querySelector('.skill-row')?.parentElement
    || document.querySelector('.hud-bottom');
  const r = cluster?.getBoundingClientRect();
  out.skillCluster = r ? {
    x: Math.round(r.left), y: Math.round(r.top),
    w: Math.round(r.width), h: Math.round(r.height),
    pctW: +((r.width / window.innerWidth) * 100).toFixed(1),
    pctH: +((r.height / window.innerHeight) * 100).toFixed(1),
  } : null;

  const v = new THREE.Vector3();
  out.enemies = (g.enemies || []).map((e) => {
    v.set(e.pos.x, 1.0, e.pos.z).project(g.camera);
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const onScreen = v.z < 1 && sx >= 0 && sx <= window.innerWidth && sy >= 0 && sy <= window.innerHeight;
    const underThumb = Boolean(r) && sx >= r.left && sx <= r.right && sy >= r.top && sy <= r.bottom;
    return { x: Math.round(sx), y: Math.round(sy), onScreen, underThumb };
  });
  out.enemyCount = out.enemies.length;
  out.offScreen = out.enemies.filter((e) => !e.onScreen).length;
  out.underThumb = out.enemies.filter((e) => e.underThumb).length;
  return out;
});

fs.mkdirSync(OUT, { recursive: true });
await page.screenshot({ path: shotPath('camera-frame.png') });
fs.writeFileSync(`${OUT}/camera-frame.json`, JSON.stringify({ report, errors }, null, 2));
console.log(JSON.stringify(report, null, 2));
if (errors.length) console.log(`PAGE ERRORS:\n${errors.join('\n')}`);

await browser.close();
await server.stop();
