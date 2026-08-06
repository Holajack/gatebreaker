// Convert the 106-model CC0 Quaternius "Ultimate RPG Items Pack" into ONE
// meshopt-compressed GLB the game can preload during the existing splash.
//
//   node tools/build-items-glb.mjs [--src <pack dir>] [--out public/models/items.glb] [--blender <path>]
//
// Pipeline: Blender headless (merge all 106 FBX into one scene, collapse to the
// shared material palette) -> gltf-transform dedup + prune -> gltfpack -cc -kn.
//
// Three things here are load-bearing and all three fail SILENTLY if changed:
//
//   1. tools/blender-items.py renames imported objects to '<name>__part' before
//      creating the handle Empty. Without it Blender hands you 'Sword001' and
//      every getObjectByName in the game returns null.
//   2. gltfpack MUST be given -kn. Without it node names are stripped and the
//      result loads without error and is completely unusable.
//   3. meshopt, NOT Draco. Draco saves ~20 KB and costs two loose decoder files
//      resolved at runtime through DRACOLoader.setDecoderPath(); under Capacitor
//      (https://localhost, base:'./') a wrong path is a silent on-device failure,
//      which is exactly what the offline requirement forbids.
//
// public/models/items.glb MUST be committed: the source pack is gitignored and
// exists on exactly one Mac, so CI can never regenerate it.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_SRC = path.join(ROOT, 'Ultimate RPG Items Pack - Aug 2019', 'FBX');
const DEFAULT_OUT = path.join(ROOT, 'public', 'models', 'items.glb');
const BLENDER_APP = '/Applications/Blender.app/Contents/MacOS/Blender';

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

/**
 * Blender is NOT on PATH on the machine this pack lives on. Try the three
 * plausible locations and name all three when none of them work, because
 * `spawn('blender')` otherwise fails with a bare ENOENT that says nothing.
 */
async function resolveBlender(explicit) {
  const tried = [];
  const candidates = [explicit, process.env.GB_BLENDER, BLENDER_APP, 'blender'].filter(Boolean);
  for (const c of candidates) {
    tried.push(c);
    if (c === 'blender') {
      try {
        await run('blender', ['--version'], { label: 'blender --version' });
        return 'blender';
      } catch { continue; }
    }
    if (await exists(c)) return c;
  }
  throw new Error(
    `Blender not found. Tried: ${tried.join(', ')}.\n` +
    `Set GB_BLENDER=/path/to/Blender or pass --blender. On this Mac it lives at ${BLENDER_APP} ` +
    `and is deliberately NOT on PATH.`,
  );
}

function resolveGltfpack() {
  // Prefer the local devDependency so the build does not depend on a global.
  const local = path.join(ROOT, 'node_modules', '.bin', 'gltfpack');
  return local;
}

/** dedup + prune through the gltf-transform Node API (no CLI dependency). */
async function transform(file) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { dedup, prune } = await import('@gltf-transform/functions');
  const io = new NodeIO();
  const doc = await io.read(file);
  await doc.transform(dedup(), prune());
  await io.write(file, doc);
}

async function glbStats(file) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { EXTMeshoptCompression, KHRMeshQuantization } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  // Registered so this can read the POST-gltfpack file too; without them
  // reading the compressed output throws 'Missing required extension'.
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(file);
  const root = doc.getRoot();
  const scenes = root.listScenes();
  // gltf-transform merge produces one scene PER input, and three.js only ever
  // renders scenes[0] — so the count matters, not just the node count.
  const named = new Set();
  for (const n of root.listNodes()) if (n.getName()) named.add(n.getName());
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      triangles += Math.floor(((idx ? idx.getCount() : (pos ? pos.getCount() : 0))) / 3);
    }
  }
  return {
    scenes: scenes.length,
    rootNodes: scenes.length ? scenes[0].listChildren().length : 0,
    nodeNames: named,
    materials: root.listMaterials().length,
    meshes: root.listMeshes().length,
    triangles,
  };
}

export async function buildItemsGlb({
  srcDir = DEFAULT_SRC,
  outFile = DEFAULT_OUT,
  blenderPath = null,
} = {}) {
  if (!(await exists(srcDir))) {
    throw new Error(
      `Item pack source not found at ${srcDir}. It is gitignored and exists only on the ` +
      `machine that has the CC0 download — pass --src or restore the pack.`,
    );
  }
  const blender = await resolveBlender(blenderPath);
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gb-items-'));
  const rawGlb = path.join(tmp, 'items-raw.glb');
  const statsJson = path.join(tmp, 'stats.json');
  const script = path.join(HERE, 'blender-items.py');

  console.log(`[items] blender  ${blender}`);
  console.log(`[items] source   ${srcDir}`);
  const { out } = await run(blender, [
    '-b', '--factory-startup', '--python-exit-code', '1',
    '--python', script, '--', srcDir, rawGlb, statsJson,
  ], { label: 'blender' });
  const ok = /ITEMPACK_OK/.test(out);
  if (!ok) throw new Error(`blender did not report success:\n${out.slice(-4000)}`);

  const blenderStats = JSON.parse(await fs.readFile(statsJson, 'utf8'));
  console.log(`[items] blender exported ${blenderStats.models} models, ` +
    `${blenderStats.triangles} triangles, ${blenderStats.materials.length} materials`);

  // ---- gltf-transform dedup + prune ----
  await transform(rawGlb);
  const mid = await glbStats(rawGlb);
  console.log(`[items] after dedup/prune: ${mid.scenes} scene(s), ${mid.rootNodes} roots, ` +
    `${mid.materials} materials, ${mid.triangles} triangles`);
  if (mid.scenes !== 1) {
    throw new Error(`expected exactly 1 scene, got ${mid.scenes}. three.js renders only scenes[0], ` +
      `so a multi-scene file shows one model and hides the other 105.`);
  }

  // ---- meshopt via gltfpack. -kn is MANDATORY. ----
  const gltfpack = resolveGltfpack();
  if (!(await exists(gltfpack))) {
    throw new Error(`gltfpack not found at ${gltfpack} — run: npm i -D gltfpack`);
  }
  await run(gltfpack, ['-i', rawGlb, '-o', outFile, '-cc', '-kn'], { label: 'gltfpack' });

  const final = await glbStats(outFile);
  const bytes = (await fs.stat(outFile)).size;

  // The name-intact assertion is not optional: without -kn this file still
  // loads, still renders, and every lookup in the game returns null.
  const missing = blenderStats.roots.filter((n) => !final.nodeNames.has(n));
  if (missing.length) {
    throw new Error(
      `${missing.length} node name(s) were lost by gltfpack (e.g. ${missing.slice(0, 5).join(', ')}). ` +
      `This is the -kn failure mode; the file would load without error and be unusable.`,
    );
  }
  if (final.scenes !== 1) throw new Error(`gltfpack produced ${final.scenes} scenes`);

  console.log(`[items] wrote ${path.relative(ROOT, outFile)}  ${(bytes / 1024).toFixed(1)} KB  ` +
    `${blenderStats.models} models  ${final.triangles} tris  ${final.materials} materials`);

  return {
    file: outFile,
    bytes,
    models: blenderStats.models,
    triangles: final.triangles,
    materials: final.materials,
  };
}

// ------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  try {
    await buildItemsGlb({
      srcDir: opt('src', DEFAULT_SRC),
      outFile: path.resolve(ROOT, opt('out', DEFAULT_OUT)),
      blenderPath: opt('blender', null),
    });
  } catch (e) {
    console.error(`[items] FAILED: ${e.message}`);
    process.exit(1);
  }
}
