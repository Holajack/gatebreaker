// PAGE-SIDE module for tools/asset-contact-sheet.mjs. Served through the vite
// dev server so the bare 'three' specifiers resolve exactly the way the
// game's own modules resolve them — one shared three instance, real
// GLTFLoader, real meshopt decoder, real SkeletonUtils.clone. Node never
// imports this file; it runs only in the harness browser.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

export async function makeSheet({ glbUrl, entries, tile, cols, poseClips }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(tile, tile);
  renderer.setClearColor(0x23262b, 1);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(glbUrl);

  const rows = Math.ceil(entries.length / cols);
  const label = 14;
  const sheet = document.createElement('canvas');
  sheet.width = cols * tile;
  sheet.height = rows * (tile + label);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#181a1e';
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  const missing = [];
  const litByKey = {};
  let tiles = 0;
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i];
    const src = gltf.scene.getObjectByName(key);
    const col = i % cols, row = Math.floor(i / cols);
    const x = col * tile, y = row * (tile + label);
    if (!src) { missing.push(key); continue; }

    // Skinned subtrees MUST go through SkeletonUtils.clone (repo rule); a
    // static piece takes the same path harmlessly.
    const inst = SkeletonUtils.clone(src);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xf4f1ea, 0x3a3e46, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 5, 2);
    scene.add(sun);
    scene.add(inst);

    // Pose skinned characters mid-idle so the sheet shows actual clip
    // binding, not the bind pose — a bind-pose sheet cannot catch an unbound
    // skeleton, which is the exact failure three.js only console-warns about.
    const clipName = poseClips && poseClips[key];
    if (clipName) {
      const clip = THREE.AnimationClip.findByName(gltf.animations, clipName);
      if (!clip) { missing.push(`${key} (clip ${clipName})`); continue; }
      const mixer = new THREE.AnimationMixer(inst);
      mixer.clipAction(clip).play();
      mixer.update(0.6);
    }

    // NOT redundant: without a full world-matrix pass first, Box3.setFromObject
    // on the meshopt-quantized skinned characters collapses to a degenerate
    // point (the dequant scale lives on anonymous child nodes whose matrixWorld
    // is stale until someone updates the whole tree) and the camera ends up
    // parked inside it — blank tile, no error. Static pieces merely got lucky.
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inst);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.5;
    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, radius * 40);
    const dist = (radius / Math.tan((cam.fov / 2) * (Math.PI / 180))) * 1.25;
    cam.position.copy(center).add(new THREE.Vector3(1, 0.65, 1).normalize().multiplyScalar(dist));
    cam.lookAt(center);
    renderer.render(scene, cam);

    // Lit-pixel count per tile: a tile that renders zero non-background
    // pixels is invisible geometry no matter what the draw call reported.
    const gl = renderer.getContext();
    const px = new Uint8Array(tile * tile * 4);
    gl.readPixels(0, 0, tile, tile, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0;
    for (let p = 0; p < px.length; p += 4) {
      if (Math.abs(px[p] - 0x23) > 6 || Math.abs(px[p + 1] - 0x26) > 6 || Math.abs(px[p + 2] - 0x2b) > 6) lit++;
    }
    litByKey[key] = lit;

    ctx.drawImage(renderer.domElement, x, y, tile, tile);
    ctx.fillStyle = '#c9ccd4';
    ctx.font = '10px monospace';
    ctx.fillText(key.length > 30 ? `${key.slice(0, 29)}…` : key, x + 3, y + tile + 11);
    tiles++;
  }
  renderer.dispose();
  return { dataUrl: sheet.toDataURL('image/png'), missing, tiles, litByKey, clips: gltf.animations.length };
}
