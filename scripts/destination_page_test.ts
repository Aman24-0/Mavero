import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Rich Destination Pages (Navigation & Settings Redesign,
// Phase 4).
//
// Regression contract for the cinematic /movies, /tv-shows, /anime
// experiences:
//
//   SOURCE     — one DestinationPage component serves all three routes
//                (hero + rails + embedded collection). One
//                loadDestinationData server loader composes ONLY the
//                existing cached TMDB helpers — no new backend fetching,
//                no duplicate page implementations.
//   HERO       — cinematic featured item (backdrop + meta + Play/More
//                details); quiet fallback block when the catalog has no
//                featured pick (no fake content); Play links preserve
//                the existing watch route pattern.
//   RAILS      — Trending / Popular / Top rated (+ New & recent + genre
//                rails for movie/series) rendered through the existing
//                ContentRail; empty rails are omitted server-side; the
//                anime merged path intentionally gets NO genre/Newest
//                rails (they would silently duplicate Popular).
//   COLLECTION — the existing CollectionPage is embedded in 'section'
//                variant below the cinematic content: filters/grid/
//                pagination contracts preserved; browsing stays primary;
//                filters no longer dominate the page.
//   LABELS     — hero + collection copy comes from the shared
//                DESTINATION_LABELS module (one source of truth).
//   MOTION     — hero Ken Burns drift disabled under reduced motion.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const loader = read('../src/lib/server/content/discover-load.ts');
const destinationPage = read('../src/lib/components/DestinationPage.svelte');
const collection = read('../src/lib/components/CollectionPage.svelte');
const contentRail = read('../src/lib/components/ContentRail.svelte');
const labelsModule = read('../src/lib/shared/content-labels.ts');
const routes = {
  movies: read('../src/routes/movies/+page.svelte'),
  series: read('../src/routes/tv-shows/+page.svelte'),
  anime: read('../src/routes/anime/+page.svelte')
};
const routeServers = {
  movies: read('../src/routes/movies/+page.server.ts'),
  series: read('../src/routes/tv-shows/+page.server.ts'),
  anime: read('../src/routes/anime/+page.server.ts')
};

// ============================================================
// 1. LOADER — composed from existing cached helpers only
// ============================================================
assert.match(loader, /export async function loadDestinationData\(type: ContentType, url: URL\)/, 'loadDestinationData exported');
for (const helper of ['loadCollectionData(type, url)', 'loadRail(type, \'trending\')', 'loadRail(type, \'popular\')', 'loadTopRated(type)', 'loadNewest(type)', 'loadGenreCollection(type, def.genre)']) {
  assert.ok(loader.includes(helper), `the destination loader composes the existing helper: ${helper}`);
}
assert.match(loader, /Promise\.all\(\[/, 'all rails load in parallel (one request burst)');
// The collection URL contract is passed through unchanged.
assert.match(loader, /\.\.\.collectionData/, 'the collection data (page/filters/totalPages) is spread into the destination payload');
// No new TMDB fetching in the destination loader — it reuses helpers.
const destinationLoaderBlock = loader.slice(loader.indexOf('export async function loadDestinationData'));
assert.doesNotMatch(destinationLoaderBlock, /getTmdb[A-Z]\w*\(|fetch\(|tmdbRequest/, 'the destination loader performs NO direct TMDB fetching (helpers only)');
ok('1. loadDestinationData composes only existing cached loaders in parallel (no new backend fetching)');

// ============================================================
// 2. HERO — cinematic featured item + honest fallback
// ============================================================
assert.match(destinationPage, /class="dest-hero"/, 'cinematic hero section present');
assert.match(destinationPage, /heroItem\.backdrop/, 'the hero renders the featured item backdrop');
assert.match(destinationPage, /hero-scrim/, 'the hero keeps the cinematic scrim treatment');
assert.match(destinationPage, /hero-eyebrow.*MAVERO \/ \{labels\.plural\}/s, 'the hero eyebrow carries the destination identity');
assert.match(destinationPage, /\/watch\/\$\{heroItem\.type\}\/\$\{heroItem\.id\}/, 'hero Play preserves the existing watch route pattern');
assert.match(destinationPage, /\/\$\{heroItem\.type\}\/\$\{heroItem\.id\}/, 'hero More details preserves the existing detail route pattern');
assert.match(loader, /\.find\(\(item\) => item\.backdrop\?\.trim\(\) && item\.title\?\.trim\(\)\)/, 'the hero REQUIRES a real backdrop + title (no fake heroes)');
// Fallback: no hero → quiet heading block with the catalog message.
assert.match(destinationPage, /dest-hero-fallback/, 'fallback hero block present for empty-catalog cases');
assert.match(destinationPage, /errorMessage \?\? labels\.description/, 'the fallback surfaces the server error message (error state preserved)');
ok('2. hero: cinematic featured pick with honest fallback (no fake content)');

// ============================================================
// 3. RAILS — destination-scoped, existing components, empty omitted
// ============================================================
assert.match(destinationPage, /<ContentRail title=\{rail\.title\} items=\{rail\.items\} \/>/, 'rails render through the existing ContentRail');
assert.match(destinationPage, /\{#each rails as rail \(rail\.key\)\}/, 'rails are keyed render targets');
assert.match(loader, /\.filter\(\(def\) => def\.result\.items\.length > 0\)/, 'empty rails are OMITTED server-side (never an empty section)');
// Rail set per the plan: trending, popular, top rated for all three;
// new & recent + genre rails only where the upstream path supports them.
const railTitles = [...loader.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
for (const title of ['Trending now', 'Top rated']) {
  assert.ok(railTitles.includes(title), `core rail present: ${title}`);
}
assert.match(loader, /title: `Popular \$\{type === 'anime' \? 'anime' : type === 'movie' \? 'movies' : 'TV shows'\}`/, 'the Popular rail label adapts per destination');
assert.match(loader, /title: 'New & recent'/, 'the New & recent rail is defined (movie/series only)');
// Anime scope: the merged path ignores genre/Newest — no duplicate rails.
assert.match(loader, /type === 'anime' \? Promise\.resolve\(\{ items: \[\] as MediaItem\[\] \} as RailResult\) : loadNewest\(type\)/, 'anime intentionally skips the New & recent rail (merged path ignores Newest)');
assert.match(loader, /DESTINATION_GENRE_RAILS: Partial<Record<ContentType/, 'genre rail config is per-type');
assert.doesNotMatch(loader, /anime:\s*\[\s*\{ genre:/, 'anime requests NO genre rails (would silently duplicate Popular)');
ok('3. rails: existing ContentRail, empty rails omitted, anime scope intentionally narrower');

// ============================================================
// 4. COLLECTION — embedded section variant, contracts preserved
// ============================================================
assert.match(destinationPage, /variant="section"/, 'DestinationPage embeds CollectionPage in section variant');
assert.match(collection, /export let variant: 'page' \| 'section' = 'page';/, 'CollectionPage exposes the variant prop (backward compatible)');
assert.match(collection, /\{#if variant === 'page'\}/, 'head chrome renders only in page variant (the parent owns the title)');
assert.match(collection, /class:section-heading=\{variant === 'section'\}/, 'the section variant ships a compact heading treatment');
// The filter/pagination contracts are unchanged.
assert.match(collection, /params\.set\('page', '1'\)/, 'filter changes still reset to page 1');
assert.match(collection, /href=\{collectionHref\(currentPage \+ 1\)\}/, 'pagination preserved');
// Rails come BEFORE the collection section (browsing primary).
const railsIndex = destinationPage.indexOf('{#each rails as rail');
const collectionIndex = destinationPage.indexOf('<CollectionPage');
assert.ok(railsIndex >= 0 && collectionIndex > railsIndex, 'rails render above the collection section (browsing primary, filters do not dominate)');
ok('4. collection: embedded below the cinematic content; all filter/grid/pagination contracts preserved');

// ============================================================
// 5. ROUTES — one component, one loader, three thin routes
// ============================================================
for (const [key, src] of Object.entries(routes)) {
  assert.match(src, /<DestinationPage\s/, `${key} route renders DestinationPage`);
  assert.match(src, /rails=\{data\.rails\}/, `${key} route passes server rails through`);
  assert.match(src, /heroItem=\{data\.heroItem\}/, `${key} route passes the hero through`);
}
for (const [key, src] of Object.entries(routeServers)) {
  assert.match(src, /loadDestinationData\('[^']+', url\)/, `${key} server uses the shared destination loader`);
}
ok('5. three thin routes over one shared component + loader (no duplicate implementations)');

// ============================================================
// 6. LABELS — shared module, hero + collection agree
// ============================================================
assert.match(labelsModule, /export const DESTINATION_LABELS/, 'shared label module exists');
assert.match(destinationPage, /DESTINATION_LABELS\[type\]/, 'the hero reads labels from the shared module');
assert.match(collection, /DESTINATION_LABELS\[type\]/, 'the collection section reads labels from the same shared module');
assert.match(destinationPage, /<title>\{labels\.plural\} — Mavero<\/title>/, 'document titles derive from the shared labels');
ok('6. one shared label module drives hero, rails copy and collection copy');

// ============================================================
// 7. MOTION + RESPONSIVE — reduced motion, mobile hero cropping
// ============================================================
assert.match(destinationPage, /prefers-reduced-motion: reduce[\s\S]*?\.hero-media img \{ animation: none; \}/, 'hero drift disabled under reduced motion');
assert.match(destinationPage, /@media \(max-width: 640px\)[\s\S]*?\.dest-hero \{[^}]*border-radius: 0/, 'mobile hero goes edge-to-edge (no floating radius)');
assert.match(destinationPage, /-webkit-line-clamp: 2/, 'mobile hero description clamps to 2 lines');
assert.match(destinationPage, /min-height: 44px/, 'hero action buttons keep the 44px touch target');
ok('7. hero honors reduced motion, mobile edge-to-edge cropping, 44px targets');

// ============================================================
// 8. DATA SAFETY — no fixture heroes, no schema/API changes
// ============================================================
assert.doesNotMatch(destinationPage, /fixtureMedia/, 'the destination page never renders fixture media');
assert.match(destinationPage, /import ContentRail from '\$components\/ContentRail\.svelte';/, 'reuses the existing rail component (no new architecture)');
assert.doesNotMatch(loader.slice(loader.indexOf('export async function loadDestinationData')), /provider === 'fixtures'/, 'the destination loader adds no new fixture-fallback branch (the shared helpers keep their existing honesty contract)');
assert.ok(contentRail.includes('role="list"'), 'ContentRail list semantics preserved for the new context');
ok('8. data safety: no fixtures, no new components beyond DestinationPage, rail semantics preserved');

console.log(`\nRich destination page (Phase 4) tests passed (${passed} check groups).`);
