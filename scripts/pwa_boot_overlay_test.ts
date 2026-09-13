import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — PWA Branded Boot / Launch Overlay Regression Test
//
// Verifies the FIXED PwaBootOverlay component + its wiring in
// +layout.svelte. The fix addresses two root causes from the previous
// version:
//   1. The overlay was gated behind standalone detection — normal
//      browser tabs never saw it. Now it renders unconditionally.
//   2. The 2-rAF lifecycle (~32ms) was imperceptible. Now it uses a
//      minimum-presentation-window (600ms) + real ready signal (rAF
//      after onMount/hydration) + defensive max fallback (3s).
//
// Contracts tested:
//   1. Boot component exists.
//   2. Root layout mounts it unconditionally (no standalone-only gate).
//   3. Normal browser is allowed to show it (no isPwaStandalone check).
//   4. Visible initial state (visible = true on mount).
//   5. Minimum presentation lifecycle exists (MIN_PRESENTATION_MS).
//   6. Ready lifecycle removes it (rAF ready signal + tryFinish).
//   7. Defensive fallback exists (MAX_FALLBACK_MS = 3s).
//   8. Reduced-motion support exists.
//   9. No history.back / pushState / popstate / goto.
//  10. No service-worker changes.
//  11. No artificial multi-second delay as the PRIMARY lifecycle.
//  12. Overlay is aria-hidden + pointer-events: none.
//  13. Overlay is mounted once at root level (not per-navigation).

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const overlaySource = readFileSync(new URL('../src/lib/components/PwaBootOverlay.svelte', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');

// Strip comments for navigation-handler checks (source mentions these
// in comments).
const overlayNoComments = overlaySource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const layoutNoComments = layoutSource.replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ============================================================
// 1. Boot component exists
// ============================================================
console.log('\n1. Boot component exists');

assert.match(overlaySource, /class="pwa-boot"/,
  'overlay container exists');
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
ok('Boot component exists: Mavero wordmark (M + MAVERO) + thin progress bar');

// ============================================================
// 2. Root layout mounts it unconditionally (no standalone-only gate)
// ============================================================
console.log('\n2. Root layout mounts boot overlay unconditionally');

assert.match(layoutSource, /import PwaBootOverlay from '\$components\/PwaBootOverlay\.svelte'/,
  '+layout.svelte imports PwaBootOverlay');
// The render must NOT be gated behind {#if isPwaStandalone} or any
// standalone check. It must be a bare <PwaBootOverlay />.
assert.match(layoutSource, /<PwaBootOverlay \/>/,
  '+layout.svelte renders <PwaBootOverlay /> unconditionally');
// Verify NO standalone gate wraps the PwaBootOverlay render.
assert.doesNotMatch(layoutSource, /\{#if isPwaStandalone\}[\s\S]*?<PwaBootOverlay/,
  '+layout.svelte does NOT gate PwaBootOverlay behind isPwaStandalone');
ok('Root layout mounts <PwaBootOverlay /> unconditionally (no standalone gate)');

// ============================================================
// 3. Normal browser is allowed to show it (no standalone check)
// ============================================================
console.log('\n3. Normal browser allowed to show boot');

// +layout.svelte must NOT have isPwaStandalone state or checkStandalone
// function anymore (the previous version had these — they're removed).
assert.doesNotMatch(layoutSource, /isPwaStandalone/,
  '+layout.svelte has no isPwaStandalone state');
assert.doesNotMatch(layoutSource, /checkStandalone/,
  '+layout.svelte has no checkStandalone function');
assert.doesNotMatch(layoutSource, /display-mode: standalone/,
  '+layout.svelte has no standalone display-mode check');
ok('Normal browser is allowed to show the boot overlay (no standalone detection in layout)');

// ============================================================
// 4. Visible initial state
// ============================================================
console.log('\n4. Visible initial state');

assert.match(overlaySource, /let visible = true/,
  'visible starts as true (overlay is visible on mount)');
assert.match(overlaySource, /\{#if visible\}/,
  'overlay wrapped in {#if visible}');
ok('Overlay is visible on initial mount (visible = true)');

// ============================================================
// 5. Minimum presentation lifecycle exists
// ============================================================
console.log('\n5. Minimum presentation lifecycle');

assert.match(overlaySource, /const MIN_PRESENTATION_MS = \d+/,
  'MIN_PRESENTATION_MS constant defined');
// The minimum must be within the 500–800ms target.
const minMatch = overlaySource.match(/const MIN_PRESENTATION_MS = (\d+)/);
assert.ok(minMatch, 'MIN_PRESENTATION_MS value extracted');
const minMs = Number(minMatch![1]);
assert.ok(minMs >= 500 && minMs <= 800,
  `MIN_PRESENTATION_MS = ${minMs}ms (within 500–800ms target)`);
// The lifecycle must track minElapsed.
assert.match(overlaySource, /let minElapsed = false/,
  'minElapsed state tracked');
assert.match(overlaySource, /minTimer = setTimeout\([\s\S]*?MIN_PRESENTATION_MS\)/,
  'minTimer uses MIN_PRESENTATION_MS');
ok(`Minimum presentation window: ${minMs}ms (within 500–800ms target)`);

// ============================================================
// 6. Ready lifecycle removes it
// ============================================================
console.log('\n6. Ready lifecycle removes overlay');

// The ready signal must be rAF (fires after hydration + first paint).
assert.match(overlaySource, /requestAnimationFrame/,
  'uses requestAnimationFrame as the ready signal');
assert.match(overlaySource, /let appReady = false/,
  'appReady state tracked');
assert.match(overlaySource, /rafId = requestAnimationFrame\(\(\) => \{[\s\S]*?appReady = true/,
  'rAF callback sets appReady = true');
// tryFinish must check BOTH appReady AND minElapsed.
assert.match(overlaySource, /function tryFinish\(\) \{[\s\S]*?if \(appReady && minElapsed\)/,
  'tryFinish requires BOTH appReady AND minElapsed');
// finish must set fading + visible = false.
assert.match(overlaySource, /function finish\(\) \{[\s\S]*?fading = true/,
  'finish sets fading = true (fade-out)');
assert.match(overlaySource, /function finish\(\) \{[\s\S]*?visible = false/,
  'finish sets visible = false (remove from DOM)');
ok('Ready lifecycle: rAF (appReady) + minElapsed → fade out → remove from DOM');

// ============================================================
// 7. Defensive fallback exists
// ============================================================
console.log('\n7. Defensive fallback exists');

assert.match(overlaySource, /const MAX_FALLBACK_MS = \d+/,
  'MAX_FALLBACK_MS constant defined');
const maxMatch = overlaySource.match(/const MAX_FALLBACK_MS = (\d+)/);
assert.ok(maxMatch, 'MAX_FALLBACK_MS value extracted');
const maxMs = Number(maxMatch![1]);
assert.ok(maxMs >= 2000 && maxMs <= 5000,
  `MAX_FALLBACK_MS = ${maxMs}ms (within 2–5s defensive range)`);
assert.match(overlaySource, /maxTimer = setTimeout\(finish, MAX_FALLBACK_MS\)/,
  'maxTimer calls finish after MAX_FALLBACK_MS');
assert.match(overlaySource, /Defensive max fallback/,
  'fallback documented as defensive');
assert.match(overlaySource, /if \(maxTimer\) clearTimeout\(maxTimer\)/,
  'maxTimer is cleared on finish (no leak)');
// The onMount cleanup must also clear the fallback.
assert.match(overlaySource, /return \(\) => \{[\s\S]*?if \(maxTimer\) clearTimeout\(maxTimer\)/,
  'onMount cleanup clears maxTimer');
ok(`Defensive max fallback: ${maxMs}ms (safety net, cleaned up on destroy)`);

// ============================================================
// 8. Reduced-motion support exists
// ============================================================
console.log('\n8. Reduced-motion support');

assert.match(overlaySource, /@media \(prefers-reduced-motion: reduce\)/,
  'has prefers-reduced-motion media query');
assert.match(overlaySource, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pwa-boot-content \{[\s\S]*?animation: none/,
  'entrance animation disabled for reduced-motion');
assert.match(overlaySource, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pwa-boot-progress-bar \{[\s\S]*?animation: none/,
  'progress sweep disabled for reduced-motion (static bar)');
ok('Reduced-motion: static wordmark + static progress bar (lifecycle unchanged)');

// ============================================================
// 9. No history.back / pushState / popstate / goto
// ============================================================
console.log('\n9. No history/navigation handlers');

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
assert.doesNotMatch(layoutNoComments, /popstate/,
  '+layout.svelte: no popstate listener (unchanged)');
assert.doesNotMatch(layoutNoComments, /history\.back/,
  '+layout.svelte: no history.back() (unchanged)');
assert.doesNotMatch(layoutNoComments, /disableScrollHandling/,
  '+layout.svelte: no disableScrollHandling (unchanged)');
ok('No new navigation handlers in +layout.svelte');

// ============================================================
// 10. No service-worker changes
// ============================================================
console.log('\n10. No service-worker changes');

assert.doesNotMatch(overlayNoComments, /serviceWorker/,
  'PwaBootOverlay: no serviceWorker reference');
assert.doesNotMatch(overlayNoComments, /navigator\.serviceWorker/,
  'PwaBootOverlay: no navigator.serviceWorker');
assert.doesNotMatch(layoutNoComments, /navigator\.serviceWorker/,
  '+layout.svelte: no serviceWorker registration (unchanged — SW lives in PwaExperience)');
ok('No service-worker registration changes (SW stays in PwaExperience)');

// ============================================================
// 11. No artificial multi-second delay as the PRIMARY lifecycle
// ============================================================
console.log('\n11. No artificial multi-second delay as primary lifecycle');

// The PRIMARY lifecycle must be rAF + min-presentation (not a single
// long setTimeout). The MAX_FALLBACK_MS is a safety net, not the
// primary signal.
assert.match(overlaySource, /Safety net/,
  'MAX_FALLBACK_MS documented as safety net (not primary)');
// All setTimeout delays must be within reasonable bounds.
const setTimeouts = [...overlaySource.matchAll(/setTimeout\([^,]+, (\d+)\)/g)];
for (const m of setTimeouts) {
  const ms = Number(m[1]);
  assert.ok(ms <= 3000,
    `setTimeout delay ${ms}ms is within the 3s defensive max (not an arbitrary long delay)`);
}
ok('Primary lifecycle is rAF + 600ms min-presentation; 3s is a defensive safety net only');

// ============================================================
// 12. Overlay is aria-hidden + pointer-events: none
// ============================================================
console.log('\n12. Overlay is aria-hidden + pointer-events: none');

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
// 13. Overlay is mounted once at root level (not per-navigation)
// ============================================================
console.log('\n13. Overlay mounted once at root level');

// PwaBootOverlay must be rendered OUTSIDE the {#if page.url.pathname...}
// bare-render branch — it's at the root level, not inside AppShell or
// the bare-render path. This ensures it shows on EVERY route (watch,
// admin, auth, detail, discover, etc.) on initial load.
assert.match(layoutSource, /\{\/if\}[\s\S]*?<PwaBootOverlay/,
  'PwaBootOverlay is rendered after the bare-render {/if} (root level, not inside either branch)');
// PwaBootOverlay must NOT be inside the AppShell's children snippet.
// The AppShell block ends with </AppShell> followed by {/if} —
// PwaBootOverlay must come AFTER that {/if}, not inside.
const appShellBlock = layoutSource.match(/<AppShell[\s\S]*?<\/AppShell>/);
assert.ok(appShellBlock, 'AppShell block found');
assert.doesNotMatch(appShellBlock![0], /PwaBootOverlay/,
  'PwaBootOverlay is NOT inside the <AppShell>...</AppShell> block');
ok('Overlay is mounted once at root level (outside bare-render + AppShell branches)');

// ============================================================
// 14. Visual design — premium OTT, Mavero tokens
// ============================================================
console.log('\n14. Visual design — premium OTT, Mavero tokens');

assert.match(overlaySource, /background:[\s\S]*?#000000/,
  'background uses #000000 (Mavero --base)');
assert.match(overlaySource, /radial-gradient/,
  'subtle radial-gradient glow for depth');
assert.match(overlaySource, /font-family: 'Inter'/,
  'wordmark uses Inter font (Mavero brand language)');
assert.match(overlaySource, /height: 2px/,
  'progress bar is thin (2px)');
assert.match(overlaySource, /pwa-boot-progress-sweep/,
  'progress bar has indeterminate sweep animation');
assert.doesNotMatch(overlaySource, /border.*solid.*border-radius: 50%.*animation:.*spin|rotate\(360deg\)/,
  'no giant spinner (thin progress bar instead)');
assert.match(overlaySource, /z-index: 9999/,
  'z-index: 9999 (above all app content)');
ok('Visual design: dark bg + radial glow + Inter wordmark + thin progress + no spinner');

// ============================================================
// 15. Mobile responsive
// ============================================================
console.log('\n15. Mobile responsive');

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
// 16. +layout.svelte existing architecture preserved
// ============================================================
console.log('\n16. +layout.svelte existing architecture preserved');

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
// Root snapshot must be preserved.
assert.match(layoutSource, /export const snapshot = \{/,
  'root layout snapshot preserved');
assert.match(layoutSource, /capture:[\s\S]*?window\.scrollX/,
  'snapshot.capture (scrollX) preserved');
assert.match(layoutSource, /restore:[\s\S]*?window\.scrollTo/,
  'snapshot.restore (scrollTo) preserved');
ok('+layout.svelte: bare-render regex + AppShell + PwaExperience + Toast + onMount + snapshot all preserved');

console.log(`\nPWA boot overlay tests passed (${passed} check groups).`);
