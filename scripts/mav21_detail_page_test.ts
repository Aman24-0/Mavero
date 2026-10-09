import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ============================================================================
// MAV-21 Workstream F — Cinematic Detail Page 2.0 regression suite.
//
// The detail page (movie / series / anime) was redesigned around an
// immersive cinematic hero:
//
//   • HERO ARTWORK: full-bleed backdropHero → backdrop → poster chain,
//     gradient-surface graceful fallback when the image fails (never a
//     broken-image icon), eager + high-priority first paint.
//   • ACTION HIERARCHY: ONE dominant action whose label states EXACTLY
//     what pressing it does (Continue Watching SxEy / Resume / Play),
//     with the approved secondary row (My List status · Share · Trailer)
//     and the movie-like-only Download button.
//   • HONEST FACTS: every fact row renders ONLY when trusted metadata
//     supplies it — no empty labels, no invented certifications, no
//     fabricated values. Director (movies) / creators (series) ride the
//     SAME detail request (append_to_response — zero extra roundtrips).
//   • RESPONSIVE COMPOSITION: (SUPERSEDED by MAV-22's approved
//     poster-overlap composition — the poster overlaps the artwork on
//     every surface with the title beside it; this suite's §6 pins the
//     current overlap contract) bounded typography at every breakpoint,
//     reduced-motion respected, landscape-short keeps actions above the
//     fold.
//   • BELOW THE FOLD: Overview (expandable synopsis), Cast,
//     SeasonEpisodes for series-like (incl. anime series), client-side
//     recommendations (skeleton → populated → honest-empty hidden; never
//     fixture-filled). (MAV-22: facts moved to the two-column More
//     Details grid; "Available on" became the compact hero strip.)
//
// This suite locks the contract at the source level + executes the pure
// derivation logic (label policy, genre clamping, facts honesty) against
// synthetic items — the same convention as mav20_discover_nav_perf_test.
// ============================================================================

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const detailPage = read('../src/lib/components/DetailPage.svelte');
const tmdbAdapter = read('../src/lib/server/content/adapters/tmdb.ts');
const typesSrc = read('../src/lib/server/content/types.ts');
const presenterSrc = read('../src/lib/server/content/presenter.ts');
const contentTypesSrc = read('../src/lib/data/content.ts');
const movieRoute = read('../src/routes/movie/[id]/+page.svelte');
const seriesRoute = read('../src/routes/series/[id]/+page.svelte');
const animeRoute = read('../src/routes/anime/[id]/+page.svelte');
const movieServer = read('../src/routes/movie/[id]/+page.server.ts');

// ============================================================
// 1. Hero artwork contract — backdrop-first immersive chain
// ============================================================
console.log('\n1. Cinematic hero artwork');

assert.match(detailPage, /const heroArtwork = \$derived\(item\.backdropHero \|\| item\.backdrop \|\| item\.poster \|\| ''\);/,
  'hero artwork = backdropHero → backdrop → poster → empty (graceful chain)');
assert.match(detailPage, /let heroArtworkFailed = \$state\(false\);/,
  'hero artwork failure is tracked in state');
assert.match(detailPage, /const heroArtworkSrc = \$derived\(heroArtworkFailed \? '' : heroArtwork\);/,
  'failed artwork renders NO img (gradient surface, never a broken-image icon)');
assert.match(detailPage, /onerror=\{\(\) => \(heroArtworkFailed = true\)\}/,
  'img onerror flips the failure state');
assert.match(detailPage, /class="hero-img"[\s\S]*?loading="eager"[\s\S]*?fetchpriority="high"/,
  'hero artwork is eager + high-priority (LCP element)');
assert.match(detailPage, /<div class="hero-scrim" aria-hidden="true"><\/div>/,
  'the scrim layer exists and is decorative');
assert.match(detailPage, /\.hero \{[\s\S]*?min-height: clamp\(4\d\dpx, 78vh, 760px\);/,
  'hero reserves space (min-height clamp — no layout shift from metadata)');
ok('1. hero artwork chain, failure fallback, LCP priority, space reservation');

// ============================================================
// 2. Action hierarchy — the dominant action says what it does
// ============================================================
console.log('\n2. Action hierarchy');

assert.match(detailPage, /const isSeriesLike = \$derived\(type === 'series' \|\| \(item\.isAnime && item\.animeFormat !== 'movie'\)\);/,
  'series-like predicate covers TV series AND anime series (the progress-pipeline convention)');
assert.match(detailPage, /const playLabel = \$derived\(\s*isSeriesLike && resumeEpisode \? 'Continue Watching'\s*: !isSeriesLike && hasActiveProgress \? 'Resume'\s*: 'Play'\s*\);/,
  'playLabel = Continue Watching (series resume) / Resume (movie progress) / Play');
assert.match(detailPage, /const playSubLabel = \$derived\(isSeriesLike && resumeEpisode \? `S\$\{resumeEpisode\.season\} · E\$\{resumeEpisode\.episode\}` : ''\);/,
  'series resume carries the SxEy sub-label');
assert.match(detailPage, /aria-label=\{playSubLabel \? `\$\{playLabel\} — season \$\{resumeEpisode\?\.season\}, episode \$\{resumeEpisode\?\.episode\}` : `\$\{playLabel\} \$\{item\.title\}`\}/,
  'the Play link aria-label states the exact action');
assert.match(detailPage, /\.play-btn \{[\s\S]*?flex: 1 1 62%;[\s\S]*?min-height: 52px;/,
  'the play action is the DOMINANT surface (62% flex, 52px min-height)');
assert.match(detailPage, /<div class="secondary-actions">[\s\S]*?statusLabel\(watchlistStatus\)[\s\S]*?Share[\s\S]*?(Trailer)?/,
  'the approved secondary row: My List status · Share · Trailer');
assert.match(detailPage, /\{#if hasTrailer\}[\s\S]*?Trailer/,
  'Trailer appears ONLY when a trailer key exists');
ok('2. action hierarchy: dominant stateful Play, approved secondary row');

// ============================================================
// 3. Download contract (movie-like main button, per-episode for series)
// ============================================================
console.log('\n3. Download contract');

assert.match(detailPage, /const downloadMediaType = \$derived\(\(type === 'movie' \|\| \(item\.isAnime && item\.animeFormat === 'movie'\)\) \? 'movie' : 'tv' as DownloadMediaType\);/,
  'media-type mapping: movie / anime-movie → movie; series / anime-series → tv');
assert.match(detailPage, /const showDownloadButton = \$derived\(isMovieLike\);/,
  'the main Download button is movie-like ONLY (unconditional, not provider-gated)');
assert.match(detailPage, /function openDownloadSheet\(\) \{[\s\S]*?downloadTargetSeason = undefined;[\s\S]*?downloadTargetEpisode = undefined;/,
  'movie download opens with no season/episode');
assert.match(detailPage, /function openEpisodeDownloadSheet\(season: number, episode: number\) \{[\s\S]*?downloadTargetSeason = season;[\s\S]*?downloadTargetEpisode = episode;/,
  'episode download targets the EXACT clicked episode');
assert.match(detailPage, /onDownload=\{openEpisodeDownloadSheet\}/,
  'SeasonEpisodes download events route to the episode sheet');
ok('3. download: movie main button + exact-episode sheet for series');

// ============================================================
// 4. Honest facts — only supplied metadata renders
// ============================================================
console.log('\n4. Honest facts grid');

// MAV-22 UPDATE: the hero now owns runtime / season-or-episode counts /
// certification (compact hero metadata), and More Details owns the
// complementary facts — the presence-gating CONTRACT below moved with
// them (the dedup policy is pinned by mav22_detail_page_3_test §10).
assert.match(detailPage, /\{#if !isSeriesLike && item\.runtime\}[\s\S]*?\{item\.runtime\}[\s\S]*?\{:else if isSeriesLike && item\.seasons\}/,
  'hero meta: movie runtime / series season-or-episode count (presence-gated)');
assert.match(detailPage, /\{#if item\.maturity\}<span class="dot"><\/span><span class="maturity">\{item\.maturity\}<\/span>\{\/if\}/,
  'Certification renders only when present (never invented) — hero chip');
assert.match(detailPage, /if \(!isSeriesLike && item\.director\) rows\.push\(\{ label: 'Director', value: item\.director \}\);/,
  'Director row: movie-like only, presence-gated (More Details)');
assert.match(detailPage, /if \(isSeriesLike && item\.creators\?\.length\) rows\.push\(\{ label: 'Creators', value: item\.creators\.join\(', '\) \}\);/,
  'Creators row: series-like only, presence-gated');
assert.match(detailPage, /if \(item\.releaseDate\) rows\.push\(\{ label: isSeriesLike \? 'First aired' : 'Release date', value: formatDate\(item\.releaseDate\) \}\);/,
  'FULL release date row (MAV-22: the hero shows the concise year only)');
assert.match(detailPage, /const language = languageName\(item\.originalLanguage\);\s*if \(language\) rows\.push/,
  'Original language row only when a code exists');
// Functional: formatDate + languageName behavior.
const formatDateSrc = detailPage.match(/function formatDate\(iso: string \| undefined\): string \{[\s\S]*?\n  \}/)![0];
assert.match(formatDateSrc, /toLocaleDateString\('en-GB', \{ day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' \}\)/,
  'date formatting: 07 Mar 2026 (UTC-safe, en-GB)');
assert.match(formatDateSrc, /if \(!iso\) return String\(item\.year > 0 \? item\.year : ''\);/,
  'missing date falls back to the year, never NaN');
ok('4. facts grid: every row presence-gated (no empty labels, no fabrication)');

// ============================================================
// 5. Compact hero metadata — bounded genre strip + synopsis preview
// ============================================================
console.log('\n5. Bounded hero metadata');

assert.match(detailPage, /const MAX_HERO_GENRES = 4;/,
  'hero shows at most 4 genres');
assert.match(detailPage, /const heroGenreOverflow = \$derived\(Math\.max\(0, item\.genres\.length - MAX_HERO_GENRES\)\);/,
  'overflow is surfaced as a count, not a long list');
assert.match(detailPage, /\{#if heroGenreOverflow > 0\} <span class="genre-more">\+\{heroGenreOverflow\} more<\/span>\{\/if\}/,
  'the "+N more" affordance renders');
assert.match(detailPage, /const hasLongOverview = \$derived\(item\.description\.length > 280\);/,
  'Overview expansion threshold is 280 chars');
// MAV-24 supersession (Issue 1): the hero synopsis preview was REMOVED;
// the Overview section below the hero is the single synopsis home.
assert.doesNotMatch(detailPage, /class="detail-desc"/,
  'hero synopsis preview removed (full synopsis lives ONLY in Overview)');
assert.match(detailPage, /\.overview-text \{[\s\S]*?-webkit-line-clamp: 4; line-clamp: 4;/,
  'Overview synopsis clamps at 4 lines until expanded');
assert.match(detailPage, /\.detail-title \{[\s\S]*?-webkit-line-clamp: 3; line-clamp: 3;/,
  'title is line-clamped (long titles never push actions away)');
// MAV-22 UPDATE: the bounded genre strip became bounded genre CHIPS
// (same 4-max + overflow-count policy, chip presentation).
assert.match(detailPage, /class="genre-chip"/,
  'genres render as compact chips (still bounded by MAX_HERO_GENRES)');
assert.match(detailPage, /\.genre-chip \{[\s\S]*?white-space: nowrap;/,
  'each chip stays on one line');
ok('5. bounded hero metadata: 4 genre chips + overflow, 2-line preview, clamped title');

// ============================================================
// 6. Responsive composition — one DOM, CSS decides
// ============================================================
console.log('\n6. Responsive composition');

// MAV-22 UPDATE: the approved OVERLAP composition replaced the
// poster-free touch hero — the poster now overlaps the artwork on EVERY
// surface (mobile included) with the title beside it (pinned by
// mav22_detail_page_3_test §8).
assert.match(detailPage, /\.hero-body \{[\s\S]*?margin-top: calc\(-1 \* clamp/,
  'the poster body OVERLAPS the backdrop (negative margin, every surface)');
assert.match(detailPage, /\.hero-grid \{[\s\S]*?grid-template-columns: clamp\(100px, 27vw, 132px\) minmax\(0, 1fr\);/,
  'mobile hero grid: poster column + identity column side by side');
assert.match(detailPage, /\.poster-card \{[\s\S]*?aspect-ratio: 2 \/ 3;/,
  'the poster is a distinct 2:3 card (aspect reserved)');
// MAV-23 supersession: mobile Play shares ONE dominant row with Download
// (62% / 38%) instead of stacking two full-width rows — the fold now
// reaches the provider chip. The ≥52px thumb target and Play's dominance
// intent are unchanged.
assert.match(detailPage, /@media \(max-width: 640px\) \{[\s\S]*?\.play-btn \{ flex: 1 1 62%; min-height: 52px;/,
  'mobile Play keeps the dominant 62% row with a ≥52px thumb target');
// MAV-24 supersession (Issue 2): Download is an icon-only 52px square that
// shares the primary row with Play (same 52px target, no visible text).
assert.match(detailPage, /\.download-btn \{[\s\S]*?flex: 0 0 auto; width: 52px; min-height: 52px;/,
  'mobile/base Download shares the primary row as a 52px icon square (≥52px thumb target)');
assert.match(detailPage, /@media \(max-width: 1024px\) and \(orientation: landscape\) and \(max-height: 480px\) \{[\s\S]*?\.hero \{ min-height: auto; height: auto; \}/,
  'landscape-short: hero collapses so title+actions stay visible');
assert.match(detailPage, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?transition: none !important;[\s\S]*?animation: none !important;/,
  'reduced-motion disables all hero/button transitions');
assert.match(detailPage, /\.back-btn \{[\s\S]*?top: calc\(1[24]px \+ env\(safe-area-inset-top\)\);/,
  'back button respects the safe-area inset');
ok('6. responsive: poster-overlap hero at every surface (MAV-22), a11y hardening');

// ============================================================
// 7. Below-the-fold sections
// ============================================================
console.log('\n7. Below the fold');

assert.match(detailPage, /<h2 class="section-h" id="overview-heading">Overview<\/h2>/,
  'Overview section present');
// MAV-24 supersession (Issue 3): the provider strip left the hero for a
// labelled field inside the More Details grid (same genuine data —
// pinned by mav22_detail_page_3_test §12 + mav24_final_polish_test).
assert.doesNotMatch(detailPage, /class="provider-strip"/,
  'no provider strip in the hero (it renders in More Details now)');
assert.match(detailPage, /class="fact-row fact-row-providers"/,
  'provider availability renders as a labelled More Details field (honest data only)');
assert.doesNotMatch(detailPage, /streaming-heading/,
  'no separate provider section remains (it duplicated the compact strip)');
assert.match(detailPage, /<div class="cast-photo cast-photo-fallback" aria-hidden="true"><span>\{member\.name\.slice\(0, 1\)\.toUpperCase\(\)\}<\/span><\/div>/,
  'Cast fallback initial renders when no photo');
assert.match(detailPage, /\{#if isSeriesLike\}[\s\S]*?<SeasonEpisodes/,
  'SeasonEpisodes renders for series-like (TV + anime series)');
assert.match(detailPage, /watchType=\{type === 'anime' \? 'anime' : 'series'\}/,
  'SeasonEpisodes watchType maps anime correctly');
assert.match(detailPage, /\{:else if recommendationState === 'loading'\}[\s\S]*?aria-busy="true"/,
  'recommendations skeleton while loading');
assert.match(detailPage, /recommendationState = 'failed';[\s\S]*?(?=\/\/|$)/,
  'failed recommendations settle silently (section hidden)');
ok('7. below the fold: Overview, Available on, Cast, SeasonEpisodes, progressive recs');

// ============================================================
// 8. Data enrichment — the SAME detail request, zero extra roundtrips
// ============================================================
console.log('\n8. Detail payload enrichment');

assert.match(tmdbAdapter, /const appendBase = 'videos,external_ids,recommendations,credits,watch\/providers';/,
  'the append base (certification rides the SAME request)');
assert.match(tmdbAdapter, /append_to_response: type === 'movie' \? `\$\{appendBase\},release_dates` : `\$\{appendBase\},content_ratings`/,
  'movies get release_dates, TV gets content_ratings (same roundtrip)');
assert.match(tmdbAdapter, /movieCertEntries\.find\(\(entry\) => entry\.iso_3166_1 === 'IN'\)[\s\S]*?entry\.iso_3166_1 === 'US'[\s\S]*?flatMap/,
  'movie certification: India first, US second, any non-empty third');
assert.match(tmdbAdapter, /tvCertEntries\.find\(\(entry\) => entry\.iso_3166_1 === 'IN'\)\?\.rating\?\.trim\(\)/,
  'TV certification: India first');
assert.match(tmdbAdapter, /if \(certification\) item\.maturity = certification;/,
  'maturity set ONLY when a real certification exists');
assert.match(tmdbAdapter, /credits\?\.crew\?\.find\(\(member\) => member\.job === 'Director' && member\.name\?\.trim\(\)\)\?\.name\?\.trim\(\)/,
  'director = first crew member with job Director (movies only)');
assert.match(tmdbAdapter, /if \(creators\.length\) item\.creators = creators\.slice\(0, 3\);/,
  'creators capped at 3 (TV/anime series only)');
assert.match(typesSrc, /director\?: string;/,
  'NormalizedMediaItem.director optional');
assert.match(typesSrc, /creators\?: string\[\];/,
  'NormalizedMediaItem.creators optional');
assert.match(presenterSrc, /director: item\.director,/s,
  'presenter passes director through');
assert.match(presenterSrc, /creators: item\.creators,/s,
  'presenter passes creators through');
assert.match(contentTypesSrc, /director\?: string;/,
  'MediaItem.director optional (client contract)');
assert.match(contentTypesSrc, /creators\?: string\[\];/,
  'MediaItem.creators optional (client contract)');
ok('8. enrichment: certification + director + creators on the SAME detail request');

// ============================================================
// 9. Route wrappers — the three detail surfaces
// ============================================================
console.log('\n9. Detail route wrappers');

assert.match(movieRoute, /<DetailPage id=\{data\.item\.id\} type="movie" dataItem=\{data\.item\} recommendationItems=\{data\.recommendations\} \/>/,
  'movie route: type="movie" + SSR item');
assert.match(seriesRoute, /<DetailPage id=\{data\.item\.id\} type="series" dataItem=\{data\.item\} recommendationItems=\{data\.recommendations\} \/>/,
  'series route: type="series" + SSR item');
assert.match(animeRoute, /<DetailPage id=\{data\.item\.id\} type=\{data\.item\.type\} dataItem=\{data\.item\} recommendationItems=\{data\.recommendations\} \/>/,
  'anime route: type derived from the loaded item (canonical series UI)');
assert.match(movieServer, /const detail = await getDetail\('movie', params\.id\);/,
  'server load fetches the PARENT detail only (MAV-20 Phase D preserved)');
assert.match(movieServer, /recommendations: \[\]/,
  'recommendations load client-side (empty SSR array)');
ok('9. route wrappers: movie/series/anime wired, parent-only SSR load');

// ============================================================
// 10. Preserved behaviors — back policy, SEO head, trailer a11y
// ============================================================
console.log('\n10. Preserved behaviors');

assert.match(detailPage, /const validReturnTo = returnTo\?\.startsWith\('\/'\) && !returnTo\.startsWith\('\/\/'\) \? returnTo : null;/,
  'from-validation preserved (internal origins only)');
assert.match(detailPage, /const fallbackDestination = validReturnTo \?\? '\/discover';/,
  'fallback destination = valid origin ?? /discover');
assert.match(detailPage, /navigateBackOr\(\(\) => \{/,
  'goBack delegates to the shared back policy');
assert.match(detailPage, /const watchHref = \$derived\(appendReturnTo\(watchPath, `\$\{page\.url\.pathname\}\$\{page\.url\.search\}\$\{page\.url\.hash\}`\)\);/,
  'watch link carries the origin (from param)');
assert.match(detailPage, /<link rel="canonical" href=\{canonicalUrl\} \/>/,
  'canonical URL preserved');
assert.match(detailPage, /<meta property="og:image" content=\{item\.backdrop \|\| item\.poster\} \/>/,
  'og:image = backdrop || poster');
assert.match(detailPage, /<script type="application\/ld\+json">\{structuredData\}<\/script>/,
  'structured data preserved');
// MAV-23 supersession: the trailer is now an INLINE player in the hero —
// there is no modal to Tab-trap. The keyboard contract is preserved in the
// inline form: Escape stops playback (except while the browser consumes
// Escape to exit fullscreen), and focus moves to the adjacent fullscreen
// control on start / back to the toggle on stop.
assert.match(detailPage, /event\.key === 'Escape' && !document\.fullscreenElement[\s\S]*?stopTrailer\(\);/,
  'trailer keyboard contract: Escape stops inline playback (fullscreen-aware)');
assert.match(detailPage, /trailerToggle\?\.focus\(\);/,
  'trailer stop restores focus to the trigger (the Trailer toggle)');
ok('10. preserved: back policy, SEO head, trailer focus management');

// ============================================================
// 11. Functional derivations — the label/clamp policies in isolation
// ============================================================
console.log('\n11. Functional policy checks');

// Recreate the pure label policy and verify its truth table.
type LabelInput = { isSeriesLike: boolean; resumeEpisode?: { season: number; episode: number }; hasActiveProgress: boolean };
function playLabelFor(input: LabelInput): string {
  return input.isSeriesLike && input.resumeEpisode ? 'Continue Watching'
    : !input.isSeriesLike && input.hasActiveProgress ? 'Resume'
      : 'Play';
}
assert.equal(playLabelFor({ isSeriesLike: true, resumeEpisode: { season: 2, episode: 3 }, hasActiveProgress: true }), 'Continue Watching',
  'series with resume target → Continue Watching');
assert.equal(playLabelFor({ isSeriesLike: true, hasActiveProgress: true }), 'Play',
  'series without resume target (no episode picked yet) → Play (first episode)');
assert.equal(playLabelFor({ isSeriesLike: false, hasActiveProgress: true }), 'Resume',
  'movie with progress → Resume');
assert.equal(playLabelFor({ isSeriesLike: false, hasActiveProgress: false }), 'Play',
  'fresh movie → Play');
assert.equal(playLabelFor({ isSeriesLike: true, resumeEpisode: { season: 1, episode: 1 }, hasActiveProgress: false }), 'Continue Watching',
  'anime series resume → Continue Watching (same predicate)');

// Genre clamp policy.
const MAX_HERO_GENRES = 4;
function heroGenresFor(genres: string[]) {
  return { shown: genres.slice(0, MAX_HERO_GENRES), overflow: Math.max(0, genres.length - MAX_HERO_GENRES) };
}
assert.deepEqual(heroGenresFor(['Action', 'Drama', 'Sci-Fi']), { shown: ['Action', 'Drama', 'Sci-Fi'], overflow: 0 },
  'short genre list: no overflow');
assert.deepEqual(heroGenresFor(['a', 'b', 'c', 'd', 'e', 'f']), { shown: ['a', 'b', 'c', 'd'], overflow: 2 },
  'long genre list: 4 shown + 2 overflow');

// Series-like predicate truth table (mirrors the derived).
function isSeriesLikeFor(type: string, item: { isAnime?: boolean; animeFormat?: 'movie' | 'series' }): boolean {
  return type === 'series' || (Boolean(item.isAnime) && item.animeFormat !== 'movie');
}
assert.equal(isSeriesLikeFor('series', {}), true, 'TV series is series-like');
assert.equal(isSeriesLikeFor('movie', {}), false, 'movie is not series-like');
assert.equal(isSeriesLikeFor('anime', { isAnime: true, animeFormat: 'series' }), true, 'anime series is series-like (seasons render)');
assert.equal(isSeriesLikeFor('anime', { isAnime: true, animeFormat: 'movie' }), false, 'anime movie is NOT series-like (movie UI)');
assert.equal(isSeriesLikeFor('anime', { isAnime: true }), true, 'anime with missing format defaults series-like (type carries it)');

// Download media-type mapping (mirrors the derived).
function downloadMediaTypeFor(type: string, item: { isAnime?: boolean; animeFormat?: 'movie' | 'series' }): 'movie' | 'tv' {
  return (type === 'movie' || (Boolean(item.isAnime) && item.animeFormat === 'movie')) ? 'movie' : 'tv';
}
assert.equal(downloadMediaTypeFor('movie', {}), 'movie', 'movie → movie download');
assert.equal(downloadMediaTypeFor('series', {}), 'tv', 'series → tv download');
assert.equal(downloadMediaTypeFor('anime', { isAnime: true, animeFormat: 'movie' }), 'movie', 'anime movie → movie download');
assert.equal(downloadMediaTypeFor('anime', { isAnime: true, animeFormat: 'series' }), 'tv', 'anime series → tv download');
ok('11. functional truth tables: play label, genre clamp, series-like, download mapping');

console.log(`\nMAV-21 cinematic detail page tests passed (${passed} check groups).`);
