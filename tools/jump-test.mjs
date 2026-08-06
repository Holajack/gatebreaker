import { chromium } from 'playwright';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const page = await b.newPage({viewport:{width:892,height:412}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:4212/',{waitUntil:'networkidle'});
await page.waitForTimeout(3500);
await page.click('#btnPlay'); await page.waitForTimeout(400);
await page.click('#gateList .gate:not(.locked)'); await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const g = window.__game;
  g.renderer.render = () => {}; g.fx.damageNumber = () => {};
  const out = {};
  const p = g.player, body = p.body;

  // --- jump arc: apex height and airtime
  p.pos.set(0,0,0); body.reset(0,0,0);
  body.jump();
  let apex = 0, air = 0, steps = 0;
  for (let i=0;i<400;i++){ g.input.move.x=0; g.input.move.y=0; body.move(0,0,0); body.step(1/60);
    apex = Math.max(apex, p.pos.y); if (!body.grounded) air += 1/60; steps++;
    if (i>3 && body.grounded) break; }
  out.jump = { apexHeight:+apex.toFixed(2), airtimeSec:+air.toFixed(2), landed: body.grounded };

  // --- coyote time: walking off a ledge must leave a brief grace window.
  // Start grounded, then drop the floor away, exactly like stepping off an edge.
  body.setEnvironment(() => 0, null);
  body.reset(0,0,0); p.vel.set(0,0,0);
  body.move(1,0,1); body.step(1/60);
  body.setEnvironment(() => -50, null);      // floor vanishes
  body.step(1/60);
  const coyoteJustAfter = body.canJump;
  for (let i=0;i<30;i++) body.step(1/60);    // half a second later
  out.coyote = { grantedOnLeavingGround: coyoteJustAfter, expiredHalfSecondLater: !body.canJump };

  // --- knockback survives (the old clamp deleted it)
  body.reset(0,0,0); p.vel.set(0,0,0);
  const v0 = body.impulseForDistance(3);
  body.addImpulse(v0,0,0);
  const speedRightAfter = body.horizontalSpeed();
  body.step(1/60);
  out.knockback = { impulseSpeed:+v0.toFixed(1), afterOneStep:+body.horizontalSpeed().toFixed(1),
                    survived: body.horizontalSpeed() > body.maxSpeed };

  // --- walking accelerates to, and never exceeds, maxSpeed.
  // Measured in open space with no collision: running into the arena wall for
  // five seconds measures the wall, not the controller.
  body.setEnvironment(() => 0, null);
  body.reset(0,0,0); p.vel.set(0,0,0);
  for (let i=0;i<10;i++){ body.move(1,0,1); body.step(1/60); }
  const after10 = body.horizontalSpeed();
  for (let i=0;i<200;i++){ body.move(1,0,1); body.step(1/60); }
  out.walk = { maxSpeed: body.maxSpeed, afterTenFrames:+after10.toFixed(2),
               settled:+body.horizontalSpeed().toFixed(2),
               neverExceeds: body.horizontalSpeed() <= body.maxSpeed + 1e-3 };
  body.setEnvironment(() => 0, g._arenaResolve);

  // --- combat still works after the movement rewrite
  g.startGate(0);
  g.enemies.forEach((e,i)=>{ e.pos.set(Math.cos(i)*2.2,0,Math.sin(i)*2.2); e.spawning=0; });
  const before = g.enemies.length;
  g.player.cds.attack = 0; g.player.pos.set(0,0,0);
  g._tryAttack(); for(let i=0;i<24;i++) g.update(1/60);
  out.combat = { enemies: before, anyDamaged: g.enemies.some(e=>e.hp<e.maxHp) };
  return out;
});
console.log(JSON.stringify(r,null,2));
console.log('ERRORS:', errs.length?errs.join('\n'):'(none)');
await b.close();
