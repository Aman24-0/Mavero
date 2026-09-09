import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Search TV Classification Regression Test
//
// BUG 1: Search TV results were always empty because classifySearchRow
// passed the normalized ID "series-1399" to getTmdbDetail() which
// expects a numeric TMDB ID. Number("series-1399") → NaN → detail
// lookup failed → 'uncertain' → fail-closed exclusion → ALL TV
// results excluded.
//
// FIX: classifySearchRow now uses item.externalIds?.tmdb (the canonical
// numeric TMDB ID, e.g. "1399") instead of String(item.id) (which is
// the prefixed "series-1399").

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const tmdbSource = readFileSync(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
const searchClassifySource = readFileSync(new URL('../src/lib/server/content/search-classify.ts', import.meta.url), 'utf8');

// ============================================================
// 1. classifySearchRow uses externalIds.tmdb (not item.id)
// ============================================================
console.log('\n1. classifySearchRow uses externalIds.tmdb');

// The fixed code must use item.externalIds?.tmdb, NOT String(item.id).
assert.match(tmdbSource, /const tmdbId = item\.externalIds\?\.tmdb/,
  'classifySearchRow reads item.externalIds?.tmdb');
assert.match(tmdbSource, /if \(!tmdbId \|\| !\/\^\\d\+\$\/\.test\(tmdbId\)\) return 'uncertain'/,
  'classifySearchRow validates tmdbId is numeric before calling getTmdbDetail');
assert.match(tmdbSource, /getTmdbDetail\('series', tmdbId\)/,
  'classifySearchRow calls getTmdbDetail with the numeric tmdbId');

// The OLD broken pattern must NOT be present in classifySearchRow.
// The old code was: getTmdbDetail('series', String(item.id))
// where item.id = "series-1399". We verify the specific function body
// does NOT contain String(item.id) passed to getTmdbDetail.
const classifyFnMatch = tmdbSource.match(/async function classifySearchRow[\s\S]*?\n\}/);
assert.ok(classifyFnMatch, 'classifySearchRow function found');
assert.doesNotMatch(classifyFnMatch![0], /getTmdbDetail\('series', String\(item\.id\)\)/,
  'classifySearchRow must NOT pass String(item.id) to getTmdbDetail (was the root cause)');
ok('classifySearchRow uses externalIds.tmdb, not the prefixed item.id');

// ============================================================
// 2. Movie search behavior unchanged
// ============================================================
console.log('\n2. Movie search behavior unchanged');

assert.match(classifyFnMatch![0], /if \(item\.type === 'movie'\) return movieRowVerdict/,
  'movie classification still uses movieRowVerdict (unchanged)');
ok('Movie search classification unchanged (movieRowVerdict)');

// ============================================================
// 3. Adult TV still excluded (fail-closed behavior preserved)
// ============================================================
console.log('\n3. Adult TV exclusion + fail-closed preserved');

// The 'uncertain' return on missing/invalid tmdbId preserves fail-closed.
assert.match(classifyFnMatch![0], /return 'uncertain'/,
  'classifySearchRow returns uncertain on missing/invalid tmdbId (fail-closed)');
// The catch block still returns 'uncertain'.
assert.match(classifyFnMatch![0], /catch \{[\s\S]*?return 'uncertain'/,
  'classifySearchRow returns uncertain on getTmdbDetail failure (fail-closed)');
// The orchestrator's fail-closed behavior is unchanged.
assert.match(searchClassifySource, /if \(excludeUncertain\) continue/,
  'collectSafeSearchPage still excludes uncertain when excludeUncertain is true');
ok('Adult TV exclusion + fail-closed behavior preserved');

// ============================================================
// 4. mapTmdb creates prefixed IDs + externalIds.tmdb
// ============================================================
console.log('\n4. mapTmdb ID format confirmed');

const mapTmdbMatch = tmdbSource.match(/function mapTmdb[\s\S]*?externalIds[\s\S]*?return \{/);
assert.ok(mapTmdbMatch, 'mapTmdb function found');
assert.ok(tmdbSource.includes('id: `${type}-${raw.id}`'),
  'mapTmdb creates prefixed ID like "series-1399"');
assert.ok(tmdbSource.includes('tmdb: String(raw.id)'),
  'mapTmdb sets externalIds.tmdb to the raw numeric ID "1399"');
ok('mapTmdb creates prefixed id ("series-1399") + externalIds.tmdb ("1399")');

// ============================================================
// 5. Real production shape: normalized TV item
// ============================================================
console.log('\n5. Production shape: normalized TV item');

// Verify the NormalizedMediaItem type has externalIds.tmdb.
const typesSource = readFileSync(new URL('../src/lib/server/content/types.ts', import.meta.url), 'utf8');
assert.match(typesSource, /externalIds\?: \{[\s\S]*?tmdb\?: string/,
  'NormalizedMediaItem has externalIds.tmdb (string)');
ok('NormalizedMediaItem type has externalIds.tmdb — the canonical numeric TMDB ID');

// ============================================================
// 6. No other getTmdbDetail(item.id) patterns remain in search path
// ============================================================
console.log('\n6. No broken getTmdbDetail(item.id) in search path');

// Verify the search path (searchTmdb function) does not pass
// String(item.id) to getTmdbDetail anywhere else.
const searchTmdbMatch = tmdbSource.match(/export async function searchTmdb[\s\S]*?\n\}/);
assert.ok(searchTmdbMatch, 'searchTmdb function found');
assert.doesNotMatch(searchTmdbMatch![0], /getTmdbDetail\('series', String\(item\.id\)\)/,
  'searchTmdb path has no remaining getTmdbDetail(String(item.id)) calls');
ok('No broken getTmdbDetail(item.id) patterns in the search path');

// ============================================================
// 7. Popular TV soap check is NOT affected (different item type)
// ============================================================
console.log('\n7. Popular TV soap check uses raw TMDB ID (correct)');

// The popular TV path uses TmdbMedia[] (raw rows), where item.id is
// already the numeric TMDB ID. String(item.id) there is correct.
assert.ok(tmdbSource.includes("getTmdbDetail('series', String(item.id))"),
  'popular TV soap check uses String(item.id) — correct because filtered is TmdbMedia[] (raw numeric IDs)');
ok('Popular TV soap check correctly uses raw TMDB ID (different from search path)');

console.log(`\nSearch TV classification tests passed (${passed} check groups).`);
