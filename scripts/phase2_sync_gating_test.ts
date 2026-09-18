import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isLibraryAwareRoute } from '../src/lib/shared/route-policy';

/**
 * Phase 2-F (audit PERF-006) — Account sync gating.
 *
 * Problem: `syncAuthenticatedState()` was called on EVERY root layout
 * mount for EVERY authenticated user, even on routes where no library
 * state is shown (e.g. /auth/sign-in, /search, /upcoming, /admin/*).
 * Each sync makes 2 cloud HTTP roundtrips (read + write) plus several
 * IndexedDB reads/writes — expensive work that produces no UI benefit.
 *
 * Fix: gate the sync to library-aware routes. A new pure helper
 * (`isLibraryAwareRoute`) classifies which paths need sync. The root
 * layout consumes it; the online-retry handler also checks the current
 * route before firing.
 *
 * This test verifies:
 *   1. The pure classifier correctly identifies library-aware routes.
 *   2. The root layout uses the classifier to gate the sync.
 *   3. The online-retry handler ALSO checks the current route.
 *   4. Guests (data.user falsy) are still skipped (existing behavior).
 *   5. Library-aware sub-pages (my-list, watch, discover, account,
 *      movie/series/anime detail) still fire sync.
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
// 1. Library-aware routes — sync SHOULD fire.
// ============================================================
const libraryAware = [
  '/my-list',
  '/discover',
  '/discover/movies',
  '/discover/series',
  '/discover/anime',
  '/watch/movie/123',
  '/watch/series/series-8633518',
  '/watch/anime/anime-94605',
  '/account',
  '/movie/123',
  '/series/94605',
  '/anime/94605'
];
for (const route of libraryAware) {
  ok(isLibraryAwareRoute(route) === true, `1. ${route} is library-aware (sync fires)`);
}

// ============================================================
// 2. Non-library routes — sync SHOULD NOT fire.
// ============================================================
const notLibraryAware = [
  '/',
  '/auth/sign-in',
  '/auth/sign-up',
  '/auth/reset',
  '/auth/callback',
  '/auth/sign-out',
  '/search',
  '/search?q=batman',
  '/upcoming',
  '/upcoming?month=jan&year=2026',
  '/admin',
  '/admin/sources',
  '/admin/addons',
  '/sitemap.xml',
  '/sw.js',
  '/manifest.webmanifest'
];
for (const route of notLibraryAware) {
  ok(isLibraryAwareRoute(route) === false, `2. ${route} is NOT library-aware (sync skipped)`);
}

// ============================================================
// 3. The root layout uses the classifier.
// ============================================================
const layout = read('src/routes/+layout.svelte');
ok(/isLibraryAwareRoute/.test(layout), '3a. +layout.svelte imports isLibraryAwareRoute');
ok(/import \{ isLibraryAwareRoute \} from '\$lib\/shared\/route-policy'/.test(layout), '3b. isLibraryAwareRoute imported from $lib/shared/route-policy');

// ============================================================
// 4. The initial mount sync is gated by isLibraryAwareRoute.
// ============================================================
ok(/if \(!data\.user\) return;/.test(layout), '4a. guests (no data.user) still short-circuit (preserved)');
ok(/if \(!isLibraryAwareRoute\(page\.url\.pathname\)\) return;/.test(layout), '4b. initial sync gated by isLibraryAwareRoute(currentPath)');

// ============================================================
// 5. The online-retry handler ALSO checks the current route.
// ============================================================
// Extract the retry handler body.
const retryMatch = /const retry = \(\) => \{[\s\S]*?\};/.exec(layout);
ok(retryMatch !== null, '5a. online-retry handler exists');
if (retryMatch) {
  const retryBody = retryMatch[0];
  ok(/navigator\.onLine/.test(retryBody), '5b. retry checks navigator.onLine (preserved)');
  ok(/isLibraryAwareRoute\(page\.url\.pathname\)/.test(retryBody), '5c. retry ALSO checks isLibraryAwareRoute(currentPath) — sync only fires on library-aware routes');
}

// ============================================================
// 6. The pure helper is exportable and side-effect-free.
// ============================================================
// Calling it multiple times with the same input must produce the same output.
const a = isLibraryAwareRoute('/my-list');
const b = isLibraryAwareRoute('/my-list');
ok(a === b, '6a. isLibraryAwareRoute is pure (same input -> same output)');

// ============================================================
// 7. Case-insensitivity — paths are lowercased before matching.
// ============================================================
ok(isLibraryAwareRoute('/MY-LIST') === true, '7a. uppercase /MY-LIST classified correctly (case-insensitive)');
ok(isLibraryAwareRoute('/My-List') === true, '7b. mixed-case /My-List classified correctly (case-insensitive)');

// ============================================================
// 8. Near-miss paths — only the right paths match.
// ============================================================
ok(isLibraryAwareRoute('/my-list-item') === true, '8a. /my-list-item matches /my-list prefix (intentional — /my-list-* would be a sub-page)');
ok(isLibraryAwareRoute('/mylist') === false, '8b. /mylist (no hyphen) does NOT match (prefix is /my-list)');
ok(isLibraryAwareRoute('/search?q=/my-list') === false, '8c. /search?q=/my-list does NOT match (path is /search, not the query)');

console.log(`phase2_sync_gating_test: ${passed} checks passed (Phase 2-F account sync gating)`);
