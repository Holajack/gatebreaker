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

// The bloom ceiling, and the reason it exists.
//
// The shipped build ran this pass at strength 1.35. The main scene is rendered
// through ACES tone mapping at exposure 1.25, so a character's brightest lit
// pixels get rolled off, while this pass is composited ON TOP in gamma space
// with no rolloff at all. The arithmetic guarantees the outcome the review
// described: "bloom on the rings is far stronger than on the characters". The
// characters could not win, whatever the art did.
//
// 0.85 is where an 8-character field stops being a sheet of light. Anything
// that truly needs to blow out — a portal, a nova, a boss telegraph — is still
// plenty bright, because those are saturated MeshBasicMaterial at full value
// and the composite's exp() rolloff keeps their cores white either way.
//
// Callers that pass more than this get clamped rather than obeyed. That is a
// deliberate one-way door: game.js is not this module's to edit, and a silent
// clamp with a loud comment beats leaving the shipped look in place. Use
// setStrength(v, { force: true }) to go above it on purpose.
export const MAX_STRENGTH = 0.85;

// Same story for the blur kernel. game.js asks for 1.1; at quarter resolution
// that is a very wide halo, and width is what made eight ground rings pool into
// a single sheet rather than eight separate marks.
export const MAX_SPREAD = 0.9;

/** Mark an object (and its subtree) as emissive for the glow pass. */
export function markGlow(obj) {
  obj.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isInstancedMesh) o.layers.enable(GLOW_LAYER);
  });
}

/**
 * Opt back OUT of the glow pass. The counterpart to markGlow, for objects that
 * inherited GLOW_LAYER from a treatment written for the box-man era.
 */
export function unmarkGlow(obj) {
  obj.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isInstancedMesh) o.layers.disable(GLOW_LAYER);
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
  // `spread` defaults tighter than it used to (1.1 -> 0.9). Halo WIDTH is what
  // made eight rings merge into one mass; a narrower kernel keeps a glow
  // attached to the object that emitted it instead of pooling between objects.
  constructor(renderer, { scale = 0.25, strength = 0.85, spread = 0.9 } = {}) {
    this.renderer = renderer;
    this.scale = scale;
    this.spread = Math.min(spread, MAX_SPREAD);
    this.enabled = true;
    this.strength = Math.min(strength, MAX_STRENGTH);
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
      uniforms: { tGlow: { value: this.rtA.texture }, uStrength: { value: this.strength } },
      vertexShader: VERT, fragmentShader: COMPOSITE,
      blending: THREE.AdditiveBlending,
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.blurQuad = new FullScreenQuad(this.blurMat);
    this.compQuad = new FullScreenQuad(this.compMat);
    this._w = 2; this._h = 2;
  }

  /**
   * Change the composite strength at runtime. Clamped to MAX_STRENGTH unless
   * `force`, which exists so a deliberate set-piece (a rift collapsing, say)
   * can blow the screen out without the ceiling being a lie the rest of the
   * time.
   */
  setStrength(v, { force = false } = {}) {
    this.strength = force ? v : Math.min(v, MAX_STRENGTH);
    this.compMat.uniforms.uStrength.value = this.strength;
    return this.strength;
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
