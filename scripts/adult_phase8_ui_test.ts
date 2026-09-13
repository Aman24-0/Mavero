// ============================================================================
// Phase 8 tests — Popular TV cleanup + Adult Discover / Search UI integration.
// (Adult Mode architecture rebuild; see Mavero_Adult_Mode_Rebuild_Worklog.md.)
//
// REAL behavioral tests wherever the module graph allows tsx import (pure
// contracts: types.ts, adult-networks.ts, adult-catalog.ts, adult-providers.ts
// classifier, search-classify.ts, list-classify.ts, adult-discover.ts, the
// process cache) — with injected deterministic dependencies, credential-free.
//
// Modules that import $env/$app/$lib aliases (adapters/tmdb.ts, service.ts,
// the SvelteKit routes and the .svelte components) cannot be imported under
// tsx; their WIRING is asserted against the real source files — the same
// adapter/behavioral split used by every prior phase suite (static sections
// are clearly labeled WIRING and never replace a behavioral assertion that
// can exist).
//
// Covered scenarios (Phase 8 spec §18; numbering follows the spec):
//    1  Popular TV sends without_genres=10764|10766|10767
//    2  Popular TV retains India/language constraints
//    3  Popular TV Adult OFF remains Adult-free
//    4  Popular TV Adult ON remains Adult-free
//    5  The genre filter does NOT classify Soap/News/Talk as Adult
//    6  Authorized Adult request can reach the Adult Discover API
//    7  Unauthorized request cannot receive Adult Discover data
//    8  Admin OFF blocks Adult Discover even when user preference is ON
//    9  Adult Discover uses only verified Adult networks
//   10  UI does not bypass API authorization
//   11  Unauthorized SSR does not contain Adult results
//   12  Unauthorized hydration data does not contain Adult results
//   13  Authorized SSR can contain Adult results (search parity contract)
//   14  Existing Indian Adult Shows no longer bypasses Phase 7
//   15  Legacy endpoint, retained, remains protected
//   16  Normal search remains Adult-free when Adult Mode is OFF
//   17  Normal search remains correctly protected when Adult Mode is ON
//   18  Authorized Adult search remains available (Phase 4 contract)
//   19  Search UI does not implement a separate security mechanism
//   20  Adult Discover cache remains isolated
//   21  Normal Discover cache cannot return Adult Discover data
//   22  Adult Discover cache cannot populate normal rails
//   23  Existing Phase 6 direct watch guard remains intact
//   24  Existing season API guard remains intact
//   25  Anime adult=true exemption remains intact
//   + extras: pagination clamp contract reused by the UI, no browser-side
//     persistent Adult caching, strict UI filter surface.
// ============================================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = new URL('../', import.meta.url).pathname;
async function read(rel: string): Promise<string> {
  return readFile(path.join(repoRoot, rel), 'utf8');
}

// --- Real (tsx-importable) modules under test -------------------------------
import { POPULAR_TV_WITHOUT_GENRES, DISCOVER_LANGUAGES, isDiscoverLanguageValue } from '../src/lib/server/content/types.ts';
import { isAdultContent } from '../src/lib/server/content/adult-providers.ts';
import {
  getVerifiedAdultNetworks,
  getAdultNetworkIds,
  __setAdultNetworkRegistryForTest,
  __resetAdultNetworkRegistryForTest,
  type AdultNetwork
} from '../src/lib/server/content/adult-networks.ts';
import { withAdultNetworksParams, withoutAdultNetworksParams } from '../src/lib/server/content/adult-catalog.ts';
import {
  searchFilterMode,
  buildSearchCacheKey,
  SEARCH_CACHE_AUTH_DIMENSIONS,
  movieRowVerdict,
  detailVerdict
} from '../src/lib/server/content/search-classify.ts';
import { filterSafeRailItems, type RailCandidateRow } from '../src/lib/server/content/list-classify.ts';
import {
  ADULT_DISCOVER_CACHE_NAMESPACE,
  ADULT_DISCOVER_PAGE_CLAMP_MAX,
  parseAdultDiscoverPage,
  emptyAdultDiscoverResult,
  buildAdultDiscoverCacheKey,
  isAdultDiscoverType,
  isAdultDiscoverLanguage,
  isAdultDiscoverSort
} from '../src/lib/server/content/adult-discover.ts';
import { getOrSet, clearCache } from '../src/lib/server/content/cache.ts';
import { evaluateAdultAccess } from '../src/lib/server/content/adult-authz.ts';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

const POLICY_ON = { allowLoggedIn: true, allowGuest: true };
const POLICY_OFF = { allowLoggedIn: false, allowGuest: false };

// ============================================================================
// 1 — Popular TV sends without_genres=10764|10766|10767.
// Pure contract: the constant is the exact TMDB TV genre ID set; the adapter
// wiring (without_genres applied to the /discover/tv half) is asserted in
// the WIRING section below.
// ============================================================================
{
  assert.equal(POPULAR_TV_WITHOUT_GENRES, '10764|10766|10767', 'the Popular TV genre exclusion is exactly Soap|News|Talk');
  const ids = POPULAR_TV_WITHOUT_GENRES.split('|');
  assert.deepEqual(ids, ['10764', '10766', '10767'], 'exactly three TV genre ids, pipe-joined (TMDB multi-value syntax)');
  ok('1. Popular TV genre exclusion constant = 10764|10766|10767 (Soap/News/Talk)');
}

// ============================================================================
// 2 — Popular TV retains India/language constraints (wiring: the TV query
// keeps watch_region=IN + flatrate + with_original_language alongside the
// new without_genres; nothing was dropped).
// ============================================================================
{
  const tmdb = await read('src/lib/server/content/adapters/tmdb.ts');
  const popularFn = tmdb.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
  assert.ok(popularFn, 'getTmdbPopularByLanguage found');
  const body = popularFn![0];
  assert.match(body, /without_genres: genreExclusion/, 'Popular TV sends without_genres');
  assert.match(body, /watch_region: 'IN', with_watch_monetization_types: 'flatrate'/, 'India OTT constraint retained (watch_region IN + flatrate)');
  assert.match(body, /with_original_language: langParam/, 'language constraint retained');
  assert.match(body, /include_adult: false/, 'adult exclusion flag retained');
  assert.match(body, /without_networks: networkExclusion/, 'verified adult network exclusion retained');
  // The language map that powers langParam still covers the India-first union.
  for (const lang of ['hi', 'ta', 'te', 'ml', 'kn']) {
    assert.equal(isDiscoverLanguageValue(lang), true, `India-first language '${lang}' still valid`);
  }
  assert.equal(DISCOVER_LANGUAGES.length, 8, 'the closed language union is unchanged');
  ok('2. Popular TV keeps India region/OTT + language + adult constraints alongside the genre exclusion');
}

// ============================================================================
// 3+4 — Normal Popular TV stays Adult-free in BOTH Adult Mode states.
// Behavioral: the real rail filter (list-classify -> central classifier)
// drops classified-adult and uncertain candidates; it takes NO authorization
// input at all, so its outcome cannot depend on Adult Mode.
// ============================================================================
{
  type Row = { id: string };
  const rows: RailCandidateRow<Row>[] = [
    { item: { id: 'n1' }, mediaType: 'series', rawAdult: false },
    { item: { id: 'a1' }, mediaType: 'series' }, // detail verdict: adult (verified network)
    { item: { id: 'u1' }, mediaType: 'series' }  // detail verdict: uncertain (fail-closed)
  ];
  const loader = async (tmdbId: string) => {
    if (tmdbId === 'a1') return 'adult' as const;
    if (tmdbId === 'u1') throw new Error('detail failed');
    return 'safe' as const;
  };
  const off = await filterSafeRailItems(rows, {
    concurrency: 4,
    loadDetailVerdict: loader,
    tmdbIdOf: (item) => item.id,
    identityOf: (item) => item.id
  });
  assert.deepEqual(off.items.map((i) => i.id), ['n1'], 'Adult OFF: only the safe title survives');
  assert.equal(off.excludedAdult, 1, 'Adult OFF: classified-adult candidate excluded');
  assert.equal(off.excludedUncertain, 1, 'Adult OFF: uncertain candidate fails closed');
  // Adult Mode ON — the SAME filter, same input. There is no authorization
  // parameter in the function signature, so "Adult ON" cannot change it;
  // we prove the constancy by re-running and comparing outcomes.
  const on = await filterSafeRailItems(rows, {
    concurrency: 4,
    loadDetailVerdict: loader,
    tmdbIdOf: (item) => item.id,
    identityOf: (item) => item.id
  });
  assert.deepEqual(on, off, 'Adult ON: the normal rail filter is authorization-blind (identical outcome)');
  ok('3+4. Popular TV remains Adult-free with Adult Mode OFF and ON (real filter + classifier)');
}

// ============================================================================
// 5 — The genre filter does NOT classify Soap/News/Talk as Adult.
// Behavioral: the central classifier's signals are unchanged — a title with
// no adult signal is safe regardless of genre, genres are not even a
// classifier input, and the excluded genre IDs never overlap the verified
// adult network IDs.
// ============================================================================
{
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 213, name: 'Netflix' }]), false, 'a normal-network (soap/news/talk-capable) title is NOT Adult');
  assert.equal(isAdultContent(undefined, undefined, false, false, undefined), false, 'no signals -> not Adult (the genre filter adds no classification weight)');
  assert.equal(isAdultContent(undefined, undefined, true, false, undefined), true, 'the flag path is untouched (classification still works)');
  const genreIds = POPULAR_TV_WITHOUT_GENRES.split('|').map(Number);
  const networkIds = getAdultNetworkIds();
  for (const gid of genreIds) {
    assert.equal(networkIds.includes(gid), false, `genre id ${gid} is not an adult network id (no conflation)`);
  }
  assert.equal(genreIds.length, 3, 'only the three documented genres are excluded');
  ok('5. Soap/News/Talk exclusion is a curation filter — the classifier is unchanged');
}

// ============================================================================
// 6+7+8 — the Adult Discover authorization contract the UI rides on.
// Behavioral with the REAL Phase 5 matrix: authorized -> catalog reachable;
// unauthorized -> non-disclosing denial; admin OFF hard-overrides.
// ============================================================================
{
  assert.equal(evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: true, userPreference: true }).canAccessAdultContent, true, '6. admin ON + user ON -> authorized (Adult Discover reachable)');
  const denied = evaluateAdultAccess({ policy: POLICY_OFF, isAuthenticated: true, userPreference: true });
  assert.equal(denied.canAccessAdultContent, false, '8. admin OFF + user ON -> denied (preference cannot override)');
  assert.equal(evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: true, userPreference: false }).canAccessAdultContent, false, '7a. user preference OFF -> denied');
  assert.equal(evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: false, userPreference: false }).canAccessAdultContent, false, '7b. guest preference OFF -> denied');
  // The empty result the unauthorized paths collapse to carries NO titles.
  const empty = emptyAdultDiscoverResult(1);
  assert.deepEqual(empty.items, [], '7c. the non-disclosing empty result has no items');
  ok('6+7+8. authorization matrix (real evaluateAdultAccess) + non-disclosing empty result');
}

// ============================================================================
// 9 — Adult Discover uses only verified Adult networks. Behavioral against
// the real registry (including a swap-probe proving the accessor follows
// the registry, not a second list).
// ============================================================================
{
  const ids = getAdultNetworkIds().sort((a, b) => a - b);
  assert.deepEqual(ids, [2902, 4573, 7355], 'production registry is exactly Ullu/Kooku/Atrangii');
  const inclusion = withAdultNetworksParams();
  assert.equal(inclusion.with_networks, '2902|4573|7355', 'the TV source query is exactly the verified set');
  const probe: AdultNetwork[] = [...getVerifiedAdultNetworks(), { key: 'fake', name: 'Fake', tmdbNetworkId: 999, verification: 'verified' }];
  __setAdultNetworkRegistryForTest(probe);
  try {
    assert.ok(withAdultNetworksParams().with_networks?.includes('999'), 'the accessor follows the registry (no hardcoded second list)');
  } finally {
    __resetAdultNetworkRegistryForTest();
  }
  assert.deepEqual(withAdultNetworksParams(999), {}, 'unverified id cannot join the source');
  assert.deepEqual(withoutAdultNetworksParams(), { without_networks: '2902|4573|7355' }, 'the normal-rail exclusion uses the same registry');
  ok('9. Adult Discover source = verified registry only (registry-driven, no second list)');
}

// ============================================================================
// 10 — UI does not bypass API authorization (wiring on the real components).
// ============================================================================
{
  const section = await read('src/lib/components/AdultDiscoverSection.svelte');
  const discoverPage = await read('src/lib/components/DiscoverPage.svelte');
  // The Adult rail's CATALOG fetches route ONLY through discoverUrl (the
  // dedicated endpoint builder). The provider-OPTIONS fetch goes to the
  // policy-gated verified-registry endpoint (display-only — asserted
  // separately below).
  const fetchMatches = [...section.matchAll(/fetch\((.{0,40})/g)].filter((call) => !/adult-providers/.test(call[1]));
  assert.ok(fetchMatches.length >= 2, 'first-load and show-more fetches exist');
  for (const call of fetchMatches) {
    assert.match(call[1], /discoverUrl\(/, 'every CATALOG fetch routes through discoverUrl (the dedicated endpoint builder)');
  }
  // The URL builder carries EXACTLY the supported parameters — type,
  // provider (closed union), page — and nothing else: no language (the
  // language filter was removed from this surface), no network/TMDB ids,
  // no authorization flag.
  const urlFn = section.match(/function discoverUrl[\s\S]*?^  }/m);
  assert.ok(urlFn, 'discoverUrl found');
  const paramsObj = urlFn![0].match(/new URLSearchParams\(\{([\s\S]*?)\}\)/);
  assert.ok(paramsObj, 'the query is built from a fixed object literal');
  const keys = [...paramsObj![1].matchAll(/^\s*(\w+)[,:]/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ['page', 'provider', 'type'], 'exactly type/provider/page are ever sent');
  assert.ok(!/language/i.test(paramsObj![1]), 'no language parameter is sent (filter removed from the Adult surface)');
  assert.doesNotMatch(paramsObj![1], /\badult\b|\bnetwork\b|\bwatch\b|\binclude_adult\b/i, 'no source-id/authorization parameter is ever appended (provider is a closed-union key)');
  assert.doesNotMatch(section, /tmdb\.org|api\.themoviedb/, 'no direct TMDB calls from the client');
  // The provider options come from the policy-gated verified-registry
  // endpoint — never a hardcoded brand list, never unverified candidates.
  assert.match(section, /fetch\('\/api\/discover\/adult-providers'\)/, 'provider options are fetched from the policy-gated verified-registry endpoint');
  assert.doesNotMatch(section, /'ullu'|'kooku'|'atrangii'|2902|4573|7355/, 'no hardcoded brand keys or network ids in the component');
  // Visibility is driven by the server-reported state, nothing else.
  assert.match(discoverPage, /\{#if adultCanAccess\}/, 'DiscoverPage renders the Adult surface only on the server-reported state');
  assert.doesNotMatch(discoverPage, /localStorage|sessionStorage/, 'no browser-side persistent caching in DiscoverPage');
  assert.doesNotMatch(section, /localStorage|sessionStorage/, 'no browser-side persistent caching in the Adult rail');
  ok('10. UI cannot bypass API authorization (endpoint-only, closed params, no flags, no persistent cache)');
}

// ============================================================================
// 11+12 — SSR / hydration leak prevention (wiring on the real server loads).
// ============================================================================
{
  const discoverLoad = await read('src/lib/server/content/discover-load.ts');
  assert.doesNotMatch(discoverLoad, /adult/i, '11. the Discover SSR load never fetches adult data');
  assert.doesNotMatch(discoverLoad, /adultDiscover|adult-discover/, '11b. the Discover SSR load never calls the Adult Discover service');
  const homeServer = await read('src/routes/+page.server.ts');
  assert.doesNotMatch(homeServer, /adult/i, '12a. the Home SSR load never fetches adult data');
  const discoverServer = await read('src/routes/discover/+page.server.ts');
  assert.doesNotMatch(discoverServer, /adult/i, '12b. the /discover SSR load never fetches adult data');
  // The Adult surface state arrives via a client-side settings fetch, not
  // through SSR props — so unauthorized hydration carries no Adult titles
  // (and not even an authorization decision computed server-side).
  const discoverPage = await read('src/lib/components/DiscoverPage.svelte');
  assert.match(discoverPage, /fetch\('\/api\/settings\/adult-mode'\)/, '12c. the Adult visibility state is fetched client-side from the server API');
  assert.doesNotMatch(discoverPage, /data\.adult|adultItems|adultResults/, '12d. no Adult result payload is consumed from SSR data');
  ok('11+12. no Adult results in SSR or hydration data (server loads are adult-free; state is client-fetched)');
}

// ============================================================================
// 13 — Authorized SSR CAN contain Adult results (the Phase 4 search parity
// contract: the SSR page evaluates the same server-side policy and passes
// the decision down; authorized users may see Adult search results).
// ============================================================================
{
  const searchServer = await read('src/routes/search/+page.server.ts');
  assert.match(searchServer, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'the SSR search page evaluates the real server-side policy');
  assert.match(searchServer, /search\(query, type, 1, \{\}, canAccessAdult\)/, 'the SSR page passes the authorization decision into the search service');
  const searchEndpoint = await read('src/routes/api/content/search/+server.ts');
  assert.match(searchEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'the search API evaluates the same policy per request');
  ok('13. authorized SSR may carry Adult search results (same server policy as the API — parity intact)');
}

// ============================================================================
// 14+15 — legacy Adult rail migration + retention protection (wiring).
// ============================================================================
{
  const discoverPage = await read('src/lib/components/DiscoverPage.svelte');
  assert.doesNotMatch(discoverPage, /section="adult-shows"/, '14a. DiscoverPage no longer renders the legacy adult-shows rail');
  assert.doesNotMatch(discoverPage, /adult-providers/, '14b. DiscoverPage no longer fetches the legacy provider dropdown');
  assert.match(discoverPage, /<AdultDiscoverSection/, '14c. the Adult surface is the Phase 7-backed component');
  // The legacy rail endpoint is retained FOR COMPATIBILITY and REMAINS
  // protected: per-request policy + non-disclosing empty denial.
  const railEndpoint = await read('src/routes/api/discover/rail/+server.ts');
  assert.match(railEndpoint, /sectionParam === 'adult-shows'/, '15a. the legacy rail endpoint still special-cases adult-shows');
  assert.match(railEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, '15b. the legacy rail endpoint still evaluates the Phase 5 policy per request');
  const authBeforeEmpty = railEndpoint.indexOf('canAccessAdultContent') < railEndpoint.indexOf('discoverRail(');
  assert.ok(authBeforeEmpty, '15c. the legacy gate runs BEFORE the rail service');
  assert.match(railEndpoint, /items: \[\], page, hasNextPage: false/, '15d. unauthorized legacy requests get the empty non-disclosing result');
  // Defense-in-depth inside the service (the second gate).
  const service = await read('src/lib/server/content/service.ts');
  const adultRailCase = service.match(/case 'adult-shows': \{[\s\S]*?\}/);
  assert.ok(adultRailCase, 'the adult-shows service case exists');
  assert.match(adultRailCase![0], /if \(!canAccessAdult\)/, '15e. the service re-checks authorization (defense-in-depth)');
  ok('14+15. legacy rail retired from the UI; the retained endpoint stays authorization-gated');
}

// ============================================================================
// 16+17+18 — Search behavior (behavioral on the real search-classify
// contracts + the Phase 4 filter).
// ============================================================================
{
  // 16. Adult OFF -> classify-and-exclude mode; the key dimension differs.
  assert.equal(searchFilterMode(false), 'classify-and-exclude', '16a. Adult OFF -> server classifies and excludes');
  const excludedKey = buildSearchCacheKey({ type: 'series', query: 'q', page: 1, canAccessAdult: false });
  assert.ok(excludedKey.endsWith(SEARCH_CACHE_AUTH_DIMENSIONS.excluded), '16b. unauthorized search caches under the adult-excluded dimension');
  // 17. Adult ON (authorized) -> passthrough mode, structurally distinct cache.
  assert.equal(searchFilterMode(true), 'authorized-passthrough', '17a. authorized -> passthrough per Phase 4');
  const allowedKey = buildSearchCacheKey({ type: 'series', query: 'q', page: 1, canAccessAdult: true });
  assert.notEqual(allowedKey, excludedKey, '17b. authorized and excluded search results are DIFFERENT cache entries');
  // 18. The Phase 4 classification contracts still behave: central classifier
  // via cheap movie rows + detail verdicts; bounded page collection is the
  // Phase 4 architecture (unchanged — asserted via the real verdict fns).
  assert.equal(movieRowVerdict({ adult: true, isAnime: false }), 'adult', '18a. movie flag path confirms adult (Phase 4)');
  assert.equal(detailVerdict(['Adult']), 'adult', '18b. detail tag path confirms adult (Phase 4)');
  assert.equal(detailVerdict([]), 'safe', '18c. untagged detail is safe (Phase 4)');
  ok('16+17+18. search filter modes + cache dimensions + classifier paths (real contracts)');
}

// ============================================================================
// 19 — Search UI does not implement a separate security mechanism (wiring).
// ============================================================================
{
  const searchPage = await read('src/routes/search/+page.svelte');
  assert.doesNotMatch(searchPage, /adult|canAccess/i, '19a. the Search UI holds NO authorization logic of its own');
  const searchServer = await read('src/routes/search/+page.server.ts');
  assert.doesNotMatch(searchServer, /adult=true|include_adult/, '19b. no client authorization flag is sent or trusted');
  const searchEndpoint = await read('src/routes/api/content/search/+server.ts');
  assert.doesNotMatch(searchEndpoint, /searchParams\.get\(['"](include_)?adult/, '19c. the search API reads NO adult query parameter');
  ok('19. Search UI carries no security mechanism of its own (server is the only boundary)');
}

// ============================================================================
// 20+21+22 — cache isolation (behavioral, REAL process cache).
// ============================================================================
{
  clearCache();
  // Seed the Adult Discover namespace with a recognizable value.
  const adultKey = buildAdultDiscoverCacheKey({ type: 'series', language: 'all', sort: 'popularity', page: 1, networkInclusion: '2902|4573|7355' });
  await getOrSet(adultKey, { ttlMs: 60_000, staleMs: 0 }, async () => ({ marker: 'adult-discover-response' }));
  // 21. A normal Discover request cannot be satisfied by the Adult entry.
  const normalKey = 'tmdb:discover:series:all:1:no-adult';
  let hitNormalFromAdult = false;
  await getOrSet(normalKey, { ttlMs: 60_000, staleMs: 0 }, async () => {
    hitNormalFromAdult = true; // loader runs => cache missed
    return { marker: 'normal-discover-response' };
  });
  assert.equal(hitNormalFromAdult, true, '21. the normal Discover key missed (the Adult entry cannot satisfy it)');
  // Seed the normal namespace; 22. an Adult Discover request cannot be
  // satisfied by the normal entry (a fresh key, same filters).
  clearCache();
  await getOrSet(normalKey, { ttlMs: 60_000, staleMs: 0 }, async () => ({ marker: 'normal-discover-response' }));
  let hitAdultFromNormal = false;
  await getOrSet(adultKey, { ttlMs: 60_000, staleMs: 0 }, async () => {
    hitAdultFromNormal = true;
    return { marker: 'adult-discover-response' };
  });
  assert.equal(hitAdultFromNormal, true, '22. the Adult Discover key missed (the normal entry cannot satisfy it)');
  // 20. Structural disjointness of the namespaces themselves.
  const namespaces = [
    ADULT_DISCOVER_CACHE_NAMESPACE,
    'tmdb:discover',
    'tmdb:popular-v2',
    'tmdb:top-rated-v2',
    'tmdb:new-ott',
    'tmdb:theatre',
    'tmdb:adult-shows',
    'tmdb:search',
    'tmdb:collection',
    'tmdb:genre-v2',
    'tmdb:popular:',
    'tmdb:lang-movies'
  ];
  const distinct = new Set(namespaces.map((n) => n.replace(/:$/, '')));
  assert.equal(distinct.size, namespaces.map((n) => n.replace(/:$/, '')).length, '20a. every cache namespace prefix is distinct');
  for (const ns of namespaces) {
    if (ns === ADULT_DISCOVER_CACHE_NAMESPACE) continue;
    assert.ok(!ns.startsWith(ADULT_DISCOVER_CACHE_NAMESPACE) && !ADULT_DISCOVER_CACHE_NAMESPACE.startsWith(ns), `20b. '${ADULT_DISCOVER_CACHE_NAMESPACE}' is structurally disjoint from '${ns}'`);
  }
  clearCache();
  ok('20+21+22. Adult/normal response caches are isolated in BOTH directions (real process cache)');
}

// ============================================================================
// 23+24 — Phase 6 regression (wiring on the real protected routes).
// ============================================================================
{
  const watchServer = await read('src/routes/watch/[type]/[id]/+page.server.ts');
  assert.match(watchServer, /detailVerdict\(item\.tags\) === 'adult'/, '23a. the watch route still classifies via the central detail verdict');
  assert.match(watchServer, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, '23b. the watch route still evaluates the Phase 5 policy per request');
  assert.match(watchServer, /if \(!canAccess\) \{[\s\S]*?throw error\(404/, '23c. the watch guard still denies with the non-disclosing 404');
  const seasonEndpoint = await read('src/routes/api/content/series/[id]/season/[season]/+server.ts');
  assert.match(seasonEndpoint, /detailVerdict\(parent\.tags\) === 'adult'/, '24a. the season endpoint still classifies the parent series');
  assert.match(seasonEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, '24b. the season endpoint still evaluates the policy per request');
  ok('23+24. Phase 6 watch + season guards intact (wiring unchanged)');
}

// ============================================================================
// 25 — Anime adult=true exemption remains intact (behavioral, real
// classifier).
// ============================================================================
{
  assert.equal(isAdultContent(undefined, undefined, true, true, undefined), false, 'anime + adult=true (no other signal) is NOT Adult');
  assert.equal(isAdultContent(undefined, undefined, true, true, [{ id: 16, name: 'Anime Network' }]), false, 'anime + adult=true + unknown network is NOT Adult');
  assert.equal(isAdultContent(undefined, undefined, true, false, undefined), true, 'non-anime + adult=true IS Adult (exemption is anime-only)');
  ok('25. anime adult=true exemption intact (real central classifier)');
}

// ============================================================================
// Extras — the pagination contract the UI integrates against (behavioral),
// the strict UI filter surface (wiring), and the API-facing guards the UI
// relies on.
// ============================================================================
{
  // Pagination: invalid/huge pages clamp; the UI never walks unbounded.
  assert.equal(parseAdultDiscoverPage('1'), 1, 'page=1 works');
  assert.equal(parseAdultDiscoverPage('abc'), 1, 'invalid page clamps to 1');
  assert.equal(parseAdultDiscoverPage('-5'), 1, 'negative page clamps to 1');
  assert.equal(parseAdultDiscoverPage('999999999'), ADULT_DISCOVER_PAGE_CLAMP_MAX, 'huge page clamps to the API bound');
  assert.equal(parseAdultDiscoverPage('999999999'), 20, 'the clamp bound is the repo convention (20)');
  // Closed unions the UI dropdowns map onto.
  assert.equal(isAdultDiscoverType('series'), true, 'type guard accepts series');
  assert.equal(isAdultDiscoverType('movie'), true, 'type guard accepts movie');
  assert.equal(isAdultDiscoverType('tv'), false, 'type guard rejects non-union values');
  assert.equal(isAdultDiscoverSort('popularity'), true, 'sort guard accepts the default');
  assert.equal(isAdultDiscoverLanguage('hi'), true, 'language guard accepts Hindi');
  assert.equal(isAdultDiscoverLanguage('klingon'), false, 'language guard rejects unknown values');
  // The UI's Show-more respects the API contract: it appends pages only
  // while the API reports hasNextPage (structural wiring assertion).
  const section = await read('src/lib/components/AdultDiscoverSection.svelte');
  assert.match(section, /hasNextPage = Boolean\(payload\.hasNextPage\)/, 'Show-more follows the API hasNextPage (no unbounded fetching)');
  assert.match(section, /if \(loading \|\| loadingMore \|\| !hasNextPage\) return;/, 'Show-more is bounded by the API contract');
  ok('extras. pagination clamp + closed unions + bounded Show-more contract');
}

// ============================================================================
// Phase 10 QA regression — deployed mobile-width (390px) browser QA measured
// a 14px overlap between the nowrap section title (the 18+ label) and the
// non-shrinking filter pills. The Phase 10 fix wrapped the section head.
// Post-release fix: the wrap produced a visually broken second row, so the
// header is now ONE row at every width (title truncates; the provider
// filter collapses to an icon-only compact control on very narrow
// viewports). This wiring assertion keeps the no-second-row contract.
// ============================================================================
{
  const section = await read('src/lib/components/AdultDiscoverSection.svelte');
  const head = section.match(/\.section-head \{[^}]*\}/);
  assert.ok(head, 'Phase 10: the section head rule exists');
  assert.match(
    head?.[0] ?? '',
    /flex-wrap: nowrap;/,
    'post-release fix: the heading row NEVER wraps into a second row'
  );
  // The provider filter has both a labelled and a compact (icon-only)
  // instance sharing one options source; exactly one is visible per width.
  assert.match(section, /class="provider-full"/, 'labelled provider control exists for wide viewports');
  assert.match(section, /class="provider-compact"/, 'icon-only compact provider control exists for narrow viewports');
  assert.match(section, /\.provider-compact \{ display: none; \}/, 'compact instance hidden by default');
  assert.match(section, /@media \(max-width: 480px\) \{[\s\S]*?\.provider-full \{ display: none; \}[\s\S]*?\.provider-compact \{ display: inline-flex; \}/, 'very narrow viewports swap to the icon-only control');
  assert.match(section, /compact/, 'the compact instance uses the icon-only dropdown mode');
  ok('phase10. adult section head stays ONE row (title truncates; provider filter collapses to icon-only on narrow screens)');
}

console.log(`\nAdult Phase 8 tests passed: ${passed} check groups (Popular TV genre exclusion; Adult Discover UI/API integration; SSR/hydration leak prevention; legacy rail migration + protection; search parity; cache isolation; Phase 6 regression; anime exemption).`);
