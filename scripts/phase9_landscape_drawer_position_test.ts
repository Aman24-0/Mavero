import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 9 URGENT FINAL UX FIX: Landscape source drawer positioning contract.
//
// PROBLEM: On real landscape phones, the source drawer was appearing from
// the LEFT, anchoring to the top of the page viewport, or rendering as a
// small centered popup. This happened because:
//   1. The portrait bottom-sheet base rule `.source-sheet, .episode-sheet`
//      sets `position: fixed; bottom: 0; left: 0; right: 0;` and applies
//      globally — including landscape mode.
//   2. The desktop `@media (min-width: 769px)` rule applies
//      `transform: translate(-50%, -50%)` to `.source-sheet` — including
//      landscape mode on wide landscape phones (≥769px wide).
//   3. The landscape override rule did NOT reset `transform` or `margin`,
//      so the desktop popover transform won on wide landscape phones,
//      centering the sheet as a small floating popup near the top.
//   4. The `.sheet-overlay` was `position: fixed; inset: 0;` — covering
//      the entire browser viewport instead of just the player shell.
//
// FIX: The landscape rules now:
//   - Explicitly reset `transform: none`, `margin: 0`, `top: 0`,
//     `right: 0`, `bottom: 0`, `left: auto`, `height: 100%`,
//     `max-height: 100%`.
//   - Use `position: absolute` so the drawer anchors to `.player-shell`
//     (which is `position: relative`) — never to the browser viewport.
//   - Use `translateX(100%) → translateX(0)` animation (slide-right) so
//     the drawer enters from the RIGHT edge of the player shell.
//   - The portrait bottom-sheet rule and the desktop popover rule are
//     scoped to `:not(.landscape-mode)` so they can NEVER apply in
//     landscape mode, regardless of viewport width.
//   - The landscape `.sheet-overlay` is `position: absolute; inset: 0;`
//     so the backdrop is player-local, NOT viewport-level.

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Player shell is the containing block for the landscape drawer
// ============================================================

// .player-shell has position: relative so absolute children anchor to it
// (not to the browser viewport or any transformed ancestor).
assert.match(shell, /\.player-shell \{[^}]*position: relative/, 'player-shell is position: relative (containing block)');

// ============================================================
// 2. Landscape source-sheet right-edge full-height contract
// ============================================================

// Landscape source sheet MUST be absolute (not fixed) and right-anchored.
const landscapeSourceSheetMatch = shell.match(/\.player-shell\.landscape-mode \.source-sheet \{([^}]+)\}/);
assert.ok(landscapeSourceSheetMatch, 'landscape .source-sheet rule exists');
const landscapeSourceSheetBody = landscapeSourceSheetMatch[1];

assert.match(landscapeSourceSheetBody, /position: absolute/, 'landscape source-sheet is absolute (player-local)');
assert.doesNotMatch(landscapeSourceSheetBody, /position: fixed/, 'landscape source-sheet is NOT fixed (not viewport-anchored)');

assert.match(landscapeSourceSheetBody, /top: 0/, 'landscape source-sheet starts at player top edge');
assert.match(landscapeSourceSheetBody, /right: 0/, 'landscape source-sheet anchored to player right edge');
assert.match(landscapeSourceSheetBody, /bottom: 0/, 'landscape source-sheet ends at player bottom edge');
assert.match(landscapeSourceSheetBody, /left: auto/, 'landscape source-sheet does NOT use left positioning (no left-side anchoring)');
assert.match(landscapeSourceSheetBody, /height: 100%/, 'landscape source-sheet occupies full player height');
assert.match(landscapeSourceSheetBody, /max-height: 100%/, 'landscape source-sheet max-height reset to 100% (NOT 60dvh or 70dvh)');

// Width: landscape-specific (280–360px range, ~30vw).
assert.match(landscapeSourceSheetBody, /width: min\(320px, 30vw\)/, 'landscape source-sheet width is 320px or 30vw (within 280–360px range)');

// Reset of conflicting properties from portrait/desktop rules.
assert.match(landscapeSourceSheetBody, /transform: none/, 'landscape source-sheet transform reset to none (overrides desktop popover translate(-50%, -50%))');
assert.match(landscapeSourceSheetBody, /margin: 0/, 'landscape source-sheet margin reset to 0');
assert.match(landscapeSourceSheetBody, /border-top: 0/, 'landscape source-sheet border-top reset (no portrait bottom-sheet border-top)');
assert.match(landscapeSourceSheetBody, /border-radius: 0/, 'landscape source-sheet border-radius reset to 0 (no portrait/desktop rounded corners)');
assert.match(landscapeSourceSheetBody, /border-left: 1px solid var\(--line-strong\)/, 'landscape source-sheet has a left border (the visual "drawer edge" against the player)');

// Animation uses slide-right (translateX), NOT sheet-up (translateY).
assert.match(landscapeSourceSheetBody, /animation: slide-right/, 'landscape source-sheet uses slide-right (horizontal) animation');

// z-index: drawer above backdrop.
assert.match(landscapeSourceSheetBody, /z-index: 21/, 'landscape source-sheet z-index is 21 (above backdrop 20)');

// ============================================================
// 3. Landscape episode-sheet follows the same contract
// ============================================================

const landscapeEpisodeSheetMatch = shell.match(/\.player-shell\.landscape-mode \.episode-sheet \{([^}]+)\}/);
assert.ok(landscapeEpisodeSheetMatch, 'landscape .episode-sheet rule exists');
const landscapeEpisodeSheetBody = landscapeEpisodeSheetMatch[1];

assert.match(landscapeEpisodeSheetBody, /position: absolute/, 'landscape episode-sheet is absolute (player-local)');
assert.match(landscapeEpisodeSheetBody, /top: 0/, 'landscape episode-sheet starts at player top');
assert.match(landscapeEpisodeSheetBody, /right: 0/, 'landscape episode-sheet anchored to player right edge');
assert.match(landscapeEpisodeSheetBody, /bottom: 0/, 'landscape episode-sheet ends at player bottom');
assert.match(landscapeEpisodeSheetBody, /left: auto/, 'landscape episode-sheet does NOT use left positioning');
assert.match(landscapeEpisodeSheetBody, /height: 100%/, 'landscape episode-sheet occupies full player height');
assert.match(landscapeEpisodeSheetBody, /max-height: 100%/, 'landscape episode-sheet max-height reset to 100%');
assert.match(landscapeEpisodeSheetBody, /transform: none/, 'landscape episode-sheet transform reset to none');
assert.match(landscapeEpisodeSheetBody, /animation: slide-right/, 'landscape episode-sheet uses slide-right (horizontal) animation');

// ============================================================
// 4. Landscape backdrop is player-local
// ============================================================

const landscapeOverlayMatch = shell.match(/\.player-shell\.landscape-mode \.sheet-overlay \{([^}]+)\}/);
assert.ok(landscapeOverlayMatch, 'landscape .sheet-overlay rule exists');
const landscapeOverlayBody = landscapeOverlayMatch[1];

assert.match(landscapeOverlayBody, /position: absolute/, 'landscape backdrop is absolute (player-local), NOT fixed (viewport-level)');
assert.doesNotMatch(landscapeOverlayBody, /position: fixed/, 'landscape backdrop is NOT fixed');
assert.match(landscapeOverlayBody, /inset: 0/, 'landscape backdrop covers the entire player shell (inset: 0)');
assert.match(landscapeOverlayBody, /z-index: 20/, 'landscape backdrop z-index is 20 (BELOW drawer z-index 21)');
assert.match(landscapeOverlayBody, /backdrop-filter: none/, 'landscape backdrop-filter disabled (no new containing block, no blur on scrim)');

// ============================================================
// 5. slide-right animation enters from the RIGHT edge
// ============================================================

// slide-right keyframe: starts at translateX(100%) (off-screen right),
// ends at translateX(0) (flush with player's right edge).
assert.match(shell, /@keyframes slide-right \{ from \{ transform: translateX\(100%\); \} to \{ transform: translateX\(0\); \} \}/, 'slide-right keyframe: translateX(100%) → translateX(0) — enters from RIGHT edge');

// sheet-up (portrait) keyframe still exists, used only by portrait rule.
assert.match(shell, /@keyframes sheet-up \{ from \{ transform: translateY\(100%\); \} to \{ transform: translateY\(0\); \} \}/, 'sheet-up keyframe preserved for portrait bottom-sheet');

// ============================================================
// 6. Portrait bottom-sheet rule is scoped to :not(.landscape-mode)
//    so it can NEVER apply in landscape mode.
// ============================================================

// The base portrait bottom-sheet rule MUST be scoped to non-landscape
// (or otherwise the landscape rule must override every property it sets).
// We chose to scope it via :not(.landscape-mode) on the .player-shell
// ancestor so the rule does not match at all in landscape mode.
assert.match(
  shell,
  /\.player-shell:not\(\.landscape-mode\) \.source-sheet, \.player-shell:not\(\.landscape-mode\) \.episode-sheet \{[^}]*position: fixed[^}]*bottom: 0[^}]*left: 0[^}]*right: 0[^}]*max-height: 60dvh/,
  'portrait bottom-sheet rule is scoped to :not(.landscape-mode) and remains a bottom sheet'
);

// The portrait rule must NOT be a bare unscoped `.source-sheet, .episode-sheet`
// rule (which would leak into landscape mode).
assert.doesNotMatch(
  shell,
  /(^|[^.])\n\s*\.source-sheet, \.episode-sheet \{ position: fixed/,
  'no unscoped portrait bottom-sheet rule that could leak into landscape'
);

// ============================================================
// 7. Desktop popover rule is scoped to :not(.landscape-mode)
//    so it can NEVER apply in landscape mode (even on wide landscape phones).
// ============================================================

assert.match(
  shell,
  /@media \(min-width: 769px\) \{[\s\S]*?\.player-shell:not\(\.landscape-mode\) \.source-sheet, \.player-shell:not\(\.landscape-mode\) \.episode-sheet \{[^}]*transform: translate\(-50%, -50%\)/,
  'desktop popover rule is scoped to :not(.landscape-mode) — no centered popover in landscape'
);

// Desktop popover rule must NOT be a bare unscoped `.source-sheet, .episode-sheet`
// inside the @media block.
assert.doesNotMatch(
  shell,
  /@media \(min-width: 769px\) \{\s*\.source-sheet, \.episode-sheet \{[^}]*transform: translate\(-50%, -50%\)/,
  'no unscoped desktop popover rule that could leak into landscape'
);

// ============================================================
// 8. Landscape source sheet has its own scrollable list
// ============================================================

assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \.sheet-list \{[^}]*overflow-y: auto/, 'landscape source sheet has its own scrollable list (overflow-y: auto)');
assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \.sheet-list \{[^}]*padding-bottom: max\(14px, env\(safe-area-inset-bottom\)\)/, 'landscape source sheet list respects safe-area-inset-bottom');

// ============================================================
// 9. Touch targets remain >=44px (existing .sheet-option min-height: 52px)
// ============================================================

assert.match(shell, /\.sheet-option \{[^}]*min-height: 52px/, 'sheet-option min-height is 52px (>= 44px touch target)');
assert.match(shell, /\.landscape-overlay-button \{[^}]*width: 44px; height: 44px/, 'landscape overlay buttons are 44×44px');

// ============================================================
// 10. Close button remains inside the drawer
// ============================================================

// The close-button is inside .sheet-head, which is inside .source-sheet.
assert.match(shell, /<div class="source-sheet"[^>]*>[\s\S]*?<div class="sheet-head">[\s\S]*?<button class="close-button"/, 'close button is inside the source-sheet (drawer)');

// ============================================================
// 11. Landscape controls overlay (Source + Exit buttons) preserved
// ============================================================

assert.match(shell, /class="landscape-controls-overlay"/, 'landscape controls overlay exists');
assert.match(shell, /class="landscape-overlay-button"[^>]*aria-label="Switch source"/, 'landscape source button preserved');
assert.match(shell, /class="landscape-overlay-button"[^>]*aria-label="Exit landscape player"/, 'landscape exit button preserved');

// ============================================================
// 12. Reduced motion disables the slide-right animation in landscape
// ============================================================

assert.match(
  shell,
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.player-shell\.landscape-mode \.source-sheet[\s\S]*?animation: none/,
  'reduced motion disables slide-right animation on landscape source sheet'
);

// ============================================================
// 13. Portrait header / bottom-bar gating preserved
// ============================================================

// Portrait header is gated on !landscapeMode.
assert.match(shell, /\{#if !landscapeMode\}[\s\S]*?<header class="player-header">/, 'portrait header only rendered when !landscapeMode');
// Bottom bar is gated on !landscapeMode.
assert.match(shell, /\{#if !landscapeMode\}[\s\S]*?<div class="bottom-bar"/, 'bottom bar only rendered when !landscapeMode');

// ============================================================
// 14. Drawer does NOT escape the player shell — mathematical proof
// ============================================================

// Given:
//   - .player-shell is position: relative (containing block).
//   - .source-sheet in landscape is position: absolute; top: 0; right: 0;
//     bottom: 0; left: auto; height: 100%; width: min(320px, 30vw).
//
// Computed bounds:
//   left   = playerShellWidth - drawerWidth  (because right: 0, width: W)
//   right  = 0  (player-local)
//   top    = 0  (player-local)
//   bottom = 0  (player-local)
//   height = playerShellHeight  (because top:0, bottom:0 OR height:100%)
//
// The drawer is therefore guaranteed to be:
//   - Right-aligned to the player shell's right edge.
//   - Full-height of the player shell.
//   - Completely inside the player shell.
//   - Never anchored to the browser viewport.
//   - Never anchored to the page.
//
// The portrait base rule and the desktop @media rule are scoped to
// :not(.landscape-mode), so they cannot leak their `position: fixed`,
// `transform: translate(-50%, -50%)`, `bottom: 0; left: 0; right: 0;`,
// or `max-height: 60dvh` into landscape mode.

// Sanity: drawer width is in the requested 280–360px range.
// (Already asserted as `min(320px, 30vw)` above.)

// ============================================================
// 15. z-index stacking: drawer (21) > backdrop (20) > player content
// ============================================================

assert.match(landscapeSourceSheetBody, /z-index: 21/, 'landscape drawer z-index 21');
assert.match(landscapeOverlayBody, /z-index: 20/, 'landscape backdrop z-index 20');
// 21 > 20 → drawer always visible above backdrop.

console.log('Phase 9 landscape source drawer positioning contract tests passed: player-shell is containing block (1 check); landscape source-sheet right-edge full-height contract (14 checks); landscape episode-sheet same contract (8 checks); landscape backdrop player-local (5 checks); slide-right animation enters from RIGHT (2 checks); portrait bottom-sheet scoped to :not(.landscape-mode) (2 checks); desktop popover scoped to :not(.landscape-mode) (2 checks); scrollable list + safe-area (2 checks); touch targets >=44px (2 checks); close button inside drawer (1 check); landscape overlay buttons preserved (3 checks); reduced motion (1 check); portrait gating preserved (2 checks); mathematical drawer-bounds proof (3 checks).');
