/**
 * MAVERO — Round 54: visual polish, part G (G1–G3) — regression suite.
 *
 *   §1 G1 — EPISODE SIDEBAR SHEET (modern + rich): glassy black panel
 *      (rgba(16,16,18,0.92), ONE 24px backdrop blur, 1px rgba(255,255,255,
 *      0.12) border, radius 20, layered shadow); the EPISODES · <n> eyebrow
 *      (10.5px/700/1.6px tracking, 45% white, small-caps) + a popover-styled
 *      30px rounded-square close button; the SEASON CHIP fix — the ACTIVE
 *      chip is white with dark text (the reported white-on-white invisible
 *      label), the INACTIVE chip a translucent square (both 36px tall,
 *      radius 12, 13px/600); the episode rows (24px number badge, 15px/600
 *      white title, 12.5px tertiary meta, ≥64px tall, quiet hover wash,
 *      hairline dividers BETWEEN rows, and the CURRENT episode's 2px white
 *      left bar + rgba(255,255,255,0.08) wash + "now playing" dot).
 *
 *   §2 G2 — SERVER SHEET: the shared popover surface joins the SAME glass
 *      treatment, and the two-pane rail + list keep their exact layout
 *      while the rail items and rows adopt the same typography, spacing
 *      and hairline dividers as G1.
 *
 *   §3 G3 — CENTRE LOADING CARD: compact glass card (radius 16, rgba(18,
 *      18,20,0.86), 1px rgba(255,255,255,0.12), blur 18px, padding 18px
 *      22px, soft layered shadow, NO full-screen overlay) with a 22px
 *      WHITE spinner ring (2px, 900ms linear) on the left, 14.5px/600
 *      title + 12.5px tertiary status line; the status strings and the
 *      error state's copy/handlers are untouched.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

const shell = read('src/lib/components/player/PlayerShell.svelte');
const controls = read('src/lib/components/player/PlayerControls.svelte');
const optionSheet = read('src/lib/components/player/PlayerOptionSheet.svelte');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ===========================================================================
// §1 — G1: the episode sidebar sheet.
// ===========================================================================
console.log('\n§1 — G1: episode sidebar sheet (modern + rich)');
{
  // (a) The glassy panel.
  const panelRule = shell.slice(shell.indexOf('.episode-sheet { position: absolute'), shell.indexOf('.episode-sheet .sheet-head'));
  ok(/background: rgba\(16, 16, 18, 0\.92\);/.test(panelRule), '1a. the panel is glassy black — rgba(16,16,18,0.92)');
  ok(/backdrop-filter: blur\(24px\);/.test(panelRule), '1b. the panel carries its ONE 24px backdrop blur (the sheet\'s single blur layer)');
  ok(/border-right: 1px solid rgba\(255, 255, 255, 0\.12\);/.test(panelRule) && /border-radius: 20px;/.test(panelRule), '1c. 1px rgba(255,255,255,0.12) border + radius 20');
  ok(/box-shadow: 0 24px 64px rgba\(0, 0, 0, 0\.55\), 0 4px 16px rgba\(0, 0, 0, 0\.35\), 0 1px 0 rgba\(255, 255, 255, 0\.06\) inset;/.test(panelRule), '1d. a layered shadow');
  ok(!/width: min\(360px, 88vw\)/.test(panelRule), '1e. the old flush 88vw width is gone (the floating panel caps to the viewport)');

  // (b) The header: eyebrow + popover-styled close button.
  ok(/\.episode-sheet \.sheet-head \.eyebrow \{ color: rgba\(255, 255, 255, 0\.45\); font-size: 10\.5px; font-weight: 700; letter-spacing: 1\.6px; text-transform: uppercase; \}/.test(shell), '1f. the EPISODES · <n> eyebrow: 10.5px/700, 1.6px tracking, 45% white, small-caps');
  ok(/\.episode-sheet \.close-button \{ display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 9px;/.test(shell), '1g. the close button is styled like the popover close (30px rounded square)');

  // (c) The season chip pair — the white-on-white BUG fix.
  const chipRule = shell.slice(shell.indexOf('.season-chip {'), shell.indexOf('.sheet-season-state'));
  ok(/\.season-chip\.active \{ background: #fff; border-color: transparent; color: #0b0c0d; \}/.test(chipRule), '1h. the ACTIVE season chip is white with #0b0c0d dark text — the invisible white-on-white label is fixed');
  ok(/border: 1px solid rgba\(255, 255, 255, 0\.12\);/.test(chipRule) && /background: rgba\(255, 255, 255, 0\.06\);/.test(chipRule) && /color: rgba\(255, 255, 255, 0\.72\);/.test(chipRule), '1i. the INACTIVE chip: rgba(255,255,255,0.06) fill, 72% white text, 1px rgba(255,255,255,0.12) border');
  ok(/height: 36px;/.test(chipRule) && /border-radius: 12px;/.test(chipRule) && /font-size: 13px;/.test(chipRule) && /font-weight: 600;/.test(chipRule), '1j. both chips: 36px tall, radius 12, 13px/600 label');
  ok(/\.season-chip\.active \{ background: #fff/.test(chipRule) && !/\.season-chip\.active \{[^}]*var\(--accent\)/.test(chipRule), '1k. no accent fill remains on the active chip');
  ok(/\.season-row \{[\s\S]{0,200}overflow-x: auto;/.test(shell) && /scrollbar-width: none;/.test(shell) && /\.season-row::-webkit-scrollbar \{ display: none; \}/.test(shell), '1l. the season rail keeps its horizontal scroll with NO scrollbar');

  // (d) The episode rows.
  ok(/\.episode-sheet \.sheet-list \.sheet-option \{[\s\S]*?min-height: 64px;/.test(shell), '1m. episode rows are ≥64px tall');
  ok(/\.episode-number \{[\s\S]*?width: 24px; height: 24px;[\s\S]*?border-radius: 7px;[\s\S]*?background: rgba\(255, 255, 255, 0\.06\);[\s\S]*?font-size: 12px; font-weight: 600;/.test(shell), '1n. the 24px number badge: rounded square, rgba(255,255,255,0.06) fill, 12px/600 tertiary');
  ok(/\.episode-sheet \.sheet-list \.sheet-option strong \{ display: block; color: #fff; font-size: 15px; font-weight: 600;/.test(shell), '1o. the title line is 15px/600 white');
  ok(/\.episode-sheet \.sheet-list \.sheet-option small \{ display: block; margin-top: 2px; color: var\(--pl-ink-3[^;]*\); font-size: 12\.5px; \}/.test(shell), '1p. the meta line is 12.5px tertiary');
  ok(/\.episode-sheet \.sheet-list \.sheet-option:hover, \.episode-sheet \.sheet-list \.sheet-option:focus-visible \{ border-color: transparent; background: rgba\(255, 255, 255, 0\.05\); \}/.test(shell), '1q. hover = a quiet rgba(255,255,255,0.05) wash (no box)');
  ok(/\.episode-sheet \.sheet-list \.sheet-option \+ \.sheet-option \{ box-shadow: 0 -1px 0 rgba\(255, 255, 255, 0\.08\); \}/.test(shell), '1r. hairline dividers BETWEEN rows (not boxes)');
  ok(/\.episode-sheet \.sheet-list \.sheet-option\.active \{ background: rgba\(255, 255, 255, 0\.08\); \}/.test(shell), '1s. the current episode gets the rgba(255,255,255,0.08) wash');
  ok(/\.episode-sheet \.sheet-list \.sheet-option\.active::before \{ content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 2px; border-radius: 1px; background: #fff; \}/.test(shell), '1t. the current episode carries the 2px white left bar');
  ok(/class="now-playing-dot"/.test(shell) && /\.now-playing-dot \{[\s\S]*?width: 6px; height: 6px; border-radius: 50%; background: #fff;/.test(shell), '1u. the current episode carries the small "now playing" dot');
  ok(/aria-current=\{currentEpisode\?\.season === episode\.season && currentEpisode\?\.episode === episode\.number \? 'true' : undefined\}/.test(shell), '1v. the current row is aria-current marked');
  ok(/class="sheet-option episode-row"/.test(shell) && /chooseEpisode\(\{ season: episode\.season, episode: episode\.number, title: episode\.title \}\)/.test(shell), '1w. the rows keep their class + the existing chooseEpisode path');
}

// ===========================================================================
// §2 — G2: the server sheet — one glassy visual language, same layout.
// ===========================================================================
console.log('\n§2 — G2: server sheet glass treatment (two-pane layout unchanged)');
{
  ok(/background: rgba\(16, 16, 18, 0\.92\);/.test(optionSheet) && /backdrop-filter: blur\(24px\);/.test(optionSheet) && /border: 1px solid rgba\(255, 255, 255, 0\.12\);/.test(optionSheet), '2a. the popover surface shares the episode sheet\'s glass treatment (rgba(16,16,18,0.92), 24px blur, 0.12 border)');
  ok(/box-shadow: 0 1px 0 rgba\(255, 255, 255, 0\.06\) inset, 0 18px 48px rgba\(0, 0, 0, 0\.55\), 0 4px 12px rgba\(0, 0, 0, 0\.32\);/.test(optionSheet), '2b. the popover carries the layered shadow');
  // The two-pane layout is EXACTLY as it was.
  ok(/\.server-pane \{ display: flex; align-items: flex-start;/.test(controls) && /\.server-rail-wrap \{ flex: 0 0 132px; position: sticky; top: 0; \}/.test(controls), '2c. NO layout change — the two-pane rail + list structure stays exactly as it is');
  ok(/class="server-rail" role="tablist" aria-label="Server groups"/.test(controls) && /server-rail-wrap/.test(controls) && /\.server-list \{ flex: 1 1 auto; min-width: 0; \}/.test(controls), '2d. the rail tablist + the list pane are untouched');
  // The rail items adopt the G1 chip language.
  ok(/\.rail-item \{ position: relative; display: block; min-height: 36px; padding: 8px 10px 8px 14px; border: 0; border-radius: 12px; color: rgba\(255, 255, 255, 0\.72\);/.test(controls), '2e. the rail items: 36px tall, radius 12, 72% white — the G1 chip language');
  ok(/font-size: 13px;\s*font-weight: 600;/.test(controls.slice(controls.indexOf('.rail-item {'), controls.indexOf('.rail-item.active::before'))), '2f. the rail label is 13px/600');
  ok(/\.rail-item:hover, \.rail-item:focus-visible \{ color: #fff; background: rgba\(255, 255, 255, 0\.05\); \}/.test(controls), '2g. the rail hover is the quiet white wash');
  ok(/\.rail-item\.active::before \{ content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px; border-radius: 1px; background: #fff; \}/.test(controls), '2h. the active rail item keeps its 2px white bar');
  // The rows adopt the G1 typography + dividers.
  ok(/\.server-list \.option-row \+ \.option-row \{ box-shadow: 0 -1px 0 rgba\(255, 255, 255, 0\.08\); \}/.test(controls), '2i. hairline dividers between the server rows');
  ok(/\.server-list \.row-copy strong \{ display: block; color: #fff; font-size: 15px; font-weight: 600;/.test(controls) && /\.server-list \.row-copy small \{ display: block; margin-top: 2px; color: var\(--pl-ink-3\); font-size: 12\.5px; \}/.test(controls), '2j. the server rows share the G1 typography (15px/600 title + 12.5px tertiary meta)');
  ok(/\.server-list \.option-row:hover, \.server-list \.option-row:focus-visible, \.server-list \.option-row\.selected \{ border-color: transparent; background: rgba\(255, 255, 255, 0\.05\); \}/.test(controls), '2k. the server row hover/selected states are quiet washes, not boxes');
}

// ===========================================================================
// §3 — G3: the centre loading card.
// ===========================================================================
console.log('\n§3 — G3: the compact centre loading card');
{
  const loadingRule = shell.slice(shell.indexOf('.loading-card { position: absolute'), shell.indexOf('.loading-ring {'));
  ok(/border-radius: 16px;/.test(loadingRule) && /padding: 18px 22px;/.test(loadingRule), '3a. radius 16 + padding 18px 22px (compact)');
  ok(/background: rgba\(18, 18, 20, 0\.86\);/.test(loadingRule) && /border: 1px solid rgba\(255, 255, 255, 0\.12\);/.test(loadingRule), '3b. background rgba(18,18,20,0.86) + the 0.12 hairline border');
  ok(/backdrop-filter: blur\(18px\);/.test(loadingRule), '3c. the card\'s single 18px blur layer');
  ok(/box-shadow: 0 16px 48px rgba\(0, 0, 0, 0\.45\), 0 2px 8px rgba\(0, 0, 0, 0\.3\);/.test(loadingRule), '3d. a soft shadow — NO full-screen dark overlay (just the card)');
  const ringRule = shell.slice(shell.indexOf('.loading-ring {'));
  ok(/width: 22px; height: 22px;/.test(ringRule) && /border: 2px solid/.test(ringRule) && /border-top-color: #fff;/.test(ringRule), '3e. the 22px WHITE spinner ring (2px stroke) on the left');
  ok(/animation: spin 0\.9s linear infinite;/.test(ringRule), '3f. the spinner runs 900ms linear');
  ok(/\.loading-copy strong \{ color: var\(--ink\); font-size: 14\.5px; font-weight: 600; \}/.test(shell), '3g. the title line is 14.5px/600');
  ok(/\.loading-copy small \{[^}]*font-size: 12\.5px; \}/.test(shell), '3h. the status line is 12.5px tertiary');
  ok(/<span class="loading-ring" aria-hidden="true"><\/span><span class="loading-copy">/.test(shell), '3i. the spinner leads on the LEFT, the copy on the right');
  // The status strings + the error state are untouched.
  ok(/Switching source…|Starting your stream…|Loading player…/.test(shell), '3j. the existing status strings are untouched');
  ok(/This source isn't available\./.test(shell) && /class="message-card" role="alert"/.test(shell), '3k. the error state\'s copy/handlers are untouched (separate message card)');
}

console.log(`\nRound 54 player polish: ${passed} passed, ${failed} failed (of ${passed + failed})`);
if (failed > 0) process.exit(1);
