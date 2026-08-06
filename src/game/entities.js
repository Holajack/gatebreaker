import * as THREE from 'three';
import { GLOW_LAYER } from '../render/glow.js';
import { applyRim } from '../render/rim.js';

// Procedurally assembled low-poly humanoids. Building rigs in code means the
// APK ships with zero model files and every silhouette is tunable from here.

function limb(w, h, d, color, roughness = 0.6) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, -h / 2, 0); // pivot at the top so rotation swings like a joint
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness, flatShading: true }));
}

export function makeHumanoid({
  color = 0x7c5cff,
  glow = 0xffffff,
  accent = 0x2b2f4a,
  scale = 1,
  weapon = 'sword',
  cloak = false,
  ghost = false,
} = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const matOpts = ghost
    ? { transparent: true, opacity: 0.62, roughness: 0.4, emissive: new THREE.Color(glow), emissiveIntensity: 0.55 }
    : { roughness: 0.65 };

  // metalness is what makes scene.environment visible at all — at 0 you only
  // get the ~4% dielectric Fresnel term and the IBL may as well not be there.
  const torsoMat = applyRim(new THREE.MeshStandardMaterial({
    color: accent, roughness: 0.55, metalness: 0.35, envMapIntensity: 1.0, ...matOpts,
  }), { color: glow, strength: 0.55 });
  const skinMat = applyRim(new THREE.MeshStandardMaterial({
    color, roughness: 0.42, metalness: 0.25, envMapIntensity: 1.15, ...matOpts,
  }), { color: glow, strength: 0.95 });

  // torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.82, 0.38), torsoMat);
  torso.position.y = 1.28;
  torso.castShadow = true;
  body.add(torso);

  // hips
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.26, 0.34), torsoMat);
  hips.position.y = 0.84;
  body.add(hips);

  // head
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.44, 0.4), skinMat);
  head.position.y = 1.92;
  head.castShadow = true;
  body.add(head);

  // eyes — a pair of emissive quads reads as a glowing visor at distance
  const eyeMat = new THREE.MeshBasicMaterial({ color: glow });
  const eyeGeo = new THREE.BoxGeometry(0.1, 0.06, 0.02);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.1, 1.95, 0.21);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.1, 1.95, 0.21);
  eyeL.layers.enable(GLOW_LAYER);
  eyeR.layers.enable(GLOW_LAYER);
  body.add(eyeL, eyeR);

  // shoulders
  const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.2, 0.42), skinMat);
  shoulder.position.y = 1.62;
  body.add(shoulder);

  // arms — pivot groups so we can swing them from the shoulder
  const armL = new THREE.Group(); armL.position.set(-0.42, 1.58, 0);
  const armR = new THREE.Group(); armR.position.set(0.42, 1.58, 0);
  const armLMesh = limb(0.18, 0.72, 0.18, color); armLMesh.castShadow = true;
  const armRMesh = limb(0.18, 0.72, 0.18, color); armRMesh.castShadow = true;
  armLMesh.material = skinMat; armRMesh.material = skinMat;
  armL.add(armLMesh); armR.add(armRMesh);
  body.add(armL, armR);

  // legs
  const legL = new THREE.Group(); legL.position.set(-0.17, 0.82, 0);
  const legR = new THREE.Group(); legR.position.set(0.17, 0.82, 0);
  const legLMesh = limb(0.2, 0.8, 0.22, accent); legLMesh.material = torsoMat; legLMesh.castShadow = true;
  const legRMesh = limb(0.2, 0.8, 0.22, accent); legRMesh.material = torsoMat; legRMesh.castShadow = true;
  legL.add(legLMesh); legR.add(legRMesh);
  body.add(legL, legR);

  // weapon in the right hand
  let blade = null;
  if (weapon === 'sword') {
    blade = new THREE.Group();
    const bladeMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 1.5, 0.03),
      new THREE.MeshStandardMaterial({
        color: 0xdfe6ff, emissive: new THREE.Color(glow), emissiveIntensity: 0.7,
        metalness: 0.95, roughness: 0.18, envMapIntensity: 2.2,
        ...(ghost ? { transparent: true, opacity: 0.7 } : {}),
      }),
    );
    bladeMesh.position.y = 0.72;
    bladeMesh.layers.enable(GLOW_LAYER);
    const guard = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.08, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x4a4f70, metalness: 0.7, roughness: 0.4 }),
    );
    blade.add(bladeMesh, guard);
    blade.position.set(0, -0.72, 0.06);
    blade.rotation.x = -0.25;
    armRMesh.add(blade);
  } else if (weapon === 'claw') {
    const clawMat = new THREE.MeshStandardMaterial({
      color: 0xf0f0ff, emissive: new THREE.Color(glow), emissiveIntensity: 0.5, flatShading: true,
    });
    [-0.06, 0, 0.06].forEach((off) => {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.5, 4), clawMat);
      c.position.set(off, -0.9, 0.1);
      c.rotation.x = Math.PI * 0.9;
      armRMesh.add(c);
    });
  } else if (weapon === 'staff') {
    const staff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 1.9, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a2f28, roughness: 0.9 }),
    );
    staff.position.y = -0.7;
    const orb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.19, 0),
      new THREE.MeshBasicMaterial({ color: glow }),
    );
    orb.position.y = 0.95;
    orb.layers.enable(GLOW_LAYER);
    staff.add(orb);
    armRMesh.add(staff);
    blade = staff;
  }

  if (cloak) {
    const cape = new THREE.Mesh(
      new THREE.ConeGeometry(0.62, 1.5, 6, 1, true),
      new THREE.MeshStandardMaterial({
        color: accent, side: THREE.DoubleSide, roughness: 0.9, flatShading: true,
        ...(ghost ? { transparent: true, opacity: 0.55 } : {}),
      }),
    );
    cape.position.set(0, 1.15, -0.22);
    cape.rotation.x = 0.16;
    body.add(cape);
    root.userData.cape = cape;
  }

  root.scale.setScalar(scale);
  root.userData.rig = { body, torso, head, armL, armR, legL, legR, blade, eyeL, eyeR };
  return root;
}

// A flat glowing disc under a character. On a dark arena this is the single
// biggest readability win — you can always find yourself and spot enemies.
export function makeGroundRing(color, radius = 0.8, opacity = 0.5) {
  const geo = new THREE.RingGeometry(radius * 0.72, radius, 28);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  mesh.layers.enable(GLOW_LAYER);
  // Sits above the ground's vertex-noise range so it never gets buried.
  mesh.position.y = 0.36;
  return mesh;
}

// Billboarded health bar that sits above an entity.
export function makeHealthBar(width = 1.2, color = 0xff2d55) {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(width, 0.13),
    new THREE.MeshBasicMaterial({ color: 0x0a0a12, transparent: true, opacity: 0.75, depthTest: false }),
  );
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(width, 0.1),
    new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
  fill.position.z = 0.01;
  group.add(bg, fill);
  group.renderOrder = 999;
  group.userData = { fill, width };
  return group;
}

export function setHealthBar(bar, ratio) {
  const { fill, width } = bar.userData;
  const r = Math.max(0, Math.min(1, ratio));
  fill.scale.x = r || 0.0001;
  // Scaling a centered plane shrinks both ends; shift left so it drains rightward.
  fill.position.x = -(width * (1 - r)) / 2;
}

// Simple walk / idle / attack pose driver shared by every humanoid.
export function animateRig(root, { moving, speed, t, attackPhase = 0, hurt = 0, airborne = false, riseRate = 0 }) {
  const rig = root.userData.rig;
  if (!rig) return;
  const { armL, armR, legL, legR, body, head } = rig;

  if (airborne && attackPhase <= 0) {
    // Tuck on the way up, reach on the way down — reading the character's
    // vertical direction from the pose is most of what sells a jump.
    const rising = riseRate > 0;
    const k = Math.max(-1, Math.min(1, riseRate * 0.12));
    legL.rotation.x = rising ? -0.75 : 0.28;
    legR.rotation.x = rising ? -0.42 : 0.5;
    armL.rotation.x = -1.15 - k * 0.35;
    armR.rotation.x = -0.85 - k * 0.35;
    body.rotation.y *= 0.85;
    body.position.y = 0;
    body.rotation.z = -k * 0.1;
    if (root.userData.cape) root.userData.cape.rotation.x = 0.16 + 0.42 - k * 0.25;
    if (hurt > 0) head.rotation.z = -Math.sin(hurt * 40) * 0.1 * hurt; else head.rotation.z *= 0.8;
    return;
  }

  if (attackPhase > 0) {
    // Wind up then chop through — armR leads, torso counter-rotates.
    const p = 1 - attackPhase; // 0 -> 1 over the swing
    const swing = p < 0.3
      ? -1.5 * (p / 0.3)
      : -1.5 + 3.4 * ((p - 0.3) / 0.7);
    armR.rotation.x = swing;
    armL.rotation.x = -swing * 0.3;
    body.rotation.y = swing * 0.22;
    legL.rotation.x = 0.1;
    legR.rotation.x = -0.1;
  } else if (moving) {
    const cyc = t * (5 + speed * 0.9);
    const amp = Math.min(1, 0.35 + speed * 0.08);
    legL.rotation.x = Math.sin(cyc) * 0.85 * amp;
    legR.rotation.x = -Math.sin(cyc) * 0.85 * amp;
    armL.rotation.x = -Math.sin(cyc) * 0.65 * amp;
    armR.rotation.x = Math.sin(cyc) * 0.65 * amp;
    body.position.y = Math.abs(Math.sin(cyc)) * 0.07;
    body.rotation.y = Math.sin(cyc) * 0.06;
    body.rotation.z = 0;
  } else {
    const idle = Math.sin(t * 1.8);
    legL.rotation.x *= 0.85;
    legR.rotation.x *= 0.85;
    armL.rotation.x = idle * 0.08 - 0.05;
    armR.rotation.x = -idle * 0.08 - 0.05;
    body.position.y = idle * 0.035;
    body.rotation.y *= 0.85;
  }

  if (hurt > 0) {
    body.rotation.z = Math.sin(hurt * 40) * 0.14 * hurt;
    head.rotation.z = -Math.sin(hurt * 40) * 0.1 * hurt;
  } else {
    head.rotation.z *= 0.8;
  }

  if (root.userData.cape) {
    root.userData.cape.rotation.x = 0.16 + (moving ? Math.sin(t * 8) * 0.06 + 0.14 : Math.sin(t * 1.5) * 0.03);
  }
}
