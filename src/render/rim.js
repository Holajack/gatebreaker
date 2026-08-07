import * as THREE from 'three';

// Fresnel rim lighting injected into MeshStandardMaterial — OPT-IN.
//
// WHY THIS IS NOW OFF BY DEFAULT
// This treatment was written when every character in the game was an untextured
// coloured box. Against a box, a Fresnel rim IS the silhouette: it is doing the
// work a model would otherwise do. Real skinned models with real proportions
// have since landed, and against those the same shader produces a person
// wearing a neon outline. The owner's note on the shipped build was exactly
// that — "can we make them normal character-looking instead of glowing
// different things".
//
// So applyRim no longer rims anything unless the call site asks for it. The
// machinery is untouched and still cheap (~6 ALU per lit fragment); it is meant
// for the things that SHOULD look unnatural: portals, boss telegraphs, rift
// boundaries, summoned shadows.
//
// Contract, in resolution order:
//   applyRim(m)                          -> untouched, normal lit shading
//   applyRim(m, { rim: false })          -> untouched, explicitly
//   applyRim(m, { preset: 'shadow' })    -> named preset
//   applyRim(m, { rim: true, color, strength, power })  -> explicit params
//   applyRim(m, { color, strength })     -> LEGACY. Untouched, unless the
//                                           material is a shadow-soldier
//                                           material (see isShadowMaterial),
//                                           which gets the restrained 'shadow'
//                                           preset in the caller's colour.
//
// That last clause is what lets characters.js and entities.js stay untouched
// while still doing the right thing for both kinds of humanoid. It is a
// heuristic and it is documented as one; the permanent fix is for those two
// files to pass `preset` explicitly (see the handoff diff).

export const RIM_PRESETS = {
  // Shadow soldiers. The ONE humanoid exception: being visibly unnatural is
  // the entire point of them. Restrained, not neon — a third of the old
  // strength and a much tighter falloff, so it is a cold edge on a dark body
  // rather than a glowing coat.
  shadow: { color: 0x35e6ff, strength: 0.30, power: 4.5, tint: 0.55 },
  // Things that are supposed to be light sources.
  portal: { color: 0xb388ff, strength: 1.0, power: 2.2, tint: 0 },
  telegraph: { color: 0xff4d6d, strength: 1.1, power: 2.0, tint: 0 },
};

// Both ghost/shadow constructors in characters.js and entities.js build a
// translucent body with a non-black emissive; nothing else in the game does.
// Living bodies are opaque with emissive black, so the two never collide.
export function isShadowMaterial(m) {
  return Boolean(m && m.transparent && m.emissive && m.emissive.getHex() !== 0);
}

function resolve(material, opts) {
  if (opts.rim === false || opts.preset === 'none') return null;
  if (opts.preset) {
    const p = RIM_PRESETS[opts.preset];
    if (!p) return null;
    return { ...p, ...(opts.color != null ? { color: opts.color } : {}) };
  }
  if (opts.rim === true || opts.enabled === true) {
    return {
      color: opts.color ?? 0x9dd8ff,
      strength: opts.strength ?? 0.9,
      power: opts.power ?? 3.0,
      tint: opts.tint ?? 0,
    };
  }
  // Legacy call: honour the intent (shadow soldiers stay unnatural), drop the
  // rest (living characters get normal lit shading).
  if (isShadowMaterial(material)) {
    return { ...RIM_PRESETS.shadow, ...(opts.color != null ? { color: opts.color } : {}) };
  }
  return null;
}

export function applyRim(material, opts = {}) {
  const cfg = resolve(material, opts);
  if (!cfg) {
    // Leave the material exactly as three built it. No onBeforeCompile and no
    // customProgramCacheKey means it shares the stock MeshStandard program with
    // every other unrimmed material — one fewer shader variant to compile on a
    // cold boot, which is where phone startup time goes.
    material.userData.rim = null;
    material.rimUniforms = null;
    return material;
  }

  // `tint` pulls the rim colour toward the body's own darkness so a "glow"
  // colour can be reused for a rim that is not supposed to glow.
  const c = new THREE.Color(cfg.color).convertSRGBToLinear();
  if (cfg.tint) c.lerp(new THREE.Color(0x060a14).convertSRGBToLinear(), cfg.tint);

  const uniforms = {
    uRimColor: { value: c },
    uRimStrength: { value: cfg.strength },
    uRimPower: { value: cfg.power },
  };
  material.userData.rim = uniforms;
  // ALSO on the material itself, not only in userData. characters.js's
  // ghostMaterial assigns `m.userData = {}` immediately after calling this (it
  // has to: disposeObject3D refuses to free anything flagged shared), which
  // silently erased the userData copy. Anything auditing "is this rimmed?" —
  // tools/visual-test.mjs does — has to read a field the call sites do not
  // stomp, or it reports a clean bill of health it did not earn.
  material.rimUniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3  uRimColor;
        uniform float uRimStrength;
        uniform float uRimPower;`)
      .replace('#include <opaque_fragment>', `
        {
          vec3  vd   = normalize( vViewPosition );
          float fres = pow( 1.0 - clamp( dot( normal, vd ), 0.0, 1.0 ), uRimPower );
          // Bias upward so it reads as a light source, not a sticker.
          fres *= 0.55 + 0.45 * clamp( normal.y * 0.5 + 0.5, 0.0, 1.0 );
          outgoingLight += uRimColor * fres * uRimStrength;
        }
        #include <opaque_fragment>`);
  };

  // Distinct cache key so rimmed and plain variants don't share a program.
  material.customProgramCacheKey = () => 'rim';
  return material;
}
