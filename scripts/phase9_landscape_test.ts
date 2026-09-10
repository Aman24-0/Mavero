import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 9: Landscape fullscreen + source drawer + single fullscreen button tests.

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/lib/components/player/PlayerControls.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Landscape player fills viewport (no wasted space)
// ============================================================

assert.match(shell, /\.player-shell\.landscape-mode \{ display: flex; flex-direction: column; height: 100dvh/, 'landscape fills 100dvh');
assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap \{[\s\S]*?width: 100%; height: 100%/, 'stage-wrap fills 100% width+height');

// Phase 9 fix: landscape uses .landscape-controls-overlay (not .player-header).
assert.match(shell, /class="landscape-controls-overlay"/, 'landscape controls overlay exists');
assert.match(shell, /class="landscape-overlay-button"/, 'landscape overlay buttons exist');

// Phase 9: bottom-bar is completely hidden in landscape (not rendered in DOM).
assert.match(shell, /\{#if !landscapeMode\}/, 'bottom-bar gated on !landscapeMode');

// ============================================================
// 2. Landscape source drawer opens from RIGHT
// ============================================================

assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[\s\S]*?right: 0/, 'landscape source sheet opens from right');
assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[\s\S]*?left: auto/, 'landscape source sheet does not use left: 0');
assert.match(shell, /width: min\(320px, 30vw\)/, 'landscape source sheet width ~320px/30vw');

// ============================================================
// 3. Landscape episode sheet also opens from right
// ============================================================

assert.match(shell, /\.player-shell\.landscape-mode \.episode-sheet \{[\s\S]*?right: 0/, 'landscape episode sheet opens from right');
assert.match(shell, /width: min\(340px, 32vw\)/, 'landscape episode sheet width ~340px/32vw');

// ============================================================
// 4. Landscape backdrop does NOT fully obscure player
// ============================================================

assert.match(shell, /\.player-shell\.landscape-mode \.sheet-overlay \{[\s\S]*?rgba\(0,0,0,\.35\)/, 'landscape overlay is semi-transparent (player visible)');

// ============================================================
// 5. Landscape slide-right animation + reduced motion
// ============================================================

assert.match(shell, /@keyframes slide-right/, 'slide-right animation exists');
assert.match(shell, /prefers-reduced-motion: reduce[\s\S]*?player-shell\.landscape-mode \.source-sheet[\s\S]*?animation: none/, 'reduced motion disables slide-right');

// ============================================================
// 6. Only ONE fullscreen control
// ============================================================

// PlayerControls must NOT have a fullscreen button
assert.doesNotMatch(controls, /aria-label=\{fullscreen \? 'Exit fullscreen' : 'Enter fullscreen'\}/, 'PlayerControls has NO fullscreen button');
assert.doesNotMatch(controls, /export let onFullscreen/, 'PlayerControls has no onFullscreen prop');
assert.doesNotMatch(controls, /Minimize|Maximize/, 'PlayerControls has no Minimize/Maximize icon imports');

// PlayerShell header has the orientation/fullscreen toggle button
assert.match(shell, /aria-label=\{landscapeMode \? 'Exit landscape player' : 'Toggle landscape player'\}/, 'PlayerShell header has the fullscreen/orientation toggle');

// ============================================================
// 7. Portrait source sheet remains bottom sheet
// ============================================================

// Phase 9 fix (drawer positioning): portrait bottom-sheet rule MUST be
// scoped to :not(.landscape-mode) so it never leaks into landscape mode
// (where it would conflict with the right-edge drawer rule).
assert.match(shell, /\.player-shell:not\(\.landscape-mode\) \.source-sheet, \.player-shell:not\(\.landscape-mode\) \.episode-sheet, \.player-shell:not\(\.landscape-mode\) \.mavero-streams-sheet \{ position: fixed; z-index: 21; bottom: 0; left: 0; right: 0/, 'portrait source sheet is bottom-anchored AND scoped to non-landscape (Phase 9: streams sheet shares the contract)');
assert.match(shell, /\.player-shell:not\(\.landscape-mode\) \.source-sheet, \.player-shell:not\(\.landscape-mode\) \.episode-sheet, \.player-shell:not\(\.landscape-mode\) \.mavero-streams-sheet \{[\s\S]*?max-height: 60dvh/, 'portrait sheet has max-height AND is scoped to non-landscape');

// ============================================================
// 8. iframe remains fullscreen-capable
// ============================================================

const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');
assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/, 'iframe allow preserved');
assert.match(viewport, /allowfullscreen/, 'allowfullscreen preserved');

// ============================================================
// 9. Landscape iframe fills viewport
// ============================================================

assert.match(shell, /\.player-shell\.landscape-mode \.stage-wrap :global\(\.viewport iframe\)[\s\S]*?width: 100%; height: 100%/, 'landscape iframe fills 100% width+height');

console.log('Phase 9 landscape + fullscreen tests passed: landscape fills viewport (4 checks); source drawer from right (2 checks); episode drawer from right (2 checks); backdrop semi-transparent (1 check); slide-right animation + reduced motion (2 checks); single fullscreen button (4 checks); portrait bottom sheet preserved (2 checks); iframe fullscreen-capable (2 checks); landscape iframe fills viewport (1 check).');
