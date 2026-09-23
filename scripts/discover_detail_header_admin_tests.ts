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
// DISCOVER CROSS-RAIL DEDUP TESTS
// ============================================================

// A. Discover dedup module exists
{
  const dedup = read('src/lib/server/content/discover-dedup.ts');
  ok(dedup.includes('canonicalKey'), 'A. dedup: has canonicalKey function');
  ok(dedup.includes('SECTION_PRIORITY'), 'A. dedup: has SECTION_PRIORITY array');
  ok(dedup.includes('GENRE_PRIORITY'), 'A. dedup: has GENRE_PRIORITY array');
  ok(dedup.includes('filterSeen'), 'A. dedup: has filterSeen function');
  ok(dedup.includes('canonicalGenreSection'), 'A. dedup: has canonicalGenreSection function');
  ok('A. discover dedup module exists');
}

// B. Canonical identity
{
  const { canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');
  assert.equal(canonicalKey({ type: 'movie', id: '550' }), 'movie:550');
  assert.equal(canonicalKey({ type: 'series', id: '1399' }), 'series:1399');
  ok(true, 'B. canonicalKey: movie:550');
  ok(true, 'B. canonicalKey: series:1399');
  passed += 2;
  ok('B. canonical identity (type:id)');
}

// C. Section priority order
{
  const { SECTION_PRIORITY } = await import('../src/lib/server/content/discover-dedup.ts');
  ok(SECTION_PRIORITY[0] === 'theatre', 'C. priority: theatre is #1');
  ok(SECTION_PRIORITY[1] === 'new-ott', 'C. priority: new-ott is #2');
  ok(SECTION_PRIORITY.indexOf('popular-movie') < SECTION_PRIORITY.indexOf('genre-action'), 'C. priority: popular before genres');
  ok(SECTION_PRIORITY.indexOf('top-rated-movie') < SECTION_PRIORITY.indexOf('genre-action'), 'C. priority: top-rated before genres');
  ok('C. section priority order (theatre > new-ott > popular > top-rated > genres)');
}

// D. Canonical genre assignment (deterministic)
{
  const { canonicalGenreSection } = await import('../src/lib/server/content/discover-dedup.ts');
  // Action + Comedy → Action (higher priority)
  assert.equal(canonicalGenreSection([28, 35]), 'genre-action');
  // Adventure + Drama → Adventure
  assert.equal(canonicalGenreSection([12, 18]), 'genre-adventure');
  // Crime + Thriller → Crime
  assert.equal(canonicalGenreSection([80, 53]), 'genre-crime');
  // Sci-Fi only → Sci-Fi
  assert.equal(canonicalGenreSection([878]), 'genre-scifi');
  // No matching genres → null
  assert.equal(canonicalGenreSection([99]), null);
  // Empty → null
  assert.equal(canonicalGenreSection([]), null);
  // Undefined → null
  assert.equal(canonicalGenreSection(undefined), null);
  passed += 6;
  console.log('  ok D.1 — Action+Comedy → Action');
  console.log('  ok D.2 — Adventure+Drama → Adventure');
  console.log('  ok D.3 — Crime+Thriller → Crime');
  console.log('  ok D.4 — Sci-Fi only → Sci-Fi');
  console.log('  ok D.5 — No matching → null');
  console.log('  ok D.6 — Empty → null');
  ok('D. canonical genre assignment (deterministic, first-priority match)');
}

// E. filterSeen removes duplicates
{
  const { filterSeen, canonicalKey } = await import('../src/lib/server/content/discover-dedup.ts');
  const items = [
    { id: '1', type: 'movie', title: 'A' },
    { id: '2', type: 'movie', title: 'B' },
    { id: '1', type: 'movie', title: 'A' }, // duplicate
    { id: '3', type: 'series', title: 'C' },
  ] as any[];
  const seen = new Set<string>();
  const result = filterSeen(items, seen);
  assert.equal(result.length, 3);
  assert.equal(seen.size, 3);
  ok(true, 'E. filterSeen: 3 unique items from 4 (1 duplicate removed)');
  ok(true, 'E. filterSeen: seen set has 3 entries');
  passed += 2;
  ok('E. filterSeen removes duplicates');
}

// F. Batch endpoint exists
{
  const batchApi = read('src/routes/api/discover/batch/+server.ts');
  ok(batchApi.includes('GET'), 'F. batch: GET handler');
  ok(batchApi.includes('discoverBatchDeduped'), 'F. batch: calls discoverBatchDeduped');
  ok(batchApi.includes('rails'), 'F. batch: returns rails object');
  ok('F. batch discover endpoint exists');
}

// G. Rail endpoint supports exclude parameter
{
  const railApi = read('src/routes/api/discover/rail/+server.ts');
  ok(railApi.includes("exclude"), 'G. rail: accepts exclude parameter');
  ok(railApi.includes('excludeSet'), 'G. rail: builds excludeSet');
  ok(railApi.includes('filterSeen'), 'G. rail: calls filterSeen');
  ok(railApi.includes('TARGET_ITEMS'), 'G. rail: has bounded continuation target');
  ok(railApi.includes('MAX_PAGES'), 'G. rail: has max pages limit');
  ok('G. rail endpoint supports exclude parameter with bounded continuation');
}

// H. discoverBatchDeduped function exists in service
{
  const service = read('src/lib/server/content/service.ts');
  ok(service.includes('export async function discoverBatchDeduped'), 'H. service: has discoverBatchDeduped');
  ok(service.includes('SECTION_PRIORITY'), 'H. service: uses SECTION_PRIORITY');
  ok(service.includes('filterSeen'), 'H. service: uses filterSeen');
  ok(service.includes('TARGET_ITEMS'), 'H. service: has target items');
  ok('H. discoverBatchDeduped function exists');
}

// ============================================================
// DETAIL PAGE BACKDROP TESTS
// ============================================================

// I. No opaque top 38% on mobile
{
  const detail = read('src/lib/components/DetailPage.svelte');
  // The mobile @media override should NOT have var(--color-bg) at 0% or 38%
  const mobileStart = detail.indexOf('@media (max-width: 640px)');
  const scrimStart = detail.indexOf('.hero-scrim', mobileStart);
  const scrimEnd = detail.indexOf('}', scrimStart);
  const scrimSection = detail.slice(scrimStart, scrimEnd + 1);

  ok(!scrimSection.includes('var(--color-bg) 0%'), 'I. mobile scrim: NO opaque var(--color-bg) at 0%');
  ok(!scrimSection.includes('var(--color-bg) 38%'), 'I. mobile scrim: NO opaque var(--color-bg) at 38%');
  ok(scrimSection.includes('rgba'), 'I. mobile scrim: uses semi-transparent rgba (backdrop visible)');

  ok('I. detail backdrop: no opaque top 38%, backdrop visible from top');
}

// ============================================================
// HEADER ALIGNMENT TESTS
// ============================================================

// J. Mobile brand uses align-items: center
{
  const appShell = read('src/lib/components/AppShell.svelte');
  ok(appShell.includes('.mobile-brand { display: inline-flex; align-items: center;'), 'J. AppShell: .mobile-brand has align-items: center');
  ok(appShell.includes('gap: 9px'), 'J. AppShell: .mobile-brand has gap: 9px (matches desktop)');
  ok('J. header: mobile brand uses centered alignment');
}

// ============================================================
// ADMIN CATEGORY/SOURCE DELETE CASCADE TESTS
// ============================================================

// K. deleteSource cascades mappings
{
  const service = read('src/lib/server/streaming/admin-service.ts');
  const fnStart = service.indexOf('export async function deleteSource');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);

  ok(fnBody.includes('streaming_source_categories'), 'K. deleteSource: touches streaming_source_categories');
  ok(fnBody.includes('.delete()'), 'K. deleteSource: deletes mappings');
  ok(fnBody.includes('.eq(\'source_id\', id)'), 'K. deleteSource: scoped by source_id');
  ok(!fnBody.includes('throw new Error'), 'K. deleteSource: does NOT throw on existing mappings');
  ok('K. deleteSource cascades mappings (no refusal)');
}

// L. deleteCategory cascades mappings
{
  const service = read('src/lib/server/streaming/admin-service.ts');
  const fnStart = service.indexOf('export async function deleteCategory');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);

  ok(fnBody.includes('streaming_source_categories'), 'L. deleteCategory: touches streaming_source_categories');
  ok(fnBody.includes('.delete()'), 'L. deleteCategory: deletes mappings');
  ok(fnBody.includes('.eq(\'category_id\', id)'), 'L. deleteCategory: scoped by category_id');
  ok(!fnBody.includes('throw new Error'), 'L. deleteCategory: does NOT throw on existing mappings');
  ok('L. deleteCategory cascades mappings (no refusal)');
}

// M. Confirm dialogs updated
{
  const categories = read('src/routes/admin/categories/+page.svelte');
  const sources = read('src/routes/admin/sources/+page.svelte');

  ok(!categories.includes('must be removed first'), 'M. categories: confirm dialog no longer says "must be removed first"');
  ok(categories.includes('All source assignments will be removed'), 'M. categories: confirm says "All source assignments will be removed"');

  ok(!sources.includes('must be removed first'), 'M. sources: confirm dialog no longer says "must be removed first"');
  ok(sources.includes('All category assignments will be removed'), 'M. sources: confirm says "All category assignments will be removed"');
  ok('M. confirm dialogs updated for cascade delete');
}

console.log(`\nDiscover + Detail + Header + Admin tests passed (${passed} check groups).`);
