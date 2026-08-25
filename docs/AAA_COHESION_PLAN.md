# EMBERGATE — AAA Cohesion Program (working spec)

Owner-approved 2026-08-25: flat-shaded + cohesion pass (art style NOT reopened) ·
Claude writes the story bible, owner approves before wiring · world cohesion
first · flagship (S25-class) device floor. Goal: run until every wave is done.

Grounded in the 7-subsystem audit of 2026-08-24 (world-city, dungeons,
combat-anim, magic-abilities, progression-story, render-perf-assets, ui-ux).
Standing laws unchanged: one renderer · zero PointLights · meshopt only ·
fully offline · deterministic sim (seeded streams, RNG draw order is contract) ·
no SL proper nouns · no glow on living characters · lowercase asset keys ·
commits authored jacken.holland@gmail.com.

## Wave A — Foundations
1. ~~Stable portal ids (kill the doorstep-memory hack)~~ ✅ ef7f35c
2. Settlement descriptor: Threshold's identity (walls/streets/districts/portals/
   interiors/verge POIs/palettes) becomes data; City consumes a descriptor;
   byte-identical output proven by the existing suites. THE enabler for towns.
3. ~~LAYOUT_PARAMS missing-rank fallback throws~~ ✅ ef7f35c
4. ~~ascension.js canAscend → canForge~~ ✅ ef7f35c
5. Strings/narrative module (lands with Wave C wiring; home established first)
6. UI tokens: one :root token sheet, tokenized z-ladder, city chrome on tokens,
   native confirm() replaced. Zero visual change this wave.
7. PerfProbe: first real-hardware measurement channel (?perf=1 / 5-tap build
   stamp; fps/p95/calls/programs/tier overlay; COPY exports JSON; localStorage
   crash-safe). Owner runs it on the S25 Ultra.

## Wave B — World Cohesion
1. Road network as descriptor data; Verge gets real roads; one trim kit.
2. Gates dissolve into districts (placement = per-settlement data; multi-target
   compass pips + rank-colored banners lead the way).
3. Doors: animated leaf on enterables; recessed doorway pieces on sealed
   buildings; smoothed roof-fade + camera boom; placeholder venues resolved.
4. Second settlement (village, ~20 buildings, no wall, own palette row) +
   a traversable forest region with hidden wild gate. Blender MCP fills kit
   gaps THROUGH tools/build-*-glb.mjs (procedural twins mandatory).
5. Waygates (portal kind carrying settlement id through the rebuild-per-
   transition flow) + world map screen (isolated-camera trick) + save gains
   settlement/per-town state (absent-means-default).
6. Palette rows per region + color-grade/vignette as uniforms on the existing
   glow COMPOSITE pass (zero new passes).

## Wave C — Story
1. Story bible (docs/STORY_BIBLE.md) — DRAFTED, awaiting owner approval.
2. Surfaces: dialogue overlay (AssayUI recipe), kind:'talk' prompts, quest
   ledger + journal panel, sequence player from the dungeon-intro machinery.
3. Wiring: quest ticks at _clearGate; beats at the boss-kill site; reactive
   door text; quest-giver citizens; setObjective as live tracker.

## Wave D — Combat Feel & Magic
1. attacks.js staged adoption: TELL decal telegraphs FIRST, then per-archetype/
   rank pattern rosters, then stepSweepSpec swept hitboxes, then poise.
2. Animation: wire adventurers.glb + the 107 unused KayKit clips (retarget in
   rig family, two-rig law); play the dead 'cast' clips; momentumCarry lunge.
3. Magic bow: draw pose + conjured nocked arrow (spawn flash), per-element
   material off TINT_TARGETS, ArchonPool trail, dissolve-not-stick impacts.
   New guarded stamps only — never edit the byte-identity bolt path.
4. One element/FX palette table; skills/enemy casts migrate to the atlas;
   per-rank enemy magic (arcing mortars etc); extend the cover-height assert.
5. Stylized physics: enemies migrate to CharacterBody (physics.js:68-73 plan),
   impulse tumbles, pooled interactive scatter. No ragdolls.

## Wave E — Dungeons That Earn Their Rank
B 'tower' vertical kind (heightAt seam) · A open-landscape kind · S scripted
set-piece + real RIFT ARCHON · per-rank identity rows (camera/fog/grade/sky/
objectives/rosters) · anomalies become mechanic swaps · per-boss deterministic
brains (kill the Math.random brain) · split the generator per-kind first.

## Wave F — Progression & Retention
1. Wire the dead daily-contract engine (tickDaily at kill/clear/bind, HUD chip,
   claim surface).
2. Build the level-40 class trial (Sealed Stair) → awardClassTier → the whole
   already-built Archon endgame becomes reachable.
3. Rank-up ceremonies off levelsGained; per-band unlocks fill the 12→55 dead
   zone (tap/hold multiplexer pattern).
4. 53–100 ladder: weekly hunts, streaks, milestones, repeatable S-variants —
   sized against xpForLevel.

## Wave G — AAA Presentation
Settings screen · custom icon set (kill OEM-font glyphs) · title carries
hunter name + story framing · per-rank gate intro cards · quest-tier toasts ·
CSS sources consolidated onto the Wave A tokens.

## Perf gates (every wave)
Gate-mode zero-program-growth assert (the 50→83 creep) · every new area clones
city-test's p95 budget harness · skinned-body ledger arbitrates crowds ·
PerfProbe numbers from the owner's device recalibrate all budgets.
