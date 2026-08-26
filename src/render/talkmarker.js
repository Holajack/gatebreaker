import * as THREE from 'three';

// The floating "someone here talks" marker (playtest 2026-08-26: "there's no
// person to really talk to" — conversability was invisible until the player
// stood inside a 2.2 m prompt bubble). One drawn-once CanvasTexture of the
// same speech-bubble glyph as index.html's #i-talk, ONE shared SpriteMaterial,
// billboard sprites per marker.
//
// Law compliance: NORMAL blending, no GLOW_LAYER, no lights — this is
// signage, not light, and it floats ABOVE heads, never glowing ON a living
// character. No RNG anywhere (markers must never touch the seeded crowd
// stream). The texture and material are module-cached and never disposed —
// City.dispose's traversal only drops InstancedMeshes and its owned lists, so
// sprites detach with their parent group and the shared material survives
// every town rebuild.

let _tex = null;
let _mat = null;

function markerTexture() {
  if (_tex) return _tex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  g.lineWidth = 4;
  g.lineJoin = 'round';
  g.strokeStyle = '#eaf0ff';
  g.fillStyle = 'rgba(12, 16, 30, 0.72)';
  const r = 8, x0 = 8, y0 = 10, x1 = 56, y1 = 40;
  g.beginPath();
  g.moveTo(x0 + r, y0);
  g.lineTo(x1 - r, y0); g.arcTo(x1, y0, x1, y0 + r, r);
  g.lineTo(x1, y1 - r); g.arcTo(x1, y1, x1 - r, y1, r);
  g.lineTo(30, y1); g.lineTo(21, 53); g.lineTo(20, y1);   // the tail
  g.lineTo(x0 + r, y1); g.arcTo(x0, y1, x0, y1 - r, r);
  g.lineTo(x0, y0 + r); g.arcTo(x0, y0, x0 + r, y0, r);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#eaf0ff';
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(20 + i * 12, 25, 3, 0, Math.PI * 2);
    g.fill();
  }
  _tex = new THREE.CanvasTexture(cv);
  _tex.colorSpace = THREE.SRGBColorSpace;
  return _tex;
}

/** A billboard talk marker sprite. Position it; parent it; done. */
export function makeTalkMarker(size = 0.9) {
  if (!_mat) {
    _mat = new THREE.SpriteMaterial({
      map: markerTexture(),
      transparent: true,
      depthWrite: false,
    });
  }
  const s = new THREE.Sprite(_mat);
  s.scale.set(size, size, 1);
  s.renderOrder = 2;
  return s;
}
