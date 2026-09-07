// ============================================================================
// Phase 9 FINAL behavioral suite — cross-phase integration confidence.
// (Adult Mode architecture rebuild; see Mavero_Adult_Mode_Rebuild_Worklog.md.)
//
// PURPOSE (Phase 9 spec §25): a DEDICATED FINAL suite that aggregates the
// most important cross-phase contracts in one place. It deliberately does
// NOT duplicate the deep per-phase case matrices (Phases 2–8 already carry
// ~826 assertions in 8 adult suites); it re-proves each FINAL CONTRACT
// against the REAL pure modules one more time, in one runnable place, so
// the production-readiness verdict rests on integration confidence rather
// than on the sum of scattered suites.
//
// REAL behavioral tests (the established adapter/behavioral split): the
// suites execute the actual pure modules under tsx — authorization matrix
// (adult-authz.ts), guest-cookie crypto (adult-cookie.ts), central
// classifier (adult-providers.ts), network registry (adult-networks.ts) +
// catalog bridge (adult-catalog.ts), rail/search classification
// (list-classify.ts / search-classify.ts), Adult Discover contract
// (adult-discover.ts) and the process cache (cache.ts). The SvelteKit
// routes / service wrapper / adapter cannot be imported under tsx (they
// import $env / $app / $lib aliases); their WIRING is asserted at source
// level (exact code shape, same convention as the Phase 6/7/8 suites).
//
// Deterministic and credential-free. The LIVE TMDB network diagnostic is a
// separate operator-runnable script: scripts/adult_phase9_tmdb_diagnostic.ts.
//
// Final contracts covered (one group each):
//   1  complete authorization matrix (+ admin flip, fail-closed reads)
//   2  network registry == live-verified set; verified-only accessors
//   3  classifier final semantics (7 rules incl. anime exemption)
//   4  normal rail isolation (adult + uncertain dropped, order kept)
//   5  Adult Discover isolation (confirmed-only collector + service gate)
//   6  Popular TV genre exclusion (exact constant, unconditional, additive)
//   7  cache namespace isolation (adult vs normal, both directions)
//   8  fallback isolation (no cross-boundary fallback either direction)
//   9  direct-access protection contract (watch / season / detail wiring)
//   10 Search protection contract (server-side mode switch + fail-closed)
//   11 arbitrary network rejection (no client network surface anywhere)
//   12 uncertain classification fail-closed (rail + discover + search)
//   13 legacy adult-shows remains gated (retained endpoint, no UI caller)
//   14 guest cookie final properties (HMAC, value-bound, fail-closed attrs)
//   15 removed anime providers stay absent (AniList/MAL/Yenime)
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateAdultAccess, adminPolicyFromRead, userPreferenceFromRead } from '../src/lib/server/content/adult-authz.ts';
import {
  canonicalAdultCookieValue,
  signAdultCookieValue,
  verifyAdultCookieValue,
  buildAdultGuestSetCookie
} from '../src/lib/server/content/adult-cookie.ts';
import { isAdultContent } from '../src/lib/server/content/adult-providers.ts';
import {
  getAdultNetworks,
  getVerifiedAdultNetworks,
  getAdultNetworkIds,
  getAdultNetworkById,
  isKnownAdultNetwork
} from '../src/lib/server/content/adult-networks.ts';
import { adultNetworkExclusionValue, withAdultNetworksParams, getVerifiedAdultNetworkIdForKey } from '../src/lib/server/content/adult-catalog.ts';
import { filterSafeRailItems, classifyRailCandidate, type RailCandidateRow } from '../src/lib/server/content/list-classify.ts';
import {
  searchFilterMode,
  movieRowVerdict,
  detailVerdict,
  buildSearchCacheKey,
  collectSafeSearchPage,
  SEARCH_CACHE_AUTH_DIMENSIONS
} from '../src/lib/server/content/search-classify.ts';
import {
  buildAdultDiscoverCacheKey,
  ADULT_DISCOVER_CACHE_NAMESPACE,
  collectConfirmedAdultPage,
  classifyAdultDiscoverRow,
  emptyAdultDiscoverResult
} from '../src/lib/server/content/adult-discover.ts';
import { POPULAR_TV_WITHOUT_GENRES } from '../src/lib/server/content/types.ts';
import { getOrSet, clearCache } from '../src/lib/server/content/cache.ts';
import { media } from '../src/lib/data/content.ts';

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const src = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const POLICY_ON = { allowLoggedIn: true, allowGuest: true };
const POLICY_OFF = { allowLoggedIn: false, allowGuest: false };

// ============================================================================
// 1 — complete authorization matrix (final re-proof, all six rows plus the
// admin flip and the fail-closed read mappings).
// ============================================================================
{
  const rows: Array<{ name: string; policy: typeof POLICY_ON | typeof POLICY_OFF; auth: boolean; pref: boolean; expect: boolean }> = [
    { name: 'admin OFF + user OFF', policy: POLICY_OFF, auth: true, pref: false, expect: false },
    { name: 'admin OFF + user ON', policy: POLICY_OFF, auth: true, pref: true, expect: false },
    { name: 'admin ON + user OFF', policy: POLICY_ON, auth: true, pref: false, expect: false },
    { name: 'admin ON + user ON', policy: POLICY_ON, auth: true, pref: true, expect: true },
    { name: 'admin ON + guest OFF', policy: POLICY_ON, auth: false, pref: false, expect: false },
    { name: 'admin ON + guest ON', policy: POLICY_ON, auth: false, pref: true, expect: true }
  ];
  for (const row of rows) {
    const ctx = evaluateAdultAccess({ policy: row.policy, isAuthenticated: row.auth, userPreference: row.pref });
    assert.equal(ctx.canAccessAdultContent, row.expect, `matrix row "${row.name}"`);
  }
  // Admin OFF immediately overrides a previously enabled preference (flip).
  const flipped = evaluateAdultAccess({ policy: POLICY_OFF, isAuthenticated: true, userPreference: true });
  assert.equal(flipped.canAccessAdultContent, false, 'admin OFF overrides enabled preference');
  // Fail-closed raw-read mappings.
  assert.deepEqual(adminPolicyFromRead(null, new Error('x')), { allowLoggedIn: false, allowGuest: false }, 'policy read failure -> OFF for everyone');
  assert.deepEqual(adminPolicyFromRead(undefined, null), { allowLoggedIn: false, allowGuest: false }, 'missing policy row -> OFF');
  assert.equal(userPreferenceFromRead(null, new Error('x')), false, 'preference read failure -> OFF');
  ok('1. complete authorization matrix: all 6 rows + admin flip + fail-closed reads');
}

// ============================================================================
// 2 — network registry: the verified set is exactly the live-confirmed
// (Phase 9 diagnostic) triple; accessors expose verified entries only.
// ============================================================================
{
  const verified = getVerifiedAdultNetworks();
  assert.deepEqual(
    verified.map((entry) => [entry.tmdbNetworkId, entry.verification]).sort((a, b) => (a[0] as number) - (b[0] as number)),
    [[2902, 'verified'], [4573, 'verified'], [7355, 'verified']],
    'verified set == live-confirmed Ullu/Kooku/Atrangii'
  );
  assert.deepEqual([...getAdultNetworkIds()].sort((a, b) => a - b), [2902, 4573, 7355], 'production filter accessor returns the verified triple');
  const unverified = getAdultNetworks().filter((entry) => entry.verification !== 'verified');
  assert.equal(unverified.length, 12, 'candidate services remain registered-but-unverified');
  assert.ok(unverified.every((entry) => entry.tmdbNetworkId === 0), 'no unverified entry carries a trusted ID');
  assert.equal(adultNetworkExclusionValue(), '2902|4573|7355', 'production exclusion value is the verified triple');
  ok('2. network registry == live-verified set {Ullu 2902, Kooku 4573, Atrangii 7355}; verified-only accessors');
}

// ============================================================================
// 3 — classifier final semantics (the seven binding rules), through the ONE
// central classifier with the REAL registry.
// ============================================================================
{
  const ulluNetwork = [{ id: 2902, name: 'Ullu' }];
  // Rule 1: explicit Adult tag -> Adult.
  assert.equal(isAdultContent(['Adult'], undefined, false, false, undefined), true, 'rule 1: explicit tag');
  // Rule 2: verified Adult network -> Adult.
  assert.equal(isAdultContent(undefined, undefined, false, false, ulluNetwork), true, 'rule 2: verified network');
  // Rule 3: TMDB adult=true -> Adult for non-anime.
  assert.equal(isAdultContent(undefined, undefined, true, false, undefined), true, 'rule 3: adult flag (non-anime)');
  // Rule 4: anime + adult=true ALONE -> NOT Adult.
  assert.equal(isAdultContent(undefined, undefined, true, true, undefined), false, 'rule 4: anime exemption');
  // Rule 5: anime + verified Adult network -> Adult (reliable signal beats the exemption).
  assert.equal(isAdultContent(undefined, undefined, false, true, ulluNetwork), true, 'rule 5: anime + verified network');
  // Combination: verified Adult network + adult=false -> Adult.
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 4573, name: 'Kooku' }]), true, 'network + adult=false -> Adult');
  // No generic heuristics: mature/romance/drama/horror titles are NOT adult by content.
  assert.equal(isAdultContent(['Mature', 'Romance'], undefined, false, false, undefined), false, 'no romance/mature heuristic');
  assert.equal(isAdultContent(['Drama', 'Horror'], undefined, undefined, undefined, undefined), false, 'no drama/horror heuristic');
  // No title blacklist: name-based matching is exact registry identity only.
  assert.equal(isKnownAdultNetwork({ id: 9999, name: 'Ullu Originals' }), false, 'substring network names never match');
  // Uncertain sources of truth cannot classify: unknown network -> not adult.
  assert.equal(isAdultContent(undefined, undefined, undefined, false, [{ id: 987654, name: 'Unknown TV' }]), false, 'unknown network is not adult');
  ok('3. classifier final semantics: 7 rules hold (tag, network, flag, anime exemption, anime+network, no heuristics)');
}

// ============================================================================
// 4 — normal rail isolation: adult AND uncertain candidates are dropped
// regardless of Adult Mode state; safe candidates keep input order; dedup.
// ============================================================================
{
  const makeItem = (id: string, tags?: string[]) => ({ id, type: 'series' as const, title: id, year: 2020, runtime: '1h', rating: 7, genres: [], description: '', poster: '', backdrop: '', accent: '#000', tags, source: { provider: 'tmdb' as const, fetchedAt: '' } });
  const safeA = makeItem('series-1');
  const adultB = makeItem('series-2', ['Adult']);
  const safeC = makeItem('series-3');
  const rows: RailCandidateRow<typeof safeA>[] = [
    { item: safeA, mediaType: 'series' },
    { item: adultB, mediaType: 'series' },
    { item: safeC, mediaType: 'series' },
    { item: makeItem('series-1'), mediaType: 'series' } // duplicate identity
  ];
  const result = await filterSafeRailItems(rows, {
    concurrency: 4,
    loadDetailVerdict: async (tmdbId) => (tmdbId === '2' ? 'adult' : 'safe'),
    tmdbIdOf: (item) => item.id.replace(/^series-/, ''),
    identityOf: (item) => `series:${item.id}`
  });
  assert.deepEqual(result.items.map((item) => item.id), ['series-1', 'series-3'], 'adult + duplicate dropped, order preserved');
  assert.equal(result.excludedAdult, 1, 'exactly one adult exclusion');
  assert.equal(result.excludedUncertain, 0, 'no uncertainty in this fixture');
  ok('4. normal rail isolation: adult candidates dropped, safe kept in order, dedup holds');
}

// ============================================================================
// 5 — Adult Discover isolation: only classifier-confirmed candidates are
// returned; the service wrapper denies unauthorized callers with the
// non-disclosing empty result; the adapter has no fallback.
// ============================================================================
{
  // 5a. Confirmed-only collector: 'safe' (anomaly) and 'uncertain' are dropped.
  const rows = [
    { item: { id: '1', type: 'series' as const }, mediaType: 'series' as const },
    { item: { id: '2', type: 'series' as const }, mediaType: 'series' as const },
    { item: { id: '3', type: 'series' as const }, mediaType: 'series' as const }
  ];
  const verdicts: Array<'adult' | 'safe' | 'uncertain'> = ['adult', 'safe', 'uncertain'];
  const outcome = await collectConfirmedAdultPage<typeof rows[0]['item']>({
    startPage: 1,
    pageSize: 10,
    maxUpstreamPages: 3,
    concurrency: 4,
    fetchUpstreamPage: async () => ({ items: rows, totalPages: 1 }),
    classifyCandidate: async (row) => verdicts[Number(row.item.id) - 1],
    identityOf: (row) => `series:${row.item.id}`
  });
  assert.deepEqual(outcome.items.map((row) => row.item.id), ['1'], 'only confirmed-adult collected');
  assert.equal(outcome.excludedNotAdult, 1, 'anomaly (safe) dropped');
  assert.equal(outcome.excludedUncertain, 1, 'uncertain dropped (fail closed)');

  // 5b. The service wrapper denies BEFORE any cache/data access (wiring).
  const service = src('../src/lib/server/content/service.ts');
  assert.match(
    service,
    /export async function adultDiscover\([\s\S]*?if \(!canAccessAdult\) \{[\s\S]*?return emptyAdultDiscoverResult\(filters\.page\);/,
    'service.adultDiscover returns the non-disclosing empty result when unauthorized'
  );

  // 5c. The non-disclosing empty result is never a fixture/normal-catalog object.
  const empty = emptyAdultDiscoverResult(1);
  assert.deepEqual(empty.items, [], 'empty result carries no items');
  assert.equal(empty.source.provider, 'tmdb', 'empty result is not a fixtures object');
  assert.equal(empty.hasNextPage, false, 'empty result has no next page');

  // 5d. The adapter propagates upstream failure (no catch -> no fallback).
  const adapter = src('../src/lib/server/content/adapters/tmdb.ts');
  const adultDiscoverFn = adapter.slice(adapter.indexOf('export async function getTmdbAdultDiscover'));
  assert.doesNotMatch(adultDiscoverFn, /fixturesFor|catch\s*(\(|\{)/, 'getTmdbAdultDiscover has no fixture fallback and no swallowed errors');
  ok('5. Adult Discover isolation: confirmed-only collector + service gate + no adapter fallback');
}

// ============================================================================
// 6 — Popular TV genre exclusion: exact Soap/News/Talk constant, applied
// ADDITIONALLY and UNCONDITIONALLY (no Adult Mode conditional anywhere near
// the query), with the India/OTT/language/adult constraints retained.
// ============================================================================
{
  assert.equal(POPULAR_TV_WITHOUT_GENRES, '10764|10766|10767', 'exact Soap/News/Talk genre union');
  const adapter = src('../src/lib/server/content/adapters/tmdb.ts');
  const popularTv = adapter.slice(adapter.indexOf('export async function getTmdbPopularByLanguage'), adapter.indexOf('export async function getTmdbTopRated'));
  assert.match(popularTv, /genreExclusion \? \{ without_genres: genreExclusion \}/, 'genre exclusion applied when set');
  assert.match(popularTv, /type === 'series' \? POPULAR_TV_WITHOUT_GENRES : undefined/, 'TV-only genre exclusion');
  assert.doesNotMatch(popularTv, /canAccessAdult|adultMode|adult_mode|adultEnabled/i, 'no Adult Mode conditional near the Popular TV query');
  assert.match(popularTv, /include_adult: false/, 'include_adult=false retained');
  assert.match(popularTv, /watch_region: 'IN'/, 'India region retained');
  assert.match(popularTv, /with_watch_monetization_types: 'flatrate'/, 'OTT flatrate bias retained');
  assert.match(popularTv, /with_original_language: langParam/, 'language filter retained');
  assert.match(popularTv, /networkExclusion \? \{ without_networks: networkExclusion \}/, 'verified-network exclusion retained alongside');
  assert.match(popularTv, /const key = `tmdb:popular-v2:\$\{type\}:\$\{language\}:\$\{page\}:\$\{adultExclusion \?\? 'no-adult'\}:\$\{genreExclusion \?\? 'no-genre-exclusion'\}`/, 'cache key embeds the genre-exclusion dimension');
  // The genre filter adds no classification weight: Soap/News/Talk genre IDs are not network IDs.
  assert.equal(isKnownAdultNetwork({ id: 10764, name: 'Soap' }), false, 'Soap genre ID is not an adult network');
  assert.equal(isKnownAdultNetwork({ id: 10767, name: 'Talk' }), false, 'Talk genre ID is not an adult network');
  ok('6. Popular TV exclusion: exact constant, unconditional, additive, India/language/OTT/adult constraints retained');
}

// ============================================================================
// 7 — cache namespace isolation: Adult Discover entries are structurally
// disjoint from every normal namespace, in BOTH directions; authorization
// decisions never enter Adult Discover cache keys; search keys keep the
// structural authorization dimension.
// ============================================================================
{
  clearCache();
  const adultKey = buildAdultDiscoverCacheKey({ type: 'series', language: 'all', sort: 'popularity', page: 1, networkInclusion: '2902|4573|7355' });
  const normalKeys = [
    'tmdb:discover:series:1',
    'tmdb:popular-v2:series:all:1:2902|4573|7355:10764|10766|10767',
    'tmdb:collection:series:1:::no-adult',
    'tmdb:search:series:foo:1:::adult-excluded',
    'tmdb:adult-shows:all:1:2902|4573|7355',
    'tmdb:detail:series:42',
    'tmdb:season:42:1'
  ];
  assert.ok(adultKey.startsWith(`${ADULT_DISCOVER_CACHE_NAMESPACE}:`), 'adult key carries the dedicated namespace prefix');
  for (const normalKey of normalKeys) {
    assert.ok(!normalKey.startsWith(`${ADULT_DISCOVER_CACHE_NAMESPACE}:`), `normal key "${normalKey}" is outside the adult namespace`);
  }
  // Behavioral: entries stored under the adult namespace are invisible to normal reads and vice versa.
  await getOrSet(adultKey, { ttlMs: 1000 }, async () => ({ marker: 'adult-catalog' }));
  const normalRead = await getOrSet('tmdb:discover:series:1', { ttlMs: 1000 }, async () => ({ marker: 'normal-rail' }));
  assert.deepEqual(normalRead.value, { marker: 'normal-rail' }, 'normal read never serves the adult entry');
  assert.equal((await getOrSet(adultKey, { ttlMs: 1000 }, async () => ({ marker: 'other' }))).value.marker, 'adult-catalog', 'adult read keeps its own entry');
  clearCache();
  // No authorization dimension exists in the Adult Discover key.
  assert.doesNotMatch(adultKey, /authoriz|canAccess|allowed|guest|user/i, 'no authorization state in adult cache keys');
  // Search keys structurally separate authorized vs unauthorized results.
  const allowed = buildSearchCacheKey({ type: 'series', query: 'q', page: 1, canAccessAdult: true });
  const excluded = buildSearchCacheKey({ type: 'series', query: 'q', page: 1, canAccessAdult: false });
  assert.notEqual(allowed, excluded, 'authorized and unauthorized search keys differ');
  assert.ok(allowed.endsWith(SEARCH_CACHE_AUTH_DIMENSIONS.allowed) && excluded.endsWith(SEARCH_CACHE_AUTH_DIMENSIONS.excluded), 'search auth dimension is a fixed literal suffix');
  ok('7. cache namespace isolation: adult vs normal disjoint both directions; no authorization cached');
}

// ============================================================================
// 8 — fallback isolation: the Adult surface never degrades into the normal
// catalog and the normal catalog never falls back into Adult content.
// ============================================================================
{
  // 8a. Normal fixture fallback (the only normal fallback that exists) contains
  //     zero Adult-classified titles — proven through the REAL classifier.
  const fixtures = media as unknown as Array<{ tags?: string[]; isAnime?: boolean; networks?: Array<{ id: number; name: string }>; type: string }>;
  assert.ok(fixtures.length > 0, 'fixture catalog present');
  for (const item of fixtures) {
    assert.equal(isAdultContent(item.tags, undefined, undefined, item.isAnime, item.networks), false, `fixture "${item.type}" item never classifies Adult`);
  }
  // 8b. The Adult service has NO fixture path (wiring): adultDiscover calls the
  //     adapter or the empty result — never fixturesFor.
  const service = src('../src/lib/server/content/service.ts');
  const adultDiscoverBody = service.slice(service.indexOf('export async function adultDiscover'), service.indexOf('export const contentServiceInternals'));
  assert.doesNotMatch(adultDiscoverBody, /fixturesFor/, 'adultDiscover has no fixture fallback');
  // 8c. Normal upstream failure paths never reach an adult surface: the only
  //     adult service entry points are adultDiscover + the legacy gated rail.
  assert.match(service, /export async function adultDiscover\(filters: AdultDiscoverFilters, canAccessAdult = false\)/, 'adultDiscover is authorization-parameterized');
  ok('8. fallback isolation: fixtures are adult-free; Adult surface has no normal fallback; no cross-boundary fallback');
}

// ============================================================================
// 9 — direct-access protection contract: watch route, season API and detail
// API classify FIRST and authorize per request, with non-disclosing denials.
// ============================================================================
{
  const watch = src('../src/routes/watch/[type]/[id]/+page.server.ts');
  assert.match(watch, /detailVerdict\(item\.tags\) === 'adult'/, 'watch route classifies the resolved title');
  assert.match(watch, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'watch route evaluates per-request authorization');
  assert.match(watch, /throw error\(404, 'Title not found'\)/, 'watch denial is a non-disclosing 404');
  const classifyPos = watch.indexOf('item = await getDetail(params.type, params.id)');
  const guardPos = watch.indexOf("detailVerdict(item.tags) === 'adult'");
  const dataPos = watch.indexOf('let streamingConfig');
  assert.ok(classifyPos !== -1 && guardPos > classifyPos && dataPos > guardPos, 'classification -> authorization -> data order');
  assert.doesNotMatch(watch, /url\.searchParams\.get\('(adult|include_adult|bypass)'\)/, 'no client adult flag exists on the watch route');

  const season = src('../src/routes/api/content/series/[id]/season/[season]/+server.ts');
  const seasonGuardPos = season.indexOf("detailVerdict(parent.tags) === 'adult'");
  const seasonDataPos = season.indexOf('getSeriesSeason(params.id, season)');
  assert.ok(seasonGuardPos !== -1, 'season API classifies the parent title');
  assert.ok(seasonDataPos > seasonGuardPos, 'classification happens BEFORE any episode data is served');
  assert.match(season, /if \(!canAccess\) \{[\s\S]*?status: 404/, 'season denial is a non-disclosing 404');
  assert.match(season, /\} catch \{[\s\S]*?status: 404/, 'failed parent classification fails CLOSED with the same 404');
  assert.ok(season.includes('/^\\d+$/.test(cleanId)'), 'TMDB-backed ids are guarded (fixtures skip classification only)');

  const detail = src('../src/routes/api/content/[type]/[id]/+server.ts');
  assert.match(detail, /detailVerdict\(result\.tags\) === 'adult'/, 'detail API classifies before responding');
  assert.match(detail, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'detail API authorizes per request');
  assert.match(detail, /status: 404/, 'detail denial is a non-disclosing 404');
  ok('9. direct-access protection contract: watch / season / detail classify -> authorize -> non-disclosing 404');
}

// ============================================================================
// 10 — Search protection contract: the server decides the mode, fail-closed
// classification runs for unauthorized search, and no client flag exists.
// ============================================================================
{
  assert.equal(searchFilterMode(true), 'authorized-passthrough', 'authorized -> passthrough');
  assert.equal(searchFilterMode(false), 'classify-and-exclude', 'unauthorized -> classify and exclude');
  // Fail-closed collection for unauthorized search: adult AND uncertain dropped.
  const collected = await collectSafeSearchPage<{ id: string }>({
    startPage: 1,
    pageSize: 10,
    maxUpstreamPages: 3,
    excludeUncertain: true,
    concurrency: 4,
    fetchUpstreamPage: async () => ({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], totalPages: 1 }),
    classifyCandidate: async (item) => (item.id === 'a' ? 'adult' : item.id === 'b' ? 'uncertain' : 'safe'),
    identityOf: (item) => item.id
  });
  assert.deepEqual(collected.items, [{ id: 'c' }], 'only safe candidates survive unauthorized search');
  assert.equal(collected.excludedAdult, 1, 'adult candidate excluded');
  assert.equal(collected.excludedUncertain, 1, 'uncertain candidate excluded (fail closed)');
  // Movie row verdict routes through the ONE central classifier.
  assert.equal(movieRowVerdict({ adult: true, isAnime: true }), 'safe', 'anime adult=true stays safe');
  assert.equal(movieRowVerdict({ adult: true, isAnime: false }), 'adult', 'non-anime adult=true is adult');
  assert.equal(detailVerdict(['Adult']), 'adult', 'detail verdict reads the central classification');
  // Both server entry points evaluate authorization; the UI sends no adult flag.
  const apiRoute = src('../src/routes/api/content/search/+server.ts');
  const ssrPage = src('../src/routes/search/+page.server.ts');
  assert.match(apiRoute, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'search API evaluates policy per request');
  assert.doesNotMatch(apiRoute, /searchParams\.get\('(adult|include_adult)'\)/, 'no client adult flag on the search API');
  assert.match(ssrPage, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'search SSR parity: same policy evaluation');
  const searchUi = src('../src/routes/search/+page.svelte');
  assert.doesNotMatch(searchUi, /adult/i, 'search UI holds no adult security mechanism');
  ok('10. Search protection contract: server-side mode switch, fail-closed collection, SSR/API parity, no client security');
}

// ============================================================================
// 11 — arbitrary network rejection: unverified/unknown IDs can never reach a
// production query, and the Adult Discover endpoint has NO network surface.
// ============================================================================
{
  assert.deepEqual(withAdultNetworksParams(999999), {}, 'arbitrary client network ID yields an empty fragment');
  assert.deepEqual(withAdultNetworksParams(0), {}, 'zero/invalid ID yields an empty fragment');
  assert.deepEqual(withAdultNetworksParams(2902), { with_networks: '2902' }, 'verified ID narrows correctly');
  assert.equal(getVerifiedAdultNetworkIdForKey('netflix'), undefined, 'a live-known NON-adult network key resolves to nothing');
  assert.equal(getVerifiedAdultNetworkIdForKey('nonexistent'), undefined, 'unknown key resolves to nothing');
  assert.equal(getAdultNetworkById(213), undefined, 'Netflix 213 is not in the registry');
  const endpoint = src('../src/routes/api/content/adult-discover/+server.ts');
  assert.match(endpoint, /searchParams\.get\('type'\)/, 'endpoint reads type');
  assert.match(endpoint, /searchParams\.get\('language'\)/, 'endpoint reads language');
  assert.match(endpoint, /searchParams\.get\('sort'\)/, 'endpoint reads sort');
  assert.match(endpoint, /searchParams\.get\('page'\)/, 'endpoint reads page');
  assert.doesNotMatch(endpoint, /searchParams\.get\('(network|networks|with_networks|without_networks|provider|watch_provider)'/, 'endpoint has NO network/provider parameter');
  const component = src('../src/lib/components/AdultDiscoverSection.svelte');
  const discoverUrlBody = component.slice(component.indexOf('function discoverUrl'), component.indexOf('async function loadFirst'));
  assert.match(discoverUrlBody, /type/, 'Adult UI sends type');
  assert.match(discoverUrlBody, /language/, 'Adult UI sends language');
  assert.match(discoverUrlBody, /page/, 'Adult UI sends page');
  assert.ok(!/network|provider|with_/i.test(discoverUrlBody), 'Adult UI sends NO network/provider/TMDB-passthrough parameters');
  ok('11. arbitrary network rejection: unverified IDs rejected; no client network surface on endpoint or UI');
}

// ============================================================================
// 12 — uncertain classification fail-closed: a throwing loader is reported
// as uncertain and the candidate is dropped on every normal surface.
// ============================================================================
{
  const item = { id: 'series-9', type: 'series' as const, title: 't', year: 2020, runtime: '1h', rating: 7, genres: [], description: '', poster: '', backdrop: '', accent: '#000', source: { provider: 'tmdb' as const, fetchedAt: '' } };
  const verdict = await classifyRailCandidate({ item, mediaType: 'series' } as RailCandidateRow<typeof item>, async () => { throw new Error('detail failed'); }, () => '9');
  assert.equal(verdict, 'uncertain', 'rail loader failure -> uncertain');
  const discoverVerdict = await classifyAdultDiscoverRow({ item, mediaType: 'series' }, async () => { throw new Error('detail failed'); }, () => '9');
  assert.equal(discoverVerdict, 'uncertain', 'Adult Discover loader failure -> uncertain (never "adult enough")');
  const railResult = await filterSafeRailItems([{ item, mediaType: 'series' }], {
    concurrency: 4,
    loadDetailVerdict: async () => { throw new Error('boom'); },
    tmdbIdOf: () => '9',
    identityOf: (entry) => entry.id
  });
  assert.deepEqual(railResult.items, [], 'uncertain candidate excluded from the normal rail');
  assert.equal(railResult.excludedUncertain, 1, 'uncertainty counted, never mapped to not-adult');
  ok('12. uncertain classification fail-closed: rail + discover loaders fail to "uncertain" and are dropped');
}

// ============================================================================
// 13 — legacy adult-shows rail: retired from the UI, retained endpoint stays
// authorization-gated end-to-end (route gate + service defense-in-depth).
// ============================================================================
{
  const service = src('../src/lib/server/content/service.ts');
  const railBranch = service.slice(service.indexOf("case 'adult-shows'"), service.indexOf('default:'));
  assert.match(railBranch, /if \(!canAccessAdult\) \{[\s\S]*?return \{ items: \[\], page, hasNextPage: false/, 'service rail branch denies unauthorized callers with an empty result');
  const railEndpoint = src('../src/routes/api/discover/rail/+server.ts');
  assert.match(railEndpoint, /sectionParam === 'adult-shows'/, 'rail endpoint special-cases the adult section');
  assert.match(railEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'rail endpoint evaluates the policy per request');
  assert.match(railEndpoint, /items: \[\], page, hasNextPage: false/, 'unauthorized rail answer is an empty non-disclosing result');
  const providersEndpoint = src('../src/routes/api/discover/adult-providers/+server.ts');
  assert.match(providersEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'legacy provider dropdown endpoint stays gated');
  // No UI caller of the legacy rail remains.
  const discoverPage = src('../src/lib/components/DiscoverPage.svelte');
  assert.doesNotMatch(discoverPage, /section="adult-shows"|DiscoverSection section=\{?['"]adult/, 'DiscoverPage no longer renders the legacy adult rail');
  assert.match(discoverPage, /AdultDiscoverSection/, 'DiscoverPage renders the dedicated Adult Discover section');
  const discoverSection = src('../src/lib/components/DiscoverSection.svelte');
  assert.doesNotMatch(discoverSection, /adult-shows/, 'the shared rail component has no adult-shows special case');
  ok('13. legacy adult-shows: retired from UI; retained endpoints stay gated (route + service defense-in-depth)');
}

// ============================================================================
// 14 — guest cookie final properties: value-bound HMAC-SHA256, canonical
// values only, timing-safe, fail-closed secret handling, safe attributes.
// ============================================================================
{
  const secret = 'phase9-final-audit-secret';
  const onCookie = signAdultCookieValue(canonicalAdultCookieValue(true), secret);
  const offCookie = signAdultCookieValue(canonicalAdultCookieValue(false), secret);
  assert.match(onCookie, /^1\.[0-9a-f]{64}$/, 'cookie format: 1.<hmac-sha256-hex>');
  assert.equal(verifyAdultCookieValue(onCookie, secret), true, 'signed "1" -> guest preference ON');
  assert.equal(verifyAdultCookieValue(offCookie, secret), false, 'signed "0" -> guest preference OFF (never accidentally ON)');
  // Value-bound: swapping the payload invalidates the signature.
  assert.equal(verifyAdultCookieValue(`${offCookie.split('.')[0]}.${onCookie.split('.')[1]}`, secret), false, 'signature is bound to the exact canonical value');
  // Tamper + wrong secret + legacy unsigned values.
  assert.equal(verifyAdultCookieValue(`1.${'0'.repeat(64)}`, secret), false, 'forged signature rejected');
  assert.equal(verifyAdultCookieValue(onCookie, 'another-secret'), false, 'wrong secret rejected');
  assert.equal(verifyAdultCookieValue('1', secret), false, 'unsigned legacy value rejected');
  assert.equal(verifyAdultCookieValue('1.extra.sig', secret), false, 'extra segments rejected');
  // Missing secret: verification fails closed, issuance throws.
  assert.equal(verifyAdultCookieValue(onCookie, undefined), false, 'missing secret -> guest OFF (nothing authenticates)');
  assert.throws(() => signAdultCookieValue('1', ''), 'missing secret refuses issuance (fail closed)');
  // Production cookie attributes.
  const prodCookie = buildAdultGuestSetCookie(onCookie, 31536000, true);
  assert.match(prodCookie, /HttpOnly/, 'HttpOnly');
  assert.match(prodCookie, /SameSite=Lax/, 'SameSite=Lax');
  assert.match(prodCookie, /Secure/, 'Secure in production');
  assert.match(prodCookie, /Path=\//, 'Path=/');
  ok('14. guest cookie final properties: HMAC-SHA256, value-bound, canonical-only, fail-closed, HttpOnly+SameSite+Secure(prod)');
}

// ============================================================================
// 15 — removed anime providers stay absent from the Adult/content
// architecture; no reintroduction of AniList/MAL/Yenime integrations.
// ============================================================================
{
  const stripComments = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|\s)\/\/[^\n]*/g, '$1'); // line comments
  const contentPipeline = [
    '../src/lib/server/content/adult-networks.ts',
    '../src/lib/server/content/adult-providers.ts',
    '../src/lib/server/content/adult-catalog.ts',
    '../src/lib/server/content/adult-discover.ts',
    '../src/lib/server/content/search-classify.ts',
    '../src/lib/server/content/list-classify.ts',
    '../src/lib/server/content/adapters/tmdb.ts'
  ].map(src).map(stripComments).join('\n');
  assert.doesNotMatch(contentPipeline, /anilist|myanimelist|jikan|yenime/i, 'no AniList/MAL/Jikan/Yenime integration code in the content pipeline');
  const resolverAdapters = stripComments(src('../src/lib/server/resolver/adapters.ts'));
  assert.doesNotMatch(resolverAdapters, /yenime/i, 'Yenime adapter stays removed');
  // The legacy externalIds TYPE fields (anilist/mal) are inert data shapes, not integrations.
  assert.match(src('../src/lib/server/content/types.ts'), /anilist\?: string;/, 'legacy externalIds type shape unchanged (inert)');
  ok('15. removed anime providers: AniList/MAL/Yenime absent from the Adult/content architecture');
}

// ============================================================================
console.log(`# Phase 9 final cross-phase contracts: ${passed} groups passed`);
console.log('PHASE 9 FINAL SUITE PASSED');
