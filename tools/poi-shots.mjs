// tools/poi-shots.mjs — human-pass framings of WORLD_SPEC step 7's POIs.
//
//   GB_PORT=<port> GB_OUT=<dir> node tools/poi-shots.mjs
//
// Not an assertion tool. frontier-test proves the POIs exist, sit inside the
// rules, collide and route through the gate flow; nothing it can assert answers
// "is this worth walking to", and that question is the whole point of the step.
// Each view is framed from where a player actually arrives — eye height, on the
// approach line from town — plus one bird's-eye per stamp.

import {
  launchBrowser, newPhonePage, ensureServer, gotoGame, shotPath,
} from './_harness.mjs';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const SWIFTSHADER = argv.includes('--swiftshader');

const server = await ensureServer();
const browser = await launchBrowser({ headless: !HEADED, swiftshader: SWIFTSHADER });
const { page } = await newPhonePage(browser, { width: 900, height: 520, dpr: 1 });

try {
  await gotoGame(page, { waitMs: 1800 });

  const info = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const cityMod = await import('/src/world/city.js');
    const kit = await import('/src/world/citykit.js');
    const nature = await import('/src/world/naturekit.js');
    const { Quality } = await import('/src/core/quality.js');
    await kit.loadCityKit();
    await nature.loadNatureKit();

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999';
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.6, 900);
    const city = new cityMod.City(scene, renderer, camera, new Quality({ startTier: 'high' }));
    city.build(20260806, { level: 60 });
    window.__ps = { THREE, renderer, scene, camera, city };
    return city.frontier.pois.map((p) => ({
      id: p.id, x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2),
    }));
  });
  console.log(JSON.stringify(info, null, 1));

  const shoot = async (name, pos, look, t = 0) => {
    await page.evaluate(({ pos, look, t }) => {
      const { renderer, scene, camera, city } = window.__ps;
      city.update(t, new THREE.Vector3(pos[0], pos[1], pos[2]));
      camera.position.set(pos[0], pos[1], pos[2]);
      camera.lookAt(look[0], look[1], look[2]);
      camera.updateMatrixWorld();
      if (city.sky) { city.sky.position.set(pos[0], 0, pos[2]); city.sky.updateMatrix(); }
      renderer.render(scene, camera);
    }, { pos, look, t }).catch(async () => {
      // THREE is module-scoped inside the first evaluate; re-read it from __ps.
      await page.evaluate(({ pos, look }) => {
        const { THREE, renderer, scene, camera, city } = window.__ps;
        camera.position.set(pos[0], pos[1], pos[2]);
        camera.lookAt(look[0], look[1], look[2]);
        camera.updateMatrixWorld();
        city.update(0.016, new THREE.Vector3(pos[0], pos[1], pos[2]));
        if (city.sky) { city.sky.position.set(pos[0], 0, pos[2]); city.sky.updateMatrix(); }
        renderer.render(scene, camera);
      }, { pos, look });
    });
    const file = shotPath(`${name}.png`);
    await page.screenshot({ path: file });
    console.log(`shot ${name} -> ${file}`);
  };

  const at = (id) => info.find((p) => p.id === id);
  // Eye-level, standing on the approach line from town, ~26 m out — the frame
  // a player gets as he arrives.
  const approach = (p, d = 26, h = 2.4) => {
    const len = Math.hypot(p.x, p.z) || 1;
    return [p.x - (p.x / len) * d, p.y + h, p.z - (p.z / len) * d];
  };
  for (const id of ['verge_ruin_arch', 'verge_ruin_hall', 'verge_watchtower',
    'camp_hunters_east', 'camp_farmstead', 'wildgate_e', 'wildgate_c']) {
    const p = at(id);
    await shoot(`poi-${id.replace(/_/g, '-')}`, approach(p), [p.x, p.y + 2.2, p.z]);
    await shoot(`poi-${id.replace(/_/g, '-')}-air`,
      [p.x - 22, p.y + 26, p.z - 22], [p.x, p.y, p.z]);
  }
  // The postcard claim: the sunken arch seen from the EAST GATE mouth (x = 88
  // is the wall line), not from the plaza — the plaza's own A portal stands in
  // the way and that is by design.
  const arch = at('verge_ruin_arch');
  await shoot('poi-east-gate-sightline', [92, 3.2, 0], [arch.x, arch.y + 2, arch.z]);
  // And the wild E gate seen from halfway out, which is the "worth walking to"
  // question in one frame.
  const we = at('wildgate_e');
  await shoot('poi-wildgate-e-far', [we.x * 0.45, 8, we.z * 0.45], [we.x, we.y + 3, we.z]);
} finally {
  await browser.close();
  await server.stop();
}
