import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Post-release fix — ADULT DISCOVER provider filter (closed union).
//
// The "Indian Adult Shows" surface gains an OTT provider filter that is a
// CLOSED UNION: provider = 'all' | <verified Adult registry key>. The
// client NEVER sends a TMDB network/provider id — the server maps the key
// to the verified registry id itself (Adult AND selected provider, never
// Adult OR provider). Unverified candidates and raw ids are rejected
// before any TMDB call. The language dropdown was REMOVED from the UI.
//
// Coverage:
//   - Closed-union guard: 'all' + verified keys accepted; unverified
//     candidates, raw ids, unknown/empty values rejected (behavioral,
//     with a controlled test registry)
//   - Verified-provider options: registry-sourced (display-only logos)
//   - API route wiring: policy FIRST (non-disclosing 404), then strict
//     closed-union validation incl. the provider guard
//   - Adapter wiring: key -> verified network id (TV) / resolved provider
//     narrowing (movies, fail-closed); cache key carries the provider
//     dimension; classifier defense unchanged
//   - UI wiring: provider dropdown from the policy-gated endpoint,
//     language dropdown REMOVED, single-row header

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const endpoint = readFileSync(new URL('../src/routes/api/content/adult-discover/+server.ts', import.meta.url), 'utf8');
const providersEndpoint = readFileSync(new URL('../src/routes/api/discover/adult-providers/+server.ts', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../src/lib/server/content/adult-discover.ts', import.meta.url), 'utf8');
const registry = readFileSync(new URL('../src/lib/server/content/adult-networks.ts', import.meta.url), 'utf8');
const section = readFileSync(new URL('../src/lib/components/AdultDiscoverSection.svelte', import.meta.url), 'utf8');

// --- behavioral imports ---
const { isAdultDiscoverProvider, ADULT_DISCOVER_PROVIDER_ALL, buildAdultDiscoverCacheKey } = await import('$lib/server/content/adult-discover');
const { __setAdultNetworkRegistryForTest, __resetAdultNetworkRegistryForTest, getVerifiedAdultNetworkOptions } = await import('$lib/server/content/adult-networks');
const { getVerifiedAdultNetworkIdForKey } = await import('$lib/server/content/adult-catalog');

// ============================================================
// 1. Closed-union guard against the PRODUCTION registry
// ============================================================
assert.equal(isAdultDiscoverProvider('all'), true, "'all' is accepted");
assert.equal(isAdultDiscoverProvider(undefined), false, 'absent value is NOT silently accepted by the guard (route defaults to all)');
assert.equal(isAdultDiscoverProvider('ullu'), true, 'verified key ullu accepted');
assert.equal(isAdultDiscoverProvider('kooku'), true, 'verified key kooku accepted');
assert.equal(isAdultDiscoverProvider('atrangii'), true, 'verified key atrangii accepted');
assert.equal(isAdultDiscoverProvider('altt'), false, 'UNVERIFIED candidate rejected (registry candidate, no verified id)');
assert.equal(isAdultDiscoverProvider('2902'), false, 'raw TMDB network id rejected');
assert.equal(isAdultDiscoverProvider('999999'), false, 'arbitrary numeric id rejected');
assert.equal(isAdultDiscoverProvider('netflix'), false, 'known NON-adult network rejected');
assert.equal(isAdultDiscoverProvider(''), false, 'empty value rejected');
assert.equal(isAdultDiscoverProvider('Ullu'), false, 'case must match the registry key exactly');
assert.equal(isAdultDiscoverProvider('ullu;DROP'), false, 'injection-shaped value rejected');
ok('1. production registry: only verified keys + all pass the guard');

// ============================================================
// 2. Behavioral: guard + options track a CONTROLLED test registry
//    (verified set changes -> accepted union changes accordingly)
// ============================================================
try {
  __setAdultNetworkRegistryForTest([
    { key: 'testnet', name: 'Test Network', tmdbNetworkId: 4242, tmdbLogoPath: '/test.png', verification: 'verified' },
    { key: 'candidate', name: 'Candidate', tmdbNetworkId: 0, verification: 'unverified' }
  ]);
  assert.equal(isAdultDiscoverProvider('testnet'), true, 'a newly VERIFIED registry key is accepted (dynamic union)');
  assert.equal(isAdultDiscoverProvider('candidate'), false, 'unverified candidates never enter the union');
  assert.equal(isAdultDiscoverProvider('ullu'), false, 'keys outside the active registry are not accepted');
  const options = getVerifiedAdultNetworkOptions();
  assert.deepEqual(options, [{ key: 'testnet', name: 'Test Network', logoPath: '/test.png' }], 'dropdown options expose VERIFIED entries only, with logo paths');
  assert.equal(getVerifiedAdultNetworkIdForKey('testnet'), 4242, 'server-side key -> verified id mapping');
  assert.equal(getVerifiedAdultNetworkIdForKey('candidate'), undefined, 'unverified keys resolve to nothing');
} finally {
  __resetAdultNetworkRegistryForTest();
}
// Post-reset the production registry is active again.
assert.equal(isAdultDiscoverProvider('ullu'), true, 'registry override fully reset');
assert.equal(getVerifiedAdultNetworkOptions().some((entry) => entry.key === 'ullu'), true, 'production options restored');
ok('2. union + options are registry-driven (test override verified, production registry restored)');

// ============================================================
// 3. Cache key carries the provider dimension (rule 13)
// ============================================================
const base = { type: 'series' as const, language: 'all' as const, sort: 'popularity' as const, page: 1, networkInclusion: '2902|4573|7355' };
const keyAll = buildAdultDiscoverCacheKey({ ...base, provider: 'all' });
const keyUllu = buildAdultDiscoverCacheKey({ ...base, provider: 'ullu' });
const keyKooku = buildAdultDiscoverCacheKey({ ...base, provider: 'kooku' });
assert.notEqual(keyAll, keyUllu, 'all vs ullu occupy different cache entries');
assert.notEqual(keyUllu, keyKooku, 'per-provider responses never share cache entries');
assert.ok(keyUllu.endsWith(':ullu'), 'provider dimension embedded as the validated KEY (never an id)');
assert.equal(buildAdultDiscoverCacheKey({ ...base, provider: '2902' }), keyAll, 'a raw id collapses to the all dimension (never enters a key)');
assert.equal(buildAdultDiscoverCacheKey({ ...base }), keyAll, 'absent provider defaults to the all dimension');
// Intra-namespace isolation retained: every adult-discover key starts with
// the dedicated namespace (structurally disjoint from normal rails).
for (const key of [keyAll, keyUllu, keyKooku]) {
  assert.ok(key.startsWith('tmdb:adult-discover:'), `key stays inside the isolated namespace (${key})`);
}
ok('3. cache key: provider dimension is the closed-union key; isolation namespace unchanged');

// ============================================================
// 4. API route — policy first, then closed-union validation
// ============================================================
assert.match(endpoint, /await canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'per-request Phase 5 policy');
assert.match(endpoint, /status: 404/, 'unauthorized -> non-disclosing 404');
assert.match(endpoint, /searchParams\.get\('provider'\) \?\? ADULT_DISCOVER_PROVIDER_ALL/, "provider defaults to 'all'");
assert.match(endpoint, /isAdultDiscoverProvider\(providerParam\)/, 'provider validated against the closed union');
assert.match(endpoint, /INVALID_PROVIDER/, 'rejected providers get a dedicated 400 code');
const authIdx = endpoint.indexOf('canAccessAdultContent');
const providerIdx = endpoint.indexOf('isAdultDiscoverProvider(providerParam)');
const serviceIdx = endpoint.indexOf('await adultDiscover(');
assert.ok(authIdx < providerIdx && providerIdx < serviceIdx, 'order: authorization -> provider validation -> service');
assert.match(endpoint, /provider: providerParam/, 'validated key (not raw ids) reaches the service');
assert.match(endpoint, /isAdultDiscoverLanguage/, 'language dimension stays server-validated (backward compatible)');
assert.doesNotMatch(endpoint, /with_networks/, 'no network filter is client-controllable');
// Endpoint CODE must never contain literal network ids (registry keys only).
// Comments may cite them as examples, so strip line comments before matching.
const endpointCode = endpoint.replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(endpointCode, /\b2902\b|\b4573\b|\b7355\b/, 'no literal network ids in the route code');
ok('4. route: policy gate -> closed-union provider validation -> service');

// ============================================================
// 5. Adapter — key mapped to verified ids server-side; fail-closed movie half
// ============================================================
{
  const fn = adapter.match(/export async function getTmdbAdultDiscover[\s\S]*?^}/m);
  assert.ok(fn, 'getTmdbAdultDiscover found');
  const body = fn![0];
  assert.match(body, /getVerifiedAdultNetworkIdForKey\(selectedProviderKey\)/, 'provider key -> VERIFIED network id via the central registry');
  assert.match(body, /withAdultNetworksParams\(selectedNetworkId\)/, 'TV query narrows through the verified-only inclusion builder');
  assert.match(body, /providerInclusion = match \? String\(match\.tmdbProviderId\) : undefined/, 'movie half narrows to the RESOLVED provider id only');
  assert.match(body, /if \(!hasSource\) \{[\s\S]*?return emptyAdultDiscoverResult\(page\)/, 'no verified source -> EMPTY result (fail-closed, never widened to all)');
  assert.match(body, /provider: filters\.provider \?\? ADULT_DISCOVER_PROVIDER_ALL/, 'cache key carries the provider dimension');
  assert.doesNotMatch(body, /fixturesFor|catch\s*(\(|\{)/, 'no fixture fallback, no swallowed errors (unchanged)');
  // The classifier defense is intact: every candidate still flows through
  // collectConfirmedAdultPage.
  assert.match(body, /collectConfirmedAdultPage/, 'bounded classifier defense retained');
  ok('5. adapter: server-side key->id mapping, Adult AND provider, fail-closed empty over fallback');
}

// ============================================================
// 6. Verified-provider list endpoint — registry-sourced, policy-gated
// ============================================================
assert.match(providersEndpoint, /getVerifiedAdultNetworkOptions/, 'serves the VERIFIED network registry');
assert.match(providersEndpoint, /canAccessAdultContent\(locals\.supabase, user, cookies\)/, 'policy-gated per request');
assert.match(providersEndpoint, /providers: \[\]/, 'unauthorized requests get the empty non-disclosing list');
assert.match(providersEndpoint, /providerLogoUrl/, 'logos built through the SAME image CDN convention');
assert.doesNotMatch(providersEndpoint, /\b2902\b|\b4573\b|\b7355\b/, 'no literal ids in the endpoint (registry is the source)');
ok('6. provider list endpoint: verified registry + logos via the controlled TMDB CDN convention');

// ============================================================
// 7. UI — provider dropdown from the endpoint; language dropdown REMOVED
// ============================================================
assert.match(section, /fetch\('\/api\/discover\/adult-providers'\)/, 'provider options fetched from the policy-gated endpoint');
assert.match(section, /\{ value: 'all', label: 'All' \}/, "'All' option present");
assert.doesNotMatch(section, /LANGUAGE_OPTIONS/, 'language dropdown options REMOVED from the Adult surface');
assert.doesNotMatch(section, /changeLanguage|language = \$state/, 'no language filter state remains');
assert.match(section, /changeProvider/, 'provider filter switches reload page 1');
assert.match(section, /loadProviderOptions/, 'options are loaded dynamically from the registry endpoint');
assert.doesNotMatch(section, /'ullu'|'kooku'|'atrangii'/, 'no hardcoded brand keys in the component');
assert.doesNotMatch(section, /2902|4573|7355/, 'no hardcoded network ids in the component');
assert.doesNotMatch(section, /localStorage|sessionStorage/, 'no persistent browser storage for filter state');
ok('7. UI: dynamic verified-provider dropdown, language filter removed, no persistence');

// ============================================================
// 8. Contract header still documents the mandatory Adult constraint
// ============================================================
assert.match(contract, /ADULT_DISCOVER_PROVIDER_ALL = 'all'/, "closed union constant exists ('all')");
assert.match(contract, /isAdultDiscoverProvider/, 'closed-union guard exported from the contract module');
assert.match(registry, /tmdbLogoPath\?: string \| null/, 'registry carries the optional controlled logo mapping');
assert.match(registry, /display-only|Display metadata|display metadata/i, 'logo field documented as display-only');
ok('8. contract + registry documented (closed union, display-only logos)');

console.log(`\nAdult Discover provider filter tests passed (${passed} check groups).`);
