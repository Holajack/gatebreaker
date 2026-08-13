// The hunter's sheet: eight equipment slots, everything the character is, and
// the stow/draw toggle the owner asked for in the plaza.
//
// It is an OVERLAY, not an AppState screen, and that is the same deliberate
// call shopui.js documents: AppState.go('city') calls Game.enterCity, which
// calls _setMode, which DISPOSES AND REBUILDS the entire city and teleports the
// player back to spawn. Routing this panel through the router would tear down
// 200-odd draw calls of town every time the player closed his own inventory.
// So it behaves like #shop and #levelup — a fixed overlay toggled by classList,
// with main.js's hardware-back chain taught one more id.
//
// Constructed ONCE, in main.js, beside the ShopUI. Rebuilding the DOM per open
// would leak an #inv node per visit; main.js already records that lesson about
// the shop.
//
// WAVE 3-B STEP 13: the five armour slots and the trinket are LIVE. Equipping
// is a deliberate two-step — tap a stash row, read the delta strip, confirm —
// because an armour swap changes combat numbers and a player on a phone
// deserves to see WHICH numbers before committing. Only the offhand still says
// "not yet": no offhand item exists in any table this wave, and a slot that
// pretends is worse than a slot that says so.
//
// Every node is built with createElement/textContent. Weapon names come out of
// rollWeapon's buildName, but the repo's standing rule is that a markup sink is
// a markup sink whatever you believe about its inputs today.

import { EQUIP_SLOTS } from '../core/save.js';
import {
  rarityColor, RARITIES, weaponSummary, weaponStance, weaponModelName, WEAPONS,
} from '../game/weapons.js';
// The armour half of the sheet: definitions for the slot filter and lock
// checks, deserializeArmor to turn a stashed {k,b,r,s,l} record back into the
// exact rolled piece, armorSummary/setProgress for the readouts.
import {
  ARMOR_BASES, SETS, SET_THRESHOLDS, setProgress, deserializeArmor, armorSummary,
} from '../game/armor.js';
import { STATS, STAT_RATES, RANKS, derive, rankOf, xpForLevel } from '../game/config.js';
// shopBand: the ONE rank-band computation, shared with the Exchange so the two
// panels can never disagree about who counts as a B-grade hunter.
import { shopBand } from '../game/shop.js';
// The ascension entry (RPG_SPEC step 14): the panel prints the recipe and the
// refusal reasons straight from ascension.js — game.ascendEquipped() is the
// commit, so this panel never touches the ledger itself.
import { ascensionRecipe, canAscend, SIGIL_LABEL } from '../game/ascension.js';
import { effectiveStat, shadowRosterCapacity } from '../game/progression.js';
// The identity layers (CLASSES_SPEC step 3). applyLayers is the SAME fold
// game.refreshDerived runs, so this tab can never disagree with combat; the
// direction/mastery/resonance readers are pure and drive the new rows.
import {
  DIRECTIONS, MASTERY_THRESHOLDS, CLASSES, CLASS_QUALITY,
  directionOf, masteryTier, resonanceOf, applyLayers,
} from '../game/classes.js';
// Armour-look refresh (RPG_SPEC step 12 left this exact call for step 13):
// after an equip/unequip the hunter's silhouette must follow the save, and
// these three are the same sequence game.setPlayerBody already runs. animateRig
// settles the fresh rig into idle immediately — inside a paused gate nothing
// else ticks the player, so without it the new body holds a T-pose until the
// panel closes.
import { setPlayerArmorLook, rebuildHumanoid, animateRig } from '../game/entities.js';
import { iconStyle } from './icons.js';

// The shared stash cap. game.js:73 owns enforcement (every stash write there
// trims to it, and _persistLoadout slices the persisted concat to it); this
// constant exists so the panel can REFUSE an unequip that would push past the
// cap instead of letting the persist path silently drop the tail record.
// 40 is the spec number (RPG_SPEC savePersistence.stashLimit: armour fills the
// old 12 in a single D-rank dungeon; 40 records x 5 short fields is nothing).
const STASH_LIMIT = 40;

// Slot metadata. `kind` is the item kind the slot accepts, matching the save
// record's `k` field, so the GEAR list filter is a single comparison rather
// than a per-slot special case.
const SLOTS = {
  weapon: { name: 'WEAPON', kind: 'w', icon: 'sword', live: true, blurb: 'The family decides how combat FEELS: reach, arc, commitment, recovery.' },
  offhand: { name: 'OFFHAND', kind: 'o', icon: 'arrow', live: false, blurb: 'Quiver, focus or parry token. Arrives with the bow and the staff.' },
  head: { name: 'HEAD', kind: 'a', icon: 'crown', live: true, blurb: 'Perception: earlier enemy tells, harder crits.' },
  chest: { name: 'CHEST', kind: 'a', icon: 'armor_metal', live: true, blurb: 'The slab. The largest single armour contribution, and max health.' },
  hands: { name: 'HANDS', kind: 'a', icon: 'glove', live: true, blurb: 'Weapon handling: attack speed, and a shave off recovery.' },
  legs: { name: 'LEGS', kind: 'a', icon: 'armor_leather', live: true, blurb: 'Mobility: move speed and a wider perfect-dodge window.' },
  feet: { name: 'FEET', kind: 'a', icon: 'bone', live: true, blurb: 'Footing: stagger resistance, and less knockback taken.' },
  trinket: { name: 'TRINKET', kind: 't', icon: 'ring3', live: true, blurb: 'One exotic effect. No armour at all — leech, luck, ash-find.' },
};

// The compare strip's row table, one entry per number an armour piece can
// carry. Values come off the ROLLED INSTANCE fields directly rather than
// re-parsing armorSummary's formatted strings — a delta needs the number, not
// the label. Every field here is higher-is-better (knockTaken is the CUT taken
// off incoming knockback, so more cut is strictly better), which is what lets
// one sign convention colour the whole strip.
const CMP_ROWS = [
  ['Armor', (a) => a.ap, (v) => String(Math.round(v)), (d) => `${d > 0 ? '+' : ''}${Math.round(d)}`],
  ['Health', (a) => a.hpAdd, (v) => `+${Math.round(v)}`, (d) => `${d > 0 ? '+' : ''}${Math.round(d)}`],
  ['Tell lead', (a) => a.tellAdd, (v) => `+${Math.round(v)}ms`, (d) => `${d > 0 ? '+' : ''}${Math.round(d)}ms`],
  ['Crit dmg', (a) => a.critDmgAdd, (v) => `+${Math.round(v * 100)}%`, (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`],
  ['Atk speed', (a) => a.atkSpeedAdd, (v) => `+${(v * 100).toFixed(1)}%`, (d) => `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%`],
  ['Speed', (a) => a.speedAdd, (v) => `+${v.toFixed(2)}`, (d) => `${d > 0 ? '+' : ''}${d.toFixed(2)}`],
  ['Dodge window', (a) => a.dodgeAdd, (v) => `+${Math.round(v * 1000)}ms`, (d) => `${d > 0 ? '+' : ''}${Math.round(d * 1000)}ms`],
  ['Stagger resist', (a) => a.staggerResist, (v) => `+${Math.round(v * 100)}%`, (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`],
  ['Knockback cut', (a) => a.knockTaken, (v) => `+${Math.round(v * 100)}%`, (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`],
  ['Leech', (a) => a.leech, (v) => `+${(v * 100).toFixed(1)}%`, (d) => `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%`],
  ['Ash found', (a) => a.ashFind, (v) => `+${Math.round(v * 100)}%`, (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`],
];

// Labels + formatters for every derived field the class layer can touch, so
// the CLASS section can print "what this class DID to you" as base -> final
// rows straight off the two derived blocks rather than re-deriving the term
// maths. Keys the layer never moved simply do not appear.
const fmtMs = (v) => `${Math.round(v * 1000)}ms`;
const CLASS_FIELD_LABEL = {
  maxHp: ['Max health', (v) => String(Math.round(v))],
  maxMp: ['Max mana', (v) => String(Math.round(v))],
  atk: ['Attack power', (v) => v.toFixed(1)],
  speed: ['Move speed', (v) => v.toFixed(2)],
  crit: ['Crit chance', pctLater],
  critDmg: ['Crit damage', (v) => `x${v.toFixed(2)}`],
  atkSpeed: ['Attack speed', pctLater],
  skillMul: ['Skill power', (v) => `x${v.toFixed(2)}`],
  cdr: ['Cooldown cut', pctLater],
  dr: ['Damage reduction', pctLater],
  hpRegen: ['Health regen', (v) => `${v.toFixed(2)}/s`],
  mpRegen: ['Mana regen', (v) => `${v.toFixed(2)}/s`],
  dmgFloor: ['Damage floor', pctLater],
  tellLeadMs: ['Enemy tell', (v) => `${Math.round(v)}ms`],
  dodgeWindow: ['Dodge window', fmtMs],
  shadowDmgMul: ['Shadow damage', (v) => `x${v.toFixed(2)}`],
  dashCd: ['Dash cooldown', (v) => `${v.toFixed(2)}s`],
  dashDistance: ['Dash distance', (v) => `${v.toFixed(1)}m`],
  dashIframes: ['Dash i-frames', fmtMs],
  knockTakenMul: ['Knockback taken', (v) => `x${v.toFixed(2)}`],
};
// pct() is declared below with the other helpers; alias through a function so
// the table above can reference it before its const initialises.
function pctLater(v) { return pct(v); }

// Trinket effect labels, shared with armorSummary's own table.
const TRINKET_LABEL = {
  leech: 'Leech', ashFind: 'Ash found', luck: 'Luck', mpRegen: 'Mana regen', extract: 'Bind chance',
};
const trinketFmt = (key, v) => (key === 'mpRegen' ? `+${v.toFixed(1)}/s` : `+${(v * 100).toFixed(1)}%`);

// Rank pill classes already exist in styles.css (.rank-E .. .rank-SOVEREIGN),
// so the panel's rank badge is the same colour as the gate the player is
// allowed into. Reusing them is what keeps two screens from disagreeing.
const CSS = `
/* .screen is z-index 20 and #cityUi is 40, so without this the district
   banner and the live OPEN button render ON TOP of the panel and eat taps —
   the same fix #shop needed, for the same reason. */
#inv { z-index: 60; }
body.gb-inv #cityUi { display: none !important; }

#inv .panel { max-height: 92vh; gap: 10px; }
#inv .inv-wallet {
  display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  border: 1px solid var(--edge); border-radius: 10px;
  padding: 8px 12px; font-size: 12px; letter-spacing: .1em;
  background: rgba(124,92,255,.07);
}
#inv .inv-wallet b { color: var(--ink); }
#inv .inv-wallet .ash b { color: var(--gold); }
#inv .inv-wallet span { color: var(--dim); }

/* Two side-by-side scrolling columns, and this is not a style preference.
   Panel padding + h2 + the wallet strip eat ~120 px of a 412 px-tall landscape
   phone; ~290 px is left, and the sheet has strictly more content than the
   Exchange's eight-row shelf that already needed a scroll box. A single
   vertical list would be a peephole. */
#inv .cols { display: flex; gap: 10px; align-items: flex-start; }
#inv .slots {
  display: grid; grid-template-columns: repeat(2, 56px); gap: 5px; flex: 0 0 auto;
}
/* THE PANEL USES THE WHOLE PHONE. .panel.wide is 560 px, which on an 892 px
   landscape window left ~330 px of empty gutter while 63% of the sheet's body
   sat below a 214 px fold — the stash list was entirely off-screen with no cue
   that it existed. Nothing about a character sheet wants to be 560 px wide on a
   screen that is 892. The generic .panel cap stays put for every other overlay;
   only this one is content-dense enough to need the room. */
#inv .panel { width: min(880px, 100%); }

#inv .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
/* The tabs live OUTSIDE the scroll box now. They used to be the first children
   of the scrolling column, so scrolling the sheet carried the only control that
   switches tabs off the top of it. */
#inv .colwrap { position: relative; min-height: 0; }
#inv .col { max-height: min(52vh, 300px); overflow-y: auto; }

/* THE SCROLLBAR THAT WASN'T (the shipped 3-A clip bug). The old block set the
   standard scrollbar-width property AND ::-webkit-scrollbar rules; per spec
   the standard property wins the moment it is present, so the "always drawn"
   webkit track never rendered anywhere. Worse, measured on this project's own
   harness Chromium (and on any macOS/Android build with overlay scrollbars),
   even a PURE ::-webkit-scrollbar customisation stays an overlay bar that is
   invisible until you already scroll: col.offsetWidth - col.clientWidth === 0
   with 460+ px of content hidden below the fold and nothing but a MORE hint.
   Native scrollbars are platform policy, not CSS — so the panel now draws its
   OWN rail: a track + thumb positioned from scrollTop by _updateScrollHint,
   pointer-events none (it is an affordance, not a control — the column itself
   is the touch scroller). The native bar is suppressed on both engines so the
   rail is THE scrollbar rather than a second one behind it. */
#inv .col { scrollbar-width: none; }
#inv .col::-webkit-scrollbar { display: none; width: 0; }
/* Reserve the rail's lane so row values never sit under the thumb — the other
   half of the shipped bug was the right column's numbers clipping against the
   panel edge with nothing to say why. */
#inv .col { padding-right: 12px; }
#inv .rail {
  position: absolute; right: 0; top: 2px; bottom: 2px; width: 6px;
  border-radius: 3px; background: rgba(255,255,255,.08); pointer-events: none;
}
#inv .rail .thumb {
  position: absolute; left: 0; right: 0; border-radius: 3px;
  background: rgba(124,92,255,.65); min-height: 24px;
}
#inv .colwrap.no-scroll .rail { display: none; }
#inv .morehint {
  position: absolute; left: 0; right: 0; bottom: 0; height: 34px;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 2px; pointer-events: none; opacity: 1; transition: opacity .15s;
  background: linear-gradient(to bottom, rgba(12,14,28,0), rgba(12,14,28,.94));
  color: var(--accent2); font-size: 9.5px; letter-spacing: .18em; font-weight: 800;
}
#inv .colwrap.at-end .morehint, #inv .colwrap.no-scroll .morehint { opacity: 0; }

/* The body splits again inside the column. On a landscape phone the sheet is
   wide and SHORT, so the fix for "the stash is below the fold" is to put the
   stash beside the equipped card rather than under it. Narrow windows stack. */
#inv .body2 { display: flex; gap: 10px; align-items: flex-start; }
#inv .body2 > .pane { flex: 1 1 0; min-width: 0; }
@media (max-width: 620px) { #inv .body2 { display: block; } }

#inv .slot {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 3px; border-radius: 9px; border: 1px solid transparent;
  background: rgba(124,92,255,.05); cursor: pointer; font: inherit; color: var(--dim);
}
/* 44 px is this repo's tap-target floor; the cell is a secondary target so it
   sits right on it rather than at cityui's 56 px thumb minimum. */
#inv .slot i { width: 44px; height: 44px; border-radius: 8px; border: 2px solid rgba(180,190,220,.22); }
#inv .slot small { font-size: 9px; letter-spacing: .06em; }
#inv .slot.sel { border-color: var(--accent); background: rgba(124,92,255,.2); }
#inv .slot.sel small { color: var(--ink); }
#inv .slot.locked { opacity: .55; }

#inv .tabs { display: flex; gap: 6px; margin-bottom: 8px; }
/* min-height 44: the tabs and the footer are TAP TARGETS, and 26-31 px tall
   bars (measured at 915x412 before this rule) sit under the repo's 44 px
   floor however wide they are. The scroll column pays the ~30 px — it has a
   rail and a MORE hint; a mis-tapped tab has nothing. */
#inv .tabs button {
  flex: 1; padding: 7px 4px; border: 1px solid var(--edge); border-radius: 8px;
  background: transparent; color: var(--dim); font: inherit; font-size: 11px;
  letter-spacing: .12em; cursor: pointer; min-height: 44px;
}
#inv .tabs button.on { background: rgba(124,92,255,.18); color: var(--ink); border-color: var(--accent); font-weight: 800; }

/* shopui.js measured this: the gate row's 44 px swatch and 13 px padding fit
   two rows in a 412 px window, and 9px/36px fits nearly four. That is the
   difference between a list and a peephole, and it applies verbatim here. */
#inv .gate { padding: 8px 10px; gap: 10px; }
#inv .gate i { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 8px; }
#inv .gate .meta b { font-size: 13px; }
#inv .gate .meta small { font-size: 10.5px; }
#inv .gate .tagline { color: var(--dim); font-size: 10.5px; white-space: nowrap; letter-spacing: .08em; }
#inv .gate.on { border-color: var(--accent); background: rgba(124,92,255,.18); }
#inv .gate.on .tagline { color: var(--accent2); }
#inv .gate.locked { opacity: .55; }

/* The compare strip: label | equipped | candidate(delta). It REPLACES the
   stash list in its pane rather than floating over the sheet — at 412 px there
   is no room for a third layer, and a modal-on-modal is exactly the tap-eating
   stack the z-index note above exists to prevent. */
#inv .cmp { border: 1px solid var(--accent); border-radius: 10px; padding: 9px 11px; background: rgba(124,92,255,.08); }
#inv .cmp .crow { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; padding: 2px 0; }
#inv .cmp .crow > span { color: var(--dim); flex: 1 1 auto; letter-spacing: .04em; }
#inv .cmp .crow .cur { color: var(--dim); text-align: right; flex: 0 0 auto; min-width: 44px; }
#inv .cmp .crow .cand { color: var(--ink); font-weight: 700; text-align: right; flex: 0 0 auto; min-width: 72px; }
#inv .cmp .delta.up { color: #54e08a; }
#inv .cmp .delta.down { color: var(--danger); }
#inv .cmp .cmp-foot { display: flex; gap: 8px; margin-top: 8px; }
/* 44 px floor: EQUIP is the commit control of the whole panel — the one
   button that must never be a squint target on a phone. */
#inv .cmp .cmp-foot .btn { flex: 1; padding: 9px; font-size: 12px; min-height: 44px; }
#inv .cmp .cmp-reason { color: var(--danger); font-size: 10.5px; letter-spacing: .1em; margin-top: 6px; }

/* No leg icon exists in the 108-key atlas, so a legs piece reuses its set's
   chest icon DESATURATED — legible as "same set, different piece" instead of
   mistakable for the chest itself. Flagged in RPG_SPEC openQuestions. */
#inv .desat { filter: saturate(.35) brightness(.9); }

/* LEGENDARY rows read as the top of the ladder at a glance: the gold border
   the rarity tint already provides, plus a soft outer bloom. This is UI
   chrome, not a scene material — the no-glow-on-living-characters law governs
   meshes, and a DOM box-shadow is neither rim nor emissive. */
#inv .gate.leg {
  border-color: rgba(255,194,75,.75);
  background: linear-gradient(90deg, rgba(255,194,75,.14), rgba(255,194,75,.04));
  box-shadow: 0 0 10px rgba(255,194,75,.28);
}
#inv .rule {
  border: 1px solid rgba(255,194,75,.6); border-radius: 10px;
  padding: 9px 11px; background: rgba(255,194,75,.07);
  color: var(--ink); font-size: 11.5px; line-height: 1.6;
}
#inv .rule b { color: #ffc24b; letter-spacing: .12em; display: block; margin-bottom: 2px; }

/* The ascension recipe: three requirement rows and the one commit button.
   Requirement rows go green as they are met, so the block doubles as the
   shopping list for the grind. */
#inv .asc { border: 1px solid var(--edge); border-radius: 10px; padding: 9px 11px; background: rgba(255,194,75,.05); }
#inv .asc .crow { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; padding: 2px 0; }
#inv .asc .crow span { color: var(--dim); flex: 1 1 auto; letter-spacing: .06em; }
#inv .asc .crow b { flex: 0 0 auto; }
#inv .asc .crow.met b { color: #54e08a; }
#inv .asc .crow.unmet b { color: var(--danger); }
#inv .asc .btn { width: 100%; margin-top: 8px; padding: 9px; font-size: 12px; min-height: 44px; }
#inv .asc .asc-reason { color: var(--danger); font-size: 10.5px; letter-spacing: .1em; margin-top: 6px; }

#inv .note {
  border: 1px dashed rgba(255,255,255,.16); border-radius: 10px;
  padding: 10px 12px; color: var(--dim); font-size: 11.5px; line-height: 1.7;
}
#inv .note b { color: var(--ink); }
#inv .sect { color: var(--accent2); font-size: 10.5px; letter-spacing: .18em; margin: 10px 0 3px; }
#inv .sect:first-child { margin-top: 0; }
#inv .readout .row small { color: var(--dim); font-size: 10px; letter-spacing: .04em; }
#inv .foot { display: flex; gap: 8px; }
#inv .foot .btn { padding: 10px; font-size: 13px; min-height: 44px; }
#inv .unequip { margin-top: 6px; padding: 9px; font-size: 12px; width: 100%; min-height: 44px; }

/* Desktop Chrome and portrait have the room to stack, so they do — two 300 px
   columns side by side on a 900 px-wide window is mostly empty gutter. */
@media (min-width: 700px) and (min-height: 620px) {
  #inv .cols { display: block; }
  #inv .slots { grid-template-columns: repeat(4, 56px); margin-bottom: 10px; }
  #inv .col { max-height: 44vh; }
}

/* A landscape phone is the tightest case in the game: ~412 px tall with a
   notch. Every row reclaimed here is a row of the sheet the player can read
   without scrolling, so the chrome gives up its height first. */
@media (orientation: landscape) and (max-height: 520px) {
  #inv .panel { max-height: 96vh; padding: 10px 14px; gap: 6px; }
  #inv .panel h2 { font-size: 15px; letter-spacing: .16em; }
  #inv .inv-wallet { padding: 4px 10px; font-size: 11px; }
  #inv .tabs { margin-bottom: 5px; }
  #inv .tabs button { padding: 5px 4px; }
  #inv .foot .btn { padding: 7px; font-size: 12px; }
  /* Let the scroll box take every pixel the panel is not using, instead of a
     52vh guess that left the panel itself scrolling underneath. The panel is
     the frame; exactly one thing inside it scrolls, and it is the column. */
  #inv .panel { overflow: hidden; }
  /* stretch, NOT the flex-start the wide layout wants: with flex-start the
     right-hand column keeps its CONTENT height, so it grows straight through
     the footer buttons instead of handing the overflow to its scroll box. */
  #inv .cols { flex: 1 1 auto; min-height: 0; align-items: stretch; }
  #inv .right { min-height: 0; }
  #inv .colwrap { flex: 1 1 auto; min-height: 0; display: flex; }
  #inv .col { flex: 1 1 auto; min-height: 0; max-height: none; }
}
`;

let _styleEl = null;
function ensureStyle() {
  if (_styleEl && _styleEl.isConnected) return;
  _styleEl = document.createElement('style');
  _styleEl.id = 'invUiStyle';
  _styleEl.textContent = CSS;
  document.head.appendChild(_styleEl);
}

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function row(label, value, sub) {
  const r = el('div', 'row');
  const left = el('span', null, label);
  if (sub) { const s = el('small', null, `  ${sub}`); left.appendChild(s); }
  r.appendChild(left);
  r.appendChild(el('b', null, value));
  return r;
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/** The icon key for a rolled weapon: the pack model name, lowercased. */
function weaponIcon(w) {
  if (!w) return null;
  const model = weaponModelName(w);
  if (model) return model.toLowerCase();
  // Procedural weapons return null from weaponModelName on purpose — but the
  // staff's HEAD is a real pack crystal (look.head Crystal2/Crystal4) and the
  // atlas carries those exact keys, so the head icon is an honest icon, not a
  // stand-in. The polearm has no such donor piece anywhere in the pack; its
  // grey cell stays the truthful answer and iconStyle renders one for an
  // unknown key.
  const head = (w.base || WEAPONS?.[w.baseId])?.look?.head;
  if (head) return head.toLowerCase();
  return null;
}

export class InventoryUI {
  /**
   * @param {{game:object, audio?:object, root?:HTMLElement}} opts
   *   `game` is the live Game. Weapon equips go through game.equipFromStash and
   *   armour equips through this panel's own swap over save.equipment — both
   *   persist through game._persistLoadout -> onSave, which writes the WHOLE
   *   save in one go. This panel never writes localStorage itself: two writers
   *   is how a wallet and an inventory drift apart.
   */
  constructor({ game, audio = null, root = document.body } = {}) {
    ensureStyle();
    this.game = game || null;
    this.audio = audio || game?.audio || null;
    this._open = false;
    this._slot = 'weapon';
    this._tab = 'gear';
    // Index into game.armorStash of the candidate whose compare strip is up,
    // or -1 for none. Cleared by every slot/tab change — a strip comparing a
    // helmet must not survive into the chest slot's list.
    this._cmp = -1;
    // Set on open() and honoured on close(): opening the sheet inside a gate
    // pauses the sim, opening it in the city does not. The asymmetry is
    // deliberate — a loadout decision under threat should not get you eaten,
    // and the city is safe (the Exchange does not pause either). Without this
    // flag, closing the panel in the city would un-pause a game that a
    // separate pause menu had legitimately paused.
    this._pausedByUs = false;
    // Set by whoever opened the panel; called once on close. main.js uses it to
    // put the PAUSE screen back when the sheet was opened from it — without
    // that, hiding #pause to show this and then closing this leaves the game
    // paused with no panel on screen and no way to resume. A soft-lock.
    this.onClose = null;
    // The stance-label poll (see open()). Kept on the instance so close() can
    // stop it; null while the sheet is closed.
    this._stancePoll = null;

    const screen = el('div', 'screen overlay hidden');
    screen.id = 'inv';

    const panel = el('div', 'panel wide');
    panel.appendChild(el('h2', null, 'THE HUNTER'));

    const wallet = el('div', 'inv-wallet');
    const lv = el('span', null, 'LV ');
    this.lvValue = el('b', null, '1');
    lv.appendChild(this.lvValue);
    const rk = el('span', null, 'RANK ');
    this.rankValue = el('b', null, 'E');
    rk.appendChild(this.rankValue);
    const xp = el('span', null, 'NEXT ');
    this.xpValue = el('b', null, '0');
    xp.appendChild(this.xpValue);
    const ash = el('span', 'ash', 'ASH ');
    this.ashValue = el('b', null, '0');
    ash.appendChild(this.ashValue);
    wallet.append(lv, rk, xp, ash);
    panel.appendChild(wallet);

    const cols = el('div', 'cols');
    this.slotsEl = el('div', 'slots');
    this.slotsEl.id = 'invSlots';
    cols.appendChild(this.slotsEl);

    const right = el('div', 'right');
    this.tabsEl = el('div', 'tabs');
    for (const [key, label] of [['gear', 'GEAR'], ['stats', 'STATS'], ['sets', 'SETS']]) {
      const b = el('button', null, label);
      b.type = 'button';
      b.dataset.tab = key;
      b.addEventListener('click', () => { this.audio?.ui?.(); this._tab = key; this._cmp = -1; this.render(); });
      this.tabsEl.appendChild(b);
    }
    right.appendChild(this.tabsEl);

    // The scroll box and its "there is more" affordance. Kept as real elements
    // rather than a CSS-only shadow because the hint has to know when it has
    // reached the end, and that is a scroll position, not a style.
    this.colWrap = el('div', 'colwrap');
    this.colEl = el('div', 'col');
    this.colEl.id = 'invCol';
    this.bodyEl = el('div', null);
    this.bodyEl.id = 'invBody';
    this.colEl.appendChild(this.bodyEl);
    this.colWrap.appendChild(this.colEl);
    this.moreHint = el('div', 'morehint', 'MORE BELOW  ▼');
    this.colWrap.appendChild(this.moreHint);
    // The panel-owned scrollbar (see the .rail CSS note): native bars are
    // overlay-or-nothing platform policy, so the sheet draws its own.
    this.railEl = el('div', 'rail');
    this.thumbEl = el('div', 'thumb');
    this.railEl.appendChild(this.thumbEl);
    this.colWrap.appendChild(this.railEl);
    this.colEl.addEventListener('scroll', () => this._updateScrollHint(), { passive: true });
    right.appendChild(this.colWrap);
    cols.appendChild(right);
    panel.appendChild(cols);

    const foot = el('div', 'foot');
    // The plaza show-off control, in the owner's own words: "the sword can be
    // visible or placed in the inventory". Long-pressing attack and desktop's
    // X key do the same thing; this is the discoverable one.
    this.stanceBtn = el('button', 'btn', 'SHEATHE');
    this.stanceBtn.id = 'invStance';
    this.stanceBtn.type = 'button';
    this.stanceBtn.addEventListener('click', () => this._toggleStance());
    foot.appendChild(this.stanceBtn);

    const close = el('button', 'btn ghost', 'CLOSE');
    close.id = 'invClose';
    close.type = 'button';
    close.addEventListener('click', () => { this.audio?.ui?.(); this.close(); });
    foot.appendChild(close);
    panel.appendChild(foot);

    screen.appendChild(panel);
    root.appendChild(screen);
    this.root = screen;
  }

  get isOpen() { return this._open; }

  open() {
    if (!this.game) return false;
    this._slot = 'weapon';
    this._cmp = -1;
    this.render();
    this.root.classList.remove('hidden');
    document.body.classList.add('gb-inv');
    this._open = true;
    // In a gate this is a loadout decision under threat; in the city it is
    // shopping. See _pausedByUs.
    if (this.game.state === 'playing' && this.game.mode?.name !== 'city') {
      this.game.pause(true);
      this._pausedByUs = true;
    }
    // THE STALE-LABEL FIX (shipped 3-A bug). In the city the sim keeps running
    // under the sheet, so the auto-stow policy can sheathe the sword while the
    // button still reads SHEATHE — and the old handler then toggled off the
    // LIVE stance, so tapping the stale button did the exact opposite of what
    // it said. Two halves to the fix: this poll keeps the label honest while
    // the sheet is open (300 ms is far inside the 3 s auto-sheath timer), and
    // _toggleStance now applies what the LABEL promises rather than a blind
    // toggle, so even a tap that races the poll does what the player read.
    this._stancePoll = setInterval(() => this._renderStanceBtn(), 300);
    return true;
  }

  close() {
    this.root.classList.add('hidden');
    document.body.classList.remove('gb-inv');
    this._open = false;
    if (this._stancePoll) { clearInterval(this._stancePoll); this._stancePoll = null; }
    if (this._pausedByUs) {
      this._pausedByUs = false;
      this.game?.pause?.(false);
    }
    const cb = this.onClose;
    // Cleared BEFORE the call: a handler that reopens the panel must not
    // inherit the previous caller's return path.
    this.onClose = null;
    cb?.();
  }

  toggle() { return this._open ? (this.close(), false) : this.open(); }

  // --------------------------------------------------------------- rendering

  render() {
    const g = this.game;
    if (!g) return;
    const save = g.save;
    this.lvValue.textContent = String(save.level || 1);
    this.rankValue.textContent = rankOf(save.level || 1);
    const need = xpForLevel(save.level || 1);
    this.xpValue.textContent = `${Math.max(0, need - (save.xp || 0))} XP`;
    this.ashValue.textContent = String(Math.floor(save.ash || 0));

    for (const b of this.tabsEl.children) b.classList.toggle('on', b.dataset.tab === this._tab);
    this._renderSlots();
    this._renderStanceBtn();

    this.bodyEl.textContent = '';
    if (this._tab === 'stats') this._renderStats();
    else if (this._tab === 'sets') this._renderSets();
    else this._renderGear();
    // Layout has to settle before scrollHeight means anything, and render() is
    // called while the panel is still hidden on open().
    requestAnimationFrame(() => this._updateScrollHint());
  }

  /** Two side-by-side panes inside the scroll box; CSS stacks them when narrow. */
  _panes() {
    const wrap = el('div', 'body2');
    const a = el('div', 'pane');
    const b = el('div', 'pane');
    wrap.append(a, b);
    this.bodyEl.appendChild(wrap);
    return [a, b];
  }

  _updateScrollHint() {
    const c = this.colEl;
    if (!c) return;
    const overflow = c.scrollHeight - c.clientHeight;
    this.colWrap.classList.toggle('no-scroll', overflow <= 4);
    // 4 px of slack: sub-pixel layout means scrollTop never exactly equals the
    // maximum, and a hint that never goes away is a hint players learn to
    // ignore.
    this.colWrap.classList.toggle('at-end', c.scrollTop >= overflow - 4);
    // Position the panel-owned thumb. Proportional, floored at the CSS
    // min-height (24 px) so a long sheet still leaves something grabbable to
    // the eye; the travel maths uses the same floored height so the thumb
    // bottoms out exactly when the content does.
    if (overflow > 4 && this.railEl) {
      const railH = this.railEl.clientHeight;
      const thumbH = Math.max(24, (c.clientHeight / c.scrollHeight) * railH);
      const y = (c.scrollTop / overflow) * (railH - thumbH);
      this.thumbEl.style.height = `${Math.round(thumbH)}px`;
      this.thumbEl.style.transform = `translateY(${Math.round(y)}px)`;
    }
  }

  /** The rolled instance currently worn in an armour/trinket slot, or null.
   *  Deserialised on demand from the save record — never cached, because the
   *  record is the source of truth and a cached instance is one table-tune
   *  away from lying. The cost is a few dozen arithmetic ops per render. */
  _wornInstance(slot) {
    const rec = this.game?.save?.equipment?.[slot];
    return rec && rec.k !== 'w' ? deserializeArmor(rec) : null;
  }

  _renderSlots() {
    const g = this.game;
    this.slotsEl.textContent = '';
    for (const id of EQUIP_SLOTS) {
      const meta = SLOTS[id];
      const btn = el('button', 'slot');
      btn.type = 'button';
      btn.dataset.slot = id;
      if (!meta.live) btn.classList.add('locked');
      if (id === this._slot) btn.classList.add('sel');

      const box = el('i');
      const held = id === 'weapon' ? g.weapon : this._wornInstance(id);
      // iconStyle already renders a neutral grey square for an unknown key, so
      // an EMPTY slot needs no placeholder markup of its own. An empty slot
      // still draws its TYPE icon, faded: eight identical grey squares tell the
      // player nothing about where a helmet goes, and the 9 px label under a
      // 44 px cell is not a legible answer on a phone.
      const iconKey = held ? (id === 'weapon' ? weaponIcon(held) : held.base.icon) : meta.icon;
      box.setAttribute('style', iconStyle(iconKey, 44));
      if (held) box.style.borderColor = hex(rarityColor(held.rarity));
      else box.style.opacity = '0.3';
      if (held && id === 'legs') box.classList.add('desat');
      btn.appendChild(box);
      btn.appendChild(el('small', null, meta.name));
      btn.addEventListener('click', () => {
        this.audio?.ui?.();
        this._slot = id; this._tab = 'gear'; this._cmp = -1;
        this.render();
      });
      this.slotsEl.appendChild(btn);
    }
  }

  _renderStanceBtn() {
    const g = this.game;
    const mesh = g?.player?.mesh;
    const sheathed = mesh ? weaponStance(mesh) === 'sheathed' : false;
    this.stanceBtn.textContent = sheathed ? 'DRAW' : 'SHEATHE';
    this.stanceBtn.disabled = !g?.weapon;
  }

  _toggleStance() {
    const g = this.game;
    this.audio?.ui?.();
    // Apply what the LABEL promises — never a blind toggle off the live
    // stance. The label is polled fresh every 300 ms while the sheet is open,
    // but a tap can still land inside that window, and a tap that does the
    // opposite of the word printed on the button is the shipped bug this
    // replaces. Delegated to the game so ONE place owns the auto-sheath
    // policy's opinion about whether a stance change is currently legal
    // (never mid-swing).
    const want = this.stanceBtn.textContent === 'DRAW' ? 'drawn' : 'sheathed';
    g?.setStance?.(want, { manual: true });
    // Re-render off the stance that actually APPLIED — a refused change (e.g.
    // mid-swing) leaves the label exactly as it was, which is the truth.
    this._renderStanceBtn();
  }

  // ------------------------------------------------------------------- gear

  _renderGear() {
    const meta = SLOTS[this._slot];
    if (meta.kind === 'w') return this._renderWeaponGear(meta);
    if (!meta.live) return this._renderLockedGear(meta);
    return this._renderArmorGear(meta);
  }

  _renderLockedGear(meta) {
    const [body] = this._panes();
    body.appendChild(el('div', 'sect', meta.name));
    body.appendChild(el('div', 'note', meta.blurb));
    const note = el('div', 'note');
    note.appendChild(el('b', null, 'NOT YET FITTED.  '));
    // Twin daggers intrinsically consume the offhand (buildDaggers parents the
    // second blade to handL) — when they are the held weapon this slot is not
    // merely empty, it is CLAIMED, and the panel must say which.
    const daggers = this.game?.weapon?.archetype === 'daggers';
    note.appendChild(document.createTextNode(daggers
      ? 'Your twin daggers fill both hands — the offhand is locked while they are equipped. Nothing else fits here yet.'
      : 'The offhand opens with the bow and the staff. Nothing equips here today, and no hidden number is being applied.'));
    body.appendChild(note);
  }

  _renderWeaponGear(meta) {
    const g = this.game;
    // Left pane: what is fitted. Right pane: what you could fit instead. The
    // whole point of the GEAR tab is swapping, so the list you swap FROM has to
    // share the fold with the thing you are swapping OUT.
    const [body, right] = this._panes();

    body.appendChild(el('div', 'sect', meta.name));
    body.appendChild(el('div', 'note', meta.blurb));

    // --- equipped
    const held = g.weapon;
    if (held) {
      body.appendChild(el('div', 'sect', 'EQUIPPED'));
      body.appendChild(this._weaponRow(held, { equipped: true }));
      const stats = el('div', 'readout');
      for (const [k, v] of weaponSummary(held)) stats.appendChild(row(k, v));
      const mesh = g.player?.mesh;
      stats.appendChild(row('Carried', mesh && weaponStance(mesh) === 'sheathed' ? 'On the back' : 'In hand'));
      body.appendChild(stats);
      // The legendary's named clause — the ACTUAL prize (RPG_SPEC: the raw
      // multiplier is deliberately small; the rule is what you grind for).
      if (held.rule) {
        const rl = el('div', 'rule');
        rl.appendChild(el('b', null, held.rule.name));
        rl.appendChild(document.createTextNode(held.rule.text));
        body.appendChild(rl);
      }
      if (held.blurb) body.appendChild(el('div', 'note', held.blurb));
      // The ascension entry (step 14): an EPIC in hand can climb the last
      // rung right here. Recipe rows read have/need and go green as they are
      // met; the refusal reason prints verbatim under a disabled button.
      if (held.rarity === 'epic') this._renderAscension(body, held);
    }

    // --- stash
    const stash = Array.isArray(g.stash) ? g.stash : [];
    right.appendChild(el('div', 'sect', `IN THE STASH  (${stash.length})`));
    if (!stash.length) {
      right.appendChild(el('div', 'note', 'Nothing spare. Gates drop weapons and the Exchange sells them.'));
      return;
    }
    for (let i = 0; i < stash.length; i++) {
      right.appendChild(this._weaponRow(stash[i], { index: i }));
    }
  }

  /**
   * The ascension block under an equipped epic. game.ascendEquipped() is the
   * commit — it consumes the epic IN PLACE (never via the stash) and equips
   * the legendary it becomes; this panel only prints and re-renders.
   */
  _renderAscension(body, held) {
    const g = this.game;
    body.appendChild(el('div', 'sect', 'ASCENSION'));
    const box = el('div', 'asc');
    box.id = 'invAscend';
    for (const [label, have, need, met] of ascensionRecipe(g.save, held)) {
      const r = el('div', `crow ${met ? 'met' : 'unmet'}`);
      r.appendChild(el('span', null, label));
      r.appendChild(el('b', null, `${have} / ${need}`));
      box.appendChild(r);
    }
    const gate = canAscend(g.save, held);
    const btn = el('button', 'btn primary', 'ASCEND');
    btn.id = 'invAscendBtn';
    btn.type = 'button';
    btn.disabled = !gate.ok;
    btn.addEventListener('click', () => {
      this.audio?.ui?.();
      const r = g.ascendEquipped?.();
      if (r?.ok) this.render();
    });
    box.appendChild(btn);
    if (!gate.ok) box.appendChild(el('div', 'asc-reason', gate.reason));
    box.appendChild(el('div', 'note',
      'Ascending consumes this epic — its seed becomes the legendary’s, so the '
      + 'weapon you shaped is the weapon that ascends. The legendary’s rule '
      + 'changes a verb, never a damage number.'));
    body.appendChild(box);
  }

  _weaponRow(w, { equipped = false, index = -1 } = {}) {
    const g = this.game;
    const btn = el('button', 'gate');
    btn.type = 'button';
    if (equipped) btn.classList.add('on');
    if (w.rarity === 'legendary') btn.classList.add('leg');

    const box = el('i');
    box.setAttribute('style', iconStyle(weaponIcon(w), 34));
    box.style.borderStyle = 'solid';
    box.style.borderWidth = '2px';
    box.style.borderColor = hex(rarityColor(w.rarity));
    btn.appendChild(box);

    const meta = el('span', 'meta');
    const name = el('b', null, w.name);
    name.style.color = hex(rarityColor(w.rarity));
    meta.appendChild(name);
    meta.appendChild(el('small', null,
      `${RARITIES[w.rarity]?.name || ''} ${w.arch.name}  ·  x${w.dmgMul.toFixed(2)} power  ·  LV ${w.level}`));
    btn.appendChild(meta);

    if (equipped) {
      btn.appendChild(el('span', 'tagline', 'EQUIPPED'));
      btn.disabled = true;
    } else {
      // The one comparison that matters, spelled out rather than left to the
      // player to work out from two power numbers: rollWeapon's `score` is the
      // single comparable value and _takeWeapon already auto-equips on it.
      const better = g.weapon ? w.score - g.weapon.score : 1;
      const tag = el('span', 'tagline', better > 0 ? `+${Math.round(better)}` : `${Math.round(better)}`);
      tag.style.color = better > 0 ? '#54e08a' : 'var(--danger)';
      btn.appendChild(tag);
      btn.addEventListener('click', () => this._equip(index));
    }
    return btn;
  }

  _equip(index) {
    const g = this.game;
    const w = g?.stash?.[index];
    if (!w) return;
    this.audio?.ui?.();
    // SWAP, not push: game.equipFromStash removes the incoming record before
    // pushing the outgoing one. Equipping straight through game.equip would
    // leave the stash entry behind and duplicate the item, which is harmless
    // at one slot and a 12-entry cap and is not harmless at eight and forty.
    g.equipFromStash(index);
    g.ui?.toast?.(`${w.name.toUpperCase()}  ·  EQUIPPED`);
    this.render();
  }

  // ----------------------------------------------------------------- armour

  /** Stash entries that fit `slot`, as { rec, inst, index } with `index` the
   *  position in game.armorStash (the equip API's coordinate system). */
  _armorCandidates(slot) {
    const stash = Array.isArray(this.game?.armorStash) ? this.game.armorStash : [];
    const out = [];
    for (let i = 0; i < stash.length; i++) {
      const rec = stash[i];
      const base = rec && ARMOR_BASES[rec.b];
      if (!base || base.slot !== slot) continue;
      const inst = deserializeArmor(rec);
      if (inst) out.push({ rec, inst, index: i });
    }
    return out;
  }

  /** Why `base` cannot be equipped right now, in the Exchange's exact words —
   *  or null when it can. shop.shopBand is the shared band computation, so the
   *  two panels can never disagree about the same rule. */
  _equipBlock(base) {
    const save = this.game?.save || {};
    if (base.reqLevel > (save.level || 1)) return `REQUIRES LEVEL ${base.reqLevel}`;
    if (base.minRank > shopBand(save)) return `${RANKS[base.minRank]}-GRADE HUNTERS ONLY`;
    return null;
  }

  _renderArmorGear(meta) {
    const [body, right] = this._panes();
    const slot = this._slot;

    body.appendChild(el('div', 'sect', meta.name));
    body.appendChild(el('div', 'note', meta.blurb));

    // --- equipped
    const worn = this._wornInstance(slot);
    if (worn) {
      body.appendChild(el('div', 'sect', 'EQUIPPED'));
      body.appendChild(this._armorRow(worn, { equipped: true }));
      const stats = el('div', 'readout');
      for (const [k, v] of armorSummary(worn)) stats.appendChild(row(k, v));
      body.appendChild(stats);
      const un = el('button', 'btn ghost unequip', 'UNEQUIP');
      un.id = 'invUnequip';
      un.type = 'button';
      un.addEventListener('click', () => this._unequipArmor(slot));
      body.appendChild(un);
      if (worn.blurb) body.appendChild(el('div', 'note', worn.blurb));
    } else {
      const note = el('div', 'note');
      note.appendChild(el('b', null, 'NOTHING EQUIPPED.  '));
      note.appendChild(document.createTextNode(slot === 'trinket'
        ? 'Gates drop rings and pendants — one exotic effect each, outside every set.'
        : 'Gates drop set pieces. Wearing 2 / 4 / 5 of one set pays its bonuses.'));
      body.appendChild(note);
    }

    // --- the compare strip, when a candidate is under consideration
    const candidates = this._armorCandidates(slot);
    const picked = this._cmp >= 0 ? candidates.find((c) => c.index === this._cmp) : null;
    if (picked) {
      this._renderCompare(right, worn, picked);
      return;
    }

    // --- stash, filtered to this slot
    right.appendChild(el('div', 'sect', `IN THE STASH  (${candidates.length})`));
    if (!candidates.length) {
      right.appendChild(el('div', 'note', slot === 'trinket'
        ? 'No spare trinkets. Gates are their only source.'
        : 'No spare pieces for this slot. Gates drop armour by rank.'));
      return;
    }
    for (const c of candidates) {
      right.appendChild(this._armorRow(c.inst, { index: c.index, worn }));
    }
  }

  _armorRow(a, { equipped = false, index = -1, worn = null } = {}) {
    const btn = el('button', 'gate');
    btn.type = 'button';
    if (equipped) btn.classList.add('on');
    if (a.rarity === 'legendary') btn.classList.add('leg');

    const box = el('i');
    box.setAttribute('style', iconStyle(a.base.icon, 34));
    box.style.borderStyle = 'solid';
    box.style.borderWidth = '2px';
    box.style.borderColor = hex(rarityColor(a.rarity));
    if (a.slot === 'legs') box.classList.add('desat');
    btn.appendChild(box);

    const meta = el('span', 'meta');
    const name = el('b', null, a.name);
    name.style.color = hex(rarityColor(a.rarity));
    meta.appendChild(name);
    const setName = a.setId ? SETS[a.setId]?.name : null;
    const blocked = equipped ? null : this._equipBlock(a.base);
    meta.appendChild(el('small', null, blocked
      // The Exchange's exact refusal wording, on the row itself, so a player
      // knows WHY before ever opening the strip.
      ? blocked
      : `${a.rarityName} ${setName || 'Trinket'}  ·  LV ${a.level}`));
    btn.appendChild(meta);

    if (equipped) {
      btn.appendChild(el('span', 'tagline', 'EQUIPPED'));
      btn.disabled = true;
    } else {
      if (blocked) btn.classList.add('locked');
      // Same single-comparable-number tag the weapon list carries; scores are
      // comparable within a slot because rollArmor builds them from the same
      // AP-first formula for every piece of a kind.
      const better = worn ? a.score - worn.score : 1;
      const tag = el('span', 'tagline', better > 0 ? `+${Math.round(better)}` : `${Math.round(better)}`);
      tag.style.color = better > 0 ? '#54e08a' : 'var(--danger)';
      btn.appendChild(tag);
      // Tap opens the COMPARE STRIP — never equips directly. An armour swap
      // changes combat numbers, and the numbers come first (the strip's EQUIP
      // button is the commit).
      btn.addEventListener('click', () => { this.audio?.ui?.(); this._cmp = index; this.render(); });
    }
    return btn;
  }

  /** Label / equipped / candidate(delta), then EQUIP + BACK. */
  _renderCompare(pane, worn, picked) {
    const a = picked.inst;
    pane.appendChild(el('div', 'sect', 'COMPARE'));
    const strip = el('div', 'cmp');
    strip.id = 'invCompare';

    // Name header, candidate coloured by rarity.
    const head = el('div', 'crow');
    const nm = el('b', 'cand', a.name);
    nm.style.color = hex(rarityColor(a.rarity));
    nm.style.textAlign = 'left';
    head.appendChild(nm);
    strip.appendChild(head);

    const crow = (label, cur, cand, delta, deltaText) => {
      const r = el('div', 'crow');
      r.appendChild(el('span', null, label));
      r.appendChild(el('span', 'cur', cur));
      const c = el('b', 'cand');
      c.appendChild(document.createTextNode(cand));
      if (delta !== 0) {
        // Never a bare number: "42 (+10)" reads, "42" does not (the spec's own
        // phrasing). Green is the shipped uncommon green; worse is --danger.
        const d = el('span', `delta ${delta > 0 ? 'up' : 'down'}`, `  (${deltaText})`);
        c.appendChild(d);
      }
      r.appendChild(c);
      strip.appendChild(r);
    };

    if (a.kind === 't') {
      // Trinkets carry ONE effect each; when the two effects differ the strip
      // shows both rows so the player sees what he gives up, not a fake delta
      // between incommensurable numbers.
      const keys = [...new Set([worn?.effect?.key, a.effect.key].filter(Boolean))];
      for (const key of keys) {
        const cur = worn?.effect?.key === key ? worn.effect.mag : 0;
        const cand = a.effect.key === key ? a.effect.mag : 0;
        const d = cand - cur;
        const dText = key === 'mpRegen'
          ? `${d >= 0 ? '+' : ''}${d.toFixed(1)}/s`
          : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;
        crow(TRINKET_LABEL[key] || key,
          cur ? trinketFmt(key, cur) : '—',
          cand ? trinketFmt(key, cand) : '—',
          // A delta between two DIFFERENT effects is not a number; only show
          // the glyph when both rows measure the same thing.
          keys.length === 1 ? d : 0,
          dText);
      }
    } else {
      for (const [label, get, fmt, dfmt] of CMP_ROWS) {
        const cur = worn ? get(worn) : 0;
        const cand = get(a);
        if (!cur && !cand) continue;   // row means nothing to either piece
        // Deltas under half a display unit round to a "(+0)" glyph that reads
        // as noise; suppress the glyph, keep the row.
        const delta = cand - cur;
        crow(label, cur ? fmt(cur) : '—', cand ? fmt(cand) : '—',
          Math.abs(delta) > 1e-9 ? delta : 0, dfmt(delta));
      }
      const wornSet = worn?.setId ? SETS[worn.setId]?.name : '—';
      const candSet = a.setId ? SETS[a.setId]?.name : '—';
      crow('Set', wornSet, candSet, 0, '');
    }

    const blocked = this._equipBlock(a.base);
    if (blocked) strip.appendChild(el('div', 'cmp-reason', blocked));

    const foot = el('div', 'cmp-foot');
    const equip = el('button', 'btn primary', 'EQUIP');
    equip.id = 'invEquipConfirm';
    equip.type = 'button';
    equip.disabled = Boolean(blocked);
    equip.addEventListener('click', () => this._equipArmor(picked.index));
    foot.appendChild(equip);
    const back = el('button', 'btn ghost', 'BACK');
    back.id = 'invCompareBack';
    back.type = 'button';
    back.addEventListener('click', () => { this.audio?.ui?.(); this._cmp = -1; this.render(); });
    foot.appendChild(back);
    strip.appendChild(foot);
    pane.appendChild(strip);
  }

  /**
   * Equip the armorStash record at `index` into its own slot. SWAP semantics,
   * the same invariant game.equipFromStash enforces for weapons: the incoming
   * record leaves the stash BEFORE the outgoing one is pushed, so an instance
   * never exists in two places — the duplication hole RPG_SPEC's audit names.
   *
   * Persistence is game._persistLoadout -> onSave, one write for the whole
   * save; refreshDerived is the single armour-fold site and credits any maxHp
   * gain itself. Nothing here caches a stat line.
   */
  _equipArmor(index) {
    const g = this.game;
    const stash = g?.armorStash;
    const rec = stash?.[index];
    const base = rec && ARMOR_BASES[rec.b];
    if (!base) return false;
    const blocked = this._equipBlock(base);
    if (blocked) { g.ui?.toast?.(blocked); return false; }
    this.audio?.ui?.();
    const slot = base.slot;
    stash.splice(index, 1);
    const outgoing = g.save.equipment[slot];
    g.save.equipment[slot] = rec;
    if (outgoing) stash.push(outgoing);
    g.refreshDerived();
    g._persistLoadout();
    this._refreshArmorLook();
    const inst = deserializeArmor(rec);
    g.ui?.toast?.(`${(inst?.name || base.name).toUpperCase()}  ·  EQUIPPED`);
    this._cmp = -1;
    this.render();
    return true;
  }

  /** Take the piece off and stash it. Refused when the stash is at the cap —
   *  _persistLoadout trims the persisted concat to STASH_LIMIT, so pushing
   *  past it here would SILENTLY DELETE the last record on the next write. */
  _unequipArmor(slot) {
    const g = this.game;
    const rec = g?.save?.equipment?.[slot];
    if (!rec || rec.k === 'w') return false;
    const held = (g.stash?.length || 0) + (g.armorStash?.length || 0);
    if (held >= STASH_LIMIT) {
      g.ui?.toast?.(`STASH FULL — ${STASH_LIMIT} PIECES MAX`);
      return false;
    }
    this.audio?.ui?.();
    g.save.equipment[slot] = null;
    g.armorStash = g.armorStash || [];
    g.armorStash.unshift(rec);
    g.refreshDerived();
    g._persistLoadout();
    this._refreshArmorLook();
    this._cmp = -1;
    this.render();
    return true;
  }

  /** Point the hunter's silhouette at the (just-changed) equipment and rebuild
   *  in place — the exact sequence game.setPlayerBody runs for an M/F flip.
   *  rebuildHumanoid declines harmlessly on the procedural box-man. */
  _refreshArmorLook() {
    const g = this.game;
    setPlayerArmorLook(g.save.equipment);
    const mesh = g.player?.mesh;
    if (mesh && rebuildHumanoid(mesh)) {
      // Settle into idle NOW: inside a paused gate nothing else ticks the rig,
      // and a T-pose behind the panel reads as a crash.
      animateRig(mesh, { moving: false, speed: 0, t: g.time, dt: 0.016 });
    }
  }

  // ------------------------------------------------------------------ stats

  _renderStats() {
    const g = this.game;
    const save = g.save;
    // IDENTITY + the six spendable stats on the left, everything they DERIVE on
    // the right: the two halves are read together ("I put a point in AGILITY,
    // what moved?") and stacking them put the derived block a full screen below
    // the stat it explains.
    const [body, right] = this._panes();
    // Same fold the game runs: applyLayers(save, derive(save, armorBonus)) —
    // exactly refreshDerived's pipeline. Showing the naked derive here while
    // the game folds armour and the class layer would make this panel lie
    // about every number either touches. dBase is kept so the CLASS section
    // can show what the class layer CONTRIBUTED, field by field.
    const dBase = derive(save, g._armorBonus || null);
    const d = applyLayers(save, dBase);
    const R = STAT_RATES;
    const dirKey = directionOf(save);
    const cls = CLASSES[save.className];

    const idt = el('div', 'readout');
    body.appendChild(el('div', 'sect', 'IDENTITY'));
    idt.appendChild(row('Level', String(save.level || 1)));
    idt.appendChild(row('Rank', rankOf(save.level || 1)));
    // Direction is DERIVED from spent points (never chosen in a menu), so the
    // row simply names what the player has been doing. UNSWORN is a real,
    // non-punished state and the sub-line says how to leave it.
    idt.appendChild(dirKey === 'unsworn'
      ? row('Direction', 'UNSWORN', 'no direction set — spend deeper')
      : row('Direction', DIRECTIONS[dirKey].name, `lead stat ${DIRECTIONS[dirKey].key.toUpperCase()}`));
    idt.appendChild(row('Class', cls ? cls.name
      : ((save.level || 1) >= 20 ? '— the Assay Hall awaits' : '— opens at level 20')));
    idt.appendChild(row('XP', `${save.xp || 0} / ${xpForLevel(save.level || 1)}`));
    idt.appendChild(row('Unspent points', String(save.points || 0)));
    idt.appendChild(row('Kills', String(save.totalKills || 0)));
    idt.appendChild(row('Deaths', String(save.deaths || 0)));
    idt.appendChild(row('Gates cleared', String(Object.keys(save.cleared || {}).length)));
    body.appendChild(idt);

    // The spec's answered open question: Emberdust lives HERE, not in the
    // wallet strip. save.materials arrives with the ascension step (14); until
    // a gate has dropped any, the honest number is 0 and the row still exists
    // so the player learns the currency's name before he needs it.
    body.appendChild(el('div', 'sect', 'RESOURCES'));
    const rs = el('div', 'readout');
    rs.appendChild(row('Ash', String(Math.floor(save.ash || 0))));
    rs.appendChild(row('Emberdust', String(Math.floor(save.materials?.emberdust || 0)),
      'legendary fuel — B-rank gates and above'));
    // Family sigils, only once one is held: six zero-rows would bury the two
    // resources a pre-B player can actually read. Each named boss guards one
    // family's sigil, and the ascension block names the one a craft needs.
    const sigils = save.materials?.sigils || {};
    for (const [boss, label] of Object.entries(SIGIL_LABEL)) {
      if ((sigils[boss] || 0) > 0) rs.appendChild(row(label, String(sigils[boss])));
    }
    body.appendChild(rs);

    body.appendChild(el('div', 'sect', 'STATS'));
    const st = el('div', 'readout');
    const auto = save.autoStats || 0;
    for (const s of STATS) {
      const spent = (save.stats || {})[s.key] || 0;
      st.appendChild(row(s.name, `${effectiveStat(save, s.key)}`, `${spent} spent + ${auto} granted`));
      st.appendChild(el('div', 'note', s.desc));
      // The mastery line (CLASSES_SPEC masteryRules uiSurface): the deepest
      // mastery earned in THIS stat plus the next spent-point threshold.
      // Thresholds count SPENT points only — the auto grant raises every stat
      // equally, so counting it would hand out every mastery for free.
      const dir = DIRECTIONS[s.key];
      const tier = masteryTier(save, s.key);
      const next = MASTERY_THRESHOLDS[tier];
      const line = tier > 0
        ? `${dir.name} · ${dir.masteries[tier - 1].name}${next ? ` — next ${spent}/${next}` : ' — mastered'}`
        : `${dir.name} — next ${spent}/${next}`;
      const m = el('div', 'note', line);
      if (tier > 0) m.style.color = 'var(--accent2)';
      st.appendChild(m);
    }
    body.appendChild(st);

    right.appendChild(el('div', 'sect', 'DERIVED'));
    const dv = el('div', 'readout');
    dv.appendChild(row('Max health', String(d.maxHp)));
    dv.appendChild(row('Max mana', String(d.maxMp)));
    dv.appendChild(row('Attack power', d.atk.toFixed(1)));
    dv.appendChild(row('Move speed', d.speed.toFixed(2), `cap +${R.agi.speedCap}`));
    dv.appendChild(row('Crit chance', pct(d.crit), `cap ${pct(R.agi.critCap)}`));
    dv.appendChild(row('Crit damage', `x${d.critDmg.toFixed(2)}`));
    dv.appendChild(row('Attack speed', `+${pct(d.atkSpeed)}`, `cap ${pct(R.str.atkSpeedCap)}`));
    dv.appendChild(row('Skill power', `x${d.skillMul.toFixed(2)}`));
    dv.appendChild(row('Cooldown cut', pct(d.cdr), `cap ${pct(R.int.cdrCap)}`));
    dv.appendChild(row('Damage reduction', pct(d.dr), `cap ${pct(R.vit.drCap)}`));
    dv.appendChild(row('Health regen', `${d.hpRegen.toFixed(2)}/s`));
    dv.appendChild(row('Mana regen', `${d.mpRegen.toFixed(2)}/s`));
    dv.appendChild(row('Damage floor', pct(d.dmgFloor), 'the low end of every roll'));
    dv.appendChild(row('Enemy tell', `${Math.round(d.tellLeadMs)} ms`, 'warning before a hit lands'));
    dv.appendChild(row('Dodge window', `${Math.round(d.dodgeWindow * 1000)} ms`));
    dv.appendChild(row('Shadow damage', `x${d.shadowDmgMul.toFixed(2)}`));
    right.appendChild(dv);

    right.appendChild(el('div', 'sect', 'ARMOUR'));
    const ab = g._armorBonus || null;
    const ar = el('div', 'readout');
    // The two layers are shown separately BECAUSE they stack multiplicatively
    // in _damagePlayer — one merged percentage would hide which layer moved.
    // The 0.72 cap is named so the player can see the ceiling rather than
    // discover it.
    ar.appendChild(row('Armour reduction', pct(d.armorDR), 'stacks with vitality, total capped 72%'));
    if (d.staggerResist > 0) ar.appendChild(row('Stagger resist', pct(d.staggerResist), 'cap 60.0%'));
    if (d.knockTakenMul !== 1) ar.appendChild(row('Knockback taken', `x${d.knockTakenMul.toFixed(2)}`));
    right.appendChild(ar);
    if (!ab || d.armorDR === 0) {
      right.appendChild(el('div', 'note',
        `Your ${pct(d.dr)} damage reduction is all from VITALITY — no armour is worn. `
        + 'Gates drop set pieces; fit them from the GEAR tab.'));
    }

    // The class layer, in stacking order after armour. Drawbacks render in the
    // SAME type size as benefits, here and everywhere, forever — a class whose
    // downside the player did not read is a class they will blame the game
    // for (CLASSES_SPEC risks: drawback resentment).
    right.appendChild(el('div', 'sect', 'CLASS'));
    if (cls) {
      const cr = el('div', 'readout');
      const quality = save.classTier || 'base';
      const res = resonanceOf(save);
      cr.appendChild(row(cls.name, res > 0 ? `RESONANT ${res}` : 'NEUTRAL',
        `quality ${quality} x${(CLASS_QUALITY[quality] || 1).toFixed(2)}`));
      cr.appendChild(el('div', 'note', `BENEFIT — ${cls.benefitText}`));
      cr.appendChild(el('div', 'note', `DRAWBACK — ${cls.drawbackText}`));
      // What the layer actually DID: every derived field it moved, base ->
      // final, off the same two blocks the game computes. An empty list means
      // the class only carries behaviour flags, and saying so is clearer than
      // a blank.
      let moved = 0;
      for (const [key, [label, fmt]] of Object.entries(CLASS_FIELD_LABEL)) {
        const a = dBase[key];
        const b = d[key];
        if (b === undefined || a === b) continue;
        const base = a !== undefined ? fmt(a) : '—';
        cr.appendChild(row(label, `${base} > ${fmt(b)}`));
        moved++;
      }
      if (!moved) cr.appendChild(el('div', 'note', 'No derived numbers moved — this class trades in behaviours.'));
      right.appendChild(cr);
    } else {
      right.appendChild(el('div', 'note', (save.level || 1) >= 20
        ? 'No class chosen. The Assay Hall in Threshold will measure you — every class carries a benefit AND a drawback, in equal type.'
        : 'Classes open at level 20, at the Assay Hall. Your direction is yours to set now: it is read from where you spend.'));
    }

    right.appendChild(el('div', 'sect', 'ARMY'));
    const ay = el('div', 'readout');
    const roster = save.shadows?.roster?.length || 0;
    ay.appendChild(row('Roster', `${roster} / ${shadowRosterCapacity(save)}`));
    // game.fieldCapacity() IS the number the sim enforces (vigil 4pc + the
    // SHADOW ARCHON's +2, inside progression's clamps) — the spec's honesty
    // clause: the tier cap wins, and this row must show the number that
    // actually rules.
    ay.appendChild(row('On the field', String(g.fieldCapacity()),
      'clamped by the live quality tier'));
    right.appendChild(ay);

    // SOVEREIGN'S WILL (CLASSES_SPEC step 8): the three-way command toggle,
    // on the shadow panel per spec. Stance is RUN state ("one enum on the run
    // state") — it resets to HUNT at every gate entry — so the toggle only
    // renders where a run is live to command; in the city the army is not
    // fielded and a control that silently reset would be a lie.
    if (save.archon === 'shadow') {
      right.appendChild(el('div', 'sect', "SOVEREIGN'S WILL"));
      if (g.mode?.name !== 'city' && typeof g.setShadowStance === 'function') {
        const st = el('div', 'tabs');
        for (const [key, label, hint] of [
          ['hold', 'HOLD', 'the wall — stay on you, cut down what closes'],
          ['hunt', 'HUNT', 'free rein — nearest quarry within 26 m'],
          ['focus', 'FOCUS', 'every blade on your last-marked target'],
        ]) {
          const b = el('button', null, label);
          b.type = 'button';
          b.title = hint;
          b.classList.toggle('on', g.shadowStance === key);
          b.addEventListener('click', () => {
            this.audio?.ui?.();
            if (g.setShadowStance(key)) this.render();
          });
          st.appendChild(b);
        }
        right.appendChild(st);
        const hints = {
          hold: 'HOLD — the wall. Your soldiers keep to your side and intercept anything that closes.',
          hunt: 'HUNT — free rein. Each soldier takes the nearest quarry within 26 m.',
          focus: 'FOCUS — every blade on your last-marked target, wherever it runs.',
        };
        right.appendChild(el('div', 'note', hints[g.shadowStance] || hints.hunt));
      } else {
        right.appendChild(el('div', 'note',
          'Stances are commanded in the field. Your army answers when a rift is open.'));
      }
    }
  }

  // ------------------------------------------------------------------- sets

  /** One block per set — ALL FIVE, not just the worn ones: this tab IS the
   *  "collect a set" reward loop, and a loop the player cannot see the whole
   *  of is not a loop (the spec's own words about legibility). */
  _renderSets() {
    const g = this.game;
    const counts = setProgress(g.save.equipment);
    const [body, right] = this._panes();
    const panes = [body, right];

    body.appendChild(el('div', 'note',
      'Wearing 2 / 4 / 5 pieces of one set pays its bonuses. Partials are small '
      + 'flat numbers; the full set is a rule. Offhand and trinket never count.'));

    const ordered = Object.values(SETS).sort((a, b) => a.tier - b.tier);
    ordered.forEach((set, i) => {
      // Alternate sets between the two panes so five blocks stay within one
      // screen-and-a-bit at 412 px instead of a five-screen single column.
      const pane = panes[i % 2 === 0 ? 0 : 1];
      const n = counts.get(set.id) || 0;
      const sr = el('div', 'readout');
      const head = row(set.name, `${n} / 5`, 'pieces worn');
      if (n > 0) head.querySelector('b').style.color = 'var(--accent2)';
      sr.appendChild(head);
      for (const th of SET_THRESHOLDS) {
        const b = set.bonuses[th];
        if (!b) continue;
        const live = n >= th;
        const line = row(`${th}-piece`, live ? 'ACTIVE' : '—', b.text);
        // Lit exactly at the thresholds armorDerive pays; dim otherwise —
        // earned in --ink, unearned faded, per the spec's SETS tab clause.
        line.style.opacity = live ? '1' : '0.45';
        if (live) line.querySelector('b').style.color = 'var(--accent2)';
        sr.appendChild(line);
      }
      pane.appendChild(el('div', 'sect', `${RANKS[set.minRank]}-RANK SET`));
      pane.appendChild(sr);
      pane.appendChild(el('div', 'note', set.flavour));
    });
  }
}

export default InventoryUI;
