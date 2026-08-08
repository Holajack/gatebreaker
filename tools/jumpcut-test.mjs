// Reproduces the tap-jump height bug: a press-and-release (what a phone player
// actually does) must not be cut to a fraction of a held jump.
//
//   node tools/jumpcut-test.mjs

import { launchBrowser, newPhonePage, ensureServer, gotoGame, enterGate, evalGame, writeReport, forceOpenGates } from './_harness.mjs';

const server = await ensureServer();
const browser = await launchBrowser();
const { page, errors } = await newPhonePage(browser, { width: 892, height: 412 });

await gotoGame(page, { waitMs: 3500 });
// Arena-behaviour tool: pin the flat arena for E/D via the sanctioned
// forceOpen dev override (see _harness.forceOpenGates).
await forceOpenGates(page);
await enterGate(page, { waitMs: 1500 });

const r = await evalGame(page, (g) => {
  const p = g.player;
  const body = p.body;
  body.setEnvironment(() => 0, null);
  const apexOf = (releaseAfterFrames) => {
    body.reset(0, 0, 0); p.vel.set(0, 0, 0);
    body.jump(); body.setJumpHeld(true);
    let apex = 0;
    for (let i = 0; i < 240; i++) {
      if (i >= releaseAfterFrames) body.setJumpHeld(false);
      body.move(0, 0, 0); body.step(1 / 60);
      apex = Math.max(apex, p.pos.y);
      if (i > 3 && body.grounded) break;
    }
    return +apex.toFixed(3);
  };
  return {
    heldFull: apexOf(9999),
    releasedAt12: apexOf(12),
    releasedAt4: apexOf(4),
    tapReleasedAt0: apexOf(0),
  };
});

console.log(JSON.stringify(r, null, 2));
console.log('ERRORS:', errors.length ? errors.join('\n') : '(none)');
console.log('report:', writeReport('jumpcut-test', { result: r, errors }));
await browser.close();
await server.stop();
process.exit(errors.length ? 1 : 0);
