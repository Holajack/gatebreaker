// Reproduces the tap-jump height bug: a press-and-release (what a phone player
// actually does) must not be cut to a fraction of a held jump.
import { chromium } from 'playwright';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const page = await b.newPage({viewport:{width:892,height:412}});
page.on('pageerror',e=>console.log('ERR',e.message));
await page.goto('http://localhost:4212/',{waitUntil:'networkidle'});
await page.waitForTimeout(3500);
await page.click('#btnPlay'); await page.waitForTimeout(300);
await page.click('#gateList .gate:not(.locked)'); await page.waitForTimeout(1500);
const r = await page.evaluate(() => {
  const g=window.__game, p=g.player, body=p.body;
  body.setEnvironment(()=>0, null);
  const apexOf = (releaseAfterFrames) => {
    body.reset(0,0,0); p.vel.set(0,0,0);
    body.jump(); body.setJumpHeld(true);
    let apex=0;
    for (let i=0;i<240;i++){
      if (i>=releaseAfterFrames) body.setJumpHeld(false);
      body.move(0,0,0); body.step(1/60);
      apex=Math.max(apex,p.pos.y);
      if (i>3 && body.grounded) break;
    }
    return +apex.toFixed(3);
  };
  return {
    heldFull:      apexOf(9999),
    releasedAt12:  apexOf(12),
    releasedAt4:   apexOf(4),
    tapReleasedAt0:apexOf(0),
  };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
