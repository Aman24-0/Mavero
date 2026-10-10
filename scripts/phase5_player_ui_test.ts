import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Immersive redesign: Player UI contract tests.
//
// These tests verify the immersive player redesign:
// - Old pink/purple/crimson colors removed
// - Mavero design system CSS variables used
// - Back FAB + Control Menu FAB exist (replacing embed shell controls)
// - Compact source sheet (bottom on compact, right on wide)
// - Compact episode sheet
// - Simplified error message
// - Loading states use plan's messages
// - Immersive full viewport
// - Accessibility preserved
// - All callbacks preserved

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/lib/components/player/PlayerControls.svelte', import.meta.url), 'utf8');
const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');

// --- 1. Legacy colors removed ---
assert.doesNotMatch(shell, /rgba\(255,\s*62,\s*94/, 'no crimson');
assert.doesNotMatch(shell, /rgba\(255,\s*56,\s*96/, 'no pink');
assert.doesNotMatch(shell, /rgba\(123,\s*92,\s*250/, 'no violet');
assert.doesNotMatch(shell, /#cabefd/, 'no #cabefd');
assert.doesNotMatch(shell, /#c3b5fc/, 'no #c3b5fc');
assert.doesNotMatch(shell, /#07070c/, 'no old #07070c');
assert.doesNotMatch(shell, /#0e0e16/, 'no old #0e0e16');
assert.doesNotMatch(shell, /rgba\(12,\s*11,\s*18/, 'no old bg');
assert.doesNotMatch(shell, /rgba\(4,\s*4,\s*6/, 'no old bg');
assert.doesNotMatch(shell, /rgba\(13,\s*12,\s*19/, 'no old bg');
assert.doesNotMatch(controls, /rgba\(155,\s*135,\s*245/, 'no purple in controls');
assert.doesNotMatch(controls, /rgba\(255,\s*56,\s*96/, 'no pink in controls');
assert.doesNotMatch(controls, /rgba\(194,\s*181,\s*255/, 'no light purple in controls');
assert.doesNotMatch(viewport, /#07070c/, 'no old bg in viewport');
assert.doesNotMatch(viewport, /rgba\(155,\s*135,\s*245/, 'no purple in viewport');

// --- 2. Mavero design system variables used ---
assert.match(shell, /var\(--base\)/, 'uses var(--base)');
assert.match(shell, /var\(--ink\)/, 'uses var(--ink)');
assert.match(shell, /var\(--line\)/, 'uses var(--line)');
assert.match(shell, /var\(--accent-soft\)/, 'uses var(--accent-soft)');
assert.match(shell, /var\(--radius/, 'uses var(--radius-*)');
assert.match(controls, /var\(--accent\)/, 'controls uses var(--accent)');
assert.match(viewport, /var\(--base\)/, 'viewport uses var(--base)');

// --- 3. Player redesign: Back FAB + dedicated bottom-right controls + source chip ---
// UPDATED (MAVERO player redesign): the menu FAB was replaced by a dedicated
// bottom-right Landscape/Fullscreen FAB (class="control-fab landscape-fab"),
// an Episodes pill (class="fab-item" preserved) and a right-edge source chip
// (class="source-chip"). The user-facing Sandbox toggle was REMOVED.
assert.match(shell, /class="back-fab"/, 'back FAB exists');
assert.match(shell, /class="control-fab landscape-fab"/, 'landscape/fullscreen FAB exists (dedicated bottom-right control)');
assert.match(shell, /class="control-fab-group"/, 'control FAB group exists');
assert.match(shell, /class="fab-item"/, 'episodes pill exists');
assert.match(shell, /class="source-chip"/, 'right-edge source chip exists');
assert.match(shell, /aria-label="Close player"/, 'back FAB aria-label');
assert.match(shell, /aria-label=\{landscapeMode \? 'Exit landscape player' : 'Enter landscape player'\}/, 'landscape FAB aria-label (distinct orientation states)');
assert.match(shell, /aria-label="Choose source"/, 'source chip aria-label');
assert.match(shell, /aria-haspopup="dialog"/, 'sheet-opening controls declare aria-haspopup');
assert.match(shell, /aria-label="Open episode list"/, 'episode action exists');
assert.doesNotMatch(shell, /Sandbox \{/, 'user-facing Sandbox toggle removed');

// --- 4. Compact source sheet (not old drawer) ---
assert.match(shell, /source-sheet/, 'source sheet exists');
assert.match(shell, /sheet-overlay/, 'sheet overlay exists');
assert.match(shell, /sheet-handle/, 'sheet handle exists');
assert.match(shell, /sheet-list/, 'sheet list exists');
assert.match(shell, /sheet-option/, 'sheet option exists');
assert.doesNotMatch(shell, /class="drawer source-drawer"/, 'old source-drawer removed');

// --- 5. Episode sheet ---
assert.match(shell, /episode-sheet/, 'episode sheet exists');
assert.doesNotMatch(shell, /class="drawer episode-drawer"/, 'old episode-drawer removed');

// --- 6. Simplified error message ---
assert.match(shell, /This source isn't available\./, 'simplified error message');
assert.doesNotMatch(shell, /Provider unavailable/, 'old verbose error removed');
assert.doesNotMatch(shell, /Server unavailable/, 'old verbose error removed');

// --- 7. Loading states use plan messages ---
assert.match(shell, /Starting your stream/, 'loading: Starting your stream');
assert.match(shell, /Loading player/, 'loading: Loading player');
assert.match(shell, /Switching source/, 'loading: Switching source');

// --- 8. Immersive full viewport ---
assert.match(shell, /class:landscape-mode=\{landscapeMode\}/, 'landscape-mode class');
assert.match(shell, /height: 100dvh/, '100dvh height');
assert.match(shell, /\.stage-wrap \{[^}]*position: absolute/, 'stage absolute (fills shell)');
assert.match(shell, /\.stage-wrap \{[^}]*inset: 0/, 'stage inset: 0');
assert.doesNotMatch(shell, /class="player-header"/, 'no persistent header');
assert.doesNotMatch(shell, /class="bottom-bar"/, 'no persistent bottom-bar');
assert.doesNotMatch(shell, /class="embed-shell-controls"/, 'no old embed shell controls');
assert.match(shell, /env\(safe-area-inset-top\)/, 'safe-area-inset');
assert.match(shell, /100dvh/, '100dvh');

const landscapeStart = shell.indexOf('async function toggleLandscape()');
const landscapeEnd = shell.indexOf('async function toggleFullscreen()', landscapeStart);
assert(landscapeStart >= 0 && landscapeEnd > landscapeStart);
const landscapeBody = shell.slice(landscapeStart, landscapeEnd);
assert.match(landscapeBody, /requestFullscreen/, 'toggleLandscape: requestFullscreen');
assert.match(landscapeBody, /exitFullscreen/, 'toggleLandscape: exitFullscreen');
assert.match(landscapeBody, /lock\?\.\('landscape'\)/, 'toggleLandscape: lock');

// --- 9. Viewport permissions preserved ---
assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/, 'iframe allow');
assert.match(viewport, /allowfullscreen/, 'allowfullscreen');
assert.match(viewport, /sandbox=\{sandboxAttribute\}/, 'sandbox');

// --- 10. Accessibility preserved ---
assert.match(shell, /role="application"/, 'role=application');
assert.match(shell, /aria-label="MAVERO video player"/, 'aria-label');
assert.match(shell, /aria-label="Close player"/, 'Back FAB aria-label');
assert.match(shell, /role="alert"/, 'error role=alert');
assert.match(shell, /role="status"/, 'loading/completion role=status');
assert.match(controls, /aria-label="Seek playback"/, 'timeline aria-label');
assert.match(controls, /aria-label="Volume"/, 'volume aria-label');
assert.match(controls, /aria-label=\{playing \? 'Pause' : 'Play'\}/, 'play/pause aria-label');

// --- 11. Callbacks preserved ---
assert.match(shell, /chooseSource/, 'chooseSource preserved');
assert.match(shell, /chooseAdjacentSource/, 'chooseAdjacentSource preserved');
assert.match(shell, /chooseEpisode/, 'chooseEpisode preserved');
assert.match(shell, /onProgress/, 'onProgress preserved');
assert.match(shell, /onSourceChange/, 'onSourceChange preserved');
assert.match(shell, /onEpisodeChange/, 'onEpisodeChange preserved');
assert.match(shell, /onClose/, 'onClose preserved');
assert.match(shell, /onDetails/, 'onDetails preserved');
assert.match(shell, /onIframeReady/, 'onIframeReady preserved');
assert.match(shell, /bind:iframeElement/, 'iframeElement binding preserved');

// --- 12. Keyboard shortcuts preserved ---
assert.match(shell, /event\.key === ' ' \|\| event\.key\.toLowerCase\(\) === 'k'/, 'space/K shortcut');
assert.match(shell, /ArrowLeft/, 'ArrowLeft shortcut');
assert.match(shell, /ArrowRight/, 'ArrowRight shortcut');
// UPDATED (MAVERO player redesign): F (fullscreen), S (source sheet) and
// Escape (sheet → Mavero fullscreen exit → browser default) are available for
// ALL source types; key-repeat is ignored for the toggles; typing in
// input/textarea/select/contenteditable is never intercepted.
assert.match(shell, /event\.key === 'f' \|\| event\.key === 'F'/, 'F shortcut toggles Mavero fullscreen (all sources)');
assert.match(shell, /event\.key === 's' \|\| event\.key === 'S'/, 'S shortcut opens the source sheet (all sources)');
assert.match(shell, /if \(event\.repeat\) return/, 'key-repeat guard for the F/S toggles');
assert.match(shell, /event\.key === 'Escape'/, 'Escape exits Mavero fullscreen after sheets');
assert.match(shell, /target\?\.matches\('input, select, textarea, \[contenteditable="true"\]'\)/, 'typing guard preserved (input/textarea/select/contenteditable)');
assert.match(shell, /void exitMaveroFullscreen\(\)/, 'Escape exits the MAVERO-owned fullscreen');

// --- 13. Sandbox policy pipeline preserved, user-facing toggle removed ---
// UPDATED (MAVERO player redesign): the visible Sandbox ON/OFF control is
// gone. The SECURITY policy is untouched — the server-resolved effective
// policy still drives the iframe sandbox attribute (PlayerViewport), the
// Admin provider form remains the single configuration point, and no
// client-side override path exists anymore.
assert.doesNotMatch(shell, /toggleSandbox/, 'client-side sandbox toggle removed');
assert.match(viewport, /iframeSandboxAttribute\(effectiveSandbox\)/, 'sandbox attribute still rendered from the effective policy');
assert.match(viewport, /sandboxPolicy \?\? \(sandboxEnabled \? 'required' : 'unrestricted'\)/, 'viewport policy fallback chain preserved');

// --- 14. Cross-origin safety ---
assert.match(shell, /provider iframe is never invoked or manipulated/, 'cross-origin safety');

// --- 15. Auto-hide 5s + sheet-open state ---
// UPDATED (MAVERO player redesign): the inactivity auto-hide is FIVE seconds
// (was 10s) and the removed menu state is replaced by the sheet-open guards
// plus the keyboard-focus a11y guard (focused controls are never hidden).
assert.match(shell, /5_000/, '5s auto-hide timer');
assert.doesNotMatch(shell, /10_000/, 'old 10s timer removed');
assert.match(shell, /sourceMenuOpen && !episodeMenuOpen/, 'sheet-open state guards auto-hide');
assert.match(shell, /focusWithinMaveroControls\(\)/, 'keyboard focus guard: focused controls are never hidden');
assert.match(shell, /prefers-reduced-motion: reduce/, 'reduced motion respected');

// --- 16. Loading messages with ellipsis ---
assert.match(shell, /Switching source…/, 'loading: Switching source…');
assert.match(shell, /Starting your stream…/, 'loading: Starting your stream…');
assert.match(shell, /Loading player…/, 'loading: Loading player…');

console.log('Immersive player UI tests passed: legacy colors removed (16 checks); design system variables used (6 checks); Back FAB + dedicated landscape FAB + source chip (10 checks); compact source sheet (6 checks); episode sheet (2 checks); simplified error message (3 checks); loading states (5 checks); immersive full viewport (9 checks); viewport permissions preserved (3 checks); accessibility preserved (8 checks); callbacks preserved (10 checks); keyboard shortcuts incl. F/S/Escape (11 checks); sandbox toggle removed + policy pipeline preserved; cross-origin safety preserved; auto-hide 5s + focus guard (5 checks).');
