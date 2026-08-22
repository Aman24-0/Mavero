import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');

assert.match(shell, /class:landscape-mode=\{landscapeMode\}/);
assert.match(shell, /\.player-shell\.landscape-mode \{ display: flex; flex-direction: column;/);
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap \{ display: flex; flex: 1 1 auto;/);
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap :global\(\.viewport\)/);
assert.match(shell, /height: 100%; max-height: none; min-height: 0; aspect-ratio: auto/);
assert.match(shell, /env\(safe-area-inset-top\)/);
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
assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture"/);
assert.match(viewport, /sandbox=\{sandboxAttribute\}/);

console.log('Landscape PlayerShell contract tests passed: compact active layout, flex-fill viewport, safe-area sizing, separate fullscreen action, and cross-origin iframe boundary.');
