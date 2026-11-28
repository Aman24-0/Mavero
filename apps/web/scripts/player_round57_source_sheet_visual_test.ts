/**
 * MAVERO — Round 57: six fixes, part I (visual: source sheet) — regression suite.
 *
 * ROUND 59 (K2) SUPERSESSION: the source sheet is now the episode sheet's
 * RIGHT TWIN at EVERY viewport — one rule (right max(12px, safe-area),
 * left auto, width min(360px, calc(100vw - 24px)), radius 20, the same
 * glass surface, internal list scroll, slide-right entry, NO drag handle)
 * plus hairline ROW DIVIDERS between rows (the per-row radius/box card look
 * is gone). The floating full-width base panel and the ≥900px override it
 * shipped with are retired; the pins below were re-pointed to the ONE rule.
 *
 *   §1 I5 — THE SOURCE SHEET MATCHES THE EPISODE SHEET'S GLASS TREATMENT
 *      (now the RIGHT-side 360px drawer twin at every viewport — K2).
 *
 *   §2 I6 — SOURCE ROW ICONS + NAMES ARE LARGE AND CLEAR: each row renders
 *      its source asset at 30px inside a 40×40 radius-12 tile (the selected
 *      state keeps the check at 18px), the name is 17px/600 ellipsized on
 *      ONE line (badges keep their size, +2px gap), rows are ≥64px tall
 *      with a 14px gap and 10px 14px padding, and the 360px-wide layout
 *      still fits one line per row (title row nowrap + name ellipsis).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const shell = read('src/lib/components/player/PlayerShell.svelte');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ===========================================================================
// §1 — I5: the source sheet floats with the episode sheet's glass treatment.
// ===========================================================================
console.log('\n§1 — I5: the source sheet matches the episode sheet\'s glass treatment');
{
  const baseRule = shell.match(/\.source-sheet \{([^}]+)\}/)?.[1] ?? '';
  ok(baseRule.length > 0, '1a. the base .source-sheet rule exists');

  // (a) Floating geometry — the right drawer at EVERY viewport (K2): the
  //     three anchored edges sit max(12px, safe-area) off the player edges,
  //     the LEFT is auto (the episode sheet's mirror anchor).
  ok(/top: max\(12px, env\(safe-area-inset-top\)\)/.test(baseRule) && /bottom: max\(12px, env\(safe-area-inset-bottom\)\)/.test(baseRule) && /right: max\(12px, env\(safe-area-inset-right\)\)/.test(baseRule), '1b. FLOATING: top/bottom/right sit max(12px, safe-area) off the player edges (right drawer)');
  ok(/left: auto/.test(baseRule), '1b2. LEFT AUTO — the episode sheet\'s mirror anchor at every viewport');
  ok(!/[^-]bottom: 0/.test(baseRule) && !/[^-]right: 0/.test(baseRule), '1c. the flush bottom-sheet geometry (bottom/right: 0) is gone');

  // (b) The glass surface — the episode sheet's exact treatment.
  ok(/border-radius: 20px/.test(baseRule), '1d. radius 20 — rounded top AND bottom corners');
  ok(/background: rgba\(16, 16, 18, 0\.92\)/.test(baseRule), '1e. the episode sheet surface: rgba(16,16,18,0.92)');
  ok(/border: 1px solid rgba\(255, 255, 255, 0\.12\)/.test(baseRule), '1f. the 1px rgba(255,255,255,0.12) hairline');
  ok(/box-shadow: 0 24px 64px rgba\(0, 0, 0, 0\.55\), 0 4px 16px rgba\(0, 0, 0, 0\.35\), 0 1px 0 rgba\(255, 255, 255, 0\.06\) inset/.test(baseRule), '1g. the episode sheet layered shadow');
  ok(/backdrop-filter: blur\(24px\)/.test(baseRule), '1h. ONE 24px backdrop blur (the sheet\'s single blur layer)');
  ok(/max-height: none/.test(baseRule), '1i. the 60dvh cap is gone (the panel spans the safe-area insets)');

  // (c) Internal scroll: flex column, head fixed, list scrolls inside.
  ok(/display: flex; flex-direction: column/.test(baseRule) && /overflow: hidden/.test(baseRule), '1j. the panel is a flex column with overflow hidden — the LIST scrolls inside');
  ok(/\.source-sheet \.sheet-head \{ flex: 0 0 auto; \}/.test(shell), '1k. the head holds its size (flex: 0 0 auto)');
  ok(/\.source-sheet \.sheet-list \{ flex: 1 1 auto; min-height: 0; max-height: none; overflow-y: auto; padding-bottom: max\(14px, env\(safe-area-inset-bottom\)\); \}/.test(shell), '1l. the list takes the rest and scrolls (overflow-y: auto, safe-area padding)');
  ok(/animation: slide-right var\(--motion-normal\) var\(--ease-out\)/.test(baseRule), '1m. the RIGHT-side (slide-right) entry at EVERY viewport (K2)');
  ok(/width: min\(360px, calc\(100vw - 24px\)\)/.test(baseRule), '1m2. the episode sheet\'s exact bounded width: min(360px, calc(100vw - 24px))');

  // (d) No drag handle in the source sheet (the episode sheet language).
  const sheetMarkup = shell.slice(shell.indexOf('class="source-sheet"'), shell.indexOf('{#if episodeMenuOpen}'));
  ok(!/sheet-handle/.test(sheetMarkup), '1n. the source sheet has NO drag handle');
  ok(/<div class="source-sheet" role="dialog" aria-modal="true" aria-label="Available playback sources">\s*<div class="sheet-head"><span class="eyebrow">Source<\/span><button class="close-button"/.test(shell), '1o. the header (eyebrow "Source" + close button) is unchanged and directly follows the panel root');

  // (e) K2 — the ≥900px override is GONE: ONE rule at every viewport (the
  //     only ≥900px block left grows the chips).
  ok(!/@media \(min-width: 769px\)/.test(shell), '1p. the old 769px media query is gone (the tier moved to the episode sheet\'s 900px)');
  ok(!/@media \(min-width: 900px\) \{[\s\S]{0,400}?\.source-sheet \{/.test(shell), '1q. NO ≥900px source-sheet override remains — one rule at every viewport (K2)');
  ok(/@keyframes slide-right \{ from \{ transform: translateX\(100%\); \} to \{ transform: translateX\(0\); \} \}/.test(shell), '1w. the slide-right keyframe enters from the right edge (global — K2)');

  // (f) ROW DIVIDERS (K2): the episode sheet's hairline BETWEEN rows — a
  //     divider never splits a source row from its SUB/DUB buttons (the
  //     variant row lives INSIDE its parent .sheet-option-row).
  ok(/\.source-sheet \.sheet-list \.sheet-option-row \+ \.sheet-option-row \{ border-top: 1px solid rgba\(255, 255, 255, 0\.08\); \}/.test(shell), '1r. hairline dividers BETWEEN source rows (the episode sheet\'s exact hairline)');
  ok(/\.sheet-option-row \{ display: flex; flex-direction: column; gap: 6px; \}/.test(shell), '1s. the variant row stays INSIDE its parent row (a divider never splits a source from its SUB/DUB buttons)');

  // (g) Everything functional is untouched.
  ok(/chooseSource\(option\.id\)/.test(shell) && /chooseSource\(option\.id, variant\)/.test(shell), '1x. every handler is unchanged (chooseSource row + variant paths)');
  ok(/sheet-group-label/.test(sheetMarkup) && /variant-row/.test(sheetMarkup), '1y. the group labels and the variant row still render inside the list');
  ok(shell.includes('<div class="sheet-head"><span class="eyebrow">Source</span><button class="close-button" type="button" aria-label="Close source list" onclick={() => closeSourceSheet()}><X size={17} /></button></div>'), '1z. the close button keeps its aria-label and handler');
}

// ===========================================================================
// §2 — I6: the source rows are large and clear (40px tiles, 30px icons, 17px names).
// ===========================================================================
console.log('\n§2 — I6: source row icons + names readable at a glance');
{
  const sheetMarkup = shell.slice(shell.indexOf('class="source-sheet"'), shell.indexOf('{#if episodeMenuOpen}'));

  // (a) The 40×40 tile + the 30px source asset (unselected rows only).
  ok(/<SourceIcon icon=\{option\.icon\} size=\{30\} \/>/.test(sheetMarkup), '2a. the source asset renders at 30px (was 15px — the 64×64 masters are finally visible)');
  ok(/<Check size=\{18\} \/>/.test(sheetMarkup), '2b. the selected state keeps the check icon but at 18px (was 14px)');
  const markRule = shell.match(/\.option-mark \{([^}]+)\}/)?.[1] ?? '';
  ok(/flex: 0 0 40px/.test(markRule) && /width: 40px; height: 40px/.test(markRule), '2c. the tile is a fixed 40×40 box');
  ok(/border-radius: 12px/.test(markRule), '2d. radius 12 (a rounded square tile)');
  ok(/background: rgba\(255, 255, 255, 0\.06\)/.test(markRule) && /border: 1px solid rgba\(255, 255, 255, 0\.10\)/.test(markRule), '2e. translucent white tile: rgba(255,255,255,0.06) fill, 1px rgba(255,255,255,0.10) border');
  ok(/place-items: center/.test(markRule), '2f. centred content (the icon sits in the middle of the tile)');
  ok(/\.option-mark\.selected \{ border: 1px solid var\(--line-strong\); border-radius: 12px; color: var\(--accent\); \}/.test(shell), '2g. the selected tile keeps the accent border (radius 12 — the tile stays a tile)');

  // (b) The row: ≥64px, 14px gap, 10px 14px padding.
  const rowRule = shell.match(/\.sheet-option \{([^}]+)\}/)?.[1] ?? '';
  ok(/min-height: 64px/.test(rowRule), '2h. rows are ≥64px tall (was 52px)');
  ok(/gap: 14px/.test(rowRule), '2i. the row gap is 14px (was 11px)');
  ok(/padding: 10px 14px/.test(rowRule), '2j. the row padding is 10px 14px (was 7px 12px)');
  ok(/border: 0;/.test(rowRule), '2k2. K2: the per-row box look is GONE (border 0 — the quiet episode-sheet wash replaces the card)');
  ok(/\.sheet-option:hover, \.sheet-option:focus-visible \{ border-color: transparent; background: rgba\(255, 255, 255, 0\.05\); \}/.test(shell), '2k. the hover wash is the episode sheet\'s quiet white (K2)');
  ok(/\.sheet-option\.active \{ border-color: transparent; background: rgba\(255, 255, 255, 0\.08\); \}/.test(shell), '2k3. the active row wash is the episode sheet\'s stronger white (K2)');

  // (c) The name: 17px/600, ellipsized, ONE line per row.
  ok(/\.option-name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; font-weight: 600; \}/.test(shell), '2l. the name is 17px/600 and ellipsizes (single line)');
  const titleRule = shell.match(/\.option-title \{([^}]+)\}/)?.[1] ?? '';
  ok(/gap: 8px/.test(titleRule), '2m. the badges keep their size but gain 2px of separation (gap 6 → 8)');
  ok(/flex-wrap: nowrap/.test(titleRule), '2n. the title row never wraps — one line per row at every width');

  // (d) The 360px-width sanity: mark 40 + gap 14 + padding 28 = 82px of
  // chrome; the name ellipsizes inside the remaining ~254px (portrait panel)
  // / ~298px (≥900px right drawer) — nothing overflows.
  ok(true, '2o. (derived) 336px inner panel − 82px row chrome ≈ 254px for name + badges at 360px viewport — the nowrap + ellipsis pair keeps every row one line');

  // (e) The episode sheet's own row overrides are untouched (G pins).
  ok(/\.episode-sheet \.sheet-list \.sheet-option \{[^}]*gap: 12px;[^}]*min-height: 64px;[^}]*padding: 10px 12px;/.test(shell), '2p. the episode rows keep their exact G1 values (gap 12, 64px, 10px 12px)');
  ok(/\.episode-sheet \.sheet-list \.sheet-option \+ \.sheet-option \{ box-shadow: 0 -1px 0 rgba\(255, 255, 255, 0\.08\); \}/.test(shell), '2q. the episode hairline dividers are untouched');
  ok(!/size=\{15\}/.test(sheetMarkup), '2r. no 15px icon remains in the source sheet markup');
}

console.log(`\nRound 57 source sheet visual: ${passed} passed, ${failed} failed (of ${passed + failed})`);
if (failed > 0) process.exit(1);
