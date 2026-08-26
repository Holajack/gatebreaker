// tools/trial-test.mjs — THE SEALED STAIR (Wave F.2, the level-40 class trial).
//
//   node tools/trial-test.mjs [--headed] [--swiftshader]
//
// The one missing keystone of the Archon endgame: classes.canAscend requires
// save.classTier and, before this wave, NOTHING ever called
// progression.awardClassTier — five paths, quality multipliers and THE REACH
// all shipped unreachable. This tool asserts the keystone end to end, through
// the real UI and the real sim:
//
//   1. A level-39 save at the stair reads the SEALED line and the confirm
//      refuses to route (no trial below 40).
//   2. A level-40 save reads the READY line; confirming descends into the
//      trial: arena world, solo (zero shadows fielded, roster untouched),
//      HUD objective is THE STAIR + a live M:SS clock, waves spawning.
//   3. Drive the sim past 60 s (god-moded — the tool tests the machinery,
//      not the tool author's dodge timing), then let the field kill the
//      hunter. Assert: save.classTier matches the achieved time band
//      ('advanced' for 60-149 s), +8 points, NO roster cull, NO deaths++,
//      ceremony panel (THE STAIR JUDGES / tier row / consequence line).
//   4. CONTINUE returns to the city BESIDE the stair; the door now reads the
//      done line and refuses a second descent.
//   5. THE REACH lights up (read-only): with classTier banked, a 55+ save
//      with an S clear passes canAscend, and the S portal's prompt carries
//      the ascension-trial line — the endgame is reachable in real play.
//
// LANDSCAPE viewport: index.html's rotate gate swallows pointers in portrait.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
// Same reasoning as flow-test: everything asserted here is logic, not pixels,
// and SwiftShader would stretch the ~4k stepped frames into minutes.
const SWIFTSHADER = argv.includes('--swiftshader');

const fail = [];
const notes = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); return Boolean(cond); };
let _t0 = Date.now();
const phase = (name) => {
  const now = Date.now();
  console.log(`  [${((now - _t0) / 1000).toFixed(1)}s] ${name}`);
  _t0 = now;
};

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: SWIFTSHADER });
const { page, errors } = await newPhonePage(browser, { width: 900, height: 460, dpr: 1 });

const report = {};

// Stand the player at an interactable's door and ask the mode what it says.
async function promptAt(id) {
  return page.evaluate((doorId) => {
    const g = window.__game;
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === doorId);
    if (!it) return { missing: true };
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    return { prompt: g.mode.prompt };
  }, id);
}

try {
  await gotoGame(page, { waitMs: 2000 });
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 })
    .catch(() => {});
  // RETARGET 2026-08-26: dismiss the first-arrival welcome (see _harness.dismissDialog)
  await page.evaluate(() => { const d = window.__game?.dialog; for (let i = 0; d?.open && i < 12; i++) d.advance(); });
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => window.__game?.mode?.name === 'city'), 'PLAY did not reach the city');
  phase('booted into the city');

  // ------------------------------------------------- 1. sealed below level 40
  const sealed = await page.evaluate(async () => {
    const g = window.__game;
    const { t } = await import('/src/game/strings.js');
    g.save.level = 39;
    g.refreshDerived(true);
    g.mode.refreshPortalLocks();
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'trial');
    if (!it) return { missing: true };
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    const prompt = g.mode.prompt;
    const acted = g.mode.confirmPrompt();
    return {
      prompt, acted,
      sealedLine: t('door.trial.sealed'),
      mode: g.mode?.name ?? null,
      classTier: g.save.classTier ?? null,
    };
  });
  report.sealed = sealed;
  ok(!sealed.missing, 'the trial interactable is missing from Threshold');
  ok(sealed.prompt?.kind === 'interact' && sealed.prompt?.id === 'trial',
    `no interact prompt at the stair for a level-39 save (got ${JSON.stringify(sealed.prompt)})`);
  ok(sealed.prompt?.sub === sealed.sealedLine,
    `level 39 should read the sealed line, read: "${sealed.prompt?.sub}"`);
  ok(sealed.acted === null, `confirming the sealed stair at 39 routed anyway (${JSON.stringify(sealed.acted)})`);
  ok(sealed.mode === 'city', `a level-39 confirm left mode=${sealed.mode}`);
  ok(sealed.classTier === null, 'a refused trial wrote classTier');
  phase(`level 39 reads: "${sealed.prompt?.sub}" and the confirm refuses`);

  // ------------------------------------------ 2. level 40: the stair is ready
  const ready = await page.evaluate(async () => {
    const g = window.__game;
    // A hand-built level-40 hunter with a company worth protecting: the
    // roster is seeded so the no-cull assert bites on real records, and the
    // pre-trial books are snapshotted for the delta checks at the end.
    const { makeShadow, addShadow } = await import('/src/game/shadows.js');
    g.save.level = 40;
    g.refreshDerived(true);
    g.mode.refreshPortalLocks();
    for (let i = 0; i < 4; i++) addShadow(g.save, makeShadow(g.save, { type: 'grunt', level: 20 + i }));
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'trial');
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    return {
      prompt: g.mode.prompt,
      roster: g.save.shadows.roster.length,
      points: g.save.points || 0,
      deaths: g.save.deaths || 0,
      stairPos: { x: it.pos.x, z: it.pos.z },
    };
  });
  report.ready = ready;
  ok(ready.prompt?.sub === 'THE SEALED STAIR WAITS. GO DOWN AS YOU ARE.',
    `level 40 should read the ready line, read: "${ready.prompt?.sub}"`);
  ok(ready.roster === 4, `roster seeding failed (${ready.roster} records)`);
  phase(`level 40 reads: "${ready.prompt?.sub}" (roster ${ready.roster}, ${ready.points} points banked)`);

  // ----------------------------------------------------- confirm and descend
  const descended = await page.evaluate(() => {
    const g = window.__game;
    const acted = g.mode.confirmPrompt();
    return { acted };
  });
  ok(descended.acted?.action === 'enterTrial',
    `the ready confirm did not route to the trial (${JSON.stringify(descended.acted)})`);
  await page.waitForFunction(() => window.__game?.mode?.name === 'dungeon', null, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(1200);

  const inTrial = await page.evaluate(() => {
    const g = window.__game;
    return {
      mode: g.mode?.name ?? null,
      trialFlag: Boolean(g._classTrial),
      reachFlag: Boolean(g._trialRun),
      rank: g.gate?.rank ?? null,
      encounterDriven: Boolean(g.world.encounterDriven),
      envIsArena: g.player.body.groundHeight(12, 34) === 0,
      shadows: g.shadows.length,
      enemies: g.enemies.length,
      objTitle: document.getElementById('objTitle')?.textContent ?? null,
      objCount: document.getElementById('objCount')?.textContent ?? null,
      state: g.state,
    };
  });
  report.inTrial = inTrial;
  ok(inTrial.mode === 'dungeon', `the trial did not mount a run (mode=${inTrial.mode})`);
  ok(inTrial.trialFlag, 'game._classTrial is not set inside the trial');
  ok(!inTrial.reachFlag, 'THE REACH flag armed for a level-40 trial run — canAscend leaked');
  ok(inTrial.rank === 'S', `the trial mounted rank ${inTrial.rank}, expected the S arena`);
  ok(!inTrial.encounterDriven, 'the trial mounted a crawl — forceOpen did not pin the arena');
  ok(inTrial.envIsArena, 'the player body is not on the flat arena environment');
  ok(inTrial.shadows === 0, `${inTrial.shadows} shadows fielded — the trial must be SOLO`);
  ok(inTrial.enemies > 0, 'the trial spawned no opening wave');
  ok(inTrial.objTitle === 'THE STAIR', `objective title is "${inTrial.objTitle}", expected THE STAIR`);
  ok(/^\d+:\d\d$/.test(inTrial.objCount || ''), `objective count "${inTrial.objCount}" is not an M:SS clock`);
  phase(`in the trial: ${inTrial.enemies} constructs, objective ${inTrial.objTitle} · ${inTrial.objCount}`);
  await page.screenshot({ path: shotPath('trial-01-descended.png') });

  // ------------------------------------- 3. survive past the 60 s tier line
  // God-moded, hand-stepped sim (the fight-test pattern): 1/30 s steps so 66
  // survived seconds cost ~2k frames. The RAF loop also ticks underneath —
  // harmless, it only adds real dt to the same clock being asserted.
  let surv = null;
  for (let guard = 0; guard < 40; guard++) {
    surv = await page.evaluate(() => {
      const g = window.__game;
      for (let i = 0; i < 120 && g.state === 'playing' && g.runTime < 66; i++) {
        g.player.hp = g.derived.maxHp;
        g.player.invuln = 3;
        g.update(1 / 30);
      }
      return {
        runTime: +g.runTime.toFixed(1),
        state: g.state,
        shadows: g.shadows.length,
        enemies: g.enemies.length,
        objCount: document.getElementById('objCount')?.textContent ?? null,
      };
    });
    if (surv.state !== 'playing' || surv.runTime >= 66) break;
  }
  report.survival = surv;
  ok(surv.state === 'playing', `the trial ended early at ${surv.runTime}s (state=${surv.state})`);
  ok(surv.runTime >= 66, `could not drive the sim past 66 s (reached ${surv.runTime}s)`);
  ok(surv.shadows === 0, `${surv.shadows} shadows appeared mid-trial — fielding is not suppressed`);
  ok(surv.enemies > 0, 'the escalating spawner went quiet mid-trial');
  ok(/^1:/.test(surv.objCount || ''), `after 66 s the clock reads "${surv.objCount}", expected 1:xx`);
  phase(`survived ${surv.runTime}s, ${surv.enemies} constructs on the field, clock ${surv.objCount}`);

  // ------------------------------------------------ the field ends the trial
  const ended = await page.evaluate(() => {
    const g = window.__game;
    const before = {
      points: g.save.points || 0,
      roster: g.save.shadows.roster.length,
      deaths: g.save.deaths || 0,
    };
    // Drop the god-mode and let the live wave kill the hunter — the REAL
    // death path (through _fail's trial reroute). Bounded so the run can
    // never idle across the 150 s sovereign line and flake the tier assert.
    for (let i = 0; i < 900 && g.state === 'playing' && g.runTime < 145; i++) {
      g.player.hp = Math.min(g.player.hp, 1);
      g.player.invuln = 0;
      g.update(1 / 30);
    }
    // A field that somehow never lands a hit still must not hang the tool:
    // _fail is the exact call both real death sites make, guard included.
    let forced = false;
    if (g.state === 'playing') { forced = true; g._fail(); }
    const secs = Math.floor(g.runTime);
    return {
      before, forced, secs,
      state: g.state,
      trialFlag: Boolean(g._classTrial),
      classTier: g.save.classTier ?? null,
      points: g.save.points || 0,
      roster: g.save.shadows.roster.length,
      deaths: g.save.deaths || 0,
      resultsVisible: !document.getElementById('results').classList.contains('hidden'),
      resultTitle: document.getElementById('resultTitle')?.textContent ?? null,
      resultBody: document.getElementById('resultBody')?.textContent ?? '',
      lastGatePortalId: g.lastGatePortalId ?? null,
    };
  });
  report.ended = ended;
  if (ended.forced) notes.push('the field never landed the killing hit inside the window; _fail() was called directly (same guarded path)');
  ok(ended.state === 'over', `the trial did not end (state=${ended.state})`);
  ok(!ended.trialFlag, 'game._classTrial survived the trial end');
  const expectTier = ended.secs >= 150 ? 'sovereign' : ended.secs >= 60 ? 'advanced' : 'base';
  ok(ended.classTier === expectTier,
    `survived ${ended.secs}s but classTier is "${ended.classTier}" (expected ${expectTier})`);
  ok(ended.classTier === 'advanced', `the tool drove past 60 s and under 150 s, yet tier=${ended.classTier}`);
  ok(ended.points === ended.before.points + 8,
    `points ${ended.before.points} -> ${ended.points}; awardClassTier's +8 did not land cleanly`);
  ok(ended.roster === ended.before.roster,
    `roster ${ended.before.roster} -> ${ended.roster}: the trial culled the company — the sanctioned death leaked into _fail`);
  ok(ended.deaths === ended.before.deaths,
    `deaths ${ended.before.deaths} -> ${ended.deaths}: the trial counted as a defeat`);
  ok(ended.resultsVisible, 'no ceremony panel after the trial');
  ok(ended.resultTitle === 'THE STAIR JUDGES', `ceremony title is "${ended.resultTitle}"`);
  ok(ended.resultBody.includes('ADVANCED'), 'the ceremony does not name the tier earned');
  ok(ended.resultBody.includes('YOUR CLASS BURNS BRIGHTER'), 'the ceremony is missing the class-quality consequence line');
  ok(ended.lastGatePortalId === 'trial-stair', `return address is ${ended.lastGatePortalId}, expected trial-stair`);
  phase(`judged: ${ended.secs}s -> ${ended.classTier}, +8 points, roster intact (${ended.roster})`);
  await page.screenshot({ path: shotPath('trial-02-ceremony.png') });

  // --------------------------------------- 4. back up the stair, door closed
  await page.click('#btnResultsOk');
  await page.waitForTimeout(400);
  if (await page.isVisible('#levelup')) {
    notes.push('the allocation panel interposed after the ceremony (the +8 points lit it — real flow)');
    await page.click('#btnStatsDone');
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(800);

  const back = await page.evaluate(() => {
    const g = window.__game;
    const c = g.mode?.city;
    const it = c?.interactables.find((x) => x.id === 'trial');
    const p = g.player.pos;
    return {
      mode: g.mode?.name ?? null,
      distToStair: it ? +Math.hypot(p.x - it.pos.x, p.z - it.pos.z).toFixed(2) : null,
    };
  });
  report.back = back;
  ok(back.mode === 'city', `CONTINUE did not return to the city (mode=${back.mode})`);
  ok(back.distToStair != null && back.distToStair < 12,
    `returned ${back.distToStair} m from the stair — expected to surface beside the Assay Hall`);

  const done = await promptAt('trial');
  const doneActed = await page.evaluate(() => window.__game.mode.confirmPrompt());
  report.done = { prompt: done.prompt, acted: doneActed };
  ok(done.prompt?.sub === 'THE STAIR REMEMBERS YOUR STEPS.',
    `a judged save should read the done line, read: "${done.prompt?.sub}"`);
  ok(doneActed === null, 'the stair let a judged hunter descend twice');
  phase(`back beside the stair (${back.distToStair} m); door reads: "${done.prompt?.sub}"`);

  // -------------------------- 5. THE REACH goes live (read-only verification)
  const reach = await page.evaluate(async () => {
    const g = window.__game;
    const { canAscend } = await import('/src/game/classes.js');
    const preLevel = canAscend(g.save);           // 40 + classTier: still short of 55
    g.save.level = 55;
    g.save.cleared.S = 300;                        // an S clear banked
    g.refreshDerived(true);
    g.mode.refreshPortalLocks();
    const live = canAscend(g.save);
    const c = g.mode.city;
    const s = c.portals.find((p) => p.rank === 'S' && !p.wild);
    g.player.body.reset(s.pos.x, c.heightAt(s.pos.x, s.pos.z), s.pos.z + 2);
    g.mode._updatePrompt();
    return { preLevel, live, prompt: g.mode.prompt, classTier: g.save.classTier };
  });
  report.reach = reach;
  ok(reach.preLevel === false, 'canAscend passed at level 40 — the level gate broke');
  ok(reach.live === true, 'classTier + level 55 + S clear still fails canAscend — the keystone did not unlock the endgame');
  ok(reach.prompt?.sub === 'THE REACH · THE ASCENSION TRIAL AWAITS',
    `the S portal does not carry THE REACH line for an eligible save (read: "${reach.prompt?.sub}")`);
  phase(`THE REACH is live: canAscend=${reach.live}, S portal reads "${reach.prompt?.sub}"`);
} catch (e) {
  fail.push(`THREW: ${e.message}\n${e.stack || ''}`);
} finally {
  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
  if (fatal.length) fail.push(`page errors:\n${fatal.join('\n')}`);
  report.pageErrors = fatal;
  report.notes = notes;
  report.failures = fail;
  const file = writeReport('trial-test', report);
  await browser.close();
  await server.stop();

  console.log(`\nreport: ${file}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (fail.length) {
    console.error(`\nTRIAL TEST FAILED (${fail.length})`);
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('\nTRIAL TEST PASSED — stair -> trial -> tier -> city; the Archon endgame is reachable');
}
