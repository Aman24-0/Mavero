import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getCachedRail, setCachedRail, clearRailCache, railCacheStats, __test } from '../src/lib/client/discover/rail-cache';

/**
 * Phase 2-G + 2-H + 2-L — Discover cache, loading UX, and Show More error state.
 *
 * 2-G: A small bounded client-side rail cache (TTL + LRU + per-user keys)
 *      survives component remounts so back-navigation doesn't refetch.
 * 2-H: The first-load state now renders a SkeletonCard rail (same grid as
 *      the populated rail) instead of an empty spinner — no layout jump.
 * 2-L: Show-more failure preserves existing items AND surfaces the error
 *      with a retry action — the rail is NOT replaced with an error page.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. The rail cache module exists with the right shape.
// ============================================================
const railCacheSrc = read('src/lib/client/discover/rail-cache.ts');
ok(/export function getCachedRail/.test(railCacheSrc), '1a. getCachedRail exported');
ok(/export function setCachedRail/.test(railCacheSrc), '1b. setCachedRail exported');
ok(/export function clearRailCache/.test(railCacheSrc), '1c. clearRailCache exported (for sign-out flow)');
ok(/export function railCacheStats/.test(railCacheSrc), '1d. railCacheStats exported');
ok(/DEFAULT_TTL_MS = 2 \* 60_000/.test(railCacheSrc), '1e. DEFAULT_TTL_MS is 2 minutes (short — adult-mode flips propagate quickly)');
ok(/DEFAULT_MAX_ENTRIES = 32/.test(railCacheSrc), '1f. DEFAULT_MAX_ENTRIES is 32 (bounded)');

// ============================================================
// 2. Cache hit / miss behavior — in-memory + per-user.
// ============================================================
clearRailCache();
const userA = 'user-aaa';
const userB = 'user-bbb';
const url = '/api/discover/rail?section=popular-movie&language=all&page=1';

setCachedRail(url, userA, [{ id: '1', type: 'movie' }], true);
const hitA = getCachedRail(url, userA);
ok(hitA !== undefined && hitA.items.length === 1 && hitA.hasNextPage === true, '2a. cache hit for the same user + url');

const missB = getCachedRail(url, userB);
ok(missB === undefined, '2b. cache miss for a DIFFERENT user (per-user key isolation — no cross-user leakage)');

const missGuest = getCachedRail(url, undefined);
ok(missGuest === undefined, '2c. cache miss for guest (per-user key isolation)');

// ============================================================
// 3. TTL expiration.
// ============================================================
clearRailCache();
setCachedRail(url, userA, [{ id: '1' }], true, 10); // 10ms TTL
await new Promise((r) => setTimeout(r, 30));
const expired = getCachedRail(url, userA);
ok(expired === undefined, '3a. expired entry is not served');

// ============================================================
// 4. LRU eviction at capacity.
// ============================================================
clearRailCache();
const max = __test.DEFAULT_MAX_ENTRIES;
for (let i = 0; i < max; i++) {
  setCachedRail(`/api/discover/rail?section=s${i}`, userA, [{ id: `i${i}` }], false);
}
const atCap = railCacheStats();
ok(atCap.entries === max, `4a. cache holds exactly ${max} entries at capacity (got ${atCap.entries})`);

setCachedRail(`/api/discover/rail?section=overflow`, userA, [{ id: 'overflow' }], false);
const overCap = railCacheStats();
ok(overCap.entries === max, `4b. cache still holds ${max} entries after overflow (LRU evicted the oldest)`);

// The oldest entry (section=s0) should be gone.
const oldestGone = getCachedRail(`/api/discover/rail?section=s0`, userA);
ok(oldestGone === undefined, '4c. LRU evicted the oldest entry (section=s0)');

// ============================================================
// 5. clearRailCache evicts everything.
// ============================================================
clearRailCache();
setCachedRail(url, userA, [{ id: '1' }], true);
clearRailCache();
const afterClear = getCachedRail(url, userA);
ok(afterClear === undefined, '5a. clearRailCache evicts everything (sign-out flow)');
ok(railCacheStats().entries === 0, '5b. cache is empty after clearRailCache');

// ============================================================
// 6. DiscoverSection uses the cache + skeleton + retry.
// ============================================================
const discoverSection = read('src/lib/components/DiscoverSection.svelte');
ok(/import \{ getCachedRail, setCachedRail \} from '\$lib\/client\/discover\/rail-cache'/.test(discoverSection), '6a. DiscoverSection imports the rail cache');
ok(/getCachedRail<MediaItem>\(url, page\.data\.user\?\.id\)/.test(discoverSection), '6b. DiscoverSection reads cache with per-user key (page.data.user?.id)');
ok(/setCachedRail\(url, page\.data\.user\?\.id, items, hasNextPage\)/.test(discoverSection), '6c. DiscoverSection writes cache with per-user key');
ok(/import SkeletonCard from '\$components\/SkeletonCard\.svelte'/.test(discoverSection), '6d. DiscoverSection imports SkeletonCard (Phase 2-H)');

// ============================================================
// 7. Phase 2-H: skeleton rail replaces the spinner on first load.
// ============================================================
ok(/<div class="rail skeleton-rail" aria-busy="true" aria-live="polite">/.test(discoverSection), '7a. first-load renders a skeleton rail (aria-busy, aria-live)');
ok(/\{#each Array\(6\) as _, i \(i\)\}<SkeletonCard \/>/.test(discoverSection), '7b. skeleton rail renders 6 SkeletonCards (same grid as populated rail)');
// The old spinner-only section-loading div should be gone.
ok(!/<div class="section-loading" aria-live="polite">[\s\S]*?<LoaderCircle/.test(discoverSection), '7c. old section-loading spinner removed from first-load path');

// ============================================================
// 8. Phase 2-L: Show-more failure preserves items + surfaces retry.
// ============================================================
ok(/let showMoreError = \$state\(''\)/.test(discoverSection), '8a. separate showMoreError state (Phase 2-L)');
ok(/showMoreError = ''; \/\/ Phase 2-L: clear any previous Show-more error/.test(discoverSection), '8b. Show-more error is cleared at the start of loadMore');
ok(/showMoreError = error instanceof Error \? error\.message : 'Could not load more titles\.'/.test(discoverSection), '8c. Show-more failure sets showMoreError (does NOT clear items)');
ok(/\{#if showMoreError\}/.test(discoverSection), '8d. showMoreError conditionally rendered (preserves the rail)');
ok(/<button class="retry-btn" type="button" onclick=\{loadMore\}/.test(discoverSection), '8e. Show-more error includes a retry button that calls loadMore');
// First-load error ALSO has a retry now.
ok(/<button class="retry-btn" type="button" onclick=\{\(\) => loadFirst\(\)\}/.test(discoverSection), '8f. first-load error includes a retry button that calls loadFirst');

// ============================================================
// 9. AdultDiscoverSection has the same Phase 2-H + 2-L treatment.
// ============================================================
const adultSection = read('src/lib/components/AdultDiscoverSection.svelte');
ok(/import SkeletonCard from '\$components\/SkeletonCard\.svelte'/.test(adultSection), '9a. AdultDiscoverSection imports SkeletonCard (Phase 2-H)');
ok(/<div class="rail skeleton-rail" aria-busy="true" aria-live="polite">/.test(adultSection), '9b. AdultDiscoverSection first-load renders a skeleton rail');
ok(/let showMoreError = \$state\(''\)/.test(adultSection), '9c. AdultDiscoverSection has separate showMoreError state (Phase 2-L)');
ok(/<button class="retry-btn" type="button" onclick=\{\(\) => loadFirst\(\)\}/.test(adultSection), '9d. AdultDiscoverSection first-load error has retry button');
ok(/\{#if showMoreError\}/.test(adultSection), '9e. AdultDiscoverSection Show-more failure preserves rail + surfaces retry');

// ============================================================
// 10. Stale-request protection (existing) preserved.
// ============================================================
ok(/requestSequence \+= 1;/.test(discoverSection), '10a. requestSequence preserved (stale-request protection)');
ok(/requestController\?\.abort\(\);/.test(discoverSection), '10b. requestController.abort() preserved (existing AbortController behavior)');
ok(/new AbortController\(\)/.test(discoverSection), '10c. new AbortController created per request (existing behavior)');

// ============================================================
// 11. Language / provider filter behavior preserved.
// ============================================================
ok(/function changeLanguage/.test(discoverSection), '11a. changeLanguage preserved');
ok(/function changeProvider/.test(discoverSection), '11b. changeProvider preserved');
ok(/if \(nextLang === language\) return;/.test(discoverSection), '11c. language change short-circuits when unchanged');
ok(/void loadFirst\(\);/.test(discoverSection), '11d. language/provider change triggers loadFirst (resets to page 1)');

// ============================================================
// 12. The cache is per-tab in-memory (not localStorage / IndexedDB).
// ============================================================
// Strip line comments so documentation references to localStorage /
// IndexedDB don't false-positive.
const railCacheCode = railCacheSrc.replace(/\/\/[^\n]*/g, '');
ok(!/localStorage/.test(railCacheCode), '12a. rail cache does NOT use localStorage (per-tab, dies with the tab)');
ok(!/indexedDB/.test(railCacheCode), '12b. rail cache does NOT use IndexedDB (per-tab, dies with the tab)');
ok(/new Map</.test(railCacheCode), '12c. rail cache uses in-memory Map (per-tab module state)');

console.log(`phase2_discover_ux_test: ${passed} checks passed (Phase 2-G/H/L discover cache + UX + Show More retry)`);
