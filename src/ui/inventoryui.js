// The hunter's sheet: a persistent "paper doll" view — the REAL hunter
// standing centre-frame, four equipment slots flanking each side, a bottom
// ticker of the numbers that matter mid-run, and two sheets (SETS, the full
// STATS breakdown) that slide over it. Ported from the owner's picked
// Claude Design mockup ("V3 — PAPER DOLL"); see docs/NUMBERS_SPEC.json for
// background research from an earlier abandoned attempt at this exact port
// (not authoritative — this file and the mockup are).
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
// the shop. render() DOES clear and repopulate the inner content of the
// skeleton nodes below on every call — that is not the same mistake: the
// skeleton (panel, rails, stage, ticker, overlay shell) is built exactly once
// in the constructor, and only their CHILDREN are torn down and rebuilt per
// render(), the same pattern _panes()/bodyEl always used here.
//
// THE CENTRE IS A REAL CHARACTER, NOT A PREVIEW RENDER. This game owns exactly
// one THREE.WebGLRenderer (game.js:~373) — standing up a second GL context for
// a preview canvas would be this project's fourth GPU-lifecycle leak in a row
// (city dispose, world dispose, entity LOD already shipped three), so this
// panel does not do that. What it DOES do (V4, this session): a SECOND
// THREE.Camera — game.previewCamera — sharing the one renderer, whose layer
// mask is INV_PREVIEW_LAYER and nothing else. game.enterInventoryView() hands
// the frame to it; every frame it stays open, game._updateInventoryCamera tags
// the player's live rig (which already tracks equipped gear every frame this
// file changes it, via setPlayerArmorLook/rebuildHumanoid) onto that layer and
// orbits the camera around it. The panel's centre column still carries no
// opaque background of its own (only the chrome around it — rails, ticker,
// header — has one) so the render shows through, exactly as before; what
// changed is WHAT renders there. close() calls game.exitInventoryView() to
// drop the state; the world's own camera was never touched, so there is
// nothing to hand back.
//
// V3 (the first paper-doll ship) pointed the world's OWN camera at a close
// portrait of the player standing exactly where they were, and left it at
// that: the owner's follow-up feedback was that the live map and other
// hunters were still visible behind the framed shot, and it read as
// "massive" rather than contained to the panel's centre column. V4 answers
// both: previewCamera's isolated layer mask means the map is not merely
// out of frame, it is literally the only thing that camera can never see, no
// matter where the player happens to be standing (the plaza, a paused
// dungeon room — irrelevant now); and a full-body medium shot (framed on a
// dedicated FOV/distance instead of the gameplay follow rig's numbers)
// replaces the old chest-height close-up. A user-draggable spin (this file's
// stage-centre pointer handler below, forwarding raw dx to
// game.spinInventoryView) replaces the fixed dead-on angle — the owner's
// explicit ask, so gear reads from more than one side without leaving the
// panel.
//
// WAVE 4 (this port): the five armour slots, the trinket, and the weapon are
// LIVE. Equipping is a deliberate two-step everywhere now — tap a slot, read
// the delta strip against the real number, confirm — because a swap changes
// combat numbers and a player on a phone deserves to see WHICH ones before
// committing; the mockup's shared compare overlay already drew this pattern
// for every slot, so weapons now get the same courtesy armour always had.
// Only the offhand still says "not yet": no offhand item exists in any table
// this wave, and a slot that pretends is worse than a slot that says so.
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
// exact rolled piece, armorSummary/setProgress for the readouts, and the two
// the hard-numbers rule needs to print the REAL total-DR cap rather than the
// mockup's invented 75%.
import {
  ARMOR_BASES, ARMOR_SLOTS, SETS, SET_THRESHOLDS, setProgress, deserializeArmor,
  armorSummary, TOTAL_DR_CAP, combinedDR,
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
// game.refreshDerived runs, so this sheet can never disagree with combat; the
// direction/mastery/resonance readers are pure and drive the identity rows.
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
// record's `k` field, so the candidate list filter is a single comparison
// rather than a per-slot special case. `code` is the mockup's short badge —
// a SECONDARY decoration next to the real icon (requirement: the atlas icon
// stays primary, never a 2-3 letter code standing in for it).
const SLOTS = {
  weapon: { name: 'WEAPON', kind: 'w', icon: 'sword', live: true, code: 'WPN', blurb: 'The family decides how combat FEELS: reach, arc, commitment, recovery.' },
  offhand: { name: 'OFFHAND', kind: 'o', icon: 'arrow', live: false, code: 'OFF', blurb: 'Quiver, focus or parry token. Arrives with the bow and the staff.' },
  head: { name: 'HEAD', kind: 'a', icon: 'crown', live: true, code: 'HED', blurb: 'Perception: earlier enemy tells, harder crits.' },
  chest: { name: 'CHEST', kind: 'a', icon: 'armor_metal', live: true, code: 'CHS', blurb: 'The slab. The largest single armour contribution, and max health.' },
  hands: { name: 'HANDS', kind: 'a', icon: 'glove', live: true, code: 'HND', blurb: 'Weapon handling: attack speed, and a shave off recovery.' },
  legs: { name: 'LEGS', kind: 'a', icon: 'armor_leather', live: true, code: 'LEG', blurb: 'Mobility: move speed and a wider perfect-dodge window.' },
  feet: { name: 'FEET', kind: 'a', icon: 'bone', live: true, code: 'FT', blurb: 'Footing: stagger resistance, and less knockback taken.' },
  trinket: { name: 'TRINKET', kind: 't', icon: 'ring3', live: true, code: 'TRK', blurb: 'One exotic effect. No armour at all — leech, luck, ash-find.' },
};
const LEFT_SLOTS = ['weapon', 'offhand', 'head', 'chest'];
const RIGHT_SLOTS = ['hands', 'legs', 'feet', 'trinket'];

// ---------------------------------------------------------------------------
// HARD NUMBERS. The owner's own two complaints — "everything is based on 1.49
// damage" and "dodge window is 114 ms" — were this file's OWN notation: a bare
// "x1.49" multiplier and a millisecond figure with no seconds-scale context.
// The V3 mockup's fmt() answers both (dodge in seconds, DR as "NN% (CAP NN%)",
// flat rounded integers, "+NN%" bonus percentages) and this is that answer,
// applied to every number this file prints — including the ones the mockup's
// synthetic data never had to cover (weapon power, class quality, shadow
// damage), because the rule is the notation, not the specific row.
// ---------------------------------------------------------------------------

/** A multiplier (1.49, 0.75, ...) as a signed bonus percentage off 1.0 —
 *  "+49%" / "-25%". Replaces every "x1.NN" this panel used to print. */
const bonusPct = (mult) => {
  const p = Math.round((mult - 1) * 100);
  return `${p >= 0 ? '+' : ''}${p}%`;
};
/** A fraction already IN bonus terms (0.18 meaning "+18%") as the same signed
 *  notation — atk speed, cooldown cut, stagger resist, leech, ash find: every
 *  field that starts at 0 and is added to. */
const bonusFrac = (frac) => {
  const p = Math.round(frac * 100);
  return `${p >= 0 ? '+' : ''}${p}%`;
};
/** An absolute rate (crit chance, damage floor) — a plain percentage with one
 *  decimal, the precision this project has always shown these at. Not a
 *  "bonus" in the additive sense, so it keeps its own notation rather than a
 *  forced sign. */
const pct = (v) => `${(v * 100).toFixed(1)}%`;
/** Dodge window: seconds, two decimals — literally the owner's complaint,
 *  answered. "0.11s" instead of "114ms". */
const fmtDodge = (sec) => `${sec.toFixed(2)}s`;
/** The one number that answers "total cap is 72%": the REAL combined
 *  reduction (vitality x armour, from armor.js's own combinedDR — the single
 *  computation site _damagePlayer uses) against the REAL cap, never the
 *  mockup's invented 75. */
const fmtDR = (frac) => `${Math.round(frac * 100)}% (CAP ${Math.round(TOTAL_DR_CAP * 100)}%)`;
/** Rewrites any stray "x<number>" token in a string THIS FILE did not
 *  compose — weaponSummary()/armorSummary() are owned by weapons.js /
 *  armor.js, not this file, and both still emit the old notation — into the
 *  same signed-percent form, so a row borrowed verbatim from either still
 *  keeps the one promise every number on this panel makes. */
const deMultiply = (str) => String(str).replace(/x(-?\d+(?:\.\d+)?)/g, (_, n) => bonusPct(Number(n)));

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
  ['Crit dmg', (a) => a.critDmgAdd, (v) => bonusFrac(v), (d) => bonusFrac(d)],
  ['Atk speed', (a) => a.atkSpeedAdd, (v) => bonusFrac(v), (d) => bonusFrac(d)],
  ['Speed', (a) => a.speedAdd, (v) => `+${v.toFixed(2)}`, (d) => `${d > 0 ? '+' : ''}${d.toFixed(2)}`],
  // Seconds, not ms — the SAME hard-numbers rule that governs the headline
  // dodge stat governs every appearance of it, deltas included.
  ['Dodge window', (a) => a.dodgeAdd, (v) => fmtDodge(v), (d) => `${d > 0 ? '+' : ''}${d.toFixed(2)}s`],
  ['Stagger resist', (a) => a.staggerResist, (v) => bonusFrac(v), (d) => bonusFrac(d)],
  ['Knockback cut', (a) => a.knockTaken, (v) => bonusFrac(v), (d) => bonusFrac(d)],
  ['Leech', (a) => a.leech, (v) => bonusFrac(v), (d) => bonusFrac(d)],
  ['Ash found', (a) => a.ashFind, (v) => bonusFrac(v), (d) => bonusFrac(d)],
];

// The weapon compare strip's twin: weapons carry a different field set, and
// COOLDOWN is the one row where LOWER is better — flagged per-row rather than
// inverting the whole strip's colour convention for one field.
const WEAPON_CMP_ROWS = [
  ['Power', (w) => w.dmgMul, (v) => bonusPct(v), (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`, true],
  ['Crit chance', (w) => w.critAdd, (v) => bonusFrac(v), (d) => bonusFrac(d), true],
  ['Crit mult', (w) => w.critMul, (v) => bonusPct(v), (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`, true],
  ['Reach', (w) => w.combo[0].range * w.reachMul, (v) => `${v.toFixed(1)}m`, (d) => `${d > 0 ? '+' : ''}${d.toFixed(1)}m`, true],
  ['Cooldown', (w) => w.cd, (v) => `${v.toFixed(2)}s`, (d) => `${d > 0 ? '+' : ''}${d.toFixed(2)}s`, false],
  ['Leech', (w) => w.leech || 0, (v) => bonusFrac(v), (d) => bonusFrac(d), true],
];

// Trinket effect labels, shared with armorSummary's own table.
const TRINKET_LABEL = {
  leech: 'Leech', ashFind: 'Ash found', luck: 'Luck', mpRegen: 'Mana regen', extract: 'Bind chance',
};
const trinketFmt = (key, v) => (key === 'mpRegen' ? `+${v.toFixed(1)}/s` : bonusFrac(v));

// Rank pill classes already exist in styles.css (.rank-E .. .rank-SOVEREIGN),
// so the panel's rank badge is the same colour as the gate the player is
// allowed into. Reusing them is what keeps two screens from disagreeing.
const CSS = `
/* .screen is z-index 20 and #cityUi is 40, so without this the district
   banner and the live OPEN button render ON TOP of the panel and eat taps —
   the same fix #shop needed, for the same reason. */
#inv { z-index: 60; }
body.gb-inv #cityUi { display: none !important; }
/* The HUD sits BELOW #inv (z-index 10) and is pointer-events:none, so it
   never ate taps — but its health orb / joystick / minimap now have a
   genuine chance to show through the panel's new transparent centre. Hiding
   it here is the same call #cityUi already gets: this panel's job is to show
   the REAL character, not whatever chrome happened to be drawn behind it. */
body.gb-inv #hud { display: none !important; }

/* THE PORTRAIT WINDOW. This is the whole reason the panel changed shape: the
   old .screen.overlay backdrop (rgba(3,4,10,.86) + a 10px blur) and the
   shared .panel's own opaque background together made it IMPOSSIBLE for
   anything behind #inv to show through, no matter what the live scene was
   doing. A transparent CHILD does not punch a hole in an opaque PARENT's own
   paint — so the parent's paint has to go. Every piece of chrome below
   (rails, the header bar, the ticker, the stage buttons) carries its OWN
   background instead, exactly like the mockup's individual boxes; the
   negative space between them — the stage centre most of all — is where the
   isolated character-viewer render (see game.enterInventoryView /
   game.previewCamera) shows through.
   Sub-sheets (compare/sets/stats) are the deliberate exception: they cover
   the stage with a real backdrop because browsing a list is not the moment
   to also be parsing a character behind it. */
#inv.screen.overlay { background: rgba(3, 4, 10, .28); backdrop-filter: none; }
#inv .panel.wide { background: transparent; border: none; box-shadow: none; padding: 8px 10px; gap: 6px; }

#inv .headbar {
  display: flex; align-items: center; gap: 10px; padding: 6px 10px;
  border: 1px solid rgba(124,92,255,.35); border-radius: 8px;
  background: rgba(12,14,28,.92);
}
#inv .headbar h2 { font-size: 14px; letter-spacing: .2em; flex: 1; text-align: left; margin: 0; }
/* Tap-to-rename affordance (invTitleName is the <h2>): a dashed underline
   reads as "editable" without a second icon element competing for the same
   14px of header height. invTitleEdit is the <input> _startRename swaps in —
   same box/type/spacing as the h2 it replaces so the header does not reflow
   the moment you tap it. */
#inv .headbar h2.invTitleName { cursor: pointer; border-bottom: 1px dashed rgba(124,92,255,.45); padding-bottom: 1px; width: fit-content; max-width: 100%; }
#inv .headbar input.invTitleEdit {
  font: inherit; font-size: 14px; letter-spacing: .2em; flex: 1; text-align: left; margin: 0;
  color: var(--ink); background: rgba(124,92,255,.12); border: 1px solid var(--accent);
  border-radius: 4px; padding: 2px 6px; min-width: 0;
}
#inv .headbar input.invTitleEdit::placeholder { color: var(--dim); letter-spacing: .05em; }
#inv .headbar .btn { width: auto; padding: 7px 14px; font-size: 11px; min-height: 36px; }

#inv .inv-wallet {
  display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  border: 1px solid rgba(124,92,255,.35); border-radius: 8px;
  padding: 5px 12px; font-size: 11px; letter-spacing: .1em;
  background: rgba(12,14,28,.85);
}
#inv .inv-wallet b { color: var(--ink); }
#inv .inv-wallet .ash b { color: var(--gold); }
#inv .inv-wallet span { color: var(--dim); }

/* THE STAGE: left rail | centre character window | right rail. flex:1 so it
   claims every pixel the header/wallet/ticker do not need — a landscape
   phone has ~230-260 px to spend here and that is the whole budget. */
#inv .stage { display: flex; gap: 6px; flex: 1 1 auto; min-height: 0; }
#inv .rail { width: 132px; flex: 0 0 132px; display: flex; flex-direction: column; gap: 5px; }
#inv .rail .slot {
  flex: 1 1 0; min-height: 44px; display: flex; align-items: center; gap: 7px;
  padding: 4px 7px; text-align: left; cursor: pointer; border-radius: 6px;
  background: rgba(12,14,28,.92); border: 1px solid rgba(124,92,255,.35);
  color: var(--dim); font: inherit;
}
#inv .rail .slot.sel { border-color: var(--accent); box-shadow: 0 0 12px rgba(124,92,255,.4); }
#inv .rail .slot.locked { opacity: .55; }
#inv .rail .slot i { width: 26px; height: 26px; flex: none; border-radius: 5px; border: 1px solid rgba(180,190,220,.3); }
#inv .rail .slot .meta { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
#inv .rail .slot .code {
  font-size: 7.5px; letter-spacing: .16em; color: var(--dim); font-weight: 700;
}
#inv .rail .slot b {
  font-size: 10.5px; letter-spacing: .04em; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 100%; font-weight: 600;
}
#inv .rail .slot small { font-size: 8px; letter-spacing: .1em; color: var(--dim); }
/* No leg icon exists in the 108-key atlas, so a legs piece reuses its set's
   chest icon DESATURATED — legible as "same set, different piece" instead of
   mistakable for the chest itself. Flagged in RPG_SPEC openQuestions. */
#inv .desat { filter: saturate(.35) brightness(.9); }

/* THE CHARACTER WINDOW. No background of its own beyond a faint vignette —
   see the CSS block comment above for why: this is the one region of the
   panel deliberately left for the live game to show through. */
#inv .stageCenter {
  flex: 1 1 0; min-width: 0; position: relative;
  background: radial-gradient(60% 70% at 50% 42%, rgba(124,92,255,.10), rgba(5,6,13,0) 70%);
  border: 1px solid rgba(124,92,255,.18); border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
}
#inv .idBox {
  position: absolute; top: 8px; display: flex; flex-direction: column; gap: 2px;
  /* A live scene behind the text is not a controlled backdrop — the strong
     shadow is what keeps DIRECTION/CLASS legible over whatever the player is
     standing in front of, plaza or dungeon, without boxing the text in and
     covering more of the character than the label needs to. */
  text-shadow: 0 1px 3px rgba(0,0,0,.9), 0 0 10px rgba(0,0,0,.75);
}
#inv .idBox.left { left: 9px; align-items: flex-start; }
#inv .idBox.right { right: 9px; align-items: flex-end; text-align: right; }
#inv .idBox .lbl { font-size: 7.5px; letter-spacing: .2em; color: #c7cbe0; }
#inv .idBox .dir { font-size: 13px; font-weight: 800; letter-spacing: .1em; color: var(--accent2); }
#inv .idBox .cls { font-size: 12px; font-weight: 800; letter-spacing: .08em; color: var(--ink); }
/* Benefit and drawback at the SAME size, forever — a class whose downside the
   player did not read is a class they will blame the game for. */
#inv .idBox .benefit, #inv .idBox .drawback { font-size: 9px; font-weight: 700; letter-spacing: .04em; max-width: 40vw; }
#inv .idBox .benefit { color: var(--accent2); }
#inv .idBox .drawback { color: var(--danger); }

#inv .stageActions { display: flex; gap: 7px; margin-bottom: 8px; flex-wrap: wrap; justify-content: center; }
#inv .stageActions .btn {
  width: auto; padding: 8px 16px; font-size: 11px; letter-spacing: .16em; min-height: 40px;
  background: rgba(124,92,255,.22); border-color: var(--accent);
}
/* The stance toggle reuses .stageActions' layout but needs its OFF state to
   read as off — .btn.ghost alone loses that fight on specificity (both rules
   are .stageActions .btn / .btn.ghost at equal specificity, and this
   stylesheet is appended after styles.css, so it would otherwise win the tie
   for every button regardless of ghost/on). Spelled out here so the toggle's
   three buttons are visually distinguishable, not just DOM-distinguishable. */
#inv .stanceGroup .btn.ghost { background: transparent; border-color: rgba(255,255,255,.14); color: var(--dim); }
#inv .stanceGroup .btn.on { background: rgba(124,92,255,.32); border-color: var(--accent); color: var(--ink); font-weight: 800; }

/* THE BOTTOM TICKER: ~8 key stats always visible, plus the two sheet buttons.
   Its own opaque bar for the same reason every other piece of chrome has one. */
#inv .ticker {
  flex: none; display: flex; align-items: stretch;
  border: 1px solid rgba(124,92,255,.35); border-radius: 8px; overflow: hidden;
  background: rgba(12,14,28,.92);
}
#inv .ticker .cell {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 1px; padding: 5px 3px; border-right: 1px solid rgba(124,92,255,.15);
}
/* min-width:0 on .cell lets a narrow cell shrink below its content's natural
   width, but a nowrap child does not clip ITSELF — the ticker's own
   overflow:hidden only catches the outer edge, so a wide value (a DR readout
   like "42% (CAP 72%)") or label ("DMG RED.") in a ~50px cell bled into the
   NEIGHBOUR cell instead of just disappearing off the panel. Same
   overflow/ellipsis/max-width trio .rail .slot b already uses for the same
   reason, applied here too. */
#inv .ticker .cell .lbl { font-size: 7px; letter-spacing: .1em; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
#inv .ticker .cell .val { font-size: 12px; font-weight: 800; letter-spacing: .02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; color: var(--ink); }
#inv .ticker button {
  flex: none; padding: 5px 10px; cursor: pointer; border: 0; border-left: 1px solid rgba(124,92,255,.35);
  background: rgba(124,92,255,.16); color: var(--ink); font: inherit; font-size: 9.5px;
  font-weight: 800; letter-spacing: .1em; min-height: 44px;
}
#inv .ticker button:active { background: rgba(124,92,255,.3); }

/* THE OVERLAY SHEETS: compare / sets / stats. Unlike the stage, these DO want
   a real backdrop — a delta strip or a five-set grid is not the moment to
   also be parsing a live character behind it. */
#inv .overlay {
  position: absolute; inset: 6px; z-index: 2; display: flex; flex-direction: column;
  background: rgba(5,6,13,.95); border: 1px solid rgba(124,92,255,.55);
  border-radius: 10px; box-shadow: 0 0 40px rgba(0,0,0,.5);
}
#inv .overlay.hidden { display: none; }
#inv .overlay .ohead {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-bottom: 1px solid rgba(124,92,255,.3); flex: none;
}
#inv .overlay .ohead b { flex: 1; font-size: 12px; letter-spacing: .2em; color: var(--accent2); }
#inv .overlay .ohead .btn { width: auto; padding: 7px 14px; font-size: 10.5px; min-height: 36px; }
/* No overflow of its own — see _renderOverlay's comment. A single
   .scrollWrap/.scrollCol (built by _makeScrollBox) fills this and owns the
   actual scrolling + the panel's own rail; a second native overflow here
   would just absorb the growth and leave that rail permanently unused. */
#inv .overlay .obody { flex: 1 1 auto; min-height: 0; padding: 9px 12px; display: flex; }

/* The compare row: EQUIPPED | CANDIDATE | DELTAS | EQUIP. */
#inv .cmpRow { display: flex; gap: 7px; margin-bottom: 8px; flex-wrap: wrap; }
#inv .cmpCard { flex: 1 1 150px; min-width: 0; padding: 7px 9px; border-radius: 6px; }
#inv .cmpCard.eq { background: rgba(255,255,255,.03); border: 1px solid rgba(124,92,255,.3); }
#inv .cmpCard.cand { background: rgba(34,211,238,.06); border: 1px solid rgba(34,211,238,.4); }
#inv .cmpCard .lbl { font-size: 7.5px; letter-spacing: .18em; color: var(--dim); }
#inv .cmpCard .nm { font-size: 12.5px; font-weight: 800; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#inv .cmpCard .ln { font-size: 9.5px; color: var(--dim); letter-spacing: .04em; }
#inv .deltas { flex: 1 1 160px; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; background: rgba(255,255,255,.03); border: 1px solid rgba(124,92,255,.3); border-radius: 6px; }
#inv .deltas .drow { display: flex; justify-content: space-between; gap: 6px; font-size: 10px; }
#inv .deltas .drow span { color: var(--dim); }
#inv .deltas .drow .cur { color: var(--dim); }
#inv .deltas .drow .cand b { color: var(--ink); }
#inv .deltas .drow .up { color: #54e08a; }
#inv .deltas .drow .down { color: var(--danger); }
#inv .deltas .hint { color: var(--dim); font-size: 10px; line-height: 1.6; }
#inv .cmpEquip {
  flex: 0 0 auto; align-self: stretch; width: auto; padding: 0 18px;
  font-size: 11px; letter-spacing: .16em; min-height: 44px;
}
#inv .cmp-reason { color: var(--danger); font-size: 10.5px; letter-spacing: .08em; margin: -4px 0 8px; }
#inv .unequip { margin-bottom: 8px; padding: 8px; font-size: 11px; width: 100%; min-height: 40px; }

/* The candidate list: the SAME 44px-floor row shape the Exchange proved out. */
#inv .candList .sect { color: var(--accent2); font-size: 10px; letter-spacing: .18em; margin: 4px 0 5px; }
#inv .gate { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 9px; margin-bottom: 5px; min-height: 44px; text-align: left; cursor: pointer; border-radius: 6px; background: rgba(255,255,255,.02); border: 1px solid rgba(124,92,255,.2); color: var(--ink); font: inherit; }
#inv .gate.sel { border-color: #22d3ee; background: rgba(34,211,238,.1); }
#inv .gate.on { border-color: var(--accent); background: rgba(124,92,255,.14); }
#inv .gate.locked { opacity: .55; }
#inv .gate i { width: 32px; height: 32px; flex: 0 0 32px; border-radius: 7px; border: 2px solid transparent; }
#inv .gate .code { font-size: 7px; letter-spacing: .1em; color: var(--dim); display: block; }
#inv .gate .meta { min-width: 0; flex: 1 1 auto; }
#inv .gate .meta b { display: block; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#inv .gate .meta small { color: var(--dim); font-size: 10px; letter-spacing: .04em; }
#inv .gate .tagline { flex: 0 0 auto; font-size: 10px; font-weight: 800; letter-spacing: .06em; }

/* LEGENDARY rows read as the top of the ladder at a glance: the gold border
   the rarity tint already provides, plus a soft outer bloom. This is UI
   chrome, not a scene material — the no-glow-on-living-characters law governs
   meshes, and a DOM box-shadow is neither rim nor emissive. */
#inv .gate.leg { border-color: rgba(255,194,75,.75); background: linear-gradient(90deg, rgba(255,194,75,.14), rgba(255,194,75,.04)); box-shadow: 0 0 10px rgba(255,194,75,.28); }
#inv .cmpCard.leg { border-color: rgba(255,194,75,.75); box-shadow: 0 0 10px rgba(255,194,75,.28); }

/* The legendary's named clause and the ascension recipe, both homed in the
   weapon compare sheet. */
#inv .rule { border: 1px solid rgba(255,194,75,.6); border-radius: 8px; padding: 8px 10px; background: rgba(255,194,75,.07); color: var(--ink); font-size: 11px; line-height: 1.55; margin-bottom: 8px; }
#inv .rule b { color: #ffc24b; letter-spacing: .1em; display: block; margin-bottom: 2px; }
#inv .asc { border: 1px solid var(--edge); border-radius: 8px; padding: 8px 10px; background: rgba(255,194,75,.05); margin-bottom: 8px; }
#inv .asc .crow { display: flex; gap: 8px; align-items: baseline; font-size: 11px; padding: 2px 0; }
#inv .asc .crow span { color: var(--dim); flex: 1 1 auto; letter-spacing: .05em; }
#inv .asc .crow b { flex: 0 0 auto; }
#inv .asc .crow.met b { color: #54e08a; }
#inv .asc .crow.unmet b { color: var(--danger); }
#inv .asc .btn { width: 100%; margin-top: 7px; padding: 8px; font-size: 11px; min-height: 40px; }
#inv .asc .asc-reason { color: var(--danger); font-size: 10px; letter-spacing: .08em; margin-top: 5px; }

#inv .note { border: 1px dashed rgba(255,255,255,.16); border-radius: 8px; padding: 9px 11px; color: var(--dim); font-size: 11px; line-height: 1.65; }
#inv .note b { color: var(--ink); }

/* The STATS sheet's readout, and its zoned DERIVED groups (OFFENSE / DEFENSE
   / MOBILITY / RESOURCE) — everything the old tabbed STATS view held, nothing
   cut, just no longer competing with GEAR for the same screen. */
#inv .sect { color: var(--accent2); font-size: 10px; letter-spacing: .18em; margin: 10px 0 4px; }
#inv .sect:first-child { margin-top: 0; }
#inv .readout { font-size: 12.5px; color: var(--dim); line-height: 1.75; }
#inv .readout b { color: var(--ink); }
#inv .readout .row { display: flex; justify-content: space-between; gap: 10px; }
#inv .readout .row small { color: var(--dim); font-size: 9.5px; letter-spacing: .04em; }
#inv .zones { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 4px; }
@media (max-width: 620px) { #inv .zones { grid-template-columns: 1fr; } }
#inv .zone { border: 1px solid rgba(124,92,255,.25); border-radius: 7px; padding: 7px 9px; }
#inv .zone .ztitle { font-size: 9.5px; font-weight: 800; letter-spacing: .16em; margin-bottom: 4px; }

/* The SETS sheet: one card per set, ALL FIVE, not just the worn ones — this
   sheet IS the "collect a set" reward loop, and a loop the player cannot see
   the whole of is not a loop. */
#inv .setGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
#inv .setCard { display: flex; flex-direction: column; gap: 5px; padding: 8px; background: rgba(255,255,255,.02); border: 1px solid rgba(124,92,255,.25); border-radius: 7px; }
#inv .setCard .shead { display: flex; align-items: baseline; gap: 5px; }
#inv .setCard .shead b { font-size: 11.5px; letter-spacing: .08em; flex: 1; }
#inv .pips { display: flex; gap: 3px; }
#inv .pips span { flex: 1; height: 4px; border-radius: 2px; background: rgba(255,255,255,.08); border: 1px solid rgba(124,92,255,.3); }
#inv .pips span.on { background: var(--accent2); border-color: var(--accent2); }
#inv .tier { display: flex; gap: 5px; padding: 4px 5px; border-radius: 4px; background: rgba(255,255,255,.02); border-left: 2px solid rgba(138,147,184,.5); opacity: .5; }
#inv .tier.live { opacity: 1; border-left-color: var(--accent2); background: rgba(124,92,255,.1); }
#inv .tier .n { font-size: 9px; font-weight: 800; color: var(--dim); flex: none; }
#inv .tier.live .n { color: var(--accent2); }
#inv .tier .t { font-size: 9px; line-height: 1.3; letter-spacing: .03em; color: var(--dim); }
#inv .tier.live .t { color: var(--ink); }

/* Panel-owned scroll rail, same reasoning that shipped it for the old STATS
   tab: native scrollbars are overlay-or-nothing platform policy (measured on
   this project's own harness Chromium — even a pure ::-webkit-scrollbar
   customisation stayed an invisible overlay bar until mid-scroll), so any box
   in this panel that can overflow draws its own. */
#inv .scrollWrap { position: relative; min-height: 0; flex: 1 1 auto; display: flex; }
#inv .scrollCol { flex: 1 1 auto; overflow-y: auto; scrollbar-width: none; padding-right: 12px; min-height: 0; }
#inv .scrollCol::-webkit-scrollbar { display: none; width: 0; }
#inv .rail2 { position: absolute; right: 0; top: 2px; bottom: 2px; width: 6px; border-radius: 3px; background: rgba(255,255,255,.08); pointer-events: none; }
#inv .rail2 .thumb { position: absolute; left: 0; right: 0; border-radius: 3px; background: rgba(124,92,255,.65); min-height: 24px; }
#inv .scrollWrap.no-scroll .rail2 { display: none; }

/* Desktop Chrome and portrait have the room to breathe: the rails widen and
   the ticker cells get more air. */
@media (min-width: 700px) and (min-height: 620px) {
  #inv .rail { width: 168px; flex-basis: 168px; }
  #inv .ticker .cell { padding: 8px 5px; }
  #inv .ticker .cell .val { font-size: 14px; }
}

/* A landscape phone is the tightest case in the game: ~412 px tall with a
   notch. Every row reclaimed here is a row the sheet can spend on the stage
   instead, so the chrome gives up its height first. */
@media (orientation: landscape) and (max-height: 520px) {
  #inv .panel { max-height: 96vh; }
  #inv .headbar { padding: 4px 8px; }
  #inv .headbar h2 { font-size: 12.5px; }
  #inv .inv-wallet { padding: 3px 10px; font-size: 10px; }
  #inv .rail { width: 108px; flex-basis: 108px; }
  #inv .rail .slot b { font-size: 9.5px; }
  #inv .stageActions .btn { padding: 6px 12px; font-size: 10px; min-height: 36px; }
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
    // The rail slot currently "focused" — the OPEN STASH button and every
    // rail tap both funnel through this, defaulting to the weapon so a bare
    // OPEN STASH tap on a fresh open has something sensible to show.
    this._slot = 'weapon';
    // True for the span between _startRename swapping the title for an
    // <input> and that input's own finish() swapping it back — render()'s
    // own title refresh backs off while this is set so it cannot clobber the
    // input mid-edit.
    this._renaming = false;
    // null | 'compare' | 'sets' | 'stats'. Only one sheet is ever up; opening
    // one always replaces whichever was showing, matching the rest of the
    // panel's "one overlay at a time" rule.
    this._sheet = null;
    // Index into the slot's own candidate source (g.stash for weapons,
    // g.armorStash for armour/trinket) of the candidate under review inside
    // the compare sheet, or -1 for none. Cleared on every slot change and
    // every sheet close — a delta strip comparing a helmet must not survive
    // into the chest slot.
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
    // Every scrollbox this render() built (see _makeScrollBox), refreshed via
    // rAF once layout has settled — the STATS sheet, the SETS sheet and the
    // compare sheet's candidate list each get their own.
    this._scrollBoxes = [];

    const screen = el('div', 'screen overlay hidden');
    screen.id = 'inv';

    const panel = el('div', 'panel wide');

    const headbar = el('div', 'headbar');
    // Tap to rename — see _startRename. Text content is kept live by
    // _renderTitle (called from render()), never set again after this.
    this.titleEl = el('h2', 'invTitleName', 'THE HUNTER');
    this.titleEl.id = 'invTitle';
    this.titleEl.title = 'Tap to rename';
    this.titleEl.tabIndex = 0;
    this.titleEl.addEventListener('click', () => this._startRename());
    headbar.appendChild(this.titleEl);
    const close = el('button', 'btn ghost', 'CLOSE');
    close.id = 'invClose';
    close.type = 'button';
    close.addEventListener('click', () => { this.audio?.ui?.(); this.close(); });
    headbar.appendChild(close);
    panel.appendChild(headbar);

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

    // -------------------------------------------------------------- stage
    const stage = el('div', 'stage');
    this.railLeftEl = el('div', 'rail');
    this.railLeftEl.id = 'invRailLeft';
    stage.appendChild(this.railLeftEl);

    const stageCenter = el('div', 'stageCenter');
    stageCenter.id = 'invStageCenter';
    // The REAL character shows through THIS element — see the CSS comment
    // above. Nothing is ever drawn into it; it is a deliberately empty window
    // onto game.previewCamera's isolated render, not onto any DOM content of
    // its own. _bindSpin below turns a drag anywhere in this window into a
    // camera orbit, via game.spinInventoryView.
    const idL = el('div', 'idBox left');
    this.dirLabelEl = el('div', 'dir', 'UNSWORN');
    idL.append(el('div', 'lbl', 'DIRECTION'), this.dirLabelEl);
    const idR = el('div', 'idBox right');
    this.classLabelEl = el('div', 'cls', '—');
    this.benefitEl = el('div', 'benefit', '');
    this.drawbackEl = el('div', 'drawback', '');
    idR.append(this.classLabelEl, this.benefitEl, this.drawbackEl);
    stageCenter.append(idL, idR);

    const actions = el('div', 'stageActions');
    // The plaza show-off control, in the owner's own words: "the sword can be
    // visible or placed in the inventory". Long-pressing attack and desktop's
    // X key do the same thing; this is the discoverable one. Homed on the
    // stage now, next to the character it affects, per the port brief.
    this.stanceBtn = el('button', 'btn', 'SHEATHE');
    this.stanceBtn.id = 'invStance';
    this.stanceBtn.type = 'button';
    this.stanceBtn.addEventListener('click', () => this._toggleStance());
    const openStash = el('button', 'btn', 'OPEN STASH');
    openStash.id = 'invOpenStash';
    openStash.type = 'button';
    openStash.addEventListener('click', () => {
      this.audio?.ui?.();
      this._sheet = 'compare';
      this._cmp = -1;
      this.render();
    });
    actions.append(this.stanceBtn, openStash);
    stageCenter.appendChild(actions);
    this._bindSpin(stageCenter);
    // The character-viewer render is hard-clipped to THIS rectangle every
    // frame (see game.js's _renderInventoryPreview) — registered once since
    // stageCenter itself is only ever built once (this file's own header
    // comment), and read live rather than snapshotted so a device rotation or
    // a responsive rail-width breakpoint while the panel is open is honoured
    // immediately instead of leaving the render clipped to a stale rectangle.
    this.game?.setInventoryStageRectProvider?.(() => stageCenter.getBoundingClientRect());
    stage.appendChild(stageCenter);

    this.railRightEl = el('div', 'rail');
    this.railRightEl.id = 'invRailRight';
    stage.appendChild(this.railRightEl);
    panel.appendChild(stage);

    // -------------------------------------------------------------- ticker
    this.tickerEl = el('div', 'ticker');
    this.tickerEl.id = 'invTicker';
    panel.appendChild(this.tickerEl);

    // -------------------------------------------------------------- overlay
    // One shared shell for all three sheets (compare / sets / stats) — the
    // mockup's own showOverlay/showSetsSheet are mutually exclusive, so one
    // container that swaps its body is the same behaviour with one fewer DOM
    // subtree to keep in sync.
    this.overlayEl = el('div', 'overlay hidden');
    this.overlayEl.id = 'invOverlay';
    const ohead = el('div', 'ohead');
    this.overlayTitleEl = el('b', null, '');
    this.overlayTitleEl.id = 'invOverlayTitle';
    const oclose = el('button', 'btn ghost', 'CLOSE');
    oclose.id = 'invOverlayClose';
    oclose.type = 'button';
    oclose.addEventListener('click', () => {
      this.audio?.ui?.();
      this._sheet = null;
      this._cmp = -1;
      this.render();
    });
    ohead.append(this.overlayTitleEl, oclose);
    this.overlayBodyEl = el('div', 'obody');
    this.overlayBodyEl.id = 'invOverlayBody';
    this.overlayEl.append(ohead, this.overlayBodyEl);
    panel.appendChild(this.overlayEl);

    screen.appendChild(panel);
    root.appendChild(screen);
    this.root = screen;
  }

  /** Drag anywhere on the character window to spin it — the same touch+mouse
   *  dual-binding shape input.js's world orbit-drag uses (see its own
   *  _bindOrbit), scoped to this one element so it can never fight the world
   *  camera's own drag: the panel already sits above the canvas in stacking
   *  order (z-index 60 vs canvas being the lowest paint), so a touch that
   *  starts here never reaches Input's canvas listener at all — the exact
   *  same "buttons keep winning without any geometry checks" fact input.js's
   *  own comment documents for the skill buttons. Starts on the stance/open
   *  buttons are explicitly excluded so a tap on either still reads as a tap,
   *  not a zero-distance drag. 1:1 and inertia-free, matching input.js's own
   *  stated reason for that choice: a model that keeps spinning after the
   *  thumb lifts is a model the player fights. */
  _bindSpin(el2) {
    let id = null;
    let lastX = 0;
    const start = (e) => {
      if (id !== null) return;
      if (e.target.closest?.('.stageActions')) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      id = e.changedTouches ? t.identifier : 'mouse';
      lastX = t.clientX;
      e.preventDefault();
    };
    const move = (e) => {
      if (id === null) return;
      let t = e;
      if (e.changedTouches) {
        t = [...e.changedTouches].find((c) => c.identifier === id);
        if (!t) return;
      } else if (id !== 'mouse') return;
      const dx = t.clientX - lastX;
      lastX = t.clientX;
      this.game?.spinInventoryView?.(dx);
      e.preventDefault();
    };
    const end = (e) => {
      if (id === null) return;
      if (e.changedTouches && ![...e.changedTouches].some((c) => c.identifier === id)) return;
      id = null;
    };
    el2.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    el2.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
  }

  get isOpen() { return this._open; }

  open() {
    if (!this.game) return false;
    this._sheet = null;
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
    // Hand the frame to the isolated character-viewer camera — see the header
    // comment and game.js's enterInventoryView for why this, not a placeholder
    // render, is the whole character-preview mechanism.
    this.game.enterInventoryView?.();
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
    // Hand the camera back to whatever mode owns it — see
    // game.exitInventoryView for why there is nothing else to restore.
    this.game?.exitInventoryView?.();
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
    this._renderTitle();
    this.lvValue.textContent = String(save.level || 1);
    this.rankValue.textContent = rankOf(save.level || 1);
    const need = xpForLevel(save.level || 1);
    this.xpValue.textContent = `${Math.max(0, need - (save.xp || 0))} XP`;
    this.ashValue.textContent = String(Math.floor(save.ash || 0));

    this._scrollBoxes = [];
    this._renderSlots();
    this._renderStanceBtn();
    this._renderIdentity();
    this._renderTicker();
    this._renderOverlay();
    // Layout has to settle before scrollHeight means anything, and render()
    // can be called while the panel is still hidden on open().
    requestAnimationFrame(() => this._updateScrollHints());
  }

  /** A scrollable box with the panel's own rail — see the CSS comment on
   *  .scrollWrap. Returns the element to append rows into; the wrap/rail pair
   *  is tracked on this._scrollBoxes so render() can refresh every box's hint
   *  in one pass regardless of which sheet is open. */
  _makeScrollBox(parent) {
    const wrap = el('div', 'scrollWrap');
    const col = el('div', 'scrollCol');
    wrap.appendChild(col);
    const rail = el('div', 'rail2');
    const thumb = el('div', 'thumb');
    rail.appendChild(thumb);
    wrap.appendChild(rail);
    col.addEventListener('scroll', () => this._updateScrollHints(), { passive: true });
    parent.appendChild(wrap);
    this._scrollBoxes.push({ wrap, col, rail, thumb });
    return col;
  }

  _updateScrollHints() {
    for (const { wrap, col, rail, thumb } of this._scrollBoxes) {
      const overflow = col.scrollHeight - col.clientHeight;
      wrap.classList.toggle('no-scroll', overflow <= 4);
      if (overflow > 4) {
        const railH = rail.clientHeight;
        const thumbH = Math.max(24, (col.clientHeight / col.scrollHeight) * railH);
        const y = (col.scrollTop / overflow) * (railH - thumbH);
        thumb.style.height = `${Math.round(thumbH)}px`;
        thumb.style.transform = `translateY(${Math.round(y)}px)`;
      }
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
    this.railLeftEl.textContent = '';
    this.railRightEl.textContent = '';
    for (const id of EQUIP_SLOTS) {
      const meta = SLOTS[id];
      const target = LEFT_SLOTS.includes(id) ? this.railLeftEl : this.railRightEl;
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
      // player nothing about where a helmet goes.
      const iconKey = held ? (id === 'weapon' ? weaponIcon(held) : held.base.icon) : meta.icon;
      box.setAttribute('style', iconStyle(iconKey, 26));
      if (held) box.style.borderColor = hex(rarityColor(held.rarity));
      else box.style.opacity = '0.3';
      if (held && id === 'legs') box.classList.add('desat');
      btn.appendChild(box);

      const metaEl = el('span', 'meta');
      metaEl.appendChild(el('span', 'code', meta.code));
      const nameEl = el('b', null, held ? held.name : meta.name);
      if (held) nameEl.style.color = hex(rarityColor(held.rarity));
      metaEl.appendChild(nameEl);
      metaEl.appendChild(el('small', null, held ? meta.name : 'EMPTY'));
      btn.appendChild(metaEl);

      btn.addEventListener('click', () => {
        this.audio?.ui?.();
        this._slot = id;
        this._sheet = 'compare';
        this._cmp = -1;
        this.render();
      });
      target.appendChild(btn);
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

  /** Keeps the headbar title honest — never set outside this and the input
   *  swap in _startRename, so a save loaded from a different tab or a rename
   *  committed elsewhere is never stale for longer than the next render(). */
  _renderTitle() {
    if (this._renaming) return; // an <input> owns the slot right now — see _startRename
    this.titleEl.textContent = this.game.save.hunterName || 'THE HUNTER';
  }

  /** Swap the header title for a text input, in place, on tap. save.hunterName
   *  is null-default (see save.js's own comment on that field), so an empty
   *  commit is a deliberate "clear the name" rather than a rejected input —
   *  it just falls back to THE HUNTER on the very next render. Persists
   *  through game.onSave() directly: this is a single scalar field, not a
   *  loadout write, so it does not go through _persistLoadout — see that
   *  method's own comment for why loadout writes need the heavier path and
   *  this one does not. */
  _startRename() {
    if (this._renaming) return;
    this._renaming = true;
    const g = this.game;
    const current = g.save.hunterName || '';
    const input = el('input', 'invTitleName invTitleEdit');
    input.id = 'invTitleInput';
    input.type = 'text';
    input.maxLength = 20;
    input.value = current;
    input.placeholder = 'THE HUNTER';
    input.autocomplete = 'off';
    input.spellcheck = false;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      this._renaming = false;
      if (commit) {
        const val = input.value.trim().slice(0, 20);
        g.save.hunterName = val || null;
        g.onSave?.();
      }
      input.replaceWith(this.titleEl);
      this._renderTitle();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    this.titleEl.replaceWith(input);
    input.focus();
    input.select();
  }

  /** DIRECTION top-left, CLASS + benefit/drawback top-right — the identity
   *  overlay printed straight over the character window, exactly where the
   *  V3 mockup put it. */
  _renderIdentity() {
    const save = this.game.save;
    const dirKey = directionOf(save);
    // Direction is DERIVED from spent points (never chosen in a menu), so the
    // label simply names what the player has been doing. UNSWORN is a real,
    // non-punished state.
    this.dirLabelEl.textContent = dirKey === 'unsworn' ? 'UNSWORN' : DIRECTIONS[dirKey].name;
    const cls = CLASSES[save.className];
    if (cls) {
      this.classLabelEl.textContent = cls.name;
      this.benefitEl.textContent = `+ ${cls.benefitText}`;
      this.drawbackEl.textContent = `− ${cls.drawbackText}`;
    } else {
      this.classLabelEl.textContent = (save.level || 1) >= 20 ? 'UNCLASSED' : `CLASS AT LV 20`;
      this.benefitEl.textContent = '';
      this.drawbackEl.textContent = '';
    }
  }

  /** The bottom ticker: ~8 always-visible numbers, plus the two sheet
   *  buttons. Every value goes through the hard-numbers helpers — this is
   *  the panel's highest-traffic surface, so it is the one place the owner's
   *  two named complaints (the "1.49" multiplier, the "114 ms" dodge window)
   *  are guaranteed to be seen fixed. */
  _renderTicker() {
    const g = this.game;
    const save = g.save;
    const dBase = derive(save, g._armorBonus || null);
    const d = applyLayers(save, dBase);
    const totalDR = combinedDR(d.dr, d.armorDR);
    const totalAp = ARMOR_SLOTS.reduce((sum, slot) => {
      const inst = this._wornInstance(slot);
      return sum + (inst ? inst.ap : 0);
    }, 0);
    const counts = setProgress(save.equipment);
    let activeSets = 0;
    for (const n of counts.values()) if (n >= 2) activeSets++;

    this.tickerEl.textContent = '';
    const cell = (label, val) => {
      const c = el('div', 'cell');
      c.append(el('div', 'lbl', label), el('div', 'val', val));
      this.tickerEl.appendChild(c);
    };
    cell('ATK POWER', d.atk.toFixed(1));
    cell('CRIT', pct(d.crit));
    cell('CRIT DMG', bonusPct(d.critDmg));
    cell('MAX HEALTH', String(d.maxHp));
    cell('DMG RED.', fmtDR(totalDR));
    cell('ARMOR', String(Math.round(totalAp)));
    cell('MOVE SPD', d.speed.toFixed(2));
    cell('DODGE', fmtDodge(d.dodgeWindow));

    const statsBtn = el('button', null, 'STATS');
    statsBtn.id = 'invStatsBtn';
    statsBtn.type = 'button';
    statsBtn.addEventListener('click', () => { this.audio?.ui?.(); this._sheet = 'stats'; this.render(); });
    this.tickerEl.appendChild(statsBtn);

    const setsBtn = el('button', null, `SETS ${activeSets} ACTIVE`);
    setsBtn.id = 'invSetsBtn';
    setsBtn.type = 'button';
    setsBtn.addEventListener('click', () => { this.audio?.ui?.(); this._sheet = 'sets'; this.render(); });
    this.tickerEl.appendChild(setsBtn);
  }

  // ---------------------------------------------------------------- overlay

  _renderOverlay() {
    const show = Boolean(this._sheet);
    this.overlayEl.classList.toggle('hidden', !show);
    if (!show) return;
    this.overlayBodyEl.textContent = '';
    // ONE scrollbox for the whole sheet body — see the CSS comment on .obody.
    // .obody used to carry its OWN native overflow-y:auto while every sheet
    // renderer ALSO nested a _makeScrollBox candidate list inside it; the
    // outer native scroll absorbed all the growth, so the inner box never
    // overflowed and the panel-owned rail (the whole point of _makeScrollBox
    // — see its own comment) never appeared. One scrollbox, built here,
    // spanning the entire sheet, is both simpler and the box that actually
    // gets used.
    const body = this._makeScrollBox(this.overlayBodyEl);
    if (this._sheet === 'sets') {
      this.overlayTitleEl.textContent = 'ARMOR SETS';
      this._renderSetsSheet(body);
    } else if (this._sheet === 'stats') {
      this.overlayTitleEl.textContent = 'THE FULL SHEET';
      this._renderStatsSheet(body);
    } else {
      const meta = SLOTS[this._slot];
      this.overlayTitleEl.textContent = `${meta.name} SLOT`;
      this._renderCompareSheet(body, meta);
    }
  }

  // ------------------------------------------------------------ compare

  _renderCompareSheet(body, meta) {
    if (meta.kind === 'w') return this._renderWeaponCompare(body, meta);
    if (!meta.live) return this._renderLockedCompare(body, meta);
    return this._renderArmorCompare(body, meta);
  }

  _renderLockedCompare(body, meta) {
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

  _renderWeaponCompare(body, meta) {
    const g = this.game;
    const held = g.weapon;
    const stash = Array.isArray(g.stash) ? g.stash : [];
    const cand = this._cmp >= 0 ? stash[this._cmp] : null;

    this._renderCmpRow(body, {
      curName: held?.name, curColor: held ? hex(rarityColor(held.rarity)) : null,
      curLine: held ? `${held.arch.name}  ·  ${bonusPct(held.dmgMul)} power  ·  LV ${held.level}` : 'EMPTY',
      curLegendary: held?.rarity === 'legendary',
      candName: cand?.name, candColor: cand ? hex(rarityColor(cand.rarity)) : null,
      candLine: cand ? `${cand.arch.name}  ·  ${bonusPct(cand.dmgMul)} power  ·  LV ${cand.level}` : null,
      candLegendary: cand?.rarity === 'legendary',
      deltaRows: this._weaponDeltaRows(held, cand),
      onEquip: cand ? () => this._equip(this._cmp) : null,
    });

    // The full readout for the equipped weapon — weaponSummary() is owned by
    // weapons.js, not this file, so its rows still carry the old "x1.NN"
    // notation; deMultiply rewrites every one before it lands on screen, the
    // same generic pass armorSummary's rows get below.
    if (held) {
      const ro = el('div', 'readout');
      for (const [k, v] of weaponSummary(held)) ro.appendChild(row(k, deMultiply(v)));
      body.appendChild(ro);
    }

    // The legendary's named clause and the ascension recipe — the ACTUAL
    // prize (RPG_SPEC: the raw multiplier is deliberately small; the rule is
    // what you grind for). Both key off the EQUIPPED weapon, not the
    // candidate under review.
    if (held?.rule) {
      const rl = el('div', 'rule');
      rl.appendChild(el('b', null, held.rule.name));
      rl.appendChild(document.createTextNode(held.rule.text));
      body.appendChild(rl);
    }
    if (held?.rarity === 'epic') this._renderAscension(body, held);

    body.appendChild(el('div', 'sect candList', `IN THE STASH  (${stash.length})`));
    if (!stash.length) {
      body.appendChild(el('div', 'note', 'Nothing spare. Gates drop weapons and the Exchange sells them.'));
      return;
    }
    for (let i = 0; i < stash.length; i++) body.appendChild(this._weaponCandidateRow(stash[i], i, held));
  }

  /** Delta rows for the weapon compare strip, built off WEAPON_CMP_ROWS —
   *  the armour CMP_ROWS's twin, with the one cooldown row flagged
   *  lower-is-better so the strip's colour convention stays a single rule. */
  _weaponDeltaRows(held, cand) {
    if (!cand) return null;
    const rows = [];
    for (const [label, get, fmt, dfmt, higherBetter] of WEAPON_CMP_ROWS) {
      const cur = held ? get(held) : 0;
      const val = get(cand);
      const delta = val - cur;
      if (Math.abs(delta) < 1e-9) continue;
      const good = higherBetter ? delta > 0 : delta < 0;
      rows.push({ label, cur: fmt(cur), cand: fmt(val), delta: dfmt(delta), up: good });
    }
    const overall = held ? cand.score - held.score : 1;
    rows.unshift({
      label: 'Overall', cur: held ? String(Math.round(held.score)) : '—', cand: String(Math.round(cand.score)),
      delta: `${overall > 0 ? '+' : ''}${Math.round(overall)}`, up: overall > 0, bold: true,
    });
    return rows;
  }

  _weaponCandidateRow(w, index, held) {
    const btn = el('button', 'gate');
    btn.type = 'button';
    if (this._cmp === index) btn.classList.add('sel');
    if (w.rarity === 'legendary') btn.classList.add('leg');

    const box = el('i');
    box.setAttribute('style', iconStyle(weaponIcon(w), 32));
    box.style.borderColor = hex(rarityColor(w.rarity));
    btn.appendChild(box);

    const metaEl = el('span', 'meta');
    metaEl.appendChild(el('span', 'code', SLOTS.weapon.code));
    const name = el('b', null, w.name);
    name.style.color = hex(rarityColor(w.rarity));
    metaEl.appendChild(name);
    metaEl.appendChild(el('small', null, `${RARITIES[w.rarity]?.name || ''} ${w.arch.name}  ·  LV ${w.level}`));
    btn.appendChild(metaEl);

    // The one comparison that matters, spelled out rather than left to the
    // player to work out from two power numbers: rollWeapon's `score` is the
    // single comparable value.
    const better = held ? w.score - held.score : 1;
    const tag = el('span', 'tagline', better > 0 ? `+${Math.round(better)}` : `${Math.round(better)}`);
    tag.style.color = better > 0 ? '#54e08a' : 'var(--danger)';
    btn.appendChild(tag);

    // Two-step, uniformly: tapping a candidate selects it for the compare
    // strip above — it never equips on its own. EQUIP is the one commit
    // button on the sheet.
    btn.addEventListener('click', () => { this.audio?.ui?.(); this._cmp = index; this.render(); });
    return btn;
  }

  /**
   * The ascension block under an equipped epic. game.ascendEquipped() is the
   * commit — it consumes the epic IN PLACE (never via the stash) and equips
   * the legendary it becomes; this panel only prints and re-renders.
   */
  _renderAscension(body, held) {
    const g = this.game;
    const box = el('div', 'asc');
    box.id = 'invAscend';
    box.appendChild(el('div', 'sect', 'ASCENSION'));
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
    // Close the sheet back to the paper doll — the payoff of an equip is
    // SEEING the character change, and the character render lives on the
    // stage, not behind this overlay.
    this._sheet = null;
    this._cmp = -1;
    this.render();
  }

  // ------------------------------------------------------------- armour

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

  _renderArmorCompare(body, meta) {
    const slot = this._slot;
    const worn = this._wornInstance(slot);
    const candidates = this._armorCandidates(slot);
    const picked = this._cmp >= 0 ? candidates.find((c) => c.index === this._cmp) : null;
    const cand = picked?.inst || null;

    this._renderCmpRow(body, {
      curName: worn?.name, curColor: worn ? hex(rarityColor(worn.rarity)) : null,
      curLine: worn ? armorSummary(worn).slice(1, 3).map(([, v]) => deMultiply(v)).join('  ·  ') : 'EMPTY',
      curLegendary: worn?.rarity === 'legendary',
      candName: cand?.name, candColor: cand ? hex(rarityColor(cand.rarity)) : null,
      candLine: cand ? armorSummary(cand).slice(1, 3).map(([, v]) => deMultiply(v)).join('  ·  ') : null,
      candLegendary: cand?.rarity === 'legendary',
      deltaRows: this._armorDeltaRows(worn, cand),
      onEquip: cand ? () => this._equipArmor(picked.index) : null,
      blocked: cand ? this._equipBlock(cand.base) : null,
    });

    if (worn) {
      // The full readout — every field armorSummary() reports, deMultiplied
      // the same way the weapon compare's readout is, so a set piece with
      // five secondary rolls does not collapse to the two-field curLine.
      const ro = el('div', 'readout');
      for (const [k, v] of armorSummary(worn)) ro.appendChild(row(k, deMultiply(v)));
      body.appendChild(ro);
      if (worn.blurb) body.appendChild(el('div', 'note', worn.blurb));
      const un = el('button', 'btn ghost unequip', 'UNEQUIP');
      un.id = 'invUnequip';
      un.type = 'button';
      un.addEventListener('click', () => this._unequipArmor(slot));
      body.appendChild(un);
    } else {
      const note = el('div', 'note');
      note.appendChild(el('b', null, 'NOTHING EQUIPPED.  '));
      note.appendChild(document.createTextNode(slot === 'trinket'
        ? 'Gates drop rings and pendants — one exotic effect each, outside every set.'
        : 'Gates drop set pieces. Wearing 2 / 4 / 5 of one set pays its bonuses.'));
      body.appendChild(note);
    }

    body.appendChild(el('div', 'sect candList', `IN THE STASH  (${candidates.length})`));
    if (!candidates.length) {
      body.appendChild(el('div', 'note', slot === 'trinket'
        ? 'No spare trinkets. Gates are their only source.'
        : 'No spare pieces for this slot. Gates drop armour by rank.'));
      return;
    }
    for (const c of candidates) body.appendChild(this._armorCandidateRow(c, worn));
  }

  /** Delta rows for the armour/trinket compare strip. Trinkets carry ONE
   *  effect each; when the two effects differ both rows are shown so the
   *  player sees what they give up, not a fake delta between incommensurable
   *  numbers — the same rule the original compare strip enforced. */
  _armorDeltaRows(worn, cand) {
    if (!cand) return null;
    const rows = [];
    if (cand.kind === 't') {
      const keys = [...new Set([worn?.effect?.key, cand.effect.key].filter(Boolean))];
      for (const key of keys) {
        const cur = worn?.effect?.key === key ? worn.effect.mag : 0;
        const val = cand.effect.key === key ? cand.effect.mag : 0;
        const d = val - cur;
        const dText = key === 'mpRegen' ? `${d >= 0 ? '+' : ''}${d.toFixed(1)}/s` : bonusFrac(d);
        rows.push({
          label: TRINKET_LABEL[key] || key,
          cur: cur ? trinketFmt(key, cur) : '—', cand: val ? trinketFmt(key, val) : '—',
          delta: keys.length === 1 ? dText : '', up: d > 0,
        });
      }
    } else {
      for (const [label, get, fmt, dfmt] of CMP_ROWS) {
        const cur = worn ? get(worn) : 0;
        const val = get(cand);
        if (!cur && !val) continue;
        const delta = val - cur;
        rows.push({
          label, cur: cur ? fmt(cur) : '—', cand: val ? fmt(val) : '—',
          delta: Math.abs(delta) > 1e-9 ? dfmt(delta) : '', up: delta > 0,
        });
      }
      const wornSet = worn?.setId ? SETS[worn.setId]?.name : '—';
      const candSet = cand.setId ? SETS[cand.setId]?.name : '—';
      rows.push({ label: 'Set', cur: wornSet, cand: candSet, delta: '', up: null });
    }
    return rows;
  }

  _armorCandidateRow(c, worn) {
    const a = c.inst;
    const btn = el('button', 'gate');
    btn.type = 'button';
    if (this._cmp === c.index) btn.classList.add('sel');
    if (a.rarity === 'legendary') btn.classList.add('leg');

    const box = el('i');
    box.setAttribute('style', iconStyle(a.base.icon, 32));
    box.style.borderColor = hex(rarityColor(a.rarity));
    if (a.slot === 'legs') box.classList.add('desat');
    btn.appendChild(box);

    const metaEl = el('span', 'meta');
    metaEl.appendChild(el('span', 'code', SLOTS[a.slot]?.code || ''));
    const name = el('b', null, a.name);
    name.style.color = hex(rarityColor(a.rarity));
    metaEl.appendChild(name);
    const setName = a.setId ? SETS[a.setId]?.name : null;
    const blocked = this._equipBlock(a.base);
    metaEl.appendChild(el('small', null, blocked
      // The Exchange's exact refusal wording, on the row itself, so a player
      // knows WHY before ever opening the strip.
      ? blocked
      : `${a.rarityName} ${setName || 'Trinket'}  ·  LV ${a.level}`));
    btn.appendChild(metaEl);
    if (blocked) btn.classList.add('locked');

    // Same single-comparable-number tag the weapon list carries.
    const better = worn ? a.score - worn.score : 1;
    const tag = el('span', 'tagline', better > 0 ? `+${Math.round(better)}` : `${Math.round(better)}`);
    tag.style.color = better > 0 ? '#54e08a' : 'var(--danger)';
    btn.appendChild(tag);

    btn.addEventListener('click', () => { this.audio?.ui?.(); this._cmp = c.index; this.render(); });
    return btn;
  }

  /** The shared EQUIPPED | CANDIDATE | DELTAS | EQUIP row every compare sheet
   *  (weapon, armour, trinket) is built from — the mockup's ctx object, wired
   *  to real items instead of synthetic ones. */
  _renderCmpRow(container, {
    curName, curColor, curLine, curLegendary = false,
    candName, candColor, candLine, candLegendary = false,
    deltaRows, onEquip, blocked = null,
  }) {
    const rowEl = el('div', 'cmpRow');

    // LEGENDARY reads as the top of the ladder here too — the same bloom
    // .gate.leg gives a stash row, moved onto whichever card (equipped or
    // candidate) actually holds the legendary. UI chrome, not a scene
    // material; the no-glow-on-living-characters law governs meshes only.
    const eq = el('div', `cmpCard eq${curLegendary ? ' leg' : ''}`);
    eq.appendChild(el('div', 'lbl', 'EQUIPPED'));
    const eqName = el('div', 'nm', curName || 'EMPTY');
    if (curColor) eqName.style.color = curColor;
    eq.appendChild(eqName);
    eq.appendChild(el('div', 'ln', curLine || ''));
    rowEl.appendChild(eq);

    const cd = el('div', `cmpCard cand${candLegendary ? ' leg' : ''}`);
    cd.appendChild(el('div', 'lbl', 'CANDIDATE'));
    const cdName = el('div', 'nm', candName || 'NONE SELECTED');
    if (candColor) cdName.style.color = candColor;
    cd.appendChild(cdName);
    cd.appendChild(el('div', 'ln', candLine || '—'));
    rowEl.appendChild(cd);

    const deltas = el('div', 'deltas');
    deltas.id = 'invCompare';
    if (deltaRows) {
      for (const r of deltaRows) {
        const dr = el('div', 'drow');
        const lbl = el('span', null, r.label);
        if (r.bold) lbl.style.color = 'var(--ink)';
        dr.appendChild(lbl);
        dr.appendChild(el('span', 'cur', r.cur));
        const c = el('b', r.up === null ? '' : (r.up ? 'up' : 'down'), r.delta ? `${r.cand}  (${r.delta})` : r.cand);
        const wrap = el('span', 'cand');
        wrap.appendChild(c);
        dr.appendChild(wrap);
        deltas.appendChild(dr);
      }
    } else {
      deltas.appendChild(el('div', 'hint', 'Pick a candidate below to compare.'));
    }
    rowEl.appendChild(deltas);

    const equip = el('button', 'btn primary cmpEquip', onEquip ? 'EQUIP' : 'PICK ONE');
    equip.id = 'invEquipConfirm';
    equip.type = 'button';
    equip.disabled = !onEquip || Boolean(blocked);
    if (onEquip) equip.addEventListener('click', onEquip);
    rowEl.appendChild(equip);

    container.appendChild(rowEl);
    if (blocked) container.appendChild(el('div', 'cmp-reason', blocked));
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
    // Close the sheet back to the paper doll — see _equip's twin comment.
    this._sheet = null;
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
    // Close back to the paper doll — same call the equip paths make: the
    // payoff of taking a piece off is seeing the silhouette lose it, and that
    // silhouette lives on the stage, not behind this overlay.
    this._sheet = null;
    this._cmp = -1;
    this.render();
    return true;
  }

  /** Point the hunter's silhouette at the (just-changed) equipment and rebuild
   *  in place — the exact sequence game.setPlayerBody runs for an M/F flip.
   *  rebuildHumanoid declines harmlessly on the procedural box-man. This is
   *  also the ENTIRE character-preview refresh: the panel's centre column
   *  shows this same mesh live, so calling this is the whole "re-render the
   *  preview" step — nothing else needs to know an equip happened. */
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

  // -------------------------------------------------------------- sets sheet

  /** One card per set — ALL FIVE, not just the worn ones: this sheet IS the
   *  "collect a set" reward loop, and a loop the player cannot see the whole
   *  of is not a loop (the spec's own words about legibility). Pips + tier
   *  list, ported from the V3 mockup's SETS sheet structure. */
  _renderSetsSheet(body) {
    const g = this.game;
    const counts = setProgress(g.save.equipment);
    body.appendChild(el('div', 'note',
      'Wearing 2 / 4 / 5 pieces of one set pays its bonuses. Partials are small '
      + 'flat numbers; the full set is a rule. Offhand and trinket never count.'));
    const grid = el('div', 'setGrid');
    body.appendChild(grid);

    const ordered = Object.values(SETS).sort((a, b) => a.tier - b.tier);
    for (const set of ordered) {
      const n = counts.get(set.id) || 0;
      const card = el('div', 'setCard');
      const head = el('div', 'shead');
      const nm = el('b', null, set.name);
      if (n > 0) nm.style.color = 'var(--accent2)';
      head.appendChild(nm);
      head.appendChild(el('span', null, `${n} / 5`));
      card.appendChild(head);

      const pips = el('div', 'pips');
      for (let i = 1; i <= 5; i++) {
        const p = el('span');
        if (i <= n) p.classList.add('on');
        pips.appendChild(p);
      }
      card.appendChild(pips);

      for (const th of SET_THRESHOLDS) {
        const b = set.bonuses[th];
        if (!b) continue;
        const live = n >= th;
        const t = el('div', `tier${live ? ' live' : ''}`);
        t.append(el('span', 'n', `${th}PC`), el('span', 't', b.text));
        card.appendChild(t);
      }
      card.appendChild(el('div', 'note', set.flavour));
      grid.appendChild(card);
    }
  }

  // ------------------------------------------------------------- stats sheet

  /** The full sheet: everything the old tabbed STATS view held, nothing cut —
   *  IDENTITY, RESOURCES, the five spendable stats with mastery lines, the
   *  DERIVED block now zoned OFFENSE/DEFENSE/MOBILITY/RESOURCE the way the
   *  mockup grouped its own totals(), the armour/class/army breakdowns and
   *  Sovereign's Will — just reachable from the STATS ticker button instead
   *  of competing with GEAR for the same screen. */
  _renderStatsSheet(body) {
    const g = this.game;
    const save = g.save;
    const dBase = derive(save, g._armorBonus || null);
    const d = applyLayers(save, dBase);
    const R = STAT_RATES;
    const dirKey = directionOf(save);
    const cls = CLASSES[save.className];
    // `body` is already the sheet's one scrollbox (see _renderOverlay) — kept
    // as `col` here purely so the rest of this long function reads the same
    // as every other appendChild call below it.
    const col = body;

    col.appendChild(el('div', 'sect', 'IDENTITY'));
    const idt = el('div', 'readout');
    idt.appendChild(row('Level', String(save.level || 1)));
    idt.appendChild(row('Rank', rankOf(save.level || 1)));
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
    col.appendChild(idt);

    col.appendChild(el('div', 'sect', 'RESOURCES'));
    const rs = el('div', 'readout');
    rs.appendChild(row('Ash', String(Math.floor(save.ash || 0))));
    rs.appendChild(row('Emberdust', String(Math.floor(save.materials?.emberdust || 0)),
      'legendary fuel — B-rank gates and above'));
    const sigils = save.materials?.sigils || {};
    for (const [boss, label] of Object.entries(SIGIL_LABEL)) {
      if ((sigils[boss] || 0) > 0) rs.appendChild(row(label, String(sigils[boss])));
    }
    col.appendChild(rs);

    col.appendChild(el('div', 'sect', 'STATS'));
    const st = el('div', 'readout');
    const auto = save.autoStats || 0;
    for (const s of STATS) {
      const spent = (save.stats || {})[s.key] || 0;
      st.appendChild(row(s.name, `${effectiveStat(save, s.key)}`, `${spent} spent + ${auto} granted`));
      st.appendChild(el('div', 'note', s.desc));
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
    col.appendChild(st);

    // DERIVED, zoned OFFENSE / DEFENSE / MOBILITY / RESOURCE — the mockup's
    // own grp() grouping, applied to the real fold instead of synthetic
    // totals. The headline "Damage reduction" row is the REAL combined
    // number (armor.js's combinedDR against TOTAL_DR_CAP), answering the
    // owner's "total cap is 72%" complaint directly; the vitality-only and
    // armour-only components stay listed right under it so nothing that was
    // visible before is lost.
    col.appendChild(el('div', 'sect', 'DERIVED'));
    const totalDR = combinedDR(d.dr, d.armorDR);
    const zones = el('div', 'zones');
    const zone = (title, rows) => {
      const z = el('div', 'zone');
      z.appendChild(el('div', 'ztitle', title));
      const ro = el('div', 'readout');
      for (const r of rows) ro.appendChild(r);
      z.appendChild(ro);
      zones.appendChild(z);
    };
    zone('OFFENSE', [
      row('Attack power', d.atk.toFixed(1)),
      row('Crit chance', pct(d.crit), `cap ${pct(R.agi.critCap)}`),
      row('Crit damage', bonusPct(d.critDmg)),
      row('Attack speed', bonusFrac(d.atkSpeed), `cap ${pct(R.str.atkSpeedCap)}`),
      row('Skill power', bonusPct(d.skillMul)),
      row('Shadow damage', bonusPct(d.shadowDmgMul)),
    ]);
    zone('DEFENSE', [
      row('Damage reduction', fmtDR(totalDR), 'vitality x armour, combined'),
      row('— vitality only', pct(d.dr), `cap ${pct(R.vit.drCap)}`),
      row('— armour only', pct(d.armorDR)),
      row('Max health', String(d.maxHp)),
      row('Health regen', `${d.hpRegen.toFixed(2)}/s`),
      row('Damage floor', pct(d.dmgFloor), 'the low end of every roll'),
    ]);
    zone('MOBILITY', [
      row('Move speed', d.speed.toFixed(2), `cap +${R.agi.speedCap}`),
      row('Dodge window', fmtDodge(d.dodgeWindow)),
      row('Enemy tell', `${Math.round(d.tellLeadMs)}ms`, 'warning before a hit lands'),
    ]);
    zone('RESOURCE', [
      row('Max mana', String(d.maxMp)),
      row('Mana regen', `${d.mpRegen.toFixed(2)}/s`),
      row('Cooldown cut', bonusFrac(d.cdr), `cap ${pct(R.int.cdrCap)}`),
    ]);
    col.appendChild(zones);

    col.appendChild(el('div', 'sect', 'ARMOUR'));
    const ar = el('div', 'readout');
    if (d.staggerResist > 0) ar.appendChild(row('Stagger resist', bonusFrac(d.staggerResist), 'cap 60%'));
    if (d.knockTakenMul !== 1) ar.appendChild(row('Knockback taken', bonusPct(d.knockTakenMul)));
    col.appendChild(ar);
    if (!g._armorBonus || d.armorDR === 0) {
      col.appendChild(el('div', 'note',
        `Your ${pct(d.dr)} damage reduction is all from VITALITY — no armour is worn. `
        + 'Gates drop set pieces; fit them from a slot on the stage.'));
    }

    // The class layer, in stacking order after armour. Drawbacks render in
    // the SAME type size as benefits, here and everywhere, forever.
    col.appendChild(el('div', 'sect', 'CLASS'));
    if (cls) {
      const cr = el('div', 'readout');
      const quality = save.classTier || 'base';
      const res = resonanceOf(save);
      cr.appendChild(row(cls.name, res > 0 ? `RESONANT ${res}` : 'NEUTRAL',
        `quality ${quality} ${bonusPct(CLASS_QUALITY[quality] || 1)}`));
      cr.appendChild(el('div', 'note', `BENEFIT — ${cls.benefitText}`));
      cr.appendChild(el('div', 'note', `DRAWBACK — ${cls.drawbackText}`));
      col.appendChild(cr);
    } else {
      col.appendChild(el('div', 'note', (save.level || 1) >= 20
        ? 'No class chosen. The Assay Hall in Threshold will measure you — every class carries a benefit AND a drawback, in equal type.'
        : 'Classes open at level 20, at the Assay Hall. Your direction is yours to set now: it is read from where you spend.'));
    }

    col.appendChild(el('div', 'sect', 'ARMY'));
    const ay = el('div', 'readout');
    const roster = save.shadows?.roster?.length || 0;
    ay.appendChild(row('Roster', `${roster} / ${shadowRosterCapacity(save)}`));
    ay.appendChild(row('On the field', String(g.fieldCapacity()), 'clamped by the live quality tier'));
    col.appendChild(ay);

    // SOVEREIGN'S WILL (CLASSES_SPEC step 8): the three-way command toggle,
    // on the shadow panel per spec. Stance is RUN state — it resets to HUNT
    // at every gate entry — so the toggle only renders where a run is live.
    if (save.archon === 'shadow') {
      col.appendChild(el('div', 'sect', "SOVEREIGN'S WILL"));
      if (g.mode?.name !== 'city' && typeof g.setShadowStance === 'function') {
        // stanceGroup: a stable hook independent of styling classes, and
        // `.on` for the active choice — the SAME active-state convention
        // `.gate.on` / `.slot.sel` already use elsewhere in this file, so a
        // reader (or a test) never has to learn a second one.
        const stanceRow = el('div', 'stageActions stanceGroup');
        stanceRow.style.justifyContent = 'flex-start';
        for (const [key, label, hint] of [
          ['hold', 'HOLD', 'the wall — stay on you, cut down what closes'],
          ['hunt', 'HUNT', 'free rein — nearest quarry within 26 m'],
          ['focus', 'FOCUS', 'every blade on your last-marked target'],
        ]) {
          const b = el('button', 'btn ghost', label);
          b.type = 'button';
          b.title = hint;
          if (g.shadowStance === key) { b.classList.remove('ghost'); b.classList.add('on'); }
          b.addEventListener('click', () => {
            this.audio?.ui?.();
            if (g.setShadowStance(key)) this.render();
          });
          stanceRow.appendChild(b);
        }
        col.appendChild(stanceRow);
        const hints = {
          hold: 'HOLD — the wall. Your soldiers keep to your side and intercept anything that closes.',
          hunt: 'HUNT — free rein. Each soldier takes the nearest quarry within 26 m.',
          focus: 'FOCUS — every blade on your last-marked target, wherever it runs.',
        };
        col.appendChild(el('div', 'note', hints[g.shadowStance] || hints.hunt));
      } else {
        col.appendChild(el('div', 'note',
          'Stances are commanded in the field. Your army answers when a rift is open.'));
      }
    }
  }
}

export default InventoryUI;
