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

// Region grade (Wave B6). The composite quad is the ONLY full-screen draw we
// own, and it never samples the framebuffer — it is blended over the scene.
// So the grade has to live in the blend equation, not in shader arithmetic
// over the scene color:
//
//   out = src * ONE + dst * SRC_ALPHA
//
// with the vignette factor written into src ALPHA. That single change of
// blend factors is what lets one quad both ADD (lift, glow) and DARKEN
// (vignette) without a second pass. It is bit-identical to the shipped
// AdditiveBlending when alpha is exactly 1.0: the old mode was
// (SRC_ALPHA, ONE) with the shader writing alpha 1.0 — src*1 + dst*1 —
// and the new mode with alpha 1.0 is src*1 + dst*1.0, the same product.
// Fixed-function blending multiplies by the exact factor value, so *1.0
// cannot drift.
//
// What each uniform can and cannot reach, given that constraint:
//   uGradeLift  — additive, reaches the WHOLE frame (it rides src).
//   uVignette   — multiplicative darken, reaches the WHOLE frame (dst*alpha),
//                 and dims the glow/lift src by the same factor so the corner
//                 falloff is uniform, not "dark scene, bright halos".
//   uGradeSat   — reaches ONLY the composite contribution (glow + lift).
//                 A true scene-wide saturation remix needs per-channel access
//                 to dst, which fixed-function blending cannot express and
//                 framebuffer-fetch does not exist in WebGL2; the only fix is
//                 rendering the scene to a target first — a new pass, which
//                 this module's contract forbids. Muted regions therefore mute
//                 their emissives, not their albedo. Documented, not hidden.
//
// Defaults short-circuit: sat and vignette sit behind dynamically-uniform
// branches (no divergence cost — the condition is a uniform), so at defaults
// the executed arithmetic is LITERALLY the shipped expression plus one
// `+ vec3(0.0)` (exact identity for the finite non-negative values this
// shader produces) and an alpha of exactly 1.0. visual-test's probes MEASURE
// this (they print, they don't gate — its exit code ignores luma drift; a
// hardening task if that ever bites).
const COMPOSITE = /* glsl */`
  uniform sampler2D tGlow;
  uniform float uStrength;
  uniform vec3 uGradeLift;
  uniform float uGradeSat;
  uniform float uVignette;
  varying vec2 vUv;
  void main() {
    vec3 g = texture2D(tGlow, vUv).rgb * uStrength;
    g = vec3(1.0) - exp(-g);      // soft rolloff so glow never clips to flat white
    g = pow(g, vec3(0.4545));     // linear -> sRGB, matching the framebuffer
    if (uGradeSat != 1.0) {
      // Rec.709 luma — same weights the tone mapper's luminance uses, so a
      // desaturated glow lands on the gray the scene would call "same
      // brightness" rather than shifting value as it loses hue.
      g = mix(vec3(dot(g, vec3(0.2126, 0.7152, 0.0722))), g, uGradeSat);
    }
    g += uGradeLift;              // exact +0.0 at defaults — identity
    float vig = 1.0;
    if (uVignette > 0.0) {
      // Radial falloff: flat inside r=0.25, eased to full effect at the
      // corner (r = sqrt(0.5) for centered UV). smoothstep keeps the onset
      // invisible at low strengths instead of printing a circle.
      float fall = smoothstep(0.25, 0.7071, length(vUv - 0.5));
      vig = max(1.0 - uVignette * fall, 0.0);
      g *= vig;                   // dim our own contribution with the scene
    }
    gl_FragColor = vec4(g, vig); // alpha scales dst via ONE/SRC_ALPHA blend
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
      uniforms: {
        tGlow: { value: this.rtA.texture },
        uStrength: { value: this.strength },
        uGradeLift: { value: new THREE.Vector3(0, 0, 0) },
        uGradeSat: { value: 1.0 },
        uVignette: { value: 0.0 },
      },
      vertexShader: VERT, fragmentShader: COMPOSITE,
      // Custom (ONE, SRC_ALPHA) instead of AdditiveBlending (SRC_ALPHA, ONE):
      // dst gets multiplied by the shader's alpha so uVignette can darken the
      // scene from this same quad. With alpha 1.0 (the default grade) both
      // modes reduce to src*1 + dst*1 — see the COMPOSITE comment for why
      // that is exact, not merely close.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
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

  /**
   * Region grade identity (Wave B6). Pass { lift:[r,g,b], glowSat, vignette }
   * or null to restore the shipped look. Any omitted field falls back to its
   * default — a region that only wants a vignette should not have to restate
   * the rest. NOT persisted anywhere: the caller (citymode via the settlement
   * descriptor's palette row) re-applies on every world build, which is what
   * keeps save files and this renderer decoupled.
   *
   * Ranges (magnitudes unclamped, malformed values fail soft to defaults):
   * lift is a small additive push (sensible 0..~0.06 per channel — it adds to
   * EVERY pixel, so 0.05 already reads as haze), glowSat multiplies the
   * COMPOSITE CONTRIBUTION ONLY (0 = monochrome glow, 1 = shipped — see
   * setGrade's rename note; it is not scene saturation and cannot be),
   * vignette is 0 (off) .. 1 (corners to black). The tier gate matters:
   * low/medium run bloom:false, Glow.render() early-returns before the
   * composite quad, and the grade never draws there — REGION IDENTITY ON
   * THOSE TIERS RIDES THE PALETTE/FOG ROWS (daynight/env data), which reach
   * every tier; this grade is the high-tier garnish on top, by design.
   */
  setGrade(grade) {
    const u = this.compMat.uniforms;
    // Field is `glowSat`, NOT `sat` (renamed while zero call sites and zero
    // palette rows existed — review finding): it desaturates ONLY the
    // glow+lift composite contribution, never the scene, an architectural
    // limit of a quad that cannot sample the framebuffer. A field named
    // plain `sat` in a REGION grade promised scene-wide saturation it cannot
    // deliver, and Wave E's palette authors would have written sat:0.5
    // expecting a muted region.
    const { lift, glowSat, vignette } = grade || {};
    // Defensive: values come from authored descriptor rows — exactly the
    // input that gets a typo. Malformed rows fail SOFT (defaults), never
    // NaN-poison the composite into a black region.
    if (lift && Number.isFinite(lift[0]) && Number.isFinite(lift[1]) && Number.isFinite(lift[2])) {
      u.uGradeLift.value.set(lift[0], lift[1], lift[2]);
    } else u.uGradeLift.value.set(0, 0, 0);
    u.uGradeSat.value = Number.isFinite(glowSat) ? glowSat : 1.0;
    u.uVignette.value = Number.isFinite(vignette) ? Math.max(0, vignette) : 0.0;
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
