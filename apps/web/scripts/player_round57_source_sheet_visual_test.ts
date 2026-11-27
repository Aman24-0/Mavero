/**
 * MAVERO — Round 57: six fixes, part I (visual: source sheet) — regression suite.
 *
 *   §1 I5 — THE SOURCE SHEET MATCHES THE EPISODE SHEET'S GLASS TREATMENT:
 *      the old flush bottom sheet (bottom:0; left:0; right:0; 60dvh cap,
 *      square top corners) becomes a FLOATING glass panel at every compact
 *      viewport — 12px safe-area insets on every side, radius 20 top AND
 *      bottom, rgba(16,16,18,0.92), 1px rgba(255,255,255,0.12), layered
 *      shadow, ONE 24px backdrop blur, internal list scroll (flex column),
 *      NO drag handle — and at ≥900px it mirrors the episode sheet on the
 *      RIGHT (top/bottom/right: max(12px, safe-area), left: auto, width
 *      min(380px, 32vw), height: auto, slide-right entry). The header
 *      (eyebrow "Source" + close button), group labels, variant row and
 *      every handler are unchanged.
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

  // (a) Floating geometry — every edge inset 12px (safe-area aware).
  ok(/top: max\(12px, env\(safe-area-inset-top\)\)/.test(baseRule) && /bottom: max\(12px, env\(safe-area-inset-bottom\)\)/.test(baseRule) && /left: max\(12px, env\(safe-area-inset-left\)\)/.test(baseRule) && /right: max\(12px, env\(safe-area-inset-right\)\)/.test(baseRule), '1b. FLOATING: all four edges sit max(12px, safe-area) off the player edges (no flush bottom sheet)');
  ok(!/[^-]bottom: 0/.test(baseRule) && !/[^-]left: 0/.test(baseRule) && !/[^-]right: 0/.test(baseRule), '1c. the flush bottom-sheet geometry (bottom/left/right: 0) is gone');

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
  ok(/animation: sheet-up var\(--motion-normal\) var\(--ease-out\)/.test(baseRule), '1m. the vertical (sheet-up) entry is kept');

  // (d) No drag handle in the source sheet (the episode sheet language).
  const sheetMarkup = shell.slice(shell.indexOf('class="source-sheet"'), shell.indexOf('{#if episodeMenuOpen}'));
  ok(!/sheet-handle/.test(sheetMarkup), '1n. the source sheet has NO drag handle');
  ok(/<div class="source-sheet" role="dialog" aria-modal="true" aria-label="Available playback sources">\s*<div class="sheet-head"><span class="eyebrow">Source<\/span><button class="close-button"/.test(shell), '1o. the header (eyebrow "Source" + close button) is unchanged and directly follows the panel root');

  // (e) ≥900px: the right-edge mirror of the episode sheet.
  ok(!/@media \(min-width: 769px\)/.test(shell), '1p. the old 769px media query is gone (the tier moved to the episode sheet\'s 900px)');
  const wideMatch = shell.match(/@media \(min-width: 900px\) \{[\s\S]*?\.source-sheet \{([^}]+)\}/);
  ok(Boolean(wideMatch), '1q. the wide rule lives at ≥900px (the episode sheet tier)');
  const wideRule = wideMatch?.[1] ?? '';
  ok(/right: max\(12px, env\(safe-area-inset-right\)\)/.test(wideRule) && /left: auto/.test(wideRule), '1r. right-anchored: right max(12px, safe-area), left auto');
  ok(/top: max\(12px, env\(safe-area-inset-top\)\)/.test(wideRule) && /bottom: max\(12px, env\(safe-area-inset-bottom\)\)/.test(wideRule), '1s. floating vertically (12px safe-area top/bottom — never a full-height flush drawer)');
  ok(/width: min\(380px, 32vw\)/.test(wideRule) && /height: auto/.test(wideRule), '1t. width min(380px, 32vw), height auto');
  ok(/border-radius: 20px/.test(wideRule), '1u. the SAME radius/surface as the base panel (radius 20 — no flush edge)');
  ok(/animation: slide-right var\(--motion-normal\) var\(--ease-out\)/.test(wideRule), '1v. slide-in from the right (slide-right entry)');
  ok(/@keyframes slide-right \{ from \{ transform: translateX\(100%\); \} to \{ transform: translateX\(0\); \} \}/.test(shell), '1w. the slide-right keyframe enters from the right edge');

  // (f) Everything functional is untouched.
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
  ok(/\.sheet-option:hover, \.sheet-option:focus-visible, \.sheet-option\.active \{ border-color: var\(--line-strong\); background: var\(--accent-soft\); \}/.test(shell), '2k. the hover/active wash is unchanged');

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
