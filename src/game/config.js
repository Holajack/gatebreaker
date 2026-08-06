// Balance tables and content definitions for Gatebreaker: Rift Ascension.
// Everything the designer would want to tune lives here.

export const RANKS = ['E', 'D', 'C', 'B', 'A', 'S'];

export const GATES = [
  {
    rank: 'E', name: 'FRACTURED HOLLOW', biome: 'hollow',
    enemies: 10, waveSize: 3, enemyLevel: 1, arena: 46,
    boss: 'warden', reqLevel: 1,
    blurb: 'A shallow tear. Good place to learn which end of the blade cuts.',
  },
  {
    rank: 'D', name: 'ASHEN CATACOMB', biome: 'catacomb',
    enemies: 16, waveSize: 4, enemyLevel: 4, arena: 52,
    boss: 'gravelord', reqLevel: 4,
    blurb: 'The dead here were buried standing up. They still are.',
  },
  {
    rank: 'C', name: 'GLACIER SPIRE', biome: 'glacier',
    enemies: 24, waveSize: 7, enemyLevel: 9, arena: 58,
    boss: 'frostcaller', reqLevel: 9,
    blurb: 'Cold enough that blood freezes before it finishes falling.',
  },
  {
    rank: 'B', name: 'EMBER THRONE', biome: 'ember',
    enemies: 30, waveSize: 8, enemyLevel: 16, arena: 64,
    boss: 'infernus', reqLevel: 16,
    blurb: 'Something enormous is sitting on a chair of molten iron.',
  },
  {
    rank: 'A', name: 'VOIDWEAVE DEPTHS', biome: 'void',
    enemies: 36, waveSize: 9, enemyLevel: 25, arena: 70,
    boss: 'weaver', reqLevel: 25,
    blurb: 'Geometry stops agreeing with itself past the threshold.',
  },
  {
    rank: 'S', name: 'MONARCH\'S REACH', biome: 'monarch',
    enemies: 44, waveSize: 10, enemyLevel: 36, arena: 76,
    boss: 'monarch', reqLevel: 36,
    blurb: 'No hunter has walked back out. The record is unbroken.',
  },
];

export const BIOMES = {
  hollow:   { fog: 0x0a0d1c, ground: 0x1a1f38, accent: 0x7c5cff, sky: 0x05060d, pillar: 0x2a3050 },
  catacomb: { fog: 0x140f14, ground: 0x2a2028, accent: 0xc2703a, sky: 0x0b0709, pillar: 0x3d2f36 },
  glacier:  { fog: 0x0b1a26, ground: 0x1d3a4d, accent: 0x66e0ff, sky: 0x061219, pillar: 0x2d5570 },
  ember:    { fog: 0x1c0a06, ground: 0x36150d, accent: 0xff6b2b, sky: 0x120503, pillar: 0x4d1f12 },
  void:     { fog: 0x0d0618, ground: 0x1c1030, accent: 0xb14bff, sky: 0x070312, pillar: 0x2c1a4a },
  monarch:  { fog: 0x18050f, ground: 0x2e0a1c, accent: 0xff2d6b, sky: 0x0e0208, pillar: 0x45102a },
};

// --- Enemy archetypes. `s` values are multipliers scaled by enemy level. ---
export const ENEMY_TYPES = {
  grunt: {
    name: 'Rift Grunt', hp: 34, atk: 5, speed: 3.4, range: 1.9, attackCd: 1.5,
    xp: 12, scale: 1, color: 0x4d5a80, glow: 0x9db4ff, ai: 'chase',
  },
  stalker: {
    name: 'Stalker', hp: 26, atk: 6.5, speed: 5.3, range: 1.8, attackCd: 1.2,
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
};

export const BOSSES = {
  warden:     { name: 'HOLLOW WARDEN',   hp: 460,   atk: 18, speed: 3.0, scale: 2.5, color: 0x4a5480, glow: 0x9db4ff, xp: 220 },
  gravelord:  { name: 'THE GRAVELORD',   hp: 900,   atk: 26, speed: 3.2, scale: 2.7, color: 0x6d4a3a, glow: 0xffa063, xp: 480 },
  frostcaller:{ name: 'FROSTCALLER',     hp: 1650,  atk: 36, speed: 3.4, scale: 2.6, color: 0x2f6d8c, glow: 0x8ff0ff, xp: 900 },
  infernus:   { name: 'INFERNUS',        hp: 2900,  atk: 52, speed: 3.6, scale: 2.9, color: 0x8a2f14, glow: 0xff8340, xp: 1700 },
  weaver:     { name: 'THE VOIDWEAVER',  hp: 5200,  atk: 74, speed: 3.8, scale: 3.0, color: 0x5a2a8c, glow: 0xd08aff, xp: 3200 },
  monarch:    { name: 'THE RIFT MONARCH',hp: 9800,  atk: 104, speed: 4.0, scale: 3.4, color: 0x8c1440, glow: 0xff5c8a, xp: 6800 },
};

// --- Skills ---
export const SKILLS = {
  attack: { name: 'Strike',  cd: 0.40, mp: 0,  dmg: 1.00, unlockLevel: 1 },
  dash:   { name: 'Dash',    cd: 1.60, mp: 0,  dmg: 0,    unlockLevel: 1, iframes: 0.34, distance: 7.5 },
  slash:  { name: 'Ruin',    cd: 4.20, mp: 12, dmg: 2.30, unlockLevel: 3,  range: 8.0, arc: Math.PI * 0.75 },
  nova:   { name: 'Nova',    cd: 8.50, mp: 26, dmg: 3.40, unlockLevel: 7,  radius: 9.0 },
  summon: { name: 'Bind',    cd: 13.0, mp: 30, dmg: 0,    unlockLevel: 12, maxShadows: 3 },
};

// --- Stats ---
export const STATS = [
  { key: 'str', name: 'STRENGTH',  desc: '+2.4 attack power' },
  { key: 'agi', name: 'AGILITY',   desc: '+0.11 move speed, +0.7% crit' },
  { key: 'vit', name: 'VITALITY',  desc: '+11 max health' },
  { key: 'int', name: 'INTELLECT', desc: '+7 max mana, +2.5% skill damage' },
];

export const POINTS_PER_LEVEL = 3;

export function xpForLevel(level) {
  return Math.floor(46 * Math.pow(level, 1.36));
}

// Derived player numbers from base + allocated stats.
export function derive(save) {
  const { str, agi, vit, int: intel } = save.stats;
  const lv = save.level;
  return {
    maxHp: Math.floor(130 + vit * 11 + (lv - 1) * 9),
    maxMp: Math.floor(50 + intel * 7 + (lv - 1) * 3),
    atk: 13 + str * 2.4 + (lv - 1) * 1.6,
    speed: 6.0 + agi * 0.11,
    crit: Math.min(0.6, 0.05 + agi * 0.007),
    skillMul: 1 + intel * 0.025,
    hpRegen: 0.6 + vit * 0.05,
    mpRegen: 2.2 + intel * 0.16,
  };
}

// Enemy stat scaling by level.
export function scaleEnemy(base, level) {
  const k = 1 + (level - 1) * 0.19;
  return {
    hp: Math.floor(base.hp * k),
    atk: base.atk * (1 + (level - 1) * 0.15),
    xp: Math.floor(base.xp * (1 + (level - 1) * 0.12)),
  };
}

export function rankOf(level) {
  if (level >= 40) return 'S';
  if (level >= 28) return 'A';
  if (level >= 18) return 'B';
  if (level >= 10) return 'C';
  if (level >= 5) return 'D';
  return 'E';
}
