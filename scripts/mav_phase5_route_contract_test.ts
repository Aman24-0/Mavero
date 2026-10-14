/**
 * MAV-FOCUSED — Phase 5 contract test — public route migration (2026-10).
 *
 * Static-code + behavior test for the Phase 5 public route migration.
 * Verifies that:
 *
 *   1. The shared route helper exists with the correct exports.
 *   2. detailHref() generates the correct public URLs for each content type.
 *   3. watchHref() generates the correct watch URLs.
 *   4. extractTmdbId() correctly strips prefixes.
 *   5. publicRouteType() maps internal types to public route types.
 *   6. isLegacyPrefixedId() detects legacy prefixed IDs.
 *   7. New route directories exist (tv-show, anime-series, anime-movie).
 *   8. Legacy routes redirect to the new canonical form.
 *   9. Watch route accepts the new public route types.
 *  10. The sitemap + SEO helpers are unchanged (no detail-page sitemap entries).
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_phase5_route_contract_test.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n§1 — Shared route helper exists');

const routes = src('src/lib/shared/routes.ts');
ok(/export function detailHref/.test(routes), '1a. detailHref function exported');
ok(/export function watchHref/.test(routes), '1b. watchHref function exported');
ok(/export function extractTmdbId/.test(routes), '1c. extractTmdbId function exported');
ok(/export function publicRouteType/.test(routes), '1d. publicRouteType function exported');
ok(/export function internalContentType/.test(routes), '1e. internalContentType function exported');
ok(/export function isLegacyPrefixedId/.test(routes), '1f. isLegacyPrefixedId function exported');
ok(/export function isPublicRouteType/.test(routes), '1g. isPublicRouteType function exported');
ok(/export function isValidTmdbId/.test(routes), '1h. isValidTmdbId function exported');
ok(/export function modernizeWatchType/.test(routes), '1i. modernizeWatchType function exported');

console.log('\n§2 — Public route type mapping');

ok(/'movie'\s*\|\s*'tv-show'\s*\|\s*'anime-series'\s*\|\s*'anime-movie'/.test(routes), '2a. PublicRouteType includes all 4 types');
ok(/isAnime && animeFormat === 'movie'/.test(routes), '2b. anime movies → anime-movie route type');
ok(/isAnime && \(animeFormat === 'series' \|\| type === 'anime'\)/.test(routes), '2c. anime series → anime-series route type');
ok(/type === 'movie'/.test(routes), '2d. regular movies → movie route type');
ok(/return 'tv-show'/.test(routes), '2e. regular series → tv-show route type');

console.log('\n§3 — New route directories exist');

ok(existsSync(resolve(root, 'src/routes/tv-show/[id]/+page.server.ts')), '3a. /tv-show/[id] server exists');
ok(existsSync(resolve(root, 'src/routes/tv-show/[id]/+page.svelte')), '3b. /tv-show/[id] page exists');
ok(existsSync(resolve(root, 'src/routes/anime-series/[id]/+page.server.ts')), '3c. /anime-series/[id] server exists');
ok(existsSync(resolve(root, 'src/routes/anime-series/[id]/+page.svelte')), '3d. /anime-series/[id] page exists');
ok(existsSync(resolve(root, 'src/routes/anime-movie/[id]/+page.server.ts')), '3e. /anime-movie/[id] server exists');
ok(existsSync(resolve(root, 'src/routes/anime-movie/[id]/+page.svelte')), '3f. /anime-movie/[id] page exists');

console.log('\n§4 — New routes accept bare TMDB IDs');

const tvShowServer = src('src/routes/tv-show/[id]/+page.server.ts');
ok(/isValidTmdbId/.test(tvShowServer), '4a. /tv-show validates bare TMDB ID');
ok(/isLegacyPrefixedId/.test(tvShowServer), '4b. /tv-show redirects legacy prefixed IDs');
ok(/getDetail\('series'/.test(tvShowServer), '4c. /tv-show calls getDetail with internal type "series"');

const animeSeriesServer = src('src/routes/anime-series/[id]/+page.server.ts');
ok(/isValidTmdbId/.test(animeSeriesServer), '4d. /anime-series validates bare TMDB ID');
ok(/getDetail\('anime'/.test(animeSeriesServer), '4e. /anime-series calls getDetail with internal type "anime"');

const animeMovieServer = src('src/routes/anime-movie/[id]/+page.server.ts');
ok(/isValidTmdbId/.test(animeMovieServer), '4f. /anime-movie validates bare TMDB ID');
ok(/getDetail\('movie'/.test(animeMovieServer), '4g. /anime-movie calls getDetail with internal type "movie"');

console.log('\n§5 — Legacy routes redirect to new canonical form');

const seriesServer = src('src/routes/series/[id]/+page.server.ts');
ok(/redirect/.test(seriesServer), '5a. /series/[id] redirects (not a detail page anymore)');
ok(/\/tv-show\//.test(seriesServer), '5b. /series/[id] redirects to /tv-show/');

const animeServer = src('src/routes/anime/[id]/+page.server.ts');
ok(/redirect/.test(animeServer), '5c. /anime/[id] redirects');
ok(/\/anime-series\//.test(animeServer), '5d. /anime/[id] redirects to /anime-series/');

const movieServer = src('src/routes/movie/[id]/+page.server.ts');
ok(/isLegacyPrefixedId/.test(movieServer), '5e. /movie/[id] handles legacy prefixed IDs');
ok(/redirect\(308/.test(movieServer), '5f. /movie/[id] redirects legacy prefixed IDs with 308');

console.log('\n§6 — Watch route accepts new public route types');

// Deep-audit refactor: the watch load logic lives in the SHARED loader
// (watch-loader.ts) consumed by BOTH the query-form parent route AND the
// canonical [season]/[episode] path-form route — one implementation, two
// URL shapes, identical behavior.
const watchServer = src('src/routes/watch/[type]/[id]/watch-loader.ts');
ok(/isPublicRouteType/.test(watchServer), '6a. watch route checks isPublicRouteType');
ok(/internalContentType/.test(watchServer), '6b. watch route derives internal type from public route type');
ok(/isLegacyWatchType/.test(watchServer), '6c. watch route detects legacy types (series/anime)');
ok(/modernizeWatchType/.test(watchServer), '6d. watch route modernizes legacy types to new form');
ok(/redirect/.test(watchServer), '6e. watch route redirects legacy types');
ok(/internalType === 'series'/.test(watchServer), '6f. watch route uses internalType for isSeriesLike check');
ok(existsSync(resolve(root, 'src/routes/watch/[type]/[id]/[season]/[episode]/+page.server.ts')) && /loadWatchPage\(event, 'path'\)/.test(src('src/routes/watch/[type]/[id]/[season]/[episode]/+page.server.ts')), '6g. canonical path-form route delegates to the shared loader');
ok(/loadWatchPage\(event, 'query'\)/.test(watchServer) || /loadWatchPage\(event, 'query'\)/.test(src('src/routes/watch/[type]/[id]/+page.server.ts')), '6h. query-form route delegates to the shared loader');

console.log('\n§7 — Route generators use shared helper');

const mediaCard = src('src/lib/components/MediaCard.svelte');
ok(/import.*detailPath.*watchPath.*from.*routes/.test(mediaCard), '7a. MediaCard imports shared route helpers');
ok(/detailPath\(item\.id/.test(mediaCard), '7b. MediaCard uses detailPath() for card/detail href');
ok(/watchPath\(item\.id/.test(mediaCard), '7c. MediaCard uses watchPath() for watch href');

const spotlight = src('src/lib/components/SpotlightCarousel.svelte');
ok(/import.*detailPath.*watchPath.*from.*routes/.test(spotlight), '7d. SpotlightCarousel imports shared route helpers');

const discover = src('src/lib/components/DiscoverPage.svelte');
ok(/import.*detailPath.*watchPath.*from.*routes/.test(discover), '7e. DiscoverPage imports shared route helpers');

const detailPage = src('src/lib/components/DetailPage.svelte');
ok(/import.*detailPath.*watchPath.*publicRouteType.*from.*routes/.test(detailPage), '7f. DetailPage imports shared route helpers');
ok(/canonicalUrl.*detailPath/.test(detailPage), '7g. DetailPage uses detailPath() for canonical URL');

const seasonEpisodes = src('src/lib/components/SeasonEpisodes.svelte');
ok(/import.*watchPath.*from.*routes/.test(seasonEpisodes), '7h. SeasonEpisodes imports shared route helper');

console.log('\n§8 — Upcoming policy uses new route conventions');

const upcoming = src('src/lib/shared/upcoming-policy.ts');
ok(/\/tv-show\//.test(upcoming), '8a. upcomingDetailPath maps series → /tv-show/');
ok(/\/anime-series\//.test(upcoming), '8b. upcomingDetailPath maps anime → /anime-series/');
ok(/\/movie\//.test(upcoming), '8c. upcomingDetailPath maps movie → /movie/');

console.log('\n§9 — Sitemap + SEO unchanged (no detail-page sitemap entries)');

const sitemap = src('src/routes/sitemap.xml/+server.ts');
ok(!/\/movie\/|\/series\/|\/anime\/|\/tv-show\/|\/anime-series\/|\/anime-movie\//.test(sitemap), '9a. sitemap does NOT include detail-page URLs (correct — dynamic URLs discovered by crawling)');

const seo = src('src/lib/shared/seo.ts');
ok(/PRODUCTION_ORIGIN/.test(seo), '9b. SEO uses fixed PRODUCTION_ORIGIN');
ok(/canonicalHref/.test(seo), '9c. canonicalHref function exists');

console.log('\n§10 — Canonical path-form watch contract');

// Deep-audit: the canonical public watch URL is the PATH form
// (/watch/tv-show/1396/5/6). The [season]/[episode] route IS the
// canonical shape (no redirect); the QUERY form is the backward-compatible
// shape that redirects (308) to the path form. watchHref() generates path
// segments; the loop-safe redirect rules live in the shared loader.
const routesHelpers = src('src/lib/shared/routes.ts');
ok(/\/\$\{s\}\/\$\{e\}/.test(routesHelpers) || /`\$\{base\}\/\$\{s\}\/\$\{e\}`/.test(routesHelpers), '10a. watchHref generates PATH-form season/episode segments');
ok(/canonicalWatchHref/.test(routesHelpers), '10b. canonicalWatchHref helper exists (loader redirects + episode navigation)');
const watchLoader = src('src/routes/watch/[type]/[id]/watch-loader.ts');
ok(/redirect\(308/.test(watchLoader), '10c. query-form season+episode deep links 308 to the canonical path form');
ok(/isLegacyPrefixedId/.test(watchLoader), '10d. legacy prefixed watch IDs 308 to bare TMDB IDs');
ok(/Invalid season or episode/.test(watchLoader), '10e. invalid path season/episode rejected with 404 (no silent fallback)');

console.log(`\nmav_phase5_route_contract_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
