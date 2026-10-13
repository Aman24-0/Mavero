/**
 * MAV-FOCUSED Issue 3 (2026-10) — loading indicator position + redesign
 * regression suite.
 *
 * Confirmed root cause (verified at HEAD before this fix):
 *   - TWO competing loading indicators rendered simultaneously during
 *     the player's preparing / resolving / switching-source / embed-loading
 *     states:
 *       1. `.loading-card` in PlayerShell — pinned to `top: max(14px,
 *          env(safe-area-inset-top)); left: 50%; transform: translateX(-50%)`
 *          (TOP-CENTER, an arbitrary top offset). Carried the small dark
 *          conic-gradient `.loading-ring` (38px, --ink-soft + --accent-soft
 *          — nearly invisible against the dark surface).
 *       2. `.empty-orb` in PlayerViewport — a 72px dark ring at the
 *          CENTER of the empty viewport (rendered when no source is bound
 *          yet, which is exactly the preparing state). This was the
 *          screenshot's "oversized, dark circular spinner around the
 *          middle of the empty black area".
 *     The two indicators were visually disconnected (one at the top, one
 *     at the center) and looked broken together.
 *
 * Behaviour after the fix:
 *   - The loading-card is CENTERED in the playback viewport (stage-wrap)
 *     via `top: 50%; left: 50%; transform: translate(-50%, -50%)` —
 *     positioned relative to the ACTUAL playback viewport, not at an
 *     arbitrary top offset.
 *   - The empty-orb markup AND its CSS rule are retired — the
 *     loading-card is the SINGLE coherent loading presentation.
 *   - The spinner is redesigned as a clean Material/iOS-style ring:
 *     2.5px border, Mavero accent on the leading edge, 36px diameter,
 *     brighter than the previous conic-gradient.
 *   - z-index 7 keeps the loading card ABOVE the media surface
 *     (z-index 1) and BELOW the actionable player controls
 *     (z-index 10/12 — back/lock/subtitle/quality/fullscreen).
 *   - The bounded direct-load timeout (20s) + stale-request protections
 *     are preserved — a stuck loading state still surfaces honestly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');
/** Source with line comments stripped — assertions must never match prose. */
const readCode = (p: string) => read(p)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

const shell = readCode('src/lib/components/player/PlayerShell.svelte');
const viewport = readCode('src/lib/components/player/PlayerViewport.svelte');

console.log('\n1 — loading-card is CENTERED in the playback viewport (no arbitrary top offset)');
{
  const loadingRule = shell.slice(shell.indexOf('.loading-card { position: absolute'));
  ok(/top: 50%; left: 50%; right: auto; bottom: auto; transform: translate\(-50%, -50%\)/.test(loadingRule), '1a. the loading-card uses top: 50%; left: 50%; translate(-50%, -50%) — centered in the playback viewport');
  ok(!/top: max\(14px, env\(safe-area-inset-top\)\)/.test(loadingRule), '1b. the loading-card no longer uses the arbitrary top: max(14px, env(safe-area-inset-top)) offset');
  ok(!/transform: translateX\(-50%\)/.test(loadingRule), '1c. the loading-card no longer uses the horizontal-only translateX(-50%) transform (which produced the top-center placement)');
}

console.log('\n2 — z-index layering: above media, below actionable controls');
{
  const loadingRule = shell.slice(shell.indexOf('.loading-card { position: absolute'));
  ok(/z-index: 7;/.test(loadingRule), '2a. the loading-card z-index is 7 (above the media surface at z-index 1)');
  // Verify the actionable controls remain above the loading card.
  ok(/\.back-fab\b[\s\S]*?z-index:\s*12/.test(shell), '2b. the back-fab remains at z-index 12 (above the loading-card)');
  ok(/\.direct-controls-overlay\b[\s\S]*?z-index:\s*10/.test(shell), '2c. the controls overlay remains at z-index 10 (above the loading-card)');
  ok(/\.control-fab-group\b[\s\S]*?z-index:\s*12/.test(shell), '2d. the control-fab-group remains at z-index 12 (above the loading-card)');
  ok(/\.unlock-fab\b[\s\S]*?z-index:\s*12/.test(shell), '2e. the unlock-fab remains at z-index 12 (above the loading-card)');
  // The embed-veil stays below the loading-card.
  ok(/\.embed-veil\b[\s\S]*?z-index:\s*6/.test(shell), '2f. the embed-veil stays at z-index 6 (below the loading-card at 7)');
}

console.log('\n3 — empty-orb is retired (single coherent loading presentation)');
{
  ok(!/<span class="empty-orb"><\/span>/.test(viewport), '3a. the empty-orb markup is gone from PlayerViewport');
  ok(!/class="empty-orb"/.test(viewport), '3b. no element carries the empty-orb class anymore');
  ok(!/.empty-orb\s*{/.test(viewport), '3c. the dead .empty-orb CSS rule is removed');
  // The empty-viewport div stays (provides the subtle gradient backdrop).
  ok(/\.empty-viewport\s*{/.test(viewport), '3d. the empty-viewport div is retained (subtle gradient backdrop only)');
  ok(/<div class="empty-viewport" aria-hidden="true"><\/div>/.test(viewport), '3e. the empty-viewport div is now empty (no orb child)');
}

console.log('\n4 — spinner redesigned: clean Material/iOS-style ring with Mavero accent');
{
  const loadingRingRule = shell.slice(shell.indexOf('.loading-ring {'));
  // Border-style ring (not conic-gradient).
  ok(/border:\s*2\.5px solid rgba\(255, 255, 255, 0\.12\)/.test(loadingRingRule), '4a. the spinner uses a 2.5px solid border (clean Material/iOS style)');
  ok(!/conic-gradient/.test(loadingRingRule), '4b. the previous conic-gradient ring is GONE (was nearly invisible: --ink-soft on dark)');
  // Mavero accent on the leading edge.
  ok(/border-top-color:\s*var\(--accent/.test(loadingRingRule), '4c. the spinner leading edge uses the Mavero accent color directly (high contrast)');
  // Sensible dimensions (not oversized).
  ok(/width:\s*36px;\s*height:\s*36px;/.test(loadingRingRule), '4d. the spinner has sensible dimensions (36px — not the previous 72px empty-orb)');
  // The spin animation is reused.
  ok(/animation:\s*spin\b/.test(loadingRingRule), '4e. the spinner reuses the existing spin animation');
  // The loading-ring no longer has the inner `<span>` "hole" (the markup change).
  ok(!/<span class="loading-ring"[\s\S]*?<span><\/span><\/span>/.test(shell), '4f. the loading-ring markup no longer has the inner span (the conic-gradient "hole" is no longer needed)');
}

console.log('\n5 — loading message stays concise and visually secondary');
{
  // The loading-card markup keeps the strong + small structure (heading + subtext).
  ok(/<span class="loading-copy"><strong>/.test(shell), '5a. the loading card keeps the strong heading element');
  ok(/<span class="loading-copy">[\s\S]*?<small>/.test(shell), '5b. the loading card keeps the small subtext element (concise, visually secondary)');
  // The loading-ring comes BEFORE the loading-copy in the markup — the spinner leads.
  const ringIdx = shell.indexOf('class="loading-ring"');
  const copyIdx = shell.indexOf('class="loading-copy"');
  ok(ringIdx > -1 && copyIdx > -1 && ringIdx < copyIdx, '5c. the spinner precedes the message copy in the markup (the indicator is the primary affordance)');
}

console.log('\n6 — bounded direct-load timeout + stale-request protections preserved');
{
  ok(/const DIRECT_LOAD_TIMEOUT_MS = 20000;/.test(shell), '6a. the bounded 20s direct-load timeout is preserved');
  ok(/if \(directLoadKey !== key\) return;/.test(shell), '6b. the stale-key guard is preserved (a previous source can never error the current one)');
  ok(/\$: if \(source\?\.type === 'direct' && mediaUrl && state === 'preparing'\) startDirectLoadTimeout/.test(shell), '6c. the timer arms ONLY during a real direct-media prepare session');
  ok(/\$: if \(state !== 'preparing'\) clearDirectLoadTimeout\(\);/.test(shell), '6d. the timer disarms on ready/error/switch (no leak across state transitions)');
}

console.log('\n7 — loading-card still gates on the correct state set (no premature removal)');
{
  // The loading-card renders ONLY during preparing / resolving / switching-source / embed-loading.
  // It must NOT render during 'playing', 'paused', 'buffering' (active playback), 'error', 'completed'.
  ok(/effectiveState === 'preparing' \|\| effectiveState === 'resolving' \|\| effectiveState === 'switching-source' \|\| effectiveState === 'embed-loading'/.test(shell), '7a. the loading-card gates on the preparing/resolving/switching-source/embed-loading state set');
  ok(!/effectiveState === 'buffering'[\s\S]{0,80}loading-card/.test(shell), '7b. the loading-card does NOT render during buffering (active playback has the viewport corner note instead)');
}

console.log('\n8 — error / completion cards remain centered (unchanged semantics)');
{
  // The error and completion cards were already centered; they stay centered.
  ok(/\.message-card, \.completion-card \{ position: absolute; z-index: 7; right: 50%; bottom: 50%;/.test(shell), '8a. the message-card + completion-card keep their centered positioning');
  ok(/transform: translate\(50%, 50%\)/.test(shell), '8b. the message-card + completion-card keep their translate(50%, 50%) centering transform');
}

console.log(`\nmav_focused_issue3_loading_indicator_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
