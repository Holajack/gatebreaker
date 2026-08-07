# Creature pack provenance

All three packs are **CC0 1.0 Universal (Public Domain Dedication)**. CC0 requires
no attribution — this file exists for hygiene, so nobody has to re-derive where
the art came from or re-check the licence.

| Pack | Author | Licence | Downloaded | Used |
| --- | --- | --- | --- | --- |
| Ultimate Monsters | Quaternius | CC0 1.0 | 2026-08-06 | 13 of 50 monsters |
| Character Pack: Skeletons (FREE tier) | Kay Lousberg | CC0 1.0 | 2026-08-06 | 4 of 4 characters, 7 of 13 accessories |
| Character Animations (FREE tier) | Kay Lousberg | CC0 1.0 | 2026-08-06 | 25 of 133 clips |

Built into `public/models/creatures.glb` + `creatures.json` by
`tools/build-creatures-glb.mjs`. That file's header carries the pipeline traps;
this one carries only where the bytes came from.

## How each one was fetched

**Quaternius — Ultimate Monsters.** The pack page
(<https://quaternius.com/packs/ultimatemonsters.html>) has no direct download; its
"Just give me the Download" button opens a public Google Drive folder,
`18m4KpzpEzhC9wl7jzr6dUc0N8Jozr79C`. No account, no form. The folder's own web UI
lazy-loads and is awkward to scrape, but
`https://drive.google.com/embeddedfolderview?id=<FOLDER_ID>#list` returns a plain
HTML listing of `id` + filename for any public folder, and
`https://drive.google.com/uc?export=download&id=<FILE_ID>` fetches a file. That is
how the per-monster files were enumerated and pulled. Every file id used is
recorded inline in `tools/build-creatures-glb.mjs` (the `drive:` field), so an
individual model can be re-fetched without re-walking the folder.

The pack is organised by BODY TYPE — `Big/`, `Blob/`, `Flying/` — not by monster.
Those three groups have different skeletons and different animation vocabularies
(`Big` says `HitReact`, `Blob` says `HitRecieve`, `Flying` has `Flying_Idle` and
`Fast_Flying` and no walk cycle at all). Several names appear in two groups and
are **genuinely different models** — `Big/Yeti` is a 6094-triangle humanoid on a
45-node rig, `Blob/Yeti` is a 2136-triangle ball on a 6-node rig. That is why the
50 advertised monsters are only ~40 distinct names.

**KayKit — both packs.** Distributed through itch.io as name-your-own-price
downloads (<https://kaylousberg.itch.io/kaykit-skeletons> and
<https://kaylousberg.itch.io/kaykit-character-animations>). The FREE tier upload
is the one taken; the paid EXTRA and SOURCE tiers were deliberately not bought.
itch does not expose a static download URL — the page grants a short-lived token
per session — so these were fetched by the ordinary anonymous free-download flow
(`/purchase?popup=1` for a CSRF token → `POST /download_url` → the upload's
`/file/<id>` endpoint). Nothing was bypassed; that is the same sequence the
"Download Now → No thanks, take me to the downloads" button performs. The
original zips are kept beside the extracted trees so nobody has to repeat it.

## What is stored here

```
quaternius/
  big/ blob/ flying/     the 20 .gltf files that were EVALUATED (13 shipped)
  LICENSE-quaternius.txt
kaykit/
  skeletons-free.zip     pristine downloads, kept so the extracted trees are
  animations-free.zip      reproducible without re-running the itch flow
  skeletons/  animations/ extracted; the build reads the gltf/ subtrees only
```

The Quaternius `.gltf` files are self-contained: one embedded base64 buffer plus
one embedded PNG palette atlas, no `.bin` sidecar. That, plus the fact that they
already carry skins and named clips, is why `tools/build-creatures-glb.mjs` needs
**no Blender step** — unlike the item pack, where FBX left no choice.

Two notes on upstream sloppiness, so neither looks like a bad download:

- `quaternius/LICENSE-quaternius.txt` is headed **"Ultimate Platformer Pack"**.
  It is the file Quaternius ships inside the Ultimate Monsters folder; the header
  is their copy/paste slip. The dedication itself is unambiguous CC0 1.0, and the
  pack page states CC0 as well.
- `flying/Demon.gltf` ships with exactly **one** animation (`Flying_Idle`) where
  every other model on that rig has eight. It is a real pack defect, not a
  truncated download — which is why that model was cut and why the builder has a
  `MIN_CLIPS` guard.

## What was deliberately NOT downloaded

- Quaternius `Blends/`, `FBX/` and `OBJ/` variants — alternative encodings of the
  same models, and the glTF is the only one the pipeline reads.
- The ~30 Quaternius monsters that were never candidates. The pack is a **cartoon**
  set (candy palette, sleepy-slit eyes, a cactus in a sombrero, a chicken, a dog,
  bees); most of it cannot be reconciled with a game whose D-gate blurb is "The
  dead here were buried standing up." The 20 plausible ones were downloaded,
  rendered, and looked at one by one; 13 survived. The reject list with per-model
  reasons is in the builder's curation block.
- KayKit EXTRA and SOURCE tiers (paid).
- KayKit `fbx/`, `fbx(unity)/` and `obj/` variants, and the `Rig_Large/` animation
  set — the skeletons are all `Rig_Medium`, so `Rig_Large` has nothing to bind to.
