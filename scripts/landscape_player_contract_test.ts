import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');

// Immersive redesign contract tests.
// The player shell now occupies the full viewport with overlay FABs.

assert.match(shell, /class:landscape-mode=\{landscapeMode\}/);
// Immersive redesign: player-shell fills 100dvh (no header/footer consuming space).
assert.match(shell, /\.player-shell \{[^}]*height: 100dvh/);
assert.match(shell, /\.player-shell \{[^}]*overflow: hidden/);
// Stage fills the entire shell.
assert.match(shell, /\.stage-wrap \{[^}]*position: absolute/);
assert.match(shell, /\.stage-wrap \{[^}]*inset: 0/);
// Back FAB exists (top-left overlay).
assert.match(shell, /class="back-fab"/);
assert.match(shell, /\.back-fab \{[^}]*position: absolute/);
assert.match(shell, /\.back-fab \{[^}]*top: max\(12px, env\(safe-area-inset-top\)\)/);
assert.match(shell, /\.back-fab \{[^}]*left: max\(12px, env\(safe-area-inset-left\)\)/);
// Control menu FAB exists (bottom-right overlay).
assert.match(shell, /class="control-fab"/);
assert.match(shell, /class="control-fab-group"/);
assert.match(shell, /\.control-fab-group \{[^}]*bottom: max\(16px, env\(safe-area-inset-bottom\)\)/);
assert.match(shell, /\.control-fab-group \{[^}]*right: max\(16px, env\(safe-area-inset-right\)\)/);
// Menu items with staggered animation.
assert.match(shell, /class="fab-item"/);
assert.match(shell, /--fab-delay/);
assert.match(shell, /@keyframes fab-unfold/);
// Auto-hide: 10s timer.
assert.match(shell, /10_000/);
// Menu open state prevents auto-hide.
assert.match(shell, /menuOpen/);
// Source sheet: bottom sheet on compact, right drawer on wide (media query, NOT landscapeMode).
assert.match(shell, /\.source-sheet.*bottom: 0/);
assert.match(shell, /@media \(min-width: 769px\)/);
assert.match(shell, /\.source-sheet.*right: 0/);
// No persistent header/footer.
assert.doesNotMatch(shell, /class="player-header"/, 'no persistent player-header');
assert.doesNotMatch(shell, /class="bottom-bar"/, 'no persistent bottom-bar');
assert.doesNotMatch(shell, /class="landscape-controls-overlay"/, 'no landscape controls overlay');
assert.doesNotMatch(shell, /class="embed-shell-controls"/, 'no embed shell controls');
// Safe area support.
assert.match(shell, /env\(safe-area-inset-top\)/);
assert.match(shell, /env\(safe-area-inset-bottom\)/);
assert.match(shell, /env\(safe-area-inset-left\)/);
assert.match(shell, /env\(safe-area-inset-right\)/);
// 100dvh viewport.
assert.match(shell, /100dvh/);
// Reduced motion.
assert.match(shell, /prefers-reduced-motion: reduce/);
// Viewport permissions preserved.
assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/);
assert.match(viewport, /allowfullscreen/);
assert.match(viewport, /sandbox=\{sandboxAttribute\}/);

console.log('Immersive PlayerShell contract tests passed: full viewport, Back FAB, Control Menu FAB, staggered animation, 10s auto-hide, responsive source sheet (bottom/right), safe-area, reduced-motion.');
