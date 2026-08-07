# Where to get assets for Gatebreaker

Everything in the game right now is generated in code — meshes from primitives,
audio from oscillators, icons rendered by a script. That was deliberate: zero
licensing risk, a 7.9 MB APK, and no load times. But it caps how good it can
look.

This is the shopping list, ordered by **how much each one actually changes the
game**, with licences and the exact format to download.

A note before the list: **CC0 is the only licence with no ongoing obligation.**
Everything else (CC-BY especially) requires you to ship attribution. If you take
CC-BY assets, add a credits screen — it's a licence condition, not a courtesy.
Avoid CC-BY-NC entirely if you ever want to charge for this or run ads.

---

## 1. Character models — the single biggest visual jump

The characters are currently boxes. This is what most people would notice first.

| Source | Licence | What you want |
| --- | --- | --- |
| **[Quaternius](https://quaternius.com/)** | **CC0** | The "Ultimate RPG" and "Cyberpunk Characters" packs. Rigged, animated, low-poly, glTF. Best single fit for this game. |
| **[Kenney](https://kenney.nl/assets)** | **CC0** | "Mini Characters", "Blocky Characters". Clean, consistent, deliberately simple. |
| **[Poly Pizza](https://poly.pizza/)** | CC0 + CC-BY (filter!) | Huge searchable library. Filter to CC0 unless you'll credit. |
| **[Mixamo](https://www.mixamo.com/)** | Free w/ Adobe account | **Animations**, not models. Upload a rigged character, download walk/attack/death cycles. Royalty-free in projects; you just can't resell the animation files themselves. |
| **[Sketchfab](https://sketchfab.com/search?features=downloadable&licenses=322a749bcfa841b29dff1e8a1bb74b0b)** | Filter to CC0/CC-BY | Higher quality, more variable. Always check the licence per model. |

**Format:** `.glb` (glTF 2.0 binary). Load with `GLTFLoader`. Run models through
[gltf-transform](https://gltf-transform.dev/) (`gltf-transform optimize in.glb out.glb`)
— it typically cuts 50–70% with Draco mesh compression and texture resizing.

**Budget:** 300–1,500 triangles per character for mobile. Skinned meshes render
in **one draw call** versus the ~13 our procedural rigs use, so this is a
performance *win* as well as a visual one.

---

## 2. HDRI environment maps — biggest lighting jump

The game synthesises a 64×32 HDR environment in JavaScript (`src/render/env.js`).
It works, but a real HDRI is dramatically better.

- **[Poly Haven HDRIs](https://polyhaven.com/hdris)** — **CC0**, ~700 of them.
  Grab **1k or 2k `.hdr`**. Do *not* download 4k or 8k: the map gets blurred into
  a small prefiltered cubemap anyway, so you'd be shipping megabytes for nothing.
  Look at `dikhololo_night`, `moonless_golf`, `satara_night` for the rift mood.

Load with `RGBELoader` → `PMREMGenerator.fromEquirectangular()`. The wiring
already exists in `src/render/env.js`; it's a ~10-line swap.

---

## 3. PBR textures — surfaces stop looking like flat plastic

- **[ambientCG](https://ambientcg.com/)** — **CC0**, ~2,000 PBR materials. Best
  first stop. Want `Rock`, `Ground`, `Concrete`, `Metal` categories.
- **[Poly Haven Textures](https://polyhaven.com/textures)** — **CC0**, fewer but
  very high quality.
- **[FreePBR](https://freepbr.com/)** — free tier, check terms.

**Download 1k or 2k, not 4k.** You need `_Color`, `_NormalGL`, and `_Roughness`.
Skip the rest — ambient occlusion and displacement aren't worth the memory here.

**Critical for mobile:** convert to **KTX2/Basis** before shipping:
```bash
npx @gltf-transform/cli etc1s in.png out.ktx2
```
An uncompressed 2048² texture costs **16 MB of GPU memory**; the KTX2 version
costs ~2 MB and stays compressed on the GPU. Load with `KTX2Loader`. Skipping
this step is the most common way mobile WebGL games run out of memory.

---

## 4. Audio — the current SFX are synthesised beeps

| Source | Licence | Notes |
| --- | --- | --- |
| **[Sonniss GDC Bundle](https://sonniss.com/gameaudiogdc)** | Royalty-free, commercial OK | Released free every year. **Tens of GB** of professional SFX. Genuinely the best free game audio on the internet. Can't resell as a library; use in games is fine. |
| **[Kenney Audio](https://kenney.nl/assets/category:Audio)** | **CC0** | Small, clean, game-ready UI and impact sounds. |
| **[Freesound](https://freesound.org/)** | **Per-sound** — check each | Enormous. Filter to CC0. **Watch for CC-BY-NC**, which blocks commercial use. |
| **[Pixabay Audio](https://pixabay.com/sound-effects/)** | Pixabay licence | Free commercial, no attribution. |
| **[Incompetech](https://incompetech.com/music/royalty-free/)** | CC-BY | Kevin MacLeod's music. Attribution required. |

**Format:** `.ogg` (Vorbis) — universally supported on Android, better than MP3
at the same size. Keep SFX **mono** at 22–44 kHz; stereo doubles the size for no
benefit on a phone speaker. Budget ~2–4 MB per minute of music.

Keep the procedural audio as a fallback — it costs nothing and covers you if a
file fails to load.

---

## 5. Skill icons — replace the Unicode glyphs

The skill buttons currently use `☗ ◎ ✕ ⚔`, which are just text characters.

- **[game-icons.net](https://game-icons.net/)** — **CC-BY 3.0**, ~4,000 SVG
  fantasy/RPG icons. Purpose-built for exactly this. Attribution required.
- **[Lucide](https://lucide.dev/)** / **[Phosphor](https://phosphoricons.com/)** —
  **MIT/ISC**, no attribution, but generic rather than fantasy.

SVGs are tiny, scale perfectly, and can be recoloured in CSS. This is the
cheapest visual upgrade on the list.

---

## 6. Fonts — already done

Rajdhani is now bundled (`src/fonts/`, SIL OFL 1.1). If you want alternatives in
the same "system window" register, all on Google Fonts and all OFL:
**Chakra Petch**, **Orbitron**, **Michroma**, **Saira Condensed**, **Teko**.

Self-host them — don't link to Google Fonts, because the APK has no network.

---

## Size budget

The debug APK is **13.14 MB** today (measured with `./gradlew assembleDebug`,
2026-08-06), up from 8.70 MB before the character/creature/world packs landed.
Of that +4.44 MB, only `characters.glb` is reachable from `src/main.js`;
`creatures.glb`, `citykit.glb` and `nature.glb` are ~4.4 MB of payload that no
runtime code path loads yet. Rough further additions:

| Item | Realistic cost |
| --- | --- |
| 6 rigged characters (Draco `.glb`) | 3–8 MB |
| 1 HDRI (2k `.hdr`) | 3–6 MB |
| 5 texture sets (KTX2) | 5–10 MB |
| Music (3 tracks) + SFX | 10–20 MB |
| Icons + fonts | < 1 MB |

**Landing around 40–60 MB** is normal and completely fine. Google Play's limit is
200 MB for a plain APK, and far more via an AAB with Play Asset Delivery.

---

## How to actually get them in

I can't download these from my build environment — the network policy blocks
`polyhaven.com`, `ambientcg.com`, `kenney.nl` and friends. So:

1. You download the packs you want.
2. Drop them into `game/assets/` (models/, textures/, audio/, hdri/).
3. Tell me what's there, and I'll wire up the loaders, the KTX2/Draco pipeline,
   an asset-preload screen, and per-quality-tier asset selection.

If you'd rather not hunt, **start with just two**: a Quaternius character pack
and one Poly Haven HDRI. Those two alone would change the look more than
everything else on this list combined.

---

## Licence hygiene

Whatever you pull in, keep a `game/assets/CREDITS.md` recording source, author
and licence for every file. It takes a minute per asset and it is the difference
between a shippable game and one you have to gut later. CC-BY assets also need
those credits visible **inside** the game, not only in the repo.

---

## What is already integrated

| Asset | Source | Licence | Where |
| --- | --- | --- | --- |
| Rajdhani (500/600/700, latin) | Google Fonts | SIL OFL 1.1 | `src/fonts/` |
| `moonless_golf` HDRI | [Poly Haven](https://polyhaven.com/a/moonless_golf) | **CC0** | `assets/hdri/` (source) → `public/hdri/rift_sky.hdr` (baked) |
| Ultimate RPG Items Pack (106 models + 107 icons) | [Quaternius](https://quaternius.com/) | **CC0** | `Ultimate RPG Items Pack - Aug 2019/` (source, gitignored) → `public/models/items.glb` + `icons.webp`/`icons.json` |
| Ultimate Modular Men + Women Packs (21 rigged characters, 24 animations) | [Quaternius](https://quaternius.com/) | **CC0** | `assets/source/characters/` (source, 65 MB) → `public/models/characters.glb` + `characters.json` |
| Ultimate Monsters (13 shipped) + Character Pack: Skeletons + Character Animations | [Quaternius](https://quaternius.com/), [KayKit](https://kaylousberg.itch.io/) | **CC0** | `assets/source/creatures/` (source, 96 MB) → `public/models/creatures.glb` + `creatures.json` — **built and verified, but NOT yet loaded by any code** |
| Fantasy Town Kit 2.0 (167) + Ultimate Modular Ruins (78) | [Kenney](https://kenney.nl/assets), [Quaternius](https://quaternius.com/) | **CC0** | `assets/source/world/` (source, 31 MB) → `public/models/citykit.glb` + `citykit.json` — consumed by `src/world/citykit.js`, which only `src/world/city.js` uses |
| Ultimate Nature Pack (140 pieces) | [Quaternius](https://quaternius.com/) | **CC0** | `assets/source/world/` (source) → `public/models/nature.glb` + `nature.json` — **built and verified, but NOT yet loaded by any code** |

> `assets/source/` is ~190 MB of build input and is gitignored (the PROVENANCE /
> CREDITS / LICENSE files are kept). Everything under `public/models/` MUST be
> committed: the sources exist on one machine and CI cannot regenerate them.

### The item pack

```bash
npm run build:items    # Blender -> gltf-transform -> gltfpack, plus the icon atlas
npm run test:items     # asserts 106 named roots survive and every icon key is lowercase
```

106 FBX become one 736 KB meshopt GLB (90,861 triangles, 27 shared materials,
each model a scene root named exactly after its source file). 107 1000×1000 PNGs
become one 310 KB 1408×1280 WebP atlas plus a JSON index. Whole pack: ~1 MB.

Four things about this pipeline are load-bearing and every one of them fails
*silently* if changed — see the header comments in `tools/build-items-glb.mjs`
and `tools/pack-icons.mjs`:

- Imported FBX objects are renamed to `<name>__part` **before** the handle Empty
  is created, or Blender hands back `Sword001` and every lookup returns null.
- `gltfpack -kn` is mandatory; without it node names are stripped and the file
  loads fine and is unusable.
- meshopt, not Draco — Draco resolves two loose decoder files at runtime, which
  is a silent on-device failure under Capacitor and breaks the offline rule.
- Every icon key is lowercased: the pack's icon filenames differ from its model
  filenames by case only, which macOS hides and Android does not.

`public/models/` is committed on purpose (`.gitignore` carries explicit
un-ignore rules). The 97 MB source pack exists on one machine, so CI cannot
regenerate it — and a build that shipped without it would show no models and
raise no error. `src/render/models.js` resolves `false` rather than throwing
when the GLB is absent, so the game still boots on procedural weapons.

### The character packs

```bash
node tools/build-characters-glb.mjs            # build + verify
node tools/build-characters-glb.mjs --verify   # verify the committed GLB only
```

21 CC0 Quaternius characters (11 men, 10 women) become one 3.2 MB meshopt GLB
plus a 14 KB JSON manifest. 151,094 triangles, 48 materials, 24 animation clips
per rig. Licences and provenance: `assets/source/characters/PROVENANCE.md`.

**No Blender step.** Both packs ship glTF 2.0 with a single embedded base64
buffer per character and zero images, so this is a pure gltf-transform pipeline
— unlike the item pack, which has to go through Blender to merge 106 FBX.

The shared-skeleton claim is **half true, and the half that is false is the
expensive half.** All 21 characters have byte-identical bone *names* and
hierarchy (62 joints) and the same 24 clip names. But the men's and women's
packs are two different rigs: their bone rest transforms and inverse bind
matrices differ (max rest-offset delta 0.108, max IBM delta 1.87), and every
clip animates absolute per-bone *translations* baked against its own rest pose,
so the two packs' clip payloads differ too. Playing `male_Walk` on a female mesh
would drag the female bone offsets to male ones while her inverse bind matrices
stayed put — she would stretch. So the GLB carries **two rigs and two clip sets**
and dedups the other 19 skeletons and 19 clip sets away. That dedup is what
turns 24.7 MB of merged glTF into 3.2 MB.

Structure, all lowercase keys, all published in `characters.json`:

```
scene "characters"
├── rig_male     — 62 bones prefixed m_,  clips prefixed male_,   11 characters
└── rig_female   — 62 bones prefixed f_,  clips prefixed female_, 10 characters
      └── char_women_witch
            ├── char_women_witch_head / _body / _legs / _feet
```

Each rig root holds its skeleton *and* every character that uses it, so
`SkeletonUtils.clone(rig)` clones all of them; drop the `char_*` groups you do
not want. Part swapping works within a rig — any `char_*_head` can be reparented
onto another character in the same pack and skins correctly.

Five things are load-bearing and every one fails *silently* — see the header of
`tools/build-characters-glb.mjs`:

- Bone names are **prefixed per rig** (`m_` / `f_`). three.js runs every node
  name through `createUniqueName()`, so two rigs both calling their root bone
  `Root` would silently load as `Root` and `Root_1`, and which rig won would
  depend on node ordering.
- Dots are **stripped from bone names** up front (`Shoulder.L` → `m_Shoulder_L`),
  because `PropertyBinding.sanitizeNodeName()` deletes `[]./:` — otherwise the
  name in the file is not the name in the scene graph.
- Clip names are **prefixed per rig**, so `Idle` is never ambiguous.
- `gltfpack -kn` is mandatory, and meshopt not Draco, for the same two reasons
  as the item pack.
- Two of the 21 (women/Medieval's sword, women/SciFi's pistol) are **rigid props
  parented to a hand bone**, not skinned parts. Discarding a duplicate bone tree
  takes them with it and loses the geometry with no error at all. They are
  hoisted into the character group and their bone is published as
  `characters[key].props[slot].attachBone` — re-parent them at runtime.

Verified: all 21 roots resolve by name, every `SkinnedMesh` has 62 bones, all 48
clips are named and non-empty, every track of `male_Idle`/`female_Idle` binds to
its own rig and to neither the other, a `SkeletonUtils.clone` of a rig stripped
to one character animates, and each character's bind-pose bounding box matches
its source `.gltf` to within 0.0001 units.

The HDRI is baked from the 6.1 MB source EXR down to a 409 KB RGBE `.hdr`:

```bash
node tools/bake-hdri.mjs assets/hdri/moonless_golf_2k.exr public/hdri/rift_sky.hdr 512
node tools/verify-hdri.mjs    # checks the round-trip against the source
```

512×256 is not a compromise here — `PMREMGenerator` prefilters the map into a
small blurred cubemap for lighting, so the extra resolution was being discarded
anyway. Verified round-trip: mean luminance ratio 1.0001, worst-case error 1.07%
(RGBE 8-bit mantissa quantisation).

Drop a different Poly Haven HDRI into `assets/hdri/` and re-run the bake to
change the entire mood of the game's lighting.
