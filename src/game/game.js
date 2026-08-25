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
  tickDaily, claimDaily, dailyState, DAILY_TARGET,
} from './progression.js';
import { DAILY_CONTRACT_POINTS } from './config.js';
// The ONE canonical rank-colour table (audit: colour drift comes from second
// homes). city.js does not import game.js, so this adds no cycle.
import { PORTAL_COLORS } from '../world/city.js';
import { ashForXp, grantAsh } from './shop.js';
import { ensureEquipment } from '../core/save.js';
import {
  autoDeploy, deployedRecords, addShadow, makeShadow, releaseWeakest,
  shadowCombat, rosterSummary, setDeployed,
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
// The class layer (CLASSES_SPEC step 3). applyLayers folds the chosen class's
// benefit/drawback terms over derive()'s output — ONCE, at the single
// computation site below — and is a proven identity when save.className is
// null, which is every save on the day this ships (the migration guarantee,
// asserted over 200 seeded saves in tools/classes-test.mjs). Directions and
// masteries are NOT applied here: they are behaviours for the step-4 combat
// hooks, never derived-block multipliers. The archon layer never touches the
// derived block at all (interlock rule; applyLayers ignores save.archon by
// design). classModifiers/clampSumPct feed the BEHAVIOUR half of the same
// contract: the term-set schema's flags/flagsScaled entries are "numeric
// behaviour magnitudes the consumer (STEP 4/5 hooks) multiplies" — this file
// IS that consumer, via the _classFlags cache refreshDerived rebuilds.
import {
  applyLayers, DIRECTIONS, masteryTier, classModifiers, clampSumPct,
} from './classes.js';
// The ascension layer (CLASSES_SPEC step 7): the S gate carries THE REACH
// trial flag, real play bumps the five affinity counters, and killing the
// Rift Archon while eligible presents archonOffers — top two by counter plus
// SHADOW. ascend() writes save.archon and NOTHING else changes: the archon
// layer reads the derived block and never enters it (interlock rule 3), so
// path mechanics arrive in steps 8-10 without this file re-deriving anything.
// `ascend` is renamed on import: ascension.js (the weapon craft) already owns
// that bare name in this file — see _craftAscend below.
import {
  bumpAffinity, canAscend, archonOffers, ascend as ascendArchon, ARCHONS,
  archonFieldBonus, archonResourceRules,
} from './classes.js';
// The archon substrate (CLASSES_SPEC step 6) configured into its first two
// stacking paths (step 9): FLAME's Pyre/combustion/Ashfall and FROST's
// Rime/freeze/shatter/Barrier. game.js owns only the HOOKS — the numbers are
// ARCHON_PATHS data, the machinery is the four substrate exports, and both
// live in archon.js so step 10's STORM cannot drift from them.
import {
  StatusTable, ArchonPool, ResourceMeter, tintForStacks, ARCHON_PATHS,
  TINT_TARGETS,
} from './archon.js';
// Ground telegraphy for the masteries (CLASSES_SPEC step 4): RESIDUE fields
// and READING arcs share one pooled channel, allocated lazily on first use so
// a save with no mastery pays nothing — not even the geometry.
import { GroundFxPool } from '../render/decalpool.js';
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

// SOVEREIGN'S WILL (CLASSES_SPEC step 8) — the SHADOW ARCHON's numbers live
// as data on ARCHONS.shadow so the node suite and this file read one source.
// Aliased here because _updateShadows is a hot loop and the mechanics below
// name these constants a dozen times.
const SOVEREIGN = ARCHONS.shadow.sovereignsWill;
const LEGION_CD = ARCHONS.shadow.resourceRules.ultimateCooldown;

// FLAME + FROST (CLASSES_SPEC step 9) — aliased like SOVEREIGN above: the hit
// hooks below name these numbers per swing, and the one source stays
// archon.js. FX colours match the substrate's own tint targets so a burning
// enemy, its flame quads and the Ashfall floor all read as one system.
const FLAME_P = ARCHON_PATHS.flame;
const FROST_P = ARCHON_PATHS.frost;
const FLAME_COLOR = 0xff6b2b;
const FROST_COLOR = 0x66e0ff;
// STORM + BEAST (CLASSES_SPEC step 10), same one-source rule: mechanics are
// ARCHON_PATHS data, cooldown rules live in classes.js resourceRules (the
// LEGION_CD precedent — a number in both files is the drift archon.js's
// header bans).
const STORM_P = ARCHON_PATHS.storm;
const BEAST_P = ARCHON_PATHS.beast;
const STORM_COLOR = 0x9dd8ff;
const WILD_CD = ARCHONS.beast.resourceRules.ultimateCooldown;
const WILD_CD_PER_KILL = ARCHONS.beast.resourceRules.cooldownPerKill;
// THE absolute move-speed ceiling, one source (see the tempest config's own
// comment in archon.js): every multiplier — TEMPO stacks, Tempest Step, Wild
// Form, any future term — answers to this one Math.min in _updatePlayer.
const SPEED_CAP = STORM_P.tempest.hardSpeedCap;
// How long after the last hit dealt or taken the run still counts as combat.
// Ember decays OUT OF COMBAT and the Barrier decays OUT OF COMBAT (their
// classes.js rules); the meter cannot know, so this clock is the caller-side
// boolean the ResourceMeter contract asks for. 4 s matches the pacing feel of
// the existing 3 s kindling window plus a beat of disengage.
const ARCHON_COMBAT_SECONDS = 4;

// ------------------------------------------------- direction masteries
//
// CLASSES_SPEC step 4: the fifteen masteries are QUALITATIVE — a clamp, a
// proc, a refund, a field — wired into the combat hooks below, never a flat
// multiplier folded into the derived block (CERTAINTY's floor/critDmg and
// TEMPO's capped stacks are the spec's two sanctioned exceptions). The
// NUMBERS live in classes.js as data (DIRECTIONS[...].params); this table is
// a flat read of them taken once at module load, so the hooks pay a property
// read per event, not a walk of the mastery tables per hit. Tiers are
// cumulative (spent >= 120 owns T1 and T2), which is why every check below
// is `>=`, and they are per-STAT thresholds independent of directionOf() — a
// 200/145 str/vit build runs BREAKER T3 and BULWARK T2 hooks at once.
const MASTERY = {
  ironhide: DIRECTIONS.vit.masteries[0].params,
  riposte: DIRECTIONS.vit.masteries[1].params,
  unyielding: DIRECTIONS.vit.masteries[2].params,
  slipstream: DIRECTIONS.agi.masteries[0].params,
  answer: DIRECTIONS.agi.masteries[1].params,
  tempo: DIRECTIONS.agi.masteries[2].params,
  kindling: DIRECTIONS.int.masteries[0].params,
  residue: DIRECTIONS.int.masteries[1].params,
  overcharge: DIRECTIONS.int.masteries[2].params,
  sunder: DIRECTIONS.str.masteries[0].params,
  aftershock: DIRECTIONS.str.masteries[1].params,
  ruinous: DIRECTIONS.str.masteries[2].params,
  reading: DIRECTIONS.per.masteries[0].params,
  punish: DIRECTIONS.per.masteries[1].params,
  certainty: DIRECTIONS.per.masteries[2].params,
};

// The shipped crit multiplier _damageEnemy has always applied. Named now
// because CERTAINTY (+25%) and TEMPO (+6%/stack) finally scale it — for every
// save without those masteries the maths below reduce to this exact constant.
const CRIT_MUL = 1.85;

// Mastery ground-fx colours. Danger-red for READING (it marks where a swing
// will LAND — the same read as the boss slam's Effects.ring), the skill
// palette's violet for RESIDUE (it is the skill's own aftermath).
const READING_COLOR = 0xff4d6d;
const RESIDUE_COLOR = 0xb98bff;

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
// Mastery-hook scratch, same single-role rule: RIPOSTE's shockwave origin and
// nothing else. It is handed to _damageEnemy as opts.from, and _damageEnemy
// consumes tmpV/tmpV2 internally — borrowing either would be the exact
// aliasing the boss spread shot shipped with.
const _mastV = new THREE.Vector3();     // riposte shockwave origin only

// Archon-path scratch (step 9), same single-role rule: fx positions and quad
// spawn points only — never handed to _damageEnemy (which consumes tmpV/tmpV2
// internally) as opts.from; blast knockback passes the live e.pos instead.
const _archV = new THREE.Vector3();
// Second archon scratch (step 10): ARC's segment endpoint and the Tempest
// dash-bolt's line end. Its own vector on the _aimDir/_projDir rule — _archV
// is live as the chain's other endpoint in the same expressions.
const _archV2 = new THREE.Vector3();
// The inventory panel's isolated character-viewer shot, same single-role rule
// as the pair above: _updateInventoryCamera's look target and camera position
// only.
const _invLook = new THREE.Vector3();
const _invPos = new THREE.Vector3();
// _renderInventoryPreview's own scratch for renderer.getSize() (logical/CSS
// px, required every frame the character viewer is open — see that method).
const _invRendererSize = new THREE.Vector2();
// The character-viewer framing (owner feedback on the first paper-doll ship:
// the old close chest-height portrait, aimed through the SAME world camera,
// left the live map and other hunters visible behind the player and read as
// "massive"/not actually contained to the panel's centre column). This is a
// full-body medium shot on a DEDICATED previewCamera (see its construction
// below) rather than the gameplay follow rig's numbers — narrower FOV, pulled
// back to the waist/knee line instead of the chest.
const INV_PREVIEW_DIST = 3.2;
const INV_PREVIEW_HEIGHT = 1.25;
const INV_PREVIEW_LOOK_Y = 0.95;
// GLOW_LAYER (imported above) is 1 and carries every sanctioned glow object
// in the game (skill VFX, portals, enemy telegraphs...). This is a SEPARATE
// layer, exclusively the live player rig, that ONLY previewCamera looks at —
// see _renderInventoryPreview for why that isolates the character from the
// rest of the (still-standing) world without touching GLOW_LAYER at all.
const INV_PREVIEW_LAYER = 2;
// Drag-to-spin sensitivity for the character viewer — a little snappier than
// Input.js's world-orbit YAW_PER_PX (Math.PI/600) because this is a small
// on-screen model being spun directly, not a camera boom swinging through a
// whole 3D space.
const INV_SPIN_PER_PX = Math.PI / 300;
// A flat front-on default reads as a silhouette with nothing to tell it apart
// from a mannequin; a modest 3/4 turn is the same choice most character-select
// screens make and still starts every piece of frontal gear (chest, weapon in
// the draw hand) in view.
const INV_DEFAULT_YAW = Math.PI / 7;
// The combustion cascade queue, module-lived and reused so a chain allocates
// nothing after the first. Safe as a singleton: _combust drains it fully
// before returning and nothing re-enters it mid-drain (blasts mark noStatus,
// so a nested _damageEnemy can never reach _applyPyre).
const _combustQ = [];
// ARC's chain-target collection, same module-lived reuse: filled, applied and
// truncated inside one _tryArc call. Nested _damageEnemy calls can splice
// this.enemies but only ever READ this list's captured references, so a
// mid-chain kill cannot skip a link (the bleed pass's snapshot reasoning).
const _arcTargets = [];

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
    // The stable id of that portal (see beginRun) — exact where rank is
    // ambiguous. Both runtime-only.
    this.lastGatePortalId = null;
    // Non-null while the inventory panel's paper-doll view owns the camera —
    // see enterInventoryView(). update()'s camera dispatch checks this before
    // the mode's own updateCamera, so the follow rig simply stops running for
    // as long as it is set; there is nothing else to disable.
    this._invView = null;
    // () => DOMRect for the inventory's stage-centre column, registered once
    // by InventoryUI — see setInventoryStageRectProvider.
    this._invStageRectFn = null;

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
    // The inventory character-viewer's OWN camera — see _renderInventoryPreview.
    // Near/far are tight (this only ever frames one small rig a few metres
    // away) and its layer mask is flipped from every other camera in the game:
    // INV_PREVIEW_LAYER only, nothing else, which is what makes the rest of
    // the (still-standing) world invisible to it without touching a single
    // other object's visibility flag.
    this.previewCamera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 20);
    this.previewCamera.layers.disableAll();
    this.previewCamera.layers.enable(INV_PREVIEW_LAYER);
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
        // Conjured arrows dissolve wherever they end — wall, floor, flesh, or
        // a pool cycle — as a small pop of their element. Wooden arrows still
        // stick silently; 'clear' (gate transition) stays a non-event.
        if (rec.kind === 'arrow' && rec.element && reason !== 'clear') {
          this.fx.burst(rec.pos, 8, rec.color, { speed: 4, up: 1.5, life: 0.3 });
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
    this.previewCamera.aspect = w / h;
    this.previewCamera.updateProjectionMatrix();
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
    // Nothing to put away, or an archetype with no place to put it. A WILD
    // FORM has no hands to stow with either — the base mesh is hidden and a
    // stance swap on it would just thrash attachments nobody can see.
    if (!mesh || !this.weapon || !STOW[this.weapon.archetype] || this._wildT > 0) return;
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
   *  The vigil 4pc (+2) and the SHADOW ARCHON's +2 (CLASSES_SPEC step 8) both
   *  join inside progression's clamps — the quality tier and the hard 12
   *  still get the final word, which is the spec's low-tier-phone honesty
   *  clause: on a small tier the path grants nothing here and is still fine,
   *  because its damage rides gradeMultiplier and shadowDmgMul, not headcount. */
  fieldCapacity() {
    // BINDER's +2 (an UNSCALED flag: headcount is a draw-call budget, not a
    // knob quality may inflate) joins the same earned term as the vigil 4pc
    // and the archon bonus — quality.js maxFieldShadows and the hard 12
    // still get the final word.
    return shadowFieldCapacity(this.save, this.quality.current,
      (this._armorBonus?.shadowFieldAdd || 0) + archonFieldBonus(this.save)
      + (this._classFlags?.fieldAdd || 0));
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
    // Layer order per CLASSES_SPEC interlock: stats+armour produce the base
    // (derive), the class layer folds once on top (applyLayers), and the
    // archon layer reads the result without ever writing it. With no class
    // chosen applyLayers returns a copy deep-equal to its input, so every
    // pre-class save gets exactly the shipped numbers.
    this.derived = applyLayers(this.save, derive(this.save, this._armorBonus));
    // The class layer's BEHAVIOUR half, cached at the same single site: the
    // schema's flags/flagsScaled terms (BERSERKER's rage, REAVER's leech and
    // kill stacks, VANGUARD's deferral, ORACLE's windup bonus, HEXWEAVER's
    // basic-attack cut, TEMPLAR's spell leech and cooldown tax, the mana
    // surcharges, BINDER's field/roster/extraction adds) arrive PRE-SCALED by
    // quality x resonance from classModifiers, so every combat hook below
    // reads one scalar and never re-folds the scaling rules per hit. Null for
    // every save without a class — each consumer guards on one falsy check
    // and the shipped path stays byte-identical.
    const cmods = classModifiers(this.save);
    this._classFlags = cmods ? cmods.flags : null;
    // BINDER's +20% shadow damage, isolated as its OWN factor for the strike
    // seam: the INT term is already inside s.atk (shadowCombat) and the
    // armour term already multiplies at the strike, so reading
    // derived.shadowDmgMul there would double-count INT — while reading only
    // the armour term (the shipped code) dropped the class term on the
    // floor. (1 + the clamped class pct) is exactly the remainder, and it is
    // 1.0 to the bit for every save without the term.
    this._classShadowMul = cmods ? 1 + clampSumPct(cmods.pct.shadowDmgMul || 0) : 1;
    // Mastery tiers, recomputed here (the single site) rather than per hit:
    // they change only when stats change, and every event that can — allocate,
    // respec, migration — already funnels through refreshDerived. The object
    // is reused so this method allocates nothing after the first call.
    const mt = this._mastery || (this._mastery = { str: 0, agi: 0, vit: 0, int: 0, per: 0 });
    mt.str = masteryTier(this.save, 'str');
    mt.agi = masteryTier(this.save, 'agi');
    mt.vit = masteryTier(this.save, 'vit');
    mt.int = masteryTier(this.save, 'int');
    mt.per = masteryTier(this.save, 'per');
    // CERTAINTY — one of the spec's two sanctioned derived-block exceptions
    // (masteryRules.qualitativeNotMultiplicative). Applied HERE, not in
    // applyLayers: masteries are earned by stats alone, so classes.js keeping
    // its hands off the block is what makes the null-CLASS identity assert
    // hold, while a per>=200 save legitimately reads a 100% floor and +25%
    // crit damage on every surface. critDmg feeds the CRIT_MUL scaling in
    // _damageEnemy, so the panel number and the felt number move together.
    if (mt.per >= 3) {
      this.derived.dmgFloor = MASTERY.certainty.dmgFloor;
      this.derived.critDmg += MASTERY.certainty.critDmgAdd;
    }
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
    // Nor does a RESIDUE field or a READING arc: the city never runs
    // _updateEnemies, so a live count would otherwise persist on screen.
    this._groundFx?.clear();
    // Nor a Pyre/Rime stack, a live Ashfall or a flame quad (step 9): the
    // stacks reference gate enemies that are about to be disposed, and a
    // frozen mid-air quad in Threshold would be exactly the linger the pool's
    // one-verb teardown exists to prevent. dispose() is idempotent and the
    // pool is rebuilt per gate entry in _beginGate.
    this._archonStatus?.disposeAll();
    if (this._ashfall) this._ashfall.t = 0;
    if (this._archonFx) { this._archonFx.dispose(); this._archonFx = null; }
    // Nor a Tempest window or a Wild Form (step 10): the city runs its own
    // player update, so a live window would freeze mid-count — and the wild
    // mesh must hand the base body back before the city presents the player.
    this._tempestT = 0;
    this._endWildForm(true);
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
    // Prefer the exact portal the player entered through (stable id, set by
    // beginRun) over the rank, which is ambiguous once wild gates share ranks
    // with plaza gates. Legacy rank payloads still work — _spawnVector falls
    // back to find-by-rank.
    return this._setMode('city', { spawnAt, atPortal: atPortal ?? this.lastGatePortalId ?? this.lastGateRank });
  }

  /**
   * Step through a portal. `rank` is 'E'..'S'. `forceBiome` pins the biome
   * roll; `forceOpen` is the dev override that mounts the flat arena for a
   * crawl rank (DUNGEON_SPEC worldJsArenasFate — old tests and screenshot
   * baselines still exercise the arena through it).
   */
  enterGate(rank, { forceBiome = null, forceOpen = false, wild = false, portalId = null } = {}) {
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
    if (this.appState) return this.appState.go('run', { rank: resolved, gateIndex: index, forceBiome, forceOpen, portalId });
    return this.beginRun({ rank: resolved, gateIndex: index, forceBiome, forceOpen, portalId });
  }

  /** Mount the dungeon. AppState's onEnter('run') hook calls this. */
  beginRun({ rank = null, gateIndex = null, ...extra } = {}) {
    const index = gateIndex != null
      ? gateIndex
      : Math.max(0, GATES.findIndex((g) => g.rank === rank));
    this.lastGateRank = GATES[index].rank;
    // The stable id of the portal this run was entered through (or null for
    // fast travel / dev paths, which have no doorstep to return to). beginRun
    // is the SINGLE writer so a dev-launched run can never inherit a stale id
    // from a previous portal walk. Runtime-only, like lastGateRank.
    this.lastGatePortalId = extra.portalId ?? null;
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
    // 0x5ade0f / 0xb5297a4d / 0x2545f491) — so per-elite material rolls can
    // never perturb the main stream's enemy/loot draws, and a replayed seed
    // yields the same dust.
    this._emberRnd = mulberry32((this.seed ^ 0xcc9e2d51) >>> 0);
    // The archon stream (CLASSES_SPEC determinism.forks): 0x2545f491 is the
    // multiplier from SplitMix-family mixers, verified unused against the
    // registry above. Owns the ASHEN SIGIL roll on an S boss (one per three
    // clears, seeded — a replayed gate seed pays the same sigil) and, later,
    // the pact-beast archetype and trial boss placement (steps 8-10).
    this._archonRnd = mulberry32((this.seed ^ 0x2545f491) >>> 0);
    this._critRefunds = 0;      // WHISPERFANGS ASCENDANT: refunds this combo
    this._crater = null;        // GRAVEMAUL ASCENDANT: the live slow zone
    // Direction-mastery per-run state (CLASSES_SPEC step 4). All of it dies
    // with the run on purpose: UNYIELDING's 90 s is REAL time on the run and
    // never persisted (spec wording), and a proc that survived a gate exit
    // would be a saved-game field nobody sanitises. Objects are reused across
    // runs so re-entering a gate allocates nothing here after the first.
    this._unyieldingT = 0;      // UNYIELDING: seconds until the next cheat of death
    this._riposteT = 0;         // RIPOSTE: internal cooldown running down
    this._riposteFire = this._riposteFire || { armed: false, x: 0, z: 0, dmg: 0 };
    this._riposteFire.armed = false; // banked shockwave, applied in _updateEnemies
    this._slipT = 0;            // SLIPSTREAM: seconds of +35% attack speed left
    this._answerT = 0;          // ANSWER: seconds the queued guaranteed crit lives
    this._tempoStacks = 0;      // TEMPO: live stacks (max 5)
    this._tempoChainT = 0;      // TEMPO: chain window since the last perfect dodge
    this._tempoDecayT = 0;      // TEMPO: accumulator toward the next stack decay
    this._kindlingT = 0;        // KINDLING: window since the last skill cast
    this._kindlingCost = 0;     // KINDLING: that cast's mana price
    this._kindlingPaid = 0;     // KINDLING: refunds banked so far (caps at cost)
    this._overN = 0;            // OVERCHARGE: casts inside the rotation window
    this._overT = 0;            // OVERCHARGE: rotation window remaining
    this._ruinFin = 0;          // RUINOUS: finishers thrown (every 3rd staggers)
    // Class-flag per-run state (STEP 5 consumers): REAVER's momentum and
    // VANGUARD's deferred pool die with the run for the same reason the
    // mastery clocks above do — a wound or a war-rhythm that survived a gate
    // exit would be a saved-game field nobody sanitises.
    this._killStacks = 0;       // REAVER: live kill stacks (max killStackMax)
    this._killStackT = 0;       // REAVER: the shared 4 s window
    this._vgPool = 0;           // VANGUARD: deferred damage still owed
    this._vgRate = 0;           // VANGUARD: the pool's drain rate (hp/s)
    // RESIDUE's three field slots, reused in place — max 3 live is the spec's
    // own cap and the array never grows.
    if (!this._residue) {
      this._residue = [
        { t: 0, x: 0, z: 0, acc: 0 }, { t: 0, x: 0, z: 0, acc: 0 }, { t: 0, x: 0, z: 0, acc: 0 },
      ];
    }
    for (const f of this._residue) { f.t = 0; f.acc = 0; }
    // PUNISH's cancel roll draws off its own fork of the gate seed —
    // 0xb5297a4d is Squirrel3's noise constant, registered in the emberdust
    // comment above — so a mastery roll can never perturb the main stream's
    // enemy/loot draws and a replayed seed cancels the same wind-ups.
    this._masteryRnd = mulberry32((this.seed ^ 0xb5297a4d) >>> 0);
    // THE REACH (CLASSES_SPEC layerC unlock.trial): the S gate with a flag —
    // not a new dungeon. Armed HERE, the one choke point every entry route
    // funnels through (portal confirm, fast-travel list, startGate), whenever
    // the save is ascension-eligible: level 55+, classTier set, an S clear
    // banked, and — for a re-ascension — an ASHEN SIGIL held (canAscend owns
    // all four conditions). Killing the Rift Archon under this flag presents
    // the archon offer; it consumes the flag so one run offers once.
    this._trialRun = gate.rank === 'S' && canAscend(this.save);
    // STORM affinity's odometer: metres of real ground covered THIS run
    // (resonanceReading: +1 per 400 m travelled inside a gate). Run state,
    // never persisted — the counter it feeds lives on the save.
    this._travelAcc = 0;
    // SOVEREIGN'S WILL run state (CLASSES_SPEC step 8). All of it dies with
    // the run on purpose — "one enum on the run state" is the spec's own
    // wording for the stance, and a Legion cooldown that survived a gate exit
    // would be a saved field nobody sanitises. HUNT is the default because it
    // is the shipped behaviour: an unascended save's army runs this exact
    // enum value down the exact pre-step-8 code path.
    this._shadowStance = 'hunt';
    this._legionT = 0;           // LEGION STEP cooldown running down (45 s)
    this._summonHoldT = null;    // Bind-slot hold timer; null = no press live
    this._lastHitTarget = null;  // FOCUS's mark: the player's last-hit enemy
    // Path run state (CLASSES_SPEC steps 9-10). _archonPath is the gate for
    // every hook below: null for SHADOW (its machinery predates the
    // substrate) and every unascended save, so the shipped combat paths pay
    // one boolean read and nothing else; the mechanic hooks themselves
    // compare against the specific config (FLAME_P/FROST_P/STORM_P/BEAST_P),
    // never bare truthiness. The StatusTable and the Ashfall record are
    // session objects reused across runs (the residue-slot precedent); the
    // ArchonPool is per-gate (built here, disposed in _setMode) because its
    // quads must never linger into the city and dispose() is its one
    // teardown verb.
    this._archonPath = ARCHON_PATHS[this.save.archon] || null;
    this._combatT = 0;           // seconds of "still in combat" remaining
    if (!this._ashfall) this._ashfall = { t: 0, x: 0, z: 0, dmgAcc: 0, stackAcc: 0 };
    this._ashfall.t = 0; this._ashfall.dmgAcc = 0; this._ashfall.stackAcc = 0;
    // STORM + BEAST run state (step 10). All of it dies with the run on the
    // legion-cooldown precedent: a Tempest window or a Wild Form that
    // survived a gate exit would be a saved field nobody sanitises. A wild
    // mesh lingering from a torn-down run is restored first — _endWildForm
    // is idempotent and the base body must be back before the derive below
    // reads a sane player.
    this._endWildForm(true);
    this._tempestT = 0;          // TEMPEST STEP window remaining (6 s)
    this._wildT = 0;             // WILD FORM window remaining (12 s)
    this._wildCd = 0;            // WILD FORM cooldown running down (90 s)
    if (this._archonPath) {
      if (!this._archonStatus) {
        // BOTH kinds' rules on one table: a re-ascension can swap the path
        // between runs and the table is kind-keyed anyway — two rules on one
        // machine, never two machines. (Storm/beast own no kinds and simply
        // never apply; the table idles at size 0.)
        this._archonStatus = new StatusTable({
          pyre: FLAME_P.stacks.pyre, rime: FROST_P.stacks.rime,
        });
      } else this._archonStatus.disposeAll();
      if (!this._archonRes || this._archonResKey !== this._archonPath.key) {
        this._archonRes = new ResourceMeter(archonResourceRules(this._archonPath.key));
        this._archonResKey = this._archonPath.key;
      }
      // The bank survives gate exits (the HUD reads the same save field).
      this._archonRes.set(this.save.archonState?.resource || 0);
      // Pool only where the path DECLARES one — BEAST's vfx budget is "zero
      // new pools" and its config carries no fx entry on purpose.
      if (!this._archonFx && this._archonPath.fx) {
        this._archonFx = new ArchonPool(this.scene, {
          kind: this._archonPath.fx.kind,
          maxInstances: this._archonPath.fx.maxInstances,
        });
      }
    }
    this.runTime = 0;
    this.xpEarned = 0;
    this.ashEarned = 0;
    this.spawnTimer = 0;
    this.levelsGained = 0;
    this.pointsGained = 0;
    this.levelUpDilation = 0;

    // Carry the deployed roster into the new rift. The field cap is a draw-call
    // budget, so the quality tier gets the final word on how many come along.
    // BEAST ARCHON with a pact bound: the pact beast IS the deployment — one
    // ally consuming the entire allowance (its spawn refuses while any other
    // soldier stands, and _spawnShadow refuses while it does), so the roster
    // stays home. With no pact yet, the path plays its shipped army verbatim.
    const cap = this.fieldCapacity();
    const pact = this.save.archon === 'beast' ? this._activePact() : null;
    if (pact && cap > 0) {
      setDeployed(this.save, []);
      this._spawnPactBeast(pact, true);
    } else {
      autoDeploy(this.save, cap);
      for (const rec of deployedRecords(this.save)) {
        this._spawnShadow(this.world.randomSpawn(this.rnd, this.player.pos, 4), true, rec);
      }
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
    // The pact beast owns the whole allowance (step 10) — no soldier stands
    // beside it, whatever the capacity number says.
    if (this._pactFielded()) return null;
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
      // LEGION STEP's re-form leg (step 8): seconds until this recalled
      // soldier stands again, and its slot in the returning column. Declared
      // at spawn so every soldier shares one hidden class — the update loop
      // reads reform every frame.
      reform: 0, _reformSlot: 0,
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
    const mt = this._mastery;
    const playerHit = opts.origin !== 'shadow';
    // FOCUS's mark (step 8): "your last-hit target" is literally the last
    // enemy a player-origin application touched — weapon, skill and bleed
    // alike, because a bleed is the player's blade still working. One pointer
    // write per hit; _killEnemy clears it so the army never chases a corpse.
    if (playerHit) this._lastHitTarget = e;
    // SUNDER (BREAKER T1): a finisher opened this target's armour — +18% from
    // ALL sources, shadows included, until the clock (set in _applySwingHit,
    // run down in _updateEnemies) lapses. Refreshes, never stacks.
    if (e.sunderT > 0) amount *= 1 + MASTERY.sunder.bonusTakenPct;
    // FROZEN (FROST ARCHON, step 9): a frozen enemy takes +45% from all
    // sources — the window the ten Rime hits earned. e.frozenT is only ever
    // written by _applyRime, so this multiplies nothing for any other save.
    if (e.frozenT > 0) amount *= 1 + FROST_P.freeze.bonusTakenPct;
    // WILD FORM (BEAST ARCHON, step 10): 2.2x ATTACK POWER — every
    // player-origin application through this one funnel, which during the
    // form is basic attacks and their riders only, because Wild Form bars
    // the skill buttons outright ("no skills and no items"). Never the
    // army's blows: the pact beast fights beside the form, not inside it.
    if (this._wildT > 0 && playerHit) amount *= BEAST_P.wildForm.atkMul;
    // The class layer's per-hit terms (STEP 5 flags, consumed at the one
    // damage funnel — the Assay card's text is a contract, not a caption).
    // Player-origin only: a class shapes the hunter's own hand, never the
    // army's. All three magnitudes arrive pre-scaled by quality x resonance.
    //   BERSERKER — "+0.45% per 1% missing HP, to +40% at the edge": both
    //     numbers scale together (the worked example's 50.2% at advanced x
    //     resonance 3), so the cap is min()'d here, not baked into the rate.
    //   ORACLE — +18% while the target's telegraph clock runs: the same
    //     read PUNISH keys on below, so "winding up" means one thing.
    //   HEXWEAVER — -25% on BASIC output only. origin 'skill' marks skill
    //     and proc applications, shadows mark themselves, so the penalty
    //     lands exactly where the card says: the blade, not the rotation.
    const CF = this._classFlags;
    if (CF && playerHit) {
      if (CF.rageAtkPerMissingHpPct) {
        const missing = 100 * (1 - Math.max(0, this.player.hp) / this.derived.maxHp);
        amount *= 1 + Math.min(CF.rageMaxAtkBonus ?? 1, CF.rageAtkPerMissingHpPct * missing);
      }
      if (CF.windupDmgPct && e.telegraph > 0) amount *= 1 + CF.windupDmgPct;
      if (CF.basicAtkPct && opts.origin !== 'skill') amount *= 1 + CF.basicAtkPct;
    }
    // The archon combat clock: a landed hit — the player's or the army's — is
    // combat, and Ember/Barrier hold their bank while it runs.
    if (this._archonPath) this._combatT = ARCHON_COMBAT_SECONDS;
    // PUNISH (AUGUR T2): a hit landed inside the wind-up — the telegraph
    // timer the whole fairness system already keeps — deals +30%, and one roll
    // in four cancels the strike outright: the enemy loses the attack and
    // eats its own cooldown. The roll draws off the gate-seed fork
    // (_masteryRnd), never Math.random, so a replayed seed cancels the same
    // wind-ups. Player hits only: perception is the hunter's read, not the
    // army's.
    if (playerHit && mt && mt.per >= 2 && e.telegraph > 0 && this._masteryRnd) {
      amount *= 1 + MASTERY.punish.bonusPct;
      if (this._masteryRnd() < MASTERY.punish.cancelChance) {
        if (e.attack?.active) cancelAttack(e.attack);
        e.telegraph = 0;
        e.swing = 0;
        e._slam = false;
        // "Eats its own cooldown": the full base cadence, as if the blow had
        // been thrown — steerAgent will not re-ask before it.
        e.attackCd = Math.max(e.attackCd || 0, e.base?.attackCd || 1.2);
        this.fx.burst(tmpV.copy(e.pos).setY(1.3 * (e.base.scale || 1)), 10, READING_COLOR, { speed: 5, up: 2, life: 0.35 });
      }
    }
    // deepglass 5pc: a banked perfect dodge makes the next PLAYER hit a
    // guaranteed crit — one charge, consumed here, never by a shadow's blow
    // (they mark themselves with origin:'shadow').
    const forced = this._riposteCrit === true && playerHit;
    // ANSWER (WINDSTEP T2): a perfect dodge queued one guaranteed crit for the
    // next BASIC attack — weapon output only, so skill/proc applications mark
    // themselves origin:'skill' and pass through without consuming it.
    const answered = !forced && playerHit && mt && mt.agi >= 2
      && this._answerT > 0 && opts.origin !== 'skill';
    const crit = forced || answered || Math.random() < this.derived.crit;
    if (forced) this._riposteCrit = false;
    if (answered) this._answerT = 0;
    // CERTAINTY (+25%) and TEMPO (+6%/stack) scale the shipped 1.85 — the
    // spec's two sanctioned percentage exceptions, both capped, both
    // conditional. ANSWER's queued crit lands at 1.3x the multiplier the
    // build has actually earned. With no masteries every term is zero and
    // this is the shipped constant to the bit.
    let critMul = CRIT_MUL;
    if (crit && mt) {
      critMul *= 1 + (mt.per >= 3 ? MASTERY.certainty.critDmgAdd : 0)
        + (mt.agi >= 3 ? (this._tempoStacks || 0) * MASTERY.tempo.critDmgPerStack : 0);
      if (answered) critMul *= MASTERY.answer.critMul;
    }
    const dmg = Math.max(1, Math.round(amount * (crit ? critMul : 1)));
    e.hp -= dmg;
    e.hurt = 0.3;
    // Captured BEFORE the hit's own stagger applies: "killed while staggered"
    // (FROST affinity, read in _killEnemy) means the enemy was ALREADY held
    // when the killing blow landed — control converted to damage. Without
    // this, every melee blow that carries stagger would count its own kill
    // and the counter would just be a kill counter.
    const preHitStagger = e.stagger > 0;
    if (opts.stagger) e.stagger = Math.max(e.stagger, opts.stagger);
    // Armour-layer leech (Thirsting affix + ember_ring trinket): player-origin
    // hits only. 0 with nothing worn, so the shipped path is untouched.
    // Routed through _healPlayer (as is every incidental heal) so BERSERKER's
    // healingTakenPct prices it — x1 exactly with no class, same clamp.
    if (opts.origin !== 'shadow' && this._armorBonus && this._armorBonus.leech > 0) {
      this._healPlayer(dmg * this._armorBonus.leech);
    }
    // Class-layer leeches (STEP 5 flags): REAVER's rides EVERY player-origin
    // application ("+3% life leech on ALL damage" — weapon, skill and
    // projectile alike); TEMPLAR's rides skill applications only ("skills
    // heal 6% of the damage they deal"). Both pre-scaled, both through
    // _healPlayer so a future class carrying leech AND a healing tax prices
    // itself consistently.
    if (CF && playerHit) {
      if (CF.leechPct) this._healPlayer(dmg * CF.leechPct);
      if (CF.spellLeechPct && opts.origin === 'skill') this._healPlayer(dmg * CF.spellLeechPct);
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

    // FLAME + FROST hit hooks (step 9). "Every hit you land" is every
    // player-origin application through this one funnel — weapon, skill and
    // projectile alike — EXCEPT the path's own generated damage (combustion
    // blasts, shatter splits, the manual detonate), which marks itself
    // opts.noStatus so an explosion cannot farm the stacks that fired it.
    // Bleed/residue/ashfall ticks write hp directly and never arrive here.
    // The dying take no stacks: their table row is about to be cleared by
    // _killEnemy anyway.
    // Frozen-ness is read BEFORE this hit's own stack lands: the 10th-stack
    // hit FREEZES, it does not also shatter what it just froze — a shatter
    // needs a hit on an ALREADY-frozen enemy (the same pre-hit-truth shape as
    // preHitStagger above).
    const preFrozen = e.frozenT > 0;
    if (this._archonPath && playerHit && !opts.noStatus && e.hp > 0) {
      if (this._archonPath === FLAME_P) this._applyPyre(e, 1);
      else if (this._archonPath === FROST_P) this._applyRime(e, 1);
    }
    // ARC (STORM ARCHON, step 10): every landed player hit discharges
    // STORM_P.arc.discharge Charge (4 since the STEP 11 parity tune — see
    // archon.js) into a chain — same funnel, same noStatus exemption (a chain
    // link or a dash bolt cannot re-chain), but NO hp>0 gate: a killing blow
    // is still a landed hit and its lightning still leaves the body. Runs
    // BEFORE the death branch so the chain measures from where the target
    // stands, not from a spliced-out corpse.
    if (this._archonPath === STORM_P && playerHit && !opts.noStatus) this._tryArc(e);
    // SHATTER: a single hit on a frozen enemy exceeding 15% of its max HP.
    // Checked on the FINAL rounded dmg (crit included — a crit is still "a
    // single hit") and BEFORE the death branch, because a killing blow that
    // clears the line shatters too — kill-chaining by control is the path.
    // Re-entry is impossible by ordering, not by flag: _shatter thaws its
    // target BEFORE dealing the split, so no chain can find this enemy
    // frozen again — while a frozen NEIGHBOUR hit hard enough by the split
    // legitimately shatters on its own inside the nested call.
    if (preFrozen && dmg >= e.maxHp * FROST_P.shatter.hitFracOfMaxHp) {
      this._shatter(e, dmg);
    }

    if (e.hp <= 0) {
      // Hand _killEnemy the pre-hit stagger truth; null for every OTHER
      // caller (bleed ticks, direct calls), which fall back to the live read
      // — a bleed death applies no stagger of its own, so its live read IS
      // the pre-hit truth.
      this._staggeredKill = preHitStagger;
      // Same handoff shape for WILD FORM's kill credit ("-6 s per kill made
      // while transformed"): the army's blows pass false, everything the
      // player's own damage lands passes true. Callers that bypass this
      // funnel (bleed/burn ticks writing hp directly) default to true in
      // _killEnemy — those wounds are the player's blade still working.
      this._wildKill = playerHit;
      this._killEnemy(e);
      this._staggeredKill = null;
      this._wildKill = null;
    }
    // Whether this application critted — _applySwingHit feeds it to the
    // WHISPERFANGS refund. A boolean, not the damage: rules read tempo, never
    // numbers (the legendary law).
    return crit;
  }

  /**
   * Every incidental heal — armour leech, finisher leech, REAVER's leech,
   * TEMPLAR's spell leech — lands through here so BERSERKER's healingTakenPct
   * (a drawback the card PROMISES: "HEALING RECEIVED -35%") prices all of it
   * uniformly. hpRegen deliberately does NOT route here: the card lists "HP
   * REGEN -50%" as its own term and that one is already a pct entry on
   * derived.hpRegen — taxing regen twice would punish the class beyond its
   * printed text. The flag is stored negative, so (1 + it) is the cut.
   */
  _healPlayer(amount) {
    const CF = this._classFlags;
    if (CF && CF.healingTakenPct) amount *= 1 + CF.healingTakenPct;
    if (!(amount > 0)) return;
    this.player.hp = Math.min(this.derived.maxHp, this.player.hp + amount);
  }

  _killEnemy(e) {
    e.hp = 0;
    this.killed++;
    this.player.kills++;
    this.save.totalKills++;
    // A dead mark is no mark (FOCUS, step 8): cleared here, at the one place
    // every death funnels through, so _shadowTarget's hp>0 read is belt on
    // top of this brace.
    if (this._lastHitTarget === e) this._lastHitTarget = null;
    // A dead body burns and freezes no further (step 9): its stack row goes
    // back to the pool here so the table can never grow past the live field.
    // The corpse keeps whatever tint it died wearing — a charred husk reads
    // correctly — and its cloned tint materials are freed with its mesh by
    // the existing disposeObject3D walk.
    if (this._archonStatus) this._archonStatus.clear(e);
    e.frozenT = 0;

    // Affinity counters (CLASSES_SPEC unlock.resonanceReading) — the save
    // remembering HOW this player already fights, read at the trial's end by
    // archonOffers. Bumped at the kill site because every clause below is a
    // property of the kill itself; persistence rides the existing onSave
    // cadence (gainXp below, the 6 s heartbeat). Read BEFORE any state is
    // torn down: e.stagger and the tier map are still the dying enemy's own.
    //   frost +2 — a kill on an ALREADY-staggered enemy (control converted
    //              to damage; _damageEnemy hands over the PRE-hit stagger
    //              truth so the killing blow's own stagger cannot count);
    //   beast +1 — an elite (brute/lancer/howler, the same tier map
    //              extraction weighs corpses with);
    //   beast +3 — a boss. "Without dying" is structural, not a check: a
    //              death ends the run on the spot (_fail), so every boss a
    //              player kills, they killed without dying;
    //   flame +1 — a kill by the combo FINISHER's own cone (the transient
    //              flag _applySwingHit raises around exactly those hits).
    if (this._staggeredKill ?? (e.stagger > 0)) bumpAffinity(this.save, 'frost', 2);
    if (e.isBoss) bumpAffinity(this.save, 'beast', 3);
    else if (tierWeightOf(e) === 'elite') bumpAffinity(this.save, 'beast', 1);
    if (this._finisherBlow) bumpAffinity(this.save, 'flame', 1);

    // WILD FORM's cooldown falls 6 s per kill made while transformed
    // (classes.js resourceRules.cooldownPerKill — the BEAST path's only
    // economy). Player kills only, via the _wildKill handoff above; a null
    // (bleed/burn/direct callers) defaults to the player's credit.
    if (this._wildT > 0 && (this._wildKill ?? true)) {
      this._wildCd = Math.max(0, (this._wildCd || 0) - WILD_CD_PER_KILL);
    }

    // The class layer's kill riders (STEP 5 flags):
    //   REAVER — "every kill grants +6% speed / +4% attack speed for 4 s,
    //     stacking to 5": one stack banked per kill, the 4 s window
    //     refreshing with each (a chain holds full momentum; the whole
    //     stack sheds when it lapses — REAVER snowballs THROUGH a room, it
    //     does not coast between fights at full tilt). Any kill counts:
    //     momentum doesn't audit whose blade finished the job.
    //   VANGUARD — "kill anything and the remainder is cancelled": the
    //     deferred pool _damagePlayer banked is forgiven outright, which is
    //     what makes the deferral aggressive rather than passive.
    const KF = this._classFlags;
    if (KF) {
      if (KF.killStackMax) {
        this._killStacks = Math.min(KF.killStackMax, (this._killStacks || 0) + 1);
        this._killStackT = KF.killStackSeconds || 4;
      }
      if (KF.bleedCancelOnKill && this._vgPool > 0) {
        this._vgPool = 0;
        this.fx.ring(this.player.pos, 0xffc24b, 2.0, 0.22);
      }
    }

    const mt = this._mastery;
    // RUINOUS (BREAKER T3), half one: kills refresh the combo window, so a
    // room chains as one long combo. The machine's own bookkeeping: `chain`
    // only runs between steps, and refilling it to the weapon's full window
    // is exactly what "comboTimer back to full" meant before the machine
    // replaced that field. Mid-swing needs nothing — the chain re-arms fresh
    // at step end anyway.
    if (mt && mt.str >= 3) {
      const st = this.player.attack;
      if (st && !st.active && st.chain > 0 && this.weapon) {
        st.chain = this.weapon.chainWindow;
      }
    }
    // KINDLING (EMBERMIND T1): a kill inside 3 s of a skill cast refunds 20%
    // of THAT cast's mana cost, kill by kill, stacking up to the full cost —
    // a rotation payout, not a mana battery.
    if (mt && mt.int >= 1 && this._kindlingT > 0 && this._kindlingPaid < this._kindlingCost) {
      const chunk = Math.min(
        this._kindlingCost * MASTERY.kindling.refundFrac,
        this._kindlingCost - this._kindlingPaid,
      );
      this._kindlingPaid += chunk;
      this.player.mp = Math.min(this.derived.maxMp, this.player.mp + chunk);
    }

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
      // ASHEN SIGIL (CLASSES_SPEC reascension): S bosses only, one per three
      // clears — a 1/3 draw off the run's own archonRnd fork, never
      // Math.random, so a replayed seed pays the same sigil. Dropped whether
      // or not the save is ascended yet: a sigil banked before the first
      // ascension is a re-read the player already earned. Capped like
      // respecTokens so a farmed counter cannot grow unbounded.
      if (this.gate?.rank === 'S' && this._archonRnd && this._archonRnd() < 1 / 3) {
        const st = this.save.archonState;
        if (st && (st.sigils || 0) < 99) {
          st.sigils = (st.sigils || 0) + 1;
          this.ui.toast('ASHEN SIGIL CLAIMED', 'gold');
        }
      }
      // THE REACH resolves (CLASSES_SPEC unlock.trial): reaching and killing
      // the Rift Archon under the trial flag is the whole trial, so the offer
      // opens HERE, at the corpse, in both worlds — the arena's instant
      // _clearGate below stacks the results panel UNDER the offer (z-order),
      // and the crawl's walk-out portal simply waits behind it. Eligibility
      // is re-checked because a mid-run migration/level change could have
      // moved it; the flag burns either way so one run offers once.
      if (this._trialRun) {
        this._trialRun = false;
        if (canAscend(this.save)) this._offerAscension();
      }
      // A boss leaves a corpse for a BEAST ARCHON alone (step 10): pacts are
      // bound "from a boss or elite corpse" and bosses shipped corpseless —
      // this is the smallest true reading, gated so every other save keeps
      // the corpseless boss byte-for-byte. type 'boss' rides shadowCombat's
      // own BOSS_BASE line; in the arena the instant results screen makes it
      // moot, in a crawl the walk-out window is the binding window.
      if (this.save.archon === 'beast') {
        const bossCorpse = this._makeCorpseMesh(e, boundCreature);
        bossCorpse.position.copy(e.pos);
        bossCorpse.rotation.y = e.yaw;
        bossCorpse.position.y = 0.25;
        this.scene.add(bossCorpse);
        this.corpses.push({
          mesh: bossCorpse, pos: e.pos.clone(), life: CORPSE_WINDOW,
          type: 'boss', creature: boundCreature,
          enemyLevel: e.level, tierWeight: 'boss', attempts: 0,
        });
      }
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
    // Being swung on is combat, dodged or not — the Ember/Barrier banks hold
    // while anything is still trying to kill you (step 9).
    if (this._archonPath) this._combatT = ARCHON_COMBAT_SECONDS;
    if (p.invuln > 0) {
      // STORM affinity (resonanceReading: +2 per dash that CLEARS an attack):
      // this hit arrived while the dash's own i-frames were live — dashTimer
      // only runs during the 0.26 s dash — which is the definition of the
      // dash having cleared it. Deliberately wider than the perfect-dodge
      // window below: a dash that dodged sloppily still dodged, and the two
      // counters measure two different instincts (mobility vs timing).
      if (p.dashTimer > 0) bumpAffinity(this.save, 'storm', 2);
      // Perfect dodge: this hit arrived inside the dodge window of the dash
      // that granted the current i-frames. _dodgeT only ever starts at dash
      // time, so spawn/level-up/post-hit invulnerability can never count.
      if (p._dodgeT > 0) {
        // FROST affinity (+1 per perfect dodge) — on the DETECTION, not on
        // the WINDSTEP ladder below it, which early-returns without agi
        // masteries. The counter is about how you play, not what you own.
        bumpAffinity(this.save, 'frost', 1);
        const rip = this._rules?.get('dodge_riposte');
        if (rip) {
          // Refund rides EVERY perfectly dodged hit; the crit charge is one,
          // unstackable, consumed by the next connecting hit (_damageEnemy).
          p.mp = Math.min(this.derived.maxMp, p.mp + Math.max(1, Math.round(amount * rip.manaRefund)));
          this._riposteCrit = true;
          this.fx.ring(p.pos, 0x66e0ff, 3.2, 0.3);
          this.audio.skill();
        }
        // WINDSTEP's whole ladder keys on the same detection (CLASSES_SPEC:
        // "the perfect-dodge detection is the only new bit and it belongs
        // next to the existing p.invuln check").
        this._onPerfectDodge();
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
    let dmg = Math.max(1, Math.round(raw));
    const mt = this._mastery;
    // IRONHIDE (BULWARK T1): a hard cap on burst, applied AFTER every
    // mitigation above — no single hit takes more than 12% of max HP. This is
    // what lets a VIT build survive an A/S boss's opener, which raw HP cannot:
    // the linear stat buys a bigger pool, the mastery bounds how fast one blow
    // drains it.
    if (mt && mt.vit >= 1) {
      dmg = Math.min(dmg, Math.max(1, Math.round(d.maxHp * MASTERY.ironhide.maxHitFracOfMaxHp)));
    }
    // WILD FORM (BEAST ARCHON, step 10): 40% FLAT damage reduction for the
    // 12 s window. After IRONHIDE like the Barrier below and for the same
    // reason — a form that ate pre-cap damage would silently waive the cap —
    // and floored at 1 like every damage floor in this method.
    if (this._wildT > 0) {
      dmg = Math.max(1, Math.round(dmg * (1 - BEAST_P.wildForm.flatDr)));
    }
    // GLACIAL BARRIER (FROST ARCHON, step 9): the shield absorbs before HP.
    // The meter is denominated in PERCENT of max HP (classes.js rules: +0.4
    // per Rime applied, cap 35, decay 2/s out of combat), so the conversion
    // happens here, at the one spend site, and the meter itself stays a pure
    // scalar the node suite can drive. Applied AFTER every mitigation —
    // including IRONHIDE's burst cap — because a shield that ate pre-cap
    // damage would silently waive the cap. Everything downstream (flinch,
    // knockback, invuln) still runs: a blocked blow still rocks you, only
    // the HP ledger is spared.
    if (this._archonPath === FROST_P && this._archonRes && this._archonRes.value > 0) {
      const shieldHp = (this._archonRes.value / 100) * d.maxHp;
      const absorbed = Math.min(dmg, Math.floor(shieldHp));
      if (absorbed > 0) {
        dmg -= absorbed;
        this._archonRes.spend((absorbed * 100) / d.maxHp);
        this.fx.ring(p.pos, FROST_COLOR, 2.2, 0.25);
      }
    }
    // VANGUARD's deferral (STEP 5 benefit flags): "25% OF EVERY HIT ARRIVES
    // AS A 3S BLEED — KILL ANYTHING AND THE REMAINDER IS CANCELLED". The
    // split takes the FINAL mitigated figure — after IRONHIDE and the
    // Barrier, for the same reason those sit last: deferring pre-cap damage
    // would silently waive the caps. The pool drains in _updatePlayer (it
    // can kill — the escape clause is killing something, not waiting) and
    // _killEnemy forgives it. bleedFrac is an UNSCALED shape flag: deferring
    // MORE would not be better, which is why quality never touches it.
    const CFP = this._classFlags;
    if (CFP && CFP.bleedFrac > 0 && dmg > 1) {
      const defer = Math.floor(dmg * CFP.bleedFrac);
      if (defer > 0) {
        dmg -= defer;
        this._vgPool = (this._vgPool || 0) + defer;
        // Overlapping hits share one clock: the whole pool re-amortises over
        // a fresh 3 s window — one integer and one rate, no queue, nothing
        // allocated per hit.
        this._vgRate = this._vgPool / (CFP.bleedSeconds || 3);
      }
    }
    const hpBefore = p.hp;
    p.hp -= dmg;
    // RIPOSTE (BULWARK T2): taking a hit while ABOVE half health returns 25%
    // of the post-mitigation damage as a 3.5 m shockwave, on a 0.9 s internal
    // cooldown. The blast is BANKED here and applied at the top of
    // _updateEnemies: _damagePlayer fires from inside the enemy for..of, and
    // a kill splicing this.enemies mid-iteration is the documented hazard the
    // bleed pass already routes around.
    if (mt && mt.vit >= 2 && hpBefore > d.maxHp * MASTERY.riposte.minHpFrac
      && (this._riposteT ?? 0) <= 0 && this._riposteFire) {
      this._riposteT = MASTERY.riposte.cooldown;
      this._riposteFire.armed = true;
      this._riposteFire.x = p.pos.x;
      this._riposteFire.z = p.pos.z;
      this._riposteFire.dmg = dmg * MASTERY.riposte.returnFrac;
      this.fx.ring(p.pos, 0xffc24b, MASTERY.riposte.radius, 0.35);
    }
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
      // UNYIELDING (BULWARK T3): one lethal hit per 90 s leaves 1 HP and 2 s
      // of the invulnerability field the dash already writes. The cooldown is
      // REAL run time (ticked on _frameDt in _updatePlayer, so hit-stop and
      // level-up dilation cannot stretch it) and is never persisted.
      if (mt && mt.vit >= 3 && (this._unyieldingT ?? 0) <= 0) {
        this._unyieldingT = MASTERY.unyielding.cooldown;
        p.hp = 1;
        p.invuln = Math.max(p.invuln, MASTERY.unyielding.invulnSeconds);
        this.ui.toast('UNYIELDING', 'gold');
        this.fx.ring(p.pos, 0xffc24b, 5, 0.6);
        this.audio.skill();
        return;
      }
      p.hp = 0;
      p.alive = false;
      // A death sheds the wild shape FIRST (step 10): the base body is what
      // plays the Death clip, and a beast mesh outliving its player would be
      // exactly the linger _endWildForm's one-verb teardown exists to stop.
      this._endWildForm(true);
      // The hunter falls before the fail screen reads him his rites: the Death
      // clip starts here and _updatePlayer's dead branch keeps the mixer
      // ticking, since the living animate path stops the moment alive flips.
      p.mesh.userData.character?.play('die', { fade: 0.08, once: true, clamp: true });
      this._fail();
    }
  }

  /**
   * WINDSTEP's mastery ladder, fired once per perfectly dodged hit (the
   * p._dodgeT branch of _damagePlayer — a hit i-framed inside the dodge
   * window of the dash that granted the frames).
   *
   *   T1 SLIPSTREAM — the dash cooldown refunds IN FULL and 0.6 s of +35%
   *      attack speed opens (consumed as a clock scale on tickAttack, the
   *      same lever a Quick affix pulls, so it speeds the whole swing).
   *   T2 ANSWER — one guaranteed crit is queued for the next basic attack
   *      landed inside 1.2 s (branch in _damageEnemy's crit roll).
   *   T3 TEMPO — dodges chain: each within 4 s of the last banks a stack
   *      (max 5) of +8% move speed / +6% crit damage; once the chain lapses
   *      one stack decays every 2 s. An integer and two timers — the stacks
   *      multiply in at the consumption sites, never into this.derived.
   */
  _onPerfectDodge() {
    const mt = this._mastery;
    if (!mt || mt.agi < 1) return;
    const p = this.player;
    p.cds.dash = 0;
    this._slipT = MASTERY.slipstream.seconds;
    this.fx.burst(p.pos.clone().setY(0.9), 10, 0x9dd8ff, { speed: 5, up: 2, life: 0.35 });
    if (mt.agi >= 2) this._answerT = MASTERY.answer.window;
    if (mt.agi >= 3) {
      this._tempoStacks = Math.min(MASTERY.tempo.maxStacks, (this._tempoStacks || 0) + 1);
      this._tempoChainT = MASTERY.tempo.chainWindow;
      this._tempoDecayT = 0;
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
      // RANK-UP CEREMONY (Wave F): rankOf transitions used to be silent label
      // changes — the audit's "meaningful level-ups" gap. A grade crossing is
      // the game's biggest progression beat short of ascension, so it gets its
      // own moment ON TOP of the level-up: a second, longer dilation, a
      // distinct toast, and a big ring in the NEW grade's portal colour. The
      // full ceremony screen is Wave G's; this makes the beat exist at all.
      const fromRank = rankOf(fromLevel);
      const toRank = rankOf(this.save.level);
      if (fromRank !== toRank) {
        const rankColor = PORTAL_COLORS?.[toRank] ?? 0xffc24b;
        this.fx.ring(this.player.pos, rankColor, 16, 1.4);
        this.ui.toast(`YOU ASSAY AS ${toRank}-GRADE NOW`, 'gold');
        this.levelUpDilation = 0.9;
      }
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
      // The staff is the one basic attack with a mana price, so ORACLE's and
      // REAVER's surcharge lists — which name 'attack' — price it here and
      // at the cast/tick sites below, all through the same multiplier.
      const need = (ns.bolt ? STAFF.boltMp : (ns.beam ? STAFF.beam.mpPerTick : 0))
        * this._skillCostMul('attack');
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
    // FLAME affinity (+1 per enemy KILLED BY A COMBO FINISHER): a transient
    // flag around exactly the finisher's own cone hits — _killEnemy reads it
    // mid-_damageEnemy. The AFTERSHOCK shockwave and the emberfall detonate
    // below deliberately do not count; they are riders, not the finisher.
    // Cleared in the finally so an exception can never leave it stuck on.
    this._finisherBlow = Boolean(step.finisher);
    try {
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
    } finally { this._finisherBlow = false; }
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
      // BREAKER's finisher ladder (CLASSES_SPEC step 4). The finisher is the
      // combo's whole identity, so all three masteries hang off it.
      const mt = this._mastery;
      if (mt && mt.str >= 1) {
        // T1 SUNDER: every connecting finisher opens ARMOUR BREAK — the
        // target takes +18% from all sources (read in _damageEnemy, run down
        // in _updateEnemies) for 5 s. Refreshes, never stacks.
        hits.forEach((e) => { if (e.hp > 0) e.sunderT = MASTERY.sunder.seconds; });
        if (mt.str >= 2) {
          // T2 AFTERSHOCK: the finisher also detonates a 5 m shockwave for
          // 40% of atk, riding the existing finisher ring + shake — no new
          // VFX asset (spec impl note). Snapshot, because _damageEnemy
          // splices the dead out of this.enemies. origin:'skill' so the
          // blast can never eat ANSWER's queued basic-attack crit.
          const ar = MASTERY.aftershock.radius;
          [...this.enemies].forEach((e) => {
            if (e.hp > 0 && tmpV2.copy(e.pos).sub(p.pos).setY(0).length() <= ar + e.radius) {
              this._damageEnemy(e, this.derived.atk * MASTERY.aftershock.atkFrac, {
                from: p.pos, knockback: 4, origin: 'skill',
              });
            }
          });
          this.fx.ring(p.pos, 0xffc24b, ar, 0.4);
          this.fx.addShake(0.35);
        }
        if (mt.str >= 3) {
          // T3 RUINOUS, half two: every 3rd finisher THROWN (hit or miss —
          // the count is cadence, like the emberfall 5pc counter above)
          // staggers everything within 7 m for 0.8 s. Stagger is already an
          // enemy field; no damage rides along.
          this._ruinFin = (this._ruinFin || 0) + 1;
          if (this._ruinFin % MASTERY.ruinous.staggerEvery === 0) {
            const rr = MASTERY.ruinous.staggerRadius;
            for (const e of this.enemies) {
              if (e.hp > 0 && tmpV2.copy(e.pos).sub(p.pos).setY(0).length() <= rr + e.radius) {
                e.stagger = Math.max(e.stagger, MASTERY.ruinous.staggerSeconds);
              }
            }
            this.fx.ring(p.pos, 0xff8c3a, rr, 0.5);
            this.fx.addShake(0.3);
          }
        }
      }
    }
    // A released charge moves more air: scale the whiff-or-hit rumble with
    // what the hold earned, so a full-charge release reads without a tooltip.
    if (cMul > 1) this.fx.addShake(0.2 * (cMul - 1));
    if (step.finisher) this.fx.ring(p.pos, 0x9dd8ff, 4.5, 0.35);
    if (step.finisher) {
      // emberfall 4pc: finishers leech 3% of damage DEALT — per connecting
      // target, because dmg here is per-target. Through _healPlayer so the
      // BERSERKER healing tax prices it like every other incidental heal.
      const fl = this._armorBonus?.finisherLeech || 0;
      if (fl > 0 && hits.length) {
        this._healPlayer(dmg * fl * hits.length);
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
          this._bowCue(p);
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
      // everything it can.
      b.fullCued = true;
      this._bowCue(p);
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

  /**
   * The full-draw / refund cue. Used to be fx.ring at the player's FEET —
   * which read as a ground shockwave, not a bow-side signal (audit). Now the
   * atlas cast rune at arrow launch height, tinted the conjured element's
   * colour, plus the same tick. _bowFrom is fire-time scratch; the fire that
   * follows re-sets it before reading.
   */
  _bowCue(p) {
    const element = this._arrowElement();
    _bowFrom.set(p.pos.x, BOW.launchY, p.pos.z);
    this.fx.flash(_bowFrom, 'magic_01', {
      size: 0.6, life: 0.2, color: element ? TINT_TARGETS[element] : 0xffe2a8,
    });
    this.audio.tone({ freq: 1500, type: 'sine', gain: 0.05, decay: 0.08 });
  }

  /**
   * THE CONJURED ARROW's element. A bow never carries ammo — every arrow is
   * conjured — and an Archon's arrows are conjured OF their element: the
   * status already flows (every arrow hit passes _damageEnemy's archon
   * funnel), this makes it VISIBLE. Only paths with a TINT_TARGETS entry get
   * a colour (flame/frost/storm); beast/shadow/sovereign arrow identity is a
   * deferred design decision (audit), and the unascended conjure is the
   * neutral arcane gold the bow has always spoken in.
   */
  _arrowElement() {
    const k = this._archonPath?.key;
    return (k && TINT_TARGETS[k] !== undefined) ? k : null;
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
    const element = this._arrowElement();
    const arrowColor = element ? TINT_TARGETS[element] : 0xffe2a8;
    const rec = this.pool.spawn({
      from: _bowFrom, dir: _bowDir, vy, g: BOW.gravity, speed,
      damage: dmg, life: BOW.life, kind: 'arrow', color: arrowColor,
      knock: BOW.knock * (w.knockMul || 1), stagger: BOW.stagger,
      element,
    });
    // Records are reused: clear the staff stamps a previous life may carry,
    // or a plain arrow would inherit homing and an arcane impact. fullDraw
    // marks the shot for GALESTING ASCENDANT's refund-on-kill.
    if (rec) { rec.staff = false; rec.staffTarget = null; rec.fullDraw = f >= 1 - 1e-6; }
    // THE CONJURE MOMENT: the arrow materializes at the launch point as the
    // string lets go — the atlas cast rune, element-tinted, at arrow height.
    // (The nocked-arrow-in-hand during the draw is Wave D's animation stage;
    // it needs the two-rig socket work and a draw pose.)
    this.fx.flash(_bowFrom, 'magic_01', { size: 0.85, life: 0.22, color: arrowColor });

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
    const boltCost = STAFF.boltMp * this._skillCostMul('attack');
    if (p.mp < boltCost) {
      this.ui.toast('NOT ENOUGH MANA');
      this.fx.burst(_staffFrom.copy(p.pos).setY(STAFF.launchY), 4, 0x9db0ff, { speed: 2, up: 1, life: 0.25 });
      return;
    }
    p.mp -= boltCost;

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
    // The class 'attack' surcharge multiplies the whole tick, EMBERSTAVE
    // discount included — a taxed channel is taxed on what it actually pays.
    const fx = b?.w?.rule?.fx;
    const base = (fx?.beamCheapT != null && b.t > fx.beamCheapT)
      ? STAFF.beam.mpPerTick * (fx.beamCostMul || 1)
      : STAFF.beam.mpPerTick;
    return base * this._skillCostMul('attack');
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
    // dashDistance/dashIframes are class-touched derived fields (VANGUARD's
    // -20% distance, BLADEDANCER's 0.34 -> 0.42 s i-frames): applyModifiers
    // seeds them from SKILLS.dash only when a class term touches them, so
    // the ?? fallback IS the shipped constant for every other save.
    const dashDist = this.derived.dashDistance ?? SKILLS.dash.distance;
    const v0 = p.body.impulseForDistance(dashDist);
    p.body.addImpulse(dir.x * v0, 0, dir.z * v0);
    p.yaw = Math.atan2(dir.x, dir.z);
    p.invuln = Math.max(p.invuln, this.derived.dashIframes ?? SKILLS.dash.iframes);
    p.dashTimer = 0.26;
    // A hit i-framed within this window of the dash START is a PERFECT dodge
    // (_damagePlayer's invuln branch) — derived.dodgeWindow finally consumed.
    p._dodgeT = this.derived.dodgeWindow;
    // derived.dashCd is SKILLS.dash.cd exactly until the issue 4pc (-0.25 s)
    // or BLADEDANCER's -0.55 s; TEMPLAR's cooldown tax multiplies on top.
    p.cds.dash = this.derived.dashCd * this._skillCdMul();
    // TEMPEST STEP (step 10): dash cooldown zero, and every dash leaves a
    // bolt that deals 90% of atk along its line. The bolt resolves NOW, down
    // the authored dash line (dir x the skill's distance) — the body solves
    // the same travel over the next frames, so the line is the dash. Enemies
    // within boltHalfWidth (+ their radius) of the segment take the hit,
    // marked noStatus + origin 'skill' like every path-generated blast: a
    // bolt must not chain an Arc or eat ANSWER's queued basic-attack crit.
    if (this._tempestT > 0) {
      p.cds.dash = 0;
      const T = STORM_P.tempest;
      const len = dashDist;   // the bolt IS the dash line, class-priced and all
      const dmg = this.derived.atk * T.boltAtkPct;
      // dir IS tmpV (both branches above) and _damageEnemy consumes tmpV
      // internally — the file-header aliasing lesson — so the line lives in
      // SCALARS and the endpoint pair before the first nested call.
      const dirX = dir.x;
      const dirZ = dir.z;
      const ox = p.pos.x;
      const oz = p.pos.z;
      _archV.set(ox, 1.0, oz);
      _archV2.set(ox + dirX * len, 1.0, oz + dirZ * len);
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        if (e.hp <= 0 || e.spawning > 0) continue;
        // Closest point on the segment to the enemy, in the ground plane.
        const ex = e.pos.x - ox;
        const ez = e.pos.z - oz;
        const t = Math.max(0, Math.min(len, ex * dirX + ez * dirZ));
        const dx = ex - dirX * t;
        const dz = ez - dirZ * t;
        if (dx * dx + dz * dz > (T.boltHalfWidth + e.radius) * (T.boltHalfWidth + e.radius)) continue;
        this._damageEnemy(e, dmg, { from: p.pos, knockback: 3, origin: 'skill', noStatus: true });
      }
      if (this._archonFx) {
        this._archonFx.spawnSegment(_archV, _archV2, { life: 0.25, scale: 1.4 });
      }
      this.fx.burst(_archV2.clone().setY(0.8), 10, STORM_COLOR, { speed: 6, up: 3, life: 0.3 });
    }
    this.audio.dash();
    this.fx.burst(p.pos.clone().setY(0.7), 16, 0x9dd8ff, { speed: 4, up: 2, life: 0.4 });
  }

  /**
   * EMBERMIND's price-and-payoff read for one skill cast, taken BEFORE the
   * mana check so OVERCHARGE's free cast is free at the gate, not refunded
   * after it. Pure read — nothing advances until _noteSkillCast commits.
   *
   * OVERCHARGE (T3): every 4th cast inside a rolling 10 s window costs 0 and
   * deals 1.6x. The counter dies with the window, so it rewards a ROTATION,
   * not a stockpile — three casts banked on Monday buy nothing on Tuesday.
   */
  _skillCastPlan(sk, key) {
    const mt = this._mastery;
    if (mt && mt.int >= 3) {
      if ((this._overT ?? 0) <= 0) this._overN = 0;
      if ((this._overN || 0) + 1 >= MASTERY.overcharge.every) {
        return { cost: 0, mul: MASTERY.overcharge.dmgMul, free: true };
      }
    }
    // The class surcharge prices the REAL cast; OVERCHARGE's free cast above
    // stays free (nothing paid, nothing surcharged) and KINDLING refunds off
    // plan.cost, so a taxed cast refunds off its taxed price — consistent.
    return { cost: Math.round(sk.mp * this._skillCostMul(key)), mul: 1, free: false };
  }

  /**
   * The class layer's mana surcharge on ONE skill (STEP 5 drawback flags):
   * skillCostPct (pre-softened by resonance) raises the cost of exactly the
   * skills the card names in skillCostSkills — 'attack' is the staff's
   * bolt/beam (the one basic attack with a mana price), 'summon' is free by
   * design so listing it prices nothing, and dash costs no mana. x1 for a
   * class without the term and for every un-classed save.
   */
  _skillCostMul(key) {
    const CF = this._classFlags;
    if (!CF || !CF.skillCostPct || !Array.isArray(CF.skillCostSkills)) return 1;
    return CF.skillCostSkills.includes(key) ? 1 + CF.skillCostPct : 1;
  }

  /** TEMPLAR's "ALL COOLDOWNS +15%" (drawback flag cooldownPct, resonance-
   *  softened): one multiplier on every skill clock at its arming site —
   *  dash, Ruin, Nova, Bind. Applied at arming rather than in the tick so
   *  the HUD wipe and the felt wait agree. x1 without the term. */
  _skillCdMul() {
    return 1 + (this._classFlags?.cooldownPct || 0);
  }

  /**
   * Commit one skill cast to the EMBERMIND masteries. Called by _trySlash and
   * _tryNova after the cast is definitely happening.
   *
   *   T1 KINDLING — arm the 3 s kill-refund window on THIS cast's real cost
   *      (a free OVERCHARGE cast arms a zero window: nothing paid, nothing
   *      refunded); _killEnemy pays it out 20% per kill up to the full cost.
   *   T2 RESIDUE — the cast leaves a 4 m field at the cast point for 3 s,
   *      12% of atk per second, max 3 live (slots reused oldest-first).
   *   T3 OVERCHARGE — advance the rotation counter and re-open the window;
   *      the 4th wraps to 0, so the ladder repeats.
   */
  _noteSkillCast(plan) {
    const mt = this._mastery;
    if (!mt) return;
    if (mt.int >= 1) {
      this._kindlingT = MASTERY.kindling.window;
      this._kindlingCost = plan.cost;
      this._kindlingPaid = 0;
    }
    if (mt.int >= 2) {
      const R = this._residue;
      if (R) {
        let slot = null;
        for (const f of R) if (f.t <= 0) { slot = f; break; }
        if (!slot) { slot = R[0]; for (const f of R) if (f.t < slot.t) slot = f; }
        slot.x = this.player.pos.x;
        slot.z = this.player.pos.z;
        slot.t = MASTERY.residue.seconds;
        slot.acc = 0;
      }
    }
    if (mt.int >= 3) {
      this._overN = ((this._overN || 0) + 1) % MASTERY.overcharge.every;
      this._overT = MASTERY.overcharge.window;
      if (plan.free) this.fx.ring(this.player.pos, RESIDUE_COLOR, 3, 0.35);
    }
  }

  _trySlash() {
    const p = this.player;
    const sk = SKILLS.slash;
    if (p.cds.slash > 0) return;
    // WILD FORM bars the skill buttons outright (step 10, spec verbatim:
    // "no skills and no items") — the form's 2.2x is basic attacks' alone.
    if (this._wildT > 0) return this.ui.toast('THE BEAST KNOWS NO SKILLS');
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`RUIN UNLOCKS AT LEVEL ${sk.unlockLevel}`);
    const plan = this._skillCastPlan(sk, 'slash');
    if (p.mp < plan.cost) return this.ui.toast('NOT ENOUGH MANA');
    // A skill cast takes both hands; the channel ends first.
    this._endStaffBeam();
    p.mp -= plan.cost;
    this._noteSkillCast(plan);
    p.cds.slash = sk.cd * this._skillCdMul();
    // Visual arm-swing only — the skill applies its own damage immediately and
    // never enters the weapon machine.
    p.skillSwing = 0.3;
    this._faceNearest(sk.range);

    const hits = this._coneTargets(p.pos, p.yaw, sk.range, sk.arc);
    // origin:'skill' — skill damage never consumes ANSWER's queued crit
    // (that charge belongs to the next BASIC attack, per the mastery text).
    hits.forEach((e) => this._damageEnemy(e, this.derived.atk * sk.dmg * this.derived.skillMul * plan.mul, {
      knockback: 7, stagger: 0.35, from: p.pos, origin: 'skill',
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
    // WILD FORM: no skills (step 10) — same bar as _trySlash, same reason.
    if (this._wildT > 0) return this.ui.toast('THE BEAST KNOWS NO SKILLS');
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`NOVA UNLOCKS AT LEVEL ${sk.unlockLevel}`);
    const plan = this._skillCastPlan(sk, 'nova');
    if (p.mp < plan.cost) return this.ui.toast('NOT ENOUGH MANA');
    // A skill cast takes both hands; the channel ends first.
    this._endStaffBeam();
    p.mp -= plan.cost;
    this._noteSkillCast(plan);
    p.cds.nova = sk.cd * this._skillCdMul();

    const r = sk.radius;
    // Snapshot: _damageEnemy can splice the dead out of this.enemies, and
    // mutating the array being iterated made Nova silently skip targets.
    let novaHits = 0;
    [...this.enemies].forEach((e) => {
      const d = e.pos.distanceTo(p.pos);
      if (d < r) {
        novaHits++;
        // Falloff keeps point-blank Nova meaningfully stronger than the fringe.
        const falloff = 1 - (d / r) * 0.45;
        this._damageEnemy(e, this.derived.atk * sk.dmg * this.derived.skillMul * falloff * plan.mul, {
          knockback: 14, stagger: 0.7, from: p.pos, origin: 'skill',
        });
      }
    });
    // FLAME affinity (resonanceReading: +2 per Nova that hits 4 or more) —
    // counted on connection, not on cast: a panic Nova into empty air says
    // nothing about a cascade instinct.
    if (novaHits >= 4) bumpAffinity(this.save, 'flame', 2);
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
    // WILD FORM: no skills (step 10) — Bind included; the form fights alone.
    if (this._wildT > 0) return this.ui.toast('THE BEAST KNOWS NO SKILLS');
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`BIND UNLOCKS AT LEVEL ${sk.unlockLevel}`);

    // BEAST ARCHON (step 10): a boss or elite corpse in reach binds a PACT
    // through this same extraction verb — the spec's "existing extraction
    // path, so it costs no new system". Handled first because a pact-worthy
    // corpse must never be spent as a common soldier; trash corpses fall
    // through to the shipped Bind below (which the fielded pact then starves
    // via the room check — one ally, not thirteen).
    if (this.save.archon === 'beast' && this._tryBindPact()) return;

    // A fielded pact beast IS the whole allowance (spec: "consumes the
    // ENTIRE field-shadow allowance — one ally, not thirteen").
    const room = this._pactFielded() ? 0 : this.fieldCapacity() - this.shadows.length;
    if (room <= 0) return this.ui.toast('YOUR COMPANY IS AT FULL STRENGTH');

    const inRange = this.corpses.filter((c) => (
      c.attempts < MAX_EXTRACT_ATTEMPTS && c.pos.distanceTo(p.pos) < 14
    ));
    if (inRange.length === 0) return this.ui.toast('NO FALLEN NEARBY');

    p.cds.summon = sk.cd * this._skillCdMul();
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
        // exotic effect (RPG_SPEC equipmentSlots.trinket) — and BINDER's
        // "+12 PTS" card term (extractAdd, quality/resonance-scaled: the
        // worked example's +15.1 pts) rides the same flat seam.
        extractAdd: (this._armorBonus?.extractAdd || 0) + (this._classFlags?.extractAdd || 0),
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

    // SHADOW affinity (resonanceReading: +1 per SUCCESSFUL Bind extraction).
    // Failures teach nothing about the player's development — the counter
    // reads commitment to the army, and a resisted corpse is not an army.
    if (raised > 0) bumpAffinity(this.save, 'shadow', raised);

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
    //
    // ...while a menu is up IN THE WORLD. With no mode mounted there is no
    // world for time to pass in — that is the boot title, where nothing
    // samples the clock and no sky is drawn. Ticking there did nothing visible
    // and made the saved-clock acceptance check a race against boot time: the
    // check budgets 3 real seconds between loop start and its post-reload
    // probe, and the classes wave's larger dev-server module graph pushed a
    // margin that was already under half a second on SwiftShader past it.
    // Freezing an unmounted clock is behaviour-identical on screen and makes
    // "resume at the saved hour" exact instead of boot-speed-dependent.
    if (this._mode) {
      this.worldClock.tick(dt);
      // The stored hour otherwise rides only the event-driven onSave cadence
      // (equip, gate clear, level-up), which can leave it minutes of game
      // time behind the live clock — an app killed from the switcher then
      // resumes at the last equip's hour, and the acceptance reload check
      // measures exactly that loss (its budget is 0.2 h = 12 real seconds).
      // A 6-real-second heartbeat bounds the loss well inside that budget at
      // the cost of one few-KB localStorage write — onSave() is the wrapper
      // above, so the heartbeat stamps worldTime on the same single path as
      // every other save and cannot introduce a second writer.
      this._clockSaveT = (this._clockSaveT || 0) + dt;
      if (this._clockSaveT >= 6) {
        this._clockSaveT = 0;
        this.onSave();
      }
    }
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

    // The inventory panel's character viewer runs its OWN camera (previewCamera)
    // rather than the mode's follow rig — checked first so the follow rig simply
    // does not run while the panel is open, and resumes on its own the instant
    // _invView clears. This.camera is never moved while the panel is open (see
    // enterInventoryView), so there is nothing to hand back either — the follow
    // rig picks up from exactly where it left off, no re-converge glide needed.
    if (this._invView) this._updateInventoryCamera(dt);
    else if (this._mode) this._mode.updateCamera(dt);
    else this._updateCamera(dt);
    this.input.endFrame();
    // While the character viewer is open, previewCamera's isolated render
    // REPLACES the normal world draw outright — see _renderInventoryPreview for
    // why that, not visibility toggling, is what makes the map and every other
    // hunter actually disappear instead of just sitting frozen out of frame.
    if (this._invView) this._renderInventoryPreview();
    else this.glow.render(this.scene, this.camera);
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

    // Mastery clocks (CLASSES_SPEC step 4). All on the SIM step except
    // UNYIELDING, whose 90 s is real time by spec ("real time, tracked on the
    // run") — hit-stop must not stretch the one cheat of death.
    if (this._slipT > 0) this._slipT -= dt;
    if (this._answerT > 0) this._answerT -= dt;
    if (this._riposteT > 0) this._riposteT -= dt;
    if (this._overT > 0) this._overT -= dt;
    if (this._kindlingT > 0) this._kindlingT -= dt;
    if (this._unyieldingT > 0) this._unyieldingT -= this._frameDt;
    // LEGION STEP's 45 s runs on the sim step like every other combat clock —
    // hit-stop stretching a burst-window cooldown would punish the path for
    // landing crits.
    if (this._legionT > 0) this._legionT -= dt;
    // TEMPEST STEP's 6 s and WILD FORM's 12 s/90 s, same sim-step reasoning
    // (step 10): both are burst windows crits should not shorten. The form
    // sheds itself the frame its window closes — _endWildForm restores the
    // base body and disposes the borrowed rig, its one teardown verb.
    if (this._tempestT > 0) {
      this._tempestT -= dt;
      // "Dash cooldown zero": zeroed at the top of the frame, BEFORE the
      // input block reads it, so a cooldown banked before the window opened
      // cannot eat the window's first dash.
      p.cds.dash = 0;
    }
    if (this._wildCd > 0) this._wildCd -= dt;
    if (this._wildT > 0) {
      this._wildT -= dt;
      if (this._wildT <= 0) this._endWildForm();
    }
    // TEMPO's chain-then-decay: stacks hold while the 4 s chain window runs,
    // then shed one every 2 s. Integer + two timers, nothing allocated.
    if (this._tempoStacks > 0) {
      if (this._tempoChainT > 0) this._tempoChainT -= dt;
      else {
        this._tempoDecayT += dt;
        if (this._tempoDecayT >= MASTERY.tempo.decayEvery) {
          this._tempoDecayT -= MASTERY.tempo.decayEvery;
          this._tempoStacks--;
        }
      }
    }

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

    // REAVER's kill-stack window (STEP 5): refresh-style — the clock re-arms
    // per kill in _killEnemy, and the WHOLE stack sheds when it lapses.
    if (this._killStackT > 0) {
      this._killStackT -= dt;
      if (this._killStackT <= 0) this._killStacks = 0;
    }

    // regen
    p.hp = Math.min(d.maxHp, p.hp + d.hpRegen * dt);
    p.mp = Math.min(d.maxMp, p.mp + d.mpRegen * dt);

    // VANGUARD's deferred remainder lands here at the bleed's own pace
    // (banked in _damagePlayer, forgiven in _killEnemy). A direct hp write
    // like the enemy bleed ticks — routing it back through _damagePlayer
    // would re-mitigate and re-defer the same wound forever. It CAN finish
    // you: a deferral that could not kill would be a hidden second benefit
    // the card never printed, so the death path below is the real one.
    if (this._vgPool > 0) {
      const bite = Math.min(this._vgPool, (this._vgRate || this._vgPool) * dt);
      this._vgPool -= bite;
      p.hp -= bite;
      if (p.hp <= 0) {
        p.hp = 0;
        p.alive = false;
        this._endWildForm(true);
        p.mesh.userData.character?.play('die', { fade: 0.08, once: true, clamp: true });
        this._fail();
        return;
      }
    }

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
    // The one contextual slot (interlock.theOneSlot). For an ascended path
    // with a slot meaning — SHADOW = Legion Step (step 8), FLAME = Ashfall,
    // FROST = the freeze-detonate (step 9) — the TAP is the path's active and
    // Bind moves to a hold: the press starts a timer, holding past
    // bindHoldSeconds fires Bind, releasing before it fires the ultimate.
    // Every other save (unascended, and STORM/BEAST until step 10 gives them
    // their meanings) keeps the shipped press-is-Bind verbatim. The decision
    // happens on RELEASE for the tap, which costs the ultimate one 0.35 s
    // confirmation — acceptable for burst-window actives, and the only shape
    // that leaves a hold available on the same thumb.
    if (this.save.archon === 'shadow' || this._archonPath) {
      if (this.input.consume('summon')) this._summonHoldT = 0;
      if (this._summonHoldT !== null) {
        if (this.input.isHeld('summon')) {
          this._summonHoldT += dt;
          if (this._summonHoldT >= SOVEREIGN.bindHoldSeconds) {
            this._summonHoldT = null;
            this._trySummon();
          }
        } else {
          this._summonHoldT = null;
          if (this.save.archon === 'shadow') this._tryLegionStep();
          else if (this._archonPath === FLAME_P) this._tryAshfall();
          else if (this._archonPath === FROST_P) this._tryShatterDetonate();
          else if (this._archonPath === STORM_P) this._tryTempest();
          else if (this._archonPath === BEAST_P) this._tryWildForm();
        }
      }
    } else if (this.input.consume('summon')) this._trySummon();

    // swing timing — the machine advances phases and fires _applySwingHit once
    // per damage application (the dagger finisher makes two).
    // SLIPSTREAM (WINDSTEP T1): while the 0.6 s post-perfect-dodge window
    // runs, the swing CLOCK advances 35% faster — the same lever a Quick
    // affix pulls (w.rate scales the clock, not the table), so windup, active
    // and recovery all compress together. dt * 1 exactly when the window is
    // closed, which is every frame of every save without the mastery.
    // REAVER's kill stacks pull the same lever (+4%/stack while the window
    // runs) — cadence, not damage, exactly like the card's "attack speed".
    let atkDt = dt;
    if (this._slipT > 0) atkDt *= 1 + MASTERY.slipstream.atkSpeedBonus;
    if (this._killStacks > 0 && this._classFlags?.killStackAtkSpeedPct) {
      atkDt *= 1 + this._killStacks * this._classFlags.killStackAtkSpeedPct;
    }
    if (w) tickAttack(p.attack, w, atkDt, this._onSwingHit);
    // TEMPEST STEP: "basic attacks ignore their cooldown" — the inter-combo
    // cd the machine just banked is zeroed while the window runs. The steps'
    // own windup/active/recovery timing is untouched: the storm buys cadence
    // between combos, not faster blades inside one.
    if (this._tempestT > 0) p.attack.cd = 0;
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
    // TEMPO (WINDSTEP T3): +8% move speed per live stack, multiplied at the
    // consumption site (this.derived is never rewritten mid-run), under the
    // ABSOLUTE 14 u/s ceiling every speed source answers to (balance guard —
    // STAT_RATES.agi's comment records what an uncapped speed term did).
    // d.speed tops out at 10.8 (6 + 4.2 asymptote + 0.6 armour), so the
    // Math.min is inert for every save without stacks.
    // Every speed term multiplies HERE and the ceiling applies ONCE (step 10
    // widened the tempo-only clamp): TEMPO's +8%/stack, TEMPEST STEP's +55%,
    // WILD FORM's 1.5x — and whatever any future save carries — all answer
    // to the same Math.min(SPEED_CAP=14). d.speed tops out at 10.8 (6 + 4.2
    // asymptote + 0.6 armour), so with no term live the clamp is inert and
    // the shipped number passes through exactly. Tempest and Wild cannot
    // coexist (one archon path per save), so their product never actually
    // compounds — the ceiling would hold even if it did.
    const body = p.body;
    let spdMul = 1;
    if (this._tempoStacks > 0) spdMul *= 1 + this._tempoStacks * MASTERY.tempo.speedPctPerStack;
    if (this._tempestT > 0) spdMul *= 1 + STORM_P.tempest.speedBonus;
    if (this._wildT > 0) spdMul *= BEAST_P.wildForm.speedMul;
    // REAVER's kill stacks (+6%/stack, STEP 5): the same consumption site as
    // TEMPO, under the same one 14 u/s ceiling.
    if (this._killStacks > 0 && this._classFlags?.killStackSpeedPct) {
      spdMul *= 1 + this._killStacks * this._classFlags.killStackSpeedPct;
    }
    body.maxSpeed = Math.min(SPEED_CAP, d.speed * spdMul);
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

    // STORM affinity (+1 per 400 m travelled inside a gate). groundSpeed x dt
    // is real ground covered by the body solver — teleports and knockbacks
    // never pass through it, so the odometer reads walking and dashing only.
    // _updatePlayer runs in gate mode alone (the city has its own player
    // update), which is exactly the "inside a gate" clause.
    this._travelAcc = (this._travelAcc || 0) + sp * dt;
    if (this._travelAcc >= 400) {
      this._travelAcc -= 400;
      bumpAffinity(this.save, 'storm', 1);
    }
    // CHARGE (STORM ARCHON, step 10): +1 per metre travelled, off the same
    // body-solver odometer as the affinity read above — teleports and
    // knockbacks never pass through groundSpeed, so the meter reads walking
    // and dashing only. Gated while TEMPEST STEP runs: "Charge is spent in
    // full and cannot regenerate for the duration" (spec verbatim). The
    // decay side (8/s while stationary) lives in _updateArchon's tick.
    if (this._archonPath === STORM_P && this._archonRes && this._tempestT <= 0) {
      this._archonRes.gain(sp * dt);
    }

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

    // present. During WILD FORM the borrowed rig is the body on screen: the
    // base mesh stays parented and hidden (never disposed — the form ends by
    // restoring it), and the invuln flicker moves to the shape the player is
    // actually watching. rigMesh is what every pose call below drives.
    const rigMesh = this._wildMesh || p.mesh;
    const flicker = !(p.invuln > 0 && p.dashTimer <= 0 && Math.floor(this.time * 22) % 2 === 0);
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = p.yaw;
    if (this._wildMesh) {
      p.mesh.visible = false;
      this._wildMesh.position.copy(p.pos);
      this._wildMesh.rotation.y = p.yaw;
      this._wildMesh.visible = flicker;
    } else {
      p.mesh.visible = flicker;
    }
    // attackAnim hands over everything the pose needs: phase 1 -> 0 across the
    // step, the contact frame at the REAL windup fraction (0.17/0.34 = 0.5 for
    // the sword opener — the exact number the old hardcoded 0.5 encoded), and
    // the archetype's shoulder curve so an axe winds further back than a
    // dagger. The Ruin skill's visual swing rides the same channel when the
    // machine is idle.
    const anim = w ? attackAnim(p.attack, w) : null;
    const machineSwinging = Boolean(anim && anim.phase > 0);
    animateRig(rigMesh, {
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
    // Mastery ground telegraphy opens its frame: everything pushed between
    // here and the commit at the bottom is this frame's truth, and an idle
    // pool submits zero draw calls (count 0 — see GroundFxPool).
    if (this._groundFx) this._groundFx.begin();
    // RIPOSTE's banked shockwave (BULWARK T2), applied where killing is safe:
    // _damagePlayer armed it from inside the enemy for..of below, and a
    // splice mid-iteration is the documented hazard the bleed pass routes
    // around the same way — reverse indexed, before anyone else iterates.
    if (this._riposteFire?.armed) {
      const rf = this._riposteFire;
      rf.armed = false;
      _mastV.set(rf.x, 0, rf.z);
      const rr = MASTERY.riposte.radius;
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        if (e.hp <= 0 || e.spawning > 0) continue;
        const dx = e.pos.x - rf.x;
        const dz = e.pos.z - rf.z;
        if (dx * dx + dz * dz <= (rr + e.radius) * (rr + e.radius)) {
          // origin:'skill': a retaliation proc is not a basic attack, so it
          // can never consume ANSWER's queued crit.
          this._damageEnemy(e, rf.dmg, { from: _mastV, knockback: 5, origin: 'skill' });
        }
      }
    }
    // RESIDUE fields (EMBERMIND T2): 12% of atk per second inside 4 m,
    // banked into half-second ticks the way the axe bleed banks whole points
    // — direct hp writes on the bleed pattern, not sixty _damageEnemy crit
    // rolls a second. SUNDER's +18% still applies (all sources).
    if (this._mastery?.int >= 2 && this._residue) {
      const R = MASTERY.residue;
      for (const f of this._residue) {
        if (f.t <= 0) continue;
        f.t -= dt;
        f.acc += dt;
        this._ensureGroundFx().pushDisc(f.x, f.z, R.radius, RESIDUE_COLOR, 0.5 + Math.min(0.5, f.t / R.seconds));
        if (f.acc >= 0.5) {
          f.acc -= 0.5;
          const base = Math.max(1, Math.round(this.derived.atk * R.atkFracPerSecond * 0.5));
          for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            if (e.hp <= 0 || e.spawning > 0) continue;
            const dx = e.pos.x - f.x;
            const dz = e.pos.z - f.z;
            if (dx * dx + dz * dz > (R.radius + e.radius) * (R.radius + e.radius)) continue;
            const tick = e.sunderT > 0 ? Math.round(base * (1 + MASTERY.sunder.bonusTakenPct)) : base;
            e.hp -= tick;
            e.hurt = Math.max(e.hurt, 0.15);
            tmpV.copy(e.pos).setY(1.1 * (e.base.scale || 1));
            this.fx.damageNumber(tmpV, tick, '');
            if (e.hp <= 0) this._killEnemy(e);
          }
        }
      }
    }
    // FLAME + FROST per-frame work (step 9): stack expiry, resource decay,
    // burn ticks, the Ashfall field, tints and the quad pool. Sits INSIDE the
    // ground-fx frame (Ashfall shares the RESIDUE disc channel — the budget's
    // "one decalpool channel", never a second) and BEFORE the main for..of,
    // on the bleed pass's reasoning: its ticks can kill and _killEnemy
    // splices this.enemies.
    this._updateArchon(dt);
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
      // RIME (FROST ARCHON, step 9): -6% move AND attack speed per stack,
      // floored at -60%. `edt` is this enemy's ACTION clock — attack
      // cooldowns, wind-ups and swings all crawl together, the same single
      // lever SLIPSTREAM pulls on the player's machine (dt scaling, never a
      // second timing system). Movement takes the same factor at the
      // position-advance below, the crater's sanctioned pattern. Every
      // non-frost save reads zero stacks and edt === dt to the bit.
      const rimeN = this._archonPath === FROST_P ? this._archonStatus.get(e, 'rime') : 0;
      const rimeMul = rimeN > 0
        ? Math.max(1 - FROST_P.rime.maxSlow, 1 - rimeN * FROST_P.rime.slowPerStack)
        : 1;
      const edt = rimeN > 0 ? dt * rimeMul : dt;
      // FREEZE runs on REAL time (2.2 s is 2.2 s — the freeze must not slow
      // its own thaw); stacks clear on thaw, spec wording verbatim.
      if (e.frozenT > 0) {
        e.frozenT -= dt;
        if (e.frozenT <= 0) {
          e.frozenT = 0;
          if (this._archonStatus) this._archonStatus.clear(e);
        }
      }
      if (e.attackCd > 0) e.attackCd -= edt;
      // SUNDER's armour-break clock (set by the finisher, read by
      // _damageEnemy and the residue tick) runs down like hurt/stagger do.
      if (e.sunderT > 0) e.sunderT -= dt;
      if (e.attack) {
        // Armed humanoids swing through the state machine (npcStrikeWeapon:
        // windup = the steerAgent telegraph, active 0, recovery 0.3), which
        // fires _enemyStrike on the exact frame the old countdown did. The
        // telegraph/swing fields stay maintained as MIRRORS because everything
        // downstream — eye flare, movement gating, yaw freeze, the animation
        // span, the fight suite — reads them, and none of that should care how
        // the clock is kept. Deliberately unconditional, like the old
        // decrement: stagger interrupts steering, not a strike already wound.
        tickAttack(e.attack, e.strikeW, edt, this._onNpcHit, e);
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
        // a cast and a boss pattern are not weapon swings. Both run on edt:
        // Rime slows a cast's wind-up exactly as it slows a swing's.
        if (e.telegraph > 0) {
          e.telegraph -= edt;
          if (e.telegraph <= 0) this._enemyStrike(e);
        }
        if (e.swing > 0) e.swing -= edt;
      }

      const toPlayer = _aimDir.copy(p.pos).sub(e.pos).setY(0);
      const dist = toPlayer.length();
      if (dist > 0.001) toPlayer.divideScalar(dist);

      const staggered = e.stagger > 0;
      // Steering output, in world units. The old code carried a scalar
      // `desiredSpeed` along toPlayer, which cannot express a detour.
      let moveX = 0, moveZ = 0;

      if (e.isBoss) {
        // The boss brain runs on the ACTION clock too: ten Rime stacks slow
        // its pattern cadence like any other attack timer. (Its movement is
        // slowed at the shared position-advance below, like everyone's.)
        this._bossBrain(e, edt, dist, toPlayer);
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
      // rimeMul rides the same seam as the crater: the POSITION advance is
      // scaled, not the velocity, so a thaw restores full speed the same
      // frame and knockback impulses still land at full strength.
      e.pos.addScaledVector(e.vel, dt * crSlow * rimeMul);
      this.world.resolve(e.pos, e.radius, e.vel);

      e.mesh.position.copy(e.pos);
      e.mesh.rotation.y = e.yaw;

      // READING (AUGUR T1): the telegraph the fairness system already runs
      // becomes a VISIBLE ground arc — the actual swing cone (the acos(0.2)
      // sector _enemyStrike tests) at the actual reach, appearing
      // derived.tellLeadMs before contact, so more PER genuinely shows the
      // blow earlier. Ranged casters are skipped (their output is a dodgeable
      // bolt, not a cone); the boss's slam is radial, so it reads as the full
      // 11 m disc _bossBrain will actually damage. Pushed per frame into the
      // pooled channel — max 6 arcs, one draw call, zero when none are live.
      if (this._mastery?.per >= 1 && e.telegraph > 0
        && e.telegraph <= this.derived.tellLeadMs / 1000
        && (e.isBoss || e.base.ai !== 'ranged')) {
        const gfx = this._ensureGroundFx();
        if (e.isBoss && e._slam) gfx.pushDisc(e.pos.x, e.pos.z, 11, READING_COLOR, 1);
        else gfx.pushArc(e.pos.x, e.pos.z, e.yaw, (e.base.range || 2) + (e.isBoss ? 2.2 : 0.6), READING_COLOR);
      }

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
    // Close the ground-fx frame: upload what was pushed, hide the rest.
    if (this._groundFx) this._groundFx.commit();
  }

  /**
   * The shared mastery decal channel (READING arcs + RESIDUE fields, Ashfall
   * later), allocated on FIRST USE: a save with no mastery never pays for the
   * geometry, and an idle pool costs zero draw calls regardless. Session-
   * lived once created; _setMode clears it so a field can never linger into
   * the city, and dispose() (driven by the test harness's teardown cycle)
   * returns both geometries and materials to the renderer.
   */
  _ensureGroundFx() {
    if (!this._groundFx) this._groundFx = new GroundFxPool(this.scene);
    return this._groundFx;
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
      // A soldier mid-re-form (LEGION STEP) is off the field: invisible,
      // planted, and not a body an enemy can bite.
      if (s.reform > 0) continue;
      const d = s.pos.distanceTo(from);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ? { s: best, d: bestD } : null;
  }

  /**
   * SOVEREIGN'S WILL target selection (CLASSES_SPEC step 8) — the three
   * command states as three branches, no new AI. Every save that is not a
   * SHADOW ARCHON is pinned to 'hunt', which is the shipped 26 m
   * nearest-to-self scan VERBATIM — that pin is the migration guarantee for
   * this function.
   *   HOLD  — the wall: engage only what closes on the PLAYER (nearest enemy
   *           to the player inside holdIntercept = the 4 m ring + the ~2 m
   *           engage reach, so interception never drags a soldier off the
   *           leash by more than its own sword). Nothing in range: fall in.
   *   HUNT  — the shipped behaviour: nearest enemy to the SOLDIER within 26 m.
   *   FOCUS — every blade on the player's last-hit mark, wherever it stands
   *           (no range gate: chasing the named quarry across the room IS the
   *           command). An expired mark falls back to HUNT so the order
   *           "focus" never reads as "stand down".
   */
  _shadowTarget(s) {
    const stance = this.save.archon === 'shadow' ? this._shadowStance : 'hunt';
    if (stance === 'hold') return this._nearestEnemy(this.player.pos, SOVEREIGN.holdIntercept);
    if (stance === 'focus') {
      const t = this._lastHitTarget;
      if (t && t.hp > 0) return t;
    }
    return this._nearestEnemy(s.pos, SOVEREIGN.huntRange);
  }

  /**
   * Change the army's command state. SHADOW ARCHON only — the stance enum
   * exists on every run but is pinned to 'hunt' for everyone else, so this
   * setter refusing is what keeps the pin honest.
   */
  setShadowStance(stance) {
    if (this.save.archon !== 'shadow') return false;
    if (!SOVEREIGN.stances.includes(stance)) return false;
    if (this._shadowStance === stance) return true;
    this._shadowStance = stance;
    return true;
  }

  get shadowStance() { return this._shadowStance; }

  /**
   * LEGION STEP (CLASSES_SPEC step 8) — the SHADOW ARCHON's one active: the
   * answer to "my army is on the wrong side of the room". Every fielded
   * soldier detonates where it stands for 60% of its OWN atk in a 4 m radius,
   * is recalled instantly, and re-forms at the player's side over 6 s at 50%
   * HP. The meshes persist across the whole cycle — recall is visibility and
   * position, never disposal — which is both the performance rule and the
   * step's verify clause.
   */
  _tryLegionStep() {
    if (this.save.archon !== 'shadow') return;
    if (this._legionT > 0) return;
    // Count the soldiers actually ON the field; a press mid-re-form must not
    // re-detonate ghosts that are not standing anywhere.
    let n = 0;
    for (const s of this.shadows) if (!(s.reform > 0)) n++;
    if (n === 0) return this.ui.toast('NO LEGION TO CALL');
    this._legionT = LEGION_CD;
    const R = SOVEREIGN.legion.radius;
    let slot = 0;
    for (const s of this.shadows) {
      if (s.reform > 0) continue;
      // The detonation: 60% of the soldier's own atk — the same figure and
      // the same armour + class shadowDmgMul seams as _shadowStrike, because
      // this IS the army's blow, paid all at once. origin:'shadow' for the
      // same reason as there: a detonation must not eat the player's banked
      // crits or feed their leech.
      const dmg = s.atk * SOVEREIGN.legion.detonatePct
        * (this._armorBonus?.shadowDmgMul || 1) * this._classShadowMul;
      for (const e of this.enemies) {
        if (e.hp > 0 && e.pos.distanceTo(s.pos) < R + e.radius) {
          this._damageEnemy(e, dmg, { origin: 'shadow' });
        }
      }
      this.fx.ring(s.pos, 0x35e6ff, R * 1.1, 0.45);
      this.fx.burst(s.pos.clone().setY(1), 20, 0x35e6ff, { speed: 8, up: 4, life: 0.6 });
      // Recall: off the field NOW, back over the 6 s stagger — soldier k of n
      // returns at (k+1)/n x 6 s, so the army walks back in as a column, not
      // a blink. Windup state clears: a strike begun before the recall has no
      // body to land from.
      s.reform = SOVEREIGN.legion.reformSeconds * ((slot + 1) / n);
      s._reformSlot = slot++;
      s.telegraph = 0;
      s.swing = 0;
      s.target = null;
      s.vel.set(0, 0, 0);
      s.mesh.visible = false;
    }
    this.fx.addShake(0.5);
    this.audio.nova();
  }

  // ------------------------------------------------- FLAME + FROST (step 9)

  /**
   * PYRE application: n stacks, combustion at 10. Called from _damageEnemy
   * (every player hit) and the Ashfall seed tick — never from a blast, which
   * marks itself noStatus.
   */
  _applyPyre(e, n) {
    const c = this._archonStatus.apply(e, 'pyre', n);
    if (c >= FLAME_P.combustion.atStacks) this._combust(e);
  }

  /**
   * COMBUSTION, iterative on purpose: the blast re-seeds 4 stacks on every
   * OTHER enemy caught, an already-stacked neighbour can reach 10 and go up
   * too, and "in a packed room this cascades, which IS the path". A queue
   * with a cursor instead of recursion, because a chain deep enough to matter
   * is exactly the room where a call stack per link would hurt; the module
   * array is reused so a cascade allocates nothing after the first.
   *
   * The combusting target takes no blast and keeps no seed — the worked
   * example prices the per-target cycle at 10 stacks / 2.7 hits per second =
   * 3.7 s, only true restarting from zero; and a self-blast landing inside
   * the _damageEnemy call that raised the 10th stack would re-enter the
   * outer call's own death branch and double-kill.
   */
  _combust(first) {
    const q = _combustQ;
    q.length = 0;
    q.push(first);
    // The chainCap watchdog (see the config's own comment): every link deals
    // real damage to everything it seeds, so live rooms terminate the chain
    // by dying — the cap only exists for bodies no blast can kill, and 64
    // links is beyond anything a survivable room ever fires.
    for (let qi = 0; qi < q.length && qi < FLAME_P.combustion.chainCap; qi++) {
      const e = q[qi];
      const consumed = this._archonStatus.get(e, 'pyre');
      // An earlier link already consumed this body (double-queued when two
      // blasts both pushed it to 10) — one explosion per stack load.
      if (consumed < FLAME_P.combustion.atStacks) continue;
      this._archonStatus.clear(e);
      this._retintEnemy(e, 'pyre', 0);
      // EMBER: +2 per Pyre stack consumed by a combustion — the meter's own
      // gainPer is the 2, the call site passes the count (classes.js rules).
      this._archonRes.gain(consumed);
      const R = FLAME_P.combustion.radius;
      const blast = this.derived.atk * FLAME_P.combustion.atkPct;
      this.fx.ring(e.pos, FLAME_COLOR, R * 1.15, 0.5);
      this.fx.burst(_archV.copy(e.pos).setY(1), 26, FLAME_COLOR, { speed: 9, up: 5, life: 0.6 });
      this.fx.addShake(0.3);
      this.audio.skill();
      // Reverse-indexed like every blast in this file: a kill splices.
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const t = this.enemies[i];
        if (t === e || t.hp <= 0 || t.spawning > 0) continue;
        const dx = t.pos.x - e.pos.x;
        const dz = t.pos.z - e.pos.z;
        if (dx * dx + dz * dz > (R + t.radius) * (R + t.radius)) continue;
        // origin:'skill' (a proc never eats ANSWER's queued basic-attack
        // crit) + noStatus (an explosion cannot farm the stacks that fired
        // it — the re-seed below is the explicit, spec-priced seeding).
        this._damageEnemy(t, blast, { from: e.pos, knockback: 4, origin: 'skill', noStatus: true });
        if (t.hp > 0) {
          const c2 = this._archonStatus.apply(t, 'pyre', FLAME_P.combustion.reseed);
          if (c2 >= FLAME_P.combustion.atStacks) q.push(t);
        }
      }
    }
    q.length = 0;
  }

  /**
   * RIME application: n stacks, each granting +0.4 %-points of Barrier (the
   * meter clamps at 35), freeze at the 10th. A frozen target takes no further
   * stacks — it is already at the mechanic's ceiling and its stacks clear on
   * thaw (spec wording), so mid-freeze hits buying more Barrier would make
   * freeze windows the path's mana battery instead of its payoff.
   */
  _applyRime(e, n) {
    if (e.frozenT > 0) return;
    const c = this._archonStatus.apply(e, 'rime', n);
    this._archonRes.gain(n);
    if (c >= FROST_P.freeze.atStacks) {
      e.frozenT = FROST_P.freeze.seconds;
      // "The freeze pose is the existing stagger hold — no new animation
      // state": the hold IS the stagger branch, pinned for the full 2.2 s.
      e.stagger = Math.max(e.stagger, FROST_P.freeze.seconds);
      this.fx.ring(e.pos, FROST_COLOR, 1.8 * (e.base.scale || 1), 0.4);
      this.fx.burst(_archV.copy(e.pos).setY(1), 16, FROST_COLOR, { speed: 4, up: 2, life: 0.5 });
      this.audio.skill();
    }
  }

  /**
   * SHATTER: 300% of THE TRIGGERING HIT split among all OTHER enemies within
   * 6 m, +3 Rime to each. The target thaws FIRST — its freeze is spent, its
   * stacks clear with it, and that ordering (not a flag) is what makes chain
   * re-entry impossible. A frozen neighbour receiving a share past its own
   * 15% line shatters in turn: kill-chaining by control.
   */
  _shatter(e, hitDmg) {
    e.frozenT = 0;
    this._archonStatus.clear(e);
    this._retintEnemy(e, 'rime', 0);
    const R = FROST_P.shatter.radius;
    this.fx.ring(e.pos, FROST_COLOR, R, 0.5);
    this.fx.burst(_archV.copy(e.pos).setY(1.1), 30, FROST_COLOR, { speed: 10, up: 5, life: 0.6 });
    this.fx.addShake(0.35);
    this.audio.skill();
    // Count the recipients first: it is a SPLIT (300% divided among them),
    // not 300% each — the spec's own wording, and the difference between a
    // control payoff and a room-deleting nova FROST is not allowed to be.
    let count = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const t = this.enemies[i];
      if (t === e || t.hp <= 0 || t.spawning > 0) continue;
      const dx = t.pos.x - e.pos.x;
      const dz = t.pos.z - e.pos.z;
      if (dx * dx + dz * dz <= (R + t.radius) * (R + t.radius)) count++;
    }
    if (count === 0) return;
    const share = Math.max(1, Math.round((hitDmg * FROST_P.shatter.splitPct) / count));
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const t = this.enemies[i];
      if (t === e || t.hp <= 0 || t.spawning > 0) continue;
      const dx = t.pos.x - e.pos.x;
      const dz = t.pos.z - e.pos.z;
      if (dx * dx + dz * dz > (R + t.radius) * (R + t.radius)) continue;
      this._damageEnemy(t, share, { from: e.pos, knockback: 3, origin: 'skill', noStatus: true });
      if (t.hp > 0) this._applyRime(t, FROST_P.shatter.reseed);
    }
  }

  /**
   * ASHFALL (the FLAME slot tap, interlock.theOneSlot): at 100 Ember, spent
   * in full, the floor burns for 8 s in a 14 m ring fixed at the cast point —
   * a field like RESIDUE's, not an aura, so positioning the cast is the
   * skill. The burn itself ticks in _updateArchon.
   */
  _tryAshfall() {
    if (this._archonPath !== FLAME_P || !this._archonRes) return;
    if (!this._archonRes.fireUltimate()) return this.ui.toast('EMBER NOT FULL');
    const A = this._ashfall;
    A.t = FLAME_P.ashfall.seconds;
    A.x = this.player.pos.x;
    A.z = this.player.pos.z;
    A.dmgAcc = 0;
    A.stackAcc = 0;
    this.fx.ring(this.player.pos, FLAME_COLOR, FLAME_P.ashfall.radius, 0.9);
    this.fx.addShake(0.6);
    this.audio.nova();
    this.ui.toast('ASHFALL', 'gold');
  }

  /**
   * The FROST slot tap: a manual freeze-detonate on the nearest frozen (=
   * 10-stack) target inside 16 m. It hits for 20% of the TARGET's max HP
   * through the ordinary funnel — over the 15% shatter line by construction
   * even before the frozen +45%, so the tap IS a shatter, with SUNDER, crits
   * and the kill path all behaving. No cooldown and no cost (classes.js
   * ultimateCost 0): the price is the ten hits of setup, every time.
   */
  _tryShatterDetonate() {
    if (this._archonPath !== FROST_P) return;
    let best = null;
    let bestD = FROST_P.detonate.range;
    for (const t of this.enemies) {
      if (t.hp <= 0 || !(t.frozenT > 0)) continue;
      const d = t.pos.distanceTo(this.player.pos);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (!best) return this.ui.toast('NO FROZEN TARGET');
    this._damageEnemy(best, best.maxHp * FROST_P.detonate.hitFracOfMaxHp, {
      from: this.player.pos, origin: 'skill', noStatus: true,
    });
  }

  // ------------------------------------------------- STORM + BEAST (step 10)

  /**
   * ARC (STORM ARCHON): a landed player hit discharges STORM_P.arc.discharge
   * Charge (4 — STEP 11 parity tune, derivation in archon.js) and chains
   * lightning to up to 4 ADDITIONAL enemies within 8 m of the TARGET for 55%
   * of derived.atk each. No Charge, no chain — a Storm Archon who stops
   * moving is a plain hunter, and that is the deal. Called from _damageEnemy
   * on the same funnel as Pyre/Rime; chain links mark noStatus so lightning
   * can never farm itself.
   *
   * Targets collect FIRST (array order — deterministic under the seeded
   * spawn stream) into the module-lived list, then the links land: a link's
   * kill splices this.enemies, and collecting-then-applying is the same
   * snapshot discipline the bleed pass and Nova use.
   */
  _tryArc(from) {
    const res = this._archonRes;
    if (!res || res.value < STORM_P.arc.discharge) return;
    const R = STORM_P.arc.radius;
    _arcTargets.length = 0;
    for (let i = 0; i < this.enemies.length && _arcTargets.length < STORM_P.arc.chains; i++) {
      const t = this.enemies[i];
      if (t === from || t.hp <= 0 || t.spawning > 0) continue;
      const dx = t.pos.x - from.pos.x;
      const dz = t.pos.z - from.pos.z;
      if (dx * dx + dz * dz > (R + t.radius) * (R + t.radius)) continue;
      _arcTargets.push(t);
    }
    if (_arcTargets.length === 0) return;
    // The discharge is the chain's price and it is spent on CONNECTION, not
    // on the swing: a hit with nothing in 8 m keeps its Charge.
    res.spend(STORM_P.arc.discharge);
    const dmg = this.derived.atk * STORM_P.arc.atkPct;
    // The origin endpoint is read once, before any link can kill and splice
    // the source (its record outlives the splice; its pos never moves again).
    for (let i = 0; i < _arcTargets.length; i++) {
      const t = _arcTargets[i];
      if (this._archonFx) {
        _archV.copy(from.pos).setY(1.2 * (from.base.scale || 1));
        _archV2.copy(t.pos).setY(1.1 * (t.base.scale || 1));
        this._archonFx.spawnSegment(_archV, _archV2, { life: 0.18, scale: 1 });
      }
      this.fx.burst(_archV2.copy(t.pos).setY(1.1), 6, STORM_COLOR, { speed: 5, up: 2, life: 0.25 });
      this._damageEnemy(t, dmg, { from: from.pos, origin: 'skill', noStatus: true });
    }
    _arcTargets.length = 0;
  }

  /**
   * TEMPEST STEP (the STORM slot tap, interlock.theOneSlot): at 200 Charge,
   * spent in full, 6 s of +55% speed under the absolute 14 u/s ceiling, zero
   * dash cooldown, a 90%-atk bolt down every dash line (_tryDash) and basic
   * attacks free of their cooldown (_updatePlayer). No regeneration for the
   * duration — the gain site checks this same clock.
   */
  _tryTempest() {
    if (this._archonPath !== STORM_P || !this._archonRes) return;
    if (this._tempestT > 0) return;
    if (!this._archonRes.fireUltimate()) return this.ui.toast('CHARGE NOT FULL');
    this._tempestT = STORM_P.tempest.seconds;
    this.fx.ring(this.player.pos, STORM_COLOR, 6, 0.6);
    this.fx.burst(this.player.pos.clone().setY(1), 30, STORM_COLOR, { speed: 9, up: 5, life: 0.6 });
    this.fx.addShake(0.5);
    this.audio.nova();
    this.ui.toast('TEMPEST STEP', 'gold');
  }

  /** Is the field currently held by a pact beast? (One boolean read for the
   *  capacity rules — the pact consumes the ENTIRE allowance.) */
  _pactFielded() {
    for (const s of this.shadows) if (s.isPact) return true;
    return false;
  }

  /**
   * The pact that answers a call to the field or a Wild Form: highest band
   * first (an S pact outranks the C one), newest id breaking ties. Null when
   * no pact is bound — a fresh BEAST ARCHON plays their shipped army until
   * the first boss or elite corpse takes the pact.
   */
  _activePact() {
    const pacts = this.save.archonState?.pacts;
    if (!Array.isArray(pacts) || pacts.length === 0) return null;
    let best = null;
    for (const rec of pacts) {
      if (!rec || typeof rec !== 'object' || !rec.type) continue;
      if (!best || (rec.band || 0) > (best.band || 0)
        || ((rec.band || 0) === (best.band || 0) && (rec.id || 0) > (best.id || 0))) best = rec;
    }
    return best;
  }

  /**
   * PACT binding (BEAST ARCHON): the nearest boss or elite corpse in Bind
   * range rolls the SAME extractionChance the shipped Bind rolls — the
   * "existing extraction path" clause — and success writes the pact into its
   * gate-band slot (E/D share one; a re-bind in a band REPLACES, five slots
   * total), recalls any common soldiers and fields the beast on the spot.
   * Returns true when a pact-worthy corpse consumed the press, so _trySummon
   * never spends a boss corpse as a common soldier.
   */
  _tryBindPact() {
    const p = this.player;
    let corpse = null;
    let bestD = 14;                     // the shipped Bind reach
    for (const c of this.corpses) {
      if (c.attempts >= MAX_EXTRACT_ATTEMPTS) continue;
      if (c.tierWeight !== 'elite' && c.tierWeight !== 'boss') continue;
      const d = c.pos.distanceTo(p.pos);
      if (d < bestD) { bestD = d; corpse = c; }
    }
    if (!corpse) return false;
    p.cds.summon = SKILLS.summon.cd * this._skillCdMul();
    const chance = extractionChance(this.save, {
      enemyLevel: corpse.enemyLevel,
      tierWeight: corpse.tierWeight,
      secondsSinceDeath: CORPSE_WINDOW - corpse.life,
      attemptIndex: corpse.attempts,
      // Same seam as the shipped Bind: trinket + BINDER's class add.
      extractAdd: (this._armorBonus?.extractAdd || 0) + (this._classFlags?.extractAdd || 0),
    });
    corpse.attempts++;
    if (Math.random() >= chance) {
      this.fx.burst(corpse.pos.clone().setY(0.9), 8, 0x35e6ff, { speed: 3, up: 2, life: 0.3 });
      this.ui.toast('THE PACT IS REFUSED');
      return true;
    }
    const st = this.save.archonState;
    const band = BEAST_P.pact.bands[this.gate?.rank] ?? 0;
    // Minted off the roster's own id counter so pact ids can never collide
    // with soldier ids (save.js's sanitiser keys pacts on a finite id).
    const id = this.save.shadows.nextId || 1;
    this.save.shadows.nextId = id + 1;
    const rec = {
      id, band,
      type: corpse.type,
      creature: corpse.creature || null,
      level: corpse.enemyLevel,
      grade: BEAST_P.pact.grade,          // WARLORD — the bind grade, fixed
      kills: 0,
    };
    st.pacts = st.pacts.filter((x) => x && x.band !== band);
    st.pacts.push(rec);
    // The corpse is spent like any bound corpse.
    this.scene.remove(corpse.mesh);
    disposeObject3D(corpse.mesh);
    const ci = this.corpses.indexOf(corpse);
    if (ci >= 0) this.corpses.splice(ci, 1);
    // The beast takes the field alone: common soldiers are recalled (mesh
    // teardown through the same walk their deaths use) and the deployment
    // list empties so the next gate fields the pact too.
    for (let i = this.shadows.length - 1; i >= 0; i--) {
      const s = this.shadows[i];
      this.scene.remove(s.mesh);
      disposeObject3D(s.mesh);
      this.shadows.splice(i, 1);
    }
    setDeployed(this.save, []);
    this._spawnPactBeast(rec, false);
    this.audio.bind();
    this.fx.ring(p.pos, 0x35e6ff, 14, 0.7);
    this.ui.toast(`PACT SEALED  ·  BAND ${this.gate?.rank ?? 'E'}`, 'gold');
    this.onSave();
    return true;
  }

  /**
   * Field the pact beast: ONE body at 4.0x a normal shadow's shadowCombat()
   * numbers, inside the existing shadow update/strike/dispose machinery —
   * this.shadows carries it, _updateShadows drives it, quality's field cap
   * still gates it (a 0-cap tier fields nothing and the path still works;
   * Wild Form never needs the beast standing). isPact is the one flag the
   * capacity rules key on.
   */
  _spawnPactBeast(rec, silent = false) {
    if (this.fieldCapacity() <= 0) return null;
    if (this._pactFielded()) return null;
    const c = shadowCombat(this.save, rec);
    const mul = BEAST_P.pact.mul;
    // 1.25x the grade scale: "one overwhelming ally" has to read as one at
    // a glance. Numbers carry the 4.0; the silhouette only hints it.
    const scale = 1.25 * c.scale;
    const pos = this.world.randomSpawn(this.rnd, this.player.pos, 4);
    const mesh = this._makeBoundBody(rec.creature, scale) || makeHumanoid({
      color: 0x1a2740, glow: 0x35e6ff, accent: 0x0b1220,
      weapon: 'sword', scale, ghost: true, cloak: true,
      archetype: 'shadow', rank: this.gate?.rank ?? 'E',
    });
    mesh.add(makeGroundRing(0x35e6ff, 0.85 * scale, 0.6));
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.shadows.push({
      rec,
      isPact: true,
      mesh, pos: pos.clone(), vel: new THREE.Vector3(), yaw: 0,
      radius: c.radius * 1.25, speed: c.speed,
      hp: Math.floor(c.hp * mul), maxHp: Math.floor(c.hp * mul),
      atk: c.atk * mul,
      attackCd: 0, swing: 0, telegraph: 0, telegraphMax: 0,
      target: null, life: 0, kills: 0,
      reform: 0, _reformSlot: 0,
    });
    if (!silent) {
      this.fx.ring(pos, 0x35e6ff, 5, 0.7);
      this.fx.burst(pos.clone().setY(1), 30, 0x35e6ff, { speed: 7, up: 5 });
    }
    return rec;
  }

  /**
   * WILD FORM (the BEAST slot tap): 12 s in the shape of the active pact
   * beast — 2.2x attack power (_damageEnemy), 1.5x speed under the 14 u/s
   * ceiling (_updatePlayer), 40% flat DR (_damagePlayer), no skills and no
   * items (the skill verbs bar themselves). 90 s cooldown, -6 s per kill
   * made transformed (_killEnemy). The transformation is a RIG SWAP sold by
   * silhouette + a desaturated palette + one burst/ring/shake — the player
   * is a living character and the no-rim/no-emissive rule holds without
   * exception (_makeWildBody enforces it mesh by mesh).
   */
  _tryWildForm() {
    if (this._archonPath !== BEAST_P) return;
    if (this._wildT > 0) return;
    if (this._wildCd > 0) return this.ui.toast(`WILD FORM IN ${Math.ceil(this._wildCd)}s`);
    const pact = this._activePact();
    if (!pact) return this.ui.toast('NO PACT BOUND');
    this._wildT = BEAST_P.wildForm.seconds;
    this._wildCd = WILD_CD;
    const mesh = this._makeWildBody(pact);
    if (mesh) {
      this._wildMesh = mesh;
      mesh.position.copy(this.player.pos);
      mesh.rotation.y = this.player.yaw;
      this.scene.add(mesh);
      this.player.mesh.visible = false;
    }
    // The transition IS the effect (spec: "if that does not read strongly
    // enough on device, the fix is a longer transition and a bigger camera
    // pull — NOT a rim").
    this.fx.burst(this.player.pos.clone().setY(1), 40, 0x9a8f7a, { speed: 8, up: 6, life: 0.8 });
    this.fx.ring(this.player.pos, 0x9a8f7a, 6, 0.7);
    this.fx.addShake(0.8);
    this.audio.nova();
    this.ui.toast('WILD FORM', 'gold');
  }

  /**
   * The wild body: SkeletonUtils.clone of the pact creature's rig via the
   * same makeCreature path _makeBoundBody uses — but LIVING flags: no shadow
   * skin (that treatment carries the army's sanctioned emissive whisper and
   * rim, both banned on the player), no telegraph eye (GLOW_LAYER is an
   * enemy tell). Every material is then cloned off the shared caches and
   * pushed to a desaturated shift of itself, emissive-zeroed, with any glow
   * layer membership stripped — the clone drops the `shared` flag so the
   * existing disposeObject3D walk frees it with the mesh. Null when the pack
   * is absent (offline/procedural fallback): the form still happens — buffs,
   * fx, timer — worn by the hunter's own body, which is the honest fallback
   * the low-poly rule asks for.
   */
  _makeWildBody(pact) {
    if (!pact.creature || !creaturesReady()) return null;
    const inst = makeCreature({
      creature: pact.creature, rank: this.gate?.rank ?? 'E',
      shadow: false, eyes: false, ignoreBudget: true, scale: 1,
    });
    if (!inst) return null;
    const root = new THREE.Group();
    root.add(inst.root);
    root.userData.character = inst;
    root.userData.appearance = inst.appearance;
    // 1.25x the pact's own grade scale, exactly like the fielded beast: the
    // form should read as BECOMING it, same silhouette, same size.
    root.scale.setScalar(1.25 * shadowCombat(this.save, pact).scale);
    root.traverse((o) => {
      // No object in the wild body may sit on the glow layer — the player
      // does not glow, whatever shape they wear (step 10 verify clause).
      if (o.layers) o.layers.disable(GLOW_LAYER);
      if (!o.isMesh) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m) continue;
        let mm = m;
        if (m.userData?.shared) {
          mm = m.clone();
          if (mm.userData) delete mm.userData.shared;
          if (Array.isArray(o.material)) o.material[i] = mm;
          else o.material = mm;
        }
        // Desaturated palette shift — the sanctioned "this is still you"
        // read: 45% of the colour's own saturation survives.
        if (mm.color) {
          const g = 0.2126 * mm.color.r + 0.7152 * mm.color.g + 0.0722 * mm.color.b;
          mm.color.setRGB(
            g + (mm.color.r - g) * 0.45,
            g + (mm.color.g - g) * 0.45,
            g + (mm.color.b - g) * 0.45,
          );
        }
        // Zero emissive, without exception: the pack's own baked eye-glow
        // materials arrive here too, and the player root must traverse clean.
        if (mm.emissive) {
          mm.emissive.setRGB(0, 0, 0);
          if ('emissiveIntensity' in mm) mm.emissiveIntensity = 0;
        }
      }
    });
    return root;
  }

  /**
   * THE one Wild Form teardown verb: restore the base body, dispose the
   * borrowed rig (disposeObject3D walks the cloned materials because they
   * shed their `shared` flag at clone time, and frees the CreatureInstance
   * through userData.character — no new teardown surface). Idempotent, and
   * safe before the wild state has ever been touched: _beginGate calls it on
   * entry against a mesh lingering from a torn-down run.
   */
  _endWildForm(silent = false) {
    this._wildT = 0;
    const mesh = this._wildMesh;
    if (!mesh) return;
    this._wildMesh = null;
    this.scene.remove(mesh);
    disposeObject3D(mesh);
    if (this.player?.mesh) this.player.mesh.visible = true;
    if (!silent) {
      this.fx.burst(this.player.pos.clone().setY(1), 24, 0x9a8f7a, { speed: 6, up: 4, life: 0.6 });
      this.fx.ring(this.player.pos, 0x9a8f7a, 4, 0.5);
      this.fx.addShake(0.4);
    }
  }

  /**
   * The per-frame archon pass, called from _updateEnemies INSIDE the
   * ground-fx frame (Ashfall shares the RESIDUE disc channel) and BEFORE the
   * main enemy for..of, on the bleed pass's reasoning: these ticks can kill
   * and _killEnemy splices this.enemies. One early return for every
   * unascended save; STORM and BEAST pay the meter tick and the pool age and
   * skip the stack walk (they own no stacks).
   */
  _updateArchon(dt) {
    const path = this._archonPath;
    if (!path) return;
    if (this._combatT > 0) this._combatT -= dt;
    const st = this._archonStatus;
    st.tick(dt);
    // Ember decays 3/s and Barrier 2%/s OUT OF COMBAT; Charge decays 8/s
    // WHILE STATIONARY (classes.js rules) — the meter cannot know either
    // condition, so the caller supplies the path's own boolean. Stationary
    // reads the body solver's ground speed, the same odometer the gain side
    // uses, so walking in place off a wall cannot count as motion. (Tempest
    // holds the bank at zero anyway; the gate keeps the read honest.)
    const decaying = path === STORM_P
      ? this._tempestT <= 0 && (this.player.body?.groundSpeed || 0) < 0.5
      : this._combatT <= 0;
    this._archonRes.tick(dt, decaying);
    // The HUD meter and the cross-gate bank read one field (ui.js step 7).
    if (this.save.archonState) this.save.archonState.resource = this._archonRes.value;

    // --- ASHFALL field (flame only) --------------------------------------
    const A = this._ashfall;
    if (path === FLAME_P && A.t > 0) {
      A.t -= dt;
      // The floor mark rides the shared decal channel, dimming as it dies.
      this._ensureGroundFx().pushDisc(A.x, A.z, FLAME_P.ashfall.radius, FLAME_COLOR,
        0.35 + Math.min(0.65, A.t / FLAME_P.ashfall.seconds));
      A.dmgAcc += dt;
      A.stackAcc += dt;
      const doDmg = A.dmgAcc >= 0.5;
      const doStack = A.stackAcc >= 1;
      if (doDmg) A.dmgAcc -= 0.5;
      if (doStack) A.stackAcc -= 1;
      if (doDmg || doStack) {
        // 45% of atk per second banked into half-second ticks — direct hp
        // writes on the residue/bleed pattern, not sixty crit rolls a
        // second. SUNDER still applies (all sources). The 1-stack-per-second
        // seed rides _applyPyre, so a packed Ashfall cascades on its own.
        const base = Math.max(1, Math.round(this.derived.atk * FLAME_P.ashfall.atkFracPerSecond * 0.5));
        const R = FLAME_P.ashfall.radius;
        let hitAny = false;
        for (let i = this.enemies.length - 1; i >= 0; i--) {
          const e = this.enemies[i];
          if (e.hp <= 0 || e.spawning > 0) continue;
          const dx = e.pos.x - A.x;
          const dz = e.pos.z - A.z;
          if (dx * dx + dz * dz > (R + e.radius) * (R + e.radius)) continue;
          hitAny = true;
          if (doDmg) {
            const tick = e.sunderT > 0 ? Math.round(base * (1 + MASTERY.sunder.bonusTakenPct)) : base;
            e.hp -= tick;
            e.hurt = Math.max(e.hurt, 0.15);
            tmpV.copy(e.pos).setY(1.1 * (e.base.scale || 1));
            this.fx.damageNumber(tmpV, tick, '');
          }
          if (e.hp > 0 && doStack) this._applyPyre(e, FLAME_P.ashfall.stacksPerSecond);
          if (e.hp <= 0) this._killEnemy(e);
        }
        // A floor actively burning bodies is combat; an empty ring is not,
        // so a whiffed Ashfall does not stop the Ember decay clock.
        if (hitAny) this._combatT = ARCHON_COMBAT_SECONDS;
      }
      // Ember-rain quads scattered across the ring. Math.random is sanctioned
      // here: visual-only jitter, no sim state reads it.
      if (this._archonFx) {
        this._ashQuadT = (this._ashQuadT || 0) - dt;
        if (this._ashQuadT <= 0) {
          this._ashQuadT = 0.06;
          const ang = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * FLAME_P.ashfall.radius;
          _archV.set(A.x + Math.cos(ang) * rr, 0.3, A.z + Math.sin(ang) * rr);
          this._archonFx.spawn(_archV, { life: 0.7, scale: 0.9, rise: 1.6 });
        }
      }
    }

    // --- per-enemy: burn ticks, tints, stack quads (STACKING paths only —
    // STORM discharges on the hit and BEAST stacks nothing, so their frame
    // pass is the meter tick above and the pool age below) ------------------
    if (path !== FLAME_P && path !== FROST_P) {
      if (this._archonFx) this._archonFx.tick(dt, this.camera);
      return;
    }
    const kind = path === FLAME_P ? 'pyre' : 'rime';
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.hp <= 0) continue;
      const n = st.get(e, kind);
      // Tint on CHANGE only (also the restore-to-base when stacks lapse):
      // per-frame material writes for a full room would be the churn the
      // no-per-frame-allocation rule is really about.
      if ((e._archonTintN || 0) !== n) this._retintEnemy(e, kind, n);
      if (n <= 0) continue;
      if (path === FLAME_P && !(e.spawning > 0)) {
        // PYRE burn: 2% of atk per stack per second — 20%/s at full load —
        // banked into half-second ticks exactly like the axe bleed.
        e._pyreT = (e._pyreT || 0) + dt;
        if (e._pyreT >= 0.5) {
          e._pyreT -= 0.5;
          let tick = Math.max(1, Math.round(this.derived.atk * FLAME_P.pyre.dotFracPerStackPerSecond * n * 0.5));
          if (e.sunderT > 0) tick = Math.round(tick * (1 + MASTERY.sunder.bonusTakenPct));
          e.hp -= tick;
          e.hurt = Math.max(e.hurt, 0.15);
          tmpV.copy(e.pos).setY(1.1 * (e.base.scale || 1));
          this.fx.damageNumber(tmpV, tick, '');
          if (e.hp <= 0) { this._killEnemy(e); continue; }
        }
      }
      // Status quads off the one pool: flame licks rise, rime shards hang.
      // Throttled per enemy, denser with stacks; Math.random is visual-only.
      if (this._archonFx) {
        e._archonFxT = (e._archonFxT || 0) - dt;
        if (e._archonFxT <= 0) {
          e._archonFxT = path === FLAME_P ? 0.30 - n * 0.018 : 0.55 - n * 0.03;
          const sc = e.base.scale || 1;
          _archV.set(
            e.pos.x + (Math.random() - 0.5) * e.radius * 1.6,
            (0.4 + Math.random() * 1.3) * sc,
            e.pos.z + (Math.random() - 0.5) * e.radius * 1.6,
          );
          this._archonFx.spawn(_archV, path === FLAME_P
            ? { life: 0.55, scale: 0.55 + n * 0.05, rise: 1.2 }
            : { life: 0.85, scale: 0.45 + n * 0.04, rise: e.frozenT > 0 ? 0 : 0.25 });
        }
      }
    }

    // Billboard and age the quads last, after every spawn this frame.
    if (this._archonFx) this._archonFx.tick(dt, this.camera);
  }

  /**
   * The sanctioned stack visual on a LIVING character: a material COLOUR
   * multiply (tintForStacks — never an emissive, never a rim; rim.js's header
   * is the law). Built lazily per enemy on the first tinted stack: any
   * cache-shared material (cachedMat, the GLB packs' shared skins) is cloned
   * first, because the caches are library objects and tinting one would tint
   * every body wearing it. Clones drop the `shared` flag, so the existing
   * disposeObject3D walk frees them with the mesh — no new teardown surface.
   * The base colour is remembered so the tint MULTIPLIES it (the enemy's own
   * palette shifts toward the hue) and restores exactly at zero stacks.
   */
  _retintEnemy(e, kind, n) {
    e._archonTintN = n;
    if (!e._tintMats) {
      if (n <= 0) return;
      const mats = [];
      e.mesh.traverse((o) => {
        if (!o.isMesh || o.isDecal) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m || !m.color) continue;
          let mm = m;
          if (m.userData?.shared) {
            mm = m.clone();
            if (mm.userData) delete mm.userData.shared;
            if (Array.isArray(o.material)) o.material[i] = mm;
            else o.material = mm;
          }
          mats.push({ m: mm, r: mm.color.r, g: mm.color.g, b: mm.color.b });
        }
      });
      e._tintMats = mats;
    }
    const tint = tintForStacks(kind, n);
    for (const rec of e._tintMats) {
      rec.m.color.setRGB(rec.r * tint.r, rec.g * tint.g, rec.b * tint.b);
    }
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
      // LEGION STEP's re-form leg (CLASSES_SPEC step 8): a recalled soldier is
      // OFF the field — invisible, untargetable, planted — until its slot in
      // the 6 s stagger comes up, then it stands at the player's CURRENT side
      // at 50% HP. The mesh is the same object that detonated: nothing is
      // disposed or rebuilt across the whole cycle (the step's verify clause),
      // only visibility, position and HP move.
      if (s.reform > 0) {
        s.reform -= dt;
        if (s.reform > 0) continue;
        const a = (s._reformSlot / Math.max(1, this.shadows.length)) * Math.PI * 2;
        s.pos.copy(this.player.pos);
        s.pos.x += Math.sin(a) * 2.0;
        s.pos.z += Math.cos(a) * 2.0;
        s.pos.y = 0;
        this.world.resolve(s.pos, s.radius, s.vel);
        s.vel.set(0, 0, 0);
        // 50% HP is the cycle's price: the detonation traded the army's
        // staying power for one burst window. Round like shadowCombat does,
        // floored at 1 so a re-formed soldier can never arrive dead.
        s.hp = Math.max(1, Math.round(s.maxHp * SOVEREIGN.legion.reformHpPct));
        s.mesh.visible = true;
        s.mesh.position.copy(s.pos);
        this.fx.burst(s.pos.clone().setY(0.8), 14, 0x35e6ff, { speed: 5, up: 4, life: 0.5 });
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

      const target = s.telegraph > 0 ? null : this._shadowTarget(s);
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
    // would double-count it. _classShadowMul is the CLASS part on the same
    // logic (BINDER's +20%, isolated in refreshDerived; x1 for everyone
    // else) — the three factors of derived.shadowDmgMul each enter exactly
    // once. origin:'shadow' keeps a soldier's blow from eating the player's
    // banked riposte crit.
    const before = target.hp;
    this._damageEnemy(target,
      s.atk * (this._armorBonus?.shadowDmgMul || 1) * this._classShadowMul,
      { origin: 'shadow' });
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
   * Auto-equip ONLY when unarmed (this.weapon is null/falsy) — the one case
   * where a drop must fill the hand, because a player can't fight barehanded.
   * Every other pickup goes STRAIGHT to the stash, same policy as _takeArmor
   * right below and for the same reason: `score` is rollWeapon's single
   * comparable DPS number, but it has no idea whether the player is running
   * an agi build or a str/vit build, so a "better DPS" heavy weapon can be an
   * actual downgrade for the build the player chose. Silently swapping it
   * into their hand mid-run changes combat numbers they never agreed to.
   * Equipping stays a deliberate act through the inventory panel's
   * compare/equip flow, which shows the delta strip before committing.
   */
  _takeWeapon(w) {
    if (!w) return;
    const held = this.weapon;
    if (!held) {
      this.equip(w);
      this.ui.toast(`${w.name.toUpperCase()}  ·  ${w.rarityName}`, 'gold');
    } else {
      this.stash.unshift(w);
      if (this.stash.length > STASH_LIMIT) this.stash.length = STASH_LIMIT;
      this._persistLoadout();
      this.ui.toast(`STASHED  ${w.name.toUpperCase()}  ·  ${w.rarityName}`, w.rarity === 'legendary' || w.rarity === 'epic' ? 'gold' : undefined);
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

  /**
   * Open the inventory's isolated character viewer. This does NOT move the
   * main world camera or hide any world mesh — it hands the frame to a
   * SEPARATE previewCamera (constructed alongside this.camera above) whose
   * layer mask is INV_PREVIEW_LAYER and nothing else. _updateInventoryCamera
   * tags the player's live rig onto that layer every frame this stays open,
   * so previewCamera literally cannot see the map, the city, a dungeon room,
   * or any other hunter — not because they are hidden, but because they were
   * never on the one layer this camera looks at. That is also why the old
   * "hide the shadow army / city companion so the portrait shot doesn't stare
   * into an ally's back" workaround this function used to carry is gone: an
   * ally mesh was never going to be on INV_PREVIEW_LAYER either, so there is
   * nothing left for it to accidentally show.
   *
   * This game still has exactly one WebGLRenderer (grep confirms it) — a
   * second camera is not a second GL context, just a second lens pointed at
   * the same one, which is the whole trick _renderInventoryPreview uses to
   * draw the isolated shot without a second canvas or render target.
   */
  enterInventoryView() {
    if (this._invView) return; // already framed — a same-frame reopen is a no-op
    this._invView = { yaw: INV_DEFAULT_YAW };
  }

  /** Registered once by InventoryUI, whose stage-centre DOM node is built
   *  exactly once and never torn down (see that file's own header comment) —
   *  so this is a live GETTER, not a snapshot: _renderInventoryPreview calls
   *  it fresh every frame, which is what lets a device rotation or a
   *  responsive breakpoint changing rail width WHILE the panel is open still
   *  confine the render to the rectangle that actually exists right now,
   *  instead of one measured back on open(). */
  setInventoryStageRectProvider(fn) {
    this._invStageRectFn = fn;
  }

  /** Drop the character-viewer state. There is nothing else to hand back —
   *  this.camera was never touched while the panel was open (see above), so
   *  the mode's normal follow rig simply resumes next frame from wherever it
   *  already was, with no re-converge glide needed. */
  exitInventoryView() {
    this._invView = null;
  }

  /** Spin the character viewer by a raw horizontal drag delta in CSS pixels —
   *  called directly by InventoryUI's own drag handler on the stage's centre
   *  column. Scoped entirely to _invView.yaw, so it can never reach (or be
   *  reached by) the world camera's own orbit-drag state on Input — the two
   *  cannot fight because dragging over the panel never reaches the world
   *  canvas in the first place (the panel sits above it in stacking order;
   *  see input.js's own comment on that same fact). A no-op while the panel
   *  is closed, so InventoryUI never needs to guard the call itself. */
  spinInventoryView(dxPixels) {
    if (!this._invView) return;
    this._invView.yaw -= dxPixels * INV_SPIN_PER_PX;
  }

  /**
   * Every frame the character viewer is open: tag the player's CURRENT rig
   * onto INV_PREVIEW_LAYER (never cached — armour/weapon swaps rebuild
   * sub-meshes live via setPlayerArmorLook/rebuildHumanoid while this panel
   * is open, and a freshly built mesh must be visible to previewCamera the
   * same frame it exists, not lag a tag pass that only ran on open), then
   * orbit previewCamera around the player at the current spin yaw. The player
   * mesh itself is held at a stable rotation.y = 0 (the same convention
   * _updatePlayer's facing math uses) — the CAMERA orbits, the rig doesn't,
   * which is what lets a drag spin the model without ever touching p.yaw or
   * anything combat math reads.
   */
  _updateInventoryCamera(dt) {
    const p = this.player;
    if (p.mesh) {
      p.mesh.traverse((o) => { if (o.layers) o.layers.enable(INV_PREVIEW_LAYER); });
      p.mesh.rotation.y = 0;
    }
    const yaw = this._invView.yaw;
    _invLook.set(p.pos.x, p.pos.y + INV_PREVIEW_LOOK_Y, p.pos.z);
    _invPos.set(
      p.pos.x + Math.sin(yaw) * INV_PREVIEW_DIST,
      p.pos.y + INV_PREVIEW_HEIGHT,
      p.pos.z + Math.cos(yaw) * INV_PREVIEW_DIST,
    );
    this.previewCamera.position.copy(_invPos);
    this.previewCamera.lookAt(_invLook.x, _invLook.y, _invLook.z);
  }

  /**
   * The isolated character-viewer render pass. Bypasses glow.js on purpose —
   * nothing on a living player is glow-tagged (rim/glow on living characters
   * stays banned; GLOW_LAYER is a wholly different layer from
   * INV_PREVIEW_LAYER), so the bloom pass would composite literally nothing
   * extra here, and skipping it avoids feeding an unfamiliar second camera
   * through a method whose render-target/layer juggling is tuned for the one
   * camera it runs every other frame of the game. scene.background/fog are
   * forced off for the duration: previewCamera's layer mask already keeps it
   * from SEEING any world geometry, but background/fog are scene-level, not
   * per-camera, and paint regardless of what the camera can see — dungeon.js
   * sets scene.background to a biome sky colour, so without this the "empty"
   * space around the character would tint whatever colour the paused gate
   * happens to be, not the plain black void the panel asks for.
   *
   * THE CONTAINMENT FIX. The first cut of this feature aimed previewCamera at
   * roughly the middle of the FULL canvas and trusted distance/FOV math to
   * make the character line up with the stage's centre column — nothing
   * physically stopped it from spilling past that column's actual edges, and
   * on the owner's real device it did (rendered "massive", poking above the
   * headbar). This version does the opposite: read InventoryUI's stage-centre
   * DOM rectangle (via setInventoryStageRectProvider) and hard-clip the
   * render to EXACTLY that rectangle with a GPU scissor + viewport, so the
   * character CANNOT render outside the rails/ticker/headbar no matter what
   * the framing numbers are. The full canvas is cleared to black first (with
   * scissor test off, so the clear reaches every pixel, not just the stage
   * rectangle) — that is what makes the rest of the screen the plain void the
   * panel asks for, independent of this fitted sub-render.
   */
  _renderInventoryPreview() {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);

    const rect = this._invStageRectFn?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return; // panel mid-layout — next frame catches it

    // setViewport/setScissor take LOGICAL (CSS) pixels, the SAME units
    // setSize does and getBoundingClientRect already returns — three.js
    // multiplies by the pixel ratio internally. Passing device pixels here
    // (this file's first cut of this fix did, via a manual *dpr) double-scales
    // the rect and is exactly what put the character outside the panel
    // instead of confining it — a scissor rect scaled up by pixelRatio a
    // second time reaches well past the actual DOM box on any dpr!=1 screen.
    r.getSize(_invRendererSize); // logical width/height — NOT canvas.width/height (those are device px)
    const vx = rect.left;
    const vw = rect.width;
    const vh = rect.height;
    // DOM rects are measured top-down from the logical viewport; a GL
    // viewport's origin is bottom-left of the same logical frame.
    const vy = _invRendererSize.height - rect.bottom;

    this.previewCamera.aspect = rect.width / rect.height;
    this.previewCamera.updateProjectionMatrix();

    const bg = this.scene.background, fog = this.scene.fog;
    this.scene.background = null;
    this.scene.fog = null;
    r.setViewport(vx, vy, vw, vh);
    r.setScissor(vx, vy, vw, vh);
    r.setScissorTest(true);
    r.render(this.scene, this.previewCamera);
    r.setScissorTest(false);
    r.setViewport(0, 0, _invRendererSize.width, _invRendererSize.height);
    this.scene.background = bg;
    this.scene.fog = fog;
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
    // THE GUILD LEDGER — the daily contract, finally wired. The whole backend
    // (dailyKey/tickDaily/claimDaily, DAILY_TARGET 3, +3 points) shipped in
    // progression.js and sat with ZERO callers; this is its one tick site.
    // A contract unit is a GATE CLEAR — kills would fill 3 in seconds. The
    // claim is automatic at the completing clear: an offline solo game gains
    // nothing from a claim button except a tap between the player and their
    // reward. dailyKey is local-device-date; clock-rolling mints +3/day and
    // that is an accepted cost of full offline (flagged in the audit).
    const ledgerDone = tickDaily(this.save);
    let ledgerRow;
    if (ledgerDone && claimDaily(this.save)) {
      ledgerRow = ['Guild ledger', `CONTRACT FULFILLED  ·  +${DAILY_CONTRACT_POINTS} POINTS`];
      this.ui.toast(`GUILD LEDGER FULFILLED  ·  +${DAILY_CONTRACT_POINTS} STAT POINTS`, 'gold');
    } else {
      const d = dailyState(this.save);
      ledgerRow = ['Guild ledger', d.claimed
        ? 'CONTRACT FULFILLED TODAY'
        : `${d.progress} / ${DAILY_TARGET} GATES TODAY`];
    }
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
        ledgerRow,
      ],
    });
  }

  /**
   * The trial's verdict (CLASSES_SPEC step 7): present archonOffers — the top
   * two paths this save's own play earned, plus SHADOW if absent, never fewer
   * than two — and commit the pick through ascend(), which enforces the SAME
   * offer list, so there is no back door around "depending on their
   * development". Ascending writes save.archon, banks the first-time respec
   * token, zeroes the meter — and changes NOTHING about the derived block
   * (interlock rule 3; refreshDerived below is a re-read, not a re-price, and
   * the classes-test browser suite asserts byte equality across this call).
   * Path mechanics are steps 8-10; today the meter lights and that is all.
   */
  _offerAscension() {
    const offers = archonOffers(this.save);
    this.ui.showArchonOffer({
      save: this.save,
      offers,
      onChoose: (key) => {
        if (!ascendArchon(this.save, key)) return false;
        this.refreshDerived();
        this.onSave();
        this.ui.toast(`YOU ARE THE ${ARCHONS[key].name}`, 'gold');
        return true;
      },
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
