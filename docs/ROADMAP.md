# Roadmap — post-playtest program (2026-08-07)

Owner feedback (first real playtest, Samsung S25 Ultra + wants Chrome play):
game is fun and looks good as-is; direction confirmed. New identity, deeper
world, better combat feel. Repo slug stays `gatebreaker`; the game gets a new
title (provisional: **GATEBOUND**) and "Arise" is renamed (**Bind** — fallen
monsters are bound into the shadow army, keeping their own silhouette, recolored
near-black).

## Wave 1 — mechanics + identity (in flight)
- Player-controlled camera: drag-to-orbit yaw on the right half of the screen,
  movement becomes CAMERA-RELATIVE (supersedes the old "no drag-to-yaw"
  decision at the owner's explicit request). City + gates. Keyboard WASD for
  desktop Chrome play.
- Combat feel: weapon properly gripped in the hand bone; `*_Sword_Slash` /
  punch/kick clips wired to attacks with the damage window synced to clip
  contact; enemy attack animations; `Idle_Sword` when armed.
- City: road/kerb definition + ground patchwork + nature.glb scatter (finally
  imported); wall segments stack with terrain (no floating seams); rank flags —
  banner colors around the city advertise which gate ranks exist here
  (data-driven for future multi-city); hide "NOT YET OPEN" teaser POIs; ambient
  civilians + hunter NPCs wandering streets (citizens.js).
- Bind: extracted monsters keep their creature model, re-materialized in the
  dark shadow treatment; summoned field shadows are the creatures you bound.
- Identity/meta: title screens + Android label renamed, versionCode 3
  ("1.2-gatebound"), male/female hunter select on the title screen
  (save.playerBody), GitHub Pages web deploy for Chrome play.

## Wave 2 — the world build-out (designs drafted in Wave 1 research)
- Dungeon-crawl gates: no spawn-drop; walk through the portal into tunnels,
  rooms, corridors; per-rank tilesets + enemy rosters; boss chamber; exit
  portal. Replaces the circular arena as the primary gate experience.
  (docs/DUNGEON_SPEC.json)
- Day/night cycle: sun path, sky, city lighting, portals glowing at dusk.
- Overworld: explorable terrain beyond the walls, biome fields, discoverable
  POIs; enterable/taller buildings where the kit supports interiors.
  (docs/WORLD_SPEC.json)
- Content packs: curated CC0 additions (dungeon kit, ability VFX, more
  monsters) — shortlist with licenses in docs/CONTENT_PACKS.json before
  anything is downloaded.
- Weapon shop economy; shadow companion walking with you in the city; more
  hunters/NPC schedules; story framing.

## Standing rules (unchanged)
- No Solo Leveling proper nouns/silhouettes. No rim/glow on living characters.
- meshopt only; offline runtime; procedural fallbacks; lowercase asset keys.
- Commits authored jacken.holland@gmail.com.
