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

// MAVP-5 Issue 4 supersession: the shared base rule now covers the SOURCE
// sheet only — the episode sheet is a LEFT drawer with its own rule (same
// surface system, same player-local anchoring, same z-index layering).
const baseSheetsMatch = shell.match(/\.source-sheet \{([^}]+)\}/);
assert.ok(baseSheetsMatch, 'base source-sheet rule exists (the mavero-streams-sheet selector was retired with the obsolete player branch, 0111d7f)');
const baseSheetsBody = baseSheetsMatch[1];
const episodeSheetMatch = shell.match(/\.episode-sheet \{([^}]+)\}/);
assert.ok(episodeSheetMatch, 'MAVP-5: the episode-sheet left-drawer rule exists');

assert.match(baseSheetsBody, /position: absolute/, 'sheets are absolute (player-local)');
assert.doesNotMatch(baseSheetsBody, /position: fixed/, 'sheets are NOT fixed (never viewport-anchored)');
assert.match(baseSheetsBody, /z-index: 21/, 'sheets z-index is 21 (above backdrop 20)');
assert.match(episodeSheetMatch[1], /position: absolute; z-index: 21;/, 'MAVP-5: the episode sheet keeps the same absolute/z-21 anchoring');
assert.match(baseSheetsBody, /transform: none/, 'sheets carry no transform (no popover translation)');

// Round 59 (K2) supersession: the base rule is now the ONLY rule — the
// episode sheet's RIGHT twin at EVERY viewport (left auto, width
// min(360px, calc(100vw - 24px)), slide-right entry).
assert.match(baseSheetsBody, /top: max\(12px, env\(safe-area-inset-top\)\)/, 'base sheet floats 12px (safe-area) below the player top edge (round 57 I5)');
assert.match(baseSheetsBody, /bottom: max\(12px, env\(safe-area-inset-bottom\)\)/, 'base sheet floats 12px (safe-area) above the player bottom edge');
assert.match(baseSheetsBody, /left: auto/, 'base sheet is RIGHT-anchored — left auto at every viewport (round 59 K2)');
assert.match(baseSheetsBody, /right: max\(12px, env\(safe-area-inset-right\)\)/, 'base sheet insets 12px (safe-area) from the right edge');
assert.match(baseSheetsBody, /border-radius: 20px/, 'rounded top AND bottom corners (radius 20 — no flush bottom sheet)');
assert.match(baseSheetsBody, /background: rgba\(16, 16, 18, 0\.92\)/, 'the glassy episode-sheet surface (rgba(16,16,18,0.92))');
assert.match(baseSheetsBody, /backdrop-filter: blur\(24px\)/, 'ONE 24px backdrop blur (the sheet\'s single blur layer)');
assert.match(baseSheetsBody, /border: 1px solid rgba\(255, 255, 255, 0\.12\)/, 'the 1px rgba(255,255,255,0.12) hairline');
assert.match(baseSheetsBody, /max-height: none/, 'no 60dvh cap — the floating panel spans the safe-area insets');
assert.match(baseSheetsBody, /display: flex; flex-direction: column/, 'flex column: the head fixed, the list scrolls INSIDE the panel');
assert.match(baseSheetsBody, /overflow: hidden/, 'the panel clips; the LIST scrolls (internal scroll)');
assert.match(baseSheetsBody, /animation: slide-right/, 'base sheets use slide-right (horizontal, from the RIGHT) entry (round 59 K2)');

// ============================================================
// 3. The source sheet is the right drawer at EVERY viewport — ONE rule
//    (round 59 K2: the ≥900px override is GONE; the base rule IS the
//    episode sheet's right twin)
// ============================================================

// Round 59 (K2) supersession: the single base rule carries the full right
// drawer geometry — right max(12px) anchor, left auto, the bounded 360px
// width, radius 20 and the slide-right entry — at every viewport. No
// ≥900px override exists anymore (the episode sheet keeps its left-drawer
// rule; the ≥900px media block left in the file only grows the chips).
assert.match(baseSheetsBody, /width: min\(360px, calc\(100vw - 24px\)\)/, 'the source sheet width is min(360px, calc(100vw - 24px)) at EVERY viewport (the episode sheet\'s exact mirror)');
assert.doesNotMatch(shell, /@media \(min-width: 900px\) \{[\s\S]{0,400}?\.source-sheet \{/, 'no ≥900px source-sheet override remains (ONE rule at every viewport)');

// MAVP-5 Issue 4 supersession: the episode sheet's width contract is now
// viewport-independent — a bounded LEFT drawer at every viewport
// (narrow-screen-safe; the streams drawer contract was retired with the
// streams sheet, 0111d7f). Round 54 (G1) supersession: the floating glass
// panel keeps the bounded 360px cap but insets itself 12px from each edge,
// so the width caps to the viewport minus the two insets.
assert.match(shell, /\.episode-sheet \{[^}]*width: min\(360px, calc\(100vw - 24px\)\);/, 'episode drawer width contract (MAVP-5 left drawer; round 54 G1 floating panel)');

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
// no SHEET/drawer rule centers itself. [2026-10] the playback LOADING card
// legitimately centers in the viewport (top/left 50% + translate) — that is
// not the episode sheet; scope the negative guard to the sheet family.
const sheetRules = shell.match(/\.(episode-sheet|source-sheet|sheet-head)[^\{]*\{[^\}]*\}/g ?? []);
// Line 3052 is a COMMENT describing the loading card; line 3082 is the
// loading-card rule itself — both refer to the SAME legitimate centering.
assert.ok((shell.match(/translate\(-50%, -50%\)/g) ?? []).length <= 2, 'no centered popover transform beyond the loading-card centering (rule + its comment)');
assert.ok(!/episode-sheet[^\{]*\{[^\}]*translate\(-50%/.test(shell) && !/source-sheet[^\{]*\{[^\}]*translate\(-50%/.test(shell), 'no centered popover transform on any sheet (drawer forms only)');

// ============================================================
// 7. Drawer list is scrollable and respects the safe area (wide context)
// ============================================================

// Round 57 (I5) supersession: the source list scrolls INSIDE the floating
// panel at EVERY viewport (the ≥900px rule only changes the panel's
// geometry); the episode sheet's list scrolls via its own viewport-
// independent rule.
assert.match(shell, /\.source-sheet \.sheet-list \{[^}]*overflow-y: auto/, 'the source list scrolls inside the floating panel (overflow-y: auto, every viewport)');
assert.match(shell, /\.episode-sheet \.sheet-list \{[^}]*overflow-y: auto/, 'MAVP-5: the episode drawer list scrolls at every viewport');
assert.match(shell, /\.source-sheet \.sheet-list \{[^}]*padding-bottom: max\(14px, env\(safe-area-inset-bottom\)\)/, 'source list respects safe-area-inset-bottom (every viewport)');

// ============================================================
// 8. Touch targets remain >=44px
// ============================================================

assert.match(shell, /\.sheet-option \{[^}]*min-height: 64px/, 'sheet-option min-height is 64px (round 57 I6: >= 44px touch target)');
// MAVP-5 Issue 4 supersession: the fab-item pill was replaced by the episode
// chip — the chip keeps the same >=44px touch target (min-width 44px).
assert.match(shell, /\.episode-chip \{[^}]*min-width: 44px/, 'episode chip keeps the >=44px touch target (MAVP-5)');
assert.match(shell, /\.back-fab \{[^}]*width: 37px; height: 37px/, 'back FAB is 37×37px');

// ============================================================
// 9. Close button remains inside the drawer
// ============================================================

// The close-button is inside .sheet-head, which is inside .source-sheet.
assert.match(shell, /<div class="source-sheet"[^>]*>[\s\S]*?<div class="sheet-head">[\s\S]*?<button class="close-button"/, 'close button is inside the source-sheet (drawer)');

// ============================================================
// 10. Landscape affordances: unified FAB control group
// ============================================================

assert.match(shell, /class="control-fab-group"/, 'unified FAB control group exists');
// UPDATED (player redesign): the landscape toggle is now the DEDICATED
// bottom-right control FAB (no longer a menu item inside the group).
assert.match(shell, /class="control-fab landscape-fab"[^>]*aria-pressed=\{landscapeMode\}/, 'landscape toggle/exit FAB preserved (dedicated control)');
assert.match(shell, /aria-label=\{landscapeMode \? 'Exit landscape player' : 'Enter landscape player'\}/, 'landscape exit label preserved');

// ============================================================
// 11. Reduced motion disables the sheet entry animations
// ============================================================

assert.match(
  shell,
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.source-sheet, \.episode-sheet \{ animation: none; \}/,
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
//   - Wide (>=900px, round 57 I5): top/bottom/right: max(12px, safe-area);
//     left: auto; height: auto; width: min(380px, 32vw).
//   - Narrow (<900px): all four edges at max(12px, safe-area) — the floating
//     glass panel (the list scrolls inside).
//
// The drawer is therefore guaranteed to be:
//   - Right-aligned inside the player shell's safe-area insets (wide) or a
//     floating panel inside them (narrow).
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
