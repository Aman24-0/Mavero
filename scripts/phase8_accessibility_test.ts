import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 8: Accessibility contract tests.
//
// Tests:
//   1. Source/episode sheets have role="dialog" + aria-modal="true"
//   2. Focus management: trigger capture + restore functions exist
//   3. Focus trap (Tab/Shift+Tab) function exists
//   4. Escape closes sheet via focus management
//   5. Focus restoration checks isConnected
//   6. Source and episode sheet focus states are independent
//   7. Existing ARIA attributes preserved (aria-label, aria-expanded, role)
//
// Classification: CONTRACT tests (regex on source). Browser-level accessibility
// testing (actual focus movement, screen reader announcements) is NOT possible
// in the current test environment without a browser automation tool.

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/lib/components/player/PlayerControls.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. ARIA modal semantics
// ============================================================

// 1a. Source sheet has role="dialog" + aria-modal="true".
assert.match(shell, /<div class="source-sheet" role="dialog" aria-modal="true" aria-label="Available playback sources">/, 'source sheet has role=dialog + aria-modal=true');

// 1b. Episode sheet has role="dialog" + aria-modal="true".
assert.match(shell, /<div class="episode-sheet" role="dialog" aria-modal="true" aria-label="Episode list">/, 'episode sheet has role=dialog + aria-modal=true');

// 1c. Existing role="presentation" on backdrops preserved.
assert.match(shell, /<div class="sheet-overlay" role="presentation" onclick=\{\(\) => closeSourceSheet\(\)\}/, 'source sheet backdrop has role=presentation');
assert.match(shell, /<div class="sheet-overlay" role="presentation" onclick=\{\(\) => closeEpisodeSheet\(\)\}/, 'episode sheet backdrop has role=presentation');

// ============================================================
// 2. Focus management functions exist
// ============================================================

// 2a. Source sheet trigger capture + restore.
assert.match(shell, /function openSourceSheet\(trigger: HTMLElement\)/, 'openSourceSheet function exists');
assert.match(shell, /function closeSourceSheet\(\)/, 'closeSourceSheet function exists');

// 2b. Episode sheet trigger capture + restore.
assert.match(shell, /function openEpisodeSheet\(trigger: HTMLElement\)/, 'openEpisodeSheet function exists');
assert.match(shell, /function closeEpisodeSheet\(\)/, 'closeEpisodeSheet function exists');

// 2c. Trigger state variables exist.
assert.match(shell, /let sourceSheetTrigger: HTMLElement \| null = null/, 'sourceSheetTrigger state declared');
assert.match(shell, /let episodeSheetTrigger: HTMLElement \| null = null/, 'episodeSheetTrigger state declared');

// 2d. Restore focus function exists with isConnected guard.
assert.match(shell, /function restoreFocus\(element: HTMLElement \| null\)/, 'restoreFocus function exists');
assert.match(shell, /if \(element instanceof HTMLElement && element\.isConnected\)/, 'restoreFocus checks isConnected');
assert.match(shell, /try \{ element\.focus\(\); \} catch/, 'restoreFocus wraps focus() in try/catch');

// 2e. Focus sheet close button function exists.
assert.match(shell, /function focusSheetCloseButton\(which: 'source' \| 'episode'\)/, 'focusSheetCloseButton function exists');

// ============================================================
// 3. Focus trap (Tab/Shift+Tab)
// ============================================================

// 3a. handleSheetKeydown function exists.
assert.match(shell, /function handleSheetKeydown\(event: KeyboardEvent\)/, 'handleSheetKeydown function exists');

// 3b. Tab key is handled.
assert.match(shell, /if \(event\.key !== 'Tab'\) return/, 'Tab key handled in sheet keydown');

// 3c. Shift+Tab wraps to last focusable.
assert.match(shell, /if \(event\.shiftKey\) \{[\s\S]*?last\.focus\(\)/, 'Shift+Tab wraps to last focusable element');

// 3d. Tab wraps to first focusable.
assert.match(shell, /if \(active === last \|\| !activeSheet\.contains\(active\)\) \{[\s\S]*?first\.focus\(\)/, 'Tab wraps to first focusable element');

// 3e. Focusables are filtered by visibility (offsetParent !== null).
assert.match(shell, /\.filter\(\(el\) => el\.offsetParent !== null\)/, 'focusables filtered by visibility');

// ============================================================
// 4. Escape closes sheet via focus management
// ============================================================

// 4a. Escape in handleSheetKeydown closes the active sheet.
assert.match(shell, /if \(event\.key === 'Escape'\) \{[\s\S]*?if \(sourceMenuOpen\) closeSourceSheet\(\)/, 'Escape closes source sheet');
assert.match(shell, /else if \(episodeMenuOpen\) closeEpisodeSheet\(\)/, 'Escape closes episode sheet');

// 4b. Sheet keydown takes priority over player shortcuts.
assert.match(shell, /if \(sourceMenuOpen \|\| episodeMenuOpen\) \{[\s\S]*?handleSheetKeydown\(event\);[\s\S]*?return;/, 'sheet keydown takes priority over player shortcuts');

// ============================================================
// 5. Sheet open moves focus into sheet
// ============================================================

// 5a. openSourceSheet focuses close button after render.
assert.match(shell, /function openSourceSheet[\s\S]*?setTimeout\(\(\) => focusSheetCloseButton\('source'\), 0\)/, 'openSourceSheet moves focus to close button');

// 5b. openEpisodeSheet focuses close button after render.
assert.match(shell, /function openEpisodeSheet[\s\S]*?setTimeout\(\(\) => focusSheetCloseButton\('episode'\), 0\)/, 'openEpisodeSheet moves focus to close button');

// 5c. Only one sheet can be open at a time.
assert.match(shell, /function openSourceSheet[\s\S]*?episodeMenuOpen = false/, 'openSourceSheet closes episode sheet');
assert.match(shell, /function openEpisodeSheet[\s\S]*?sourceMenuOpen = false/, 'openEpisodeSheet closes source sheet');

// ============================================================
// 6. Sheet close restores focus
// ============================================================

// 6a. closeSourceSheet restores focus to trigger.
assert.match(shell, /function closeSourceSheet\(\) \{[\s\S]*?restoreFocus\(sourceSheetTrigger\)/, 'closeSourceSheet restores focus to trigger');

// 6b. closeEpisodeSheet restores focus to trigger.
assert.match(shell, /function closeEpisodeSheet\(\) \{[\s\S]*?restoreFocus\(episodeSheetTrigger\)/, 'closeEpisodeSheet restores focus to trigger');

// 6c. chooseSource closes sheet (which restores focus).
assert.match(shell, /function chooseSource[\s\S]*?closeSourceSheet\(\)/, 'chooseSource closes sheet with focus restore');

// 6d. chooseEpisode closes sheet (which restores focus).
assert.match(shell, /function chooseEpisode[\s\S]*?closeEpisodeSheet\(\)/, 'chooseEpisode closes sheet with focus restore');

// 6e. Backdrop click closes sheet with focus restore.
assert.match(shell, /onclick=\{\(\) => closeSourceSheet\(\)\}/, 'source backdrop click closes sheet');
assert.match(shell, /onclick=\{\(\) => closeEpisodeSheet\(\)\}/, 'episode backdrop click closes sheet');

// 6f. Close button closes sheet with focus restore.
assert.match(shell, /aria-label="Close source list" onclick=\{\(\) => closeSourceSheet\(\)\}/, 'source close button restores focus');
assert.match(shell, /aria-label="Close episode list" onclick=\{\(\) => closeEpisodeSheet\(\)\}/, 'episode close button restores focus');

// ============================================================
// 7. Source and episode sheet focus states are independent
// ============================================================

// 7a. Separate trigger variables.
assert.match(shell, /let sourceSheetTrigger: HTMLElement \| null = null/, 'sourceSheetTrigger is separate from episodeSheetTrigger');
assert.match(shell, /let episodeSheetTrigger: HTMLElement \| null = null/, 'episodeSheetTrigger is separate from sourceSheetTrigger');

// 7b. Opening source sheet clears episode sheet trigger.
assert.match(shell, /function openSourceSheet[\s\S]*?episodeMenuOpen = false/, 'opening source sheet closes episode sheet');

// 7c. Opening episode sheet clears source sheet trigger.
assert.match(shell, /function openEpisodeSheet[\s\S]*?sourceMenuOpen = false/, 'opening episode sheet closes source sheet');

// ============================================================
// 8. Existing ARIA attributes preserved
// ============================================================

// 8a. role="application" on player shell.
assert.match(shell, /role="application"/, 'role=application preserved');

// 8b. role="toolbar" on embed shell controls.
assert.match(shell, /role="toolbar"/, 'role=toolbar preserved');

// 8c. role="alert" on error card.
assert.match(shell, /role="alert"/, 'role=alert preserved');

// 8d. role="status" on loading/completion cards.
assert.match(shell, /role="status"/, 'role=status preserved');

// 8e. aria-label on icon-only buttons.
assert.match(shell, /aria-label="Close player"/, 'aria-label on Back button preserved');
assert.match(shell, /aria-label="Switch source"/, 'aria-label on Switch source button preserved');
assert.match(shell, /aria-label="Open episode list"/, 'aria-label on episode list button preserved');

// 8f. aria-expanded on sheet toggle buttons.
assert.match(shell, /aria-expanded=\{sourceMenuOpen\}/, 'aria-expanded on source toggle preserved');
assert.match(shell, /aria-expanded=\{episodeMenuOpen\}/, 'aria-expanded on episode toggle preserved');

// 8g. aria-pressed on stateful toggles.
assert.match(shell, /aria-pressed=\{landscapeMode\}/, 'aria-pressed on landscape toggle preserved');
assert.match(shell, /aria-pressed=\{effectiveSandboxEnabled\}/, 'aria-pressed on sandbox toggle preserved');

// 8h. PlayerControls icon-only buttons retain accessible labels.
assert.match(controls, /aria-label=\{playing \? 'Pause' : 'Play'\}/, 'play/pause aria-label preserved');
assert.match(controls, /aria-label="Seek playback"/, 'seek aria-label preserved');
assert.match(controls, /aria-label="Volume"/, 'volume aria-label preserved');
assert.match(controls, /aria-label=\{fullscreen \? 'Exit fullscreen' : 'Enter fullscreen'\}/, 'fullscreen aria-label preserved');
assert.match(controls, /aria-label=\{pictureInPicture \? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'\}/, 'PiP aria-label preserved');

// ============================================================
// 9. Trigger elements pass themselves to open functions
// ============================================================

// 9a. Embed shell source button passes currentTarget.
assert.match(shell, /onclick=\{\(e\) => \{ if \(sourceMenuOpen\) closeSourceSheet\(\); else openSourceSheet\(e\.currentTarget as HTMLElement\); \}\}/, 'embed shell source button passes currentTarget');

// 9b. Embed shell episode button passes currentTarget.
assert.match(shell, /onclick=\{\(e\) => \{ if \(episodeMenuOpen\) closeEpisodeSheet\(\); else openEpisodeSheet\(e\.currentTarget as HTMLElement\); \}\}/, 'embed shell episode button passes currentTarget');

// 9c. Error card "Switch source" button passes currentTarget.
assert.match(shell, /onclick=\{\(e\) => openSourceSheet\(e\.currentTarget as HTMLElement\)\}/, 'error card Switch source button passes currentTarget');

console.log('Phase 8 accessibility tests passed: aria-modal on source sheet (1); aria-modal on episode sheet (1); backdrop role=presentation (2); focus management functions (5); trigger state variables (2); restoreFocus isConnected guard (2); focus trap Tab/Shift+Tab (3); escape closes sheet (2); sheet keydown priority (1); focus moves into sheet on open (2); only one sheet at a time (2); focus restoration on close (4); source/episode focus independence (3); existing ARIA preserved (8); PlayerControls aria-labels preserved (5); trigger elements pass currentTarget (3).');
