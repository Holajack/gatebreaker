// Gate for build-order step 13: prove the committed item pack is actually
// usable, not merely present.
//
//   node tools/items-verify.mjs
//
// This exists because BOTH of the ways this pipeline fails are silent. A GLB
// whose node names gltfpack stripped loads without error and renders; every
// getObjectByName in the game just returns null. A multi-scene GLB likewise
// loads fine and shows exactly one of its 106 models. Neither shows up as an
// exception, so they have to be asserted.
//
// The parse runs through the SAME GLTFLoader + MeshoptDecoder pair the game
// uses, so a decoder mismatch fails here rather than on a phone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB = path.join(ROOT, 'public', 'models', 'items.glb');
const ATLAS = path.join(ROOT, 'public', 'models', 'icons.webp');
const INDEX = path.join(ROOT, 'public', 'models', 'icons.json');

const EXPECT_MODELS = 106;
const MUST_RESOLVE = ['Sword', 'Chest_Open', 'Armor_Black'];

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
};

// ------------------------------------------------------------------- GLB
if (!fs.existsSync(GLB)) {
  console.log(`FAIL  public/models/items.glb exists  — missing. Run: node tools/build-items-glb.mjs`);
  process.exit(1);
}
const bytes = fs.statSync(GLB).size;
const buf = fs.readFileSync(GLB);

const gltf = await new Promise((resolve, reject) => {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    '',
    resolve,
    reject,
  );
});

check('items.glb parses through GLTFLoader + MeshoptDecoder', true, `${(bytes / 1024).toFixed(1)} KB`);
check('exactly one scene', gltf.scenes.length === 1,
  `${gltf.scenes.length} scene(s) — three.js only ever renders scenes[0]`);

const roots = gltf.scene.children;
check(`${EXPECT_MODELS} named scene roots`, roots.length === EXPECT_MODELS, `got ${roots.length}`);

const unnamed = roots.filter((o) => !o.name);
check('no root lost its name', unnamed.length === 0,
  `${unnamed.length} unnamed — this is the gltfpack "-kn missing" failure`);

const suffixed = roots.filter((o) => /\d{3}$/.test(o.name) && !/^(Potion|Book|Key|Ring|Crystal|Coin|Skull|Snowflake|Crown|Necklace|Armor|Hammer)/.test(o.name));
check('no Blender name-collision suffixes (Sword001)', suffixed.length === 0,
  suffixed.map((o) => o.name).join(', '));

for (const n of MUST_RESOLVE) {
  const o = gltf.scene.getObjectByName(n);
  const box = o ? new THREE.Box3().setFromObject(o) : null;
  const s = box ? box.getSize(new THREE.Vector3()) : null;
  check(`getObjectByName('${n}') resolves`, Boolean(o),
    s ? `${s.x.toFixed(2)} x ${s.y.toFixed(2)} x ${s.z.toFixed(2)}` : 'null');
}

let triangles = 0, meshes = 0;
const materials = new Set();
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  meshes++;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) if (m) materials.add(m.uuid);
  const g = o.geometry;
  const count = g.index ? g.index.count : (g.attributes.position?.count || 0);
  triangles += Math.floor(count / 3);
});
check('triangle count in the expected band', triangles > 70000 && triangles < 100000, `${triangles}`);
check('material palette collapsed', materials.size <= 40, `${materials.size} materials, ${meshes} meshes`);

// Scale sanity: the pack is metre-mismatched against a ~1.8-unit humanoid, and
// src/render/models.js compensates with a 0.4x default. Assert the premise.
const sword = gltf.scene.getObjectByName('Sword');
if (sword) {
  const size = new THREE.Box3().setFromObject(sword).getSize(new THREE.Vector3());
  check('Sword is the oversized 2.3-unit model models.js assumes',
    size.y > 2.0 && size.y < 2.6, `y = ${size.y.toFixed(3)} (x0.4 -> ${(size.y * 0.4).toFixed(2)} m)`);
}

// ------------------------------------------------------------------ icons
if (fs.existsSync(INDEX) && fs.existsSync(ATLAS)) {
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const keys = Object.keys(idx.icons);
  check('icon atlas + index present', true,
    `${(fs.statSync(ATLAS).size / 1024).toFixed(1)} KB, ${idx.width}x${idx.height}, ${keys.length} keys`);
  const bad = keys.filter((k) => k !== k.toLowerCase());
  check('every icon key is lowercase', bad.length === 0, bad.join(', '));

  // The case-only mismatch this whole normalisation exists for.
  for (const n of ['axe_small', 'fishbone', 'sword_big', 'potion1_filled']) {
    check(`icon key '${n}' resolves`, Boolean(idx.icons[n]));
  }
  // Every model must be reachable from the icon index by its lowercased name.
  const missing = roots.map((o) => o.name.toLowerCase()).filter((n) => !idx.icons[n]);
  check('every model name has an icon', missing.length === 0, missing.join(', '));
} else {
  check('icon atlas + index present', false, 'run: node tools/pack-icons.mjs');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll item-pack checks passed');
process.exit(failures ? 1 : 0);
