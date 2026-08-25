// The narrative strings module — Wave A item 5 / Wave C's foundation.
//
// WHY THIS FILE EXISTS: before it, player-facing copy lived at ~30 inline
// call sites (gate blurbs in config.js, door subs in citymode.js, panel copy
// in cityui.js/ui.js, toasts everywhere) — the audit's "narrative copy is
// scattered with no strings module" finding. A campaign multiplies text by
// 50x; it needs ONE home, or every line hard-codes itself into whatever file
// fires it, forever.
//
// SHAPE RULES:
// - Keys are dot-paths by SURFACE then MOMENT ('door.barracks.sealed',
//   'ledger.fulfilled'), not by speaker — the same character speaks on many
//   surfaces, but a surface renders one way. The ONE keyed-by-speaker family
//   is 'talk.*' (C-TALK), because there the speaker IS the surface: a talk
//   prompt is "stand in front of this person", and their act-state variants
//   ('talk.brann.act1' / 'act1b') are moments of that one surface.
// - Values are strings, functions (ctx) => string when a line interpolates
//   (player name, counts), or ARRAYS of strings when the surface is the
//   dialogue overlay — DialogUI.show takes a lines[] and one key per line
//   would scatter a single conversation across N keys with nothing keeping
//   them ordered or together. tLines() is the array-safe accessor; t() on an
//   array key returns its first line so no caller ever renders "[object".
//   Callers never concatenate story text themselves.
// - ALL-CAPS is the game's diegetic register for HUD/prompt lines (matches
//   every shipped toast); sentence case is reserved for dialogue bodies,
//   which arrive with the dialogue overlay.
// - Story content marked [BIBLE] traces to docs/STORY_BIBLE.md and is
//   PROVISIONAL until the owner approves the bible; mechanical copy (ledger,
//   errors) is not gated on that approval.
// - t(key, ctx) is total: a missing key returns the key itself in brackets —
//   a visible, greppable bug instead of a silent blank.
//
// Existing inline copy migrates here OPPORTUNISTICALLY: each Wave C wiring
// touch moves the lines of the surface it wires (never a big-bang sweep —
// that churns every file for zero player value).

export const STRINGS = {
  // ---- the Guild Ledger (daily contract) ---------------------------------
  // The original 'ledger.fulfilled'/'ledger.toast'/'ledger.fulfilledToday'
  // keys were retired unwired (review fix): F.4's daily payout needed streak
  // context and wired the self-contained 'ladder.daily.*' keys instead —
  // dead keys in THE strings home are exactly the drift this module exists
  // to prevent. Only the progress line survives from the first cut.
  'ledger.progress': (c) => `${c.progress} / ${c.target} GATES TODAY`,

  // ---- rank ceremony ------------------------------------------------------
  'rank.up': (c) => `YOU ASSAY AS ${c.rank}-GRADE NOW`,

  // ---- doors (diegetic venue lines; replace 'NOT YET OPEN') --------------
  'door.barracks.sealed': 'THE WATCH KEEPS ITS OWN COUNSEL — FOR NOW',      // [BIBLE]
  'door.trial.sealed': 'THE SEALED STAIR OPENS TO PROVEN HUNTERS',          // [BIBLE]
  'door.trial.ready': 'THE SEALED STAIR WAITS. GO DOWN AS YOU ARE.',        // [BIBLE]
  // The judged hunter's line (Wave F.2 authored it inline in citymode._trialSub
  // with a "[strings] migrate when the file is free" note — the file is free
  // this wave, so the literal moves home and the mode reads the key).
  'door.trial.done': 'THE STAIR REMEMBERS YOUR STEPS.',                     // [BIBLE]

  // ---- the First Voice (shadow whispers; Act-gated) ----------------------
  // Delivered one word/line at a time through the toast tier v1, the
  // dialogue overlay when it lands. Triggered at Bind commits.              [BIBLE]
  'voice.act1.first': '…more.',
  'voice.act1.second': '…the fire… holds?',
  'voice.act2.pressure': 'They are not coming through. They are being PUSHED.',
  'voice.act2.forest': 'Ours was a forest once. Ash falls there like snow falls here.',
  'voice.act3.named': 'I was the first to walk in. I am what walked back out. Part of me.',

  // ---- gate intro cards (Wave E per-rank identity rows) -------------------
  // Fired at intro end by dungeonmode._endIntro alongside the rank toast;
  // Wave G's per-rank intro card surface consumes the same keys when it
  // lands. Keyed by rank via layouts/identity.js RANK_IDENTITY.introKey.
  'gate.intro.E': 'A SHALLOW TEAR. LEARN WHICH END OF THE BLADE CUTS.',       // [BIBLE]
  'gate.intro.D': 'THE DEAD HERE KEEP THEIR RANKS. HOLD YOURS.',              // [BIBLE]
  'gate.intro.C': 'THE GLASS REMEMBERS EVERY LIGHT IT SWALLOWED.',            // [BIBLE]
  'gate.intro.B': 'CLIMB. THE FIRE ONLY EVER LOOKS DOWN.',                    // [BIBLE]
  'gate.intro.A': 'NO WALLS OUT HERE. THE WASTE DOES NOT NEED THEM.',         // [BIBLE]
  'gate.intro.S': 'THE REACH WAS BUILT TO BE CLIMBED ONCE.',                  // [BIBLE]
  // The summit arena's collapse beat (encounters.js arena-phase seam).
  'gate.arena.collapse': 'THE RIM GIVES WAY — THE CIRCLE TIGHTENS',

  // ---- band unlocks (Wave F.3: the 18/30/42 dead-zone riders) ------------
  // Ceremony toasts fired on the level crossing (game._grantXp). The rider
  // name arrives in ctx when the save has a sworn class; without one the line
  // points at the Assay Hall instead of naming a rider that does not exist
  // yet — both shapes are mechanical copy, so neither is [BIBLE]-gated.
  'band.unlock.technique': (c) => (c.name
    ? `TECHNIQUE  ·  ${c.name} — HOLD DASH`
    : 'A TECHNIQUE STIRS — IT WAITS ON A SWORN CLASS'),
  'band.unlock.attunement': (c) => (c.name
    ? `ATTUNEMENT  ·  ${c.name} — NOVA BEARS YOUR COLOUR`
    : 'AN ATTUNEMENT STIRS — IT WAITS ON A SWORN CLASS'),
  'band.unlock.oathwork': (c) => (c.name
    ? `OATHWORK  ·  ${c.name} — HOLD BIND AFIELD`
    : 'AN OATHWORK STIRS — IT WAITS ON A SWORN CLASS'),
  // The stance's own two lines (game._tryOath).
  'band.oath.begin': (c) => `${c.name}  ·  ${c.seconds}S`,
  'band.oath.notReady': 'THE OATH IS SPENT — IT RETURNS IN TIME',
  // Levelup-panel row labels (ui.js unlock list): the band's gesture, stated
  // once, beside UNLOCKED / LV NN exactly like the skill rows above it.
  'band.row.technique': 'TECHNIQUE — HOLD DASH',
  'band.row.attunement': 'ATTUNEMENT — NOVA TWIST',
  'band.row.oathwork': 'OATHWORK — HOLD BIND',

  // ---- the ladder past 53 (Wave F.4: weekly hunt + streaks) --------------
  // All mechanical copy (contracts, payouts, counters) — none is [BIBLE]-
  // gated, same ruling as the ledger family above. Consumers: game._clearGate
  // (toast + results rows) and journalui's ledger strips.
  //
  // The daily payout lines carry the STREAK inside the one key rather than as
  // a caller-side suffix ("callers never concatenate" applies to mechanical
  // copy too — a suffix bolted on at two call sites is how the toast and the
  // row drift apart). `flames` is the streak day count; day one renders the
  // shipped line shape exactly (no trailing fragment to explain).
  'ladder.daily.fulfilled': (c) => `CONTRACT FULFILLED  ·  +${c.points} POINTS${c.flames > 1 ? `  ·  FLAME ${c.flames}` : ''}`,
  'ladder.daily.toast': (c) => `GUILD LEDGER FULFILLED  ·  +${c.points} STAT POINTS${c.flames > 1 ? `  ·  FLAME ${c.flames}` : ''}`,
  // The ledger strip's flame counter (journalui) — the streak made visible
  // where the daily already lives. Only rendered while the chain is alive
  // (progression.dailyStreak owns that honesty).
  'ladder.streak.flame': (c) => `FLAME ${c.flames}`,
  // THE WEEKLY HUNT. The contract line is one key per modifier kind — the
  // three shapes genuinely differ (a count of gates vs a named head), and a
  // single mega-key switching internally would be the STRINGS module hiding
  // control flow the way inline copy used to.
  'ladder.weekly.title': 'WEEKLY HUNT',
  'ladder.weekly.desc.wild': (c) => `CLEAR ${c.target} WILD GATES`,
  'ladder.weekly.desc.anomaly': (c) => `CLEAR ${c.target} ANOMALOUS GATES`,
  'ladder.weekly.desc.boss': (c) => `FELL ${c.boss} ${c.target} TIMES`,
  'ladder.weekly.progress': (c) => `${c.progress} / ${c.target}`,
  'ladder.weekly.fulfilled': 'HUNT FULFILLED THIS WEEK',
  'ladder.weekly.toast': (c) => `WEEKLY HUNT FULFILLED  ·  +${c.xp} XP  ·  +1 RESPEC TOKEN`,
  'ladder.weekly.row': (c) => `FULFILLED  ·  +${c.xp} XP  ·  +1 RESPEC TOKEN`,

  // ---- quest surfaces -----------------------------------------------------
  'quest.new': (c) => `NEW CONTRACT  ·  ${c.title}`,
  'quest.advanced': (c) => `${c.title}  ·  ${c.progress} / ${c.count}`,
  'quest.complete': (c) => `CONTRACT COMPLETE  ·  ${c.title}`,

  // ---- street dialogue (C-TALK: the towns learn to speak) -----------------
  // Every body of dialogue below is [BIBLE]: cast, factions and arcs are
  // docs/STORY_BIBLE.md §5, PROVISIONAL until the owner approves it —
  // swapping a persona's voice is a strings-only edit by design.
  // Register per the bible's tone rule: speaker/role lines are ALL-CAPS (they
  // render in the HUD-register prompt and the overlay's speaker strip);
  // dialogue BODIES are sentence case, three sentences max, phone-readable.
  //
  // Act-state keys ('act1' / 'act2', Brann's 'act1b') are chosen by
  // citymode._talkStage off the quest ledger — the STAGE logic lives with the
  // mode; this file only owns the words, so a bible rewrite touches one file.
  'talk.speaker.veyra': 'ASSAYER VEYRA',                                    // [BIBLE]
  'talk.speaker.callun': 'MASTER CALLUN',                                   // [BIBLE]
  'talk.speaker.brann': 'WATCH-CAPTAIN BRANN',                              // [BIBLE]
  'talk.speaker.maren': 'MAREN',                                            // [BIBLE]
  'talk.speaker.hunter': 'A HUNTER',
  // The prompt's second line: the persona's post, so the prompt reads as a
  // person standing somewhere, not a floating name.
  'talk.role.veyra': 'THE ASSAY GUILD',                                     // [BIBLE]
  'talk.role.callun': 'THE EMBERWRIGHTS',                                   // [BIBLE]
  'talk.role.brann': 'THE WATCH',                                           // [BIBLE]
  'talk.role.maren': 'VERGEWALKER',                                         // [BIBLE]
  'talk.role.hunter': 'A WORD IN PASSING',

  // Veyra — dry, precise, tolerates the Bind until it stops being ignorable.
  'talk.veyra.act1': [                                                      // [BIBLE]
    'Contracts go up on the board; sigils come back to this desk. That is the whole liturgy of the hall.',
    'Your assay reads clean. What follows you home after a clear is your own business — until it becomes mine.',
  ],
  'talk.veyra.act2': [                                                      // [BIBLE]
    'The mark on that sigil is in no ledger I keep, and I keep all of them.',
    'Whatever spoke to you down there — it does not go in a file. The Guild burns what it fears reading.',
  ],
  // Callun — warm, loud, humor lives at the Exchange.
  'talk.callun.act1': [                                                     // [BIBLE]
    'Steel for ash, ash for steel. The only honest arithmetic left in Threshold, and I do the sums loudly.',
    'Carry out something heavy and bring it here. I will put an edge on it that outlives us both.',
  ],
  'talk.callun.act2': [                                                     // [BIBLE]
    'Gates past the wall now, they say. And still the queue at my counter grows — fear buys more steel than courage ever did.',
    'Whatever is pushing through out there has not met my forge-work yet. That is not a boast, it is a warranty.',
  ],
  // Brann — opens hostile to the Bind; act1b is the approval arc's FIRST beat,
  // keyed off a1_bind_three (three shadows walked past his wall and it stood).
  'talk.brann.act1': [                                                      // [BIBLE]
    'The Watch holds the Breach. What I want to know is who holds the thing at your heel.',
    'Things that fall should stay down, hunter. Inside my wall, keep yours on a short leash.',
  ],
  'talk.brann.act1b': [                                                     // [BIBLE]
    'Three of them walking at your heel now. I counted, because counting is my job.',
    'I still do not like what you do. But my wall stands quieter on the nights you work — so keep working.',
  ],
  // Maren — wild-gate tutor, pressure-theory heretic, right too early.
  'talk.maren.act1': [                                                      // [BIBLE]
    'The Guild calls the wild gates a mistake. Out here we call them what they are — new weather.',
    'Watch how a gate breathes before you walk it. The Verge teaches, or it buries.',
  ],
  'talk.maren.act2': [                                                      // [BIBLE]
    'They are not opening at us. Something on the far side is squeezing, and a gate is just where it leaks.',
    'I saw through a C-gate once — a forest of embers, and ash coming down like snow falls here.',
    'I have not slept the same since. Neither will you, once you look.',
  ],
  // The giver surfacing line: appended as the LAST line of a persona's
  // dialogue when a quest they gave is active — the contract acknowledged in
  // conversation, no new mechanics (the journal row's giver is already data).
  'talk.giver.active': (c) => `The contract stands — ${c.title}. See it done.`,

  // Ambient street-hunter pool: NOT act-gated (these are the town's weather,
  // not the campaign's), one line per chat, rotated by the mode so the same
  // hunter does not repeat himself back to back. 5 lines per the 4-6 spec.
  'talk.hunter.pool': [                                                     // [BIBLE]
    'Cleared a D-gate before sunrise. The walk home was the hard part.',
    'Ash is up at the Exchange again. Prices climb when the gates get strange.',
    'There are camps out in the Verge now. Vergewalkers — braver than smart, that lot.',
    'Assay it, walk it, carry it out, drink the difference. The trade is not complicated.',
    'My cousin swears he saw a gate open outside the wall. My cousin also swears he has quit drinking.',
  ],
};

/** Total lookup: missing keys come back visible and greppable, never blank. */
export function t(key, ctx = null) {
  const v = STRINGS[key];
  if (v === undefined) return `[${key}]`;
  // An array key asked for as a single line yields its first line — never
  // "[object Object]"-class garbage on a player's screen. tLines is the
  // intended accessor for dialogue bodies.
  if (Array.isArray(v)) return v[0];
  return typeof v === 'function' ? v(ctx || {}) : v;
}

/**
 * Total lookup for dialogue bodies: always an array, always a FRESH one (the
 * caller appends the giver-surfacing line; mutating the table would make the
 * appended contract line permanent for every later conversation — the exact
 * class of shared-mutable-state bug the strings module exists to prevent).
 * Missing keys come back as a one-line bracketed array, same visibility rule
 * as t().
 */
export function tLines(key, ctx = null) {
  const v = STRINGS[key];
  if (v === undefined) return [`[${key}]`];
  if (Array.isArray(v)) return v.slice();
  return [typeof v === 'function' ? v(ctx || {}) : v];
}
