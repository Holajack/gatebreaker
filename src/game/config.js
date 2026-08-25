// Balance tables and content definitions for EMBERGATE.
// Everything the designer would want to tune lives here.
//
// This file is deliberately THREE-free and side-effect free so the headless
// progression test can import it in Node. src/core/rng.js is THREE-free for
// exactly this reason, so the one roll that lives here (rollWaveSize) may
// import it without breaking that property.

import { mulberry32 } from '../core/rng.js';

export const RANKS = ['E', 'D', 'C', 'B', 'A', 'S'];

export const LEVEL_CAP = 100;

// 5 spendable points per level, PLUS an automatic +1 to every stat. The auto
// grant is what makes early levels read as the body changing rather than a
// number going up, so it is not optional flavour — progression.js maintains
// `save.autoStats` as the "levels gained" counter that feeds it.
export const POINTS_PER_LEVEL = 5;
export const AUTO_STAT_PER_LEVEL = 1;

// One daily objective, three points. Local-date keyed; the game never talks to
// a server so there is nothing else it could key on.
export const DAILY_CONTRACT_POINTS = 3;

// STREAKS (Wave F.4): each consecutive day the daily contract is fulfilled
// adds +1 stat point to its payout, capped here. The cap is +3 (day four and
// beyond pay 6 points total) because the daily is the ladder's METRONOME, not
// its engine — an uncapped streak would compound into the primary stat income
// and make one missed day a build-defining loss, which is how a retention
// mechanic turns into a resentment mechanic.
export const STREAK_BONUS_CAP = 3;

// THE WEEKLY HUNT (Wave F.4): the reward multiplier on xpForLevel(save.level).
// Same philosophy as quests.questXp (60% of the gap at the quest's band) but
// sized WEEKLY-large: 1.5x the current level's whole gap. At L60 that is
// ~25.7k XP — about a level and a half, which post-53 (where a level costs
// 15-30 S-runs of trash income) is a real rung on the ladder without being a
// week of progress in one grant. Scales off save.level so it can never go
// stale: the reward is always priced in the claimant's own gap.
export const WEEKLY_HUNT_XP_MULT = 1.5;

// --- Stats. Fixed key order: the UI, the save schema and the tests all rely
// on it, so never reorder this array. ---
export const STATS = [
  { key: 'str', name: 'STRENGTH',   desc: '+2.4 attack power, +0.6% attack speed' },
  { key: 'agi', name: 'AGILITY',    desc: '+0.09 move speed, +0.55% crit, +4ms dodge window' },
  { key: 'vit', name: 'VITALITY',   desc: '+11 max health, +0.18% damage reduction' },
  { key: 'int', name: 'INTELLECT',  desc: '+7 max mana, +0.45% cooldown cut, bigger shadow army' },
  { key: 'per', name: 'PERCEPTION', desc: '+1.2% damage floor, earlier enemy tells, +0.4% bind chance' },
];

// Per-point rates and their hard caps. Every derived number in derive() reads
// from here so a designer never has to hunt through formulas.
export const STAT_RATES = {
  str: { atk: 2.4, atkSpeed: 0.006, atkSpeedCap: 0.30 },
  // speedCap is the ceiling on the AGILITY BONUS, not on total speed. Every
  // other stat here is capped; speed was the one that was not, and once the
  // level-up grant went to 5 points + 1 auto it ran to 60 u/s at cap — ten
  // times base, far past what the camera and the walk cycle can carry.
  agi: { speed: 0.09, speedCap: 4.2, crit: 0.0055, critCap: 0.55, critDmg: 0.0035, dodgeWindowMs: 4, dodgeBaseMs: 110, dodgeCapMs: 260 },
  vit: { hp: 11, regen: 0.05, dr: 0.0018, drCap: 0.45 },
  int: { mp: 7, mpRegen: 0.16, cdr: 0.0045, cdrCap: 0.40, shadowDmg: 0.011 },
  per: { floor: 0.012, floorBase: 0.55, floorCap: 0.92, tellMs: 8, tellBaseMs: 120, tellCapMs: 520, extract: 0.004 },
};

// ENEMY COUNTS. `enemies` is the trash total for a run (the boss is extra),
// `waveSize` caps how many are ALIVE at once, and `bossAdds` is the boss
// chamber's own pack. The encounter director trickles replacements in as they
// die, so waveSize is what a fight FEELS like and `enemies` is how many waves
// the room costs.
//
// BOTH counts are ROLLED PER RUN off forked mulberry32 streams keyed on the run
// seed, and written back onto the gate before anything reads them:
// Dungeon.build rolls `enemies` from `enemyBand`, EncounterDirector rolls
// `waveSize` from `waveBand`. A context-loss rebuild (same seed) lands on the
// identical pair — never Math.random. The `enemies` / `waveSize` fields below
// are the NOMINAL values: they are what B+ use (the arena world has neither
// roll site) and what a headless caller with no seed sees.
//
// --- WHY waveSize MOVED --------------------------------------------------
// The first pass of this wave grew the rooms ~5.5x in area and left waveSize
// alone, on the theory that a bigger TOTAL buys more waves rather than a busier
// moment. Measured, that produced the opposite of the ask: a sealed 30 x 26 m
// room containing 3 live enemies — sparser AND longer at the same time.
// waveSize has to move with the rooms.
//
// The parity held here is bodies per metre of room WIDTH, not per square metre
// of floor, because enemies converge on the player: what a bigger room adds is
// approach distance in ONE dimension plus a longer wall of pressure, a linear
// term. Area parity is also literally unpayable — the old E room was 13 x 10 m
// = 130 m2 carrying waveSize 3 (2.31 live per 100 m2), and 2.31 x 720 m2 (the
// new mean E room, measured off live layouts) asks for 16.6 live in a room
// whose entire budget is 8.
//
//   anchor   old E room sqrt(130 m2) = 11.4 m wide holding 3 live
//            => 3 / 11.4 = 0.263 live bodies per metre of room width
//   E  new mean room 720 m2, sqrt = 26.8 m -> 0.263 x 26.8 = 7.05   -> 7
//   D  new mean room 830 m2, sqrt = 28.8 m, keeping D's 4/3 rank premium:
//            3 x (4/3) x (28.8 / 11.4) = 10.1                        -> 9
//   C  zone disc r 12 m = 452 m2, sqrt = 21.3 m, 2x rank premium:
//            3 x 2 x (21.3 / 11.4) = 11.2                            -> 11
//
// D is trimmed 10 -> 9 so its TOTAL stays under C's; the C cavern's zones are
// open floor with no walls to hold a pack, which is what its higher live count
// is paying for.
//
// TOTALS then follow from waveSize x waves-per-room x combat rooms, holding
// waves per room at ~1.15 — a room is now ONE real fight plus a short tail,
// not two and a half skirmishes of three:
//   E   7 x 1.15 x 4.5 rooms = 36  -> enemyBand [30, 42]
//   D   9 x 1.15 x 5.0 rooms = 52  -> enemyBand [44, 60]
//   C  11 x 1.15 x 4.5 zones = 57  -> enemyBand [48, 66]
//
// B/A/S keep their old waveSize on purpose. The arena disc did NOT change size
// this wave, so there is nothing to re-derive from; the resulting C-11 > B-7
// step is an artifact of the arena being a different (and much larger) space,
// not a typo. It gets revisited when the arena does.
//
// BOSS CHAMBERS get their own pack. The same width parity applied to the E
// chamber (38 x 38 m, sqrt = 38 m) asks for 0.263 x 38 = 10 bodies of pressure.
// The boss is scale 2.5 with a 1.5 m collision radius and room-crossing
// telegraphs — it holds the centre the way three trash bodies cannot, so it
// counts as 3, leaving 7. Only `live` of those stand at once, so open floor
// always outnumbers occupied floor and one dash (7.5 m) always breaks contact;
// the rest arrive from `total` as replacements across the fight. That is the
// difference between kiting and being swarmed.
//   E  38x38 = 1444 m2, sqrt 38 -> 10 - 3 = 7  -> live 7, total 16
//   D  42x42 = 1764 m2, sqrt 42 -> 11 - 3 = 8  -> live 8, total 18
//   C  grotto ~40 m across       -> 10 - 3 = 7, +1 live for its lancer packs
//                                              -> live 8, total 18
//
// --- WHY `live` MOVED (fixup 1) ------------------------------------------
// The first pass derived those 7/8/8 trash-equivalents and then shipped 4/5/6,
// which made the boss chamber the SPARSEST room in the dungeon by more than 2x
// — measured, E boss peak was boss + 4 = 5 bodies in 1444 m2 (289 m2 each)
// against an ordinary 780 m2 E room holding 6-8 (98-130 m2 each). The room the
// owner actually named ("especially for the boss room") was getting the
// weakest version of the wave's own lever. `live` now IS the derivation.
//
// The ceiling is a PERF invariant, not a taste call: bossAdds.live <=
// waveBand[1] - 1, so the chamber's peak body count never exceeds the peak an
// ordinary room of the same rank already sustains (skinned characters are the
// dominant frame cost — ~14k tris each — so one extra concurrent body is the
// whole delta, and here there is not even one).
//   E  boss + 7 = 8 bodies, waveBand hi 8   -> equal, no new peak
//   D  boss + 8 = 9,        waveBand hi 10  -> under
//   C  boss + 8 = 9,        waveBand hi 12  -> under
// TOTALS hold the room convention of ~2.3 waves for a boss fight (an ordinary
// room is 1.15): 7 x 2.3 = 16, 8 x 2.3 = 18. encounters.js owns the RHYTHM
// that gets the chamber to its cap — see BOSS_ADDS_DELAY / _INTERVAL there.
export const GATES = [
  {
    rank: 'E', name: 'THE WARREN', biome: 'warren',
    enemies: 36, enemyBand: [30, 42], waveSize: 7, waveBand: [6, 8],
    bossAdds: { live: 7, total: 16 },
    enemyLevel: 2, bossLevel: 6, arena: 46,
    boss: 'warden', reqLevel: 1,
    blurb: 'A shallow tear. Good place to learn which end of the blade cuts.',
  },
  {
    rank: 'D', name: 'THE OSSUARY', biome: 'ossuary',
    enemies: 52, enemyBand: [44, 60], waveSize: 9, waveBand: [8, 10],
    bossAdds: { live: 8, total: 18 },
    enemyLevel: 7, bossLevel: 12, arena: 52,
    boss: 'gravelord', reqLevel: 5,
    blurb: 'The dead here were buried standing up. They still are.',
  },
  {
    rank: 'C', name: 'DEEPGLASS CAVERN', biome: 'deepglass',
    enemies: 57, enemyBand: [48, 66], waveSize: 11, waveBand: [10, 12],
    bossAdds: { live: 8, total: 18 },
    enemyLevel: 14, bossLevel: 21, arena: 58,
    boss: 'frostcaller', reqLevel: 11,
    blurb: 'Cold enough that blood freezes before it finishes falling.',
  },
  {
    rank: 'B', name: 'EMBERFALL', biome: 'emberfall',
    enemies: 32, waveSize: 7, enemyLevel: 24, bossLevel: 33, arena: 64,
    boss: 'infernus', reqLevel: 19,
    blurb: 'Something enormous is sitting on a chair of molten iron.',
  },
  {
    rank: 'A', name: 'THE RIVEN WASTE', biome: 'rivenwaste',
    enemies: 38, waveSize: 8, enemyLevel: 37, bossLevel: 49, arena: 70,
    boss: 'weaver', reqLevel: 29,
    blurb: 'Geometry stops agreeing with itself past the threshold.',
  },
  {
    rank: 'S', name: 'ARCHON\'S REACH', biome: 'archonreach',
    enemies: 46, waveSize: 9, enemyLevel: 54, bossLevel: 70, arena: 76,
    boss: 'archon', reqLevel: 42,
    blurb: 'No hunter has walked back out. The record is unbroken.',
  },
];

/**
 * Roll this run's live-enemy cap from the gate's `waveBand`.
 *
 * Mirrors dungeon.js's rollEnemyCount exactly — same shape, same fallback
 * discipline, its own forked constant — because the two numbers must be able to
 * move independently: retuning how CROWDED a fight is may never reshuffle how
 * LONG a run is, and vice versa. Pure and THREE-free so the headless suites can
 * exercise it.
 *
 * @param {object} gate  a GATES row (or the per-run shallow copy of one)
 * @param {number} seed  per-run gate seed
 * @returns {number}     live cap; gate.waveSize when the gate carries no band
 */
export function rollWaveSize(gate, seed) {
  const band = gate?.waveBand;
  if (!Array.isArray(band) || band.length !== 2) return gate?.waveSize ?? 3;
  const lo = Math.min(band[0], band[1]) | 0;
  const hi = Math.max(band[0], band[1]) | 0;
  if (!(hi >= lo) || lo < 1) return gate.waveSize;
  // Fork constant: murmur3's finaliser, chosen because it collides with none of
  // the streams already in use — 0x9e3779b9 / 0x5f356495 / 0x1f123bb5 (layout,
  // decor, encounter), 0x85ebca6b / 0x27d4eb2f (dungeon shell/props) and
  // 0x632be59b (rollEnemyCount).
  const rnd = mulberry32((seed ^ 0xc2b2ae35) >>> 0);
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

// Chance a B+ gate rolls an off-canon "anomaly" biome instead of its own.
export const ANOMALY_CHANCE = { E: 0, D: 0, C: 0, B: 0.14, A: 0.20, S: 0.26 };

// Palettes. Keyed by the new biome ids; the pre-rename keys are kept as
// aliases below because world.js looks these up by gate.biome at runtime and
// a stale save or an in-flight branch must not hand it `undefined`.
export const BIOMES = {
  warren:      { fog: 0x0a0d1c, ground: 0x1a1f38, accent: 0x7c5cff, sky: 0x05060d, pillar: 0x2a3050, detail: 0x3a4468 },
  ossuary:     { fog: 0x140f14, ground: 0x2a2028, accent: 0xc2703a, sky: 0x0b0709, pillar: 0x3d2f36, detail: 0x5a4238 },
  deepglass:   { fog: 0x0b1a26, ground: 0x1d3a4d, accent: 0x66e0ff, sky: 0x061219, pillar: 0x2d5570, detail: 0x8ff0ff },
  emberfall:   { fog: 0x1c0a06, ground: 0x36150d, accent: 0xff6b2b, sky: 0x120503, pillar: 0x4d1f12, detail: 0xffb067 },
  rivenwaste:  { fog: 0x0d0618, ground: 0x1c1030, accent: 0xb14bff, sky: 0x070312, pillar: 0x2c1a4a, detail: 0xd08aff },
  archonreach: { fog: 0x18050f, ground: 0x2e0a1c, accent: 0xff2d6b, sky: 0x0e0208, pillar: 0x45102a, detail: 0xff7a9e },
};
// Legacy ids from the pre-rename table, so an old gate record still resolves.
BIOMES.hollow = BIOMES.warren;
BIOMES.catacomb = BIOMES.ossuary;
BIOMES.glacier = BIOMES.deepglass;
BIOMES.ember = BIOMES.emberfall;
BIOMES.void = BIOMES.rivenwaste;

// --- Enemy archetypes. `s` values are multipliers scaled by enemy level. ---
//
// attackCd (Wave D stage 2): still the archetype's mean attack CYCLE, but the
// cycle is now COMPOSED rather than counted down blind — game.js charges
// `pattern windup + pattern recovery + attacks.js ENEMY_RHYTHM.gcd roll`, and
// the gcd bands are derived from THESE numbers (the derivation is written out
// at ENEMY_RHYTHM). So this column remains the one designers tune — it is
// also still read directly by the shadow-aggro bite and the PUNISH-cancel
// penalty — but retuning it now means moving the paired gcd band too, and
// weapons.js's combo-recovery note ("a whiffed greataxe finisher costs one
// free enemy attack") keys off it as before.
export const ENEMY_TYPES = {
  grunt: {
    name: 'Rift Grunt', hp: 34, atk: 5, speed: 3.4, range: 1.9, attackCd: 1.5,
    xp: 12, scale: 1, color: 0x4d5a80, glow: 0x9db4ff, ai: 'chase',
  },
  stalker: {
    // attackCd 1.2 → 1.55 (stage 2): the flurry pattern lands 3 folded
    // applications (1.26x atk per cycle) where the old single swing landed
    // 1.0x — the cycle stretches so the archetype's ~0.71 atk/s pressure
    // holds. The ENEMY_RHYTHM.stalker.gcd band carries the other half.
    name: 'Stalker', hp: 26, atk: 6.5, speed: 5.3, range: 1.8, attackCd: 1.55,
    xp: 16, scale: 0.88, color: 0x8b3fa8, glow: 0xe07aff, ai: 'lunge',
  },
  brute: {
    name: 'Brute', hp: 78, atk: 11, speed: 2.3, range: 2.6, attackCd: 2.2,
    xp: 26, scale: 1.45, color: 0x8a5a3a, glow: 0xffa063, ai: 'chase',
  },
  caster: {
    name: 'Hexcaster', hp: 30, atk: 8, speed: 2.6, range: 15, attackCd: 2.6,
    xp: 24, scale: 0.95, color: 0x2f7d8c, glow: 0x5ff0ff, ai: 'ranged',
  },
  // B+ archetypes. The lancer punishes standing still, the howler punishes
  // ignoring target priority — both only appear once the player has a dodge
  // window worth using.
  lancer: {
    name: 'Riftlancer', hp: 52, atk: 19, speed: 4.6, range: 3.2, attackCd: 3.0,
    xp: 34, scale: 1.1, color: 0x3a4d8a, glow: 0x8ad0ff, ai: 'charge',
  },
  howler: {
    name: 'Howler', hp: 64, atk: 7, speed: 3.0, range: 12, attackCd: 4.0,
    xp: 40, scale: 1.15, color: 0x6a2f5a, glow: 0xff7ad0, ai: 'support',
    // Hit-reaction profile (Wave D stage 3): attacks.js POISE is keyed by the
    // four core silhouettes plus boss; rows whose key has no profile of its
    // own name the silhouette they react as. The howler is a light leaping
    // body — it takes knockback like a stalker (mass 0.62: player blows
    // genuinely move it), not like the default grunt. The lancer deliberately
    // carries NO row: poiseProfile's grunt fallback (mass 1.00) is right for
    // an armoured mid-weight, and an absent field meaning "grunt" is the same
    // absent-means-default rule the save format uses.
    poise: 'stalker',
  },
};

export const BOSSES = {
  warden:     { name: 'HOLLOW WARDEN',   hp: 460,   atk: 18, speed: 3.0, scale: 2.5, color: 0x4a5480, glow: 0x9db4ff, xp: 220 },
  gravelord:  { name: 'THE GRAVELORD',   hp: 900,   atk: 26, speed: 3.2, scale: 2.7, color: 0x6d4a3a, glow: 0xffa063, xp: 480 },
  frostcaller:{ name: 'FROSTCALLER',     hp: 1650,  atk: 36, speed: 3.4, scale: 2.6, color: 0x2f6d8c, glow: 0x8ff0ff, xp: 900 },
  infernus:   { name: 'INFERNUS',        hp: 2900,  atk: 52, speed: 3.6, scale: 2.9, color: 0x8a2f14, glow: 0xff8340, xp: 1700 },
  weaver:     { name: 'THE VOIDWEAVER',  hp: 5200,  atk: 74, speed: 3.8, scale: 3.0, color: 0x5a2a8c, glow: 0xd08aff, xp: 3200 },
  archon:     { name: 'THE RIFT ARCHON', hp: 9800,  atk: 104, speed: 4.0, scale: 3.4, color: 0x8c1440, glow: 0xff5c8a, xp: 6800 },
};

// THE TELL PALETTE (Wave D stage 1: attacks.js's danger-colour vocabulary
// adopted as the game's ONE fairness language). Exactly two colours, named
// here and nowhere else, so every telegraph in the game answers the same
// question at a glance:
//   TELL_DANGER_COLOR (red)  — unavoidable-if-you-stand-there: the shape IS
//     the damage and it commits (the boss slam's radial ring, the charge
//     lane). The only answer is to not be inside it at contact.
//   TELL_WARN_COLOR (amber)  — dodgeable pressure: melee swing cones, caster
//     bolts, the spread fan. One step out of the shape is a full answer.
// The values are attacks.js's DANGER_COLOR / WARN_COLOR verbatim, so when the
// staged adoption reaches its per-archetype pattern rosters (heavy => red)
// the palette is already the shipped one. Consumers import these names —
// an inline 0xff4d6d anywhere else is palette drift, the exact disease the
// rank-colour table above exists to cure.
export const TELL_DANGER_COLOR = 0xff4d6d;
export const TELL_WARN_COLOR = 0xffc24b;

// THE BOLT PLANE. Every projectile in the game — trash caster bolts and boss
// spread shots alike — flies in ONE horizontal plane at this height, and this
// is the single constant that says so.
//
// It lives here, in the THREE-free balance table, because THREE consumers need
// the same number and drifted apart the moment they each kept their own copy:
//   game.js  _spawnProjectile flattens the direction (`.setY(0)`), so a bolt
//            never changes height after it is born; the player hit test is a
//            1.1 m sphere centred at y 1.2. |1.6 - 1.2| = 0.4 m leaves 0.7 m of
//            lateral radius to hit with. The boss used to spawn its spread shot
//            at 2.4: 2.4 - 1.2 = 1.20 > 1.1, so the whole pattern MISSED at
//            every range, measured 10/10 trials at 4-14 m, E and D, normal and
//            enraged. A flat-flying bolt must be born on the plane it can hit
//            from, so _spawnProjectile now stamps this height itself.
//   game.js  _agentLosBlocked probes obstacleField.lineBlocked at this feetY,
//            so a caster's decision to fire is judged at the height its bolt
//            actually travels.
//   dungeonlayout.js  COVER_KINDS is designed against it: a piece is only cover
//            if its collision `top` clears this plane (COVER_MIN_TOP there).
//            rubble's top is 1.75 — it clears 1.6 by 0.15 m but does NOT clear
//            2.4, which is why the old boss height would have flown over a
//            third of the boss chamber's cover even after the hit test was
//            fixed.
// 1.6 (not 1.2) because that is where the trash caster already fired from and
// it reads as chest height on a 1.8 m body; every COVER_KINDS top clears it.
export const PROJECTILE_Y = 1.6;

// --- Skills ---
// summon has no maxShadows any more: how many shadows exist and how many stand
// on the field are both progression.js's call now.
export const SKILLS = {
  attack: { name: 'Strike',  cd: 0.40, mp: 0,  dmg: 1.00, unlockLevel: 1 },
  dash:   { name: 'Dash',    cd: 1.60, mp: 0,  dmg: 0,    unlockLevel: 1, iframes: 0.34, distance: 7.5 },
  slash:  { name: 'Ruin',    cd: 4.20, mp: 12, dmg: 2.30, unlockLevel: 3,  range: 8.0, arc: Math.PI * 0.75 },
  nova:   { name: 'Nova',    cd: 8.50, mp: 26, dmg: 3.40, unlockLevel: 7,  radius: 9.0 },
  summon: { name: 'Bind',    cd: 13.0, mp: 0,  dmg: 0,    unlockLevel: 12 },
};

// --- Shadow grades. Original naming built from the game's own "Cinderbound"
// lexicon. shadows.js re-exports this as GRADES. ---
export const SHADOW_GRADES = [
  { name: 'CINDER',      mul: 0.55, maxCount: Infinity },
  { name: 'THRALL',      mul: 0.75, maxCount: Infinity },
  { name: 'SOLDIER',     mul: 1.00, maxCount: Infinity },
  { name: 'VANGUARD',    mul: 1.35, maxCount: 24 },
  { name: 'CHAMPION',    mul: 1.80, maxCount: 8 },
  { name: 'WARLORD',     mul: 2.50, maxCount: 3 },
  { name: 'ASHEN FIRST', mul: 4.00, maxCount: 1 },
];

// XP required to go FROM `level` to the next one. Sub-exponential on purpose:
// the exponential *feel* of the genre comes from enemy rank tiering, not from
// the player curve, and an exponential curve here makes L60-100 unplayable.
export function xpForLevel(level) {
  return Math.floor(52 * Math.pow(level, 1.42));
}

// Derived player numbers from base + allocated + auto-granted stats.
//
// `armor` is the armour layer's contribution — armorDerive()'s return value —
// passed in by game.refreshDerived (RPG_SPEC step 11) so this stays the ONE
// place every derived number is computed. It is a plain object, never an
// import: armor.js imports weapons.js which imports this file, so taking the
// numbers as an argument is what keeps the module graph acyclic.
//
// THE NAKED CONTRACT: with no armour worn (or armor === null) every value the
// shipped derive() returned is BYTE-identical — each fold below is `+ 0`,
// `* 1`, or a min() against an unchanged operand, all of which are exact in
// IEEE754 for the non-negative finite values these formulas produce. The
// armour-only outputs (armorDR / staggerResist / knockTakenMul / dashCd) are
// NEW keys with honest naked defaults; they change no existing number.
export function derive(save, armor = null) {
  // The +1-per-level auto grant applies to every stat, so it is added here
  // rather than being written into save.stats (which stays "what you spent").
  const auto = save.autoStats || 0;
  const s = save.stats || {};
  const str = (s.str || 0) + auto;
  const agi = (s.agi || 0) + auto;
  const vit = (s.vit || 0) + auto;
  const intel = (s.int || 0) + auto;
  const per = (s.per || 0) + auto;
  const lv = save.level;
  const R = STAT_RATES;
  const A = armor;
  return {
    // Chest secondary (+9 hp per tier) and the Vital affix arrive pre-summed
    // in hpAdd; the floor happens after the add so a fractional Vital roll
    // still counts.
    maxHp: Math.floor(130 + vit * R.vit.hp + (lv - 1) * 9 + (A ? A.hpAdd : 0)),
    maxMp: Math.floor(50 + intel * R.int.mp + (lv - 1) * 3),
    atk: 13 + str * R.str.atk + (lv - 1) * 1.6,
    // Smooth approach to the cap rather than a hard clamp, so a point of
    // agility is never worthless — it just buys less speed and more dodge
    // window the further in you go. Armour speed rides OUTSIDE the agility
    // curve: it was already clamped to its own +0.6 budget (ARMOR_SPEED_CAP)
    // inside armorDerive, so agility's asymptote stays agility's.
    speed: 6.0 + R.agi.speedCap * (1 - Math.exp(-agi * R.agi.speed / R.agi.speedCap)) + (A ? A.speedAdd : 0),
    crit: Math.min(R.agi.critCap, 0.05 + agi * R.agi.crit),
    critDmg: 1.5 + agi * R.agi.critDmg + (A ? A.critDmgAdd : 0),
    // Armour attack speed (hands secondary, Deft, emberfall 2pc) folds into
    // the EXISTING 0.30 cap — it does not get its own budget (spec guardrail).
    atkSpeed: Math.min(R.str.atkSpeedCap, str * R.str.atkSpeed + (A ? A.atkSpeedAdd : 0)),
    skillMul: 1 + intel * 0.025,
    cdr: Math.min(R.int.cdrCap, intel * R.int.cdr),
    // Vitality only. The armour slab is deliberately a SEPARATE term
    // (armorDR below): the two stack multiplicatively in _damagePlayer via
    // combinedDR, and folding them into one number here would hide which
    // layer a point of reduction came from on the panel.
    dr: Math.min(R.vit.drCap, vit * R.vit.dr),
    hpRegen: 0.6 + vit * R.vit.regen,
    mpRegen: 2.2 + intel * R.int.mpRegen + (A ? A.mpRegenAdd : 0),
    // Perception compresses the low end of the damage roll upward instead of
    // raising the ceiling — nothing else in the game does this.
    dmgFloor: Math.min(R.per.floorCap, R.per.floorBase + per * R.per.floor),
    // Head secondary tellAdd is on top of perception's, same 520 ms ceiling.
    tellLeadMs: Math.min(R.per.tellCapMs, R.per.tellBaseMs + per * R.per.tellMs + (A ? A.tellAdd : 0)),
    // Agility is felt in the hands, not read on a panel: it widens the window
    // in which a dodge counts as perfect. Seconds, because the sim runs in dt.
    // Legs secondary and the deepglass 4pc (dodgeAdd, in seconds) join agility
    // INSIDE the existing dodgeCapMs 260 clamp, per the spec.
    dodgeWindow: Math.min(R.agi.dodgeCapMs, R.agi.dodgeBaseMs + agi * R.agi.dodgeWindowMs + (A ? A.dodgeAdd * 1000 : 0)) / 1000,
    // The armour part (vigil 2pc) multiplies so x1 is exact when naked.
    shadowDmgMul: (1 + intel * R.int.shadowDmg) * (A ? A.shadowDmgMul : 1),
    // ---- armour-layer outputs (new keys; naked defaults are the no-op) ----
    // The slab: AP curve x set multipliers, computed in armorDerive. 0 naked.
    armorDR: A ? A.armorDR : 0,
    // Feet secondary + Rooted + ossuary 4pc, clamped 0.60 in armorDerive.
    // Scales DOWN the player's hurt flinch — the player's stagger term.
    staggerResist: A ? A.staggerResist : 0,
    // Knockback-distance multiplier (feet cut clamped 0.50, then ossuary 4pc).
    knockTakenMul: A ? A.knockTakenMul : 1,
    // Dash cooldown after the issue 4pc (-0.25 s). Floor 0.5 s so no future
    // stack of cooldown sources can make the dash a free permanent i-frame.
    dashCd: Math.max(0.5, SKILLS.dash.cd + (A ? A.dashCdAdd : 0)),
  };
}

// THE POST-53 XP TERM (Wave F.4) — the ladder past the S gate.
//
// THE CLIFF, measured: the player curve is xpForLevel = 52·L^1.42 while enemy
// XP scaled LINEARLY (1 + (L-1)·0.12), so kills-to-level grows like
// L^1.42 / L^1 ≈ L^0.42 — forever. With the matched-level proxy
// Σ xpForLevel(L) / (1 + (L-1)·0.12) (per-kill base normalised out, enemy
// level ≈ player level, which is what the one S gate at enemyLevel 54 /
// bossLevel 70 approximates across the band):
//   30 -> 45 costs 24,653 proxy-kills across 15 levels
//   53 -> 70 costs 36,924 proxy-kills across 17 levels  — 1.50x the grind,
// with LESS content variety to spend it in (one S gate vs the B/A/S ladder).
//
// THE DERIVATION: give enemy XP a gentle exponential factor G^(level - 53)
// above 53 and solve for G so the two bands cost the SAME proxy-kill total:
//   Σ_{L=53}^{69} 52·L^1.42 / ((1 + (L-1)·0.12) · G^(L-53))  =  24,653
// Bisection gives G = 1.0548; shipped as the round designer constant 1.055,
// which lands the 53->70 band at 24,621 proxy-kills — 0.13% under the
// 30->45 target, i.e. the same session count to within noise.
// tools/progression-test.mjs recomputes both sums from the live formulas and
// asserts the parity, naming the old 36,924 figure.
//
// SHAPE OF THE SHIPPED CURVE: x1.055 at 54 (+5.5%, imperceptible at the
// seam), x2.48 at 70, x12.4 at 100 — compounding exactly where the linear
// term starved, gentle where the old numbers were still honest. hp/atk stay
// LINEAR on purpose: the audit's cliff is an INCOME failure, not a
// difficulty failure, and inflating enemy stats would re-dig the hole this
// term fills. At and below 53 the pow term is G^0 = 1, so every shipped XP
// integer through E..A content is byte-identical; the first touched number is
// S-gate trash (enemyLevel 54 rolls: grunt 88 -> 93). Boss XP is NOT routed
// through scaleEnemy (game._spawnBoss prices b.xp off save.level itself), so
// this term deliberately moves only the trash stream — the dominant income.
export const POST53_XP_LEVEL = 53;
export const POST53_XP_GROWTH = 1.055;

// Enemy stat scaling by level.
export function scaleEnemy(base, level) {
  const k = 1 + (level - 1) * 0.19;
  return {
    hp: Math.floor(base.hp * k),
    atk: base.atk * (1 + (level - 1) * 0.15),
    xp: Math.floor(base.xp * (1 + (level - 1) * 0.12)
      * Math.pow(POST53_XP_GROWTH, Math.max(0, level - POST53_XP_LEVEL))),
  };
}

// The world's opinion of you. S lands at 53 rather than 40 so it stops
// colliding with the level-40 class trial, and SOVEREIGN sits above the
// published ladder entirely.
export function rankOf(level) {
  if (level >= 71) return 'SOVEREIGN';
  if (level >= 53) return 'S';
  if (level >= 37) return 'A';
  if (level >= 25) return 'B';
  if (level >= 16) return 'C';
  if (level >= 8) return 'D';
  return 'E';
}

export function gateIndexOfRank(rank) {
  return GATES.findIndex((g) => g.rank === rank);
}
