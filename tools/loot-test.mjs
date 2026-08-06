// Build-order step 14 gate: prove the item pack is actually IN THE GAME, not
// merely on disk.
//
//   node tools/loot-test.mjs [--no-models]
//
//   --no-models  boot with public/models/ hidden and assert the game still
//                works on the procedural fallback. An offline game must not
//                hard-fail on a missing asset.
//
// The interesting assertion is the last one: after a real kill and a real
// pickup, the object parented to the player's right hand has to be a node out
// of items.glb (userData.packModel) at a sane world size — not a procedural
// stand-in, and not a 2.3-metre sword on a 1.8-metre hunter.

import {
  OUT, launchBrowser, newPhonePage, ensureServer, gotoGame, enterGate,
  evalGame, writeReport, shotPath,
} from './_harness.mjs';

const NO_MODELS = process.argv.slice(2).includes('--no-models');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return Boolean(ok);
};

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);
let fatal = null;

try {
  if (NO_MODELS) {
    // Simulate a build where the converted pack never shipped. Blocking the
    // request is closer to the real failure (404 from the APK) than deleting
    // the file, and it cannot damage the working tree.
    await page.route('**/models/**', (route) => route.fulfill({ status: 404, body: '' }));
  }

  await gotoGame(page);

  const stats = await page.evaluate(() => window.__items?.stats?.() || null);
  if (NO_MODELS) {
    check('boots with models/ missing', true, JSON.stringify(stats));
    check('item pack correctly reports NOT loaded', stats && stats.loaded === false, JSON.stringify(stats));
  } else {
    check('item pack loaded during the splash', Boolean(stats?.loaded), JSON.stringify(stats));
    check('all 106 roots resolved at runtime', stats?.roots === 106, `roots = ${stats?.roots}`);
  }

  await enterGate(page, { rank: 'E' });

  // ---- kill something, then force a drop where the player is standing ----
  const killed = await evalGame(page, (g) => {
    let n = 0;
    for (const e of g.enemies.slice(0, 3)) { g._killEnemy(e); n++; }
    return { killed: n, pickups: g.pickups.length };
  });
  check('killing enemies runs the drop path', killed.killed > 0, JSON.stringify(killed));

  const dropped = await evalGame(page, (g) => {
    const before = g.pickups.length;
    // Land it on the player so the existing magnet/collect code does the work
    // rather than the test reaching past it.
    g._spawnWeaponDrop(g.player.pos.clone());
    const drop = g.pickups[g.pickups.length - 1];
    return {
      added: g.pickups.length - before,
      kind: drop?.kind,
      name: drop?.weapon?.name,
      rarity: drop?.weapon?.rarity,
      // What the floor mesh is: a pack node, or the procedural fallback.
      packModel: drop?.mesh?.children?.[0]?.userData?.packModel || null,
    };
  });
  check('rollDrop produced a weapon pickup', dropped.added === 1 && dropped.kind === 'weapon',
    JSON.stringify(dropped));

  const equipped = await evalGame(page, (g) => {
    const before = g.weapon?.name;
    // Advance the real update loop so _updatePickups collects it.
    for (let i = 0; i < 90; i++) g.update(1 / 60);
    const held = g.player.mesh.userData.weapon;
    const main = held?.main;
    return {
      before,
      after: g.weapon?.name,
      rarity: g.weapon?.rarity,
      score: g.weapon?.score,
      stash: g.stash.length,
      remainingPickups: g.pickups.filter((p) => p.kind === 'weapon').length,
      packModel: main?.userData?.packModel || null,
      parent: main?.parent?.type || null,
      // The pose node is the outer group; the pack scale lives one level down.
      scale: main?.children?.[0]?.scale?.x ?? main?.scale?.x ?? null,
      saveWeapon: g.save.weapon,
      saveStash: (g.save.stash || []).length,
    };
  });

  check('the drop was collected', equipped.remainingPickups === 0,
    `${equipped.remainingPickups} weapon pickup(s) left`);
  check('something is in the hand', Boolean(equipped.parent), JSON.stringify({
    weapon: equipped.after, rarity: equipped.rarity, parent: equipped.parent,
  }));

  if (NO_MODELS) {
    check('procedural fallback is used when the GLB is absent', equipped.packModel === null,
      `packModel = ${equipped.packModel}`);
  } else {
    check('the held weapon is a REAL pack model', Boolean(equipped.packModel),
      `packModel = ${equipped.packModel}, scale = ${equipped.scale}`);
  }

  check('save.weapon persists the equipped weapon', Boolean(equipped.saveWeapon),
    JSON.stringify(equipped.saveWeapon));
  check('save.stash persists spares', equipped.saveStash === equipped.stash,
    `${equipped.saveStash} stored / ${equipped.stash} live`);

  // ---- measured size of what is actually in the hand ----
  // gltfpack quantises positions into Uint16 with a tiny compensating node
  // scale, so a naive Box3().setFromObject() on the raw attributes is
  // meaningless — the world matrix has to be applied per vertex.
  const measured = await evalGame(page, (g) => {
    const main = g.player.mesh.userData.weapon?.main;
    if (!main) return null;
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    main.updateWorldMatrix(true, true);
    main.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.attributes.position;
      o.updateWorldMatrix(true, false);
      const m = o.matrixWorld.elements;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
      }
    });
    return { worldHeight: maxY - minY, worldWidth: maxX - minX, topY: maxY };
  });
  check('weapon is a plausible size next to a ~1.8m hunter',
    measured && measured.worldHeight > 0.3 && measured.worldHeight < 2.2,
    measured ? `${measured.worldHeight.toFixed(2)}m tall, top at y=${measured.topY.toFixed(2)}` : 'no mesh');

  // The pack's FBX materials carry opacity 0. That survived Blender, survived
  // the glTF export, and produced a MeshStandardMaterial whose alphaMode is
  // OPAQUE and whose opacity is 0 — geometry present, world bounds correct,
  // nothing drawn. It cost hours; it is now asserted so it cannot come back.
  const opacity = await evalGame(page, (g) => {
    const main = g.player.mesh.userData.weapon?.main;
    let worst = 1;
    main?.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.opacity < worst) worst = m.opacity;
    });
    return worst;
  });
  check('weapon materials are not invisibly transparent', opacity >= 1, `min opacity = ${opacity}`);

  // The icon atlas ships alongside the GLB and is loaded in the same boot step.
  const icons = await page.evaluate(async () => {
    const mod = await import('/src/ui/icons.js');
    await mod.loadIconIndex();
    return {
      sword: mod.hasIcon('Sword'),
      // Case-only mismatches: these are the model spellings, not the icon ones.
      axeSmall: mod.hasIcon('Axe_small'),
      fishbone: mod.hasIcon('FishBone'),
      unknown: mod.hasIcon('NotAThing'),
      style: mod.iconStyle('Sword', 48),
    };
  });
  if (NO_MODELS) {
    check('unknown icons degrade to a placeholder, not a crash',
      icons.style.includes('background-color'), icons.style.slice(0, 60));
  } else {
    check('icon atlas resolves case-insensitively',
      icons.sword && icons.axeSmall && icons.fishbone && !icons.unknown, JSON.stringify(icons.style.slice(0, 60)));
  }

  // ---- screenshot: freeze the loop and frame the rig by hand ----
  // _updateCamera lerps toward its own target every frame, so the clock has to
  // stop before the camera can be posed; otherwise the next rAF snaps it back
  // to the gameplay framing and the hunter is off-screen.
  const framed = await page.evaluate(() => {
    const g = window.__game;
    for (const e of g.enemies.slice()) g._killEnemy(e);
    for (const p of g.pickups.slice()) { p.life = 0; }
    for (let i = 0; i < 30; i++) g.update(1 / 60);
    window.__clock.stop();

    // Roll until a sword comes up so the reference shot is always the same
    // silhouette — a dagger and a greataxe are not comparable frame to frame.
    let sword = null;
    for (let i = 0; i < 300 && !sword; i++) {
      g._spawnWeaponDrop(g.player.pos.clone());
      const drop = g.pickups.pop();
      g.scene.remove(drop.mesh);
      if (drop.weapon.archetype === 'sword') sword = drop.weapon;
    }
    if (sword) g.equip(sword);

    const main = g.player.mesh.userData.weapon.main;
    main.updateWorldMatrix(true, true);
    const e = main.matrixWorld.elements;
    const hand = { x: e[12], y: e[13], z: e[14] };
    g.camera.near = 0.1;
    g.camera.updateProjectionMatrix();
    // Turn the hunter to face the camera. The blade runs up +Y out of the fist
    // and the sword grip leans it along the character's forward axis, so from
    // behind the whole blade hides inside their own arm.
    g.player.mesh.rotation.y = Math.PI;
    g.player.mesh.updateWorldMatrix(true, true);
    main.updateWorldMatrix(true, true);
    const h2 = main.matrixWorld.elements;
    hand.x = h2[12]; hand.y = h2[13]; hand.z = h2[14];
    g.camera.position.set(hand.x - 2.1, hand.y + 1.5, hand.z + 3.6);
    g.camera.lookAt(hand.x + 0.3, hand.y + 0.55, hand.z);
    g.camera.updateMatrixWorld(true);
    g.glow.render(g.scene, g.camera);
    return { shown: g.weapon.name, model: main.userData.packModel, hand };
  });
  console.log(`framed: ${JSON.stringify(framed)}`);
  await page.waitForTimeout(300);
  const shot = shotPath(NO_MODELS ? 'loot-fallback.png' : 'loot-equipped.png');
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);

  check('zero page errors', errors.length === 0, errors.slice(0, 2).join('\n'));
} catch (e) {
  fatal = e;
  console.error(e);
} finally {
  await browser.close();
  await server.stop();
}

const failed = checks.filter((c) => !c.ok);
writeReport(NO_MODELS ? 'loot-fallback.json' : 'loot-result.json', { checks, fatal: fatal?.message || null });
console.log(`shots + report: ${OUT}`);
if (fatal || failed.length) {
  console.log(`LOOT TEST FAILED — ${failed.length} check(s)`);
  process.exit(1);
}
console.log(`LOOT TEST PASSED — ${checks.length} checks`);

