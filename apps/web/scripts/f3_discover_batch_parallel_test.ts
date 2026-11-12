import assert from 'node:assert/strict';
import { discoverBatchDeduped } from '../src/lib/server/content/discover-batch';
import type { ContentList, DiscoverRailFilters, NormalizedMediaItem } from '../src/lib/server/content/types';

/**
 * F3 regression tests: verify that parallel page-1 fetching preserves
 * deterministic ordering, cross-rail dedup, failure isolation, and
 * continuation-page behavior.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

// ============================================================
// Helper: create a mock NormalizedMediaItem
// ============================================================
function makeItem(type: string, id: string, genres: number[] = []): NormalizedMediaItem {
  return {
    id: `${type}-${id}`,
    title: `Title ${id}`,
    year: 2024,
    type: type as 'movie' | 'series',
    genres: [],
    description: '',
    poster: '',
    backdrop: '',
    tmdbGenreIds: genres,
    externalIds: { tmdb: id },
  } as unknown as NormalizedMediaItem;
}

// ============================================================
// Helper: create a mock fetchRail that returns canned data per section
// ============================================================
function createMockFetchRail(
  sectionData: Record<string, NormalizedMediaItem[]>,
  opts: { delay?: number; failSections?: Set<string>; hasNextPage?: boolean } = {}
): (filters: DiscoverRailFilters, canAccessAdult: boolean) => Promise<ContentList> {
  const { delay = 0, failSections = new Set<string>(), hasNextPage = false } = opts;
  return async (filters: DiscoverRailFilters) => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (failSections.has(filters.section)) {
      throw new Error(`Mock failure for section ${filters.section}`);
    }
    const items = sectionData[filters.section] ?? [];
    return {
      items,
      page: filters.page ?? 1,
      hasNextPage: hasNextPage && filters.page < 3,
      source: 'mock' as any,
    };
  };
}

// ============================================================
// 1. Deterministic ordering — same item in multiple sections
// ============================================================
// Movie "123" appears in theatre, popular-movie, and genre-action.
// theatre has highest priority, so it should get the item.
// The other two sections should NOT have it.
{
  const sharedItem = makeItem('movie', '123', [28]); // genre 28 = action
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'theatre': [sharedItem, makeItem('movie', '200')],
    'popular-movie': [sharedItem, makeItem('movie', '201')],
    'genre-action': [sharedItem, makeItem('movie', '202')],
  };
  const fetchRail = createMockFetchRail(sectionData);
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);

  // theatre should have the shared item.
  const theatreIds = results['theatre'].items.map((i) => i.id);
  assert.ok(theatreIds.includes('movie-123'), 'theatre has movie-123');

  // popular-movie should NOT have the shared item (already in theatre).
  const popularIds = results['popular-movie'].items.map((i) => i.id);
  assert.ok(!popularIds.includes('movie-123'), 'popular-movie does NOT have movie-123 (dedup)');

  // genre-action should NOT have the shared item.
  const actionIds = results['genre-action'].items.map((i) => i.id);
  assert.ok(!actionIds.includes('movie-123'), 'genre-action does NOT have movie-123 (dedup)');
}
ok(true, '1. deterministic dedup: shared item assigned to highest-priority section (theatre)');

// ============================================================
// 2. Deterministic ordering regardless of completion timing
// ============================================================
// Same data as test 1, but with VARYING delays per section.
// The result must be identical regardless of which section resolves first.
{
  const sharedItem = makeItem('movie', '456', [28]);
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'theatre': [sharedItem, makeItem('movie', '300')],
    'genre-action': [sharedItem, makeItem('movie', '301')],
  };

  // Fetch with delays: genre-action resolves BEFORE theatre.
  // The result must still assign movie-456 to theatre (higher priority).
  const fetchRail = async (filters: DiscoverRailFilters) => {
    const delay = filters.section === 'theatre' ? 50 : 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const items = sectionData[filters.section] ?? [];
    return { items, page: filters.page ?? 1, hasNextPage: false, source: 'mock' as any };
  };

  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);

  const theatreIds = results['theatre'].items.map((i) => i.id);
  assert.ok(theatreIds.includes('movie-456'), 'theatre has movie-456 even though genre-action resolved first');

  const actionIds = results['genre-action'].items.map((i) => i.id);
  assert.ok(!actionIds.includes('movie-456'), 'genre-action does NOT have movie-456 (dedup preserved despite completion order)');
}
ok(true, '2. deterministic ordering: completion timing does NOT affect dedup assignment');

// ============================================================
// 3. Section failure isolation
// ============================================================
// theatre throws an error, but other sections should still return data.
{
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'popular-movie': [makeItem('movie', '400')],
  };
  const fetchRail = createMockFetchRail(sectionData, {
    failSections: new Set(['theatre']),
  });
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);

  // theatre should have empty items (error was caught).
  assert.equal(results['theatre'].items.length, 0, 'theatre has 0 items (error isolated)');

  // popular-movie should still have its item.
  assert.equal(results['popular-movie'].items.length, 1, 'popular-movie has 1 item (failure isolated)');
  assert.equal(results['popular-movie'].items[0].id, 'movie-400', 'popular-movie has the correct item');
}
ok(true, '3. failure isolation: one section error does not fail the entire batch');

// ============================================================
// 4. Bounded concurrency — verify all page-1 fetches happen
// ============================================================
{
  let fetchCount = 0;
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'theatre': [makeItem('movie', '500')],
  };
  const fetchRail = async (filters: DiscoverRailFilters) => {
    fetchCount++;
    const items = sectionData[filters.section] ?? [];
    return { items, page: filters.page ?? 1, hasNextPage: false, source: 'mock' as any };
  };
  await discoverBatchDeduped('all', undefined, false, fetchRail);
  // Should fetch page-1 for all 17 sections.
  assert.equal(fetchCount, 17, 'all 17 sections fetched (page-1 parallel)');
}
ok(true, '4. bounded concurrency: all 17 page-1 fetches executed');

// ============================================================
// 5. Continuation pages — only fetched when needed
// ============================================================
// Section needs more items after dedup → should fetch page 2.
{
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'theatre': [makeItem('movie', '600'), makeItem('movie', '601')], // 2 items, hasNextPage=true
    'popular-movie': [makeItem('movie', '600'), makeItem('movie', '602')], // movie-600 is shared with theatre
  };
  const page2Data: Record<string, NormalizedMediaItem[]> = {
    'popular-movie': [makeItem('movie', '700'), makeItem('movie', '701'), makeItem('movie', '702'),
                       makeItem('movie', '703'), makeItem('movie', '704'), makeItem('movie', '705'),
                       makeItem('movie', '706'), makeItem('movie', '707'), makeItem('movie', '708'),
                       makeItem('movie', '709')], // 10 items to fill the rail
  };
  let callCount = 0;
  const fetchRail = async (filters: DiscoverRailFilters) => {
    callCount++;
    if (filters.page === 1) {
      const items = sectionData[filters.section] ?? [];
      return { items, page: 1, hasNextPage: true, source: 'mock' as any };
    }
    // page 2+
    const items = page2Data[filters.section] ?? [];
    return { items, page: filters.page, hasNextPage: false, source: 'mock' as any };
  };
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);

  // popular-movie lost movie-600 to theatre → should have fetched page 2.
  const popularItems = results['popular-movie'].items;
  assert.ok(popularItems.length >= 10, `popular-movie filled to ${popularItems.length} items via continuation`);
  assert.equal(results['popular-movie'].page, 2, 'popular-movie lastFetchedPage = 2 (continuation)');
  assert.ok(!popularItems.some((i) => i.id === 'movie-600'), 'popular-movie does NOT have movie-600 (dedup)');
}
ok(true, '5. continuation pages: fetched only for sections that need more items after dedup');

// ============================================================
// 6. Genre canonical assignment — deterministic
// ============================================================
// Movie with genres [28 (action), 35 (comedy)] should go to genre-action
// (action has higher priority), NOT genre-comedy.
{
  const multiGenreItem = makeItem('movie', '800', [28, 35]); // action + comedy
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'genre-action': [multiGenreItem, makeItem('movie', '801')],
    'genre-comedy': [multiGenreItem, makeItem('movie', '802')],
  };
  const fetchRail = createMockFetchRail(sectionData);
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);

  // genre-action should have movie-800 (canonical genre = action).
  const actionIds = results['genre-action'].items.map((i) => i.id);
  assert.ok(actionIds.includes('movie-800'), 'genre-action has movie-800 (canonical genre)');

  // genre-comedy should NOT have movie-800 (rejected — canonical genre is action).
  const comedyIds = results['genre-comedy'].items.map((i) => i.id);
  assert.ok(!comedyIds.includes('movie-800'), 'genre-comedy does NOT have movie-800 (canonical genre = action)');
}
ok(true, '6. genre canonical assignment: multi-genre item assigned to highest-priority genre only');

// ============================================================
// 7. Response shape preserved
// ============================================================
{
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'theatre': [makeItem('movie', '900')],
  };
  const fetchRail = createMockFetchRail(sectionData, { hasNextPage: true });
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);

  // Verify response shape.
  for (const section of Object.keys(results)) {
    const rail = results[section];
    assert.ok('items' in rail, `${section}: has items`);
    assert.ok('page' in rail, `${section}: has page`);
    assert.ok('hasNextPage' in rail, `${section}: has hasNextPage`);
    assert.ok(Array.isArray(rail.items), `${section}: items is array`);
    assert.equal(typeof rail.page, 'number', `${section}: page is number`);
    assert.equal(typeof rail.hasNextPage, 'boolean', `${section}: hasNextPage is boolean`);
  }
}
ok(true, '7. response shape preserved: each section has { items, page, hasNextPage }');

// ============================================================
// 8. Per-rail cap at 20 items
// ============================================================
{
  const manyItems = Array.from({ length: 30 }, (_, i) => makeItem('movie', `cap-${i}`));
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    'theatre': manyItems,
  };
  const fetchRail = createMockFetchRail(sectionData);
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);
  assert.ok(results['theatre'].items.length <= 20, `theatre capped at 20 items (got ${results['theatre'].items.length})`);
}
ok(true, '8. per-rail cap: no section exceeds 20 items');

// ============================================================
// 9. Empty batch — all sections return empty
// ============================================================
{
  const fetchRail = createMockFetchRail({});
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);
  let totalItems = 0;
  for (const section of Object.keys(results)) {
    totalItems += results[section].items.length;
  }
  assert.equal(totalItems, 0, 'empty batch: 0 total items');
}
ok(true, '9. empty batch: all sections have 0 items');

// ============================================================
// 10. Page-1 errors are caught and produce empty rails
// ============================================================
{
  const fetchRail = createMockFetchRail(
    { 'popular-movie': [makeItem('movie', '999')] },
    { failSections: new Set(['theatre', 'new-ott', 'genre-action']) }
  );
  const results = await discoverBatchDeduped('all', undefined, false, fetchRail);
  assert.equal(results['theatre'].items.length, 0, 'theatre: 0 items (error caught)');
  assert.equal(results['new-ott'].items.length, 0, 'new-ott: 0 items (error caught)');
  assert.equal(results['genre-action'].items.length, 0, 'genre-action: 0 items (error caught)');
  assert.equal(results['popular-movie'].items.length, 1, 'popular-movie: 1 item (not failed)');
}
ok(true, '10. page-1 errors caught: failed sections have 0 items, successful sections unaffected');

// ============================================================
// 11. REAL concurrency limit — max active fetches <= PAGE1_CONCURRENCY
// ============================================================
// This test proves that the lazy-task scheduling actually limits
// concurrency. It would FAIL against the old implementation (which
// passed already-started promises to boundedAll, allowing all 17
// fetchRail calls to be in flight simultaneously).
{
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let totalFetches = 0;

  // Each mock fetch: increment active, update max, wait, decrement.
  const fetchRail = async (filters: DiscoverRailFilters) => {
    activeFetches++;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    totalFetches++;
    // Small delay so concurrent workers overlap.
    await new Promise((r) => setTimeout(r, 5));
    activeFetches--;
    return { items: [], page: filters.page ?? 1, hasNextPage: false, source: 'mock' as any };
  };

  await discoverBatchDeduped('all', undefined, false, fetchRail);

  // The max concurrent page-1 fetches MUST be <= 6 (PAGE1_CONCURRENCY).
  assert.ok(
    maxActiveFetches <= 6,
    `max active page-1 fetches = ${maxActiveFetches}, expected <= 6`
  );
  ok(true, `11. real concurrency limit: max active fetches = ${maxActiveFetches} (<= 6)`);

  // All 17 sections must have been fetched (page-1).
  assert.ok(totalFetches >= 17, `total fetches = ${totalFetches}, expected >= 17`);
  ok(true, `12. all 17 sections fetched (total page-1 fetches = ${totalFetches})`);
}

console.log(`\nf3_discover_batch_parallel_test: ${passed} checks passed (deterministic ordering + dedup + failure isolation + bounded concurrency + continuation + genre assignment + response shape + cap + empty + error handling + REAL concurrency limit)`);
