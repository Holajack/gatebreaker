// Regressions for defects found by adversarial verification of physics.js.
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
  const out={};

  // D2: a groundNormal adapter that returns undefined (the Terrain.normal
  // signature trap) must NOT poison slope detection.
  body.setEnvironment(()=>0, null, (x,z,o)=>{ o.x=NaN; o.y=NaN; o.z=NaN; return undefined; });
  body.reset(0,0,0); body._sampleX=Infinity; body.step(1/60);
  out.badNormalGuard = { nx:body.nx, ny:body.ny, nz:body.nz,
                         slopeStillDetected: Number.isFinite(body.ny) && body.ny>0 };

  // D3: a drag override must not leak into the next impulse.
  body.setEnvironment(()=>0, null);
  body.reset(0,0,0); p.vel.set(0,0,0);
  body.addImpulse(30,0,0,2);
  for(let i=0;i<400 && body.horizontalSpeed()>0.4;i++) body.step(1/60);
  body.reset(0,0,0); p.vel.set(0,0,0);
  const want = 3;
  body.addImpulse(body.impulseForDistance(want),0,0);
  for(let i=0;i<600 && body.horizontalSpeed()>0.3;i++){ body.move(0,0,0); body.step(1/60); }
  out.dragLeak = { requested:want, travelled:+p.pos.x.toFixed(2),
                   errPct:+(100*Math.abs(p.pos.x-want)/want).toFixed(1) };

  // D4: solving must be cheap enough to run per-enemy inside one Nova frame.
  body.reset(0,0,0);
  const t0=performance.now();
  for(let i=0;i<200;i++) body.impulseForDistance(2.5);
  out.solverCost = { callsPer200:+(performance.now()-t0).toFixed(2)+'ms',
                     perCallUs:+(((performance.now()-t0)/200)*1000).toFixed(1) };

  // D5: zero friction must not collapse the bisection to ~nothing.
  const prevF = body.friction; body.friction = 0;
  out.zeroFriction = { impulse:+body.impulseForDistance(5).toFixed(2) };
  body.friction = prevF;

  // D6: NaN input must not leave the body drifting forever.
  body.reset(0,0,0); p.vel.set(4,0,0);
  body.move(NaN,NaN,1);
  for(let i=0;i<180;i++){ body.move(NaN,NaN,1); body.step(1/60); }
  out.nanInput = { finalSpeed:+body.horizontalSpeed().toFixed(3), cameToRest: body.horizontalSpeed()<0.4 };
  return out;
});
console.log(JSON.stringify(r,null,2));
await b.close();
