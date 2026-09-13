import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Post-release fix — INDIAN POPULAR TV daily-soap exclusion policy.
//
// ROOT CAUSE (live TMDB verification, 2026-09-08): the Phase 8 genre
// exclusion (10764|10766|10767) is applied correctly, but TMDB tags Indian
// daily soaps with ONLY Drama (18) — the Soap genre is absent on every
// contaminating title. Genre metadata alone is INSUFFICIENT (prestige
// Drama-only shows like Rocket Boys must remain), so the policy uses the
// reliable TMDB detail field `number_of_episodes`: Indian daily/weekly
// soaps are serials by production model (measured 198-957 episodes on the
// contaminating titles vs 10-32 on must-keep Indian OTT shows).
//
// Coverage:
//   - Policy boundaries (pure rule) against the LIVE-measured evidence
//   - Wiring: applied to the Popular TV rail ONLY (series half), with the
//     cache-key policy dimension, bounded concurrency, curation fail-open
//     detail handling, and every Phase 8 constraint retained
//   - Language paths: all flow through the same policy ('all' keeps its
//     single-page behavior)
//   - No title blacklist (the policy module never inspects titles)
//   - Adult exclusion, anime, Adult Discover, Search untouched

const policy = readFileSync(new URL('../src/lib/server/content/popular-tv-policy.ts', import.meta.url), 'utf8');
const tmdb = readFileSync(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
const animeAdapter = readFileSync(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// --- behavioral import (tsx resolves $lib via jsconfig paths) ---
const { INDIAN_POPULAR_TV_DAILY_SOAP_MAX_EPISODES, INDIAN_POPULAR_TV_SOAP_POLICY_KEY, INDIAN_POPULAR_TV_NO_SOAP_POLICY_KEY, isDailySoapEpisodeCount } = await import('$lib/server/content/popular-tv-policy');

// ============================================================
// 1. Policy constants + pure rule boundaries
// ============================================================
assert.equal(INDIAN_POPULAR_TV_DAILY_SOAP_MAX_EPISODES, 100, 'threshold is 100 released episodes');
assert.equal(typeof INDIAN_POPULAR_TV_SOAP_POLICY_KEY, 'string', 'policy cache-key dimension exists');
assert.notEqual(INDIAN_POPULAR_TV_SOAP_POLICY_KEY, INDIAN_POPULAR_TV_NO_SOAP_POLICY_KEY, 'policy dimension differs from the no-policy dimension');

// LIVE-MEASURED contaminating serials (TMDB number_of_episodes, 2026-09-08):
//   Patiala Babes /tv/85879 = 349; Vantalakka /tv/235424 = 957;
//   Pallakilo Pellikuturu /tv/235330 = 198; Meenakshi Ponnunga /tv/276583 = 637;
//   Bhoomige Bandha Bhagyantha /tv/275535 = 354  -> ALL excluded
for (const [episodes, label] of [[349, 'Patiala Babes'], [957, 'Vantalakka'], [198, 'Pallakilo Pellikuturu'], [637, 'Meenakshi Ponnunga'], [354, 'Bhoomige Bandha Bhagyantha']] as const) {
  assert.equal(isDailySoapEpisodeCount(episodes), true, `${label} (${episodes} episodes) is a serial -> excluded`);
}
// LIVE-MEASURED must-keep Indian OTT shows:
//   Panchayat 32; Scam 1992 10; Rocket Boys 16 (Drama-only, must stay);
//   Gullak 27; The Family Man 22; Kota Factory 15; Yeh Meri Family 15
for (const [episodes, label] of [[32, 'Panchayat'], [10, 'Scam 1992'], [16, 'Rocket Boys'], [27, 'Gullak'], [22, 'The Family Man'], [15, 'Kota Factory'], [15, 'Yeh Meri Family']] as const) {
  assert.equal(isDailySoapEpisodeCount(episodes), false, `${label} (${episodes} episodes) stays in the rail`);
}
// Boundaries + missing metadata (fail-open for curation):
assert.equal(isDailySoapEpisodeCount(100), false, 'exactly AT the threshold stays (strictly-greater rule)');
assert.equal(isDailySoapEpisodeCount(101), true, 'one past the threshold is excluded');
assert.equal(isDailySoapEpisodeCount(99), false, 'below the threshold stays');
assert.equal(isDailySoapEpisodeCount(undefined), false, 'missing metadata stays (curation fail-open)');
assert.equal(isDailySoapEpisodeCount(null), false, 'null metadata stays (curation fail-open)');
assert.equal(isDailySoapEpisodeCount(Number.NaN), false, 'non-finite metadata stays (curation fail-open)');
ok('1. daily-soap rule: boundaries + live-measured evidence (soaps out, prestige shows stay, fail-open on missing metadata)');

// ============================================================
// 2. Scope: Popular TV rail ONLY — series half applies the policy
// ============================================================
{
  const fn = tmdb.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
  assert.ok(fn, 'getTmdbPopularByLanguage found');
  const body = fn![0];
  // The series half applies the isolated policy via the cached detail path.
  assert.match(body, /if \(isSeries\) \{[\s\S]*?isDailySoapEpisodeCount/, 'soap policy applied in the series half');
  assert.match(body, /getTmdbDetail\('series', String\(item\.id\)\)/, 'episode count comes from the shared cached detail path');
  assert.match(body, /catch \{\s*return false;\s*\}/, 'a failed detail lookup keeps the candidate (curation fail-open)');
  assert.match(body, /INDIAN_POPULAR_TV_SOAP_CHECK_CONCURRENCY/, 'lookups are concurrency-bounded');
  // Deterministic survivor walk for specific languages; 'all' keeps its
  // single-page behavior (existing discover_v2 contract).
  assert.match(body, /deterministicSoapWalk = isSeries && language !== 'all'/, 'deterministic walk only for specific languages');
  assert.match(body, /if \(language === 'all'\) break/, "'all' still breaks after the first upstream page");
  // The movie half never applies it: the only soap-policy application is
  // inside the `if (isSeries)` guard (asserted above) and the movie key
  // dimension is the explicit no-policy constant.
  assert.match(body, /soapPolicyKey = type === 'series' \? INDIAN_POPULAR_TV_SOAP_POLICY_KEY : INDIAN_POPULAR_TV_NO_SOAP_POLICY_KEY/, 'movie half carries the no-soap-policy key dimension');
  ok('2. policy scope: Popular TV series half only, cached-detail based, fail-open, deterministic walk, movie half untouched');
}

// ============================================================
// 3. Cache keys embed the policy dimension (rule 13)
// ============================================================
{
  const fn = tmdb.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
  const body = fn![0];
  assert.match(body, /soapPolicyKey = type === 'series' \? INDIAN_POPULAR_TV_SOAP_POLICY_KEY : INDIAN_POPULAR_TV_NO_SOAP_POLICY_KEY/, 'policy key is a per-type constant dimension');
  assert.match(body, /:\$\{soapPolicyKey\}`/, 'cache key template ends with the soap-policy dimension');
  // The genre + adult dimensions are still in the key (Phase 8 contract).
  assert.match(body, /\$\{adultExclusion \?\? 'no-adult'\}:\$\{genreExclusion \?\? 'no-genre-exclusion'\}:\$\{soapPolicyKey\}/, 'adult + genre + soap dimensions all present');
  ok('3. cache key carries adult + genre + soap-policy dimensions (policy bump re-keys)');
}

// ============================================================
// 4. Every Phase 8 constraint retained (query unchanged, adult exclusion
//    unconditional, no Adult Mode conditional, no title inspection)
// ============================================================
{
  const fn = tmdb.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
  const body = fn![0];
  assert.match(body, /genreExclusion \? \{ without_genres: genreExclusion \}/, 'Phase 8 genre exclusion retained');
  assert.match(body, /type === 'series' \? POPULAR_TV_WITHOUT_GENRES : undefined/, 'TV-only genre exclusion retained');
  assert.match(body, /networkExclusion \? \{ without_networks: networkExclusion \}/, 'verified adult network exclusion retained (unconditional)');
  assert.match(body, /include_adult: false/, 'include_adult=false retained');
  assert.match(body, /watch_region: 'IN'/, 'India region retained');
  assert.match(body, /with_watch_monetization_types: 'flatrate'/, 'OTT flatrate bias retained');
  assert.match(body, /with_original_language: langParam/, 'language filter retained');
  assert.doesNotMatch(body, /canAccessAdult|adultMode|adult_mode|adultEnabled/i, 'no Adult Mode conditional anywhere near the rail');
  assert.doesNotMatch(body, /item\.title|item\.name|original_title|original_name/, 'NO title-based logic (never a blacklist)');
  // The policy module itself never inspects titles either (pure
  // episode-count metadata — the only "rule" input is a number).
  assert.doesNotMatch(policy, /\.title\b|\.name\b|toLowerCase\(\)|toUpperCase\(\)|\.includes\(/, 'policy module is pure episode-count metadata (no title inspection)');
  ok('4. Phase 8 constraints retained; no Adult Mode coupling; no title blacklist anywhere');
}

// ============================================================
// 5. Isolation: anime, Adult Discover, Search, Top Rated untouched
// ============================================================
{
  const animeFn = animeAdapter.match(/export async function getTmdbAnimeMerged[\s\S]*?^}/m);
  assert.ok(animeFn, 'getTmdbAnimeMerged found');
  assert.doesNotMatch(animeFn![0], /isDailySoapEpisodeCount|popular-tv-policy/, 'anime rails have NO soap policy');
  const adultFn = animeAdapter.match(/export async function getTmdbAdultDiscover[\s\S]*?^}/m);
  assert.ok(adultFn, 'getTmdbAdultDiscover found');
  assert.doesNotMatch(adultFn![0], /isDailySoapEpisodeCount|POPULAR_TV_WITHOUT_GENRES/, 'Adult Discover has NO soap/genre policy');
  const topRatedFn = animeAdapter.match(/export async function getTmdbTopRated[\s\S]*?^}/m);
  assert.ok(topRatedFn, 'getTmdbTopRated found');
  assert.doesNotMatch(topRatedFn![0], /isDailySoapEpisodeCount/, 'Top Rated has NO soap policy');
  const searchClassify = readFileSync(new URL('../src/lib/server/content/search-classify.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(searchClassify, /popular-tv-policy|isDailySoapEpisodeCount/, 'Search has NO soap policy');
  ok('5. isolation: anime, Adult Discover, Search, Top Rated carry no soap policy');
}

console.log(`\nPopular TV daily-soap policy tests passed (${passed} check groups).`);
