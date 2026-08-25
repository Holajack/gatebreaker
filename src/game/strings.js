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
//   surfaces, but a surface renders one way.
// - Values are strings, or functions (ctx) => string when a line interpolates
//   (player name, counts). Callers never concatenate story text themselves.
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
  'ledger.progress': (c) => `${c.progress} / ${c.target} GATES TODAY`,
  'ledger.fulfilledToday': 'CONTRACT FULFILLED TODAY',
  'ledger.fulfilled': (c) => `CONTRACT FULFILLED  ·  +${c.points} POINTS`,
  'ledger.toast': (c) => `GUILD LEDGER FULFILLED  ·  +${c.points} STAT POINTS`,

  // ---- rank ceremony ------------------------------------------------------
  'rank.up': (c) => `YOU ASSAY AS ${c.rank}-GRADE NOW`,

  // ---- doors (diegetic venue lines; replace 'NOT YET OPEN') --------------
  'door.barracks.sealed': 'THE WATCH KEEPS ITS OWN COUNSEL — FOR NOW',      // [BIBLE]
  'door.trial.sealed': 'THE SEALED STAIR OPENS TO PROVEN HUNTERS',          // [BIBLE]
  'door.trial.ready': 'THE SEALED STAIR WAITS. GO DOWN AS YOU ARE.',        // [BIBLE]

  // ---- the First Voice (shadow whispers; Act-gated) ----------------------
  // Delivered one word/line at a time through the toast tier v1, the
  // dialogue overlay when it lands. Triggered at Bind commits.              [BIBLE]
  'voice.act1.first': '…more.',
  'voice.act1.second': '…the fire… holds?',
  'voice.act2.pressure': 'They are not coming through. They are being PUSHED.',
  'voice.act2.forest': 'Ours was a forest once. Ash falls there like snow falls here.',
  'voice.act3.named': 'I was the first to walk in. I am what walked back out. Part of me.',

  // ---- quest surfaces -----------------------------------------------------
  'quest.new': (c) => `NEW CONTRACT  ·  ${c.title}`,
  'quest.advanced': (c) => `${c.title}  ·  ${c.progress} / ${c.count}`,
  'quest.complete': (c) => `CONTRACT COMPLETE  ·  ${c.title}`,
};

/** Total lookup: missing keys come back visible and greppable, never blank. */
export function t(key, ctx = null) {
  const v = STRINGS[key];
  if (v === undefined) return `[${key}]`;
  return typeof v === 'function' ? v(ctx || {}) : v;
}
