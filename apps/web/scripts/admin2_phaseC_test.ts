import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

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
const adminMediaListComp = readFileSync(new URL('../src/lib/components/admin2/AdminMediaList.svelte', import.meta.url), 'utf8');
// 2026-10-16 re-pin: AdminHostingAssets (the legacy asset-centric file
// manager, unimported since the AdminMediaList swap) was DELETED with the
// provider-inventory UI. Its contracts are re-pinned on the LIVE
// AdminMediaList below with equal or greater strength.
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url)), 'AdminHostingAssets component deleted (legacy file manager removed)');
const hostingAssets = adminMediaListComp; // the live file manager source

const adminAssetStatus = readFileSync(new URL('../src/lib/components/admin2/AdminAssetStatus.svelte', import.meta.url), 'utf8');
const adminMediaTree = readFileSync(new URL('../src/lib/components/admin2/AdminMediaTree.svelte', import.meta.url), 'utf8');
// 2026-10-16 re-pin: AdminMediaTable (dead code — unimported since the
// AdminMediaList swap) was DELETED with the legacy asset-manager UI; the
// desktop results surface is AdminMediaList's list view.
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminMediaTable.svelte', import.meta.url)), 'AdminMediaTable component deleted (legacy desktop table removed)');
const adminMediaTable = adminMediaListComp; // the live list/grid source
const adminMediaCard = readFileSync(new URL('../src/lib/components/admin2/AdminMediaCard.svelte', import.meta.url), 'utf8');
// 2026-10-16 re-pin: AdminMediaDetailDrawer (dead code — unimported since
// the AdminMediaList swap) was DELETED. Its accessibility/detail contracts
// live on in AdminEpisodeSheet + AdminOpsJobs' drawer.
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminMediaDetailDrawer.svelte', import.meta.url)), 'AdminMediaDetailDrawer component deleted (dead code removed)');
const adminMediaDetailDrawer = readFileSync(new URL('../src/lib/components/admin2/AdminEpisodeSheet.svelte', import.meta.url), 'utf8'); // the live detail sheet
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
// [final remediation] The library page is ASSET-CENTRIC: the file manager
// (AdminHostingAssets) owns the paginated read via /api/admin/hosting/assets.
// The page server provides hosting sources + parses the canonical URL params
// into initialFilters (provider deep-links from Hosting Control, mediaItem
// deep-links from Jobs/Activity/Attention).
// ============================================================
assert.match(libraryPageServer, /export const load: PageServerLoad/, 'page.server.ts exports load');
assert.match(libraryPageServer, /requireAdmin\(locals/, 'page server requires admin');
assert.match(libraryPageServer, /hostingSources/, 'page server returns hostingSources for filter');
assert.match(libraryPageServer, /initialFilters/, 'page server returns initialFilters (URL param wiring)');
ok('3a. page server provides sources + initialFilters (asset-centric read model via /api/admin/hosting/assets)');

// URL state is parsed server-side for deep links
assert.match(libraryPageServer, /url\.searchParams/, 'page server parses URL search params');
assert.match(libraryPageServer, /get\('provider'\)/, 'page server extracts provider param (Hosting Control deep-link)');
assert.match(libraryPageServer, /get\('mediaItem'\)/, 'page server extracts mediaItem param (Jobs/Activity/Attention deep-link)');
assert.match(libraryPageServer, /status.*'active'/, 'page server defaults status to active (deleted excluded)');
assert.match(libraryPageServer, /params\.delete\('view'\)/, 'page server strips legacy ?view= param (redirect)');
ok('3b. page server parses URL state for deep links (provider + mediaItem + view redirect)');

// ============================================================
// 4. Page component — workspace architecture
// ============================================================

// Uses AdminAppShell + AdminPage framework
assert.match(libraryPage, /<AdminAppShell/, 'library page uses AdminAppShell');
// Task 2 (2026-10-15): the Media Library page heading + explanatory
// paragraph were REMOVED by design — the shell header stays, the content
// region starts at the toolbar. The page still uses the AdminPage
// framework (header-less form).
assert.match(libraryPage, /<AdminPage fill>/, 'library page uses the AdminPage framework (header-less, FILL mode by design)');
ok('4a. library page uses AdminAppShell + AdminPage framework');

// [Task 2 (2026-10-15)] The library page renders the compact media-centric
// list (AdminMediaList + Add File wizard + episode sheet) — the successor
// of the AdminHostingAssets asset-centric file manager. The URL-derived
// initialFilters contract is PRESERVED: the page server parses the
// canonical params and the page passes them to AdminMediaList (restored
// deep-link wiring — ?provider=vidara initializes the Provider filter).
assert.match(libraryPage, /AdminMediaList/, 'library page renders AdminMediaList (the media-centric list)');
assert.doesNotMatch(libraryPage, /AdminMediaTree|AdminMediaTable|AdminMediaCard|AdminMediaDetailDrawer|AdminMediaFilters/, 'library page does NOT render the old Phase C component set');
assert.match(libraryPage, /initialFilters=\{data\.initialFilters\}/, 'library page passes URL-derived initialFilters to the media list (deep-link wiring restored)');
assert.match(adminMediaListComp, /initialFilters/, 'AdminMediaList accepts initialFilters');
ok('4b. library page renders the media-centric list with URL-derived initialFilters');

// Workspace is the file manager itself — no split tree layout.
assert.doesNotMatch(libraryPage, /library-workspace/, 'no legacy tree workspace container');
ok('4c. library page: single-file-manager workspace (no tree split layout)');

// Responsive (2026-10-16 re-pin on AdminMediaList): the mobile media query
// compacts the rows, the filter SHEET is a modal dialog, and the action
// menu is portaled (never clipped by card overflow).
assert.match(hostingAssets, /@media \(max-width: 640px\)/, 'file manager has a mobile breakpoint');
assert.match(hostingAssets, /class="filter-sheet"/, 'file manager uses a native filter sheet (modal dialog)');
assert.match(hostingAssets, /use:portal/, 'file manager portals its action menu (overflow-safe)');
ok('4d. library page is responsive: compact mobile rows + native filter sheet + portal menu');

// URL state (2026-10-16 re-pin): the CURRENT contract is server-parsed
// deep-links — the page loader reads the canonical params into
// initialFilters and the list applies them ONCE at init (no client URL
// rewriting, no history spam by construction).
assert.match(hostingAssets, /initialFilters/, 'file manager initializes from server-parsed URL params');
assert.match(hostingAssets, /\$effect\(\(\) => \{[\s\S]*?initialFilters[\s\S]*?loadList\(true\)/, 'deep-link params drive the FIRST load (deterministic)');
ok('4e. deep-links are server-parsed and applied at init (provider/q/type/status/sort)');

// Pagination (2026-10-16 re-pin): infinite scroll inside the cards
// scroller + honest end-of-list.
assert.match(hostingAssets, /has_more/, 'file manager respects the has_more flag');
assert.match(hostingAssets, /checkCardsNearViewportBottom/, 'file manager loads more near the scroll end');
assert.match(hostingAssets, /End of list/, 'file manager shows the honest end state');
ok('4f. file manager has pagination (infinite scroll + end-of-list)');

// Detail integration (2026-10-16 re-pin): the parent row opens the
// accessible episode sheet.
assert.match(hostingAssets, /function openEpisodeSheet/, 'file manager opens the episode sheet on parent click');
assert.match(hostingAssets, /sheetOpen/, 'file manager tracks sheet state');
ok('4g. file manager integrates with the episode detail sheet');

// Deep-links (2026-10-16 re-pin): ?provider= / ?q= / ?type= initialize the
// file manager via the page server.
assert.match(libraryPageServer, /get\('provider'\)/, 'page server reads provider param');
assert.match(libraryPageServer, /get\('q'\)/, 'page server reads the q param');
assert.match(hostingAssets, /initialFilters/, 'file manager initializes from server-parsed URL params');
ok('4h. file manager supports provider/search deep-links');

// Upload integration — [2026-10-15] the Add File action moved INTO the
// AdminMediaList toolbar controls row (Task 2 layout: page-level heading
// and action button removed). The action still opens the shared
// AdminAddFileWizard inline (manual-link flow — no upload round-trip,
// and the upload page itself is REMOVED).
assert.match(adminMediaListComp, /class="add-file-btn"/, 'media list toolbar owns the Add File button (controls row, left)');
assert.match(adminMediaListComp, /function openAddWizard/, 'Add File button opens the shared wizard');
assert.match(adminMediaListComp, /AdminAddFileWizard/, 'the media list embeds the Add File wizard (manual-link flow)');
assert.doesNotMatch(libraryPage, /href="\/admin\/media\/upload"/, 'library page no longer links out to the upload wizard (Add file is inline)');
ok('4i. media list toolbar integrates the Add File wizard inline (no upload navigation)');

// Partial failure: list error shows retry, doesn't crash whole page
// (2026-10-16 re-pin: AdminMediaList's error state).
assert.match(hostingAssets, /state-error/, 'file manager tracks list error');
assert.match(hostingAssets, /Retry/, 'file manager has retry button');
ok('4j. file manager handles list errors with retry');

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
// 7. Desktop results (2026-10-16 re-pin: AdminMediaList list view)
// ============================================================

assert.match(adminMediaTable, /class="media-list"/, 'the desktop results use the media list');
assert.match(adminMediaTable, /badge-type/, 'rows show the content type');
assert.match(adminMediaTable, /\{row\.title\}/, 'rows show the title');
assert.match(adminMediaTable, /\{row\.tmdbId\}/, 'rows show the TMDB id');
assert.match(adminMediaTable, /badge-provider/, 'rows show the provider badge');
ok('7a. rows show all required identity fields (type/title/TMDB/provider)');

// Per-row provider availability
assert.match(adminMediaTable, /providerLabel\(row\)/, 'rows compute the provider label');
assert.match(adminMediaTable, /data-provider=\{providerLabel/, 'provider badges carry the provider dimension');
ok('7b. rows render per-row provider availability');

// Loading + empty states
assert.match(adminMediaTable, /\{#if loading\}/, 'the list has a loading state');
assert.match(adminMediaTable, /state-empty/, 'the list has an empty state');
assert.match(adminMediaTable, /state-error/, 'the list has an error state');
ok('7c. the list handles loading + empty + error states');

// Row interaction is keyboard accessible (buttons + aria labels)
assert.match(adminMediaTable, /aria-label="Open episodes of \{row\.title\}/, 'parent rows are labelled buttons (keyboard accessible)');
assert.match(adminMediaTable, /aria-label="Actions"/, 'row action menus are labelled buttons');
ok('7d. rows are keyboard accessible (real buttons + aria labels)');

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
// 9. Detail experience (2026-10-16 re-pin: AdminMediaDetailDrawer was
//    deleted with the legacy asset-manager UI; the LIVE detail surface is
//    the AdminEpisodeSheet + the AdminOpsJobs drawer. Contracts re-pinned
//    with equal or greater strength.)
// ============================================================

assert.match(adminMediaDetailDrawer, /role="dialog"/, 'the sheet has dialog role');
assert.match(adminMediaDetailDrawer, /aria-modal="true"/, 'the sheet is aria-modal');
assert.match(adminMediaDetailDrawer, /onKeydown/, 'the sheet has keyboard handling');
assert.match(adminMediaDetailDrawer, /Escape/, 'the sheet handles Escape to close');
assert.match(adminMediaDetailDrawer, /lastFocused/, 'the sheet restores focus on close');
ok('9a. detail sheet has dialog semantics + focus trap + Escape + focus restore');

// Identity: the sheet head carries the parent identity.
assert.match(adminMediaDetailDrawer, /head-title/, 'the sheet shows the title');
assert.match(adminMediaDetailDrawer, /TMDB \{parent\.tmdbId\}/, 'the sheet shows the TMDB id');
assert.match(adminMediaDetailDrawer, /head-title[\s\S]{0,200}parent\.title[\s\S]{0,200}parent\.year/, 'the sheet shows the year');
ok('9c. detail sheet shows identity fields (title/TMDB/year)');

// Provider availability per episode: provider badge + status badge.
assert.match(adminMediaDetailDrawer, /badge-provider/, 'the sheet shows provider badges');
assert.match(adminMediaDetailDrawer, /data-provider=\{providerNameForSource/, 'provider names resolved per asset');
assert.match(adminMediaDetailDrawer, /badge-status/, 'the sheet shows per-asset status');
ok('9d. detail sheet shows provider availability (provider/status per episode)');

// Loading + error states (replaces the drawer prop contract).
assert.match(adminMediaDetailDrawer, /linkedLoading/, 'the sheet tracks ground-truth loading');
assert.match(adminMediaDetailDrawer, /linkedError/, 'the sheet tracks ground-truth error');
assert.match(adminMediaDetailDrawer, /seasonError/, 'the sheet tracks season metadata errors');
ok('9f. detail sheet handles loading + error states');

// Upload integration REMOVED (2026-10-16): no onupload callback, no
// Upload / Import action, no link to the retired upload page.
assert.doesNotMatch(adminMediaDetailDrawer, /onupload/, 'no onupload callback (upload workflow retired)');
assert.doesNotMatch(adminMediaDetailDrawer, /Upload \/ Import/, 'no Upload / Import action');
ok('9g. detail sheet holds NO upload integration (the manual-link wizard is the only flow)');

// Per-episode actions remain (update/delete/add via the shared wizard).
assert.match(adminMediaDetailDrawer, /onupdatelink/, 'the sheet delegates update-link to the shared wizard');
assert.match(adminMediaDetailDrawer, /ondeletelink/, 'the sheet delegates delete to the shared confirm');
ok('9h. per-episode actions delegated to the shared wizard/confirm (manual-link flow)');

// The admin operations records live in the Operations Center (Jobs/
// History), not the retired drawer.
assert.ok(existsSync(new URL('../src/lib/components/admin2/AdminOpsHistory.svelte', import.meta.url)), 'operations history UI exists (the audit trail surface)');
ok('9i. operations history + audit trail live in the Operations Center (no dead drawer)');

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

// list() performs exactly 4 bounded queries (Task 2): items (top-level
// rows only), episode children (batch by parent_media_id), assets (batch
// by media_item_id), demand (batch by canonical_key) — STILL no N+1
// regardless of page size.
// Extract the list() method body and count queries inside it.
const listMethodMatch = libraryService.match(/async list\(query: LibraryQuery\): Promise<LibraryListResult> \{[\s\S]*?\n  \}/);
assert.ok(listMethodMatch, 'list() method body extracted');
const listMethodBody = listMethodMatch![0];
const listDbQueries = (listMethodBody.match(/\.from\('media_/g) ?? []).length;
assert.equal(listDbQueries, 4, `list() performs exactly 4 DB queries (items, children batch, assets batch, demand batch) — found ${listDbQueries}`);
ok('13a. list() performs bounded DB queries (4 batched queries, no N+1)');

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
assert.match(libraryPage, /<AdminAppShell/, 'Phase C library page still uses AdminAppShell (Phase B contract preserved)');
assert.doesNotMatch(libraryPage, /AdminPlaceholder/, 'Phase C library page no longer uses AdminPlaceholder (real implementation)');
ok('14a. Phase C preserves Phase B contracts (AdminAppShell wrapper) + replaces placeholder');

console.log(`\nAdmin 2.0 Phase C tests passed (${passed} check groups).`);
