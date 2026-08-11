// FIGHT-FEEL VERIFICATION — does the thing that is supposed to hit you, hit you?
//
//   GB_PORT=5173 node tools/fight-test.mjs
//
// WHY THIS FILE EXISTS. The boss's spread shot could not damage the player at
// any range, in either rank, in either phase — and shipped that way, because
// none of the other 25 suites measures whether an ENEMY ATTACK LANDS. They
// measure geometry, budgets, determinism, leaks and flow. The bug was pure
// arithmetic: _spawnProjectile flattens the direction, so a bolt keeps its
// birth height forever; the boss was born at y 2.4; the player hit test is a
// 1.1 m sphere centred at y 1.2; 2.4 - 1.2 = 1.20 > 1.1, a 10 cm miss on every
// bolt of every volley. Measured before the fix: 10/10 trials at 4-14 m,
// closest approach exactly 1.20 m, damage 0, while 6-9 bolts flew each time.
//
// So this suite asserts the four things that make a ranged attack real:
//   1. every bolt flies on the ONE plane config.js PROJECTILE_Y defines,
//   2. the FAN IS A FAN — every bolt's bearing is the boss->player aim plus its
//      own intended step, so the pattern threatens an arc rather than a line,
//   3. a volley aimed at a stationary player DAMAGES that player, boss and
//      trash alike, in both ranks and both boss phases,
//   4. and cover STOPS it — a caster whose line is blocked at the bolt plane
//      by a boss-chamber rubble pile deals zero, which is the claim the whole
//      interior-cover system rests on.
//
// CHECK 2 EXISTS BECAUSE CHECK 3 COULD NOT SEE PAST IT. game.js used ONE
// module-level scratch Vector3 for both the enemy loop's aim vector and
// _spawnProjectile's heading, so each bolt's angle was computed off the PREVIOUS
// bolt's heading: offsets from the true aim ran
// [-0.60,-0.96,-1.08,-0.96,-0.60,0.00] rad instead of a symmetric +/-0.60, and
// the last term landed back on the aim purely by accident. 8 of 9 bolts died on
// walls, one hit, and a damage-only check reads that as a pass. Bearings are
// therefore measured directly off each projectile's own `dir` on the frame it is
// born, and compared against the arithmetic the pattern claims.
//
// AND DAMAGE IS MEASURED AT THE SOURCE, NOT AS AN HP DELTA. The probe is built
// at vit 90, which config.js:352 turns into hpRegen = 0.6 + 90*0.05 = 5.1 HP/s —
// 10.2 HP over the 2 s a 120-frame trial runs, against a bolt that deals 10.8.
// `hp0 - hp` therefore reported 0,2,3,4,5 across 4-14 m off the IDENTICAL single
// hit, purely because a closer boss lands earlier and leaves more frames of
// regen behind it. That check cannot tell "the attack landed" from "the attack
// landed late enough to outrun regeneration", which is the only discrimination
// it was added to provide. _damagePlayer is wrapped instead, so every trial
// reports how many separate blows connected and how much HP they actually took
// off — regeneration, i-frames and the death floor cannot forge either number.
//
// Everything runs on the sim, not the clock: the renderer is stubbed out and
// g.update(1/60) is stepped by hand, so the numbers are frame-exact and the
// suite does not race a compositor.

import { ensureServer, launchBrowser, newPhonePage, gotoGame, evalGame, writeReport } from './_harness.mjs';

const fails = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(name);
}

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser);

try {
  await gotoGame(page);
  const boltPlane = await page.evaluate(async () => {
    const cfg = await import('/src/game/config.js');
    return cfg.PROJECTILE_Y;
  });

  const report = { boltPlane, ranks: {} };

  for (const [rank, index] of [['E', 0], ['D', 1]]) {
    const res = await evalGame(page, async (g, [gateIndex, planeY]) => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      // A levelled hunter, so a volley cannot simply one-shot the probe and
      // so the DR/floor terms are exercised rather than skipped.
      g.save.level = 40;
      g.save.stats = { str: 60, vit: 90, agi: 20, int: 20, per: 20 };
      g.refreshDerived?.(true);
      g.quality.lock?.('high');
      // Pinned Math.random for the gate roll only — the layout and the pack
      // deal come out identical every run.
      const realRandom = Math.random;
      Math.random = () => 0.42;
      g.startGate(gateIndex);
      Math.random = realRandom;
      for (let i = 0; i < 20; i++) await frame();
      g.mode._introSkip = true;
      for (let i = 0; i < 20; i++) await frame();
      // From here the sim is stepped by hand.
      g.renderer.render = () => {};
      g.fx.damageNumber = () => {};

      // --- damage, measured where it is applied ------------------------------
      // See the header: hp deltas measure regeneration as much as they measure
      // damage. This counts the blows themselves. The delta is read around the
      // real call so i-frames (an early return) and the hp<=0 floor are both
      // reflected honestly, and `hits` is the quantity the asserts use — one
      // aimed bolt out of nine is a fan that does not work, and only a count can
      // say so.
      let hits = 0;
      let hpLost = 0;
      const realDamagePlayer = g._damagePlayer.bind(g);
      g._damagePlayer = (amount, from) => {
        const before = g.player.hp;
        realDamagePlayer(amount, from);
        const d = before - g.player.hp;
        if (d > 0) { hits++; hpLost += d; }
      };
      const resetDamage = () => { hits = 0; hpLost = 0; };
      // Signed angle difference folded into (-PI, PI]. Bearings are compared,
      // not raw atan2 values, so a fan straddling +/-PI does not read as garbage.
      const angDiff = (a, b) => {
        let d = a - b;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d <= -Math.PI) d += Math.PI * 2;
        return d;
      };

      const L = g.world.layout;
      const bossRoom = L.rooms[L.bossRoom];
      const field = g.world.obstacleField;
      const V = g.player.pos.constructor;
      const out = { rank: g.gate?.rank, bossVolleys: [], caster: {} };

      // Fast-forward to the boss: stand in the chamber, clear whatever the
      // director sends, tick until the boss is up.
      g.player.pos.set(bossRoom.centre.x, 0, bossRoom.centre.z);
      g.player.body?.reset?.(bossRoom.centre.x, 0, bossRoom.centre.z);
      let guard = 0;
      while (!g.bossActive && guard++ < 8000) {
        for (const e of [...g.enemies]) if (!e.isBoss) g._killEnemy(e);
        g.player.hp = g.derived.maxHp;
        g.update(1 / 60);
      }
      const boss = g.enemies.find((e) => e.isBoss);
      if (!boss) return { error: `no boss after ${guard} steps` };
      out.stepsToBoss = guard;
      // Let the rise/entrance beat finish. The boss does not run patterns while
      // it is standing up, and the first volley measured mid-rise fires nothing
      // — which would look exactly like the bug this suite exists to catch.
      for (let i = 0; i < 180; i++) {
        g.player.hp = g.derived.maxHp;
        g.player.invuln = 1;
        g.update(1 / 60);
      }
      // --- BOSS CHAMBER DENSITY, measured before anything is suppressed -----
      // config.js sizes the pack (bossAdds) and encounters.js times it. The
      // first pass shipped a 1444 m2 chamber whose peak was boss + 4 = 289 m2
      // per body — the sparsest room in the dungeon, in the one room the ask
      // named — and did not reach even that cap until ~24 s in. This measures
      // what the chamber actually holds and how fast it fills.
      {
        const cap = g.gate.bossAdds?.live ?? 0;
        let peak = 0;
        let stepsToCap = -1;
        for (let i = 0; i < 60 * 40; i++) {     // 40 s of sim
          g.player.hp = g.derived.maxHp;        // the probe is not the subject
          g.player.invuln = 1;
          g.update(1 / 60);
          let live = 0;
          for (const e of g.enemies) if (!e.isBoss) live++;
          if (live > peak) peak = live;
          if (stepsToCap < 0 && live >= cap) stepsToCap = i + 1;
        }
        out.bossChamber = {
          liveCap: cap,
          total: g.gate.bossAdds?.total ?? 0,
          peakLive: peak,
          secondsToCap: stepsToCap < 0 ? -1 : +(stepsToCap / 60).toFixed(1),
          roomM2: +(bossRoom.w * bossRoom.d).toFixed(0),
          // Floor per body at peak, counting the boss. The comparison number is
          // an ordinary room of this rank: area / waveSize.
          m2PerBodyAtPeak: +((bossRoom.w * bossRoom.d) / (peak + 1)).toFixed(0),
        };
      }

      // The director is the only other source of bodies in a sealed chamber;
      // silence it so the ONLY thing that can damage the probe is the attack
      // under test.
      g.mode.director.update = () => {};
      for (const e of [...g.enemies]) if (!e.isBoss) g._killEnemy(e);

      // --- boss spread shot, open floor, straight down the room -------------
      const volley = (dist, enraged) => {
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);
        for (const e of [...g.enemies]) if (!e.isBoss) g._killEnemy(e);
        const cx = bossRoom.centre.x;
        const cz = bossRoom.centre.z;
        const px = cx; const pz = cz - dist / 2;
        const bx = cx; const bz = cz + dist / 2;
        g.player.pos.set(px, 0, pz);
        g.player.body?.reset?.(px, 0, pz);
        boss.pos.set(bx, 0, bz);
        boss.body?.reset?.(bx, 0, bz);
        boss.enraged = enraged;
        boss.telegraph = 0;
        boss.stagger = 0;
        boss.attackCd = 9e9;      // melee off: this is the ranged pattern's test
        boss.patternCd = 0;
        g.player.hp = g.derived.maxHp;
        resetDamage();
        // 0.4 lands _bossBrain's pattern roll on 1 — the spread shot — every
        // time, so this measures the pattern rather than the dice.
        const r0 = Math.random;
        Math.random = () => 0.4;
        // The true aim: boss -> player, in game.js's own atan2(x, z) convention.
        const aimTrue = Math.atan2(px - bx, pz - bz);
        // Every bolt is recorded ONCE, the frame it appears, by identity rather
        // than by a length delta — a delta cannot tell a spawn from a removal on
        // a frame that does both, and it cannot report a heading at all.
        const seen = new WeakSet();
        const offsets = [];
        let bolts = 0;
        let closest = 99;
        let boltY = null;
        // Per-bolt closest approach, so a fan that lands one lucky bolt and
        // throws the rest sideways is visible in the report as well as in the
        // asserts.
        const nearest = new Map();
        for (let i = 0; i < 120; i++) {
          g.player.invuln = 0;                 // no i-frames to hide behind
          g.player.pos.set(px, 0, pz);
          boss.pos.set(bx, 0, bz);
          boss.vel.set(0, 0, 0);
          boss.hp = boss.maxHp;                // never crosses the enrage line
          boss.telegraph = 0;
          boss.stagger = 0;
          g.update(1 / 60);
          for (const p of g.projectiles) {
            if (!seen.has(p)) {
              seen.add(p);
              bolts++;
              offsets.push(+angDiff(Math.atan2(p.dir.x, p.dir.z), aimTrue).toFixed(3));
              nearest.set(p, 99);
            }
            boltY = +p.pos.y.toFixed(3);
            const dd = Math.hypot(p.pos.x - px, p.pos.y - 1.2, p.pos.z - pz);
            if (dd < closest) closest = dd;
            if (dd < nearest.get(p)) nearest.set(p, dd);
          }
          if (i === 20) boss.patternCd = 9e9;  // exactly one volley
        }
        Math.random = r0;
        return {
          rangeM: dist,
          enraged,
          bolts,
          boltFlightY: boltY,
          // Sorted so the report reads as the fan's shape rather than as spawn
          // order; the assert re-sorts the intended sequence the same way.
          boltOffsetsRad: offsets.slice().sort((a, b) => a - b),
          closestApproachM: +closest.toFixed(2),
          perBoltClosestM: [...nearest.values()].map((v) => +v.toFixed(2)).sort((a, b) => a - b),
          hits,
          damageTaken: Math.round(hpLost),
        };
      };
      for (const d of [4, 6, 8, 10, 14]) {
        out.bossVolleys.push(volley(d, false));
        out.bossVolleys.push(volley(d, true));
      }

      // --- trash caster: open floor, then behind a rubble pile --------------
      boss.pos.set(bossRoom.centre.x, -500, bossRoom.centre.z);   // park it
      const casterTrial = (px, pz, ex, ez) => {
        for (const e of [...g.enemies]) if (!e.isBoss) g._killEnemy(e);
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);
        g._spawnEnemy(new V(ex, 0, ez), 'caster');
        const e = g.enemies.find((q) => !q.isBoss);
        if (!e) return { error: 'no caster' };
        g.player.hp = g.derived.maxHp;
        resetDamage();
        let bolts = 0;
        let boltY = null;
        for (let i = 0; i < 600; i++) {        // 10 s of standing still
          g.player.invuln = 0;
          g.player.pos.set(px, 0, pz);
          g.player.body?.reset?.(px, 0, pz);
          e.pos.set(ex, 0, ez);
          e.vel.set(0, 0, 0);
          e.hp = e.maxHp;
          e.body?.reset?.(ex, 0, ez);
          const before = g.projectiles.length;
          g.update(1 / 60);
          bolts += Math.max(0, g.projectiles.length - before);
          for (const p of g.projectiles) boltY = +p.pos.y.toFixed(3);
        }
        const row = {
          dist: +Math.hypot(ex - px, ez - pz).toFixed(1),
          boltsFired: bolts,
          boltFlightY: boltY,
          hits,
          damageTaken: Math.round(hpLost),
          losBlockedAtPlane: field.lineBlocked(ex, ez, px, pz, { feetY: planeY }),
        };
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
        return row;
      };

      // A bolt fired by hand along a chosen line. The caster AI refuses to
      // shoot through cover (that is _agentLosBlocked doing its job), so
      // "cover stops bolts" cannot be proven with a caster alone — this puts a
      // live projectile on the line and reports whether it survives the trip.
      const manualBolt = (px, pz, ex, ez) => {
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);
        for (const e of [...g.enemies]) if (!e.isBoss) g._killEnemy(e);
        g.player.pos.set(px, 0, pz);
        g.player.body?.reset?.(px, 0, pz);
        g.player.hp = g.derived.maxHp;
        g.player.invuln = 0;
        resetDamage();
        g._spawnProjectile(new V(ex, 0, ez), new V(px, 1.2, pz), 25, 0xffffff, 14);
        let alive = 0;
        for (let i = 0; i < 90; i++) {
          g.player.invuln = 0;
          g.player.pos.set(px, 0, pz);
          g.update(1 / 60);
          if (g.projectiles.length) alive = i + 1;
        }
        return {
          dist: +Math.hypot(ex - px, ez - pz).toFixed(1),
          hits,
          damageTaken: Math.round(hpLost),
          framesAlive: alive,
        };
      };

      // Open pair: two points either side of the chamber centre with a clear
      // line at the bolt plane.
      let open = null;
      for (let t = 0; t < 720 && !open; t++) {
        const a = (t / 720) * Math.PI * 2;
        const cx = bossRoom.centre.x;
        const cz = bossRoom.centre.z;
        const px = cx + Math.cos(a) * 4.2;
        const pz = cz + Math.sin(a) * 4.2;
        const ex = cx - Math.cos(a) * 4.2;
        const ez = cz - Math.sin(a) * 4.2;
        if (field.lineBlocked(ex, ez, px, pz, { feetY: planeY })) continue;
        if (field.blocked(px, pz, 0.45, 0, 0.2) || field.blocked(ex, ez, 0.45, 0, 0.2)) continue;
        open = { px, pz, ex, ez };
      }
      if (open) {
        out.caster.open = casterTrial(open.px, open.pz, open.ex, open.ez);
        out.boltOpen = manualBolt(open.px, open.pz, open.ex, open.ez);
      }

      // Covered pair: straddle a real rubble pile in the boss chamber, so the
      // ONLY difference from the open trial is the piece in between.
      const pile = (L.decor?.cover || []).find((c) => c.room === bossRoom.id && c.kind === 'rubble');
      if (pile) {
        for (const s of [4.2, 5.0, 6.0]) {
          for (const axis of [[1, 0], [0, 1]]) {
            const px = pile.x - axis[0] * s;
            const pz = pile.z - axis[1] * s;
            const ex = pile.x + axis[0] * s;
            const ez = pile.z + axis[1] * s;
            if (!field.lineBlocked(ex, ez, px, pz, { feetY: planeY })) continue;
            if (field.blocked(px, pz, 0.45, 0, 0.2) || field.blocked(ex, ez, 0.45, 0, 0.2)) continue;
            out.caster.covered = casterTrial(px, pz, ex, ez);
            out.caster.covered.pieceTop = 1.75;
            out.boltCovered = manualBolt(px, pz, ex, ez);
            break;
          }
          if (out.caster.covered) break;
        }
      }
      return out;
    }, index, boltPlane);

    report.ranks[rank] = res;
    if (res.error) {
      check(`${rank}: reached the boss`, false, res.error);
      continue;
    }

    const room = res.bossChamber;
    check(`${rank}: boss chamber fills to its cap — peak ${room.peakLive} live adds of ${room.liveCap} `
      + `in ${room.secondsToCap} s, ${room.roomM2} m2 = ${room.m2PerBodyAtPeak} m2 per body at peak`,
    room.peakLive >= room.liveCap && room.secondsToCap > 0 && room.secondsToCap <= 20);

    const vs = res.bossVolleys;
    const fired = vs.filter((v) => v.bolts > 0);
    const landed = vs.filter((v) => v.hits > 0);
    check(`${rank}: boss spread shot fires (${fired.length}/${vs.length} trials, `
      + `${vs.reduce((s, v) => s + v.bolts, 0)} bolts over 4-14 m, normal + enraged)`,
    fired.length === vs.length);
    check(`${rank}: boss spread shot DAMAGES a stationary player — ${landed.length}/${vs.length} trials, `
      + `${vs.map((v) => `${v.rangeM}m${v.enraged ? '+' : ''}:${v.hits}x/${v.damageTaken}hp`).join(' ')}`,
    landed.length === vs.length);

    // THE FAN IS THE PATTERN. Bolt i must be the aim plus i's own step, not the
    // aim plus every earlier step — see the header. The intended sequence is
    // reconstructed from _bossBrain's own arithmetic (odd n so one bolt rides
    // the bearing itself) and compared term by term; 0.02 rad of tolerance is
    // ~1 cm of lateral error at 0.5 m, far tighter than the 0.24 rad spacing and
    // orders of magnitude tighter than the 0.36-2.40 rad the alias produced.
    const fanOk = (v) => {
      const n = v.enraged ? 9 : 7;
      if (v.boltOffsetsRad.length !== n) return false;
      const want = [];
      for (let i = 0; i < n; i++) want.push((i - (n - 1) / 2) * 0.24);
      want.sort((a, b) => a - b);
      return want.every((w, i) => Math.abs(w - v.boltOffsetsRad[i]) <= 0.02);
    };
    const fans = vs.filter(fanOk);
    check(`${rank}: the spread shot is a symmetric FAN about the true aim, not a `
      + `running sum (${fans.length}/${vs.length} volleys; normal `
      + `${JSON.stringify(vs.find((v) => !v.enraged)?.boltOffsetsRad)}, enraged `
      + `${JSON.stringify(vs.find((v) => v.enraged)?.boltOffsetsRad)})`,
    fans.length === vs.length);

    // A fan whose neighbours ALL miss is an aimed shot with decoys, which is
    // what the alias produced. The bound is arithmetic, and it is range
    // specific: a bolt one step off the bearing passes the player at
    // d*sin(0.24), against a lateral hit radius of sqrt(1.1^2 - 0.4^2) = 1.025 m
    // (1.1 m sphere at y 1.2, bolts flat at y 1.6). At 4 m that is 0.951 m — it
    // connects. At 6 m it is 1.427 m — a clean miss, and only the centre bolt
    // lands, which is the fan opening up with range exactly as intended. So the
    // multi-hit claim is made at 4 m only. Two, not three: _damagePlayer grants
    // 0.42 s of i-frames, so the second neighbour arriving in the same update is
    // absorbed no matter how good the aim is.
    const close = vs.filter((v) => v.rangeM <= 4);
    check(`${rank}: at 4 m the fan's neighbours connect too, not just the centre `
      + `bolt (${close.map((v) => `${v.rangeM}m${v.enraged ? '+' : ''}:${v.hits}`).join(' ')}; `
      + `neighbour passes at 4*sin(0.24) = 0.95 m inside the 1.025 m lateral radius)`,
    close.length > 0 && close.every((v) => v.hits >= 2));
    check(`${rank}: every boss bolt flies on the bolt plane y=${boltPlane}`,
      vs.every((v) => v.boltFlightY === boltPlane),
      vs.map((v) => v.boltFlightY).join(','));
    // Sampling note: positions are read AFTER g.update, and a bolt that enters
    // the 1.1 m sphere is deleted inside that same update — so the closest
    // distance this probe can ever SEE is one step of travel outside the
    // sphere, 1.1 + 15 / 60 = 1.35 m. What it rules out is the old geometry,
    // where the flat flight plane held every bolt at exactly 1.20 m and no
    // approach ever converged. Damage above is the assert that matters; this
    // one catches "landed for some other reason".
    check(`${rank}: bolts converge on the player rather than passing at a fixed `
      + `offset (closest sampled ${Math.min(...vs.map((v) => v.closestApproachM))} m, `
      + 'bound 1.35 = hit radius + one step)',
    vs.every((v) => v.closestApproachM <= 1.35));

    const co = res.caster.open;
    check(`${rank}: trash caster on open floor still lands (${co?.boltsFired} bolts at `
      + `${co?.dist} m, ${co?.hits} blows, ${co?.damageTaken} hp)`,
    Boolean(co) && co.boltsFired > 0 && co.hits > 0 && co.losBlockedAtPlane === false);
    check(`${rank}: trash caster bolt flies on the same plane y=${boltPlane}`,
      co?.boltFlightY === boltPlane, String(co?.boltFlightY));

    // Cover, proven two ways. The caster REFUSES to fire through a blocked
    // line (that is _agentLosBlocked working), so the caster trial alone can
    // only show "no damage"; the hand-fired bolt shows the pile eating a live
    // projectile that the identical shot on open floor lands.
    const cc = res.caster.covered;
    check(`${rank}: a caster behind a rubble pile deals nothing — `
      + `${cc?.boltsFired} bolts fired at ${cc?.dist} m, ${cc?.hits} blows landed`,
    Boolean(cc) && cc.hits === 0 && cc.losBlockedAtPlane === true);
    const bo = res.boltOpen;
    const bc = res.boltCovered;
    check(`${rank}: a hand-fired bolt lands on open floor (${bo?.dist} m, ${bo?.hits} hit, `
      + `${bo?.damageTaken} hp) and DIES on the rubble pile (${bc?.dist} m, ${bc?.hits} hit, `
      + `${bc?.framesAlive} frames alive vs ${bo?.framesAlive})`,
    Boolean(bo) && Boolean(bc) && bo.hits > 0 && bc.hits === 0
      && bc.framesAlive < bo.framesAlive);
  }

  const file = writeReport('fight-test', report);
  console.log(`\nreport: ${file}`);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join('\n'));
} finally {
  await browser.close();
  await server.stop();
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall fight checks passed');
process.exit(fails.length ? 1 : 0);
