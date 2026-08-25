import * as THREE from 'three';
import { GameMode, registerMode } from './mode.js';
import { FLAT_GROUND } from '../physics.js';
import { GATES, ANOMALY_CHANCE } from '../config.js';
import { animateRig } from '../entities.js';
import { Dungeon } from '../../world/dungeon.js';
import { LAYOUT_PARAMS } from '../../world/dungeonlayout.js';
import { RANK_IDENTITY } from '../../world/layouts/identity.js';
import { EncounterDirector } from '../encounters.js';
import { mulberry32 } from '../../core/rng.js';
import { t } from '../strings.js';

/**
 * The gate run — and, since DUNGEON_SPEC STEP 4, the place that decides WHICH
 * world a rank mounts:
 *
 *   E/D  -> the generated crawl interior (Dungeon, kind 'crawl'), kept on the
 *           mode so its GPU-side caches survive re-entry.
 *   C    -> the same Dungeon class generating kind 'cavern' (STEP 8): one
 *           organic chamber, encounter zones, boss grotto behind a membrane.
 *   B    -> the same Dungeon class generating kind 'tower' (Wave E, THE
 *           ASCENT): terraced floors climbed by stair ramps, parapet drops
 *           with fall damage (this mode owns the damage — see update()), and
 *           the player body bound to the layout's own height function.
 *   A    -> the same Dungeon class generating kind 'waste' (Wave E task E-A,
 *           THE RIVEN WASTE): an open landscape run — rolling smooth terrain
 *           through the SAME heightAt seam the tower opened (the binding
 *           below is already kind-agnostic), a compass-gated route of
 *           objective sites, roaming packs, boss at the final site.
 *   S    -> the same Dungeon class generating kind 'reach' (Wave E task E-S,
 *           THE REACH): a scripted linear set-piece — broken causeways up,
 *           two gauntlet fights, and a collapsing summit arena whose phase
 *           radii live in layout.arenaPhases. The flat arena World survives
 *           only behind forceOpen (dev/baseline path).
 *
 * The swap is a single assignment BEFORE _beginGate: _beginGate calls
 * this.world.build(gate, seed) and the _arenaResolve closure reads this.world
 * dynamically, so the whole combat/spawn/damage machine follows the swap
 * without knowing it happened (spec studyFindings.modeSeam). Everything the
 * arena path runs is byte for byte the code that shipped.
 *
 * `forceOpen` in the enter payload is the sanctioned dev override that mounts
 * the arena for a crawl rank — screenshot baselines and the older tools still
 * exercise the arena through it (spec worldJsArenasFate).
 */

// Ranks that open into a generated interior: E/D crawl, C cavern (STEP 8),
// B tower (Wave E task E-B), A waste (Wave E task E-A), S reach (Wave E task
// E-S — THE set-piece: broken causeway, gauntlet arenas, the RIFT ARCHON's
// collapsing summit). Every rank is an interior now; the flat arena World
// stays reachable only through the forceOpen dev override.
const INTERIOR_RANKS = new Set(['E', 'D', 'C', 'B', 'A', 'S']);

// Interior camera probe constants — citymode's proven boom-probe numbers
// (spec: copy the pattern, do not invent a new one).
const CAM_MIN = 3.6;
const CAM_PROBE_STEPS = 7;
const EYE = 1.55;             // where the collision probe leaves the body
const WALL_PAD = 0.4;

// Entry intro (DUNGEON_SPEC STEP 6, entryExperience beat 4): the player walks
// THROUGH the portal into the crawl — a 2.4 s auto-walk down the entry tunnel
// with input suppressed and a tap to skip. The camera opens on the spec's low
// close-over-the-shoulder shot and eases to the standard follow.
const INTRO_DURATION = 2.4;
const INTRO_WALK_THROTTLE = 0.7;   // auto-walk at 0.7x speed, per spec
// Offsets are player-relative. The END values are chosen so the intro lands
// exactly on the interior follow rig's steady state — camLook leads the player
// by 3.4 m down -Z and camPos = camLook + camOffset (game.js owns it; 0,13,13
// since the owner's zoom-out pass — read it, never hardcode it), so the handoff
// frame is bit-continuous with _updateInteriorCamera and nothing snaps.
const INTRO_CAM_FROM = { x: 0, y: 3.2, z: 5.2 };   // spec's shoulder shot

// THE INTERIOR CAMERA IS NOT THE ARENA CAMERA, and this wave is why. The crawl
// rooms grew about 5.5x (a boss chamber is now 38x38 m) while the rig stayed on
// the open arena's 0/13/13 boom with a 3.4 m forward lead. tools/camera-frame
// measured what that costs at 892x412: 45.7 m of ground visible FORWARD, which
// no room is deep enough to use, against 5.18 m toward the camera — less than
// the 6.16 m of a single dash. Anything that circled to your near side left the
// frame in one dodge, and a boss you are kiting can be a health bar over an
// empty floor.
//
// So the interior spends that wasted forward reach on the near side instead: a
// slightly longer boom at a slightly steeper pitch, and a much shorter lead so
// the player sits nearer the middle of his own screen. Re-measured: 8.1 m near
// (a dash plus a third), 34.6 m forward (still the full depth of the largest
// room). The ARENA rig in game.js is untouched — open ranks have no walls to
// hide behind and the owner just signed off on that framing.
//
// DUNGEON_SPEC sanctions this ("the mode owns the constant — tune, don't
// fork") and the wall-occlusion rule it derives still holds with room to
// spare: a wall h tall occludes the player within ~(d/h)*h on the camera side,
// which the 45-degree arena boom made 1.0-1.1*h. At 13.2/15.7 that shrinks to
// 0.84*h, so the south-low heighting is MORE than sufficient, not less. The
// boom probe below is unchanged and still the backstop for dragged orbits.
const INTERIOR_CAM = { y: 15.7, z: 13.2 };
const INTERIOR_LEAD = 1.4;
const INTRO_LOOK_FROM = 9;     // opening frame stares down the tunnel at the torchlight
const INTRO_LOOK_TO = INTERIOR_LEAD;   // the follow rig's forward lead
// DERIVED, not typed: the END pose has to BE the follow rig's steady state
// (camPos = camLook + boom, camLook = player - lead) or the handoff snaps. It
// was a hardcoded 0,11,7.6 left over from the 0,11,11 boom two zoom passes ago,
// which is exactly the drift this now cannot have. Since the identity rows
// landed the live values are INSTANCE state (this._cam / this._camTo, derived
// per rank in enter() with this exact formula); INTERIOR_CAM stays the shared
// default a null identity row falls back to.
// Boss reveal (spec bossChamberAndExit beat 1): a 1.2 s camera hold on the
// rising boss, reusing the intro lerp machinery instead of a bespoke cutscene.
const BOSS_HOLD = 1.2;

// Module-level scratch; an inline vector here would allocate per frame.
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();

export class DungeonMode extends GameMode {
  constructor(game) {
    super(game);
    this.gateIndex = 0;
    this.rank = 'E';
    // The crawl world. A mode instance lives exactly one run (_setMode builds
    // a fresh mode per enter), so this is created on interior ranks and torn
    // fully down in exit() — its build/clear cycle is leak-audited by
    // dungeon-test.
    this.dungeon = null;
    // The room-state director (STEP 5). Only encounter-driven worlds get one;
    // the arena's wave timer needs no chaperone.
    this.director = null;
    // Walk-in intro state (STEP 6). Truthy = intro running: { t }. The whole
    // combat frame (_updateDungeonFrame + director) is gated on it, which IS
    // the input suppression — _updatePlayer never samples the stick or the
    // skill buffer while the intro owns the body.
    this.intro = null;
    this._introSkip = false;
    this._skipHandler = null;
    // Boss-reveal camera hold (STEP 6 wiring of the STEP 5 deferral).
    this._bossSeen = false;
    this._bossHold = 0;
    // The height-environment closure for kinds whose layout carries a height
    // function (the B tower). Built ONCE (physics.js: creating environment
    // callbacks inline per frame allocates), reads the dungeon dynamically so
    // a context-loss rebuild needs no rebind.
    this._height = (x, z) => (this.dungeon ? this.dungeon.heightAt(x, z) : 0);
    // PER-RANK IDENTITY (Wave E task E-S item 2): the RANK_IDENTITY row this
    // run applies — camera boom, fog density, glow strength/grade, intro card
    // key. Camera state is instance-level so a rank override never leaks into
    // the next run; the shipped defaults live in INTERIOR_CAM.
    this._identity = null;
    this._cam = { y: INTERIOR_CAM.y, z: INTERIOR_CAM.z };
    this._camTo = { x: 0, y: INTERIOR_CAM.y, z: INTERIOR_CAM.z - INTERIOR_LEAD };
    this._prevGlowStrength = null;
    this._prevCamOffset = null;
  }

  get name() { return 'dungeon'; }

  get targetFps() { return 60; }

  /** The biome hazard for this gate. Nothing rolls one yet — biomes.js is a later step. */
  get hazard() { return null; }

  enter({ gateIndex = 0, rank = null, forceBiome = null, forceOpen = false } = {}) {
    const g = this.game;
    this.gateIndex = gateIndex;
    const baseGate = GATES[gateIndex] || GATES[0];
    this.rank = rank || baseGate.rank;

    // A gate is the one place that wants every frame the panel can give.
    g.frameClock?.setTarget(60);
    g.quality?.setTargetFps(60);

    // PER-RANK IDENTITY ROWS (Wave E task E-S item 2): fog density, palette
    // grade, camera boom, glow strength, intro card key — one table
    // (layouts/identity.js), applied here, restored in exit(). Absent fields
    // keep the shipped behaviour bit for bit.
    const identity = RANK_IDENTITY[baseGate.rank] || null;
    this._identity = identity;
    this._cam = identity?.cam
      ? { y: identity.cam.y, z: identity.cam.z }
      : { y: INTERIOR_CAM.y, z: INTERIOR_CAM.z };
    this._camTo = { x: 0, y: this._cam.y, z: this._cam.z - INTERIOR_LEAD };
    // Region grade: the rank's row replaces the city's (Wave B6 uniforms; a
    // null row restores the shipped look — the old unconditional setGrade(null)).
    g.glow?.setGrade(identity?.grade ?? null);
    // Glow strength set-piece value; previous strength restored on exit.
    this._prevGlowStrength = g.glow?.strength ?? null;
    if (identity?.glowStrength != null) g.glow?.setStrength(identity.glowStrength);

    // Biome roll. forceBiome (dev/payload) wins outright; otherwise B+ ranks
    // may roll an anomaly — the gate opens into another gate's palette AND
    // (Wave E task E-S item 3) may re-roll its layout KIND off the same
    // stream: an anomalous B can generate as a cavern or a waste. The shallow
    // copy travels through _beginGate into this.gate, which is what the
    // context-loss rebuild reads, so a lost GL context restores the SAME
    // anomaly (biome and kind both) instead of re-rolling it.
    const anomaly = forceBiome ? { biome: forceBiome, kind: null } : this._rollAnomaly(baseGate);
    const gateOverride = anomaly && (anomaly.biome !== baseGate.biome || anomaly.kind)
      ? {
        ...baseGate,
        biome: anomaly.biome || baseGate.biome,
        ...(anomaly.kind ? { anomalyKind: anomaly.kind } : {}),
      }
      : null;

    // World selection — assign BEFORE _beginGate, which builds this.world.
    if (INTERIOR_RANKS.has(baseGate.rank) && !forceOpen) {
      if (!this.dungeon) this.dungeon = new Dungeon(g.scene, g.renderer, g.camera);
      g.world = this.dungeon;
    } else {
      g.world = g._arenaWorld;
    }

    // Both worlds are flat-floored and both collide through world.resolve —
    // the same environment the body was constructed with. _beginGate builds
    // the world (and therefore packs the obstacle field), so bind the field
    // AFTER it: setEnvironment always assigns the 4th arg, so binding first
    // would be overwritten and binding a not-yet-built field would bind an
    // empty one.
    g.player.body.setEnvironment(FLAT_GROUND, g._arenaResolve);

    // THE camOffset override seam (identity rows): the OPEN/arena rig reads
    // game.js's shared camOffset vector, and a rank row may override it — the
    // mode sets the vector, game.js's read is untouched, exit() restores.
    // Every row ships null today (the arena framing is owner-approved), but
    // the seam is live for the forceOpen path.
    if (g.world === g._arenaWorld && identity?.camOffset) {
      this._prevCamOffset = g.camOffset.clone();
      g.camOffset.set(identity.camOffset.x, identity.camOffset.y, identity.camOffset.z);
    }

    g._beginGate(gateIndex, gateOverride);

    // Fog density (identity rows): a mood multiplier over the geometry-sized
    // fog planes the layout carries — applied after build() wrote scene.fog,
    // interiors only (the arena's fog is world.js's own business).
    if (g.world === this.dungeon && g.scene.fog && identity?.fogScale
      && identity.fogScale !== 1) {
      g.scene.fog.near /= identity.fogScale;
      g.scene.fog.far /= identity.fogScale;
    }

    // The Wave E heightAt seam: a layout that carries its own height function
    // (the B tower's terraces + stair treads) rebinds the body's ground to it
    // — necessarily AFTER _beginGate, because the layout only exists once
    // build() ran, and BEFORE setObstacles, because setEnvironment always
    // assigns the obstacles slot (see the FLAT_GROUND comment above). Flat
    // kinds keep FLAT_GROUND and its identity fast path in physics.js.
    if (g.world === this.dungeon && this.dungeon?.layout?.heightAt) {
      // ownsY: the CharacterBody's groundHeight IS this layout's heightAt, so
      // Dungeon.resolve must never height-settle this body — on the first
      // frame off a parapet lip the body is still grounded (vel.y 0) and the
      // settle teleported it 0.55 m down BEFORE gravity engaged, which both
      // distorted every fall's entry speed (the review measured the damage
      // table drifting from its stated tuning) and stole the drop's apex.
      // Enemies/shadows keep the settle: their flat integrator has no ground
      // binding, and the settle is exactly how they ride treads and falls.
      if (!this._ownResolve) {
        this._ownResolve = (pos, radius, vel) => this.dungeon?.resolve(pos, radius, vel, true);
      }
      g.player.body.setEnvironment(this._height, this._ownResolve);
    }

    // Substepped anti-tunnelling + wall-slide against this world's solids —
    // arena pillars and scatter rocks, or the crawl's wall runs and membranes.
    g.player.body.setObstacles(g.world.obstacleField);

    // DUNGEON_SPEC EDIT 7 counterpart: _beginGate suppresses the HUD and the
    // rank toast for encounter-driven worlds so the mode owns the entry
    // presentation — STEP 6 fires both at intro end (_endIntro), where they
    // land as the reveal instead of a menu transition.
    if (g.world.encounterDriven) {
      // The director binds AFTER _beginGate: it reads the built layout and
      // seals the boss chamber's membranes, which only exist post-build. It
      // reads g.gate (the anomaly-resolved copy) and g.seed so its pack rolls
      // survive a context-loss rebuild identically. It stays idle through the
      // intro (update() gates on this.intro), so nothing can trigger while
      // the player has no control.
      this.director = new EncounterDirector({
        game: g, dungeon: this.dungeon, gate: g.gate, seed: g.seed,
      });
      this._startIntro();
    }
  }

  // ------------------------------------------------------------ entry intro

  _startIntro() {
    const g = this.game;
    this.intro = { t: 0 };
    this._introSkip = false;
    // Actively hide the HUD: _beginGate merely SKIPS showHud for us (EDIT 7),
    // but the city mode walks in with its own HUD still up. Suppressing it
    // for the walk-in is most of what makes this an entrance (spec hudTiming).
    g.ui.showHud(false);
    // A yaw carried out of the city would break the authored shot; the tunnel
    // intro is the one place the camera state is ours to reset.
    g.input.resetLook?.();
    // _updatePlayer is not running, so its invuln-blink visibility toggle
    // cannot restore a mesh the previous mode happened to leave hidden.
    g.player.mesh.visible = true;
    // Drop _beginGate's 1.2 s spawn protection: it exists for arena spawn
    // overlap, but a crawl's entry tunnel is safe by construction (rooms are
    // dormant until the player's footfall) and its blink would strobe the
    // hero through the one directed shot in the game.
    g.player.invuln = 0;
    // Snap the rig to the opening frame — lerping in from wherever the city
    // camera sat would show the transit, not the arrival.
    const p = g.player.pos;
    g.camLook.set(p.x, 0, p.z - INTRO_LOOK_FROM);
    g.camPos.set(p.x + INTRO_CAM_FROM.x, INTRO_CAM_FROM.y, p.z + INTRO_CAM_FROM.z);
    g.camera.position.copy(g.camPos);
    g.camera.lookAt(g.camLook.x, g.camLook.y + 1.2, g.camLook.z);
    // Tap (or any key) skips. Capture phase so the stick/orbit handlers on the
    // canvas cannot swallow the press first; the flag is consumed on the next
    // mode update, keeping the skip on the frame clock like everything else.
    this._skipHandler = () => { this._introSkip = true; };
    window.addEventListener('pointerdown', this._skipHandler, { capture: true });
    window.addEventListener('keydown', this._skipHandler, { capture: true });
  }

  _updateIntro(dt) {
    const g = this.game;
    const p = g.player;
    this.intro.t += dt;
    // Auto-walk straight down the tunnel (-Z; the layout translates the entry
    // to face it) at 0.7x speed through the same body pipeline as real play —
    // collision, substepping and ground contact all behave.
    p.body.maxSpeed = g.derived.speed;
    p.body.move(0, -1, INTRO_WALK_THROTTLE);
    p.body.step(dt);
    // Face the walk: the game's yaw convention is atan2(x, z), so -Z (down
    // the tunnel, away from the camera) is PI — yaw 0 would moonwalk the
    // whole entrance staring into the lens.
    p.yaw = Math.PI;
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = Math.PI;
    animateRig(p.mesh, { moving: true, speed: p.body.groundSpeed, t: g.time, dt });
    if (this.intro.t >= INTRO_DURATION || this._introSkip) this._endIntro();
  }

  _endIntro() {
    const g = this.game;
    this.intro = null;
    this._removeSkipListeners();
    // EDIT 7's deferred presentation: HUD + rank toast land as the reveal, at
    // the tunnel mouth. Suppressing them during the walk-in is most of what
    // makes this read as an entrance (spec entryExperience.hudTiming).
    g.ui.showHud(true);
    g.ui.toast(`${g.gate.rank}-GRADE RIFT — ${g.gate.name}`, 'gold');
    // The rank's intro card line (identity rows; Wave G's card surface will
    // consume the same key). t() is total — a missing key comes back
    // bracketed, which we treat as "no line" rather than toasting a bug.
    const key = this._identity?.introKey;
    if (key) {
      const line = t(key);
      if (line && line[0] !== '[') g.ui.toast(line, '');
    }
  }

  _removeSkipListeners() {
    if (!this._skipHandler) return;
    window.removeEventListener('pointerdown', this._skipHandler, { capture: true });
    window.removeEventListener('keydown', this._skipHandler, { capture: true });
    this._skipHandler = null;
  }

  /**
   * B+ gates sometimes open somewhere they shouldn't (config ANOMALY_CHANCE).
   * Returns the off-canon biome id, or null for the gate's own. The roll runs
   * on a forked mulberry32 stream seeded from per-run entropy — exactly the
   * standing _beginGate seed does — and NEVER feeds layout generation: the
   * result is baked into the gate copy, and rebuilds read the copy.
   */
  _rollAnomaly(gate) {
    const chance = ANOMALY_CHANCE[gate.rank] || 0;
    if (chance <= 0) return null;
    const rnd = mulberry32((Math.random() * 0xffffffff) >>> 0);
    if (rnd() >= chance) return null;
    const others = GATES.map((x) => x.biome).filter((b) => b !== gate.biome);
    const biome = others[Math.floor(rnd() * others.length)] || null;
    // Wave E task E-S item 3: the anomaly ALSO re-rolls the layout kind, off
    // the same stream (one more draw — the biome roll's count is unchanged
    // before it, so old behaviour up to this line is identical). Pool: every
    // interior kind except the rank's own and 'reach' — the S set-piece is
    // singular; an anomaly may STEAL from the reach's rank (an anomalous S
    // opens as any other kind) but never counterfeit its summit.
    const own = LAYOUT_PARAMS[gate.rank]?.kind;
    const kinds = ['crawl', 'cavern', 'tower', 'waste'].filter((k) => k !== own);
    const kind = kinds[Math.floor(rnd() * kinds.length)] || null;
    return { biome, kind };
  }

  exit() {
    const g = this.game;
    // Quitting mid-intro (pause menu, context teardown) must not leave the
    // skip listeners orphaned on window.
    this.intro = null;
    this._removeSkipListeners();
    this.director?.dispose();
    this.director = null;
    g.clearEntities();
    g.world.clear();
    // Dungeon.clear() empties its group but the ctor parented that group to
    // the scene; the mode dies with its run, so the husk goes too or every
    // gate leaves an orphan Group behind.
    if (this.dungeon) g.scene.remove(this.dungeon.group);
    // Hand this.world back to the arena alias so everything that runs outside
    // a mounted gate (quit(), the title screen, the next open-rank run) talks
    // to the World it was built against rather than a cleared Dungeon.
    g.world = g._arenaWorld;
    // And the body's ground with it: a tower run bound this._height, and a
    // dead Dungeon reference returning stale heights under the title screen
    // is exactly the kind of leak the alias handoff above exists to prevent.
    g.player.body.setEnvironment(FLAT_GROUND, g._arenaResolve);
    g.player.body.setObstacles(g.world.obstacleField);
    // Identity rows: hand back the shipped presentation — grade cleared,
    // glow strength restored to whatever the run started with, and the
    // arena camOffset returned if a row overrode it.
    g.glow?.setGrade(null);
    if (this._prevGlowStrength != null) {
      g.glow?.setStrength(this._prevGlowStrength);
      this._prevGlowStrength = null;
    }
    if (this._prevCamOffset) {
      g.camOffset.copy(this._prevCamOffset);
      this._prevCamOffset = null;
    }
    g.audio.music(false);
    g.ui.showHud(false);
    g.state = 'idle';
  }

  // Atmosphere keeps breathing behind a pause, exactly as it did when this
  // call sat unconditionally in Game.update: sky/shards for the arena, torch
  // flicker/membrane pulse/dust for the crawl.
  updateAlways(dt) {
    this.game.world.update(dt);
  }

  update(dt) {
    // Intro owns the frame outright: no player input sampling, no spawns, no
    // director, no HUD churn — the body auto-walks and the world breathes
    // (updateAlways already ran). This gate IS the input suppression.
    if (this.intro) { this._updateIntro(dt); return; }
    this.game._updateDungeonFrame(dt);
    // Fall damage (Wave E, the tower's parapet drops). The body solver already
    // did all the work — justLanded/landSpeed are set by the ground-contact
    // step _updateDungeonFrame just ran — so this is pure scoring, data-driven
    // off layout.params.fallDamage (only the tower carries one). minSpeed 13
    // clears every ordinary jump's landing (~11.5 m/s); the damage routes
    // through _damagePlayer so DR, death and the hurt flash all behave.
    {
      const g = this.game;
      const fd = g.world === this.dungeon
        ? this.dungeon?.layout?.params?.fallDamage : null;
      const body = g.player.body;
      if (fd && body.justLanded && body.landSpeed > fd.minSpeed) {
        const frac = Math.min(0.6, (body.landSpeed - fd.minSpeed) * fd.scale);
        g._damagePlayer(Math.max(1, Math.round(g.derived.maxHp * frac)), g.player.pos);
        g.fx.addShake(Math.min(0.4, 0.1 + frac * 0.5));
        g.audio.noise({ gain: 0.16, decay: 0.2, filter: 500 });
      }
    }
    // After the frame, not before: triggers and clears read entity state the
    // frame just settled (kills spliced, positions resolved).
    this.director?.update(dt);
    // Boss reveal: the first frame the boss exists, arm the 1.2 s camera hold
    // (consumed by _updateInteriorCamera). Once per run — a context loss must
    // not replay the reveal on rebind.
    const g = this.game;
    if (!this._bossSeen && g.bossActive && g.boss) {
      this._bossSeen = true;
      this._bossHold = BOSS_HOLD;
    }
  }

  /**
   * Game._restoreContext rebuilt this.world deterministically, which reset
   * every door membrane to open and dropped the exit portal. The director
   * re-stamps the seals its run state implies.
   */
  onContextRestored() {
    this.director?.rebindAfterContextLoss();
    // Re-apply the identity fog multiplier (review fix): _restoreContext's
    // world.build() rewrote scene.fog from the base LAYOUT_PARAMS values, so
    // without this a context loss mid-run visibly snapped D/C/A/S gates back
    // to unscaled fog. Same guard as enter()'s application.
    const g = this.game;
    const identity = this._identity;
    if (g.world === this.dungeon && g.scene.fog && identity?.fogScale
      && identity.fogScale !== 1) {
      g.scene.fog.near /= identity.fogScale;
      g.scene.fog.far /= identity.fogScale;
    }
  }

  updateCamera(dt) {
    const w = this.game.world;
    // The interior camera is the same follow rig plus a boom probe; the open
    // arena keeps the shipped camera bit for bit.
    if (w === this.dungeon && w?.layout) {
      if (this.intro) this._updateIntroCamera(dt);
      else this._updateInteriorCamera(dt);
    } else this.game._updateCamera(dt);
  }

  /**
   * The walk-in shot: low and close over the shoulder, staring down the
   * tunnel at the torchlight, easing up and back to the standard follow as
   * the player reaches the tunnel mouth. Writes the same camLook/camPos rig
   * state as the follow camera, and its END pose IS the follow rig's steady
   * state, so the handoff frame is continuous — nothing snaps.
   */
  _updateIntroCamera(dt) {
    const g = this.game;
    const p = g.player;
    const raw = Math.min(1, this.intro.t / INTRO_DURATION);
    const k = raw * raw * (3 - 2 * raw);   // smoothstep: gentle at both ends
    const lead = INTRO_LOOK_FROM + (INTRO_LOOK_TO - INTRO_LOOK_FROM) * k;
    _v.set(p.pos.x, 0, p.pos.z - lead);
    g.camLook.lerp(_v, Math.min(1, dt * 6));
    g.camPos.set(
      p.pos.x + INTRO_CAM_FROM.x + (this._camTo.x - INTRO_CAM_FROM.x) * k,
      INTRO_CAM_FROM.y + (this._camTo.y - INTRO_CAM_FROM.y) * k,
      p.pos.z + INTRO_CAM_FROM.z + (this._camTo.z - INTRO_CAM_FROM.z) * k,
    );
    g.camera.position.lerp(g.camPos, Math.min(1, dt * 7));
    g.camera.lookAt(g.camLook.x, g.camLook.y + 1.2, g.camLook.z);
    // No boom probe: the authored path runs straight down a 4 m corridor and
    // the shoulder shot deliberately rides above the low south walls; probing
    // here would fight the one shot in the game that is directed.
    g.world.updateShadowCamera(p.pos, 14);
  }

  // ---------------------------------------------------------------- camera
  //
  // Same follow math as Game._updateCamera (same camLook/camPos state, so
  // switching worlds mid-session never snaps the rig), with citymode's
  // outward boom probe marched against the layout's wall runs. The fixed
  // south-low wall heighting means the untouched orbit almost never probes
  // positive — this is the safety net for dragged orbits and tight corners.

  _updateInteriorCamera(dt) {
    const g = this.game;
    const p = g.player;
    const { yaw, pitch } = g.input.look;
    // Boss reveal hold (spec bossChamberAndExit beat 1): for 1.2 s after the
    // boss rises, the look target is the boss instead of the player — the
    // intro lerp machinery re-aimed, not a bespoke cutscene. Player control
    // stays live; only the camera acknowledges the arrival. The boom probe
    // below still runs, so the swung shot cannot clip a wall.
    if (this._bossHold > 0 && g.boss) {
      this._bossHold -= dt;
      // boss.pos.y: the tower's boss rises on the top floor — the hold has to
      // look AT it, not at ground level nine metres below (flat kinds: 0).
      _v.set(g.boss.pos.x, g.boss.pos.y, g.boss.pos.z);
      g.camLook.lerp(_v, Math.min(1, dt * 4));
      g.camPos.set(g.camLook.x, g.camLook.y + this._cam.y, g.camLook.z + this._cam.z);
    } else {
      // Lead the camera slightly toward movement so you can see what you're running into.
      _v.copy(p.pos).addScaledVector(p.vel, 0.22);
      if (yaw === 0 && pitch === 0) {
        _v.z -= INTERIOR_LEAD;
        g.camLook.lerp(_v, Math.min(1, dt * 6));
        g.camPos.set(g.camLook.x, g.camLook.y + this._cam.y, g.camLook.z + this._cam.z);
      } else {
        _v.x -= Math.sin(yaw) * INTERIOR_LEAD;
        _v.z -= Math.cos(yaw) * INTERIOR_LEAD;
        g.camLook.lerp(_v, Math.min(1, dt * 6));
        const boom = Math.hypot(this._cam.y, this._cam.z);
        const pa = Math.atan2(this._cam.y, this._cam.z) + pitch;
        g.camPos.set(
          g.camLook.x + Math.sin(yaw) * boom * Math.cos(pa),
          g.camLook.y + boom * Math.sin(pa),
          g.camLook.z + Math.cos(yaw) * boom * Math.cos(pa),
        );
      }
    }

    const dist = this._clearBoomDistance(p.pos, g.camPos);
    if (dist > 0) {
      // Blocked: sit at the last unobstructed point along the boom.
      _dir.copy(g.camPos).sub(p.pos).normalize();
      g.camPos.copy(p.pos).addScaledVector(_dir, dist);
      // Keep the boom off the deck — the LOCAL deck: flat kinds' floors sit
      // at y=0 and this is the old constant; the tower's floors ride
      // heightAt, and the boom must not clip into a terrace it retreated over.
      const deck = (this.dungeon ? this.dungeon.heightAt(g.camPos.x, g.camPos.z) : 0) + 2.4;
      if (g.camPos.y < deck) g.camPos.y = deck;
    }

    g.camera.position.lerp(g.camPos, Math.min(1, dt * 7));
    g.camera.lookAt(g.camLook.x, g.camLook.y + 1.2, g.camLook.z);
    g.fx.applyShake(g.camera);
    // Fit the shadow frustum to the player — same ±14 the arena camera uses.
    g.world.updateShadowCamera(p.pos, 14);
  }

  /**
   * March the boom from the player's eye out to the desired camera position
   * and return the distance at which it first hits a wall run (or the floor).
   * Returns 0 when the whole boom is clear. Citymode's _clearCameraDistance,
   * retargeted at the crawl's solids.
   */
  _clearBoomDistance(from, want) {
    _probe.copy(want).sub(from);
    const full = _probe.length();
    if (full < 1e-3) return 0;
    // Walk OUTWARD and stop at the first hit, so a boom that clips one corner
    // near the player is not rescued by the far samples being clear.
    for (let i = 1; i <= CAM_PROBE_STEPS; i++) {
      const t = i / CAM_PROBE_STEPS;
      const x = from.x + _probe.x * t;
      const y = from.y + EYE + (_probe.y - EYE) * t;
      const z = from.z + _probe.z * t;
      if (this._boomBlocked(x, y, z)) {
        return Math.max(CAM_MIN, full * ((i - 1) / CAM_PROBE_STEPS));
      }
    }
    return 0;
  }

  // Blocked = inside a wall run BELOW its rendered height. Collision tops are
  // Infinity (bodies must never cross), but the camera only cares what it can
  // SEE over: south-facing runs render low precisely so the fixed camera
  // clears them, and testing the visual height here is what keeps the default
  // orbit from being throttled by walls that never occlude anything.
  _boomBlocked(x, y, z) {
    const layout = this.dungeon?.layout;
    if (!layout) return false;
    // The local floor (tower: heightAt; flat kinds: 0) is the ground plane
    // the old `y < 0.6` constant meant.
    const floorY = layout.heightAt ? layout.heightAt(x, z) : 0;
    if (y < floorY + 0.6) return true;
    const low = layout.params.wallHeightLow;
    const high = layout.params.wallHeight;
    for (const run of layout.wallRuns) {
      // Tower runs carry top = the highest floor they bound; their rendered
      // slab reaches top + wallHeight(/Low), which is exactly the occlusion
      // question this probe asks. Flat kinds carry no `top` and keep the old
      // arithmetic to the bit.
      if (y > (run.top || 0) + (run.face === 's' ? low : high)) continue;
      if (Math.abs(x - run.x) < run.w / 2 + WALL_PAD
        && Math.abs(z - run.z) < run.d / 2 + WALL_PAD) return true;
    }
    return false;
  }

  resolveFor(entity) {
    this.game.world.resolve(entity.pos, entity.radius, entity.vel);
  }
}

registerMode('dungeon', (game) => new DungeonMode(game));

export default DungeonMode;
