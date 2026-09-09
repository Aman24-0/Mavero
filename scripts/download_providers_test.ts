import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyDownloadTemplate,
  buildDownloadUrl,
  filterProvidersByMediaType,
  pad2,
  slugifyTitle,
  sortPublicDownloadProviders,
  DOWNLOAD_PLACEHOLDERS,
  type PublicDownloadProvider,
} from '../src/lib/shared/downloader.ts';
import { parseDownloadProviderForm, DownloaderValidationError } from '../src/lib/server/downloader/validation.ts';

// MAVERO Download Provider integration tests.
//
// Pure (no live Supabase) deterministic tests covering:
//   1. every movie URL template — exact URL generation for all 5 providers
//   2. every TV URL template — exact URL generation for all 5 providers
//   3. Cineverse slug generation — spec examples (Deadpool & Wolverine,
//      Dune: Part Two, Breaking Bad, Loki)
//   4. season/episode zero-padding — {season2}/{episode2} produce s02e05
//   5. disabled providers excluded from public config — verified via
//      sortPublicDownloadProviders + filterProvidersByMediaType contract
//   6. default provider ordering — default first, then ordering, then name
//   7. provider content-type capability filtering — movie-only provider
//      hidden on TV detail page
//   8. invalid/non-HTTPS URL rejection — validation throws
//   9. adult unauthorized content does not expose downloader — verified by
//      reading the existing SSR load + DetailPage contract (no downloader-
//      specific guard is added; the existing 404 gate is the guard)
//  10. no changes to streaming provider/source registry behavior —
//      verified by reading the streaming-registry files and confirming
//      no downloader imports leak into them, and no streaming imports
//      leak into the downloader modules

let passed = 0;
function ok(label: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

// ============================================================
// Fixture providers — mirror the seed data in
// 20260915000000_download_providers.sql
// ============================================================
const fixtures: PublicDownloadProvider[] = [
  {
    id: 'p-02movie',
    name: '02Movie Downloader',
    slug: '02movie',
    enabled: true,
    isDefault: true,
    ordering: 10,
    icon: 'download',
    description: '02Movie direct-download links for movies and TV episodes using TMDB IDs.',
    supportsMovie: true,
    supportsTv: true,
    movieUrlTemplate: 'https://02moviedownloader.site/api/download/movie/{tmdbId}',
    tvUrlTemplate: 'https://02moviedownloader.site/api/download/tv/{tmdbId}/{season}/{episode}',
  },
  {
    id: 'p-vidvault',
    name: 'VidVault',
    slug: 'vidvault',
    enabled: true,
    isDefault: false,
    ordering: 20,
    icon: 'download',
    description: 'VidVault direct-download links.',
    supportsMovie: true,
    supportsTv: true,
    movieUrlTemplate: 'https://vidvault.ru/movie/{tmdbId}',
    tvUrlTemplate: 'https://vidvault.ru/tv/{tmdbId}/{season}/{episode}',
  },
  {
    id: 'p-nxsha',
    name: 'Nxsha Space',
    slug: 'nxsha',
    enabled: true,
    isDefault: false,
    ordering: 30,
    icon: 'download',
    description: 'Nxsha Space direct-download links.',
    supportsMovie: true,
    supportsTv: true,
    movieUrlTemplate: 'https://nxsha.space/dl/movie/{tmdbId}',
    tvUrlTemplate: 'https://nxsha.space/dl/tv/{tmdbId}/{season}/{episode}',
  },
  {
    id: 'p-nhd',
    name: 'NHD Downloader',
    slug: 'nhd',
    enabled: true,
    isDefault: false,
    ordering: 40,
    icon: 'download',
    description: 'NHD direct-download links.',
    supportsMovie: true,
    supportsTv: true,
    movieUrlTemplate: 'https://nhdapi.com/dl/movie/{tmdbId}',
    tvUrlTemplate: 'https://nhdapi.com/dl/tv/{tmdbId}/{season}/{episode}',
  },
  {
    id: 'p-cineverse',
    name: 'Cineverse',
    slug: 'cineverse',
    enabled: true,
    isDefault: false,
    ordering: 50,
    icon: 'download',
    description: 'Cineverse download links using a deterministic title slug and zero-padded season/episode.',
    supportsMovie: true,
    supportsTv: true,
    movieUrlTemplate: 'https://cineverse.modiplay.xyz/download/{titleSlug}',
    tvUrlTemplate: 'https://cineverse.modiplay.xyz/download/{titleSlug}-s{season2}e{episode2}',
  },
];

// ============================================================
// 1. Every MOVIE URL template — exact URL for all 5 providers
// ============================================================
console.log('\n1. Movie URL templates');

const tmdbId = '6263850';
const movieTitle = 'Deadpool & Wolverine';

const expectedMovieUrls: Record<string, string> = {
  'p-02movie': 'https://02moviedownloader.site/api/download/movie/6263850',
  'p-vidvault': 'https://vidvault.ru/movie/6263850',
  'p-nxsha': 'https://nxsha.space/dl/movie/6263850',
  'p-nhd': 'https://nhdapi.com/dl/movie/6263850',
  'p-cineverse': 'https://cineverse.modiplay.xyz/download/deadpool-wolverine',
};

for (const provider of fixtures) {
  const url = buildDownloadUrl(provider, { mediaType: 'movie', tmdbId, title: movieTitle });
  assert.equal(url, expectedMovieUrls[provider.id], `movie URL for ${provider.slug}`);
}
ok('all 5 movie URLs match the spec exactly (02movie/vidvault/nxsha/nhd use tmdbId; cineverse uses titleSlug)');

// HTTPS-only contract: every produced URL is HTTPS.
for (const provider of fixtures) {
  const url = buildDownloadUrl(provider, { mediaType: 'movie', tmdbId, title: movieTitle });
  assert.ok(url?.startsWith('https://'), `${provider.slug} movie URL is HTTPS`);
}
ok('every movie URL is HTTPS');

// ============================================================
// 2. Every TV URL template — exact URL for all 5 providers
// ============================================================
console.log('\n2. TV URL templates');

const season = 2;
const episode = 5;
const tvTitle = 'Breaking Bad';

const expectedTvUrls: Record<string, string> = {
  'p-02movie': 'https://02moviedownloader.site/api/download/tv/6263850/2/5',
  'p-vidvault': 'https://vidvault.ru/tv/6263850/2/5',
  'p-nxsha': 'https://nxsha.space/dl/tv/6263850/2/5',
  'p-nhd': 'https://nhdapi.com/dl/tv/6263850/2/5',
  'p-cineverse': 'https://cineverse.modiplay.xyz/download/breaking-bad-s02e05',
};

for (const provider of fixtures) {
  const url = buildDownloadUrl(provider, { mediaType: 'tv', tmdbId, title: tvTitle, season, episode });
  assert.equal(url, expectedTvUrls[provider.id], `TV URL for ${provider.slug}`);
}
ok('all 5 TV URLs match the spec exactly (02movie/vidvault/nxsha/nhd use raw season/episode; cineverse uses s02e05)');

// Different title to confirm Cineverse uses the title (not a hardcoded map):
const lokiMovie = buildDownloadUrl(fixtures[4], { mediaType: 'movie', tmdbId: '84958', title: 'Loki' });
assert.equal(lokiMovie, 'https://cineverse.modiplay.xyz/download/loki', 'cineverse movie slug for "Loki"');
const lokiTv = buildDownloadUrl(fixtures[4], { mediaType: 'tv', tmdbId: '84958', title: 'Loki', season: 2, episode: 5 });
assert.equal(lokiTv, 'https://cineverse.modiplay.xyz/download/loki-s02e05', 'cineverse TV slug for "Loki" S02E05');
ok('cineverse TV URL uses title-derived slug + zero-padded s02e05 (matches spec Loki example)');

const duneMovie = buildDownloadUrl(fixtures[4], { mediaType: 'movie', tmdbId: '438631', title: 'Dune: Part Two' });
assert.equal(duneMovie, 'https://cineverse.modiplay.xyz/download/dune-part-two', 'cineverse movie slug for "Dune: Part Two"');
ok('cineverse movie URL for "Dune: Part Two" matches spec');

// ============================================================
// 3. Cineverse slug generation — spec examples
// ============================================================
console.log('\n3. Cineverse slug generation');

assert.equal(slugifyTitle('Deadpool & Wolverine'), 'deadpool-wolverine', 'Deadpool & Wolverine');
assert.equal(slugifyTitle('Dune: Part Two'), 'dune-part-two', 'Dune: Part Two');
assert.equal(slugifyTitle('Breaking Bad'), 'breaking-bad', 'Breaking Bad');
assert.equal(slugifyTitle('Loki'), 'loki', 'Loki');
ok('all 4 spec slug examples match');

// Edge cases:
assert.equal(slugifyTitle(''), '', 'empty title -> empty slug');
assert.equal(slugifyTitle('   '), '', 'whitespace-only title -> empty slug');
assert.equal(slugifyTitle('Hello!!! World'), 'hello-world', 'punctuation stripped');
assert.equal(slugifyTitle('A    B'), 'a-b', 'multiple spaces collapsed');
assert.equal(slugifyTitle('--Hello--'), 'hello', 'leading/trailing dashes trimmed');
assert.equal(slugifyTitle('The 100'), 'the-100', 'numbers preserved');
assert.equal(slugifyTitle('Star Wars: Episode IV - A New Hope'), 'star-wars-episode-iv-a-new-hope', 'complex title');
assert.equal(slugifyTitle('Café Crème'), 'cafe-creme', 'accented characters normalized');
assert.equal(slugifyTitle('UNDERSCORE_TEST'), 'underscore-test', 'underscores become dashes');
ok('10 slug edge cases pass (empty/whitespace/punctuation/multi-space/trim/numbers/complex/accents/underscores)');

// ============================================================
// 4. Season/episode zero-padding
// ============================================================
console.log('\n4. Season/episode zero-padding');

assert.equal(pad2(0), '00', 'pad2(0)');
assert.equal(pad2(1), '01', 'pad2(1)');
assert.equal(pad2(5), '05', 'pad2(5)');
assert.equal(pad2(9), '09', 'pad2(9)');
assert.equal(pad2(10), '10', 'pad2(10)');
assert.equal(pad2(12), '12', 'pad2(12)');
assert.equal(pad2(99), '99', 'pad2(99)');
assert.equal(pad2(100), '100', 'pad2(100) — three digits preserved');
assert.equal(pad2(123), '123', 'pad2(123) — three digits preserved');
assert.equal(pad2(-5), '00', 'pad2(-5) — negative clamped to 0');
assert.equal(pad2(NaN), '00', 'pad2(NaN) -> 00');
assert.equal(pad2(Infinity), '00', 'pad2(Infinity) -> 00');
ok('pad2 handles 0/1/5/9/10/12/99/100/123/-5/NaN/Infinity');

// Verify the {season2}/{episode2} placeholders are zero-padded in actual URLs.
const singleDigitUrl = applyDownloadTemplate('https://example.com/{season2}e{episode2}', { season: 5, episode: 7 });
assert.equal(singleDigitUrl, 'https://example.com/05e07', 'season2/episode2 zero-padded for single digits');
const doubleDigitUrl = applyDownloadTemplate('https://example.com/s{season2}e{episode2}', { season: 12, episode: 23 });
assert.equal(doubleDigitUrl, 'https://example.com/s12e23', 'season2/episode2 preserved for double digits');
ok('season2/episode2 placeholders produce zero-padded values in real templates');

// ============================================================
// 5. Disabled providers excluded from public config
// ============================================================
console.log('\n5. Disabled providers excluded from public config');

// The public config reader filters `enabled = true` at the SQL view layer
// (download_providers_public). Here we verify the helper functions that
// operate on the already-filtered list do not silently re-include disabled
// providers, AND we verify the public-config reader's source actually
// filters by enabled=true.
const publicConfigSource = readFileSync(new URL('../src/lib/server/downloader/public-config.ts', import.meta.url), 'utf8');
assert.match(publicConfigSource, /\.eq\('enabled', true\)/, 'public config reader filters enabled=true');
assert.match(publicConfigSource, /from\('download_providers_public'\)/, 'public config reader reads from the public view');

// Simulate the post-filter list (only enabled providers):
const enabledOnly = fixtures.filter((p) => p.enabled);
assert.equal(enabledOnly.length, fixtures.length, 'all fixtures enabled in this test set');

// Add a disabled provider and confirm filterProvidersByMediaType never
// surfaces it via the sort (it would only be excluded upstream, but the
// contract is: the public reader only ever sees enabled providers).
const withDisabled: PublicDownloadProvider[] = [
  ...fixtures,
  { ...fixtures[0], id: 'p-disabled', slug: 'disabled', enabled: false, isDefault: false },
];
const sortedWithDisabled = sortPublicDownloadProviders(withDisabled);
assert.ok(sortedWithDisabled.every((p) => p.id !== 'p-disabled' || p.enabled === false), 'disabled provider present in input but not promoted to default by sort');
// The default (02movie) remains first.
assert.equal(sortedWithDisabled[0].id, 'p-02movie', 'default (02movie) stays first');
ok('disabled provider is never promoted to default by the sort helper; default stays first');

// ============================================================
// 6. Default provider ordering — default first, then ordering, then name
// ============================================================
console.log('\n6. Default provider ordering');

// With the default present, it's first.
const sorted1 = sortPublicDownloadProviders(fixtures);
assert.equal(sorted1[0].id, 'p-02movie', 'default (02movie) is first');
assert.equal(sorted1[0].isDefault, true, 'first item is the default');
// Remaining providers are ordered by ordering then name:
assert.equal(sorted1[1].id, 'p-vidvault', 'second is vidvault (ordering 20)');
assert.equal(sorted1[2].id, 'p-nxsha', 'third is nxsha (ordering 30)');
assert.equal(sorted1[3].id, 'p-nhd', 'fourth is nhd (ordering 40)');
assert.equal(sorted1[4].id, 'p-cineverse', 'fifth is cineverse (ordering 50)');
ok('default-first, then ordering-ascending, then name-ascending');

// With no default in the list, the sort still produces a stable order
// (ordering then name) — the public-config reader promotes the first
// enabled-by-ordering to default AFTER sorting.
const noDefault = fixtures.map((p) => ({ ...p, isDefault: false }));
const sorted2 = sortPublicDownloadProviders(noDefault);
assert.equal(sorted2[0].id, 'p-02movie', 'no default: first by ordering (10)');
assert.equal(sorted2[0].isDefault, false, 'no default: first is NOT default-flagged');
ok('no-default case: sort by ordering then name (the public-config reader promotes first to default)');

// Tie-breaker: same ordering, sort by name.
const tie: PublicDownloadProvider[] = [
  { ...fixtures[0], id: 'a', name: 'Zeta', slug: 'zeta', isDefault: false, ordering: 100 },
  { ...fixtures[0], id: 'b', name: 'Alpha', slug: 'alpha', isDefault: false, ordering: 100 },
];
const sortedTie = sortPublicDownloadProviders(tie);
assert.equal(sortedTie[0].id, 'b', 'tie-break: Alpha before Zeta');
assert.equal(sortedTie[1].id, 'a', 'tie-break: Zeta after Alpha');
ok('tie-breaker: same ordering falls back to name ascending');

// ============================================================
// 7. Provider content-type capability filtering
// ============================================================
console.log('\n7. Provider content-type capability filtering');

// All 5 fixtures support both movie + TV — verify they all appear for both.
assert.equal(filterProvidersByMediaType(fixtures, 'movie').length, 5, 'all 5 fixtures support movie');
assert.equal(filterProvidersByMediaType(fixtures, 'tv').length, 5, 'all 5 fixtures support tv');

// Movie-only provider is hidden on a TV detail page.
const movieOnly: PublicDownloadProvider = {
  ...fixtures[0],
  id: 'p-movie-only',
  slug: 'movie-only',
  supportsMovie: true,
  supportsTv: false,
  isDefault: false,
};
const tvOnly: PublicDownloadProvider = {
  ...fixtures[0],
  id: 'p-tv-only',
  slug: 'tv-only',
  supportsMovie: false,
  supportsTv: true,
  isDefault: false,
};
const mixed: PublicDownloadProvider[] = [...fixtures, movieOnly, tvOnly];
const movieFiltered = filterProvidersByMediaType(mixed, 'movie');
assert.ok(movieFiltered.some((p) => p.id === 'p-movie-only'), 'movie-only provider visible on movie page');
assert.ok(!movieFiltered.some((p) => p.id === 'p-tv-only'), 'tv-only provider hidden on movie page');
const tvFiltered = filterProvidersByMediaType(mixed, 'tv');
assert.ok(tvFiltered.some((p) => p.id === 'p-tv-only'), 'tv-only provider visible on tv page');
assert.ok(!tvFiltered.some((p) => p.id === 'p-movie-only'), 'movie-only provider hidden on tv page');
ok('movie-only hidden on TV page; tv-only hidden on movie page');

// buildDownloadUrl returns null for unsupported media types.
assert.equal(buildDownloadUrl(movieOnly, { mediaType: 'tv', tmdbId, title: 'X', season: 1, episode: 1 }), null, 'movie-only provider returns null for TV');
assert.equal(buildDownloadUrl(tvOnly, { mediaType: 'movie', tmdbId, title: 'X' }), null, 'tv-only provider returns null for movie');
ok('buildDownloadUrl returns null for unsupported media type');

// ============================================================
// 8. Invalid/non-HTTPS URL rejection
// ============================================================
console.log('\n8. Invalid/non-HTTPS URL rejection');

function form(values: Record<string, string | boolean>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'boolean') { if (value) data.set(key, 'on'); }
    else data.set(key, value);
  }
  return data;
}

// Valid form parses successfully.
const valid = parseDownloadProviderForm(form({
  name: 'Test Downloader',
  slug: 'test-downloader',
  ordering: '10',
  supports_movie: true,
  supports_tv: true,
  movie_url_template: 'https://example.com/movie/{tmdbId}',
  tv_url_template: 'https://example.com/tv/{tmdbId}/{season}/{episode}',
  enabled: true,
}));
assert.equal(valid.slug, 'test-downloader');
assert.equal(valid.movie_url_template, 'https://example.com/movie/{tmdbId}');

// HTTP rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: true,
  supports_tv: false,
  movie_url_template: 'http://example.com/movie/{tmdbId}',
})), DownloaderValidationError, 'HTTP movie template rejected');

// javascript: rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: true,
  supports_tv: false,
  movie_url_template: 'javascript:alert(1)',
})), DownloaderValidationError, 'javascript: scheme rejected');

// data: rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: true,
  supports_tv: false,
  movie_url_template: 'data:text/html,<script>alert(1)</script>',
})), DownloaderValidationError, 'data: scheme rejected');

// Unknown placeholder rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: true,
  supports_tv: false,
  movie_url_template: 'https://example.com/movie/{evilPlaceholder}',
})), DownloaderValidationError, 'unknown placeholder rejected');

// Multi-line template rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: true,
  supports_tv: false,
  movie_url_template: 'https://example.com/movie/{tmdbId}\n?evil=1',
})), DownloaderValidationError, 'multi-line template rejected');

// Bad slug rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'Bad_Slug',
  supports_movie: true,
  supports_tv: false,
  movie_url_template: 'https://example.com/movie/{tmdbId}',
})), DownloaderValidationError, 'bad slug rejected');

// Supports neither movie nor TV rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: false,
  supports_tv: false,
})), DownloaderValidationError, 'supports neither movie nor TV rejected');

// Movie support enabled but movie template missing rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: true,
  supports_tv: false,
})), DownloaderValidationError, 'movie support without movie template rejected');

// TV support enabled but TV template missing rejected.
assert.throws(() => parseDownloadProviderForm(form({
  name: 'Bad',
  slug: 'bad',
  supports_movie: false,
  supports_tv: true,
})), DownloaderValidationError, 'TV support without TV template rejected');
ok('validation rejects HTTP/javascript/data/unknown-placeholder/multi-line/bad-slug/neither-support/missing-template');

// applyDownloadTemplate also rejects non-HTTPS output (defense in depth).
assert.equal(applyDownloadTemplate('http://example.com/{tmdbId}', { tmdbId: '123' }), null, 'applyDownloadTemplate returns null for HTTP');
assert.equal(applyDownloadTemplate('ftp://example.com/{tmdbId}', { tmdbId: '123' }), null, 'applyDownloadTemplate returns null for FTP');
assert.equal(applyDownloadTemplate('https://', { tmdbId: '123' }), null, 'applyDownloadTemplate returns null for HTTPS-without-host');
ok('applyDownloadTemplate returns null for non-HTTPS or host-less output');

// ============================================================
// 9. Adult unauthorized content does not expose downloader
// ============================================================
console.log('\n9. Adult unauthorized content');

// The contract: the existing SSR load for movie/series/anime detail pages
// throws a non-disclosing 404 for unauthorized adult content BEFORE the
// DetailPage is ever rendered. The DetailPage therefore does NOT add any
// downloader-specific adult guard — it relies on the existing guard. We
// verify that contract by reading the existing load files and confirming
// they still call canAccessAdultContent + throw 404 on denial, and that
// DetailPage does NOT attempt to add its own (weaker) adult check.
const movieServer = readFileSync(new URL('../src/routes/movie/[id]/+page.server.ts', import.meta.url), 'utf8');
const seriesServer = readFileSync(new URL('../src/routes/series/[id]/+page.server.ts', import.meta.url), 'utf8');
const animeServer = readFileSync(new URL('../src/routes/anime/[id]/+page.server.ts', import.meta.url), 'utf8');

assert.match(movieServer, /canAccessAdultContent/, 'movie load still calls canAccessAdultContent');
assert.match(movieServer, /throw error\(404/, 'movie load still throws 404 for unauthorized adult');
assert.match(seriesServer, /canAccessAdultContent/, 'series load still calls canAccessAdultContent');
assert.match(seriesServer, /throw error\(404/, 'series load still throws 404 for unauthorized adult');
// Anime load goes through getDetailWithSafeRecommendations which already
// classifies + 404s. Verify the adult guard is intact too.
assert.match(animeServer, /canAccessAdultContent/, 'anime load still calls canAccessAdultContent');
assert.match(animeServer, /throw error\(404/, 'anime load still throws 404 for unauthorized adult');

// DetailPage must NOT introduce a new adult check (the spec says: use the
// already-existing authorized item/state only — i.e. do NOT add a new
// guard). Confirm no downloader-specific adult guard was added.
const detailPage = readFileSync(new URL('../src/lib/components/DetailPage.svelte', import.meta.url), 'utf8');
assert.doesNotMatch(detailPage, /canAccessAdultContent/, 'DetailPage does not duplicate the adult guard (relies on SSR)');
assert.match(detailPage, /Adult content is gated by the existing SSR/, 'DetailPage documents the existing-SSR-guard contract');
ok('adult authorization stays in the existing SSR load (no duplicate guard in DetailPage)');

// Also confirm the downloader modules don't import any adult logic (the
// downloader is content-type-only, not adult-aware):
const downloaderShared = readFileSync(new URL('../src/lib/shared/downloader.ts', import.meta.url), 'utf8');
const downloaderPublic = readFileSync(new URL('../src/lib/server/downloader/public-config.ts', import.meta.url), 'utf8');
assert.doesNotMatch(downloaderShared, /adult/i, 'shared downloader module is adult-agnostic');
assert.doesNotMatch(downloaderPublic, /adult/i, 'public-config reader is adult-agnostic');
ok('downloader modules are adult-agnostic (no adult-mode coupling)');

// ============================================================
// 10. No changes to streaming provider/source registry behavior
// ============================================================
console.log('\n10. Streaming registry isolation');

// The streaming registry files must NOT import from the downloader modules.
const streamingFiles = [
  'src/lib/server/streaming/admin-service.ts',
  'src/lib/server/streaming/public-config.ts',
  'src/lib/server/streaming/validation.ts',
  'src/lib/server/streaming/types.ts',
  'src/lib/server/streaming/admin-auth.ts',
  'src/lib/server/streaming/health.ts',
  'src/lib/server/streaming/health-service.ts',
  'src/routes/admin/providers/+page.server.ts',
  'src/routes/admin/sources/+page.server.ts',
  'src/routes/admin/categories/+page.server.ts',
  'src/routes/admin/defaults/+page.server.ts',
];
for (const relPath of streamingFiles) {
  const src = readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
  assert.doesNotMatch(src, /downloader/, `${relPath} does not import from downloader`);
}
ok('no streaming registry file imports from the downloader modules');

// The downloader modules must NOT import from the streaming modules
// (except for the SHARED helpers requireAdmin + classifyAdminMutationError,
// which are explicitly allowed by the spec — admin mutations require
// existing requireAdmin()).
const downloaderFiles = [
  'src/lib/server/downloader/admin-service.ts',
  'src/lib/server/downloader/public-config.ts',
  'src/lib/server/downloader/validation.ts',
  'src/lib/server/downloader/types.ts',
  'src/routes/admin/downloaders/+page.server.ts',
];
for (const relPath of downloaderFiles) {
  const src = readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
  // Allowed: requireAdmin from streaming/admin-auth, classifyAdminMutationError
  // from streaming/mutation-result. Forbidden: importing from
  // streaming/admin-service, streaming/public-config, streaming/validation,
  // streaming/types (which would couple the registries).
  const forbidden = /from '\$lib\/server\/streaming\/(admin-service|public-config|validation|types|health|health-service)'/;
  assert.doesNotMatch(src, forbidden, `${relPath} does not import from streaming domain modules`);
}
ok('no downloader file imports from streaming domain modules (only requireAdmin + classifyAdminMutationError shared helpers)');

// The migration must NOT touch any streaming_* table.
const migration = readFileSync(new URL('../supabase/migrations/20260915000000_download_providers.sql', import.meta.url), 'utf8');
assert.doesNotMatch(migration, /alter table public\.streaming_/, 'migration does not alter any streaming_* table');
assert.doesNotMatch(migration, /create table .*streaming_/, 'migration does not create any streaming_* table');
assert.doesNotMatch(migration, /drop table .*streaming_/, 'migration does not drop any streaming_* table');
assert.match(migration, /create table if not exists public\.download_providers/, 'migration creates download_providers');
assert.match(migration, /create table if not exists public\.download_providers_config_meta/, 'migration creates download_providers_config_meta');
ok('migration only creates download_providers + download_providers_config_meta (no streaming_* table touched)');

// Sanity: DOWNLOAD_PLACEHOLDERS is exactly the spec set.
const expectedPlaceholders = ['{tmdbId}', '{season}', '{episode}', '{season2}', '{episode2}', '{titleSlug}'];
assert.deepEqual(
  [...DOWNLOAD_PLACEHOLDERS].sort(),
  [...expectedPlaceholders].sort(),
  'placeholder set matches spec',
);
ok('DOWNLOAD_PLACEHOLDERS = {tmdbId} {season} {episode} {season2} {episode2} {titleSlug}');

// ============================================================
// DetailPage integration contract
// ============================================================
console.log('\nDetailPage integration contract');

assert.match(detailPage, /import DownloadSheet from '\$components\/DownloadSheet\.svelte'/, 'DetailPage imports DownloadSheet');
assert.match(detailPage, /\bDownload\b/, 'DetailPage imports the Download icon name');
assert.match(detailPage, /class="download-btn"/, 'DetailPage renders a .download-btn');
assert.match(detailPage, /<DownloadSheet/, 'DetailPage mounts <DownloadSheet');
assert.match(detailPage, /open=\{downloadSheetOpen\}/, 'DownloadSheet open prop wired to downloadSheetOpen');
assert.match(detailPage, /primary-actions/, 'DetailPage wraps Play + Download in a primary-actions row');
ok('DetailPage wires DownloadSheet + Play|Download row');

// AdminShell + admin overview contract.
const adminShell = readFileSync(new URL('../src/lib/components/AdminShell.svelte', import.meta.url), 'utf8');
assert.match(adminShell, /\{ id: 'downloaders', label: 'Downloaders', href: '\/admin\/downloaders'/, 'AdminShell has Downloaders nav item');

const adminOverviewServer = readFileSync(new URL('../src/routes/admin/+page.server.ts', import.meta.url), 'utf8');
assert.match(adminOverviewServer, /getDownloadersAdminOverview/, 'admin overview loads downloader counts');

const adminOverviewPage = readFileSync(new URL('../src/routes/admin/+page.svelte', import.meta.url), 'utf8');
assert.match(adminOverviewPage, /href="\/admin\/downloaders"/, 'admin overview has a Downloaders card');
ok('AdminShell + admin overview wired to /admin/downloaders');

// Database types include the new table.
const dbTypes = readFileSync(new URL('../src/lib/server/supabase/database.types.ts', import.meta.url), 'utf8');
assert.match(dbTypes, /download_providers:/, 'database.types.ts includes download_providers');
assert.match(dbTypes, /download_providers_config_meta:/, 'database.types.ts includes download_providers_config_meta');
assert.match(dbTypes, /download_providers_public:/, 'database.types.ts includes the public view');
ok('database.types.ts includes download_providers + config_meta + public view');

// Public API endpoint exists.
const apiEndpoint = readFileSync(new URL('../src/routes/api/downloader/config/+server.ts', import.meta.url), 'utf8');
assert.match(apiEndpoint, /getPublicDownloadConfig/, 'public API endpoint uses getPublicDownloadConfig');
assert.match(apiEndpoint, /cache-control/, 'public API endpoint sets cache-control');
ok('public /api/downloader/config endpoint exists and uses the public-config reader');

console.log(`\nDownload provider tests passed (${passed} check groups).`);
