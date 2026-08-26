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

// The eight slots, in the order the inventory panel draws them. Exported so a
// panel or a test never has to spell the list out a second time — two lists of
// slot names is how a slot goes missing from exactly one of them.
export const EQUIP_SLOTS = ['weapon', 'offhand', 'head', 'chest', 'hands', 'legs', 'feet', 'trinket'];

export function freshEquipment() {
  const e = {};
  for (const s of EQUIP_SLOTS) e[s] = null;
  return e;
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
    // null means "no custom name set" — the inventory header falls back to
    // the generic "THE HUNTER" label. Absent-means-default, the same
    // save.shop/save.worldTime precedent: a save written before this field
    // existed reads identically to one that explicitly has it unset, so this
    // is not a schema bump.
    hunterName: null,
    cleared: {},        // { E: bestTimeSeconds }
    shadows: { roster: [], deployed: [], nextId: 1 },
    ash: 0,
    daily: { dayKey: null, progress: 0, claimed: false },
    classTier: null,
    unlockedAnomaly: false,
    totalKills: 0,
    deaths: 0,
    // The v1-and-still-current single-weapon field. It is now a MIRROR of
    // equipment.weapon rather than the source of truth — see ensureEquipment.
    weapon: null,
    stash: [],
    // Eight equipment slots. Five of them (head/chest/hands/legs/feet) are the
    // armour slots Wave 3-B fills; they exist here now so a save written today
    // is already the shape the armour wave reads, and so the inventory panel
    // can show them as real empty slots instead of pretending.
    //
    // Deliberately NOT a schema bump, on the save.shop / save.worldTime
    // precedent: an absent value is indistinguishable from this one, so
    // ensureEquipment() IS the migration and it runs on first contact.
    equipment: freshEquipment(),
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
    // --- The two Wave B5 world fields. Both absent-means-default on the
    // shop/worldTime precedent — NOT a schema bump, because every save written
    // before waygates existed was, by definition, standing in Threshold having
    // visited only Threshold, which is exactly what these defaults say.
    //   settlement — the slug of the town the player is in; citymode.enter is
    //                the single writer. THIS LINE IS THE MIGRATION: an absent
    //                value reads as 'threshold'.
    //   visited    — append-only discovery list the map's settlement switcher
    //                and TRAVEL gating read; marked on arrival, never removed.
    //                An absent value reads as ['threshold'].
    settlement: 'threshold',
    visited: ['threshold'],
    //   welcomed   — the first-arrival welcome overlay has been shown and
    //                dismissed (citymode.enter is the single writer). Absent
    //                reads as false, which IS the migration: an existing
    //                player sees the welcome once after this update — a
    //                one-time re-greeting, not a bug.
    welcomed: false,
    // --- The four CLASSES_SPEC fields. All additive, all defaulting to "the
    // system does not exist for this save", which is exactly the state every
    // profile written before Wave 3-B is in — so, on the shop/worldTime
    // precedent, NOT a schema bump. className is the Assay Hall choice;
    // archon is the endgame path; both null until the player commits.
    // classTier (above) is deliberately untouched: it is reinterpreted as
    // class QUALITY by classes.js and stays owned by progression.js.
    className: null,
    archon: null,
    respecTokens: 0,
    archonState: freshArchonState(),
  };
}

// The archon layer's persistent block: the resource meter, ASHEN SIGILS for
// re-ascension, the pact-beast records, and the five affinity counters that
// decide which paths the trial offers. The two booleans are one-shot grant
// guards (see migrate): they live in here rather than as top-level fields so
// the whole classes footprint stays four keys.
export function freshArchonState() {
  return {
    resource: 0,
    sigils: 0,
    ascendedAt: 0,
    pacts: [],
    affinity: { shadow: 0, flame: 0, frost: 0, storm: 0, beast: 0 },
    migTokenGranted: false,
    classTokenGranted: false,
    // STEP 5's third one-shot guard: the first class RE-choice is free (an
    // Assay Seal on the house — every player deserves one look at a class they
    // picked from a menu at level 20); after this flips, reseals cost ash.
    freeSealUsed: false,
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

// The class/archon key allowlists, duplicated as local consts on the same
// trade sanitiseShop() already made with weapons.js: game/classes.js is the
// source of truth for both lists, and this module deliberately does not
// import it merely to validate a string. If a key is added there, add it
// here, or the new class silently unsaves.
const CLASS_KEYS = ['vanguard', 'berserker', 'bladedancer', 'hexweaver', 'binder', 'oracle', 'templar', 'reaver'];
const ARCHON_PATH_KEYS = ['shadow', 'flame', 'frost', 'storm', 'beast'];

// The settlement slug allowlist, duplicated from src/world/settlements.js's
// SETTLEMENTS registry on the exact trade CLASS_KEYS made with classes.js:
// this module deliberately imports nothing merely to validate a string (and
// settlements.js, though dependency-free, is 50 KB of world data the headless
// progression test has no business loading). Add a settlement there, add its
// slug here, or the new town silently unsaves back to Threshold.
const SETTLEMENT_KEYS = ['threshold', 'emberfall', 'birchreach'];

// A hand-edited or future-build slug must never reach citymode.enter — it
// would look up undefined in the registry and fall through anyway, but the
// save should not carry a value the running build cannot honour.
function sanitiseSettlement(v) {
  return SETTLEMENT_KEYS.includes(v) ? v : 'threshold';
}

// Structural + allowlist. 'threshold' is always present (the migration's
// default IS "you have stood in Threshold" — every save has), duplicates are
// dropped, unknown slugs are dropped rather than thrown on.
function sanitiseVisited(v) {
  const out = ['threshold'];
  if (Array.isArray(v)) {
    for (const s of v) {
      if (SETTLEMENT_KEYS.includes(s) && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

// An unknown string — a future build's class, a hand-edit — must NOT reach
// classes.applyLayers(); null ("no class") is always safe and always sane.
function sanitiseClassName(v) {
  return CLASS_KEYS.includes(v) ? v : null;
}

function sanitiseArchon(v) {
  return ARCHON_PATH_KEYS.includes(v) ? v : null;
}

// Same defensive posture as sanitiseAsh: tokens are spendable currency, so a
// corrupted wallet must never reach respec() as NaN (every NaN comparison is
// false, which would make the token path silently unreachable).
function sanitiseRespecTokens(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(99, Math.floor(v));
}

// Structural only, mirroring sanitiseShop(): whether a pact id still names a
// live roster entry is game/classes.js's business, not this module's. Every
// number is coerced finite and non-negative; affinity counters clamp to the
// spec's 9999 overflow guard with missing keys filled to 0.
function sanitiseArchonState(v) {
  const out = freshArchonState();
  if (!v || typeof v !== 'object') return out;
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  out.resource = num(v.resource);
  out.sigils = Math.floor(num(v.sigils));
  out.ascendedAt = Math.floor(num(v.ascendedAt));
  out.pacts = Array.isArray(v.pacts)
    ? v.pacts.filter((p) => p && typeof p === 'object' && Number.isFinite(p.id))
    : [];
  for (const k of ARCHON_PATH_KEYS) {
    out.affinity[k] = Math.max(0, Math.min(9999, Math.floor(num(v.affinity?.[k]))));
  }
  out.migTokenGranted = v.migTokenGranted === true;
  out.classTokenGranted = v.classTokenGranted === true;
  out.freeSealUsed = v.freeSealUsed === true;
  return out;
}

// Structural only. Whether a `sold` entry names a weapon that still exists is
// game/shop.js's business — this module deliberately does not import weapons.js
// (which pulls in THREE) merely to validate a string.
function sanitiseShop(v) {
  const band = (v && typeof v.band === 'number' && Number.isFinite(v.band)) ? Math.floor(v.band) : -1;
  const sold = (v && Array.isArray(v.sold)) ? v.sold.filter((s) => typeof s === 'string') : [];
  return { band, sold };
}

// An item INSTANCE is five short fields: kind, base id, rarity key, seed and
// the level it was rolled at. Nothing else is ever persisted, because a rolled
// stat line is exactly the thing that goes stale the next time the tables are
// tuned — weapons.js already enforces this and armour will obey it identically.
//
// Validation here is STRUCTURAL ONLY. Whether `b` names a weapon that still
// exists is game/weapons.js's business; this module deliberately does not
// import it (that would pull THREE into a module the headless progression test
// loads), exactly as sanitiseShop() refuses to validate a `sold` id.
function sanitiseItem(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.b !== 'string' || !v.b) return null;
  // Kind: 'w' weapon, 'a' armor, 't' trinket. ABSENT MEANS 'w' — that absence
  // IS the migration for every stash entry and every save.weapon ever written.
  const k = (v.k === 'a' || v.k === 't') ? v.k : (v.k === undefined || v.k === 'w' ? 'w' : null);
  if (k === null) return null;   // an unknown kind is dropped, never thrown on
  const s = Number.isFinite(v.s) ? (v.s >>> 0) : 0;
  const l = Number.isFinite(v.l) ? Math.max(1, Math.floor(v.l)) : 1;
  const r = typeof v.r === 'string' ? v.r : 'common';
  return { k, b: v.b, r, s, l };
}

/**
 * Bring `save` up to the eight-slot equipment model, in place. Idempotent, and
 * called first by every entry point — this is the migration, in the same shape
 * as game/shop.js's ensureShopSave, and for the same reason: an absent
 * `equipment` is indistinguishable from an empty one, so a schema bump would
 * buy nothing and cost every existing profile a reload path.
 *
 * The one real upgrade it performs: a pre-wave save has `save.weapon` and no
 * `save.equipment`, so the old single weapon is COPIED into the weapon slot.
 */
export function ensureEquipment(save) {
  if (!save || typeof save !== 'object') return save;
  const src = (save.equipment && typeof save.equipment === 'object') ? save.equipment : {};
  const out = freshEquipment();
  for (const slot of EQUIP_SLOTS) out[slot] = sanitiseItem(src[slot]);
  // v-old -> v-new: the one slot that already existed.
  if (!out.weapon) out.weapon = sanitiseItem(save.weapon);
  save.equipment = out;
  // The MIRROR. save.weapon keeps being written so a build rolled back to the
  // shipped version still finds the right sword instead of an empty fist —
  // save.js's own "leave the v1 key in place" note is the precedent for caring.
  save.weapon = out.weapon ? { b: out.weapon.b, r: out.weapon.r, s: out.weapon.s, l: out.weapon.l } : null;
  save.stash = (Array.isArray(save.stash) ? save.stash : [])
    .map(sanitiseItem)
    .filter(Boolean);
  return save;
}

/**
 * Upgrade any parsed save object to the v2 shape. Pure — no storage access —
 * so it is directly testable and so load() can decide what to persist.
 */
export function migrate(raw) {
  // ensureEquipment wraps every exit: migrate() is the one funnel load() and
  // the tests both go through, so putting the equipment upgrade here means no
  // caller can reach a save that has not had it applied.
  return ensureEquipment(_migrate(raw));
}

function _migrate(raw) {
  const base = freshSave();
  if (!raw || typeof raw !== 'object') return base;
  // The rig loader switches on this value, so the contract is exactly the two
  // strings — anything else (absent on older saves, or hand-edited) snaps back
  // to the default rather than leaking into entities.js.
  const playerBody = raw.playerBody === 'female' ? 'female' : 'male';
  if (raw.version === SCHEMA_VERSION && raw.shadows && Array.isArray(raw.shadows.roster)) {
    // Already v2: merge onto fresh so a build that adds a field stays safe.
    return withClassFields({
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
    }, raw);
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
  return withClassFields(out, raw);
}

// The classes-layer half of the migration, applied to BOTH the v1 and v2
// paths. Sanitises the four additive fields (the `...raw` spread above can
// carry hand-edited garbage for any of them), then performs the spec's one
// retroactive grant: a save already past the level-20 class gate gets one
// respec token, because directions and masteries change what a stat spread is
// worth and a player who spread flat under the old rules deserves one free
// look at the new ones. migTokenGranted is the once-guard — migrate() runs on
// EVERY load, and without the boolean each boot would mint another token.
function withClassFields(out, raw) {
  out.className = sanitiseClassName(raw.className);
  out.archon = sanitiseArchon(raw.archon);
  out.respecTokens = sanitiseRespecTokens(raw.respecTokens);
  out.archonState = sanitiseArchonState(raw.archonState);
  if (out.level >= 20 && !out.archonState.migTokenGranted) {
    out.archonState.migTokenGranted = true;
    out.respecTokens = Math.min(99, out.respecTokens + 1);
  }
  // The Wave B5 world fields ride the same funnel (this function wraps both
  // the v1 and v2 exits, exactly why the class fields live here): the `...raw`
  // spreads above can carry hand-edited garbage for either.
  out.settlement = sanitiseSettlement(raw.settlement);
  out.visited = sanitiseVisited(raw.visited);
  out.welcomed = Boolean(raw.welcomed);
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
