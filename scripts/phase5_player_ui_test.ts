import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 5: Player UI redesign contract tests.
//
// These tests verify BOTH the CSS redesign AND the structural markup
// changes required by the Phase 5 plan:
// - Old pink/purple/crimson colors removed
// - Mavero design system CSS variables used
// - Embed shell controls bar exists (not gated behind direct-only)
// - Compact source sheet (not old giant drawer)
// - Compact episode sheet
// - Simplified error message
// - Loading states use plan's messages
// - Landscape contract preserved
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

// --- 3. Embed shell controls exist (NOT gated behind source?.type === 'direct') ---
assert.match(shell, /embed-shell-controls/, 'embed shell controls bar exists');
assert.match(shell, /role="toolbar"/, 'embed shell has role=toolbar');
assert.match(shell, /aria-label="Embed playback controls"/, 'embed shell has aria-label');
assert.match(shell, /shell-source-name/, 'shell shows source name');
assert.match(shell, /shell-button/, 'shell has action buttons');
assert.match(shell, /aria-label="Switch source"/, 'shell has switch source button');
assert.match(shell, /aria-label="Episode list"/, 'shell has episode button');
// The bottom-bar is NOT gated exclusively behind source?.type === 'direct'
assert.match(shell, /class="bottom-bar"/, 'bottom-bar exists');
assert.match(shell, /source\?\.type === 'embed'/, 'embed branch exists in bottom-bar');
// Direct controls still exist within bottom-bar
assert.match(shell, /source\?\.type === 'direct'/, 'direct branch exists in bottom-bar');

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

// --- 8. Landscape contract preserved ---
assert.match(shell, /class:landscape-mode=\{landscapeMode\}/, 'landscape-mode class');
// Phase 9 fix: removed landscapeControlsExpanded, LANDSCAPE_CONTROLS_HIDE_MS, data-landscape-controls-toggle.
assert.doesNotMatch(shell, /let landscapeControlsExpanded/, 'landscapeControlsExpanded removed');
assert.doesNotMatch(shell, /LANDSCAPE_CONTROLS_HIDE_MS/, 'LANDSCAPE_CONTROLS_HIDE_MS removed');
assert.doesNotMatch(shell, /data-landscape-controls-toggle/, 'data-landscape-controls-toggle removed');
// Phase 9: PanelTopClose/PanelTopOpen removed (landscape-controls-toggle button removed).
assert.doesNotMatch(shell, /PanelTopClose/, 'PanelTopClose removed');
assert.doesNotMatch(shell, /PanelTopOpen/, 'PanelTopOpen removed');
assert.match(shell, /\.player-shell\.landscape-mode \{ display: flex; flex-direction: column;/, 'landscape CSS');
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap \{ display: flex; flex: 1 1 auto;/, 'landscape stage CSS');
assert.match(shell, /height: 100%; max-height: none; min-height: 0; aspect-ratio: auto/, 'landscape viewport');
assert.match(shell, /env\(safe-area-inset-top\)/, 'safe-area-inset');
assert.match(shell, /100svh/, '100svh');
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
assert.match(shell, /aria-label="Close player"/, 'Back button');
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

// --- 15. Player-first layout structure (flex column) ---
assert.match(shell, /display: flex; flex-direction: column/, 'player-shell is flex column');
assert.match(shell, /class="bottom-bar"/, 'bottom-bar exists for all source types');

// --- 16. Loading messages with ellipsis ---
assert.match(shell, /Switching source…/, 'loading: Switching source…');
assert.match(shell, /Starting your stream…/, 'loading: Starting your stream…');
assert.match(shell, /Loading player…/, 'loading: Loading player…');

console.log('Phase 5 player UI redesign tests passed: legacy colors removed (16 checks); design system variables used (6 checks); embed shell controls bar exists with role=toolbar + source name + action buttons (8 checks); compact source sheet with handle + overlay (6 checks); episode sheet (2 checks); simplified error message "This source isn\'t available." (3 checks); loading states use plan messages (5 checks); landscape contract preserved (14 structural checks); viewport permissions preserved (3 checks); accessibility preserved (8 checks); callbacks preserved (10 checks); keyboard shortcuts preserved (3 checks); sandbox toggle preserved; cross-origin safety preserved; player-first flex column layout (2 checks).');
