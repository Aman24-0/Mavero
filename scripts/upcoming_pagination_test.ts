import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Upcoming Pagination Regression Test
//
// BUG 2: Upcoming loaded the entire month before showing anything
// (4–5 second initial load). The fix introduces real server-side
// pagination: the SSR load returns only page 1 (~24 items), and
// subsequent pages are loaded via /api/upcoming infinite scroll.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const upcomingSource = readFileSync(new URL('../src/lib/server/content/upcoming.ts', import.meta.url), 'utf8');
const pageServerSource = readFileSync(new URL('../src/routes/upcoming/+page.server.ts', import.meta.url), 'utf8');
const pageSvelteSource = readFileSync(new URL('../src/routes/upcoming/+page.svelte', import.meta.url), 'utf8');

// Strip comments for some checks.
const upcomingNoComments = upcomingSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ============================================================
// 1. PAGE_SIZE constant exists
// ============================================================
console.log('\n1. PAGE_SIZE constant');

assert.match(upcomingSource, /export const UPCOMING_PAGE_SIZE = \d+/,
  'UPCOMING_PAGE_SIZE exported');
const psMatch = upcomingSource.match(/export const UPCOMING_PAGE_SIZE = (\d+)/);
assert.ok(psMatch, 'UPCOMING_PAGE_SIZE value extracted');
const psVal = Number(psMatch![1]);
assert.ok(psVal >= 20 && psVal <= 30,
  `UPCOMING_PAGE_SIZE = ${psVal} (within 20–30 target range)`);
ok(`Page size = ${psVal} (within 20–30 target)`);

// ============================================================
// 2. loadUpcomingPage function exists
// ============================================================
console.log('\n2. loadUpcomingPage function');

assert.match(upcomingSource, /export async function loadUpcomingPage\(filters: UpcomingFilters, page: number = 1\)/,
  'loadUpcomingPage exported with filters + page params');
assert.match(upcomingSource, /export type UpcomingPageResult = \{[\s\S]*?items: UpcomingItem\[\][\s\S]*?page: number[\s\S]*?pageSize: number[\s\S]*?hasNextPage: boolean/,
  'UpcomingPageResult type has items, page, pageSize, hasNextPage');
ok('loadUpcomingPage + UpcomingPageResult type exist');

// ============================================================
// 3. loadUpcomingPage returns a bounded slice
// ============================================================
console.log('\n3. loadUpcomingPage returns a bounded slice');

assert.match(upcomingSource, /const startIndex = \(page - 1\) \* pageSize/,
  'startIndex = (page - 1) * pageSize');
assert.match(upcomingSource, /const endIndex = startIndex \+ pageSize/,
  'endIndex = startIndex + pageSize');
assert.match(upcomingSource, /const pageItems = fullResult\.items\.slice\(startIndex, endIndex\)/,
  'pageItems = fullResult.items.slice(startIndex, endIndex)');
assert.match(upcomingSource, /const hasNextPage = endIndex < fullResult\.items\.length/,
  'hasNextPage = endIndex < fullResult.items.length');
ok('loadUpcomingPage slices the cached result into pages');

// ============================================================
// 4. SSR route returns only page 1
// ============================================================
console.log('\n4. SSR route returns page 1');

assert.match(pageServerSource, /loadUpcomingPage\(\{ month, year, type, language \}, 1\)/,
  'SSR load calls loadUpcomingPage with page=1');
assert.match(pageServerSource, /items: result\.items/,
  'SSR returns result.items (page 1 only)');
assert.match(pageServerSource, /hasNextPage: result\.hasNextPage/,
  'SSR returns hasNextPage');
assert.match(pageServerSource, /page: result\.page/,
  'SSR returns page number');
ok('SSR route returns only page 1 (~24 items) + pagination metadata');

// ============================================================
// 5. API endpoint exists for subsequent pages
// ============================================================
console.log('\n5. API endpoint for subsequent pages');

const apiSource = readFileSync(new URL('../src/routes/api/upcoming/+server.ts', import.meta.url), 'utf8');
assert.match(apiSource, /export const GET: RequestHandler/,
  '/api/upcoming GET handler exists');
assert.match(apiSource, /loadUpcomingPage\(\{ month, year, type, language \}, page\)/,
  'API calls loadUpcomingPage with the requested page');
assert.match(apiSource, /const page = Math\.max\(1, Number\(url\.searchParams\.get\('page'\)\) \|\| 1\)/,
  'API parses page from query param');
ok('/api/upcoming endpoint exists for infinite scroll');

// ============================================================
// 6. UI infinite scroll (IntersectionObserver + sentinel)
// ============================================================
console.log('\n6. UI infinite scroll');

assert.match(pageSvelteSource, /IntersectionObserver/,
  'Upcoming page uses IntersectionObserver');
assert.match(pageSvelteSource, /rootMargin: '400px 0px'/,
  'IntersectionObserver has 400px rootMargin (preload before visible)');
assert.match(pageSvelteSource, /load-more-sentinel/,
  'sentinel element exists');
assert.match(pageSvelteSource, /bind:this=\{sentinelEl\}/,
  'sentinel element bound');
assert.match(pageSvelteSource, /async function loadMore\(\)/,
  'loadMore function exists');
assert.match(pageSvelteSource, /fetch\(`\/api\/upcoming\?\$\{params\.toString\(\)\}`\)/,
  'loadMore fetches from /api/upcoming');
ok('UI uses IntersectionObserver + sentinel + /api/upcoming for infinite scroll');

// ============================================================
// 7. Deduplication — no duplicate events across pages
// ============================================================
console.log('\n7. No duplicate events across pages');

assert.match(pageSvelteSource, /const existing = new Set\(allItems\.map\(\(i\) => i\.id\)\)/,
  'loadMore deduplicates by event ID');
assert.match(pageSvelteSource, /const newItems = \(payload\.items as UpcomingItem\[\]\)\.filter\(\(i\) => !existing\.has\(i\.id\)\)/,
  'loadMore filters out already-loaded items');
ok('Deduplication by event ID prevents duplicate events across pages');

// ============================================================
// 8. Stale request protection
// ============================================================
console.log('\n8. Stale request protection');

assert.match(pageSvelteSource, /let requestSeq = 0/,
  'requestSeq counter exists');
assert.match(pageSvelteSource, /const seq = \+\+requestSeq/,
  'loadMore increments requestSeq');
assert.match(pageSvelteSource, /if \(seq !== requestSeq\) return/,
  'loadMore ignores stale responses');
ok('Stale request protection prevents race conditions');

// ============================================================
// 9. Loading indicator
// ============================================================
console.log('\n9. Loading indicator');

assert.match(pageSvelteSource, /loadingMore/,
  'loadingMore state exists');
assert.match(pageSvelteSource, /\{#if loadingMore\}/,
  'loading indicator shown when loadingMore is true');
assert.match(pageSvelteSource, /Loading more…/,
  'loading indicator text exists');
ok('Inline loading indicator at the bottom (no blocking spinner)');

// ============================================================
// 10. Pagination reset on filter change
// ============================================================
console.log('\n10. Pagination reset on filter change');

assert.match(pageSvelteSource, /\$effect\(\(\) => \{[\s\S]*?allItems = \[\.\.\.data\.items\]/,
  '$effect resets allItems when SSR data changes (filter change)');
assert.match(pageSvelteSource, /currentPage = data\.page \?\? 1/,
  '$effect resets currentPage');
assert.match(pageSvelteSource, /hasNextPage = data\.hasNextPage \?\? false/,
  '$effect resets hasNextPage');
ok('Pagination resets cleanly when Month/Year/Type/Language changes');

// ============================================================
// 11. Snapshot preserves loaded items + pagination state
// ============================================================
console.log('\n11. Snapshot preserves loaded items');

assert.match(pageSvelteSource, /export const snapshot = \{/,
  'Upcoming page exports snapshot');
assert.match(pageSvelteSource, /capture: \(\) => \(\{ allItems, currentPage, hasNextPage \}\)/,
  'snapshot.capture preserves allItems + currentPage + hasNextPage');
assert.match(pageSvelteSource, /restore: \(value: any\) => \{[\s\S]*?allItems = value\.allItems/,
  'snapshot.restore restores allItems');
ok('Snapshot preserves loaded items + pagination state across back navigation');

// ============================================================
// 12. No history/navigation interference
// ============================================================
console.log('\n12. No navigation interference');

const pageSvelteNoComments = pageSvelteSource.replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '');
assert.doesNotMatch(pageSvelteNoComments, /history\.back/,
  'no history.back()');
assert.doesNotMatch(pageSvelteNoComments, /history\.pushState/,
  'no history.pushState()');
assert.doesNotMatch(pageSvelteNoComments, /popstate/,
  'no popstate listener');
assert.doesNotMatch(pageSvelteNoComments, /disableScrollHandling/,
  'no disableScrollHandling');
ok('No navigation interference from Upcoming pagination');

// ============================================================
// 13. appendReturnTo preserved (back navigation contract)
// ============================================================
console.log('\n13. appendReturnTo preserved');

assert.match(pageSvelteSource, /appendReturnTo\(path, currentReturnTo\)/,
  'detailHref still uses appendReturnTo (back navigation contract)');
assert.ok(pageSvelteSource.includes('currentReturnTo = $derived(`${page.url.pathname}${page.url.search}${page.url.hash}`)'),
  'currentReturnTo preserves full URL (pathname + search + hash)');
ok('appendReturnTo + back navigation contract preserved');

console.log(`\nUpcoming pagination tests passed (${passed} check groups).`);
