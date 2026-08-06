// Regression tests for the progression fixes found in the audit.
import { chromium } from 'playwright';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const page = await b.newPage({viewport:{width:892,height:412}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:4191/',{waitUntil:'networkidle'});
await page.waitForTimeout(2000);

const r = await page.evaluate(() => {
  const g = window.__game;
  g.renderer.render = () => {};
  g.fx.damageNumber = () => {};
  const toasts = [];
  const orig = g.ui.toast.bind(g.ui);
  g.ui.toast = (m,k) => { toasts.push(m); orig(m,k); };
  const out = {};

  // --- 1. multi-level toast must report the real span and real points
  g.save.level = 1; g.save.xp = 0; g.save.points = 0;
  g.refreshDerived(true);
  g.startGate(0);
  toasts.length = 0;
  const before = g.save.points;
  g.gainXp(400);                        // enough to cross several thresholds
  out.multiLevel = {
    levelsCrossed: g.save.level - 1,
    pointsGranted: g.save.points - before,
    toast: toasts.find(t => t.includes('LEVEL')) || null,
  };

  // --- 2. Nova must hit every enemy in radius (array was mutated mid-forEach)
  g.save.level = 60; g.save.stats.str = 200; g.refreshDerived(true);
  g.startGate(0);
  g.enemies.forEach(e => { g.scene.remove(e.mesh); g.scene.remove(e.bar); });
  g.enemies.length = 0;
  for (let i = 0; i < 6; i++) g._spawnEnemy();
  g.enemies.forEach((e,i) => { e.pos.set(Math.cos(i)*2, 0, Math.sin(i)*2); e.spawning = 0; e.hp = 1; });
  const nBefore = g.enemies.length;
  g.player.cds.nova = 0; g.player.mp = 999;
  g._tryNova();
  out.nova = { before: nBefore, survivors: g.enemies.length };

  // --- 3. spending VIT must not shrink the health bar
  g.save.points = 5;
  g.refreshDerived(true);
  const hpBefore = g.player.hp, maxBefore = g.derived.maxHp;
  g.save.points--; g.save.stats.vit++;
  g.refreshDerived();
  out.vit = { hpBefore, maxBefore, hpAfter: g.player.hp, maxAfter: g.derived.maxHp,
              ratioBefore: +(hpBefore/maxBefore).toFixed(3), ratioAfter: +(g.player.hp/g.derived.maxHp).toFixed(3) };

  // --- 4. summon must not write run state to the saved profile
  g.startGate(0);
  g.save.shadows = 0;
  for (let i = 0; i < 3; i++) g.corpses.push({ mesh:{position:{}}, pos: g.player.pos.clone(), life: 10 });
  g.scene.remove = g.scene.remove.bind(g.scene);
  g.save.level = 60; g.player.mp = 999; g.player.cds.summon = 0;
  g._trySummon();
  out.summonProfileWrite = { liveShadows: g.shadows.length, savedShadows: g.save.shadows };

  // --- 5. live soldiers must never exceed the retention cap
  for (let i = 0; i < 20; i++) g._spawnShadow(g.player.pos.clone(), true);
  out.shadowCap = g.shadows.length;

  return out;
});
console.log(JSON.stringify(r,null,2));
console.log('ERRORS:', errs.length?errs.join('\n'):'(none)');
await b.close();
