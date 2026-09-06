import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');

assert.match(shell, /class:landscape-mode=\{landscapeMode\}/);
assert.match(shell, /let landscapeControlsExpanded = true/);
assert.match(shell, /const LANDSCAPE_CONTROLS_HIDE_MS = 5000/);
assert.match(shell, /data-landscape-controls-toggle/);
assert.match(shell, /PanelTopClose/);
assert.match(shell, /PanelTopOpen/);
assert.match(shell, /if \(!landscapeMode\) return/);
assert.match(shell, /\.player-shell\.landscape-mode \{ display: flex; flex-direction: column;/);
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap \{ display: flex; flex: 1 1 auto;/);
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap :global\(\.viewport\)/);
assert.match(shell, /height: 100%; max-height: none; min-height: 0; aspect-ratio: auto/);
assert.match(shell, /env\(safe-area-inset-top\)/);
// Phase 5: the floating .landscape-controls-toggle button overlays the top-right
// corner of the header (32px wide at right: 8px). The orientation-button is now
// the right-edge element in the landscape header (after .header-actions was
// removed when actions moved to the bottom shell toolbar). It must clear the
// floating toggle button via margin-right: 38px, OR be otherwise offset.
// This is the real contract — the OLD test asserted an obsolete .header-actions
// selector that no longer matches any DOM element.
assert.match(shell, /\.player-shell\.landscape-mode \.orientation-button[^}]*margin-right: 38px/);
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
assert.match(shell, /aria-label="Open episode list"/);
assert.doesNotMatch(shell, /class="episode-stepper"/);
assert.doesNotMatch(shell, /aria-label="Previous episode"/);
assert.doesNotMatch(shell, /aria-label="Next episode"/);
assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/);
assert.match(viewport, /allowfullscreen/);
assert.match(viewport, /sandbox=\{sandboxAttribute\}/);

console.log('Landscape PlayerShell contract tests passed: compact active layout, flex-fill viewport, safe-area sizing, separate fullscreen action, and cross-origin iframe boundary.');
