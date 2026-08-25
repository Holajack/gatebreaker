// tools/talk-smoke.mjs — C-TALK's doorstep check: the towns speak.
//
//   node tools/talk-smoke.mjs [--headed] [--swiftshader]
//
// The whole loop, through the real mode and the real DialogUI, no shortcuts:
//
//   1. PLAY -> city. Stand in the talk band beside the Assay Hall desk and
//      assert ASSAYER VEYRA offers a word (kind:'talk'), while standing AT
//      the door still yields the shipped 'interact' prompt — the band must
//      never eat the panel flow flow-test asserts by name.
//   2. Confirm -> game.dialog opens with her act1 line, and (fresh save) the
//      last line surfaces her active contract (a1_first_assay, THE FIRST
//      ASSAY) — quest-giver surfacing is a line, not a mechanic.
//   3. Tap through -> dialog closed, mode still 'city', prompt scan alive.
//   4. The barracks door (open:false, panel-less) prompts as WATCH-CAPTAIN
//      BRANN, and his line PIVOTS when the ledger says a1_bind_three is done
//      (the approval arc's first beat) — act-state gating proven off the
//      same save.quests the journal reads.
//
// Logic-only assertions, so SwiftShader is optional exactly as in flow-test.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, writeReport,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
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
// LANDSCAPE — the rotate gate swallows pointer events in portrait.
const { page, errors } = await newPhonePage(browser, { width: 900, height: 460, dpr: 1 });

const report = {};

try {
  await gotoGame(page, { waitMs: 1600 });
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.__game?.mode?.name === 'city', null, { timeout: 30000 });
  await page.waitForTimeout(900);
  phase('booted into the city');

  // ---------------------------------------------- 1. Veyra's talk band
  const stand = await page.evaluate(() => {
    const g = window.__game;
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'assay');
    // AT the door first: the shipped interact prompt must survive C-TALK.
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    const atDoor = g.mode.prompt;
    // Then the band: an annulus outside the radius. Geometry (the C portal's
    // prompt zone to the north, the trial stair to the south-west) makes some
    // bearings dead by DESIGN — portal > door > talk — so probe the circle
    // instead of hardcoding one lucky angle.
    let band = null, angle = null;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = it.radius + 1.1;
      const x = it.pos.x + Math.sin(a) * r;
      const z = it.pos.z + Math.cos(a) * r;
      g.player.body.reset(x, c.heightAt(x, z), z);
      g.mode._updatePrompt();
      const p = g.mode.prompt;
      if (p?.kind === 'talk' && p.persona === 'veyra') { band = p; angle = a; break; }
    }
    return { atDoor, band, angle };
  });
  report.veyraPrompt = stand;
  ok(stand.atDoor?.kind === 'interact', 'standing AT the Assay door no longer yields the shipped interact prompt');
  ok(Boolean(stand.band), 'no bearing on the Assay talk band offered ASSAYER VEYRA');
  ok(stand.band?.label === 'ASSAYER VEYRA', `talk prompt label reads "${stand.band?.label}"`);
  phase(`Veyra offers a word at bearing ${stand.angle?.toFixed(2)} rad ("${stand.band?.label} / ${stand.band?.sub}")`);

  // ------------------------------------- 2. confirm -> dialog, giver line
  const talked = await page.evaluate(() => {
    const g = window.__game;
    const acted = g.mode.confirmPrompt();
    const script = g.dialog?._script || null;
    return {
      acted,
      open: Boolean(g.dialog?.open),
      speaker: script?.speaker ?? null,
      lines: script?.lines ?? [],
      dialogVisible: !document.getElementById('dialog')?.classList.contains('hidden'),
      speakerText: document.querySelector('#dialog .dlg-speaker')?.textContent ?? null,
    };
  });
  report.veyraTalk = talked;
  ok(talked.acted?.action === 'talk' && talked.acted?.persona === 'veyra',
    `confirm returned ${JSON.stringify(talked.acted)}, expected {action:'talk', persona:'veyra'}`);
  ok(talked.open && talked.dialogVisible, 'confirming the talk prompt did not open the dialogue overlay');
  ok(talked.speakerText === 'ASSAYER VEYRA', `overlay speaker reads "${talked.speakerText}"`);
  ok(talked.lines.length >= 2, `Veyra spoke ${talked.lines.length} lines, expected her act lines`);
  // Fresh save: a1_first_assay (giver: veyra) is active, so the LAST line
  // must name the contract — the giver-surfacing rule.
  ok(/THE FIRST ASSAY/.test(talked.lines[talked.lines.length - 1] || ''),
    `Veyra's last line does not surface her active contract: "${talked.lines[talked.lines.length - 1]}"`);
  phase(`dialog open: ${talked.lines.length} lines, last surfaces THE FIRST ASSAY`);

  // ----------------------------------------------- 3. tap through, city intact
  const closed = await page.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 10 && g.dialog.open; i++) g.dialog.advance();
    g.mode._updatePrompt();
    return {
      open: g.dialog.open,
      hidden: document.getElementById('dialog').classList.contains('hidden'),
      mode: g.mode?.name ?? null,
      state: g.state,
      promptAlive: g.mode.prompt !== undefined,
    };
  });
  report.closed = closed;
  ok(!closed.open && closed.hidden, 'tapping through did not close the dialogue');
  ok(closed.mode === 'city' && closed.state === 'playing', `city not intact after the chat (mode=${closed.mode}, state=${closed.state})`);
  phase('tapped through; city intact');

  // ------------------------------- 4. Brann at the barracks, act-state pivot
  const brann = await page.evaluate(() => {
    const g = window.__game;
    const c = g.mode.city;
    const it = c.interactables.find((x) => x.id === 'barracks');
    if (!it) return { noDoor: true };
    g.player.body.reset(it.pos.x, c.heightAt(it.pos.x, it.pos.z), it.pos.z);
    g.mode._updatePrompt();
    const prompt = g.mode.prompt;
    const openLines = (() => {
      g.mode.confirmPrompt();
      const l = g.dialog?._script?.lines?.slice() ?? [];
      while (g.dialog.open) g.dialog.advance();
      return l;
    })();
    // Flip the approval beat in the ledger and ask again — the same
    // absent-means-default save.quests shape quests.js owns.
    const before = g.save.quests;
    g.save.quests = { done: { a1_bind_three: Date.now() }, progress: {} };
    g.mode._updatePrompt();
    g.mode.confirmPrompt();
    const afterLines = g.dialog?._script?.lines?.slice() ?? [];
    while (g.dialog.open) g.dialog.advance();
    g.save.quests = before;   // leave the save as found
    return { prompt, openLines, afterLines };
  });
  report.brann = brann;
  ok(!brann.noDoor, 'the barracks interactable record is gone — talk-door table has nothing to stand at');
  ok(brann.prompt?.kind === 'talk' && brann.prompt?.persona === 'brann',
    `the barracks door offers ${JSON.stringify(brann.prompt)}, expected Brann's talk prompt`);
  ok(brann.openLines?.length >= 2, 'Brann had no act1 lines');
  ok(brann.afterLines?.length >= 2 && brann.afterLines[0] !== brann.openLines[0],
    'Brann\'s line did not pivot when a1_bind_three completed (the approval arc\'s first beat)');
  notes.push(`brann act1: "${brann.openLines?.[0]}"`);
  notes.push(`brann act1b: "${brann.afterLines?.[0]}"`);
  phase('Brann speaks, and the ledger changes his mind');

  // --------------------------- 5. the crowd: Maren at a camp, ambient street
  const crowd = await page.evaluate(async () => {
    const g = window.__game;
    const c = g.mode.city;
    const cz = c.citizens;
    const { STRINGS } = await import('/src/game/strings.js');
    const pool = STRINGS['talk.hunter.pool'];
    const standAt = (n) => {
      // Beside the body, not on it: resolve() would shove the player off.
      g.player.body.reset(n.pos.x + 1.2, c.heightAt(n.pos.x + 1.2, n.pos.z), n.pos.z);
      g.mode._updatePrompt();
      return g.mode.prompt;
    };
    const chat = () => {
      g.mode.confirmPrompt();
      const s = g.dialog?._script;
      const out = { speaker: s?.speaker ?? null, lines: s?.lines?.slice() ?? [] };
      while (g.dialog.open) g.dialog.advance();
      return out;
    };
    // A Verge camp hunter -> Maren. Camps are tier-gated (none on 'low'), so
    // their absence is a skip, not a failure — citylife-test owns proving the
    // camps populate.
    let maren = null;
    const camper = cz?.campers?.find((n) => n.hunter && n.root.visible);
    if (camper) maren = { prompt: standAt(camper), ...chat() };
    // A wandering street hunter -> the ambient pool, one line per chat,
    // rotating (two chats, different lines).
    let street = null;
    const walker = cz?.npcs?.find((n) => n.hunter && !n.station && !n.companion
      && n.beat === 0 && n.root.visible);
    if (walker) {
      const prompt = standAt(walker);
      const first = chat();
      g.mode._updatePrompt();
      const second = chat();
      street = { prompt, first, second };
    }
    return { maren, street, pool, camps: cz?.campers?.length ?? 0 };
  });
  report.crowd = crowd;
  if (crowd.maren) {
    ok(crowd.maren.prompt?.kind === 'talk' && crowd.maren.prompt?.persona === 'maren',
      `a camp hunter offers ${JSON.stringify(crowd.maren.prompt)}, expected Maren`);
    ok(crowd.maren.speaker === 'MAREN' && crowd.maren.lines.length >= 2,
      `Maren spoke as "${crowd.maren.speaker}" with ${crowd.maren.lines.length} lines`);
    // Fresh save + a1_first_assay incomplete: her a1_walk_the_verge is still
    // locked, so no giver line — her lines are exactly her act lines.
  } else {
    notes.push(`no visible camp hunter to talk to (campers=${crowd.camps}) — camp persona skipped`);
  }
  if (crowd.street) {
    ok(crowd.street.prompt?.kind === 'talk' && crowd.street.prompt?.persona === 'hunter',
      `a street hunter offers ${JSON.stringify(crowd.street.prompt)}, expected the ambient persona`);
    ok(crowd.street.first.lines.length === 1 && crowd.pool.includes(crowd.street.first.lines[0]),
      `ambient chat did not serve one pool line: ${JSON.stringify(crowd.street.first.lines)}`);
    ok(crowd.street.second.lines[0] !== crowd.street.first.lines[0],
      'two consecutive ambient chats repeated the same line — the rotation is dead');
  } else {
    notes.push('no eligible street hunter at this instant — ambient persona skipped');
  }
  phase(`crowd: maren=${crowd.maren ? 'talked' : 'skip'}, ambient=${crowd.street ? 'rotated' : 'skip'}`);
} catch (e) {
  fail.push(`THREW: ${e.message}\n${e.stack || ''}`);
} finally {
  const fatal = errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
  if (fatal.length) fail.push(`page errors:\n${fatal.join('\n')}`);
  report.pageErrors = fatal;
  report.notes = notes;
  report.failures = fail;
  const file = writeReport('talk-smoke', report);
  await browser.close();
  await server.stop();

  console.log(`\nreport: ${file}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (fail.length) {
    console.error(`\nTALK SMOKE FAILED (${fail.length})`);
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('\nTALK SMOKE PASSED — prompt -> confirm -> dialog -> closed, city intact');
}
