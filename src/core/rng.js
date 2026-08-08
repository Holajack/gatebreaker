// Deterministic PRNG, lifted out of src/game/world.js so THREE-free modules
// (dungeonlayout.js, the Node generation soak) can import it without dragging
// the whole renderer in. world.js re-exports it, so every existing
// `import { mulberry32 } from './world.js'` keeps working unchanged.
//
// Determinism is load-bearing here: context-loss recovery rebuilds a gate via
// world.build(gate, seed), so the same seed MUST replay the exact same stream.
// Never "improve" this function — any change silently invalidates every saved
// seed and the byte-compare soak in tools/dungeon-gen-test.mjs.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default mulberry32;
