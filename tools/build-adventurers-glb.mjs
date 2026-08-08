// Convert the KayKit Adventurers FREE pack (5 rigged humans) into ONE meshopt
// GLB + manifest, binding a curated subset of the ALREADY-OWNED KayKit clip
// library (assets/source/creatures/kaykit/animations-free.zip — 107 of its 133
// clips are still unused by creatures.glb; new Rig_Medium bodies bind to it at
// zero download cost).
//
//   node tools/build-adventurers-glb.mjs            # build + manifest + verify
//   node tools/build-adventurers-glb.mjs --verify   # verify the committed GLB only
//
// OUTPUTS
//   public/models/adventurers.glb + adventurers.json
//
// SOURCES (both CC0; provenance in the manifest's sources field):
//   * KayKit "Adventurers" FREE tier 2.0    https://kaylousberg.itch.io/kaykit-adventurers
//   * KayKit "Character Animations" FREE    https://kaylousberg.itch.io/kaykit-character-animations
//     (downloaded 2026-08-06 for the skeletons build; re-used from disk)
//
// This is deliberately the tools/build-creatures-glb.mjs pipeline — same rig
// family (Rig_Medium, byte-identical 23-bone skeleton), same traps, same
// mitigations. The four that fail silently if changed (full war stories in
// that file's header):
//   1. gltfpack MUST get -kn or every getObjectByName returns null.
//   2. Exactly ONE scene, or three.js renders one character and hides four.
//   3. EVERY node name unique: three.js GLTFLoader renames collisions
//      (root -> root_1) and silently unbinds the losers' animation tracks, so
//      bones are namespaced per character and each character carries its OWN
//      copy of every clip it uses (sharing keyframe accessors, so the copies
//      cost channel records, not animation data).
//   4. Keys lowercase (macOS hides case bugs, Android does not).
//
// MIXER CONTRACT (same as creatures.glb):
//   const src = scene.getObjectByName('knight');       // lowercase key
//   const inst = SkeletonUtils.clone(src);             // NOT Object3D.clone
//   const mixer = new THREE.AnimationMixer(inst);
//   mixer.clipAction(clipsByName.get('knight__idle_a')).play();
//
// NO src/ wiring this wave — the deliverable is the GLB + manifest only.
// public/models/adventurers.glb MUST be committed (sources are gitignored).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const ADV_ROOT = path.join(ROOT, 'assets', 'source', 'creatures', 'kaykit', 'adventurers',
  'KayKit_Adventurers_2.0_FREE');
const CHAR_DIR = path.join(ADV_ROOT, 'Characters', 'gltf');
const PROP_DIR = path.join(ADV_ROOT, 'Assets', 'gltf');
// The clip library shipped with the SKELETONS wave — not the trimmed
// Animations/ folder inside the adventurers zip (that one carries only 2 of
// the 8 stem files).
const CLIP_DIR = path.join(ROOT, 'assets', 'source', 'creatures', 'kaykit', 'animations',
  'KayKit_Character_Animations_1.1', 'Animations', 'gltf', 'Rig_Medium');

const OUT_GLB = path.join(ROOT, 'public', 'models', 'adventurers.glb');
const OUT_MANIFEST = path.join(ROOT, 'public', 'models', 'adventurers.json');

// ---------------------------------------------------------------- curation
//
// The FREE tier ships six GLBs; Rogue_Hooded is the Rogue silhouette with a
// hood and is deliberately left in source, unconverted — five bodies cover
// the Wave needs (hunter NPCs, rival hunters, human minibosses) and the
// sixth would be ~130 KB for a variant the spawner has no slot for yet.
const CHARACTERS = [
  { key: 'knight', file: 'Knight.glb', role: 'tank', archetype: 'lancer',
    note: 'Full helm, cape. Sword-and-board hunter; the guild-vanguard silhouette. Visor and cape are separate skinned parts (knight_Knight_Cape / knight_Knight_HelmetVisor) if a bare variant is ever needed.' },
  { key: 'barbarian', file: 'Barbarian.glb', role: 'bruiser', archetype: 'brute',
    note: 'Bear-hat two-hander. Reads as the heavy of a rival hunter squad.' },
  { key: 'rogue', file: 'Rogue.glb', role: 'skirmisher', archetype: 'stalker',
    note: 'Leathers and daggers. The "fallen hunter" dungeon miniboss read. Rogue_Hooded variant kept in source, unconverted.' },
  { key: 'mage', file: 'Mage.glb', role: 'caster', archetype: 'caster',
    note: 'Hat and robe. Human caster to complement the skeleton mage.' },
  { key: 'ranger', file: 'Ranger.glb', role: 'ranged', archetype: 'archer',
    note: 'Hooded archer. The pack ships a real bow (adv_bow), so bow clips do not mime.' },
];

// Which of the 133 library clips to bind. Assigned PER CHARACTER for the same
// two reasons as the skeletons: the mage has no use for a two-handed spin, and
// every character pays for its own namespaced copy of each clip it takes
// (trap 3), so an unused clip is not free — it is paid for five times.
const CLIPS_COMMON = {
  Rig_Medium_General: ['Idle_A', 'Hit_A', 'Death_A'],
  Rig_Medium_MovementBasic: ['Walking_A', 'Running_A'],
};

const CLIPS_BY_CHARACTER = {
  knight: {
    Rig_Medium_CombatMelee: ['Melee_1H_Attack_Slice_Diagonal', 'Melee_1H_Attack_Chop', 'Melee_Blocking'],
  },
  barbarian: {
    Rig_Medium_CombatMelee: ['Melee_2H_Attack_Chop', 'Melee_2H_Attack_Spinning'],
  },
  rogue: {
    Rig_Medium_CombatMelee: ['Melee_Dualwield_Attack_Stab'],
    Rig_Medium_MovementAdvanced: ['Dodge_Backward'],
  },
  mage: {
    Rig_Medium_CombatRanged: ['Ranged_Magic_Spellcasting', 'Ranged_Magic_Shoot', 'Ranged_Magic_Summon'],
  },
  ranger: {
    // A real bow ships with this pack (unlike the skeletons' crossbow-only
    // free tier), so the bow draw/release cycle has something in frame.
    Rig_Medium_CombatRanged: ['Ranged_Bow_Aiming_Idle', 'Ranged_Bow_Draw', 'Ranged_Bow_Release'],
  },
};

// Weapons/props for the hands — the characters ship UNARMED, and an armed
// silhouette is the difference between "hunter" and "villager with a hat".
// Static meshes parented onto `<key>_handslot_l/r` at runtime, exactly like
// creatures.json's props.
const PROPS = [
  { key: 'adv_sword_1h', file: 'sword_1handed.gltf', attach: 'handslot_r', suits: ['knight'] },
  { key: 'adv_shield_badge', file: 'shield_badge.gltf', attach: 'handslot_l', suits: ['knight'] },
  { key: 'adv_axe_2h', file: 'axe_2handed.gltf', attach: 'handslot_r', suits: ['barbarian'] },
  { key: 'adv_dagger', file: 'dagger.gltf', attach: 'handslot_r', suits: ['rogue'] },
  { key: 'adv_staff', file: 'staff.gltf', attach: 'handslot_r', suits: ['mage'] },
  { key: 'adv_bow', file: 'bow_withString.gltf', attach: 'handslot_l', suits: ['ranger'] },
  { key: 'adv_quiver', file: 'quiver.gltf', attach: 'spine', suits: ['ranger'] },
  { key: 'adv_arrow', file: 'arrow_bow.gltf', attach: 'handslot_r', suits: ['ranger'] },
];

// A character that only idles cannot be a combat entity (the guard that
// caught Quaternius' one-clip Demon).
const MIN_CLIPS = 4;

const ATLAS_MAX_PX = 128;
const ATLAS_MAX_DISTINCT_UVS = 256;

// ------------------------------------------------------------------ shell

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

// --------------------------------------------------------- doc utilities
// Same helpers as tools/build-creatures-glb.mjs (file-local there by design;
// copied, not reinvented).

function walkNodes(node, fn) {
  fn(node);
  for (const child of node.listChildren()) walkNodes(child, fn);
}

function disposeSubtree(node) {
  for (const child of node.listChildren()) disposeSubtree(child);
  node.dispose();
}

function absorb(master, other, mergeDocuments) {
  const root = master.getRoot();
  const beforeScenes = new Set(root.listScenes());
  const beforeAnims = new Set(root.listAnimations());
  mergeDocuments(master, other);
  return {
    scenes: root.listScenes().filter((s) => !beforeScenes.has(s)),
    animations: root.listAnimations().filter((a) => !beforeAnims.has(a)),
  };
}

function foldIntoHolder(master, scenes, key, targetScene) {
  const holder = master.createNode(key);
  for (const scene of scenes) {
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      holder.addChild(child);
    }
    scene.dispose();
  }
  targetScene.addChild(holder);
  return holder;
}

/** Pre-apply three.js PropertyBinding's name sanitiser (deletes `. [ ] : /`)
 *  so the names in the GLB are the names the AnimationMixer will look for. */
function safeName(name) {
  return name.replace(/[.[\]:/]/g, '_').replace(/\s+/g, '_');
}

function prefixNodes(holder, key) {
  walkNodes(holder, (node) => {
    if (node === holder) return;
    node.setName(`${key}_${safeName(node.getName() || 'node')}`);
  });
}

/** Copy a clip onto another skeleton with the same bone names, sharing the
 *  source keyframe accessors (glTF permits sampler->accessor sharing). */
function retargetClone(master, anim, newName, bones, sourceBones) {
  const nameOf = new Map();
  for (const [name, node] of sourceBones) nameOf.set(node, name);

  const copy = master.createAnimation(newName);
  const samplers = new Map();
  for (const s of anim.listSamplers()) {
    const ns = master.createAnimationSampler()
      .setInput(s.getInput())
      .setOutput(s.getOutput())
      .setInterpolation(s.getInterpolation());
    samplers.set(s, ns);
    copy.addSampler(ns);
  }
  for (const ch of anim.listChannels()) {
    const originalName = nameOf.get(ch.getTargetNode());
    const bone = originalName && bones.get(originalName);
    if (!bone) {
      throw new Error(`${newName}: no counterpart for bone '${originalName ?? '?'}'`);
    }
    copy.addChannel(master.createAnimationChannel()
      .setTargetNode(bone)
      .setTargetPath(ch.getTargetPath())
      .setSampler(samplers.get(ch.getSampler())));
  }
  return copy;
}

function dropClips(doc, keep) {
  let dropped = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    if (keep(anim.getName())) continue;
    for (const ch of anim.listChannels()) ch.dispose();
    for (const s of anim.listSamplers()) s.dispose();
    anim.dispose();
    dropped++;
  }
  return dropped;
}

/** stem -> clip -> [character keys that want it] */
function clipPlan() {
  const plan = new Map();
  const add = (stem, clip, key) => {
    if (!plan.has(stem)) plan.set(stem, new Map());
    const byClip = plan.get(stem);
    if (!byClip.has(clip)) byClip.set(clip, []);
    byClip.get(clip).push(key);
  };
  for (const spec of CHARACTERS) {
    for (const [stem, clips] of Object.entries(CLIPS_COMMON)) {
      for (const clip of clips) add(stem, clip, spec.key);
    }
    for (const [stem, clips] of Object.entries(CLIPS_BY_CHARACTER[spec.key] || {})) {
      for (const clip of clips) add(stem, clip, spec.key);
    }
  }
  return plan;
}

/** Downscale palette-like atlases with per-UV pixel verification; leave real
 *  gradient atlases alone (the creatures builder's exact rule — the KayKit
 *  1024 character atlases are expected to stay, matching skeleton_texture). */
async function shrinkPaletteAtlases(doc) {
  let sharp;
  try { sharp = (await import('sharp')).default; }
  catch { console.log('[adventurers] sharp unavailable, keeping atlases at source size'); return; }

  for (const tex of doc.getRoot().listTextures()) {
    const [w, h] = tex.getSize() || [];
    if (!w || Math.max(w, h) <= ATLAS_MAX_PX) continue;

    const uvs = new Set();
    for (const mat of doc.getRoot().listMaterials()) {
      if (mat.getBaseColorTexture() !== tex) continue;
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMaterial() !== mat) continue;
          const uv = prim.getAttribute('TEXCOORD_0');
          if (!uv) continue;
          const a = uv.getArray();
          for (let i = 0; i < a.length; i += 2) uvs.add(`${a[i]},${a[i + 1]}`);
        }
      }
    }
    const label = `${tex.getName() || 'texture'} ${w}x${h}`;
    if (!uvs.size || uvs.size > ATLAS_MAX_DISTINCT_UVS) {
      console.log(`[adventurers] atlas ${label}: ${uvs.size} distinct UVs, not a palette — left alone`);
      continue;
    }

    const scale = ATLAS_MAX_PX / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const src = Buffer.from(tex.getImage());
    const small = await sharp(src).resize(nw, nh, { kernel: 'nearest' }).png().toBuffer();

    const A = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const B = await sharp(small).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (o, u, v) => {
      const x = Math.min(o.info.width - 1, Math.max(0, Math.floor(u * o.info.width)));
      const y = Math.min(o.info.height - 1, Math.max(0, Math.floor(v * o.info.height)));
      const i = (y * o.info.width + x) * o.info.channels;
      return [o.data[i], o.data[i + 1], o.data[i + 2], o.data[i + 3]];
    };
    let ok = true;
    for (const s of uvs) {
      const [u, v] = s.split(',').map(Number);
      const a = px(A, u, v), b = px(B, u, v);
      if (!(a[3] > 0)) {
        throw new Error(`atlas ${label} samples a fully transparent texel at UV ${s}`);
      }
      if (a.join() !== b.join()) { ok = false; break; }
    }
    if (!ok) {
      console.log(`[adventurers] atlas ${label}: downscale changed a sampled colour — kept at source size`);
      continue;
    }
    tex.setImage(new Uint8Array(small));
    for (const mat of doc.getRoot().listMaterials()) {
      if (mat.getBaseColorTexture() !== tex) continue;
      const info = mat.getBaseColorTextureInfo();
      if (info) { info.setMagFilter(9728); info.setMinFilter(9728); }
    }
    console.log(`[adventurers] atlas ${label} -> ${nw}x${nh} (verified identical at every sampled UV)`);
  }
}

// ------------------------------------------------------------ the build

export async function buildAdventurersGlb() {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const { dedup, prune, unpartition, mergeDocuments } = await import('@gltf-transform/functions');

  for (const [dir, hint] of [
    [CHAR_DIR, 'unzip assets/source/creatures/kaykit/adventurers-free.zip (itch.io free tier, CC0)'],
    [CLIP_DIR, 'unzip assets/source/creatures/kaykit/animations-free.zip (already on disk)'],
  ]) {
    if (!(await exists(dir))) throw new Error(`missing ${dir} — ${hint}`);
  }

  const io = new NodeIO();
  const master = new Document();
  const scene = master.createScene('adventurers');
  master.getRoot().setDefaultScene(scene);

  const built = new Map();

  // ---- 1. Characters. Bones captured by ORIGINAL names first (step 2
  // matches clips against those), namespaced only afterwards (step 2b).
  const holders = [];
  for (const spec of CHARACTERS) {
    const file = path.join(CHAR_DIR, spec.file);
    if (!(await exists(file))) throw new Error(`missing ${file}`);
    const doc = await io.read(file);
    if (doc.getRoot().listAnimations().length) {
      throw new Error(`${spec.key}: expected an unanimated character file, got clips`);
    }
    const arrived = absorb(master, doc, mergeDocuments);
    const holder = foldIntoHolder(master, arrived.scenes, spec.key, scene);
    const bones = new Map();
    walkNodes(holder, (n) => { if (n !== holder && n.getName()) bones.set(n.getName(), n); });
    holders.push({ spec, holder, bones });
    built.set(spec.key, { spec, clips: [], holder, pack: 'kaykit-adventurers' });
  }

  // ---- 2. Clip library, copied onto EACH character (trap 3: a genuinely
  // shared library binds to exactly one skeleton after three.js's collision
  // rename; the copies share keyframe accessors so they cost records, not data).
  const byKey = new Map(holders.map((s) => [s.spec.key, s]));
  const plan = clipPlan();

  for (const [stem, byClip] of plan) {
    const file = path.join(CLIP_DIR, `${stem}.glb`);
    if (!(await exists(file))) throw new Error(`missing ${file}`);
    const doc = await io.read(file);
    const wanted = [...byClip.keys()];
    const want = new Set(wanted);
    dropClips(doc, (n) => want.has(n));
    const got = doc.getRoot().listAnimations().map((a) => a.getName());
    const missing = wanted.filter((w) => !got.includes(w));
    if (missing.length) throw new Error(`${stem}: clips not in the pack: ${missing.join(', ')}`);

    const arrived = absorb(master, doc, mergeDocuments);
    for (const anim of arrived.animations) {
      const clip = String(anim.getName());
      const owners = byClip.get(clip).map((k) => byKey.get(k));
      const [first, ...rest] = owners;
      for (const ch of anim.listChannels()) {
        const bone = first.bones.get(ch.getTargetNode().getName());
        if (!bone) {
          throw new Error(
            `${stem}/${clip} animates '${ch.getTargetNode().getName()}', which does not exist on ` +
            `${first.spec.key}. The rigs have diverged; retargeting is no longer valid.`,
          );
        }
        ch.setTargetNode(bone);
      }
      anim.setName(`${first.spec.key}__${clip.toLowerCase()}`);
      built.get(first.spec.key).clips.push(anim.getName());

      for (const other of rest) {
        const copy = retargetClone(master, anim, `${other.spec.key}__${clip.toLowerCase()}`, other.bones, first.bones);
        built.get(other.spec.key).clips.push(copy.getName());
      }
    }
    // The clips' own mannequin is now unreferenced. Skins first: disposing
    // joints out from under a live Skin leaves a hole in its joint list.
    const doomed = new Set();
    for (const s of arrived.scenes) for (const c of s.listChildren()) walkNodes(c, (n) => doomed.add(n));
    for (const skin of master.getRoot().listSkins()) {
      if (skin.listJoints().some((j) => doomed.has(j))) skin.dispose();
    }
    for (const s of arrived.scenes) {
      for (const c of s.listChildren()) { s.removeChild(c); disposeSubtree(c); }
      s.dispose();
    }
    const instances = [...byClip.values()].reduce((n, o) => n + o.length, 0);
    console.log(`[adventurers] + ${stem.replace('Rig_Medium_', '').padEnd(18)} ` +
      `${wanted.length} clips -> ${instances} per-character copies`);
  }

  // ---- 2b. Namespace bones AFTER retargeting (which matched original names).
  for (const { spec, holder } of holders) {
    prefixNodes(holder, spec.key);
    const clips = built.get(spec.key).clips;
    if (clips.length < MIN_CLIPS) {
      throw new Error(`${spec.key}: only ${clips.length} clips bound — under MIN_CLIPS ${MIN_CLIPS}`);
    }
    console.log(`[adventurers] + ${spec.key.padEnd(12)} ${clips.length} clips`);
  }

  // ---- 3. Hand props: static, no rig, parented at runtime.
  const props = new Map();
  for (const spec of PROPS) {
    const file = path.join(PROP_DIR, spec.file);
    if (!(await exists(file))) throw new Error(`missing ${file}`);
    const doc = await io.read(file);
    const arrived = absorb(master, doc, mergeDocuments);
    const holder = foldIntoHolder(master, arrived.scenes, spec.key, scene);
    prefixNodes(holder, spec.key);
    props.set(spec.key, spec);
  }
  console.log(`[adventurers] + ${props.size} props`);

  // ---- 4. dedup collapses the shared textures; unpartition is mandatory
  // (one Buffer per GLB).
  await master.transform(dedup(), prune(), unpartition());
  await shrinkPaletteAtlases(master);

  // ---- 5. structural asserts (the ones that fail silently at runtime)
  const scenes = master.getRoot().listScenes();
  if (scenes.length !== 1) throw new Error(`expected 1 scene before export, got ${scenes.length}`);
  const rootNames = scene.listChildren().map((n) => n.getName());
  for (const key of [...built.keys(), ...props.keys()]) {
    if (!rootNames.includes(key)) throw new Error(`'${key}' is not a root of the scene`);
  }
  const seen = new Map(); const dupes = [];
  for (const child of scene.listChildren()) {
    walkNodes(child, (n) => {
      const name = n.getName();
      if (!name) return;
      if (seen.has(name)) dupes.push(name);
      else seen.set(name, n);
    });
  }
  if (dupes.length) {
    throw new Error(`${dupes.length} duplicate node name(s), e.g. ${[...new Set(dupes)].slice(0, 6).join(', ')}`);
  }
  for (const mat of master.getRoot().listMaterials()) {
    const alpha = mat.getBaseColorFactor()[3];
    if (!(alpha > 0)) {
      throw new Error(`material '${mat.getName()}' has baseColorFactor alpha ${alpha}`);
    }
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-adventurers-'));
  const rawGlb = path.join(tmp, 'adventurers-raw.glb');
  await fs.mkdir(path.dirname(OUT_GLB), { recursive: true });
  await io.write(rawGlb, master);
  const rawBytes = (await fs.stat(rawGlb)).size;

  // ---- 6. meshopt; -kn mandatory.
  const gltfpack = path.join(ROOT, 'node_modules', '.bin', 'gltfpack');
  if (!(await exists(gltfpack))) throw new Error(`gltfpack not found at ${gltfpack} — run: npm i -D gltfpack`);
  await run(gltfpack, ['-i', rawGlb, '-o', OUT_GLB, '-cc', '-kn'], { label: 'gltfpack' });
  await fs.rm(tmp, { recursive: true, force: true });
  const bytes = (await fs.stat(OUT_GLB)).size;

  // ---- 7. read back and assert the compressor kept what matters.
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  const readIo = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const finalDoc = await readIo.read(OUT_GLB);
  const finalRoot = finalDoc.getRoot();
  if (finalRoot.listScenes().length !== 1) {
    throw new Error(`gltfpack produced ${finalRoot.listScenes().length} scenes`);
  }
  const finalRoots = new Set(finalRoot.listScenes()[0].listChildren().map((n) => n.getName()));
  const lostNodes = [...built.keys(), ...props.keys()].filter((k) => !finalRoots.has(k));
  if (lostNodes.length) {
    throw new Error(`gltfpack dropped node name(s): ${lostNodes.join(', ')} — the -kn failure mode.`);
  }
  const finalClips = new Set(finalRoot.listAnimations().map((a) => a.getName()));
  const expectedClips = [...new Set([...built.values()].flatMap((b) => b.clips))];
  const lostClips = expectedClips.filter((c) => !finalClips.has(c));
  if (lostClips.length) {
    throw new Error(`gltfpack dropped ${lostClips.length} animation name(s), e.g. ${lostClips.slice(0, 5).join(', ')}`);
  }
  if (!finalRoot.listExtensionsUsed().some((e) => e.extensionName === 'EXT_meshopt_compression')) {
    throw new Error('EXT_meshopt_compression missing from output');
  }

  // ---- 8. manifest (creatures.json schema, so consumers can share tooling)
  const vocabulary = [...new Set([...clipPlan().values()].flatMap((m) => [...m.keys()]))].sort();
  const triCount = (key) => {
    const root = finalRoot.listScenes()[0].listChildren().find((n) => n.getName() === key);
    let t = 0;
    if (root) walkNodes(root, (n) => {
      const mesh = n.getMesh();
      if (mesh) for (const p of mesh.listPrimitives()) {
        const i = p.getIndices(), pos = p.getAttribute('POSITION');
        t += Math.floor((i ? i.getCount() : pos ? pos.getCount() : 0) / 3);
      }
    });
    return t;
  };
  const manifest = {
    generated: new Date().toISOString(),
    glb: 'models/adventurers.glb',
    bytes,
    note: 'Character keys are lowercase and are DIRECT children of the single scene. ' +
      'Every clip is named `<character key>__<clip>` and binds to that character ONLY — ' +
      'each of the five carries its own namespaced copy of the shared KayKit vocabulary, ' +
      'because three.js GLTFLoader renames duplicate node names on load and a genuinely ' +
      'shared clip library binds to exactly one of them. Build the AnimationMixer against ' +
      'a SkeletonUtils.clone of the character subtree. Deliverable only this wave: ' +
      'no src/ consumer exists yet.',
    sources: [
      {
        pack: 'KayKit Character Pack: Adventurers (FREE tier, 2.0)', author: 'Kay Lousberg',
        licence: 'CC0 1.0 (License.txt inside the zip re-verified at download time)',
        url: 'https://kaylousberg.itch.io/kaykit-adventurers', downloaded: '2026-08-07',
        used: CHARACTERS.length, available: 6,
        note: 'Rogue_Hooded left in source unconverted; pristine zip at assets/source/creatures/kaykit/adventurers-free.zip.',
      },
      {
        pack: 'KayKit Character Animations (FREE tier, 1.1)', author: 'Kay Lousberg',
        licence: 'CC0 1.0', url: 'https://kaylousberg.itch.io/kaykit-character-animations',
        downloaded: '2026-08-06 (skeletons wave; re-used from assets/source/creatures/kaykit/animations-free.zip)',
        used: vocabulary.length, available: 133,
      },
    ],
    kaykitClipVocabulary: vocabulary,
    characters: {},
    props: {},
  };
  for (const spec of PROPS) {
    manifest.props[spec.key] = {
      pack: 'kaykit-adventurers',
      attach: spec.attach,
      attachNodeFor: Object.fromEntries(spec.suits.map((k) => [k, `${k}_${spec.attach}`])),
      suits: spec.suits,
    };
  }
  for (const [key, b] of built) {
    manifest.characters[key] = {
      pack: b.pack,
      role: b.spec.role,
      archetype: b.spec.archetype,
      note: b.spec.note,
      clips: b.clips,
      triangles: triCount(key),
    };
  }
  await fs.writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  let triangles = 0;
  for (const m of finalRoot.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const i = p.getIndices(), pos = p.getAttribute('POSITION');
      triangles += Math.floor((i ? i.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  }
  console.log(
    `[adventurers] wrote ${path.relative(ROOT, OUT_GLB)}  ${(bytes / 1024).toFixed(1)} KB ` +
    `(raw ${(rawBytes / 1024).toFixed(1)} KB, ${(100 - bytes / rawBytes * 100).toFixed(0)}% off)`,
  );
  console.log(
    `[adventurers] ${built.size} characters  ${props.size} props  ${triangles} tris  ` +
    `${finalRoot.listMaterials().length} materials  ${finalRoot.listTextures().length} textures  ` +
    `${finalRoot.listAnimations().length} clips`,
  );
  console.log(`[adventurers] manifest ${path.relative(ROOT, OUT_MANIFEST)}`);
  return { file: OUT_GLB, manifestFile: OUT_MANIFEST, bytes, characters: built.size, clips: finalRoot.listAnimations().length };
}

// ------------------------------------------------------------------- verify

export async function verifyAdventurersGlb() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  if (!(await exists(OUT_GLB))) throw new Error(`${OUT_GLB} missing`);
  if (!(await exists(OUT_MANIFEST))) throw new Error(`${OUT_MANIFEST} missing`);
  const manifest = JSON.parse(await fs.readFile(OUT_MANIFEST, 'utf8'));
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(OUT_GLB);
  const root = doc.getRoot();
  if (root.listScenes().length !== 1) throw new Error(`expected 1 scene, got ${root.listScenes().length}`);
  if (!root.listExtensionsUsed().some((e) => e.extensionName === 'EXT_meshopt_compression')) {
    throw new Error('EXT_meshopt_compression missing');
  }
  const roots = new Set(root.listScenes()[0].listChildren().map((n) => n.getName()));
  const clips = new Set(root.listAnimations().map((a) => a.getName()));
  for (const [key, c] of Object.entries(manifest.characters)) {
    if (key !== key.toLowerCase()) throw new Error(`non-lowercase key ${key}`);
    if (!roots.has(key)) throw new Error(`character '${key}' missing from GLB roots`);
    for (const clip of c.clips) {
      if (!clips.has(clip)) throw new Error(`clip '${clip}' missing from GLB`);
    }
  }
  for (const key of Object.keys(manifest.props)) {
    if (!roots.has(key)) throw new Error(`prop '${key}' missing from GLB roots`);
  }
  if (root.listSkins().length < Object.keys(manifest.characters).length) {
    throw new Error(`only ${root.listSkins().length} skins for ${Object.keys(manifest.characters).length} characters`);
  }
  console.log(`[adventurers] verify OK: ${Object.keys(manifest.characters).length} characters, ` +
    `${Object.keys(manifest.props).length} props, ${root.listAnimations().length} clips, ` +
    `${root.listSkins().length} skins, meshopt present`);
  return true;
}

// ---------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--verify')) await verifyAdventurersGlb();
    else { await buildAdventurersGlb(); await verifyAdventurersGlb(); }
  } catch (e) {
    console.error(`[adventurers] FAILED: ${e.message}`);
    process.exit(1);
  }
}
