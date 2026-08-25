import { mulberry32 } from '../core/rng.js';
import { rollWaveSize } from './config.js';
import { t } from './strings.js';

// The room-state director — DUNGEON_SPEC.json STEP 5.
//
// Gated free-roam ("threshold gates"): rooms trigger on entry, the ACTIVE
// room's doors seal during combat and reopen on clear, cleared and dormant
// rooms stay freely walkable so backtracking for pickups and Bind extractions
// works between fights. The boss chamber stays sealed until every combat room
// is CLEARED, and the run ends by WALKING INTO the exit portal the boss's
// death raises — not by an instant results screen (game.js EDIT 6 defers
// _clearGate to us when world.encounterDriven).
//
// The director owns NOTHING renderable: doors and the exit portal are Dungeon
// toggles (setDoorSealed / showExitPortal), enemies go through the game's own
// _spawnEnemy / _spawnBoss so spawned/killed counters — and therefore the HUD
// and the results rows — keep working unchanged.
//
// ZONE MODE (STEP 8, the C cavern) is the same machine minus the doors:
// cavern combat "rooms" are disc trigger zones with EMPTY doors lists, so the
// seal/unseal calls no-op, the pack aggroes in the open when the player steps
// into the disc, and nothing pens the fight in — kiting across the cavern is
// legal. Only the boss grotto keeps a door (its neck membrane), which the
// standard machinery seals at start, re-seals behind the player at the boss
// threshold, and drops on allCleared exactly like a crawl's boss chamber.
//
// ROUTE MODE (Wave E task E-A, the A-rank waste) is zone mode plus ORDER:
// layout.route lists the combat sites in clear sequence, only the next site
// (or, after allCleared, the boss site) may trigger — the deep-door gate for
// a world with no doors — the dungeon's compass beacon retargets on every
// clear, and each site sends part of its own budget ahead as a roaming pack
// on the leg between stops (_spawnRoamers; points precomputed by waste.js).
//
// THREE-free on purpose: positions travel as {x,z} ducks and the one Vector3
// this module needs is cloned off the game's own player position at bind time,
// so the state machine imports nothing renderer-shaped and stays Node-testable
// exactly like config.js / dungeonlayout.js.

export const ROOM_STATE = { DORMANT: 0, TRIGGERED: 1, COMBAT: 2, CLEARED: 3 };

// Trailing shadows get this long to cross the threshold before the doors slam.
const SEAL_GRACE = 0.5;
// COMBAT metering: initial wave min(waveSize, budget), then one spawn per
// interval as deaths open slots — concurrent never exceeds gate.waveSize.
const TRICKLE_INTERVAL = 1.1;
// A shadow stranded outside a sealed room teleports in after this long. Longer
// than SEAL_GRACE by design, so recovery can never fire during the grace
// window and ping-pong a soldier who was about to walk through (spec risk).
const SHADOW_TELEPORT_AFTER = 1.5;
// Exit portal: rise time before walk-in arms, and the walk-in trigger disc.
const PORTAL_RISE = 2.0;
const PORTAL_RADIUS = 1.6;
// A spawn point this close to the player is skipped when any other will do —
// nobody should materialise inside the player's swing arc.
const SPAWN_CLEARANCE = 2.5;
// BOSS CHAMBER ADDS. A 38 x 38 m chamber holding exactly one enemy was the
// emptiest room in the game and the reason dodging there meant nothing: there
// was only ever one thing to dodge, and 1444 m2 to do it in. config.js's
// `bossAdds` sizes the pack (see the arithmetic there); these two constants
// decide the RHYTHM of it.
//
// The boss gets the room to itself for the first beat — its entrance, the
// camera hold and the first exchange are the fight introducing itself, and a
// grunt walking in over the top of that is noise. After that a body arrives
// every BOSS_ADDS_INTERVAL while there is room under the live cap.
//
// FIXUP 1 RE-TIMED BOTH. At 6.0 s + 3.0 s the chamber held ONE body for the
// first six seconds and, at the corrected live caps (E 7, D 8), would not have
// reached its cap until 6 + 3 x 6 = 24 s — most of a boss fight spent in the
// emptiest room in the game, which is the defect config.js's bossAdds block
// exists to remove. The delay now covers the entrance and the boss's FIRST
// pattern only (_bossBrain's patternCd is 4.4-6.0 s cold), and the interval
// fills the floor inside the second:
//   E  4.0 + 1.2 x (7 - 1) = 11.2 s to a full 7-body floor
//   D  4.0 + 1.2 x (8 - 1) = 12.4 s
// One body per 1.2 s is still a trickle a player can answer — a single Ruin
// (4.2 s cooldown, 8 m arc) clears more than it delivers — so this is pressure,
// not attrition.
const BOSS_ADDS_DELAY = 4.0;
const BOSS_ADDS_INTERVAL = 1.2;

// Rank-appropriate enemy mixes. Weights over ENEMY_TYPES keys that already
// exist — the owner's "different E-rank gates have different enemies" is a
// weighting table, not new content. gateIndex 0 = E; D+ adds the heavier
// packs; C (the cavern, STEP 8) mixes in the lancer — the spec's "lancer at
// the fringe" — whose charge is what the stalagmite cover exists to break;
// B (the tower, Wave E) draws the HEAVY end of the roster outright — brutes,
// lancers and the howler support body — and drops the pure-E starter packs
// via maxGate, so an emberfall floor never deals a burrow of plain grunts.
// maxGate is absent-means-open (the save format's absent-means-default rule):
// only the three starter rows carry one, and every rank at or below C sees
// the exact pool it saw before this column existed — same rows, same order,
// same shuffle stream, same deals.
const PACK_TABLE = [
  { minGate: 0, maxGate: 2, name: 'burrow', mix: { grunt: 3, stalker: 2 } },
  { minGate: 0, maxGate: 2, name: 'nest', mix: { grunt: 2, caster: 1 } },
  { minGate: 0, maxGate: 2, name: 'hunt', mix: { stalker: 3, grunt: 1 } },
  { minGate: 1, name: 'vault', mix: { brute: 1, grunt: 2 } },
  { minGate: 1, name: 'ossuary', mix: { caster: 2, stalker: 1, grunt: 1 } },
  { minGate: 2, name: 'fringe', mix: { lancer: 2, stalker: 2, grunt: 1 } },
  { minGate: 2, name: 'deepglass', mix: { grunt: 2, caster: 1, lancer: 1 } },
  { minGate: 3, name: 'emberguard', mix: { brute: 2, lancer: 2, grunt: 1 } },
  { minGate: 3, name: 'cinderchoir', mix: { caster: 2, howler: 1, stalker: 2 } },
  { minGate: 3, name: 'pyreline', mix: { lancer: 2, brute: 1, howler: 1 } },
  // A (the waste, Wave E task E-A) widens the top of the deck: void-touched
  // hunt packs for camps fought in the open, where the caster line and the
  // lancer charge have real approach room. Additive rows — every rank at or
  // below B sees the exact pool, order, shuffle stream and deals it saw
  // before these existed (the maxGate/minGate filter is the whole change).
  { minGate: 4, name: 'rivenhunt', mix: { stalker: 2, caster: 2, lancer: 1 } },
  { minGate: 4, name: 'wastewalkers', mix: { brute: 2, howler: 1, grunt: 2 } },
];

/**
 * Roll per-room enemy-mix tables for a gate. Deterministic from `rnd` (the
 * director's forked stream), so a context-loss rebuild deals the same packs.
 * @param {object} gate  config.js GATES row
 * @param {function} rnd forked mulberry32 stream
 * @param {number} [count] how many room slots to deal (rooms.length; the
 *   default just over-deals — indexing by room id keeps every id covered)
 * @returns {Array<{name:string, mix:Object<string,number>}>}
 */
export function rollRoomPacks(gate, rnd, count = 16) {
  const gateIndex = ['E', 'D', 'C', 'B', 'A', 'S'].indexOf(gate.rank);
  const pool = PACK_TABLE.filter((p) => gateIndex >= p.minGate
    && gateIndex <= (p.maxGate ?? Infinity));
  const packs = [];
  if (!pool.length) return packs;
  // SHUFFLE BAG, not an independent roll per room. An independent roll deals
  // the same pack to adjacent rooms often enough to read as sameness — with
  // the 3-pack E pool that is one room in three — and now that a run is 4-5
  // BIG rooms instead of 6-7 small ones, every room that feels like a repeat
  // is a bigger fraction of the dungeon. The bag deals each pack once before
  // any repeats, and a reshuffle never immediately re-deals the pack that
  // closed the previous bag. Still a pure function of `rnd`, so the rebuild
  // after a context loss deals the identical hand.
  let bag = [];
  let last = null;
  for (let i = 0; i < count; i++) {
    if (!bag.length) {
      bag = pool.slice();
      for (let k = bag.length - 1; k > 0; k--) {   // Fisher-Yates, same stream
        const j = Math.floor(rnd() * (k + 1));
        const t = bag[k]; bag[k] = bag[j]; bag[j] = t;
      }
      // The bag is dealt from the end, so the seam repeat to dodge is the LAST
      // element matching what we just dealt.
      if (bag.length > 1 && bag[bag.length - 1] === last) {
        const t = bag[bag.length - 1];
        bag[bag.length - 1] = bag[bag.length - 2];
        bag[bag.length - 2] = t;
      }
    }
    last = bag.pop();
    packs.push(last);
  }
  return packs;
}

/** Weighted key pick from a pack mix. */
export function pickFromMix(mix, rnd) {
  let total = 0;
  for (const k in mix) total += mix[k];
  let roll = rnd() * total;
  let last = null;
  for (const k in mix) {
    last = k;
    roll -= mix[k];
    if (roll <= 0) return k;
  }
  return last;
}

export class EncounterDirector {
  constructor({ game, dungeon, gate, seed }) {
    this.g = game;
    this.dungeon = dungeon;
    this.gate = gate;
    // Forked stream, same constant family as the layout's own forks: pack
    // rolls can never reshuffle rooms, and the per-run seed reproduces the
    // same deal after a context-loss rebuild.
    this.rnd = mulberry32((seed ^ 0x1f123bb5) >>> 0);

    // LIVE CONCURRENCY, rolled per run from gate.waveBand off its own forked
    // stream (config.rollWaveSize). Written straight back onto the gate because
    // gate.waveSize is what every other consumer already reads — game.js's
    // arena _spawnWave, the HUD, tools/dungeon-test — and two fields that mean
    // the same thing is exactly how they drift apart. The roll's INPUT is
    // gate.waveBand, which nothing ever writes, so re-entering a gate rolls
    // from the band again rather than jittering an already-jittered number.
    this.waveSize = rollWaveSize(gate, seed);
    gate.waveSize = this.waveSize;

    // Boss-chamber pack. Sized in config.js; metered by _updateBossAdds.
    const adds = gate.bossAdds;
    this._adds = {
      live: Math.max(0, adds?.live | 0),
      total: Math.max(0, adds?.total | 0),
      spawned: 0,
      timer: BOSS_ADDS_DELAY,
    };

    const rooms = dungeon.layout.rooms;
    this.rooms = rooms;
    // Entry is safe ground by construction (the shadow escort deploys there);
    // everything else waits for the player's footfall.
    this.states = rooms.map((r) => (r.kind === 'entry' ? ROOM_STATE.CLEARED : ROOM_STATE.DORMANT));
    this.packs = rollRoomPacks(gate, this.rnd, rooms.length);

    this._phase = 'rooms'; // rooms | boss | exit | done
    this._active = -1;
    this._grace = 0;
    this._trickle = 0;
    this._budget = 0;
    this._roomSpawned = 0;
    this._spawnCursor = 0;
    this._bossSpawned = false;
    this._portalPos = null;
    this._portalT = 0;
    // The one Vector3 this module touches, cloned from the game's own vector
    // class — reused for every spawn/pickup call (they all copy internally).
    this._vec = game.player.pos.clone().set(0, 0, 0);

    // ROUTE MODE (Wave E task E-A, the waste). layout.route lists the combat
    // sites in clear order; a route-carrying world has no door membranes to
    // seal, so the deep-door machinery's SHAPE survives as ordering: only the
    // next site on the route may trigger, and the boss site only once
    // allCleared — the same gate, enforced at the trigger instead of at a
    // membrane box. _preSpawned tracks roam-pack bodies spawned against a
    // site's budget BEFORE the site activates, so the kill-metering totals
    // stay exact. Absent route (every other kind) = every path below is the
    // shipped behaviour, untouched.
    this._route = dungeon.layout.route || null;
    this._routeIdx = 0;
    this._preSpawned = new Map();
    this._roamPrimed = false;

    // COLLAPSING ARENA (Wave E task E-S, the S reach's summit). The layout
    // carries the phase radii + boss-hp thresholds as data
    // (layout.arenaPhases); dungeon.js pre-registered the ring barriers and
    // owns setArenaPhase; THIS is the consumer — the director watches boss hp
    // each boss-phase tick and seals rings as thresholds fall. The boss's own
    // BRAIN stays game.js's untouched: hp is an output we read, never an
    // input we steer. Absent arenaPhases (every other kind) = dead code.
    this._arenaPhases = dungeon.layout.arenaPhases || null;
    this._arenaPhase = 0;

    // The deep door opens on allCleared, not on arrival. (No-op for the
    // waste's door-less boss site — its gate is the route check above.)
    this._setRoomSealed(dungeon.layout.bossRoom, true);
    // Compass: the beacon opens pointing at the first site.
    if (this._route) this.dungeon.setWaypoint?.(this._route[0]);
  }

  get state() { return this._phase; }

  get activeRoom() { return this._active; }

  get roomStates() { return this.states; }

  get allCleared() {
    return this.rooms.every((r) => r.kind !== 'combat' || this.states[r.id] === ROOM_STATE.CLEARED);
  }

  update(dt) {
    const g = this.g;
    if (!g || this._phase === 'done') return;

    if (this._phase === 'exit') { this._updateExit(dt); return; }

    if (this._phase === 'boss') {
      // _killEnemy's boss branch skips _clearGate for encounter-driven worlds
      // (EDIT 6); the flip of bossActive is our death signal.
      if (this._bossSpawned && !g.bossActive) { this.onBossDeath(); return; }
      if (this._bossSpawned) {
        this._updateArenaPhases();
        this._updateBossAdds(dt);
      }
      return;
    }

    // --- rooms phase ------------------------------------------------------
    // Route mode: the FIRST leg's roaming pack rises on the director's first
    // live tick — the mode gates update() on the intro, so this is the moment
    // the player steps out of the tunnel, never a body spawned into the
    // authored walk-in shot. Sites 2+ get theirs on the previous clear.
    if (this._route && !this._roamPrimed) {
      this._roamPrimed = true;
      this._spawnRoamers(this.rooms[this._route[0]]);
    }
    if (this._active >= 0) { this._updateActiveRoom(dt); return; }

    const p = g.player.pos;
    const roomId = this.dungeon.roomAt(p.x, p.z);
    if (roomId < 0) return; // corridor / tunnel: nothing triggers
    const room = this.rooms[roomId];
    if (this.states[roomId] !== ROOM_STATE.DORMANT) return;

    if (room.kind === 'treasure') {
      // Treasure rooms pay out on discovery — no fight, no seal. floorY: the
      // tower's rooms sit at their floor's height (0 everywhere flat).
      this.states[roomId] = ROOM_STATE.CLEARED;
      this._vec.set(room.centre.x, room.floorY || 0, room.centre.z);
      g._spawnWeaponDrop(this._vec);
      g.fx.ring(this._vec, this._accent(), 4, 0.6);
      g.ui.toast('A CACHE IN THE DARK', 'gold');
      return;
    }
    if (room.kind === 'combat' || room.kind === 'boss') {
      // Boss room is only reachable here once allCleared dropped its seal.
      // Route mode has no seals, so the SAME two gates are enforced right
      // here: a combat site off the compass stays dormant under the player's
      // feet, and the boss site holds until every camp is down.
      if (this._route) {
        if (room.kind === 'combat' && roomId !== this._route[this._routeIdx]) return;
        if (room.kind === 'boss' && !this.allCleared) return;
      }
      this.states[roomId] = ROOM_STATE.TRIGGERED;
      this._active = roomId;
      this._grace = SEAL_GRACE;
    }
  }

  // -------------------------------------------------------------- combat

  _updateActiveRoom(dt) {
    const g = this.g;
    const d = this.dungeon;
    const roomId = this._active;
    const room = this.rooms[roomId];

    if (this.states[roomId] === ROOM_STATE.TRIGGERED) {
      // The player can step back out during the grace beat — stand down
      // instead of sealing them OUT of their own fight.
      if (d.roomAt(g.player.pos.x, g.player.pos.z) !== roomId) {
        this.states[roomId] = ROOM_STATE.DORMANT;
        this._active = -1;
        return;
      }
      this._grace -= dt;
      if (this._grace > 0) return;

      // Seal and engage.
      this._setRoomSealed(roomId, true);
      d.activeRoomId = roomId;
      this.states[roomId] = ROOM_STATE.COMBAT;
      g.audio.tone({ freq: 160, type: 'square', gain: 0.12, decay: 0.5, sweep: -60 });
      this._doorFlare(room);

      if (room.kind === 'boss') {
        // Threshold crossed, door sealed behind — the chamber owns the rest.
        // (Route mode: the compass stands down, the boss IS the marker now.)
        if (this._route) this.dungeon.setWaypoint?.(-1);
        g._spawnBoss();
        this._phase = 'boss';
        this._bossSpawned = true;
        this._active = -1;
        return;
      }

      this._budget = room.budget;
      // Roam-pack bodies already spawned against this site's budget count as
      // spawned (route mode; 0 everywhere else — the map is only ever written
      // by _spawnRoamers).
      this._roomSpawned = this._preSpawned.get(roomId) || 0;
      this._spawnCursor = Math.floor(this.rnd() * Math.max(1, room.spawnPoints.length));
      // Opening wave respects the LIVE cap, not just the budget: surviving
      // roamers that chased the player into their own camp already occupy
      // concurrency slots. In a crawl g.enemies is always empty at a trigger
      // (the previous room's doors do not reopen mid-fight), so `live` is 0
      // and this is the shipped arithmetic to the number.
      let live = 0;
      for (const e of g.enemies) if (!e.isBoss) live++;
      const first = Math.max(0, Math.min(this.waveSize - live, this._budget - this._roomSpawned));
      for (let i = 0; i < first; i++) this._spawnOne(room);
      this._trickle = TRICKLE_INTERVAL;
      return;
    }

    // COMBAT: meter the remainder, watch for the clear, rescue stray shadows.
    if (this._roomSpawned < this._budget) {
      this._trickle -= dt;
      if (this._trickle <= 0 && g.enemies.length < this.waveSize) {
        this._spawnOne(room);
        this._trickle = TRICKLE_INTERVAL;
      }
    } else if (g.enemies.length === 0) {
      // Only director spawns exist in a crawl, so an empty enemy list with the
      // budget exhausted IS the room clear.
      this._clearRoom(roomId);
      return;
    }

    // Stray-shadow rescue exists for SEALED rooms only: an ally locked out by
    // a membrane can never path back in. Cavern zones have no doors — nothing
    // separates a shadow standing one metre outside the trigger disc from the
    // fight, and blinking it every 1.5 s would strobe rings all run long.
    // ...and never when the PLAYER has left the sealed room through a
    // parapet gap (review fix, tower): teleporting shadows back INTO the
    // still-sealed room while the player fights below sealed them away from
    // exactly the fight they exist for. If the player is out, the rescue
    // waits — the room-clear unseal reunites everyone.
    const playerInRoom = d.roomAt(g.player.pos.x, g.player.pos.z) === roomId;
    if (room.doors.length && playerInRoom) {
      for (const s of g.shadows) {
        if (d.roomAt(s.pos.x, s.pos.z) === roomId) { s._outsideT = 0; continue; }
        s._outsideT = (s._outsideT || 0) + dt;
        if (s._outsideT >= SHADOW_TELEPORT_AFTER) {
          // Same trick as their gate-entry deploy: blink to a spawn point near
          // the player rather than grinding against a sealed membrane.
          s._outsideT = 0;
          const pt = this._nearestPoint(room, g.player.pos);
          s.pos.set(pt.x, pt.y || 0, pt.z);
          s.vel.set(0, 0, 0);
          s.mesh.position.copy(s.pos);
          g.fx.ring(s.pos, 0x35e6ff, 3, 0.5);
        }
      }
    }
  }

  _clearRoom(roomId) {
    const g = this.g;
    const room = this.rooms[roomId];
    this.states[roomId] = ROOM_STATE.CLEARED;
    this._setRoomSealed(roomId, false);
    this._active = -1;
    this._doorFlare(room);
    g.audio.tone({ freq: 520, type: 'triangle', gain: 0.12, decay: 0.4, sweep: 400 });

    // Clear payout: a breather's worth of orbs at the room's heart. Treasure
    // rooms pay a weapon on discovery instead (they never fight). floorY:
    // tower rooms sit at height, flat kinds at 0.
    const ry = room.floorY || 0;
    this._vec.set(room.centre.x - 0.8, ry, room.centre.z);
    g._spawnPickup(this._vec, 'hp');
    this._vec.set(room.centre.x + 0.8, ry, room.centre.z);
    g._spawnPickup(this._vec, 'mp');

    const bossRoom = this.rooms[this.dungeon.layout.bossRoom];
    // Route mode: advance the compass. Clearing site N unseals site N+1 —
    // the beacon retargets, and the next site's advance pack rises on the
    // leg between (the roaming-pack beat: bodies met in the open, spent from
    // the NEXT site's own budget so gate.enemies stays the exact total).
    if (this._route && this._route[this._routeIdx] === roomId) {
      this._routeIdx++;
      if (this._routeIdx < this._route.length) {
        const next = this.rooms[this._route[this._routeIdx]];
        this.dungeon.setWaypoint?.(next.id);
        this._spawnRoamers(next);
        g.ui.toast('THE COMPASS PULLS ONWARD', 'gold');
      }
    }
    if (this.allCleared) {
      this._setRoomSealed(bossRoom.id, false);
      this._doorFlare(bossRoom);
      if (this._route) {
        // No door to drop out here on the open waste — the compass turns to
        // the final site instead. Same machinery beat, reworded.
        this.dungeon.setWaypoint?.(bossRoom.id);
        g.ui.toast('THE COMPASS SEARS TOWARD THE HEART', 'gold');
      } else {
        g.ui.toast('THE DEEP DOOR UNSEALS', 'gold');
      }
      g.audio.nova();
    } else {
      // A combat room can open STRAIGHT into the boss chamber; the unseal
      // above just dropped that shared membrane. The boss gate outranks the
      // room clear — re-assert it until every combat room is down.
      this._setRoomSealed(bossRoom.id, true);
    }
  }

  /**
   * Rise `room.roam` of the site's budget on its precomputed roamPoints —
   * the leg between the just-cleared stop and this one (waste.js owns the
   * WHERE; both are pure functions of the seed). Capped by the live wave so
   * a pack met in the open never exceeds what a camp fight peaks at; bodies
   * that do not fit under the cap simply stay in the site's own metering.
   */
  _spawnRoamers(room) {
    const pts = room.roamPoints;
    const want = Math.min(room.roam || 0, pts?.length || 0);
    if (!want) return;
    const g = this.g;
    let live = 0;
    for (const e of g.enemies) if (!e.isBoss) live++;
    let spawned = this._preSpawned.get(room.id) || 0;
    for (let i = 0; i < want; i++) {
      if (live >= this.waveSize || spawned >= room.budget) break;
      this._spawnOne(room, pts[i]);
      live++;
      spawned++;
    }
    this._preSpawned.set(room.id, spawned);
  }

  _spawnOne(room, forcePt = null) {
    const pts = room.spawnPoints;
    const pack = this.packs[room.id % this.packs.length];
    const key = pack ? pickFromMix(pack.mix, this.rnd) : null;
    // forcePt: a roam-pack rise on the open route (waste) — the point came
    // from the layout's roamPoints, already floor-guaranteed and cover-clear.
    let pt = forcePt || room.centre;
    if (!forcePt && pts.length) {
      // Collapsed-arena guard (reach summit): a boss add must never rise in
      // a band the edge already swallowed. Live radius minus a body's width;
      // any point passes when no phase has collapsed (or no phases exist).
      const ph = this._arenaPhases;
      const collapsed = ph && this._arenaPhase > 0
        && room.id === this.dungeon.layout.bossRoom;
      const liveR = collapsed
        ? ph.radii[Math.min(this._arenaPhase, ph.radii.length - 1)] - 1.0 : Infinity;
      const inArena = (p) => !collapsed
        || Math.hypot(p.x - ph.cx, p.z - ph.cz) <= liveR;
      // Walk the ring from the cursor; take the first point clear of the
      // player, falling back to the farthest so a tiny room still spawns.
      let best = null;
      let bestD = -1;
      const px = this.g.player.pos.x;
      const pz = this.g.player.pos.z;
      for (let i = 0; i < pts.length; i++) {
        const cand = pts[(this._spawnCursor + i) % pts.length];
        if (!inArena(cand)) continue;
        const dd = Math.hypot(cand.x - px, cand.z - pz);
        if (dd >= SPAWN_CLEARANCE) { best = cand; this._spawnCursor += i + 1; break; }
        if (dd > bestD) { bestD = dd; best = cand; }
      }
      pt = best || pts[0];
      // Collapsed-summit clamp (review fix): when EVERY candidate sat in a
      // collapsed band, the raw pts[0] fallback could rise an add outside
      // the sealed barrier — unengageable both ways. Project the fallback
      // onto the live radius instead, the same pull _updateArenaPhases uses.
      if (collapsed && !inArena(pt)) {
        const dx = pt.x - ph.cx, dz = pt.z - ph.cz;
        const dd = Math.hypot(dx, dz) || 1;
        pt = { x: ph.cx + (dx / dd) * (liveR - 0.2), y: pt.y, z: ph.cz + (dz / dd) * (liveR - 0.2) };
      }
    }
    // pt.y: tower spawn points carry their floor height; room.centre and the
    // flat kinds' points carry none, so this is 0 everywhere it always was.
    this._vec.set(pt.x, pt.y || (room.floorY || 0), pt.z);
    // pos AND key both supplied — game.js EDIT 2's contract. spawned++ and the
    // level roll stay the game's business.
    this.g._spawnEnemy(this._vec, key);
    this._roomSpawned++;
  }

  // ---------------------------------------------------------------- boss

  /**
   * Collapse the summit's edge as the boss falls (reach kind only). One ring
   * per threshold crossed: dungeon.setArenaPhase seals the barrier + flips
   * the veil/rim visuals, and every body caught outside the live edge is
   * pulled just inside it — the same teleport-recovery philosophy as the
   * stranded-shadow rescue, because a barrier that seals the PLAYER out of
   * the boss fight is a softlock, not a mechanic. The while-loop makes one
   * huge hit that crosses two thresholds collapse both rings in one tick.
   */
  _updateArenaPhases() {
    const ph = this._arenaPhases;
    if (!ph) return;
    const g = this.g;
    const boss = g.boss;
    if (!g.bossActive || !boss || !(boss.maxHp > 0)) return;
    const frac = boss.hp / boss.maxHp;
    while (this._arenaPhase < ph.thresholds.length
      && frac <= ph.thresholds[this._arenaPhase]) {
      this._arenaPhase++;
      this.dungeon.setArenaPhase?.(this._arenaPhase);
      const R = ph.radii[Math.min(this._arenaPhase, ph.radii.length - 1)];
      const pull = (ent) => {
        const dx = ent.pos.x - ph.cx;
        const dz = ent.pos.z - ph.cz;
        const d = Math.hypot(dx, dz);
        if (d <= R - 0.8) return;
        const s = (R - 1.2) / (d || 1);
        const nx = ph.cx + dx * s;
        const nz = ph.cz + dz * s;
        if (ent.body?.reset) ent.body.reset(nx, ent.pos.y, nz);
        ent.pos.x = nx;
        ent.pos.z = nz;
        ent.vel?.set?.(0, 0, 0);
        ent.mesh?.position?.copy?.(ent.pos);
        g.fx.ring(ent.pos, this._accent(), 2.5, 0.4);
      };
      pull(g.player);
      for (const s of g.shadows) pull(s);
      for (const e of g.enemies) pull(e);
      this._vec.set(ph.cx, ph.y || 0, ph.cz);
      g.fx.ring(this._vec, this._accent(), R, 0.9);
      g.fx.addShake?.(0.35);
      g.audio.noise?.({ gain: 0.2, decay: 0.5, filter: 300 });
      g.ui.toast(t('gate.arena.collapse'), 'gold');
    }
  }

  /**
   * Trickle the boss chamber's pack in while the boss is alive.
   *
   * Deliberately NOT a wave: the pool is spread across the whole fight one body
   * at a time, so the chamber is never empty and never a wall. Stops dead the
   * moment the boss does — onBossDeath flips the phase out of 'boss' before
   * this is reached again, so the exit walk is not a running fight.
   */
  _updateBossAdds(dt) {
    const a = this._adds;
    if (a.live <= 0 || a.spawned >= a.total) return;
    const g = this.g;
    // The chamber is sealed and this director is the only thing that spawns
    // into it, so every non-boss entry in g.enemies is one of ours.
    let live = 0;
    for (const e of g.enemies) if (!e.isBoss) live++;
    if (live >= a.live) return;
    a.timer -= dt;
    if (a.timer > 0) return;
    a.timer = BOSS_ADDS_INTERVAL;
    this._spawnOne(this.rooms[this.dungeon.layout.bossRoom]);
    a.spawned++;
    // Keep the run's own accounting honest. `killed` is scored against
    // gate.enemies by the HUD and by the results row, and an add outside that
    // total reads as "37 / 36 cleared". Incremented as each add actually
    // LANDS — never by the whole pool up front — so a boss that dies early
    // cannot leave the total holding bodies that were never made.
    this.gate.enemies++;
  }

  onBossDeath() {
    if (this._phase === 'exit' || this._phase === 'done') return;
    const g = this.g;
    const L = this.dungeon.layout;
    // The collapse settles with its maker: rings retract (barriers open,
    // veils clear), so the walk-out crosses the full disc — the exit anchor
    // sits 21 m off centre, outside every collapse ring by design.
    if (this._arenaPhases) {
      this._arenaPhase = 0;
      this.dungeon.setArenaPhase?.(0);
    }
    this.states[L.bossRoom] = ROOM_STATE.CLEARED;
    // Every membrane drops: the dungeon is beaten, the Bind window and the
    // drops play out at leisure, and the way home rises at the back wall.
    for (const door of L.doors) this.dungeon.setDoorSealed(door.id, false);
    // The compass stands down — the exit portal is the marker now.
    this.dungeon.setWaypoint?.(-1);
    this._portalPos = this.dungeon.showExitPortal();
    this._portalT = 0;
    this._phase = 'exit';
    g.ui.toast('THE WAY BACK OPENS', 'gold');
  }

  _updateExit(dt) {
    this._portalT += dt;
    // The walk-in only arms once the portal has fully risen — clearing the
    // gate mid-materialisation would read as a glitch, not a departure.
    if (this._portalT < PORTAL_RISE || !this._portalPos) return;
    const p = this.g.player.pos;
    const dx = p.x - this._portalPos.x;
    const dz = p.z - this._portalPos.z;
    if (dx * dx + dz * dz <= PORTAL_RADIUS * PORTAL_RADIUS) {
      this._phase = 'done';
      this.g._clearGate();
    }
  }

  // ------------------------------------------------------------- recovery

  /**
   * Context loss: world.build re-created the dungeon deterministically but
   * every membrane box reset to open and the portal mesh is gone. Re-stamp the
   * seals the run state implies. Live entities survive a context loss (only
   * GPU-side state dies), so no respawns are needed — in-room progress holds.
   */
  rebindAfterContextLoss() {
    const d = this.dungeon;
    const L = d?.layout;
    if (!L) return;
    if (this._phase === 'rooms') {
      if (!this.allCleared) this._setRoomSealed(L.bossRoom, true);
      if (this._active >= 0 && this.states[this._active] === ROOM_STATE.COMBAT) {
        this._setRoomSealed(this._active, true);
        d.activeRoomId = this._active;
      }
      // Route mode: the rebuilt beacon starts hidden — re-point it at the
      // stop the run state implies (next site, or the boss once allCleared).
      if (this._route) {
        d.setWaypoint?.(this.allCleared
          ? L.bossRoom
          : this._route[Math.min(this._routeIdx, this._route.length - 1)]);
      }
    } else if (this._phase === 'boss') {
      this._setRoomSealed(L.bossRoom, true);
      if (this._route) d.setWaypoint?.(-1);
      // The rebuild reset every collapse ring open; re-stamp the phase the
      // fight had reached (idempotent — see dungeon.setArenaPhase).
      if (this._arenaPhases) d.setArenaPhase?.(this._arenaPhase);
    } else if (this._phase === 'exit') {
      const pos = d.showExitPortal();
      if (pos) this._portalPos = pos;
      // onBossDeath reset _arenaPhase to 0 (the collapse settles with its
      // maker); re-stamping keeps the rebuilt rings open for the walk-out.
      if (this._arenaPhases) d.setArenaPhase?.(this._arenaPhase);
    }
  }

  dispose() {
    this.g = null;
    this.dungeon = null;
    this.rooms = null;
    this.packs = null;
    this._portalPos = null;
    this._phase = 'done';
  }

  // -------------------------------------------------------------- helpers

  _setRoomSealed(roomId, sealed) {
    const room = this.rooms[roomId];
    for (const doorId of room.doors) this.dungeon.setDoorSealed(doorId, sealed);
  }

  _doorFlare(room) {
    const L = this.dungeon.layout;
    for (const doorId of room.doors) {
      const door = L.doors[doorId];
      this._vec.set(door.x, door.y || 0, door.z);
      this.g.fx.ring(this._vec, this._accent(), 3, 0.5);
    }
  }

  _accent() {
    const a = this.dungeon.biome?.accent;
    return typeof a === 'number' ? a : 0xffc24b;
  }

  _nearestPoint(room, pos) {
    const pts = room.spawnPoints;
    if (!pts.length) return room.centre;
    let best = pts[0];
    let bestD = Infinity;
    for (const pt of pts) {
      const dd = Math.hypot(pt.x - pos.x, pt.z - pos.z);
      if (dd < bestD) { bestD = dd; best = pt; }
    }
    return best;
  }
}

export default EncounterDirector;
