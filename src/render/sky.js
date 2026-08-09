import * as THREE from 'three';

// Procedural sky dome: gradient, horizon rift glow, stars, drifting aurora.
//
// three's Sky.js is a Preetham daylight-scattering model — there is no
// parameterisation of it that produces a void rift, and it costs more. A custom
// BackSide dome with renderOrder 1000 draws *after* opaque geometry, so tile
// hidden-surface removal rejects every sky pixel the arena already covers.

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3  uZenith, uHorizon, uGround, uAccent;
  uniform float uTime, uStars, uAurora;
  varying vec3 vDir;

  // The sun/moon block compiles ONLY for makeSky(..., { sun: true }). Every
  // existing caller (arenas, the six dungeon biomes, and the city until the
  // day/night wiring lands) leaves it out, so their program and their pixels
  // are the ones they have always had — see makeSky's note.
  #ifdef SUN_DISC
  uniform vec3  uSunDir, uSunColor;
  uniform vec2  uDiscs;      // x = sun disc intensity, y = moon disc intensity
  uniform float uAccentAz;
  #endif

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
          mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
          mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  void main() {
    vec3 d = normalize(vDir);
    float t = d.y;

    // Below the horizon the old curve, pow(-t, 0.6), was a quarter of the way
    // to the near-black uGround within a few degrees — and from a grounded
    // camera the only visible below-horizon sky IS those few degrees past the
    // ground apron, so the world ended in a void cliff. Hold uHorizon (the fog
    // colour) flat through that band and fall off toward uGround only well
    // below anything a grounded camera can see, so the region behind the fog
    // line reads as misty ground instead.
    vec3 col = t >= 0.0
      ? mix(uHorizon, uZenith, pow(t, 0.45))
      : mix(uHorizon, uGround, smoothstep(0.05, 0.65, -t));

    // Rift glow banded along the horizon, aligned with the env-map key light.
    float az   = atan(d.z, d.x);
    float band = exp(-pow(t - 0.02, 2.0) / 0.010);
    // The lobe's azimuth is steerable only in the sun build: at dawn and dusk
    // the rift glow should sit under the sun rather than at a fixed compass
    // bearing. The #else arm is the shipped line, character for character.
    #ifdef SUN_DISC
    float lobe = exp(-pow(az - uAccentAz, 2.0) / 0.55);
    #else
    float lobe = exp(-pow(az - 0.75, 2.0) / 0.55);
    #endif
    col += uAccent * band * (0.35 + lobe * 0.9);

    #ifdef SUN_DISC
    // ONE direction serves both bodies: the moon is drawn at -uSunDir, so
    // "which one is up" is answered by uDiscs and never by a second uniform,
    // a second light, or a branch on time of day. Masked to the above-horizon
    // band so neither body bleeds into the misty-ground region below t = 0.
    float above = smoothstep(-0.015, 0.03, t);
    float cs    = dot(d, uSunDir);
    float sunCore = smoothstep(0.99955, 0.99985, cs);
    // Two lobes: a tight aureole and a wide forward-scatter wash. The wash is
    // what sells a low sun — the whole quarter of sky around it lifts.
    float sunHalo = pow(max(cs, 0.0), 900.0) * 0.55 + pow(max(cs, 0.0), 14.0) * 0.05;
    col += uSunColor * (sunCore * 2.0 + sunHalo) * uDiscs.x * above;

    float cm = -cs;
    float moonCore = smoothstep(0.99975, 0.99992, cm);
    float moonHalo = pow(max(cm, 0.0), 1600.0) * 0.30;
    col += mix(uSunColor, vec3(0.80, 0.86, 1.0), 0.65)
         * (moonCore * 1.4 + moonHalo) * uDiscs.y * above;
    #endif

    if (t > -0.05 && uStars > 0.0) {
      vec3 sp = d * 190.0;
      vec3 cell = floor(sp);
      float r = hash13(cell);
      float bright = smoothstep(0.9955, 1.0, r);
      vec3 off = vec3(hash13(cell + 7.1), hash13(cell + 13.7), hash13(cell + 23.3));
      float dd = length(fract(sp) - off);
      float star = bright * smoothstep(0.38, 0.0, dd);
      float twinkle = 0.55 + 0.45 * sin(uTime * 2.6 + r * 90.0);
      col += vec3(0.85, 0.9, 1.0) * star * twinkle * uStars * smoothstep(-0.05, 0.35, t);
    }

    if (uAurora > 0.0 && t > 0.02) {
      vec3 q = vec3(d.x * 2.2, d.y * 5.0 - uTime * 0.045, d.z * 2.2);
      float n = noise3(q) * 0.65 + noise3(q * 2.7 + 11.0) * 0.35;
      float ribbon = smoothstep(0.52, 0.86, n)
                   * smoothstep(0.02, 0.42, t)
                   * smoothstep(0.95, 0.45, t);
      col += mix(uAccent, vec3(0.35, 0.95, 0.85), 0.35) * ribbon * uAurora;
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * @param {object} biome  palette; see the double-conversion note below
 * @param {object} opts   { stars, aurora, sun }
 *
 * `sun: true` opts the dome into the sun/moon disc and the steerable rift
 * azimuth. It is OFF by default on purpose: the disc adds a preprocessor
 * define, and a define is a different compiled program. Callers that do not
 * ask for it get the exact program and the exact pixels they got before this
 * option existed, which is the whole golden-image contract for arenas and the
 * six dungeon biomes.
 */
export function makeSky(biome, { stars = 1.0, aurora = 0.55, sun = false } = {}) {
  const uniforms = {
    uZenith: { value: new THREE.Color(biome.sky).convertSRGBToLinear() },
    uHorizon: { value: new THREE.Color(biome.fog).convertSRGBToLinear() },
    uGround: { value: new THREE.Color(biome.ground).convertSRGBToLinear().multiplyScalar(0.35) },
    uAccent: { value: new THREE.Color(biome.accent).convertSRGBToLinear() },
    uTime: { value: 0 },
    uStars: { value: stars },
    uAurora: { value: aurora },
  };
  if (sun) {
    // Defaults chosen so a sun-enabled dome that is never fed a DayState still
    // renders today's frame: both discs off, rift band on its shipped bearing.
    uniforms.uSunDir = { value: new THREE.Vector3(58, 74, 40).normalize() };
    uniforms.uSunColor = { value: new THREE.Color(0xfff0d6).convertSRGBToLinear() };
    uniforms.uDiscs = { value: new THREE.Vector2(0, 0) };
    uniforms.uAccentAz = { value: 0.75 };
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    defines: sun ? { SUN_DISC: '' } : {},
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    dithering: true,   // phone panels are 8-bit; without this the gradient bands hard
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
  mesh.scale.setScalar(300);        // inside camera.far
  mesh.renderOrder = 1000;          // after opaques, so early-Z rejects most pixels
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/**
 * Push a DayState (src/render/daynight.js) onto a dome. Call once per frame;
 * allocates nothing.
 *
 * THE DOUBLE CONVERSION IS DELIBERATE. makeSky runs every palette colour
 * through convertSRGBToLinear() even though ColorManagement has already
 * linearised the hex, so the dome renders one gamma step dark and every biome
 * in the game — plus the day/night table's skyPalette — is authored
 * pre-brightened against that. This function applies the SAME second
 * conversion the constructor does, so hour 15:00 reproduces SKY_BIOME exactly.
 * Removing it here would re-tone six dungeons; see city.js's SKY_BIOME note.
 */
export function updateSkyState(mesh, state) {
  const u = mesh?.material?.uniforms;
  if (!u || !state) return;
  const p = state.sky;

  u.uZenith.value.copy(p.zenith).convertSRGBToLinear();
  u.uHorizon.value.copy(p.horizon).convertSRGBToLinear();
  u.uGround.value.copy(p.ground).convertSRGBToLinear().multiplyScalar(0.35);
  u.uAccent.value.copy(p.accent).convertSRGBToLinear();
  u.uStars.value = state.stars;
  u.uAurora.value = state.aurora;

  // Domes built without { sun: true } have no such uniforms and no shader code
  // that reads them — skip rather than grow a uniform set the program ignores.
  if (!u.uSunDir) return;
  u.uSunDir.value.copy(state.sunDir);
  u.uSunColor.value.copy(state.keyColor).convertSRGBToLinear();
  u.uDiscs.value.set(state.sunDisc, state.moonDisc);
  u.uAccentAz.value = p.accentAz;
}
