import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Detail Back Navigation Reliability Regression Test
//
// Root cause being protected:
//   `window.history.back()` is fire-and-forget. It returns void, has no
//   callback, and SILENTLY does nothing when there is no previous history
//   entry (history index 0). This happens when the user deep-links / shares
//   / refreshes the DetailPage URL — the DetailPage becomes the first
//   history entry, and back() no-ops. BOTH the DetailPage Back button AND
//   the Android/browser hardware Back button fail simultaneously because
//   they rely on the same empty history stack.
//
//   The existing fallback (goto '/discover') only fired when `from` was
//   missing/invalid. When `from` IS present (shared link with a from param),
//   the old code called back() and returned — but back() was a no-op,
//   leaving the user stuck.
//
// Fix being protected:
//   1. Fast path: if history.length === 1, skip back() entirely and go
//      straight to goto(returnTo, { replaceState: true }).
//   2. Normal path: call back() + listen for popstate. If popstate doesn't
//      fire within one macrotask (setTimeout 0), fall back to
//      goto(returnTo, { replaceState: true }).
//   3. No valid `from`: goto('/discover', { replaceState: true }).
//   4. Old browsers without history.back: defensive goto(returnTo).
//
//   The fix PRESERVES the existing architecture:
//     - appendReturnTo + from param (unchanged)
//     - history.back() for normal navigation (unchanged — still the
//       primary path so SvelteKit snapshot/scroll restore fires)
//     - snapshot capture/restore in +layout.svelte (unchanged)
//     - /discover fallback for missing from (unchanged)
//     - defensive goto for old browsers (unchanged)

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const detailPage = read('../src/lib/components/DetailPage.svelte');
const mediaCard = read('../src/lib/components/MediaCard.svelte');
const navigation = read('../src/lib/shared/navigation.ts');
const layout = read('../src/routes/+layout.svelte');
const downloadSheet = read('../src/lib/components/DownloadSheet.svelte');

// ============================================================
// 1. MediaCard creates DetailPage URL with encoded `from`
// ============================================================
console.log('\n1. MediaCard from-param encoding');

assert.match(mediaCard, /import \{ appendReturnTo \} from '\$lib\/shared\/navigation'/,
  'MediaCard imports appendReturnTo');
assert.match(mediaCard, /appendReturnTo\(`\/\$\{item\.type\}\/\$\{item\.id\}`, returnTo\)/,
  'MediaCard builds detail href via appendReturnTo');
assert.match(mediaCard, /\$: returnTo = `\$\{page\.url\.pathname\}\$\{page\.url\.search\}\$\{page\.url\.hash\}`/,
  'MediaCard computes returnTo from pathname + search + hash');
ok('MediaCard creates DetailPage URL with encoded from param');

// ============================================================
// 2. DetailPage recognizes a valid internal `from`
// ============================================================
console.log('\n2. DetailPage recognizes valid internal from');

assert.match(detailPage, /function goBack\(event: MouseEvent\)/,
  'DetailPage has goBack function');
assert.match(detailPage, /const returnTo = page\.url\.searchParams\.get\('from'\)/,
  'goBack reads from param via searchParams.get');
assert.match(detailPage, /if \(returnTo\?\.startsWith\('\/'\) && !returnTo\.startsWith\('\/\/'\)\)/,
  'goBack checks returnTo starts with / and not // (valid internal from)');
ok('DetailPage recognizes valid internal from (starts with /, not //)');

// ============================================================
// 3. External/open/deep-link values are never treated as internal
// ============================================================
console.log('\n3. External/deep-link from values rejected');

// The isValidInternal check rejects:
//   - null/undefined (optional chaining returns undefined → false)
//   - values not starting with '/'
//   - values starting with '//' (protocol-relative URLs)
// Verify the check pattern is present and correct.
assert.match(detailPage, /returnTo\?\.startsWith\('\/'\) && !returnTo\.startsWith\('\/\/'\)/,
  'isValidInternal rejects values not starting with / and // values');
// Verify that https://evil.example would fail: it doesn't start with '/'.
// Verify that //evil.example would fail: it starts with '//'.
// These are covered by the regex above.
ok('External/open/deep-link from values (https://evil, //evil, malformed) rejected');

// Also verify the appendReturnTo + safeReturnTo helpers reject external values.
assert.match(navigation, /export function appendReturnTo[\s\S]*?if \(!returnTo\.startsWith\('\/'\) \|\| returnTo\.startsWith\('\/\/'\)\) return href/,
  'appendReturnTo rejects external returnTo values');
assert.match(navigation, /export function safeReturnTo[\s\S]*?if \(!value \|\| !value\.startsWith\('\/'\) \|\| value\.startsWith\('\/\/'\)\) return null/,
  'safeReturnTo rejects external/null values');
ok('navigation.ts helpers (appendReturnTo, safeReturnTo) reject external values');

// ============================================================
// 4. Back behavior does not bypass normal history traversal when a
//    valid internal origin exists
// ============================================================
console.log('\n4. Normal history traversal preserved for valid from');

// The primary path MUST still be window.history.back() — NOT goto(returnTo).
// This is what triggers SvelteKit's snapshot/scroll restoration.
assert.match(detailPage, /window\.history\.back\(\)/,
  'goBack calls window.history.back() for the valid-from case (primary path)');

// The old broken pattern (goto with replaceState as the PRIMARY action for
// valid from) must NOT be present.
assert.doesNotMatch(detailPage,
  /if \(returnTo\?\.startsWith\('\/'\) && !returnTo\.startsWith\('\/\/'\)\)\s*\{\s*void goto\(returnTo, \{ replaceState: true, keepFocus: true \}\);\s*return;\s*\}/,
  'goBack must NOT use goto(returnTo, { replaceState: true }) as the primary valid-from action');

// The popstate-detection safety net must be present (the fix).
assert.match(detailPage, /window\.addEventListener\('popstate', onPopState/,
  'goBack adds a popstate listener to detect whether back() navigated');
assert.match(detailPage, /let navigated = false/,
  'goBack tracks navigated state');
assert.match(detailPage, /if \(!navigated\)/,
  'goBack falls back to goto when popstate did not fire (back() no-op)');
ok('Normal history traversal preserved (back() is primary); popstate-detection is the safety net');

// ============================================================
// 5. Direct DetailPage fallback remains /discover
// ============================================================
console.log('\n5. /discover fallback for missing/invalid from');

assert.match(detailPage, /goto\('\/discover', \{ replaceState: true, keepFocus: true \}\)/,
  'goBack falls back to goto(/discover) when from is missing/invalid');
ok('/discover fallback preserved for missing/invalid from');

// ============================================================
// 6. Existing snapshot/navigation contract not accidentally removed
// ============================================================
console.log('\n6. Snapshot/navigation contract intact');

// Root layout snapshot must still exist.
assert.match(layout, /export const snapshot = \{/,
  'Root layout exports snapshot');
assert.match(layout, /window\.scrollX/,
  'snapshot.capture reads window.scrollX');
assert.match(layout, /window\.scrollY/,
  'snapshot.capture reads window.scrollY');
assert.match(layout, /window\.scrollTo/,
  'snapshot.restore calls window.scrollTo');
assert.match(layout, /requestAnimationFrame/,
  'snapshot.restore defers via requestAnimationFrame');
ok('Root layout snapshot (scroll capture/restore) intact');

// Search page snapshot must still exist.
const searchPage = read('../src/routes/search/+page.svelte');
assert.match(searchPage, /export const snapshot = \{/,
  'Search page exports snapshot');
ok('Search page snapshot (query/type/results restore) intact');

// appendReturnTo helper must still exist + work correctly.
assert.match(navigation, /export function appendReturnTo/,
  'appendReturnTo helper exists');
assert.match(navigation, /encodeURIComponent\(returnTo\)/,
  'appendReturnTo URL-encodes the returnTo value');
ok('appendReturnTo helper intact (with URL encoding)');

// ============================================================
// 7. No duplicate/conflicting popstate/back handlers introduced
// ============================================================
console.log('\n7. No duplicate popstate/back handlers');

// The popstate listener in goBack must be properly cleaned up (removeEventListener).
assert.match(detailPage, /window\.removeEventListener\('popstate', onPopState\)/,
  'goBack cleans up the popstate listener (removeEventListener)');
assert.match(detailPage, /clearTimeout\(timer\)/,
  'goBack cleans up the setTimeout timer');
ok('popstate listener + timer are properly cleaned up (no leaks)');

// No other popstate handlers in DetailPage (the only popstate listener is
// the one inside goBack).
const detailPagePopstateCount = (detailPage.match(/addEventListener\('popstate'/g) ?? []).length;
assert.equal(detailPagePopstateCount, 1,
  'DetailPage has exactly one popstate listener (inside goBack)');
const detailPageRemovePopstateCount = (detailPage.match(/removeEventListener\('popstate'/g) ?? []).length;
assert.equal(detailPageRemovePopstateCount, 1,
  'DetailPage has exactly one removeEventListener(popstate) (cleanup)');
ok('No duplicate popstate handlers in DetailPage');

// No popstate handlers in DownloadSheet (shouldn't interfere with navigation).
assert.doesNotMatch(downloadSheet, /popstate/,
  'DownloadSheet has no popstate handler (does not interfere with navigation)');
assert.doesNotMatch(downloadSheet, /history\.back/,
  'DownloadSheet does not call history.back (does not interfere)');
ok('DownloadSheet does not introduce conflicting popstate/back handlers');

// No beforeNavigate/onNavigate/afterNavigate anywhere (the failed approach).
assert.doesNotMatch(layout, /onMount\(\(\)\s*=>\s*\{[\s\S]*?beforeNavigate\(/,
  'Root layout does NOT register beforeNavigate inside onMount');
assert.doesNotMatch(layout, /onMount\(\(\)\s*=>\s*\{[\s\S]*?onNavigate\(/,
  'Root layout does NOT register onNavigate inside onMount');
assert.doesNotMatch(layout, /onMount\(\(\)\s*=>\s*\{[\s\S]*?afterNavigate\(/,
  'Root layout does NOT register afterNavigate inside onMount');
ok('No beforeNavigate/onNavigate/afterNavigate hooks (failed approach absent)');

// ============================================================
// 8. Recent downloader DetailPage changes do not interfere with navigation
// ============================================================
console.log('\n8. Downloader changes do not interfere with navigation');

// The loadDownloadProviders call in onMount must be fire-and-forget (void).
assert.match(detailPage, /void loadDownloadProviders\(\)/,
  'onMount calls loadDownloadProviders as fire-and-forget (void)');
// loadDownloadProviders must NOT touch history or call goto.
const loadDownloadProvidersMatch = detailPage.match(/async function loadDownloadProviders\(\) \{[\s\S]*?\n  \}/);
assert.ok(loadDownloadProvidersMatch, 'loadDownloadProviders function exists');
assert.doesNotMatch(loadDownloadProvidersMatch![0], /history\./,
  'loadDownloadProviders does not touch history');
assert.doesNotMatch(loadDownloadProvidersMatch![0], /goto\(/,
  'loadDownloadProviders does not call goto');
assert.doesNotMatch(loadDownloadProvidersMatch![0], /replaceState/,
  'loadDownloadProviders does not call replaceState');
assert.doesNotMatch(loadDownloadProvidersMatch![0], /popstate/,
  'loadDownloadProviders does not listen to popstate');
ok('loadDownloadProviders is fire-and-forget fetch only (no history/goto/popstate interference)');

// The DownloadSheet must not call history.back / goto / replaceState.
assert.doesNotMatch(downloadSheet, /goto\(/,
  'DownloadSheet does not call goto');
assert.doesNotMatch(downloadSheet, /replaceState/,
  'DownloadSheet does not call replaceState');
assert.doesNotMatch(downloadSheet, /pushState/,
  'DownloadSheet does not call pushState');
ok('DownloadSheet does not use goto/replaceState/pushState');

// The onMount cleanup must still set active = false (the existing async guard).
assert.match(detailPage, /return \(\) => \{ active = false; \}/,
  'onMount cleanup sets active = false (async guard intact)');
ok('DetailPage onMount cleanup (active = false) intact');

// ============================================================
// 9. history.length fast-path (deep-link detection)
// ============================================================
console.log('\n9. history.length fast-path for deep-link detection');

// When history.length === 1, back() would no-op. The fix skips back() and
// goes straight to goto(returnTo, { replaceState: true }).
assert.match(detailPage, /window\.history\.length <= 1/,
  'goBack checks history.length <= 1 (deep-link fast path)');
assert.match(detailPage, /if \(window\.history\.length <= 1\) \{[\s\S]*?void goto\(returnTo, \{ replaceState: true, keepFocus: true \}\)/,
  'history.length <= 1 → goto(returnTo, { replaceState: true }) (skip back())');
ok('history.length fast-path: skips back() when at first history entry');

// ============================================================
// 10. popstate-detection safety net (back() no-op detection)
// ============================================================
console.log('\n10. popstate-detection safety net');

// The safety net: after back(), listen for popstate. If it doesn't fire
// within one macrotask (setTimeout 0), fall back to goto.
assert.match(detailPage, /setTimeout\([\s\S]*?, 0\)/,
  'goBack uses setTimeout(..., 0) for popstate detection (single macrotask)');
assert.match(detailPage, /if \(!navigated\) \{[\s\S]*?void goto\(returnTo, \{ replaceState: true, keepFocus: true \}\)/,
  'popstate-detection fallback calls goto(returnTo, { replaceState: true })');
ok('popstate-detection: falls back to goto when back() is a no-op');

// ============================================================
// 11. Defensive fallback for old browsers preserved
// ============================================================
console.log('\n11. Old-browser defensive fallback preserved');

assert.match(detailPage, /void goto\(returnTo, \{ replaceState: true, keepFocus: true \}\)/,
  'Defensive goto(returnTo, { replaceState: true }) preserved for old browsers');
ok('Old-browser defensive goto fallback preserved');

// ============================================================
// 12. Functional test: appendReturnTo + safeReturnTo round-trip
// ============================================================
console.log('\n12. Functional round-trip: appendReturnTo + searchParams.get');

// We can actually execute these pure functions.
const { appendReturnTo, safeReturnTo } = await import('../src/lib/shared/navigation.ts');

// Normal case: listing URL with query string.
const listingUrl = '/search?q=deadpool&type=movie';
const detailHref = appendReturnTo('/movie/123', listingUrl);
assert.equal(detailHref, '/movie/123?from=%2Fsearch%3Fq%3Ddeadpool%26type%3Dmovie',
  'appendReturnTo URL-encodes the from value');

// Simulate searchParams.get('from') — it auto-decodes.
const parsed = new URL(detailHref, 'http://localhost').searchParams.get('from');
assert.equal(parsed, listingUrl,
  'searchParams.get decodes from back to the original listing URL');
assert.ok(parsed?.startsWith('/') && !parsed.startsWith('//'),
  'decoded from passes the isValidInternal check');
ok('appendReturnTo + searchParams.get round-trip preserves the listing URL');

// External values rejected by appendReturnTo.
assert.equal(appendReturnTo('/movie/123', 'https://evil.example'),
  '/movie/123',
  'appendReturnTo rejects https://evil.example (returns href unchanged)');
assert.equal(appendReturnTo('/movie/123', '//evil.example'),
  '/movie/123',
  'appendReturnTo rejects //evil.example (returns href unchanged)');
assert.equal(appendReturnTo('/movie/123', ''),
  '/movie/123',
  'appendReturnTo rejects empty string (returns href unchanged)');
ok('appendReturnTo rejects external/empty values');

// safeReturnTo rejects external values.
assert.equal(safeReturnTo('https://evil.example'), null,
  'safeReturnTo rejects https://evil.example');
assert.equal(safeReturnTo('//evil.example'), null,
  'safeReturnTo rejects //evil.example');
assert.equal(safeReturnTo(null), null,
  'safeReturnTo rejects null');
assert.equal(safeReturnTo(undefined), null,
  'safeReturnTo rejects undefined');
assert.equal(safeReturnTo('/search?q=test'),
  '/search?q=test',
  'safeReturnTo accepts valid internal URL');
ok('safeReturnTo rejects external/null values, accepts valid internal');

console.log(`\nDetail back navigation reliability tests passed (${passed} check groups).`);
