// tools/travel-test.mjs — Wave B5: the world becomes several places.
//
//   node tools/travel-test.mjs [--headed] [--no-shots]
//
// What it proves, in order, through the real app (title button, real thumb
// vector, real confirm button — the flow-test discipline):
//
//   0. STATIC: the settlement registry's world laws hold — portal ids are
//      unique across ALL settlements (return payloads cross town boundaries)
//      and every waygate's `to` names a real registry slug + a real placement
//      id there, reciprocally. Asserted in Node off the dependency-free
//      descriptor module, before a browser even launches.
//   1. PLAY lands in Threshold; the save says so (settlement/visited,
//      absent-means-default); the waygate stands beside the north gate,
//      unlocked, outside the rank ladder.
//   2. Walk to the waygate -> the prompt reads WAYGATE / TO EMBERFALL.
//   3. Confirm -> the mode rebuilds onto Emberfall (the existing
//      rebuild-per-transition flow): active slug flips, save.settlement is
//      written, save.visited grows, the player stands beside the RETURN
//      waygate, and exactly ONE city group exists in the scene — two
//      settlements never coexist.
//   4. The dungeon round trip STILL returns to the right settlement: enter
//      Emberfall's E gate, clear it via the same dev hook flow-test uses
//      (_killEnemy on everything the real spawner produces), CONTINUE ->
//      Emberfall, not Threshold, beside the gate used.
//   5. The second link: Emberfall's end waygate -> THE BIRCHREACH, and the
//      map gains the settlement dimension there (title, three switcher
//      chips, a remote chart from descriptor data, TRAVEL on a way pip).
//   6. Travel back down the chain -> Threshold byte-state: same portal
//      roster (ids AND positions match the first visit — the per-settlement
//      seed law), sane grounded spawn beside the north waygate.
//
// Determinism note: this tool draws no RNG of its own; every assertion is
// against state the app derived from its own seeded streams.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport, shotPath,
  forceOpenGates,
} from './_harness.mjs';
import { SETTLEMENTS } from '../src/world/settlements.js';

const argv = process.argv.slice(2);
const SHOTS = !argv.includes('--no-shots');
const HEADED = argv.includes('--headed');

const fail = [];
const notes = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); return Boolean(cond); };
let _t0 = Date.now();
const phase = (name) => {
  const now = Date.now();
  console.log(`  [${((now - _t0) / 1000).toFixed(1)}s] ${name}`);
  _t0 = now;
};

// ---------------------------------------------------------------- 0. static
// The registry's world laws, off the leaf data module (imports nothing, so
// Node can load it without THREE or a DOM).
{
  const seen = new Map();   // portal id -> slug
  for (const [slug, spec] of Object.entries(SETTLEMENTS)) {
    ok(spec.slug === slug, `registry key '${slug}' maps a descriptor whose slug is '${spec.slug}'`);
    ok(typeof spec.name === 'string' && spec.name.length > 0, `settlement '${slug}' has no display name`);
    for (const pl of spec.portals.placements) {
      ok(!seen.has(pl.id),
        `portal id '${pl.id}' is claimed by both '${seen.get(pl.id)}' and '${slug}' — ids are a WORLD-unique contract`);
      seen.set(pl.id, slug);
    }
  }
  for (const [slug, spec] of Object.entries(SETTLEMENTS)) {
    for (const pl of spec.portals.placements) {
      if (pl.kind !== 'way') continue;
      const dest = SETTLEMENTS[pl.to?.settlement];
      ok(Boolean(dest), `waygate '${pl.id}' points at unknown settlement '${pl.to?.settlement}'`);
      const target = dest?.portals.placements.find((q) => q.id === pl.to.portalId);
      ok(Boolean(target), `waygate '${pl.id}' points at missing portal '${pl.to?.portalId}' in '${pl.to?.settlement}'`);
      // Reciprocity: the destination waygate must link back, or a traveller
      // is stranded one confirm from home.
      ok(target && target.kind === 'way' && target.to?.settlement === slug && target.to?.portalId === pl.id,
        `waygate '${pl.id}' -> '${pl.to?.portalId}' is not reciprocal`);
    }
  }
  phase(`static registry laws: ${seen.size} unique portal ids across ${Object.keys(SETTLEMENTS).length} settlements`);
}
if (fail.length) {
  for (const f of fail) console.error(`  ✗ ${f}`);
  process.exit(1);
}

const server = await ensureServer();
// swiftshader:false, exactly as flow-test runs: the clear step needs the
// wave chain's spawn timers to advance in game time, and the software
// rasteriser's ~0.8 s frames starve them (measured: 90 s of wall clock
// never reached the boss).
const browser = await launchBrowser({ headless: !HEADED, swiftshader: false });
// LANDSCAPE — index.html's rotate gate covers the screen in portrait.
const { page, errors } = await newPhonePage(browser, { width: 900, height: 460, dpr: 1 });

const report = {};

/** One snapshot of the live city + save, taken inside the page. */
const snapshot = () => page.evaluate(() => {
  const g = window.__game;
  const c = g.mode?.city;
  const p = g.player.pos;
  let cityGroups = 0;
  g.scene.traverse((o) => { if (o.name === 'city' && o.parent === g.scene) cityGroups++; });
  return {
    mode: g.mode?.name ?? null,
    slug: c?.spec?.slug ?? null,
    built: Boolean(c?.built),
    cityGroups,
    saveSettlement: g.save?.settlement ?? null,
    visited: Array.isArray(g.save?.visited) ? [...g.save.visited] : null,
    player: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
    ground: c ? +c.heightAt(p.x, p.z).toFixed(2) : null,
    portals: c ? c.portals.map((q) => ({
      id: q.id, rank: q.rank, wild: Boolean(q.wild), locked: q.locked,
      way: q.way ? { ...q.way } : null,
      x: +q.pos.x.toFixed(2), z: +q.pos.z.toFixed(2),
    })) : [],
  };
});

/** Put the body N metres out along a portal's facing, then let it settle. */
const teleportBeside = (portalId, dist = 10) => page.evaluate(([id, d]) => {
  const g = window.__game;
  const city = g.mode.city;
  const portal = city.portals.find((q) => q.id === id);
  if (!portal) return { ok: false, reason: `no portal '${id}'` };
  const yaw = portal.group.rotation.y;
  const x = portal.pos.x + Math.sin(yaw) * d;
  const z = portal.pos.z + Math.cos(yaw) * d;
  g.player.body.reset(x, city.heightAt(x, z), z);
  g.player.mesh.position.copy(g.player.pos);
  return { ok: true, x: +x.toFixed(2), z: +z.toFixed(2) };
}, [portalId, dist]);

/**
 * flow-test's walker: drive the real input vector until THE TARGET's prompt
 * shows. Keyed on portalId, not on "any prompt": arriving through a waygate
 * legitimately leaves the player inside the RETURN gate's prompt zone, so a
 * break-on-anything walker would grab that prompt one frame after a teleport
 * (before _updatePrompt has recomputed) and then confirm a button that has
 * already cleared — the exact race the first run of this suite hit.
 */
async function walkTo(page, tx, tz, { expectId = null, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(([gx, gz]) => {
      const g = window.__game;
      const p = g.player.pos;
      const dx = gx - p.x, dz = gz - p.z;
      const d = Math.hypot(dx, dz);
      g.input.move.x = d > 0.001 ? dx / d : 0;
      g.input.move.y = d > 0.001 ? -dz / d : 0;
      return { d, prompt: g.mode?.prompt || null };
    }, [tx, tz]);
    const p = last.prompt;
    if (p && (!expectId || p.portalId === expectId || p.id === expectId)) break;
    if (last.d < 1.5) break;
    await page.waitForTimeout(110);
  }
  await page.evaluate(() => {
    window.__game.input.move.x = 0;
    window.__game.input.move.y = 0;
  });
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__game.mode?.prompt || null);
}

/** Walk into a portal's prompt zone and press the real confirm button. */
async function confirmAtPortal(page, portalId) {
  const spot = await teleportBeside(portalId, 10);
  ok(spot.ok, `teleportBeside failed: ${spot.reason}`);
  // One beat for _updatePrompt to digest the teleport, so a stale prompt from
  // wherever we stood before cannot leak into the walk below.
  await page.waitForTimeout(300);
  const target = await page.evaluate((id) => {
    const q = window.__game.mode.city.portals.find((p) => p.id === id);
    return { x: q.pos.x, z: q.pos.z };
  }, portalId);
  const prompt = await walkTo(page, target.x, target.z, { expectId: portalId });
  // The confirm is only pressable while the prompt is live ('on'); asserting
  // that here turns "walked into the zone" and "the button armed" into one
  // failure instead of a silent 30 s click timeout.
  await page.waitForFunction(
    () => document.getElementById('cityConfirm')?.classList.contains('on'),
    null, { timeout: 5000 },
  ).catch(() => {});
  // Dispatch the click from inside the page: a confirm kicks off a synchronous
  // world build (dungeon or destination settlement) that blocks the main
  // thread for seconds under SwiftShader, and Playwright's post-click
  // "scheduled navigations" bookkeeping times out on exactly that stall even
  // though the click landed (measured on this suite's first runs).
  const clicked = await page.evaluate(() => {
    const b = document.getElementById('cityConfirm');
    if (!b || !b.classList.contains('on')) return false;
    b.click();
    return true;
  });
  ok(clicked, `the confirm button never armed at the '${portalId}' prompt`);
  return prompt;
}

/** flow-test's dev hook: kill everything the real spawner produces. */
async function clearGate(page, { timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  let state = 'playing';
  let killed = 0;
  while (Date.now() < t0 + timeoutMs) {
    const st = await page.evaluate(() => {
      const g = window.__game;
      for (const e of [...g.enemies]) {
        if (e.spawning > 0) e.spawning = 0;
        g._killEnemy(e);
      }
      return { state: g.state, killed: g.killed };
    });
    state = st.state;
    killed = st.killed;
    if (state === 'over') break;
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(600);
  return { over: state === 'over', state, killed, seconds: (Date.now() - t0) / 1000 };
}

const waitForSlug = (slug) => page
  .waitForFunction((s) => {
    const g = window.__game;
    return g?.mode?.name === 'city' && g.mode.city?.built && g.mode.city.spec.slug === s;
  }, slug, { timeout: 45000 })
  .catch(() => {});

try {
  await gotoGame(page, { waitMs: 2000 });
  // Arena-behaviour override, exactly as flow-test does it: pin the flat
  // arena for the E gate so the clear hook below (kill everything the real
  // spawner produces) drives the wave chain to the boss without walking a
  // crawl layout — this suite is about WHERE the round trip returns, not
  // about dungeon traversal.
  await forceOpenGates(page);
  phase('booted to title');

  // ------------------------------------------------------------ 1. Threshold
  await page.click('#btnPlay');
  await waitForSlug('threshold');
  // RETARGET 2026-08-26: tap through the first-arrival welcome overlay
  // (save.welcomed) — it owns every click while open. See _harness.dismissDialog.
  await page.evaluate(() => { const d = window.__game?.dialog; for (let i = 0; d?.open && i < 12; i++) d.advance(); });
  await page.waitForTimeout(800);
  const home = await snapshot();
  report.home = home;
  ok(home.mode === 'city' && home.slug === 'threshold', `PLAY landed in ${home.slug} (mode ${home.mode})`);
  ok(home.cityGroups === 1, `${home.cityGroups} city groups in the scene — must be exactly 1`);
  ok(home.saveSettlement === 'threshold', `save.settlement is '${home.saveSettlement}' — the absent-means-default migration should read 'threshold'`);
  ok(Array.isArray(home.visited) && home.visited.includes('threshold'),
    `save.visited is ${JSON.stringify(home.visited)} — must include 'threshold'`);
  const homeWay = home.portals.find((p) => p.id === 'way-threshold-north');
  ok(Boolean(homeWay), 'Threshold has no way-threshold-north portal');
  ok(homeWay && !homeWay.locked && homeWay.rank === null,
    `the waygate must be rankless and never locked: ${JSON.stringify(homeWay)}`);
  ok(homeWay && homeWay.way?.toSettlement === 'emberfall' && homeWay.way?.toPortalId === 'way-emberfall-green',
    `waygate payload wrong: ${JSON.stringify(homeWay?.way)}`);
  phase(`in Threshold: ${home.portals.length} portals (${home.portals.filter((p) => p.wild).length} wild)`);

  // ------------------------------------------- 2 + 3. Threshold -> Emberfall
  const wayPrompt = await confirmAtPortal(page, 'way-threshold-north');
  report.wayPrompt = wayPrompt;
  ok(wayPrompt && wayPrompt.kind === 'portal' && wayPrompt.label === 'WAYGATE',
    `expected the WAYGATE prompt, got ${JSON.stringify(wayPrompt)}`);
  ok(wayPrompt && wayPrompt.sub === 'TO EMBERFALL',
    `the waygate sub must name the destination; got '${wayPrompt?.sub}'`);
  await waitForSlug('emberfall');
  await page.waitForTimeout(800);
  const ember = await snapshot();
  report.ember = ember;
  ok(ember.slug === 'emberfall', `travel landed in '${ember.slug}'`);
  ok(ember.cityGroups === 1, `${ember.cityGroups} city groups after travel — two settlements may never coexist`);
  ok(ember.saveSettlement === 'emberfall', `save.settlement not written on arrival ('${ember.saveSettlement}')`);
  ok(ember.visited?.includes('emberfall') && ember.visited?.includes('threshold'),
    `save.visited did not grow: ${JSON.stringify(ember.visited)}`);
  const emberReturn = ember.portals.find((p) => p.id === 'way-emberfall-green');
  ok(Boolean(emberReturn), 'Emberfall has no way-emberfall-green return gate');
  const dToReturn = emberReturn
    ? Math.hypot(ember.player.x - emberReturn.x, ember.player.z - emberReturn.z) : Infinity;
  ok(dToReturn < 9, `arrived ${dToReturn.toFixed(1)} m from the return waygate — spawn must be beside it`);
  ok(Math.abs(ember.player.y - ember.ground) < 0.6,
    `arrival spawn floats ${(ember.player.y - ember.ground).toFixed(2)} m off the ground`);
  ok(ember.portals.filter((p) => !p.wild && !p.way).length === 2,
    'Emberfall should hold exactly its two rank gates');
  ok(ember.portals.filter((p) => p.way).length === 2,
    'Emberfall should hold exactly two waygates (green + village end)');
  if (SHOTS) { const f = shotPath('travel-emberfall-arrival.png'); await page.screenshot({ path: f }); }
  phase(`travelled to Emberfall, ${dToReturn.toFixed(1)} m from the return waygate`);

  // ------------------------------- 4. the dungeon round trip stays settled
  const gatePrompt = await confirmAtPortal(page, 'green-e');
  ok(gatePrompt && gatePrompt.kind === 'portal' && gatePrompt.rank === 'E',
    `expected the E gate prompt in Emberfall, got ${JSON.stringify(gatePrompt)}`);
  await page.waitForFunction(() => window.__game?.mode?.name === 'dungeon', null, { timeout: 30000 }).catch(() => {});
  ok(await page.evaluate(() => window.__game.mode?.name === 'dungeon'), 'confirming the E gate did not mount the dungeon');
  phase('entered the E gate from Emberfall');

  const cleared = await clearGate(page);
  report.clear = cleared;
  ok(cleared.over, `the gate never resolved (state=${cleared.state}, killed=${cleared.killed})`);
  await page.click('#btnResultsOk');
  await page.waitForTimeout(500);
  if (await page.isVisible('#levelup')) {
    notes.push('the allocation panel interposed after the clear (expected on a level-up)');
    await page.click('#btnStatsDone');
    await page.waitForTimeout(400);
  }
  await waitForSlug('emberfall');
  await page.waitForTimeout(800);
  const back = await snapshot();
  report.dungeonReturn = back;
  ok(back.slug === 'emberfall',
    `the dungeon round trip returned to '${back.slug}' — it must return to the settlement the gate was entered from`);
  const greenE = back.portals.find((p) => p.id === 'green-e');
  const dBack = greenE ? Math.hypot(back.player.x - greenE.x, back.player.z - greenE.z) : Infinity;
  ok(dBack < 12, `returned ${dBack.toFixed(1)} m from green-e — expected beside the gate used`);
  phase(`cleared the gate and returned to Emberfall (${cleared.killed} kills, ${dBack.toFixed(1)} m from green-e)`);

  // --------------------------------- 5. Emberfall -> THE BIRCHREACH + map
  const birchPrompt = await confirmAtPortal(page, 'way-emberfall-end');
  ok(birchPrompt && birchPrompt.label === 'WAYGATE' && birchPrompt.sub === 'TO THE BIRCHREACH',
    `expected TO THE BIRCHREACH, got ${JSON.stringify(birchPrompt)}`);
  await waitForSlug('birchreach');
  await page.waitForTimeout(800);
  const birch = await snapshot();
  report.birch = birch;
  ok(birch.slug === 'birchreach', `second link landed in '${birch.slug}'`);
  ok(birch.visited?.length === 3, `visited should hold all three settlements: ${JSON.stringify(birch.visited)}`);
  const birchReturn = birch.portals.find((p) => p.id === 'way-birchreach-trail');
  const dBirch = birchReturn
    ? Math.hypot(birch.player.x - birchReturn.x, birch.player.z - birchReturn.z) : Infinity;
  ok(dBirch < 9, `arrived ${dBirch.toFixed(1)} m from the trailhead waygate`);
  if (SHOTS) { const f = shotPath('travel-birchreach-arrival.png'); await page.screenshot({ path: f }); }
  phase(`travelled to THE BIRCHREACH, ${dBirch.toFixed(1)} m from the trail waygate`);

  // The map's settlement dimension, exercised where all three towns are known.
  const map = await page.evaluate(() => {
    const g = window.__game;
    g.mapUI.open();
    const title = document.querySelector('#map h2')?.textContent ?? null;
    const chips = [...document.querySelectorAll('#map .map-towns button')].map((b) => ({
      label: b.textContent, active: b.classList.contains('active'),
    }));
    // Tap the active view's way pip: the TRAVEL affordance must exist.
    const way = g.mode.city.portals.find((p) => p.way);
    let travelBtn = false;
    let footer = null;
    if (way) {
      g.mapUI._describe(way);
      travelBtn = Boolean(document.querySelector('#map .map-foot .map-travel'));
      footer = document.querySelector('#map .map-foot')?.textContent ?? null;
    }
    // Switch to a remote settlement: chart must come from descriptor data.
    const emberChip = [...document.querySelectorAll('#map .map-towns button')]
      .find((b) => b.textContent === 'EMBERFALL');
    emberChip?.click();
    const remoteTitle = document.querySelector('#map h2')?.textContent ?? null;
    const remotePips = document.querySelectorAll('#map .map-chart .pip').length;
    g.mapUI.close();
    return { title, chips, travelBtn, footer, remoteTitle, remotePips };
  });
  report.map = map;
  ok(map.title === 'THE BIRCHREACH', `map title is '${map.title}', expected the ACTIVE settlement`);
  ok(map.chips.length === 3, `settlement switcher has ${map.chips.length} chips, expected 3 (all visited)`);
  ok(map.chips.filter((c) => c.active).length === 1 && map.chips.find((c) => c.active)?.label === 'THE BIRCHREACH',
    `the active chip must be the active settlement: ${JSON.stringify(map.chips)}`);
  ok(map.travelBtn, `the way pip in the active view carries no TRAVEL button (footer: '${map.footer}')`);
  ok(map.remoteTitle === 'EMBERFALL', `remote view titled '${map.remoteTitle}'`);
  ok(map.remotePips === 4, `Emberfall's remote chart shows ${map.remotePips} pips, expected its 4 placements`);
  phase('map: settlement switcher + remote chart + TRAVEL affordance');

  // ------------------------------------ 6. back down the chain to Threshold
  await confirmAtPortal(page, 'way-birchreach-trail');
  await waitForSlug('emberfall');
  await page.waitForTimeout(600);
  await confirmAtPortal(page, 'way-emberfall-green');
  await waitForSlug('threshold');
  await page.waitForTimeout(800);
  const home2 = await snapshot();
  report.homeAgain = home2;
  ok(home2.slug === 'threshold' && home2.saveSettlement === 'threshold',
    `the way home landed in '${home2.slug}' (save '${home2.saveSettlement}')`);
  ok(home2.cityGroups === 1, `${home2.cityGroups} city groups after the round trip`);
  // Byte-state: the per-settlement seed law says a rebuilt Threshold is THE
  // SAME Threshold — same portal roster, same ids, same positions.
  const rosterOf = (s) => s.portals.map((p) => `${p.id}@${p.x},${p.z}`).sort().join('|');
  ok(rosterOf(home2) === rosterOf(home),
    `Threshold's portal roster changed across the round trip:\n  was ${rosterOf(home)}\n  now ${rosterOf(home2)}`);
  const homeWay2 = home2.portals.find((p) => p.id === 'way-threshold-north');
  const dHome = homeWay2
    ? Math.hypot(home2.player.x - homeWay2.x, home2.player.z - homeWay2.z) : Infinity;
  ok(dHome < 9, `arrived home ${dHome.toFixed(1)} m from the north waygate`);
  ok(Math.abs(home2.player.y - home2.ground) < 0.6,
    `home spawn floats ${(home2.player.y - home2.ground).toFixed(2)} m off the ground`);
  if (SHOTS) { const f = shotPath('travel-threshold-return.png'); await page.screenshot({ path: f }); }
  phase(`home again: roster byte-stable, ${dHome.toFixed(1)} m from the waygate`);
} catch (e) {
  fail.push(`THREW: ${e.message}\n${e.stack || ''}`);
} finally {
  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
  if (fatal.length) fail.push(`page errors:\n${fatal.join('\n')}`);
  report.pageErrors = fatal;
  report.notes = notes;
  report.failures = fail;
  const file = writeReport('travel-test', report);
  await browser.close();
  await server.stop();

  console.log(`\nreport: ${file}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (fail.length) {
    console.error(`\nTRAVEL TEST FAILED (${fail.length})`);
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('\nTRAVEL TEST PASSED — threshold <-> emberfall <-> birchreach, dungeon round trip settled, map gained the settlement dimension');
}
