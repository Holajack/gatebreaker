import * as THREE from 'three';
import { World, mulberry32 } from './world.js';
import { Effects } from './effects.js';
import {
  makeHumanoid, makeHealthBar, setHealthBar, animateRig, makeGroundRing, disposeObject3D,
  setCharacterQuality, rebuildHumanoid,
} from './entities.js';
// The render-side cache of save.playerBody: the title screen's M/F flip must
// update it AND rebuild the hero, or the choice only applies next boot.
import { setPlayerBody as setPlayerBodyLook } from '../render/characters.js';
import { makeAgent, steerAgent, separate, noteAttack } from './enemyai.js';
import {
  GATES, ENEMY_TYPES, BOSSES, SKILLS, derive, scaleEnemy, rankOf, PROJECTILE_Y,
} from './config.js';
import {
  grantXp, shadowFieldCapacity, extractionChance,
  MAX_EXTRACT_ATTEMPTS, CORPSE_WINDOW,
} from './progression.js';
import { ashForXp, grantAsh } from './shop.js';
import { ensureEquipment } from '../core/save.js';
import {
  autoDeploy, deployedRecords, addShadow, makeShadow, releaseWeakest,
  shadowCombat, rosterSummary,
} from './shadows.js';
import {
  rollDrop, equipWeapon, currentWeapon, setModelSource,
  serializeWeapon, deserializeWeapon, starterWeapon, buildWeaponMesh, rarityColor,
  setStance, weaponStance, drawTime, STOW,
  // The swing state machine (RPG_SPEC step 1). game.js owns WHEN an attack is
  // asked for and what a hit does to the world; weapons.js owns every number
  // in between — timing, phase, movement, commitment, hit maths.
  makeAttackState, startAttack, tickAttack, canAttack, consumeBuffer,
  consumeLunge, cancelAttack, moveScale, isCommitted, attackAnim,
  hitDamage, hitRange, hitArc, hitKnockback, hitStagger, isRadial, chargeMul,
  npcStrikeWeapon, enemyWeaponKind,
  // The bow (RPG_SPEC step 8): BOW is the family's ballistic contract (draw
  // window, 22->46 m/s, g 9.0, soft-lock cone) and sharedItemGeometry is the
  // pool's one window into the item pack for the Arrow mesh.
  BOW, sharedItemGeometry,
  // The staff (RPG_SPEC step 9): STAFF is the mana-and-ballistics contract.
  // Its bolt shares the arrow's g = 9.0 and bends physics in EXACTLY the two
  // ways the spec names (damage type/effect, bounded trajectory curvature) —
  // see the table's own comment in weapons.js.
  STAFF,
} from './weapons.js';
// Pooled projectiles (RPG_SPEC step 8): 16 preallocated records and meshes,
// zero per-shot allocation, optional vy/g for arrow ballistics. The pool's
// flat path is byte-identical to the loop it replaced — fight-test asserts it.
import { ProjectilePool } from './projectiles.js';
// Armour layer (RPG_SPEC steps 10-11). rollArmorDrop feeds the gate loot
// path, serializeArmor writes the {k:'a'|'t',b,r,s,l} records, armorDerive is
// folded into refreshDerived (the single computation site), and combinedDR is
// the ONE stacking law _damagePlayer applies: multiplicative with vitality DR,
// hard-clamped at 0.72 total.
import { rollArmorDrop, serializeArmor, armorDerive, combinedDR } from './armor.js';
// The legendary craft (RPG_SPEC step 14). game.js owns WHEN materials are
// granted (boss/elite kills, seed-derived) and the equipped-weapon craft path;
// ascension.js owns the ledger, the recipe and the refusal reasons.
import {
  ensureMaterials, grantEmberdust, grantSigil, ascend,
  EMBERDUST_ELITE_CHANCE, EMBERDUST_MIN_RANK, SIGIL_LABEL,
} from './ascension.js';
// Straight from the render module, not via entities.js: Bind summons a NAMED
// creature off the roster, which is a call shape makeHumanoid cannot express.
import { makeCreature, creaturesReady, creatureFor } from '../render/creatures.js';
import { Glow, GLOW_LAYER } from '../render/glow.js';
import { WorldClock, bootBias } from '../render/daynight.js';
import { Quality } from '../core/quality.js';
import { attachBody, applyKnockback, FLAT_GROUND } from './physics.js';
import { createMode } from './modes/mode.js';
// Imported for their registerMode() side effect. createMode looks the factory
// up by name, so nothing else in this file needs to know either class exists.
import './modes/dungeonmode.js';
import './modes/citymode.js';

// How hard a corpse resists extraction. progression.extractionChance takes this
// as its tierWeight. Provisional home: difficulty.js owns enemy classification
// once step 11 lands, and this table moves there wholesale.
const TIER_WEIGHT = { brute: 'elite', lancer: 'elite', howler: 'elite' };

// How many spare items the save carries. Bounded because the whole profile
// lives in one localStorage string. 12 -> 40 with the armour tables (RPG_SPEC
// step 10): one D-rank dungeon can produce five armour pieces, so 12 filled in
// a single run; 40 records x 5 short fields is nothing in localStorage.
const STASH_LIMIT = 40;
// Chance a trash kill leaves a weapon behind. Bosses always drop one.
const WEAPON_DROP_CHANCE = 0.06;
// Chance a trash kill leaves ARMOUR behind. Gates are armour's ONLY source
// this wave — the Exchange does not sell it (RPG_SPEC openQuestions: a second
// vendor is a later wave). 0.10 sizes to the spec's own pacing claim: a D-rank
// run is 44-60 trash (mean 52), 52 x 0.10 ≈ 5 pieces per run.
const ARMOR_DROP_CHANCE = 0.10;
const tierWeightOf = (e) => (e.isBoss ? 'boss' : TIER_WEIGHT[e.key] || 'trash');

// The hand axe's bleed (RPG_SPEC weaponFamilies.axe): every connecting axe hit
// opens a 3 s damage-over-time that "does not stack past 3 applications".
// Each application bleeds 30% of ITS OWN hit's damage, spread over the 3 s —
// which is why AXE_COMBO's raw dmg shares sit below the sword's: a fourth
// swing refreshes the clock but adds no fourth stack, so sustained axe output
// converges on hits x 1.30 rather than climbing without bound.
const BLEED_TIME = 3;
const BLEED_MAX_STACKS = 3;
const BLEED_FRACTION = 0.30;

// Shadow-soldier attack timing — the same telegraph-to-contact shape enemies
// got in Wave 1. WINDUP is how long the soldier stands planted winding up
// before the blow lands (the contact frame _shadowStrike fires on), STRIKE is
// the follow-through the clip plays out afterwards. 0.42 matches the standard
// enemy chase telegraph, and windup + strike (0.72 s) fits inside the 0.85 s
// attack cycle in _updateShadows — that cycle and s.atk are the DPS knobs and
// are deliberately untouched: these constants only move WHEN inside the cycle
// the damage lands, not how much of it there is.
const SHADOW_WINDUP = 0.42;
const SHADOW_STRIKE = 0.3;

// ------------------------------------------------------------- entity LOD
//
// Rooms grew ~5.5x in area this wave and the live wave more than doubled with
// them, so there are now several bodies on screen that are nowhere near the
// player. A skinned body is not one cost but three: it is drawn into the main
// pass, again into the key light's depth map, and its telegraph mote is drawn
// again into the glow pass. Measured with tools/density-probe.mjs on the E
// crawl, a body's contribution to renderer.info.render.triangles is ~2.7x its
// own geometry, and switching the depth pass off for entity bodies alone
// accounts for about 1x of that — the single biggest lever available without
// touching how anything looks up close.
//
// 14 m because the interior camera sits 15.7 m up and 13.2 m back looking at
// the player, and interior fog starts at 13 m: a contact shadow that far out is
// a smudge inside fog, under a body about 40 px tall. The known cost of this is
// that a SKINNED depth-material program compiles the first time a body crosses
// INTO range rather than on the first shadow render of the gate — one compile
// per material permutation per session, and the alternative is paying a whole
// extra pass on every distant body for the entire run.
const LOD_CAST_RANGE_SQ = 14 * 14;
// The CPU half of the same problem: three uploads a bone texture per skeleton
// per mixer tick, a per-instance per-FRAME cost that no resolution drop
// touches. Past 22 m — beyond the far side of an E room — the rig ticks at
// 20 Hz on accumulated dt instead of every frame. It still animates; it just
// stops paying 60 Hz for a walk cycle nobody can read at that distance.
const LOD_RIG_RANGE_SQ = 22 * 22;
const LOD_RIG_INTERVAL = 1 / 20;

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

// TWO SCRATCH VECTORS THAT ARE *NOT* GENERAL PURPOSE, and the reason is a bug
// that shipped: tmpV was used both as the enemy loop's aim vector and inside the
// helpers that loop calls. `const toPlayer = tmpV.copy(...)` in _updateEnemies is
// a live ALIAS of tmpV, so the first _spawnProjectile / _damagePlayer call made
// from inside that iteration overwrote the bearing the rest of the iteration was
// still reading. The boss spread shot computed bolt i+1's angle off bolt i's
// heading instead of off the player bearing, turning a symmetric fan into a
// running sum: measured offsets from the true aim were
// [-0.60,-0.96,-1.08,-0.96,-0.60,0.00] rad for n=6 and up to -2.40 rad (137
// degrees) for n=9 — 5 of 6 (8 of 9) bolts flew into walls and exactly one
// landed. The same alias also fed e.yaw on any frame the boss's slam dealt
// damage. Giving the two roles their own vectors makes the aliasing
// unrepresentable rather than fixed once; nothing else may touch either.
const _aimDir = new THREE.Vector3();    // _updateEnemies' per-enemy bearing only
const _projDir = new THREE.Vector3();   // _spawnProjectile's heading only
// Bow-only scratch, same single-role rule as the pair above. The pool COPIES
// spawn arguments, so handing it these is safe; handing it tmpV would put the
// enemy loop's aim vector back inside projectile code, which is the exact
// aliasing the boss spread shot shipped with.
const _projFrom = new THREE.Vector3();  // _spawnProjectile's launch point only
const _bowDir = new THREE.Vector3();    // bow aim heading only
const _bowFrom = new THREE.Vector3();   // arrow launch point only
const _bowTo = new THREE.Vector3();     // soft-lock candidate bearing only
// Staff-only scratch, same single-role rule. The bolt homing pass and the
// beam tick both run inside update loops, so they get their own vectors
// rather than borrowing the bow's (which _camForward may be refreshing the
// same frame a bolt steers).
const _staffDir = new THREE.Vector3();  // staff aim / beam axis only
const _staffFrom = new THREE.Vector3(); // bolt launch point only
const _staffTo = new THREE.Vector3();   // homing bearing / beam-tick offsets only

// Reused steering context; steerAgent never retains it.
const _steerCtx = {
  navGrid: null, targetPos: null, selfPos: null,
  distance: 0, losBlocked: false, aggression: 1, dt: 0,
};

export class Game {
  constructor({ canvas, input, audio, ui, saveData, onSave, appState = null, frameClock = null }) {
    this.canvas = canvas;
    this.input = input;
    this.audio = audio;
    this.ui = ui;
    this.save = saveData;
    // The world clock is the ONE source of time of day. It lives here rather
    // than on citymode so a gate run keeps advancing it: walking out of a
    // cleared dungeon into a sunset you did not see arrive is the whole point,
    // and it costs a single float. Gate modes tick it and apply nothing —
    // a rift has no sun.
    //
    // bootBias turns a cold start in the small hours into a sunrise. A player
    // who quit at midnight should not be handed a black screen for their
    // trouble; a session resumed at any other hour resumes exactly there.
    this.worldClock = new WorldClock({ hours: bootBias(saveData?.worldTime ?? 15) });
    // Wrapped rather than chased through seven onSave() call sites: the clock
    // has to reach the save on the EXISTING cadence, and adding an eighth
    // place that must remember to write it is how that field goes stale.
    this.onSave = () => {
      this.save.worldTime = this.worldClock.hours;
      onSave();
    };
    // The screen router and the frame pacer. Both are optional so the headless
    // tools that construct a bare Game still work.
    this.appState = appState;
    this.frameClock = frameClock;
    this._mode = null;
    this._frameDt = 0;
    // The rank of the last gate entered, so returning to the city puts the
    // player back beside the portal they walked into rather than at the spawn.
    this.lastGateRank = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Rendering direct to the default framebuffer means MSAA resolves in tile
      // memory on mobile GPUs, which is nearly free — so take it.
      antialias: true,
      alpha: false,      // opaque canvas -> WebView's fast composite path
      stencil: false,    // unused; saves a buffer and its per-tile traffic
      depth: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // With image-based lighting online, 1.45 clipped. The env map now supplies
    // the indirect light this was compensating for.
    this.renderer.toneMappingExposure = 1.25;

    this.scene = new THREE.Scene();
    // near 1.0, not 0.1: the camera sits ~15.6 units out and nothing is ever
    // inside the first metre, so a 4000:1 far/near ratio spent most of the
    // depth buffer's precision on empty space and z-fought the arena props.
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 1.0, 400);
    // 13,13 rather than the long-shipped 11,11: the owner asked to pull back a
    // little, and the city moved 8,8 -> 10,10 in the same pass. dungeonmode
    // reads this same vector, so crawls and arenas stay in step.
    this.camOffset = new THREE.Vector3(0, 13, 13);
    this.camLook = new THREE.Vector3();
    this.camPos = new THREE.Vector3();

    this.world = new World(this.scene, this.renderer, this.camera);
    // The arena survives world swaps: DungeonMode mounts a Dungeon over
    // this.world for crawl ranks (E/D) and restores this alias for open ranks
    // and on exit. Everything else in this file keeps talking to this.world
    // and never learns which class is mounted (DUNGEON_SPEC worldContract).
    this._arenaWorld = this.world;
    this.fx = new Effects(this.scene, this.camera, this.renderer);
    // 0.85/0.9 is what glow.js actually applies — the main scene goes through
    // ACES tone mapping at exposure 1.25 while the bloom pass is composited on
    // top in gamma space with no rolloff, so the old 1.35/1.1 was arithmetically
    // guaranteed to outshine the characters. Say the real numbers here rather
    // than asking for numbers that get silently clamped.
    this.glow = new Glow(this.renderer, { scale: 0.25, strength: 0.85, spread: 0.9 });
    this.quality = new Quality({ onChange: (t) => this._applyQuality(t) });
    this._applyQuality(this.quality.current);

    // A backgrounded WebView can lose the GL context outright. Without
    // preventDefault it never restores at all.
    this._lostContext = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._lostContext = true;
      this.pause(true);
    });
    // ...and without this half, restoring leaves a dead canvas: three re-inits
    // its own GL state but every buffer and render target the game uploaded is
    // gone. Android WebViews drop the context on backgrounding routinely, so
    // the old one-sided handler meant a phone call froze the game permanently.
    canvas.addEventListener('webglcontextrestored', () => {
      this._restoreContext();
    });

    this.enemies = [];
    this.shadows = [];
    // The projectile pool (RPG_SPEC step 8). `this.projectiles` stays as an
    // ALIAS of the pool's live array — same identity for the life of the Game
    // — so every shipped reader (Nova's wipe, the fight suite's per-bolt
    // probes, _removeProjectile's index loops) keeps working unchanged.
    this.pool = new ProjectilePool(this.scene, {
      max: 16,
      glowLayer: GLOW_LAYER,
      // Lazy: the item pack loads after the Game exists; the first arrow asks.
      arrowGeometry: () => sharedItemGeometry('Arrow'),
      // The shipped removal burst, for bolts only: arrows STICK (no pop), and
      // a gate-transition clear was never a firework.
      onRemove: (rec, reason) => {
        if (rec.kind === 'bolt' && reason !== 'clear') {
          this.fx.burst(rec.pos, 10, rec.color, { speed: 5, up: 2, life: 0.35 });
        }
        // Staff bolts ride the pool's ARROW branch (it owns the enemy torso
        // test and the vy/g arc) but a magic bolt BURSTS where an arrow
        // sticks — the one place every release path funnels through, so the
        // impact cannot be missed by a reclaim cycle or a world cull.
        if (rec.staff && reason !== 'clear') this._staffImpact(rec.pos);
      },
    });
    // The staff bolt's shared look: one glow-tinted orb, swapped onto a
    // pooled arrow record's mesh after spawn (spawn() re-stamps geometry and
    // material per kind, so a later real arrow reclaims the mesh cleanly).
    // Created ONCE — the pool ledger's zero-alloc assert stays honest because
    // these never enter it. shared-flagged so no dispose walk can free them
    // out from under a live bolt.
    this._staffOrbGeo = new THREE.IcosahedronGeometry(0.20, 0);
    this._staffOrbGeo.userData.shared = true;
    this._staffOrbMat = new THREE.MeshBasicMaterial({ color: 0xb98bff });
    this._staffOrbMat.userData.shared = true;
    // The channelled-beam state (RPG_SPEC staff finisher). Null when idle;
    // see _beginStaffBeam / _updateStaffBeam.
    this._staffBeam = null;
    this.projectiles = this.pool.live;
    // Per-frame context for pool.update — built once, fields refreshed in
    // _updateProjectiles, because update loops are a no-allocation zone.
    this._projCtx = {
      obstacleField: null,
      worldRadius: 0,
      playerPos: null,
      enemies: null,
      onHitPlayer: (rec) => this._damagePlayer(rec.damage, rec.pos),
      onHitEnemy: (rec, e) => {
        this._damageEnemy(e, rec.damage, {
          knockback: rec.knock, stagger: rec.stagger, from: this.player.pos,
        });
        // GALESTING ASCENDANT (resource-flow verb): a FULL-DRAW arrow that
        // kills its target banks a refund — the next draw starts full. Gated
        // on the rule at impact time so swapping bows mid-flight pays nothing.
        if (rec.kind === 'arrow' && rec.fullDraw && e.hp <= 0
          && this.weapon?.rule?.fx.drawRefundOnKill && this._bowState) {
          this._bowState.refund = true;
        }
      },
    };
    this.corpses = [];
    this.pickups = [];

    this.state = 'idle'; // idle | playing | paused | over
    this.time = 0;

    this.flash = document.createElement('div');
    this.flash.id = 'flash';
    document.body.appendChild(this.flash);

    this._buildPlayer();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    // Pull the camera back a little on tall phone screens so more arena is visible.
    const tall = h / w > 1.7;
    this.camera.fov = tall ? 64 : 58;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const dpr = Math.min(window.devicePixelRatio, this.quality?.current.pixelRatio ?? 2);
    this.renderer.setPixelRatio(dpr);
    this.glow?.setSize(w, h, dpr);
  }

  _applyQuality(t) {
    // The skinned-character budget has to follow the RUNTIME tier, not the tier
    // guessed once at import. A device that gets stepped down mid-run otherwise
    // keeps skinning more characters than it can afford.
    setCharacterQuality(t);
    const dpr = Math.min(window.devicePixelRatio, t.pixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.glow.setSize(window.innerWidth, window.innerHeight, dpr);
    this.glow.enabled = t.bloom;
    this.renderer.shadowMap.enabled = t.shadows;
    const key = this.world?.key;
    if (key) {
      key.castShadow = t.shadows;
      if (t.shadows && key.shadow.mapSize.x !== t.shadowMapSize) {
        key.shadow.mapSize.set(t.shadowMapSize, t.shadowMapSize);
        // three only reallocates the depth map when it is null, so changing
        // mapSize alone silently does nothing.
        key.shadow.map?.dispose();
        key.shadow.map = null;
        key.shadow.normalBias = (14 * 2 / t.shadowMapSize) * 1.4;
      }
    }
    this.fx?.setBudget(Math.round(420 * t.particleScale));
    // THE FENCE THAT WAS NOT CONNECTED. Every lever above is a per-frame or
    // per-material setting; the tier's instanceScale was read once at build and
    // never again, so a device this governor had just judged to be struggling
    // kept the scatter density of the tier it was struggling AT until the player
    // next re-entered the city from a gate. City.setInstanceDensity truncates
    // each sheddable field's drawn instance range in place — no rebuild, no
    // reallocation, no shader recompile — and switches the matching colliders
    // off with them. Optional-chained through the mode because only the city
    // mode owns a City; gate modes have no scatter to thin.
    this._mode?.city?.setInstanceDensity?.(t.instanceScale);
  }

  _restoreContext() {
    // Re-push everything that lives outside three's own state tracking, then
    // rebuild the arena — its geometry was uploaded to a context that no longer
    // exists. The seed is kept, so the player lands in the same rift they left.
    this.renderer.shadowMap.needsUpdate = true;
    this._applyQuality(this.quality.current);
    this.resize();
    // Rebuild whatever level is mounted. Its geometry was uploaded to a
    // context that no longer exists, so re-entering the mode is the only
    // honest repair — and for the city it is also the cheapest.
    if (this._mode?.name === 'city') {
      this._mode.enter({ spawnAt: this.player.pos.clone() });
    } else if (this.gate) {
      this.world.build(this.gate, this.seed);
      // The rebuild is deterministic but stateless: door membranes come back
      // OPEN and the exit portal is gone. The mounted mode re-stamps whatever
      // its run state implies (no-op for the arena — the hook is optional).
      this._mode?.onContextRestored?.();
    }
    // Only auto-resume the pause WE forced. A player who paused deliberately
    // and then took a phone call should still come back to the pause screen.
    if (this._lostContext) {
      this._lostContext = false;
      this.pause(false);
    }
  }

  // ---------------------------------------------------------------- player
  _buildPlayer() {
    // `weapon: 'none'` on purpose: the hardcoded blade makeHumanoid used to
    // build is now supplied by weapons.js, which is what lets the player hold
    // a rolled drop (and, once the item pack has loaded, a real model).
    const mesh = makeHumanoid({
      color: 0x8fa2ff, glow: 0xffc24b, accent: 0x161c3c,
      weapon: 'none', cloak: true, scale: 1,
    });
    this.playerRing = makeGroundRing(0xffc24b, 1.0, 0.8);
    mesh.add(this.playerRing);
    this.scene.add(mesh);

    this.player = {
      mesh,
      pos: new THREE.Vector3(0, 0, 0),
      vel: new THREE.Vector3(),
      yaw: 0,
      radius: 0.6,
      hp: 100, mp: 50,
      // The swing state machine replaces the old p.swing / p.comboIndex /
      // p.comboTimer / p.swingHitApplied quartet — weapons.js owns the timing
      // and game.js only asks it questions. skillSwing is the one survivor: a
      // purely visual arm-swing timer for skills (Ruin) that apply their own
      // damage and never touch the weapon machine.
      attack: makeAttackState(),
      skillSwing: 0,
      dashTimer: 0, invuln: 0, hurt: 0,
      // Time left in which an incoming (i-framed) hit counts as a PERFECT
      // dodge; set by _tryDash from derived.dodgeWindow.
      _dodgeT: 0,
      cds: { attack: 0, dash: 0, slash: 0, nova: 0, summon: 0 },
      alive: true,
      kills: 0,
    };
    this.refreshDerived(true);

    // Bound once: physics calls this every frame and an inline arrow here would
    // allocate a closure per entity per frame.
    this._arenaResolve = (pos, radius, vel) => this.world.resolve(pos, radius, vel);
    // Same rule for the swing callbacks: tickAttack is handed one every frame.
    this._onSwingHit = (step) => this._applySwingHit(step);
    this._onNpcHit = (step, hitIndex, e) => this._enemyStrike(e);
    attachBody(this.player, { radius: 0.6, maxSpeed: this.derived.speed });
    this.player.body.setEnvironment(FLAT_GROUND, this._arenaResolve);

    this._restoreLoadout();
  }

  /**
   * The title screen's M/F flip. The hero was built (and pack-upgraded) back in
   * the constructor, and characters.js caches the body choice on first read, so
   * writing save.playerBody alone would only apply on the NEXT boot. This
   * updates the cache and swaps the body in place; the equipped weapon and hero
   * light ride through the rebuild, and on the procedural box-man (pack absent)
   * rebuildHumanoid declines and the identical silhouette simply stays.
   */
  setPlayerBody(body) {
    setPlayerBodyLook(body);
    const p = this.player;
    if (p?.mesh && rebuildHumanoid(p.mesh)) {
      // Settle the fresh rig into its idle immediately — the title screen never
      // reaches _updatePlayer, so without this tick the new body holds a T-pose
      // until PLAY is pressed.
      animateRig(p.mesh, { moving: false, speed: 0, t: this.time, dt: 0.016 });
    }
  }

  // ------------------------------------------------------------- loadout
  //
  // save.weapon and save.stash store (base, rarity, seed, level) per weapon,
  // not a snapshot of every rolled number, so re-tuning the tables later
  // re-derives everyone's gear instead of leaving stale statlines in saves.

  _restoreLoadout() {
    // ensureEquipment is the migration and it is idempotent, so calling it on
    // first contact here — the save.js ensureShopSave precedent — means a
    // profile written before the eight-slot model existed simply arrives with
    // its old single weapon already copied into equipment.weapon.
    ensureEquipment(this.save);
    // The materials ledger converges the same way on first contact — a save
    // from before ascension existed simply arrives with an empty ledger.
    ensureMaterials(this.save);
    const eq = this.save.equipment;
    this.weapon = deserializeWeapon(eq.weapon) || deserializeWeapon(this.save.weapon) || starterWeapon();
    const rawStash = Array.isArray(this.save.stash) ? this.save.stash : [];
    this.stash = rawStash
      // Weapons become live instances; armour/trinket records stay records in
      // armorStash below — nothing equips them until the panel unlocks the
      // slots (step 13), so deserialising them here would buy nothing.
      .filter((d) => !d || !d.k || d.k === 'w')
      .map((d) => deserializeWeapon(d))
      .filter(Boolean)
      .slice(0, STASH_LIMIT);
    // Armour and trinket records ride as-is ({k,b,r,s,l}) — kept separate so
    // the weapon-facing UI (g.stash) never sees a record it cannot swing.
    this.armorStash = rawStash
      .filter((d) => d && (d.k === 'a' || d.k === 't'))
      .slice(0, STASH_LIMIT);
    // refreshDerived (already run by the constructor, re-run here now that
    // equipment is definitely ensured) is the single computation site for
    // this._armorBonus — a second armorDerive call here was step 10's interim
    // wiring and two computation sites is how a stat line drifts.
    this.refreshDerived(true);
    equipWeapon(this.player.mesh, this.weapon);
  }

  _persistLoadout() {
    ensureEquipment(this.save);
    const rec = serializeWeapon(this.weapon);
    // k:'w' marks the kind. Written explicitly rather than relying on the
    // absent-means-weapon rule, because a save this build writes should not
    // need the compatibility path to read correctly.
    this.save.equipment.weapon = rec ? { k: 'w', ...rec } : null;
    // THE MIRROR. save.weapon keeps being the old flat record so a build rolled
    // back to the shipped version still finds the right sword instead of an
    // empty fist — the same reason save.js leaves the v1 key in place.
    this.save.weapon = rec;
    const weapons = this.stash.map((w) => {
      const r = serializeWeapon(w);
      return r ? { k: 'w', ...r } : null;
    }).filter(Boolean);
    // Weapons first, then the armour/trinket records, one shared cap. Armour
    // yields the tail under pressure because a weapon is the thing a rolled-
    // back build can still read.
    this.save.stash = weapons.concat(this.armorStash || []).slice(0, STASH_LIMIT);
    this.onSave();
  }

  /**
   * Point weapon construction at the loaded item pack and rebuild whatever is
   * currently in hand. Called from main.js once loadItemModels resolves TRUE;
   * never called when the GLB is missing, so the procedural weapons stay.
   */
  useItemModels(getMesh) {
    setModelSource(getMesh);
    if (this.player?.mesh && this.weapon) equipWeapon(this.player.mesh, this.weapon);
  }

  /** Equip `w`, sending whatever was held to the stash. */
  equip(w) {
    if (!w) return;
    // Swapping away from a bow mid-draw must drop the draw — the new weapon
    // has no string to release. Same for a staff mid-channel: no crystal, no
    // beam.
    if (this._bowState) { this._bowState.drawing = false; this._bowState.buffered = false; }
    this._endStaffBeam();
    // A swap mid-swing must also drop the MACHINE: the panel opens fine
    // mid-step in a gate, and a stale state.index from a 5-step dagger combo
    // indexes past a 1-step bow's table — tickAttack then crashes reading
    // steps[4].charge. cancelAttack's own header names this exact case.
    if (this.player?.attack) cancelAttack(this.player.attack);
    const old = currentWeapon(this.player.mesh) || this.weapon;
    if (old && old !== w) {
      this.stash.unshift(old);
      if (this.stash.length > STASH_LIMIT) this.stash.length = STASH_LIMIT;
    }
    this.weapon = w;
    equipWeapon(this.player.mesh, w);
    this._persistLoadout();
  }

  /**
   * ASCEND the equipped weapon (RPG_SPEC step 14, gate3): the epic in hand is
   * CONSUMED — replaced in place, never stashed — and its seed becomes the
   * legendary's seed, so the item the player loved is the item he keeps.
   * ascension.ascend owns the recipe maths and the refusal reasons; this
   * method owns the containers (hand, mesh, persistence), the same split
   * shop.buy has with equip(). Returns ascend()'s {ok, reason, weapon}.
   */
  ascendEquipped() {
    const held = this.weapon;
    const r = ascend(this.save, held);
    if (!r.ok) {
      this.ui.toast(r.reason || 'CANNOT ASCEND', 'danger');
      return r;
    }
    // In place, not equip(): equip() would push the consumed epic into the
    // stash, resurrecting the exact duplication the craft's "consumed" clause
    // forbids.
    if (this._bowState) { this._bowState.drawing = false; this._bowState.buffered = false; }
    this._endStaffBeam();
    // Same mid-swing rule as equip(): the machine never crosses a swap.
    if (this.player?.attack) cancelAttack(this.player.attack);
    this.weapon = r.weapon;
    equipWeapon(this.player.mesh, r.weapon);
    this._persistLoadout();
    this.ui.toast(`${r.weapon.name.toUpperCase()}  ·  ASCENDED`, 'gold');
    this.fx.ring(this.player.pos, 0xffc24b, 6, 0.7);
    this.fx.burst(this.player.pos.clone().setY(1.2), 40, 0xffc24b, { speed: 8, up: 7, life: 1.0 });
    this.audio.levelUp?.();
    return r;
  }

  /**
   * Equip the stash entry at `index`, SWAPPING rather than pushing.
   *
   * equip() alone unconditionally unshifts the outgoing weapon and never
   * removes the incoming one, so equipping something that CAME FROM the stash
   * leaves a duplicate. At one slot and a 12-entry cap that self-heals by
   * eviction; the moment the panel lets a player equip out of the stash on
   * purpose it is a duplication exploit, so the removal happens FIRST and
   * equip() then does the push.
   */
  equipFromStash(index) {
    const w = this.stash[index];
    if (!w) return null;
    this.stash.splice(index, 1);
    this.equip(w);
    return w;
  }

  // --------------------------------------------------------- stow and draw
  //
  // Stance is transient and is NOT saved: a resumed profile re-derives it from
  // where the player is standing and what is near him. Persisting it would be
  // a third source of truth about what is in the hand, alongside
  // save.equipment.weapon and mesh.userData.weapon.

  /**
   * Put the sword away, or take it out. Returns the stance actually applied.
   *
   * `manual` marks a deliberate player toggle, which suppresses the auto policy
   * for a few seconds — otherwise showing the weapon off in the plaza would
   * last exactly until the 3 s idle timer sheathed it again, and the button
   * would look broken.
   */
  setStance(stance, { manual = false } = {}) {
    const mesh = this.player?.mesh;
    if (!mesh) return 'drawn';
    // Never mid-swing: a weapon that vanishes from the fist during a chop
    // desyncs the animation from the hitbox that is still live.
    if (stance === 'sheathed'
      && (this.player.attack.active || this.player.skillSwing > 0
        || this._bowState?.drawing || this._staffBeam)) return weaponStance(mesh);
    const applied = setStance(mesh, stance);
    if (manual) this._stanceHold = 6.0;
    this._idleSince = 0;
    return applied;
  }

  /**
   * The auto policy, ticked once per frame from the player update.
   *
   * Sheathe in a safe place after 3 s of not fighting; draw the instant
   * anything hostile is close, an attack is pressed, or the mode is not the
   * city. Only the PLAYER stows — enemies, shadow soldiers, citizens and the
   * companion spawn drawn and stay drawn, which is one less state to test and
   * zero risk to the crowd budget.
   */
  _updateStance(dt) {
    const mesh = this.player?.mesh;
    // Nothing to put away, or an archetype with no place to put it.
    if (!mesh || !this.weapon || !STOW[this.weapon.archetype]) return;
    if (this._stanceHold > 0) { this._stanceHold -= dt; return; }

    const inTown = this._mode?.name === 'city';
    const hostileNear = !inTown || this.enemies.some(
      (e) => e.alive !== false && e.pos && e.pos.distanceToSquared(this.player.pos) < 196,   // 14 m
    );
    const busy = this.player.attack.active || this.player.attack.cd > 0
      || this.player.skillSwing > 0 || Boolean(this._bowState?.drawing)
      || Boolean(this._staffBeam);
    if (busy) this._idleSince = 0; else this._idleSince = (this._idleSince || 0) + dt;

    const want = (!hostileNear && this._idleSince >= 3.0) ? 'sheathed' : 'drawn';
    if (want === weaponStance(mesh)) return;
    // A draw takes time proportional to mass — a greataxe player who let it
    // sheath pays 0.35 s the moment something jumps him, a dagger player pays
    // almost nothing. The delay is spent BEFORE the weapon reappears, so the
    // cost is visible rather than a hidden stat.
    if (want === 'drawn') {
      this._drawTimer = (this._drawTimer || 0) + dt;
      if (this._drawTimer < drawTime(this.weapon)) return;
    }
    this._drawTimer = 0;
    setStance(mesh, want);
  }

  /** Shadows allowed on the field at once, clamped by the live quality tier.
   *  The vigil 4pc (+2) joins inside progression's clamps — the quality tier
   *  and the hard 12 still get the final word. */
  fieldCapacity() {
    return shadowFieldCapacity(this.save, this.quality.current, this._armorBonus?.shadowFieldAdd || 0);
  }

  refreshDerived(fill = false) {
    const prevMaxHp = this.derived?.maxHp ?? 0;
    const prevMaxMp = this.derived?.maxMp ?? 0;
    // THE single computation site for the armour layer (RPG_SPEC step 11).
    // ensureEquipment is idempotent and cheap; running it here means every
    // caller — constructor, level-up, gate entry — reads a sane slot object
    // rather than trusting whoever called first. armorDerive folds numeric
    // 2/4-piece set bonuses itself; the 5-piece RULES only ride along in
    // `rules`, and the map below is how the combat sites ask "is rule X live"
    // without re-walking the equipment every hit.
    ensureEquipment(this.save);
    this._armorBonus = armorDerive(this.save.equipment, this.save.level);
    this._rules = new Map(this._armorBonus.rules.map((r) => [r.key, r.bonus]));
    this.derived = derive(this.save, this._armorBonus);
    if (fill) {
      this.player.hp = this.derived.maxHp;
      this.player.mp = this.derived.maxMp;
      return;
    }
    // Credit any increase in the maximum. Spending a Vitality point used to
    // raise maxHp while leaving hp alone, so investing in health visibly
    // *shrank* your health bar.
    this.player.hp = Math.min(this.derived.maxHp, this.player.hp + Math.max(0, this.derived.maxHp - prevMaxHp));
    this.player.mp = Math.min(this.derived.maxMp, this.player.mp + Math.max(0, this.derived.maxMp - prevMaxMp));
  }

  // ------------------------------------------------------------- mode flow
  //
  // The game has exactly two places you can be: the city, or inside a gate.
  // Which one is mounted is the ONLY thing that decides what a frame does.

  get mode() { return this._mode; }

  /** Swap the mounted mode. `name === null` unmounts and leaves an empty scene. */
  _setMode(name, payload = {}) {
    if (this._mode) {
      this._mode.exit();
      this._mode = null;
    }
    // A mode swap never carries a live swing across: CityMode runs its own
    // player update and would leave the machine frozen mid-step forever, which
    // reads to _updateStance as "busy" and pins the sword in the fist. The cd
    // is zeroed for the same reason — nothing in the city ticks it down.
    if (this.player?.attack) {
      cancelAttack(this.player.attack);
      this.player.attack.cd = 0;
      this.player.skillSwing = 0;
      this.player.cds.attack = 0;
    }
    // A half-drawn bowstring does not cross a mode boundary either — nothing
    // in the city would ever release it. Nor does a lit beam.
    if (this._bowState) { this._bowState.drawing = false; this._bowState.buffered = false; }
    this._endStaffBeam();
    if (!name) return null;
    this._mode = createMode(name, this);
    this._mode.enter(payload);
    return this._mode;
  }

  /**
   * Walk into Threshold. Routed through AppState by main.js — call
   * `appState.go('city', { atPortal })` rather than this directly, or the
   * screen stack and the mounted mode disagree.
   */
  enterCity({ spawnAt = null, atPortal = null } = {}) {
    return this._setMode('city', { spawnAt, atPortal: atPortal ?? this.lastGateRank });
  }

  /**
   * Step through a portal. `rank` is 'E'..'S'. `forceBiome` pins the biome
   * roll; `forceOpen` is the dev override that mounts the flat arena for a
   * crawl rank (DUNGEON_SPEC worldJsArenasFate — old tests and screenshot
   * baselines still exercise the arena through it).
   */
  enterGate(rank, { forceBiome = null, forceOpen = false, wild = false } = {}) {
    const index = Math.max(0, GATES.findIndex((g) => g.rank === rank));
    const resolved = GATES[index].rank;
    this.lastGateRank = resolved;
    // Verge wild gates yield emberdust at ANY rank (RPG_SPEC gate3 recipe);
    // stored on the Game because the mode payload sheds unknown keys. Default
    // false on every entry path, so the flag can never leak between runs.
    // citymode's portal prompt forwards wild:true for a Verge portal
    // (citymode._updatePrompt stamps it from portal.wild; wired in the 3-B1
    // integration pass).
    this._wildRun = Boolean(wild);
    if (this.appState) return this.appState.go('run', { rank: resolved, gateIndex: index, forceBiome, forceOpen });
    return this.beginRun({ rank: resolved, gateIndex: index, forceBiome, forceOpen });
  }

  /** Mount the dungeon. AppState's onEnter('run') hook calls this. */
  beginRun({ rank = null, gateIndex = null, ...extra } = {}) {
    const index = gateIndex != null
      ? gateIndex
      : Math.max(0, GATES.findIndex((g) => g.rank === rank));
    this.lastGateRank = GATES[index].rank;
    // Forward whatever else rode in (forceBiome, forceOpen) — the mode owns
    // what those mean, and stripping the payload down to {gateIndex, rank}
    // here silently killed every dev override routed through AppState.
    return this._setMode('dungeon', { gateIndex: index, rank: GATES[index].rank, ...extra });
  }

  /** Compat wrapper for the gate-list menu, which still speaks in indices. */
  startGate(index) {
    return this.enterGate(GATES[index]?.rank ?? GATES[0].rank);
  }

  // ------------------------------------------------------------- gate setup
  //
  // Everything below this line is the code that shipped, moved but not
  // rewritten. DungeonMode.enter() calls _beginGate; the old public
  // startGate(index) is the wrapper above.
  _beginGate(index, gateOverride = null) {
    // `gateOverride` is DungeonMode's shallow copy {...gate, biome} from the
    // anomaly/forceBiome roll. Storing it as this.gate is what makes the
    // context-loss repair (this.world.build(this.gate, this.seed), line ~213)
    // rebuild the SAME anomaly rather than re-rolling. Absent, this line is
    // byte-identical to the shipped arena path.
    const gate = gateOverride || GATES[index];
    this.gateIndex = index;
    this.gate = gate;
    this.seed = (index + 1) * 7919 + Math.floor(Math.random() * 100000);
    this.rnd = mulberry32(this.seed);

    this.clearEntities();
    this.world.build(gate, this.seed);

    this.player.pos.set(0, 0, 0);
    this.player.vel.set(0, 0, 0);
    this.player.body.reset(0, 0, 0);
    this.player.yaw = 0;
    this.player.alive = true;
    this.player.kills = 0;
    this.player.invuln = 1.2;
    this.player.hurt = 0;
    cancelAttack(this.player.attack);
    this.player.attack.cd = 0;
    this.player.skillSwing = 0;
    if (this._bowState) { this._bowState.drawing = false; this._bowState.buffered = false; }
    this._endStaffBeam();
    Object.keys(this.player.cds).forEach((k) => { this.player.cds[k] = 0; });
    this.refreshDerived(true);

    this.spawned = 0;
    this.killed = 0;
    this.bossActive = false;
    this.boss = null;
    // Set-rule per-run state (RPG_SPEC step 11). The ward starts ARMED — the
    // arena has no rooms, so gate entry is its one "room entry"; in a crawl
    // the room tracker in _updatePlayer re-arms it per room. The finisher
    // counter is per-run by spec; the riposte charge dies with the run too.
    this._wardRoomId = -1;
    this._wardReady = true;
    this._finisherCount = 0;
    this._riposteCrit = false;
    // Legendary-rule per-run state (RPG_SPEC step 14). The emberdust stream is
    // its own FORK off the gate seed — 0xcc9e2d51 is murmur3's c1, colliding
    // with none of the registered fork constants (0x9e3779b9 / 0x5f356495 /
    // 0x1f123bb5 / 0x85ebca6b / 0x27d4eb2f / 0x632be59b / 0xc2b2ae35 /
    // 0x5ade0f) — so per-elite material rolls can never perturb the main
    // stream's enemy/loot draws, and a replayed seed yields the same dust.
    this._emberRnd = mulberry32((this.seed ^ 0xcc9e2d51) >>> 0);
    this._critRefunds = 0;      // WHISPERFANGS ASCENDANT: refunds this combo
    this._crater = null;        // GRAVEMAUL ASCENDANT: the live slow zone
    this.runTime = 0;
    this.xpEarned = 0;
    this.ashEarned = 0;
    this.spawnTimer = 0;
    this.levelsGained = 0;
    this.pointsGained = 0;
    this.levelUpDilation = 0;

    // Carry the deployed roster into the new rift. The field cap is a draw-call
    // budget, so the quality tier gets the final word on how many come along.
    const cap = this.fieldCapacity();
    autoDeploy(this.save, cap);
    for (const rec of deployedRecords(this.save)) {
      this._spawnShadow(this.world.randomSpawn(this.rnd, this.player.pos, 4), true, rec);
    }

    this.state = 'playing';
    this.audio.music(true);
    // DUNGEON_SPEC EDIT 7: crawl entry presentation is mode-owned. The HUD and
    // the rank toast land at the end of the walk-in (DungeonMode fires them;
    // STEP 6 moves them to intro end) so arriving reads as an entrance, not a
    // menu transition. The arena path keeps both inline, byte-identical.
    if (!this.world.encounterDriven) {
      this.ui.showHud(true);
      this.ui.toast(`${gate.rank}-GRADE RIFT — ${gate.name}`, 'gold');
    }
    this._spawnWave();
  }

  // `dispose` is only ever turned off when a caller intends to re-parent the
  // meshes; scene.remove alone orphaned every geometry and material an entity
  // owned, which is what killed long S-rank runs on Android.
  clearEntities({ dispose = true } = {}) {
    [...this.enemies, ...this.shadows, ...this.corpses, ...this.pickups].forEach((e) => {
      if (e.mesh) { this.scene.remove(e.mesh); if (dispose) disposeObject3D(e.mesh); }
      if (e.bar) { this.scene.remove(e.bar); if (dispose) disposeObject3D(e.bar); }
    });
    this.enemies.length = 0;
    this.shadows.length = 0;
    // Projectiles are POOLED: their meshes belong to the pool for the life of
    // the Game and must never enter the dispose walk above — clear() hides
    // them and hands every record back, silently (no removal bursts).
    this.pool.clear();
    this.corpses.length = 0;
    this.pickups.length = 0;
  }

  _spawnWave() {
    // DUNGEON_SPEC EDIT 1(b): encounter-driven worlds meter every spawn
    // through the room director — _beginGate calls this directly, and
    // unguarded it dumps the opening wave into rooms that must stay dormant.
    if (this.world.encounterDriven) return;
    const gate = this.gate;
    const remaining = gate.enemies - this.spawned;
    if (remaining <= 0) return;
    const n = Math.min(gate.waveSize, remaining);
    for (let i = 0; i < n; i++) this._spawnEnemy();
  }

  // DUNGEON_SPEC EDIT 2: the encounter director passes both `pos` (a room
  // spawn point) and `key` (its per-room pack roll). Existing callers pass
  // nothing and get exactly the shipped roll + randomSpawn.
  _spawnEnemy(pos = null, key = null) {
    const gate = this.gate;
    if (!key) {
      const roll = this.rnd();
      key = 'grunt';
      // Deeper gates skew toward the nastier archetypes.
      const tier = this.gateIndex / (GATES.length - 1);
      if (roll > 0.85 - tier * 0.15) key = 'caster';
      else if (roll > 0.68 - tier * 0.12) key = 'brute';
      else if (roll > 0.44 - tier * 0.14) key = 'stalker';
    }

    const base = ENEMY_TYPES[key];
    const level = gate.enemyLevel + Math.floor(this.rnd() * 3);
    const s = scaleEnemy(base, level);
    pos = pos || this.world.randomSpawn(this.rnd, this.player.pos, 12);

    const weapon = key === 'caster' ? 'staff' : key === 'stalker' ? 'claw' : 'sword';
    const mesh = makeHumanoid({
      color: base.color, glow: base.glow, accent: 0x14172a,
      weapon, scale: base.scale, cloak: key === 'caster',
      // The skinned-character picker cannot tell a lancer from a howler by the
      // weapon alone — both carry a plain sword — so name the archetype and the
      // rank outright. Both are advisory; makeHumanoid infers them otherwise.
      archetype: key, rank: this.gate.rank ?? 'E',
    });
    mesh.add(makeGroundRing(base.glow, 0.85 * base.scale, 0.5));
    mesh.position.copy(pos);
    // Rise-from-the-floor spawn: cheap, and it reads as a rift materialization.
    mesh.position.y = -3;
    this.scene.add(mesh);

    const bar = makeHealthBar(1.1 * base.scale, base.glow);
    this.scene.add(bar);

    this.fx.burst(pos.clone().setY(0.4), 14, base.glow, { speed: 5, up: 4, life: 0.6 });
    this.fx.ring(pos, base.glow, 3, 0.5);

    this.enemies.push({
      key, base, level, mesh, bar,
      pos: pos.clone(),
      vel: new THREE.Vector3(),
      yaw: 0,
      hp: s.hp, maxHp: s.hp, atk: s.atk, xp: s.xp,
      radius: 0.55 * base.scale,
      speed: base.speed,
      attackCd: 0.8 + this.rnd() * 1.2,
      telegraph: 0,
      swing: 0,
      hurt: 0,
      stagger: 0,
      spawning: 0.55,
      lungeCd: 0,
      isBoss: false,
    });
    const spawned = this.enemies[this.enemies.length - 1];
    spawned.agent = makeAgent(spawned, base.ai);
    // Enemy humanoids that CARRY a weapon (grunt/stalker/brute/lancer) swing it
    // through the same state machine the player uses: a one-step pseudo-weapon
    // whose windup is poked to steerAgent's telegraph per attack, active 0 so
    // the blow lands on the exact frame the old countdown fired it, recovery
    // 0.3 = the old follow-through. Casters and howlers have no weapon and no
    // swing; the boss's attacks are patterns, not weapon steps, and stay owned
    // by _bossBrain — the fairness telegraphs themselves still come from
    // enemyai.js either way.
    if (enemyWeaponKind(key)) {
      spawned.attack = makeAttackState();
      spawned.strikeW = npcStrikeWeapon();
    }
    this.spawned++;
  }

  _spawnBoss() {
    const b = BOSSES[this.gate.boss];
    // DUNGEON_SPEC EDIT 3: interiors anchor the boss in the boss chamber;
    // the arena keeps its disc formula (World has no bossSpawn).
    const pos = this.world.bossSpawn?.() ?? new THREE.Vector3(0, 0, -this.world.radius * 0.55);
    const mesh = makeHumanoid({
      color: b.color, glow: b.glow, accent: 0x0d0f1c,
      weapon: 'sword', scale: b.scale, cloak: true,
      archetype: 'boss', rank: this.gate.rank ?? 'E',
      // Name the boss explicitly. creatures.js can fall back to a rank lookup,
      // but that is only correct today because GATES' rank order and the
      // manifest's boss assignments happen to line up 1:1.
      boss: this.gate.boss,
    });
    mesh.add(makeGroundRing(b.glow, 1.6, 0.6));
    mesh.position.copy(pos);
    mesh.position.y = -6;
    this.scene.add(mesh);

    const bar = makeHealthBar(2.6, b.glow);
    this.scene.add(bar);

    const scaled = Math.floor(b.hp * (1 + (this.save.level - this.gate.reqLevel) * 0.04));
    this.boss = {
      // GATES carries an explicit bossLevel now — roughly a full rank above the
      // gate's trash, which the old enemyLevel+5 only approximated at E rank.
      key: 'boss', base: b, level: this.gate.bossLevel, mesh, bar,
      pos: pos.clone(), vel: new THREE.Vector3(), yaw: 0,
      hp: scaled, maxHp: scaled, atk: b.atk,
      xp: Math.floor(b.xp * (1 + Math.max(0, this.save.level - this.gate.reqLevel) * 0.04)),
      radius: 1.5 * (b.scale / 2.5), speed: b.speed,
      xpScaled: true,
      attackCd: 2.2, telegraph: 0, swing: 0, hurt: 0, stagger: 0,
      spawning: 1.2, isBoss: true,
      pattern: 0, patternCd: 4.5, enraged: false,
    };
    // The boss goes through the same stuck breaker as everything else. range 0
    // keeps it pressing all the way in exactly as the old code did, and its
    // attacks stay entirely owned by _bossBrain.
    this.boss.agent = makeAgent(this.boss, 'chase');
    this.boss.agent.range = 0;
    this.enemies.push(this.boss);
    this.bossActive = true;

    this.fx.ring(pos, b.glow, 16, 1.1);
    this.fx.burst(pos.clone().setY(1), 60, b.glow, { speed: 12, up: 8, life: 1.4 });
    this.fx.addShake(0.9);
    this.audio.nova();
    this.ui.toast(`${b.name} HAS AWAKENED`, 'danger');
    this.ui.setObjective('BOSS', '');
  }

  /**
   * A dark clone of a named creature — the Bind look. Wrapped the same way
   * buildSkinnedInto wraps its instances (outer Group carries game scale,
   * userData.character carries the mixer), so animateRig and disposeObject3D
   * treat it exactly like every other skinned entity. Null when the pack is
   * absent or the key is unknown; callers fall back to the humanoid ghost.
   */
  _makeBoundBody(creatureKey, scale) {
    if (!creatureKey || !creaturesReady()) return null;
    const inst = makeCreature({
      creature: creatureKey, rank: this.gate?.rank ?? 'E',
      shadow: true, glow: 0x35e6ff, eyes: false, scale: 1,
      // Shadows are already capped by fieldCapacity — the tier's declared
      // shadow budget — and must not evict monsters from the enemy budget.
      ignoreBudget: true,
    });
    if (!inst) return null;
    const root = new THREE.Group();
    root.add(inst.root);
    root.userData.character = inst;
    // The cast rides along like buildSkinnedInto's does: tools and the roster
    // UI read userData.appearance.key to tell one soldier's figure from
    // another, and without it every bound creature reports the same nothing.
    root.userData.appearance = inst.appearance;
    root.scale.setScalar(scale);
    return root;
  }

  // The corpse is the dead creature itself gone dark — a shadow that has not
  // been bound yet. The humanoid ghost remains as the offline fallback.
  _makeCorpseMesh(e, creatureKey) {
    const root = this._makeBoundBody(creatureKey, (e.base.scale || 1) * 0.95);
    if (root) {
      const inst = root.userData.character;
      // A dead flyer lies down with everything else.
      inst.root.position.y = 0;
      // Crumple from standing: _updateCorpses ticks the mixer, and the clamp
      // holds the ground pose for the Bind window.
      inst.play('die', { fade: 0, once: true, clamp: true });
      inst.mixer.update(0.01);
      return root;
    }
    const mesh = makeHumanoid({
      color: 0x0f1424, glow: 0x35e6ff, accent: 0x0a0d18,
      weapon: 'sword', scale: (e.base.scale || 1) * 0.95, ghost: true,
    });
    // The fallback paths handle the tip themselves: the skinned character
    // corpse counter-rotates and plays its Death clip, the box-man just lies
    // where it is tipped.
    mesh.rotation.x = -Math.PI / 2.4;
    return mesh;
  }

  // `record` is the roster entry this field instance represents. Its grade and
  // the owner's INT decide the numbers, so a shadow you kept and promoted is
  // still worth fielding forty levels later.
  _spawnShadow(pos, silent = false, record = null) {
    if (this.shadows.length >= this.fieldCapacity()) return null;
    const rec = record || makeShadow(this.save, { type: 'grunt', level: this.save.level });
    // Lazy save migration: rosters bound before creature identity existed (and
    // kills made while creatures.glb was still loading) carry no key. Deal one
    // deterministically from the record's own id the first time it takes the
    // field; the assignment sticks to the roster entry and persists through
    // the next onSave, so the same soldier keeps the same figure forever.
    if (!rec.creature && creaturesReady()) {
      const cast = creatureFor(`${rec.type}:${rec.id % 4}`, {
        archetype: rec.type, rank: this.gate?.rank ?? 'E',
      });
      rec.creature = cast?.key || null;
    }
    const c = shadowCombat(this.save, rec);
    const mesh = this._makeBoundBody(rec.creature, 0.95 * c.scale) || makeHumanoid({
      color: 0x1a2740, glow: 0x35e6ff, accent: 0x0b1220,
      weapon: 'sword', scale: 0.95 * c.scale, ghost: true, cloak: true,
      archetype: 'shadow', rank: this.gate?.rank ?? 'E',
    });
    mesh.add(makeGroundRing(0x35e6ff, 0.85 * c.scale, 0.6));
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.shadows.push({
      rec,
      mesh, pos: pos.clone(), vel: new THREE.Vector3(), yaw: 0,
      radius: c.radius, speed: c.speed,
      hp: c.hp, maxHp: c.hp,
      atk: c.atk,
      // telegraph/telegraphMax mirror the enemy fields: windup timer counting
      // down to the contact frame, and its start value for the animation span.
      attackCd: 0, swing: 0, telegraph: 0, telegraphMax: 0,
      target: null, life: 0, kills: 0,
    });
    if (!silent) {
      this.fx.ring(pos, 0x35e6ff, 4, 0.6);
      this.fx.burst(pos.clone().setY(0.8), 22, 0x35e6ff, { speed: 6, up: 5 });
    }
    return rec;
  }

  // -------------------------------------------------------------- combat
  _damageEnemy(e, amount, opts = {}) {
    if (e.hp <= 0) return false;
    // deepglass 5pc: a banked perfect dodge makes the next PLAYER hit a
    // guaranteed crit — one charge, consumed here, never by a shadow's blow
    // (they mark themselves with origin:'shadow').
    const forced = this._riposteCrit === true && opts.origin !== 'shadow';
    const crit = forced || Math.random() < this.derived.crit;
    if (forced) this._riposteCrit = false;
    const dmg = Math.max(1, Math.round(amount * (crit ? 1.85 : 1)));
    e.hp -= dmg;
    e.hurt = 0.3;
    if (opts.stagger) e.stagger = Math.max(e.stagger, opts.stagger);
    // Armour-layer leech (Thirsting affix + ember_ring trinket): player-origin
    // hits only. 0 with nothing worn, so the shipped path is untouched.
    if (opts.origin !== 'shadow' && this._armorBonus && this._armorBonus.leech > 0) {
      this.player.hp = Math.min(this.derived.maxHp, this.player.hp + dmg * this._armorBonus.leech);
    }

    tmpV.copy(e.pos).setY(1.4 * (e.base.scale || 1));
    this.fx.damageNumber(tmpV, dmg, crit ? 'crit' : '');
    this.fx.burst(tmpV, crit ? 16 : 9, e.base.glow, { speed: 6, up: 3, life: 0.4, size: crit ? 1.3 : 1 });
    this.audio.hit(crit);
    this.fx.addShake(crit ? 0.24 : 0.12);
    this.fx.addHitStop(crit ? 0.055 : 0.03);

    if (opts.knockback) {
      tmpV2.copy(e.pos).sub(opts.from || this.player.pos).setY(0);
      const kbDist = tmpV2.length();
      if (kbDist > 1e-4) tmpV2.divideScalar(kbDist);
      let kb = opts.knockback / (e.isBoss ? 6 : 1);
      if (kb < 0) {
        // NEGATIVE knockback is the hand axe's hook (RPG_SPEC familyTable's
        // -12 finisher): a pull TOWARD the attacker, not a value to clamp to
        // zero. Enemy velocity damps at 7/s (see _updateEnemies), so an
        // impulse v travels ~v/7 m — the table's 12 closes ~1.7 m. The cap
        // keeps the pull from dragging a close target THROUGH the player:
        // never pull more than would land it at arm's length (1.3 m).
        kb = -Math.min(-kb, Math.max(0, (kbDist - 1.3) * 7));
        // HOOKFANG ASCENDANT (tempo verb): the pull also staggers what it
        // drags. Player-origin only — a bound shadow swinging an axe carries
        // no rule.
        const ps = opts.origin !== 'shadow' ? this.weapon?.rule?.fx.pullStagger : 0;
        if (ps) e.stagger = Math.max(e.stagger, ps);
      }
      e.vel.addScaledVector(tmpV2, kb);
    }

    if (e.hp <= 0) this._killEnemy(e);
    // Whether this application critted — _applySwingHit feeds it to the
    // WHISPERFANGS refund. A boolean, not the damage: rules read tempo, never
    // numbers (the legendary law).
    return crit;
  }

  _killEnemy(e) {
    e.hp = 0;
    this.killed++;
    this.player.kills++;
    this.save.totalKills++;

    this.fx.burst(e.pos.clone().setY(1), e.isBoss ? 90 : 26, e.base.glow, {
      speed: e.isBoss ? 14 : 8, up: e.isBoss ? 9 : 5, life: e.isBoss ? 1.5 : 0.8,
      size: e.isBoss ? 2 : 1,
    });
    this.fx.ring(e.pos, e.base.glow, e.isBoss ? 18 : 4, e.isBoss ? 1.2 : 0.45);
    this.fx.addShake(e.isBoss ? 1.0 : 0.2);
    this.audio.death();

    // CINDERBITE ASCENDANT (resource-flow verb): a bleeding kill passes the
    // REMAINING wound to the nearest enemy in range — nothing is amplified,
    // the same dps and clock just change bodies.
    const jump = this.weapon?.rule?.fx.bleedJump;
    if (jump && e.bleedT > 0 && (e.bleedDps || 0) > 0) {
      let heir = null; let heirD = jump;
      for (const o of this.enemies) {
        if (o === e || o.hp <= 0) continue;
        const d = tmpV2.copy(o.pos).sub(e.pos).setY(0).length();
        if (d < heirD) { heir = o; heirD = d; }
      }
      if (heir) {
        heir.bleedDps = (heir.bleedDps || 0) + e.bleedDps;
        heir.bleedT = Math.max(heir.bleedT || 0, e.bleedT);
        heir.bleedStacks = Math.max(heir.bleedStacks || 0, e.bleedStacks || 1);
        heir.bleedAcc = heir.bleedAcc || 0;
        heir.bleedNumT = heir.bleedNumT ?? 0;
        this.fx.burst(heir.pos.clone().setY(1.2), 8, 0xff6b4d, { speed: 4, up: 2, life: 0.35 });
      }
    }

    // Ascension materials (RPG_SPEC step 14) — BEFORE gainXp, whose onSave()
    // persists the whole save including the ledger this writes.
    //
    // Emberdust: only band-B-and-above gates (index >= 3) and Verge wild gates
    // yield it. 1 guaranteed per boss; per ELITE (brute/lancer/howler — the
    // same tier map extraction uses) a draw off the gate's own forked stream,
    // never Math.random, so a replayed seed pays the same dust.
    const dustEligible = (this.gateIndex ?? 0) >= EMBERDUST_MIN_RANK || this._wildRun;
    if (dustEligible) {
      const dust = e.isBoss ? 1
        : (tierWeightOf(e) === 'elite' && this._emberRnd && this._emberRnd() < EMBERDUST_ELITE_CHANCE ? 1 : 0);
      if (dust > 0) {
        grantEmberdust(this.save, dust);
        this.fx.damageNumber(tmpV.copy(e.pos).setY(2.6), '+1 EMBERDUST', 'crit');
      }
    }
    // Family sigil: every named boss guards one family's sigil and ALWAYS
    // drops it — six bosses, six families, no ambiguity about where to go.
    if (e.isBoss && this.gate?.boss && SIGIL_LABEL[this.gate.boss]) {
      grantSigil(this.save, this.gate.boss);
      this.ui.toast(`${SIGIL_LABEL[this.gate.boss]} CLAIMED`, 'gold');
    }

    this.gainXp(e.xp);

    // Drops: a steady trickle of healing is what makes long gates survivable.
    if (e.isBoss) {
      for (let i = 0; i < 4; i++) {
        tmpV.copy(e.pos).add(new THREE.Vector3((Math.random() - 0.5) * 5, 0, (Math.random() - 0.5) * 5));
        this._spawnPickup(tmpV.clone(), i < 3 ? 'hp' : 'mp');
      }
      // A boss always leaves a weapon. It is the only guaranteed source, so
      // clearing a rank always moves your gear forward.
      this._spawnWeaponDrop(e.pos.clone());
    } else {
      // One roll, adjacent windows. Armour's 0.10 window is INSERTED and the
      // hp/mp windows shifted up by the same amount, so the healing trickle
      // keeps its exact shipped probabilities (hp 0.20, mp 0.08) — long gates
      // stay exactly as survivable as before armour existed.
      const roll = Math.random();
      if (roll < WEAPON_DROP_CHANCE) this._spawnWeaponDrop(e.pos.clone());
      else if (roll < WEAPON_DROP_CHANCE + ARMOR_DROP_CHANCE) this._spawnArmorDrop(e.pos.clone());
      else if (roll < 0.36) this._spawnPickup(e.pos.clone(), 'hp');
      else if (roll < 0.44) this._spawnPickup(e.pos.clone(), 'mp');
    }

    // The Bound keep the figure of whatever died, so read WHICH creature this
    // was off the live instance — disposeObject3D nulls userData.character.
    const srcInst = e.mesh.userData?.character;
    const boundCreature = (srcInst?.isCreature && srcInst.creature) || null;
    this.scene.remove(e.mesh);
    this.scene.remove(e.bar);
    disposeObject3D(e.mesh);
    disposeObject3D(e.bar);   // hands the pooled bar slot straight back
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);

    if (e.isBoss) {
      this.bossActive = false;
      this.boss = null;
      // DUNGEON_SPEC EDIT 6: in a crawl the walk-out exit portal owns run end
      // (STEP 5's director calls _clearGate on walk-in); the arena keeps the
      // instant clear.
      if (!this.world.encounterDriven) this._clearGate();
      return;
    }

    // Leave a corpse that Bind can raise for a limited window.
    const corpseMesh = this._makeCorpseMesh(e, boundCreature);
    corpseMesh.position.copy(e.pos);
    corpseMesh.rotation.y = e.yaw;
    corpseMesh.position.y = 0.25;
    this.scene.add(corpseMesh);
    // enemyLevel/tierWeight/attempts are what extractionChance reads; the life
    // and the chance decay share CORPSE_WINDOW so a corpse that still looks
    // raiseable still is one. `creature` rides along so a successful Bind can
    // put the same figure on the roster.
    this.corpses.push({
      mesh: corpseMesh, pos: e.pos.clone(), life: CORPSE_WINDOW,
      type: e.key, creature: boundCreature,
      enemyLevel: e.level, tierWeight: tierWeightOf(e), attempts: 0,
    });

    // DUNGEON_SPEC EDIT 1(c): unguarded, the last trash kill in a crawl would
    // spawn the boss on the spot, bypassing the sealed boss door. The director
    // owns both transitions when the world is encounter-driven.
    if (!this.world.encounterDriven) {
      if (this.killed >= this.gate.enemies && !this.bossActive) {
        this._spawnBoss();
      } else if (this.enemies.length <= 1 && this.spawned < this.gate.enemies) {
        this.spawnTimer = 0.9;
      }
    }
  }

  /**
   * The one place player damage resolves (RPG_SPEC step 11).
   *
   * Order of operations, and why it is this order:
   *   1. i-frames — a dodged hit deals nothing, but a dodge inside the
   *      dodgeWindow of the dash is a PERFECT dodge, which is where the
   *      deepglass 5pc rule pays out (it needs the dodged hit's raw amount,
   *      which only exists here).
   *   2. combinedDR(dr, armorDR) — multiplicative stacking of vitality DR and
   *      the armour slab, hard total clamp 0.72 (taken >= raw * 0.28). The
   *      clamp lives in armor.combinedDR so the headless suite asserts the
   *      exact function the game runs. NOTE: derive().dr was computed and
   *      shown on the panel since v1 but never applied here; the spec's
   *      stacking formula (`taken = raw * (1-dr) * (1-armorDR)`) makes both
   *      layers real. A fresh save has dr 0, so the shipped numbers hold.
   *   3. Set RULES that modify the amount — ossuary lowhp_bulwark (below 35%
   *      HP, x0.80), issue first_hit_ward (first hit each room, x0.60). Both
   *      multiply, so their order does not matter.
   *   4. Stagger/knockback — staggerResist scales the hurt flinch (the
   *      player's stagger term), knockTakenMul scales the shove distance, and
   *      the bulwark makes trash (grunt/stalker) unable to do either while
   *      low. `source` is the striking enemy when the caller has one; a bolt
   *      carries none and casters are not trash anyway.
   */
  _damagePlayer(amount, from, source = null) {
    const p = this.player;
    if (!p.alive) return;
    if (p.invuln > 0) {
      // Perfect dodge: this hit arrived inside the dodge window of the dash
      // that granted the current i-frames. _dodgeT only ever starts at dash
      // time, so spawn/level-up/post-hit invulnerability can never count.
      const rip = p._dodgeT > 0 ? this._rules?.get('dodge_riposte') : null;
      if (rip) {
        // Refund rides EVERY perfectly dodged hit; the crit charge is one,
        // unstackable, consumed by the next connecting hit (_damageEnemy).
        p.mp = Math.min(this.derived.maxMp, p.mp + Math.max(1, Math.round(amount * rip.manaRefund)));
        this._riposteCrit = true;
        this.fx.ring(p.pos, 0x66e0ff, 3.2, 0.3);
        this.audio.skill();
      }
      return;
    }
    const d = this.derived;
    let raw = amount * (1 - combinedDR(d.dr, d.armorDR));
    const bul = this._rules?.get('lowhp_bulwark');
    const lowHp = Boolean(bul) && p.hp <= d.maxHp * bul.lowHpFrac;
    if (lowHp) raw *= bul.lowHpDmgMul;
    const ward = this._rules?.get('first_hit_ward');
    if (ward && this._wardReady) {
      // Consumed only by a hit that actually lands — a dodged hit returned
      // above without touching it. Re-arms on room entry (_updatePlayer).
      this._wardReady = false;
      raw *= ward.firstHitMul;
      this.fx.ring(p.pos, 0xffc24b, 2.6, 0.35);
    }
    const dmg = Math.max(1, Math.round(raw));
    p.hp -= dmg;
    // RIFTEDGE ASCENDANT's other half: the whiff no longer rewinds the combo
    // (tickAttack skips it under the rule), so TAKING A HIT is what does —
    // the clause's own wording, and the only reset the rule leaves.
    if (this.weapon?.rule?.fx.comboKeepOnWhiff) { p.attack.next = 0; p.attack.chain = 0; }
    // Trash-tier per the spec's own naming: ENEMY_TYPES grunt/stalker only.
    const trash = Boolean(source) && !source.isBoss && (source.key === 'grunt' || source.key === 'stalker');
    const unstoppable = lowHp && trash; // ossuary 5pc: trash cannot stagger you
    if (!unstoppable) p.hurt = 0.35 * (1 - d.staggerResist);
    p.invuln = 0.42;

    this.fx.damageNumber(tmpV.copy(p.pos).setY(2.2), dmg, 'player');
    this.fx.addShake(0.4);
    this.audio.hurt();
    this.flash.style.opacity = Math.min(0.42, dmg / this.derived.maxHp * 1.6);
    setTimeout(() => { this.flash.style.opacity = 0; }, 110);

    if (from && !unstoppable) {
      tmpV2.copy(p.pos).sub(from).setY(0);
      // 1.6 m is the shipped shove; knockTakenMul (feet secondary clamped at
      // -50%, then ossuary 4pc x0.75) scales the DISTANCE the body solves for.
      applyKnockback(p.body, tmpV2, p.body.impulseForDistance(1.6 * d.knockTakenMul));
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      // The hunter falls before the fail screen reads him his rites: the Death
      // clip starts here and _updatePlayer's dead branch keeps the mixer
      // ticking, since the living animate path stops the moment alive flips.
      p.mesh.userData.character?.play('die', { fade: 0.08, once: true, clamp: true });
      this._fail();
    }
  }

  gainXp(amount) {
    this.xpEarned += amount;
    // Ash rides the same event as XP. save.ash has had two sinks (respec,
    // shadow promotion) and no source since the v1 schema; the Exchange is the
    // third sink and the reason it finally needs an income. Granting it HERE
    // rather than at the kill site means every existing XP payer — trash,
    // bosses, the daily — pays ash too, with no second bookkeeping path to
    // fall out of sync.
    // ashMul is the armour layer's one payout hook: Ashen affix + ash_band
    // trinket + the issue 2pc compound into a single multiplier (x1 naked, so
    // grantAsh's own rounding reproduces the shipped integers exactly).
    this.ashEarned = (this.ashEarned || 0)
      + grantAsh(this.save, ashForXp(amount) * (this._armorBonus?.ashMul || 1));
    const fromLevel = this.save.level;
    // progression.grantXp owns the level loop: it is the only place that also
    // increments save.autoStats, and the +1-to-every-stat grant silently never
    // happened while this method open-coded the loop itself.
    const r = grantXp(this.save, amount);
    const leveled = r.levelsGained;
    if (leveled > 0) {
      const gained = r.pointsGained;
      this.levelsGained += leveled;
      this.pointsGained += gained;
      // refreshDerived now credits the max-health delta itself.
      this.refreshDerived();
      this.player.hp = Math.min(this.derived.maxHp, this.player.hp + 25);
      this.player.mp = this.derived.maxMp;
      this.player.invuln = Math.max(this.player.invuln, 0.8);
      this.fx.ring(this.player.pos, 0xffc24b, 10, 0.8);
      this.fx.burst(this.player.pos.clone().setY(1), 50, 0xffc24b, { speed: 9, up: 8, life: 1.2 });
      this.audio.levelUp();
      // A single kill can cross several thresholds. Report the real span and
      // the real point count — saying "+3" after a double level is why points
      // felt untethered from levelling.
      const label = leveled > 1
        ? `LEVEL ${fromLevel} → ${this.save.level}  ·  +${gained} POINTS`
        : `LEVEL ${this.save.level}  ·  +${gained} POINTS`;
      this.ui.toast(label, 'gold');
      this.ui.flashLevelUp(this.save.level, gained);
      // Brief time dilation so a level-up registers as an event rather than a
      // toast you were too busy fighting to read.
      this.levelUpDilation = 0.5;
    }
    // Persist XP as it is earned, not only on level-up: Android kills
    // backgrounded apps and everything since the last level was being lost.
    this.onSave();
  }

  // ------------------------------------------------------------- skills
  _tryAttack() {
    const p = this.player;
    const w = this.weapon;
    if (!w) return;
    // The staff costs MANA where every other family costs only time (RPG_SPEC
    // staff identity; magic's bend #1 changes what a hit does, never its
    // timing, so the cost sits on the resource rather than the clock). The
    // gate fires only when this press would actually START a step — a
    // mid-swing press still buffers normally, and the buffered retry
    // re-enters here with a fresh mana read.
    if (canAttack(p.attack, w)) {
      const ns = w.combo[p.attack.next % w.combo.length];
      const need = ns.bolt ? STAFF.boltMp : (ns.beam ? STAFF.beam.mpPerTick : 0);
      if (need > 0 && p.mp < need) { this.ui.toast('NOT ENOUGH MANA'); return; }
    }
    // Any attack input draws. A manual sheathe holds off the auto policy for a
    // few seconds, and without this a player who put the sword away to look at
    // the plaza would swing a bare fist at the first thing that jumped him.
    if (weaponStance(p.mesh) === 'sheathed') { this._stanceHold = 0; this.setStance('drawn'); }
    // The machine answers "can this press start a step". A press that arrives
    // mid-swing is buffered inside the state and re-attempted from
    // _updatePlayer, so mashing never eats an input the cancel window would
    // have honoured.
    const step = startAttack(p.attack, w);
    if (!step) return;
    // WHISPERFANGS ASCENDANT's per-combo budget re-arms when a fresh combo
    // opens — the opener is index 0 by the machine's own bookkeeping.
    if (p.attack.index === 0) this._critRefunds = 0;
    // Staff casts aim down the CAMERA line (soft-lock in _fireStaffBolt, yaw
    // tracking during the beam) — snapping to the nearest melee body here
    // would fight the line the player is actually looking down.
    if (!step.bolt && !step.beam) this._faceNearest(7);
    // The step's forward carry, in metres — the body solves the impulse that
    // travels it, exactly as the dash does. This is what walks the daggers
    // into the target and leans the heavies into their arcs.
    const lunge = consumeLunge(p.attack);
    if (lunge > 0 && p.body) {
      const f = this._forward(p.yaw, tmpV);
      const v0 = p.body.impulseForDistance(lunge);
      p.body.addImpulse(f.x * v0, 0, f.z * v0);
    }
    // Mirror for the HUD wipe only — the machine's own cd is the gate.
    p.cds.attack = p.attack.cd;
    // state.next is already the human-readable step number (index + 1).
    this._comboShown = p.attack.next;
    this.audio.swing();
    this.ui.setCombo(this._comboShown);
  }

  /**
   * One damage application from tickAttack. All maths come from the hit
   * helpers so game.js never has to remember whether the step or the rolled
   * instance owns a factor. A common Riftedge through this path is numerically
   * identical to the retired hardcoded three-chop — SWORD_COMBO is that sword,
   * and tools/weapon-feel-test.mjs asserts the equality rather than trusting
   * this comment.
   */
  _applySwingHit(step) {
    const p = this.player;
    const w = this.weapon;
    // The staff's two steps produce no melee cone at all (RPG_SPEC: arc 0 on
    // both rows) — the machine still owns the timing, but the HIT is a
    // projectile or a channel opening, so it routes out before the cone maths.
    if (step.bolt) return this._fireStaffBolt(w, step);
    if (step.beam) return this._beginStaffBeam(w, step);
    const range = hitRange(w, step);
    const arc = hitArc(w, step);
    // The maul pound is the one radial attack in the game: a ground slam has
    // no front, so it takes everything in the circle instead of a cone.
    const hits = isRadial(step)
      ? this.enemies.filter((e) => tmpV2.copy(e.pos).sub(p.pos).setY(0).length() <= range + e.radius)
      : this._coneTargets(p.pos, p.yaw, range, arc);
    // chargeMul is 1 on every step without a charge clause (all shipped
    // tables), so the sword's byte-equality contract is untouched. On the
    // greatsword finisher it is 1 -> 2.1 with the hold.
    const cMul = chargeMul(p.attack, step, w);
    const dmg = hitDamage(w, step, this.derived.atk * SKILLS.attack.dmg) * cMul;
    // DUSKREND ASCENDANT (tempo verb): a NEAR-FULL charge's stagger scales.
    // "Near-full" is 90% of the charge span, so a frame of early release does
    // not silently void the clause the player just paid 0.4 s for.
    const charged = Boolean(step.charge) && cMul >= 1 + ((step.charge?.dmgMul || 1) - 1) * 0.9;
    let stagger = hitStagger(w, step);
    if (charged && w.rule?.fx.chargedStaggerMul) stagger *= w.rule.fx.chargedStaggerMul;
    let crits = 0;
    hits.forEach((e) => {
      if (this._damageEnemy(e, dmg, {
        knockback: hitKnockback(w, step),
        stagger,
        from: p.pos,
      })) crits++;
      // The axe opens a wound on every CONNECTING hit; a killing blow has
      // nothing left to bleed.
      if (step.bleed && e.hp > 0) this._applyBleed(e, dmg);
      // VOIDGLAIVE ASCENDANT (positioning verb): wide-arc steps pull every
      // target toward the arc's centre — never past arm's length of it. The
      // velocity damps at 7/s (see _updateEnemies), so an impulse of d*7
      // travels ~d metres.
      const pull = w.rule?.fx.sweepPull;
      if (pull && step.arc >= Math.PI * 0.5 && !isRadial(step) && e.hp > 0) {
        tmpV2.copy(p.pos).addScaledVector(this._forward(p.yaw, tmpV), range * 0.5).sub(e.pos).setY(0);
        const d = tmpV2.length();
        if (d > 0.3) e.vel.addScaledVector(tmpV2.divideScalar(d), Math.min(pull, d - 0.3) * 7);
      }
    });
    // WHISPERFANGS ASCENDANT (tempo verb): a crit refunds recovery time, at
    // most critRefundMax per combo (counter reset when the opener starts).
    const cr = w.rule?.fx.critRefund;
    if (cr && crits > 0) {
      const n = Math.min(crits, (w.rule.fx.critRefundMax || 3) - this._critRefunds);
      if (n > 0) { p.attack.t += cr * n; this._critRefunds += n; }
    }
    if (step.finisher) {
      // SUNDERAXE ASCENDANT (tempo verb): the finisher's stagger lands on
      // everything in the arc AT HALF AGAIN THE REACH, hit or miss — the wind
      // alone staggers. Stagger only: the damage cone above is untouched.
      if (w.rule?.fx.staggerOnMiss && stagger > 0) {
        for (const e of this._coneTargets(p.pos, p.yaw, range * 1.5, arc)) {
          if (!hits.includes(e) && e.hp > 0) e.stagger = Math.max(e.stagger, stagger);
        }
      }
      // VIGIL ASCENDANT (tempo verb): LANDING the thrust finisher resets Dash.
      if (w.rule?.fx.finisherDashReset && hits.length > 0) {
        this.player.cds.dash = 0;
        this.fx.ring(p.pos, 0x9dd8ff, 2.2, 0.25);
      }
      // GRAVEMAUL ASCENDANT (positioning verb): the radial pound leaves a
      // crater that slows everything inside. One zone at a time — a second
      // pound MOVES the crater rather than stacking a field of them.
      if (w.rule?.fx.craterSlow && isRadial(step)) {
        this._crater = {
          x: p.pos.x, z: p.pos.z, r: range * 0.7,
          t: w.rule.fx.craterT || 3, slow: w.rule.fx.craterSlow,
        };
        this.fx.ring(p.pos, 0xc2703a, range * 0.7, 0.6);
      }
    }
    // A released charge moves more air: scale the whiff-or-hit rumble with
    // what the hold earned, so a full-charge release reads without a tooltip.
    if (cMul > 1) this.fx.addShake(0.2 * (cMul - 1));
    if (step.finisher) this.fx.ring(p.pos, 0x9dd8ff, 4.5, 0.35);
    if (step.finisher) {
      // emberfall 4pc: finishers leech 3% of damage DEALT — per connecting
      // target, because dmg here is per-target.
      const fl = this._armorBonus?.finisherLeech || 0;
      if (fl > 0 && hits.length) {
        p.hp = Math.min(this.derived.maxHp, p.hp + dmg * fl * hits.length);
      }
      // emberfall 5pc: every THIRD combo finisher detonates for 60% weapon
      // damage in a 4 m ring. The counter is per-run (reset in _beginGate)
      // and counts finishers THROWN, not landed — a ground burst goes off
      // whether or not the swing connected. Existing fx.ring/addShake only,
      // per the spec: no new VFX asset.
      const det = this._rules?.get('third_finisher_detonate');
      if (det) {
        this._finisherCount = (this._finisherCount || 0) + 1;
        if (this._finisherCount % 3 === 0) {
          const r = det.detonateRadius;
          // Snapshot: _damageEnemy splices the dead out of this.enemies.
          [...this.enemies].forEach((e) => {
            if (tmpV2.copy(e.pos).sub(p.pos).setY(0).length() <= r + e.radius) {
              this._damageEnemy(e, dmg * det.detonateMul, { from: p.pos, knockback: 5 });
            }
          });
          this.fx.ring(p.pos, 0xff6b2b, r * 1.1, 0.45);
          this.fx.addShake(0.5);
        }
      }
    }
    // shake rides the step whether or not it connects (the air moves); the
    // hit-stop only lands on contact — freezing time for a whiff reads as lag.
    if (step.shake) this.fx.addShake(step.shake);
    if (hits.length > 0) {
      if (step.hitStop) this.fx.addHitStop(step.hitStop);
    } else {
      this.fx.burst(tmpV.copy(p.pos).addScaledVector(this._forward(p.yaw), 2).setY(1), 4, 0x9dd8ff, { speed: 3, up: 1, life: 0.25 });
    }
  }

  /**
   * One axe hit's bleed application. Stacks cap at BLEED_MAX_STACKS; a capped
   * application still refreshes the clock (the wound is re-opened, not
   * deepened). Fields live directly on the enemy record like hurt/stagger do —
   * no allocation per application.
   */
  _applyBleed(e, hitDmg) {
    if ((e.bleedStacks || 0) < BLEED_MAX_STACKS) {
      e.bleedStacks = (e.bleedStacks || 0) + 1;
      e.bleedDps = (e.bleedDps || 0) + (hitDmg * BLEED_FRACTION) / BLEED_TIME;
    }
    e.bleedT = BLEED_TIME;
    e.bleedAcc = e.bleedAcc || 0;
    e.bleedNumT = e.bleedNumT ?? 0;
  }

  // ------------------------------------------------------------- the bow
  //
  // RPG_SPEC step 8. Draw-hold-release on the SAME attack button: press starts
  // the draw, holding deepens it (speed 22 -> 46 m/s and damage 0.55x -> 1.35x
  // linearly across drawMin..drawFull), release looses. The melee swing
  // machine never runs — the bow family's whole output is the projectile.

  /** Per-frame bow input. Consumes the attack press so the melee path can't. */
  _updateBow(dt, w, p) {
    const b = this._bowState
      || (this._bowState = { drawing: false, t: 0, heldT: 0, buffered: false, fullCued: false });
    const held = this.input.isHeld('attack');
    const pressed = this.input.consume('attack');
    // STARPIERCER ASCENDANT (tempo verb): full draw arrives sooner. The whole
    // draw-fraction ruler scales off this one effective value, so speed,
    // damage and the full-draw cue all agree about what "full" means.
    const drawFull = BOW.drawFull * (w.rule?.fx.drawFullMul || 1);
    if (!b.drawing) {
      if ((pressed || b.buffered) && p.attack.cd <= 0) {
        b.drawing = true;
        b.t = 0;
        b.heldT = 0;
        b.buffered = false;
        b.fullCued = false;
        // GALESTING ASCENDANT (resource-flow verb): a banked refund makes THIS
        // draw start at full — the string remembers the kill that paid for it.
        if (b.refund) {
          b.refund = false;
          b.t = drawFull;
          b.heldT = drawFull;
          b.fullCued = true;
          this.fx.ring(p.pos, 0xffe2a8, 1.5, 0.22);
          this.audio.tone({ freq: 1500, type: 'sine', gain: 0.05, decay: 0.08 });
        }
        // Any attack input draws the weapon — same policy as _tryAttack.
        if (weaponStance(p.mesh) === 'sheathed') { this._stanceHold = 0; this.setStance('drawn'); }
      } else if (pressed) {
        // Press landed during recovery: buffer it, exactly as the melee
        // machine buffers a too-early press, so mashing never eats an input.
        b.buffered = true;
      }
      return;
    }
    b.t += dt;
    // heldT is the time the button was actually DOWN — a release before
    // drawMin still fires (the string must travel), but at minimum power.
    if (held) b.heldT = b.t;
    if (!b.fullCued && b.heldT >= drawFull) {
      // Full-draw cue: the one non-numeric signal that the hold has bought
      // everything it can. Ring + tick, no new VFX asset.
      b.fullCued = true;
      this.fx.ring(p.pos, 0xffe2a8, 1.5, 0.22);
      this.audio.tone({ freq: 1500, type: 'sine', gain: 0.05, decay: 0.08 });
    }
    if (!held && b.t >= BOW.drawMin) {
      b.drawing = false;
      const f = Math.min(1, Math.max(0, (b.heldT - BOW.drawMin) / (drawFull - BOW.drawMin)));
      this._fireBow(w, p, f);
    }
  }

  /**
   * Camera-forward, flattened — the axis the soft-lock cone hangs off. Falls
   * back to the body's facing when the camera sits directly overhead.
   */
  _camForward(out) {
    out.copy(this.player.pos).sub(this.camera.position).setY(0);
    const len = out.length();
    if (len < 1e-4) return this._forward(this.player.yaw, out);
    return out.divideScalar(len);
  }

  /**
   * The spec's recommended soft-lock: nearest live enemy within 25 degrees of
   * camera-forward and inside `reach`. No new input mode and no new camera
   * mode — the orbit camera was tuned for melee and stays. Shared by the bow
   * (34 m) and the staff bolt (18 m); both families use the same 25-degree
   * cone so "aiming" is ONE learned skill, not two. Scratch use is
   * call-scoped: this runs only at release/fire time, never inside the enemy
   * or projectile loops.
   */
  _bowTarget(w, reach = BOW.reach, coneCos = BOW.coneCos) {
    this._camForward(_bowDir);
    const p = this.player;
    const maxD = reach * (w.reachMul || 1);
    let best = null;
    let bestD = maxD;
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      // The cone test is HORIZONTAL, so guard the vertical band a shot can
      // actually mean — the underground-boss lesson a third time (the arrow
      // hit test and the beam corridor both learned it): a body far below
      // the floor can drift horizontally into the cone, and the arc solver
      // will then dutifully compute an absurd vy to reach its "chest"
      // (measured in the fight suite: a test-parked boss at y -500 wandered
      // to point-blank horizontal range and solved vy 54 on an 18 m/s bolt).
      if (e.pos.y < -1 || e.pos.y > 3) continue;
      _bowTo.copy(e.pos).sub(p.pos).setY(0);
      const d = _bowTo.length();
      if (d < 1e-3 || d > bestD) continue;
      if (_bowTo.dot(_bowDir) / d < coneCos) continue;
      best = e;
      bestD = d;
    }
    return best;
  }

  /** Loose one arrow at draw fraction `f` (0 = min draw, 1 = full). */
  _fireBow(w, p, f) {
    const speed = BOW.speedMin + f * (BOW.speedFull - BOW.speedMin);
    const dmg = this.derived.atk * SKILLS.attack.dmg * w.dmgMul
      * (BOW.dmgMin + f * (BOW.dmgFull - BOW.dmgMin));

    // Soft-lock, validated with lineBlocked ONCE at release (the probe's own
    // header forbids per-frame use). A blocked lock falls back to a free shot
    // down the camera line rather than refusing to fire — the string is
    // already loosed and cover is the wall's argument to win, not the UI's.
    let target = this._bowTarget(w);
    if (target && this.world.obstacleField?.lineBlocked(
      p.pos.x, p.pos.z, target.pos.x, target.pos.z, { radius: 0.2, feetY: BOW.launchY },
    )) target = null;

    let vy;
    if (target) {
      _bowDir.copy(target.pos).sub(p.pos).setY(0);
      const D = Math.max(0.5, _bowDir.length());
      _bowDir.normalize();
      // Flat-ish arc to the lock (RPG_SPEC launchElevation): horizontal speed
      // is constant, so flight time is T = D / speed, and vy must both close
      // the height gap to the target's chest and pre-pay the gravity drop:
      // arrival y = y0 + vy*T - g*T^2/2, solve for vy.
      const T = D / speed;
      const chestY = 1.2 * (target.base?.scale || 1);
      // Clamped: at legitimate ranges the solve stays within ~±5, but a
      // point-blank lock divides by a tiny T and the hit sphere already
      // covers the chest there — an arrow leaving near-vertically reads as
      // a misfire, not an aim assist.
      vy = Math.max(-8, Math.min(8, (chestY - BOW.launchY) / T + 0.5 * BOW.gravity * T));
    } else {
      // No lock: a gentle rise down the camera line. The drop numbers in
      // weapons.BOW's comment are exactly what the player learns from here.
      this._camForward(_bowDir);
      vy = speed * BOW.riseVy;
    }
    p.yaw = Math.atan2(_bowDir.x, _bowDir.z);

    // The spec's cap on live player projectiles: reclaim before refusing, so
    // the newest shot always exists and the oldest arrow pays for it.
    if (this.pool.countFlying('arrow') >= BOW.maxLive) this.pool.reclaimOldest('arrow');
    _bowFrom.set(
      p.pos.x + _bowDir.x * 0.45,
      BOW.launchY,
      p.pos.z + _bowDir.z * 0.45,
    );
    const rec = this.pool.spawn({
      from: _bowFrom, dir: _bowDir, vy, g: BOW.gravity, speed,
      damage: dmg, life: BOW.life, kind: 'arrow', color: 0xffe2a8,
      knock: BOW.knock * (w.knockMul || 1), stagger: BOW.stagger,
    });
    // Records are reused: clear the staff stamps a previous life may carry,
    // or a plain arrow would inherit homing and an arcane impact. fullDraw
    // marks the shot for GALESTING ASCENDANT's refund-on-kill.
    if (rec) { rec.staff = false; rec.staffTarget = null; rec.fullDraw = f >= 1 - 1e-6; }

    // Recovery: the machine's cd is the shared gate the HUD already reads.
    p.attack.cd = w.cd;
    p.cds.attack = Math.min(w.cd, SKILLS.attack.cd);
    this.fx.addShake(BOW.shake * (0.5 + f * 0.5));
    // Release twang: pitch falls with draw depth, like a real string.
    this.audio.tone({ freq: 1200 - f * 400, type: 'triangle', gain: 0.12, decay: 0.16, sweep: -300 });
  }

  // ------------------------------------------------------------- the staff
  //
  // RPG_SPEC step 9. The staff runs the SWING MACHINE (unlike the bow): a
  // cast has a windup you commit to, not a string you hold. Step 1's contact
  // frame fires the mana-costing bolt; step 2's opens the channelled beam.
  // Magic bends physics in EXACTLY the two ways the spec names — damage
  // type/effect, and bounded trajectory curvature — see weapons.STAFF.

  /** The bolt: 18 m/s, the arrow's shared g = 9.0, steering capped at 90 deg/s. */
  _fireStaffBolt(w, step) {
    const p = this.player;
    // The cast can outlive its funding: _tryAttack read the bar 0.28 s ago
    // and a skill may have drained it since. A dry cast fizzles visibly
    // instead of casting on credit.
    if (p.mp < STAFF.boltMp) {
      this.ui.toast('NOT ENOUGH MANA');
      this.fx.burst(_staffFrom.copy(p.pos).setY(STAFF.launchY), 4, 0x9db0ff, { speed: 2, up: 1, life: 0.25 });
      return;
    }
    p.mp -= STAFF.boltMp;

    // Same soft-lock affordance as the bow at the staff's 18 m — one learned
    // aiming skill, not two — validated with lineBlocked ONCE at cast (the
    // probe's own header forbids per-frame use). A blocked lock falls back
    // to a free shot down the camera line.
    let target = this._bowTarget(w, STAFF.reach, STAFF.coneCos);
    if (target && this.world.obstacleField?.lineBlocked(
      p.pos.x, p.pos.z, target.pos.x, target.pos.z, { radius: 0.2, feetY: STAFF.launchY },
    )) target = null;

    const speed = STAFF.boltSpeed;
    let vy;
    if (target) {
      _staffDir.copy(target.pos).sub(p.pos).setY(0);
      const D = Math.max(0.5, _staffDir.length());
      _staffDir.normalize();
      // The arrow's solved arc (arrival y = y0 + vy*T - g*T^2/2). The slower
      // bolt makes T longer, so the SAME shared g buys a visibly deeper arc
      // — internally consistent magic, on screen rather than in a tooltip.
      const T = D / speed;
      const chestY = 1.2 * (target.base?.scale || 1);
      // Same clamp as the bow's: the solve is honest at range and silly at
      // point-blank, where the hit sphere already covers the chest.
      vy = Math.max(-8, Math.min(8, (chestY - STAFF.launchY) / T + 0.5 * STAFF.gravity * T));
    } else {
      this._camForward(_staffDir);
      vy = speed * STAFF.riseVy;
    }
    p.yaw = Math.atan2(_staffDir.x, _staffDir.z);

    // The spec's cap on live player projectiles, shared with arrows — both
    // ride the pool's 'arrow' branch (it owns the enemy torso test and the
    // vy/g arc; a bolt must hit ENEMIES, which the 'bolt' branch never does).
    if (this.pool.countFlying('arrow') >= STAFF.maxLive) this.pool.reclaimOldest('arrow');
    _staffFrom.set(
      p.pos.x + _staffDir.x * 0.5,
      STAFF.launchY,
      p.pos.z + _staffDir.z * 0.5,
    );
    const rec = this.pool.spawn({
      from: _staffFrom, dir: _staffDir, vy, g: STAFF.gravity, speed,
      damage: hitDamage(w, step, this.derived.atk * SKILLS.attack.dmg),
      life: STAFF.boltLife, kind: 'arrow', color: 0xb98bff,
      knock: hitKnockback(w, step), stagger: hitStagger(w, step),
    });
    if (rec) {
      // Pooled records are REUSED, so the staff flags are stamped at every
      // spawn site (here, _fireBow, _spawnProjectile) and never trusted from
      // a record's previous life.
      rec.staff = true;
      rec.staffTarget = target || null;
      // HOLLOWLIGHT ASCENDANT (positioning verb): the steering BOUND scales.
      // Stamped at spawn — a bolt keeps the rule it left the crystal with.
      rec.staffTurnMul = this.weapon?.rule?.fx.boltTurnMul || 1;
      // spawn() stamped the Arrow mesh; a bolt is an orb. spawn() re-stamps
      // geometry/material/scale per kind, so a later real arrow reclaims the
      // mesh cleanly and nothing here leaks into other spawns.
      rec.mesh.geometry = this._staffOrbGeo;
      rec.mesh.material = this._staffOrbMat;
      rec.mesh.scale.setScalar(1);
    }
    // Cast flash at the head (the atlas's stated cast-flash sprite) + note.
    this.fx.flash(_staffFrom, 'magic_01', { size: 1.0, life: 0.22, color: w.tint });
    if (step.shake) this.fx.addShake(step.shake);
    this.audio.tone({ freq: 620, type: 'sine', gain: 0.10, decay: 0.18, sweep: 240 });
  }

  /** Arcane impact — the pool's onRemove funnels EVERY bolt death here. */
  _staffImpact(pos) {
    this.fx.burst(pos, 8, 0xb98bff, { speed: 4, up: 1.5, life: 0.3 });
    this.fx.flash(pos, 'magic_04', { size: 1.3, life: 0.28, color: 0xb98bff });
  }

  /**
   * The finisher's channel opens on the machine's own contact frame.
   * familyTable: "roots to move 0.20 while held, up to 1.6 s, costing mana
   * per tick". Tick 1 fires NOW with the finisher's full knock/stagger;
   * later ticks are damage only, so the beam pins rather than juggles.
   */
  _beginStaffBeam(w, step) {
    if (this.player.mp < STAFF.beam.mpPerTick) {
      this.ui.toast('NOT ENOUGH MANA');
      return;
    }
    this._staffBeam = { w, step, t: 0, tickT: 0, ticks: 0, cut: STAFF.beam.range };
    this._staffBeamTick(true);
    this.audio.tone({ freq: 240, type: 'sawtooth', gain: 0.08, decay: 0.3 });
  }

  /** One beam tick: mana, wall cut, corridor damage, impact FX. */
  /** What the NEXT beam tick costs, honouring EMBERSTAVE ASCENDANT (resource-
   *  flow verb): ticks past beamCheapT cost beamCostMul of the base — a long
   *  channel is cheaper per second than a short one. Base cost on every
   *  instance without the rule. */
  _beamTickCost(b) {
    const fx = b?.w?.rule?.fx;
    if (fx?.beamCheapT != null && b.t > fx.beamCheapT) return STAFF.beam.mpPerTick * (fx.beamCostMul || 1);
    return STAFF.beam.mpPerTick;
  }

  _staffBeamTick(first) {
    const b = this._staffBeam;
    const p = this.player;
    if (!b) return;
    p.mp -= this._beamTickCost(b);
    b.ticks++;
    // Beam axis is the player's facing — yaw tracks the camera while the
    // channel holds (same rule as a drawn bowstring), so the beam goes where
    // the player is looking.
    this._forward(p.yaw, _staffDir);
    // Wall cut: march blocked() out to range in 1 m steps at chest height.
    // ~9 scalar broadphase checks, 5 times a second — nowhere near the
    // per-frame use lineBlocked's header forbids.
    const field = this.world?.obstacleField;
    let cut = STAFF.beam.range;
    if (field) {
      for (let d = 1; d <= STAFF.beam.range; d += 1) {
        if (field.blocked(p.pos.x + _staffDir.x * d, p.pos.z + _staffDir.z * d, 0.25, 0, STAFF.beam.feetY)) {
          cut = d - 0.5;
          break;
        }
      }
    }
    b.cut = cut;
    const dmg = hitDamage(b.w, b.step, this.derived.atk * SKILLS.attack.dmg);
    // Snapshot: _damageEnemy splices the dead out of this.enemies.
    for (const e of [...this.enemies]) {
      if (e.hp <= 0) continue;
      // The corridor test is horizontal, so guard the vertical band the beam
      // actually occupies — the arrow branch's underground-boss lesson (a
      // test-parked body at y -500 must not eat a chest-height beam).
      if (e.pos.y < -1 || e.pos.y > 3) continue;
      _staffTo.copy(e.pos).sub(p.pos).setY(0);
      const along = _staffTo.dot(_staffDir);
      if (along < 0.5 || along > cut + e.radius) continue;
      const px = _staffTo.x - _staffDir.x * along;
      const pz = _staffTo.z - _staffDir.z * along;
      if (Math.hypot(px, pz) > STAFF.beam.halfWidth + e.radius * 0.5) continue;
      this._damageEnemy(e, dmg, {
        knockback: first ? hitKnockback(b.w, b.step) : 0,
        stagger: first ? hitStagger(b.w, b.step) : 0.05,
        from: p.pos,
      });
    }
    // Tick FX at the far end, where the beam lands.
    _staffTo.copy(p.pos).addScaledVector(_staffDir, cut).setY(1.1);
    this.fx.flash(_staffTo, 'spark_06', { size: 0.9, life: 0.18, color: 0xc9a6ff });
    this.fx.burst(_staffTo, 3, 0xb98bff, { speed: 3, up: 1, life: 0.22, gravity: -3 });
  }

  /** Per-frame channel upkeep + the beam's visual. Called after tickAttack. */
  _updateStaffBeam(dt) {
    const b = this._staffBeam;
    if (!b) return;
    const p = this.player;
    b.t += dt;
    b.tickT += dt;
    // Ends on release, on the 1.6 s ceiling, or when the NEXT due tick
    // cannot be funded — the channel stops rather than overdrafting.
    if (!this.input.isHeld('attack') || b.t >= STAFF.beam.maxT
        || (b.tickT >= STAFF.beam.tick && p.mp < this._beamTickCost(b))) {
      return this._endStaffBeam();
    }
    if (b.tickT >= STAFF.beam.tick) {
      b.tickT -= STAFF.beam.tick;
      this._staffBeamTick(false);
    }
    // Present: staff head to the wall cut, refreshed every frame (the fx
    // beam auto-hides the frame this stops arriving).
    this._forward(p.yaw, _staffDir);
    _staffFrom.copy(p.pos).setY(STAFF.launchY).addScaledVector(_staffDir, 0.4);
    _staffTo.copy(p.pos).addScaledVector(_staffDir, b.cut).setY(1.1);
    this.fx.beam(_staffFrom, _staffTo, 0xb98bff);
  }

  _endStaffBeam() {
    if (!this._staffBeam) return;
    this._staffBeam = null;
    this.fx.beamHide();
  }

  _tryDash() {
    const p = this.player;
    if (p.cds.dash > 0) return;
    // Committed means committed: while the current step's lock window runs,
    // the swing owns you and no escape is sold. This one refusal is most of
    // what "weight" means — a greataxe's lock is its whole step, a dagger's
    // is only its 0.075 s windup.
    if (this.weapon && isCommitted(p.attack, this.weapon)) return;
    // A dash is the channel's escape hatch: the beam's lock is only its
    // step's 0.36 s, so once that clears the player may buy their way out of
    // the root — the beam just stops paying out.
    this._endStaffBeam();
    // sampleWorld, not sample: a dash aimed with the stick must go where the
    // stick points ON SCREEN, whatever the camera yaw happens to be.
    const mv = this.input.sampleWorld();
    const dir = (mv.x || mv.z)
      ? tmpV.set(mv.x, 0, mv.z).normalize()
      : this._forward(p.yaw, tmpV);
    // Authored in world units; the body solves the impulse that travels it.
    const v0 = p.body.impulseForDistance(SKILLS.dash.distance);
    p.body.addImpulse(dir.x * v0, 0, dir.z * v0);
    p.yaw = Math.atan2(dir.x, dir.z);
    p.invuln = Math.max(p.invuln, SKILLS.dash.iframes);
    p.dashTimer = 0.26;
    // A hit i-framed within this window of the dash START is a PERFECT dodge
    // (_damagePlayer's invuln branch) — derived.dodgeWindow finally consumed.
    p._dodgeT = this.derived.dodgeWindow;
    // derived.dashCd is SKILLS.dash.cd exactly until the issue 4pc (-0.25 s).
    p.cds.dash = this.derived.dashCd;
    this.audio.dash();
    this.fx.burst(p.pos.clone().setY(0.7), 16, 0x9dd8ff, { speed: 4, up: 2, life: 0.4 });
  }

  _trySlash() {
    const p = this.player;
    const sk = SKILLS.slash;
    if (p.cds.slash > 0) return;
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`RUIN UNLOCKS AT LEVEL ${sk.unlockLevel}`);
    if (p.mp < sk.mp) return this.ui.toast('NOT ENOUGH MANA');
    // A skill cast takes both hands; the channel ends first.
    this._endStaffBeam();
    p.mp -= sk.mp;
    p.cds.slash = sk.cd;
    // Visual arm-swing only — the skill applies its own damage immediately and
    // never enters the weapon machine.
    p.skillSwing = 0.3;
    this._faceNearest(sk.range);

    const hits = this._coneTargets(p.pos, p.yaw, sk.range, sk.arc);
    hits.forEach((e) => this._damageEnemy(e, this.derived.atk * sk.dmg * this.derived.skillMul, {
      knockback: 7, stagger: 0.35, from: p.pos,
    }));

    // Draw the cleave as a flat arc of shards sweeping outward.
    const fwd = this._forward(p.yaw);
    for (let i = 0; i < 22; i++) {
      const a = p.yaw - sk.arc / 2 + (sk.arc * i) / 21;
      tmpV2.set(Math.sin(a), 0, Math.cos(a)).multiplyScalar(sk.range * (0.35 + Math.random() * 0.65));
      tmpV2.add(p.pos).setY(0.9);
      this.fx.burst(tmpV2, 3, 0xb98bff, { speed: 5, up: 2, life: 0.45, gravity: -3 });
    }
    this.fx.addShake(0.35);
    this.audio.skill();
    void fwd;
  }

  _tryNova() {
    const p = this.player;
    const sk = SKILLS.nova;
    if (p.cds.nova > 0) return;
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`NOVA UNLOCKS AT LEVEL ${sk.unlockLevel}`);
    if (p.mp < sk.mp) return this.ui.toast('NOT ENOUGH MANA');
    // A skill cast takes both hands; the channel ends first.
    this._endStaffBeam();
    p.mp -= sk.mp;
    p.cds.nova = sk.cd;

    const r = sk.radius;
    // Snapshot: _damageEnemy can splice the dead out of this.enemies, and
    // mutating the array being iterated made Nova silently skip targets.
    [...this.enemies].forEach((e) => {
      const d = e.pos.distanceTo(p.pos);
      if (d < r) {
        // Falloff keeps point-blank Nova meaningfully stronger than the fringe.
        const falloff = 1 - (d / r) * 0.45;
        this._damageEnemy(e, this.derived.atk * sk.dmg * this.derived.skillMul * falloff, {
          knockback: 14, stagger: 0.7, from: p.pos,
        });
      }
    });
    // Nova also wipes incoming projectiles — a genuine panic button. Bolts
    // only: the player's own arrows are not "incoming", and popping a stuck
    // arrow out of the floor because you panicked reads as a bug.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      if (pr.kind === 'bolt' && pr.pos.distanceTo(p.pos) < r) this._removeProjectile(i);
    }

    this.fx.ring(p.pos, 0x9dd8ff, r * 1.1, 0.55);
    this.fx.ring(p.pos, 0xffffff, r * 0.7, 0.4);
    this.fx.burst(p.pos.clone().setY(1), 70, 0x9dd8ff, { speed: 15, up: 6, life: 1, spread: 2 });
    this.fx.addShake(0.85);
    this.fx.addHitStop(0.08);
    this.audio.nova();
    p.invuln = Math.max(p.invuln, 0.3);
  }

  // Extraction is free — the cost is the corpse decaying and the three-attempt
  // limit, not mana. A failed attempt burns one of the three and leaves the
  // corpse standing, so Bind is a gamble you can press again, not a tax.
  _trySummon() {
    const p = this.player;
    const sk = SKILLS.summon;
    if (p.cds.summon > 0) return;
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`BIND UNLOCKS AT LEVEL ${sk.unlockLevel}`);

    const room = this.fieldCapacity() - this.shadows.length;
    if (room <= 0) return this.ui.toast('YOUR COMPANY IS AT FULL STRENGTH');

    const inRange = this.corpses.filter((c) => (
      c.attempts < MAX_EXTRACT_ATTEMPTS && c.pos.distanceTo(p.pos) < 14
    ));
    if (inRange.length === 0) return this.ui.toast('NO FALLEN NEARBY');

    p.cds.summon = sk.cd;
    let raised = 0;
    let failed = 0;
    let rosterFull = false;

    for (const c of inRange.slice(0, room)) {
      const chance = extractionChance(this.save, {
        enemyLevel: c.enemyLevel,
        tierWeight: c.tierWeight,
        secondsSinceDeath: CORPSE_WINDOW - c.life,
        attemptIndex: c.attempts,
        // A worn Taker's Chain rides on the PER term — the trinket's one
        // exotic effect (RPG_SPEC equipmentSlots.trinket).
        extractAdd: this._armorBonus?.extractAdd || 0,
      });
      c.attempts++;
      if (Math.random() >= chance) {
        failed++;
        this.fx.burst(c.pos.clone().setY(0.9), 8, 0x35e6ff, { speed: 3, up: 2, life: 0.3 });
        continue;
      }
      const rec = makeShadow(this.save, { type: c.type, level: c.enemyLevel, creature: c.creature });
      const { added } = addShadow(this.save, rec);
      if (!added) { rosterFull = true; break; }
      this._spawnShadow(c.pos.clone(), false, rec);
      raised++;
      this.scene.remove(c.mesh);
      disposeObject3D(c.mesh);
      const i = this.corpses.indexOf(c);
      if (i >= 0) this.corpses.splice(i, 1);
    }

    this.audio.bind();
    this.fx.ring(p.pos, 0x35e6ff, 14, 0.7);
    if (rosterFull) this.ui.toast('YOUR ARMY WILL HOLD NO MORE', 'danger');
    else if (raised > 0) this.ui.toast(`BIND  ·  ${raised} CINDERBOUND RAISED`, 'gold');
    else this.ui.toast(`BIND FAILED  ·  ${failed} RESISTED`);
    this.onSave();
  }

  // ------------------------------------------------------------ helpers
  _forward(yaw, out = new THREE.Vector3()) {
    return out.set(Math.sin(yaw), 0, Math.cos(yaw));
  }

  _coneTargets(origin, yaw, range, arc) {
    const fwd = this._forward(yaw);
    return this.enemies.filter((e) => {
      const d = tmpV2.copy(e.pos).sub(origin).setY(0);
      const dist = d.length();
      if (dist > range + e.radius) return false;
      if (dist < 0.001) return true;
      d.divideScalar(dist);
      return d.dot(fwd) > Math.cos(arc / 2);
    });
  }

  _nearestEnemy(from, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const e of this.enemies) {
      const d = e.pos.distanceTo(from);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  _faceNearest(maxDist) {
    const t = this._nearestEnemy(this.player.pos, maxDist);
    if (!t) return;
    const d = tmpV.copy(t.pos).sub(this.player.pos);
    this.player.yaw = Math.atan2(d.x, d.z);
  }

  /**
   * Fire a bolt from `from` toward `target`.
   *
   * THE SPAWN HEIGHT IS NOT THE CALLER'S TO CHOOSE. The direction is flattened
   * (`.setY(0)`) so a bolt keeps its birth height for its whole life, and the
   * player hit test below is a 1.1 m sphere centred at y 1.2 — so a caller that
   * spawns off the bolt plane fires a shot that can never connect at any range.
   * That is exactly what the boss's spread shot did: it spawned at y 2.4, and
   * 2.4 - 1.2 = 1.20 m > 1.1 m missed by 10 cm on every bolt, at every standoff
   * from 4 to 14 m, in both ranks and both phases (measured: 0 damage over 10
   * trials while 6-9 bolts flew per volley). Stamping config.PROJECTILE_Y here
   * makes that class of bug unrepresentable rather than merely fixed once.
   */
  _spawnProjectile(from, target, damage, color, speed = 16) {
    // Pooled since RPG_SPEC step 8: no geometry, no material and — new — no
    // PointLight per shot (twelve bolts used to be twelve dynamic lights; the
    // glow layer carries the read now). The pool COPIES both vectors, so the
    // per-shot dir.clone() the old code paid is gone too. Trajectory maths are
    // otherwise untouched: flat dir, g = 0, vy = 0, which the pool integrates
    // byte-identically to the loop this replaced.
    _projFrom.copy(from).setY(PROJECTILE_Y);
    _projDir.copy(target).sub(_projFrom).setY(0).normalize();
    const rec = this.pool.spawn({
      from: _projFrom, dir: _projDir, speed, damage, color, life: 4, kind: 'bolt',
    });
    // Records are reused: an enemy bolt must not inherit a previous staff
    // bolt's homing target or arcane impact stamp.
    if (rec) { rec.staff = false; rec.staffTarget = null; }
  }

  _removeProjectile(i) {
    // The pool's onRemove hook plays the shipped removal burst; the record and
    // its mesh go back to the pool instead of being disposed (disposal per
    // removal is the shader-recompile tax the pool exists to end).
    this.pool.releaseAt(i, 'manual');
  }

  // --------------------------------------------------------------- loop
  update(rawDt) {
    const dt = Math.min(rawDt, 0.05);
    this.time += dt;
    this._frameDt = dt;
    // ONE tick site for every mode and for no mode at all. WORLD_SPEC describes
    // each mode ticking its own clock; a single call here is the same behaviour
    // with one fewer way to get it wrong — two modes mounted during a handover
    // would otherwise double the day length, and nothing would report it.
    // Deliberately outside the `state === 'playing'` gate: time passes while a
    // menu is up, which is what makes the hub feel like a place.
    this.worldClock.tick(dt);
    // Atmosphere runs behind a pause, exactly as `this.world.update(dt)` did
    // when it sat here unconditionally.
    this._mode?.updateAlways(dt);
    this.fx.update(dt);

    if (this.state === 'playing') {
      // Hit-stop briefly freezes simulation for weight on impacts; a level-up
      // dilates time for a moment so the moment actually registers.
      let step = this.fx.hitStop > 0 ? dt * 0.12 : dt;
      if (this.levelUpDilation > 0) {
        this.levelUpDilation = Math.max(0, this.levelUpDilation - dt);
        step *= 0.35;
      }
      this._mode?.update(step, rawDt);
      // ONE call site for both modes. CityMode runs its own player update and
      // DungeonMode runs _updatePlayer, so putting the stow policy in either
      // would leave the sword permanently drawn in the other half of the game.
      this._updateStance(step);
    }

    if (this._mode) this._mode.updateCamera(dt);
    else this._updateCamera(dt);
    this.input.endFrame();
    this.glow.render(this.scene, this.camera);
    this.quality.update(rawDt);
  }

  /**
   * One in-gate frame. This is the block that used to live inline in update()
   * — same calls, same order, same dt. `runTime` deliberately advances on the
   * UNSCALED frame time, as it always has, so hit-stop does not slow the clock.
   */
  _updateDungeonFrame(dt) {
    this.runTime += this._frameDt;
    this._updatePlayer(dt);
    this._updateEnemies(dt);
    this._updateShadows(dt);
    this._updateProjectiles(dt);
    this._updateCorpses(dt);
    this._updatePickups(dt);
    this._updateSpawns(dt);
    this.ui.updateHud(this);
  }

  _updatePlayer(dt) {
    const p = this.player;
    if (!p.alive) {
      // Dead: only the Death clip still runs (animateRig routes a dead skinned
      // character straight to its mixer; the procedural rig ignores this).
      // A channel does not survive its caster.
      this._endStaffBeam();
      animateRig(p.mesh, { moving: false, speed: 0, t: this.time, dt });
      return;
    }
    const d = this.derived;

    // cooldowns
    for (const k of Object.keys(p.cds)) if (p.cds[k] > 0) p.cds[k] = Math.max(0, p.cds[k] - dt);
    if (p.invuln > 0) p.invuln -= dt;
    if (p.hurt > 0) p.hurt -= dt;
    if (p.dashTimer > 0) p.dashTimer -= dt;
    if (p._dodgeT > 0) p._dodgeT -= dt;
    if (p.skillSwing > 0) p.skillSwing = Math.max(0, p.skillSwing - dt);

    // issue 5pc: the ward re-arms on ROOM ENTRY, which is a room-id change —
    // the dungeon's roomAt is the same lookup the encounter director runs per
    // frame, and the arena world has no roomAt so the whole gate is one room
    // (armed once, by _beginGate). Corridors return -1 and change nothing, so
    // stepping out and back into the SAME room does not re-arm it.
    if (this._rules?.size && this._rules.has('first_hit_ward') && this.world?.roomAt) {
      const rid = this.world.roomAt(p.pos.x, p.pos.z);
      if (rid >= 0 && rid !== this._wardRoomId) {
        this._wardRoomId = rid;
        this._wardReady = true;
      }
    }

    // regen
    p.hp = Math.min(d.maxHp, p.hp + d.hpRegen * dt);
    p.mp = Math.min(d.maxMp, p.mp + d.mpRegen * dt);

    // input. A fresh press always goes in (startAttack buffers it if the step
    // is not cancelable yet); a held button or a ripe buffer only fires once
    // the machine says the next step would actually start.
    const w = this.weapon;
    // The bow has NO melee arc at all (RPG_SPEC weaponFamilies.bow): the same
    // attack button becomes draw-hold-release and the swing machine stays
    // idle. No new input, no new camera mode — the spec's soft-lock answer.
    const ranged = Boolean(w?.arch?.ranged);
    if (ranged) {
      this._updateBow(dt, w, p);
    } else if (this._staffBeam) {
      // The held button IS the channel. Eat any press edge so a release and
      // re-press inside one frame cannot double-start a step while the beam
      // is still deciding whether it ended.
      this.input.consume('attack');
    } else {
      // Live hold flag for chargeable steps (the greatsword finisher):
      // refreshed every frame BEFORE tickAttack so the machine sees this
      // frame's truth. Steps without a charge clause ignore it entirely.
      p.attack.charging = this.input.isHeld('attack');
      if (this.input.consume('attack')
        || ((this.input.isHeld('attack') || p.attack.buffered) && w && canAttack(p.attack, w))) {
        consumeBuffer(p.attack);
        this._tryAttack();
      }
    }
    if (this.input.consume('dash')) this._tryDash();
    if (this.input.consume('slash')) this._trySlash();
    if (this.input.consume('nova')) this._tryNova();
    if (this.input.consume('summon')) this._trySummon();

    // swing timing — the machine advances phases and fires _applySwingHit once
    // per damage application (the dagger finisher makes two).
    if (w) tickAttack(p.attack, w, dt, this._onSwingHit);
    // The staff's channel outlives its machine step by design — the step is
    // the CAST, the channel is what the hold buys after it.
    this._updateStaffBeam(dt);
    // HUD mirror for the skill-button wipe; the machine's cd is the real gate.
    // Clamped to SKILLS.attack.cd because ui.js divides by that constant for
    // the wipe height — a maul's 1.05 s cd would scale the wipe to 2.6x the
    // button. A heavy weapon's wipe therefore sits full a moment longer
    // instead of overflowing, which is the honest read at a glance anyway.
    p.cds.attack = Math.min(p.attack.cd, SKILLS.attack.cd);
    // Combo readout clears when the chain window lapses back to the opener.
    if (this._comboShown && !p.attack.active && p.attack.next === 0) {
      this._comboShown = 0;
      this.ui.setCombo(0);
    }

    // movement — the body owns integration, collision and ground contact
    const body = p.body;
    body.maxSpeed = d.speed;
    if (this.input.consume('jump')) body.jump();
    body.setJumpHeld(this.input.isHeld('jump'));

    // World-space stick: rotated through the camera yaw so orbiting can never
    // invert the controls. With the camera untouched this is (x, -y) exactly.
    const mv = this.input.sampleWorld();
    const moving = Math.abs(mv.x) > 0.01 || Math.abs(mv.z) > 0.01;
    // moveScale is the per-step movement penalty (a maul finisher nearly roots
    // you at 0.04); idle it returns the instance's own moveMul, so a light
    // weapon's mobility bonus is finally a real number rather than a tooltip.
    // A drawn bowstring overrides both: the familyTable's 0.45 is absolute
    // ("0.45 while drawing, 0.85 otherwise") — the draw is the commitment
    // this family pays instead of a lock window.
    const drawing = Boolean(this._bowState?.drawing);
    // The staff's channel roots harder than any step: familyTable's "roots
    // to move 0.20 while held" is absolute, like the bow's 0.45 while
    // drawing — the root is the commitment this finisher charges.
    const channeling = Boolean(this._staffBeam);
    body.move(mv.x, mv.z,
      channeling ? STAFF.beam.move
        : drawing ? BOW.moveDrawing : (w ? moveScale(p.attack, w) : 1));

    if (drawing || channeling) {
      // Aiming is LOOKING: while the string is back (or the beam is lit) the
      // body tracks the camera bearing, so the shot leaves along what the
      // player sees and the soft-lock cone is centred on the same line.
      const aim = drawing ? _bowDir : _staffDir;
      this._camForward(aim);
      const targetYaw = Math.atan2(aim.x, aim.z);
      let diff = targetYaw - p.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      p.yaw += diff * Math.min(1, dt * 12);
    } else if (moving && !p.attack.active) {
      // Turn toward the stick, shortest way around.
      const targetYaw = Math.atan2(mv.x, mv.z);
      let diff = targetYaw - p.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      p.yaw += diff * Math.min(1, dt * 16);
    }

    body.step(dt);
    const sp = body.groundSpeed;

    if (body.justLanded && body.landSpeed > 6) {
      // Only a real drop gets a thump; stepping off a kerb should be silent.
      this.fx.burst(p.pos.clone().setY(0.3), 10, 0x9dd8ff, { speed: 3, up: 1.4, life: 0.35 });
      this.fx.addShake(Math.min(0.35, body.landSpeed * 0.02));
      this.audio.noise({ gain: 0.1, decay: 0.14, filter: 700 });
    }

    // dash trail
    if (p.dashTimer > 0 && Math.random() < 0.7) {
      this.fx.burst(p.pos.clone().setY(0.6), 2, 0x9dd8ff, { speed: 1, up: 0.5, life: 0.3, gravity: -1 });
    }

    // present
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = p.yaw;
    p.mesh.visible = !(p.invuln > 0 && p.dashTimer <= 0 && Math.floor(this.time * 22) % 2 === 0);
    // attackAnim hands over everything the pose needs: phase 1 -> 0 across the
    // step, the contact frame at the REAL windup fraction (0.17/0.34 = 0.5 for
    // the sword opener — the exact number the old hardcoded 0.5 encoded), and
    // the archetype's shoulder curve so an axe winds further back than a
    // dagger. The Ruin skill's visual swing rides the same channel when the
    // machine is idle.
    const anim = w ? attackAnim(p.attack, w) : null;
    const machineSwinging = Boolean(anim && anim.phase > 0);
    animateRig(p.mesh, {
      moving, speed: sp, t: this.time,
      attackPhase: machineSwinging ? anim.phase : (p.skillSwing > 0 ? p.skillSwing / 0.3 : 0),
      // The skinned rig warps its slash clip so the blade connects on exactly
      // the frame tickAttack applies the damage.
      attackContact: machineSwinging ? anim.windup : 0.5,
      // Procedural box-man swing curve, per archetype. Defaults inside
      // animateRig reproduce the old hardcoded sword arc exactly.
      swingContact: machineSwinging ? anim.windup : 0.3,
      swingLo: anim?.lo, swingHi: anim?.hi, swingTwist: anim?.twist,
      twoHand: anim?.twoHand ?? false,
      mirror: anim?.mirror ?? false,
      // The combo step picks the clip (slash restart-offsets, punches and
      // kicks alternate) so mashing does not replay one pose from frame 0.
      combo: p.attack.active ? p.attack.index + 1 : (this._comboShown || 0),
      // Dash is dressed as the pack's Roll; the 0.26 matches p.dashTimer's
      // start value in _tryDash. Purely visual — i-frames are p.invuln's.
      dashPhase: p.dashTimer > 0 ? p.dashTimer / 0.26 : 0,
      hurt: Math.max(0, p.hurt),
      airborne: !p.body.grounded,
      riseRate: p.vel.y,
      // The time-scaled dt, so hit-stop and level-up dilation slow the
      // AnimationMixer too. Without it the mixer reads wall-clock and skinned
      // characters keep moving at full speed through a freeze frame.
      dt,
    });
  }

  /**
   * Real wall line-of-sight for ranged/flank agents (DUNGEON_SPEC EDIT 5).
   * Sampled through obstacleField.lineBlocked at torso height, throttled to
   * the agents' shared probe cadence (0.4 s) with the result stashed on the
   * agent — a per-frame segment walk for every caster on the field is exactly
   * the kind of quiet cost the phone frame budget cannot absorb. Melee agents
   * skip it entirely: losBlocked only gates standoff/strafe decisions, and
   * out-of-range agents are approaching anyway.
   */
  _agentLosBlocked(e, dist, dt) {
    const a = e.agent;
    if (!a || (a.behavior !== 'ranged' && a.behavior !== 'flank')) return false;
    if (a.losT === undefined) { a.losT = 0; a.losBlocked = false; }
    a.losT -= dt;
    if (a.losT <= 0) {
      a.losT = 0.4;
      // feetY is the BOLT PLANE (config.PROJECTILE_Y), not an arbitrary torso
      // height: the question this probe answers is "would my shot survive the
      // trip", so it has to be asked at the height the shot travels at.
      a.losBlocked = dist <= a.range
        && Boolean(this.world.obstacleField?.lineBlocked(
          e.pos.x, e.pos.z, this.player.pos.x, this.player.pos.z, { feetY: PROJECTILE_Y }));
    }
    return a.losBlocked;
  }

  /**
   * Distance LOD for one skinned entity (enemy, boss or bound shadow).
   *
   * Two decisions, both keyed on plan distance to the PLAYER rather than to the
   * camera: the camera is rigidly anchored to the player indoors, and player
   * distance is the number every other range in this file already uses.
   *
   * Returns the dt animateRig should be given, or 0 for "skip the rig this
   * frame" — the caller must not fall back to its own dt, because the skipped
   * time is being accumulated for the next tick.
   *
   * @param {object} e         entity with .pos and .mesh
   * @param {number} dt         frame delta
   * @param {boolean} canCast   false for bound shadows — characters.js already
   *   builds a ghost body with castShadow off (a translucent silhouette casting
   *   a hard shadow reads as a bug), and creatures.js did NOT, so the army was
   *   half-casting depending on which pack backed it. This settles it on the
   *   ghost's side for both, which is also one depth pass saved per soldier.
   * @returns {number}   dt to animate with, or 0 to skip
   */
  _entityLod(e, dt, canCast = true) {
    const dx = e.pos.x - this.player.pos.x;
    const dz = e.pos.z - this.player.pos.z;
    const dsq = dx * dx + dz * dz;

    // Cache the shadow-casting meshes once. Traversing a 62-bone skinned root
    // every frame to find its two meshes is exactly the kind of per-frame cost
    // this method exists to remove.
    if (!e._lodMeshes) {
      const meshes = [];
      e.mesh.traverse((o) => { if (o.isMesh && !o.isDecal) meshes.push(o); });
      e._lodMeshes = meshes;
      // The telegraph mote is a separate mesh AND a glow-layer draw, so it is
      // two draw calls per body — the single most expensive 132 triangles in
      // the game. It exists to be READ (eyes flaring = a strike is coming), and
      // there is nothing to read at 14 m under fog that starts at 13, so it
      // goes away with the shadow. rig.eyeL/eyeR both point at it (entities.js
      // aliases them), and game.js's flare writes .scale, not .visible, so the
      // two never fight.
      e._lodMote = e.mesh.userData.character?.eyes || null;
    }
    // Written every frame rather than on change: setCharacterQuality rewrites
    // castShadow across every live instance whenever the governor steps a tier,
    // and a cached "already correct" flag would silently lose to it.
    const near = e.isBoss || dsq < LOD_CAST_RANGE_SQ;
    const cast = canCast && this.quality.current.shadows && near;
    for (const m of e._lodMeshes) m.castShadow = cast;
    if (e._lodMote) e._lodMote.visible = near;

    e._rigLag = (e._rigLag || 0) + dt;
    // The boss is never throttled: it is one body and it is the thing the
    // player is reading.
    if (!e.isBoss && dsq > LOD_RIG_RANGE_SQ && e._rigLag < LOD_RIG_INTERVAL) return 0;
    const lag = e._rigLag;
    e._rigLag = 0;
    return lag;
  }

  _updateEnemies(dt) {
    const p = this.player;
    // GRAVEMAUL ASCENDANT: the crater decays here, once, whatever spawned it.
    if (this._crater && (this._crater.t -= dt) <= 0) this._crater = null;
    // Crowd separation happens once for the whole field, BEFORE anyone moves.
    // Doing it per-enemy after the move loop (the old _separate) left mesh
    // positions a frame behind the separated pos.
    //
    // 1.8, not the old 1.0. radiusScale multiplies (a.radius + b.radius), so 1.0
    // means "just barely not intersecting": two grunts (r 0.55) settle 1.1 m
    // apart and a pack of six collapses into a ~3 m pillar on whichever side of
    // the player it arrived from. That is what made the first density
    // screenshots of this wave read as an EMPTY room with a clump in it — the
    // enemies were there, they were just all standing in the same place.
    //
    // At 1.8 the same two grunts hold 2.0 m and six of them occupy a ~7 m arc:
    // a ring rather than a pillar, with gaps a 7.5 m dash can actually go
    // through, which is the whole reason the rooms were made dash-sized. Bosses
    // benefit most — a scale-2.5 boss (r 1.5) now keeps its adds 3.7 m off, so
    // it is never buried inside its own pack.
    separate(this.enemies, 1.8, 900);
    // Axe bleed ticks in their own REVERSE indexed pass, before the main
    // for..of below: a bleed tick can kill, _killEnemy splices this.enemies,
    // and splicing the current element out from under a live for..of iterator
    // silently skips the next enemy for a frame.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!(e.bleedT > 0)) continue;
      e.bleedT -= dt;
      e.bleedAcc += e.bleedDps * dt;
      // Whole points only, banked until they exist — hp stays integer-ish and
      // the numbers popup never shows a 0.
      if (e.bleedAcc >= 1) {
        const n = Math.floor(e.bleedAcc);
        e.bleedAcc -= n;
        e.hp -= n;
        e.bleedShown = (e.bleedShown || 0) + n;
        e.hurt = Math.max(e.hurt, 0.15);
      }
      // Throttled readout: one small number per half second per bleeder, not
      // one per tick — sixty popups a second is noise, not information.
      e.bleedNumT = (e.bleedNumT || 0) - dt;
      if (e.bleedNumT <= 0 && (e.bleedShown || 0) > 0 && e.hp > 0) {
        tmpV.copy(e.pos).setY(1.1 * (e.base.scale || 1));
        this.fx.damageNumber(tmpV, e.bleedShown, '');
        e.bleedShown = 0;
        e.bleedNumT = 0.5;
      }
      if (e.bleedT <= 0) { e.bleedT = 0; e.bleedStacks = 0; e.bleedDps = 0; e.bleedAcc = 0; }
      if (e.hp <= 0) this._killEnemy(e);
    }
    for (const e of this.enemies) {
      if (e.spawning > 0) {
        e.spawning -= dt;
        const k = 1 - Math.max(0, e.spawning) / (e.isBoss ? 1.2 : 0.55);
        e.mesh.position.y = THREE.MathUtils.lerp(e.isBoss ? -6 : -3, 0, k);
        e.mesh.position.x = e.pos.x;
        e.mesh.position.z = e.pos.z;
        continue;
      }
      if (e.hurt > 0) e.hurt -= dt;
      if (e.stagger > 0) { e.stagger -= dt; }
      if (e.attackCd > 0) e.attackCd -= dt;
      if (e.attack) {
        // Armed humanoids swing through the state machine (npcStrikeWeapon:
        // windup = the steerAgent telegraph, active 0, recovery 0.3), which
        // fires _enemyStrike on the exact frame the old countdown did. The
        // telegraph/swing fields stay maintained as MIRRORS because everything
        // downstream — eye flare, movement gating, yaw freeze, the animation
        // span, the fight suite — reads them, and none of that should care how
        // the clock is kept. Deliberately unconditional, like the old
        // decrement: stagger interrupts steering, not a strike already wound.
        tickAttack(e.attack, e.strikeW, dt, this._onNpcHit, e);
        if (e.attack.active) {
          const st = e.strikeW.combo[0];
          e.telegraph = Math.max(0, st.windup - e.attack.t);
          e.swing = e.attack.t >= st.windup ? Math.max(0, st.windup + st.recovery - e.attack.t) : 0;
        } else {
          e.telegraph = 0;
          // Leave e.swing to its own decay: the shadow-aggro swipe below sets
          // it directly without entering the machine.
          if (e.swing > 0) e.swing -= dt;
        }
      } else {
        // Unarmed (casters, howlers) and the boss keep the plain countdown —
        // a cast and a boss pattern are not weapon swings.
        if (e.telegraph > 0) {
          e.telegraph -= dt;
          if (e.telegraph <= 0) this._enemyStrike(e);
        }
        if (e.swing > 0) e.swing -= dt;
      }

      const toPlayer = _aimDir.copy(p.pos).sub(e.pos).setY(0);
      const dist = toPlayer.length();
      if (dist > 0.001) toPlayer.divideScalar(dist);

      const staggered = e.stagger > 0;
      // Steering output, in world units. The old code carried a scalar
      // `desiredSpeed` along toPlayer, which cannot express a detour.
      let moveX = 0, moveZ = 0;

      if (e.isBoss) {
        this._bossBrain(e, dt, dist, toPlayer);
        if (e.telegraph > 0 || staggered) { moveX = 0; moveZ = 0; }
        else {
          if (!e.agent) { e.agent = makeAgent(e, 'chase'); e.agent.range = 0; }
          _steerCtx.navGrid = this.world.navGrid || null;
          _steerCtx.targetPos = p.pos; _steerCtx.selfPos = e.pos;
          _steerCtx.distance = dist; _steerCtx.losBlocked = false;
          _steerCtx.aggression = 1; _steerCtx.dt = dt;
          const bsteer = steerAgent(e.agent, _steerCtx, dt);
          moveX = bsteer.moveX; moveZ = bsteer.moveZ;
        }
      } else if (!staggered && e.telegraph <= 0) {
        if (!e.agent) e.agent = makeAgent(e, e.base.ai);
        _steerCtx.navGrid = this.world.navGrid || null;
        _steerCtx.targetPos = p.pos; _steerCtx.selfPos = e.pos;
        // DUNGEON_SPEC EDIT 5: casters stop shooting through walls.
        _steerCtx.distance = dist; _steerCtx.losBlocked = this._agentLosBlocked(e, dist, dt);
        _steerCtx.aggression = 1; _steerCtx.dt = dt;
        const steer = steerAgent(e.agent, _steerCtx, dt);
        moveX = steer.moveX; moveZ = steer.moveZ;
        e.vel.x += steer.impulseX; e.vel.z += steer.impulseZ;
        if (steer.wantAttack && e.attackCd <= 0) {
          // The fairness window is still enemyai.js's number — armed humanoids
          // just pour it into the machine's windup instead of a bare timer.
          // startAttack can refuse (recovery of the previous blow still
          // running); a refused ask charges no cooldown, matching the old
          // code's behaviour where attackCd alone gated and never overlapped
          // a live swing.
          let began = true;
          if (e.attack) {
            e.strikeW.combo[0].windup = steer.telegraph;
            began = Boolean(startAttack(e.attack, e.strikeW));
            if (began) e.telegraph = steer.telegraph;   // mirror for this frame's readers
          } else {
            e.telegraph = steer.telegraph;
          }
          if (began) {
            // Remembered so the attack CLIP can start its windup at telegraph
            // start and land its blow on the exact frame _enemyStrike fires —
            // the fairness timing itself is untouched.
            e.telegraphMax = steer.telegraph;
            e.attackCd = e.base.attackCd + Math.random() * (steer.attackKind === 'ranged' ? 0.6 : 0.4);
            noteAttack(e.agent);
          }
        }

        // Shadows pull aggro: if one is much closer, fight it instead.
        const near = this._nearestShadow(e.pos, 6);
        if (near && near.d < dist * 0.6) {
          const toS = tmpV2.copy(near.s.pos).sub(e.pos).setY(0);
          const dS = toS.length();
          if (dS > 0.001) toS.divideScalar(dS);
          if (dS > e.base.range) { e.vel.addScaledVector(toS, e.speed * 9 * dt); moveX = 0; moveZ = 0; }
          else if (e.attackCd <= 0) {
            // vigil 5pc: bound shadows inherit 15% of the OWNER's armorDR.
            // (The rule's other half — inheriting the active 2-piece bonus —
            // is the vigil 2pc +12% shadow damage, which _shadowStrike already
            // pays to every soldier; 4pc/5pc are explicitly not inherited.)
            const inh = this._rules?.get('shadow_inherit');
            near.s.hp -= e.atk * 0.6 * (inh ? 1 - inh.inheritDrFrac * this.derived.armorDR : 1);
            e.attackCd = e.base.attackCd;
            e.swing = 0.3;
            this.fx.burst(near.s.pos.clone().setY(1), 6, 0x35e6ff, { speed: 4, up: 2, life: 0.3 });
          }
          e.yaw = Math.atan2(toS.x, toS.z);
        }
      }

      if (moveX !== 0 || moveZ !== 0) { e.vel.x += moveX * 9 * dt; e.vel.z += moveZ * 9 * dt; }
      // Deliberately still facing the PLAYER, not steer.yaw: the line below has
      // always overwritten the shadow-facing yaw above, and keeping that quirk
      // is what makes this swap behaviour-neutral outside the stuck breaker.
      if (e.telegraph <= 0 && !staggered) e.yaw = Math.atan2(toPlayer.x, toPlayer.z);

      e.vel.multiplyScalar(1 - Math.min(0.95, 7 * dt));
      // GRAVEMAUL ASCENDANT (positioning verb): bodies inside the crater cover
      // ground at craterSlow of their speed. The POSITION advance is scaled,
      // not the velocity — leaving the zone restores full speed the same
      // frame, and knockback impulses still land at full strength.
      const cr = this._crater;
      const crSlow = (cr && Math.hypot(e.pos.x - cr.x, e.pos.z - cr.z) <= cr.r) ? cr.slow : 1;
      e.pos.addScaledVector(e.vel, dt * crSlow);
      this.world.resolve(e.pos, e.radius, e.vel);

      e.mesh.position.copy(e.pos);
      e.mesh.rotation.y = e.yaw;

      // telegraph tint: eyes flare before a strike lands
      const flare = e.telegraph > 0 ? 1 : 0;
      const rig = e.mesh.userData.rig;
      if (rig) {
        const s = flare ? 1.7 + Math.sin(this.time * 40) * 0.5 : 1;
        rig.eyeL.scale.setScalar(s);
        rig.eyeR.scale.setScalar(s);
      }

      const moving = Math.hypot(e.vel.x, e.vel.z) > 0.4;
      // The attack animation spans TELEGRAPH + STRIKE as one motion: windup
      // plays while e.telegraph runs down (the enemy stands planted and its
      // eyes flare — that fairness window is unchanged), and the blow lands on
      // the exact frame _enemyStrike applies the damage, at telegraphMax into
      // the span. Before this, the clip only started AFTER the damage, so
      // every enemy hit you from a standing pose and swung at nothing.
      const atkSpan = (e.telegraphMax || 0.42) + 0.3;
      let atkPhase = 0;
      if (e.telegraph > 0) atkPhase = Math.min(1, (e.telegraph + 0.3) / atkSpan);
      else if (e.swing > 0) atkPhase = e.swing / atkSpan;
      // LOD: shadow-cast decision plus the rig's own tick rate. rigDt is 0 when
      // this distant body's mixer is being skipped for a frame.
      const rigDt = this._entityLod(e, dt);
      if (rigDt > 0) {
        animateRig(e.mesh, {
          moving, speed: Math.hypot(e.vel.x, e.vel.z), t: this.time + e.pos.x,
          attackPhase: atkPhase,
          attackContact: (e.telegraphMax || 0.42) / atkSpan,
          hurt: Math.max(0, e.hurt),
          dt: rigDt,
        });
      }

      // health bar billboard. A flat 5.6 for bosses put the bar across the
      // face of anything scaled past ~2.3 (a scale-3.4 boss is 7.3 m tall);
      // scaling it like every other enemy clears the head at every rank.
      const h = 2.4 * (e.base.scale || 1);
      e.bar.position.copy(e.pos).setY(h);
      e.bar.quaternion.copy(this.camera.quaternion);
      setHealthBar(e.bar, e.hp / e.maxHp);
      e.bar.visible = e.hp < e.maxHp || e.isBoss;
    }
  }

  _enemyStrike(e) {
    const p = this.player;
    e.swing = 0.3;
    if (e.base.ai === 'ranged' && !e.isBoss) {
      this._spawnProjectile(e.pos.clone().setY(PROJECTILE_Y), p.pos.clone().setY(1.2), e.atk, e.base.glow, 14);
      this.audio.tone({ freq: 700, type: 'triangle', gain: 0.1, decay: 0.2, sweep: 300 });
      return;
    }
    const range = (e.base.range || 2) + (e.isBoss ? 2.2 : 0.6);
    const d = tmpV.copy(p.pos).sub(e.pos).setY(0);
    if (d.length() < range) {
      const fwd = this._forward(e.yaw);
      if (d.normalize().dot(fwd) > 0.2) {
        // The striker rides along so the damage pipeline can ask its tier —
        // the ossuary 5pc cares whether this was trash (grunt/stalker).
        this._damagePlayer(e.atk, e.pos, e);
      }
    }
    this.fx.burst(tmpV.copy(e.pos).addScaledVector(this._forward(e.yaw), 1.2).setY(1.2), 8, e.base.glow, {
      speed: 4, up: 2, life: 0.3,
    });
    this.audio.swing();
  }

  _bossBrain(b, dt, dist, toPlayer) {
    if (!b.enraged && b.hp / b.maxHp < 0.4) {
      b.enraged = true;
      b.speed *= 1.3;
      b.atk *= 1.25;
      this.ui.toast('THE BOSS IS ENRAGED', 'danger');
      this.fx.ring(b.pos, b.base.glow, 14, 0.8);
      this.audio.nova();
    }

    b.patternCd -= dt;
    if (b.telegraph > 0 || b.stagger > 0) return;

    if (b.patternCd <= 0) {
      b.pattern = Math.floor(Math.random() * 3);
      b.patternCd = (b.enraged ? 3.0 : 4.4) + Math.random() * 1.6;

      if (b.pattern === 0 && dist < 12) {
        // Slam: telegraphed radial shockwave.
        b.telegraph = 0.75;
        b.telegraphMax = 0.75;
        b._slam = true;
        this.fx.ring(b.pos, 0xff4d6d, 9, 0.75);
      } else if (b.pattern === 1) {
        // Spread shot: a fan of projectiles, ODD count in both phases.
        //
        // 7/9 rather than 6/9. An EVEN count has no bolt on the aim bearing, so
        // the line straight back to the boss is a permanently safe corridor and
        // the pattern stops being a threat past a fixed range. The arithmetic:
        // bolts fly flat at PROJECTILE_Y 1.6 and the player hit test is a 1.1 m
        // sphere centred at 1.2, so the LATERAL hit radius is
        // sqrt(1.1^2 - 0.4^2) = 1.025 m; a bolt at angle t off the bearing
        // passes the player at d*sin(t). With n=6 the innermost pair sits at
        // +/-0.12 rad, which clears 1.025 m at d = 8.6 m — so a 6-bolt volley
        // could not touch a stationary player at 10 or 14 m, in a chamber that
        // is 38 m across. An odd count always puts one bolt on the bearing, so
        // standing still is always punished and MOVING is the answer, which is
        // the whole point of the bigger room. The spacing is unchanged at 0.24
        // rad, so the fan still opens with range: at 4 m the two neighbours also
        // connect (4*sin(0.24) = 0.95 m < 1.025), at 8 m only the centre does.
        const n = b.enraged ? 9 : 7;
        // Sampled ONCE, outside the loop. See the _aimDir comment at the top of
        // this file: reading the bearing per bolt is what let a scratch-vector
        // alias turn this fan into a running sum.
        const aim = Math.atan2(toPlayer.x, toPlayer.z);
        for (let i = 0; i < n; i++) {
          const a = aim + (i - (n - 1) / 2) * 0.24;
          tmpV2.set(Math.sin(a), 0, Math.cos(a)).multiplyScalar(20).add(b.pos).setY(PROJECTILE_Y);
          // Chest height on the PLAYER, not on the boss. A scale-2.5 boss could
          // plausibly throw from 2.4 m, but the bolt flies flat and the player's
          // hit sphere tops out at 2.3 — so a "correct" shoulder height is a
          // pattern that cannot land. See _spawnProjectile.
          this._spawnProjectile(b.pos.clone().setY(PROJECTILE_Y), tmpV2, b.atk * 0.6, b.base.glow, 15);
        }
        this.audio.skill();
      } else {
        // Charge.
        b.vel.addScaledVector(toPlayer, 34);
        this.fx.burst(b.pos.clone().setY(1), 20, b.base.glow, { speed: 6, up: 3 });
        this.audio.dash();
      }
    }

    if (b._slam && b.telegraph <= 0) {
      b._slam = false;
      const r = 11;
      if (this.player.pos.distanceTo(b.pos) < r) this._damagePlayer(b.atk * 1.4, b.pos, b);
      this.fx.ring(b.pos, 0xff4d6d, r * 1.1, 0.5);
      this.fx.burst(b.pos.clone().setY(0.6), 60, b.base.glow, { speed: 16, up: 4, life: 0.9, spread: 2 });
      this.fx.addShake(1.0);
      this.audio.nova();
    }

    if (dist < 4.5 && b.attackCd <= 0) {
      b.telegraph = 0.5;
      b.telegraphMax = 0.5;
      b.attackCd = b.enraged ? 1.5 : 2.2;
    }
  }

  _nearestShadow(from, maxDist) {
    let best = null, bestD = maxDist;
    for (const s of this.shadows) {
      const d = s.pos.distanceTo(from);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ? { s: best, d: bestD } : null;
  }


  _updateShadows(dt) {
    for (let i = this.shadows.length - 1; i >= 0; i--) {
      const s = this.shadows[i];
      s.life += dt;
      if (s.hp <= 0) {
        this.fx.burst(s.pos.clone().setY(1), 20, 0x35e6ff, { speed: 6, up: 4, life: 0.7 });
        this.scene.remove(s.mesh);
        disposeObject3D(s.mesh);
        this.shadows.splice(i, 1);
        continue;
      }
      if (s.attackCd > 0) s.attackCd -= dt;
      // Windup running down to the contact frame, exactly like the enemy path:
      // the attack CLIP plays its windup while this timer runs (the soldier
      // stands planted) and the damage lands the frame it crosses zero. The
      // old code paid the damage at swing START, from a standing pose, before
      // the clip had moved — the same no-windup unfairness Wave 1 fixed on
      // enemies but never gave their allied mirror.
      if (s.telegraph > 0) {
        s.telegraph -= dt;
        if (s.telegraph <= 0) this._shadowStrike(s);
      }
      if (s.swing > 0) s.swing -= dt;

      const target = s.telegraph > 0 ? null : this._nearestEnemy(s.pos, 26);
      let moving = false;
      if (s.telegraph > 0) {
        // Planted mid-windup, like a telegraphing enemy: no chase, no
        // retarget, yaw held where the windup began so the blow lands where
        // the windup pointed.
      } else if (target) {
        const d = tmpV.copy(target.pos).sub(s.pos).setY(0);
        const dist = d.length();
        if (dist > 0.001) d.divideScalar(dist);
        s.yaw = Math.atan2(d.x, d.z);
        if (dist > 2.2) { s.vel.addScaledVector(d, s.speed * 9 * dt); moving = true; }
        else if (s.attackCd <= 0) {
          // Start the windup; _shadowStrike applies the damage when it ends.
          // The 0.85 s cycle is unchanged, so sustained DPS is what it was —
          // only the contact frame moved deeper into the cycle.
          s.attackCd = 0.85;
          s.telegraph = SHADOW_WINDUP;
          s.telegraphMax = SHADOW_WINDUP;
          s.target = target;
        }
      } else {
        // No targets: fall in behind the player.
        const d = tmpV.copy(this.player.pos).sub(s.pos).setY(0);
        const dist = d.length();
        if (dist > 3.5) {
          d.divideScalar(dist);
          s.vel.addScaledVector(d, s.speed * 8 * dt);
          s.yaw = Math.atan2(d.x, d.z);
          moving = true;
        }
      }
      s.vel.multiplyScalar(1 - Math.min(0.95, 8 * dt));
      s.pos.addScaledVector(s.vel, dt);
      this.world.resolve(s.pos, s.radius, s.vel);
      s.mesh.position.copy(s.pos);
      s.mesh.rotation.y = s.yaw;
      // The attack animation spans WINDUP + STRIKE as one motion, the same
      // bridge the enemy path uses: attackPhase covers the whole span and
      // attackContact tells the rig which fraction of it is the contact frame,
      // so the clip's blow lands exactly when _shadowStrike pays the damage.
      const atkSpan = (s.telegraphMax || SHADOW_WINDUP) + SHADOW_STRIKE;
      let atkPhase = 0;
      if (s.telegraph > 0) atkPhase = Math.min(1, (s.telegraph + SHADOW_STRIKE) / atkSpan);
      else if (s.swing > 0) atkPhase = s.swing / atkSpan;
      const rigDt = this._entityLod(s, dt, false);
      if (rigDt > 0) {
        animateRig(s.mesh, {
          moving, speed: Math.hypot(s.vel.x, s.vel.z), t: this.time + s.life,
          attackPhase: atkPhase,
          attackContact: (s.telegraphMax || SHADOW_WINDUP) / atkSpan,
          dt: rigDt,
        });
      }
    }
  }

  /**
   * The shadow soldier's contact frame — fires when s.telegraph crosses zero,
   * mirroring _enemyStrike. Damage numbers (s.atk) and cadence are the same as
   * the old instant hit; only the moment inside the cycle moved.
   */
  _shadowStrike(s) {
    s.swing = SHADOW_STRIKE;
    // Prefer the windup target, but let the blow land on whoever else is in
    // reach when that one is already dead or gone: a windup begun on a monster
    // the player finished first must not cost the squad its whole attack
    // cycle, or crowded fights would quietly run below Wave 1's shadow DPS.
    // 2.8 is the 2.2 engage range plus the same 0.6 reach slack enemies get.
    let target = s.target;
    s.target = null;
    if (!target || target.hp <= 0 || target.pos.distanceTo(s.pos) > 2.8) {
      const near = this._nearestEnemy(s.pos, 2.8);
      target = near && near.hp > 0 ? near : null;
    }
    if (!target) return;
    // s.atk already carries grade, owner level and INT via shadowCombat;
    // the old extra level multiplier here double-dipped. The vigil 2pc's
    // +12% is the ARMOUR part of shadowDmgMul only (x1 naked) — the INT part
    // is already inside s.atk, and multiplying derived.shadowDmgMul here
    // would double-count it. origin:'shadow' keeps a soldier's blow from
    // eating the player's banked riposte crit.
    const before = target.hp;
    this._damageEnemy(target, s.atk * (this._armorBonus?.shadowDmgMul || 1), { origin: 'shadow' });
    if (before > 0 && target.hp <= 0) s.kills++;
  }

  _updateProjectiles(dt) {
    // The whole loop lives in the pool now (RPG_SPEC step 8) — integration,
    // the DUNGEON_SPEC EDIT 4 own-height wall cull, the 1.1 m player sphere
    // for bolts, and the new arrow branch (gravity, ground/wall stick, enemy
    // torso test). The ctx object is reused every frame; only its fields move.
    // Staff-bolt steering — magic's bend #2, BOUNDED (RPG_SPEC
    // magicMayBendExactlyTwoThings): the HORIZONTAL heading rotates toward
    // the locked target at up to STAFF.turnRate (90 deg/s); the vertical
    // channel stays gravity's alone, because a bolt may steer but may not
    // ignore gravity, and it never exceeds its launch speed. At 18 m/s that
    // bound is an 11.5 m turn radius — a sprinting target still escapes.
    // Runs BEFORE pool.update so the frame integrates the steered heading.
    for (let i = 0; i < this.pool.live.length; i++) {
      const pr = this.pool.live[i];
      if (!pr.staff || pr.stuck) continue;
      const t = pr.staffTarget;
      if (!t || t.hp <= 0) { pr.staffTarget = null; continue; }
      _staffTo.copy(t.pos).sub(pr.pos).setY(0);
      if (_staffTo.lengthSq() < 1e-6) continue;
      const want = Math.atan2(_staffTo.x, _staffTo.z);
      const cur = Math.atan2(pr.dir.x, pr.dir.z);
      let diff = want - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // staffTurnMul: 1 on every bolt without HOLLOWLIGHT ASCENDANT's stamp.
      // The bound doubles; the vertical channel stays gravity's either way.
      const maxTurn = STAFF.turnRate * (pr.staffTurnMul || 1) * dt;
      if (diff > maxTurn) diff = maxTurn;
      else if (diff < -maxTurn) diff = -maxTurn;
      const yaw = cur + diff;
      // dir stays a flat unit vector, exactly as launched — vy carries the
      // vertical channel, so the pool's arrow integration is untouched.
      pr.dir.set(Math.sin(yaw), 0, Math.cos(yaw));
    }
    const ctx = this._projCtx;
    ctx.obstacleField = this.world?.obstacleField || null;
    ctx.worldRadius = this.world?.radius ?? 0;
    ctx.playerPos = this.player.pos;
    ctx.enemies = this.enemies;
    this.pool.update(dt, ctx);
    // A magic bolt BURSTS where an arrow sticks. The pool's arrow branch has
    // just parked any record that met a wall or the ground; an arrow parked
    // there is scenery, but a glowing orb parked there is a bug — so staff
    // records are released the same frame, and the 'cull' reason routes the
    // arcane impact through onRemove like every other bolt death.
    for (let i = this.pool.live.length - 1; i >= 0; i--) {
      const pr = this.pool.live[i];
      if (pr.staff && pr.stuck) this.pool.releaseAt(i, 'cull');
    }
  }

  /**
   * Roll a weapon for this gate and drop it. Uses the gate's seeded rng, so a
   * replayed seed hands out the same loot.
   */
  _spawnWeaponDrop(pos) {
    const w = rollDrop(this.rnd || Math.random, {
      rankIndex: this.gateIndex ?? 0,
      level: this.save.level,
      luck: this._dropLuck(),
    });
    if (!w) return;
    this._spawnPickup(pos, 'weapon', w);
  }

  // Perception is the stat that already governs what you notice; letting it
  // nudge rarity gives it a second, visible job. A worn Fortune trinket adds
  // its rolled magnitude on top — the spec's "luck feeds rollDrop's existing
  // parameter" contact point. Same 0.6 ceiling over the combined value.
  _dropLuck() {
    return Math.min(0.6, (this.save.stats?.per || 0) * 0.01 + (this._armorBonus?.luckAdd || 0));
  }

  /**
   * Roll an armour piece (or trinket) for this gate and drop it. Same seeded
   * stream as the weapon drops, so a replayed seed hands out the same loot.
   */
  _spawnArmorDrop(pos) {
    const a = rollArmorDrop(this.rnd || Math.random, {
      rankIndex: this.gateIndex ?? 0,
      level: this.save.level,
      luck: this._dropLuck(),
    });
    if (!a) return;
    this._spawnPickup(pos, 'armor', a);
  }

  _spawnPickup(pos, kind = 'hp', weapon = null) {
    if (kind === 'armor' && weapon) {
      // Armour has no worn mesh this wave (the look is step 12's part swap),
      // so the floor drop is the generic pickup shape in the RARITY tint —
      // grey/green/blue/purple/gold is already the loot language the weapon
      // beams taught, and it separates cleanly from hp red / mp cyan.
      const armor = weapon;
      const tint = rarityColor(armor.rarity);
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.4, 0),
        new THREE.MeshBasicMaterial({ color: tint }),
      );
      mesh.position.copy(pos).setY(1.05);
      mesh.add(new THREE.PointLight(tint, 3.0, 6));
      this.scene.add(mesh);
      this.pickups.push({
        mesh, pos: mesh.position, kind: 'armor', armor,
        life: 45, t: Math.random() * 6,
      });
      return;
    }
    if (kind === 'weapon' && weapon) {
      // The drop is the weapon itself — the same mesh that ends up in the hand,
      // so what you see on the floor is literally what you pick up.
      const mesh = new THREE.Group();
      const model = buildWeaponMesh(weapon);
      model.rotation.z = 0.42;
      mesh.add(model);
      const tint = rarityColor(weapon.rarity);
      mesh.position.copy(pos).setY(1.05);
      mesh.add(new THREE.PointLight(tint, 3.0, 6));
      this.scene.add(mesh);
      this.pickups.push({
        mesh, pos: mesh.position, kind: 'weapon', weapon,
        life: 45, t: Math.random() * 6,
      });
      return;
    }
    const color = kind === 'hp' ? 0xff4d6d : 0x22d3ee;
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.34, 0),
      new THREE.MeshBasicMaterial({ color }),
    );
    mesh.position.copy(pos).setY(0.9);
    mesh.add(new THREE.PointLight(color, 2.4, 5));
    mesh.layers.enable(GLOW_LAYER);
    this.scene.add(mesh);
    this.pickups.push({ mesh, pos: mesh.position, kind, life: 22, t: Math.random() * 6 });
  }

  _updatePickups(dt) {
    const p = this.player;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const it = this.pickups[i];
      it.life -= dt;
      it.t += dt;
      it.mesh.rotation.y += dt * 2.4;
      it.mesh.position.y = (it.kind === 'weapon' || it.kind === 'armor' ? 1.05 : 0.9) + Math.sin(it.t * 3) * 0.16;

      const d = it.mesh.position.distanceTo(p.pos);
      // Magnet: drift toward the player once they're close, so you never have
      // to fight the camera to stand exactly on a drop.
      if (d < 5.5) {
        tmpV.copy(p.pos).setY(0.9).sub(it.mesh.position).normalize();
        it.mesh.position.addScaledVector(tmpV, (6.5 - d) * 2.2 * dt);
      }
      if (d < 1.5) {
        if (it.kind === 'weapon') {
          this._takeWeapon(it.weapon);
          this.fx.burst(it.mesh.position.clone(), 18, rarityColor(it.weapon.rarity), { speed: 5, up: 4, life: 0.5 });
          this.audio.tone({ freq: 520, type: 'triangle', gain: 0.14, decay: 0.35, sweep: 1500 });
          this.scene.remove(it.mesh);
          disposeObject3D(it.mesh);
          this.pickups.splice(i, 1);
          continue;
        }
        if (it.kind === 'armor') {
          this._takeArmor(it.armor);
          this.fx.burst(it.mesh.position.clone(), 18, rarityColor(it.armor.rarity), { speed: 5, up: 4, life: 0.5 });
          this.audio.tone({ freq: 440, type: 'triangle', gain: 0.14, decay: 0.35, sweep: 1200 });
          this.scene.remove(it.mesh);
          disposeObject3D(it.mesh);
          this.pickups.splice(i, 1);
          continue;
        }
        if (it.kind === 'hp') {
          const heal = Math.round(this.derived.maxHp * 0.16);
          p.hp = Math.min(this.derived.maxHp, p.hp + heal);
          this.fx.damageNumber(tmpV.copy(p.pos).setY(2.4), `+${heal}`, 'crit');
        } else {
          p.mp = Math.min(this.derived.maxMp, p.mp + Math.round(this.derived.maxMp * 0.3));
        }
        this.fx.burst(it.mesh.position.clone(), 12, it.kind === 'hp' ? 0xff4d6d : 0x22d3ee, { speed: 4, up: 3, life: 0.4 });
        this.audio.tone({ freq: 880, type: 'sine', gain: 0.12, decay: 0.18, sweep: 1300 });
        this.scene.remove(it.mesh);
        disposeObject3D(it.mesh);
        this.pickups.splice(i, 1);
        continue;
      }
      if (it.life <= 0) {
        this.scene.remove(it.mesh);
        disposeObject3D(it.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  /**
   * Auto-equip on upgrade, stash otherwise. `score` is rollWeapon's single
   * comparable number, so this never needs to know what an affix is.
   */
  _takeWeapon(w) {
    if (!w) return;
    const held = this.weapon;
    if (!held || w.score > held.score) {
      this.equip(w);
      this.ui.toast(`${w.name.toUpperCase()}  ·  ${w.rarityName}`, 'gold');
    } else {
      this.stash.unshift(w);
      if (this.stash.length > STASH_LIMIT) this.stash.length = STASH_LIMIT;
      this._persistLoadout();
      this.ui.toast(`STASHED  ${w.name.toUpperCase()}`);
    }
  }

  /**
   * Armour goes STRAIGHT to the stash as a serialized record — never
   * auto-equipped. Worn armour is fully live now (step 11 folds armorDerive
   * into refreshDerived), which is exactly why a drop must not equip itself:
   * silently changing a slot the panel still renders locked would silently
   * change the player's combat numbers. Equipping stays a deliberate act and
   * arrives with the panel's armour slots (step 13).
   */
  _takeArmor(a) {
    if (!a) return;
    const rec = serializeArmor(a);
    if (!rec) return;
    this.armorStash = this.armorStash || [];
    this.armorStash.unshift(rec);
    // The persisted stash shares one 40-record cap with the weapons; trim the
    // in-memory list too so it cannot grow past what will ever be written.
    if (this.armorStash.length > STASH_LIMIT) this.armorStash.length = STASH_LIMIT;
    this._persistLoadout();
    this.ui.toast(`STASHED  ${a.name.toUpperCase()}  ·  ${a.rarityName}`, a.rarity === 'legendary' || a.rarity === 'epic' ? 'gold' : undefined);
  }

  _updateCorpses(dt) {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.life -= dt;
      // The Death clip: entities.js starts it from the standing frame so the
      // fallen visibly crumple, and this tick is what plays it. It clamps on
      // its last frame ~1 s in, so the cost after that is one no-op mixer
      // update per corpse.
      c.mesh.userData.character?.update(dt);
      const k = Math.max(0, Math.min(1, c.life / CORPSE_WINDOW));
      c.mesh.traverse((o) => {
        if (o.isMesh && o.material.transparent) o.material.opacity = 0.62 * k;
      });
      // Corpses sink away as their raise window closes.
      c.mesh.position.y = 0.25 - (1 - k) * 1.2;
      if (c.life <= 0) {
        this.scene.remove(c.mesh);
        disposeObject3D(c.mesh);
        this.corpses.splice(i, 1);
      }
    }
  }

  _updateSpawns(dt) {
    // DUNGEON_SPEC EDIT 1(a): the wave timer is the arena's spawn driver; the
    // crawl's encounter director meters spawns room by room instead.
    if (this.world.encounterDriven) return;
    if (this.bossActive) return;
    if (this.spawnTimer > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) this._spawnWave();
    }
    if (this.enemies.length === 0 && this.spawned < this.gate.enemies && this.spawnTimer <= 0) {
      this.spawnTimer = 0.7;
    }
    if (this.enemies.length === 0 && this.spawned >= this.gate.enemies && !this.bossActive && this.killed >= this.gate.enemies) {
      this._spawnBoss();
    }
  }

  _updateCamera(dt) {
    const p = this.player;
    const { yaw, pitch } = this.input.look;
    // Lead the camera slightly toward movement so you can see what you're running into.
    tmpV.copy(p.pos).addScaledVector(p.vel, 0.22);
    if (yaw === 0 && pitch === 0) {
      // Untouched orbit reproduces the shipped camera bit for bit — scripted
      // runs never drag, so this branch is the one every test exercises.
      // Bias the look target away from the camera so the player sits below
      // centre and the screen is spent on the ground ahead rather than empty
      // foreground.
      tmpV.z -= 3.4;
      this.camLook.lerp(tmpV, Math.min(1, dt * 6));
      this.camPos.copy(this.camLook).add(this.camOffset);
    } else {
      // Same rig, swung around Y by the player's drag. The look-target bias
      // slides along the camera's ground forward so the player still sits
      // below centre from every angle; the boom keeps camOffset's length and
      // 45° base pitch, +/- the drag's clamped pitch offset.
      tmpV.x -= Math.sin(yaw) * 3.4;
      tmpV.z -= Math.cos(yaw) * 3.4;
      this.camLook.lerp(tmpV, Math.min(1, dt * 6));
      const boom = Math.hypot(this.camOffset.y, this.camOffset.z);
      const pa = Math.atan2(this.camOffset.y, this.camOffset.z) + pitch;
      this.camPos.set(
        this.camLook.x + Math.sin(yaw) * boom * Math.cos(pa),
        this.camLook.y + boom * Math.sin(pa),
        this.camLook.z + Math.cos(yaw) * boom * Math.cos(pa),
      );
    }
    this.camera.position.lerp(this.camPos, Math.min(1, dt * 7));
    this.camera.lookAt(this.camLook.x, this.camLook.y + 1.2, this.camLook.z);
    this.fx.applyShake(this.camera);
    // Fit the shadow frustum to the player rather than the whole arena: ±14
    // units at 1024 is 2.7cm/texel instead of 7.4cm.
    this.world.updateShadowCamera(this.player.pos, 14);
  }

  // --------------------------------------------------------- end states
  _clearGate() {
    this.state = 'over';
    this.audio.music(false);
    this.audio.gateClear();
    const rank = this.gate.rank;
    const t = Math.round(this.runTime);
    const prev = this.save.cleared[rank];
    const isBest = prev == null || t < prev;
    if (isBest) this.save.cleared[rank] = t;
    // The roster persists on its own now. Only per-shadow bookkeeping is
    // written back — the old `save.shadows = <count>` overwrote the whole
    // roster object with a number and wiped the army on every clear.
    this._commitShadowKills();
    const roster = rosterSummary(this.save);
    this.onSave();
    this.ui.showHud(false);
    // replace(), not go(): the finished run must not sit on the back stack, or
    // hardware-back from the results panel would restart the gate.
    this.appState?.replace('results', { rank, cleared: true });
    this.ui.showResults({
      title: 'RIFT CLEARED',
      cleared: true,
      levelsGained: this.levelsGained,
      rows: [
        ['Gate', `${rank}-Rank · ${this.gate.name}`],
        ['Time', `${Math.floor(t / 60)}m ${t % 60}s${isBest ? '  (BEST)' : ''}`],
        ['Kills', String(this.player.kills)],
        ['Essence gained', `${this.xpEarned} XP`],
        ['Ash recovered', `${this.ashEarned || 0}`],
        ['Levels gained', this.levelsGained ? `+${this.levelsGained}` : 'none'],
        ['Stat points earned', this.pointsGained ? `+${this.pointsGained}` : 'none'],
        ['Breaker level', `${this.save.level}  (${rankOf(this.save.level)}-grade)`],
        ['Company', `${roster.count} / ${roster.capacity} bound`],
      ],
    });
  }

  // Field kills belong to the roster record, not to the throwaway field entity,
  // or every run would reset the army's service history.
  _commitShadowKills() {
    for (const s of this.shadows) {
      if (s.rec && s.kills) s.rec.kills += s.kills;
      s.kills = 0;
    }
  }

  _fail() {
    this.state = 'over';
    this.save.deaths++;
    this._commitShadowKills();
    // Death releases the weakest quarter by grade. Losing an irreplaceable
    // named shadow to one bad run is the fastest way to stop a player taking
    // risks, so releaseWeakest never touches the top of the roster.
    const lost = releaseWeakest(this.save, Math.floor(this.save.shadows.roster.length / 4));
    this.onSave();
    this.audio.music(false);
    this.audio.gameOver();
    this.fx.burst(this.player.pos.clone().setY(1), 60, 0xff4d6d, { speed: 10, up: 6, life: 1.4 });
    this.fx.addShake(1.1);
    this.ui.showHud(false);
    this.appState?.replace('results', { rank: this.gate?.rank ?? null, cleared: false });
    const t = Math.round(this.runTime);
    this.ui.showResults({
      title: 'YOU FELL',
      cleared: false,
      levelsGained: this.levelsGained,
      rows: [
        ['Gate', `${this.gate.rank}-Rank · ${this.gate.name}`],
        ['Survived', `${Math.floor(t / 60)}m ${t % 60}s`],
        ['Progress', `${this.killed} / ${this.gate.enemies} cleared`],
        ['Kills', String(this.player.kills)],
        ['Essence kept', `${this.xpEarned} XP`],
        ['Ash recovered', `${this.ashEarned || 0}`],
        ['Levels gained', this.levelsGained ? `+${this.levelsGained}` : 'none'],
        ['Stat points earned', this.pointsGained ? `+${this.pointsGained}` : 'none'],
        ['Soldiers lost', lost.length ? `${lost.length} released` : 'none'],
      ],
    });
  }

  pause(on) {
    if (this.state === 'over' || this.state === 'idle') return;
    this.state = on ? 'paused' : 'playing';
    this.audio.music(!on);
  }

  /** Unmount whatever is running and leave an empty scene (title screen). */
  quit() {
    this.onSave();
    this._setMode(null);
    this.state = 'idle';
    this.clearEntities();
    this.world.clear();
    this.audio.music(false);
    this.ui.showHud(false);
  }
}
