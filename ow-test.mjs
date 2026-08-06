import { Overworld } from '/home/user/collins-seo-website/game/src/world/overworld.js';
import * as THREE from 'three';
const scene = new THREE.Scene();
const quality = { current: { name: 'high' } };
const ow = new Overworld(scene, quality);
ow.build(20260804);
console.log('gates:', ow.gates.length);
console.log('obstacles:', ow.obstacles.length);
const verts = ow.ground.geometry.attributes.position.count;
console.log('ground verts:', verts);
console.log('gate placement (rank, dist from spawn, height):');
for (const g of ow.gates) {
  console.log(' ', g.gate.rank, Math.hypot(g.pos.x,g.pos.z).toFixed(0), g.pos.y.toFixed(1));
}
// gateAt / nearestGate
const p = ow.gates[0].pos.clone();
console.log('gateAt(E gate pos):', ow.gateAt(p)?.gate.rank);
console.log('gateAt(origin):', ow.gateAt(new THREE.Vector3(0,0,0))?.gate.rank ?? 'none');
const n = ow.nearestGate(new THREE.Vector3(0,0,0));
console.log('nearest to spawn:', n.gate.gate.rank, n.distance.toFixed(1));
// collision resolve pushes out of an obstacle
const o = ow.obstacles.find(o=>o.radius>2);
const pos = new THREE.Vector3(o.pos.x, 0, o.pos.z);
const vel = new THREE.Vector3(0,0,0);
ow.resolve(pos, 0.6, vel);
console.log('resolved out of obstacle:', Math.hypot(pos.x-o.pos.x,pos.z-o.pos.z).toFixed(2), '>=', (o.radius+0.6).toFixed(2));
// out-of-world clamp
const far = new THREE.Vector3(900,0,900);
ow.resolve(far, 0.6, new THREE.Vector3());
console.log('clamped far point to radius:', Math.hypot(far.x,far.z).toFixed(1));

// regression: dead-centre and off-centre both escape the obstacle
for (const [label, off] of [['dead-centre',0],['off-centre',0.3]]) {
  const p2 = new THREE.Vector3(o.pos.x+off, 0, o.pos.z);
  ow.resolve(p2, 0.6, new THREE.Vector3());
  const d = Math.hypot(p2.x-o.pos.x, p2.z-o.pos.z);
  console.log(label+':', d.toFixed(2), 'need >=', (o.radius+0.6).toFixed(2), d >= o.radius+0.6-1e-6 ? 'PASS':'FAIL');
}
