import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');

assert.match(shell, /class:landscape-mode=\{landscapeMode\}/);
assert.match(shell, /let landscapeControlsExpanded = true/);
assert.match(shell, /const LANDSCAPE_CONTROLS_HIDE_MS = 5000/);
// Phase 9: landscape-controls-toggle floating button removed — header now has exit + source buttons.
assert.doesNotMatch(shell, /data-landscape-controls-toggle/, 'landscape-controls-toggle removed');
assert.doesNotMatch(shell, /PanelTopClose/, 'PanelTopClose import removed');
assert.doesNotMatch(shell, /PanelTopOpen/, 'PanelTopOpen import removed');
assert.match(shell, /if \(!landscapeMode\) return/);
assert.match(shell, /\.player-shell\.landscape-mode \{ display: flex; flex-direction: column;/);
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap \{ display: flex; flex: 1 1 auto;/);
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap :global\(\.viewport\)/);
assert.match(shell, /height: 100%; max-height: none; min-height: 0; aspect-ratio: auto/);
assert.match(shell, /env\(safe-area-inset-top\)/);
// Phase 9: bottom-bar is hidden in landscape via {#if !landscapeMode} — no landscape-controls-collapsed class.
assert.doesNotMatch(shell, /landscape-controls-collapsed/, 'landscape-controls-collapsed removed');
// Phase 9: orientation-button no longer needs margin-right clearance (no floating toggle button).
assert.doesNotMatch(shell, /\.player-shell\.landscape-mode \.orientation-button[^}]*margin-right: 38px/, 'orientation-button margin-right removed (no floating toggle)');
assert.doesNotMatch(shell, /\.player-shell\.landscape-mode \.header-actions[^}]*margin-right: 38px/, 'dead .header-actions CSS selector removed');
assert.match(shell, /100svh/);

const landscapeStart = shell.indexOf('async function toggleLandscape()');
const landscapeEnd = shell.indexOf('async function toggleFullscreen()', landscapeStart);
assert(landscapeStart >= 0 && landscapeEnd > landscapeStart);
const landscapeBody = shell.slice(landscapeStart, landscapeEnd);
assert.match(landscapeBody, /requestFullscreen/);
assert.match(landscapeBody, /exitFullscreen/);
assert.match(landscapeBody, /lock\?\.\('landscape'\)/);

const fullscreenStart = shell.indexOf('async function toggleFullscreen()');
const fullscreenEnd = shell.indexOf('async function togglePictureInPicture()', fullscreenStart);
assert.match(shell.slice(fullscreenStart, fullscreenEnd), /requestFullscreen/);
assert.match(shell.slice(fullscreenStart, fullscreenEnd), /exitFullscreen/);
assert.match(shell, /provider iframe is never invoked or manipulated/);
assert.doesNotMatch(shell, /class="episode-stepper"/);
assert.doesNotMatch(shell, /aria-label="Previous episode"/);
assert.doesNotMatch(shell, /aria-label="Next episode"/);
assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/);
assert.match(viewport, /allowfullscreen/);
assert.match(viewport, /sandbox=\{sandboxAttribute\}/);

console.log('Landscape PlayerShell contract tests passed: compact active layout, flex-fill viewport, safe-area sizing, separate fullscreen action, cross-origin iframe boundary, removed landscape-controls-toggle, removed bottom-bar in landscape.');
