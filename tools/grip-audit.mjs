// Grip audit: one screenshot per weapon CLASS, in hand, at idle and at the
// swing contact frame.
//
// Why a dedicated tool instead of eyeballing a play session: the owner's
// complaint ("the characters do not properly hold the swords") is a per-class
// transform problem, and a transform you cannot see from a fixed, repeatable
// camera is a transform you will re-break next wave. This equips the REAL
// player, in the real city, and parks the camera at three fixed framings —
// same pose, same light, same angle, every class, so two runs are comparable.
//
// IT DRIVES window.__weapons, NOT ITS OWN import(). A tool that imports
// /src/game/weapons.js from the page gets a SECOND module instance whose model
// source was never injected, so every pack lookup falls through to the
// procedural builder and the audit silently grades weapons the player never
// sees. That mistake cost a whole pass; main.js exposes the live module.
//
//   GB_PORT=5251 node tools/grip-audit.mjs [--stance drawn|sheathed] [--tag x]

import fs from 'node:fs';
import { launchBrowser, newPhonePage, ensureServer, gotoGame, shotPath, OUT } from './_harness.mjs';

// Player archetypes come from the WEAPONS table; NPC kinds come from
// HELD_MODELS. Both are audited because both end up in the player's eyeline.
const PLAYER_CASES = [
  ['sword-common', 'riftedge', 'common'],
  ['sword-golden', 'dawnbrand', 'legendary'],
  ['greataxe', 'sunderaxe', 'common'],
  ['maul', 'gravemaul', 'common'],
  ['daggers', 'whisperfangs', 'common'],
  ['daggers-golden', 'veinsplitters', 'epic'],
  ['spear', 'vigil', 'common'],
  ['glaive', 'voidglaive', 'common'],
];

const NPC_KINDS = ['sword', 'bigsword', 'axe', 'greataxe', 'hammer', 'dagger', 'bow'];

const args = process.argv.slice(2);
const stanceArg = args.includes('--stance') ? args[args.indexOf('--stance') + 1] : 'drawn';
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : '';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });

await gotoGame(page);
await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page.waitForTimeout(2500);

await page.evaluate(() => {
  const g = window.__game;
  const W = window.__weapons;

  // The city camera controller would fight every camera write below.
  if (g.mode) g.mode.updateCamera = () => {};
  g._updateCamera = () => {};
  // Fixed hour: a difference between two runs should be a grip change, not a
  // change in where the sun is.
  g.worldClock?.setHours?.(13.0);

  const root = g.player.mesh;
  const st = { root, phase: 0, held: [] };
  window.__grip = st;

  st.equipPlayer = (baseId, rarity) => {
    for (const h of st.held) h.parent?.remove(h);
    st.held.length = 0;
    const w = W.rollWeapon(baseId, () => 0.5, { rarity, level: 10 });
    g.equip(w);
    return w.name;
  };
  st.equipNpc = (kind) => {
    // Exactly the socket and the merged-geometry path a spawned enemy uses.
    W.unequipWeapon(root);
    for (const h of st.held) h.parent?.remove(h);
    st.held.length = 0;
    const held = W.buildHeldWeapon(kind);
    if (!held) return null;
    const socket = root.userData.rig.hand || root.userData.rig.armR;
    socket.add(held);
    st.held.push(held);
    root.userData.character?.setArmed?.(true);
    return kind;
  };
  st.stance = (s) => W.setStance(root, s);

  // Three fixed framings. `near` is the judgement shot — three-quarter front,
  // chest height, close enough that a hilt floating 5 cm out of the fist is
  // obvious; `wide` shows the whole silhouette (used for stow, and for the
  // back where a slung weapon actually lives); `hand` crops onto the fist.
  st.look = (mode) => {
    const cam = g.camera;
    const p = g.player.pos;
    if (mode === 'wide') { cam.position.set(p.x + 2.6, 1.7, p.z + 3.6); cam.lookAt(p.x, 1.05, p.z); }
    else if (mode === 'behind') { cam.position.set(p.x - 0.9, 1.75, p.z - 2.9); cam.lookAt(p.x, 1.15, p.z); }
    else if (mode === 'hand') { cam.position.set(p.x + 0.95, 1.25, p.z + 1.25); cam.lookAt(p.x - 0.15, 0.95, p.z); }
    else { cam.position.set(p.x + 1.35, 1.45, p.z + 2.0); cam.lookAt(p.x, 1.05, p.z); }
    cam.updateProjectionMatrix();
  };

  // Face the lens and hold still. yaw 0 is +Z in this game, and every framing
  // except `behind` sits on +Z.
  st.pin = () => {
    g.player.yaw = 0;
    g.player.mesh.rotation.y = 0;
    if (st.phase > 0) { g.player.swing = 0.17; g.player.comboIndex = 1; }
    else { g.player.swing = 0; }
  };
  setInterval(st.pin, 16);
});

async function shoot(name, { phase = 0, mode = 'near' } = {}) {
  await page.evaluate(([p, m]) => { window.__grip.phase = p; window.__grip.look(m); }, [phase, mode]);
  await page.waitForTimeout(450);
  await page.evaluate(([m]) => window.__grip.look(m), [mode]);
  await page.waitForTimeout(140);
  const file = shotPath(`grip-${tag ? `${tag}-` : ''}${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

const shots = [];
for (const [label, baseId, rarity] of PLAYER_CASES) {
  const nm = await page.evaluate(([b, r]) => window.__grip.equipPlayer(b, r), [baseId, rarity]);
  if (stanceArg === 'sheathed') {
    const applied = await page.evaluate(() => window.__grip.stance('sheathed'));
    shots.push({ label, weapon: nm, applied, file: await shoot(`${label}-stow`, { mode: 'wide' }) });
    shots.push({ label, weapon: nm, applied, file: await shoot(`${label}-stow-back`, { mode: 'behind' }) });
    await page.evaluate(() => window.__grip.stance('drawn'));
    continue;
  }
  shots.push({ label, weapon: nm, file: await shoot(`${label}-idle`) });
  shots.push({ label, weapon: nm, file: await shoot(`${label}-hand`, { mode: 'hand' }) });
  shots.push({ label, weapon: nm, file: await shoot(`${label}-contact`, { phase: 0.5 }) });
}

if (stanceArg !== 'sheathed') {
  for (const kind of NPC_KINDS) {
    const ok = await page.evaluate(([k]) => window.__grip.equipNpc(k), [kind]);
    if (!ok) { shots.push({ label: `npc-${kind}`, missing: true }); continue; }
    shots.push({ label: `npc-${kind}`, file: await shoot(`npc-${kind}-idle`, { mode: 'hand' }) });
    shots.push({ label: `npc-${kind}`, file: await shoot(`npc-${kind}-contact`, { phase: 0.5 }) });
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/grip-audit${tag ? `-${tag}` : ''}.json`,
  JSON.stringify({ stance: stanceArg, shots, errors }, null, 2));
console.log(`${shots.length} shots -> ${OUT}`);
if (errors.length) console.log(`PAGE ERRORS:\n${errors.join('\n')}`);

await browser.close();
await server.stop();
