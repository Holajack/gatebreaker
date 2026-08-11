// Numeric companion to grip-audit.mjs: where IS the fist, and where does the
// weapon actually end up?
//
// The screenshots say "the hilt is not in the hand"; this says by how much and
// in which direction, in character-local metres, in the pose the character
// actually stands in. Guessing a grip from a screenshot costs a full browser
// round trip per guess; measuring the frame costs one.
//
// Everything is reported in CHARACTER space (root yaw 0, so +Z is forward,
// +Y is up, +X is the character's left as seen from the front).

import fs from 'node:fs';
import { launchBrowser, newPhonePage, ensureServer, gotoGame, OUT } from './_harness.mjs';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });

await gotoGame(page);
await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page.waitForTimeout(2500);

const report = await page.evaluate(async ([which]) => {
  const W = await import('/src/game/weapons.js');
  const E = await import('/src/game/entities.js');
  const g = window.__game;

  const root = E.makeHumanoid({ archetype: 'player', weapon: 'none', characters: true });
  root.position.set(0, 0, 0);
  root.rotation.y = 0;
  g.scene.add(root);

  const w = W.rollWeapon(which, () => 0.5, { rarity: 'common', level: 1 });
  W.equipWeapon(root, w);
  // Settle into the armed idle — the pose the player spends most of the game
  // in, and the one the shipped grips were NOT authored against.
  for (let i = 0; i < 120; i++) E.animateRig(root, { moving: false, speed: 0, t: i / 60, dt: 1 / 60 });
  root.updateMatrixWorld(true);

  const V = root.position.constructor;
  const Q = root.quaternion.constructor;
  const inv = root.matrixWorld.clone().invert();
  const r3 = (v) => ({ x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) });
  const at = (o) => r3(o.getWorldPosition(new V()).applyMatrix4(inv));
  const ax = (o, x, y, z) => r3(new V(x, y, z).applyQuaternion(o.getWorldQuaternion(new Q())));

  const inst = root.userData.character;
  const out = { weapon: which, bonePrefix: inst?.rig?.bonePrefix ?? '(procedural)', bones: {}, sockets: {}, held: {} };

  const want = ['Wrist_R', 'Wrist_L', 'Chest', 'Torso', 'Abdomen', 'Hips', 'Head'];
  root.traverse((o) => {
    if (!o.isBone || !want.some((n) => o.name.endsWith(n))) return;
    out.bones[o.name] = { pos: at(o), up: ax(o, 0, 1, 0), right: ax(o, 1, 0, 0), fwd: ax(o, 0, 0, 1) };
  });

  for (const [k, s] of Object.entries(inst?.sockets || {})) {
    out.sockets[k] = { pos: at(s), up: ax(s, 0, 1, 0), fwd: ax(s, 0, 0, 1), scale: +s.scale.x.toFixed(4) };
  }

  const bounds = (obj) => {
    const lo = new V(Infinity, Infinity, Infinity);
    const hi = new V(-Infinity, -Infinity, -Infinity);
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      for (const xx of [bb.min.x, bb.max.x]) {
        for (const yy of [bb.min.y, bb.max.y]) {
          for (const zz of [bb.min.z, bb.max.z]) {
            const v = new V(xx, yy, zz).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
            lo.min(v); hi.max(v);
          }
        }
      }
    });
    return Number.isFinite(lo.x) ? { min: r3(lo), max: r3(hi) } : null;
  };

  const held = root.userData.weapon;
  if (held?.main) {
    out.held.main = {
      origin: at(held.main),
      bladeDir: ax(held.main, 0, 1, 0),
      bounds: bounds(held.main),
      parent: held.main.parent?.name || '(none)',
    };
    if (held.offhand) out.held.offhand = { origin: at(held.offhand), bladeDir: ax(held.offhand, 0, 1, 0), bounds: bounds(held.offhand) };
  }
  return out;
}, [process.argv[2] || 'riftedge']);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/grip-probe-${report.weapon}.json`, JSON.stringify({ report, errors }, null, 2));
console.log(JSON.stringify(report, null, 2));
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));

await browser.close();
await server.stop();
