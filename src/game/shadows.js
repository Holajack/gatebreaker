// The shadow army as DATA. Who exists, who is strong, who deploys.
//
// Deliberately THREE-free: game.js keeps ownership of meshes and spawning,
// this module only ever decides membership and numbers.

import { ENEMY_TYPES, SHADOW_GRADES } from './config.js';
import { effectiveStat, shadowRosterCapacity } from './progression.js';

export const GRADES = SHADOW_GRADES;

// A boss corpse has no ENEMY_TYPES row, so give it its own base line rather
// than silently extracting a grunt.
const BOSS_BASE = { hp: 180, atk: 24, speed: 3.6, scale: 1.6 };

const baseFor = (type) => ENEMY_TYPES[type] || (type === 'boss' ? BOSS_BASE : ENEMY_TYPES.grunt);

const clampGrade = (i) => Math.max(0, Math.min(GRADES.length - 1, Math.floor(i || 0)));

export function gradeName(index) {
  return GRADES[clampGrade(index)].name;
}

export function gradeMultiplier(index) {
  return GRADES[clampGrade(index)].mul;
}

// Two original word lists. Names are composed, never drawn from any existing
// property, and the numeric suffix keeps a 120-strong roster unambiguous.
const PREFIXES = ['Ash', 'Grey', 'Coal', 'Rime', 'Hollow', 'Quill', 'Sable'];
const SUFFIXES = ['-warden', '-mark', '-thorn', '-fang', '-shard', '-vow'];

export function nameFor(type, grade, seedId) {
  const n = Math.max(0, Math.floor(seedId || 0));
  const combos = PREFIXES.length * SUFFIXES.length;
  const p = PREFIXES[n % PREFIXES.length];
  const s = SUFFIXES[Math.floor(n / PREFIXES.length) % SUFFIXES.length];
  const cycle = Math.floor(n / combos);
  return cycle > 0 ? `${p}${s} ${cycle + 1}` : `${p}${s}`;
}

export function makeShadow(save, { type = 'grunt', level = 1, grade = 0, creature = null } = {}) {
  const roster = save.shadows.roster;
  const id = save.shadows.nextId || roster.length + 1;
  save.shadows.nextId = id + 1;
  return {
    id,
    name: nameFor(type, grade, id),
    grade: clampGrade(grade),
    type,
    // WHICH creature this used to be (a creatures.json key). Binding keeps the
    // fallen's own figure, so the roster must remember more than the archetype.
    // Nullable on purpose: rosters saved before this field existed (and kills
    // made with creatures.glb absent) carry null, and game.js assigns a stable
    // default the first time the record takes the field — a lazy migration, so
    // save.js never needs a schema bump for it.
    creature: creature || null,
    level: Math.max(1, Math.floor(level)),
    kills: 0,
    bornAt: Date.now(),
  };
}

export function addShadow(save, record) {
  if (save.shadows.roster.length >= shadowRosterCapacity(save)) return { added: false, reason: 'full' };
  save.shadows.roster.push(record);
  return { added: true, reason: 'ok' };
}

export function removeShadow(save, id) {
  const r = save.shadows.roster;
  const i = r.findIndex((s) => s.id === id);
  if (i < 0) return false;
  r.splice(i, 1);
  save.shadows.deployed = (save.shadows.deployed || []).filter((d) => d !== id);
  return true;
}

/**
 * Death releases recruits, never your best. Losing an irreplaceable named
 * shadow to one bad run is the fastest way to make a player stop taking risks.
 */
export function releaseWeakest(save, count = 1) {
  const order = [...save.shadows.roster].sort((a, b) => (
    a.grade - b.grade || a.level - b.level || a.kills - b.kills || a.id - b.id
  ));
  const doomed = order.slice(0, Math.max(0, Math.floor(count)));
  doomed.forEach((s) => removeShadow(save, s.id));
  return doomed;
}

export function promoteCost(save, record) {
  const g = clampGrade(record?.grade);
  return { ash: Math.round(120 * Math.pow(2.2, g)), minLevel: 8 * (g + 1) };
}

export function canPromote(save, record) {
  if (!record) return false;
  const g = clampGrade(record.grade);
  if (g >= GRADES.length - 1) return false;
  const { ash, minLevel } = promoteCost(save, record);
  if ((save.ash || 0) < ash) return false;
  if (save.level < minLevel) return false;
  // The upper grades are rank slots, not just price tags.
  const next = GRADES[g + 1];
  const held = save.shadows.roster.filter((s) => s.grade === g + 1).length;
  return held < next.maxCount;
}

export function promote(save, id) {
  const rec = save.shadows.roster.find((s) => s.id === id);
  if (!rec || !canPromote(save, rec)) return false;
  save.ash -= promoteCost(save, rec).ash;
  rec.grade = clampGrade(rec.grade + 1);
  return true;
}

export function setDeployed(save, ids) {
  const owned = new Set(save.shadows.roster.map((s) => s.id));
  const seen = new Set();
  const next = [];
  for (const id of ids || []) {
    if (!owned.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  save.shadows.deployed = next;
  return next;
}

export function autoDeploy(save, fieldCap) {
  const cap = Math.max(0, Math.floor(fieldCap || 0));
  const best = [...save.shadows.roster].sort((a, b) => (
    b.grade - a.grade || b.level - a.level || b.kills - a.kills || a.id - b.id
  )).slice(0, cap);
  return setDeployed(save, best.map((s) => s.id));
}

export function deployedRecords(save) {
  const byId = new Map(save.shadows.roster.map((s) => [s.id, s]));
  return (save.shadows.deployed || []).map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Shadow strength scales off the OWNER's INT and level, not off whatever the
 * corpse used to be — that is what makes an early shadow you kept and promoted
 * still worth fielding at level 60.
 */
export function shadowCombat(save, record) {
  const base = baseFor(record.type);
  const mul = gradeMultiplier(record.grade);
  const scale = (base.scale || 1) * (1 + clampGrade(record.grade) * 0.03);
  return {
    hp: Math.floor(base.hp * mul * (1 + save.level * 0.06)),
    atk: base.atk * mul * (1 + effectiveStat(save, 'int') * 0.011) * (1 + save.level * 0.05),
    // Shadows have to keep up with the player or they never reach the fight,
    // so the archetype's own speed is a floor, not the answer.
    speed: Math.max(5.4, base.speed),
    radius: 0.5 * scale,
    scale,
  };
}

export function rosterSummary(save) {
  const roster = save.shadows.roster;
  const byGrade = GRADES.map(() => 0);
  let strongest = null;
  for (const s of roster) {
    byGrade[clampGrade(s.grade)]++;
    if (!strongest || s.grade > strongest.grade || (s.grade === strongest.grade && s.level > strongest.level)) {
      strongest = s;
    }
  }
  return { count: roster.length, capacity: shadowRosterCapacity(save), byGrade, strongest };
}
