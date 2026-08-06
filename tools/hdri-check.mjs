import { chromium } from 'playwright';
const OUT='/tmp/claude-0/-home-user-collins-seo-website/d52ff8fd-7e89-591c-9ed1-ace0f798cd42/scratchpad';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const page = await b.newPage({viewport:{width:892,height:412},deviceScaleFactor:2});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
const net=[]; page.on('response',r=>{ if(r.url().includes('.hdr')) net.push(`${r.status()} ${r.url().split('/').pop()}`); });
await page.goto('http://localhost:4200/',{waitUntil:'networkidle'});
await page.waitForTimeout(3500);
await page.click('#btnPlay'); await page.waitForTimeout(400);
await page.click('#gateList .gate:not(.locked)'); await page.waitForTimeout(2000);
const info = await page.evaluate(()=>{
  const g=window.__game;
  return {
    envSet: !!g.scene.environment,
    envIntensity: g.scene.environmentIntensity,
    envMapSize: g.scene.environment ? `${g.scene.environment.image?.width||'?'}x${g.scene.environment.image?.height||'?'}` : null,
    tier: g.quality?.current?.name,
    exposure: g.renderer.toneMappingExposure,
  };
});
console.log('hdr requests:', net.join(', ') || '(none)');
console.log(JSON.stringify(info,null,2));
console.log('ERRORS:', errs.length?errs.join('\n'):'(none)');
await page.evaluate(()=>{ const g=window.__game; g.player.invuln=0;
  g.enemies.forEach((e,i)=>{const a=i/g.enemies.length*Math.PI*2; e.pos.set(Math.cos(a)*5,0,Math.sin(a)*5-2); e.spawning=0;}); });
await page.waitForTimeout(700);
await page.keyboard.press('j'); await page.waitForTimeout(300);
await page.screenshot({path:`${OUT}/HDRI-lit.png`});
await b.close();
