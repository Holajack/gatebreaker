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

import * as THREE from 'three';
import { ensureServer, launchBrowser, newPhonePage, gotoGame, evalGame, writeReport } from './_harness.mjs';
import { ProjectilePool } from '../src/game/projectiles.js';

const fails = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(name);
}

// ---------------------------------------------------------------------------
// THE POOL'S CONTRACT, PROVEN IN NODE BEFORE A BROWSER EXISTS (RPG_SPEC step 8
// verify clause). Two claims, both about what pooling must NOT change:
//
//   1. A g=0, vy=0 projectile's position sequence is FLOAT-IDENTICAL to the
//      shipped integration (pos.addScaledVector(dir, speed*dt)) over 240
//      steps. Enemy caster bolts and boss spread shots ride this path, and
//      the spec's wording is "assert that byte-equality in the test rather
//      than assuming it".
//   2. Firing 200 arrows creates ZERO new geometries, materials or meshes —
//      the pool's whole reason to exist. Counted at the allocation ledger the
//      pool keeps, which a reclaim cycle cannot forge.
// ---------------------------------------------------------------------------
{
  const scene = { add() {}, remove() {} };
  const pool = new ProjectilePool(scene, { max: 16 });
  const from = new THREE.Vector3(3.2, 1.6, -7.1);
  const flatDir = new THREE.Vector3(0.6, 0, 0.8).normalize();
  const rec = pool.spawn({ from, dir: flatDir, speed: 15, damage: 1, life: 999, kind: 'bolt' });
  const ref = from.clone();
  const ctx = { obstacleField: null, worldRadius: Infinity, playerPos: null, enemies: null };
  const dt = 1 / 60;
  let identical = true;
  let divergedAt = -1;
  for (let i = 0; i < 240; i++) {
    pool.update(dt, ctx);
    ref.addScaledVector(flatDir, 15 * dt);
    if (rec.pos.x !== ref.x || rec.pos.y !== ref.y || rec.pos.z !== ref.z) {
      identical = false;
      divergedAt = i;
      break;
    }
  }
  check('pool: g=0/vy=0 integration float-identical to the shipped loop over 240 steps',
    identical, identical ? '' : `diverged at step ${divergedAt}`);

  // Warm both kinds so lazy material/geometry creation is behind the marker,
  // then cycle 200 arrows through a 16-record pool.
  pool.spawn({ from, dir: flatDir, speed: 46, vy: 2, g: 9, life: 2.5, kind: 'arrow' });
  const before = pool.stats();
  for (let i = 0; i < 200; i++) {
    pool.spawn({ from, dir: flatDir, speed: 46, vy: 2, g: 9, life: 2.5, kind: 'arrow' });
    pool.update(dt, ctx);
  }
  const after = pool.stats();
  check('pool: 200 arrow spawns allocate nothing '
    + `(meshes ${before.meshes}->${after.meshes}, geometries ${before.geometries}->${after.geometries}, `
    + `materials ${before.materials}->${after.materials})`,
  before.meshes === after.meshes && before.geometries === after.geometries
    && before.materials === after.materials);
  check(`pool: record count is capped at 16 (live ${after.live} + free ${after.free})`,
    after.live + after.free === 16 && after.live <= 16);

  // Gravity is real when asked for: same spawn with vy/g rises then falls.
  pool.clear();
  const arc = pool.spawn({ from, dir: flatDir, speed: 22, vy: 2.64, g: 9, life: 2.5, kind: 'arrow' });
  let maxY = from.y;
  let lastY = from.y;
  for (let i = 0; i < 120 && pool.live.includes(arc); i++) {
    pool.update(dt, ctx);
    lastY = arc.pos.y;
    if (arc.pos.y > maxY) maxY = arc.pos.y;
  }
  check(`pool: a vy=2.64/g=9 arrow arcs — rises to ${maxY.toFixed(2)} then falls to ${lastY.toFixed(2)}`,
    maxY > from.y + 0.3 && lastY < maxY - 0.3);
  pool.dispose();
}

// ---------------------------------------------------------------------------
// THE STAFF'S CONTRACT, PROVEN IN NODE (RPG_SPEC step 9). Three claims:
//
//   1. INTERNAL CONSISTENCY: the bolt flies under the arrow's EXACT gravity
//      (STAFF.gravity === BOW.gravity === 9.0), its steering is bounded at
//      the spec's 90 deg/s, and its launch speed is the spec's 18 m/s —
//      magic bends physics in exactly two named ways and gravity is not one
//      of them.
//   2. The family's combo carries the familyTable's numbers: two steps, the
//      opener a bolt, the finisher a beam rooted at move 0.20.
//   3. The staff BUILDS AND READS AS A STAFF with the pack ABSENT (the
//      step's own verify clause): setModelSource(null), procedural head.
// ---------------------------------------------------------------------------
{
  const W = await import('../src/game/weapons.js');
  check('staff: bolt gravity IS the arrow gravity (9.0 shared, the internal-consistency law)',
    W.STAFF.gravity === 9 && W.STAFF.gravity === W.BOW.gravity,
    `staff g ${W.STAFF.gravity}, bow g ${W.BOW.gravity}`);
  check('staff: steering bounded at the spec\'s 90 deg/s and launch speed at 18 m/s',
    Math.abs(W.STAFF.turnRate - Math.PI / 2) < 1e-12 && W.STAFF.boltSpeed === 18);
  const sc = W.WEAPONS.emberstave.combo;
  check('staff: two steps — bolt opener, beam finisher rooted at move 0.20 (familyTable)',
    sc.length === 2 && sc[0].bolt === true && !sc[0].finisher
      && sc[1].beam === true && sc[1].finisher === true && sc[1].move === 0.20
      && sc[0].windup === 0.28 && sc[0].lock === 0.34 && sc[0].range === 18);
  check('staff: the family costs mana (bolt and beam tick both priced above zero)',
    W.STAFF.boltMp > 0 && W.STAFF.beam.mpPerTick > 0 && W.STAFF.beam.maxT === 1.6);
  check('staff: both bases enter the drop/Exchange ladder (archetype staff, distinct tiers)',
    W.WEAPONS.emberstave.archetype === 'staff' && W.WEAPONS.hollowlight.archetype === 'staff'
      && W.WEAPONS.emberstave.tier !== W.WEAPONS.hollowlight.tier);

  // Pack-absent build: the verify clause's own wording.
  W.setModelSource(null);
  const staff = W.buildWeaponMesh(W.rollWeapon('emberstave', 1, { rarity: 'common', level: 1 }));
  let minY = Infinity;
  let maxY = -Infinity;
  let maxR = 0;
  let parts = 0;
  let headParts = 0;
  staff.updateMatrixWorld(true);
  staff.traverse((o) => {
    if (!o.isMesh) return;
    parts++;
    const y = o.getWorldPosition(new THREE.Vector3()).y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (y > 1.0) headParts++;
    maxR = Math.max(maxR, Math.abs(o.position.x), Math.abs(o.position.z));
  });
  check('staff: builds with the pack ABSENT and reads as a staff — tall thin haft, '
    + `head cluster at the top (${parts} parts, y ${minY.toFixed(2)}..${maxY.toFixed(2)}, `
    + `radial spread ${maxR.toFixed(2)})`,
  parts >= 5 && (maxY - minY) > 1.4 && maxY > 1.2 && headParts >= 2 && maxR < 0.4);
  check('staff: archetype tagged for the STOW table and stows on the back',
    staff.userData.archetype === 'staff' && W.STOW.staff?.socket === 'back');
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

      // --- armed melee humanoid through the swing machine --------------------
      // Wave 3-B step 1 routed armed humanoids (grunt/stalker/brute/lancer)
      // through weapons.js's swing state machine instead of the bare
      // telegraph countdown. The fairness contract this trial pins down: the
      // blow still lands EXACTLY telegraphMax after the wind-up starts (the
      // eye-flare window players learned), and it still lands at all. A
      // machine that drifted the strike frame by even a couple of frames
      // would shrink or stretch every dodge window in the game silently.
      {
        for (const e of [...g.enemies]) if (!e.isBoss) g._killEnemy(e);
        const mx = bossRoom.centre.x;
        const mz = bossRoom.centre.z;
        g._spawnEnemy(new V(mx, 0, mz + 1.4), 'grunt');
        const m = g.enemies.find((q) => !q.isBoss);
        m.spawning = 0;
        m.attackCd = 0;
        resetDamage();
        // startFrame tracks the wind-up of the attack that LANDS, not the
        // first one asked for: an attackCd forced to 0 makes the grunt swing
        // on its spawn frame before the yaw update has faced it at the player
        // (a quirk the old countdown had identically), and that first blow
        // whiffs behind it.
        let startFrame = -1;
        let strikeFrame = -1;
        let telMax = 0;
        let prevTel = 0;
        for (let i = 0; i < 600 && strikeFrame < 0; i++) {
          g.player.invuln = 0;
          g.player.pos.set(mx, 0, mz);
          g.player.body?.reset?.(mx, 0, mz);
          g.player.hp = g.derived.maxHp;
          m.pos.set(mx, 0, mz + 1.4);
          m.vel.set(0, 0, 0);
          m.hp = m.maxHp;
          m.stagger = 0;
          const hitsBefore = hits;
          g.update(1 / 60);
          if (m.telegraph > 0 && prevTel <= 0) { startFrame = i; telMax = m.telegraphMax; }
          prevTel = m.telegraph;
          if (hits > hitsBefore) strikeFrame = i;
        }
        out.melee = {
          usesMachine: Boolean(m.attack),
          startFrame,
          strikeFrame,
          telMax,
          windupFrames: strikeFrame - startFrame,
          wantFrames: Math.ceil(telMax * 60),
          hits,
          damage: Math.round(hpLost),
        };
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
      }

      // --- the bow: draw-hold-release, soft-lock, arc, stick (step 8) --------
      // E rank only: one gate's geometry is enough to prove ballistics, and the
      // D pass should keep measuring the game with the SHIPPED melee loadout.
      if (gateIndex === 0) {
        const W = await import('/src/game/weapons.js');
        const bow = { shots: 0, hits: 0, hitDistM: -1, targetMovedM: 0 };
        out.bow = bow;
        g.equip(W.rollWeapon('galesting', 7, { rarity: 'common', level: 40 }));
        bow.family = g.weapon?.archetype;
        bow.mainHand = g.weapon?.arch?.mainHand;
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);

        const cx = bossRoom.centre.x;
        const cz = bossRoom.centre.z;
        g.player.pos.set(cx, 0, cz);
        g.player.body?.reset?.(cx, 0, cz);
        // Camera-forward IS the soft-lock axis, so the trial reads it off the
        // live camera, exactly as the aim solver will — and it must find a
        // bearing whose 15 m line is CLEAR at arrow height, because the boss
        // chamber deliberately contains cover (a blocked lock is refused by
        // design, and that refusal is a different test). Rotate the real orbit
        // input until the live camera looks down a clear lane.
        let camF = null;
        let ex = cx;
        let ez = cz;
        for (let k = 0; k < 24 && !camF; k++) {
          g.input.look.yaw = (k / 24) * Math.PI * 2;
          for (let i = 0; i < 16; i++) { g.player.invuln = 1; g.update(1 / 60); }
          const cf = g.player.pos.clone().sub(g.camera.position).setY(0).normalize();
          const tx = cx + cf.x * 15;
          const tz = cz + cf.z * 15;
          if (field.lineBlocked(cx, cz, tx, tz, { feetY: 1.4 })) continue;
          if (field.blocked(tx, tz, 0.45, 0, 0.2)) continue;
          camF = cf;
          ex = tx;
          ez = tz;
        }
        bow.lineClear = Boolean(camF);
        if (!camF) { camF = g.player.pos.clone().sub(g.camera.position).setY(0).normalize(); }

        // The target: a live grunt, AI on, free to move. It is PINNED at 15 m
        // until the release frame so the claim "hits at 15 m" is measured, then
        // freed — it spends the whole arrow flight running, which is the moving
        // part of "hits a moving enemy".
        g._spawnEnemy(new V(ex, 0, ez), 'grunt');
        const tgt = g.enemies.find((q) => !q.isBoss);
        tgt.spawning = 0;
        tgt.attackCd = 9e9;

        let arrowHits = 0;
        let hitDist = -1;
        bow.dbg = [];
        const realDamageEnemy = g._damageEnemy.bind(g);
        g._damageEnemy = (e, amount, opts) => {
          arrowHits++;
          hitDist = Math.hypot(e.pos.x - g.player.pos.x, e.pos.z - g.player.pos.z);
          if (bow.dbg.length < 5) {
            bow.dbg.push({
              key: e.key, boss: Boolean(e.isBoss), y: +e.pos.y.toFixed(1),
              amount: Math.round(amount), origin: opts?.origin || null,
              stack: new Error('x').stack.split('\n').slice(2, 5).join(' | '),
            });
          }
          realDamageEnemy(e, amount, opts);
        };

        // Draw-hold-release through the real input object: press on frame 0 of
        // each 75-frame cycle, hold 45 frames (past the 0.55 s full draw),
        // release, then leave 30 frames for the flight.
        let tracked = null;
        let freeFrame = -1;
        const flightY = [];
        for (let i = 0; i < 750 && arrowHits === 0; i++) {
          const phase = i % 75;
          if (phase === 0) {
            g.input.pressed.add('attack');
            g.input.held.add('attack');
            freeFrame = -1;
          }
          if (phase < 45) {
            tgt.pos.set(ex, 0, ez);
            tgt.vel.set(0, 0, 0);
            tgt.body?.reset?.(ex, 0, ez);
            tgt.hp = tgt.maxHp;
          } else if (phase === 45) {
            g.input.held.delete('attack');
            freeFrame = i;
          }
          g.player.invuln = 1;
          g.player.pos.set(cx, 0, cz);
          g.player.body?.reset?.(cx, 0, cz);
          g.update(1 / 60);
          for (const pr of g.projectiles) {
            if (pr.kind !== 'arrow') continue;
            if (tracked !== pr) {
              tracked = pr;
              bow.shots++;
              bow.spawnVy = +pr.vy.toFixed(3);
              bow.gravity = pr.g;
              bow.speed = +pr.speed.toFixed(1);
              flightY.length = 0;
            }
            flightY.push(+pr.pos.y.toFixed(3));
          }
          if (freeFrame >= 0 && arrowHits > 0) {
            bow.targetMovedM = +Math.hypot(tgt.pos.x - ex, tgt.pos.z - ez).toFixed(2);
          }
        }
        g._damageEnemy = realDamageEnemy;
        g.input.held.delete('attack');
        bow.hits = arrowHits;
        bow.hitDistM = +hitDist.toFixed(1);
        bow.lockedFlightY = flightY.slice(0, 24);

        // Free shot (no target): full arc down the camera line, ground stick.
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);
        const statsBefore = g.pool.stats();
        g.input.pressed.add('attack');
        g.input.held.add('attack');
        let free = null;
        let maxY = 0;
        let lastY = 0;
        for (let i = 0; i < 300; i++) {
          if (i === 20) g.input.held.delete('attack');   // ~0.33 s: partial draw
          g.player.invuln = 1;
          g.update(1 / 60);
          for (const pr of g.projectiles) {
            if (pr.kind !== 'arrow') continue;
            if (free !== pr) { free = pr; bow.freeSpawnVy = +pr.vy.toFixed(2); }
            lastY = pr.pos.y;
            if (pr.pos.y > maxY) maxY = pr.pos.y;
          }
          if (free?.stuck) break;
        }
        bow.freeShot = free ? {
          spawnVy: bow.freeSpawnVy,
          maxY: +maxY.toFixed(2),
          endY: +lastY.toFixed(2),
          stuck: Boolean(free.stuck),
          meshVisible: Boolean(free.mesh?.visible),
        } : null;
        const statsAfter = g.pool.stats();
        bow.poolDelta = {
          meshes: statsAfter.meshes - statsBefore.meshes,
          geometries: statsAfter.geometries - statsBefore.geometries,
          materials: statsAfter.materials - statsBefore.materials,
        };

        // Hand the melee loadout back so nothing downstream measures a bow.
        g.equipFromStash(0);
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);
      }

      // --- the staff: machine-timed bolt, homing bound, mana, beam (step 9) --
      // E rank only, same reasoning as the bow. The trial drives the REAL
      // input and the REAL camera: press casts through the swing machine, the
      // bolt homes inside its 90 deg/s budget at a target that MOVES, and the
      // held finisher channels the beam against a pinned grunt.
      if (gateIndex === 0) {
        const W = await import('/src/game/weapons.js');
        const S = W.STAFF;
        const st = {};
        out.staff = st;
        g.equip(W.rollWeapon('emberstave', 7, { rarity: 'common', level: 40 }));
        st.family = g.weapon?.archetype;
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);

        const cx = bossRoom.centre.x;
        const cz = bossRoom.centre.z;
        g.player.pos.set(cx, 0, cz);
        g.player.body?.reset?.(cx, 0, cz);
        // Clear lane at bolt height, found off the live camera like the
        // bow's — but the staff trial's target DODGES 2 m sideways
        // mid-flight, so the DODGE spot's line must be clear too (the first
        // run of this trial had the bolt steer correctly into a rubble pile
        // sitting on the un-validated dodge line and die there, which is the
        // cover system working, not the homing failing). Checked at feetY
        // 1.2, conservative against the bolt's whole 1.0-1.9 arc band;
        // either sidestep direction is accepted, and the chosen sign rides
        // out to the sidestep below.
        let camF = null;
        let ex = cx;
        let ez = cz;
        let sideSign = 1;
        for (let k = 0; k < 24 && !camF; k++) {
          g.input.look.yaw = (k / 24) * Math.PI * 2;
          for (let i = 0; i < 16; i++) { g.player.invuln = 1; g.update(1 / 60); }
          const cf = g.player.pos.clone().sub(g.camera.position).setY(0).normalize();
          const tx = cx + cf.x * 12;
          const tz = cz + cf.z * 12;
          if (field.lineBlocked(cx, cz, tx, tz, { feetY: S.launchY })) continue;
          if (field.blocked(tx, tz, 0.45, 0, 0.2)) continue;
          for (const sgn of [1, -1]) {
            const dx = tx + (-cf.z) * 2 * sgn;
            const dz = tz + cf.x * 2 * sgn;
            if (field.lineBlocked(cx, cz, dx, dz, { feetY: 1.2 })) continue;
            if (field.blocked(dx, dz, 0.45, 0, 0.2)) continue;
            camF = cf;
            ex = tx;
            ez = tz;
            sideSign = sgn;
            break;
          }
        }
        st.lineClear = Boolean(camF);
        if (!camF) camF = g.player.pos.clone().sub(g.camera.position).setY(0).normalize();

        g._spawnEnemy(new V(ex, 0, ez), 'grunt');
        const tgt = g.enemies.find((q) => !q.isBoss);
        tgt.spawning = 0;
        tgt.attackCd = 9e9;
        // The probe hunter is level 40 against an E grunt: one blow KILLS,
        // and _killEnemy splices the body out of g.enemies — which would end
        // the trial by deleting its own target. An effectively-infinite
        // health bar keeps the subject on the field; the wrap still counts
        // every blow.
        tgt.maxHp = 1e9;
        tgt.hp = 1e9;

        let boltHits = 0;
        let hitDist = -1;
        const realDamageEnemy = g._damageEnemy.bind(g);
        g._damageEnemy = (e, amount, opts) => {
          boltHits++;
          hitDist = Math.hypot(e.pos.x - g.player.pos.x, e.pos.z - g.player.pos.z);
          realDamageEnemy(e, amount, opts);
        };

        // BOLT + HOMING BOUND. The grunt is pinned at 12 m until the bolt
        // exists, then SIDESTEPS 2 m and holds — a clean mid-flight dodge
        // the steering must close inside its 90 deg/s budget (9.5 deg of
        // correction against ~61 deg of budget over the flight). A freed,
        // sprinting target was tried first and the bolt missed by 8 cm —
        // which is the SPEC's own promise ("a fast-moving target can still
        // outrun a homing bolt"), so the deterministic dodge is the honest
        // test of the steering claim, and the bound assert below proves the
        // budget was never exceeded to make it. Per-frame bearing deltas are
        // measured off the record's own dir.
        const statsBefore = g.pool.stats();
        g.player.hp = g.derived.maxHp;
        g.player.mp = g.derived.maxMp;
        const mp0 = g.player.mp;
        let bolt = null;
        let stepped = false;
        let maxTurnPerFrame = 0;
        let totalTurn = 0;
        let prevBearing = null;
        const sideX = -camF.z * sideSign;
        const sideZ = camF.x * sideSign;
        for (let i = 0; i < 240 && boltHits === 0; i++) {
          if (i === 0) { g.input.pressed.add('attack'); g.input.held.add('attack'); }
          if (i === 2) g.input.held.delete('attack');
          if (!bolt) {
            tgt.pos.set(ex, 0, ez);
            tgt.vel.set(0, 0, 0);
            tgt.body?.reset?.(ex, 0, ez);
          } else {
            stepped = true;
            tgt.pos.set(ex + sideX * 2, 0, ez + sideZ * 2);
            tgt.body?.reset?.(tgt.pos.x, 0, tgt.pos.z);
            tgt.vel.set(0, 0, 0);
          }
          tgt.hp = tgt.maxHp;
          g.player.invuln = 1;
          g.player.pos.set(cx, 0, cz);
          g.player.body?.reset?.(cx, 0, cz);
          g.update(1 / 60);
          if (bolt) {
            // Diagnostics the report keeps: closest approach to the chest
            // sphere and the bolt's eventual fate.
            const chest = 1.2 * (tgt.base?.scale || 1);
            const dd = Math.hypot(bolt.pos.x - tgt.pos.x, bolt.pos.y - (tgt.pos.y + chest), bolt.pos.z - tgt.pos.z);
            if (st.minApproachM === undefined || dd < st.minApproachM) st.minApproachM = +dd.toFixed(2);
            st.boltFate = bolt.stuck ? 'stuck' : (g.projectiles.includes(bolt) ? 'flying' : 'gone');
            if (!st.path) st.path = { from: [+cx.toFixed(1), +cz.toFixed(1)], tgt: [+tgt.pos.x.toFixed(1), +tgt.pos.z.toFixed(1)], pts: [] };
            if (!bolt.stuck && st.path.pts.length < 60) {
              st.path.pts.push([+bolt.pos.x.toFixed(2), +bolt.pos.y.toFixed(2), +bolt.pos.z.toFixed(2)]);
            }
          }
          for (const pr of g.projectiles) {
            if (!pr.staff) continue;
            if (bolt !== pr) {
              bolt = pr;
              st.gravity = pr.g;
              st.speed = pr.speed;
              st.spawnVy = +pr.vy.toFixed(3);
              st.locked = Boolean(pr.staffTarget);
              // Mana measured the frame the cast lands: the bar was FULL
              // until this frame, so regen cannot have refilled the cost.
              st.mpCost = +(mp0 - g.player.mp).toFixed(2);
              prevBearing = Math.atan2(pr.dir.x, pr.dir.z);
            } else {
              const b2 = Math.atan2(pr.dir.x, pr.dir.z);
              let d = b2 - prevBearing;
              while (d > Math.PI) d -= Math.PI * 2;
              while (d <= -Math.PI) d += Math.PI * 2;
              maxTurnPerFrame = Math.max(maxTurnPerFrame, Math.abs(d));
              totalTurn += Math.abs(d);
              prevBearing = b2;
            }
          }
        }
        st.boltHits = boltHits;
        st.hitDistM = +hitDist.toFixed(1);
        st.maxTurnPerFrameRad = +maxTurnPerFrame.toFixed(4);
        st.totalTurnRad = +totalTurn.toFixed(3);
        st.turnBoundRad = +(S.turnRate / 60).toFixed(4);

        // THE BEAM. A fresh opener fires free, then the finisher is pressed
        // inside the chain window and HELD against a grunt pinned 5 m down
        // the beam line. Ticks are read off the live channel state.
        g._damageEnemy = realDamageEnemy;
        g.input.held.delete('attack');
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);
        g.player.hp = g.derived.maxHp;
        g.player.mp = g.derived.maxMp;

        let tickHits = 0;
        g._damageEnemy = (e, amount, opts) => { tickHits++; realDamageEnemy(e, amount, opts); };
        let beamSeen = false;
        let beamMeshSeen = false;
        let beamTicks = 0;
        let beamGone = -1;
        let mpBeforeBeam = 0;
        let mpNet = 0;
        let beamTgt = null;
        for (let i = 0; i < 400; i++) {
          if (i === 0) { g.input.pressed.add('attack'); g.input.held.add('attack'); }
          if (i === 2) g.input.held.delete('attack');
          if (i === 45) {
            // Opener total is 0.52 s (32 frames); the 1.10 s chain window is
            // open. Spawn the pinned target, then press AND HOLD.
            g._spawnEnemy(new V(cx + camF.x * 5, 0, cz + camF.z * 5), 'grunt');
            beamTgt = g.enemies.find((q) => !q.isBoss);
            beamTgt.spawning = 0;
            beamTgt.attackCd = 9e9;
            // Same immortality as the bolt target — tick 1 must not delete
            // the subject of ticks 2-8.
            beamTgt.maxHp = 1e9;
            beamTgt.hp = 1e9;
            mpBeforeBeam = g.player.mp;
            g.input.pressed.add('attack');
            g.input.held.add('attack');
          }
          if (beamTgt) {
            beamTgt.pos.set(cx + camF.x * 5, 0, cz + camF.z * 5);
            beamTgt.vel.set(0, 0, 0);
            beamTgt.body?.reset?.(beamTgt.pos.x, 0, beamTgt.pos.z);
            beamTgt.hp = beamTgt.maxHp;
          }
          g.player.invuln = 1;
          g.update(1 / 60);
          if (g._staffBeam) {
            beamSeen = true;
            beamTicks = Math.max(beamTicks, g._staffBeam.ticks);
            if (g.fx._beam?.visible) beamMeshSeen = true;
          } else if (beamSeen && beamGone < 0 && i > 46) {
            beamGone = i;
            mpNet = +(mpBeforeBeam - g.player.mp).toFixed(2);
            // Stop the held button from opening a fresh combo after the
            // channel times out — the trial is over.
            g.input.held.delete('attack');
          }
          if (beamGone >= 0 && i > beamGone + 5) break;
        }
        g.input.held.delete('attack');
        g._damageEnemy = realDamageEnemy;
        st.beam = {
          seen: beamSeen,
          meshSeen: beamMeshSeen,
          ticks: beamTicks,
          tickHits,
          mpNet,
          endedAtFrame: beamGone,
        };
        const statsAfter = g.pool.stats();
        st.poolDelta = {
          meshes: statsAfter.meshes - statsBefore.meshes,
          geometries: statsAfter.geometries - statsBefore.geometries,
          materials: statsAfter.materials - statsBefore.materials,
        };

        // Hand the melee loadout back so nothing downstream measures a staff.
        g.equipFromStash(0);
        for (const q of [...g.enemies]) if (!q.isBoss) g._killEnemy(q);
        for (let i = g.projectiles.length - 1; i >= 0; i--) g._removeProjectile(i);
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

    // The melee fairness window survives the swing-machine rewire, frame-exact.
    const me = res.melee;
    check(`${rank}: an armed grunt swings through the machine and its blow lands exactly `
      + `telegraphMax after the wind-up starts (${me?.windupFrames} frames vs ${me?.wantFrames} `
      + `for ${me?.telMax}s, ${me?.hits} blows, ${me?.damage} hp)`,
    Boolean(me) && me.usesMachine === true && me.hits > 0
      && Math.abs(me.windupFrames - me.wantFrames) <= 1);

    // --- the bow (E only): RPG_SPEC step 8 -------------------------------
    if (res.bow) {
      const bw = res.bow;
      check(`E: the player bow HITS a moving enemy at 15 m — ${bw.hits} hit(s) at `
        + `${bw.hitDistM} m after ${bw.shots} shot(s); target ran ${bw.targetMovedM} m `
        + 'during the flight',
      bw.lineClear === true && bw.hits > 0 && bw.hitDistM >= 12);
      check(`E: arrows fly under the spec's shared g=9.0 with a real vertical component `
        + `(g ${bw.gravity}, spawn vy ${bw.spawnVy}, launch speed ${bw.speed} m/s at full draw)`,
      bw.gravity === 9 && typeof bw.spawnVy === 'number' && bw.speed >= 44);
      const fs = bw.freeShot;
      check(`E: an unlocked arrow ARCS and STICKS where it lands — rises ${fs?.spawnVy} m/s `
        + `to y ${fs?.maxY}, ends at y ${fs?.endY}, stuck=${fs?.stuck}, still visible=${fs?.meshVisible}`,
      Boolean(fs) && fs.spawnVy > 0 && fs.maxY > 1.6 && fs.stuck === true && fs.meshVisible === true);
      check('E: in-game arrow fire allocates nothing once warm — pool ledger delta '
        + `${JSON.stringify(bw.poolDelta)}`,
      bw.poolDelta && bw.poolDelta.meshes === 0 && bw.poolDelta.geometries === 0
        && bw.poolDelta.materials === 0);
      check(`E: the bow is left-handed and ranged (mainHand ${bw.mainHand}, family ${bw.family})`,
        bw.mainHand === 'L' && bw.family === 'bow');
    }

    // --- the staff (E only): RPG_SPEC step 9 -----------------------------
    if (res.staff) {
      const stf = res.staff;
      check(`E: the staff bolt HITS through the machine at range — ${stf.boltHits} hit(s) at `
        + `${stf.hitDistM} m after a 2 m sidestep mid-flight (locked=${stf.locked})`,
      stf.lineClear === true && stf.boltHits > 0 && stf.hitDistM >= 5 && stf.locked === true);
      check(`E: the bolt flies at the spec's 18 m/s under the arrow's shared g=9.0 `
        + `(g ${stf.gravity}, speed ${stf.speed}, solved vy ${stf.spawnVy})`,
      stf.gravity === 9 && stf.speed === 18 && typeof stf.spawnVy === 'number');
      check(`E: the cast costs mana at the contact frame (${stf.mpCost} MP of the contract's 4)`,
        typeof stf.mpCost === 'number' && stf.mpCost > 3 && stf.mpCost <= 4.05);
      check('E: homing is BOUNDED — steering happened '
        + `(${stf.totalTurnRad} rad total) but never beat 90 deg/s `
        + `(${stf.maxTurnPerFrameRad} rad/frame vs bound ${stf.turnBoundRad})`,
      stf.totalTurnRad > 0.03 && stf.maxTurnPerFrameRad <= stf.turnBoundRad + 1e-3);
      const bm = stf.beam;
      check(`E: the held finisher CHANNELS — ${bm?.ticks} ticks, ${bm?.tickHits} blows on the `
        + `pinned grunt, net ${bm?.mpNet} MP drained, beam mesh seen=${bm?.meshSeen}, `
        + `ended by the 1.6 s ceiling at frame ${bm?.endedAtFrame}`,
      Boolean(bm) && bm.seen === true && bm.ticks >= 6 && bm.tickHits >= 5
        && bm.mpNet > 5 && bm.meshSeen === true && bm.endedAtFrame > 0);
      check('E: staff fire allocates nothing once warm — pool ledger delta '
        + `${JSON.stringify(stf.poolDelta)}`,
      stf.poolDelta && stf.poolDelta.meshes === 0 && stf.poolDelta.geometries === 0
        && stf.poolDelta.materials === 0);
    }
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
