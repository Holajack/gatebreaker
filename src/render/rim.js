import * as THREE from 'three';

// Fresnel rim lighting injected into MeshStandardMaterial.
//
// About six ALU ops per lit fragment, and it does more for the "expensive
// stylised render" read than anything else available — it separates characters
// from a dark background and gives each archetype a readable silhouette colour.

export function applyRim(material, { color = 0x9dd8ff, strength = 0.9, power = 3.0 } = {}) {
  const uniforms = {
    uRimColor: { value: new THREE.Color(color).convertSRGBToLinear() },
    uRimStrength: { value: strength },
    uRimPower: { value: power },
  };
  material.userData.rim = uniforms;

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
