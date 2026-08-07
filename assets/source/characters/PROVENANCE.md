# Character pack provenance

Both packs are **CC0 1.0 Universal (Public Domain Dedication)**. CC0 requires no
attribution — this file exists for hygiene, so nobody has to re-derive where the
art came from or re-check the licence.

| Pack | Author | Licence | Characters | Downloaded |
| --- | --- | --- | --- | --- |
| Ultimate Modular Men Pack | Quaternius | CC0 1.0 | 11 | 2026-08-06 |
| Ultimate Modular Women Pack | Quaternius | CC0 1.0 | 10 | 2026-08-06 |

- Pack pages: <https://quaternius.com/packs/ultimatemodularcharacters.html> and
  <https://quaternius.com/packs/ultimatemodularwomen.html>
- Both pages link a public Google Drive folder as the download; there is no
  itch.io gate, no form and no account. Folder ids:
  `1USAAquX2JJWuA2m6zol0KUkFe3UkZ8zX` (men) and
  `1720N9IGyQHXYvtvZJzazhxtTTlz-y2Vf` (women).
- Author's own licence and readme text is kept verbatim as `*/License.txt` and
  `*/How To Use.txt`. Note that **`women/License.txt` says "Ultimate Modular
  Males"** — that is a copy/paste slip in the upstream pack, not a mislabelled
  download. It still reads CC0 1.0, and the rest of the folder is unambiguously
  the women's pack.

## What is actually stored here

Only the `glTF` variant of each pack's **Individual Characters** folder. Each
`.gltf` is self-contained: a single embedded base64 buffer, no `.bin` sidecar,
no images (the art is flat-shaded — colour lives in `baseColorFactor`). That is
why `tools/build-characters-glb.mjs` needs **no Blender step**, unlike the item
pack.

The packs' other variants — `FBX/`, `Blends/`, `Humanoid Rigs/`,
`Separate Skeletal Meshes and Animations/`, and the `All together/` masters —
were deliberately **not** downloaded. They are alternative encodings of the same
21 characters plus per-engine retarget rigs; nothing in them is missing from the
glTF. Re-fetch them from the Drive folders above if a future workflow needs them.

```
men/    License.txt  "How To Use.txt"  gltf/*.gltf   (11)
women/  License.txt  "How To Use.txt"  gltf/*.gltf   (10)
```

~65 MB. Rebuild the shipped asset with:

```bash
node tools/build-characters-glb.mjs          # build + verify
node tools/build-characters-glb.mjs --verify # verify the committed GLB only
```

## The one thing worth knowing before you touch this

The 21 characters share **bone names and hierarchy exactly** (62 joints, same
order, same parents, on all 21) and the same 24 clip names — but the men's and
women's packs are **two different rigs**: their bone rest transforms and inverse
bind matrices differ (max rest-offset delta 0.108 on `Body`; max IBM delta 1.87),
and their clip payloads differ because every clip bakes absolute per-bone
translations against its own rest pose. Within a pack, all characters' skeletons
and all clip data are bit-identical.

So `characters.glb` carries **two** rigs and **two** clip sets, and dedups the
other 19 skeletons and 19 clip sets away. Playing a `male_*` clip on a female
mesh would overwrite the female bone offsets while the female inverse bind
matrices stayed put — the mesh would stretch. The per-rig `clipPrefix` in
`public/models/characters.json` exists to make that mistake impossible.
