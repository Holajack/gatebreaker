// The quest ledger — Wave C's campaign spine. Pure data + pure functions,
// THREE-free and DOM-free (importable by tools/ the way progression.js is).
//
// DESIGN, from the audit's progression findings:
// - Quests advance off EVENTS the game already emits at single funnels
//   (gate cleared at _clearGate, boss killed at the boss-kill site, shadow
//   bound at the Bind commit, level crossed in gainXp). The wiring is ONE
//   quests.onEvent(save, evt) call per funnel — no quest logic ever lives at
//   a call site.
// - save.quests follows the absent-means-default migration discipline
//   (save.js:62-92 precedent): { done: {id: dayStamp}, progress: {id: n} }.
//   Absent = fresh ledger. No schema bump.
// - Campaign CONTENT is [BIBLE]-gated (docs/STORY_BIBLE.md, owner approval
//   pending): the QUESTS table below ships Act I provisionally; the ENGINE
//   (state/advance/offer) is content-agnostic and not gated.
// - Quest XP is sized as a FRACTION of xpForLevel at the quest's band, never
//   a constant — the audit's "quest rewards sized against the curve or the
//   campaign paces like the 53-100 cliff" warning, made structural.
//
// An 'event' is { type, ...facts }:
//   { type:'gateCleared', rank, wild }   { type:'bossKilled', boss }
//   { type:'bound', creature }           { type:'levelReached', level }

import { xpForLevel } from './config.js';

/**
 * Act I (provisional, [BIBLE]): the trade learned honestly, the wild gates
 * that should not exist, the shadow that speaks. Each quest:
 * { id, act, title, giver, objective: {event, match?, count}, xpBand,
 *   unlock: (save, doneMap) => bool, beat? }
 * `beat` is the story line fired on completion (strings.js key) — the toast
 * tier carries it until the dialogue overlay lands.
 */
export const QUESTS = [
  {
    id: 'a1_first_assay',
    act: 1,
    title: 'THE FIRST ASSAY',
    giver: 'veyra',
    objective: { event: 'gateCleared', count: 1 },
    xpBand: 2,
    unlock: () => true,
  },
  {
    id: 'a1_the_warden',
    act: 1,
    title: 'THE WARDEN OF THE WARREN',
    giver: 'veyra',
    objective: { event: 'bossKilled', match: { boss: 'warden' }, count: 1 },
    xpBand: 4,
    unlock: (s, done) => Boolean(done.a1_first_assay),
    beat: 'voice.act1.first',        // the sigil carries a mark with no record
  },
  {
    id: 'a1_walk_the_verge',
    act: 1,
    title: 'WHAT OPENS UNWATCHED',
    giver: 'maren',
    objective: { event: 'gateCleared', match: { wild: true }, count: 1 },
    xpBand: 6,
    unlock: (s, done) => Boolean(done.a1_first_assay),
  },
  {
    id: 'a1_bind_three',
    act: 1,
    title: 'THINGS THAT DO NOT STAY DOWN',
    giver: 'veyra',
    objective: { event: 'bound', count: 3 },
    xpBand: 8,
    unlock: (s, done) => Boolean(done.a1_the_warden),
    beat: 'voice.act1.second',
  },
  {
    id: 'a1_the_gravelord',
    act: 1,
    title: 'THE GRAVELORD',
    giver: 'veyra',
    objective: { event: 'bossKilled', match: { boss: 'gravelord' }, count: 1 },
    xpBand: 12,
    unlock: (s, done) => Boolean(done.a1_bind_three) && Boolean(done.a1_walk_the_verge),
    beat: 'voice.act2.pressure',     // act break: the oath at 20 follows
  },
];

/** Reward: 60% of the gap to the next level at the quest's band. */
export function questXp(q) {
  return Math.round(xpForLevel(q.xpBand) * 0.6);
}

function ledger(save) {
  if (!save.quests) save.quests = { done: {}, progress: {} };
  if (!save.quests.done) save.quests.done = {};
  if (!save.quests.progress) save.quests.progress = {};
  return save.quests;
}

function matches(obj, evt) {
  if (obj.event !== evt.type) return false;
  if (obj.match) {
    for (const k of Object.keys(obj.match)) {
      if (evt[k] !== obj.match[k]) return false;
    }
  }
  return true;
}

/** Every quest currently offered/active: unlocked, not done. */
export function activeQuests(save) {
  const l = ledger(save);
  return QUESTS.filter((q) => !l.done[q.id] && q.unlock(save, l.done));
}

/**
 * Feed one game event through the ledger. Returns the list of
 * { quest, completed, progress } rows that CHANGED, so the caller can toast
 * each one and pay completions — the caller owns granting XP (it must ride
 * game.gainXp for ash parity) and firing `beat` lines.
 */
export function onEvent(save, evt) {
  const l = ledger(save);
  const out = [];
  for (const q of activeQuests(save)) {
    if (!matches(q.objective, evt)) continue;
    const n = (l.progress[q.id] || 0) + 1;
    if (n >= q.objective.count) {
      l.done[q.id] = Date.now();
      delete l.progress[q.id];
      out.push({ quest: q, completed: true, progress: q.objective.count });
    } else {
      l.progress[q.id] = n;
      out.push({ quest: q, completed: false, progress: n });
    }
  }
  return out;
}

/** The journal view: active with progress, then done ids (for the panel). */
export function journal(save) {
  const l = ledger(save);
  return {
    active: activeQuests(save).map((q) => ({
      id: q.id, title: q.title, giver: q.giver,
      progress: l.progress[q.id] || 0, count: q.objective.count,
    })),
    done: Object.keys(l.done),
  };
}
