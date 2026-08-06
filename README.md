# Gatebreaker: Rift Ascension

A 3D action-RPG for Android. You play a rift hunter who clears procedurally
generated dungeon gates, levels up, allocates stats, unlocks skills, and raises
fallen enemies as shadow soldiers who fight alongside you.

Built with Three.js and wrapped for Android with Capacitor. Original setting and
characters — inspired by the "hunter clears gates and levels up" ARPG genre, not
derived from any existing property.

## Getting the APK

The APK is built by GitHub Actions, not locally — see [Why CI](#why-ci-builds-the-apk).

**[Download gatebreaker.apk](https://github.com/Holajack/gatebreaker/releases/download/gatebreaker-latest/gatebreaker.apk)**

That link always serves the newest build; every push to `main` replaces it. Open
it on an Android phone and tap the downloaded file to install. Android will ask
you to allow installing from unknown sources, because it's signed with a debug
key rather than a Play Store key.

Prefer the raw artifact? Open the **Actions** tab → **Build Gatebreaker APK**,
pick the most recent run, and download the **gatebreaker-apk** artifact.

Minimum Android 5.1 (API 22). The game is fully offline — no network calls, no
analytics, no accounts.

## Playing

| Action | Touch | Keyboard |
| --- | --- | --- |
| Move | Left thumbstick | `WASD` / arrows |
| Attack | ⚔ button | `J` / `Space` |
| Dash (i-frames) | ↯ | `Shift` |
| Ruin (cleaving arc) | ✕ | `K` |
| Nova (radial burst) | ◎ | `L` |
| Bind (raise Cinderbound) | ☗ | `U` |

Clear every enemy in a gate to summon its boss; kill the boss to break the gate.
Basic attacks chain into a 3-hit combo — the finisher hits far harder and knocks
enemies back. Shadows you raise persist between gates; dying loses half of them.

Six gates, E-rank through S-rank, each with its own biome, enemy mix and boss.
Progress saves to local storage automatically.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle into dist/
```

To build the APK locally you need the Android SDK installed and `ANDROID_HOME`
set:

```bash
npm run apk        # build + cap sync + gradlew assembleDebug
# output: android/app/build/outputs/apk/debug/app-debug.apk
```

### Layout

```
src/
  main.js            bootstrap, game loop, wake lock
  core/
    input.js         virtual thumbstick, skill buttons, keyboard
    audio.js         procedural WebAudio SFX and drone (no audio files)
    save.js          localStorage hunter profile
  game/
    config.js        all balance tables — gates, enemies, bosses, skills, stats
    world.js         seeded procedural arena generation and collision
    entities.js      procedurally assembled low-poly humanoid rigs
    effects.js       pooled particles, damage numbers, shake, hit-stop
    game.js          combat, AI, waves, boss patterns, camera
  ui/ui.js           screens and HUD
tools/               icon generation and headless test harnesses
```

All art is generated in code — meshes from primitives, icons and splash screens
rendered by `tools/make-icons.mjs`. The repo carries no third-party art or audio,
which keeps the APK small and the licensing clean.

Balance lives entirely in `src/game/config.js`; you can retune the whole game
without touching engine code.

### Testing

The harnesses in `tools/` drive the game headlessly against a preview server
(`npm run build && npx vite preview --port 4180`):

```bash
node tools/smoke.mjs               # boot → title → gate, screenshots, console errors
node tools/playtest.mjs 0 500 1    # soak a gate: <gateIndex> <simSeconds> <level>
node tools/pillartest.mjs          # collision regression: sliding around obstacles
```

`playtest.mjs` stubs out rendering and runs a scripted hunter through a full
gate far faster than real time, reporting kills, levels, boss state and any
uncaught errors. It is how the difficulty curve was tuned and how the obstacle
collision bug was caught.

## Why CI builds the APK

The development container this was written in has JDK and Gradle but no Android
SDK, and its egress policy blocks `dl.google.com` — which hosts the SDK, `aapt2`,
the Android Gradle Plugin and every AndroidX artifact. None of those are mirrored
on Maven Central. Gradle configures the project fine and fails only when
resolving those artifacts.

GitHub's `ubuntu-latest` runners have the Android SDK preinstalled and
unrestricted access to Google's Maven repository, so the build runs there
instead. The workflow is `.github/workflows/build-apk.yml`.
