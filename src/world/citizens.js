import * as THREE from 'three';
import { makeCharacter, charactersReady, characterStats } from '../render/characters.js';
import { makeCreature, creaturesReady, creatureFor } from '../render/creatures.js';

// ---------------------------------------------------------------------------
// CITIZENS — the ambient crowd of Threshold
// ---------------------------------------------------------------------------
// A hub with six portals and nobody in it reads as a diorama; the playtest
// asked for a city that feels lived in. This module owns that crowd and
// NOTHING else: no combat, no health, no interaction prompts. The City builds
// it, ticks it and disposes it — citizens never outlive the place they walk.
//
// Three design rules, each load-bearing:
//
// 1. CITIZENS ARE SET DRESSING, NOT ENTITIES. They are not in game.enemies,
//    they carry no colliders, and the player walks THROUGH one (with a polite
//    sidestep from the citizen) rather than being body-blocked in his own hub.
//    The sidestep is one-way: citizens move for the player, never the reverse.
//
// 2. THE SKINNED PACK IS A BUDGET, NOT A PROMISE. makeCharacter refuses past
//    the quality tier's cap (8 on low), and characters.glb may not have
//    shipped at all — both degrade to a procedural villager built here, so an
//    offline APK still has a populated hub. The procedural body deliberately
//    has NO glow, NO emissive eye mote: the telegraph flare is combat
//    language and these people are not combatants.
//
// 3. NO PER-FRAME ALLOCATION. Sixteen NPCs tick inside City.update on a
//    phone; everything below steers with scalar math on pre-built records.

const COUNT = 16;               // 12-20 per the brief; 16 fits the medium tier
// ONE tier change (WORLD_SPEC cityLife.population): eight box-people animating
// off-screen is CPU spent on a tier that is struggling by definition. The
// subset is 5 civilians + 3 hunters rather than the roster's first eight —
// slicing ROSTER in order would take every hunter off the Breach road, and the
// hunters are the half of the crowd that sells what this town IS.
const COUNT_LOW = 8;
const LOW_CIVILIANS = 5;
const WALK_RADIUS = 0.4;        // resolve() radius — same slot a player uses
const AVOID_PLAYER = 1.7;       // start sidestepping inside this range
const SEPARATE = 0.8;           // citizens keep this much air between them
const SOCIAL_RANGE = 2.4;       // two walkers this close may stop and chat
const SOCIAL_COOLDOWN = 14;     // seconds before the same citizen chats again
const TURN_RATE = 5.0;          // rad/s — unhurried, nobody here is kiting

// state machine
const WALK = 0;
const IDLE = 1;
const WAVE = 2;

// ---------------------------------------------------------------------------
// SCHEDULES (WORLD_SPEC step 10)
// ---------------------------------------------------------------------------
// A PHASE TABLE, not a per-NPC planner. The whole system is: which anchor list
// does _pickPoint aim at, and how often. Nothing about HOW a citizen walks
// changes — straight-line legs, city.resolve(), the stuck-shrug — because that
// path is allocation-free and has already survived a playtest.
//
// Deliberately NOT flow fields. navgrid.js is a flow-field grid and baking one
// field per anchor at city build was considered and rejected in the spec
// (auditFindings.cityLifeSubstrate): an anchor-biased leg that ends within a
// few metres of a stall already reads as "going to work", and seven baked
// fields would be seven grid-sized allocations plus a per-frame table lookup
// to buy arrival accuracy nobody can see from the plaza.
const PHASE_DAWN = 'dawn';
const PHASE_DAY = 'day';
const PHASE_DUSK = 'dusk';
const PHASE_NIGHT = 'night';

/** [startHour, endHour) — night wraps midnight and is the else-branch. */
const PHASE_HOURS = { dawn: [5, 7], day: [7, 17], dusk: [17, 20], night: [20, 5] };

/**
 * How often a civilian's next leg aims at that phase's anchors instead of the
 * street network. DAY is 0 on purpose: the shipped wander is already good and
 * the spec says leave it alone.
 */
const PHASE_BIAS = { dawn: 0.6, day: 0, dusk: 0.6, night: 0.7 };

/** Metres of slop around an anchor, so ten people never stack on one stall. */
const ANCHOR_SPREAD = 5.0;

// How far a citizen will travel to reach an anchor. The lantern list spans the
// whole town, and picking uniformly from it sent every night walker on a 60 m
// crossing: measured, their TARGETS were 1 m from a lamp and their BODIES were
// 9-26 m away, permanently in transit, which is the opposite of "holding near
// lanterns". Choosing among the anchors near where he already is makes the
// legs short enough that he is usually standing at one.
const ANCHOR_LOCAL = 45;

// How many of the town's ~100 lamp posts become night anchors. Sampling only a
// handful left the nearest one 30 m away from wherever a walker happened to be,
// which put him back in transit; this is a target list, not a census, but it
// has to be dense enough that "the nearest lamp" is actually near.
const LANTERN_ANCHORS = 40;

// Chance a citizen who reaches his target stops there rather than picking a new
// one, and how long he stays. The higher pair applies when the current phase
// HAS anchors: turning up at the market and immediately leaving is not "going
// to work", and the night rule is literally "hold near lanterns". Day keeps the
// shipped 0.3 / 1.5-4.5 s exactly — the spec says day behaviour is unchanged.
const ARRIVE_IDLE = { chance: 0.3, min: 1.5, span: 3.0 };
const ARRIVE_IDLE_ANCHORED = { chance: 0.62, min: 3.5, span: 7.0 };

// Per-NPC shift offset, in game-minutes either side of the phase boundary. A
// town where sixteen people turn toward the tavern on the same frame reads as
// choreography; +-40 minutes at a 24-minute cycle is ~40 real seconds of
// stagger, which is exactly enough to look like people leaving work.
const PHASE_JITTER_MIN = 40;

// Night population. Four of the ten civilians stay out (the spec's number);
// the rest go home. "Go home" is root.visible=false and NOTHING else: the
// records keep steering, so nobody is destroyed, rebuilt, or teleported, and
// dawn brings the same people back where they would have been.
const NIGHT_CIVILIANS = 4;
const DEPOP_DIST = 25;          // never flip visibility closer than this
const SCAN_INTERVAL = 0.5;      // seconds between visibility/frustum scans

// Mixer throttle. Bone-matrix work is CPU-side and does not shrink with pixel
// ratio (characters.js documents this), so distant NPCs animate at half rate
// with a doubled dt — the gait keeps its speed, the skeleton updates half as
// often, and at 30 m nobody can see the difference.
const MIXER_FAR = 30;

// ---------------------------------------------------------------------------
// HUNTER PORTAL BEAT (WORLD_SPEC step 11)
// ---------------------------------------------------------------------------
const BEAT_NONE = 0;            // wandering; beatIn counts down in GAME hours
const BEAT_WALK = 1;            // crossing to a portal dais
const BEAT_FACE = 2;            // standing in front of it
const BEAT_FADE = 3;            // scaling down into the portal
const BEAT_GONE = 4;            // away; beatT counts down in REAL seconds

const BEAT_EVERY = [3, 6];      // game hours between rolls
const BEAT_FACE_S = [4, 8];     // seconds spent facing the gate
const BEAT_FADE_S = 0.55;       // the scale-down
const BEAT_AWAY_S = [30, 90];   // seconds before he walks back in
// A hunter who cannot reach the dais shrugs and goes back to wandering. The
// allowance is DISTANCE-SCALED because the daises are 22 m from the plaza and
// a hunter can be 100 m away when the roll lands: a flat 45 s looked generous
// until it was measured, and it silently cancelled every beat that started
// from the far side of town — which is most of them.
const BEAT_GIVEUP_MIN_S = 25;
const BEAT_GIVEUP_SLACK = 2.2;  // x the straight-line walk time
const BEAT_ARRIVE = 2.2;        // "at the dais" radius

// A game hour when nobody has fed the clock. daynight.js runs a 24-minute
// cycle, so one game hour is 60 real seconds; the beat only falls back to this
// when City.applyDayState has never called setPhaseHour (a harness that builds
// a city without a clock).
const GAME_HOUR_SECONDS = 60;

// Where a hunter walks back IN from. Probed against resolve() at build rather
// than mirroring city.js's WALL_HALF, because a hardcoded copy of another
// module's constant is a silent misplacement waiting for the day someone moves
// the wall. The three wall gates are centred on the cardinal axes, so a point
// on the axis just outside the wall is always inside the opening.
const GATE_PROBE_R = [96, 100, 104, 110];

// ---------------------------------------------------------------------------
// THE COMPANION (WORLD_SPEC step 11)
// ---------------------------------------------------------------------------
const COMP_HEEL = 2.5;          // where he walks: at your shoulder, behind
const COMP_STOP = 1.4;          // close enough; stop pushing
const COMP_TELEPORT = 25;       // past this he steps out of your shadow instead
const COMP_IDLE_AFTER = 10;     // seconds of a still player before he settles
// The player's own top speed is 6.0 m/s before agility (config.js DERIVED), so
// a companion pinned at a citizen's 1.3 m/s stroll falls behind on the first
// straight and lives permanently at the teleport backstop — which is the one
// behaviour that reads as broken. He walks when close and closes the gap fast
// when he is behind; the ramp is what keeps it from looking like a slide.
const COMP_SPEED_NEAR = 2.2;
const COMP_SPEED_FAR = 7.5;
const COMP_SPEED_RAMP = 8.0;    // metres of gap over which speed reaches FAR

// The shadow-army body, restrained. Same numbers as creatures.applyShadowSkin
// and characters.ghostMaterial — screenshot-tuned to read as near-black under
// ACES at exposure 1.25 — with TWO deliberate differences:
//   * emissive stays BLACK. Every other body in this file is a living person
//     and the no-glow rule is absolute for them; making the companion's body
//     obey the same rule means the test can scan EVERY npc body mechanically
//     instead of carrying an exception that a future edit could widen.
//   * no rim. The spec is explicit ("never a rim light") and the wisps below
//     are the sanctioned accent instead — a cold edge on a body walking the
//     plaza in daylight reads as a shader, not as a bound shadow.
const COMP_BODY = { color: 0x0a1220, roughness: 0.9, metalness: 0.05, env: 0.12 };
// The ONE permitted glow category, and it lives on particles, not on the body.
const WISP_COLOR = 0x35e6ff;
const WISP_COUNT = 14;
const WISP_NODE = 'companion_wisps';   // the name the no-glow scan exempts

// The roster. Civilian archetypes were banned as ENEMIES (fighting a man in
// beach shorts undermined the tone); as townsfolk they are exactly right.
// Hunters use the soldier/medieval pools so the plaza reads as a guild town.
// Seeds repeat on purpose: two citizens sharing a seed share one merged
// geometry in characters.js's refcounted cache, which caps both build time
// and resident memory no matter what COUNT is raised to.
const ROSTER = [];
for (let i = 0; i < 10; i++) {
  ROSTER.push({
    archetype: 'grunt',
    seed: `citizen:${i % 8}`,
    hunter: false,
    // Who is still out after dark. Fixed by index rather than diced so the
    // same four keep the night shift across a rebuild — a town whose night
    // population changes identity every time you re-enter reads as a bug.
    nightKeep: i < NIGHT_CIVILIANS,
  });
}
for (let i = 0; i < 3; i++) ROSTER.push({ archetype: 'lancer', seed: `hunter:${i}`, hunter: true });
for (let i = 0; i < 3; i++) ROSTER.push({ archetype: 'stalker', seed: `hunter:${3 + i}`, hunter: true });

// ---------------------------------------------------------------------------
// FRONTIER CAMPS (WORLD_SPEC frontier.pois)
// ---------------------------------------------------------------------------
// The two Verge camps are specced with people in them — "town_stall + town_cart
// + bench x2 + fence arc + campfire + 2 hunter NPCs at high tier" and "fence
// field + wheat/corn rows + cart + 1 NPC" — and frontier.js already authors the
// exact spots (poi.npcAnchors). Without this block a camp is furniture: the
// ruins and the watchtower are honestly scenery, but the camps were the answer
// to "is anyone out here" and they were answering no.
//
// A camp body is a CITIZEN, not a new kind of thing: same record, same gait,
// same resolve(), same disposal. Three fields make it a camper —
//
//   * `station`, a point it wanders around instead of the street network,
//   * nightKeep, because a staging post you pass at midnight with nobody at the
//     fire is worse than no camp at all (and the de-pop rule exists to thin a
//     CROWD, which three people are not),
//   * no portal beat, because the beat walks to a plaza dais 200 m away and the
//     hunter would spend the rest of the session trying to get back.
//
// TIER-GATED, per the spec's own "at high tier": on `low` the character budget
// is already refusing skinned bodies to the town crowd, and three more walkers
// 200 m outside the wall are the easiest thing in the world to not build.
const CAMP_RADIUS = 5.0;        // how far a camper strays from his anchor
const CAMP_SPREAD = 1.6;        // jitter on the authored anchor, so two hunters do not stack

/** The tier the character budget is currently pointed at ('low'..'ultra'). */
function currentTier() {
  try { return characterStats().tier; } catch { return 'medium'; }
}

/**
 * Which of the sixteen actually spawn. Everything but `low` is all of them;
 * `low` keeps the crowd's SHAPE (civilians and hunters both) at half size
 * rather than truncating the list.
 */
function rosterFor(tier) {
  if (tier !== 'low') return ROSTER.slice(0, Math.min(COUNT, ROSTER.length));
  // The night-shift share is a FRACTION, not a count: keeping the table's four
  // out of a five-person low-tier crowd would leave the tier that is already
  // struggling with almost no night saving. Copies, never the ROSTER entries
  // themselves — those are module state shared by every City ever built.
  const keep = Math.max(1, Math.round((LOW_CIVILIANS * NIGHT_CIVILIANS) / 10));
  const civ = ROSTER.filter((r) => !r.hunter).slice(0, LOW_CIVILIANS)
    .map((r, i) => ({ ...r, nightKeep: i < keep }));
  const hun = ROSTER.filter((r) => r.hunter).slice(0, COUNT_LOW - LOW_CIVILIANS);
  return civ.concat(hun);
}

/** Which schedule phase an hour falls in. */
export function phaseAt(hours) {
  const h = ((hours % 24) + 24) % 24;
  if (h >= PHASE_HOURS.dawn[0] && h < PHASE_HOURS.dawn[1]) return PHASE_DAWN;
  if (h >= PHASE_HOURS.day[0] && h < PHASE_HOURS.day[1]) return PHASE_DAY;
  if (h >= PHASE_HOURS.dusk[0] && h < PHASE_HOURS.dusk[1]) return PHASE_DUSK;
  return PHASE_NIGHT;
}

export class Citizens {
  constructor(city) {
    this.city = city;
    this.group = new THREE.Group();
    this.group.name = 'city_citizens';
    this.npcs = [];
    this._t = 0;
    this._scanT = 0;
    this._rnd = null;
    this._ownedGeometries = [];
    this._ownedMaterials = [];
    this._procMat = null;

    // --- schedules
    /** Sampled clock hour, fed by City.applyDayState. null = no clock wired. */
    this.phaseHour = null;
    this._clockFed = false;
    this._ghAccum = 0;          // game hours since the last update(), from the clock
    /** Baked once at build: { dawn, dusk, night } arrays of {x,z}. */
    this._anchors = null;
    this._gates = [];           // wall-gate walk-in points for the hunter beat

    // --- hunter beat
    this._beatBusy = null;      // at most one hunter mid-beat, ever

    // --- companion
    this.companion = null;      // the npc record, when the roster has anyone
    this._compMat = null;
    this._wisps = null;

    // --- frontier camps
    /** The stationed camp bodies. A SUBSET of this.npcs, not a second list. */
    this.campers = [];
  }

  // ------------------------------------------------------------------ build

  /**
   * @param {function} rnd            the city's forked mulberry32 stream
   * @param {object}   [opts]
   * @param {object}   [opts.save]    read-only; the companion is roster slot 0
   */
  build(rnd, { save = null } = {}) {
    this._rnd = rnd;
    // A settlement may decline the town roster (spec.crowd.town === false —
    // B4b, THE BIRCHREACH): sixteen civilians strolling a forest is the town
    // simulation wearing the wrong coat, and _pickPoint indexes this.streets,
    // which an all-'track' region has none of. Guarded on ABSENCE so both
    // towns run the shipped loop — and its rnd() draws — bit for bit. Camp
    // hunters are unaffected: _spawnCamps below reads the built POI records,
    // and stationed npcs wander their station, never _pickPoint.
    const wantTownCrowd = this.city.spec.crowd?.town !== false;
    if (wantTownCrowd) {
      for (const spec of rosterFor(currentTier())) {
        const npc = this._spawn(spec, rnd);
        if (npc) this.npcs.push(npc);
      }
    }
    // After the crowd, so the anchor probes can lean on a settled city and so
    // the companion's character-budget slot is taken last (a civilian that
    // degrades to a box is a better trade than a companion that does).
    this._bakeAnchors();
    this._bakeGates();
    const comp = this._spawnCompanion(save, rnd);
    if (comp) { this.companion = comp; this.npcs.push(comp); }
    // Last: the camps take whatever character budget the town and the companion
    // left, and a camper degrading to a box-person 200 m outside the wall is the
    // cheapest degradation available.
    this._spawnCamps(rnd);
    this.city.group.add(this.group);
  }

  // ------------------------------------------------------- frontier camps

  /**
   * Populate every frontier POI that asks for people. Reads the BUILT poi
   * records (frontier.js has already jittered and validated their positions),
   * so a camp that moves takes its hunters with it.
   */
  _spawnCamps(rnd) {
    // No Verge, no camps — and no assumption that there is one: City.build's
    // opts.frontier is a real lever and half the harnesses pull it.
    const pois = this.city.frontier?.pois;
    if (!pois || currentTier() === 'low') return;
    for (const poi of pois) {
      const want = poi.npcs | 0;
      if (want <= 0) continue;
      for (let i = 0; i < want; i++) {
        // The authored anchors first; anything past them falls back to the POI
        // centre, so a spec that asks for three people at a two-anchor camp
        // still gets three rather than silently one.
        const a = poi.npcAnchors?.[i] || { x: poi.pos.x, z: poi.pos.z };
        const station = {
          x: a.x + (rnd() * 2 - 1) * CAMP_SPREAD,
          z: a.z + (rnd() * 2 - 1) * CAMP_SPREAD,
        };
        const spec = poi.npcHunter
          ? { archetype: i % 2 ? 'stalker' : 'lancer', seed: `camp:${poi.id}:${i}`, hunter: true }
          : { archetype: 'grunt', seed: `camp:${poi.id}:${i}`, hunter: false };
        const npc = this._spawn(spec, rnd, station);
        if (!npc) continue;
        npc.poiId = poi.id;
        this.npcs.push(npc);
        this.campers.push(npc);
      }
    }
  }

  // ------------------------------------------------------------- anchors

  /**
   * The places a schedule aims at, resolved ONCE from live city data rather
   * than from copied coordinates. Every list degrades to the plaza if its
   * source is missing (procedural fallback city, no interiors, no kit), so a
   * schedule can never aim a citizen at (0,0)-by-accident or at nothing.
   */
  _bakeAnchors() {
    const city = this.city;
    const push = (arr, x, z) => {
      if (Number.isFinite(x) && Number.isFinite(z)) arr.push({ x, z });
    };
    const district = (id) => city.districts?.find((d) => d.id === id) || null;

    // DAWN — the market opens. Stalls first (they ARE the market strip), the
    // Exchange's own pad, and both fountains.
    const dawn = [];
    for (const s of city.propMeta?.stalls || []) push(dawn, s.x, s.z);
    const ex = district('exchange');
    if (ex) push(dawn, ex.pos.x, ex.pos.z);
    for (const f of city.propMeta?.fountains || []) push(dawn, f.x, f.z);

    // DUSK — Quarter Row and the tavern's doorstep. The door pad comes from
    // interiors.js's own record, so if the tavern ever moves plots the crowd
    // moves with it.
    const dusk = [];
    const row = district('row');
    if (row) { push(dusk, row.pos.x, row.pos.z); push(dusk, row.pos.x + 6, row.pos.z - 7); }
    const tav = city.interiors?.byId?.get('tavern_row');
    if (tav?.door) push(dusk, tav.door.outX, tav.door.outZ);
    for (const b of city.propMeta?.benches || []) {
      if (Math.hypot(b.x - (row?.pos.x ?? 0), b.z - (row?.pos.z ?? 0)) < 30) push(dusk, b.x, b.z);
    }

    // NIGHT — under the lanterns. The lamp bulbs are one InstancedMesh built by
    // city._buildLampGlow; reading its matrices is the only way to know where
    // the light actually is (the lantern field is merged instance data with no
    // position list behind it). Bounded to 18: this is a target list, not a
    // census, and a hundred entries would only make the pick colder.
    const night = [];
    const bulbs = city.group.getObjectByName('city_lamp_glow');
    if (bulbs?.isInstancedMesh) {
      const step = Math.max(1, Math.floor(bulbs.count / LANTERN_ANCHORS));
      for (let i = 0; i < bulbs.count && night.length < LANTERN_ANCHORS; i += step) {
        bulbs.getMatrixAt(i, _m4);
        _v3.setFromMatrixPosition(_m4);
        push(night, _v3.x, _v3.z);
      }
    }
    for (const f of city.propMeta?.fountains || []) push(night, f.x, f.z);

    const fallback = [{ x: 0, z: 10 }, { x: 8, z: -8 }, { x: -9, z: 6 }];
    this._anchors = {
      [PHASE_DAWN]: dawn.length ? dawn : fallback,
      [PHASE_DUSK]: dusk.length ? dusk : fallback,
      [PHASE_NIGHT]: night.length ? night : fallback,
    };
  }

  /**
   * The three wall gates, found by probe. city.js's wall breaks on each
   * cardinal axis, so a point ON the axis is inside the opening at any radius;
   * the probe only has to find one that resolve() does not push, which is what
   * makes this survive the wall moving.
   */
  _bakeGates() {
    const city = this.city;
    const dirs = [[0, -1], [0, 1], [1, 0]];   // north (the Breach road), south, east
    for (const [dx, dz] of dirs) {
      for (const r of GATE_PROBE_R) {
        _v3.set(dx * r, 0, dz * r);
        const bx = _v3.x, bz = _v3.z;
        city.resolve(_v3, WALK_RADIUS);
        if (Math.hypot(_v3.x - bx, _v3.z - bz) < 0.05) { this._gates.push({ x: bx, z: bz }); break; }
      }
    }
    if (!this._gates.length) this._gates.push({ x: 0, z: 40 });
  }

  /**
   * @param {object} spec        roster entry
   * @param {function} rnd       the city's forked stream
   * @param {?{x:number,z:number}} station  a frontier camp post; null = town
   */
  _spawn(spec, rnd, station = null) {
    const city = this.city;
    // Stand on a street. Streets are where the wandering happens, so spawning
    // on one guarantees the first waypoint is reachable without pathfinding.
    let x = 0, z = 20;
    if (station) {
      x = station.x; z = station.z;
    } else {
      for (let tries = 0; tries < 12; tries++) {
        const w = this._pickPoint(spec.hunter, rnd);
        let clear = true;
        for (const o of this.npcs) {
          const dx = w.x - o.pos.x, dz = w.z - o.pos.z;
          if (dx * dx + dz * dz < 9) { clear = false; break; }
        }
        if (clear || tries === 11) { x = w.x; z = w.z; break; }
      }
    }

    const scale = 0.93 + rnd() * 0.1;
    let inst = null;
    if (charactersReady()) {
      inst = makeCharacter({
        seed: spec.seed,
        archetype: spec.archetype,
        scale,
        // No mote, no rim, no tint: a citizen is lit like everyone else and
        // glows like nobody. The pack palette is all the variety needed.
        glow: 0xffffff,
        color: 0xffffff,
        eyes: false,
        armed: false,
      });
    }
    const root = inst ? inst.root : this._buildVillager(rnd, scale);
    if (!root) return null;
    // Citizens cast NO shadow, ever. Not (only) for fill rate: a skinned
    // caster lazily compiles a skinned depth-material program the first time
    // it enters the shadow frustum, and tools/city-test.mjs rightly treats
    // any program-count growth mid-walk as the PointLight-recompile bug. A
    // contact shadow on set dressing is not worth reopening that class of
    // hitch on a phone.
    // "ever" is the load-bearing word, and until now it was not true: the
    // frame-rate governor's setCharacterQuality wrote castShadow back on over
    // every live instance on any tier change, so this line held only until the
    // first hitch. shadowPinned makes the decision stick.
    if (inst) { inst.shadowPinned = true; inst.mesh.castShadow = false; }

    const npc = {
      root,
      inst,                                     // null = procedural body
      rig: inst ? null : root.userData.villagerRig,
      pos: new THREE.Vector3(x, city.heightAt(x, z), z),
      yaw: rnd() * 6.283,
      speed: (spec.hunter ? 1.3 : 1.05) + rnd() * 0.35,
      state: IDLE,
      stateT: rnd() * 2,
      tx: x, tz: z,
      social: rnd() * SOCIAL_COOLDOWN,          // desynchronise first chats
      stuckT: 0,
      hunter: spec.hunter,
      phase: rnd() * 6.283,
      // --- schedule state
      // This citizen's private idea of when the shift changes, in hours.
      phaseOff: ((rnd() * 2 - 1) * PHASE_JITTER_MIN) / 60,
      // Set by build(): the four civilians who stay out after dark. A camper
      // always keeps his post — see the FRONTIER CAMPS note.
      nightKeep: Boolean(spec.hunter || spec.nightKeep || station),
      // --- frontier camp state
      station,
      poiId: null,
      animT: 0,                                 // banked dt for the half-rate mixer
      animSkip: false,
      // --- hunter beat state
      beat: BEAT_NONE,
      beatIn: BEAT_EVERY[0] + rnd() * (BEAT_EVERY[1] - BEAT_EVERY[0]),
      beatT: 0,
      beatPortal: null,
      baseScale: 1,
      companion: false,
    };
    npc.baseScale = root.scale.x || 1;
    city.resolve(npc.pos, WALK_RADIUS);
    npc.pos.y = city.heightAt(npc.pos.x, npc.pos.z);
    root.position.copy(npc.pos);
    root.rotation.y = npc.yaw;
    this.group.add(root);
    return npc;
  }

  /**
   * The clock, forwarded by City.applyDayState once a frame. Stores a float and
   * banks the elapsed GAME hours for the hunter beat; allocates nothing.
   */
  setPhaseHour(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h)) return;
    if (this._clockFed) {
      let d = h - this.phaseHour;
      // Midnight wrap. A backwards step of any other size means somebody set
      // the clock by hand (a test fast-forwarding, the player loading a save) —
      // bank nothing rather than banking a negative or a fictitious day.
      if (d < -12) d += 24;
      if (d < 0 || d > 6) d = 0;
      this._ghAccum += d;
    }
    this.phaseHour = h;
    this._clockFed = true;
  }

  /** This NPC's phase, shifted by its own +-40 game-minute shift offset. */
  _phaseFor(off) {
    if (this.phaseHour == null) return PHASE_DAY;
    return phaseAt(this.phaseHour + off);
  }

  /**
   * A random spot on the street network. Civilians stay inside the walls.
   *
   * `phaseOff` is the caller's shift offset; the anchor bias is the ONLY thing
   * schedules change here. Hunters never take it — the whole point of them is
   * that they keep their own hours and the Breach road at night is exactly
   * where they belong.
   */
  _pickPoint(hunter, rnd, near = null, out = _wp, phaseOff = 0) {
    const streets = this.city.streets;

    if (!hunter && this._anchors) {
      const phase = this._phaseFor(phaseOff);
      const bias = PHASE_BIAS[phase] || 0;
      const list = this._anchors[phase];
      if (bias > 0 && list && list.length && rnd() < bias) {
        // Reservoir pick among the anchors within walking distance, with the
        // nearest one as the fallback — no temporary array, one pass.
        let pick = null, seen = 0, best = null, bestD = Infinity;
        for (const a of list) {
          const d = near ? Math.hypot(a.x - near.x, a.z - near.z) : 0;
          if (d < bestD) { bestD = d; best = a; }
          if (d <= ANCHOR_LOCAL) { seen++; if (rnd() < 1 / seen) pick = a; }
        }
        const a = pick || best;
        if (a) {
          out.x = a.x + (rnd() - 0.5) * ANCHOR_SPREAD;
          out.z = a.z + (rnd() - 0.5) * ANCHOR_SPREAD;
          return out;
        }
      }
    }
    // The plaza is not a street, so a street-only wander never crosses it —
    // and the plaza is the one place the player is guaranteed to stand.
    // About a fifth of all legs cut across the flagstones instead.
    if (rnd() < 0.22) {
      const a = rnd() * 6.283;
      const r = 6 + rnd() * 17;
      out.x = Math.cos(a) * r;
      out.z = -Math.sin(a) * r;
      return out;
    }
    for (let tries = 0; tries < 8; tries++) {
      const s = streets[Math.floor(rnd() * streets.length) % streets.length];
      // The Breach road is outside the wall and ends at an S-rank rift;
      // window-shopping civilians have no business there. Hunters do.
      if (!hunter && (s.z1 < -88 || s.z2 < -88)) continue;
      const t = rnd();
      const lat = (rnd() - 0.5) * s.w * 0.9;
      const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
      const len = Math.hypot(dx, dz) || 1;
      const x = s.x1 + dx * t - (dz / len) * lat;
      const z = s.z1 + dz * t + (dx / len) * lat;
      // Wander locally. A citizen crossing the whole town in one leg spends
      // his life in transit and the streets never look occupied.
      if (near && Math.hypot(x - near.x, z - near.z) > 55 && tries < 7) continue;
      // Bias the crowd toward the centre: the plaza and the four avenues are
      // where the player actually stands, and sixteen people spread over
      // 340 m of map is an empty town from any one spot. Outer targets are
      // accepted with one-in-three odds, so the edges stay visited but the
      // core stays busy.
      if (Math.hypot(x, z) > 62 && rnd() < 0.67 && tries < 7) continue;
      out.x = x; out.z = z;
      return out;
    }
    out.x = 0; out.z = 20;
    return out;
  }

  // ---------------------------------------------------- procedural fallback

  /**
   * The no-GLB villager: a flat-shaded box-person in townsfolk colours.
   * Deliberately plainer than the enemy box-man in entities.js — no glowing
   * visor, no weapon — because those read as combat cues and this is a
   * bystander. Geometries are cached per palette entry on this Citizens
   * instance and disposed with it.
   */
  _buildVillager(rnd, scale) {
    if (!this._procMat) {
      this._procMat = new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0.0,
      });
      this._ownedMaterials.push(this._procMat);
    }
    const PALETTE = [
      { shirt: 0x8a6f4d, pants: 0x4a4438 }, { shirt: 0x6d7a8a, pants: 0x3d3a33 },
      { shirt: 0x7a8a5c, pants: 0x4d4030 }, { shirt: 0x9a7a6a, pants: 0x37404a },
      { shirt: 0x707a66, pants: 0x494036 }, { shirt: 0x8a8060, pants: 0x403a44 },
    ];
    const v = Math.floor(rnd() * PALETTE.length) % PALETTE.length;
    const p = PALETTE[v];
    const skin = 0xc9a482;

    const geo = (key, make) => {
      const k = `${key}:${v}`;
      let g = this._procGeo?.get(k);
      if (!g) {
        if (!this._procGeo) this._procGeo = new Map();
        g = make();
        this._procGeo.set(k, g);
        this._ownedGeometries.push(g);
      }
      return g;
    };
    const paint = (g, hex) => {
      const c = new THREE.Color(hex);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    };

    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const torso = new THREE.Mesh(geo('torso', () => {
      const g = new THREE.BoxGeometry(0.5, 0.62, 0.28);
      g.translate(0, 1.22, 0);
      return paint(g, p.shirt);
    }), this._procMat);
    body.add(torso);

    const head = new THREE.Mesh(geo('head', () => {
      const g = new THREE.BoxGeometry(0.26, 0.28, 0.26);
      g.translate(0, 1.71, 0);
      return paint(g, skin);
    }), this._procMat);
    body.add(head);

    const armGeo = geo('arm', () => {
      const g = new THREE.BoxGeometry(0.13, 0.58, 0.13);
      g.translate(0, -0.26, 0);
      return paint(g, p.shirt);
    });
    const legGeo = geo('leg', () => {
      const g = new THREE.BoxGeometry(0.16, 0.9, 0.16);
      g.translate(0, -0.42, 0);
      return paint(g, p.pants);
    });
    const armL = new THREE.Group(); armL.position.set(-0.33, 1.48, 0);
    const armR = new THREE.Group(); armR.position.set(0.33, 1.48, 0);
    armL.add(new THREE.Mesh(armGeo, this._procMat));
    armR.add(new THREE.Mesh(armGeo, this._procMat));
    const legL = new THREE.Group(); legL.position.set(-0.14, 0.9, 0);
    const legR = new THREE.Group(); legR.position.set(0.14, 0.9, 0);
    legL.add(new THREE.Mesh(legGeo, this._procMat));
    legR.add(new THREE.Mesh(legGeo, this._procMat));
    body.add(armL, armR, legL, legR);

    root.scale.setScalar(scale);
    root.userData.villagerRig = { body, armL, armR, legL, legR };
    return root;
  }

  // ------------------------------------------------------------- companion

  /**
   * The one bound shadow that walks the city with you: roster slot 0, the same
   * figure it had in the gate, standing at your shoulder in the plaza. Purely
   * cosmetic here — there is no combat in the city or the Verge — which is why
   * it lives in this file as a special citizen rather than in game.js's field
   * army: it inherits spawn, separation, ground-follow and disposal for free.
   *
   * Returns null when the roster is empty, which is the whole gating rule: a
   * player who has bound nobody walks alone.
   */
  _spawnCompanion(save, rnd) {
    const rec = save?.shadows?.roster?.[0];
    if (!rec) return null;
    const city = this.city;

    // Same figure resolution game.js._spawnShadow uses, minus the write-back:
    // a city walk must never mutate the save (the lazy migration belongs to
    // the code that fields the soldier, not to set dressing).
    let key = rec.creature || null;
    if (!key && creaturesReady()) {
      key = creatureFor(`${rec.type || 'grunt'}:${(rec.id || 1) % 4}`, {
        archetype: rec.type || 'grunt', rank: 'E',
      })?.key || null;
    }

    let inst = null;
    let root = null;
    if (key && creaturesReady()) {
      inst = makeCreature({
        creature: key, rank: 'E', shadow: true, glow: WISP_COLOR, eyes: false,
        scale: 1,
        // Same reason game.js gives: a bound shadow must not evict a living
        // body from the creature budget.
        ignoreBudget: true,
      });
      if (inst) {
        // The outer-Group wrap game.js._makeBoundBody uses, so the game-space
        // scale rides on a node the creature's own normalisation does not own.
        root = new THREE.Group();
        root.add(inst.root);
        root.scale.setScalar(0.95);
      }
    }
    if (!root && charactersReady()) {
      inst = makeCharacter({
        seed: `companion:${rec.id || 0}`, archetype: 'shadow', rank: 'E',
        scale: 1.0, glow: WISP_COLOR, ghost: true, eyes: false, armed: true,
        ignoreBudget: true,
      });
      if (inst) root = inst.root;
    }
    if (!root) {
      // Offline, no packs at all: the box villager, painted out. Better a dark
      // silhouette at your heel than nobody.
      root = this._buildVillager(rnd, 0.98);
      inst = null;
    }
    if (!root) return null;

    root.name = 'city_companion';
    this._applyCompanionDark(root);
    root.add(this._buildWisps());

    // Behind the player's arrival point, not on top of it.
    const sp = city.spawnPoint ? city.spawnPoint(WALK_RADIUS) : null;
    const sx = sp ? sp.x : 0;
    const sz = (sp ? sp.z : 20) + COMP_HEEL;
    const npc = {
      root,
      inst,
      rig: inst ? null : root.userData.villagerRig,
      pos: new THREE.Vector3(sx, city.heightAt(sx, sz), sz),
      yaw: 0,
      speed: 3.1,                               // a shade faster than you walk
      state: IDLE,
      stateT: 0,
      tx: sx, tz: sz,
      social: 1e9,                              // shadows do not gossip
      stuckT: 0,
      hunter: false,
      phase: 0,
      phaseOff: 0,
      nightKeep: true,                          // never de-pops
      animT: 0,
      animSkip: false,
      beat: BEAT_NONE,
      beatIn: Infinity,
      beatT: 0,
      beatPortal: null,
      baseScale: root.scale.x || 1,
      companion: true,
      idleT: 0,                                 // how long the player has stood still
      lastPx: sx, lastPz: sz,
      name: rec.name || 'shadow',
    };
    city.resolve(npc.pos, WALK_RADIUS);
    npc.pos.y = city.heightAt(npc.pos.x, npc.pos.z);
    root.position.copy(npc.pos);
    this.group.add(root);
    return npc;
  }

  /**
   * The restrained dark treatment, applied over whatever body we got.
   *
   * ONE material for every mesh on him, minted here and disposed here. It is
   * deliberately NOT creatures.applyShadowSkin's material even though the
   * numbers match: that one carries a non-black emissive and the 'shadow' rim
   * preset, and the rim brings its own program cache key. Both are wrong for a
   * companion strolling a lit plaza (see COMP_BODY), and the material this
   * replaces is thrown away before it is ever rendered, so no extra shader is
   * compiled by the swap.
   */
  _applyCompanionDark(root) {
    if (!this._compMat) {
      this._compMat = new THREE.MeshStandardMaterial({
        color: COMP_BODY.color,
        roughness: COMP_BODY.roughness,
        metalness: COMP_BODY.metalness,
        envMapIntensity: COMP_BODY.env,
        emissive: 0x000000,
        flatShading: false,
        side: THREE.FrontSide,
      });
      this._ownedMaterials.push(this._compMat);
    }
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.material = this._compMat;
      // Same recompile guard the citizens carry, and for the same reason: a
      // skinned caster compiles a skinned depth program the first time it
      // enters the shadow frustum. characters.js honours shadowPinned;
      // creatures.setCreatureQuality does not, so update() re-asserts this.
      o.castShadow = false;
      o.receiveShadow = false;
    });
  }

  /**
   * The dark wisps. The ONE sanctioned glow in this file, and it lives on
   * particles rather than on the body — a body that glows is the thing the
   * owner asked us to stop doing.
   *
   * One Points draw, fourteen vertices, no per-frame upload: the whole
   * animation is the node's own rotation and bob, so the attribute buffer is
   * written once at build. Kept OFF the glow layer on purpose — the additive
   * composite is what washed the night frames out the first time.
   */
  _buildWisps() {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(WISP_COUNT * 3);
    for (let i = 0; i < WISP_COUNT; i++) {
      const a = (i / WISP_COUNT) * Math.PI * 2 * 1.618;
      const r = 0.22 + (i % 4) * 0.07;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = 0.12 + (i / WISP_COUNT) * 1.35;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color: WISP_COLOR,
      size: 0.075,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._ownedGeometries.push(g);
    this._ownedMaterials.push(m);
    const p = new THREE.Points(g, m);
    p.name = WISP_NODE;
    p.frustumCulled = false;
    this._wisps = p;
    return p;
  }

  // -------------------------------------------------------------- per frame

  update(dt, playerPos) {
    const npcs = this.npcs;
    if (!npcs.length) return;
    const city = this.city;
    const t = (this._t += dt);

    // Game hours burned since the last frame — the hunter beat's clock. The
    // fallback keeps the beat running at the shipped cycle's rate in a harness
    // that never wires daynight.js up.
    const gameHours = this._clockFed ? this._ghAccum : dt / GAME_HOUR_SECONDS;
    this._ghAccum = 0;

    // Visibility bookkeeping is throttled: a Frustum rebuild plus a sphere test
    // per NPC is not per-frame work for a decision that changes twice a day.
    this._scanT -= dt;
    if (this._scanT <= 0) {
      this._scanT = SCAN_INTERVAL;
      this._scanVisibility(playerPos);
    }

    // Pairwise pass: separation every frame (128 distance checks for 16 NPCs
    // — cheaper than one bone-matrix upload), chats decided in the same loop.
    for (let i = 0; i < npcs.length; i++) {
      const a = npcs[i];
      for (let j = i + 1; j < npcs.length; j++) {
        const b = npcs[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < SEPARATE * SEPARATE && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = ((SEPARATE - d) / d) * 0.5;
          a.pos.x -= dx * push; a.pos.z -= dz * push;
          b.pos.x += dx * push; b.pos.z += dz * push;
        } else if (
          d2 < SOCIAL_RANGE * SOCIAL_RANGE
          && a.state === WALK && b.state === WALK
          && a.social <= 0 && b.social <= 0
          // A bound shadow does not stop for a chat, and a hunter walking his
          // portal beat has somewhere to be.
          && !a.companion && !b.companion
          && a.beat === BEAT_NONE && b.beat === BEAT_NONE
        ) {
          // Two walkers meet: stop, face each other, one may wave. This tiny
          // beat is most of what "the city is alive" costs.
          a.social = SOCIAL_COOLDOWN + this._rnd() * 6;
          b.social = SOCIAL_COOLDOWN + this._rnd() * 6;
          a.yaw = Math.atan2(dx, dz);
          b.yaw = Math.atan2(-dx, -dz);
          const dur = 2.2 + this._rnd() * 2.2;
          this._setState(a, this._rnd() < 0.6 ? WAVE : IDLE, dur);
          this._setState(b, IDLE, dur);
        }
      }
    }

    for (const n of npcs) {
      n.social -= dt;
      n.stateT -= dt;
      let moving = false;

      // The companion steers itself (it heels on the player rather than
      // wandering) and then rejoins the shared tail below.
      if (n.companion) {
        moving = this._updateCompanion(n, dt, playerPos);
      } else {
        // The beat walks to a plaza dais. A camp hunter is 200 m outside the
        // wall with no path home worth watching, so he keeps his post.
        if (n.hunter && !n.station) this._updateBeat(n, dt, gameHours, playerPos);

        if (n.beat === BEAT_GONE) {
          // Away. He keeps his record and his position; there is simply nobody
          // standing there. No mixer, no resolve, no ground sample.
          continue;
        }

        if (n.state === WALK) {
          const dx = n.tx - n.pos.x;
          const dz = n.tz - n.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 1.3) {
            // Mid-beat the target belongs to the beat, which is watching this
            // same distance and will advance on its own next frame.
            if (n.beat === BEAT_WALK) { /* held by the beat */ }
            else {
              // A camper is permanently "at work": long idles at the fire are
              // the whole read, and a man doing laps of a campfire is not.
              const anchored = Boolean(n.station) || (!n.hunter
                && (PHASE_BIAS[this._phaseFor(n.phaseOff)] || 0) > 0);
              const w = anchored ? ARRIVE_IDLE_ANCHORED : ARRIVE_IDLE;
              if (this._rnd() < w.chance) this._setState(n, IDLE, w.min + this._rnd() * w.span);
              else this._newTarget(n);
            }
          } else {
            const want = Math.atan2(dx, dz);
            let diff = want - n.yaw;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            n.yaw += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, diff));
            const step = n.speed * dt;
            n.pos.x += Math.sin(n.yaw) * step;
            n.pos.z += Math.cos(n.yaw) * step;
            moving = true;
            // Wedged against a building or another curiosity: shrug, go
            // somewhere else. Citizens have nowhere they NEED to be.
            const px = n.pos.x, pz = n.pos.z;
            city.resolve(n.pos, WALK_RADIUS);
            const pushed = Math.hypot(n.pos.x - px, n.pos.z - pz);
            n.stuckT = pushed > step * 0.55 ? n.stuckT + dt : 0;
            if (n.stuckT > 1.2) {
              n.stuckT = 0;
              // A hunter who cannot reach his dais abandons the beat rather
              // than grinding into a wall for forty seconds.
              if (n.beat === BEAT_WALK) this._endBeat(n);
              this._newTarget(n);
            }
          }
        } else if (n.stateT <= 0 && n.beat === BEAT_NONE) {
          this._newTarget(n);
          this._setState(n, WALK, 0);
        }

        // The polite sidestep. One-way: the citizen yields, the player's own
        // physics never sees the citizen at all.
        if (playerPos) {
          const dx = n.pos.x - playerPos.x;
          const dz = n.pos.z - playerPos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < AVOID_PLAYER * AVOID_PLAYER && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const k = ((AVOID_PLAYER - d) / d) * Math.min(1, dt * 6);
            n.pos.x += dx * k;
            n.pos.z += dz * k;
            city.resolve(n.pos, WALK_RADIUS);
          }
        }
      }

      n.pos.y = city.heightAt(n.pos.x, n.pos.z);
      n.root.position.copy(n.pos);
      n.root.rotation.y = n.yaw;

      // The mixer is the expensive half of an NPC and it is CPU work that does
      // not shrink with resolution, so: nothing at all for a body nobody can
      // see, and half rate past 30 m with a doubled dt so the gait keeps its
      // speed. `animT` banks the skipped frame rather than dropping it.
      n.animT += dt;
      if (!n.root.visible) { n.animT = 0; continue; }
      if (this._farFromCamera(n)) {
        n.animSkip = !n.animSkip;
        if (n.animSkip) continue;
      }
      const adt = Math.min(0.1, n.animT);
      n.animT = 0;

      if (n.inst) {
        if (n.state === WAVE) n.inst.update(adt);   // let the Wave clip finish
        else n.inst.animate({ moving, speed: n.speed, dt: adt });
      } else {
        this._animateVillager(n, t, moving);
      }
    }
  }

  /** Squared distance from the render camera, or 0 when there is not one. */
  _farFromCamera(n) {
    const cam = this.city.camera;
    if (!cam) return false;
    const dx = n.pos.x - cam.position.x;
    const dz = n.pos.z - cam.position.z;
    return dx * dx + dz * dz > MIXER_FAR * MIXER_FAR;
  }

  // ------------------------------------------------------- night de-pop

  /**
   * Who is out right now. The rule the spec is emphatic about: a citizen may
   * only appear or disappear when the player cannot possibly be looking — more
   * than 25 m away AND outside the camera frustum. A body winking out in view
   * is worse than a slightly over-populated night.
   */
  _scanVisibility(playerPos) {
    const cam = this.city.camera;
    let haveFrustum = false;
    if (cam) {
      cam.updateMatrixWorld();
      _m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_m4);
      haveFrustum = true;
    }
    const night = this.phaseHour != null;
    for (const n of this.npcs) {
      // The companion never de-pops; a hunter mid-beat owns his own visibility.
      if (n.companion || n.beat >= BEAT_FADE) continue;
      const wantHidden = night && !n.nightKeep && this._phaseFor(n.phaseOff) === PHASE_NIGHT;
      if (wantHidden === !n.root.visible) continue;
      let far = true;
      if (playerPos) {
        const dx = n.pos.x - playerPos.x;
        const dz = n.pos.z - playerPos.z;
        far = dx * dx + dz * dz > DEPOP_DIST * DEPOP_DIST;
      }
      let onScreen = false;
      if (haveFrustum) {
        _sphere.center.set(n.pos.x, n.pos.y + 1.0, n.pos.z);
        onScreen = _frustum.intersectsSphere(_sphere);
      }
      if (far && !onScreen) n.root.visible = !wantHidden;
    }
  }

  // ----------------------------------------------------- hunter portal beat

  /**
   * "Other hunters use these gates." Every few game hours one hunter walks to
   * an unlocked dais, stands looking into it, and steps through; half a minute
   * later he walks back in through a wall gate. No new effect, no new asset —
   * a scale-down and the portal's own pulse.
   *
   * Two rules, both about not reading as a bug: at most ONE hunter is mid-beat
   * at a time (a plaza where three men vanish at once is a glitch), and never
   * the portal the player is standing at (a body dissolving under your own
   * prompt reads as the game losing an NPC).
   */
  _updateBeat(n, dt, gameHours, playerPos) {
    const rnd = this._rnd;
    switch (n.beat) {
      case BEAT_NONE:
        n.beatIn -= gameHours;
        if (n.beatIn <= 0 && !this._beatBusy && n.root.visible) {
          const p = this._pickBeatPortal(playerPos);
          if (!p) { n.beatIn = 0.5; break; }
          // Stand OFF the dais, on the plaza side: the dais is a solid the
          // collision hash pushes bodies out of anyway, so aiming at its
          // centre would just grind him against it.
          //
          // The stand-off is derived from the dais's ACTUAL collider, not from
          // a fraction of the prompt radius. The Breach portal is built at
          // scale 1.85 — a 4.81 m dais inside a 6.5 m prompt — so the fraction
          // put its approach point INSIDE the solid, and every beat that rolled
          // the Breach ground into it until the stuck-shrug cancelled it.
          const len = Math.hypot(p.pos.x, p.pos.z) || 1;
          let daisR = 2.6;
          for (const o of this.city.obstacles) {
            if (o.radius > daisR
              && Math.abs(o.pos.x - p.pos.x) < 1 && Math.abs(o.pos.z - p.pos.z) < 1) daisR = o.radius;
          }
          const back = Math.max(p.radius * 0.72, daisR + 1.3);
          n.tx = p.pos.x - (p.pos.x / len) * back;
          n.tz = p.pos.z - (p.pos.z / len) * back;
          n.beatPortal = p;
          n.beat = BEAT_WALK;
          n.beatT = Math.max(
            BEAT_GIVEUP_MIN_S,
            (Math.hypot(n.tx - n.pos.x, n.tz - n.pos.z) / n.speed) * BEAT_GIVEUP_SLACK,
          );
          n.state = WALK;
          n.stateT = 0;
          this._beatBusy = n;
        }
        break;

      case BEAT_WALK: {
        n.beatT -= dt;
        const d = Math.hypot(n.tx - n.pos.x, n.tz - n.pos.z);
        if (d < BEAT_ARRIVE) {
          n.beat = BEAT_FACE;
          n.beatT = BEAT_FACE_S[0] + rnd() * (BEAT_FACE_S[1] - BEAT_FACE_S[0]);
          this._setState(n, IDLE, n.beatT);
        } else if (n.beatT <= 0) {
          this._endBeat(n);
          this._newTarget(n);
        }
        break;
      }

      case BEAT_FACE: {
        n.beatT -= dt;
        const p = n.beatPortal;
        if (p) n.yaw = Math.atan2(p.pos.x - n.pos.x, p.pos.z - n.pos.z);
        n.state = IDLE;
        n.stateT = Math.max(n.stateT, n.beatT);
        if (n.beatT <= 0) {
          n.beat = BEAT_FADE;
          n.beatT = BEAT_FADE_S;
          // The gate answers. This re-phases the pulse city.update is ALREADY
          // running on that portal so its brightest frame lands as he steps
          // through — the spec's "no new effect", literally.
          if (p) p.phase = -this.city._t * 1.7 + Math.PI * 0.5;
        }
        break;
      }

      case BEAT_FADE:
        n.beatT -= dt;
        n.root.scale.setScalar(n.baseScale * Math.max(0.001, n.beatT / BEAT_FADE_S));
        if (n.beatT <= 0) {
          n.root.visible = false;
          n.root.scale.setScalar(n.baseScale);
          n.beat = BEAT_GONE;
          n.beatT = BEAT_AWAY_S[0] + rnd() * (BEAT_AWAY_S[1] - BEAT_AWAY_S[0]);
        }
        break;

      case BEAT_GONE:
        n.beatT -= dt;
        if (n.beatT <= 0) {
          // Back in through a wall gate, walking, facing the town.
          const g = this._gates[Math.floor(rnd() * this._gates.length) % this._gates.length];
          n.pos.set(g.x, this.city.heightAt(g.x, g.z), g.z);
          this.city.resolve(n.pos, WALK_RADIUS);
          n.yaw = Math.atan2(-n.pos.x, -n.pos.z);
          n.root.position.copy(n.pos);
          n.root.visible = true;
          this._endBeat(n);
          this._newTarget(n);
        }
        break;

      default:
        break;
    }
  }

  /** An unlocked portal that is not the one under the player's prompt. */
  _pickBeatPortal(playerPos) {
    const portals = this.city.portals;
    if (!portals || !portals.length) return null;
    const prompted = playerPos && this.city.portalAt ? this.city.portalAt(playerPos) : null;
    let seen = 0, pick = null;
    // Reservoir pick: one pass, no temporary array, uniform over the eligible.
    // Wild gates are excluded: they are 200 m out in the Verge across ground
    // this beat has no business crossing, and a hunter who spends four minutes
    // walking there is a hunter who is never in the plaza.
    for (const p of portals) {
      if (p.locked || p.wild || p === prompted) continue;
      seen++;
      if (this._rnd() < 1 / seen) pick = p;
    }
    return pick;
  }

  _endBeat(n) {
    n.beat = BEAT_NONE;
    n.beatPortal = null;
    n.beatT = 0;
    n.beatIn = BEAT_EVERY[0] + this._rnd() * (BEAT_EVERY[1] - BEAT_EVERY[0]);
    if (this._beatBusy === n) this._beatBusy = null;
  }

  // ------------------------------------------------------------- companion

  /**
   * Heel at 2.5 m, idle when the player idles, step out of his shadow when he
   * gets too far ahead. Returns whether the companion is moving (the shared
   * tail animates from that).
   *
   * He does NOT go indoors: interiors have a 2 m door gap sized for one body
   * with thumb-steering slack, and a second body in it turns walking into a
   * shop into a wrestling match. Parked at the door reads as waiting, which is
   * what a bound shadow should look like anyway.
   */
  _updateCompanion(n, dt, playerPos) {
    const city = this.city;
    // creatures.setCreatureQuality writes castShadow over every live instance
    // on a tier change and does not honour shadowPinned the way characters.js
    // does, so the decision is re-asserted here. Two boolean stores; the
    // alternative is a skinned depth program compiled at an arbitrary frame.
    if (n.inst?.meshes) for (const m of n.inst.meshes) m.castShadow = false;
    else if (n.inst?.mesh) n.inst.mesh.castShadow = false;

    if (this._wisps) {
      this._wisps.rotation.y += dt * 0.55;
      this._wisps.position.y = Math.sin(this._t * 1.3) * 0.045;
    }

    if (!playerPos) return false;

    // Is the player indoors? Park at that building's doorstep instead.
    const inside = city.interiors?.insideId
      ? city.interiors.byId?.get(city.interiors.insideId)
      : null;
    let ax = playerPos.x, az = playerPos.z;
    if (inside?.door) {
      // A stride BEYOND the door pad, not on it: he stops COMP_STOP short of
      // whatever he is aiming at, and aiming at the pad itself let that slack
      // land him in the front room. Measured — the first version parked him
      // 1.4 m from the pad and inside the tavern footprint.
      ax = inside.door.outX + inside.door.nx * 1.5;
      az = inside.door.outZ + inside.door.nz * 1.5;
      // And if he is already indoors (the >25 m teleport can drop him next to a
      // player who walked in), put him out. This runs only while the player is
      // actually inside one of the five.
      const at = city.interiors.buildingAt(n.pos);
      if (at && at.id === inside.id) {
        n.pos.x = ax; n.pos.z = az;
        city.resolve(n.pos, WALK_RADIUS);
        n.pos.y = city.heightAt(n.pos.x, n.pos.z);
      }
    }

    // Player idle detection: his own movement, not his input, so this works
    // for every control scheme including the desktop keyboard path.
    const moved = Math.hypot(playerPos.x - n.lastPx, playerPos.z - n.lastPz);
    n.lastPx = playerPos.x; n.lastPz = playerPos.z;
    n.idleT = moved < 0.02 ? n.idleT + dt : 0;

    const dx = ax - n.pos.x;
    const dz = az - n.pos.z;
    const d = Math.hypot(dx, dz);

    // Lost him. Step out of his shadow rather than jogging across the town —
    // teleport BEHIND, never in front, so he never materialises in view.
    if (d > COMP_TELEPORT) {
      const len = d || 1;
      n.pos.x = ax - (dx / len) * COMP_HEEL;
      n.pos.z = az - (dz / len) * COMP_HEEL;
      city.resolve(n.pos, WALK_RADIUS);
      n.pos.y = city.heightAt(n.pos.x, n.pos.z);
      return false;
    }

    const heel = inside ? COMP_STOP : COMP_HEEL;
    if (d > heel) {
      const want = Math.atan2(dx, dz);
      let diff = want - n.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      n.yaw += Math.max(-TURN_RATE * 1.6 * dt, Math.min(TURN_RATE * 1.6 * dt, diff));
      // Ease off as he closes so he settles instead of oscillating on the spot,
      // and open up as the gap grows so he can actually catch a running player.
      const k = Math.min(1, (d - heel) / 1.5);
      const ramp = Math.min(1, (d - heel) / COMP_SPEED_RAMP);
      n.speed = COMP_SPEED_NEAR + (COMP_SPEED_FAR - COMP_SPEED_NEAR) * ramp;
      const step = n.speed * k * dt;
      n.pos.x += Math.sin(n.yaw) * step;
      n.pos.z += Math.cos(n.yaw) * step;
      city.resolve(n.pos, WALK_RADIUS);
      n.state = WALK;
      return k > 0.05;
    }

    // At heel. Face the way the player faces once he has been still a while,
    // otherwise keep looking at him.
    if (n.idleT < COMP_IDLE_AFTER) n.yaw = Math.atan2(dx, dz);
    n.state = IDLE;
    return false;
  }

  _setState(n, state, dur) {
    if (state === WAVE) {
      // Wave is a skinned-clip luxury; the box villager just stands. clamp
      // holds the final frame — an unclamped LoopOnce action disables itself
      // when it finishes and the skeleton snaps to bind pose for a beat.
      if (n.inst && n.inst.play('wave', { once: true, clamp: true })) {
        n.state = WAVE;
        n.stateT = Math.max(0.9, n.inst.clipDuration('wave'));
        return;
      }
      state = IDLE;
    }
    n.state = state;
    n.stateT = dur;
    if (state === IDLE && n.inst) n.inst.play('idle', { fade: 0.2 });
  }

  _newTarget(n) {
    if (n.station) {
      // A disc around the post, sqrt-weighted so the samples are area-uniform
      // rather than piling on the centre. No street network out here and no
      // anchors: the camp IS the anchor.
      const a = this._rnd() * 6.283;
      const r = Math.sqrt(this._rnd()) * CAMP_RADIUS;
      n.tx = n.station.x + Math.cos(a) * r;
      n.tz = n.station.z + Math.sin(a) * r;
      n.state = WALK;
      n.stateT = 0;
      return;
    }
    const w = this._pickPoint(n.hunter, this._rnd, n.pos, _wp, n.phaseOff);
    n.tx = w.x; n.tz = w.z;
    n.state = WALK;
    n.stateT = 0;
  }

  /** The whole procedural gait: swing limbs, bob a little. */
  _animateVillager(n, t, moving) {
    const rig = n.rig;
    if (!rig) return;
    if (moving) {
      const cyc = (t + n.phase) * 5.2;
      const s = Math.sin(cyc) * 0.55;
      rig.legL.rotation.x = s;
      rig.legR.rotation.x = -s;
      rig.armL.rotation.x = -s * 0.7;
      rig.armR.rotation.x = s * 0.7;
      rig.body.position.y = Math.abs(Math.sin(cyc)) * 0.035;
    } else {
      const idle = Math.sin((t + n.phase) * 1.6);
      rig.legL.rotation.x *= 0.8;
      rig.legR.rotation.x *= 0.8;
      rig.armL.rotation.x = idle * 0.06 - 0.03;
      rig.armR.rotation.x = -idle * 0.06 - 0.03;
      rig.body.position.y = idle * 0.02;
    }
  }

  // ----------------------------------------------------------- talk (C-TALK)

  /**
   * The nearest hunter the player could strike up a word with, or null.
   * Returns { npc, camp } — `camp` (a stationed Verge body) is what citymode
   * maps to the Maren persona; a street hunter gets the ambient pool.
   *
   * This lives HERE and not in citymode because the eligibility rules are all
   * npc-record internals this class owns:
   *   - hunters only: civilians are set dressing; the hunters are the half of
   *     the crowd that sells what the town is, and the bible gives them the
   *     argot ("assay it", "the walk home").
   *   - never the companion: a bound shadow does not stop for a chat — the
   *     same line the social beat draws.
   *   - never mid-portal-beat: a hunter walking to a dais has somewhere to be,
   *     and BEAT_FADE/BEAT_GONE bodies are half-vanished or absent entirely.
   *   - root.visible only: the night de-pop and the frustum thinning both hide
   *     via visibility, and a talk prompt at an empty patch of street is the
   *     prompt system lying.
   * Pure read, no allocation beyond the one result object, no stream draws —
   * offering a chat must never perturb the seeded crowd sim.
   */
  nearestTalker(pos, radius) {
    let best = null, bestD2 = radius * radius;
    for (const n of this.npcs) {
      if (!n.hunter || n.companion) continue;
      if (n.beat !== BEAT_NONE) continue;
      if (!n.root.visible) continue;
      const dx = pos.x - n.pos.x, dz = pos.z - n.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    return best ? { npc: best, camp: Boolean(best.station) } : null;
  }

  // --------------------------------------------------------------- teardown

  dispose() {
    for (const n of this.npcs) {
      // CharacterInstance.dispose releases the refcounted merged geometry and
      // the per-instance skeleton bone texture — the two leaks a plain
      // traversal cannot see.
      if (n.inst) n.inst.dispose();
      n.root.removeFromParent();
    }
    this.npcs.length = 0;
    this.campers.length = 0;
    this.companion = null;
    this._beatBusy = null;
    this._wisps = null;
    this._compMat = null;
    this._anchors = null;
    this._gates.length = 0;
    this.group.removeFromParent();
    for (const g of this._ownedGeometries) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedGeometries.length = 0;
    this._ownedMaterials.length = 0;
    this._procGeo = null;
    this._procMat = null;
  }

  get stats() {
    let skinned = 0, visible = 0, hidden = 0, away = 0;
    for (const n of this.npcs) {
      // The companion and the frontier campers are counted separately below,
      // for the same reason: `count` means THE TOWN CROWD and nothing else.
      if (n.companion || n.station) continue;
      if (n.inst) skinned++;
      if (n.beat === BEAT_GONE) away++;
      if (n.root.visible) visible++; else hidden++;
    }
    // `count` deliberately EXCLUDES the companion and the campers: it is the
    // crowd's size (8 at low, 16 otherwise) and folding conditional extra
    // bodies into it would make that number mean two different things.
    const count = this.npcs.length - (this.companion ? 1 : 0) - this.campers.length;
    let campSkinned = 0;
    for (const n of this.campers) if (n.inst) campSkinned++;
    return {
      count,
      skinned,
      procedural: count - skinned,
      visible,
      hidden,
      away,
      companion: Boolean(this.companion),
      // The frontier camps, so "are the camps populated" is a number a harness
      // can read rather than a screenshot someone has to look at.
      camp: this.campers.length,
      campSkinned,
      campPois: this.campers.reduce((acc, n) => {
        acc[n.poiId] = (acc[n.poiId] || 0) + 1;
        return acc;
      }, {}),
      phase: this.phaseHour == null ? null : phaseAt(this.phaseHour),
      hours: this.phaseHour,
    };
  }
}

const _wp = { x: 0, z: 0 };

// Module scratch. Every one of these exists so the per-frame paths above can
// stay allocation-free on a phone.
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
