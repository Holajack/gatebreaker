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

The APK is **7.9 MB** today. Rough additions:

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
