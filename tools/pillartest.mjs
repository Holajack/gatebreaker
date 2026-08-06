import { chromium } from 'playwright';
import * as THREEMOD from 'three';
const browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const page = await browser.newPage({viewport:{width:412,height:892}});
page.on('pageerror',e=>console.log('PAGEERROR',e.message));
await page.goto('http://localhost:4178/',{waitUntil:'networkidle'});
await page.waitForTimeout(2000);
const r = await page.evaluate(()=>{
  const g = window.__game;
  g.renderer.render=()=>{}; g.fx.damageNumber=()=>{};
  g.startGate(0);
  g.enemies.forEach(e=>{g.scene.remove(e.mesh);g.scene.remove(e.bar);}); g.enemies.length=0;

  const out = {};
  // Deterministic: one pillar at the origin, player pushing straight at it.
  const V = g.player.pos.constructor;
  for (const [label, offsetX] of [['head-on', 0], ['slightly-off', 0.25]]) {
    g.world.obstacles.length = 0;
    g.world.obstacles.push({ pos: new V(0,0,0), radius: 2 });
    g.player.pos.set(offsetX, 0, 4);
    g.player.vel.set(0,0,0);
    g.input.move.x = 0;
    g.input.move.y = 1;      // push toward -z, i.e. straight at the pillar
    const start = g.player.pos.clone();
    const trail = [];
    for (let i=0;i<60*6;i++){ g.update(1/60); if(i%60===0) trail.push([+g.player.pos.x.toFixed(2),+g.player.pos.z.toFixed(2)]); }
    out[label] = {
      moved: +g.player.pos.distanceTo(start).toFixed(2),
      distToCentre: +Math.hypot(g.player.pos.x,g.player.pos.z).toFixed(2),
      trail,
    };
  }
  return out;
});
console.log(JSON.stringify(r,null,2));
await browser.close();
