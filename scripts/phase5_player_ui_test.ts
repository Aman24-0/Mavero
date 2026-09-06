import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 5: Player UI redesign contract tests.
//
// These tests verify that the player UI has been redesigned to use the
// Mavero neutral monochrome design system (no old pink/purple/crimson
// colors) while preserving the landscape contract and all functional
// behavior.

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/lib/components/player/PlayerControls.svelte', import.meta.url), 'utf8');
const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');

// --- 1. No old pink/crimson/purple colors in PlayerShell ---

// Check for specific hardcoded RGB values that were the old design system.
// rgba(255, 62, 94, ...) = crimson
// rgba(255, 56, 96, ...) = pink
// rgba(255, 88, 120, ...) = light pink
// rgba(123, 92, 250, ...) = violet
// #cabefd = light purple
// #c3b5fc = light purple
// #9b87f5 = purple
assert.doesNotMatch(shell, /rgba\(255,\s*62,\s*94/, 'PlayerShell: no crimson rgba(255, 62, 94)');
assert.doesNotMatch(shell, /rgba\(255,\s*56,\s*96/, 'PlayerShell: no pink rgba(255, 56, 96)');
assert.doesNotMatch(shell, /rgba\(255,\s*88,\s*120/, 'PlayerShell: no light pink rgba(255, 88, 120)');
assert.doesNotMatch(shell, /rgba\(123,\s*92,\s*250/, 'PlayerShell: no violet rgba(123, 92, 250)');
assert.doesNotMatch(shell, /#cabefd/, 'PlayerShell: no #cabefd');
assert.doesNotMatch(shell, /#c3b5fc/, 'PlayerShell: no #c3b5fc');
assert.doesNotMatch(shell, /#9b87f5/, 'PlayerShell: no #9b87f5');
// Also check the old dark backgrounds
assert.doesNotMatch(shell, /#07070c/, 'PlayerShell: no old #07070c background');
assert.doesNotMatch(shell, /#0e0e16/, 'PlayerShell: no old #0e0e16 background');
assert.doesNotMatch(shell, /rgba\(12,\s*11,\s*18/, 'PlayerShell: no old rgba(12, 11, 18) background');
assert.doesNotMatch(shell, /rgba\(4,\s*4,\s*6/, 'PlayerShell: no old rgba(4, 4, 6) background');
assert.doesNotMatch(shell, /rgba\(13,\s*12,\s*19/, 'PlayerShell: no old rgba(13, 12, 19) background');

// --- 2. No old pink/crimson/purple colors in PlayerControls ---

assert.doesNotMatch(controls, /rgba\(155,\s*135,\s*245/, 'PlayerControls: no purple rgba(155, 135, 245)');
assert.doesNotMatch(controls, /rgba\(255,\s*56,\s*96/, 'PlayerControls: no pink rgba(255, 56, 96)');
assert.doesNotMatch(controls, /rgba\(194,\s*181,\s*255/, 'PlayerControls: no light purple rgba(194, 181, 255)');
assert.doesNotMatch(controls, /rgba\(33,\s*27,\s*52/, 'PlayerControls: no dark purple rgba(33, 27, 52)');

// --- 3. No old pink/purple colors in PlayerViewport ---

assert.doesNotMatch(viewport, /#07070c/, 'PlayerViewport: no old #07070c');
assert.doesNotMatch(viewport, /rgba\(155,\s*135,\s*245/, 'PlayerViewport: no purple');
assert.doesNotMatch(viewport, /rgba\(194,\s*181,\s*255/, 'PlayerViewport: no light purple');
assert.doesNotMatch(viewport, /#101018/, 'PlayerViewport: no old #101018');

// --- 4. Mavero design system variables are used ---

assert.match(shell, /var\(--base\)/, 'PlayerShell: uses var(--base)');
assert.match(shell, /var\(--ink\)/, 'PlayerShell: uses var(--ink)');
assert.match(shell, /var\(--line\)/, 'PlayerShell: uses var(--line)');
assert.match(shell, /var\(--accent-soft\)/, 'PlayerShell: uses var(--accent-soft)');
assert.match(shell, /var\(--shadow-lg\)/, 'PlayerShell: uses var(--shadow-lg)');
assert.match(shell, /var\(--radius/, 'PlayerShell: uses var(--radius-*)');

assert.match(controls, /var\(--ink-soft\)/, 'PlayerControls: uses var(--ink-soft)');
assert.match(controls, /var\(--accent\)/, 'PlayerControls: uses var(--accent)');
assert.match(controls, /var\(--accent-strong\)/, 'PlayerControls: uses var(--accent-strong)');
assert.match(controls, /var\(--line-strong\)/, 'PlayerControls: uses var(--line-strong)');

assert.match(viewport, /var\(--base\)/, 'PlayerViewport: uses var(--base)');
assert.match(viewport, /var\(--surface\)/, 'PlayerViewport: uses var(--surface)');
assert.match(viewport, /var\(--line-strong\)/, 'PlayerViewport: uses var(--line-strong)');
assert.match(viewport, /var\(--muted\)/, 'PlayerViewport: uses var(--muted)');

// --- 5. Landscape contract preserved ---

assert.match(shell, /class:landscape-mode=\{landscapeMode\}/, 'landscape-mode class preserved');
assert.match(shell, /let landscapeControlsExpanded = true/, 'landscapeControlsExpanded preserved');
assert.match(shell, /const LANDSCAPE_CONTROLS_HIDE_MS = 5000/, 'LANDSCAPE_CONTROLS_HIDE_MS preserved');
assert.match(shell, /data-landscape-controls-toggle/, 'data-landscape-controls-toggle preserved');
assert.match(shell, /PanelTopClose/, 'PanelTopClose icon preserved');
assert.match(shell, /PanelTopOpen/, 'PanelTopOpen icon preserved');
assert.match(shell, /\.player-shell\.landscape-mode \{ display: flex; flex-direction: column;/, 'landscape-mode CSS preserved');
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap \{ display: flex; flex: 1 1 auto;/, 'landscape-mode stage-wrap CSS preserved');
assert.match(shell, /height: 100%; max-height: none; min-height: 0; aspect-ratio: auto/, 'landscape viewport sizing preserved');
assert.match(shell, /env\(safe-area-inset-top\)/, 'safe-area-inset preserved');
assert.match(shell, /100svh/, '100svh preserved');

const landscapeStart = shell.indexOf('async function toggleLandscape()');
const landscapeEnd = shell.indexOf('async function toggleFullscreen()', landscapeStart);
assert(landscapeStart >= 0 && landscapeEnd > landscapeStart);
const landscapeBody = shell.slice(landscapeStart, landscapeEnd);
assert.match(landscapeBody, /requestFullscreen/, 'toggleLandscape calls requestFullscreen');
assert.match(landscapeBody, /exitFullscreen/, 'toggleLandscape calls exitFullscreen');
assert.match(landscapeBody, /lock\?\.\('landscape'\)/, 'toggleLandscape calls orientation lock');

// --- 6. Player viewport permissions preserved ---

assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/, 'viewport iframe allow preserved');
assert.match(viewport, /allowfullscreen/, 'viewport allowfullscreen preserved');
assert.match(viewport, /sandbox=\{sandboxAttribute\}/, 'viewport sandbox preserved');

// --- 7. Direct source controls gating preserved ---

assert.match(shell, /source\?\.type === 'direct'/, 'direct source controls gating preserved');
assert.match(shell, /PlayerControls/, 'PlayerControls import preserved');

// --- 8. Accessibility preserved ---

assert.match(shell, /role="application"/, 'role=application preserved');
assert.match(shell, /aria-label="MAVERO video player"/, 'aria-label preserved');
assert.match(shell, /aria-label="Close player"/, 'Back button aria-label preserved');
assert.match(shell, /aria-label="Open episode list"/, 'Episodes button aria-label preserved');
assert.match(shell, /aria-label="Open source list"/, 'Sources button aria-label preserved');
assert.match(shell, /role="alert"/, 'error card role=alert preserved');
assert.match(shell, /role="status"/, 'loading/completion card role=status preserved');
assert.match(controls, /aria-label="Seek playback"/, 'timeline aria-label preserved');
assert.match(controls, /aria-label="Volume"/, 'volume aria-label preserved');
assert.match(controls, /aria-label=\{playing \? 'Pause' : 'Play'\}/, 'play/pause aria-label preserved');

// --- 9. Source/episode drawers preserved ---

assert.match(shell, /class="drawer source-drawer"/, 'source drawer preserved');
assert.match(shell, /class="drawer episode-drawer"/, 'episode drawer preserved');
assert.match(shell, /chooseSource/, 'chooseSource function preserved');
assert.match(shell, /chooseAdjacentSource/, 'chooseAdjacentSource function preserved');
assert.match(shell, /chooseEpisode/, 'chooseEpisode function preserved');

// --- 10. Loading/error states preserved ---

assert.match(shell, /message-card/, 'error card preserved');
assert.match(shell, /loading-card/, 'loading card preserved');
assert.match(shell, /completion-card/, 'completion card preserved');
assert.match(shell, /retry/, 'retry function preserved');
assert.match(shell, /Switching server|Switching source/, 'switching message preserved');
assert.match(shell, /Starting your stream|Loading player/, 'loading messages preserved');

// --- 11. Keyboard shortcuts preserved ---

assert.match(shell, /event\.key === ' ' \|\| event\.key\.toLowerCase\(\) === 'k'/, 'space/K keyboard shortcut preserved');
assert.match(shell, /ArrowLeft/, 'ArrowLeft keyboard shortcut preserved');
assert.match(shell, /ArrowRight/, 'ArrowRight keyboard shortcut preserved');

// --- 12. Sandbox toggle preserved ---

assert.match(shell, /toggleSandbox/, 'sandbox toggle function preserved');
assert.match(shell, /sandbox-button/, 'sandbox button class preserved');

// --- 13. Iframe ready callback preserved ---

assert.match(shell, /onIframeReady/, 'onIframeReady callback preserved');
assert.match(shell, /bind:iframeElement/, 'iframeElement binding preserved');

// --- 14. Provider iframe is never invoked or manipulated ---

assert.match(shell, /provider iframe is never invoked or manipulated/, 'cross-origin safety comment preserved');

// --- 15. No episode stepper (not part of current architecture) ---

assert.doesNotMatch(shell, /class="episode-stepper"/, 'no episode stepper class');
assert.doesNotMatch(shell, /aria-label="Previous episode"/, 'no previous episode button');
assert.doesNotMatch(shell, /aria-label="Next episode"/, 'no next episode button');

console.log('Phase 5 player UI redesign tests passed: old pink/purple/crimson colors removed from PlayerShell (12 checks), PlayerControls (4 checks), PlayerViewport (4 checks); Mavero design system CSS variables used (10 checks); landscape contract preserved (14 structural checks); iframe permissions preserved (3 checks); direct source controls gating preserved; accessibility preserved (10 ARIA checks); source/episode drawers preserved (5 checks); loading/error states preserved (5 checks); keyboard shortcuts preserved (3 checks); sandbox toggle preserved; iframe ready callback preserved; cross-origin safety comment preserved; no episode stepper.');
