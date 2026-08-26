# PLAYTEST FINDINGS — 3.1-clarity on the S25 Ultra, watched live over ADB

Jacken played build 3.1-clarity while I watched frame-by-frame over ADB.
His verdict: the design/placement work was never properly done — "you have just
not done, while designing everything, to where it should properly fit and look
right and be the proper placements."

He is right, and the measurements below are why. **These numbers are
engine-independent** — they stay true whether this game continues on
Three.js/Capacitor or is ported to a native engine.

---

## 1. THE ROOT CAUSE — two scale authorities, never reconciled

The character is **2.14 world units** tall (`src/render/characters.js:52`
PROCEDURAL_HEIGHT, derived from the old procedural box rig's head-box top in
`src/game/entities.js:158-161`). Every human in the game is normalised onto
that number (`characters.js:61`, MODEL_SCALE = 2.14/1.85).

The town kit is on a **2.0 unit storey** (`src/world/citykit.js:55`
KIT_STOREY), which was chosen in `tools/build-world-glb.mjs:22-40` to make two
art packs agree WITH EACH OTHER. The character was never one of the
measurements.

| Measurement | Actual | Correct ratio to a 2.14 body | Error |
|---|---|---|---|
| Storey, floor to floor | 2.00 | ~3.34 | character is TALLER than a floor |
| Enterable doorway clear opening | 1.39 w x 1.505 h | ~1.5 x 2.4 | head passes 0.64 through the header |
| Sealed-building "door" (`town_wall_doorway_base`) | 0.795 w, NO lintel | — | body is 1.2 wide; it is a slot, not a door |
| Interior ceiling (`interiors.js:969`) | 2.00 | ~3.34 | head clips the ceiling; cap is alpha-faded so you see it |
| Market awning underside (`city.js:2303`) | 1.339 | ~2.4 | cuts the player at chest height, and carries NO collision |
| 1-storey cottage total height | 3.25 (1.52 bodies) | ~3.0 bodies | every band ~2x too short |

Compounding: the 45-degree camera (`game.js:564`) compresses apparent height by
cos(45) = 0.707, so buildings read even shorter than the raw ratio.

**The worst part of the history:** `tools/build-dungeonkit-glb.mjs:18-30` took
KayKit Dungeon — authored on a 4.0 m storey, which would have been very nearly
CORRECT for a 2.14 character — and multiplied it by 0.5 to conform to the wrong
standard.

**Why no test caught it:** the only height assertion in 60+ suites is
`tools/character-test.mjs:255-257`, which checks the character against the
character. Nothing anywhere asserts headroom, door clearance, or
storey-vs-body. `interior-test.mjs` does walk the player through a door, but it
tests the COLLISION gap (a 2.0 hole in an XZ box list), so it cannot see that
the VISIBLE opening is 1.39 x 1.505 and 0.30 off-centre.

### The fix that is NOT architectural

Both diagnostic passes called this "architectural / rewrite-scale", proposing
either scaling every character down or scaling KIT_CELL up. **Both are wrong
about the cost**, because the vertical module is separable from the layout grid:

- `KIT_STOREY` — **12 uses**, every one of them vertical stacking (`y = f * KIT_STOREY`).
- `KIT_CELL` — **56 uses**: the layout grid, plot search, navgrid feed, collision
  footprints, street half-widths, and every authored coordinate in settlements.js.

So raising the storey ~1.45x (2.0 -> 2.9) with a matching Y-stretch on the wall
pieces fixes buildings, doorways AND interiors at once, and touches **no**
street, plot, nav or collision data. The doorway opening goes 1.505 -> 2.18,
which finally clears the 2.14 body. Effort: medium, not architectural.
Suites needing retarget: tri-count/height baselines only.

---

## 2. THE OTHER FINDINGS

**Talk markers lie (regression from 3.1).** The overhead marker keys on the
static `spec.hunter` roster flag (`citizens.js` _spawn); the TALK prompt keys on
live sim state via `nearestTalker` (visible, not companion, not mid-beat) at
2.6 m with no slack. Worse, hunters actively flee via AVOID_PLAYER at up to
~4 m/s — they run from you while advertising a talk bubble. Fix: one shared
`canTalkTo()` predicate driving both, plus halt-on-hail (a hailed hunter stops
and turns), plus enter-2.6/exit-3.8 hysteresis. Consumes no seeded RNG, so
citylife determinism holds.

**Doors on tall buildings.** The five enterable buildings are hardcoded to 2
storeys (`interiors.js:967`), making them the SMALLEST in town, while the tall
impressive ones are all sealed — and Wave B3 gave those sealed shells
open-looking frames (`town_wall_doorway_base`) over solid collision. The
player's eye correctly picks the tall buildings; every one is fake. Fix: give
ENTERABLES a `floors` field (Assay 4, Exchange/Ashworks 3, Tavern/Stash 2), and
put a real door (`town_wall_doorway_square`, which has a lintel) back on the
sealed ones.

**The map is not a map.** `mapui.js` was scoped as a portal locator and never
revisited. `city.streets`, `city.layoutMeta` (every footprint), `districts` and
`interiors.buildings` are all retained in memory and NONE are drawn; it also
fits the whole known world into one fixed viewBox, so the town occupies ~37%.
Fix: a real top-down survey (streets as stroked paths, footprints as rects,
labelled shops, player arrow) at a TOWN zoom level. Medium.

**The lag is corpses, not AI.** `_makeCorpseMesh` is exempted from the skinned
body ceiling with `ignoreBudget: true` and never runs through `_entityLod`, so
every kill keeps a full skeleton + AnimationMixer + shadow-depth draw alive for
12 seconds. The cost GROWS as the fight goes on — exactly the "lag behind" that
was reported. Compounded by zero shader warm-up (programs climb 45 -> 115 during
the first fight; the 50 ms max frame). Fix: cap corpse meshes and LOD them
(reap the MESH, keep the RECORD — `extractionChance` reads the record), plus a
load-screen `renderer.compile()` warm-up that must not touch seeded spawns.

**Lighting.** Three causes, none of them the no-PointLight law: (a) the shadow
rig was tuned for the 14 m arena and inherited by the city at extent 22 without
re-fitting, with a 12-degree sun-elevation clamp that works around frustum acne
by lying about the sun's position; (b) GLB kit materials keep `doubleSided:true`
with no `shadowSide` normalisation on import; (c) emissive window glow is drawn
from a DIFFERENT rnd() stream than the window geometry it is meant to light, so
they cannot agree.

**The art ceiling — honest answer.** Partly fixable with technique (baked AO in
vertex colours, palette discipline, roughness remapping). Partly needs better
assets. And one hard limit: **ground triangle SIZE is set by camera distance,
not the mesh** — at a 17.6 m boom and 64 fov, a 3.4 m cell is 3.5% of the screen
regardless of colour work. The real "cheap" tell is that four packs from three
artists at three proportion systems were combined with no unifying pass.

---

## 3. THE ARCHITECTURE QUESTION HE ASKED

"Is this truly a full APK, or a web thing wrapped in an APK?"

**It is a WebView game.** Three.js/WebGL running in an Android WebView via
Capacitor; `MainActivity.java` is the stock 2 KB Capacitor bridge. It is a real
installable APK with real native plugins (haptics), but the game itself is the
phone's browser engine, and that is a genuine performance ceiling.

The fork, which is the owner's to call:
- **Stay web/Capacitor** — everything above is fixable; ceiling stays roughly
  where it is plus maybe 30-40% from the fixes.
- **Port to a native engine** (Godot/Unity) — native perf, real lighting, a real
  asset pipeline; the design, progression, combat rules and content survive, the
  rendering and world layer do not. Months.

**Recommended sequence regardless of the fork:** fix scale, doors, talk,
corpse-lag and the map on the current build first (~1.5 days). That makes the
game genuinely playable and answers whether the DESIGN is fun before committing
to an engine port for the PRESENTATION.

---

## 4. ALSO OBSERVED LIVE

- Console warned three times at town build: district gates `gate-d`, `gate-b`,
  `gate-a` each "placed ZERO rank flags — all candidate spots blocked". Those
  gates carry no rank identification. Real bug, unfixed.
- Confirmed working on device: city HUD pinned top-right, first-arrival welcome,
  talk markers visible across the plaza, roads reading as roads with sidewalk
  and elevation (day and night), progression LV1 -> LV5, an E-rift cleared 48/48.
- 20 unspent stat points accumulated without the player being pulled to spend
  them — progression-feel note, not a bug.
