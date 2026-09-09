import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Upcoming Real Pagination Regression Test
//
// CRITICAL ACCEPTANCE TEST: loadUpcomingPage must NOT call loadUpcoming.
// The previous implementation called loadUpcoming() and sliced the
// result — that was response slicing, NOT bounded server-side pagination.
//
// The new implementation calls the individual source functions
// (loadUpcomingMovies, loadUpcomingSeries, loadUpcomingAnime) directly
// with BOUNDED candidate caps for page 1, so page 1 does NOT process
// the full month.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const upcomingSource = readFileSync(new URL('../src/lib/server/content/upcoming.ts', import.meta.url), 'utf8');
const pageServerSource = readFileSync(new URL('../src/routes/upcoming/+page.server.ts', import.meta.url), 'utf8');
const pageSvelteSource = readFileSync(new URL('../src/routes/upcoming/+page.svelte', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/routes/api/upcoming/+server.ts', import.meta.url), 'utf8');

// ============================================================
// 1. CRITICAL: loadUpcomingPage does NOT call loadUpcoming
// ============================================================
console.log('\n1. CRITICAL: loadUpcomingPage does NOT call loadUpcoming');

// Extract the loadUpcomingPage function body.
const pageFnMatch = upcomingSource.match(/export async function loadUpcomingPage[\s\S]*?\n\}/);
assert.ok(pageFnMatch, 'loadUpcomingPage function found');
const pageFnBody = pageFnMatch![0];

// The function body must NOT contain a call to loadUpcoming(filters)
// or loadUpcoming( — any form of calling the full-month aggregator.
assert.doesNotMatch(pageFnBody, /loadUpcoming\(filters\)/,
  'loadUpcomingPage does NOT call loadUpcoming(filters)');
assert.doesNotMatch(pageFnBody, /\bloadUpcoming\(/,
  'loadUpcomingPage does NOT call loadUpcoming() in any form');
ok('CRITICAL: loadUpcomingPage does NOT call loadUpcoming — calls source functions directly');

// ============================================================
// 2. loadUpcomingPage calls source functions directly
// ============================================================
console.log('\n2. loadUpcomingPage calls source functions directly');

assert.match(pageFnBody, /loadUpcomingMovies\(/,
  'loadUpcomingPage calls loadUpcomingMovies directly');
assert.match(pageFnBody, /loadUpcomingSeries\(/,
  'loadUpcomingPage calls loadUpcomingSeries directly');
assert.match(pageFnBody, /loadUpcomingAnime\(/,
  'loadUpcomingPage calls loadUpcomingAnime directly');
ok('loadUpcomingPage calls loadUpcomingMovies/Series/Anime directly (NOT through loadUpcoming)');

// ============================================================
// 3. Page 1 has bounded candidate caps
// ============================================================
console.log('\n3. Page 1 has bounded candidate caps');

assert.match(upcomingSource, /const PAGE_1_MOVIE_CANDIDATES = \d+/,
  'PAGE_1_MOVIE_CANDIDATES constant defined');
assert.match(upcomingSource, /const PAGE_1_SERIES_CANDIDATES = \d+/,
  'PAGE_1_SERIES_CANDIDATES constant defined');
assert.match(upcomingSource, /const PAGE_1_ANIME_CANDIDATES = \d+/,
  'PAGE_1_ANIME_CANDIDATES constant defined');

const movieCapMatch = upcomingSource.match(/const PAGE_1_MOVIE_CANDIDATES = (\d+)/);
const seriesCapMatch = upcomingSource.match(/const PAGE_1_SERIES_CANDIDATES = (\d+)/);
const animeCapMatch = upcomingSource.match(/const PAGE_1_ANIME_CANDIDATES = (\d+)/);
assert.ok(movieCapMatch && seriesCapMatch && animeCapMatch, 'all cap values extracted');

const movieCap = Number(movieCapMatch![1]);
const seriesCap = Number(seriesCapMatch![1]);
const animeCap = Number(animeCapMatch![1]);

// Page 1 caps must be SMALLER than the full-month caps.
assert.ok(movieCap < 200, `PAGE_1_MOVIE_CANDIDATES = ${movieCap} < 200 (UPCOMING_MOVIE_MAX_CANDIDATES)`);
assert.ok(seriesCap < 80, `PAGE_1_SERIES_CANDIDATES = ${seriesCap} < 80 (UPCOMING_TV_MAX_CANDIDATES)`);
assert.ok(animeCap < 20, `PAGE_1_ANIME_CANDIDATES = ${animeCap} < 20 (anime default cap)`);
ok(`Page 1 bounded caps: movies=${movieCap} (<200), series=${seriesCap} (<80), anime=${animeCap} (<20)`);

// ============================================================
// 4. Page 1 passes bounded caps to source functions
// ============================================================
console.log('\n4. Page 1 passes bounded caps to source functions');

assert.match(pageFnBody, /const isPage1 = page === 1/,
  'isPage1 flag computed');
assert.match(pageFnBody, /const movieMax = isPage1 \? PAGE_1_MOVIE_CANDIDATES : undefined/,
  'movieMax set to PAGE_1_MOVIE_CANDIDATES for page 1, undefined for page 2+');
assert.match(pageFnBody, /const seriesMax = isPage1 \? PAGE_1_SERIES_CANDIDATES : undefined/,
  'seriesMax set to PAGE_1_SERIES_CANDIDATES for page 1, undefined for page 2+');
assert.match(pageFnBody, /const animeMax = isPage1 \? PAGE_1_ANIME_CANDIDATES : undefined/,
  'animeMax set to PAGE_1_ANIME_CANDIDATES for page 1, undefined for page 2+');
// The maxCandidates parameter must be passed to each source function.
assert.match(pageFnBody, /loadUpcomingMovies\(.*movieMax\)/,
  'movieMax passed to loadUpcomingMovies');
assert.match(pageFnBody, /loadUpcomingSeries\(.*seriesMax\)/,
  'seriesMax passed to loadUpcomingSeries');
assert.match(pageFnBody, /loadUpcomingAnime\(.*animeMax\)/,
  'animeMax passed to loadUpcomingAnime');
ok('Page 1 passes bounded caps to source functions; page 2+ passes undefined (full caps)');

// ============================================================
// 5. Source functions accept maxCandidates parameter
// ============================================================
console.log('\n5. Source functions accept maxCandidates parameter');

assert.match(upcomingSource, /async function loadUpcomingMovies\(.*maxCandidates\?: number\)/,
  'loadUpcomingMovies accepts maxCandidates?: number');
assert.match(upcomingSource, /async function loadUpcomingSeries\(.*maxCandidates\?: number\)/,
  'loadUpcomingSeries accepts maxCandidates?: number');
assert.match(upcomingSource, /export async function loadUpcomingAnime\(.*maxCandidates\?: number\)/,
  'loadUpcomingAnime accepts maxCandidates?: number');
ok('All source functions accept optional maxCandidates parameter');

// ============================================================
// 6. Source functions use maxCandidates to bound enrichment N+1
// ============================================================
console.log('\n6. Source functions use maxCandidates to bound enrichment');

// Movies: candidateCap = min(maxCandidates, UPCOMING_MOVIE_MAX_CANDIDATES)
assert.match(upcomingSource, /const candidateCap = maxCandidates !== undefined \? Math\.min\(maxCandidates, UPCOMING_MOVIE_MAX_CANDIDATES\) : UPCOMING_MOVIE_MAX_CANDIDATES/,
  'loadUpcomingMovies uses candidateCap = min(maxCandidates, MAX) or MAX');
assert.match(upcomingSource, /candidates = \[\.\.\.rowsById\.values\(\)\]\.slice\(0, candidateCap\)/,
  'loadUpcomingMovies slices candidates to candidateCap');

// Series: same pattern
assert.match(upcomingSource, /const candidateCap = maxCandidates !== undefined \? Math\.min\(maxCandidates, UPCOMING_TV_MAX_CANDIDATES\) : UPCOMING_TV_MAX_CANDIDATES/,
  'loadUpcomingSeries uses candidateCap = min(maxCandidates, MAX) or MAX');
assert.match(upcomingSource, /\.slice\(0, candidateCap\)/,
  'loadUpcomingSeries slices candidates to candidateCap');

// Anime: same pattern
assert.match(upcomingSource, /const animeCap = maxCandidates !== undefined \? Math\.min\(maxCandidates, 20\) : 20/,
  'loadUpcomingAnime uses animeCap = min(maxCandidates, 20) or 20');
assert.match(upcomingSource, /\.slice\(0, animeCap\)/,
  'loadUpcomingAnime slices candidates to animeCap');
ok('Source functions bound enrichment N+1 by maxCandidates (page 1 processes fewer candidates)');

// ============================================================
// 7. Cache keys include maxCandidates dimension
// ============================================================
console.log('\n7. Cache keys include maxCandidates dimension');

// Series cache key must include maxCandidates.
assert.match(upcomingSource, /upcoming:series:.*\$\{maxCandidates \?\? 'full'\}/,
  'series cache key includes maxCandidates dimension (bounded vs full)');
// Anime cache key must include maxCandidates.
assert.match(upcomingSource, /upcoming:anime:.*\$\{maxCandidates \?\? 'full'\}/,
  'anime cache key includes maxCandidates dimension (bounded vs full)');
ok('Cache keys include maxCandidates dimension (page 1 bounded ≠ page 2+ full)');

// ============================================================
// 8. Page size + hasNextPage
// ============================================================
console.log('\n8. Page size + hasNextPage');

assert.match(upcomingSource, /export const UPCOMING_PAGE_SIZE = 24/,
  'UPCOMING_PAGE_SIZE = 24');
assert.match(pageFnBody, /const startIndex = \(page - 1\) \* pageSize/,
  'startIndex = (page-1) * pageSize');
assert.match(pageFnBody, /const endIndex = startIndex \+ pageSize/,
  'endIndex = startIndex + pageSize');
assert.match(pageFnBody, /const hasNextPage = endIndex < deduped\.length/,
  'hasNextPage = endIndex < deduped.length');
ok('Page size = 24; hasNextPage correctly computed from deduped length');

// ============================================================
// 9. Deduplication by event ID
// ============================================================
console.log('\n9. Deduplication by event ID');

assert.match(pageFnBody, /const seen = new Set<string>\(\)/,
  'dedup Set exists');
assert.match(pageFnBody, /if \(seen\.has\(item\.id\)\) return false/,
  'duplicate event IDs filtered');
assert.match(pageFnBody, /seen\.add\(item\.id\)/,
  'event IDs added to dedup Set');
ok('Deduplication by event ID prevents duplicate events across pages');

// ============================================================
// 10. Chronological ordering
// ============================================================
console.log('\n10. Chronological ordering');

assert.match(pageFnBody, /allItems\.sort\(\(a, b\) => a\.timestamp - b\.timestamp\)/,
  'items sorted by timestamp (chronological)');
ok('Chronological ordering preserved across all sources');

// ============================================================
// 11. SSR route returns page 1
// ============================================================
console.log('\n11. SSR route returns page 1');

assert.match(pageServerSource, /loadUpcomingPage\(\{ month, year, type, language \}, 1\)/,
  'SSR calls loadUpcomingPage with page=1');
ok('SSR route returns page 1 (bounded work)');

// ============================================================
// 12. API endpoint for subsequent pages
// ============================================================
console.log('\n12. API endpoint for subsequent pages');

assert.match(apiSource, /loadUpcomingPage\(\{ month, year, type, language \}, page\)/,
  'API calls loadUpcomingPage with the requested page number');
ok('API endpoint serves page 2+ via loadUpcomingPage');

// ============================================================
// 13. UI infinite scroll
// ============================================================
console.log('\n13. UI infinite scroll');

assert.match(pageSvelteSource, /IntersectionObserver/,
  'UI uses IntersectionObserver');
assert.match(pageSvelteSource, /load-more-sentinel/,
  'sentinel element exists');
assert.match(pageSvelteSource, /async function loadMore\(\)/,
  'loadMore function exists');
assert.match(pageSvelteSource, /fetch\(`\/api\/upcoming/,
  'loadMore fetches from /api/upcoming');
assert.match(pageSvelteSource, /const existing = new Set\(allItems\.map\(\(i\) => i\.id\)\)/,
  'client-side dedup by event ID');
ok('UI infinite scroll with IntersectionObserver + sentinel + /api/upcoming + client dedup');

// ============================================================
// 14. Snapshot preserves loaded items + pagination state
// ============================================================
console.log('\n14. Snapshot preserves loaded items');

assert.match(pageSvelteSource, /export const snapshot = \{/,
  'snapshot exists');
assert.match(pageSvelteSource, /capture: \(\) => \(\{ allItems, currentPage, hasNextPage \}\)/,
  'snapshot.capture preserves allItems + currentPage + hasNextPage');
ok('Snapshot preserves loaded items + pagination state across back navigation');

// ============================================================
// 15. No navigation interference
// ============================================================
console.log('\n15. No navigation interference');

const pageSvelteNoComments = pageSvelteSource.replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '');
assert.doesNotMatch(pageSvelteNoComments, /history\.back/,
  'no history.back()');
assert.doesNotMatch(pageSvelteNoComments, /history\.pushState/,
  'no history.pushState()');
assert.doesNotMatch(pageSvelteNoComments, /popstate/,
  'no popstate listener');
ok('No navigation interference from Upcoming pagination');

// ============================================================
// 16. appendReturnTo preserved (back navigation contract)
// ============================================================
console.log('\n16. appendReturnTo preserved');

assert.match(pageSvelteSource, /appendReturnTo\(path, currentReturnTo\)/,
  'detailHref still uses appendReturnTo');
ok('appendReturnTo + back navigation contract preserved');

// ============================================================
// 17. Filters preserved across pages
// ============================================================
console.log('\n17. Filters preserved across pages');

assert.match(pageSvelteSource, /month: String\(data\.filters\.month\)/,
  'loadMore passes month filter');
assert.match(pageSvelteSource, /year: String\(data\.filters\.year\)/,
  'loadMore passes year filter');
assert.match(pageSvelteSource, /type: data\.filters\.type/,
  'loadMore passes type filter');
assert.match(pageSvelteSource, /language: data\.filters\.language/,
  'loadMore passes language filter');
ok('Filters preserved across page requests (month/year/type/language)');

// ============================================================
// 18. Pagination reset on filter change
// ============================================================
console.log('\n18. Pagination reset on filter change');

assert.match(pageSvelteSource, /\$effect\(\(\) => \{[\s\S]*?allItems = \[\.\.\.data\.items\]/,
  '$effect resets allItems when SSR data changes');
ok('Pagination resets cleanly when filters change');

// ============================================================
// 19. Existing loadUpcoming preserved (not destroyed)
// ============================================================
console.log('\n19. Existing loadUpcoming preserved');

assert.match(upcomingSource, /export async function loadUpcoming\(filters: UpcomingFilters\)/,
  'loadUpcoming still exists (not destroyed — used by tests + diagnostics)');
ok('Existing loadUpcoming preserved (not destroyed)');

console.log(`\nUpcoming real pagination tests passed (${passed} check groups).`);
