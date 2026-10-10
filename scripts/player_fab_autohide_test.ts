import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// FAB Auto-Hide Behavior Regression Tests
//
// Scope: ONLY the Mavero FAB auto-hide behavior in PlayerShell.svelte.
// These tests verify the targeted fix for the auto-hide behavior without
// making any assertions about the visual redesign (which is approved).
//
// Verified behavior:
//   1. FABs are initially visible (controlsVisible starts true)
//   2. 5s inactivity hides FABs (player redesign; was 10s)
//   3. User interaction reveals FABs again
//   4. Interaction resets the timer (single authoritative timer)
//   5. Sheet-open + keyboard-focus state prevents hiding
//   6. Closing the menu restarts the timer
//   7. Closing a sheet (source/episode/streams) restarts the timer
//   8. Video/player itself is NOT hidden by the FAB auto-hide state
//   9. Component cleanup clears timers + listeners
//  10. visibility:hidden is applied in the hidden CSS state
//  11. portrait↔landscape does not break the timer
//  12. pointerdown + pointermove + touchstart are all registered
//  13. No duplicate inactivity-timer body in onMount

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. FABs initially visible
// ============================================================
assert.match(shell, /let controlsVisible = true/, 'controlsVisible initial state is true (FABs visible on mount)');

// ============================================================
// 2. 10s inactivity hides FABs
// ============================================================
assert.match(shell, /5_000/, '5s auto-hide timer value present (player redesign)');
assert.match(shell, /hideTimer = setTimeout\(\(\) => \{[^}]*controlsVisible = false/, 'timer callback sets controlsVisible = false');

// ============================================================
// 3. User interaction reveals FABs (event listeners route to revealControls)
// ============================================================
assert.match(shell, /const showControls = \(\) => \{ revealControls\(\); \};/, 'showControls delegates to revealControls (single authoritative timer)');
assert.match(shell, /playerRoot\?\.addEventListener\('pointermove', showControls\)/, 'pointermove listener registered');
assert.match(shell, /playerRoot\?\.addEventListener\('pointerdown', showControls/, 'pointerdown listener registered (desktop click + pen)');
assert.match(shell, /playerRoot\?\.addEventListener\('touchstart', showControls/, 'touchstart listener registered (mobile tap)');

// ============================================================
// 4. Single authoritative timer — NO duplicate timer body inside onMount
// ============================================================
// The onMount body must NOT contain a second `hideTimer = setTimeout(...)`.
// We extract the onMount block and verify the only setTimeout-to-hideControls
// pattern lives in revealControls (outside onMount).
const onMountStart = shell.indexOf('onMount(() => {');
assert.ok(onMountStart >= 0, 'onMount block found');
// Find the end of onMount by scanning balanced braces starting after the opening {
let onMountEnd = -1;
let depth = 0;
for (let i = onMountStart + 'onMount(() => '.length; i < shell.length; i++) {
  const ch = shell[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) { onMountEnd = i + 1; break; }
  }
}
assert.ok(onMountEnd > onMountStart, 'onMount block end found');
const onMountBlock = shell.slice(onMountStart, onMountEnd);
assert.doesNotMatch(onMountBlock, /hideTimer = setTimeout/, 'NO duplicate hideTimer = setTimeout inside onMount — single authoritative timer');
assert.doesNotMatch(onMountBlock, /controlsVisible = false/, 'NO controlsVisible = false mutation inside onMount — hiding happens only via revealControls timer');

// ============================================================
// 5. Menu-open state prevents hiding
// ============================================================
assert.match(shell, /\(playing \|\| embedPlaying\) && !sourceMenuOpen && !episodeMenuOpen/, 'revealControls gates timer start on playback + all open states');
assert.match(shell, /!sourceMenuOpen && !episodeMenuOpen && !focusWithinMaveroControls\(\)\) \{[^}]*controlsVisible = false/, 'timer callback re-checks open states + focus guard before hiding');
assert.match(shell, /function focusWithinMaveroControls\(\): boolean/, 'keyboard-focus a11y guard exists (focused controls are never hidden)');

// ============================================================
// 6. UPDATED (player redesign): the menu no longer exists — dedicated
//    controls close via their own handlers and either sheet close restarts
//    the countdown (section 7 below).
// ============================================================

// ============================================================
// 7. Closing sheets restarts the timer
// ============================================================
const closeSourceSheetStart = shell.indexOf('function closeSourceSheet()');
const closeSourceSheetEnd = shell.indexOf('\n  }', closeSourceSheetStart);
assert.ok(closeSourceSheetStart >= 0, 'closeSourceSheet function found');
const closeSourceSheetBlock = shell.slice(closeSourceSheetStart, closeSourceSheetEnd);
assert.match(closeSourceSheetBlock, /revealControls\(\)/, 'closeSourceSheet calls revealControls to restart timer');

const closeEpisodeSheetStart = shell.indexOf('function closeEpisodeSheet()');
const closeEpisodeSheetEnd = shell.indexOf('\n  }', closeEpisodeSheetStart);
assert.ok(closeEpisodeSheetStart >= 0, 'closeEpisodeSheet function found');
const closeEpisodeSheetBlock = shell.slice(closeEpisodeSheetStart, closeEpisodeSheetEnd);
assert.match(closeEpisodeSheetBlock, /revealControls\(\)/, 'closeEpisodeSheet calls revealControls to restart timer');

// The dedicated streams sheet was RETIRED (0111d7f); only the source and
// episode sheets remain — both covered above.

// ============================================================
// 8. Video / player itself is NOT hidden by the FAB auto-hide state
// ============================================================
// The stage-wrap (which contains PlayerViewport and the video/iframe) must
// NOT have any opacity/visibility/pointer-events mutation tied to
// controls-hidden. Only the FABs and direct-controls-overlay are affected.
const stageWrapRule = shell.match(/\.stage-wrap \{[^}]*\}/)?.[0] ?? '';
assert.ok(stageWrapRule.length > 0, '.stage-wrap CSS rule found');
assert.doesNotMatch(stageWrapRule, /opacity:/, 'stage-wrap has no opacity mutation');
assert.doesNotMatch(stageWrapRule, /visibility:/, 'stage-wrap has no visibility mutation');
assert.doesNotMatch(stageWrapRule, /pointer-events:/, 'stage-wrap has no pointer-events mutation');

// No rule anywhere in the file should select stage-wrap under controls-hidden.
assert.doesNotMatch(shell, /controls-hidden[^{]*\.stage-wrap/, 'no controls-hidden rule targets stage-wrap');
assert.doesNotMatch(shell, /controls-hidden[^{]*\.viewport/, 'no controls-hidden rule targets viewport');
assert.doesNotMatch(shell, /controls-hidden[^{]*iframe/, 'no controls-hidden rule targets iframe');
assert.doesNotMatch(shell, /controls-hidden[^{]*video/, 'no controls-hidden rule targets video element');

// The playerRoot itself must NOT be hidden by controls-hidden — only its
// descendant FABs/overlay are.
const playerShellRule = shell.match(/\.player-shell \{[^}]*\}/)?.[0] ?? '';
assert.doesNotMatch(playerShellRule, /opacity:\s*0/, 'player-shell root is never opacity:0');

// ============================================================
// 9. Component cleanup clears timers + listeners
// ============================================================
const onMountReturnIdx = onMountBlock.indexOf('return () => {');
assert.ok(onMountReturnIdx >= 0, 'onMount cleanup return found');
const cleanupBlock = onMountBlock.slice(onMountReturnIdx);
assert.match(cleanupBlock, /if \(hideTimer\) clearTimeout\(hideTimer\)/, 'cleanup clears hideTimer');
assert.match(cleanupBlock, /removeEventListener\('pointermove', showControls\)/, 'cleanup removes pointermove listener');
assert.match(cleanupBlock, /removeEventListener\('pointerdown', showControls\)/, 'cleanup removes pointerdown listener');
assert.match(cleanupBlock, /removeEventListener\('touchstart', showControls\)/, 'cleanup removes touchstart listener');
assert.match(cleanupBlock, /removeEventListener\('focusin', handleFocusIn\)/, 'cleanup removes focusin listener (player redesign)');

// ============================================================
// 10. visibility:hidden applied in the hidden CSS state (with transition delay)
// ============================================================
// Back FAB hidden state:
assert.match(shell, /\.player-shell\.controls-hidden \.back-fab \{[^}]*opacity: 0/, 'back-fab hidden state sets opacity:0');
assert.match(shell, /\.player-shell\.controls-hidden \.back-fab \{[^}]*visibility: hidden/, 'back-fab hidden state sets visibility:hidden');
assert.match(shell, /\.player-shell\.controls-hidden \.back-fab \{[^}]*pointer-events: none/, 'back-fab hidden state sets pointer-events:none');
// Transition delay on visibility so the fade-out animation is preserved:
assert.match(shell, /\.player-shell\.controls-hidden \.back-fab \{[^}]*visibility 0s linear var\(--motion-normal\)/, 'back-fab hidden state delays visibility transition to preserve fade-out');

// Control FAB group hidden state:
assert.match(shell, /\.player-shell\.controls-hidden \.control-fab-group \{[^}]*opacity: 0/, 'control-fab-group hidden state sets opacity:0');
assert.match(shell, /\.player-shell\.controls-hidden \.control-fab-group \{[^}]*visibility: hidden/, 'control-fab-group hidden state sets visibility:hidden');
assert.match(shell, /\.player-shell\.controls-hidden \.control-fab-group \{[^}]*pointer-events: none/, 'control-fab-group hidden state sets pointer-events:none');
assert.match(shell, /\.player-shell\.controls-hidden \.control-fab-group \{[^}]*visibility 0s linear var\(--motion-normal\)/, 'control-fab-group hidden state delays visibility transition to preserve fade-out');

// Player redesign: the menu state no longer exists — the group is kept
// visible while a sheet is open via the revealControls guards (asserted
// above) and while focus rests inside a Mavero control (focus guard).

// Reduced-motion respected for FAB transitions (visibility delay becomes 0):
// Extract the prefers-reduced-motion media block first, then assert on it.
const reducedMotionStart = shell.indexOf('@media (prefers-reduced-motion: reduce) {');
assert.ok(reducedMotionStart >= 0, 'prefers-reduced-motion media query present');
// Find matching closing brace of the media query (balanced scan).
let reducedMotionEnd = -1;
let rmDepth = 0;
for (let i = reducedMotionStart + '@media (prefers-reduced-motion: reduce) '.length; i < shell.length; i++) {
  const ch = shell[i];
  if (ch === '{') rmDepth++;
  else if (ch === '}') {
    rmDepth--;
    if (rmDepth === 0) { reducedMotionEnd = i + 1; break; }
  }
}
assert.ok(reducedMotionEnd > reducedMotionStart, 'prefers-reduced-motion block end found');
const reducedMotionBlock = shell.slice(reducedMotionStart, reducedMotionEnd);
assert.match(reducedMotionBlock, /\.back-fab[^{]*\{[^}]*transition: none/, 'reduced-motion disables back-fab transitions');
assert.match(reducedMotionBlock, /\.control-fab-group[^{]*\{[^}]*transition: none/, 'reduced-motion disables control-fab-group transitions');

// ============================================================
// 11. portrait ↔ landscape must NOT break the timer
// ============================================================
const toggleLandscapeStart = shell.indexOf('async function toggleLandscape()');
const toggleLandscapeEnd = shell.indexOf('async function toggleFullscreen()', toggleLandscapeStart);
assert.ok(toggleLandscapeStart >= 0 && toggleLandscapeEnd > toggleLandscapeStart, 'toggleLandscape function found');
const toggleLandscapeBlock = shell.slice(toggleLandscapeStart, toggleLandscapeEnd);
// The entering branch must NOT clear hideTimer without restarting.
// It should call revealControls() AFTER setting landscapeMode = true so the
// 10s countdown restarts cleanly.
assert.doesNotMatch(toggleLandscapeBlock, /if \(hideTimer\) clearTimeout\(hideTimer\);\s*hideTimer = undefined;/, 'toggleLandscape entering branch no longer bare-clears hideTimer (which broke the timer)');
// Verify revealControls is called in the entering branch (after landscapeMode = true):
const enteringIdx = toggleLandscapeBlock.indexOf('if (entering) {');
const enteringBlock = toggleLandscapeBlock.slice(enteringIdx, toggleLandscapeBlock.indexOf('} else {', enteringIdx));
assert.match(enteringBlock, /landscapeMode = true/, 'entering branch sets landscapeMode = true');
assert.match(enteringBlock, /revealControls\(\)/, 'entering branch calls revealControls to restart timer');

// ============================================================
// 12. No competing timer bodies — revealControls is the single source
// ============================================================
// Count occurrences of `hideTimer = setTimeout` — should be exactly ONE
// (inside revealControls).
const hideTimerSetMatches = shell.match(/hideTimer = setTimeout/g) ?? [];
assert.equal(hideTimerSetMatches.length, 1, 'exactly ONE hideTimer = setTimeout assignment (single authoritative timer)');

// Count occurrences of `controlsVisible = false` — should be exactly ONE
// (inside revealControls timer callback).
const controlsHiddenMatches = shell.match(/controlsVisible = false/g) ?? [];
assert.equal(controlsHiddenMatches.length, 1, 'exactly ONE controlsVisible = false mutation (single hide path)');

// ============================================================
// 13. Back FAB + Control FAB + Episodes preserved (regression guard)
// ============================================================
// These checks confirm the fix did NOT accidentally remove the Back FAB,
// Control Menu FAB, or the Episodes button (intentionally present for TV).
assert.match(shell, /class="back-fab"/, 'Back FAB still present');
assert.match(shell, /class="control-fab landscape-fab"/, 'Landscape control FAB still present (player redesign: menu FAB replaced by the dedicated landscape control)');
assert.match(shell, /aria-label="Open episode list"/, 'Episodes button still present (TV/series playback)');

// Source selector sheet behavior unchanged:
assert.match(shell, /function openSourceSheet\(/, 'openSourceSheet function preserved');
assert.match(shell, /function closeSourceSheet\(/, 'closeSourceSheet function preserved');

console.log('FAB auto-hide behavior tests passed: initially visible (1); 5s inactivity hides (1); interaction listeners (4); single authoritative timer (3); sheet-open + focus guards (3); sheet close restarts (2); closeSheet restarts (3); video/player NOT hidden (6); cleanup clears timers + listeners (5); visibility:hidden + transition delay (8); portrait/landscape no break (3); no competing timers (2); regressions preserved (5).');
