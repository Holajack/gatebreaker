import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// Image-based lighting.
//
// Preferred path: a real captured HDRI (public/hdri/rift_sky.hdr), baked down
// from a 2k Poly Haven EXR to 512x256 RGBE — 409KB instead of 6.1MB, which is
// all PMREM needs since it prefilters into a small blurred cubemap anyway.
// The biome's own colour identity comes from the analytic lights, so one sky
// serves every biome without flattening them into each other.
//
// Fallback path (below): a synthesised map, used if the HDRI fails to load so a
// bad fetch degrades the lighting instead of producing a black screen.
//
// MeshStandardMaterial is a microfacet BRDF: with no environment map its
// indirect specular term is simply zero, which is why untextured PBR geometry
// reads as "flat 3D" rather than "rendered". We synthesise a tiny equirect
// RGBA16F map per biome in JS — "HDR" only means values above 1.0 — and let
// PMREMGenerator prefilter it. Costs about a kilobyte of maths and zero bytes
// in the APK.

const W = 64, H = 32;   // PMREM blurs this heavily; more resolution is wasted.

function makeEnvSource(biome) {
  const data = new Uint16Array(W * H * 4);
  const zenith = new THREE.Color(biome.sky).convertSRGBToLinear();
  const horizon = new THREE.Color(biome.fog).convertSRGBToLinear();
  const ground = new THREE.Color(biome.ground).convertSRGBToLinear();
  const accent = new THREE.Color(biome.accent).convertSRGBToLinear();
  const c = new THREE.Color();
  const half = THREE.DataUtils.toHalfFloat;

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const t = Math.cos(v * Math.PI);          // +1 zenith .. -1 nadir
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;

      if (t >= 0) c.copy(horizon).lerp(zenith, Math.pow(t, 0.55));
      else c.copy(horizon).lerp(ground, Math.pow(-t, 0.7));

      // One hot rift source. Pushing it far above 1.0 is what gives metal a
      // highlight worth looking at.
      const dAz = Math.abs((((u - 0.62) % 1) + 1.5) % 1 - 0.5);
      const dEl = t - 0.34;
      const gl = Math.exp(-(dAz * dAz) / 0.0045) * Math.exp(-(dEl * dEl) / 0.045);

      // Broad cool counter-fill opposite it, deliberately kept under 1.0.
      const dAz2 = Math.abs((((u - 0.12) % 1) + 1.5) % 1 - 0.5);
      const fill = Math.exp(-(dAz2 * dAz2) / 0.06) * Math.max(0, t) * 0.55;

      const i = (y * W + x) * 4;
      data[i] = half(c.r * (1 + fill) + accent.r * gl * 24);
      data[i + 1] = half(c.g * (1 + fill) + accent.g * gl * 24);
      data[i + 2] = half(c.b * (1 + fill) + accent.b * gl * 24);
      data[i + 3] = half(1);
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;   // float data is already linear
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let _pmrem = null;
let _hdriTexture = null;      // the raw equirect, kept for use as a sky backdrop
let _hdriPromise = null;

function pmrem(renderer) {
  if (!_pmrem) {
    _pmrem = new THREE.PMREMGenerator(renderer);
    _pmrem.compileEquirectangularShader();       // pay the compile once, at boot
  }
  return _pmrem;
}

/**
 * Load the shipped HDRI once. Resolves to the equirect texture, or null if it
 * could not be fetched — callers must handle null and fall back.
 */
// Indirect-light exposure, and why it is not 1.0.
//
// Characters used to carry a Fresnel rim that added light to every silhouette
// edge. That rim was doing two jobs at once: making a box read as a body, and
// quietly acting as a fill light. rim.js has now turned it off for living
// characters — the owner asked for people, not neon outlines — and the second
// job went with it. Measured on the 8-character gameplay frame, dropping the
// rim cost the character region about a fifth of its brightness on its own.
//
// This buys that fill back from the correct place: the image-based light. It is
// a real fill from the sky the scene is actually standing under, so it lands on
// upward-facing surfaces and follows the biome, rather than tracing an outline
// around everybody. Applied to the HDRI radiance before PMREM prefilters it, so
// it costs one pass over a 512x256 buffer at boot and nothing per frame.
export const IBL_EXPOSURE = 1.35;

function scaleRadiance(tex, k) {
  const d = tex.image?.data;
  if (!d || k === 1) return tex;
  // RGBELoader gives HalfFloatType by default in three r150+; handle both it
  // and the Float32 path rather than assuming, because a wrong assumption here
  // is a silently black sky.
  if (d instanceof Uint16Array) {
    const { fromHalfFloat, toHalfFloat } = THREE.DataUtils;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = toHalfFloat(fromHalfFloat(d[i]) * k);
      d[i + 1] = toHalfFloat(fromHalfFloat(d[i + 1]) * k);
      d[i + 2] = toHalfFloat(fromHalfFloat(d[i + 2]) * k);
    }
  } else if (d instanceof Float32Array) {
    for (let i = 0; i < d.length; i += 4) { d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }
  } else {
    return tex;   // unknown encoding: leave it alone rather than corrupt it
  }
  tex.needsUpdate = true;
  return tex;
}

export function loadHdri(url = 'hdri/rift_sky.hdr') {
  if (_hdriPromise) return _hdriPromise;
  _hdriPromise = new Promise((resolve) => {
    new RGBELoader().load(
      url,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        scaleRadiance(tex, IBL_EXPOSURE);
        _hdriTexture = tex;
        resolve(tex);
      },
      undefined,
      () => resolve(null),   // degrade to the synthesised map rather than failing
    );
  });
  return _hdriPromise;
}

export function getHdriTexture() { return _hdriTexture; }

/**
 * Returns a PMREM render target for a biome. Uses the real HDRI when it has
 * finished loading, otherwise the synthesised stand-in.
 * The caller owns the result and must dispose it.
 */
export function buildBiomeEnvironment(renderer, biome) {
  const gen = pmrem(renderer);
  if (_hdriTexture) return gen.fromEquirectangular(_hdriTexture);
  const src = makeEnvSource(biome);
  const rt = gen.fromEquirectangular(src);
  src.dispose();
  return rt;
}

/** PMREM output does not survive a WebGL context loss; drop the cache on one. */
export function disposeEnvironmentCache() {
  _pmrem?.dispose();
  _pmrem = null;
  _hdriTexture?.dispose();
  _hdriTexture = null;
  _hdriPromise = null;
}
