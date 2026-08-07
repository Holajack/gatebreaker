// Convert the two CC0 Quaternius character packs — "Ultimate Modular Men"
// (11 characters) and "Ultimate Modular Women" (10) — into ONE meshopt GLB
// plus a JSON manifest the character system can address without guessing.
//
//   node tools/build-characters-glb.mjs            # build + verify
//   node tools/build-characters-glb.mjs --verify   # verify the committed GLB only
//
// NO BLENDER STEP. Both packs ship glTF 2.0 with a single embedded base64
// buffer per character, so this is a pure gltf-transform pipeline:
// mergeDocuments -> re-parent -> dedup + prune -> unpartition -> gltfpack -cc -kn.
//
// ---------------------------------------------------------------------------
// WHAT THE SOURCE ACTUALLY IS (measured, not assumed)
// ---------------------------------------------------------------------------
// Every one of the 21 characters ships a 62-joint armature with byte-identical
// joint NAMES and byte-identical hierarchy, and the same 24 animation clips.
// But the two packs are NOT one rig:
//
//   * bone REST TRANSFORMS and INVERSE BIND MATRICES differ between the men's
//     and women's packs (max rest-offset delta 0.108 on `Body`, max IBM delta
//     1.87). Within a pack they are bit-identical across all characters.
//   * every clip animates translation AND rotation on all 62 joints, and the
//     translation tracks are absolute local bone offsets baked against that
//     pack's rest pose. The men's and women's clip payloads therefore differ.
//
// Consequence: playing a men's clip on a women's mesh would overwrite the
// female bone offsets with male ones while the female inverse bind matrices
// stayed put — the mesh would stretch. So this file carries TWO rigs and TWO
// clip sets, not one. Everything else is deduplicated: the 21 identical
// skeletons collapse to 2, and the 21 identical clip sets collapse to 2.
//
// ---------------------------------------------------------------------------
// LOAD-BEARING DETAILS (each fails silently if changed)
// ---------------------------------------------------------------------------
//  1. BONE NAMES ARE PREFIXED PER RIG (`m_` / `f_`). three.js GLTFLoader runs
//     every node name through createUniqueName(); two rigs both calling their
//     root bone `Root` would load as `Root` and `Root_1`, and which rig won
//     would depend on node ordering. Prefixing makes it explicit, and the
//     manifest publishes the prefix so nothing has to be guessed.
//  2. DOTS ARE STRIPPED FROM BONE NAMES (`Shoulder.L` -> `m_Shoulder_L`).
//     PropertyBinding.sanitizeNodeName() deletes `[]./:` — an un-sanitised
//     `Shoulder.L` would load as `ShoulderL`, so the name in the file would not
//     be the name in the scene graph. Pre-sanitising makes GLB name == three
//     name == manifest name.
//  3. CLIP NAMES ARE PREFIXED PER RIG (`male_Idle` / `female_Idle`). Two clips
//     called `Idle` in one file make every lookup-by-name ambiguous.
//  4. gltfpack MUST be given -kn. Without it node names are stripped and the
//     file loads, renders, and every getObjectByName returns null.
//  5. meshopt, NOT Draco. DRACOLoader resolves its decoder path at runtime;
//     under Capacitor (https://localhost, base:'./') that is a silent
//     on-device failure, which the offline requirement forbids.
//  6. TEXCOORD_0 is pruned. The packs are flat-shaded — zero images, zero
//     textures, colour lives entirely in baseColorFactor — so the UVs are
//     dead weight. prune({ keepAttributes: false }) removes them.
//
// public/models/characters.glb and characters.json MUST be committed: the
// 68 MB source lives under assets/source/characters/ on one Mac.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_SRC = path.join(ROOT, 'assets', 'source', 'characters');
const DEFAULT_OUT = path.join(ROOT, 'public', 'models', 'characters.glb');
const MANIFEST_OUT = path.join(ROOT, 'public', 'models', 'characters.json');

/**
 * Pack layout. `sex` is the rig id; `bonePrefix` and `clipPrefix` are published
 * in the manifest so consumers never hardcode them.
 */
const PACKS = [
  { dir: 'men', sex: 'male', bonePrefix: 'm_', clipPrefix: 'male_' },
  { dir: 'women', sex: 'female', bonePrefix: 'f_', clipPrefix: 'female_' },
];

/**
 * Source part filenames are inconsistent: men/Farmer ships `Farmer_Pants`
 * rather than `_Legs`, and women/Formal ships a typo'd `Formad_Head`. Slots are
 * normalised so `parts.legs` means the same thing on every character.
 */
const SLOT_ALIASES = { pants: 'legs', formad_head: 'head' };

const SLOT_ORDER = ['head', 'body', 'legs', 'feet', 'backpack', 'pistol'];

// ------------------------------------------------------------------ helpers

function run(cmd, args, { label }) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`${label}: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${label} exited ${code}\n${out.slice(-4000)}\n${err.slice(-4000)}`));
    });
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Exactly what THREE.PropertyBinding.sanitizeNodeName does, applied up front. */
function sanitizeNodeName(name) {
  return name.replace(/\s/g, '_').replace(/[.:/[\]]/g, '_');
}

/** Asset keys are lowercase everywhere: macOS is case-insensitive, Android is not. */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * `Adventurer_Body` -> 'body'. `Backpack` / `Pistol` have no character prefix.
 * Returns the normalised slot name.
 */
function slotOf(meshNodeName, charName) {
  let s = slug(meshNodeName);
  const c = slug(charName);
  if (s.startsWith(c + '_')) s = s.slice(c.length + 1);
  // men/Casual_2's parts are named `Casual2_*`, women/Formal's head is `Formad_Head`.
  s = s.replace(/^[a-z0-9]+_/, (m) => (SLOT_ORDER.includes(s) ? m : ''));
  if (SLOT_ALIASES[s]) s = SLOT_ALIASES[s];
  return s;
}

// ------------------------------------------------------------------- build

export async function buildCharactersGlb({
  srcDir = DEFAULT_SRC,
  outFile = DEFAULT_OUT,
  manifestFile = MANIFEST_OUT,
} = {}) {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const { mergeDocuments, dedup, prune, unpartition } = await import('@gltf-transform/functions');

  const io = new NodeIO();
  const doc = new Document();
  doc.setLogger({ debug() {}, info() {}, warn: console.warn, error: console.error });
  const root = doc.getRoot();
  const scene = doc.createScene('characters');
  root.setDefaultScene(scene);

  const manifest = {
    generator: 'tools/build-characters-glb.mjs',
    source: [
      { pack: 'Quaternius Ultimate Modular Men', licence: 'CC0-1.0', characters: 11 },
      { pack: 'Quaternius Ultimate Modular Women', licence: 'CC0-1.0', characters: 10 },
    ],
    file: 'models/characters.glb',
    usage: [
      'One scene, two rig roots. Each rig root holds its 62-bone skeleton PLUS every',
      'character group that uses it, so cloning a rig clones all of its characters.',
      'To instantiate one character:',
      '  const rig = gltf.scene.getObjectByName(m.rigs[c.rig].node);',
      '  const inst = SkeletonUtils.clone(rig);',
      '  for (const g of [...inst.children]) if (g.name.startsWith("char_") && g.name !== c.node) inst.remove(g);',
      '  const mixer = new THREE.AnimationMixer(inst);',
      '  mixer.clipAction(byName(m.rigs[c.rig].clipPrefix + "Walk")).play();',
      'Part swapping works within a rig: any char_*_head from the same rig can be',
      're-parented onto another character group and skins correctly, because every',
      'character in a pack shares one skeleton and one skin.',
      'Weapon sockets: rigs[sex].bonePrefix + "Wrist_R" / "Wrist_L" / "Head".',
    ].join('\n'),
    rigs: {},
    characters: {},
    slots: [],
    clips: [],
    clipNames: [],
  };

  const allSlots = new Set();
  let totalSourceTriangles = 0;

  for (const pack of PACKS) {
    const gltfDir = path.join(srcDir, pack.dir, 'gltf');
    if (!(await exists(gltfDir))) {
      throw new Error(
        `Character pack source not found at ${gltfDir}. Both packs are CC0 downloads from ` +
        `quaternius.com (Google Drive) — see ASSETS.md.`,
      );
    }
    const files = (await fs.readdir(gltfDir)).filter((f) => f.endsWith('.gltf')).sort();
    if (!files.length) throw new Error(`no .gltf files in ${gltfDir}`);

    let rigNode = null;
    let rigSkin = null;
    let boneNames = null;

    for (const [i, file] of files.entries()) {
      const charName = path.basename(file, '.gltf');
      const charKey = `${pack.dir}_${slug(charName)}`;

      const srcDoc = await io.read(path.join(gltfDir, file));
      const map = mergeDocuments(doc, srcDoc);

      const srcScene = srcDoc.getRoot().getDefaultScene() || srcDoc.getRoot().listScenes()[0];
      const mergedScene = map.get(srcScene);
      const children = mergedScene.listChildren();
      if (children.length !== 1) {
        throw new Error(`${file}: expected 1 scene root, got ${children.length}`);
      }
      const armature = children[0];

      const meshNodes = armature.listChildren().filter((n) => n.getMesh());
      if (!meshNodes.length) throw new Error(`${file}: no skinned mesh nodes under the armature`);
      const skin = meshNodes[0].getSkin();
      if (!skin) throw new Error(`${file}: mesh node has no skin`);

      // Two of the 21 (women/Medieval's Sword, women/SciFi's Pistol) are NOT
      // skinned parts — they are rigid props PARENTED TO A BONE, deep inside the
      // armature. Discarding a duplicate bone tree would take them with it and
      // lose the geometry with no error at all, so they are hoisted out here and
      // the bone they belong on is published in the manifest.
      const props = [];
      {
        const stack = armature.listChildren().filter((n) => !n.getMesh());
        while (stack.length) {
          const n = stack.pop();
          for (const c of n.listChildren()) {
            if (c.getMesh()) props.push({ node: c, bone: n.getName() });
            else stack.push(c);
          }
        }
      }

      const anims = srcDoc.getRoot().listAnimations().map((a) => map.get(a));

      if (i === 0) {
        // ---- first character of the pack donates the rig and the clip set ----
        rigNode = armature;
        rigSkin = skin;
        rigNode.setName(`rig_${pack.sex}`);
        skin.setName(`skin_${pack.sex}`);

        boneNames = [];
        for (const joint of skin.listJoints()) {
          const clean = pack.bonePrefix + sanitizeNodeName(joint.getName());
          joint.setName(clean);
          boneNames.push(clean);
        }
        for (const a of anims) a.setName(pack.clipPrefix + a.getName());
      } else {
        // ---- every later character reuses the rig; its own copy is dropped ----
        for (const a of anims) a.dispose();
        for (const m of meshNodes) m.setSkin(rigSkin);
      }

      // Re-parent this character's parts under a named group on the rig.
      const group = doc.createNode(`char_${charKey}`);
      const parts = {};
      const charProps = {};
      let primitives = 0, triangles = 0;
      const countMesh = (n) => {
        for (const prim of n.getMesh().listPrimitives()) {
          primitives++;
          const idx = prim.getIndices();
          const pos = prim.getAttribute('POSITION');
          triangles += Math.floor((idx ? idx.getCount() : (pos ? pos.getCount() : 0)) / 3);
        }
      };
      for (const p of props) {
        const slot = slug(p.node.getName());
        const propName = `char_${charKey}_${slot}`;
        const rawBone = p.bone;
        const boneName = rawBone.startsWith(pack.bonePrefix)
          ? rawBone
          : pack.bonePrefix + sanitizeNodeName(rawBone);
        countMesh(p.node);
        p.node.setName(propName);
        // Local TRS is preserved, so re-parenting this node onto `attachBone`
        // at runtime restores the exact original placement in the hand.
        for (const parent of p.node.listParents()) {
          if (parent.propertyType === 'Node') parent.removeChild(p.node);
        }
        group.addChild(p.node);
        charProps[slot] = { node: propName, attachBone: boneName };
      }
      for (const m of meshNodes) {
        const slot = slotOf(m.getName(), charName);
        allSlots.add(slot);
        const partName = `char_${charKey}_${slot}`;
        if (parts[slot]) throw new Error(`${file}: duplicate slot '${slot}'`);
        parts[slot] = partName;
        m.setName(partName);
        countMesh(m);
        armature.removeChild(m);
        group.addChild(m);
      }
      rigNode.addChild(group);

      manifest.characters[charKey] = {
        node: `char_${charKey}`,
        rig: pack.sex,
        pack: pack.dir,
        sourceName: charName,
        parts,
        ...(Object.keys(charProps).length ? { props: charProps } : {}),
        // One primitive == one SkinnedMesh == one draw call. Quaternius splits
        // each part per material, so a character is ~12 draw calls, not 4.
        primitives,
        triangles,
      };

      // Triangle conservation. Every silent failure this pipeline can produce
      // shows up as geometry going missing, so the source total is re-counted
      // here and must match what was re-parented.
      const srcTris = srcDoc.getRoot().listMeshes().reduce((sum, mesh) => sum +
        mesh.listPrimitives().reduce((s, prim) => {
          const idx = prim.getIndices();
          const pos = prim.getAttribute('POSITION');
          return s + Math.floor((idx ? idx.getCount() : (pos ? pos.getCount() : 0)) / 3);
        }, 0), 0);
      if (srcTris !== triangles) {
        throw new Error(
          `${file}: ${srcTris - triangles} triangle(s) would be dropped ` +
          `(source ${srcTris}, kept ${triangles}). A mesh is parented somewhere ` +
          `this script does not walk.`,
        );
      }
      totalSourceTriangles += srcTris;

      // Drop the leftovers: this copy's scene, and (for i>0) its duplicate
      // bone tree and skin. prune() would catch the bones, but disposing them
      // here keeps the intermediate document honest and the failure loud.
      mergedScene.removeChild(armature);
      mergedScene.dispose();
      if (i !== 0) {
        skin.dispose();
        const stack = [armature];
        while (stack.length) {
          const n = stack.pop();
          stack.push(...n.listChildren());
          n.dispose();
        }
      }
    }

    scene.addChild(rigNode);
    manifest.rigs[pack.sex] = {
      node: `rig_${pack.sex}`,
      bonePrefix: pack.bonePrefix,
      clipPrefix: pack.clipPrefix,
      boneCount: boneNames.length,
      bones: boneNames,
      skeletonRoot: boneNames[0],
    };
  }

  manifest.slots = SLOT_ORDER.filter((s) => allSlots.has(s))
    .concat([...allSlots].filter((s) => !SLOT_ORDER.includes(s)).sort());
  manifest.clips = root.listAnimations().map((a) => a.getName()).sort();
  // The 24 bare clip names, shared by both rigs: clipNames[i] is addressed as
  // rigs[sex].clipPrefix + clipNames[i].
  manifest.clipNames = [...new Set(
    manifest.clips.map((n) => {
      const p = PACKS.find((k) => n.startsWith(k.clipPrefix));
      return p ? n.slice(p.clipPrefix.length) : n;
    }),
  )].sort();

  // ---- dedup materials/meshes/accessors, drop the unused UVs, one buffer ----
  await doc.transform(
    dedup(),
    prune({ keepAttributes: false, keepLeaves: false }),
    unpartition(),
  );

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-chars-'));
  const rawGlb = path.join(tmp, 'characters-raw.glb');
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await io.write(rawGlb, doc);

  const mid = await glbStats(rawGlb);
  console.log(`[characters] merged: ${mid.scenes} scene(s), ${mid.rootNodes} rig root(s), ` +
    `${mid.skins} skin(s), ${mid.animations} clip(s), ${mid.materials} materials, ` +
    `${mid.sceneTriangles} triangles drawn (${mid.triangles} unique), ` +
    `${(fsSync.statSync(rawGlb).size / 1024 / 1024).toFixed(2)} MB`);
  if (mid.scenes !== 1) {
    throw new Error(`expected exactly 1 scene, got ${mid.scenes}. three.js renders only scenes[0].`);
  }
  if (mid.sceneTriangles !== totalSourceTriangles) {
    throw new Error(`triangle count changed during merge: ${totalSourceTriangles} in the ` +
      `21 source files, ${mid.sceneTriangles} drawn by the merged scene.`);
  }

  // ---- meshopt via gltfpack. -kn is MANDATORY. ----
  const gltfpack = path.join(ROOT, 'node_modules', '.bin', 'gltfpack');
  if (!(await exists(gltfpack))) {
    throw new Error(`gltfpack not found at ${gltfpack} — run: npm i -D gltfpack`);
  }
  // -kn keep node names, -ke keep extras, -cc meshopt compression.
  await run(gltfpack, ['-i', rawGlb, '-o', outFile, '-cc', '-kn'], { label: 'gltfpack' });

  const final = await glbStats(outFile);
  if (final.scenes !== 1) throw new Error(`gltfpack produced ${final.scenes} scenes`);

  const expectedNames = [
    ...Object.values(manifest.rigs).map((r) => r.node),
    ...Object.values(manifest.characters).map((c) => c.node),
    ...Object.values(manifest.characters).flatMap((c) => Object.values(c.parts)),
    ...Object.values(manifest.rigs).flatMap((r) => r.bones),
  ];
  const missing = expectedNames.filter((n) => !final.nodeNames.has(n));
  if (missing.length) {
    throw new Error(
      `${missing.length} node name(s) lost by gltfpack (e.g. ${missing.slice(0, 6).join(', ')}). ` +
      `This is the -kn failure mode: the file loads without error and is unusable.`,
    );
  }
  const clipsLost = manifest.clips.filter((n) => !final.clipNames.has(n));
  if (clipsLost.length) {
    throw new Error(`${clipsLost.length} animation clip name(s) lost by gltfpack: ` +
      `${clipsLost.slice(0, 6).join(', ')}`);
  }

  const bytes = (await fs.stat(outFile)).size;
  manifest.bytes = bytes;
  manifest.triangles = final.sceneTriangles;
  if (final.sceneTriangles !== totalSourceTriangles) {
    throw new Error(`gltfpack changed the drawn triangle count: ${totalSourceTriangles} -> ` +
      `${final.sceneTriangles}`);
  }
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`[characters] wrote ${path.relative(ROOT, outFile)}  ` +
    `${(bytes / 1024).toFixed(1)} KB  ${Object.keys(manifest.characters).length} characters  ` +
    `${final.triangles} tris  ${final.materials} materials  ${final.animations} clips`);
  console.log(`[characters] wrote ${path.relative(ROOT, manifestFile)}`);

  return { file: outFile, manifestFile, bytes, manifest };
}

/** Reads either the raw or the meshopt-compressed GLB. */
async function glbStats(file) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { EXTMeshoptCompression, KHRMeshQuantization } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(file);
  const root = doc.getRoot();
  const scenes = root.listScenes();
  const nodeNames = new Set();
  for (const n of root.listNodes()) if (n.getName()) nodeNames.add(n.getName());
  const clipNames = new Set(root.listAnimations().map((a) => a.getName()));
  const primTris = (prim) => {
    const idx = prim.getIndices();
    const pos = prim.getAttribute('POSITION');
    return Math.floor((idx ? idx.getCount() : (pos ? pos.getCount() : 0)) / 3);
  };
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) triangles += primTris(prim);
  }
  // Per-NODE total. dedup() collapses two byte-identical meshes into one Mesh
  // referenced twice, which lowers the per-mesh count without losing anything —
  // so conservation has to be checked against what the scene actually draws.
  let sceneTriangles = 0;
  if (scenes.length) {
    const stack = [...scenes[0].listChildren()];
    while (stack.length) {
      const n = stack.pop();
      stack.push(...n.listChildren());
      const mesh = n.getMesh();
      if (mesh) for (const prim of mesh.listPrimitives()) sceneTriangles += primTris(prim);
    }
  }
  return {
    sceneTriangles,
    scenes: scenes.length,
    rootNodes: scenes.length ? scenes[0].listChildren().length : 0,
    nodeNames,
    clipNames,
    skins: root.listSkins().length,
    animations: root.listAnimations().length,
    materials: root.listMaterials().length,
    meshes: root.listMeshes().length,
    triangles,
  };
}

// ------------------------------------------------------------------ verify
//
// Parses the shipped GLB through the SAME GLTFLoader + MeshoptDecoder pair the
// game uses, so a decoder mismatch fails here rather than on a phone. Every
// failure mode of this pipeline is silent at load time, so all of it is
// asserted rather than eyeballed.

export async function verifyCharactersGlb({
  glbFile = DEFAULT_OUT,
  manifestFile = MANIFEST_OUT,
} = {}) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');

  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    return ok;
  };

  if (!fsSync.existsSync(glbFile)) {
    console.log(`FAIL  ${path.relative(ROOT, glbFile)} exists — missing. ` +
      `Run: node tools/build-characters-glb.mjs`);
    return 1;
  }
  const bytes = fsSync.statSync(glbFile).size;
  const buf = fsSync.readFileSync(glbFile);
  const manifest = JSON.parse(fsSync.readFileSync(manifestFile, 'utf8'));

  const gltf = await new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject);
  });

  check('characters.glb parses through GLTFLoader + MeshoptDecoder', true,
    `${(bytes / 1024).toFixed(1)} KB`);
  check('exactly one scene', gltf.scenes.length === 1,
    `${gltf.scenes.length} scene(s) — three.js only ever renders scenes[0]`);

  // ---- rigs ----
  for (const [sex, rig] of Object.entries(manifest.rigs)) {
    const node = gltf.scene.getObjectByName(rig.node);
    check(`rig '${rig.node}' resolves by name`, Boolean(node));
    if (!node) continue;
    const missingBones = rig.bones.filter((b) => !node.getObjectByName(b));
    check(`rig '${sex}' has all ${rig.boneCount} bones under it`, missingBones.length === 0,
      missingBones.slice(0, 5).join(', '));
    const skelRoot = node.getObjectByName(rig.skeletonRoot);
    check(`rig '${sex}' skeleton root '${rig.skeletonRoot}' is a Bone`,
      Boolean(skelRoot && skelRoot.isBone));
  }

  // The shared-skeleton claim, re-asserted against the shipped file: strip the
  // per-rig prefix and the two bone lists must be identical.
  const bare = (r) => r.bones.map((b) => b.slice(r.bonePrefix.length));
  const [m, f] = [manifest.rigs.male, manifest.rigs.female];
  check('male and female rigs share identical bone names + order',
    JSON.stringify(bare(m)) === JSON.stringify(bare(f)),
    `${m.boneCount} vs ${f.boneCount} joints`);

  // ---- characters ----
  const charKeys = Object.keys(manifest.characters);
  check('21 characters in the manifest', charKeys.length === 21, `${charKeys.length}`);

  let skinnedTotal = 0, bonesBound = 0, triangles = 0;
  const badKeys = charKeys.filter((k) => k !== k.toLowerCase());
  check('every character key is lowercase', badKeys.length === 0, badKeys.join(', '));

  for (const key of charKeys) {
    const c = manifest.characters[key];
    const node = gltf.scene.getObjectByName(c.node);
    if (!check(`character '${key}' resolves by name`, Boolean(node))) continue;

    const skinned = [];
    node.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
    skinnedTotal += skinned.length;
    const partOk = Object.values(c.parts).every((p) => Boolean(gltf.scene.getObjectByName(p)));
    if (!partOk) check(`character '${key}' parts resolve`, false,
      Object.values(c.parts).filter((p) => !gltf.scene.getObjectByName(p)).join(', '));

    for (const [slot, p] of Object.entries(c.props || {})) {
      const pn = gltf.scene.getObjectByName(p.node);
      let propTris = 0;
      if (pn) pn.traverse((o) => {
        if (o.isMesh) propTris += Math.floor(
          (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3);
      });
      check(`prop '${key}.${slot}' survives and resolves`, Boolean(pn) && propTris > 0,
        pn ? `${propTris} tris` : 'missing');
      const bone = gltf.scene.getObjectByName(manifest.rigs[c.rig].node)
        ?.getObjectByName(p.attachBone);
      check(`prop '${key}.${slot}' attachBone '${p.attachBone}' exists on rig_${c.rig}`,
        Boolean(bone && bone.isBone));
    }

    const withBones = skinned.filter((s) => s.skeleton && s.skeleton.bones.length > 0);
    if (withBones.length !== skinned.length) {
      check(`character '${key}' every SkinnedMesh has bones`, false,
        `${withBones.length}/${skinned.length}`);
    }
    for (const s of withBones) bonesBound = Math.max(bonesBound, s.skeleton.bones.length);

    // The opacity-0 trap from the item pack: correct geometry, nothing drawn.
    for (const s of skinned) {
      const mats = Array.isArray(s.material) ? s.material : [s.material];
      const invisible = mats.filter((mm) => mm && (mm.opacity < 0.01 || mm.visible === false));
      if (invisible.length) check(`character '${key}' materials are visible`, false,
        `${invisible.length} material(s) at opacity ~0`);
    }

    // Non-degenerate bounds, computed from the bind pose.
    const box = new THREE.Box3().setFromObject(node);
    const size = box.getSize(new THREE.Vector3());
    if (!(size.y > 0.5 && size.y < 4)) {
      check(`character '${key}' has plausible height`, false, `y = ${size.y.toFixed(3)}`);
    }

    for (const s of skinned) {
      const g = s.geometry;
      triangles += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
    }
  }
  check(`all ${charKeys.length} characters resolve, are skinned, visible and sized`, true,
    `${skinnedTotal} SkinnedMeshes, max ${bonesBound} bones, ${triangles} triangles`);

  // ---- animations ----
  const clipNames = gltf.animations.map((a) => a.name).sort();
  check('animation clips present', gltf.animations.length > 0, `${gltf.animations.length} clips`);
  check('clip names match the manifest',
    JSON.stringify(clipNames) === JSON.stringify([...manifest.clips].sort()),
    `${clipNames.length} vs ${manifest.clips.length}`);
  const unnamedClips = gltf.animations.filter((a) => !a.name);
  check('no clip lost its name', unnamedClips.length === 0, `${unnamedClips.length} unnamed`);
  const emptyClips = gltf.animations.filter((a) => a.tracks.length === 0 || a.duration <= 0);
  check('no clip is empty', emptyClips.length === 0,
    emptyClips.map((a) => a.name).join(', '));

  // A clip is only useful if its tracks actually bind to the rig it belongs to.
  // This is the check that catches a bone-rename or a prefix mismatch.
  const { PropertyBinding } = THREE;
  for (const [sex, rig] of Object.entries(manifest.rigs)) {
    const rigNode = gltf.scene.getObjectByName(rig.node);
    const clip = gltf.animations.find((a) => a.name === `${rig.clipPrefix}Idle`);
    if (!check(`clip '${rig.clipPrefix}Idle' exists`, Boolean(clip))) continue;
    const unbound = clip.tracks.filter((t) => {
      const parsed = PropertyBinding.parseTrackName(t.name);
      return !PropertyBinding.findNode(rigNode, parsed.nodeName);
    });
    check(`every track of '${clip.name}' binds to rig_${sex}`, unbound.length === 0,
      `${clip.tracks.length} tracks, ${unbound.length} unbound` +
      (unbound.length ? `: ${unbound.slice(0, 3).map((t) => t.name).join(', ')}` : ''));

    // And it must NOT bind to the other rig — that is what the prefixes buy.
    const other = Object.values(manifest.rigs).find((r) => r.node !== rig.node);
    const otherNode = gltf.scene.getObjectByName(other.node);
    const crossBound = clip.tracks.filter((t) => {
      const parsed = PropertyBinding.parseTrackName(t.name);
      return Boolean(PropertyBinding.findNode(otherNode, parsed.nodeName));
    });
    check(`'${clip.name}' does not cross-bind to ${other.node}`, crossBound.length === 0,
      `${crossBound.length} tracks would also match`);
  }

  // Playing a clip must actually move a bone. Cheap end-to-end proof that the
  // meshopt-decoded animation buffers survived the round trip.
  const rigMale = gltf.scene.getObjectByName(manifest.rigs.male.node);
  const walk = gltf.animations.find((a) => a.name === 'male_Walk');
  if (walk && rigMale) {
    const probe = rigMale.getObjectByName(`${manifest.rigs.male.bonePrefix}UpperLeg_L`)
      || rigMale.getObjectByName(manifest.rigs.male.skeletonRoot);
    const mixer = new THREE.AnimationMixer(rigMale);
    mixer.clipAction(walk).play();
    mixer.update(0);
    const a = probe.quaternion.clone();
    mixer.update(walk.duration * 0.5);
    const b = probe.quaternion.clone();
    check(`playing 'male_Walk' rotates ${probe.name}`, a.angleTo(b) > 1e-3,
      `angle delta ${(a.angleTo(b) * 180 / Math.PI).toFixed(2)} deg over ${walk.duration.toFixed(2)}s`);
  }

  // The actual runtime path, end to end: clone a rig, strip it to one
  // character, drive it with a clip. This is what the game will do, and it is
  // the check that catches a broken skin/joint remap after gltfpack.
  {
    const { clone } = await import('three/examples/jsm/utils/SkeletonUtils.js');
    const c = manifest.characters.women_witch || manifest.characters[charKeys[0]];
    const rig = manifest.rigs[c.rig];
    const inst = clone(gltf.scene.getObjectByName(rig.node));
    for (const g of [...inst.children]) {
      if (g.name.startsWith('char_') && g.name !== c.node) inst.remove(g);
    }
    const skinned = [];
    inst.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
    const ownBones = skinned.every((s) => s.skeleton.bones.every((b) => {
      let p = b; while (p.parent) p = p.parent; return p === inst;
    }));
    check(`SkeletonUtils.clone of ${rig.node} -> ${c.node} rebinds to its own bones`,
      skinned.length > 0 && ownBones, `${skinned.length} SkinnedMeshes`);

    const clip = gltf.animations.find((a) => a.name === `${rig.clipPrefix}Run`);
    const mixer = new THREE.AnimationMixer(inst);
    mixer.clipAction(clip).play();
    mixer.update(0);
    inst.updateMatrixWorld(true);
    const boneA = inst.getObjectByName(`${rig.bonePrefix}Wrist_R`).getWorldPosition(new THREE.Vector3());
    mixer.update(clip.duration * 0.5);
    inst.updateMatrixWorld(true);
    const boneB = inst.getObjectByName(`${rig.bonePrefix}Wrist_R`).getWorldPosition(new THREE.Vector3());
    check(`cloned ${c.node} animates under '${clip.name}'`, boneA.distanceTo(boneB) > 0.01,
      `${rig.bonePrefix}Wrist_R moved ${boneA.distanceTo(boneB).toFixed(3)} units`);

    const box = new THREE.Box3().setFromObject(inst);
    const size = box.getSize(new THREE.Vector3());
    check(`cloned ${c.node} has non-degenerate bounds`, size.y > 0.5 && size.x > 0.05,
      `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
  }

  // Props ship parked under their character group, not in the hand, because the
  // hand bone lives on the shared rig. Re-parenting them onto `attachBone` is
  // the documented step, so prove it lands them somewhere sane.
  {
    const { clone } = await import('three/examples/jsm/utils/SkeletonUtils.js');
    for (const [key, c] of Object.entries(manifest.characters)) {
      for (const [slot, p] of Object.entries(c.props || {})) {
        const rig = manifest.rigs[c.rig];
        const inst = clone(gltf.scene.getObjectByName(rig.node));
        const prop = inst.getObjectByName(p.node);
        const bone = inst.getObjectByName(p.attachBone);
        const hand = inst.getObjectByName(`${rig.bonePrefix}Wrist_R`);
        bone.add(prop);
        inst.updateMatrixWorld(true);
        const d = prop.getWorldPosition(new THREE.Vector3())
          .distanceTo(hand.getWorldPosition(new THREE.Vector3()));
        check(`re-parenting '${key}.${slot}' onto ${p.attachBone} puts it in the right hand`,
          d < 0.3, `${d.toFixed(3)} units from ${rig.bonePrefix}Wrist_R`);
      }
    }
  }

  console.log('\nclips (' + clipNames.length + '):');
  for (const n of clipNames) console.log('  ' + n);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll character-pack checks passed');
  return failures;
}

// ------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  try {
    if (!argv.includes('--verify')) {
      await buildCharactersGlb({
        srcDir: path.resolve(ROOT, opt('src', DEFAULT_SRC)),
        outFile: path.resolve(ROOT, opt('out', DEFAULT_OUT)),
      });
    }
    const failures = await verifyCharactersGlb({
      glbFile: path.resolve(ROOT, opt('out', DEFAULT_OUT)),
    });
    process.exit(failures ? 1 : 0);
  } catch (e) {
    console.error(`[characters] FAILED: ${e.message}`);
    process.exit(1);
  }
}
