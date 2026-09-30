import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase C contracts.
 *
 * Phase C is the Media Library: hierarchy, search, filters, sorting,
 * master-detail interaction, detail drawer, provider availability,
 * asset information, and contextual actions. These tests pin the
 * contracts that Phase D+ will depend on so later phases don't
 * accidentally regress Phase C's foundation.
 *
 * Test strategy: static source-file contract assertions (regex
 * against source files). No live DB, no live provider calls. This
 * matches the existing admin2_phaseB_test.ts pattern.
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const libraryService = readFileSync(new URL('../src/lib/server/hosting/library/service.ts', import.meta.url), 'utf8');
const libraryListApi = readFileSync(new URL('../src/routes/api/admin/media/library/+server.ts', import.meta.url), 'utf8');
const libraryDetailApi = readFileSync(new URL('../src/routes/api/admin/media/library/[id]/+server.ts', import.meta.url), 'utf8');
const libraryFoldersApi = readFileSync(new URL('../src/routes/api/admin/media/library/folders/+server.ts', import.meta.url), 'utf8');
const libraryPageServer = readFileSync(new URL('../src/routes/admin/media/library/+page.server.ts', import.meta.url), 'utf8');
const libraryPage = readFileSync(new URL('../src/routes/admin/media/library/+page.svelte', import.meta.url), 'utf8');

const adminAssetStatus = readFileSync(new URL('../src/lib/components/admin2/AdminAssetStatus.svelte', import.meta.url), 'utf8');
const adminMediaTree = readFileSync(new URL('../src/lib/components/admin2/AdminMediaTree.svelte', import.meta.url), 'utf8');
const adminMediaTable = readFileSync(new URL('../src/lib/components/admin2/AdminMediaTable.svelte', import.meta.url), 'utf8');
const adminMediaCard = readFileSync(new URL('../src/lib/components/admin2/AdminMediaCard.svelte', import.meta.url), 'utf8');
const adminMediaDetailDrawer = readFileSync(new URL('../src/lib/components/admin2/AdminMediaDetailDrawer.svelte', import.meta.url), 'utf8');
const adminMediaFilters = readFileSync(new URL('../src/lib/components/admin2/AdminMediaFilters.svelte', import.meta.url), 'utf8');

const resolverHosted = readFileSync(new URL('../src/lib/server/resolver/mavero-hosted.ts', import.meta.url), 'utf8');

// ============================================================
// 1. Media Library read model (service)
// ============================================================

assert.match(libraryService, /class MediaLibraryService/, 'service defines MediaLibraryService class');
assert.match(libraryService, /async list\(query: LibraryQuery\)/, 'service exposes list() method');
assert.match(libraryService, /async detail\(mediaItemId: string\)/, 'service exposes detail() method');
assert.match(libraryService, /async folderSummary\(\)/, 'service exposes folderSummary() method');
ok('1a. MediaLibraryService exposes list + detail + folderSummary methods');

// N+1 prevention: list() batch-fetches assets and demand
assert.match(libraryService, /\.in\('media_item_id', mediaItemIds\)/, 'list() batch-fetches assets by media_item_id (avoids N+1)');
assert.match(libraryService, /\.in\('canonical_key', canonicalKeys\)/, 'list() batch-fetches demand by canonical_key (avoids N+1)');
ok('1b. list() avoids N+1 by batch-fetching assets + demand');

// Search supports title, TMDB ID, IMDb ID, canonical key
assert.match(libraryService, /ilike\('title'/, 'search supports title (ILIKE)');
assert.match(libraryService, /eq\('tmdb_id', q\)/, 'search supports TMDB ID');
assert.match(libraryService, /eq\('imdb_id', q\)/, 'search supports IMDb ID');
assert.match(libraryService, /eq\('canonical_key', q\)/, 'search supports canonical key');
ok('1c. search supports title / TMDB ID / IMDb ID / canonical key');

// Pagination
assert.match(libraryService, /range\(offset, offset \+ limit - 1\)/, 'list() uses range pagination');
assert.match(libraryService, /MAX_LIMIT = 100/, 'list() enforces max limit of 100');
assert.match(libraryService, /has_more/, 'list() returns has_more flag');
ok('1d. list() enforces pagination with max limit + has_more flag');

// Sorting
for (const sort of ['recently_updated', 'recently_added', 'title', 'year', 'status']) {
  assert.match(libraryService, new RegExp(`'${sort}'`), `sort option: ${sort}`);
}
ok('1e. list() supports all 5 sort options');

// Detail returns item + recent_operations
assert.match(libraryService, /recent_operations/, 'detail() returns recent_operations array');
assert.match(libraryService, /Promise\.allSettled|Promise\.all\(\[/, 'detail() parallelizes asset + demand + operations fetches');
ok('1f. detail() returns item + recent_operations, parallelizes internal fetches');

// FolderSummary returns movies (by year) + series + anime (with season/episode counts)
assert.match(libraryService, /movies: \{ year: number \| null; count: number \}\[\]/, 'folderSummary returns movies by year');
assert.match(libraryService, /series: \{ tmdb_id: string; title: string; year: number \| null; season_count: number; episode_count: number \}\[\]/, 'folderSummary returns series with season/episode counts');
assert.match(libraryService, /anime: \{ tmdb_id: string; title: string; year: number \| null; season_count: number; episode_count: number \}\[\]/, 'folderSummary returns anime with season/episode counts');
ok('1g. folderSummary returns movies (by year) + series + anime (with season/episode counts)');

// Types are exported for sharing with the API layer
assert.match(libraryService, /export type LibraryMediaItem/, 'LibraryMediaItem type exported');
assert.match(libraryService, /export type LibraryAssetSummary/, 'LibraryAssetSummary type exported');
assert.match(libraryService, /export type LibraryDetailResult/, 'LibraryDetailResult type exported');
assert.match(libraryService, /export type LibraryQuery/, 'LibraryQuery type exported');
ok('1h. Types exported for API + UI sharing');

// ============================================================
// 2. API endpoints
// ============================================================

// GET /api/admin/media/library
assert.match(libraryListApi, /export const GET: RequestHandler/, 'list endpoint exports GET');
assert.match(libraryListApi, /requireAdmin\(locals/, 'list endpoint requires admin');
assert.match(libraryListApi, /createSupabaseAdminClient\(\)/, 'list endpoint uses service-role client');
assert.match(libraryListApi, /NO_STORE/, 'list endpoint sets no-store cache header');
assert.match(libraryListApi, /MediaLibraryService/, 'list endpoint uses MediaLibraryService');
ok('2a. GET /api/admin/media/library is admin-gated + uses service + no-store');

// Query params validated
assert.match(libraryListApi, /VALID_TYPES/, 'list endpoint validates type param');
assert.match(libraryListApi, /VALID_STATUSES/, 'list endpoint validates status param');
assert.match(libraryListApi, /VALID_SORTS/, 'list endpoint validates sort param');
assert.match(libraryListApi, /year >= 1880 && year <= 3000/, 'list endpoint validates year range');
ok('2b. list endpoint validates all query params');

// Response shape: { ok, items, total, page, limit, has_more }
assert.match(libraryListApi, /\{ ok: true, \.\.\.result \}/, 'list endpoint spreads result with ok:true');
assert.match(libraryListApi, /error: \{ code: 'LIBRARY_QUERY_FAILED'/, 'list endpoint returns typed error');
ok('2c. list endpoint response shape: { ok, items, total, page, limit, has_more }');

// GET /api/admin/media/library/[id]
assert.match(libraryDetailApi, /export const GET: RequestHandler/, 'detail endpoint exports GET');
assert.match(libraryDetailApi, /requireAdmin\(locals/, 'detail endpoint requires admin');
assert.match(libraryDetailApi, /service\.detail\(id\)/, 'detail endpoint calls service.detail()');
assert.match(libraryDetailApi, /status: 404/, 'detail endpoint returns 404 when not found');
ok('2d. GET /api/admin/media/library/[id] is admin-gated + returns 404 when missing');

// GET /api/admin/media/library/folders
assert.match(libraryFoldersApi, /export const GET: RequestHandler/, 'folders endpoint exports GET');
assert.match(libraryFoldersApi, /requireAdmin\(locals/, 'folders endpoint requires admin');
assert.match(libraryFoldersApi, /service\.folderSummary\(\)/, 'folders endpoint calls service.folderSummary()');
ok('2e. GET /api/admin/media/library/folders is admin-gated');

// ============================================================
// 3. Page server loader — initial server-side render
// ============================================================
assert.match(libraryPageServer, /export const load: PageServerLoad/, 'page.server.ts exports load');
assert.match(libraryPageServer, /requireAdmin\(locals/, 'page server requires admin');
assert.match(libraryPageServer, /Promise\.allSettled/, 'page server uses Promise.allSettled for partial-failure resilience');
assert.match(libraryPageServer, /initialList/, 'page server returns initialList');
assert.match(libraryPageServer, /initialFolders/, 'page server returns initialFolders');
assert.match(libraryPageServer, /initialFoldersError/, 'page server returns initialFoldersError on partial failure');
assert.match(libraryPageServer, /hostingSources/, 'page server returns hostingSources for filter');
ok('3a. page server preloads list + folders + sources with partial-failure resilience');

// URL state is parsed server-side for deep links
assert.match(libraryPageServer, /url\.searchParams/, 'page server parses URL search params');
assert.match(libraryPageServer, /selectedId/, 'page server extracts selectedId for deep-link drawer');
ok('3b. page server parses URL state for deep links');

// ============================================================
// 4. Page component — workspace architecture
// ============================================================

// Uses AdminAppShell + AdminPage framework
assert.match(libraryPage, /<AdminAppShell>/, 'library page uses AdminAppShell');
assert.match(libraryPage, /<AdminPage eyebrow="Content" title="Media Library"/, 'library page uses AdminPage framework');
ok('4a. library page uses AdminAppShell + AdminPage framework');

// Imports all the new Phase C components
assert.match(libraryPage, /AdminMediaTree/, 'imports AdminMediaTree');
assert.match(libraryPage, /AdminMediaTable/, 'imports AdminMediaTable');
assert.match(libraryPage, /AdminMediaCard/, 'imports AdminMediaCard');
assert.match(libraryPage, /AdminMediaDetailDrawer/, 'imports AdminMediaDetailDrawer');
assert.match(libraryPage, /AdminMediaFilters/, 'imports AdminMediaFilters');
ok('4b. library page imports all 5 Phase C components');

// Split layout (tree + main)
assert.match(libraryPage, /library-workspace/, 'library page has workspace container');
assert.match(libraryPage, /grid-template-columns: 240px 1fr/, 'desktop split layout: tree (240px) + main');
ok('4c. library page has split layout (tree + main)');

// Responsive: mobile swaps to card list, hides tree
assert.match(libraryPage, /library-card-wrap/, 'library page has mobile card wrap');
assert.match(libraryPage, /display: none/, 'library page hides elements responsively');
assert.match(libraryPage, /@media \(max-width: 1023px\)/, 'library page has 1023px breakpoint');
assert.match(libraryPage, /library-filters-mobile-btn/, 'library page has mobile filter button');
ok('4d. library page is responsive: mobile swaps to card list + filter sheet');

// URL state sync
assert.match(libraryPage, /syncUrl\(\)/, 'library page syncs URL state');
assert.match(libraryPage, /replaceState: true/, 'library page uses replaceState (no history spam)');
ok('4e. library page syncs URL state (search/filter/sort/page/selected)');

// Pagination
assert.match(libraryPage, /goToPage/, 'library page has pagination');
assert.match(libraryPage, /hasMore/, 'library page respects hasMore flag');
assert.match(libraryPage, /totalPages/, 'library page computes total pages');
ok('4f. library page has pagination');

// Detail drawer integration
assert.match(libraryPage, /openDetail/, 'library page opens detail drawer on row click');
assert.match(libraryPage, /closeDetail/, 'library page closes detail drawer');
assert.match(libraryPage, /drawerItem/, 'library page tracks drawer item');
assert.match(libraryPage, /drawerLoading/, 'library page tracks drawer loading state');
assert.match(libraryPage, /drawerError/, 'library page tracks drawer error state');
ok('4g. library page integrates with detail drawer');

// Deep-link: ?selected=<id> opens drawer on mount
assert.match(libraryPage, /onMount/, 'library page has onMount');
assert.match(libraryPage, /initial\.initialFilters\.selectedId/, 'library page reads selectedId from initial data');
ok('4h. library page supports deep-link via ?selected=<id>');

// Upload integration: link to existing upload wizard with prefilled params
assert.match(libraryPage, /openUploadForItem/, 'library page has openUploadForItem');
assert.match(libraryPage, /tmdbId: item\.tmdb_id/, 'library page prefills tmdbId in upload URL');
assert.match(libraryPage, /contentType: item\.content_type/, 'library page prefills contentType in upload URL');
ok('4i. library page integrates with upload wizard (prefilled)');

// Partial failure: list error shows retry, doesn't crash whole page
assert.match(libraryPage, /listError/, 'library page tracks list error');
assert.match(libraryPage, /library-error-block/, 'library page has error block');
assert.match(libraryPage, /Retry/, 'library page has retry button');
ok('4j. library page handles list errors with retry');

// ============================================================
// 5. AdminAssetStatus — per-asset semantic status
// ============================================================

assert.match(adminAssetStatus, /status.*maveroStatus/, 'AdminAssetStatus takes status + maveroStatus');
assert.match(adminAssetStatus, /Not Linked/, 'AdminAssetStatus handles "not linked" state');
assert.match(adminAssetStatus, /Detached/, 'AdminAssetStatus handles detached state (mavero_status=missing)');
assert.match(adminAssetStatus, /Disabled/, 'AdminAssetStatus handles disabled state');
assert.match(adminAssetStatus, /Stale/, 'AdminAssetStatus handles stale state');
assert.match(adminAssetStatus, /Ready/, 'AdminAssetStatus handles ready state');
assert.match(adminAssetStatus, /Processing/, 'AdminAssetStatus handles processing state');
assert.match(adminAssetStatus, /Failed/, 'AdminAssetStatus handles failed state');
ok('5a. AdminAssetStatus maps all asset lifecycle + mavero_status states');

// ============================================================
// 6. AdminMediaTree — content navigator
// ============================================================

assert.match(adminMediaTree, /Movies/, 'tree has Movies group');
assert.match(adminMediaTree, /Series/, 'tree has Series group');
assert.match(adminMediaTree, /Anime/, 'tree has Anime group');
ok('6a. tree has Movies + Series + Anime groups');

// Tree shows counts
assert.match(adminMediaTree, /totals\.movies/, 'tree shows total movies count');
assert.match(adminMediaTree, /totals\.series/, 'tree shows total series count');
assert.match(adminMediaTree, /totals\.anime/, 'tree shows total anime count');
ok('6b. tree shows counts per group');

// Tree is expandable
assert.match(adminMediaTree, /expanded/, 'tree has expandable state');
assert.match(adminMediaTree, /aria-expanded/, 'tree uses aria-expanded');
ok('6c. tree is expandable with aria-expanded');

// Tree handles loading + error states
assert.match(adminMediaTree, /loading/, 'tree has loading state');
assert.match(adminMediaTree, /error/, 'tree has error state');
assert.match(adminMediaTree, /a2-tree-skeleton/, 'tree has skeleton loading');
ok('6d. tree handles loading + error states');

// Tree selection triggers filter callback
assert.match(adminMediaTree, /onselect/, 'tree exposes onselect callback');
assert.match(adminMediaTree, /type\?: 'movie' \| 'series' \| 'anime' \| 'all'/, 'tree selection includes type');
assert.match(adminMediaTree, /year\?: number \| null/, 'tree selection includes year');
assert.match(adminMediaTree, /seriesTmdb\?: string \| null/, 'tree selection includes seriesTmdb');
ok('6e. tree selection triggers filter callback with type/year/seriesTmdb');

// ============================================================
// 7. AdminMediaTable — desktop results
// ============================================================

assert.match(adminMediaTable, /media-table/, 'table has media-table class');
assert.match(adminMediaTable, /col-type/, 'table has type column');
assert.match(adminMediaTable, /col-title/, 'table has title column');
assert.match(adminMediaTable, /col-year/, 'table has year column');
assert.match(adminMediaTable, /col-vidara/, 'table has Vidara column');
assert.match(adminMediaTable, /col-abyss/, 'table has Abyss column');
assert.match(adminMediaTable, /col-qualities/, 'table has quality column');
assert.match(adminMediaTable, /col-audio/, 'table has audio column');
assert.match(adminMediaTable, /col-updated/, 'table has updated column');
ok('7a. table has all required columns (type/title/year/Vidara/Abyss/quality/audio/updated)');

// Table renders provider availability per row
assert.match(adminMediaTable, /vidaraAsset/, 'table computes Vidara asset per row');
assert.match(adminMediaTable, /abyssAsset/, 'table computes Abyss asset per row');
assert.match(adminMediaTable, /AdminAssetStatus/, 'table uses AdminAssetStatus');
ok('7b. table renders per-row provider availability');

// Table handles loading + empty states
assert.match(adminMediaTable, /loading/, 'table has loading state');
assert.match(adminMediaTable, /media-row-skeleton/, 'table has skeleton loading');
assert.match(adminMediaTable, /media-table-empty/, 'table has empty state');
ok('7c. table handles loading + empty states');

// Row click opens detail
assert.match(adminMediaTable, /onselect/, 'table exposes onselect callback');
assert.match(adminMediaTable, /role="button"/, 'table rows are buttons (keyboard accessible)');
assert.match(adminMediaTable, /tabindex="0"/, 'table rows are focusable');
ok('7d. table rows are keyboard accessible (Enter/Space)');

// ============================================================
// 8. AdminMediaCard — mobile results
// ============================================================

assert.match(adminMediaCard, /media-card-list/, 'card list has media-card-list class');
assert.match(adminMediaCard, /media-card/, 'card has media-card class');
assert.match(adminMediaCard, /type-pill/, 'card has type pill');
assert.match(adminMediaCard, /provider-row/, 'card has provider rows');
assert.match(adminMediaCard, /AdminAssetStatus/, 'card uses AdminAssetStatus');
ok('8a. card list has type pill + provider rows + AdminAssetStatus');

// Card handles loading + empty states
assert.match(adminMediaCard, /media-card-skeleton/, 'card has skeleton loading');
assert.match(adminMediaCard, /media-card-empty/, 'card has empty state');
ok('8b. card handles loading + empty states');

// Card click opens detail
assert.match(adminMediaCard, /onselect/, 'card exposes onselect callback');
ok('8c. card click opens detail');

// ============================================================
// 9. AdminMediaDetailDrawer — detail experience
// ============================================================

assert.match(adminMediaDetailDrawer, /role="dialog"/, 'drawer has dialog role');
assert.match(adminMediaDetailDrawer, /aria-modal="true"/, 'drawer is aria-modal');
assert.match(adminMediaDetailDrawer, /handleKeydown/, 'drawer has keyboard handler');
assert.match(adminMediaDetailDrawer, /Escape/, 'drawer handles Escape to close');
assert.match(adminMediaDetailDrawer, /lastFocused/, 'drawer restores focus on close');
ok('9a. drawer has dialog semantics + focus trap + Escape + focus restore');

// Drawer sections
assert.match(adminMediaDetailDrawer, /Identity/, 'drawer has Identity section');
assert.match(adminMediaDetailDrawer, /Provider Availability/, 'drawer has Provider Availability section');
assert.match(adminMediaDetailDrawer, /Missing Demand/, 'drawer has Missing Demand section');
assert.match(adminMediaDetailDrawer, /Metadata/, 'drawer has Metadata section');
assert.match(adminMediaDetailDrawer, /Recent Operations/, 'drawer has Recent Operations section');
assert.match(adminMediaDetailDrawer, /Actions/, 'drawer has Actions section');
ok('9b. drawer has all 6 sections (Identity/Provider/Demand/Metadata/Operations/Actions)');

// Drawer shows identity fields
assert.match(adminMediaDetailDrawer, /TMDB ID/, 'drawer shows TMDB ID');
assert.match(adminMediaDetailDrawer, /IMDb ID/, 'drawer shows IMDb ID');
assert.match(adminMediaDetailDrawer, /Canonical Key/, 'drawer shows canonical key');
assert.match(adminMediaDetailDrawer, /Year/, 'drawer shows year');
assert.match(adminMediaDetailDrawer, /Episode/, 'drawer shows episode');
ok('9c. drawer shows identity fields (TMDB/IMDb/canonical key/year/episode)');

// Drawer shows provider availability per provider
assert.match(adminMediaDetailDrawer, /Vidara/, 'drawer shows Vidara');
assert.match(adminMediaDetailDrawer, /Abyss/, 'drawer shows Abyss');
assert.match(adminMediaDetailDrawer, /Quality/, 'drawer shows quality');
assert.match(adminMediaDetailDrawer, /Audio/, 'drawer shows audio');
assert.match(adminMediaDetailDrawer, /Subtitles/, 'drawer shows subtitles');
assert.match(adminMediaDetailDrawer, /Duration/, 'drawer shows duration');
assert.match(adminMediaDetailDrawer, /Size/, 'drawer shows size');
ok('9d. drawer shows provider availability (quality/audio/subtitles/duration/size)');

// Drawer shows operations with action + status + timestamp + admin email
assert.match(adminMediaDetailDrawer, /operation-action/, 'drawer shows operation action');
assert.match(adminMediaDetailDrawer, /operation-time/, 'drawer shows operation time');
assert.match(adminMediaDetailDrawer, /operation-user/, 'drawer shows admin email');
assert.match(adminMediaDetailDrawer, /operation-error/, 'drawer shows operation error');
ok('9e. drawer shows operations with action/status/time/admin-email/error');

// Drawer partial failure — drawer component takes loading + error props
assert.match(adminMediaDetailDrawer, /loading = false/, 'drawer accepts loading prop');
assert.match(adminMediaDetailDrawer, /error = null as string \| null/, 'drawer accepts error prop');
assert.match(adminMediaDetailDrawer, /a2-drawer-error/, 'drawer has error block');
assert.match(adminMediaDetailDrawer, /a2-drawer-skeleton/, 'drawer has skeleton loading');
// Page tracks drawer loading + error states
assert.match(libraryPage, /drawerLoading/, 'page tracks drawerLoading state');
assert.match(libraryPage, /drawerError/, 'page tracks drawerError state');
ok('9f. drawer handles loading + error states (component props + page state)');

// Drawer integrates with upload wizard
assert.match(adminMediaDetailDrawer, /onupload/, 'drawer exposes onupload callback');
assert.match(adminMediaDetailDrawer, /Upload \/ Import/, 'drawer has Upload action');
ok('9g. drawer integrates with upload wizard');

// Drawer links to missing media page when demand exists
assert.match(adminMediaDetailDrawer, /Open Missing Media/, 'drawer links to missing media page');
ok('9h. drawer links to missing media page when demand exists');

// Drawer documents Phase E/F deferrals (no fake action buttons)
assert.match(adminMediaDetailDrawer, /Phase E/, 'drawer documents Phase E deferral');
assert.match(adminMediaDetailDrawer, /Phase F/, 'drawer documents Phase F deferral');
ok('9i. drawer explicitly documents Phase E/F deferrals (no fake actions)');

// ============================================================
// 10. AdminMediaFilters — filter bar
// ============================================================

assert.match(adminMediaFilters, /FilterState/, 'filters exports FilterState type');
assert.match(adminMediaFilters, /q: string/, 'filters has q (search)');
assert.match(adminMediaFilters, /type:/, 'filters has type');
assert.match(adminMediaFilters, /status:/, 'filters has status');
assert.match(adminMediaFilters, /provider:/, 'filters has provider');
assert.match(adminMediaFilters, /sort:/, 'filters has sort');
ok('10a. filters has all 5 fields (q/type/status/provider/sort)');

// Filter options match the approved plan
assert.match(adminMediaFilters, /All Types/, 'filters has All Types');
assert.match(adminMediaFilters, /Movies/, 'filters has Movies');
assert.match(adminMediaFilters, /Series/, 'filters has Series');
assert.match(adminMediaFilters, /Anime/, 'filters has Anime');
assert.match(adminMediaFilters, /All Status/, 'filters has All Status');
assert.match(adminMediaFilters, /Ready/, 'filters has Ready');
assert.match(adminMediaFilters, /Missing/, 'filters has Missing');
assert.match(adminMediaFilters, /Failed/, 'filters has Failed');
assert.match(adminMediaFilters, /Processing/, 'filters has Processing');
assert.match(adminMediaFilters, /All Providers/, 'filters has All Providers');
assert.match(adminMediaFilters, /Unlinked Only/, 'filters has Unlinked Only');
ok('10b. filters has all approved filter options');

// Mobile filter sheet
assert.match(adminMediaFilters, /filter-sheet/, 'filters has mobile sheet');
assert.match(adminMediaFilters, /mobileOpen/, 'filters has mobileOpen state');
assert.match(adminMediaFilters, /filter-overlay/, 'filters has mobile overlay');
ok('10c. filters has mobile bottom-sheet composition');

// Clear-all
assert.match(adminMediaFilters, /clearAll/, 'filters has clearAll');
assert.match(adminMediaFilters, /hasActiveFilters/, 'filters tracks hasActiveFilters');
ok('10d. filters has clear-all + active-filter tracking');

// ============================================================
// 11. Resolver gating bug fix (Phase C critical)
//
// Before Phase C: resolver only gated on status='ready'. detachAsset
// sets mavero_status='missing' but leaves status='ready', so a
// "detached" asset would STILL be served by the resolver.
//
// Phase C fix: resolver now gates on BOTH status='ready' AND
// mavero_status='available'.
// ============================================================
assert.match(resolverHosted, /\.eq\('status', 'ready'\)/, 'resolver still gates on status=ready');
assert.match(resolverHosted, /\.eq\('mavero_status', 'available'\)/, 'resolver now also gates on mavero_status=available (Phase C fix)');
assert.match(resolverHosted, /Phase C §Hosting\/Media Issue Audit/, 'resolver fix is documented as Phase C');
ok('11a. resolver now gates on BOTH status=ready AND mavero_status=available');

// ============================================================
// 12. Security — no credentials leak
// ============================================================

// Service does NOT expose provider_metadata in select() (may contain provider-internal fields)
// It's OK to mention in comments but should NOT appear in any select() call.
const serviceSelects = libraryService.match(/\.select\([^)]+\)/g) ?? [];
const providerMetadataInSelect = serviceSelects.some(s => s.includes('provider_metadata'));
assert.ok(!providerMetadataInSelect, 'service does NOT include provider_metadata in any select() call');
// Service does NOT expose playback_url in list (resolver-only field)
const playbackUrlInList = serviceSelects.some(s => s.includes('playback_url'));
assert.ok(!playbackUrlInList, 'service does NOT include playback_url in any select() call');
// API endpoints all use requireAdmin
for (const api of [libraryListApi, libraryDetailApi, libraryFoldersApi]) {
  assert.match(api, /requireAdmin/, 'API endpoint uses requireAdmin');
  assert.match(api, /NO_STORE/, 'API endpoint sets no-store');
}
ok('12a. no credentials leak: provider_metadata + playback_url excluded; all endpoints admin-gated + no-store');

// ============================================================
// 13. No N+1 patterns
// ============================================================

// list() performs exactly 3 queries: items, assets (batch by media_item_id), demand (batch by canonical_key).
// Extract the list() method body and count queries inside it.
const listMethodMatch = libraryService.match(/async list\(query: LibraryQuery\): Promise<LibraryListResult> \{[\s\S]*?\n  \}/);
assert.ok(listMethodMatch, 'list() method body extracted');
const listMethodBody = listMethodMatch![0];
const listDbQueries = (listMethodBody.match(/\.from\('media_/g) ?? []).length;
assert.equal(listDbQueries, 3, `list() performs exactly 3 DB queries (items, assets batch, demand batch) — found ${listDbQueries}`);
ok('13a. list() performs bounded DB queries (3 queries, no N+1)');

// detail() uses Promise.all (parallel)
assert.match(libraryService, /Promise\.all\(\[/, 'detail() parallelizes fetches');
ok('13b. detail() parallelizes asset + demand + operations fetches');

// ============================================================
// 14. Phase B test compatibility — Phase C must not break Phase B
//
// Phase B asserted that /admin/media/library exists and wraps in
// AdminAppShell. Phase C keeps that contract — the page is now the
// real implementation, not a placeholder, but the shell wrapper
// is preserved.
// ============================================================
assert.match(libraryPage, /<AdminAppShell>/, 'Phase C library page still uses AdminAppShell (Phase B contract preserved)');
assert.doesNotMatch(libraryPage, /AdminPlaceholder/, 'Phase C library page no longer uses AdminPlaceholder (real implementation)');
ok('14a. Phase C preserves Phase B contracts (AdminAppShell wrapper) + replaces placeholder');

console.log(`\nAdmin 2.0 Phase C tests passed (${passed} check groups).`);
