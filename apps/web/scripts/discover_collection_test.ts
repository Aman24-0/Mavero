import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// MAVERO — Collection/feed pagination + filter contract (Explorer
// redesign). The Explorer pages replaced the old paginated Collection
// grid with the progressive feed; the SERVER contract stays anchored
// on the same `collection()` service, now extended with the Explorer
// language filter (validated against the existing DiscoverLanguage
// union) and served through loadExplorerData (SSR seed) +
// /api/explorer/feed (client-side pages).
const loader = await readFile(new URL('../src/lib/server/content/explorer-load.ts', import.meta.url), 'utf8');
const service = await readFile(new URL('../src/lib/server/content/service.ts', import.meta.url), 'utf8');
const tmdbAdapter = await readFile(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
const feedEndpoint = await readFile(new URL('../src/routes/api/explorer/feed/+server.ts', import.meta.url), 'utf8');
const explorerPage = await readFile(new URL('../src/lib/components/ExplorerPage.svelte', import.meta.url), 'utf8');
// The three Explorer routes now serve the Explorer experience via
// loadExplorerData (which composes the SAME collection() service for
// the filtered feed — the URL filter contract carries genre/language).
const routes = await Promise.all([
  readFile(new URL('../src/routes/movies/+page.server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/tv-shows/+page.server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/anime/+page.server.ts', import.meta.url), 'utf8')
]);

// ── Server contract: the collection service keeps its shape and gains
//    the validated language dimension. ──
assert.match(service, /export async function collection\(type: ContentType, page = 1, filters: CollectionFilters = \{\}\)/);
assert.match(service, /getTmdbCollection\((?:tmdbType|type), page, filters\)/);
assert.match(tmdbAdapter, /export async function getTmdbCollection\(type: Exclude<ContentType, 'anime'>, page = 1, filters: CollectionFilters = \{\}\)/);
// Language filter: validated union + real TMDB param + bounded walk
// (the deterministicSoapWalk pattern — stable disjoint feed pages).
assert.match(tmdbAdapter, /const isLanguageWalk = Boolean\(language\)/);
assert.match(tmdbAdapter, /with_original_language: langParam/, 'language filtering uses the real TMDB original-language param');
assert.match(tmdbAdapter, /const survivorTarget = isLanguageWalk \? page \* DISCOVER_PAGE_SIZE : DISCOVER_PAGE_SIZE/, 'feed page N = survivor rows [(N-1)*10, N*10) — disjoint, no gaps');
assert.match(tmdbAdapter, /MAX_OTHER_LANGUAGE_PAGES \* page, 30\)/, 'the language walk stays bounded');
assert.match(tmdbAdapter, /applyLanguageFilter\(raw, language\)/, 'the existing language filter helper is reused');
// No language → the original single-page behavior byte-for-byte.
assert.match(tmdbAdapter, /const maxWalked = isLanguageWalk \? Math\.min\(MAX_OTHER_LANGUAGE_PAGES \* page, 30\) : 1;/, 'no-language queries keep the single-page behavior');
assert.match(tmdbAdapter, /totalPages: result\.total_pages/, 'movie/series collection exposes the upstream total_pages');

// ── The anime merged path keeps its no-total honesty and gains the
//    per-side genre constraint (real ids only). ──
const animeMerged = tmdbAdapter.match(/export async function getTmdbAnimeMerged[\s\S]*?\n\}/);
assert.ok(animeMerged, 'getTmdbAnimeMerged source captured');
assert.doesNotMatch(animeMerged![0], /\btotalPages\b/, 'anime merged path does NOT report a total (never invent N)');
assert.match(tmdbAdapter, /export type AnimeGenreConstraint = \{ movieGenreId\?: number; tvGenreId\?: number \}/, 'the anime genre constraint maps per-side ids');

// ── Explorer feed loader contract. ──
assert.match(loader, /url\.searchParams\.get\('page'\)/, 'the page param is still server-parsed');
assert.match(loader, /collection\(type, safePage, collectionFilters\)/, 'the movie/series feed calls the collection service');
assert.match(loader, /hasNextPage: result\.hasNextPage/, 'hasNextPage flows through');
assert.match(loader, /MAX_EXPLORER_FEED_PAGE = 20/, 'the 1..20 serving window survives (single named constant)');
assert.match(loader, /parseExplorerPage/, 'out-of-range pages clamp safely to 1 (server-side)');
assert.match(loader, /isExplorerGenre\(type, genreParam\)/, 'genre params are validated against the closed taxonomy (fail-safe)');
assert.match(loader, /isExplorerLanguage\(type, languageParam\)/, 'language params are validated per type (fail-safe)');
assert.match(loader, /explorerGenreId\(type, filters\.genre\)/, 'genre names resolve to REAL per-type TMDB ids before querying');
for (const route of routes) assert.match(route, /loadExplorerData\('[^']+', url\)/);

// ── Feed endpoint contract (client-side progressive pages). ──
assert.match(feedEndpoint, /isContentType\(typeParam\)/, 'the endpoint validates the type union');
assert.match(feedEndpoint, /isExplorerGenre\(typeParam, genre\)/, 'the endpoint validates the genre taxonomy');
assert.match(feedEndpoint, /isExplorerLanguage\(typeParam, language\)/, 'the endpoint validates the language taxonomy');
assert.match(feedEndpoint, /Math\.min\(Number\(url\.searchParams\.get\('page'\) \?\? 1\) \|\| 1, 20\)/, 'the endpoint clamps pages to the 1..20 window');

// ── Client: filter changes reset to page 1 and stay deduped. ──
assert.match(explorerPage, /let feedItems = \$state<MediaItem\[\]>\(\[\]\)/, 'the SSR feed seed state is typed');
assert.match(explorerPage, /new Set\(feedItems\.map\(itemKey\)\)/, 'appended feed pages deduplicate by type:id');
assert.match(explorerPage, /const MAX_FEED_PAGE = 20;/, 'the client stops at the serving window');
assert.doesNotMatch(explorerPage, /filteredItems = .*\.filter\(\(item\) => item\.genres/, 'no client-side genre filtering — the server feed stays authoritative');

console.log('Explorer collection pagination/filter contract tests passed');
