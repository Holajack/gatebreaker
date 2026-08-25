// ASCENSION — the legendary craft (RPG_SPEC step 14, gate3_ascension).
//
// A legendary is CRAFTED, not found below band B and never bought: the drop
// floor lives in weapons.rollDrop, the shelf ceiling in shop.shopStock, and
// this module is the third gate — the recipe. It happens at the ascension
// entry in the character panel (the buildOrder's answer to the openQuestions
// "where" — zero new city content), and it consumes:
//
//   * an EPIC instance of the family you want. It is consumed, and its SEED
//     becomes the legendary's seed — the item you loved becomes the item you
//     keep, and the save cost stays four fields ({b,r,s,l} with r flipped).
//   * 9 EMBERDUST — dropped only by B-rank-and-above gates (and Verge wild
//     gates): 1 guaranteed per boss plus a seed-derived chance per elite.
//     game.js owns the granting; this module owns the ledger.
//   * 1 FAMILY SIGIL — a guaranteed drop from ONE named boss per family, so
//     there is no ambiguity about where to go.
//   * 8000 ash — TIER_PRICE[5] 2400 x RARITY_PRICE.legendary 3.4 = 8160,
//     rounded to a price-shaped number.
//
// Like shop.js this file is DOM-free and node-drivable, and its ensure* is the
// whole migration: save.materials is deliberately NOT a schema bump — an
// absent ledger is indistinguishable from an empty one, the exact precedent
// save.shop and save.equipment set.

import { WEAPONS, RARITIES, rollWeapon } from './weapons.js';

export const EMBERDUST_COST = 9;
export const ASH_COST = 8000;

// Which named boss guards which family's sigil — the spec's literal map.
// polearm is deliberately ABSENT: the spec assigns six bosses to six families
// Six bosses cover seven families by sharing: the gravelord's sigil already
// serves both axe weights, so the warden's serves sword AND polearm — reach
// weapons drilled in the same martial line. A polearm epic previously reported
// NO SIGIL (the map omitted it), which walled Vigil/Voidglaive out of
// ascension entirely; sharing beats an unreachable rarity tier until a seventh
// boss exists to own the slot.
export const FAMILY_SIGIL = {
  sword: 'warden',
  polearm: 'warden',
  axe: 'gravelord',
  greataxe: 'gravelord',
  daggers: 'frostcaller',
  greatsword: 'infernus',
  bow: 'weaver',
  staff: 'archon',
};

// Toast/panel labels for the sigils, keyed by BOSS (the ledger's key), since
// two families share the Gravelord's.
export const SIGIL_LABEL = {
  warden: 'WARDEN SIGIL',
  gravelord: 'GRAVELORD SIGIL',
  frostcaller: 'FROSTCALLER SIGIL',
  infernus: 'INFERNUS SIGIL',
  weaver: 'VOIDWEAVER SIGIL',
  archon: 'ARCHON SIGIL',
};

// Emberdust economics, stated with the arithmetic so nobody retunes one side:
// only gates at rank band B+ (index >= 3, matching weapons.LEGENDARY_MIN_RANK)
// or Verge wild gates yield it. A B-rank crawl runs ~32 trash of which roughly
// a third roll elite-tier (brute/lancer/howler), so ~10 elites x 0.22 ≈ 2.2
// plus the boss's guaranteed 1 ≈ 3.2 per clear — three clears per craft, on
// top of the sigil hunt and the 8000 ash. Worth the grind, not a lottery.
export const EMBERDUST_MIN_RANK = 3;
export const EMBERDUST_ELITE_CHANCE = 0.22;

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Normalise (and, for pre-ascension saves, create) save.materials.
 * Idempotent and total, the ensureShopSave shape: any object converges to
 * { emberdust: int, sigils: { bossKey: int } } on first contact.
 */
export function ensureMaterials(save) {
  if (!save || typeof save !== 'object') return { emberdust: 0, sigils: {} };
  const cur = (save.materials && typeof save.materials === 'object') ? save.materials : {};
  const out = {
    emberdust: isCount(cur.emberdust) ? Math.floor(cur.emberdust) : 0,
    sigils: {},
  };
  const src = (cur.sigils && typeof cur.sigils === 'object') ? cur.sigils : {};
  for (const boss of Object.keys(SIGIL_LABEL)) {
    out.sigils[boss] = isCount(src[boss]) ? Math.floor(src[boss]) : 0;
  }
  save.materials = out;
  return out;
}

/** Credit emberdust. Returns the amount granted (0 for garbage input). */
export function grantEmberdust(save, n = 1) {
  const m = ensureMaterials(save);
  const add = Math.max(0, Math.floor(n || 0));
  m.emberdust += add;
  return add;
}

/** Credit one sigil for `boss` ('warden'..'archon'). False for unknown keys. */
export function grantSigil(save, boss) {
  const m = ensureMaterials(save);
  if (!(boss in m.sigils)) return false;
  m.sigils[boss] += 1;
  return true;
}

/**
 * Can `inst` (a rolled WEAPON instance) ascend right now?
 * Reasons come back in the Exchange's refusal voice so the panel can print
 * them verbatim. Checks are ordered cheapest-story-first: what the item is,
 * then what the wallet holds.
 */
export function canForge(save, inst) {
  const m = ensureMaterials(save);
  if (!inst || !inst.baseId || !WEAPONS[inst.baseId]) return { ok: false, reason: 'NOT A WEAPON' };
  if (inst.rarity === 'legendary') return { ok: false, reason: 'ALREADY ASCENDED' };
  if (inst.rarity !== 'epic') return { ok: false, reason: 'ONLY AN EPIC CAN ASCEND' };
  const boss = FAMILY_SIGIL[inst.archetype];
  if (!boss) return { ok: false, reason: 'NO SIGIL EXISTS FOR THIS FAMILY' };
  if ((m.sigils[boss] || 0) < 1) return { ok: false, reason: `NEEDS 1 ${SIGIL_LABEL[boss]}` };
  if (m.emberdust < EMBERDUST_COST) {
    return { ok: false, reason: `NEED ${EMBERDUST_COST - m.emberdust} MORE EMBERDUST` };
  }
  if ((save.ash || 0) < ASH_COST) {
    return { ok: false, reason: `NEED ${ASH_COST - Math.floor(save.ash || 0)} MORE ASH` };
  }
  return { ok: true, reason: null, boss };
}

/**
 * The craft. Deducts the recipe and returns the legendary; the CALLER owns
 * consuming the epic instance (removing it from hand/stash and equipping the
 * result) because only the caller knows which container held it — the exact
 * split buy() has with Game.equip.
 *
 * Result law (RPG_SPEC): rollWeapon(base, seedOfTheConsumedEpic,
 * { rarity: 'legendary', level: save.level }). Same seed, forced rarity —
 * the first three affixes are the epic's own (the affix stream is shared and
 * legendary draws one more), so the item genuinely IS the one that ascended.
 */
export function ascend(save, inst) {
  const gate = canForge(save, inst);
  if (!gate.ok) return { ok: false, reason: gate.reason, weapon: null };
  const m = save.materials;
  m.emberdust -= EMBERDUST_COST;
  m.sigils[gate.boss] -= 1;
  save.ash = Math.floor((save.ash || 0) - ASH_COST);
  const weapon = rollWeapon(inst.baseId, (inst.seed ?? 1) >>> 0, {
    rarity: 'legendary',
    level: Math.max(1, Math.floor(save.level || 1)),
  });
  return { ok: true, reason: null, weapon };
}

/** Flat recipe rows for the panel: [label, have, need, met]. */
export function ascensionRecipe(save, inst) {
  const m = ensureMaterials(save);
  const boss = inst ? FAMILY_SIGIL[inst.archetype] : null;
  const rows = [
    ['EMBERDUST', m.emberdust, EMBERDUST_COST, m.emberdust >= EMBERDUST_COST],
    [boss ? SIGIL_LABEL[boss] : 'FAMILY SIGIL', boss ? (m.sigils[boss] || 0) : 0, 1,
      Boolean(boss) && (m.sigils[boss] || 0) >= 1],
    ['ASH', Math.floor(save.ash || 0), ASH_COST, (save.ash || 0) >= ASH_COST],
  ];
  return rows;
}

// Re-exported so the panel can print the epic->legendary step without
// importing RARITIES itself just for two numbers.
export const LEGENDARY_MUL_STEP = RARITIES.legendary.mul / RARITIES.epic.mul;
