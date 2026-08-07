// Convert the CC0 creature packs into ONE meshopt-compressed GLB the game can
// preload alongside public/models/items.glb.
//
//   node tools/build-creatures-glb.mjs [--out public/models/creatures.glb]
//                                      [--src assets/source/creatures]
//                                      [--manifest public/models/creatures.json]
//
// SOURCES (all CC0, no attribution obligation):
//   * Quaternius "Ultimate Monsters"        https://quaternius.com/packs/ultimatemonsters.html
//   * KayKit "Character Pack: Skeletons"    https://kaylousberg.itch.io/kaykit-skeletons  (FREE tier)
//   * KayKit "Character Animations"         https://kaylousberg.itch.io/kaykit-character-animations (FREE tier)
//
// WHY THIS DOES NOT GO THROUGH BLENDER, unlike tools/build-items-glb.mjs.
// The item pack shipped as FBX with no rig, so Blender was the only thing that
// could read it. Every creature source here is already glTF 2.0 with skins and
// named animation clips, and a Blender round-trip on a rigged, animated asset
// is a net risk: it renumbers actions, re-derives bone roll, and drops clip
// names. gltf-transform edits the same files in place with no re-authoring, so
// that is what this uses. The compression tail is IDENTICAL to the item pack --
// gltfpack -cc -kn, meshopt, never Draco -- for the reasons in that file's
// header (DRACOLoader resolves its decoder at runtime and fails silently
// on-device under Capacitor, which breaks the offline guarantee).
//
// THE FOUR THINGS HERE THAT FAIL SILENTLY IF CHANGED:
//
//   1. gltfpack MUST get -kn. Same trap as the item pack: without it the node
//      names are stripped, the GLB still loads, and every creature lookup in
//      the game returns null.
//   2. Exactly ONE scene. gltf-transform's merge() appends the incoming
//      document's scenes rather than its nodes, and three.js renders scenes[0]
//      only -- so an unconsolidated merge shows one creature and hides 17.
//      foldIntoHolder() below is what prevents that, and the assert after
//      gltfpack is what proves it.
//   3. EVERY NODE NAME IN THE FILE IS UNIQUE, and there is an assert for it.
//      This one was learned the expensive way. All four KayKit skeletons carry
//      the byte-identical 23-bone `Rig_Medium`, so the obvious build shares one
//      library of clips across all four -- an AnimationMixer resolves tracks by
//      NAME, so it should just work. It does not. three.js GLTFLoader passes
//      every node name through GLTFParser.createUniqueName, which appends a
//      counter on collision across the whole file: four bones called `root`
//      load as root, root_1, root_2, root_3. The clips then bind to exactly one
//      skeleton and the other three stand in bind pose forever. three.js says
//      so only as a console warning per track, which nothing reads. Hence:
//      bones are namespaced per creature, and each skeleton carries its own
//      copy of every clip it uses (sharing the keyframe accessors, so the cost
//      is JSON records rather than animation data).
//   4. Creature keys are lowercase. macOS is case-insensitive and Android is
//      not, so a `Ghost_Skull` that resolves on this Mac is a null on-device.
//
// MIXER CONTRACT for whoever wires this into the game:
//   const src = scene.getObjectByName('skeleton_warrior');   // lowercase key
//   const inst = SkeletonUtils.clone(src);                   // NOT Object3D.clone
//   const mixer = new THREE.AnimationMixer(inst);            // <- the CLONE
//   mixer.clipAction(clipsByName.get('skeleton_warrior__skeletons_idle')).play();
// Clip names are always `<creature key>__<clip>`, and a clip belongs to exactly
// one creature -- there is no shared library to reach for, by design (see 3).
// public/models/creatures.json lists each creature's clips verbatim.
//
// public/models/creatures.glb MUST be committed. The sources are large,
// gitignored, and pulled from Google Drive / itch.io at build time, so CI can
// never regenerate this file.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_SRC = path.join(ROOT, 'assets', 'source', 'creatures');
const DEFAULT_OUT = path.join(ROOT, 'public', 'models', 'creatures.glb');
const DEFAULT_MANIFEST = path.join(ROOT, 'public', 'models', 'creatures.json');

// ---------------------------------------------------------------- curation
//
// The Quaternius pack is 50 monsters and MOST of them are tonally wrong for
// this game -- it is a cartoon pack: candy palette, sleepy-slit eyes, a cactus
// in a sombrero, a chicken, a dog, bees. Every model below was rendered and
// looked at individually before it was let in (tools/ has no renderer; the
// contact sheet was a throwaway Blender script). What survived is the subset
// whose silhouette reads as a threat rather than a mascot.
//
// REJECTED after looking, with reasons, so nobody re-adds them by name:
//   BlueDemon      - carries a baseball bat
//   Dino           - pink, bell collar, reads as a pet
//   Ninja          - chibi ninja; also no ninjas in this bestiary
//   Hywirl         - limp-limbed purple sleepy blob
//   Squidle        - lolling tongue, comic
//   Goleling       - bland; its Evolved form covers the same silhouette
//   Bunny / Cat / Chicken / Dog / Pigeon / Fish / Frog / Birb / Armabee /
//   Alpaking / Glub / Mushnub / MushroomKing / Cactoro / Wizard / PinkBlob
//                  - never downloaded; cute by construction
//
// `rank` is the gate this creature is TUNED for; `alsoRanks` are the gates it
// can be reused in. Both are advisory -- the manifest is data for whoever
// wires spawning, not a schedule this file enforces.
const QUATERNIUS = [
  // --- key ------------ group --- file ------------- drive id -------------------------- rank  alsoRanks    role     archetype  boss
  { key: 'greenblob',       group: 'blob',   file: 'GreenBlob.gltf',       drive: '1Qj3EPCAzN7P3KNrfjV_sFMw98nsBUyob', rank: 'E', alsoRanks: ['D'],          role: 'trash', archetype: 'grunt',   boss: null,
    note: 'Dark-green single-eyed ooze. The one Quaternius blob whose palette is muddy enough for the Warren.' },
  { key: 'greenspikyblob',  group: 'blob',   file: 'GreenSpikyBlob.gltf',  drive: '125zPNBLl1VAgzhfVom9Kj29hSClaZhjF', rank: 'E', alsoRanks: ['D', 'C'],     role: 'trash', archetype: 'grunt',   boss: null,
    note: 'Spiked variant of the same ooze; the spines read as a hazard tell.' },
  { key: 'tribal',          group: 'big',    file: 'Tribal.gltf',          drive: '1hWEwACHKMfDzYbqG2Cum3KP6semUY_Ap', rank: 'E', alsoRanks: ['D'],          role: 'trash', archetype: 'grunt',   boss: null,
    note: 'Masked humanoid with a feather crest. Best plain-grunt silhouette in the pack.' },
  { key: 'orc',             group: 'big',    file: 'Orc.gltf',             drive: '17675H4Owu5FeHUk_7Goyc9TKI5YK3cEM', rank: 'E', alsoRanks: ['D', 'C'],     role: 'elite', archetype: 'brute',   boss: null,
    note: 'Green club-swinging goblinoid. Reads as a heavy without reading as a joke.' },
  { key: 'orc_skull',       group: 'big',    file: 'Orc_Skull.gltf',       drive: '13wbbztVj_2eYyF5lavumLvK9JyCfQEhI', rank: 'D', alsoRanks: ['C'],          role: 'boss',  archetype: 'brute',   boss: 'gravelord',
    note: 'Skull-headed spiked brute. THE GRAVELORD: a ground heavy, which is what the D boss stats describe (900hp, scale 2.7).' },
  { key: 'ghost',           group: 'flying', file: 'Ghost.gltf',           drive: '1rUs1QRA9v1Y2wRYEXsfteBisTsz4JlLi', rank: 'D', alsoRanks: ['C', 'A'],     role: 'trash', archetype: 'stalker', boss: null,
    note: 'Black hooded wraith. Reads undead and moves on the flying rig, so it can hover the Ossuary.' },
  { key: 'ghost_skull',     group: 'flying', file: 'Ghost_Skull.gltf',     drive: '1JIw8lx6H5IIhf_3Z5FprEu_yCoMcoRN7', rank: 'D', alsoRanks: ['C', 'A'],     role: 'elite', archetype: 'howler',  boss: null,
    note: 'Bone-skulled wraith. The bare skull is the strongest undead read in the pack after the KayKit set.' },
  { key: 'yeti',            group: 'big',    file: 'Yeti.gltf',            drive: '1_skNq11VXoaGPu9D-hHb4-0OQXEWNTzY', rank: 'C', alsoRanks: ['B'],          role: 'boss',  archetype: 'brute',   boss: 'frostcaller',
    note: 'Pale white/blue ghoul, open jaw. FROSTCALLER: already the right palette for Deepglass, no recolour needed.' },
  { key: 'goleling_evolved',group: 'flying', file: 'Goleling_Evolved.gltf',drive: '1DXqke-QxMth9mq5eYiawcmJDACm4-jvL', rank: 'B', alsoRanks: ['A'],          role: 'trash', archetype: 'howler',  boss: null,
    note: 'Crowned imp caught mid-scream. Literally a howler; the open mouth sells the support-shout tell.' },
  { key: 'dragon',          group: 'flying', file: 'Dragon.gltf',          drive: '1-mQSm6_oGt7-EEQfNj1dFWYgPQy4AdPC', rank: 'B', alsoRanks: ['A', 'S'],     role: 'trash', archetype: 'stalker', boss: null,
    note: 'Small horned bat-dragon, ember palette. Flying trash for Emberfall.' },
  // flying/Demon.gltf was downloaded, rendered, approved on looks -- and then
  // cut, because Quaternius ships it with exactly ONE clip (Flying_Idle) while
  // every other creature on that rig gets eight. An elite that cannot attack is
  // not an elite. MIN_CLIPS below is the guard that catches the next one.
  { key: 'demon',         group: 'big',    file: 'Demon.gltf',           drive: '1XhBLnR6tjqIrFy0AUfRlqKf-hYmVwIR4', rank: 'B', alsoRanks: ['A', 'S'],     role: 'boss',  archetype: 'brute',   boss: 'infernus',
    note: 'Red horned demon with a trident. INFERNUS. TWO CAVEATS, both checked by rendering it: (1) it wears a black halo hoop, which is a visual gag, and the halo is welded into the body mesh -- there is no node to hide, so removing it means editing geometry. (2) the trident IS a separate node (`demon_Trident`) and can be hidden or swapped for an item-pack weapon. It is the most cartoonish thing admitted to this set; at the B boss scale of 2.9 that will show.' },
  { key: 'alien',           group: 'big',    file: 'Alien.gltf',           drive: '1rWF4Jo_G7-odDa5LfkQ0e2d9_p9pxb3W', rank: 'A', alsoRanks: ['S'],          role: 'boss',  archetype: 'stalker', boss: 'weaver',
    note: 'Purple tentacle-headed humanoid. THE VOIDWEAVER: the tentacles and the Riven Waste palette line up exactly.' },
  { key: 'dragon_evolved',  group: 'flying', file: 'Dragon_Evolved.gltf',  drive: '1Mcfuavq7F4itG9xhqc-20_IL257ZY2_3', rank: 'S', alsoRanks: ['A'],          role: 'boss',  archetype: 'lancer',  boss: 'archon',
    note: 'WEAKEST MATCH IN THE SET, flagged deliberately. Nothing in this pack is a credible THE RIFT ARCHON (9800hp, scale 3.4) -- this is a chibi bat-dragon and will look like one when scaled 3.4x. Treat it as a placeholder and source the S boss elsewhere.' },
];

// KayKit is the tonal anchor. Muted bone/steel/oxblood, no cartoon eyes, and a
// shared rig -- it is a better fit for this game than anything in Quaternius,
// which is why the undead ranks lean on it.
const KAYKIT_CHARACTERS = [
  { key: 'skeleton_minion',  file: 'Skeleton_Minion.glb',  rank: 'D', alsoRanks: ['E', 'C'], role: 'trash', archetype: 'grunt',   boss: null,
    note: 'Bare skeleton, no kit. The Ossuary\'s baseline body.' },
  { key: 'skeleton_rogue',   file: 'Skeleton_Rogue.glb',   rank: 'D', alsoRanks: ['C', 'B'], role: 'trash', archetype: 'stalker', boss: null,
    note: 'Hooded, caped, dagger. Fast-lunge body.' },
  { key: 'skeleton_mage',    file: 'Skeleton_Mage.glb',    rank: 'D', alsoRanks: ['C', 'B'], role: 'elite', archetype: 'caster',  boss: null,
    note: 'Hat and robe. The only credible Hexcaster in either pack.' },
  { key: 'skeleton_warrior', file: 'Skeleton_Warrior.glb', rank: 'E', alsoRanks: ['D', 'C'], role: 'boss',  archetype: 'lancer',  boss: 'warden',
    note: 'Horned helm, shield, axe. THE HOLLOW WARDEN: an armoured undead guardian is what that name and the E-gate blurb describe.' },
];

// Which of the 133 KayKit clips to actually ship. The pack is a general-purpose
// character library -- fishing, lockpicking, push-ups -- and none of that has a
// caller in a wave-combat game.
//
// Clips are assigned PER SKELETON rather than as one library, for two reasons.
// The design reason: the mage does not need a two-handed spin attack and the
// minion does not need a bow draw. The mechanical reason: every skeleton needs
// its own namespaced copy of every clip it uses (see step 3), so an unused clip
// is not free -- it is paid for four times.
const KAYKIT_CLIPS_COMMON = {
  // The Special file is the reason this pack was worth downloading: a
  // purpose-built skeleton set including rising-from-the-floor, which is the
  // literal staging of the D-gate blurb ("buried standing up. They still are").
  Rig_Medium_Special: [
    'Skeletons_Awaken_Standing', 'Skeletons_Idle', 'Skeletons_Walking',
    'Skeletons_Death', 'Skeletons_Taunt',
  ],
  Rig_Medium_General: ['Idle_A', 'Hit_A', 'Hit_B'],
  Rig_Medium_MovementBasic: ['Walking_A', 'Running_A'],
};

const KAYKIT_CLIPS_BY_CREATURE = {
  skeleton_warrior: {
    Rig_Medium_Special: ['Skeletons_Awaken_Floor', 'Skeletons_Death_Resurrect'],
    Rig_Medium_CombatMelee: ['Melee_2H_Attack_Chop', 'Melee_2H_Attack_Spinning', 'Melee_Blocking'],
  },
  skeleton_minion: {
    Rig_Medium_Special: ['Skeletons_Awaken_Floor', 'Skeletons_Spawn_Ground'],
    Rig_Medium_CombatMelee: ['Melee_Unarmed_Attack_Punch_A', 'Melee_1H_Attack_Chop'],
  },
  skeleton_rogue: {
    Rig_Medium_CombatMelee: ['Melee_1H_Attack_Stab'],
    Rig_Medium_MovementAdvanced: ['Dodge_Backward'],
    // Two-handed, not Ranged_Bow_*: the FREE tier ships a CROSSBOW and no bow,
    // and a draw-and-release cycle with nothing in frame to draw reads as a bug.
    Rig_Medium_CombatRanged: ['Ranged_2H_Aiming', 'Ranged_2H_Shoot', 'Ranged_2H_Reload'],
  },
  skeleton_mage: {
    Rig_Medium_CombatRanged: ['Ranged_Magic_Spellcasting', 'Ranged_Magic_Shoot', 'Ranged_Magic_Summon'],
  },
};

// The skeleton characters ship UNARMED -- KayKit keeps the kit as separate
// static models meant to be parented to the rig's `handslot.l` / `handslot.r`
// bones. Without these the E boss is an empty-handed skeleton and the rogue
// mimes a crossbow it does not have, so they come along. They are static props,
// not creatures: no rig, no clips, and they live in the manifest's `props`.
const KAYKIT_PROPS = [
  { key: 'kaykit_axe',            file: 'Skeleton_Axe.gltf',            attach: 'handslot_r', suits: ['skeleton_warrior'] },
  { key: 'kaykit_blade',          file: 'Skeleton_Blade.gltf',          attach: 'handslot_r', suits: ['skeleton_minion', 'skeleton_rogue'] },
  { key: 'kaykit_crossbow',       file: 'Skeleton_Crossbow.gltf',       attach: 'handslot_r', suits: ['skeleton_rogue'] },
  { key: 'kaykit_staff',          file: 'Skeleton_Staff.gltf',          attach: 'handslot_r', suits: ['skeleton_mage'] },
  { key: 'kaykit_shield_large_a', file: 'Skeleton_Shield_Large_A.gltf', attach: 'handslot_l', suits: ['skeleton_warrior'] },
  { key: 'kaykit_shield_small_a', file: 'Skeleton_Shield_Small_A.gltf', attach: 'handslot_l', suits: ['skeleton_minion'] },
  { key: 'kaykit_quiver',         file: 'Skeleton_Quiver.gltf',         attach: 'spine',      suits: ['skeleton_rogue'] },
];

/** stem -> clip -> [creature keys that want it] */
function kaykitClipPlan() {
  const plan = new Map();
  const add = (stem, clip, key) => {
    if (!plan.has(stem)) plan.set(stem, new Map());
    const byClip = plan.get(stem);
    if (!byClip.has(clip)) byClip.set(clip, []);
    byClip.get(clip).push(key);
  };
  for (const spec of KAYKIT_CHARACTERS) {
    for (const [stem, clips] of Object.entries(KAYKIT_CLIPS_COMMON)) {
      for (const clip of clips) add(stem, clip, spec.key);
    }
    for (const [stem, clips] of Object.entries(KAYKIT_CLIPS_BY_CREATURE[spec.key] || {})) {
      for (const clip of clips) add(stem, clip, spec.key);
    }
  }
  return plan;
}

// Quaternius clips worth shipping, by lowercased name. The packs' three rigs
// use different vocabularies (Big says HitReact, Blob says HitRecieve -- the
// typo is theirs), so this matches on the union rather than per-rig.
const QUATERNIUS_KEEP_CLIPS = new Set([
  'idle', 'walk', 'run', 'jump',
  'punch', 'weapon', 'bite_front', 'headbutt',
  'hitreact', 'hitrecieve', 'death',
  'flying_idle', 'fast_flying',
]);

// Palette atlases only. Quaternius ships the same flat colour grid at 32x32 for
// two of its rigs and 1024x1024 for the third; a 1024 palette costs 4 MB of GPU
// memory to store ~9 distinct colours. Downscaling is only attempted when the
// mesh proves the texture is a palette (few distinct UVs) and is only KEPT when
// every one of those UVs samples the identical pixel afterwards.
// A creature that only idles cannot be a combat entity. flying/Demon.gltf ships
// exactly one clip and this is what caught it, after the eye had already
// approved the model.
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

/** The KayKit zips expand to a version-stamped directory; find it rather than
 *  hardcoding 1.1, so a 1.2 re-download does not silently build nothing. */
async function findDir(root, prefix) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const hit = entries.find((e) => e.isDirectory() && e.name.startsWith(prefix));
  if (!hit) throw new Error(`no directory starting with ${prefix} in ${root}`);
  return path.join(root, hit.name);
}

// --------------------------------------------------------- doc utilities

function walkNodes(node, fn) {
  fn(node);
  for (const child of node.listChildren()) walkNodes(child, fn);
}

/** Depth-first dispose so a parent never outlives a child reference. */
function disposeSubtree(node) {
  for (const child of node.listChildren()) disposeSubtree(child);
  node.dispose();
}

/**
 * Absorb `other` into `master` and report what arrived. gltf-transform's merge
 * copies every resource AND appends the incoming scenes, which is trap #2 in
 * the header -- the caller is responsible for folding those scenes away.
 */
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

/** Move every root of `scenes` under one new node named `key`, then drop the
 *  now-empty scenes. This is what keeps the output at exactly one scene. */
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

/** glTF node names survive into three.js as-is apart from PropertyBinding's
 *  sanitiser, which deletes `. [ ] : /`. Doing that substitution here instead
 *  means the names in the GLB are already the names the AnimationMixer will
 *  look for, so a debug session never has to reason about two spellings. */
function safeName(name) {
  return name.replace(/[.[\]:/]/g, '_').replace(/\s+/g, '_');
}

function prefixNodes(holder, key) {
  walkNodes(holder, (node) => {
    if (node === holder) return;
    node.setName(`${key}_${safeName(node.getName() || 'node')}`);
  });
}

/**
 * Copy an animation onto a different skeleton that carries the same bone names.
 *
 * The samplers deliberately reuse the SOURCE accessors instead of copying them:
 * the keyframe data is bit-identical between the four KayKit skeletons, so
 * sharing it means four copies of a clip cost four sets of channel records and
 * one set of keyframe buffers. glTF explicitly permits several samplers to point
 * at the same accessor.
 */
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

// ------------------------------------------------------------ the build

export async function buildCreaturesGlb({
  srcDir = DEFAULT_SRC,
  outFile = DEFAULT_OUT,
  manifestFile = DEFAULT_MANIFEST,
} = {}) {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const { dedup, prune, unpartition, mergeDocuments } = await import('@gltf-transform/functions');

  const quatDir = path.join(srcDir, 'quaternius');
  const kayDir = path.join(srcDir, 'kaykit');
  if (!(await exists(quatDir)) || !(await exists(kayDir))) {
    throw new Error(
      `creature sources not found under ${srcDir}. They are gitignored and pulled from ` +
      `Google Drive (Quaternius) and itch.io (KayKit) -- see the header for the URLs.`,
    );
  }
  const skelRoot = await findDir(kayDir + '/skeletons', 'KayKit_Skeletons');
  const animRoot = await findDir(kayDir + '/animations', 'KayKit_Character_Animations');
  const charDir = path.join(skelRoot, 'characters', 'gltf');
  const clipDir = path.join(animRoot, 'Animations', 'gltf', 'Rig_Medium');

  const io = new NodeIO();
  const master = new Document();
  const scene = master.createScene('creatures');
  master.getRoot().setDefaultScene(scene);

  /** key -> { clips: [], triangles, source } */
  const built = new Map();

  // ---- 1. Quaternius. Fully namespaced: their rigs are per-creature, their
  // bone names are generic ('Bone.001'), and nothing is shared between them,
  // so there is no reason to leave a collision lying around.
  for (const spec of QUATERNIUS) {
    const file = path.join(quatDir, spec.group, spec.file);
    if (!(await exists(file))) {
      throw new Error(`missing ${file} (Drive id ${spec.drive})`);
    }
    const doc = await io.read(file);
    const before = doc.getRoot().listAnimations().length;
    dropClips(doc, (n) => QUATERNIUS_KEEP_CLIPS.has(String(n).toLowerCase()));
    const kept = doc.getRoot().listAnimations();
    if (kept.length < MIN_CLIPS) {
      throw new Error(
        `${spec.key}: only ${kept.length} usable clip(s) out of ${before} ` +
        `(${doc.getRoot().listAnimations().map((a) => a.getName()).join(', ') || 'none'}). ` +
        `Either the pack ships this model under-animated -- cut it -- or QUATERNIUS_KEEP_CLIPS ` +
        `is missing this rig's vocabulary.`,
      );
    }
    const clipNames = [];
    for (const anim of kept) {
      const name = `${spec.key}__${String(anim.getName()).toLowerCase()}`;
      anim.setName(name);
      clipNames.push(name);
    }
    const arrived = absorb(master, doc, mergeDocuments);
    const holder = foldIntoHolder(master, arrived.scenes, spec.key, scene);
    prefixNodes(holder, spec.key);
    built.set(spec.key, { spec, clips: clipNames, holder, pack: 'quaternius' });
    console.log(`[creatures] + ${spec.key.padEnd(18)} ${String(before).padStart(2)} clips -> ${clipNames.length}`);
  }

  // ---- 2. KayKit characters. Bones are captured by their ORIGINAL names
  // first, because step 3 matches clips against those names, and only namespaced
  // afterwards in step 3b.
  const skeletonHolders = [];
  for (const spec of KAYKIT_CHARACTERS) {
    const file = path.join(charDir, spec.file);
    if (!(await exists(file))) throw new Error(`missing ${file}`);
    const doc = await io.read(file);
    if (doc.getRoot().listAnimations().length) {
      throw new Error(`${spec.key}: expected an unanimated character file, got clips`);
    }
    const arrived = absorb(master, doc, mergeDocuments);
    const holder = foldIntoHolder(master, arrived.scenes, spec.key, scene);
    const bones = new Map();
    walkNodes(holder, (n) => { if (n !== holder && n.getName()) bones.set(n.getName(), n); });
    skeletonHolders.push({ spec, holder, bones });
    built.set(spec.key, { spec, clips: [], holder, pack: 'kaykit' });
  }

  // ---- 3. The KayKit clip library, COPIED ONTO EACH of the four skeletons.
  //
  // The obvious design is to ship these clips once: all four skeletons carry the
  // byte-identical 23-bone Rig_Medium, an AnimationMixer resolves tracks by NAME,
  // so one library should drive all four. That was built, and it does not work,
  // and the way it fails is invisible.
  //
  // three.js GLTFLoader runs every node name through GLTFParser.createUniqueName,
  // which appends a counter on collision across the WHOLE file. Four skeletons
  // sharing a bone called `root` do not load as four nodes called `root`; they
  // load as root, root_1, root_2, root_3. The clips -- authored against whichever
  // skeleton the channels pointed at -- then bind to exactly one of the four, and
  // three.js reports it as a console warning per track, which nothing reads. The
  // other three skeletons render in bind pose and never move.
  //
  // So: every skeleton gets its own namespaced bones AND its own copy of every
  // clip. The copies are cheap because the cloned channels reference the SAME
  // input/output Accessors rather than new ones -- only the channel/sampler
  // records are duplicated, not the keyframe data.
  const byKey = new Map(skeletonHolders.map((s) => [s.spec.key, s]));
  const plan = kaykitClipPlan();

  for (const [stem, byClip] of plan) {
    const file = path.join(clipDir, `${stem}.glb`);
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
      // The first owner takes the original by retargeting it in place; the rest
      // get clones that share its keyframe accessors.
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
    // Every channel now points at a real skeleton bone, so the mannequin the
    // clips shipped inside is unreferenced and can go. Skins first: disposing
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
    console.log(`[creatures] + kaykit ${stem.replace('Rig_Medium_', '').padEnd(18)} ` +
      `${wanted.length} clips -> ${instances} per-skeleton copies`);
  }

  // ---- 3b. Namespace the skeleton bones. This has to happen AFTER retargeting
  // (which matches on the original names) and is what stops three.js renaming
  // them behind our back.
  for (const { spec, holder } of skeletonHolders) {
    prefixNodes(holder, spec.key);
    console.log(`[creatures] + ${spec.key.padEnd(18)} ${built.get(spec.key).clips.length} clips`);
  }

  // ---- 3c. KayKit accessories. Static meshes, no rig, no clips -- they are
  // parented onto a skeleton's handslot bone at runtime.
  const props = new Map();
  const propDir = path.join(skelRoot, 'assets', 'gltf');
  for (const spec of KAYKIT_PROPS) {
    const file = path.join(propDir, spec.file);
    if (!(await exists(file))) throw new Error(`missing ${file}`);
    const doc = await io.read(file);
    const arrived = absorb(master, doc, mergeDocuments);
    const holder = foldIntoHolder(master, arrived.scenes, spec.key, scene);
    prefixNodes(holder, spec.key);
    props.set(spec.key, spec);
  }
  console.log(`[creatures] + ${String(props.size).padStart(2)} kaykit accessories`);

  // ---- 4. dedup + prune. The four skeleton files each embed their own copy of
  // the identical 17 KB skeleton_texture; dedup is what collapses them.
  // unpartition is not optional: every merged source arrives with its own
  // Buffer, and a GLB is allowed exactly one. Without this the write fails with
  // 'GLB must have 0-1 buffers', which at least is loud.
  await master.transform(dedup(), prune(), unpartition());

  // ---- 5. Palette atlas downscale, verified pixel-for-pixel at every UV the
  // meshes actually sample.
  const paletteTextures = await shrinkPaletteAtlases(master);
  const paletteNames = new Set([...paletteTextures].map((t) => t.getName()));

  // ---- 6. one scene, no exceptions
  const scenes = master.getRoot().listScenes();
  if (scenes.length !== 1) {
    throw new Error(`expected 1 scene before export, got ${scenes.length} -- merge was not consolidated`);
  }
  const rootNames = scene.listChildren().map((n) => n.getName());
  for (const key of [...built.keys(), ...props.keys()]) {
    if (!rootNames.includes(key)) throw new Error(`'${key}' is not a root of the scene`);
  }

  // No duplicate node names ANYWHERE. This is the assertion that would have
  // caught the shared-clip design described in step 3: three.js silently
  // renames colliding nodes on load (root -> root_1 -> root_2), which unbinds
  // every animation track that pointed at the losers. Warnings only, no throw,
  // and the creature just stands still.
  const seen = new Map();
  const dupes = [];
  for (const child of scene.listChildren()) {
    walkNodes(child, (n) => {
      const name = n.getName();
      if (!name) return;
      if (seen.has(name)) dupes.push(name);
      else seen.set(name, n);
    });
  }
  if (dupes.length) {
    throw new Error(
      `${dupes.length} duplicate node name(s), e.g. ${[...new Set(dupes)].slice(0, 6).join(', ')}. ` +
      `three.js GLTFLoader will rename these on load and silently unbind their animation tracks.`,
    );
  }

  // The item pack shipped materials with baseColorFactor alpha 0: correct
  // geometry, correct bounds, nothing drawn, and no warning anywhere. Cheap to
  // check, so check it.
  for (const mat of master.getRoot().listMaterials()) {
    const alpha = mat.getBaseColorFactor()[3];
    if (!(alpha > 0)) {
      throw new Error(`material '${mat.getName()}' has baseColorFactor alpha ${alpha} -- ` +
        `this renders nothing and warns about nothing (the item pack's failure mode)`);
    }
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-creatures-'));
  const rawGlb = path.join(tmp, 'creatures-raw.glb');
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await io.write(rawGlb, master);
  const rawBytes = (await fs.stat(rawGlb)).size;

  // ---- 7. meshopt. -kn is MANDATORY (trap #1).
  const gltfpack = path.join(ROOT, 'node_modules', '.bin', 'gltfpack');
  if (!(await exists(gltfpack))) throw new Error(`gltfpack not found at ${gltfpack} -- run: npm i -D gltfpack`);
  await run(gltfpack, ['-i', rawGlb, '-o', outFile, '-cc', '-kn'], { label: 'gltfpack' });
  const bytes = (await fs.stat(outFile)).size;

  // ---- 8. assert the compressor did not quietly eat the thing that makes
  // this file usable.
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  const readIo = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const finalDoc = await readIo.read(outFile);
  const finalRoot = finalDoc.getRoot();
  if (finalRoot.listScenes().length !== 1) {
    throw new Error(`gltfpack produced ${finalRoot.listScenes().length} scenes`);
  }
  const finalRoots = new Set(finalRoot.listScenes()[0].listChildren().map((n) => n.getName()));
  const lostNodes = [...built.keys(), ...props.keys()].filter((k) => !finalRoots.has(k));
  if (lostNodes.length) {
    throw new Error(`gltfpack dropped node name(s): ${lostNodes.join(', ')}. This is the -kn failure mode.`);
  }
  await assertPaletteSurvived(master, finalDoc, paletteNames);

  const finalClips = new Set(finalRoot.listAnimations().map((a) => a.getName()));
  const expectedClips = [...new Set([...built.values()].flatMap((b) => b.clips))];
  const lostClips = expectedClips.filter((c) => !finalClips.has(c));
  if (lostClips.length) {
    throw new Error(`gltfpack dropped ${lostClips.length} animation name(s), e.g. ${lostClips.slice(0, 5).join(', ')}`);
  }

  // ---- 9. manifest
  const kaykitVocabulary = [...new Set(
    [...kaykitClipPlan().values()].flatMap((byClip) => [...byClip.keys()]),
  )].sort();
  const manifest = {
    generated: new Date().toISOString(),
    glb: path.relative(path.join(ROOT, 'public'), outFile).split(path.sep).join('/'),
    bytes,
    note: 'Creature keys are lowercase and are DIRECT children of the single scene. ' +
      'Every clip is named `<creature key>__<clip>` and binds to that creature ONLY -- ' +
      'the four KayKit skeletons each carry their own namespaced copy of the shared ' +
      'KayKit vocabulary, because three.js GLTFLoader renames duplicate node names on ' +
      'load and a genuinely shared clip library binds to exactly one of them. ' +
      'Build the AnimationMixer against a SkeletonUtils.clone of the creature subtree.',
    sources: [
      { pack: 'Quaternius Ultimate Monsters', licence: 'CC0', url: 'https://quaternius.com/packs/ultimatemonsters.html', used: QUATERNIUS.length, available: 50 },
      { pack: 'KayKit Character Pack: Skeletons (FREE tier)', licence: 'CC0', url: 'https://kaylousberg.itch.io/kaykit-skeletons', used: KAYKIT_CHARACTERS.length, available: 4 },
      { pack: 'KayKit Character Animations (FREE tier)', licence: 'CC0', url: 'https://kaylousberg.itch.io/kaykit-character-animations', used: kaykitVocabulary.length, available: 133 },
    ],
    kaykitClipVocabulary: kaykitVocabulary,
    creatures: {},
    props: {},
  };
  for (const spec of KAYKIT_PROPS) {
    manifest.props[spec.key] = {
      pack: 'kaykit',
      // The bone to parent this onto, as it is named in the FILE. The real node
      // name is `<creature key>_<attach>` -- e.g. skeleton_warrior_handslot_r --
      // because bones are namespaced per creature (see trap 3).
      attach: spec.attach,
      attachNodeFor: Object.fromEntries(spec.suits.map((k) => [k, `${k}_${spec.attach}`])),
      suits: spec.suits,
    };
  }
  for (const [key, b] of built) {
    const box = measure(finalDoc, key);
    manifest.creatures[key] = {
      pack: b.pack,
      rank: b.spec.rank,
      alsoRanks: b.spec.alsoRanks,
      role: b.spec.role,
      archetype: b.spec.archetype,
      boss: b.spec.boss,
      note: b.spec.note,
      clips: b.clips,
      triangles: box.triangles,
    };
  }
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  let triangles = 0;
  for (const m of finalRoot.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const i = p.getIndices(), pos = p.getAttribute('POSITION');
      triangles += Math.floor((i ? i.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  }
  console.log(
    `[creatures] wrote ${path.relative(ROOT, outFile)}  ${(bytes / 1024).toFixed(1)} KB ` +
    `(raw ${(rawBytes / 1024).toFixed(1)} KB, ${(100 - bytes / rawBytes * 100).toFixed(0)}% off)`,
  );
  console.log(
    `[creatures] ${built.size} creatures  ${triangles} tris  ` +
    `${finalRoot.listMaterials().length} materials  ${finalRoot.listTextures().length} textures  ` +
    `${finalRoot.listAnimations().length} clips`,
  );
  console.log(`[creatures] manifest ${path.relative(ROOT, manifestFile)}`);

  return { file: outFile, manifestFile, bytes, creatures: built.size, triangles, clips: finalRoot.listAnimations().length };
}

/** Per-creature triangle count and bounding size, read back off the packed file. */
/**
 * Per-creature triangle count, read back off the packed file.
 *
 * Deliberately does NOT measure bounds or collect mesh-node names. gltfpack
 * quantizes positions into integer space and pushes each mesh onto an anonymous
 * child node carrying the dequantization scale, so POSITION min/max here is in
 * quantized units (a 3-metre demon measures ~13845) and the mesh's own node has
 * no name. Both of those numbers are therefore taken in the verify pass, where
 * three.js has already resolved the transforms -- see patchManifestMeasurements.
 */
function measure(doc, key) {
  const root = doc.getRoot().listScenes()[0].listChildren().find((n) => n.getName() === key);
  let triangles = 0;
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      for (const p of mesh.listPrimitives()) {
        const i = p.getIndices(), pos = p.getAttribute('POSITION');
        triangles += Math.floor((i ? i.getCount() : pos ? pos.getCount() : 0) / 3);
      }
    }
    for (const c of node.listChildren()) visit(c);
  };
  if (root) visit(root);
  return { triangles };
}

/**
 * Downscale flat palette atlases, but only when the meshes prove they ARE
 * palettes and only when the result samples identically at every UV in use.
 * A wrong colour here is invisible in code review and obvious on a phone.
 */
async function shrinkPaletteAtlases(doc) {
  const palettes = new Set();
  let sharp;
  try { sharp = (await import('sharp')).default; }
  catch { console.log('[creatures] sharp unavailable, keeping atlases at source size'); return palettes; }

  for (const tex of doc.getRoot().listTextures()) {
    const [w, h] = tex.getSize() || [];
    if (!w || Math.max(w, h) <= ATLAS_MAX_PX) continue;

    // Which UVs does anything actually sample out of this texture?
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
    if (uvs.size && uvs.size <= ATLAS_MAX_DISTINCT_UVS) palettes.add(tex);
    if (!uvs.size || uvs.size > ATLAS_MAX_DISTINCT_UVS) {
      console.log(`[creatures] atlas ${label}: ${uvs.size} distinct UVs, not a palette -- left alone`);
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
        throw new Error(`atlas ${label} samples a fully transparent texel at UV ${s} -- ` +
          `that geometry would render as nothing (the item pack's opacity trap, via texture)`);
      }
      if (a.join() !== b.join()) { ok = false; break; }
    }
    if (!ok) {
      console.log(`[creatures] atlas ${label}: downscale changed a sampled colour -- kept at source size`);
      continue;
    }
    tex.setImage(new Uint8Array(small));
    // A palette atlas wants point sampling, and wants it MORE at 128px than it
    // did at 1024px: every triangle samples one flat cell, so linear filtering
    // and mipmaps buy nothing and start blending neighbouring colours together
    // once the creature is a few metres away. NEAREST minFilter also tells
    // three.js not to generate mipmaps at all, which is the actual memory win.
    for (const mat of doc.getRoot().listMaterials()) {
      if (mat.getBaseColorTexture() !== tex) continue;
      const info = mat.getBaseColorTextureInfo();
      if (info) { info.setMagFilter(9728); info.setMinFilter(9728); }
    }
    console.log(`[creatures] atlas ${label} -> ${nw}x${nh}  ` +
      `(${uvs.size} sampled UVs verified identical, GPU ${(w * h * 4 / 1048576).toFixed(1)} MB -> ${(nw * nh * 4 / 1048576).toFixed(2)} MB)`);
  }
  return palettes;
}

// ------------------------------------------------- palette survival check
//
// WHY THIS EXISTS. gltfpack does not leave UVs alone: it repacks them into a
// tight sub-rectangle and compensates with KHR_texture_transform, with scale
// factors as large as 14x on this data. On a flat PALETTE atlas that is a
// genuine hazard -- every triangle samples a single small cell, so a UV that
// drifts by one texel does not shade slightly differently, it comes out an
// entirely different colour, and the model still loads, still animates, and
// still reports correct bounds. That is the item pack's opacity trap wearing a
// different hat.
//
// It is also the trap that produced a false alarm during this build: rendering
// the packed file through Blender showed every Quaternius creature in the wrong
// colour, because Blender's workbench display ignores KHR_texture_transform.
// The file was fine. So the check resolves the transform itself and compares
// SAMPLED COLOURS rather than trusting any renderer.

function textureTransform(info) {
  const ext = info && info.listExtensions().find((e) => e.extensionName === 'KHR_texture_transform');
  if (!ext) return null;
  return { offset: ext.getOffset(), scale: ext.getScale(), rotation: ext.getRotation() };
}

function applyTransform(uv, t) {
  if (!t) return uv;
  let u = uv[0] * t.scale[0];
  let v = uv[1] * t.scale[1];
  if (t.rotation) {
    const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
    [u, v] = [c * u + s * v, -s * u + c * v];
  }
  return [u + t.offset[0], v + t.offset[1]];
}

/** creature key -> sorted array of sampled 'r,g,b,a' strings. */
async function sampledColours(doc, sharp, onlyTextures = null) {
  const cache = new Map();
  const decode = async (tex) => {
    if (!cache.has(tex)) {
      cache.set(tex, await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true }));
    }
    return cache.get(tex);
  };
  const texel = (o, u, v) => {
    const wrap = (x) => ((x % 1) + 1) % 1;
    const x = Math.min(o.info.width - 1, Math.floor(wrap(u) * o.info.width));
    const y = Math.min(o.info.height - 1, Math.floor(wrap(v) * o.info.height));
    const i = (y * o.info.width + x) * o.info.channels;
    return [o.data[i], o.data[i + 1], o.data[i + 2], o.data[i + 3]];
  };

  const out = new Map();
  for (const root of doc.getRoot().listScenes()[0].listChildren()) {
    const set = new Set();
    const visit = async (node) => {
      const mesh = node.getMesh();
      if (mesh) {
        for (const prim of mesh.listPrimitives()) {
          const mat = prim.getMaterial();
          const tex = mat && mat.getBaseColorTexture();
          const uvAttr = prim.getAttribute('TEXCOORD_0');
          if (!tex || !uvAttr) continue;
          if (onlyTextures && !onlyTextures.has(tex)) continue;
          const t = textureTransform(mat.getBaseColorTextureInfo());
          const img = await decode(tex);
          const el = [];
          for (let i = 0; i < uvAttr.getCount(); i++) {
            uvAttr.getElement(i, el);
            const [u, v] = applyTransform(el, t);
            const rgba = texel(img, u, v);
            if (!(rgba[3] > 0)) {
              throw new Error(`${root.getName()} samples a fully transparent texel -- it would ` +
                `render as nothing, with no warning (the item pack's opacity failure mode)`);
            }
            set.add(rgba.join(','));
          }
        }
      }
      for (const c of node.listChildren()) await visit(c);
    };
    await visit(root);
    out.set(root.getName(), [...set].sort());
  }
  return out;
}

/**
 * Compare the palette colours each creature samples BEFORE and AFTER gltfpack.
 * Restricted to textures proven to be flat palettes: on those, exact equality
 * is the correct bar and any drift is a real bug. Continuous textures (the
 * KayKit skeleton atlas) are excluded because sub-LSB UV drift legitimately
 * moves a sample by 1/255 there, which is invisible and not worth failing on.
 */
async function assertPaletteSurvived(rawDoc, packedDoc, paletteNames) {
  let sharp;
  try { sharp = (await import('sharp')).default; }
  catch { console.log('[creatures] sharp unavailable, skipping palette survival check'); return; }

  const pick = (doc) => new Set(doc.getRoot().listTextures().filter((t) => paletteNames.has(t.getName())));
  const before = await sampledColours(rawDoc, sharp, pick(rawDoc));
  const after = await sampledColours(packedDoc, sharp, pick(packedDoc));

  const broken = [];
  let checked = 0;
  for (const [key, src] of before) {
    if (!src.length) continue;
    checked++;
    const got = after.get(key) || [];
    if (src.length !== got.length || src.some((c, i) => c !== got[i])) {
      broken.push(`${key}: ${src.length} palette colours before, ${got.length} after ` +
        `(e.g. expected ${src.slice(0, 3).join(' ')}, got ${got.slice(0, 3).join(' ')})`);
    }
  }
  if (broken.length) {
    throw new Error(`gltfpack changed the sampled palette on ${broken.length} creature(s):\n  ` +
      broken.slice(0, 5).join('\n  '));
  }
  console.log(`[creatures] palette survived gltfpack: ${checked} creatures sample identical colours ` +
    `before and after (KHR_texture_transform resolved)`);
}

// -------------------------------------------------------------- verify
//
//   node tools/build-creatures-glb.mjs --verify
//
// The gltf-transform asserts in the build prove the FILE is well-formed. They
// cannot prove the game can use it, because the thing that breaks is what
// three.js does to the file on the way in -- node renaming, skinned cloning,
// track binding. So this loads the shipped GLB through the real GLTFLoader with
// the real MeshoptDecoder, clones each creature the way the game will, and
// checks that every single animation track finds its bone.
//
// This is the check that caught the shared-clip design; without it the build
// was green and three of the four skeletons were frozen.

/** three.js's loaders reach for a DOM to decode PNGs. Give them the smallest
 *  possible one: an <img> that reports success as soon as src is assigned. */
function installDomShim() {
  globalThis.self ??= globalThis;
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
      createElementNS(_ns, tag) {
        if (tag !== 'img') return {};
        const listeners = {};
        return {
          addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
          removeEventListener: () => {},
          set src(_v) { queueMicrotask(() => (listeners.load || []).forEach((f) => f())); },
          get src() { return ''; },
          width: 1, height: 1,
        };
      },
      createElement: () => ({ getContext: () => null, style: {} }),
    };
  }
  globalThis.URL.createObjectURL ??= () => 'blob:stub';
  globalThis.URL.revokeObjectURL ??= () => {};
}

export async function verifyCreaturesGlb({
  glbFile = DEFAULT_OUT,
  manifestFile = DEFAULT_MANIFEST,
  quiet = false,
  patchManifest = true,
} = {}) {
  installDomShim();
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  const { clone: cloneSkinned } = await import('three/addons/utils/SkeletonUtils.js');

  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const buf = await fs.readFile(glbFile);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((resolve, reject) => loader.parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject,
  ));

  const clips = new Map(gltf.animations.map((a) => [a.name, a]));
  const problems = [];
  const rows = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();

  // The loader renames colliding nodes rather than failing. If any name in the
  // loaded scene ends up different from the name in the file, that rename has
  // happened and something is already silently unbound.
  const suspicious = [];
  gltf.scene.traverse((o) => {
    if (o.userData?.name && o.name !== THREE.PropertyBinding.sanitizeNodeName(o.userData.name)) {
      suspicious.push(`${o.userData.name} -> ${o.name}`);
    }
  });
  if (suspicious.length) {
    problems.push(`GLTFLoader renamed ${suspicious.length} node(s) on load ` +
      `(e.g. ${suspicious.slice(0, 4).join(', ')}) -- their animation tracks are unbound`);
  }

  for (const [key, meta] of Object.entries(manifest.creatures)) {
    const src = gltf.scene.getObjectByName(key);
    if (!src) { problems.push(`'${key}' does not resolve in the loaded scene`); continue; }
    if (!meta.clips.length) { problems.push(`'${key}' has no animation clips`); continue; }

    const inst = cloneSkinned(src);
    inst.updateMatrixWorld(true);
    const mixer = new THREE.AnimationMixer(inst);

    let tracks = 0, unbound = 0;
    for (const name of meta.clips) {
      const clip = clips.get(name);
      if (!clip) { problems.push(`'${key}' clip '${name}' is not in the GLB`); continue; }
      for (const track of clip.tracks) {
        tracks++;
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        if (!THREE.PropertyBinding.findNode(inst, parsed.nodeName)) unbound++;
      }
      mixer.clipAction(clip).play();
    }
    mixer.update(1 / 60);
    if (unbound) problems.push(`'${key}': ${unbound}/${tracks} animation tracks do not bind`);

    let skinned = 0;
    inst.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
    if (!skinned) problems.push(`'${key}' has no SkinnedMesh -- it cannot animate`);

    box.setFromObject(inst, true).getSize(size);

    // The handles worth knowing about: gltfpack parents each mesh to an
    // ANONYMOUS dequantization node, so the useful name is the nearest ancestor
    // that was really named in the file -- that is what `demon_Trident`
    // resolves to, and hiding it is how you take the trident off the B boss.
    //
    // `o.name` is not the test. GLTFLoader invents `mesh_14`-style names for
    // unnamed mesh nodes, so every mesh has a name and the naive walk stops
    // immediately and reports nothing useful. It only sets userData.name when
    // the glTF node carried a name of its own, so that is the real signal.
    const handles = new Set();
    inst.traverse((o) => {
      if (!o.isMesh) return;
      for (let p = o; p && p !== inst; p = p.parent) {
        if (p.userData?.name) { handles.add(p.name); return; }
      }
    });

    rows.push({
      key, meta, tracks, unbound, skinned,
      height: size.y,
      size: [size.x, size.y, size.z].map((v) => Number(v.toFixed(3))),
      meshNodes: [...handles].sort(),
    });
  }

  if (!quiet) {
    console.log('');
    console.log('key                pack        rank alsoRanks  role   archetype boss         tris  height clips tracks');
    console.log('-'.repeat(112));
    for (const r of rows) {
      console.log(
        `${r.key.padEnd(18)} ${r.meta.pack.padEnd(11)} ${String(r.meta.rank).padEnd(4)} ` +
        `${(r.meta.alsoRanks || []).join('').padEnd(10)} ${String(r.meta.role).padEnd(6)} ` +
        `${String(r.meta.archetype).padEnd(9)} ${String(r.meta.boss ?? '-').padEnd(12)} ` +
        `${String(r.meta.triangles).padStart(5)} ${r.height.toFixed(2).padStart(6)} ` +
        `${String(r.meta.clips.length).padStart(5)} ${String(r.tracks - r.unbound)}/${r.tracks}`,
      );
    }
    console.log('-'.repeat(112));
    console.log(`${rows.length} creatures, ${gltf.animations.length} clips, ` +
      `${(buf.length / 1024).toFixed(1)} KB`);
  }

  // Accessories: they must resolve, they must actually contain geometry, and
  // the bone each one claims to attach to has to exist on every skeleton it
  // claims to suit. A weapon that resolves but has no attach point is the same
  // as no weapon, and nothing would have thrown.
  const propRows = [];
  for (const [key, meta] of Object.entries(manifest.props || {})) {
    const src = gltf.scene.getObjectByName(key);
    if (!src) { problems.push(`prop '${key}' does not resolve in the loaded scene`); continue; }
    let meshes = 0;
    src.traverse((o) => { if (o.isMesh) meshes++; });
    if (!meshes) problems.push(`prop '${key}' contains no mesh`);
    for (const [creature, node] of Object.entries(meta.attachNodeFor || {})) {
      if (!gltf.scene.getObjectByName(node)) {
        problems.push(`prop '${key}' attaches to '${node}', which does not exist on ${creature}`);
      }
    }
    box.setFromObject(src, true).getSize(size);
    propRows.push({ key, meta, meshes, size: [size.x, size.y, size.z].map((v) => Number(v.toFixed(3))) });
  }

  if (!quiet && propRows.length) {
    console.log('');
    console.log('accessory            attach       suits');
    for (const r of propRows) {
      console.log(`${r.key.padEnd(20)} ${r.meta.attach.padEnd(12)} ${r.meta.suits.join(', ')}`);
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(`[creatures] PROBLEM: ${p}`);
    throw new Error(`${problems.length} verification problem(s)`);
  }

  // Write the three.js-measured numbers back. This is the only place they can
  // be measured honestly (see measure()'s note), and doing it here means the
  // manifest reports what the game will actually see rather than a second,
  // subtly different calculation.
  if (patchManifest) {
    for (const r of rows) {
      manifest.creatures[r.key].size = r.size;
      manifest.creatures[r.key].meshNodes = r.meshNodes;
    }
    for (const r of propRows) manifest.props[r.key].size = r.size;
    manifest.measurementNote =
      'size is the world-space bounding box of a SkeletonUtils.clone in bind pose, in ' +
      'metres, measured through three.js. meshNodes are the named handles under each ' +
      'creature -- hide or swap these to change a creature\'s kit.';
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  }

  if (!quiet) console.log('[creatures] verify OK: every creature resolves, is skinned, and every track binds');
  return { creatures: rows.length, clips: gltf.animations.length, bytes: buf.length };
}

// ------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const outFile = path.resolve(ROOT, opt('out', DEFAULT_OUT));
  const manifestFile = path.resolve(ROOT, opt('manifest', DEFAULT_MANIFEST));
  try {
    if (!argv.includes('--verify')) {
      await buildCreaturesGlb({ srcDir: path.resolve(ROOT, opt('src', DEFAULT_SRC)), outFile, manifestFile });
    }
    await verifyCreaturesGlb({ glbFile: outFile, manifestFile });
  } catch (e) {
    console.error(`[creatures] FAILED: ${e.message}`);
    process.exit(1);
  }
}
