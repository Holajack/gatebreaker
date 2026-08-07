# World kit sources

Everything here is **CC0 1.0** — public domain dedication, no attribution
required, no ongoing obligation, commercial use fine. Credit is given anyway
because it costs nothing and the alternative is nobody remembering where a file
came from in six months.

| Source pack | Author | Licence | Downloaded from | Local |
| --- | --- | --- | --- | --- |
| Fantasy Town Kit 2.0 (167 models) | Kenney (kenney.nl) | CC0 1.0 | <https://kenney.nl/assets/fantasy-town-kit> | `kenney_fantasy-town-kit_2.0.zip` → `kenney-fantasy-town/` |
| Ultimate Nature Pack (150 models) | Quaternius | CC0 1.0 | <https://quaternius.com/packs/ultimatenature.html> | `nature-fbx/` |
| Ultimate Modular Ruins Pack (92 models) | Quaternius | CC0 1.0 | <https://quaternius.com/packs/ultimatemodularruins.html> | `ruins-fbx/` |

Licence texts as shipped by the authors: `kenney-fantasy-town/License.txt`,
`LICENSE-quaternius-nature.txt`, `LICENSE-quaternius-ruins.txt`.
`ruins-How-To-Use.txt` is the ruins pack's own note about its grid and the
wall-rotation rule.

## What this folder is

Build **input**, ~31 MB, and it is not needed at runtime. Nothing in the game
reads from here. `tools/build-world-glb.mjs` converts it into two committed
files:

```
public/models/citykit.glb + citykit.json    Kenney town + Quaternius ruins
public/models/nature.glb  + nature.json     Quaternius nature
```

Rebuild with `node tools/build-world-glb.mjs`, verify with `--verify`.

**This folder should be gitignored and the two GLBs should not be.** See the
handoff note — `.gitignore` was outside this task's file ownership, so the rule
has not been added yet. Until it is, `git add -A` will try to commit 31 MB of
source packs.

## Provenance of the download

Kenney ships a direct zip. Quaternius routes downloads through a shared Google
Drive folder of individual FBX files, so the two Quaternius packs were pulled
file-by-file from the folder listings (150 and 92 files respectively, every one
verified non-empty and not an HTML error page). If they ever need re-fetching,
the folder ids are in the pack pages linked above.
