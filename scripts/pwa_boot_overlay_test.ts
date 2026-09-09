import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — PWA Branded Launch / Boot Overlay Regression Test
//
// Verifies the PwaBootOverlay component + its wiring in +layout.svelte:
//   1. Standalone detection exists (display-mode: standalone + navigator.standalone).
//   2. Normal browser does NOT get forced into PWA boot mode (gated by
//      isPwaStandalone).
//   3. Boot UI exists (wordmark + progress bar).
//   4. Ready lifecycle removes/hides boot UI (rAF-based, no arbitrary
//      multi-second delay).
//   5. Reduced-motion support exists (static wordmark + static progress).
//   6. No history.back / pushState / popstate / goto.
//   7. No arbitrary multi-second delay as the PRIMARY lifecycle (the
//      2.5s fallback is a safety net only, not the primary signal).
//   8. No service-worker registration changes.
//   9. No navigation interference (no disableScrollHandling, no
//      beforeNavigate/afterNavigate/onNavigate).
//  10. Overlay is aria-hidden + pointer-events: none (does not block
//      interaction or screen-reader navigation).
//  11. Defensive max fallback exists (overlay can never get stuck
//      permanently).

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const overlaySource = readFileSync(new URL('../src/lib/components/PwaBootOverlay.svelte', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Standalone detection exists
// ============================================================
console.log('\n1. Standalone detection exists');

assert.match(overlaySource, /display-mode: standalone/,
  'PwaBootOverlay checks display-mode: standalone');
assert.match(overlaySource, /window\.matchMedia\('\(display-mode: standalone\)'\)\.matches/,
  'PwaBootOverlay uses matchMedia for (display-mode: standalone)');
assert.match(overlaySource, /navigator as Navigator & \{ standalone\?: boolean \}\)\.standalone/,
  'PwaBootOverlay checks navigator.standalone (iOS Safari)');
// +layout.svelte must also have the standalone check (gates the render).
assert.match(layoutSource, /display-mode: standalone/,
  '+layout.svelte checks display-mode: standalone');
assert.match(layoutSource, /navigator as Navigator & \{ standalone\?: boolean \}\)\.standalone/,
  '+layout.svelte checks navigator.standalone (iOS Safari)');
ok('Standalone detection exists in both PwaBootOverlay + +layout.svelte');

// ============================================================
// 2. Normal browser does NOT get forced into PWA boot mode
// ============================================================
console.log('\n2. Normal browser not forced into PWA boot mode');

// +layout.svelte must gate the PwaBootOverlay render on isPwaStandalone.
assert.match(layoutSource, /let isPwaStandalone = \$state\(false\)/,
  '+layout.svelte has isPwaStandalone state (default false = not shown)');
assert.match(layoutSource, /isPwaStandalone = checkStandalone\(\)/,
  '+layout.svelte sets isPwaStandalone in onMount (client-only)');
assert.match(layoutSource, /\{#if isPwaStandalone\}[\s\S]*?<PwaBootOverlay/,
  '+layout.svelte renders <PwaBootOverlay> only when isPwaStandalone is true');
ok('Normal browser loads never see the boot overlay (gated by isPwaStandalone)');

// PwaBootOverlay must also defensively bail if mounted in non-standalone.
assert.match(overlaySource, /if \(!isStandalone\(\)\) \{[\s\S]*?visible = false/,
  'PwaBootOverlay bails immediately if mounted in non-standalone mode');
ok('PwaBootOverlay has defensive non-standalone bail (visible = false)');

// ============================================================
// 3. Boot UI exists (wordmark + progress bar)
// ============================================================
console.log('\n3. Boot UI exists');

assert.match(overlaySource, /class="pwa-boot-wordmark"/,
  'wordmark container exists');
assert.match(overlaySource, /class="pwa-boot-mark"/,
  'Mavero "M" mark exists');
assert.match(overlaySource, /class="pwa-boot-text"/,
  'MAVERO text exists');
assert.match(overlaySource, />MAVERO</,
  'MAVERO wordmark text present');
assert.match(overlaySource, /class="pwa-boot-progress"/,
  'progress bar container exists');
assert.match(overlaySource, /class="pwa-boot-progress-bar"/,
  'progress bar fill exists');
ok('Boot UI: Mavero wordmark (M + MAVERO) + thin progress bar');

// ============================================================
// 4. Ready lifecycle removes/hides boot UI
// ============================================================
console.log('\n4. Ready lifecycle removes/hides boot UI');

// The primary ready signal must be requestAnimationFrame (2 frames).
assert.match(overlaySource, /requestAnimationFrame/,
  'uses requestAnimationFrame as the ready signal');
assert.match(overlaySource, /frameCount >= 2/,
  'waits for 2 animation frames (app has painted)');
// After ready, the overlay must fade out + be removed.
assert.match(overlaySource, /fading = true/,
  'sets fading = true to trigger fade-out');
assert.match(overlaySource, /visible = false/,
  'sets visible = false to remove from DOM');
// The {#if visible} gate must wrap the overlay.
assert.match(overlaySource, /\{#if visible\}[\s\S]*?<div[\s\S]*?class="pwa-boot"/,
  'overlay wrapped in {#if visible} (removed from DOM when not visible)');
ok('Ready lifecycle: 2 rAF frames → fade out → remove from DOM');

// ============================================================
// 5. Reduced-motion support exists
// ============================================================
console.log('\n5. Reduced-motion support');

assert.match(overlaySource, /@media \(prefers-reduced-motion: reduce\)/,
  'has prefers-reduced-motion media query');
assert.match(overlaySource, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pwa-boot-content \{[\s\S]*?animation: none/,
  'entrance animation disabled for reduced-motion');
assert.match(overlaySource, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pwa-boot-progress-bar \{[\s\S]*?animation: none/,
  'progress sweep disabled for reduced-motion (static bar)');
ok('Reduced-motion: static wordmark + static progress bar (no animation)');

// ============================================================
// 6. No history.back / pushState / popstate / goto
// ============================================================
console.log('\n6. No history/navigation handlers');

// Strip comments before checking (source mentions these in comments).
const overlayNoComments = overlaySource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const layoutNoComments = layoutSource.replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

assert.doesNotMatch(overlayNoComments, /popstate/,
  'PwaBootOverlay: no popstate listener');
assert.doesNotMatch(overlayNoComments, /history\.back/,
  'PwaBootOverlay: no history.back()');
assert.doesNotMatch(overlayNoComments, /history\.pushState/,
  'PwaBootOverlay: no history.pushState()');
assert.doesNotMatch(overlayNoComments, /history\.replaceState/,
  'PwaBootOverlay: no history.replaceState()');
assert.doesNotMatch(overlayNoComments, /\bgoto\(/,
  'PwaBootOverlay: no goto() call');
assert.doesNotMatch(overlayNoComments, /disableScrollHandling/,
  'PwaBootOverlay: no disableScrollHandling');
assert.doesNotMatch(overlayNoComments, /beforeNavigate|afterNavigate|onNavigate/,
  'PwaBootOverlay: no navigation lifecycle hooks');
ok('No history/navigation handlers in PwaBootOverlay');

// +layout.svelte must not have NEW navigation handlers from this change.
// (The existing snapshot + onMount online listener are unchanged — we
// only ADDED the isPwaStandalone check + PwaBootOverlay render.)
assert.doesNotMatch(layoutNoComments, /popstate/,
  '+layout.svelte: no popstate listener (unchanged)');
assert.doesNotMatch(layoutNoComments, /history\.back/,
  '+layout.svelte: no history.back() (unchanged)');
assert.doesNotMatch(layoutNoComments, /disableScrollHandling/,
  '+layout.svelte: no disableScrollHandling (unchanged)');
ok('No new navigation handlers in +layout.svelte');

// ============================================================
// 7. No arbitrary multi-second delay as the PRIMARY lifecycle
// ============================================================
console.log('\n7. No arbitrary multi-second delay as primary lifecycle');

// The PRIMARY lifecycle must be rAF-based (not setTimeout-based).
// The 2.5s fallback is a SAFETY NET only — it must be clearly marked
// as defensive + must not be the only lifecycle signal.
assert.match(overlaySource, /Defensive max fallback/,
  '2.5s fallback documented as defensive');
assert.match(overlaySource, /maxFallbackTimer = setTimeout\(finish, 2500\)/,
  '2.5s defensive fallback exists');
assert.match(overlaySource, /ONLY fires if rAF never/,
  '2.5s fallback ONLY fires if rAF never fires (safety net)');
// No other setTimeout with a multi-second delay as the primary signal.
// The only other setTimeout is the 160ms fade-out delay (acceptable).
const setTimeouts = [...overlaySource.matchAll(/setTimeout\([^,]+, (\d+)\)/g)];
for (const m of setTimeouts) {
  const ms = Number(m[1]);
  assert.ok(ms <= 2500,
    `setTimeout delay ${ms}ms is within the 2.5s defensive max (not an arbitrary long delay)`);
}
ok('Primary lifecycle is rAF (2 frames); 2.5s is a defensive safety net only');

// ============================================================
// 8. No service-worker registration changes
// ============================================================
console.log('\n8. No service-worker registration changes');

// PwaBootOverlay must NOT touch serviceWorker.
assert.doesNotMatch(overlayNoComments, /serviceWorker/,
  'PwaBootOverlay: no serviceWorker reference');
assert.doesNotMatch(overlayNoComments, /navigator\.serviceWorker/,
  'PwaBootOverlay: no navigator.serviceWorker');
// +layout.svelte must not have NEW serviceWorker registration (the
// existing SW registration lives in PwaExperience.svelte, unchanged).
assert.doesNotMatch(layoutNoComments, /navigator\.serviceWorker/,
  '+layout.svelte: no serviceWorker registration (unchanged — SW lives in PwaExperience)');
ok('No service-worker registration changes (SW stays in PwaExperience)');

// ============================================================
// 9. No navigation interference
// ============================================================
console.log('\n9. No navigation interference');

// The overlay must not interfere with SvelteKit snapshots.
// +layout.svelte's existing `export const snapshot` must be unchanged.
assert.match(layoutSource, /export const snapshot = \{/,
  '+layout.svelte snapshot preserved');
assert.match(layoutSource, /capture:[\s\S]*?window\.scrollX/,
  'snapshot.capture (scrollX) preserved');
assert.match(layoutSource, /capture:[\s\S]*?window\.scrollY/,
  'snapshot.capture (scrollY) preserved');
assert.match(layoutSource, /restore:[\s\S]*?window\.scrollTo/,
  'snapshot.restore (scrollTo) preserved');
ok('SvelteKit snapshot (scroll capture/restore) preserved in +layout.svelte');

// The overlay must not interfere with scroll restoration.
// (No disableScrollHandling, no noScroll — covered in test #6.)

// ============================================================
// 10. Overlay is aria-hidden + pointer-events: none
// ============================================================
console.log('\n10. Overlay is aria-hidden + pointer-events: none');

assert.match(overlaySource, /aria-hidden="true"/,
  'overlay has aria-hidden="true" (decorative boot UI)');
assert.match(overlaySource, /role="presentation"/,
  'overlay has role="presentation"');
assert.match(overlaySource, /pointer-events: none/,
  'overlay has pointer-events: none (never blocks interaction)');
// No focusable elements inside the overlay.
assert.doesNotMatch(overlaySource, /<button|<a\s|<input|<select|tabindex=/,
  'no focusable elements inside the overlay (screen readers skip it)');
ok('Overlay: aria-hidden + pointer-events: none + no focusable elements');

// ============================================================
// 11. Defensive max fallback exists
// ============================================================
console.log('\n11. Defensive max fallback exists');

assert.match(overlaySource, /maxFallbackTimer/,
  'maxFallbackTimer variable exists');
assert.match(overlaySource, /if \(maxFallbackTimer\) clearTimeout\(maxFallbackTimer\)/,
  'maxFallbackTimer is cleared on finish (no leak)');
// The onMount cleanup must also clear the fallback.
assert.match(overlaySource, /return \(\) => \{[\s\S]*?if \(maxFallbackTimer\) clearTimeout\(maxFallbackTimer\)/,
  'onMount cleanup clears maxFallbackTimer');
ok('Defensive 2.5s fallback exists + is cleaned up on destroy (overlay never stuck)');

// ============================================================
// 12. Visual design — premium OTT, Mavero tokens
// ============================================================
console.log('\n12. Visual design — premium OTT, Mavero tokens');

// Background must be dark (Mavero --base = #000).
assert.match(overlaySource, /background:[\s\S]*?#000000/,
  'background uses #000000 (Mavero --base)');
// Must have a subtle radial glow (premium depth, not flat).
assert.match(overlaySource, /radial-gradient/,
  'subtle radial-gradient glow for depth');
// Wordmark must use Inter font (Mavero brand language).
assert.match(overlaySource, /font-family: 'Inter'/,
  'wordmark uses Inter font (Mavero brand language)');
// Progress bar must be thin (2px).
assert.match(overlaySource, /height: 2px/,
  'progress bar is thin (2px)');
// Progress bar must be indeterminate (sweep animation).
assert.match(overlaySource, /pwa-boot-progress-sweep/,
  'progress bar has indeterminate sweep animation');
// No giant spinner.
assert.doesNotMatch(overlaySource, /border.*solid.*border-radius: 50%.*animation:.*spin|rotate\(360deg\)/,
  'no giant spinner (thin progress bar instead)');
// z-index must be high (above everything) so the overlay covers the
// full viewport during boot.
assert.match(overlaySource, /z-index: 9999/,
  'z-index: 9999 (above all app content)');
ok('Visual design: dark bg + radial glow + Inter wordmark + thin progress + no spinner');

// ============================================================
// 13. Mobile responsive
// ============================================================
console.log('\n13. Mobile responsive');

assert.match(overlaySource, /@media \(max-width: 380px\)/,
  'has small-screen media query (380px)');
assert.match(overlaySource, /@media \(max-width: 380px\)[\s\S]*?\.pwa-boot-mark \{[\s\S]*?width: 34px/,
  'wordmark mark shrinks on small screens');
assert.match(overlaySource, /@media \(max-width: 380px\)[\s\S]*?\.pwa-boot-text \{[\s\S]*?font-size: 1rem/,
  'wordmark text shrinks on small screens');
assert.match(overlaySource, /@media \(max-width: 380px\)[\s\S]*?\.pwa-boot-progress \{[\s\S]*?width: 120px/,
  'progress bar shrinks on small screens');
ok('Mobile responsive (wordmark + progress bar shrink on <380px screens)');

// ============================================================
// 14. +layout.svelte existing architecture preserved
// ============================================================
console.log('\n14. +layout.svelte existing architecture preserved');

// The bare-render regex (watch/admin/auth/detail/discover-subpages)
// must be unchanged.
assert.match(layoutSource, /page\.url\.pathname\.startsWith\('\/watch\/'\)/,
  '/watch/ bare-render preserved');
assert.match(layoutSource, /page\.url\.pathname\.startsWith\('\/admin'\)/,
  '/admin bare-render preserved');
assert.match(layoutSource, /page\.url\.pathname\.startsWith\('\/auth\/'\)/,
  '/auth/ bare-render preserved');
assert.match(layoutSource, /\^\\\/\(movie\|series\|anime\)\\\/\[\^\/\]\+/,
  'movie/series/anime detail bare-render preserved');
assert.match(layoutSource, /\^\\\/discover\\\/\(movies\|series\|anime\)\\\/\?\$/,
  'discover sub-pages bare-render preserved');
// AppShell render must be unchanged.
assert.match(layoutSource, /<AppShell currentPath=\{page\.url\.pathname\} showMobileNav=\{!page\.url\.pathname\.startsWith\('\/settings'\)\}>/,
  'AppShell render preserved');
// PwaExperience + Toast must still be mounted.
assert.match(layoutSource, /<PwaExperience \/>/,
  'PwaExperience still mounted');
assert.match(layoutSource, /<Toast \/>/,
  'Toast still mounted');
// The existing onMount (syncAuthenticatedState + online listener) must
// be preserved.
assert.match(layoutSource, /void syncAuthenticatedState\(\)/,
  'syncAuthenticatedState preserved');
assert.match(layoutSource, /window\.addEventListener\('online', retry\)/,
  'online listener preserved');
ok('+layout.svelte: bare-render regex + AppShell + PwaExperience + Toast + onMount all preserved');

console.log(`\nPWA boot overlay tests passed (${passed} check groups).`);
