/**
 * MAVERO — Round 59: seven fixes, part K (visual) — regression suite.
 *
 *   §1 K1 — RIGHT TIME LABEL FONT MATCH: the right time label (the duration
 *      toggle button) renders in the EXACT .time-label typography at every
 *      breakpoint. The old `font: inherit` inherited from the timeline ROW
 *      (not from .time-label), so the right label was larger than the left
 *      everywhere; the ≤640px override (11px) only reached the plain label.
 *      Now both labels read ONE shared --pl-time-size token (12px base,
 *      11px ≤640px) and the button spells out family/size/weight/
 *      tabular-nums/letter-spacing explicitly.
 *
 *   §2 K2 — SOURCE SHEET = RIGHT-SIDE PANEL + ROW DIVIDERS: the source sheet
 *      is the exact MIRROR of the episode sheet at ALL widths — right
 *      max(12px, safe-area) / left auto / width min(360px, calc(100vw - 24px)),
 *      radius 20, the same glass surface, internal list scroll, slide-in
 *      from the right, hairline dividers BETWEEN rows (the variant row stays
 *      inside its parent so a divider never splits a source from its SUB/DUB
 *      buttons) and NO per-row radius/box card look. The old full-width base
 *      rule and the ≥900px override are gone (one rule for every viewport).
 *
 *   §3 K3 — LANDSCAPE TOP ROW: back left (8px floor), title fits on the row:
 *      the header joins the chips row tight to the back chip (gap 16 → 8),
 *      truncates with a capped width that can never reach the first chip, and
 *      the meta line hides while the available width is ≤520px (100vw ≤ 940).
 *      The subtitle chip shows "Subtitles" + a SHORT 2-letter code (the full
 *      name stays in aria-label + title). The FIT RULE shrinks the landscape
 *      chips to 36px and drops chip labels before anything can wrap or clip.
 *
 *   §4 K4 — DESKTOP CONTINUE-WATCHING CARD HEIGHT: on ≥1025px the rail's
 *      vertical axis clips (overflow-y: hidden) so the compact card's
 *      absolute "Details" link overhang can never become a vertical scroll
 *      inside the card frame — the container is exactly the card's real
 *      height. Other rails (no overhang) are untouched.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const controls = read('src/lib/components/player/PlayerControls.svelte');
const shell = read('src/lib/components/player/PlayerShell.svelte');
const rail = read('src/lib/components/ContentRail.svelte');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ===========================================================================
// §1 — K1: the right time label matches the left at every breakpoint.
// ===========================================================================
console.log('\n§1 — K1: right time label font match');
{
  // (a) The shared token on the controls root.
  ok(/\.controls \{\s*\n\s*position: absolute; inset: 0; z-index: 10; pointer-events: none; color: var\(--ink\);\s*\n\s*\/\* Round 59 \(K1\)[\s\S]*?\*\/\s*\n\s*--pl-time-size: 12px;/.test(controls), '1a. the controls root defines the shared --pl-time-size token (12px)');
  ok(/\.time-label \{[^}]*font-size: var\(--pl-time-size, 12px\);[^}]*\}/.test(controls), '1b. the LEFT (elapsed) label reads the shared token');
  // (b) The button spells out the exact .time-label typography — no font: inherit.
  const toggleRule = controls.match(/button\.time-label\.duration-toggle \{[^}]+\}/)?.[0] ?? '';
  ok(toggleRule.length > 0, '1c. the duration-toggle rule exists');
  ok(!/font:\s*inherit/.test(toggleRule), '1d. font: inherit is GONE (it inherited the ROW font, not .time-label)');
  ok(/font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;/.test(toggleRule), '1e. the explicit family matches .time-label');
  ok(/font-size: var\(--pl-time-size, 12px\)/.test(toggleRule), '1f. the size reads the shared token');
  ok(/font-weight: 400;/.test(toggleRule) && /font-variant-numeric: tabular-nums;/.test(toggleRule) && /letter-spacing: 0;/.test(toggleRule), '1g. weight 400 + tabular-nums + letter-spacing 0 — the .time-label match is exact');
  // (c) The ≤640px override applies to BOTH labels through the token.
  ok(/@media \(max-width: 640px\) \{[\s\S]{0,1200}?\.controls \{ --pl-time-size: 11px; \}/.test(controls), '1h. the ≤640px compaction sets the token once — BOTH labels get 11px');
  ok(!/@media \(max-width: 640px\) \{[\s\S]{0,1200}?\.time-label \{ font-size: 11px; \}/.test(controls), '1i. the old label-only 11px override is gone');
  // (d) The markup is unchanged (aria-pressed toggle + both labels).
  ok(/<button class="time-label duration-toggle" type="button" aria-pressed=\{durationMode === 'remaining'\}/.test(controls), '1j. the toggle button markup + aria-pressed are unchanged');
  ok(/class="time-label" aria-live="off">\{formatPlayerTime\(currentTime\)\}<\/span>/.test(controls), '1k. the LEFT label markup is unchanged');
}

// ===========================================================================
// §2 — K2: the source sheet is the episode sheet's right twin + dividers.
// ===========================================================================
console.log('\n§2 — K2: source sheet right drawer + row dividers');
{
  const baseRule = shell.match(/\.source-sheet \{([^}]+)\}/)?.[1] ?? '';
  ok(baseRule.length > 0, '2a. the single .source-sheet rule exists');

  // (a) The mirror geometry at EVERY viewport.
  ok(/right: max\(12px, env\(safe-area-inset-right\)\)/.test(baseRule) && /left: auto/.test(baseRule), '2b. right max(12px, safe-area) + left auto — the episode sheet\'s mirror anchor');
  ok(/top: max\(12px, env\(safe-area-inset-top\)\)/.test(baseRule) && /bottom: max\(12px, env\(safe-area-inset-bottom\)\)/.test(baseRule), '2c. floating vertically: 12px safe-area top/bottom');
  ok(/width: min\(360px, calc\(100vw - 24px\)\)/.test(baseRule), '2d. the episode sheet\'s exact width: min(360px, calc(100vw - 24px))');

  // (b) The same glass surface + internal scroll + slide-in from the right.
  ok(/border-radius: 20px/.test(baseRule) && /background: rgba\(16, 16, 18, 0\.92\)/.test(baseRule) && /border: 1px solid rgba\(255, 255, 255, 0\.12\)/.test(baseRule) && /backdrop-filter: blur\(24px\)/.test(baseRule), '2e. the identical glass surface (radius 20, rgba(16,16,18,0.92), 1px hairline, ONE 24px blur)');
  ok(/box-shadow: 0 24px 64px rgba\(0, 0, 0, 0\.55\), 0 4px 16px rgba\(0, 0, 0, 0\.35\), 0 1px 0 rgba\(255, 255, 255, 0\.06\) inset/.test(baseRule), '2f. the identical layered shadow');
  ok(/overflow: hidden/.test(baseRule) && /\.source-sheet \.sheet-list \{ flex: 1 1 auto; min-height: 0; max-height: none; overflow-y: auto;/.test(shell), '2g. the internal list scrolls (flex column, overflow hidden panel)');
  ok(/animation: slide-right var\(--motion-normal\) var\(--ease-out\)/.test(baseRule), '2h. slide-in from the RIGHT at every viewport');
  ok(/@keyframes slide-right \{ from \{ transform: translateX\(100%\); \} to \{ transform: translateX\(0\); \} \}/.test(shell), '2i. the global slide-right keyframe (the sheet-left twin)');

  // (c) ONE rule: the old full-width base + ≥900px override are gone.
  ok(!/@media \(min-width: 900px\) \{[\s\S]{0,400}?\.source-sheet \{/.test(shell), '2j. NO ≥900px source-sheet override remains');
  ok(!/left: max\(12px, env\(safe-area-inset-left\)\); right: max\(12px, env\(safe-area-inset-right\)\)/.test(baseRule), '2k. the old full-width base geometry (left+right anchored) is gone');

  // (d) ROW DIVIDERS — the episode sheet's hairline BETWEEN rows.
  ok(/\.source-sheet \.sheet-list \.sheet-option-row \+ \.sheet-option-row \{ border-top: 1px solid rgba\(255, 255, 255, 0\.08\); \}/.test(shell), '2l. hairline dividers between consecutive source rows');
  const variantIndex = shell.indexOf('.variant-row { display: flex; gap: 6px; padding: 0 12px 6px; }');
  const rowRuleIndex = shell.indexOf('.sheet-option-row { display: flex; flex-direction: column; gap: 6px; }');
  ok(variantIndex > rowRuleIndex && rowRuleIndex > -1, '2m. the variant row stays INSIDE its parent .sheet-option-row (a divider never splits a source from its SUB/DUB buttons)');

  // (e) The per-row radius/box look is gone — the episode sheet's wash.
  const rowRule = shell.match(/\.sheet-option \{([^}]+)\}/)?.[1] ?? '';
  ok(/border: 0;/.test(rowRule) && /border-radius: 12px;/.test(rowRule), '2n. no per-row box (border 0); the radius stays for the wash shape');
  ok(/\.sheet-option:hover, \.sheet-option:focus-visible \{ border-color: transparent; background: rgba\(255, 255, 255, 0\.05\); \}/.test(shell), '2o. hover = the quiet episode-sheet wash');
  ok(/\.sheet-option\.active \{ border-color: transparent; background: rgba\(255, 255, 255, 0\.08\); \}/.test(shell), '2p. active = the stronger episode-sheet wash');

  // (f) Header, group labels, variant buttons and handlers unchanged.
  const sheetMarkup = shell.slice(shell.indexOf('class="source-sheet"'), shell.indexOf('{#if episodeMenuOpen}'));
  ok(/<div class="sheet-head"><span class="eyebrow">Source<\/span><button class="close-button" type="button" aria-label="Close source list"/.test(shell), '2q. the header (eyebrow "Source" + close) is unchanged');
  ok(/sheet-group-label/.test(sheetMarkup) && /variant-button/.test(sheetMarkup) && /chooseSource\(option\.id, variant\)/.test(shell), '2r. group labels, variant buttons and every handler are unchanged');
}

// ===========================================================================
// §3 — K3: landscape top row — back left, title fits, short subtitle code.
// ===========================================================================
console.log('\n§3 — K3: landscape top row');
{
  // (a) Back chip further left (the shell side).
  ok(/\.back-fab \{ width: 37px; height: 37px; top: max\(6px, env\(safe-area-inset-top\)\); left: max\(8px, env\(safe-area-inset-left\)\); \}/.test(shell), '3a. the landscape back chip sits at the 8px LEFT floor (37px size, 6px top floor)');
  ok(/\.back-fab\.native \{ left: max\(8px, env\(safe-area-inset-left\)\); \}/.test(shell), '3b. the native back chip carries the same 8px left floor');

  // (b) The header joins the chips row, truncates, and is capped.
  const landscapeHeader = controls.match(/@media \(orientation: landscape\) and \(max-height: 500px\) \{\s*\.utility-zone \{ left: auto; \}\s*\.header-zone \{([^}]+)\}/)?.[1] ?? '';
  ok(landscapeHeader.length > 0, '3c. the landscape header rule exists');
  ok(/top: var\(--pl-chrome-top, max\(16px, env\(safe-area-inset-top\)\)\)/.test(landscapeHeader), '3d. the header sits ON the chips row (the shared --pl-chrome-top reference)');
  ok(/left: calc\(max\(8px, env\(safe-area-inset-left\)\) \+ var\(--pl-chip-size, 40px\) \+ 8px\)/.test(landscapeHeader), '3e. tight to the back chip: the after-chip gap drops 16 → 8 (~8px more usable row width)');
  ok(/max-width: min\(560px, calc\(100vw - \(max\(8px, env\(safe-area-inset-left\)\) \+ var\(--pl-chip-size, 40px\) \+ 8px\) - 352px\)\)/.test(landscapeHeader), '3f. the width CAP can never reach the first chip (the 352px chips reserve + right inset)');
  ok(/\.header-title \{[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap;[^}]*\}/.test(controls), '3g. the title TRUNCATES (ellipsis — never wraps, never pushes)');

  // (c) The meta line hides when the available width is ≤520px (100vw ≤ 940).
  ok(/@media \(orientation: landscape\) and \(max-height: 500px\) and \(max-width: 940px\) \{\s*\.header-meta \{ display: none; \}\s*\}/.test(controls), '3h. the meta line HIDES while the header\'s available width is ≤520px (available = 100vw − left − 352 − 12 → 100vw ≤ 940)');

  // (d) SUBTITLE CHIP: the heading + a SHORT code; the FULL name stays in
  //     aria-label + title.
  ok(/const SUBTITLE_LANGUAGE_CODES: Record<string, string> = \{/.test(controls), '3i. the language→code map exists');
  for (const pair of ["off: 'Off'", "english: 'en'", "hindi: 'hi'", "tamil: 'ta'", "korean: 'ko'", "french: 'fr'", "spanish: 'es'", "japanese: 'ja'", "turkish: 'tr'"]) {
    ok(controls.includes(pair), `3j. the map carries ${pair}`);
  }
  ok(/firstWord\.slice\(0, 2\)\.toUpperCase\(\)/.test(controls), '3k. unknown languages → the first two letters, uppercased');
  ok(/\/\^\[a-z\]\{2\}\$\/\.test\(firstWord\)/.test(controls), '3l. an already-2-letter code (BCP-47 primary subtag) is kept as-is');
  ok(/\$:\s*subtitleChipValue = selectedSubtitleTrack\s*\?\s*\(subtitleShortCode\(selectedSubtitleTrack\.language\) \|\| subtitleShortCode\(selectedSubtitleTrack\.label\) \|\| 'Sub'\)\s*:\s*'Off';/.test(controls), '3m. the chip value derives from the SELECTED track\'s language (label fallback, Off when none)');
  ok(/<span class="chip-label">Subtitles<\/span>\s*<span class="chip-value">\{subtitleChipValue\}<\/span>/.test(controls), '3n. the chip reads "Subtitles" + the SHORT code');
  ok(/aria-label=\{`Subtitles: \$\{subtitleButtonLabel\}\$\{subtitleNotice \? ` \(\$\{subtitleNotice\}\)` : ''\}`\}/.test(controls), '3o. the FULL name stays in the aria-label (unchanged)');
  ok(/title=\{subtitleNotice \? `\$\{subtitleButtonLabel\} \(\$\{subtitleNotice\}\)` : subtitleButtonLabel\}/.test(controls), '3p. the FULL name also lives in the title attribute');

  // (e) FIT RULE: chips shrink to 36px + drop labels before anything wraps.
  const fitRule = controls.match(/@media \(orientation: landscape\) and \(max-height: 500px\) and \(max-width: 899px\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  ok(fitRule.length > 0, '3q. the landscape FIT RULE block exists (≤899px)');
  ok(/\.select-control \{ height: 36px; padding: 0 10px; gap: 6px; \}/.test(fitRule), '3r. chips shrink to 36px height');
  ok(/\.select-control \.chip-label \{ display: none; \}/.test(fitRule), '3s. chip labels DROP (icon + value only)');
  ok(/\.utility-zone \{ gap: 6px; \}/.test(fitRule), '3t. the row gap tightens (never wraps)');
  ok(/\.utility-zone \.control-button \{ width: 36px; min-width: 36px; height: 36px; \}/.test(fitRule), '3u. the icon buttons join the 36px tier');
  ok(/\.utility-zone \{ left: auto; \}/.test(controls), '3v. the utility chips keep their RIGHT anchor in landscape (the portrait left inset is cancelled)');
  ok(/flex-wrap: nowrap/.test(controls.match(/\.utility-zone \{[^}]+\}/)?.[0] ?? ''), '3w. the row NEVER wraps');
}

// ===========================================================================
// §4 — K4: desktop continue-watching card height (no inner vertical scroll).
// ===========================================================================
console.log('\n§4 — K4: continue-watching card height on desktop');
{
  const desktopRule = rail.match(/@media \(min-width: 1025px\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  ok(desktopRule.length > 0, '4a. the desktop rail rule exists');
  ok(/\.rail \{ overflow-y: hidden; \}/.test(desktopRule), '4b. the rail\'s vertical axis CLIPS on ≥1025px — no inner vertical scroll inside the card frame');
  ok(/overflow-x: auto/.test(rail.match(/\.rail \{([^}]+)\}/)?.[1] ?? ''), '4c. the horizontal scroll is untouched (the rail still swipes)');
  ok(/\.rail-wrap \{ position: relative; overflow: hidden; min-height: 250px; \}/.test(rail), '4d. the wrap keeps its CLS floor + clip (overflow: hidden only where the card was already clipped)');
  ok(rail.indexOf('.rail { overflow-y: hidden; }') > rail.indexOf('.rail { grid-auto-columns: clamp(160px, 14vw, 200px)'), '4e. the vertical clip lands INSIDE the desktop tier (≥1025px only)');
  ok(!/@media \(min-width: 1025px\) \{[\s\S]{0,300}?min-height: 0/.test(rail), '4f. no CLS regression — the wrap floor is not removed for other rails');
}

console.log(`\nRound 59 visual: ${passed} passed, ${failed} failed (of ${passed + failed})`);
if (failed > 0) process.exit(1);
