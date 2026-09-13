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

// --- 3. Immersive redesign: Back FAB + Control Menu FAB ---
assert.match(shell, /class="back-fab"/, 'back FAB exists');
assert.match(shell, /class="control-fab"/, 'control FAB exists');
assert.match(shell, /class="control-fab-group"/, 'control FAB group exists');
assert.match(shell, /class="fab-item"/, 'menu items exist');
assert.match(shell, /aria-label="Close player"/, 'back FAB aria-label');
assert.match(shell, /aria-label=\{menuOpen \? 'Close menu' : 'Open player menu'\}/, 'control FAB aria-label');
assert.match(shell, /aria-label="Switch source"/, 'source action in menu');
assert.match(shell, /aria-label="Open episode list"/, 'episode action in menu');

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

// --- 13. Sandbox toggle preserved ---
assert.match(shell, /toggleSandbox/, 'toggleSandbox preserved');

// --- 14. Cross-origin safety ---
assert.match(shell, /provider iframe is never invoked or manipulated/, 'cross-origin safety');

// --- 15. Auto-hide 10s + menu state ---
assert.match(shell, /10_000/, '10s auto-hide timer');
assert.match(shell, /menuOpen/, 'menu state exists');
assert.match(shell, /prefers-reduced-motion: reduce/, 'reduced motion respected');

// --- 16. Loading messages with ellipsis ---
assert.match(shell, /Switching source…/, 'loading: Switching source…');
assert.match(shell, /Starting your stream…/, 'loading: Starting your stream…');
assert.match(shell, /Loading player…/, 'loading: Loading player…');

console.log('Immersive player UI tests passed: legacy colors removed (16 checks); design system variables used (6 checks); Back FAB + Control Menu FAB (8 checks); compact source sheet (6 checks); episode sheet (2 checks); simplified error message (3 checks); loading states (5 checks); immersive full viewport (9 checks); viewport permissions preserved (3 checks); accessibility preserved (8 checks); callbacks preserved (10 checks); keyboard shortcuts preserved (3 checks); sandbox toggle preserved; cross-origin safety preserved; auto-hide + menu state (3 checks).');
