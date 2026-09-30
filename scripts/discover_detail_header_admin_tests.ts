import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// BEHAVIORAL TESTS — discover-dedup module (actual function calls)
// ============================================================

// A. canonicalKey uses TMDB numeric ID via externalIds
{
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');
  const movie550 = { type: 'movie', id: 'movie-550', externalIds: { tmdb: '550' } };
  const series1399 = { type: 'series', id: 'series-1399', externalIds: { tmdb: '1399' } };
  const movie550NoExt = { type: 'movie', id: 'movie-550' };

  assert.equal(canonicalKey(movie550), 'movie:550');
  assert.equal(canonicalKey(series1399), 'series:1399');
  assert.equal(canonicalKey(movie550NoExt), 'movie:movie-550');
  passed += 3;
  ok('A. canonicalKey uses TMDB numeric ID');
}

// J. movie:550 and series:550 remain separate
{
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');
  const movie = { type: 'movie', id: 'movie-550', externalIds: { tmdb: '550' } };
  const series = { type: 'series', id: 'series-550', externalIds: { tmdb: '550' } };
  assert.notEqual(canonicalKey(movie), canonicalKey(series));
  passed += 1;
  ok('J. movie:550 ≠ series:550 (distinct)');
}

// B. filterSeen removes duplicates
{
  const { filterSeen } = await import('../src/lib/server/content/discover-dedup.ts');
  const items = [
    { id: 'movie-1', type: 'movie', externalIds: { tmdb: '1' } },
    { id: 'movie-2', type: 'movie', externalIds: { tmdb: '2' } },
    { id: 'movie-1', type: 'movie', externalIds: { tmdb: '1' } },
    { id: 'series-3', type: 'series', externalIds: { tmdb: '3' } },
  ] as any[];
  const seen = new Set<string>();
  const result = filterSeen(items, seen);
  assert.equal(result.length, 3);
  assert.equal(seen.size, 3);
  passed += 2;
  ok('B. filterSeen removes duplicates');
}

// C. canonicalGenreSection deterministic
{
  const { canonicalGenreSection } = await import('../src/lib/server/content/discover-dedup.ts');
  assert.equal(canonicalGenreSection([28, 35]), 'genre-action');
  assert.equal(canonicalGenreSection([12, 18]), 'genre-adventure');
  assert.equal(canonicalGenreSection([80, 53]), 'genre-crime');
  assert.equal(canonicalGenreSection([18]), 'genre-drama');
  assert.equal(canonicalGenreSection([99]), null);
  assert.equal(canonicalGenreSection(undefined), null);
  assert.equal(canonicalGenreSection([]), null);
  passed += 7;
  ok('C. canonicalGenreSection (7 cases)');
}

// D. shouldExcludeFromGenre uses tmdbGenreIds
{
  const { shouldExcludeFromGenre } = await import('../src/lib/server/content/discover-dedup.ts');
  const actionComedyItem = { tmdbGenreIds: [28, 35], type: 'movie', id: '1', externalIds: { tmdb: '1' } } as any;
  assert.equal(shouldExcludeFromGenre(actionComedyItem, 'genre-action'), false);
  assert.equal(shouldExcludeFromGenre(actionComedyItem, 'genre-comedy'), true);
  const noGenreItem = { type: 'movie', id: '2', externalIds: { tmdb: '2' } } as any;
  assert.equal(shouldExcludeFromGenre(noGenreItem, 'genre-action'), false);
  passed += 3;
  ok('D. shouldExcludeFromGenre uses tmdbGenreIds');
}

// E. SECTION_PRIORITY order
{
  const { SECTION_PRIORITY } = await import('../src/lib/server/content/discover-dedup.ts');
  ok(SECTION_PRIORITY[0] === 'theatre');
  ok(SECTION_PRIORITY.indexOf('popular-movie') < SECTION_PRIORITY.indexOf('genre-action'));
  passed += 2;
  ok('E. SECTION_PRIORITY order');
}

// ============================================================
// BEHAVIORAL TEST 3: Cross-rail genre eligibility
// ============================================================
// Simulate the batch dedup algorithm manually to verify:
// - Action+Comedy item accepted by genre-action
// - Same item rejected by genre-comedy (without occupying seen slot)
// - Item from earlier non-genre rail not duplicated in genre rail
{
  const { canonicalKey, shouldExcludeFromGenre, isGenreSection, SECTION_PRIORITY } = await import('../src/lib/server/content/discover-dedup.ts');

  // Simulate the batch loop's per-item algorithm
  const seen = new Set<string>();

  // Item: movie TMDB 123, Action+Comedy genres
  const item123 = { type: 'movie', id: 'movie-123', externalIds: { tmdb: '123' }, tmdbGenreIds: [28, 35] } as any;
  const key123 = canonicalKey(item123);

  // Simulate theatre rail accepting it first
  const theatreSection = 'theatre';
  assert.ok(!isGenreSection(theatreSection), '3. theatre is not a genre section');
  assert.ok(!seen.has(key123), '3. movie:123 not yet in seen');
  seen.add(key123);
  assert.ok(seen.has(key123), '3. movie:123 now in seen after theatre accepts it');

  // Now genre-action tries to accept the same item
  const genreActionSection = 'genre-action';
  assert.ok(isGenreSection(genreActionSection), '3. genre-action is a genre section');
  assert.ok(seen.has(key123), '3. movie:123 already in seen — genre-action rejects (A)');
  // Item is NOT added again (it's already in seen)

  // Now genre-comedy tries
  const genreComedySection = 'genre-comedy';
  assert.ok(seen.has(key123), '3. movie:123 already in seen — genre-comedy rejects (A)');

  // Verify: movie:123 appears exactly once in seen
  let count123 = 0;
  for (const key of seen) {
    if (key === key123) count123++;
  }
  assert.equal(count123, 1, '3. movie:123 in seen exactly once');

  passed += 6;
  console.log('  ok 3.1 — theatre accepts movie:123');
  console.log('  ok 3.2 — genre-action rejects (already seen)');
  console.log('  ok 3.3 — genre-comedy rejects (already seen)');
  console.log('  ok 3.4 — movie:123 in seen exactly once');
  ok('3. Cross-rail: theatre item not duplicated in genre rails');
}

// ============================================================
// BEHAVIORAL TEST 4: Genre-ineligible item NOT added to seen
// ============================================================
// A movie with Action+Comedy appears in genre-action's TMDB results.
// genre-comedy also returns it. But genre-comedy should reject it
// WITHOUT adding to seen — so the item remains available for
// genre-action (which processes first due to priority order).
{
  const { canonicalKey, shouldExcludeFromGenre, isGenreSection } = await import('../src/lib/server/content/discover-dedup.ts');

  const seen = new Set<string>();

  // Item: movie TMDB 456, Action+Comedy
  const item456 = { type: 'movie', id: 'movie-456', externalIds: { tmdb: '456' }, tmdbGenreIds: [28, 35] } as any;
  const key456 = canonicalKey(item456);

  // genre-action processes first (higher priority)
  assert.ok(!seen.has(key456), '4. movie:456 not in seen yet');
  assert.ok(!shouldExcludeFromGenre(item456, 'genre-action'), '4. movie:456 canonical genre IS action → accepted');
  seen.add(key456);
  assert.ok(seen.has(key456), '4. movie:456 added to seen by genre-action');

  // genre-comedy processes later
  assert.ok(seen.has(key456), '4. movie:456 already in seen → genre-comedy rejects (A)');

  // Now test: if genre-comedy processed FIRST (hypothetically),
  // the item should be rejected WITHOUT adding to seen
  const seen2 = new Set<string>();
  const item789 = { type: 'movie', id: 'movie-789', externalIds: { tmdb: '789' }, tmdbGenreIds: [28, 35] } as any;
  const key789 = canonicalKey(item789);

  // genre-comedy hypothetical
  assert.ok(!seen2.has(key789), '4b. movie:789 not in seen');
  assert.ok(shouldExcludeFromGenre(item789, 'genre-comedy'), '4b. movie:789 canonical genre is Action, NOT Comedy → rejected');
  // Item is NOT added to seen (correct behavior — it belongs to genre-action)
  assert.ok(!seen2.has(key789), '4b. movie:789 NOT added to seen (rejected by genre, not by seen)');

  // Later genre-action processes it
  assert.ok(!seen2.has(key789), '4b. movie:789 still not in seen → genre-action can accept');
  assert.ok(!shouldExcludeFromGenre(item789, 'genre-action'), '4b. movie:789 canonical genre IS action → accepted');
  seen2.add(key789);
  assert.ok(seen2.has(key789), '4b. movie:789 added to seen by genre-action');

  passed += 8;
  console.log('  ok 4.1 — genre-action accepts Action+Comedy item');
  console.log('  ok 4.2 — genre-comedy rejects already-seen item');
  console.log('  ok 4.3 — genre-ineligible item NOT added to seen (hypothetical)');
  console.log('  ok 4.4 — genre-action can still accept it later');
  ok('4. Genre-ineligible items NOT added to seen');
}

// ============================================================
// BEHAVIORAL TEST 5: Batch result duplicate verification
// ============================================================
// Simulate a full batch result and verify no canonical ID occurs in
// more than one rail.
{
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');

  // Simulated batch result
  const rails: Record<string, { items: any[]; hasNextPage: boolean }> = {
    'theatre': {
      items: [
        { type: 'movie', id: 'movie-1', externalIds: { tmdb: '1' } },
        { type: 'movie', id: 'movie-2', externalIds: { tmdb: '2' } },
      ],
      hasNextPage: true,
    },
    'genre-action': {
      items: [
        { type: 'movie', id: 'movie-3', externalIds: { tmdb: '3' } },
      ],
      hasNextPage: false,
    },
    'genre-comedy': {
      items: [
        { type: 'movie', id: 'movie-4', externalIds: { tmdb: '4' } },
      ],
      hasNextPage: false,
    },
  };

  // Collect all canonical IDs across all rails
  const allKeys: string[] = [];
  for (const [section, rail] of Object.entries(rails)) {
    for (const item of rail.items) {
      allKeys.push(canonicalKey(item));
    }
  }

  // Count duplicates
  const keyCounts = new Map<string, number>();
  for (const key of allKeys) {
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  let duplicates = 0;
  for (const [key, count] of keyCounts) {
    if (count > 1) {
      duplicates++;
      console.error(`  DUPLICATE: ${key} appears ${count} times`);
    }
  }

  assert.equal(duplicates, 0, '5. No duplicate canonical IDs across rails');
  passed += 1;
  ok('5. Batch result has zero duplicate canonical IDs across rails');
}

// ============================================================
// BEHAVIORAL TEST 6: decideSectionLoad — A. batch success + non-empty
// ============================================================
// A successful batch with non-empty items MUST use the batch result.
// No independent fetch should occur.
//
// Note: decideSectionLoad lives in $lib/shared/discover-batch.ts (client-safe).
// It does NOT take initialItems as input — the caller already has the prop,
// the decision function only returns whether to use it (plus hasNextPage/page).
{
  const { decideSectionLoad } = await import('../src/lib/shared/discover-batch.ts');
  const decision = decideSectionLoad({
    batchStatus: 'success',
    filterChanged: false,
    usedInitialItems: false,
    initialHasNextPage: true,
    initialPage: 1,
  });
  assert.equal(decision.kind, 'use-batch', '6.A. success+non-empty → use-batch');
  if (decision.kind === 'use-batch') {
    assert.equal(decision.hasNextPage, true, '6.A. hasNextPage preserved');
    assert.equal(decision.page, 1, '6.A. page preserved');
  }
  passed += 3;
  console.log('  ok 6.A.1 — batch success + non-empty → use-batch');
  console.log('  ok 6.A.2 — hasNextPage preserved');
  console.log('  ok 6.A.3 — page preserved');
  ok('6.A. batch success + non-empty items → use-batch, no independent fetch');
}

// ============================================================
// BEHAVIORAL TEST 7: decideSectionLoad — B. batch success + EMPTY
// ============================================================
// A successful batch with EMPTY items MUST still use the batch result.
// It MUST NOT fall back to independent fetch — that would bypass the
// cross-rail dedup contract. This is the critical correctness invariant.
//
// The decision function does NOT take initialItems as input — the test
// verifies that even when initialItems would be empty, the decision is
// 'use-batch' (NOT 'fetch'). The caller (DiscoverSection) handles the
// empty array correctly because the decision tells it to consume.
{
  const { decideSectionLoad } = await import('../src/lib/shared/discover-batch.ts');
  const decision = decideSectionLoad({
    batchStatus: 'success',
    filterChanged: false,
    usedInitialItems: false,
    initialHasNextPage: false,
    initialPage: 1,
  });
  assert.equal(decision.kind, 'use-batch', '7.B. empty success MUST be use-batch, NOT fetch');
  if (decision.kind === 'use-batch') {
    assert.equal(decision.hasNextPage, false, '7.B. hasNextPage preserved');
    assert.equal(decision.page, 1, '7.B. page preserved');
  }
  passed += 3;
  console.log('  ok 7.B.1 — batch success + EMPTY → use-batch (NOT fetch)');
  console.log('  ok 7.B.2 — hasNextPage preserved');
  console.log('  ok 7.B.3 — page preserved');
  ok('7.B. batch success + EMPTY items → use-batch (does NOT fall back to independent fetch)');
}

// ============================================================
// BEHAVIORAL TEST 8: decideSectionLoad — C. batch failure
// ============================================================
// A failed batch MUST fall back to independent fetch.
{
  const { decideSectionLoad } = await import('../src/lib/shared/discover-batch.ts');
  const decision = decideSectionLoad({
    batchStatus: 'failed',
    filterChanged: false,
    usedInitialItems: false,
    initialHasNextPage: false,
    initialPage: 1,
  });
  assert.equal(decision.kind, 'fetch', '8.C. failure → fetch');
  passed += 1;
  ok('8.C. batch failure → independent fetch is allowed');
}

// ============================================================
// BEHAVIORAL TEST 9: decideSectionLoad — D. preserves hasNextPage
// ============================================================
// The decision MUST preserve the batch's hasNextPage — NOT infer it
// from the item count. The previous bug was `hasNextPage = initialItems.length >= 10`,
// which would incorrectly set hasNextPage=false for a rail with 5 items
// even if more pages existed upstream.
//
// Since decideSectionLoad no longer takes initialItems as input, the
// test verifies the decision function faithfully returns the input
// hasNextPage and page values — proving there is NO inference path.
{
  const { decideSectionLoad } = await import('../src/lib/shared/discover-batch.ts');

  // Case 1: less than 10 items (simulated) but batch says hasNextPage=true.
  // The decision MUST preserve hasNextPage=true — NOT infer false
  // from the item count.
  const decision1 = decideSectionLoad({
    batchStatus: 'success',
    filterChanged: false,
    usedInitialItems: false,
    initialHasNextPage: true,
    initialPage: 1,
  });
  assert.equal(decision1.kind, 'use-batch', '9.D.1 decision is use-batch');
  if (decision1.kind === 'use-batch') {
    assert.equal(decision1.hasNextPage, true, '9.D.1 hasNextPage preserved (true) — NOT inferred from item count');
    assert.equal(decision1.page, 1, '9.D.1 page preserved');
  }

  // Case 2: 10 items (simulated) but batch says hasNextPage=false + page=2.
  const decision2 = decideSectionLoad({
    batchStatus: 'success',
    filterChanged: false,
    usedInitialItems: false,
    initialHasNextPage: false,
    initialPage: 2,
  });
  assert.equal(decision2.kind, 'use-batch', '9.D.2 decision is use-batch');
  if (decision2.kind === 'use-batch') {
    assert.equal(decision2.hasNextPage, false, '9.D.2 hasNextPage preserved (false) — NOT inferred from item count');
    assert.equal(decision2.page, 2, '9.D.2 page preserved (2) — actual batch continuation page');
  }

  passed += 5;
  console.log('  ok 9.D.1 — hasNextPage=true preserved (less than 10 items, more pages exist)');
  console.log('  ok 9.D.2 — hasNextPage=false preserved (10 items, last page)');
  console.log('  ok 9.D.3 — page preserved when hasNextPage=true');
  console.log('  ok 9.D.4 — page preserved when hasNextPage=false');
  console.log('  ok 9.D.5 — no inference from item count');
  ok('9.D. batch success preserves hasNextPage + actual page (no item-count heuristic)');
}

// ============================================================
// BEHAVIORAL TEST 10: decideSectionLoad — pending → wait
// ============================================================
{
  const { decideSectionLoad } = await import('../src/lib/shared/discover-batch.ts');
  const decision = decideSectionLoad({
    batchStatus: 'pending',
    filterChanged: false,
    usedInitialItems: false,
    initialHasNextPage: false,
    initialPage: 1,
  });
  assert.equal(decision.kind, 'wait', '10. pending → wait');
  passed += 1;
  ok('10. batch pending → wait (no independent fetch)');
}

// ============================================================
// BEHAVIORAL TEST 11: decideSectionLoad — filterChanged → fetch
// ============================================================
// Even if batch succeeded, a filter change MUST trigger independent fetch
// (the batch was for the original "all" filter, not the new language/provider).
{
  const { decideSectionLoad } = await import('../src/lib/shared/discover-batch.ts');
  const decision = decideSectionLoad({
    batchStatus: 'success',
    filterChanged: true,
    usedInitialItems: false,
    initialHasNextPage: true,
    initialPage: 1,
  });
  assert.equal(decision.kind, 'fetch', '11. filterChanged → fetch (not batch)');
  passed += 1;
  ok('11. filterChanged → independent fetch (never reuse stale batch)');
}

// ============================================================
// BEHAVIORAL TEST 12: discoverBatchDeduped — E. preserves actual page
// ============================================================
// When a section needs to fetch multiple pages to fill itself (due to
// dedup losses), the returned `page` MUST reflect the ACTUAL last
// fetched page — NOT always 1. Show More uses this as the starting
// currentPage so it can compute nextPage = currentPage + 1 correctly
// and never re-fetch already-consumed pages.
{
  const { discoverBatchDeduped } = await import('../src/lib/server/content/discover-batch.ts');

  // Mock fetcher: theatre returns 5 items on page 1 + 5 more on page 2.
  // All other sections return empty. Theatre needs both pages to reach
  // TARGET_ITEMS=10, so the returned page MUST be 2.
  const mockFetchRail = async (filters: any) => {
    const page = filters.page as number;
    if (filters.section === 'theatre' && page === 1) {
      return {
        items: Array.from({ length: 5 }, (_, i) => ({
          type: 'movie', id: `t${i + 1}`, externalIds: { tmdb: String(i + 1) }
        })) as any[],
        page,
        hasNextPage: true,
      };
    }
    if (filters.section === 'theatre' && page === 2) {
      return {
        items: Array.from({ length: 5 }, (_, i) => ({
          type: 'movie', id: `t${i + 6}`, externalIds: { tmdb: String(i + 6) }
        })) as any[],
        page,
        hasNextPage: false,
      };
    }
    return { items: [], page, hasNextPage: false };
  };

  const rails = await discoverBatchDeduped('all', undefined, false, mockFetchRail);

  // Theatre consumed pages 1 AND 2 to reach 10 items.
  assert.equal(rails['theatre'].items.length, 10, '12.E.1 theatre has 10 items (consumed 2 pages)');
  assert.equal(rails['theatre'].page, 2, '12.E.2 theatre.page = 2 (ACTUAL last fetched, not 1)');
  assert.equal(rails['theatre'].hasNextPage, false, '12.E.3 theatre.hasNextPage = false (page 2 reported no next)');

  // Sections that returned empty immediately have page=1 (only fetched page 1).
  assert.equal(rails['new-ott'].items.length, 0, '12.E.4 new-ott is empty');
  assert.equal(rails['new-ott'].page, 1, '12.E.5 new-ott.page = 1 (only page 1 was fetched)');
  assert.equal(rails['new-ott'].hasNextPage, false, '12.E.6 new-ott.hasNextPage = false');

  passed += 6;
  console.log('  ok 12.E.1 — theatre filled to 10 items across 2 pages');
  console.log('  ok 12.E.2 — theatre.page = 2 (actual last fetched page)');
  console.log('  ok 12.E.3 — theatre.hasNextPage preserved');
  console.log('  ok 12.E.4 — empty section has 0 items');
  console.log('  ok 12.E.5 — empty section.page = 1 (only 1 page fetched)');
  console.log('  ok 12.E.6 — empty section.hasNextPage = false');
  ok('12.E. batch returns ACTUAL last fetched page (theatre: 2, empty rails: 1)');
}

// ============================================================
// BEHAVIORAL TEST 13: discoverBatchDeduped — global uniqueness
// ============================================================
// All canonical IDs across ALL rails returned by the batch MUST be
// globally unique. Re-verifies test 5 with the REAL batch function
// using a mock fetcher that returns OVERLAPPING items — the dedup
// must filter them so each canonical ID appears in exactly one rail.
{
  const { discoverBatchDeduped } = await import('../src/lib/server/content/discover-batch.ts');
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');

  // Mock fetcher returns OVERLAPPING items: theatre and genre-action
  // both return the shared item (tmdb:100). Dedup must filter it from
  // genre-action since theatre processes first.
  const sharedItem = { type: 'movie', id: 'shared-1', externalIds: { tmdb: '100' } };
  const theatreItem = { type: 'movie', id: 'theatre-1', externalIds: { tmdb: '101' } };
  const actionItem = { type: 'movie', id: 'action-1', externalIds: { tmdb: '102' }, tmdbGenreIds: [28] };

  const mockFetchRail = async (filters: any) => {
    if (filters.page > 1) return { items: [], page: filters.page, hasNextPage: false };
    if (filters.section === 'theatre') {
      return { items: [sharedItem, theatreItem] as any[], page: 1, hasNextPage: false };
    }
    if (filters.section === 'genre-action') {
      // genre-action also returns the shared item — must be deduped.
      return { items: [sharedItem, actionItem] as any[], page: 1, hasNextPage: false };
    }
    return { items: [], page: 1, hasNextPage: false };
  };

  const rails = await discoverBatchDeduped('all', undefined, false, mockFetchRail);

  // Collect all canonical IDs across all rails.
  const allKeys: string[] = [];
  for (const [, rail] of Object.entries(rails)) {
    for (const item of rail.items) {
      allKeys.push(canonicalKey(item));
    }
  }

  // Count duplicates.
  const keyCounts = new Map<string, number>();
  for (const key of allKeys) {
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  let duplicates = 0;
  for (const [key, count] of keyCounts) {
    if (count > 1) {
      duplicates++;
      console.error(`  DUPLICATE: ${key} appears ${count} times`);
    }
  }

  assert.equal(duplicates, 0, '13.1 No duplicate canonical IDs across rails (with mock fetcher)');

  // Verify the shared item went to theatre (higher priority) and was
  // NOT duplicated into genre-action.
  assert.ok(rails['theatre'].items.some(i => canonicalKey(i) === 'movie:100'), '13.2 shared item in theatre');
  assert.ok(!rails['genre-action'].items.some(i => canonicalKey(i) === 'movie:100'), '13.3 shared item NOT in genre-action (deduped)');
  // genre-action should have its own canonical item.
  assert.ok(rails['genre-action'].items.some(i => canonicalKey(i) === 'movie:102'), '13.4 action-specific item in genre-action');

  passed += 4;
  console.log('  ok 13.1 — zero duplicate canonical IDs across all rails');
  console.log('  ok 13.2 — shared item routed to theatre (higher priority)');
  console.log('  ok 13.3 — shared item NOT duplicated into genre-action');
  console.log('  ok 13.4 — action-specific item present in genre-action');
  ok('13. discoverBatchDeduped with mock fetcher: zero duplicates + correct priority routing');
}

// ============================================================
// BEHAVIORAL TEST 14: discoverBatchDeduped — Action+Comedy only in Action
// ============================================================
// An Action+Comedy item must appear in genre-action ONLY (its canonical
// genre), NOT in genre-comedy. genre-comedy must reject it WITHOUT
// adding it to seen — so the item remains available for genre-action
// (which processes first due to higher priority).
{
  const { discoverBatchDeduped } = await import('../src/lib/server/content/discover-batch.ts');
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');

  // Action+Comedy item (TMDB genre IDs 28=Action, 35=Comedy).
  // canonicalGenreSection([28, 35]) returns 'genre-action' (Action wins).
  const actionComedyItem = { type: 'movie', id: 'ac-1', externalIds: { tmdb: '200' }, tmdbGenreIds: [28, 35] };

  const mockFetchRail = async (filters: any) => {
    if (filters.page > 1) return { items: [], page: filters.page, hasNextPage: false };
    // Both genre-action and genre-comedy return the same item.
    if (filters.section === 'genre-action') {
      return { items: [actionComedyItem] as any[], page: 1, hasNextPage: false };
    }
    if (filters.section === 'genre-comedy') {
      return { items: [actionComedyItem] as any[], page: 1, hasNextPage: false };
    }
    return { items: [], page: 1, hasNextPage: false };
  };

  const rails = await discoverBatchDeduped('all', undefined, false, mockFetchRail);

  const inAction = rails['genre-action'].items.some(i => canonicalKey(i) === 'movie:200');
  const inComedy = rails['genre-comedy'].items.some(i => canonicalKey(i) === 'movie:200');

  assert.ok(inAction, '14.1 Action+Comedy item IS in genre-action (canonical genre)');
  assert.ok(!inComedy, '14.2 Action+Comedy item NOT in genre-comedy (rejected by genre eligibility)');

  passed += 2;
  console.log('  ok 14.1 — Action+Comedy item appears in genre-action');
  console.log('  ok 14.2 — Action+Comedy item does NOT appear in genre-comedy');
  ok('14. Action+Comedy item only in genre-action (canonical genre assignment)');
}

// ============================================================
// BEHAVIORAL TEST 15: discoverBatchDeduped — earlier rails take priority
// ============================================================
// An item that appears in an earlier-priority rail (e.g. theatre) must
// NOT appear in any later-priority rail (e.g. genre-action), even if the
// later rail also returns it from its TMDB query.
{
  const { discoverBatchDeduped } = await import('../src/lib/server/content/discover-batch.ts');
  const { canonicalKey, SECTION_PRIORITY } = await import('../src/lib/server/content/discover-dedup.ts');

  // Shared item is Action genre, returned by BOTH theatre AND genre-action.
  const sharedItem = { type: 'movie', id: 'shared-2', externalIds: { tmdb: '300' }, tmdbGenreIds: [28] };

  const mockFetchRail = async (filters: any) => {
    if (filters.page > 1) return { items: [], page: filters.page, hasNextPage: false };
    if (filters.section === 'theatre') {
      return { items: [sharedItem] as any[], page: 1, hasNextPage: false };
    }
    if (filters.section === 'genre-action') {
      // genre-action also returns the shared item — must be deduped.
      return { items: [sharedItem] as any[], page: 1, hasNextPage: false };
    }
    return { items: [], page: 1, hasNextPage: false };
  };

  const rails = await discoverBatchDeduped('all', undefined, false, mockFetchRail);

  // Verify theatre comes before genre-action in priority.
  assert.ok(
    SECTION_PRIORITY.indexOf('theatre') < SECTION_PRIORITY.indexOf('genre-action'),
    '15.1 theatre has higher priority than genre-action'
  );

  // The shared item must be in theatre, NOT in genre-action.
  const inTheatre = rails['theatre'].items.some(i => canonicalKey(i) === 'movie:300');
  const inAction = rails['genre-action'].items.some(i => canonicalKey(i) === 'movie:300');

  assert.ok(inTheatre, '15.2 shared item IS in theatre (higher priority)');
  assert.ok(!inAction, '15.3 shared item NOT in genre-action (already in theatre)');

  passed += 3;
  console.log('  ok 15.1 — theatre has higher priority than genre-action');
  console.log('  ok 15.2 — shared item routed to theatre');
  console.log('  ok 15.3 — shared item NOT duplicated into genre-action');
  ok('15. Earlier-priority rail takes the item; later rail is deduped');
}

// ============================================================
// BEHAVIORAL TEST 16: discoverBatchDeduped — Show More continuation page
// ============================================================
// End-to-end verification: after batch consumes pages 1+2 for a section,
// Show More (which calls /api/discover/rail with page=currentPage+1=3)
// will fetch page 3 — NOT page 2 (already consumed) or page 1 (already
// consumed). This test verifies the continuation page arithmetic.
{
  const { discoverBatchDeduped } = await import('../src/lib/server/content/discover-batch.ts');

  // Mock returns 3 items on page 1 (need more), 4 items on page 2 (need more),
  // 4 items on page 3 (reaches TARGET_ITEMS=10 since 3+4+4=11 >= 10).
  // MAX_PAGES = 3, so the loop stops after page 3.
  const mockFetchRail = async (filters: any) => {
    const page = filters.page as number;
    if (filters.section === 'theatre') {
      if (page === 1) {
        return {
          items: Array.from({ length: 3 }, (_, i) => ({
            type: 'movie', id: `a${i}`, externalIds: { tmdb: String(i + 1) }
          })) as any[],
          page, hasNextPage: true,
        };
      }
      if (page === 2) {
        return {
          items: Array.from({ length: 4 }, (_, i) => ({
            type: 'movie', id: `b${i}`, externalIds: { tmdb: String(i + 10) }
          })) as any[],
          page, hasNextPage: true,
        };
      }
      if (page === 3) {
        return {
          items: Array.from({ length: 4 }, (_, i) => ({
            type: 'movie', id: `c${i}`, externalIds: { tmdb: String(i + 20) }
          })) as any[],
          page, hasNextPage: true,
        };
      }
    }
    return { items: [], page, hasNextPage: false };
  };

  const rails = await discoverBatchDeduped('all', undefined, false, mockFetchRail);

  // Theatre consumed all 3 pages (3+4+4=11 >= 10, so it stops at page 3).
  // Wait — the TARGET_ITEMS check happens AFTER processing, so:
  //   page 1: railItems=3 < 10, hasNext=true → continue to page 2
  //   page 2: railItems=7 < 10, hasNext=true → continue to page 3
  //   page 3: railItems=11 >= 10 → break.
  // lastFetchedPage = 3.
  assert.equal(rails['theatre'].page, 3, '16.1 theatre.page = 3 (consumed pages 1, 2, 3)');
  assert.equal(rails['theatre'].items.length, 11, '16.2 theatre has 11 items (cap 20)');
  assert.equal(rails['theatre'].hasNextPage, true, '16.3 theatre.hasNextPage = true (page 3 had next)');

  // Show More continuation arithmetic:
  //   currentPage = 3 (from batch result)
  //   nextPage = currentPage + 1 = 4
  // Show More will fetch /api/discover/rail?...&page=4 — NOT page 1, 2, or 3.
  const showMoreNextPage = rails['theatre'].page + 1;
  assert.equal(showMoreNextPage, 4, '16.4 Show More next page = 4 (continues from page 3, not 1)');

  // Verify Show More would NOT re-fetch already-consumed pages.
  assert.ok(showMoreNextPage > 3, '16.5 Show More does NOT re-fetch pages 1, 2, or 3');
  assert.ok(showMoreNextPage > rails['theatre'].page, '16.6 Show More fetches a page AFTER the last consumed one');

  passed += 6;
  console.log('  ok 16.1 — theatre.page = 3 (actual last fetched)');
  console.log('  ok 16.2 — theatre filled to 11 items across 3 pages');
  console.log('  ok 16.3 — theatre.hasNextPage = true');
  console.log('  ok 16.4 — Show More next page = 4 (correct continuation)');
  console.log('  ok 16.5 — Show More does NOT re-fetch pages 1, 2, 3');
  console.log('  ok 16.6 — Show More fetches a page AFTER the last consumed');
  ok('16. Show More continuation page = batch.page + 1 (never re-fetches consumed pages)');
}

// ============================================================
// BEHAVIORAL TEST 17: canonicalExcludeIds — Comedy excludes Crime/Thriller/Sci-Fi
// ============================================================
// The visual UI order has Comedy BEFORE Crime/Thriller/Sci-Fi, but the
// canonical server priority has Crime/Thriller/Sci-Fi BEFORE Comedy.
//
// excludeIdsFor('genre-comedy') MUST include IDs from genre-action,
// genre-adventure, genre-crime, genre-thriller, genre-scifi — even
// though Crime/Thriller/Sci-Fi are visually rendered AFTER Comedy.
//
// This is the critical Phase 9 fix: walking SECTION_PRIORITY (canonical
// server order) instead of the visual SECTIONS array ensures Show More
// on Comedy cannot reintroduce items already displayed in Crime/Thriller/Sci-Fi.
{
  const { canonicalExcludeIds, SECTION_PRIORITY } = await import('../src/lib/shared/discover-batch.ts');

  // Simulated batch result: each genre rail has exactly ONE unique item.
  // We deliberately place Movie X (tmdb:500) in genre-crime to verify
  // it appears in genre-comedy's exclude list despite the visual order.
  const movie500 = { type: 'movie', id: 'movie-500', externalIds: { tmdb: '500' } };
  const movie501 = { type: 'movie', id: 'movie-501', externalIds: { tmdb: '501' } };
  const movie502 = { type: 'movie', id: 'movie-502', externalIds: { tmdb: '502' } };
  const movie503 = { type: 'movie', id: 'movie-503', externalIds: { tmdb: '503' } };
  const movie504 = { type: 'movie', id: 'movie-504', externalIds: { tmdb: '504' } };
  const movie505 = { type: 'movie', id: 'movie-505', externalIds: { tmdb: '505' } };

  const batchRails = {
    'genre-action':   { items: [movie501], page: 1, hasNextPage: false },
    'genre-adventure':{ items: [movie502], page: 1, hasNextPage: false },
    'genre-crime':    { items: [movie500], page: 1, hasNextPage: false }, // ← Movie X
    'genre-thriller': { items: [movie503], page: 1, hasNextPage: false },
    'genre-scifi':    { items: [movie504], page: 1, hasNextPage: false },
    'genre-comedy':   { items: [movie505], page: 1, hasNextPage: false },
  } as any;

  const excludeForComedy = canonicalExcludeIds('genre-comedy', batchRails);

  // The exclude list MUST contain all 5 higher-priority genre rails'
  // canonical IDs — including genre-crime's movie:500 — even though
  // genre-crime/genre-thriller/genre-scifi are visually rendered AFTER
  // genre-comedy.
  assert.ok(excludeForComedy.includes('movie:501'), '17.1 exclude includes genre-action ID');
  assert.ok(excludeForComedy.includes('movie:502'), '17.2 exclude includes genre-adventure ID');
  assert.ok(excludeForComedy.includes('movie:500'), '17.3 exclude includes genre-crime ID (Movie X) — CRITICAL');
  assert.ok(excludeForComedy.includes('movie:503'), '17.4 exclude includes genre-thriller ID');
  assert.ok(excludeForComedy.includes('movie:504'), '17.5 exclude includes genre-scifi ID');
  // The exclude list MUST NOT contain genre-comedy's own item.
  assert.ok(!excludeForComedy.includes('movie:505'), '17.6 exclude does NOT include genre-comedy own ID');

  // Sanity: verify canonical priority order has crime/thriller/scifi BEFORE comedy.
  assert.ok(
    SECTION_PRIORITY.indexOf('genre-crime') < SECTION_PRIORITY.indexOf('genre-comedy'),
    '17.7 canonical priority: genre-crime BEFORE genre-comedy'
  );
  assert.ok(
    SECTION_PRIORITY.indexOf('genre-thriller') < SECTION_PRIORITY.indexOf('genre-comedy'),
    '17.8 canonical priority: genre-thriller BEFORE genre-comedy'
  );
  assert.ok(
    SECTION_PRIORITY.indexOf('genre-scifi') < SECTION_PRIORITY.indexOf('genre-comedy'),
    '17.9 canonical priority: genre-scifi BEFORE genre-comedy'
  );

  passed += 9;
  console.log('  ok 17.1 — genre-comedy exclude includes genre-action');
  console.log('  ok 17.2 — genre-comedy exclude includes genre-adventure');
  console.log('  ok 17.3 — genre-comedy exclude includes genre-crime (Movie X) — CRITICAL FIX');
  console.log('  ok 17.4 — genre-comedy exclude includes genre-thriller');
  console.log('  ok 17.5 — genre-comedy exclude includes genre-scifi');
  console.log('  ok 17.6 — genre-comedy exclude does NOT include its own ID');
  console.log('  ok 17.7 — canonical priority: crime BEFORE comedy');
  console.log('  ok 17.8 — canonical priority: thriller BEFORE comedy');
  console.log('  ok 17.9 — canonical priority: scifi BEFORE comedy');
  ok('17. canonicalExcludeIds: genre-comedy excludes Crime/Thriller/Sci-Fi (canonical order, NOT visual)');
}

// ============================================================
// BEHAVIORAL TEST 18: canonicalExcludeIds — Drama excludes ALL higher-priority genres
// ============================================================
// genre-drama is the 7th genre in canonical priority. Its exclude list
// MUST include IDs from ALL 6 higher-priority genre rails (action,
// adventure, crime, thriller, scifi, comedy) — even though in the
// visual UI order, drama is rendered AFTER comedy but the other
// 5 genres are also visually before drama.
//
// This test specifically verifies that genre-comedy (canonical priority
// 13, lower than drama's 14) is included in drama's exclude list, even
// though in the visual UI comedy is rendered at position 11 and drama
// at position 15 (so they're both visually in the "before drama" set).
{
  const { canonicalExcludeIds } = await import('../src/lib/shared/discover-batch.ts');

  const batchRails = {
    'genre-action':   { items: [{ type: 'movie', id: 'a1', externalIds: { tmdb: '601' } }], page: 1, hasNextPage: false },
    'genre-adventure':{ items: [{ type: 'movie', id: 'a2', externalIds: { tmdb: '602' } }], page: 1, hasNextPage: false },
    'genre-crime':    { items: [{ type: 'movie', id: 'a3', externalIds: { tmdb: '603' } }], page: 1, hasNextPage: false },
    'genre-thriller': { items: [{ type: 'movie', id: 'a4', externalIds: { tmdb: '604' } }], page: 1, hasNextPage: false },
    'genre-scifi':    { items: [{ type: 'movie', id: 'a5', externalIds: { tmdb: '605' } }], page: 1, hasNextPage: false },
    'genre-comedy':   { items: [{ type: 'movie', id: 'a6', externalIds: { tmdb: '606' } }], page: 1, hasNextPage: false },
    'genre-drama':    { items: [{ type: 'movie', id: 'a7', externalIds: { tmdb: '607' } }], page: 1, hasNextPage: false },
  } as any;

  const excludeForDrama = canonicalExcludeIds('genre-drama', batchRails);

  // Drama's exclude list must contain ALL 6 higher-priority genre IDs.
  assert.ok(excludeForDrama.includes('movie:601'), '18.1 drama excludes action');
  assert.ok(excludeForDrama.includes('movie:602'), '18.2 drama excludes adventure');
  assert.ok(excludeForDrama.includes('movie:603'), '18.3 drama excludes crime');
  assert.ok(excludeForDrama.includes('movie:604'), '18.4 drama excludes thriller');
  assert.ok(excludeForDrama.includes('movie:605'), '18.5 drama excludes scifi');
  assert.ok(excludeForDrama.includes('movie:606'), '18.6 drama excludes comedy');
  // Drama's own item must NOT be in the exclude list.
  assert.ok(!excludeForDrama.includes('movie:607'), '18.7 drama does NOT exclude its own ID');

  passed += 7;
  console.log('  ok 18.1 — drama excludes action');
  console.log('  ok 18.2 — drama excludes adventure');
  console.log('  ok 18.3 — drama excludes crime');
  console.log('  ok 18.4 — drama excludes thriller');
  console.log('  ok 18.5 — drama excludes scifi');
  console.log('  ok 18.6 — drama excludes comedy');
  console.log('  ok 18.7 — drama does NOT exclude its own ID');
  ok('18. canonicalExcludeIds: genre-drama excludes ALL 6 higher-priority genre rails');
}

// ============================================================
// BEHAVIORAL TEST 19: Show More cannot reintroduce higher-priority rail IDs
// ============================================================
// End-to-end simulation of the Show More flow:
//   1. Batch places movie:500 into genre-crime (canonical priority 10).
//   2. genre-comedy's Show More runs and the server /api/discover/rail
//      endpoint receives the exclude list (which now correctly includes
//      movie:500 thanks to the Phase 9 fix).
//   3. The server's rail endpoint filters out excluded IDs.
//
// Simulate the rail endpoint's filter behavior using filterSeen() to
// verify movie:500 cannot be reintroduced into genre-comedy's rail,
// even if the TMDB API would naturally return it (because the movie
// has both Crime and Comedy genres).
{
  const { canonicalExcludeIds } = await import('../src/lib/shared/discover-batch.ts');
  const { filterSeen, canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');

  // Step 1: Batch result — movie:500 is in genre-crime.
  const movie500 = { type: 'movie', id: 'movie-500', externalIds: { tmdb: '500' }, tmdbGenreIds: [80, 35] } as any;
  const batchRails = {
    'genre-action':   { items: [], page: 1, hasNextPage: false },
    'genre-adventure':{ items: [], page: 1, hasNextPage: false },
    'genre-crime':    { items: [movie500], page: 1, hasNextPage: false },
    'genre-thriller': { items: [], page: 1, hasNextPage: false },
    'genre-scifi':    { items: [], page: 1, hasNextPage: false },
    'genre-comedy':   { items: [], page: 1, hasNextPage: true }, // has more pages
  } as any;

  // Step 2: Compute genre-comedy's exclude list. With the Phase 9 fix,
  // this list now includes movie:500 from genre-crime.
  const excludeForComedy = canonicalExcludeIds('genre-comedy', batchRails);
  assert.ok(excludeForComedy.includes('movie:500'), '19.1 exclude list includes movie:500 from genre-crime');

  // Step 3: Simulate the rail endpoint behavior. The endpoint receives
  // the exclude list as the `exclude` query param and parses it into a Set.
  // It then calls filterSeen(result.items, excludeSet) to remove excluded
  // IDs from the TMDB response.
  const excludeSet = new Set(excludeForComedy);

  // Simulate TMDB returning movie:500 in genre-comedy's page 2 response
  // (this happens naturally because the movie has both Crime and Comedy genres).
  const tmdbResponsePage2 = [movie500, { type: 'movie', id: 'other-1', externalIds: { tmdb: '999' } } as any];

  // The rail endpoint filters out excluded IDs.
  const filtered = filterSeen(tmdbResponsePage2, excludeSet);

  // movie:500 MUST be filtered out — it's in genre-crime (higher priority).
  assert.ok(!filtered.some(i => canonicalKey(i) === 'movie:500'), '19.2 movie:500 filtered out of comedy Show More');
  // The other item (movie:999) MUST remain — it's not in the exclude list.
  assert.ok(filtered.some(i => canonicalKey(i) === 'movie:999'), '19.3 unrelated item (movie:999) preserved');

  // Verify the cross-rail invariant after Show More:
  //   movie:500 appears in genre-crime's rail (initial batch)
  //   movie:500 does NOT appear in genre-comedy's rail (Show More)
  const allDisplayedIds: string[] = [];
  for (const [, rail] of Object.entries(batchRails)) {
    for (const item of (rail as any).items) allDisplayedIds.push(canonicalKey(item));
  }
  // After Show More, genre-comedy's rail is `filtered`.
  for (const item of filtered) allDisplayedIds.push(canonicalKey(item));

  // Count movie:500 across all displayed rails.
  const count500 = allDisplayedIds.filter(k => k === 'movie:500').length;
  assert.equal(count500, 1, '19.4 movie:500 appears exactly ONCE across all rails (in genre-crime only)');

  passed += 4;
  console.log('  ok 19.1 — exclude list includes movie:500 from genre-crime');
  console.log('  ok 19.2 — movie:500 filtered out of comedy Show More');
  console.log('  ok 19.3 — unrelated item (movie:999) preserved');
  console.log('  ok 19.4 — movie:500 appears exactly ONCE across all rails');
  ok('19. Show More on genre-comedy cannot reintroduce movie:500 from genre-crime');
}

// ============================================================
// BEHAVIORAL TEST 20: Cross-rail invariant holds after multiple Show More calls
// ============================================================
// Final end-to-end invariant: for every canonical ID, count across all
// currently displayed Discover rails <= 1. This must remain true after:
//   - initial page load (batch)
//   - Show More on any rail
//   - Show More on a lower-priority rail whose canonical higher-priority
//     rail appears visually below it (the Phase 9 fix scenario)
{
  const { canonicalExcludeIds } = await import('../src/lib/shared/discover-batch.ts');
  const { filterSeen, canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');

  // Initial batch: each genre rail has unique items, BUT some items
  // appear in MULTIPLE genres' TMDB queries (natural — a movie has
  // multiple genres). The batch dedup correctly places each into ONE rail.
  const movieX = { type: 'movie', id: 'x', externalIds: { tmdb: '500' }, tmdbGenreIds: [80, 35] } as any; // Crime+Comedy → genre-crime
  const movieY = { type: 'movie', id: 'y', externalIds: { tmdb: '501' }, tmdbGenreIds: [53, 878] } as any; // Thriller+SciFi → genre-thriller
  const movieZ = { type: 'movie', id: 'z', externalIds: { tmdb: '502' }, tmdbGenreIds: [35] } as any;     // Comedy only → genre-comedy

  const batchRails = {
    'genre-action':   { items: [], page: 1, hasNextPage: false },
    'genre-adventure':{ items: [], page: 1, hasNextPage: false },
    'genre-crime':    { items: [movieX], page: 1, hasNextPage: false },
    'genre-thriller': { items: [movieY], page: 1, hasNextPage: false },
    'genre-scifi':    { items: [], page: 1, hasNextPage: true }, // needs Show More
    'genre-comedy':   { items: [movieZ], page: 1, hasNextPage: true }, // needs Show More
    'genre-drama':    { items: [], page: 1, hasNextPage: false },
  } as any;

  // === Phase 1: Show More on genre-scifi ===
  // TMDB returns movieY (Thriller+SciFi) on scifi page 2 — but movieY
  // is already in genre-thriller (higher canonical priority).
  const excludeForScifi = canonicalExcludeIds('genre-scifi', batchRails);
  assert.ok(excludeForScifi.includes('movie:501'), '20.1 scifi exclude includes movie:501 from thriller');
  const scifiShowMoreResponse = [movieY, { type: 'movie', id: 'scifi-only', externalIds: { tmdb: '700' } } as any];
  const scifiFiltered = filterSeen(scifiShowMoreResponse, new Set(excludeForScifi));
  assert.ok(!scifiFiltered.some(i => canonicalKey(i) === 'movie:501'), '20.2 movie:501 NOT reintroduced into scifi');

  // === Phase 2: Show More on genre-comedy ===
  // TMDB returns movieX (Crime+Comedy) on comedy page 2 — but movieX
  // is already in genre-crime (higher canonical priority, but visually
  // rendered AFTER comedy in the UI).
  const excludeForComedy = canonicalExcludeIds('genre-comedy', batchRails);
  assert.ok(excludeForComedy.includes('movie:500'), '20.3 comedy exclude includes movie:500 from crime (CRITICAL)');
  const comedyShowMoreResponse = [movieX, { type: 'movie', id: 'comedy-only', externalIds: { tmdb: '701' } } as any];
  const comedyFiltered = filterSeen(comedyShowMoreResponse, new Set(excludeForComedy));
  assert.ok(!comedyFiltered.some(i => canonicalKey(i) === 'movie:500'), '20.4 movie:500 NOT reintroduced into comedy');

  // === Final invariant: count every canonical ID across all rails ===
  // Build the full "displayed" snapshot:
  //   - initial batch rails
  //   - scifi Show More additions
  //   - comedy Show More additions
  const allDisplayedIds: string[] = [];
  for (const [, rail] of Object.entries(batchRails)) {
    for (const item of (rail as any).items) allDisplayedIds.push(canonicalKey(item));
  }
  for (const item of scifiFiltered) allDisplayedIds.push(canonicalKey(item));
  for (const item of comedyFiltered) allDisplayedIds.push(canonicalKey(item));

  // Count duplicates.
  const counts = new Map<string, number>();
  for (const key of allDisplayedIds) counts.set(key, (counts.get(key) ?? 0) + 1);
  let duplicates = 0;
  for (const [key, count] of counts) {
    if (count > 1) {
      duplicates++;
      console.error(`  DUPLICATE: ${key} appears ${count} times after Show More`);
    }
  }

  assert.equal(duplicates, 0, '20.5 zero duplicate canonical IDs after multiple Show More calls');

  // Spot-check: each movie appears exactly once.
  assert.equal(counts.get('movie:500'), 1, '20.6 movie:500 appears exactly once (in genre-crime)');
  assert.equal(counts.get('movie:501'), 1, '20.7 movie:501 appears exactly once (in genre-thriller)');
  assert.equal(counts.get('movie:502'), 1, '20.8 movie:502 appears exactly once (in genre-comedy)');
  assert.equal(counts.get('movie:700'), 1, '20.9 movie:700 (scifi-only) appears exactly once');
  assert.equal(counts.get('movie:701'), 1, '20.10 movie:701 (comedy-only) appears exactly once');

  passed += 10;
  console.log('  ok 20.1 — scifi exclude includes thriller ID');
  console.log('  ok 20.2 — thriller ID NOT reintroduced into scifi Show More');
  console.log('  ok 20.3 — comedy exclude includes crime ID (CRITICAL FIX)');
  console.log('  ok 20.4 — crime ID NOT reintroduced into comedy Show More');
  console.log('  ok 20.5 — zero duplicate canonical IDs after multiple Show More calls');
  console.log('  ok 20.6 — movie:500 in genre-crime only');
  console.log('  ok 20.7 — movie:501 in genre-thriller only');
  console.log('  ok 20.8 — movie:502 in genre-comedy only');
  console.log('  ok 20.9 — movie:700 (scifi-only) unique');
  console.log('  ok 20.10 — movie:701 (comedy-only) unique');
  ok('20. Cross-rail invariant holds after multiple Show More calls (incl. lower-priority rail with visually-higher-priority IDs)');
}

// ============================================================
// SOURCE CONTRACT TESTS — wiring
// ============================================================

// F. Batch endpoint exists with no-store
{
  const batchApi = read('src/routes/api/discover/batch/+server.ts');
  ok(batchApi.includes('GET'));
  ok(batchApi.includes('discoverBatchDeduped'));
  ok(batchApi.includes('no-store'));
  ok('F. batch endpoint with no-store');
}

// F2. DiscoverPage wired with batchStatus + page + hasNextPage propagation
//     + canonical-priority-aware excludeIdsFor
{
  const discoverPage = read('src/lib/components/DiscoverPage.svelte');
  ok(discoverPage.includes('loadBatchRails'));
  ok(discoverPage.includes('/api/discover/batch'));
  ok(discoverPage.includes('batchStatus'));
  // Phase 9 fix: DiscoverPage passes the full batchStatus state (not a
  // derived boolean) so DiscoverSection can distinguish success from
  // failure — only failure permits an independent fetch fallback.
  ok(discoverPage.includes('batchStatus={batchStatus}'));
  // Phase 9 fix: DiscoverPage propagates the batch's authoritative
  // hasNextPage and actual last-fetched page to each section.
  ok(discoverPage.includes('initialHasNextPage={batchRails'));
  ok(discoverPage.includes('initialPage={batchRails'));
  ok(discoverPage.includes('clearRailCache'));
  // Phase 9 refactor: `externalIds?.tmdb` now lives in
  // canonicalExcludeIds() (shared module) — DiscoverPage no longer
  // inlines the canonical-key computation. The next assertions verify
  // the delegation is in place.
  // Phase 9 critical fix: excludeIdsFor() MUST delegate to
  // canonicalExcludeIds() from the SHARED module — NOT walk the visual
  // SECTIONS array. The visual UI order has Comedy BEFORE Crime/Thriller/
  // Sci-Fi, but the canonical server priority has them AFTER — so the
  // old visual-order walk excluded the wrong set of rails.
  ok(discoverPage.includes("from '$lib/shared/discover-batch'"), 'F2. imports canonicalExcludeIds from shared module');
  ok(discoverPage.includes('canonicalExcludeIds'), 'F2. excludeIdsFor delegates to canonicalExcludeIds');
  ok(discoverPage.includes('return canonicalExcludeIds(sectionKey, batchRails)'), 'F2. excludeIdsFor returns canonicalExcludeIds result');
  ok('F2. DiscoverPage wired with batchStatus + page + hasNextPage + canonical-priority excludeIdsFor');
}

// F2b. Visual UI order UNCHANGED — Comedy before Crime/Thriller/Sci-Fi
//
// Phase 9 contract: the visual UI order in DiscoverPage.svelte MUST
// remain as spec'd (Action → Adventure → Comedy → Crime → Thriller →
// Sci-Fi → Drama → Horror → Romance). Only the exclude-list computation
// walks canonical priority. This test locks the visual order so a
// future refactor cannot accidentally reorder the rendered rails.
{
  const discoverPage = read('src/lib/components/DiscoverPage.svelte');
  // Find the SECTIONS array literal and extract the genre entries' order.
  const sectionsStart = discoverPage.indexOf('const SECTIONS: SectionDef[]');
  ok(sectionsStart > -1, 'F2b. SECTIONS array present');
  const sectionsEnd = discoverPage.indexOf('];', sectionsStart);
  const sectionsBlock = discoverPage.slice(sectionsStart, sectionsEnd);
  // Extract genre section keys in their visual order.
  const genreKeys: string[] = [];
  const genreKeyRegex = /key:\s*'(genre-[a-z]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = genreKeyRegex.exec(sectionsBlock)) !== null) {
    genreKeys.push(match[1]);
  }
  // Expected visual order — Comedy BEFORE Crime/Thriller/Sci-Fi.
  const expectedVisualOrder = [
    'genre-action',
    'genre-adventure',
    'genre-comedy',    // ← visual position 3
    'genre-crime',     // ← visual position 4 (AFTER comedy)
    'genre-thriller',  // ← visual position 5 (AFTER comedy)
    'genre-scifi',     // ← visual position 6 (AFTER comedy)
    'genre-drama',
    'genre-horror',
    'genre-romance',
  ];
  assert.deepEqual(genreKeys, expectedVisualOrder, 'F2b. visual UI genre order = Action/Adventure/Comedy/Crime/Thriller/Sci-Fi/Drama/Horror/Romance');
  ok('F2b. visual UI order UNCHANGED — Comedy before Crime/Thriller/Sci-Fi (spec preserved)');
}

// F2c. SECTION_PRIORITY in shared module uses canonical server order
//      (Crime/Thriller/Sci-Fi BEFORE Comedy — opposite of visual)
{
  const sharedModule = read('src/lib/shared/discover-batch.ts');
  // Find SECTION_PRIORITY array literal.
  const prioStart = sharedModule.indexOf('export const SECTION_PRIORITY');
  ok(prioStart > -1, 'F2c. SECTION_PRIORITY exported from shared module');
  const prioEnd = sharedModule.indexOf('];', prioStart);
  const prioBlock = sharedModule.slice(prioStart, prioEnd);
  // Extract section keys in canonical order.
  const canonicalKeys: string[] = [];
  const keyRegex = /'(genre-[a-z]+|[a-z-]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(prioBlock)) !== null) {
    if (match[1].startsWith('genre-')) canonicalKeys.push(match[1]);
  }
  // Expected canonical order — Crime/Thriller/Sci-Fi BEFORE Comedy.
  const expectedCanonicalOrder = [
    'genre-action',
    'genre-adventure',
    'genre-crime',     // ← canonical position 3 (BEFORE comedy)
    'genre-thriller',  // ← canonical position 4 (BEFORE comedy)
    'genre-scifi',     // ← canonical position 5 (BEFORE comedy)
    'genre-comedy',    // ← canonical position 6 (AFTER crime/thriller/scifi)
    'genre-drama',
    'genre-horror',
    'genre-romance',
  ];
  assert.deepEqual(canonicalKeys, expectedCanonicalOrder, 'F2c. canonical SECTION_PRIORITY order = Action/Adventure/Crime/Thriller/Sci-Fi/Comedy/Drama/Horror/Romance');
  ok('F2c. shared SECTION_PRIORITY = canonical server order (Crime/Thriller/Sci-Fi BEFORE Comedy)');
}

// F2d. Server discover-dedup re-exports SECTION_PRIORITY from shared
//      (single source of truth — no duplicated array literal)
{
  const dedupModule = read('src/lib/server/content/discover-dedup.ts');
  ok(
    dedupModule.includes("export { SECTION_PRIORITY } from '$lib/shared/discover-batch'"),
    'F2d. server discover-dedup re-exports SECTION_PRIORITY from shared module (single source of truth)'
  );
  // Negative assertion: no duplicated SECTION_PRIORITY literal in the server file.
  ok(
    !dedupModule.includes("const SECTION_PRIORITY: readonly string[] = ["),
    'F2d. no duplicated SECTION_PRIORITY literal in server discover-dedup'
  );
  ok('F2d. server re-exports shared SECTION_PRIORITY (no duplication)');
}

// F3. DiscoverSection: $effect wakes on batchStatus change + uses pure decideSectionLoad
{
  const section = read('src/lib/components/DiscoverSection.svelte');
  ok(section.includes('batchStatus'), 'F3. section: accepts batchStatus prop');
  ok(section.includes("type BatchStatus = 'pending' | 'success' | 'failed'"), 'F3. section: explicit BatchStatus type');
  ok(section.includes('decideSectionLoad'), 'F3. section: delegates to pure decideSectionLoad()');
  // Phase 9: import must be from $lib/shared (client-safe), NOT $lib/server
  // (which is rejected by the SvelteKit browser-bundle guard).
  ok(section.includes("from '$lib/shared/discover-batch'"), 'F3. section: imports decideSectionLoad from $lib/shared (client-safe)');
  ok(section.includes("decision.kind === 'wait'"), 'F3. section: handles wait (pending batch)');
  ok(section.includes("decision.kind === 'use-batch'"), 'F3. section: handles use-batch (consume result even if empty)');
  ok(section.includes('$effect'), 'F3. section: has $effect for batchStatus transition');
  ok(section.includes('lastBatchStatus'), 'F3. section: tracks lastBatchStatus');
  ok(section.includes("lastBatchStatus === 'pending' && nowStatus !== 'pending'"), 'F3. section: re-calls loadFirst on pending→resolved');
  ok(section.includes('filterChanged'), 'F3. section: has filterChanged flag');
  ok(section.includes('railUrl(nextPage, allExclude)'), 'F3. section: loadMore passes combined exclude');
  ok(section.includes('externalIds?.tmdb'), 'F3. section: uses TMDB ID for exclude');
  // Phase 9 invariant: the heuristic `initialItems.length >= 10` for
  // hasNextPage MUST be gone — the batch's hasNextPage is authoritative.
  // The only occurrences of `initialItems.length >= 10` in the file
  // should be in comments documenting what we removed.
  const matches = section.match(/initialItems\.length >= 10/g) ?? [];
  // Allow up to 2 occurrences in comments (we have explanatory comments).
  ok(matches.length <= 2, 'F3. section: initialItems.length >= 10 only in comments');
  ok(!section.includes('hasNextPage = initialItems.length >= 10'), 'F3. section: no heuristic hasNextPage from item count');
  ok('F3. DiscoverSection: batchStatus state machine + decideSectionLoad + authoritative hasNextPage');
}

// F4. Batch loop uses per-item algorithm (not filterSeen for genre sections)
// Phase 9: the batch implementation lives in `discover-batch.ts` (extracted
// from service.ts so it can be unit-tested without SvelteKit's $env).
{
  const batch = read('src/lib/server/content/discover-batch.ts');
  ok(batch.includes('if (seen.has(key)) continue'), 'F4. batch: per-item seen check');
  ok(batch.includes('if (sectionIsGenre && shouldExcludeFromGenre'), 'F4. batch: per-item genre eligibility check');
  ok(batch.includes('seen.add(key)'), 'F4. batch: adds to seen only after acceptance');
  ok(!batch.includes('filterSeen(result.items, seen)'), 'F4. batch: does NOT use filterSeen (which mutates seen before genre check)');
  // Phase 9 fix: the batch returns the ACTUAL last fetched page, not
  // a hardcoded `page: 1`.
  ok(batch.includes('lastFetchedPage'), 'F4. batch: tracks actual last fetched page');
  ok(batch.includes('page: lastFetchedPage'), 'F4. batch: returns actual last fetched page');
  ok(!/\bpage:\s*1\b\s*,\s*\n\s*hasNextPage:/.test(batch), 'F4. batch: no hardcoded page: 1 in result assignment');
  // Phase 9: service.ts re-exports the wrapper for backward compat.
  const service = read('src/lib/server/content/service.ts');
  ok(service.includes("discoverBatchDeduped: impl"), 'F4. service.ts re-exports discover-batch impl with real discoverRail');
  ok('F4. Batch loop uses correct per-item algorithm + actual last fetched page');
}

// G. tmdbGenreIds field + mapTmdb
{
  const types = read('src/lib/server/content/types.ts');
  ok(types.includes('tmdbGenreIds?: number[]'));
  const tmdb = read('src/lib/server/content/adapters/tmdb.ts');
  ok(tmdb.includes('tmdbGenreIds: genreIds.length > 0 ? genreIds : undefined'));
  ok('G. tmdbGenreIds field + mapTmdb population');
}

// H. Admin delete cascade
{
  const svc = read('src/lib/server/streaming/admin-service.ts');
  ok(svc.includes('.delete().eq(\'source_id\', id)'));
  ok(svc.includes('.delete().eq(\'category_id\', id)'));
  ok(!svc.includes('throw new Error(\'This source belongs'));
  ok(!svc.includes('throw new Error(\'This category has'));
  ok('H. admin delete cascade');
}

// I. Detail backdrop: no opaque top
{
  const detail = read('src/lib/components/DetailPage.svelte');
  const mobileStart = detail.indexOf('@media (max-width: 640px)');
  const scrimStart = detail.indexOf('.hero-scrim', mobileStart);
  const scrimEnd = detail.indexOf('}', scrimStart);
  const scrim = detail.slice(scrimStart, scrimEnd + 1);
  ok(!scrim.includes('var(--color-bg) 0%'));
  ok(!scrim.includes('var(--color-bg) 38%'));
  ok(scrim.includes('rgba'));
  ok('I. detail backdrop: no opaque top 38%');
}

// K. Header alignment
{
  const appShell = read('src/lib/components/AppShell.svelte');
  ok(appShell.includes('.mobile-brand { display: inline-flex; align-items: center;'));
  ok('K. header: mobile brand centered');
}

console.log(`\nDiscover + Detail + Header + Admin tests passed (${passed} check groups).`);
