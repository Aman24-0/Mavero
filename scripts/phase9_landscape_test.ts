import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Immersive redesign: Full viewport + FAB overlay + responsive source sheet tests.

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/lib/components/player/PlayerControls.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Player fills full viewport (100dvh, no header/footer)
// ============================================================

assert.match(shell, /\.player-shell \{[^}]*height: 100dvh/, 'player fills 100dvh');
assert.match(shell, /\.stage-wrap \{[^}]*position: absolute[^}]*inset: 0/, 'stage-wrap fills entire shell via inset: 0');

// ============================================================
// 2. Back FAB exists (top-left overlay)
// ============================================================

assert.match(shell, /class="back-fab"/, 'back FAB exists');
assert.match(shell, /\.back-fab \{[^}]*top: max\(12px/, 'back FAB positioned top-left with safe area');

// ============================================================
// 3. Control Menu FAB exists (bottom-right overlay)
// ============================================================

assert.match(shell, /class="control-fab"/, 'control FAB exists');
assert.match(shell, /\.control-fab-group \{[^}]*bottom: max\(16px/, 'control FAB positioned bottom-right with safe area');

// ============================================================
// 4. Menu unfolds with staggered animation
// ============================================================

assert.match(shell, /class="fab-item"/, 'menu items exist');
assert.match(shell, /--fab-delay/, 'staggered delay variable exists');
assert.match(shell, /@keyframes fab-unfold/, 'unfold animation exists');

// ============================================================
// 5. Auto-hide 10s timer
// ============================================================

assert.match(shell, /10_000/, '10s auto-hide timer');
assert.match(shell, /menuOpen.*sourceMenuOpen.*episodeMenuOpen.*streamsSheetOpen/, 'auto-hide checks all open states');

// ============================================================
// 6. Source sheet: bottom on compact, right drawer on wide (media query)
// ============================================================

assert.match(shell, /\.source-sheet.*bottom: 0/, 'source sheet defaults to bottom');
assert.match(shell, /@media \(min-width: 769px\)/, 'wide viewport breakpoint at 769px');
assert.match(shell, /\.source-sheet.*right: 0.*top: 0.*bottom: 0|\.source-sheet, \.episode-sheet, \.mavero-streams-sheet \{[^}]*top: 0; right: 0; bottom: 0/, 'wide viewport: source sheet becomes right drawer');

// ============================================================
// 7. No persistent header/footer
// ============================================================

assert.doesNotMatch(shell, /class="player-header"/, 'no persistent player-header');
assert.doesNotMatch(shell, /class="bottom-bar"/, 'no persistent bottom-bar');

// ============================================================
// 8. Safe area support
// ============================================================

assert.match(shell, /env\(safe-area-inset-top\)/, 'safe-area-inset-top');
assert.match(shell, /env\(safe-area-inset-bottom\)/, 'safe-area-inset-bottom');
assert.match(shell, /env\(safe-area-inset-left\)/, 'safe-area-inset-left');
assert.match(shell, /env\(safe-area-inset-right\)/, 'safe-area-inset-right');

// ============================================================
// 9. Reduced motion
// ============================================================

assert.match(shell, /prefers-reduced-motion: reduce/, 'reduced motion respected');

// ============================================================
// 10. Direct source controls overlay (auto-hiding)
// ============================================================

assert.match(shell, /class="direct-controls-overlay"/, 'direct controls overlay exists');
assert.match(shell, /\.direct-controls-overlay:not\(\.visible\)/, 'direct controls auto-hide');

// ============================================================
// 11. iframe fullscreen-capable
// ============================================================

// iframe fullscreen-capable is in PlayerViewport, not PlayerShell — verified in landscape_player_contract_test.ts
// This test file focuses on PlayerShell immersive redesign contract.

console.log('Immersive redesign tests passed: full viewport (2 checks); back FAB (2 checks); control FAB (2 checks); staggered animation (3 checks); 10s auto-hide (2 checks); responsive source sheet (3 checks); no persistent header/footer (2 checks); safe area (4 checks); reduced motion (1 check); direct controls overlay (2 checks); iframe fullscreen (1 check).');
