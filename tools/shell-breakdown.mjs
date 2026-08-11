// One-off: enumerate what actually draws inside a LIVE E gate's world.group,
// to reconcile tools/dungeon-test.mjs's standalone shell delta (E 15 draws /
// 65,931 tris) with the live-gate delta measured by tools/wave3a2-verify.mjs
// (E 26 / 129,592). Prints every drawable under the mounted world, plus what
// the two renderers count.
import { ensureServer, launchBrowser, newPhonePage, gotoGame, evalGame } from './_harness.mjs';

const srv = await ensureServer();
const browser = await launchBrowser();
const { page } = await newPhonePage(browser);
await gotoGame(page);

const IDX = Number(process.env.GB_GATE || 0);
const out = await evalGame(page, async (g, [index]) => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  const real = Math.random;
  Math.random = () => 0.42;
  g.startGate(index);
  Math.random = real;
  await frames(20);
  g.mode._introSkip = true;
  await frames(40);

  const tri = (o) => {
    const geo = o.geometry;
    if (!geo) return 0;
    const n = geo.index ? geo.index.count : (geo.attributes?.position?.count || 0);
    const per = Math.floor(n / 3);
    return o.isInstancedMesh ? per * o.count : per;
  };
  const rows = [];
  g.world.group.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    let vis = true;
    for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
    rows.push({
      name: o.name || o.type,
      inst: o.isInstancedMesh ? o.count : 1,
      tris: tri(o),
      castShadow: !!o.castShadow,
      culled: !!o.frustumCulled,
      visible: vis,
    });
  });
  rows.sort((a, b) => b.tris - a.tris);

  // What the two paths count for the world group alone.
  const meas = (fn) => {
    g.renderer.info.autoReset = false;
    g.renderer.info.reset();
    fn();
    const i = g.renderer.info.render;
    const r = { calls: i.calls, tris: i.triangles };
    g.renderer.info.autoReset = true;
    return r;
  };
  const hide = [];
  for (const e of [...g.enemies, ...g.shadows, ...g.corpses, ...g.pickups, ...g.projectiles]) {
    if (e.mesh?.visible) { e.mesh.visible = false; hide.push(e.mesh); }
    if (e.bar?.visible) { e.bar.visible = false; hide.push(e.bar); }
  }
  if (g.player.mesh.visible) { g.player.mesh.visible = false; hide.push(g.player.mesh); }
  const withWorld1 = meas(() => g.renderer.render(g.scene, g.camera));
  g.world.group.visible = false;
  const without1 = meas(() => g.renderer.render(g.scene, g.camera));
  g.world.group.visible = true;
  // COVER A/B on the live frame. dungeon-test measures cover's cost on a
  // standalone build whose shadow pass never runs; here the two new KitFields
  // are simply hidden in a frame that DOES render the depth map, so the delta
  // includes the second draw each of them pays for.
  const coverFields = [];
  g.world.group.traverse((o) => {
    if (o.isMesh && (o.name === 'dress_coverRubble' || o.name === 'dress_coverStub')) coverFields.push(o);
  });
  for (const o of coverFields) o.visible = false;
  const noCover1 = meas(() => g.renderer.render(g.scene, g.camera));
  for (const o of coverFields) o.visible = true;
  for (const m of hide) m.visible = true;

  return {
    shadowsEnabled: g.renderer.shadowMap.enabled,
    tier: g.quality.current.name,
    rows,
    totalDrawables: rows.length,
    visibleDrawables: rows.filter((r) => r.visible).length,
    sumTris: rows.filter((r) => r.visible).reduce((s, r) => s + r.tris, 0),
    castShadowDrawables: rows.filter((r) => r.visible && r.castShadow).length,
    withWorld1,
    without1,
    delta1: { calls: withWorld1.calls - without1.calls, tris: withWorld1.tris - without1.tris },
    coverCost: { calls: withWorld1.calls - noCover1.calls, tris: withWorld1.tris - noCover1.tris },
  };
}, IDX);

console.log(`tier=${out.tier} shadowMap.enabled=${out.shadowsEnabled}`);
console.log(`drawables under world.group: ${out.visibleDrawables} visible of ${out.totalDrawables}, `
  + `${out.castShadowDrawables} of them castShadow, geometry sum ${out.sumTris} tris`);
console.log(`single renderer.render delta: ${out.delta1.calls} draws / ${out.delta1.tris} tris`);
console.log(`cover costs, live frame (shadow pass included): ${out.coverCost.calls} draws / ${out.coverCost.tris} tris`);
console.log('\n  tris   inst  cast  cull  name');
for (const r of out.rows) {
  if (!r.visible) continue;
  console.log(`${String(r.tris).padStart(7)} ${String(r.inst).padStart(6)} `
    + `${r.castShadow ? ' yes' : '  no'} ${r.culled ? ' yes' : '  no'}  ${r.name}`);
}

await browser.close();
await srv.stop();
