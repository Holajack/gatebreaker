# Drop assets here

**This folder is the handoff point.** Anything committed here, I can read. I pull
the repo every time I work on the game, so there is no upload step beyond a git
push — no Drive, no file transfer, nothing for me to be blocked from reaching.

## Where things go

```
assets/
  models/
    characters/   rigged .glb — player, enemies, bosses, soldiers
    weapons/      .glb — swords, axes, daggers, spears, staves
    props/        .glb — rocks, ruins, pillars, crates, gate arches
  textures/       PBR sets: *_Color, *_NormalGL, *_Roughness
  audio/
    sfx/          .ogg — hits, swings, footsteps, UI
    music/        .ogg — ambient beds, boss themes
  icons/          .svg — skill icons
  hdri/           .hdr / .exr — environment lighting
  CREDITS.md      source + author + licence for every file
```

Filenames become identifiers, so keep them lowercase with hyphens:
`skeleton-warrior.glb`, not `Skeleton Warrior (1).glb`.

## Uploading a big pack — read this first

The Quaternius Ultimate RPG pack is a few hundred megabytes **as downloaded**,
because it ships every format at once: FBX, OBJ, Blender source, separate
textures, and glTF. **Upload only the glTF/GLB files.** That is usually 5–10% of
the download and it is the only format the game can load.

Inside a Quaternius download, take the `glTF/` folder (or the `.glb` files) and
skip `FBX/`, `OBJ/`, `Blender/`, `Source/`, and any `.blend`.

Don't upload the whole pack either — the game needs perhaps 8–12 characters, not
150. Pick a few humanoids that fit the four archetypes we already have: a grunt,
a fast light one, a heavy brute, a robed caster, plus a couple of boss-scale
figures. I can always ask for more.

**Hard limits:** GitHub rejects any single file over 100 MB. Individual `.glb`
character files are typically 0.5–3 MB, so this will not be a problem unless
something has 4K textures baked in.

## Two ways to get files in

### Web browser — easiest, no tools

1. Go to the branch:
   https://github.com/Holajack/collins-seo-website/tree/claude/3d-leveling-game-apk-gykts2/game/assets
2. Open the subfolder you want (`models/characters`).
3. **Add file → Upload files**, then drag your `.glb` files in.
4. Make sure it says *"Commit directly to the `claude/3d-leveling-game-apk-gykts2`
   branch"*, and commit.

The web uploader takes up to 100 files at once. For more than that, do it in
batches or use the command line below.

### Command line — better for a whole pack

```bash
git clone https://github.com/Holajack/collins-seo-website.git
cd collins-seo-website
git checkout claude/3d-leveling-game-apk-gykts2

cp ~/Downloads/UltimateRPG/glTF/*.glb game/assets/models/characters/

git add game/assets
git commit -m "Add character models"
git push
```

## Then tell me

Say "models are up" and I will:

- inventory what arrived (`node tools/asset-report.mjs`),
- wire up `GLTFLoader` with Draco decompression and a preload screen,
- swap the procedural box rigs for the real models, keeping the existing
  animation driver where the rigs allow it,
- run each model through size/triangle checks and report anything too heavy for
  a phone,
- and record every file in `CREDITS.md` with its source and licence.

## What is here already

- `hdri/moonless_golf_2k.exr` — Poly Haven, CC0. Baked to
  `public/hdri/rift_sky.hdr` by `tools/bake-hdri.mjs` and already lighting the
  game.

## A note on repo size

Committed assets live in git history permanently, so a 300 MB mistake is
annoying to undo. Prefer uploading a curated subset over everything-just-in-case.
If we ever genuinely need large binaries, the answer is Git LFS, and I will set
it up — but we are nowhere near needing it.
