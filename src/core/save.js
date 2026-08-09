// Persistent hunter profile. Small enough for localStorage; survives app restarts.
//
// Schema v2. The v1 shape stored `shadows` as an integer count; v2 stores a
// roster of records, which is a CHANGED FIELD TYPE — the old "merge onto a
// fresh object" trick cannot express that, so migrate() exists.

export const SCHEMA_VERSION = 2;
export const SAVE_KEY = 'gatebreaker.save.v2';
export const LEGACY_KEY = 'gatebreaker.save.v1';

// Node (the headless progression test) has no localStorage and must not throw
// merely by importing this module.
function store() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function freshSave() {
  return {
    version: SCHEMA_VERSION,
    level: 1,
    xp: 0,
    points: 0,
    stats: { str: 0, agi: 0, vit: 0, int: 0, per: 0 },
    autoStats: 0,       // the +1-to-everything counter; one per level gained
    playerBody: 'male', // 'male' | 'female' — the combat layer picks the rig off this
    cleared: {},        // { E: bestTimeSeconds }
    shadows: { roster: [], deployed: [], nextId: 1 },
    ash: 0,
    daily: { dayKey: null, progress: 0, claimed: false },
    classTier: null,
    unlockedAnomaly: false,
    totalKills: 0,
    deaths: 0,
    weapon: null,
    stash: [],
    // The Exchange's memory: which rank band the shelf was rolled for, and
    // which of that band's bases have already been bought. band -1 means "no
    // shelf rolled yet", which is what every save written before the shop
    // existed reads as — game/shop.js ensureShopSave() is the migration and it
    // runs on first contact, so this field is a convenience, not a contract.
    // Deliberately NOT a schema bump: an absent value is indistinguishable
    // from this one.
    shop: { band: -1, sold: [] },
    // World clock, hours as a 0..24 float. 15.0 is the shipped afternoon look,
    // so a save from before day/night existed resumes in the frame the game
    // has always opened on. Deliberately NOT a schema bump: a missing field
    // reads as 15.0 and that is the whole migration.
    worldTime: 15.0,
  };
}

// The clock is written every save cadence and read back on boot, so a
// hand-edited or corrupted value must not put the world at hour NaN.
function sanitiseHours(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 15.0;
  const w = v % 24;
  return w < 0 ? w + 24 : w;
}

// Ash is real money now (game/shop.js gave the field its first income source),
// so a corrupted or hand-edited wallet must not reach the shop as NaN — every
// comparison against NaN is false, which would make everything unaffordable
// AND make the balance render as "NaN ASH".
function sanitiseAsh(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

// Structural only. Whether a `sold` entry names a weapon that still exists is
// game/shop.js's business — this module deliberately does not import weapons.js
// (which pulls in THREE) merely to validate a string.
function sanitiseShop(v) {
  const band = (v && typeof v.band === 'number' && Number.isFinite(v.band)) ? Math.floor(v.band) : -1;
  const sold = (v && Array.isArray(v.sold)) ? v.sold.filter((s) => typeof s === 'string') : [];
  return { band, sold };
}

/**
 * Upgrade any parsed save object to the v2 shape. Pure — no storage access —
 * so it is directly testable and so load() can decide what to persist.
 */
export function migrate(raw) {
  const base = freshSave();
  if (!raw || typeof raw !== 'object') return base;
  // The rig loader switches on this value, so the contract is exactly the two
  // strings — anything else (absent on older saves, or hand-edited) snaps back
  // to the default rather than leaking into entities.js.
  const playerBody = raw.playerBody === 'female' ? 'female' : 'male';
  if (raw.version === SCHEMA_VERSION && raw.shadows && Array.isArray(raw.shadows.roster)) {
    // Already v2: merge onto fresh so a build that adds a field stays safe.
    return {
      ...base,
      ...raw,
      version: SCHEMA_VERSION,
      playerBody,
      worldTime: sanitiseHours(raw.worldTime),
      ash: sanitiseAsh(raw.ash),
      shop: sanitiseShop(raw.shop),
      stats: { ...base.stats, ...(raw.stats || {}) },
      cleared: { ...(raw.cleared || {}) },
      daily: { ...base.daily, ...(raw.daily || {}) },
      shadows: {
        roster: raw.shadows.roster.slice(),
        deployed: Array.isArray(raw.shadows.deployed) ? raw.shadows.deployed.slice() : [],
        nextId: raw.shadows.nextId || raw.shadows.roster.length + 1,
      },
      stash: Array.isArray(raw.stash) ? raw.stash.slice() : [],
    };
  }

  // --- v1 -> v2 ---
  const level = Math.max(1, Math.floor(raw.level || 1));
  const out = {
    ...base,
    ...raw,
    version: SCHEMA_VERSION,
    playerBody,
    level,
    worldTime: sanitiseHours(raw.worldTime),
    ash: sanitiseAsh(raw.ash),
    shop: sanitiseShop(raw.shop),
    stats: { ...base.stats, ...(raw.stats || {}) },   // seeds per:0
    cleared: { ...(raw.cleared || {}) },
    daily: { ...base.daily },
    stash: Array.isArray(raw.stash) ? raw.stash.slice() : [],
  };
  // v1 had no auto-granted stats, but the v2 invariant is autoStats === levels
  // gained. Reconstructing it keeps a returning player's power curve continuous
  // instead of leaving them 99 stat points behind a fresh account.
  out.autoStats = typeof raw.autoStats === 'number' ? raw.autoStats : level - 1;

  const count = typeof raw.shadows === 'number' ? Math.max(0, Math.floor(raw.shadows)) : 0;
  const roster = [];
  for (let i = 0; i < count; i++) {
    roster.push({
      id: i + 1,
      name: `Cinderbound ${i + 1}`,
      grade: 1,
      type: 'grunt',
      level,
      kills: 0,
      bornAt: 0,
    });
  }
  out.shadows = { roster, deployed: [], nextId: count + 1 };
  return out;
}

export function load() {
  const ls = store();
  if (!ls) return freshSave();
  try {
    const rawV2 = ls.getItem(SAVE_KEY);
    if (rawV2) return migrate(JSON.parse(rawV2));

    const rawV1 = ls.getItem(LEGACY_KEY);
    if (!rawV1) return freshSave();
    const upgraded = migrate(JSON.parse(rawV1));
    // Write the v2 key but LEAVE v1 in place: rolling back to an older build
    // must not find an empty profile.
    save(upgraded);
    return upgraded;
  } catch {
    return freshSave();
  }
}

export function save(data) {
  try {
    store()?.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    /* storage full or blocked — the run still plays, it just won't persist */
  }
}

export function wipe() {
  try {
    const ls = store();
    ls?.removeItem(SAVE_KEY);
    ls?.removeItem(LEGACY_KEY);
  } catch { /* ignore */ }
}
