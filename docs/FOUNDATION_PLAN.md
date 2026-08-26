# THE FOUNDATION PROGRAM — from "pieced together" to a game

**Origin:** Jacken's first real playtest of 3.0-ascension on the S25 Ultra (2026-08-26).
His verdict: systems are there, but it "looks very much like AI put together some kids
slap some stuff together." UI floats mid-screen in the city, the ground reads as raw
triangles, jumps truncate mid-flip, combat is a twitch not a swing, hits pass through
pillars, class paths are opaque, and there is no welcome and nobody obvious to talk to.

**Status of the story:** REJECTED. docs/STORY_BIBLE.md does not advance. All [BIBLE]
strings stay provisional and frozen. Story gets redone with Jacken later — nothing in
this program adds lore copy.

---

## Why it feels pieced together (the honest diagnosis)

Real studios ship in this order: **prove the fun → set the quality bar on one small
slice → only then build breadth.** EMBERGATE did it backwards: we built enormous
breadth (3 settlements, 6 dungeon kinds, quests, classes, weeklies) on top of
**blockout-quality art**. In studio terms, the whole world is still a greybox —
placeholder geometry level designers use to test spacing, which is *never shipped*.
Nothing is wrong with the systems; the game skipped the **vertical slice** and the
**art pass**. That is the gap this program closes.

## The professional pipeline, and where EMBERGATE sits

| Stage | What studios do | EMBERGATE today |
|---|---|---|
| 1. Concept | Pillars, references, art direction bible | ✅ (flat-shaded direction locked) |
| 2. Prototype | Find the fun in a graybox | ✅ (core loop works) |
| 3. **Vertical slice** | ONE area at final quality — art, feel, UI, audio | ❌ **skipped — this is the gap** |
| 4. Production | Blockout → art pass → polish, per area, to the slice's bar | ❌ world is still blockout |
| 5. Alpha | Content complete | (systems yes, presentation no) |
| 6. Beta/polish | Game feel, perf on real hardware | PerfProbe exists, no data yet |
| 7. Ship | | 3.0 shipped as systems-alpha |

## The program

### Wave 0 — CLARITY (feel + UX bugs; quick, high-confidence)
Maps to: "icons in the center", "strange settings/button layout", "flip doesn't
complete", "hit an enemy through the wall", "why do I have Bind abilities", "no
welcome screen", "no person to talk to".
1. City HUD rearranged to the dungeon arrangement (the one Jacken called perfect);
   nothing floats center over the player.
2. Jump flip driven by predicted airtime — completes just before landing; no flip on
   short hops. Dash untouched (he likes it).
3. Hit-time occlusion: a wall or pillar between attacker and target blocks the hit —
   both directions, pure geometry query, deterministic.
4. Class Path view: names the paths, previews 18/30/42 unlocks, says exactly when the
   choice happens, stops presenting unusable abilities as owned.
5. First-arrival welcome overlay (functional copy only, no lore) + floating talk
   markers over conversable NPCs.

### Wave 1 — GROUND TRUTH (the terrain look)
Maps to: "sidewalk is just triangles… different shadings… no elevation… no road
versus sidewalk." The single highest-impact visual complaint.
- Kill per-triangle shade noise; ground reads as cohesive surfaces.
- Roads rendered as real strips along the existing street graph, slightly recessed;
  sidewalk lip / curb elevation; distinct building-plot treatment.
- heightAt/nav/collision updated coherently; baselines retargeted with rationale.

### Wave 2 — THE SLICE (art pass on one district)
Bring ONE district of Threshold to the target bar: facade variety and trim on
buildings, props, cohesive palette, lighting mood. This district becomes the visual
contract every other area is brought up to. (Studio equivalent: the "beautiful
corner".)

### Wave 3 — SWING (combat animation rework)
Maps to: "a weird twitch thing… not actually swinging the sword."
Anticipation → contact → recovery arcs on every weapon class; the weapon visibly
travels through the hit; hitstop on contact; recovery windows readable. Enemy
reactions already exist (flinch/stagger) — this wave makes the *player* side honest.

### Wave 4 — THE SEAMLESS WORLD (procedural continuity)
Maps to: "I want this to be procedurally generated, so it looks like an infinite
world that keeps generating as it goes."
Chunk-streamed wilderness beyond settlement edges so the world reads continuous
instead of assembled; settlements become places IN a world rather than the world
itself. Biggest architecture item — designed on paper first, after Waves 0–2 land.

### Wave 5 — STORY REDO (with Jacken, later)
Full rewrite session. Not before he's ready.

### Wave P — PERFORMANCE (real-device, data-driven)
S25 Ultra probe data arrived 2026-08-26 (docs/perf/s25u-2026-08-26.md): 60 fps
p50 but ≥10% of frames at 30 fps, concentrated in the 1.4M-tri city; shader
programs grow 45→115 across the first fight (compile hitches, the 50 ms max
frame). Done in Wave 0: probe now reports the true render pixel ratio. Next:
a load-screen shader warm-up (designed against the seeded-RNG contract — render-
side objects only), then city tri pressure alongside Wave 1/2.

### Parked / needs clarification
- "There's no power and ability balance" — needs a follow-up question: which
  abilities felt samey or wrongly tuned?

## Rules carried forward (unchanged)
One renderer; zero PointLights; no glow on living characters; flat-shaded direction;
seeded sim RNG; no new HUD buttons; suites are the contract (retarget, never delete);
ship = versionCode bump + stamp verified inside the APK before upload.
