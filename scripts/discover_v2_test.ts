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
const appFooter = await readFile(path.join(repoRoot, 'src/lib/components/AppFooter.svelte'), 'utf8');

// ============================================================================
// A. Section configuration — exactly these CHIP FAMILIES in this order
//    (MAV-20 Phase B: Popular/Top Rated/New on OTT/genre rails are ONE
//    family each with Movie / TV Shows / Anime chips; the separate
//    popular-*/top-rated-* sections were consolidated).
// ============================================================================
{
  // The FAMILIES array in DiscoverPage must list exactly the spec order.
  assert.match(discoverPage, /key: 'theatre',\s*\n\s*title: 'Running in theatre 🎥',\s*\n\s*typeChips: false/, 'theatre family present, no chips');
  assert.match(discoverPage, /key: 'new-ott',\s*\n\s*title: 'New on OTT',\s*\n\s*typeChips: true,\s*\n\s*languageFilter: false,\s*\n\s*providerFilter: true/, 'new-ott family: chips + provider filter, no language dropdown');
  assert.match(discoverPage, /key: 'popular',\s*\n\s*title: 'Popular',\s*\n\s*typeChips: true/, 'popular family (consolidated) present with chips');
  assert.match(discoverPage, /key: 'top-rated',\s*\n\s*title: 'Top Rated',\s*\n\s*typeChips: true/, 'top-rated family (consolidated) present with chips');
  // The popular family selects the EXISTING per-type datasets (the same
  // section keys the three separate rails used before consolidation).
  assert.match(discoverPage, /movie: \{ section: 'popular-movie' \},\s*\n\s*series: \{ section: 'popular-series' \},\s*\n\s*anime: \{ section: 'popular-anime' \}/, 'popular chips map to the existing popular-{movie,series,anime} datasets');
  assert.match(discoverPage, /movie: \{ section: 'top-rated-movie' \},\s*\n\s*series: \{ section: 'top-rated-series' \},\s*\n\s*anime: \{ section: 'top-rated-anime' \}/, 'top-rated chips map to the existing top-rated-{movie,series,anime} datasets');
  // The new-ott family scopes the SAME OTT query per content type.
  assert.match(discoverPage, /movie: \{ section: 'new-ott', type: 'movie' \},\s*\n\s*series: \{ section: 'new-ott', type: 'series' \},\s*\n\s*anime: \{ section: 'new-ott', type: 'anime' \}/, 'new-ott chips scope the OTT query per content type');
  // Genre families: every genre keeps its section key + chips. The
  // families are built by the shared genreFamily() factory — assert the
  // factory builds the typed variants (movie default + TV/anime chips
  // carrying the type dimension) AND that all nine genres are listed.
  const genreTitles: Record<string, string> = { action: 'Action', adventure: 'Adventure', comedy: 'Comedy', crime: 'Crime', thriller: 'Thriller', scifi: 'Sci-Fi', drama: 'Drama', horror: 'Horror', romance: 'Romance' };
  for (const g of Object.keys(genreTitles)) {
    assert.match(discoverPage, new RegExp(`genreFamily\\('${g}', '${genreTitles[g]}'\\)`), `genre-${g} family present`);
  }
  assert.match(discoverPage, /function genreFamily\([\s\S]*?key: section,[\s\S]*?typeChips: true,[\s\S]*?variants: \{[\s\S]*?movie: \{ section \},[\s\S]*?series: \{ section, type: 'series' \},[\s\S]*?anime: \{ section, type: 'anime' \}/, 'genreFamily factory: every genre rail gets the Movie/TV Shows/Anime chip variants');
  // The OLD separate section titles are gone (consolidated into chips).
  assert.doesNotMatch(discoverPage, /title: 'Popular movies'/, 'separate Popular movies section removed');
  assert.doesNotMatch(discoverPage, /title: 'Popular TV shows'/, 'separate Popular TV shows section removed');
  assert.doesNotMatch(discoverPage, /title: 'Popular anime'/, 'separate Popular anime section removed');
  assert.doesNotMatch(discoverPage, /title: 'Top rated movies'/, 'separate Top rated movies section removed');
  assert.doesNotMatch(discoverPage, /title: 'Top rated TV shows'/, 'separate Top rated TV shows section removed');
  assert.doesNotMatch(discoverPage, /title: 'Top rated anime'/, 'separate Top rated anime section removed');
  // Old decorative genre tiles must be gone.
  assert.doesNotMatch(discoverPage, /class="genre-section"/, 'old genre-tile section removed');
  assert.doesNotMatch(discoverPage, /Browse by genre/, 'old genre-tile heading removed');
  // Old "Trending right now" / "Trending Movies — Hindi" / "Trending Movies — Regional" sections removed.
  assert.doesNotMatch(discoverPage, /Trending right now/, 'old "Trending right now" section removed');
  assert.doesNotMatch(discoverPage, /Trending Movies — Hindi/, 'old Hindi rail removed');
  assert.doesNotMatch(discoverPage, /Trending Movies — Regional/, 'old Regional rail removed');
  // No duplicate families (each key appears exactly once).
  const theatreCount = (discoverPage.match(/key: 'theatre'/g) || []).length;
  assert.equal(theatreCount, 1, 'theatre family appears exactly once');
  const newOttCount = (discoverPage.match(/key: 'new-ott'/g) || []).length;
  assert.equal(newOttCount, 1, 'new-ott family appears exactly once');
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
  // Phase 2-G: the page counter was renamed from `page` to `currentPage`
  // to avoid the naming collision with `page` from `$app/state` (which
  // the rail cache integration needs for per-user keys). The state is
  // still locally owned by the section instance — the contract is the same.
  assert.match(discoverSection, /let currentPage = .state\(1\)/, 'currentPage is local $state (Phase 2-G: renamed from page to avoid $app/state collision)');
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
  // Explorer redesign: with_genres is now built from the base 16 (Animation)
  // plus the optional per-side Explorer genre — the base 16 + ja contract
  // is unchanged, the constraint is additive.
  assert.match(tmdb, /const movieGenres = genre\?\.movieGenreId \? `16,\$\{genre\.movieGenreId\}` : 16;/, 'anime movie query keeps base genre 16 (+ optional Explorer genre)');
  assert.match(tmdb, /const tvGenres = genre\?\.tvGenreId \? `16,\$\{genre\.tvGenreId\}` : 16;/, 'anime TV query keeps base genre 16 (+ optional Explorer genre)');
  assert.match(tmdb, /tmdbRequest<TmdbList<TmdbMovie>>\('\/discover\/movie'[\s\S]*?with_genres: movieGenres[\s\S]*?with_original_language: 'ja'/, 'queries TMDB movie with genre 16 + ja');
  assert.match(tmdb, /tmdbRequest<TmdbList<TmdbTv>>\('\/discover\/tv'[\s\S]*?with_genres: tvGenres[\s\S]*?with_original_language: 'ja'/, 'queries TMDB TV with genre 16 + ja');
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
// M. Anime Explore — /anime can return movie + series and preserves canonical type.
// ============================================================================
{
  // The /anime route (moved from /discover/anime in the Navigation &
  // Settings Redesign Phase 1; Explorer page since the Explorer redesign)
  // uses loadExplorerData('anime', url), which composes the SAME
  // collection()/getTmdbAnimeMerged service path for the filtered feed.
  const animeRoute = await readFile(path.join(repoRoot, 'src/routes/anime/+page.server.ts'), 'utf8');
  assert.match(animeRoute, /loadExplorerData\('anime', url\)/, 'anime route uses loadExplorerData');
  const explorerLoader = await readFile(path.join(repoRoot, 'src/lib/server/content/explorer-load.ts'), 'utf8');
  assert.match(explorerLoader, /getTmdbAnimeMerged\(filters\.sort === 'top-rated' \? 'top-rated' : 'popularity', safePage, constraint\)/, 'the anime explorer feed composes the existing merged path (+ the top-rated Show-more mode)');
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
  // Hero lineage: `featuredItems` is still a $derived state. Either
  // the legacy `createFeaturedItems(...)` call OR the new server-
  // selected `heroItems` path may produce it.
  assert.match(discoverPage, /featuredItems = \$derived/);
  assert.match(discoverPage, /activeHero = (?:.*?\$derived\()?featuredItems\[activeIndex\]/);
  assert.match(discoverPage, /aria-roledescription="carousel"/);
  assert.match(discoverPage, /aria-label="Previous title"/);
  assert.match(discoverPage, /aria-label="Next title"/);
  assert.match(discoverPage, /role="tablist"/);
  // Quick chips REMOVED (Navigation & Settings Redesign, Phase 1): their
  // only purpose was entering the old /discover/{movies,series,anime}
  // child pages, which are now first-class routes in the primary nav.
  assert.doesNotMatch(discoverPage, /quickChips/, 'quick chips const removed');
  assert.doesNotMatch(discoverPage, /quick-chips/, 'quick chips markup/styles removed');
  assert.doesNotMatch(discoverPage, /\/discover\/(movies|series|anime)/, 'no links to the legacy child pages remain');
  // Anime chip View-all links target the first-class /anime route
  // (MAV-20: the View-all renders on the ANIME VARIANT of the
  // popular / top-rated families).
  assert.match(discoverPage, /viewAllHref=\{\(fam\.key === 'popular' \|\| fam\.key === 'top-rated'\) && variantType === 'anime' \? '\/anime' : ''\}/, 'anime View-all targets /anime (anime chip only)');
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
  // MAV-20 Phase D: the back button delegates to the ONE shared policy
  // (navigateBackOr in shared/navigation.ts), which performs the REAL
  // history.back() with the popstate watchdog + fallback.
  assert.match(detailPage, /navigateBackOr\(\(\) => \{/, 'DetailPage back control uses the shared navigateBackOr policy');
  const navigation = await readFile(path.join(repoRoot, 'src/lib/shared/navigation.ts'), 'utf8');
  assert.match(navigation, /window\.history\.back\(\)/, 'navigateBackOr performs the real history.back()');
  assert.match(navigation, /export function recordInAppNavigation\(/, 'in-app origin tracking: the root layout records in-app navigations');
  assert.match(navigation, /lastInAppNavigationFrom !== null/, 'hasInAppHistoryEntry is driven by the recorded in-app navigation');
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
  // Attribution now lives in the shared AppFooter component (BUG 4 fix).
  assert.match(discoverPage, /import AppFooter from/, 'DiscoverPage imports AppFooter');
  assert.match(discoverPage, /<AppFooter/, 'DiscoverPage renders AppFooter');
  assert.match(appFooter, /tmdb-credit/, 'TMDB credit present in AppFooter');
  assert.match(appFooter, /tmdb-logo/, 'TMDB logo present in AppFooter');
  assert.match(appFooter, /themoviedb\.org\/about\/logos-attribution/, 'links to TMDB attribution page in AppFooter');
  assert.match(appFooter, /justwatch-credit/, 'JustWatch credit present in AppFooter');
  assert.match(appFooter, /justwatch\.com/, 'links to JustWatch in AppFooter');
}

// ============================================================================
// U. Cache keys include all dimensions.
// ============================================================================
{
  // Each TMDB query function must include language + page in its cache key.
  assert.match(tmdb, /key = `tmdb:theatre:\$\{language\}:\$\{page\}`/, 'theatre cache key includes language + page');
  assert.match(tmdb, /key = `tmdb:new-ott:\$\{providerKey/, 'OTT cache key includes provider');
  assert.match(tmdb, /key = `tmdb:popular-v2:\$\{type\}:\$\{language\}:\$\{page\}:[^`]+`/, 'popular cache key includes type + language + page + adult exclusion');
  assert.match(tmdb, /key = `tmdb:top-rated-v2:\$\{type\}:\$\{language\}:\$\{page\}:[^`]+`/, 'top-rated cache key includes type + language + page + adult exclusion');
  assert.match(tmdb, /key = `tmdb:genre-v2:\$\{genreId\}:\$\{language\}:\$\{page\}:[^`]+`/, 'genre cache key includes genreId + language + page + adult exclusion');
  assert.match(tmdb, /key = `tmdb:anime-merged:\$\{sort\}:\$\{page\}:\$\{genre\?\.movieGenreId \?\? ''\}:\$\{genre\?\.tvGenreId \?\? ''\}`/, 'anime-merged cache key includes sort + page + the Explorer genre dimensions');
}

// ============================================================================
// V. Hero daily lineage v3 — server-selected M/S/M/S/M/S, fresh + cached
//    with cache-poisoning prevention (empty lineup NEVER cached for 24h).
// ============================================================================
{
  // The Discover server load returns heroItems.
  assert.match(discoverLoad, /heroItems/, 'loadDiscoverData returns heroItems');
  assert.match(discoverLoad, /selectHeroLineup/, 'loadDiscoverData calls selectHeroLineup');
  assert.match(discoverLoad, /heroDailyBucket/, 'daily bucket drives the cache key');
  assert.match(discoverLoad, /HERO_CACHE_VERSION = 'v3'/, 'cache version v3 (invalidates v2 cache namespace)');
  assert.match(discoverLoad, /tmdb:hero-lineup:\$\{HERO_CACHE_VERSION\}:\$\{bucket\}/, 'cache key is versioned + daily-bucket-scoped');
  // The TMDB adapter exposes a streaming-id batch helper (no N+1).
  assert.match(tmdb, /getTmdbIndiaFlatrateIds/, 'TMDB adapter exposes the streaming-id batch helper');
  assert.match(tmdb, /tmdb:hero-flatrate-ids/, 'streaming-id cache key exists');
  // v3 expanded candidate pool (now_playing + airing_today + on_the_air)
  // with versioned pool cache keys.
  assert.match(tmdb, /export async function getTmdbHeroMoviePool/, 'TMDB adapter exports the expanded movie pool');
  assert.match(tmdb, /export async function getTmdbHeroSeriesPool/, 'TMDB adapter exports the expanded series pool');
  assert.match(tmdb, /tmdb:hero-pool:movie:v3/, 'movie pool cache key is v3-versioned');
  assert.match(tmdb, /tmdb:hero-pool:series:v3/, 'series pool cache key is v3-versioned');
  // v3 cache-poisoning prevention — uses getOrSetValidated, NOT getOrSet.
  assert.match(discoverLoad, /getOrSetValidated/, 'discover-load uses getOrSetValidated (empty lineup NEVER cached)');
  assert.match(discoverLoad, /isHeroLineupCacheable/, 'discover-load uses the cacheability predicate (lineup.length >= 1)');
  // Production diagnostics — per-stage counts + reason field.
  assert.match(discoverLoad, /\[Hero\] thin\/empty lineup/, 'discover-load logs when lineup is thin OR empty');
  assert.match(discoverLoad, /reason=\$\{d\.reason\}/, 'diagnostics include the reason field');
  assert.match(discoverLoad, /postBackdropMovies=\$\{d\.postBackdropMovies\}/, 'diagnostics track per-stage counts');
  // The DiscoverPage v3 contract: heroItems is the SOLE canonical
  // source for the Hero. NO legacy fallback, NO createFallbackItems.
  assert.match(discoverPage, /heroItems = \[\]/, 'DiscoverPage accepts heroItems prop');
  assert.match(discoverPage, /let featuredItems = \$derived\(/, 'featuredItems is $derived');
  assert.match(discoverPage, /heroItems\s*\.filter\(\(item\) => item\.id\.trim/, 'featuredItems derived DIRECTLY from heroItems (no legacy fallback)');
  assert.doesNotMatch(discoverPage, /function createFallbackItems/, 'NO createFallbackItems function (v3 — removes legacy fallback)');
  // The 6-slot contract + cache-poisoning prevention is enforced by
  // the pure selector in hero-select.ts — its dedicated test
  // discover_hero_lineup_test.ts covers the behavioral guarantees
  // (M/S/M/S/M/S order, freshness, dedup, daily rotation, NO legacy
  // fallback, Reacher exclusion, cache-poisoning prevention, source
  // recovery, reason classification).
}

console.log('Discover V2 India-first catalog tests passed: section config (A); language options (B); all-language mixed-query (C); language mapping (D); other-language exclusion (E); theatre (F); OTT (G); page size 10 (H); show more appends (I); independent section state (J); language switch replaces (K); anime movie+series merge (L); anime Explore (M); anime navigation (N); existing behavior (O); nav regression (P); playback regression (Q); no fake data (R); dropdown UX (S); attribution (T); cache keys (U); hero daily lineage (V).');
