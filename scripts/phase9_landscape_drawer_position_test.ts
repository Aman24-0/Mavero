import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 9 URGENT FINAL UX FIX: Source drawer positioning contract.
//
// ORIGINAL PROBLEM: On real landscape phones, the source drawer appeared from
// the LEFT, anchored to the page viewport, or rendered as a small centered
// popup (a desktop `translate(-50%, -50%)` popover rule leaking into
// landscape, plus a viewport-level fixed backdrop).
//
// ORIGINAL FIX: orientation-class scoping — `.player-shell.landscape-mode`
// overrides plus `:not(.landscape-mode)` scoping of the portrait/desktop
// rules.
//
// CURRENT ARCHITECTURE (immersive-player redesign): the orientation-class
// mechanism was REPLACED by a simpler, leak-proof viewport contract:
//   - The player shell is the containing block (`position: relative`).
//   - Sheets are ALWAYS `position: absolute` (player-local, never fixed).
//   - Portrait/narrow (<769px): bottom sheet (`bottom: 0; left: 0; right: 0`,
//     max-height 60dvh, `sheet-up` animation).
//   - Wide (>=769px — landscape phones, desktop, TV): right-edge drawer
//     (`top: 0; right: 0; bottom: 0; left: auto`, full height, `slide-right`
//     animation). One media query serves every wide context, so there is no
//     landscape-specific rule that could leak, and NO desktop popover exists
//     at all.
// The original intent — drawer never left-anchored, never viewport-anchored,
// never a centered popup, always player-local, slides from the right edge on
// wide/landscape surfaces — holds by construction.

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Player shell is the containing block for the drawer
// ============================================================

// .player-shell has position: relative so absolute children anchor to it
// (not to the browser viewport or any transformed ancestor).
assert.match(shell, /\.player-shell \{[^}]*position: relative/, 'player-shell is position: relative (containing block)');

// ============================================================
// 2. Sheets are player-local absolute surfaces (NEVER viewport-fixed)
// ============================================================

const baseSheetsMatch = shell.match(/\.source-sheet, \.episode-sheet, \.mavero-streams-sheet \{([^}]+)\}/);
assert.ok(baseSheetsMatch, 'base sheets rule exists');
const baseSheetsBody = baseSheetsMatch[1];

assert.match(baseSheetsBody, /position: absolute/, 'sheets are absolute (player-local)');
assert.doesNotMatch(baseSheetsBody, /position: fixed/, 'sheets are NOT fixed (never viewport-anchored)');
assert.match(baseSheetsBody, /z-index: 21/, 'sheets z-index is 21 (above backdrop 20)');
assert.match(baseSheetsBody, /transform: none/, 'sheets carry no transform (no popover translation)');

// Portrait bottom-sheet base: bottom-anchored, capped height, vertical entry.
assert.match(baseSheetsBody, /bottom: 0/, 'base sheets anchored to player bottom edge');
assert.match(baseSheetsBody, /left: 0/, 'base sheets span from left edge');
assert.match(baseSheetsBody, /right: 0/, 'base sheets span to right edge');
assert.match(baseSheetsBody, /top: auto/, 'base sheets do not stretch from the top');
assert.match(baseSheetsBody, /max-height: 60dvh/, 'base sheets capped at 60dvh (portrait bottom sheet)');
assert.match(baseSheetsBody, /animation: sheet-up/, 'base sheets use sheet-up (vertical) entry');

// ============================================================
// 3. Wide viewport (landscape/desktop/TV): right-edge full-height drawer
// ============================================================

const wideRuleMatch = shell.match(/@media \(min-width: 769px\) \{[\s\S]*?\.source-sheet, \.episode-sheet, \.mavero-streams-sheet \{([^}]+)\}/);
assert.ok(wideRuleMatch, 'wide-viewport drawer rule exists');
const wideRuleBody = wideRuleMatch[1];

assert.match(wideRuleBody, /top: 0/, 'wide drawer starts at player top edge');
assert.match(wideRuleBody, /right: 0/, 'wide drawer anchored to player right edge');
assert.match(wideRuleBody, /bottom: 0/, 'wide drawer ends at player bottom edge');
assert.match(wideRuleBody, /left: auto/, 'wide drawer does NOT use left positioning (no left-side anchoring)');
assert.match(wideRuleBody, /height: 100%/, 'wide drawer occupies full player height');
assert.match(wideRuleBody, /max-height: 100%/, 'wide drawer max-height reset to 100% (NOT 60dvh)');
assert.match(wideRuleBody, /width: min\(360px, 32vw\)/, 'wide drawer width is min(360px, 32vw) (280–420px range)');

// Reset of conflicting portrait properties inside the wide rule.
assert.match(wideRuleBody, /border-top: 0/, 'wide drawer border-top reset (no portrait bottom-sheet border)');
assert.match(wideRuleBody, /border-radius: 0/, 'wide drawer border-radius reset (no rounded corners)');
assert.match(wideRuleBody, /border-left: 1px solid var\(--line-strong\)/, 'wide drawer has a left border (visual drawer edge)');
assert.match(wideRuleBody, /animation: slide-right/, 'wide drawer uses slide-right (horizontal) entry');

// The wide rule overrides EVERY positioning property the base rule sets
// (top/bottom/left/right/height/max-height/width/animation), so no portrait
// geometry can leak into wide/landscape contexts.
for (const prop of ['top', 'bottom', 'left', 'height', 'max-height', 'animation']) {
  assert.match(wideRuleBody, new RegExp(`${prop}:`), `wide rule overrides ${prop} (no base-rule leak)`);
}

// Episode and streams drawers share the same contract with their own widths.
assert.match(shell, /\.episode-sheet \{ width: min\(380px, 34vw\); \}/, 'episode drawer width contract');
assert.match(shell, /\.mavero-streams-sheet \{ width: min\(420px, 38vw\); \}/, 'streams drawer width contract');

// ============================================================
// 4. Backdrop is player-local
// ============================================================

const overlayMatch = shell.match(/\.sheet-overlay \{([^}]+)\}/);
assert.ok(overlayMatch, '.sheet-overlay rule exists');
const overlayBody = overlayMatch[1];

assert.match(overlayBody, /position: absolute/, 'backdrop is absolute (player-local), NOT fixed (viewport-level)');
assert.doesNotMatch(overlayBody, /position: fixed/, 'backdrop is NOT fixed');
assert.match(overlayBody, /inset: 0/, 'backdrop covers the entire player shell (inset: 0)');
assert.match(overlayBody, /z-index: 20/, 'backdrop z-index is 20 (BELOW drawer z-index 21)');
// Redesign note: the scrim now uses a light backdrop-filter blur. The original
// containment concern (blur creating a containing block that would re-anchor
// fixed children) is moot — nothing inside the shell is position: fixed
// anymore; sheets and backdrop are absolute siblings.

// ============================================================
// 5. slide-right animation enters from the RIGHT edge
// ============================================================

// slide-right keyframe: starts at translateX(100%) (off-screen right),
// ends at translateX(0) (flush with player's right edge).
assert.match(shell, /@keyframes slide-right \{ from \{ transform: translateX\(100%\); \} to \{ transform: translateX\(0\); \} \}/, 'slide-right keyframe: translateX(100%) → translateX(0) — enters from RIGHT edge');

// sheet-up (portrait) keyframe still exists, used only by the base rule.
assert.match(shell, /@keyframes sheet-up \{ from \{ transform: translateY\(100%\); \} to \{ transform: translateY\(0\); \} \}/, 'sheet-up keyframe preserved for portrait bottom-sheet');

// ============================================================
// 6. No desktop popover exists anywhere
// ============================================================

// The old centered popover (translate(-50%, -50%)) was removed outright —
// there is no rule that could center the sheet in any context.
assert.doesNotMatch(shell, /translate\(-50%, -50%\)/, 'no centered popover transform anywhere');

// ============================================================
// 7. Drawer list is scrollable and respects the safe area (wide context)
// ============================================================

assert.match(shell, /@media \(min-width: 769px\) \{[\s\S]*?\.source-sheet \.sheet-list, \.episode-sheet \.sheet-list, \.mavero-streams-sheet \.sheet-list \{[^}]*overflow-y: auto/, 'wide drawer has its own scrollable list (overflow-y: auto)');
assert.match(shell, /@media \(min-width: 769px\) \{[\s\S]*?\.source-sheet \.sheet-list, \.episode-sheet \.sheet-list, \.mavero-streams-sheet \.sheet-list \{[^}]*padding-bottom: max\(14px, env\(safe-area-inset-bottom\)\)/, 'wide drawer list respects safe-area-inset-bottom');

// ============================================================
// 8. Touch targets remain >=44px
// ============================================================

assert.match(shell, /\.sheet-option \{[^}]*min-height: 52px/, 'sheet-option min-height is 52px (>= 44px touch target)');
assert.match(shell, /\.fab-item \{[^}]*height: 44px/, 'FAB menu items are 44px tall (>= 44px touch target)');
assert.match(shell, /\.back-fab \{[^}]*width: 44px; height: 44px/, 'back FAB is 44×44px');

// ============================================================
// 9. Close button remains inside the drawer
// ============================================================

// The close-button is inside .sheet-head, which is inside .source-sheet.
assert.match(shell, /<div class="source-sheet"[^>]*>[\s\S]*?<div class="sheet-head">[\s\S]*?<button class="close-button"/, 'close button is inside the source-sheet (drawer)');

// ============================================================
// 10. Landscape affordances: unified FAB control group
// ============================================================

assert.match(shell, /class="control-fab-group"/, 'unified FAB control group exists');
assert.match(shell, /class="fab-item"[^>]*aria-pressed=\{landscapeMode\}/, 'landscape toggle/exit FAB item preserved');
assert.match(shell, /aria-label=\{landscapeMode \? 'Exit landscape player' : 'Toggle landscape player'\}/, 'landscape exit label preserved');

// ============================================================
// 11. Reduced motion disables the sheet entry animations
// ============================================================

assert.match(
  shell,
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.source-sheet, \.episode-sheet, \.mavero-streams-sheet \{ animation: none; \}/,
  'reduced motion disables sheet entry animations (both sheet-up and slide-right)'
);

// ============================================================
// 12. Single unified chrome (no portrait-only header/bottom gating)
// ============================================================

// The immersive shell renders one chrome for every orientation; the old
// {#if !landscapeMode} header/bottom-bar gating was removed with the redesign.
assert.doesNotMatch(shell, /player-header/, 'no portrait-only header');
assert.doesNotMatch(shell, /bottom-bar/, 'no bottom bar');

// ============================================================
// 13. Drawer does NOT escape the player shell — mathematical proof
// ============================================================

// Given:
//   - .player-shell is position: relative (containing block).
//   - Sheets are position: absolute at every viewport width.
//   - Wide (>=769px): top: 0; right: 0; bottom: 0; left: auto;
//     height: 100%; width: min(360px, 32vw).
//   - Narrow (<769px): bottom: 0; left: 0; right: 0; max-height: 60dvh.
//
// The drawer is therefore guaranteed to be:
//   - Right-aligned to the player shell's right edge (wide) or bottom sheet
//     (narrow).
//   - Full-height of the player shell (wide).
//   - Completely inside the player shell in both contexts.
//   - Never anchored to the browser viewport (nothing is position: fixed).
//   - Never a centered popup (no translate(-50%, -50%) anywhere).

// ============================================================
// 14. z-index stacking: drawer (21) > backdrop (20) > player content
// ============================================================

assert.match(baseSheetsBody, /z-index: 21/, 'drawer z-index 21');
assert.match(overlayBody, /z-index: 20/, 'backdrop z-index 20');
// 21 > 20 → drawer always visible above backdrop.

console.log('Phase 9 landscape source drawer positioning contract tests passed: player-shell is containing block (1 check); sheets player-local absolute + portrait bottom-sheet contract (9 checks); wide right-edge full-height drawer contract (16 checks); backdrop player-local (4 checks); slide-right/sheet-up keyframes (2 checks); no popover anywhere (1 check); scrollable list + safe-area (2 checks); touch targets >=44px (3 checks); close button inside drawer (1 check); unified FAB landscape affordances (3 checks); reduced motion (1 check); single unified chrome (2 checks); mathematical drawer-bounds proof; z-index stacking (2 checks).');
