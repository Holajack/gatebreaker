// THE EXCHANGE — the weapon shop behind the Exchange's door prompt.
//
// The owner's ask, verbatim: "the stronger he gets the better weapons he
// unlocks". This module is the whole of that rule, and nothing else. No
// crafting, no upgrades, no reroll, no sell-back. Buy, equip, keep.
//
// Why it lives in game/ and not ui/: everything here is pure data over the save
// object — no THREE, no DOM — so tools/shop-test.mjs can import it in Node and
// assert the ladder, the prices and the persistence without a browser, exactly
// the way progression.js is tested.
//
// ---------------------------------------------------------------------------
// THE CURRENCY
// ---------------------------------------------------------------------------
// save.ash has existed since the v1 schema and has always had two SINKS
// (progression.respec, shadows.promote) and no SOURCE — nothing in the shipped
// game ever incremented it, so both sinks were unreachable. Rather than mint a
// second currency beside a dead one, this wave gives ash its income: every
// point of XP a kill pays also pays ash. That is the minimal change, it makes
// the two existing sinks work for the first time, and it needs no new save
// field for the money itself.
//
// The one genuinely NEW piece of save state is `save.shop`, which is the
// shopfront's memory: which rank band the stock was rolled for, and which of
// that band's bases have already been bought. Old saves have no such field, so
// ensureShopSave() is the migration and it is idempotent — every entry point
// here calls it first, which means a save written by any previous build, or a
// hand-edited one, converges to the valid shape on first contact rather than
// throwing halfway through a purchase.
//
// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------
// Stock is GENERATED, so it obeys the repo's generation rule: forked mulberry32
// only, no Date.now(), no Math.random(). The stream is seeded from the rank
// band alone, which has three consequences worth stating:
//
//   * the same player at the same rank always sees the same shelf, so the shop
//     is a ladder you can plan against rather than a slot machine you reroll by
//     leaving and coming back;
//   * a bought weapon is stored as (base, rarity, seed, level) by
//     serializeWeapon, so it rebuilds byte-identically after a reload — which
//     is what makes "buy, equip, persist across reload" true rather than
//     approximately true;
//   * the test can assert the shelf without a fixture file.

import { mulberry32 } from '../core/rng.js';
import { WEAPONS, WEAPON_LIST, RARITIES, rollRarity, rollWeapon } from './weapons.js';
import { RANKS, rankOf } from './config.js';

// Ash per point of XP. Calibrated against the shipped tables, not guessed: an
// E-gate clear is 12 trash at 12-16 XP plus a 220 XP boss, so ~190 ash — one
// tier-1 common (140) per clear at the bottom of the ladder, and roughly seven
// E clears for the tier-3 rare a C-rank hunter is shopping for. Rounding is UP
// so that a 1 XP kill is never worth 0 and the number visibly moves.
export const ASH_PER_XP = 0.5;

// Price is driven by TIER, not by the rolled score. Measured: every base in
// weapons.js scores within 362..510 common, because score is a DPS proxy and
// the archetypes are balanced against each other on purpose. Pricing off it
// would make a Voidglaive cost the same as a Riftedge. Tier is the axis the
// weapon table already uses to express "later, better", so tier is the axis
// the shop charges on.
const TIER_PRICE = { 1: 140, 2: 380, 3: 760, 4: 1400, 5: 2400 };

// Rarity multiplies the tier price. Deliberately flatter than RARITIES.mul
// implies at the top: a legendary is 3.4x the price for 1.58x the damage
// multiplier, because the affixes are the real prize and a shop that priced
// them linearly would make legendaries the only rational purchase.
const RARITY_PRICE = { common: 1.0, uncommon: 1.3, rare: 1.75, epic: 2.4, legendary: 3.4 };

// Fixed salt so the band seed cannot collide with any other stream in the game
// (the dungeon uses (index+1)*7919, the city uses its own build seed).
const SHOP_SALT = 0x5ade0f;

/** Rank band as an index into RANKS. SOVEREIGN shops from the S shelf. */
export function shopBand(save) {
  const r = rankOf(Math.max(1, Math.floor(save?.level || 1)));
  const i = RANKS.indexOf(r);
  return i < 0 ? RANKS.length - 1 : i;
}

/**
 * Normalise (and, for pre-shop saves, create) save.ash and save.shop.
 *
 * Idempotent and total: given any object it returns a valid save.shop, and it
 * re-rolls the shelf whenever the player's rank band has moved since the last
 * visit. That re-roll IS the progression the owner asked for — ranking up is
 * what puts new weapons on the shelf and makes the ones you skipped buyable
 * again.
 */
export function ensureShopSave(save) {
  if (!save || typeof save !== 'object') return { band: -1, sold: [] };
  if (typeof save.ash !== 'number' || !Number.isFinite(save.ash) || save.ash < 0) save.ash = 0;
  const cur = save.shop;
  let shop = (cur && typeof cur === 'object') ? cur : null;
  if (!shop) { shop = { band: -1, sold: [] }; save.shop = shop; }
  if (!Array.isArray(shop.sold)) shop.sold = [];
  // Drop anything in `sold` that is not a real base id — a stale id from a
  // renamed weapon would otherwise hide a shelf slot forever.
  shop.sold = shop.sold.filter((id) => Boolean(WEAPONS[id]));
  const band = shopBand(save);
  if (shop.band !== band) {
    shop.band = band;
    shop.sold = [];
  }
  return shop;
}

/** Price of a rolled weapon, in ash. Rounded to 5 so the numbers read as prices. */
export function priceOf(weapon) {
  if (!weapon) return 0;
  const tier = TIER_PRICE[weapon.tier] || TIER_PRICE[1];
  const mul = RARITY_PRICE[weapon.rarity] || 1;
  return Math.round((tier * mul) / 5) * 5;
}

/**
 * The shelf.
 *
 * EVERY base in the table appears, in ladder order, so the panel itself is the
 * answer to "what do I unlock next" — the locked rows are the point, not
 * clutter. A row is unlocked when the player's rank band has reached the base's
 * minRank AND his level has reached its reqLevel; only unlocked rows carry a
 * rolled weapon instance and a price.
 *
 * Rarity is rolled per row off the band stream with luck scaling on the band,
 * so an S-rank shelf genuinely offers better rolls than an E-rank one rather
 * than merely offering more rows.
 *
 * @returns {Array<{baseId:string,name:string,archetype:string,tier:number,
 *   reqLevel:number,minRank:string,locked:boolean,sold:boolean,
 *   weapon:object|null,price:number,reason:string|null}>}
 */
export function shopStock(save) {
  const shop = ensureShopSave(save);
  const band = shop.band;
  const level = Math.max(1, Math.floor(save.level || 1));
  const rnd = mulberry32((SHOP_SALT ^ ((band + 1) * 0x9e3779b1)) >>> 0);
  // Ladder order, so the panel reads top-to-bottom as "now / soon / later"
  // regardless of the order the WEAPONS object literal happens to be in.
  const ordered = WEAPON_LIST.slice().sort(
    (a, b) => (a.minRank - b.minRank) || (a.reqLevel - b.reqLevel) || (a.tier - b.tier),
  );
  const rows = [];
  for (const base of ordered) {
    // The stream is consumed for EVERY row, locked ones included. That is what
    // makes a row's rarity a function of the BAND alone and not of how many
    // rows happened to be unlocked when it was drawn — so gaining a level
    // inside a band (which unlocks reqLevel rows) does not silently re-roll the
    // rows already on the shelf, and `sold` stays a meaningful key for the
    // whole band. Crossing into a new band re-seeds and re-rolls everything,
    // which is the intended reward.
    const rarity = rollRarity(rnd, band * 0.75);
    const seed = (rnd() * 0xffffffff) >>> 0;
    const rankLocked = base.minRank > band;
    const levelLocked = base.reqLevel > level;
    const locked = rankLocked || levelLocked;
    const sold = shop.sold.includes(base.id);
    const weapon = locked ? null : rollWeapon(base.id, seed, { rarity, level });
    rows.push({
      baseId: base.id,
      name: base.name,
      archetype: base.archetype,
      tier: base.tier,
      reqLevel: base.reqLevel,
      minRank: RANKS[base.minRank] || RANKS[0],
      rarity: locked ? null : rarity,
      rarityName: locked ? null : RARITIES[rarity].name,
      blurb: base.blurb,
      locked,
      sold,
      weapon,
      price: weapon ? priceOf(weapon) : 0,
      reason: rankLocked
        ? `${RANKS[base.minRank]}-GRADE HUNTERS ONLY`
        : (levelLocked ? `REQUIRES LEVEL ${base.reqLevel}` : null),
    });
  }
  return rows;
}

/** Ash awarded for `xp` points of experience. Never zero for a real kill. */
export function ashForXp(xp) {
  if (!(xp > 0)) return 0;
  return Math.max(1, Math.round(xp * ASH_PER_XP));
}

/**
 * Credit ash. Returns the amount actually granted so a caller can report it.
 * Kept here rather than in progression.js because progression.js is the stat
 * ledger and this is the wallet; the only other thing that touches ash is the
 * two sinks that were already written against save.ash directly.
 */
export function grantAsh(save, amount) {
  if (!save) return 0;
  ensureShopSave(save);
  const n = Math.max(0, Math.round(amount || 0));
  if (!n) return 0;
  save.ash += n;
  return n;
}

/**
 * Buy one shelf row.
 *
 * Does NOT equip — equipping owns the player mesh and the stash, which is
 * Game.equip's job, and the caller passes the returned weapon straight to it.
 * That split is what keeps this module DOM-free and importable in Node.
 *
 * @returns {{ok:boolean, reason:string|null, weapon:object|null, price:number, ash:number}}
 */
export function buy(save, baseId) {
  const shop = ensureShopSave(save);
  const row = shopStock(save).find((r) => r.baseId === baseId);
  if (!row) return { ok: false, reason: 'NO SUCH WEAPON', weapon: null, price: 0, ash: save.ash };
  if (row.locked) return { ok: false, reason: row.reason || 'LOCKED', weapon: null, price: row.price, ash: save.ash };
  if (row.sold) return { ok: false, reason: 'ALREADY BOUGHT', weapon: null, price: row.price, ash: save.ash };
  if (save.ash < row.price) {
    return { ok: false, reason: `NEED ${row.price - save.ash} MORE ASH`, weapon: null, price: row.price, ash: save.ash };
  }
  save.ash -= row.price;
  shop.sold.push(baseId);
  return { ok: true, reason: null, weapon: row.weapon, price: row.price, ash: save.ash };
}
