import { chromium } from 'playwright';
const OUT='/tmp/claude-0/-home-user-collins-seo-website/d52ff8fd-7e89-591c-9ed1-ace0f798cd42/scratchpad';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const page = await b.newPage({viewport:{width:412,height:892},deviceScaleFactor:2});
await page.goto('http://localhost:4178/',{waitUntil:'networkidle'});
await page.waitForTimeout(2000);
await page.screenshot({path:`${OUT}/A-title.png`});
await page.click('#btnPlay'); await page.waitForTimeout(500);
await page.screenshot({path:`${OUT}/B-gates.png`});
await page.click('#gateList .gate:not(.locked)'); await page.waitForTimeout(1500);
// Pull the fight to the player and swing.
await page.evaluate(()=>{
  const g=window.__game; g.player.invuln=0;
  g.enemies.forEach((e,i)=>{ const a=i/g.enemies.length*Math.PI*2;
    e.pos.set(Math.cos(a)*4.5, 0, Math.sin(a)*4.5 - 2); e.spawning=0; });
});
await page.waitForTimeout(700);
for(let i=0;i<4;i++){ await page.keyboard.press('j'); await page.waitForTimeout(260); }
await page.screenshot({path:`${OUT}/C-combat.png`});
await b.close();
