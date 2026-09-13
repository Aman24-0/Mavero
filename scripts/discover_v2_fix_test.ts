import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = new URL('../', import.meta.url).pathname;

const tmdb = await readFile(path.join(repoRoot, 'src/lib/server/content/adapters/tmdb.ts'), 'utf8');
const discoverPage = await readFile(path.join(repoRoot, 'src/lib/components/DiscoverPage.svelte'), 'utf8');
// Since Phase C the legacy Profile page is a redirect-only route; the shared
// AppFooter contract is asserted on the canonical Account page instead.
const accountPage = await readFile(path.join(repoRoot, 'src/routes/account/+page.svelte'), 'utf8');
const appFooter = await readFile(path.join(repoRoot, 'src/lib/components/AppFooter.svelte'), 'utf8');
const railEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/discover/rail/+server.ts'), 'utf8');

// ============================================================================
// A. New on OTT — provider list, provider ID resolution, query params,
//    mixed All OTT, movie + TV merge, no N+1, no fixtures.
// ============================================================================
{
  // Provider list comes from TMDB India metadata.
  assert.match(tmdb, /function getTmdbIndiaProviders/, 'India providers function exists');
  assert.match(tmdb, /\/watch\/providers\/movie.*watch_region: 'IN'/, 'fetches movie providers for IN');
  assert.match(tmdb, /\/watch\/providers\/tv.*watch_region: 'IN'/, 'fetches TV providers for IN');

  // Selected provider uses real TMDB provider ID.
  assert.match(tmdb, /function resolveProviderIdByKey/, 'provider key resolver exists');
  assert.match(tmdb, /match\?\.providerId/, 'resolves to TMDB provider_id');

  // watch_region=IN is present in the OTT query.
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?watch_region: 'IN'/, 'OTT query has watch_region=IN');

  // flatrate monetization is present.
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?with_watch_monetization_types: 'flatrate'/, 'OTT query has flatrate');

  // with_watch_providers is passed when a provider is selected.
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?with_watch_providers: providerId/, 'OTT passes with_watch_providers');

  // All OTT is mixed — no per-provider bucket concatenation.
  // For "All OTT" (providerKey undefined), with_watch_providers is NOT set.
  // The query is one mixed catalog query, not N per-provider queries.
  assert.doesNotMatch(tmdb, /for \(const provider of.*providers\)/, 'no per-provider loop in OTT');
  // The function uses /discover/movie + /discover/tv (both India-filtered).
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?tmdbRequest<TmdbList<TmdbMovie>>\('\/discover\/movie'/, 'OTT fetches /discover/movie');
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?tmdbRequest<TmdbList<TmdbTv>>\('\/discover\/tv'/, 'OTT fetches /discover/tv');

  // movie + TV can both contribute — they're merged.
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?merged = \[\.\.\.movieItems, \.\.\.tvItems\]/, 'OTT merges movie + TV');

  // No per-title N+1 provider calls — the filter is server-side.
  const newOnOttFn = tmdb.match(/export async function getTmdbNewOnOtt[\s\S]*?^}/m);
  assert.ok(newOnOttFn, 'getTmdbNewOnOtt function body found');
  assert.doesNotMatch(newOnOttFn![0], /matchesOtt/, 'getTmdbNewOnOtt does NOT call per-item matchesOtt');

  // No fixtures — errors propagate (no silent .catch that hides failures).
  assert.doesNotMatch(newOnOttFn![0], /\.catch\(\(\) => \(/, 'getTmdbNewOnOtt does NOT silently swallow errors');

  // Sort by release date desc for movies, first_air_date desc for TV.
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?sort_by: 'release_date\.desc'/, 'OTT movies sorted by release_date.desc');
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?sort_by: 'first_air_date\.desc'/, 'OTT TV sorted by first_air_date.desc');

  // release_date.lte / first_air_date.lte = today (no future dates).
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?'release_date\.lte'/, 'OTT movies have release_date.lte');
  assert.match(tmdb, /function getTmdbNewOnOtt[\s\S]*?'first_air_date\.lte'/, 'OTT TV have first_air_date.lte');
}

// ============================================================================
// B. Popular language — correct TMDB original-language filtering.
// ============================================================================
{
  // The function uses /discover/movie and /discover/tv (NOT /movie/popular
  // or /tv/popular) because the /popular endpoints don't support
  // with_original_language.
  const popularFn = tmdb.match(/export async function getTmdbPopularByLanguage[\s\S]*?^}/m);
  assert.ok(popularFn, 'getTmdbPopularByLanguage function body found');
  assert.match(popularFn![0], /\/discover\/movie/, 'popular-movie uses /discover/movie (not /movie/popular)');
  assert.match(popularFn![0], /\/discover\/tv/, 'popular-series uses /discover/tv (not /tv/popular)');
  assert.doesNotMatch(popularFn![0], /\/movie\/popular/, 'popular-movie does NOT use /movie/popular');
  assert.doesNotMatch(popularFn![0], /\/tv\/popular/, 'popular-series does NOT use /tv/popular');

  // with_original_language is passed for specific languages.
  assert.match(popularFn![0], /with_original_language: langParam/, 'popular passes with_original_language');

  // sort_by=popularity.desc preserves popularity ranking.
  assert.match(popularFn![0], /sort_by: 'popularity\.desc'/, 'popular uses sort_by=popularity.desc');

  // region=IN for movies.
  assert.match(popularFn![0], /region: 'IN'/, 'popular-movie uses region=IN');

  // "All" has no with_original_language (one unfiltered query).
  assert.match(popularFn![0], /if \(language === 'all'\) break/, 'all-language breaks after first page');

  // "Other" excludes hi/en/ta/te/ml/kn.
  assert.match(tmdb, /OTHER_LANGUAGE_EXCLUSIONS/, 'other-language exclusion set exists');
  assert.match(tmdb, /KNOWN_LANGUAGES.*hi.*en.*ta.*te.*ml.*kn/, 'known languages list');

  // Language mappings.
  assert.match(tmdb, /hi: 'hi'/, 'Hindi → hi');
  assert.match(tmdb, /en: 'en'/, 'English → en');
  assert.match(tmdb, /ta: 'ta'/, 'Tamil → ta');
  assert.match(tmdb, /te: 'te'/, 'Telugu → te');
  assert.match(tmdb, /ml: 'ml'/, 'Malayalam → ml');
  assert.match(tmdb, /kn: 'kn'/, 'Kannada → kn');

  // No fixtures in the popular path.
  assert.doesNotMatch(popularFn![0], /fixtures/, 'popular function does not reference fixtures');
}

// ============================================================================
// C. Footer — shared component, disclaimer, attribution.
// ============================================================================
{
  // AppFooter component exists.
  assert.match(appFooter, /<footer class="app-footer">/, 'AppFooter renders a <footer>');
  // MAVERO branding.
  assert.match(appFooter, /MAVERO/, 'AppFooter has MAVERO branding');
  // Tagline.
  assert.match(appFooter, /Movies, series.*all in one place/, 'AppFooter has tagline');
  // TMDB attribution + logo.
  assert.match(appFooter, /tmdb-credit/, 'AppFooter has TMDB credit');
  assert.match(appFooter, /tmdb-logo/, 'AppFooter has TMDB logo');
  assert.match(appFooter, /themoviedb\.org\/about\/logos-attribution/, 'AppFooter links to TMDB attribution page');
  // JustWatch attribution.
  assert.match(appFooter, /justwatch-credit/, 'AppFooter has JustWatch credit');
  assert.match(appFooter, /justwatch\.com/, 'AppFooter links to JustWatch');
  // Disclaimer.
  assert.match(appFooter, /does not host, upload, or store/, 'AppFooter has third-party content disclaimer');
  assert.match(appFooter, /third-party services available on the internet/, 'disclaimer mentions third-party services');
  // Copyright.
  assert.match(appFooter, /Mavero @2026/, 'AppFooter has Mavero @2026 copyright');
  // No unsupported legal claims.
  assert.doesNotMatch(appFooter, /DMCA/i, 'no DMCA claims');
  assert.doesNotMatch(appFooter, /no liability/i, 'no liability claims');
  assert.doesNotMatch(appFooter, /all content is legal/i, 'no legal-content claims');

  // Discover uses AppFooter.
  assert.match(discoverPage, /import AppFooter from '\$components\/AppFooter\.svelte'/, 'DiscoverPage imports AppFooter');
  assert.match(discoverPage, /<AppFooter/, 'DiscoverPage renders AppFooter');
  // Discover no longer has its own inline footer.
  assert.doesNotMatch(discoverPage, /class="discover-footer"/, 'DiscoverPage no longer has inline discover-footer');
  assert.doesNotMatch(discoverPage, /class="discover-attribution"/, 'DiscoverPage no longer has inline attribution');

  // Account uses AppFooter (canonical user surface since Phase C).
  assert.match(accountPage, /import AppFooter from '\$components\/AppFooter\.svelte'/, 'Account imports AppFooter');
  assert.match(accountPage, /<AppFooter/, 'Account renders AppFooter');
  // Account carries no inline legacy profile footer.
  assert.doesNotMatch(accountPage, /class="profile-footer"/, 'Account has no inline profile-footer');

  // Bottom nav unaffected — AppFooter doesn't import or modify navigation.
  assert.doesNotMatch(appFooter, /mobile-nav|bottom-nav|AppShell/, 'AppFooter does not touch bottom navigation');
}

console.log('Discover V2 targeted fix tests passed: OTT provider/region/flatrate/merge/no-N+1/no-catch/release-date-sort (A); popular /discover endpoint + with_original_language + no /popular endpoint + All mixed + Other excluded (B); shared AppFooter + disclaimer + TMDB/JustWatch attribution + Discover + Account consistent + bottom nav untouched (C).');
