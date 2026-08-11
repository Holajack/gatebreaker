// WHY: the grip has now been "fixed" twice off screenshots and was still wrong.
// A crop tells you the pommel is on the knuckles; it does not tell you by how
// many metres, so each pass guessed a new number and re-shot. This measures the
// two things the guess needs — where the FIST actually is (posed skin vertices,
// not the wrist bone) and where the model's HANDLE actually is (geometry, not
// the pivot) — and prints the correction that makes them coincide.
//
// Two errors are reported separately because they have different fixes and
// fixing one while the other is wrong is exactly how this survived two passes:
//   ALONG the shaft  -> PACK_FIT.lift  (handle in the fist, or blade in it?)
//   PERPENDICULAR    -> grip.y / grip.z (shaft through the fist, or beside it?)
//
// It drives window.__weapons and g.player.mesh for the same reason grip-audit
// does: the live module has the item pack injected and the live player is the
// only rig actually running its animation mixer. A freshly made humanoid is in
// bind pose with an open hand, and measuring that is measuring nothing.
//
//   GB_PORT=5173 node tools/grip-measure.mjs

import fs from 'node:fs';
import { launchBrowser, newPhonePage, ensureServer, gotoGame, OUT } from './_harness.mjs';

const CASES = [
  ['sword', 'riftedge'],
  ['daggers', 'whisperfangs'],
  ['greataxe', 'sunderaxe'],
  ['maul', 'gravemaul'],
  ['spear', 'vigil'],
  ['glaive', 'voidglaive'],
];

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412, dpr: 2 });

await gotoGame(page);
await page.click('#btnPlay');
await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
await page.waitForTimeout(2500);

const report = await page.evaluate(async ([cases]) => {
  const W = window.__weapons;
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.__game;
  const root = g.player.mesh;

  // The fist is the wrist island PLUS every phalanx: these rigs carry a full
  // finger chain, so the wrist weights alone are the back of the hand and put
  // the "fist" a finger-length short of where the player sees it close.
  const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb'];
  function fistCentre(side) {
    let skinned = null;
    root.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
    if (!skinned) return null;
    const want = new Set();
    skinned.skeleton.bones.forEach((b, i) => {
      if (b.name.endsWith(`Wrist_${side}`)) want.add(i);
      if (FINGERS.some((f) => new RegExp(`${f}\\d_${side}$`).test(b.name))) want.add(i);
    });
    if (!want.size) return null;
    const pos = skinned.geometry.attributes.position;
    const si = skinned.geometry.attributes.skinIndex;
    const sw = skinned.geometry.attributes.skinWeight;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const sum = new THREE.Vector3();
    const v = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (want.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
      if (w < 0.5) continue;
      v.fromBufferAttribute(pos, i);
      skinned.applyBoneTransform(i, v);
      v.applyMatrix4(skinned.matrixWorld);
      lo.min(v); hi.max(v); sum.add(v); n++;
    }
    if (!n) return null;
    return { centre: sum.multiplyScalar(1 / n), lo, hi, count: n };
  }

  // Second, independent target for the same point, because the skin centroid is
  // only as honest as the weights: a hand whose fingers are relaxed rather than
  // curled drags its centroid out toward the fingertips. The bones do not lie —
  // a gripped handle passes through the palm, i.e. the centroid of the wrist and
  // the four knuckles. If the two targets agree, the number is real.
  const KNUCKLES = ['Wrist_R', 'Index1_R', 'Middle1_R', 'Ring1_R', 'Pinky1_R', 'Thumb2_R'];
  function palmCentre() {
    const sum = new THREE.Vector3();
    let n = 0;
    root.traverse((o) => {
      if (!o.isBone || !KNUCKLES.some((k) => o.name.endsWith(k))) return;
      sum.add(o.getWorldPosition(new THREE.Vector3())); n++;
    });
    return n ? sum.multiplyScalar(1 / n) : null;
  }

  const r3 = (v) => ({ x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) });
  const out = { fit: JSON.parse(JSON.stringify(W.PACK_FIT)), weapons: {} };

  for (const [label, baseId] of cases) {
    const w = W.rollWeapon(baseId, () => 0.5, { rarity: 'common', level: 10 });
    g.equip(w);
    // One frame so the mixer re-poses the rig around the new weapon.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    root.updateMatrixWorld(true);

    const held = root.userData.weapon;
    const outer = held?.main;
    const rec = { label, weapon: baseId, archetype: w.archetype, pack: outer?.userData?.packModel || '(procedural)' };
    const fist = fistCentre('R');
    if (outer && fist) {
      // Everything in the OUTER group's own frame: its +Y is the shaft, and
      // `lift` is expressed in exactly these units, so no projection maths can
      // silently pick up the rig's scale factor.
      outer.updateWorldMatrix(true, true);
      const toLocal = outer.matrixWorld.clone().invert();
      const fistLocal = fist.centre.clone().applyMatrix4(toLocal);
      const fistT = fistLocal.y;
      rec.perpMiss = +Math.hypot(fistLocal.x, fistLocal.z).toFixed(4);
      rec.perpMissXZ = [+fistLocal.x.toFixed(4), +fistLocal.z.toFixed(4)];
      rec.fistAlongShaft = +fistT.toFixed(4);
      rec.fistHalfSpan = +(fist.lo.distanceTo(fist.hi) / 2).toFixed(4);

      let glo = Infinity; let ghi = -Infinity;
      outer.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const m = toLocal.clone().multiply(o.matrixWorld);
        for (const xx of [bb.min.x, bb.max.x]) for (const yy of [bb.min.y, bb.max.y]) for (const zz of [bb.min.z, bb.max.z]) {
          const t = new THREE.Vector3(xx, yy, zz).applyMatrix4(m).y;
          glo = Math.min(glo, t); ghi = Math.max(ghi, t);
        }
      });
      rec.weaponSpan = [+glo.toFixed(4), +ghi.toFixed(4)];
      rec.pommelToFist = +(fistT - glo).toFixed(4);

      // Pack models pivot at the guard, so in outer-local the guard sits at the
      // current lift and the handle runs from the pommel up to it. The lift that
      // lands the fist mid-handle follows directly. A procedural weapon has no
      // lift — its origin is already authored mid-grip — so it reports null and
      // its only lever is the grip offsets.
      const packKey = outer.userData.packModel
        ? (w.archetype === 'daggers' ? 'daggers' : w.archetype)
        : null;
      const curLift = packKey ? (W.PACK_FIT[packKey] || W.PACK_FIT.sword).lift : null;
      if (curLift != null) {
        rec.currentLift = curLift;
        rec.handleSpan = [+glo.toFixed(4), +curLift.toFixed(4)];
        rec.suggestedLift = +(curLift + (fistT - (glo + curLift) / 2)).toFixed(3);
      }
      rec.fistWorld = r3(fist.centre);
      rec.fistInWeaponFrame = r3(fistLocal);
      rec.fistVerts = fist.count;
      const palm = palmCentre();
      if (palm) {
        const pl = palm.clone().applyMatrix4(toLocal);
        rec.palmInWeaponFrame = r3(pl);
        rec.palmPerpMiss = +Math.hypot(pl.x, pl.z).toFixed(4);
        if (curLift != null) rec.suggestedLiftFromPalm = +(curLift + (pl.y - (glo + curLift) / 2)).toFixed(3);
      }
    }
    out.weapons[label] = rec;
  }
  // Same measurement for the NPC/enemy kinds. They come out of HELD_MODELS
  // rather than PACK_FIT and were built from the same wrong assumption, so a
  // pass that fixes only the player's four archetypes leaves every armed enemy
  // holding air.
  const held = [];
  for (const kind of ['sword', 'bigsword', 'axe', 'greataxe', 'hammer', 'dagger', 'bow']) {
    W.unequipWeapon(root);
    for (const h of held) h.parent?.remove(h);
    held.length = 0;
    const obj = W.buildHeldWeapon(kind);
    if (!obj) { out.weapons[`npc:${kind}`] = { label: `npc:${kind}`, pack: '(no model)' }; continue; }
    const socket = root.userData.rig.hand || root.userData.rig.armR;
    socket.add(obj);
    held.push(obj);
    root.userData.character?.setArmed?.(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    root.updateMatrixWorld(true);

    obj.updateWorldMatrix(true, true);
    const toLocal = obj.matrixWorld.clone().invert();
    const fist = fistCentre('R');
    const fistLocal = fist.centre.clone().applyMatrix4(toLocal);
    let glo = Infinity; let ghi = -Infinity;
    obj.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      const m = toLocal.clone().multiply(o.matrixWorld);
      for (const xx of [bb.min.x, bb.max.x]) for (const yy of [bb.min.y, bb.max.y]) for (const zz of [bb.min.z, bb.max.z]) {
        const t = new THREE.Vector3(xx, yy, zz).applyMatrix4(m).y;
        glo = Math.min(glo, t); ghi = Math.max(ghi, t);
      }
    });
    const cur = W.HELD_MODELS?.[kind]?.lift;
    out.weapons[`npc:${kind}`] = {
      label: `npc:${kind}`, pack: obj.userData.packModel,
      perpMiss: +Math.hypot(fistLocal.x, fistLocal.z).toFixed(4),
      fistAlongShaft: +fistLocal.y.toFixed(4),
      weaponSpan: [+glo.toFixed(4), +ghi.toFixed(4)],
      currentLift: cur ?? null,
      // handleBelowPivot is the number the lift rule needs and the only one that
      // cannot be read off the table: how far the handle hangs under the guard
      // once scale is applied.
      handleBelowPivot: cur == null ? null : +(glo - cur).toFixed(4),
      suggestedLift: cur == null ? null : +(fistLocal.y - (glo - cur) / 2).toFixed(3),
    };
  }
  W.unequipWeapon(root);
  for (const h of held) h.parent?.remove(h);
  return out;
}, [CASES]);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/grip-measure.json`, JSON.stringify({ report, errors }, null, 2));
for (const r of Object.values(report.weapons)) {
  console.log(
    `${r.label.padEnd(9)} ${String(r.pack).padEnd(14)} perpMiss ${r.perpMiss}`
    + `  fistAlongShaft ${r.fistAlongShaft}  handle ${JSON.stringify(r.handleSpan ?? null)}`
    + `  lift ${r.currentLift ?? '-'} -> ${r.suggestedLift ?? '-'}`,
  );
}
if (errors.length) console.log(`PAGE ERRORS:\n${errors.join('\n')}`);

await browser.close();
await server.stop();
