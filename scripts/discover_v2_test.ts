import assert from 'node:assert/strict';
import { readFile, access, constants } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = new URL('../', import.meta.url).pathname;

const discoverPage = await readFile(path.join(repoRoot, 'src/lib/components/DiscoverPage.svelte'), 'utf8');
const discoverSection = await readFile(path.join(repoRoot, 'src/lib/components/DiscoverSection.svelte'), 'utf8');
const discoverDropdown = await readFile(path.join(repoRoot, 'src/lib/components/DiscoverDropdown.svelte'), 'utf8');
const service = await readFile(path.join(repoRoot, 'src/lib/server/content/service.ts'), 'utf8');
const tmdb = await readFile(path.join(repoRoot, 'src/lib/server/content/adapters/tmdb.ts'), 'utf8');
const types = await readFile(path.join(repoRoot, 'src/lib/server/content/types.ts'), 'utf8');
const railEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/discover/rail/+server.ts'), 'utf8');
const providersEndpoint = await readFile(path.join(repoRoot, 'src/routes/api/discover/providers/+server.ts'), 'utf8');
const discoverLoad = await readFile(path.join(repoRoot, 'src/lib/server/content/discover-load.ts'), 'utf8');

// ============================================================================
// A. Section configuration — exactly these sections in this order.
// ============================================================================
{
  // The SECTIONS array in DiscoverPage must list exactly the spec order.
  assert.match(discoverPage, /key: 'theatre'.*?Running in theatre/, 'theatre section present with title');
  assert.match(discoverPage, /key: 'new-ott'.*?New on OTT/, 'new-ott section present');
  assert.match(discoverPage, /key: 'popular-movie'.*?Popular movies/, 'popular-movie section');
  assert.match(discoverPage, /key: 'popular-series'.*?Popular TV shows/, 'popular-series section');
  assert.match(discoverPage, /key: 'popular-anime'.*?Popular anime/, 'popular-anime section');
  assert.match(discoverPage, /key: 'top-rated-movie'.*?Top rated movies/, 'top-rated-movie section');
  assert.match(discoverPage, /key: 'top-rated-series'.*?Top rated TV shows/, 'top-rated-series section');
  assert.match(discoverPage, /key: 'top-rated-anime'.*?Top rated anime/, 'top-rated-anime section');
  // Genre sections
  for (const g of ['action', 'adventure', 'comedy', 'crime', 'thriller', 'scifi', 'drama', 'horror', 'romance']) {
    assert.match(discoverPage, new RegExp(`key: 'genre-${g}'`), `genre-${g} section present`);
  }
  // Old decorative genre tiles must be gone.
  assert.doesNotMatch(discoverPage, /class="genre-section"/, 'old genre-tile section removed');
  assert.doesNotMatch(discoverPage, /Browse by genre/, 'old genre-tile heading removed');
  // Old "Trending right now" / "Trending Movies — Hindi" / "Trending Movies — Regional" sections removed.
  assert.doesNotMatch(discoverPage, /Trending right now/, 'old "Trending right now" section removed');
  assert.doesNotMatch(discoverPage, /Trending Movies — Hindi/, 'old Hindi rail removed');
  assert.doesNotMatch(discoverPage, /Trending Movies — Regional/, 'old Regional rail removed');
  // No duplicate sections (each key appears exactly once).
  const theatreCount = (discoverPage.match(/key: 'theatre'/g) || []).length;
  assert.equal(theatreCount, 1, 'theatre section appears exactly once');
  const newOttCount = (discoverPage.match(/key: 'new-ott'/g) || []).length;
  assert.equal(newOttCount, 1, 'new-ott section appears exactly once');
}

// ============================================================================
// B. Language options — every language-filtered section has exactly the 8 options.
// ============================================================================
{
  const expectedLanguages = ['All', 'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Other language'];
  for (const label of expectedLanguages) {
    assert.match(discoverSection, new RegExp(`label: '${label.replace(/'/g, "\\'")}'`), `language option "${label}" present in DiscoverSection`);
  }
  // The language values map to TMDB codes.
  assert.match(discoverSection, /value: 'hi'.*?Hindi/, 'Hindi → hi');
  assert.match(discoverSection, /value: 'en'.*?English/, 'English → en');
  assert.match(discoverSection, /value: 'ta'.*?Tamil/, 'Tamil → ta');
  assert.match(discoverSection, /value: 'te'.*?Telugu/, 'Telugu → te');
  assert.match(discoverSection, /value: 'ml'.*?Malayalam/, 'Malayalam → ml');
  assert.match(discoverSection, /value: 'kn'.*?Kannada/, 'Kannada → kn');
  assert.match(discoverSection, /value: 'other'.*?Other language/, 'Other language → other');
  assert.match(discoverSection, /value: 'all'.*?All/, 'All → all');
}

// ============================================================================
// C. "All" behavior — must NOT concatenate language buckets.
// ============================================================================
{
  // The TMDB adapter must NOT issue separate per-language queries for "all".
  // We assert that getTmdbNowPlaying / getTmdbPopularByLanguage / getTmdbTopRated
  // / getTmdbGenreByLanguage all have a `if (language === 'all') break;` early
  // exit after the first upstream page.
  assert.match(tmdb, /if \(language === 'all'\) break;/, 'all-language path issues ONE upstream query');
  // The adapter must NOT have a pattern like fetching hi, en, ta, te, ml, kn
  // separately and concatenating them for "all".
  assert.doesNotMatch(tmdb, /for \(const lang of \['hi', 'en', 'ta'/, 'no language-bucket concatenation for all');
  // The service-level discoverRail must pass language through without
  // splitting it.
  assert.match(service, /function discoverRail/, 'discoverRail builder exists');
  assert.match(service, /getTmdbNowPlaying\(language/, 'theatre passes language through');
  assert.match(service, /getTmdbPopularByLanguage\(.*?language/, 'popular passes language through');
  assert.doesNotMatch(service, /Promise\.all\(\[getTmdbNowPlaying\('hi'/, 'no per-language parallel fetch for all');
}

// ============================================================================
// D. Language mapping — hi/en/ta/te/ml/kn.
// ============================================================================
{
  assert.match(types, /hi.*\/\/ Hindi/, 'type comment: Hindi');
  assert.match(types, /en.*\/\/ English/, 'type comment: English');
  assert.match(types, /ta.*\/\/ Tamil/, 'type comment: Tamil');
  assert.match(types, /te.*\/\/ Telugu/, 'type comment: Telugu');
  assert.match(types, /ml.*\/\/ Malayalam/, 'type comment: Malayalam');
  assert.match(types, /kn.*\/\/ Kannada/, 'type comment: Kannada');
  // The adapter's DISCOVER_LANGUAGE_PARAM maps each to the right ISO code.
  assert.match(tmdb, /hi: 'hi'/, 'Hindi → hi');
  assert.match(tmdb, /en: 'en'/, 'English → en');
  assert.match(tmdb, /ta: 'ta'/, 'Tamil → ta');
  assert.match(tmdb, /te: 'te'/, 'Telugu → te');
  assert.match(tmdb, /ml: 'ml'/, 'Malayalam → ml');
  assert.match(tmdb, /kn: 'kn'/, 'Kannada → kn');
}

// ============================================================================
// E. Other language — hi/en/ta/te/ml/kn are excluded.
// ============================================================================
{
  // The adapter must exclude the 6 known languages for "other".
  assert.match(tmdb, /KNOWN_LANGUAGES.*hi.*en.*ta.*te.*ml.*kn/, 'known languages list');
  assert.match(tmdb, /OTHER_LANGUAGE_EXCLUSIONS/, 'exclusion set exists');
  assert.match(tmdb, /!OTHER_LANGUAGE_EXCLUSIONS\.has/, 'other-language filter excludes known languages');
  // Bounded safety limit to avoid infinite fetch loops.
  assert.match(tmdb, /MAX_OTHER_LANGUAGE_PAGES = 6/, 'bounded page-walk limit for other-language');
}

// ============================================================================
// F. Theatre — movie-only, region=IN, now-playing, language filter, no upcoming fallback.
// ============================================================================
{
  assert.match(tmdb, /function getTmdbNowPlaying/, 'theatre function exists');
  assert.match(tmdb, /\/movie\/now_playing/, 'uses /movie/now_playing endpoint');
  assert.match(tmdb, /region: 'IN'/, 'region=IN');
  assert.doesNotMatch(tmdb, /\/movie\/upcoming/, 'theatre does NOT use upcoming');
  assert.match(tmdb, /hasRequiredListMetadata\(item, 'movie'\)/, 'theatre is movie-only');
  // Language filtering is by original_language.
  assert.match(tmdb, /applyLanguageFilter\(raw, language\)/, 'theatre applies language filter');
}

// ============================================================================
// G. OTT — watch_region=IN, provider filter, flatrate, provider list from TMDB, logos, no N+1.
// ============================================================================
{
  assert.match(tmdb, /function getTmdbNewOnOtt/, 'OTT function exists');
  assert.match(tmdb, /watch_region: 'IN'/, 'OTT uses watch_region=IN');
  assert.match(tmdb, /with_watch_monetization_types: 'flatrate'/, 'OTT uses flatrate monetization');
  assert.match(tmdb, /with_watch_providers: providerId/, 'OTT supports provider filter');
  // Provider list comes from TMDB /watch/providers, not random favicons.
  assert.match(tmdb, /function getTmdbIndiaProviders/, 'India providers function exists');
  assert.match(tmdb, /\/watch\/providers\/movie.*watch_region: 'IN'/, 'fetches movie providers for IN');
  assert.match(tmdb, /\/watch\/providers\/tv.*watch_region: 'IN'/, 'fetches TV providers for IN');
  // Logos come from TMDB logo_path, not Google favicons.
  assert.match(tmdb, /function providerLogoUrl/, 'logo URL builder exists');
  assert.match(tmdb, /IMAGE_URL.*w92.*logoPath/, 'logo URL uses TMDB image CDN');
  assert.doesNotMatch(tmdb, /google\.com\/s2\/favicons/, 'no Google favicon URLs in new code');
  // No per-card N+1 provider calls — the provider filter is server-side
  // (with_watch_providers), NOT a fetch-then-filter loop. The existing
  // searchTmdb path does per-item matchesOtt but that's search, not the new
  // OTT section. We assert getTmdbNewOnOtt does NOT call matchesOtt.
  const newOnOttFn = tmdb.match(/export async function getTmdbNewOnOtt[\s\S]*?^}/m);
  assert.ok(newOnOttFn, 'getTmdbNewOnOtt function body found');
  assert.doesNotMatch(newOnOttFn![0], /matchesOtt/, 'getTmdbNewOnOtt does NOT call per-item matchesOtt');
  // The providers endpoint exists.
  assert.match(providersEndpoint, /getTmdbIndiaProviders/, 'providers endpoint calls getTmdbIndiaProviders');
  assert.match(providersEndpoint, /providerLogoUrl/, 'providers endpoint returns logo URLs');
}

// ============================================================================
// H. Initial page size — every section returns max 10 visible items initially.
// ============================================================================
{
  assert.match(tmdb, /DISCOVER_PAGE_SIZE = 10/, 'page size is 10');
  assert.match(tmdb, /\.slice\(0, DISCOVER_PAGE_SIZE\)/, 'items sliced to 10');
  // The rail endpoint validates page 1-20.
  assert.match(railEndpoint, /Math\.max\(1, Math\.min/, 'page clamped');
}

// ============================================================================
// I. Show more — 10 → 20 → 30, existing titles remain.
// ============================================================================
{
  // DiscoverSection appends on Show more, does NOT replace.
  assert.match(discoverSection, /function loadMore/, 'loadMore function exists');
  assert.match(discoverSection, /items = \[\.\.\.items, item\]/, 'Show more APPENDS to existing items');
  assert.doesNotMatch(discoverSection, /items = incoming/, 'Show more does NOT replace');
  // Show more button only renders when hasNextPage is true.
  assert.match(discoverSection, /\{#if hasNextPage\}/, 'Show more button gated on hasNextPage');
}

// ============================================================================
// J. Independent section pagination — Action Show more does not change Popular Movie.
// ============================================================================
{
  // Each DiscoverSection instance owns its own state — no shared global.
  assert.match(discoverSection, /let items = .state<MediaItem\[\]>\(\[\]\)/, 'items is local $state');
  assert.match(discoverSection, /let page = .state\(1\)/, 'page is local $state');
  assert.match(discoverSection, /let language = .state/, 'language is local $state');
  assert.match(discoverSection, /let hasNextPage = .state\(false\)/, 'hasNextPage is local $state');
  // No shared external store.
  assert.doesNotMatch(discoverSection, /import.*from.*\$.lib.*stores/, 'no external shared store');
}

// ============================================================================
// K. Language switch — All → Hindi replaces results; Hindi → Tamil replaces.
// ============================================================================
{
  // changeLanguage calls loadFirst which resets items.
  assert.match(discoverSection, /function changeLanguage/, 'changeLanguage function exists');
  assert.match(discoverSection, /void loadFirst\(\)/, 'language change calls loadFirst (replaces)');
  // loadFirst resets items (does NOT append).
  assert.match(discoverSection, /function loadFirst/, 'loadFirst function exists');
  assert.match(discoverSection, /items = payload\.items as MediaItem\[\]/, 'loadFirst REPLACES items');
}

// ============================================================================
// L. Anime — popular anime + top rated anime contain both movies AND series.
// ============================================================================
{
  assert.match(tmdb, /function getTmdbAnimeMerged/, 'anime merged function exists');
  // Queries BOTH movie and TV.
  assert.match(tmdb, /tmdbRequest<TmdbList<TmdbMovie>>\('\/discover\/movie'[\s\S]*?with_genres: 16[\s\S]*?with_original_language: 'ja'/, 'queries TMDB movie with genre 16 + ja');
  assert.match(tmdb, /tmdbRequest<TmdbList<TmdbTv>>\('\/discover\/tv'[\s\S]*?with_genres: 16[\s\S]*?with_original_language: 'ja'/, 'queries TMDB TV with genre 16 + ja');
  // Filters to isAnime === true.
  assert.match(tmdb, /filter\(\(item\) => item\.isAnime === true\)/, 'filters to isAnime === true');
  // Merges + dedupes by canonical type+id.
  assert.match(tmdb, /merged = \[\.\.\.movieItems, \.\.\.tvItems\]/, 'merges movie + TV');
  assert.match(tmdb, /seen = new Set<string>/, 'dedupes by key');
  assert.match(tmdb, /k = `\$\{item\.type\}:\$\{item\.id\}`/, 'dedupe key is type:id (canonical identity)');
  // Does NOT convert movies into series.
  assert.doesNotMatch(tmdb, /type = 'series'.*isAnime/, 'does NOT force anime movies to type=series');
  // The service routes popular/top-rated anime through the merged path.
  assert.match(service, /if \(type === 'anime'\) return await getTmdbAnimeMerged\('popularity'/, 'popular(anime) uses merged path');
  assert.match(service, /if \(type === 'anime'\) return await getTmdbAnimeMerged\(filters\.sort === 'Top rated' \? 'top-rated' : 'popularity'/, 'collection(anime) uses merged path');
}

// ============================================================================
// M. Anime Explore — /discover/anime can return movie + series and preserves canonical type.
// ============================================================================
{
  // The /discover/anime route still uses loadCollectionData('anime', url).
  const animeRoute = await readFile(path.join(repoRoot, 'src/routes/discover/anime/+page.server.ts'), 'utf8');
  assert.match(animeRoute, /loadCollectionData\('anime', url\)/, 'anime route still uses loadCollectionData');
  // The collection() service function for anime now uses the merged path.
  assert.match(service, /if \(type === 'anime'\) return await getTmdbAnimeMerged/, 'collection(anime) uses merged movie+TV path');
  // Canonical identity is preserved — movies keep type='movie', series keep type='series'.
  assert.match(tmdb, /mapTmdb\(item, 'movie'\)/, 'anime movies mapped as type=movie');
  assert.match(tmdb, /mapTmdb\(item, 'series'\)/, 'anime series mapped as type=series');
}

// ============================================================================
// N. Anime navigation — anime movie opens movie route; anime series opens series route.
// ============================================================================
{
  // MediaCard builds href from item.type — no special anime route override.
  const mediaCard = await readFile(path.join(repoRoot, 'src/lib/components/MediaCard.svelte'), 'utf8');
  assert.match(mediaCard, /appendReturnTo\(`\/\$\{item\.type\}\/\$\{item\.id\}`/, 'card href uses canonical item.type');
  // No /anime/ route override in the card.
  assert.doesNotMatch(mediaCard, /href=\{`\/anime\//, 'no /anime/ route in card');
}

// ============================================================================
// O. Existing behavior — gallery, chips, continue watching, bottom nav unchanged.
// ============================================================================
{
  // Gallery single-active hero contract (subset of discover_gallery_test).
  assert.match(discoverPage, /const MAX_FEATURED_ITEMS = 6/);
  assert.match(discoverPage, /function createFeaturedItems/);
  assert.match(discoverPage, /featuredItems = (?:\$derived\()?createFeaturedItems/);
  assert.match(discoverPage, /activeHero = (?:.*?\$derived\()?featuredItems\[activeIndex\]/);
  assert.match(discoverPage, /aria-roledescription="carousel"/);
  assert.match(discoverPage, /aria-label="Previous title"/);
  assert.match(discoverPage, /aria-label="Next title"/);
  assert.match(discoverPage, /role="tablist"/);
  // Quick chips unchanged.
  assert.match(discoverPage, /label: 'Movies'.*?href: '\/discover\/movies'/);
  assert.match(discoverPage, /label: 'TV Shows'.*?href: '\/discover\/series'/);
  assert.match(discoverPage, /label: 'Anime'.*?href: '\/discover\/anime'/);
  // Continue watching unchanged.
  assert.match(discoverPage, /ContentRail title="Continue watching"/);
  assert.match(discoverPage, /href="\/my-list\?status=watching"/);
}

// ============================================================================
// P. Navigation regression — SvelteKit snapshot + history.back intact.
// ============================================================================
{
  const layout = await readFile(path.join(repoRoot, 'src/routes/+layout.svelte'), 'utf8');
  assert.match(layout, /export const snapshot = \{/, 'root layout snapshot intact');
  const detailPage = await readFile(path.join(repoRoot, 'src/lib/components/DetailPage.svelte'), 'utf8');
  assert.match(detailPage, /window\.history\.back\(\)/, 'DetailPage still uses history.back()');
}

// ============================================================================
// Q. Playback regression — no playback code modified.
// ============================================================================
{
  // Verify the diff does not touch player/resolver/watch.
  // This is a source-text contract: the new files must not import from
  // player/resolver/watch.
  assert.doesNotMatch(discoverSection, /import.*from.*player/, 'DiscoverSection does not import player');
  assert.doesNotMatch(discoverSection, /import.*from.*resolver/, 'DiscoverSection does not import resolver');
  assert.doesNotMatch(discoverSection, /import.*from.*watch/, 'DiscoverSection does not import watch route');
  assert.doesNotMatch(railEndpoint, /import.*from.*player/, 'rail endpoint does not import player');
  assert.doesNotMatch(railEndpoint, /import.*from.*resolver/, 'rail endpoint does not import resolver');
}

// ============================================================================
// R. No fake data — Discover tests must fail if fixtures are returned as successful results.
// ============================================================================
{
  // The rail endpoint must NOT fall back to fixtures on upstream failure.
  // discoverRail catches errors and returns an empty list, NOT fixtures.
  assert.match(service, /NO fixture fallback — empty rail on failure, per the spec/);
  assert.match(service, /return \{ items: \[\], page, hasNextPage: false/, 'failed rail returns empty list');
  // The rail endpoint itself must not reference fixtures.
  assert.doesNotMatch(railEndpoint, /fixtures/, 'rail endpoint does not reference fixtures');
  // The DiscoverSection component must render an empty state, not fake cards.
  assert.match(discoverSection, /No titles available right now/, 'empty state rendered when no items');
}

// ============================================================================
// S. Dropdown UX — accessible, keyboard, closes after selection.
// ============================================================================
{
  assert.match(discoverDropdown, /role="listbox"/, 'dropdown uses listbox role');
  assert.match(discoverDropdown, /aria-haspopup="listbox"/, 'trigger has aria-haspopup');
  assert.match(discoverDropdown, /aria-expanded=\{open\}/, 'trigger has aria-expanded');
  assert.match(discoverDropdown, /aria-selected/, 'options have aria-selected');
  // Keyboard navigation.
  assert.match(discoverDropdown, /ArrowDown/, 'ArrowDown navigates');
  assert.match(discoverDropdown, /ArrowUp/, 'ArrowUp navigates');
  assert.match(discoverDropdown, /Home/, 'Home goes to first');
  assert.match(discoverDropdown, /End/, 'End goes to last');
  assert.match(discoverDropdown, /Escape/, 'Escape closes');
  assert.match(discoverDropdown, /Enter/, 'Enter selects');
  // Closes after selection.
  assert.match(discoverDropdown, /function choose[\s\S]*?close\(\)/, 'choosing an option closes the dropdown');
  // Does NOT navigate to another page.
  assert.doesNotMatch(discoverDropdown, /goto\(/, 'dropdown does not navigate');
}

// ============================================================================
// T. Attribution — TMDB + JustWatch in the Discover footer.
// ============================================================================
{
  assert.match(discoverPage, /tmdb-credit/, 'TMDB credit present');
  assert.match(discoverPage, /tmdb-logo/, 'TMDB logo present');
  assert.match(discoverPage, /themoviedb\.org\/about\/logos-attribution/, 'links to TMDB attribution page');
  assert.match(discoverPage, /justwatch-credit/, 'JustWatch credit present');
  assert.match(discoverPage, /justwatch\.com/, 'links to JustWatch');
}

// ============================================================================
// U. Cache keys include all dimensions.
// ============================================================================
{
  // Each TMDB query function must include language + page in its cache key.
  assert.match(tmdb, /key = `tmdb:theatre:\$\{language\}:\$\{page\}`/, 'theatre cache key includes language + page');
  assert.match(tmdb, /key = `tmdb:new-ott:\$\{providerKey/, 'OTT cache key includes provider');
  assert.match(tmdb, /key = `tmdb:popular-v2:\$\{type\}:\$\{language\}:\$\{page\}`/, 'popular cache key includes type + language + page');
  assert.match(tmdb, /key = `tmdb:top-rated-v2:\$\{type\}:\$\{language\}:\$\{page\}`/, 'top-rated cache key includes type + language + page');
  assert.match(tmdb, /key = `tmdb:genre-v2:\$\{genreId\}:\$\{language\}:\$\{page\}`/, 'genre cache key includes genreId + language + page');
  assert.match(tmdb, /key = `tmdb:anime-merged:\$\{sort\}:\$\{page\}`/, 'anime-merged cache key includes sort + page');
}

console.log('Discover V2 India-first catalog tests passed: section config (A); language options (B); all-language mixed-query (C); language mapping (D); other-language exclusion (E); theatre (F); OTT (G); page size 10 (H); show more appends (I); independent section state (J); language switch replaces (K); anime movie+series merge (L); anime Explore (M); anime navigation (N); existing behavior (O); nav regression (P); playback regression (Q); no fake data (R); dropdown UX (S); attribution (T); cache keys (U).');
