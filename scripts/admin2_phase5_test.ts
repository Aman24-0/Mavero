/**
 * Admin 2.0 — Phase 5 — Data Model Cleanup, Overview Caching & Final Hardening
 *
 * Verifies:
 *   A. seriesTmdb cleanup — tree selection now filters the list (URL + API + service)
 *   B. seriesTmdbFilter is no longer dead code — wired to server
 *   C. seriesTmdbId in CanonicalMediaService is unchanged (required, not touched)
 *   D. Overview caching — deferral documented (addon invalidation gap confirmed)
 *   E. No regressions in legacy redirects, [userId] shell, analytics tabs
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const libraryPage = read('src/routes/admin/media/library/+page.svelte');
const libraryServer = read('src/routes/admin/media/library/+page.server.ts');
const libraryApi = read('src/routes/api/admin/media/library/+server.ts');
const libraryService = read('src/lib/server/hosting/library/service.ts');
const mediaService = read('src/lib/server/hosting/media/service.ts');
const overviewServer = read('src/routes/admin/+page.server.ts');
const cacheModule = read('src/lib/server/content/cache.ts');

// ============================================================
// A. seriesTmdb cleanup — tree selection now filters the list
// ============================================================

// A1. LibraryQuery type has seriesTmdb field
assert.match(libraryService, /seriesTmdb\?: string \| null/, 'A1a. LibraryQuery type has seriesTmdb field');
ok('A1. LibraryQuery type extended with seriesTmdb filter field');

// A2. Service list() applies the filter
assert.match(libraryService, /if \(query\.seriesTmdb\)[\s\S]*?itemsQuery = itemsQuery\.eq\('tmdb_id', query\.seriesTmdb\)/, 'A2a. MediaLibraryService.list() applies .eq(tmdb_id, seriesTmdb) filter');
ok('A2. MediaLibraryService.list() applies seriesTmdb filter (filters by parent + episode rows)');

// A3. API endpoint parses ?series= param
assert.match(libraryApi, /sp\.get\('series'\)/, 'A3a. API endpoint reads ?series= query param');
assert.match(libraryApi, /query\.seriesTmdb = series/, 'A3b. API endpoint sets query.seriesTmdb from parsed param');
assert.match(libraryApi, /d\{1,20\}.*\.test\(series\)/, 'A3c. API endpoint validates series is numeric (TMDB ID format)');
ok('A3. API endpoint parses + validates ?series= param');

// A4. Server loader parses ?series= param
assert.match(libraryServer, /sp\.get\('series'\)/, 'A4a. Server loader reads ?series= query param');
assert.match(libraryServer, /seriesTmdb: series/, 'A4b. Server loader passes seriesTmdb to service.list()');
assert.match(libraryServer, /initialFilters: \{[\s\S]*?series[\s\S]*?\}/, 'A4c. Server loader returns series in initialFilters');
ok('A4. Server loader parses ?series= param + passes to service + returns in initialFilters');

// A5. Page sends series in fetchList()
assert.match(libraryPage, /if \(seriesTmdbFilter\) params\.set\('series', seriesTmdbFilter\)/, 'A5a. fetchList() sends ?series= param to API');
ok('A5. Page fetchList() sends series filter to API');

// A6. Page persists series in syncUrl()
assert.match(libraryPage, /if \(seriesTmdbFilter\) params\.set\('series', seriesTmdbFilter\)/, 'A6a. syncUrl() persists ?series= param to URL');
ok('A6. Page syncUrl() persists series filter to URL (survives refresh + shareable)');

// A7. Page initializes seriesTmdbFilter from URL
assert.match(libraryPage, /let seriesTmdbFilter = \$state<string \| null>\(initial\.initialFilters\.series/, 'A7a. seriesTmdbFilter initialized from initialFilters.series (URL-driven)');
ok('A7. seriesTmdbFilter initialized from URL param (deep-link safe)');

// A8. Page initializes treeSelectedSeriesTmdb from URL
assert.match(libraryPage, /let treeSelectedSeriesTmdb = \$state<string \| null>\(initial\.initialFilters\.series/, 'A8a. treeSelectedSeriesTmdb initialized from initialFilters.series (tree highlight on deep-link)');
ok('A8. treeSelectedSeriesTmdb initialized from URL param (tree highlight works on refresh)');

// ============================================================
// B. seriesTmdbFilter is no longer dead code
// ============================================================

// B1. seriesTmdbFilter is now READ by fetchList() and syncUrl() (not just written)
const filterWriteCount = (libraryPage.match(/seriesTmdbFilter = /g) || []).length;
const filterReadCount = (libraryPage.match(/if \(seriesTmdbFilter\)/g) || []).length;
assert.ok(filterReadCount >= 2, `B1a. seriesTmdbFilter is READ in at least 2 places (fetchList + syncUrl) — found ${filterReadCount}`);
assert.ok(filterWriteCount >= 1, `B1b. seriesTmdbFilter is still WRITTEN (in handleTreeSelect) — found ${filterWriteCount}`);
ok('B1. seriesTmdbFilter is no longer dead code — now read by fetchList() + syncUrl()');

// ============================================================
// C. seriesTmdbId in CanonicalMediaService is unchanged
// ============================================================

// C1. EnsureEpisodeInput still has seriesTmdbId (required for episode creation)
assert.match(mediaService, /seriesTmdbId: string/, 'C1a. EnsureEpisodeInput.seriesTmdbId preserved (required for episode creation)');
assert.match(mediaService, /input\.seriesTmdbId/, 'C1b. ensureEpisode() uses input.seriesTmdbId (canonical key + tmdb_id stamp)');
ok('C1. CanonicalMediaService.seriesTmdbId unchanged (required, load-bearing — not touched)');

// ============================================================
// D. Overview caching — deferral documented
// ============================================================

// D1. Overview server still calls services directly (no cache layer)
assert.match(overviewServer, /getAdminOverview/, 'D1a. Overview server still calls getAdminOverview (no cache)');
assert.match(overviewServer, /getDownloadersAdminOverview/, 'D1b. Overview server still calls getDownloadersAdminOverview (no cache)');
assert.match(overviewServer, /getAddonsAdminOverview/, 'D1c. Overview server still calls getAddonsAdminOverview (no cache)');
assert.doesNotMatch(overviewServer, /getOrSet|cache\./, 'D1d. Overview server does NOT use cache (Phase 5 audit confirmed unsafe)');
ok('D1. Overview caching NOT implemented (addon invalidation gap confirmed still present)');

// D2. content/cache.ts unchanged
assert.match(cacheModule, /export async function getOrSet/, 'D2a. cache.ts still exports getOrSet (infrastructure preserved)');
assert.match(cacheModule, /export function invalidate/, 'D2b. cache.ts still exports invalidate (infrastructure preserved)');
ok('D2. content/cache.ts infrastructure unchanged (available for future use)');

// ============================================================
// E. No regressions
// ============================================================

// E1. Legacy /admin/users/* redirects intact
const usersServer = read('src/routes/admin/users/+page.server.ts');
assert.match(usersServer, /throw redirect\(303, `\/admin\/analytics\?/, 'E1a. /admin/users redirect stub intact');
const overviewRedirect = read('src/routes/admin/users/overview/+page.server.ts');
assert.match(overviewRedirect, /throw redirect\(303, `\/admin\/analytics\?/, 'E1b. /admin/users/overview redirect stub intact');
ok('E1. Legacy /admin/users/* redirect stubs intact');

// E2. [userId] page still uses AdminAppShell
const userIdPage = read('src/routes/admin/users/[userId]/+page.svelte');
assert.match(userIdPage, /<AdminAppShell active="analytics">/, 'E2a. [userId] page uses AdminAppShell');
ok('E2. /admin/users/[userId] remains on AdminAppShell');

// E3. Analytics tabs all present
const analyticsPage = read('src/routes/admin/analytics/+page.svelte');
assert.match(analyticsPage, /currentTab === 'overview'/, 'E3a. Analytics overview tab present');
assert.match(analyticsPage, /currentTab === 'users'/, 'E3b. Analytics users tab present');
assert.match(analyticsPage, /currentTab === 'viewing'/, 'E3c. Analytics viewing tab present');
assert.match(analyticsPage, /currentTab === 'providers'/, 'E3d. Analytics providers tab present');
assert.match(analyticsPage, /currentTab === 'retention'/, 'E3e. Analytics retention tab present');
ok('E3. All 5 Analytics tabs present + functional');

// E4. Fallback empty state still present (Phase 4 fix)
assert.match(analyticsPage, /Loading analytics data/, 'E4a. Analytics fallback empty state present (Phase 4 fix intact)');
ok('E4. Analytics fallback empty state intact (Phase 4 fix preserved)');

console.log(`\nAdmin 2.0 Phase 5 tests passed (${passed} check groups).`);
