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
// BEHAVIORAL TESTS — discover-dedup module
// ============================================================

// A. canonicalKey uses TMDB numeric ID via externalIds
{
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');
  // Real-shape NormalizedMediaItem from mapTmdb()
  const movie550 = { type: 'movie', id: 'movie-550', externalIds: { tmdb: '550' } };
  const series1399 = { type: 'series', id: 'series-1399', externalIds: { tmdb: '1399' } };
  const movie550NoExt = { type: 'movie', id: 'movie-550' }; // fallback case

  assert.equal(canonicalKey(movie550), 'movie:550', 'A. movie:550 (TMDB numeric ID)');
  assert.equal(canonicalKey(series1399), 'series:1399', 'A. series:1399');
  assert.equal(canonicalKey(movie550NoExt), 'movie:movie-550', 'A. fallback to raw id when no externalIds');
  passed += 3;
  console.log('  ok A.1 — canonicalKey uses TMDB numeric ID');
  console.log('  ok A.2 — canonicalKey uses TMDB numeric ID for series');
  console.log('  ok A.3 — canonicalKey falls back to raw id when no externalIds');
  ok('A. canonicalKey uses TMDB numeric ID via externalIds');
}

// J. movie:550 and series:550 remain separate
{
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');
  const movie = { type: 'movie', id: 'movie-550', externalIds: { tmdb: '550' } };
  const series = { type: 'series', id: 'series-550', externalIds: { tmdb: '550' } };
  assert.notEqual(canonicalKey(movie), canonicalKey(series), 'J. movie:550 ≠ series:550');
  passed += 1;
  ok('J. movie:550 and series:550 remain separate');
}

// B. filterSeen removes duplicates by canonical key
{
  const { filterSeen } = await import('../src/lib/server/content/discover-dedup.ts');
  const items = [
    { id: 'movie-1', type: 'movie', externalIds: { tmdb: '1' } },
    { id: 'movie-2', type: 'movie', externalIds: { tmdb: '2' } },
    { id: 'movie-1', type: 'movie', externalIds: { tmdb: '1' } }, // duplicate
    { id: 'series-3', type: 'series', externalIds: { tmdb: '3' } },
  ] as any[];
  const seen = new Set<string>();
  const result = filterSeen(items, seen);
  assert.equal(result.length, 3, 'B. filterSeen: 3 unique from 4');
  assert.equal(seen.size, 3, 'B. filterSeen: seen has 3 entries');
  passed += 2;
  ok('B. filterSeen removes duplicates by canonical key');
}

// C. canonicalGenreSection: Action+Comedy → Action
{
  const { canonicalGenreSection } = await import('../src/lib/server/content/discover-dedup.ts');
  assert.equal(canonicalGenreSection([28, 35]), 'genre-action', 'C. Action+Comedy → Action');
  assert.equal(canonicalGenreSection([12, 18]), 'genre-adventure', 'C. Adventure+Drama → Adventure');
  assert.equal(canonicalGenreSection([80, 53]), 'genre-crime', 'C. Crime+Thriller → Crime');
  assert.equal(canonicalGenreSection([18]), 'genre-drama', 'C. Drama only → Drama');
  assert.equal(canonicalGenreSection([99]), null, 'C. No matching genre → null');
  assert.equal(canonicalGenreSection(undefined), null, 'C. undefined → null');
  assert.equal(canonicalGenreSection([]), null, 'C. empty → null');
  passed += 7;
  console.log('  ok C.1 — Action+Comedy → Action');
  console.log('  ok C.2 — Adventure+Drama → Adventure');
  console.log('  ok C.3 — Crime+Thriller → Crime');
  console.log('  ok C.4 — Drama only → Drama');
  console.log('  ok C.5 — No matching → null');
  console.log('  ok C.6 — undefined → null');
  console.log('  ok C.7 — empty → null');
  ok('C. canonicalGenreSection (deterministic first-priority match)');
}

// D. shouldExcludeFromGenre uses tmdbGenreIds
{
  const { shouldExcludeFromGenre } = await import('../src/lib/server/content/discover-dedup.ts');
  const actionComedyItem = { tmdbGenreIds: [28, 35], type: 'movie', id: '1', externalIds: { tmdb: '1' } } as any;
  assert.equal(shouldExcludeFromGenre(actionComedyItem, 'genre-action'), false, 'D. Action+Comedy NOT excluded from Action');
  assert.equal(shouldExcludeFromGenre(actionComedyItem, 'genre-comedy'), true, 'D. Action+Comedy IS excluded from Comedy');
  const noGenreItem = { type: 'movie', id: '2', externalIds: { tmdb: '2' } } as any;
  assert.equal(shouldExcludeFromGenre(noGenreItem, 'genre-action'), false, 'D. No genre info → not excluded');
  passed += 3;
  ok('D. shouldExcludeFromGenre uses tmdbGenreIds');
}

// E. SECTION_PRIORITY order
{
  const { SECTION_PRIORITY } = await import('../src/lib/server/content/discover-dedup.ts');
  ok(SECTION_PRIORITY[0] === 'theatre', 'E. priority: theatre #1');
  ok(SECTION_PRIORITY.indexOf('popular-movie') < SECTION_PRIORITY.indexOf('genre-action'), 'E. popular before genres');
  ok('E. section priority order');
}

// ============================================================
// SOURCE CONTRACT TESTS — wiring
// ============================================================

// F. Batch endpoint exists with no-store
{
  const batchApi = read('src/routes/api/discover/batch/+server.ts');
  ok(batchApi.includes('GET'), 'F. batch: GET handler');
  ok(batchApi.includes('discoverBatchDeduped'), 'F. batch: calls discoverBatchDeduped');
  ok(batchApi.includes('no-store'), 'F. batch: no-store cache-control');
  ok('F. batch discover endpoint exists with no-store');
}

// F2. DiscoverPage wired to batch with batchStatus
{
  const discoverPage = read('src/lib/components/DiscoverPage.svelte');
  ok(discoverPage.includes('loadBatchRails'), 'F2. DiscoverPage: has loadBatchRails');
  ok(discoverPage.includes('/api/discover/batch'), 'F2. DiscoverPage: calls batch endpoint');
  ok(discoverPage.includes('batchStatus'), 'F2. DiscoverPage: has batchStatus state');
  ok(discoverPage.includes("batchPending={batchStatus === 'pending'}"), 'F2. DiscoverPage: passes batchPending to sections');
  ok(discoverPage.includes('clearRailCache'), 'F2. DiscoverPage: clears rail cache on batch success');
  ok(discoverPage.includes('excludeIdsFor'), 'F2. DiscoverPage: has excludeIdsFor');
  ok(discoverPage.includes('externalIds?.tmdb'), 'F2. DiscoverPage: excludeIdsFor uses TMDB ID');
  ok('F2. DiscoverPage wired to batch with batchStatus + cache clearing');
}

// F3. DiscoverSection respects batchPending + filterChanged
{
  const section = read('src/lib/components/DiscoverSection.svelte');
  ok(section.includes('batchPending'), 'F3. section: accepts batchPending prop');
  ok(section.includes('if (batchPending && !filterChanged)'), 'F3. section: waits for batch when pending');
  ok(section.includes('filterChanged'), 'F3. section: has filterChanged flag');
  ok(section.includes('filterChanged = true'), 'F3. section: sets filterChanged on language/provider change');
  ok(!section.includes('includeExclude'), 'F3. section: railUrl no longer uses boolean includeExclude');
  ok(section.includes('railUrl(nextPage, allExclude)'), 'F3. section: loadMore passes combined exclude list to railUrl');
  ok(section.includes('externalIds?.tmdb'), 'F3. section: loadMore uses TMDB ID for exclude');
  ok('F3. DiscoverSection: batchPending + filterChanged + correct exclude wiring');
}

// G. tmdbGenreIds field on NormalizedMediaItem + populated in mapTmdb
{
  const types = read('src/lib/server/content/types.ts');
  ok(types.includes('tmdbGenreIds?: number[]'), 'G. NormalizedMediaItem: has tmdbGenreIds');
  const tmdb = read('src/lib/server/content/adapters/tmdb.ts');
  ok(tmdb.includes('tmdbGenreIds: genreIds.length > 0 ? genreIds : undefined'), 'G. mapTmdb: populates tmdbGenreIds');
  ok('G. tmdbGenreIds field + mapTmdb population');
}

// H. Admin delete cascade
{
  const service = read('src/lib/server/streaming/admin-service.ts');
  ok(service.includes('.delete().eq(\'source_id\', id)'), 'H. deleteSource: cascades mappings');
  ok(service.includes('.delete().eq(\'category_id\', id)'), 'H. deleteCategory: cascades mappings');
  ok(!service.includes('throw new Error(\'This source belongs'), 'H. deleteSource: no longer throws');
  ok(!service.includes('throw new Error(\'This category has'), 'H. deleteCategory: no longer throws');
  ok('H. admin delete cascade (mappings first, then parent)');
}

// I. Detail backdrop: no opaque top
{
  const detail = read('src/lib/components/DetailPage.svelte');
  const mobileStart = detail.indexOf('@media (max-width: 640px)');
  const scrimStart = detail.indexOf('.hero-scrim', mobileStart);
  const scrimEnd = detail.indexOf('}', scrimStart);
  const scrim = detail.slice(scrimStart, scrimEnd + 1);
  ok(!scrim.includes('var(--color-bg) 0%'), 'I. mobile scrim: NO opaque bg at 0%');
  ok(!scrim.includes('var(--color-bg) 38%'), 'I. mobile scrim: NO opaque bg at 38%');
  ok(scrim.includes('rgba'), 'I. mobile scrim: uses semi-transparent rgba');
  ok('I. detail backdrop: no opaque top 38%');
}

// K. Header alignment
{
  const appShell = read('src/lib/components/AppShell.svelte');
  ok(appShell.includes('.mobile-brand { display: inline-flex; align-items: center;'), 'K. mobile-brand: align-items center');
  ok('K. header: mobile brand uses centered alignment');
}

console.log(`\nDiscover + Detail + Header + Admin tests passed (${passed} check groups).`);

console.log(`\nDiscover + Detail + Header + Admin tests passed (${passed} check groups).`);
