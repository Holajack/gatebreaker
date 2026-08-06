import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Layer-masked additive glow.
//
// EffectComposer + UnrealBloomPass costs 4-9ms on a mid-range Android because
// it forces the whole scene through two HalfFloat render targets (losing free
// tile-memory MSAA) and then runs ~15 full-screen passes. Worse, its resolution
// argument is discarded: EffectComposer.addPass immediately calls setSize with
// the full drawing-buffer size, so the only knob is downscaling everything.
//
// Instead: render the main scene straight to the default framebuffer, and
// separately render only the emissive objects at quarter resolution, blur, and
// composite additively. Everything we want to bloom is already MeshBasicMaterial,
// so the glow pass is ~80 tiny draws. Roughly 0.7ms for most of the look.

export const GLOW_LAYER = 1;

/** Mark an object (and its subtree) as emissive for the glow pass. */
export function markGlow(obj) {
  obj.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isInstancedMesh) o.layers.enable(GLOW_LAYER);
  });
}

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// 9-tap Gaussian collapsed into 5 bilinear fetches.
const BLUR = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec4 c  = texture2D(tSrc, vUv) * 0.2270270270;
    c += (texture2D(tSrc, vUv + uDir * 1.3846153846)
        + texture2D(tSrc, vUv - uDir * 1.3846153846)) * 0.3162162162;
    c += (texture2D(tSrc, vUv + uDir * 3.2307692308)
        + texture2D(tSrc, vUv - uDir * 3.2307692308)) * 0.0702702703;
    gl_FragColor = c;
  }
`;

const COMPOSITE = /* glsl */`
  uniform sampler2D tGlow;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec3 g = texture2D(tGlow, vUv).rgb * uStrength;
    g = vec3(1.0) - exp(-g);      // soft rolloff so glow never clips to flat white
    g = pow(g, vec3(0.4545));     // linear -> sRGB, matching the framebuffer
    gl_FragColor = vec4(g, 1.0);
  }
`;

export class Glow {
  constructor(renderer, { scale = 0.25, strength = 1.35, spread = 1.1 } = {}) {
    this.renderer = renderer;
    this.scale = scale;
    this.spread = spread;
    this.enabled = true;
    this._black = new THREE.Color(0, 0, 0);
    this._prevClear = new THREE.Color();

    const opts = {
      type: THREE.UnsignedByteType,     // 8 bits is plenty for a glow mask
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,                // so glow geometry self-occludes
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(2, 2, opts);
    this.rtB = new THREE.WebGLRenderTarget(2, 2, opts);

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERT, fragmentShader: BLUR,
      depthTest: false, depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: { tGlow: { value: this.rtA.texture }, uStrength: { value: strength } },
      vertexShader: VERT, fragmentShader: COMPOSITE,
      blending: THREE.AdditiveBlending,
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.blurQuad = new FullScreenQuad(this.blurMat);
    this.compQuad = new FullScreenQuad(this.compMat);
    this._w = 2; this._h = 2;
  }

  setSize(w, h, pixelRatio) {
    const gw = Math.max(2, Math.round(w * pixelRatio * this.scale));
    const gh = Math.max(2, Math.round(h * pixelRatio * this.scale));
    this.rtA.setSize(gw, gh);
    this.rtB.setSize(gw, gh);
    this._w = gw; this._h = gh;
  }

  _blur(from, to, dx, dy) {
    this.blurMat.uniforms.tSrc.value = from.texture;
    this.blurMat.uniforms.uDir.value.set(dx, dy);
    this.renderer.setRenderTarget(to);
    this.blurQuad.render(this.renderer);
  }

  /** Drop-in replacement for renderer.render(scene, camera). */
  render(scene, camera) {
    const r = this.renderer;
    if (!this.enabled) { r.setRenderTarget(null); r.render(scene, camera); return; }

    // 1. emissive-only pass, quarter res
    const bg = scene.background, fog = scene.fog, env = scene.environment;
    const mask = camera.layers.mask;
    scene.background = null; scene.fog = null; scene.environment = null;
    camera.layers.set(GLOW_LAYER);

    r.getClearColor(this._prevClear);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(this._black, 1);
    r.setRenderTarget(this.rtA);
    r.clear(true, true, false);
    r.render(scene, camera);

    camera.layers.mask = mask;
    scene.background = bg; scene.fog = fog; scene.environment = env;
    r.setClearColor(this._prevClear, prevAlpha);

    // 2. separable blur, two ping-pong rounds
    const sx = this.spread / this._w, sy = this.spread / this._h;
    this._blur(this.rtA, this.rtB, sx, 0);
    this._blur(this.rtB, this.rtA, 0, sy);
    this._blur(this.rtA, this.rtB, sx * 2, 0);
    this._blur(this.rtB, this.rtA, 0, sy * 2);

    // 3. main scene direct to canvas — keeps free MSAA and tone mapping
    r.setRenderTarget(null);
    r.render(scene, camera);

    // 4. additive composite
    const autoClear = r.autoClear;
    r.autoClear = false;
    this.compMat.uniforms.tGlow.value = this.rtA.texture;
    this.compQuad.render(r);
    r.autoClear = autoClear;
  }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.blurQuad.dispose(); this.compQuad.dispose();
    this.blurMat.dispose(); this.compMat.dispose();
  }
}
