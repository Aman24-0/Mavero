/**
 * Admin 2.0 — Phase 4 — Analytics Recovery & Viewing Completion
 *
 * Verifies:
 *   A. Root cause fix — createSupabaseAdminClient inside try/catch
 *   B. Fallback empty state — no blank page when tab data is null
 *   C. Overview tab field-name fixes (stickiness→dauMauRatio, removed non-existent fields)
 *   D. Viewing tab field-name fixes (completedWatches, watchTimeSeconds, search.totalSearches)
 *   E. Viewing enrichment (content type breakdown, mostCompleted, trending, genres, search)
 *   F. Legacy redirect stubs remain intact
 *   G. /admin/users/[userId] remains on AdminAppShell
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const analyticsServer = read('src/routes/admin/analytics/+page.server.ts');
const analyticsPage = read('src/routes/admin/analytics/+page.svelte');

// ============================================================
// A. Root cause fix — createSupabaseAdminClient inside try/catch
// ============================================================

// The server must NOT call createSupabaseAdminClient() outside the try/catch.
// Previously it was on line 31 (before the try block), so a missing
// PRIVATE_SUPABASE_SERVICE_ROLE_KEY env var would throw an uncaught error
// and 500 the entire /admin/analytics route.
assert.match(analyticsServer, /try\s*\{[\s\S]*?const adminClient = createSupabaseAdminClient\(\)/, 'A1a. createSupabaseAdminClient() is INSIDE the try block');
// Verify it's NOT before the try block (the old position)
const tryIdx = analyticsServer.indexOf('try {');
const adminClientIdx = analyticsServer.indexOf('createSupabaseAdminClient()');
assert.ok(tryIdx >= 0 && adminClientIdx > tryIdx, 'A1b. createSupabaseAdminClient() appears AFTER the try block opens (not before)');
ok('A1. Root cause fixed: createSupabaseAdminClient() moved inside try/catch (was outside, causing uncaught 500)');

// ============================================================
// B. Fallback empty state — no blank page
// ============================================================

// The page must have a fallback {:else} at the end of the tab chain
// so that if no tab condition matches (data.<tab> is null), the page
// renders a message instead of a blank screen.
assert.match(analyticsPage, /Loading analytics data/, 'B1a. Fallback "Loading analytics data" state present');
assert.match(analyticsPage, /\{:else\}[\s\S]*?Loading analytics data/, 'B1b. Fallback is in the {:else} branch of the tab chain');
ok('B1. Fallback empty state added (prevents blank page when tab data is null)');

// ============================================================
// C. Overview tab field-name fixes
// ============================================================

// Removed non-existent fields: totalUsersComparison, watchStarts (on OverviewMetrics)
assert.doesNotMatch(analyticsPage, /m\.totalUsersComparison/, 'C1a. Overview no longer references non-existent m.totalUsersComparison');
assert.doesNotMatch(analyticsPage, /m\.stickiness/, 'C1b. Overview no longer references non-existent m.stickiness');
// Fixed: stickiness → dauMauRatio
assert.match(analyticsPage, /m\.dauMauRatio/, 'C1c. Overview uses m.dauMauRatio (was m.stickiness)');
// Overview still has valid fields
assert.match(analyticsPage, /m\.totalUsers/, 'C1d. Overview uses m.totalUsers');
assert.match(analyticsPage, /m\.activeUsers/, 'C1e. Overview uses m.activeUsers');
assert.match(analyticsPage, /m\.guestReach/, 'C1f. Overview uses m.guestReach');
assert.match(analyticsPage, /m\.loggedInReach/, 'C1g. Overview uses m.loggedInReach (replaced non-existent m.watchStarts)');
ok('C1. Overview tab field-name fixes (removed totalUsersComparison/watchStarts, fixed stickiness→dauMauRatio)');

// ============================================================
// D. Viewing tab field-name fixes
// ============================================================

// Removed non-existent fields: totalViews, watchCompletes, approxWatchTimeSeconds, searches (on ViewingMetrics)
assert.doesNotMatch(analyticsPage, /m\.totalViews/, 'D1a. Viewing no longer references non-existent m.totalViews');
assert.doesNotMatch(analyticsPage, /m\.watchCompletes/, 'D1b. Viewing no longer references non-existent m.watchCompletes (should be completedWatches)');
assert.doesNotMatch(analyticsPage, /m\.approxWatchTimeSeconds/, 'D1c. Viewing no longer references non-existent m.approxWatchTimeSeconds (should be watchTimeSeconds)');
assert.doesNotMatch(analyticsPage, /m\.searches/, 'D1d. Viewing no longer references non-existent m.searches (should be v.search.totalSearches)');
// Fixed field names
assert.match(analyticsPage, /m\.completedWatches/, 'D1e. Viewing uses m.completedWatches (was m.watchCompletes)');
assert.match(analyticsPage, /m\.watchTimeSeconds/, 'D1f. Viewing uses m.watchTimeSeconds (was m.approxWatchTimeSeconds)');
assert.match(analyticsPage, /v\.search\?\.totalSearches/, 'D1g. Viewing uses v.search?.totalSearches (was m.searches)');
assert.match(analyticsPage, /m\.uniqueViewers/, 'D1h. Viewing uses m.uniqueViewers');
assert.match(analyticsPage, /m\.watchStarts/, 'D1i. Viewing uses m.watchStarts');
ok('D1. Viewing tab field-name fixes (completedWatches, watchTimeSeconds, search.totalSearches)');

// ============================================================
// E. Viewing enrichment — new sections
// ============================================================

// Content type breakdown (movie/series/anime starts + completes)
assert.match(analyticsPage, /Content Type Breakdown/, 'E1a. Viewing has Content Type Breakdown section');
assert.match(analyticsPage, /m\.movieWatchStarts/, 'E1b. Viewing shows movieWatchStarts');
assert.match(analyticsPage, /m\.seriesWatchStarts/, 'E1c. Viewing shows seriesWatchStarts');
assert.match(analyticsPage, /m\.animeWatchStarts/, 'E1d. Viewing shows animeWatchStarts');
assert.match(analyticsPage, /m\.movieCompletedWatches/, 'E1e. Viewing shows movieCompletedWatches');
assert.match(analyticsPage, /m\.seriesCompletedWatches/, 'E1f. Viewing shows seriesCompletedWatches');
assert.match(analyticsPage, /m\.animeCompletedWatches/, 'E1g. Viewing shows animeCompletedWatches');
ok('E1. Viewing enrichment: Content Type Breakdown (movie/series/anime starts + completes)');

// Most Completed ranking
assert.match(analyticsPage, /Most Completed/, 'E2a. Viewing has Most Completed section');
assert.match(analyticsPage, /v\.mostCompleted/, 'E2b. Viewing renders v.mostCompleted data');
ok('E2. Viewing enrichment: Most Completed ranking');

// Trending ranking
assert.match(analyticsPage, /Trending/, 'E3a. Viewing has Trending section');
assert.match(analyticsPage, /v\.trending/, 'E3b. Viewing renders v.trending data');
ok('E3. Viewing enrichment: Trending ranking');

// Genre breakdown
assert.match(analyticsPage, /Genre Breakdown/, 'E4a. Viewing has Genre Breakdown section');
assert.match(analyticsPage, /v\.genres/, 'E4b. Viewing renders v.genres data');
ok('E4. Viewing enrichment: Genre Breakdown table');

// Search / Discovery analytics
assert.match(analyticsPage, /Discovery & Search/, 'E5a. Viewing has Discovery & Search section');
assert.match(analyticsPage, /v\.search\.totalSearches/, 'E5b. Viewing renders search totalSearches');
assert.match(analyticsPage, /v\.search\.uniqueSearchers/, 'E5c. Viewing renders search uniqueSearchers');
assert.match(analyticsPage, /v\.search\.noResultSearches/, 'E5d. Viewing renders search noResultSearches');
assert.match(analyticsPage, /v\.search\.topQueries/, 'E5e. Viewing renders search topQueries table');
ok('E5. Viewing enrichment: Discovery & Search analytics (KPIs + top queries table)');

// ============================================================
// F. Legacy redirect stubs remain intact
// ============================================================

const legacyRoutes: Array<[string, string, string]> = [
  ['users', 'src/routes/admin/users/+page.server.ts', 'users'],
  ['overview', 'src/routes/admin/users/overview/+page.server.ts', 'overview'],
  ['viewing', 'src/routes/admin/users/viewing/+page.server.ts', 'viewing'],
  ['providers', 'src/routes/admin/users/providers/+page.server.ts', 'providers'],
  ['retention', 'src/routes/admin/users/retention/+page.server.ts', 'retention'],
];

for (const [name, file, tab] of legacyRoutes) {
  const server = read(file);
  assert.match(server, /throw redirect\(303, `\/admin\/analytics\?/, `F1-${name}: server throws redirect(303)`);
  assert.match(server, new RegExp(`params\\.set\\('tab', '${tab}'`), `F1-${name}: server sets tab=${tab}`);
  assert.doesNotMatch(server, /requireAdmin/, `F1-${name}: server has no requireAdmin`);
}
ok('F1. All 5 legacy /admin/users/* redirect stubs remain intact');

// Client svelte files removed (cleanup pass) — server redirect is sufficient
for (const [name, file] of legacyRoutes) {
  const sveltePath = file.replace('+page.server.ts', '+page.svelte');
  assert.ok(!existsSync(new URL(`../${sveltePath}`, import.meta.url)), `F2-${name}: client +page.svelte removed (server redirect sufficient)`);
}
ok('F2. No client +page.svelte stubs (server redirect handles all cases)');

// ============================================================
// G. /admin/users/[userId] remains on AdminAppShell
// ============================================================

const userIdPage = read('src/routes/admin/users/[userId]/+page.svelte');
assert.match(userIdPage, /<AdminAppShell active="analytics">/, 'G1a. [userId] page uses AdminAppShell');
assert.match(userIdPage, /href="\/admin\/analytics\?tab=users"/, 'G1b. [userId] back-link points to canonical Analytics');
ok('G1. /admin/users/[userId] remains on AdminAppShell with canonical back-link');

// ============================================================
// H. No unused CSS (Phase 4 cleanup)
// ============================================================

assert.doesNotMatch(analyticsPage, /\.a2-kpi-comparison/, 'H1a. Unused .a2-kpi-comparison CSS removed (comparison display was removed from overview)');
ok('H1. Unused CSS cleaned up (a2-kpi-comparison selectors removed)');

console.log(`\nAdmin 2.0 Phase 4 tests passed (${passed} check groups).`);
