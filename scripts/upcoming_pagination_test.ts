import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Upcoming Cursor-Based Pagination Regression Test
//
// Verifies the cursor-based pagination architecture:
//   - loadUpcomingPage does NOT call loadUpcoming
//   - Serializable source cursor (movie/series/anime candidateIndex)
//   - Each request processes only SOURCE_CANDIDATE_BATCH per source
//   - Page 2 continues from the cursor position (never restarts from 0)
//   - Independent movie/series/anime cursors for type=all
//   - Cursor is serializable (parseCursor + serializeCursor)
//   - hasNextPage correct (false when all sources exhausted)
//   - No duplicate event IDs
//   - Chronological merge
//   - No navigation interference

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

const pageFnMatch = upcomingSource.match(/export async function loadUpcomingPage[\s\S]*?\n\}/);
assert.ok(pageFnMatch, 'loadUpcomingPage function found');
const pageFnBody = pageFnMatch![0];

assert.doesNotMatch(pageFnBody, /\bloadUpcoming\(/,
  'loadUpcomingPage does NOT call loadUpcoming() in any form');
ok('CRITICAL: loadUpcomingPage does NOT call loadUpcoming');

// ============================================================
// 2. Cursor type exists and is serializable
// ============================================================
console.log('\n2. Cursor type + serialization');

assert.match(upcomingSource, /export type SourceCursor = \{[\s\S]*?candidateIndex: number[\s\S]*?exhausted: boolean/,
  'SourceCursor type has candidateIndex + exhausted');
assert.match(upcomingSource, /export type UpcomingCursor = \{[\s\S]*?movie: SourceCursor[\s\S]*?series: SourceCursor[\s\S]*?anime: SourceCursor/,
  'UpcomingCursor type has independent movie/series/anime cursors');
assert.match(upcomingSource, /export function parseCursor\(raw: string \| null \| undefined\): UpcomingCursor/,
  'parseCursor function exists');
assert.match(upcomingSource, /export function serializeCursor\(cursor: UpcomingCursor\): string/,
  'serializeCursor function exists');
assert.match(upcomingSource, /encodeURIComponent\(JSON\.stringify\(cursor\)\)/,
  'serializeCursor uses JSON.stringify + encodeURIComponent (serializable)');
assert.match(upcomingSource, /JSON\.parse\(decodeURIComponent\(raw\)\)/,
  'parseCursor uses JSON.parse + decodeURIComponent (deserializable)');
ok('Cursor type + parseCursor + serializeCursor exist and are JSON-serializable');

// ============================================================
// 3. loadUpcomingPage accepts a cursor parameter
// ============================================================
console.log('\n3. loadUpcomingPage accepts cursor');

assert.match(upcomingSource, /export async function loadUpcomingPage\([\s\S]*?incomingCursor\?: UpcomingCursor/,
  'loadUpcomingPage accepts optional incomingCursor parameter');
assert.match(pageFnBody, /const cursor = incomingCursor \?\? emptyCursor\(\)/,
  'loadUpcomingPage uses incomingCursor or empty cursor for page 1');
ok('loadUpcomingPage accepts incomingCursor (page 2+ continues from cursor)');

// ============================================================
// 4. UpcomingPageResult returns a cursor
// ============================================================
console.log('\n4. UpcomingPageResult returns cursor');

assert.match(upcomingSource, /export type UpcomingPageResult = \{[\s\S]*?cursor: UpcomingCursor/,
  'UpcomingPageResult type has cursor field');
assert.match(pageFnBody, /cursor: \{[\s\S]*?movie: nextMovieCursor[\s\S]*?series: nextSeriesCursor[\s\S]*?anime: nextAnimeCursor/,
  'loadUpcomingPage returns the updated cursor with all three source positions');
ok('UpcomingPageResult returns the cursor for the next request');

// ============================================================
// 5. Cursor-based batch loaders exist
// ============================================================
console.log('\n5. Cursor-based batch loaders');

assert.match(upcomingSource, /async function loadMovieBatch\([\s\S]*?cursor: SourceCursor/,
  'loadMovieBatch function exists with cursor parameter');
assert.match(upcomingSource, /async function loadSeriesBatch\([\s\S]*?cursor: SourceCursor/,
  'loadSeriesBatch function exists with cursor parameter');
assert.match(upcomingSource, /SOURCE_CANDIDATE_BATCH = \d+/,
  'SOURCE_CANDIDATE_BATCH constant defined');
ok('Cursor-based batch loaders (loadMovieBatch, loadSeriesBatch) exist');

// ============================================================
// 6. Batch loaders process only SOURCE_CANDIDATE_BATCH per request
// ============================================================
console.log('\n6. Batch size bounded per request');

assert.match(upcomingSource, /SOURCE_CANDIDATE_BATCH = (\d+)/);
const batchMatch = upcomingSource.match(/SOURCE_CANDIDATE_BATCH = (\d+)/);
assert.ok(batchMatch, 'SOURCE_CANDIDATE_BATCH value extracted');
const batchVal = Number(batchMatch![1]);
assert.ok(batchVal >= 20 && batchVal <= 50,
  `SOURCE_CANDIDATE_BATCH = ${batchVal} (within 20–50 range)`);

// Movie batch: slice from cursor position to cursor + BATCH
assert.match(upcomingSource, /const startIdx = Math\.min\(cursor\.candidateIndex, allCandidates\.length\)/,
  'loadMovieBatch starts from cursor.candidateIndex');
assert.match(upcomingSource, /const batch = allCandidates\.slice\(startIdx, startIdx \+ SOURCE_CANDIDATE_BATCH\)/,
  'loadMovieBatch processes only SOURCE_CANDIDATE_BATCH candidates');

// Series batch: same pattern
assert.match(upcomingSource, /const startIdx = Math\.min\(cursor\.candidateIndex, filtered\.length\)/,
  'loadSeriesBatch starts from cursor.candidateIndex');
assert.match(upcomingSource, /const batch = filtered\.slice\(startIdx, startIdx \+ SOURCE_CANDIDATE_BATCH\)/,
  'loadSeriesBatch processes only SOURCE_CANDIDATE_BATCH candidates');
ok(`Batch size = ${batchVal} per source per request (bounded, not full month)`);

// ============================================================
// 7. Batch loaders return nextCursor (advances the position)
// ============================================================
console.log('\n7. Batch loaders advance the cursor');

assert.match(upcomingSource, /const nextIdx = startIdx \+ batch\.length/,
  'nextIdx = startIdx + batch.length (cursor advances by batch size)');
assert.match(upcomingSource, /nextCursor: \{ candidateIndex: nextIdx, exhausted: nextIdx >= allCandidates\.length, pending: \[\] \}/,
  'loadMovieBatch returns nextCursor with advanced candidateIndex + exhausted flag');
assert.match(upcomingSource, /nextCursor: \{ candidateIndex: nextIdx, exhausted: nextIdx >= filtered\.length, pending: \[\] \}/,
  'loadSeriesBatch returns nextCursor with advanced candidateIndex + exhausted flag');
ok('Batch loaders advance the cursor (candidateIndex += batch.length)');

// ============================================================
// 8. Page 2+ continues from cursor (does NOT restart from 0)
// ============================================================
console.log('\n8. Page 2+ continues from cursor');

// loadUpcomingPage must check cursor.movie.exhausted etc. before
// calling the batch loaders — exhausted sources are skipped.
assert.match(pageFnBody, /if \(wantMovies && \(!cursor\.movie\.exhausted \|\| cursor\.movie\.pending\.length > 0\)\)/,
  'loadUpcomingPage skips movie source when exhausted AND no pending');
assert.match(pageFnBody, /if \(wantSeries && \(!cursor\.series\.exhausted \|\| cursor\.series\.pending\.length > 0\)\)/,
  'loadUpcomingPage skips series source when exhausted AND no pending');
assert.match(pageFnBody, /if \(wantAnime && \(!cursor\.anime\.exhausted \|\| cursor\.anime\.pending\.length > 0\)\)/,
  'loadUpcomingPage skips anime source when exhausted AND no pending');
// The batch loaders receive the cursor from the incoming request.
assert.match(pageFnBody, /loadMovieBatch\(.*cursor\.movie\)/,
  'loadMovieBatch receives cursor.movie (continues from previous position)');
assert.match(pageFnBody, /loadSeriesBatch\(.*cursor\.series, false\)/,
  'loadSeriesBatch receives cursor.series');
assert.match(pageFnBody, /loadSeriesBatch\(.*cursor\.anime, true\)/,
  'loadSeriesBatch receives cursor.anime (isAnime=true)');
ok('Page 2+ passes the incoming cursor to batch loaders (continues, never restarts)');

// ============================================================
// 9. Independent movie/series/anime cursors for type=all
// ============================================================
console.log('\n9. Independent source cursors for type=all');

assert.match(pageFnBody, /let movieCursor = cursor\.movie/,
  'movieCursor tracked independently');
assert.match(pageFnBody, /let seriesCursor = cursor\.series/,
  'seriesCursor tracked independently');
assert.match(pageFnBody, /let animeCursor = cursor\.anime/,
  'animeCursor tracked independently');
assert.match(pageFnBody, /cursor: \{[\s\S]*?movie: nextMovieCursor[\s\S]*?series: nextSeriesCursor[\s\S]*?anime: nextAnimeCursor/,
  'returned cursor has all three independent source positions');
ok('Independent movie/series/anime cursors preserved across requests');

// ============================================================
// 10. FIX 1: hasNextPage only checks ACTIVE source cursors
// ============================================================
console.log('\n10. FIX 1: hasNextPage only checks active sources');

// hasNextPage must use movieActive/seriesActive/animeActive gates so
// an unused source's non-exhausted cursor doesn't keep it true forever.
assert.match(pageFnBody, /const movieActive = wantMovies/,
  'movieActive flag computed');
assert.match(pageFnBody, /const seriesActive = wantSeries/,
  'seriesActive flag computed');
assert.match(pageFnBody, /const animeActive = wantAnime/,
  'animeActive flag computed');
assert.match(pageFnBody, /const hasNextPage =[\s\S]*?movieActive &&/,
  'hasNextPage gated by movieActive');
assert.match(pageFnBody, /seriesActive &&/,
  'hasNextPage gated by seriesActive');
assert.match(pageFnBody, /animeActive &&/,
  'hasNextPage gated by animeActive');
// Must also check pending (overflow events stored in cursor).
assert.match(pageFnBody, /nextMovieCursor\.pending\.length > 0 \|\| !nextMovieCursor\.exhausted/,
  'hasNextPage checks movie pending OR not-exhausted');
assert.match(pageFnBody, /nextSeriesCursor\.pending\.length > 0 \|\| !nextSeriesCursor\.exhausted/,
  'hasNextPage checks series pending OR not-exhausted');
assert.match(pageFnBody, /nextAnimeCursor\.pending\.length > 0 \|\| !nextAnimeCursor\.exhausted/,
  'hasNextPage checks anime pending OR not-exhausted');
ok('FIX 1: hasNextPage only checks ACTIVE source cursors (single-type filters work correctly)');

// ============================================================
// 11. Deduplication by event ID
// ============================================================
console.log('\n11. Deduplication by event ID');

assert.match(pageFnBody, /const seen = new Set<string>\(\)/,
  'dedup Set exists');
assert.match(pageFnBody, /if \(seen\.has\(item\.id\)\) return false/,
  'duplicate event IDs filtered');
ok('Deduplication by event ID prevents duplicate events across pages');

// ============================================================
// 12. Chronological merge
// ============================================================
console.log('\n12. Chronological merge');

assert.match(pageFnBody, /const allItems = \[\.\.\.movieItems, \.\.\.seriesItems, \.\.\.animeItems\]/,
  'all source items merged into one array');
assert.match(pageFnBody, /allItems\.sort\(\(a, b\) => a\.timestamp - b\.timestamp\)/,
  'merged items sorted chronologically');
ok('Chronological merge of movie/series/anime items');

// ============================================================
// 13. API endpoint accepts + returns cursor
// ============================================================
console.log('\n13. API endpoint cursor handling');

assert.match(apiSource, /parseCursor\(url\.searchParams\.get\('cursor'\)\)/,
  'API parses cursor from query param');
assert.match(apiSource, /loadUpcomingPage\(\{ month, year, type, language \}, page, cursor\)/,
  'API passes cursor to loadUpcomingPage');
assert.match(apiSource, /cursor: serializeCursor\(result\.cursor\)/,
  'API returns serialized cursor in response');
ok('API endpoint accepts cursor query param + returns serialized cursor');

// ============================================================
// 14. SSR route returns cursor for page 1
// ============================================================
console.log('\n14. SSR route returns cursor');

assert.match(pageServerSource, /loadUpcomingPage\(\{ month, year, type, language \}, 1\)/,
  'SSR calls loadUpcomingPage with page=1 (no cursor = empty)');
assert.match(pageServerSource, /cursor: serializeCursor\(result\.cursor\)/,
  'SSR returns serialized cursor for the UI');
ok('SSR route returns page 1 + cursor for the UI');

// ============================================================
// 15. UI passes cursor to API
// ============================================================
console.log('\n15. UI passes cursor to API');

assert.match(pageSvelteSource, /let nextCursor = \$state<string>\(data\.cursor \?\? ''\)/,
  'UI tracks nextCursor from SSR data');
assert.match(pageSvelteSource, /cursor: nextCursor/,
  'loadMore passes cursor in API request params');
assert.match(pageSvelteSource, /nextCursor = payload\.cursor \?\? ''/,
  'loadMore updates nextCursor from API response');
ok('UI passes cursor to API + updates from response');

// ============================================================
// 16. Snapshot preserves cursor
// ============================================================
console.log('\n16. Snapshot preserves cursor');

assert.match(pageSvelteSource, /capture: \(\) => \(\{ allItems, currentPage, hasNextPage, nextCursor \}\)/,
  'snapshot.capture includes nextCursor');
assert.match(pageSvelteSource, /if \(typeof value\.nextCursor === 'string'\) nextCursor = value\.nextCursor/,
  'snapshot.restore restores nextCursor');
ok('Snapshot preserves cursor across back navigation');

// ============================================================
// 17. Pagination reset includes cursor
// ============================================================
console.log('\n17. Pagination reset includes cursor');

assert.match(pageSvelteSource, /\$effect\(\(\) => \{[\s\S]*?nextCursor = data\.cursor \?\? ''/,
  '$effect resets nextCursor when SSR data changes');
ok('Pagination reset includes cursor (filter change resets cursor)');

// ============================================================
// 18. No maxCandidates=undefined pattern (old approach)
// ============================================================
console.log('\n18. No maxCandidates=undefined pattern');

// The old approach used isPage1 + maxCandidates=undefined for page 2+.
// The new approach uses cursor-based continuation — no isPage1 flag.
assert.doesNotMatch(pageFnBody, /const isPage1 = page === 1/,
  'loadUpcomingPage does NOT use isPage1 flag (old approach)');
assert.doesNotMatch(pageFnBody, /maxCandidates/,
  'loadUpcomingPage does NOT pass maxCandidates (old approach)');
ok('No isPage1/maxCandidates=undefined pattern — pure cursor-based');

// ============================================================
// 19. No navigation interference
// ============================================================
console.log('\n19. No navigation interference');

const pageSvelteNoComments = pageSvelteSource.replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '');
assert.doesNotMatch(pageSvelteNoComments, /history\.back/,
  'no history.back()');
assert.doesNotMatch(pageSvelteNoComments, /history\.pushState/,
  'no history.pushState()');
assert.doesNotMatch(pageSvelteNoComments, /popstate/,
  'no popstate listener');
ok('No navigation interference');

// ============================================================
// 20. appendReturnTo preserved
// ============================================================
console.log('\n20. appendReturnTo preserved');

assert.match(pageSvelteSource, /appendReturnTo\(path, currentReturnTo\)/,
  'detailHref still uses appendReturnTo');
ok('appendReturnTo + back navigation contract preserved');

// ============================================================
// 21. Existing loadUpcoming preserved
// ============================================================
console.log('\n21. Existing loadUpcoming preserved');

assert.match(upcomingSource, /export async function loadUpcoming\(filters: UpcomingFilters\)/,
  'loadUpcoming still exists (not destroyed)');
ok('Existing loadUpcoming preserved (not destroyed)');

// ============================================================
// 22. FIX 2: Pending events in cursor (no enriched events dropped)
// ============================================================
console.log('\n22. FIX 2: Pending events stored in cursor');

// SourceCursor must have a pending field.
assert.match(upcomingSource, /pending: UpcomingItem\[\]/,
  'SourceCursor has pending: UpcomingItem[] field');
// emptyCursor must initialize pending to [].
assert.match(upcomingSource, /pending: \[\]/,
  'emptyCursor initializes pending to []');
// parseCursor must handle pending.
assert.match(upcomingSource, /pending: Array\.isArray\(s\?\.pending\) \? s\.pending : \[\]/,
  'parseCursor handles pending field');
// loadUpcomingPage must slice PAGE_SIZE and store overflow.
assert.match(pageFnBody, /const overflow = deduped\.slice\(pageSize\)/,
  'overflow = deduped.slice(pageSize) — events beyond PAGE_SIZE');
assert.match(pageFnBody, /moviePending\.push\(item\)/,
  'overflow movie items stored in moviePending');
assert.match(pageFnBody, /seriesPending\.push\(item\)/,
  'overflow series items stored in seriesPending');
assert.match(pageFnBody, /animePending\.push\(item\)/,
  'overflow anime items stored in animePending');
// Next cursor must carry the pending arrays.
assert.match(pageFnBody, /nextMovieCursor: SourceCursor = \{ \.\.\.movieCursor, pending: moviePending \}/,
  'nextMovieCursor carries moviePending');
assert.match(pageFnBody, /nextSeriesCursor: SourceCursor = \{ \.\.\.seriesCursor, pending: seriesPending \}/,
  'nextSeriesCursor carries seriesPending');
assert.match(pageFnBody, /nextAnimeCursor: SourceCursor = \{ \.\.\.animeCursor, pending: animePending \}/,
  'nextAnimeCursor carries animePending');
// Batch loaders must prepend pending from the cursor.
assert.match(upcomingSource, /\[\.\.\.cursor\.pending, \.\.\.items\]/,
  'batch loaders prepend cursor.pending before newly enriched items');
// Batch loaders must clear pending in the returned cursor.
assert.match(upcomingSource, /nextCursor: \{ candidateIndex: nextIdx, exhausted: nextIdx >= allCandidates\.length, pending: \[\] \}/,
  'loadMovieBatch returns cursor with empty pending (consumed)');
assert.match(upcomingSource, /nextCursor: \{ candidateIndex: nextIdx, exhausted: nextIdx >= filtered\.length, pending: \[\] \}/,
  'loadSeriesBatch returns cursor with empty pending (consumed)');
// loadUpcomingPage must check pending before deciding to call batch loaders.
assert.match(pageFnBody, /!cursor\.movie\.exhausted \|\| cursor\.movie\.pending\.length > 0/,
  'loadUpcomingPage calls movie batch when pending exists even if exhausted');
ok('FIX 2: Pending events stored in cursor — no enriched events dropped across pages');

// ============================================================
// 23. FIX 3: Upstream failure preserves cursor position
// ============================================================
console.log('\n23. FIX 3: Upstream failure preserves cursor position');

// The catch blocks must NOT set exhausted: true. They must preserve
// the cursor as-is (including candidateIndex and pending).
assert.match(pageFnBody, /\.catch\(\(err\) => \{[\s\S]*?errors\.push\(`Movies: \$\{safeMessage\(err\)\}`\);[\s\S]*?movieCursor = cursor\.movie/,
  'movie catch preserves cursor.movie (NOT marked exhausted)');
assert.match(pageFnBody, /\.catch\(\(err\) => \{[\s\S]*?errors\.push\(`Series: \$\{safeMessage\(err\)\}`\);[\s\S]*?seriesCursor = cursor\.series/,
  'series catch preserves cursor.series (NOT marked exhausted)');
assert.match(pageFnBody, /\.catch\(\(err\) => \{[\s\S]*?errors\.push\(`Anime: \$\{safeMessage\(err\)\}`\);[\s\S]*?animeCursor = cursor\.anime/,
  'anime catch preserves cursor.anime (NOT marked exhausted)');
// Verify NO catch block sets exhausted: true.
const catchBlocks = pageFnBody.match(/\.catch\(\(err\) => \{[\s\S]*?\}\)/g) ?? [];
for (const block of catchBlocks) {
  assert.doesNotMatch(block, /exhausted: true/,
    'no catch block sets exhausted: true (failure != exhaustion)');
}
ok('FIX 3: Upstream failure preserves cursor position (NOT marked exhausted, retry possible)');

// ============================================================
// 24. FIX 2 continued: cursor serialization preserves pending
// ============================================================
console.log('\n24. Cursor serialization preserves pending');

assert.match(upcomingSource, /encodeURIComponent\(JSON\.stringify\(cursor\)\)/,
  'serializeCursor uses JSON.stringify (serializes pending arrays)');
// parseCursor must restore pending as an array.
assert.match(upcomingSource, /pending: Array\.isArray\(s\?\.pending\) \? s\.pending : \[\]/,
  'parseCursor restores pending array from deserialized JSON');
ok('Cursor serialization/deserialization preserves pending events');

console.log(`\nUpcoming cursor pagination tests passed (${passed} check groups).`);
