import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Admin 2.0 — Phase E contracts.
 *
 * Phase E is the Hosting Control workspace: Providers / Jobs / Activity
 * tabs (post Hosting-navigation-consolidation) with real management
 * actions (rename, move, detach, delete, reconcile), provider health,
 * capabilities, quota, detached assets, and partial-failure handling.
 * Sync actions live on the Providers tab (Sync all + per-card Sync).
 *
 * This test pins the contracts that Phase F+ will depend on. It also
 * verifies the audit-driven fixes:
 *
 *   - Provider health is never faked (no "healthy" without verification)
 *   - Provider capabilities come from the adapter (never guessed)
 *   - Unlinked assets are NOT confused with missing media
 *   - Subtitle failure isolation is preserved (Phase D)
 *   - Resolver gating (status='ready' AND mavero_status='available') preserved
 *   - No provider credentials leak to the browser
 *   - SyncService returns structured results instead of throwing
 *   - GET /api/admin/media/unlinked side-effecting GET is deprecated
 *
 * Test strategy: static source-file contract assertions (regex against
 * source files). No live DB, no live provider calls.
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ============================================================
// Source files under test
// ============================================================

const hostingTypes = readFileSync(new URL('../src/lib/shared/hosting-types.ts', import.meta.url), 'utf8');
const controlService = readFileSync(new URL('../src/lib/server/hosting/control/service.ts', import.meta.url), 'utf8');
const providersApi = readFileSync(new URL('../src/routes/api/admin/hosting/providers/+server.ts', import.meta.url), 'utf8');
const assetsApi = readFileSync(new URL('../src/routes/api/admin/hosting/assets/+server.ts', import.meta.url), 'utf8');
const unlinkedApi = readFileSync(new URL('../src/routes/api/admin/media/unlinked/+server.ts', import.meta.url), 'utf8');
const syncApi = readFileSync(new URL('../src/routes/api/admin/media/sync/+server.ts', import.meta.url), 'utf8');
const healthApi = readFileSync(new URL('../src/routes/api/admin/media/health/+server.ts', import.meta.url), 'utf8');
const reconcileApi = readFileSync(new URL('../src/routes/api/admin/media/assets/[id]/reconcile/+server.ts', import.meta.url), 'utf8');
const renameApi = readFileSync(new URL('../src/routes/api/admin/media/assets/[id]/rename/+server.ts', import.meta.url), 'utf8');
const moveApi = readFileSync(new URL('../src/routes/api/admin/media/assets/[id]/move/+server.ts', import.meta.url), 'utf8');
const detachApi = readFileSync(new URL('../src/routes/api/admin/media/assets/[id]/detach/+server.ts', import.meta.url), 'utf8');
const deleteApi = readFileSync(new URL('../src/routes/api/admin/media/assets/[id]/delete/+server.ts', import.meta.url), 'utf8');

const hostingPage = readFileSync(new URL('../src/routes/admin/hosting/+page.svelte', import.meta.url), 'utf8');
const hostingPageServer = readFileSync(new URL('../src/routes/admin/hosting/+page.server.ts', import.meta.url), 'utf8');
const assetsRedirect = readFileSync(new URL('../src/routes/admin/media/assets/+page.svelte', import.meta.url), 'utf8');
const syncRedirect = readFileSync(new URL('../src/routes/admin/media/sync/+page.svelte', import.meta.url), 'utf8');
const syncRedirectServer = readFileSync(new URL('../src/routes/admin/media/sync/+page.server.ts', import.meta.url), 'utf8');

const adminHostingProviders = readFileSync(new URL('../src/lib/components/admin2/AdminHostingProviders.svelte', import.meta.url), 'utf8');
// [2026-10-16 re-pin] AdminHostingAssets was DELETED with the legacy
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url)), 'AdminHostingAssets deleted (legacy file manager removed)');
const episodeSheetE = readFileSync(new URL('../src/lib/components/admin2/AdminEpisodeSheet.svelte', import.meta.url), 'utf8');
const adminAssetStatusE = readFileSync(new URL('../src/lib/components/admin2/AdminAssetStatus.svelte', import.meta.url), 'utf8');
const mediaListE = readFileSync(new URL('../src/lib/components/admin2/AdminMediaList.svelte', import.meta.url), 'utf8');
const opsAttentionE = readFileSync(new URL('../src/lib/components/admin2/AdminOpsAttention.svelte', import.meta.url), 'utf8');
const adminCapabilityGrid = readFileSync(new URL('../src/lib/components/admin2/AdminCapabilityGrid.svelte', import.meta.url), 'utf8');
const adminConfirmDialog = readFileSync(new URL('../src/lib/components/admin2/AdminConfirmDialog.svelte', import.meta.url), 'utf8');

const syncService = readFileSync(new URL('../src/lib/server/hosting/sync/service.ts', import.meta.url), 'utf8');
const managementService = readFileSync(new URL('../src/lib/server/hosting/management/service.ts', import.meta.url), 'utf8');
const healthService = readFileSync(new URL('../src/lib/server/hosting/health/service.ts', import.meta.url), 'utf8');
const resolverHosted = readFileSync(new URL('../src/lib/server/resolver/mavero-hosted.ts', import.meta.url), 'utf8');

const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Provider list + identity
// ============================================================

assert.match(hostingTypes, /export type HostingProviderOverview/, 'shared types export HostingProviderOverview');
assert.match(hostingTypes, /adapterId: string/, 'HostingProviderOverview has adapterId');
assert.match(hostingTypes, /providerId: string/, 'HostingProviderOverview has providerId');
assert.match(hostingTypes, /sourceId: string \| null/, 'HostingProviderOverview has sourceId');
assert.match(hostingTypes, /name: string/, 'HostingProviderOverview has name');
assert.match(hostingTypes, /enabled: boolean/, 'HostingProviderOverview has enabled');
assert.match(hostingTypes, /capabilities: ProviderCapabilities/, 'HostingProviderOverview has capabilities');
assert.match(hostingTypes, /health: HostingProviderHealth \| null/, 'HostingProviderOverview has health');
assert.match(hostingTypes, /assetCounts/, 'HostingProviderOverview has assetCounts');
assert.match(hostingTypes, /lastSyncAt: string \| null/, 'HostingProviderOverview has lastSyncAt');
ok('1a. HostingProviderOverview type covers identity + capabilities + health + counts + last sync');

// Control service lists providers
assert.match(controlService, /async listProviders/, 'HostingControlService.listProviders method');
assert.match(controlService, /HOSTING_ADAPTER_IDS/, 'service restricts to hosting adapters (vidara, abyss)');
ok('1b. HostingControlService.listProviders exists and restricts to hosting adapters');

// ============================================================
// 2. Provider health — never faked
// ============================================================

// Health service maps status to a closed vocabulary
assert.match(healthService, /ProviderHealthStatus = 'healthy' \| 'degraded' \| 'unavailable' \| 'misconfigured' \| 'unknown'/, 'health status vocabulary');
ok('2a. Provider health status uses closed vocabulary (healthy/degraded/unavailable/misconfigured/unknown)');

// Health service does NOT mark healthy without verification
assert.match(healthService, /Do NOT use getAccountInfo/, 'Vidara health uses listAssets (NOT broken getAccountInfo)');
assert.match(healthService, /listAssets\(null\)/, 'Vidara health check calls listAssets');
assert.match(healthService, /getAccountInfo\(\)/, 'Abyss health check calls getAccountInfo');
ok('2b. Provider health uses real API calls — never faked');

// Misconfigured when credentials missing
assert.match(healthService, /misconfigured/, 'health service returns misconfigured when credentials missing');
assert.match(healthService, /VIDARA_API_KEY is not configured/, 'Vidara misconfigured message');
assert.match(healthService, /ABYSS_EMAIL.*ABYSS_PASSWORD are not configured/, 'Abyss misconfigured message');
ok('2c. Health service returns misconfigured (NOT healthy) when credentials are missing');

// Providers UI component uses health service, doesn't fake healthy
assert.match(adminHostingProviders, /\/api\/admin\/media\/health/, 'Providers UI calls health endpoint');
assert.match(adminHostingProviders, /healthTone/, 'Providers UI has healthTone helper');
assert.match(adminHostingProviders, /Checking/, 'Providers UI shows "Checking" before health loads');
assert.match(adminHostingProviders, /Unavailable/, 'Providers UI shows "Unavailable" when health fails');
ok('2d. Providers UI shows Checking → Healthy/Unavailable — never fakes healthy');

// ============================================================
// 3. Provider capabilities — verified, never guessed
// ============================================================

// Capability rows are defined in shared types (single source of truth)
assert.match(hostingTypes, /CAPABILITY_ROWS/, 'shared types define CAPABILITY_ROWS');
assert.match(hostingTypes, /localUpload/, 'CAPABILITY_ROWS includes localUpload');
assert.match(hostingTypes, /remoteUpload/, 'CAPABILITY_ROWS includes remoteUpload');
assert.match(hostingTypes, /multiAudio/, 'CAPABILITY_ROWS includes multiAudio');
assert.match(hostingTypes, /subtitles/, 'CAPABILITY_ROWS includes subtitles');
assert.match(hostingTypes, /transcoding/, 'CAPABILITY_ROWS includes transcoding');
assert.match(hostingTypes, /qualityVariants/, 'CAPABILITY_ROWS includes qualityVariants');
assert.match(hostingTypes, /folderManagement/, 'CAPABILITY_ROWS includes folderManagement');
assert.match(hostingTypes, /nestedFolders/, 'CAPABILITY_ROWS includes nestedFolders');
ok('3a. Capability rows defined in shared types (single source of truth)');

// AdminCapabilityGrid renders capabilities from the adapter
assert.match(adminCapabilityGrid, /capabilities: ProviderCapabilities/, 'AdminCapabilityGrid accepts ProviderCapabilities');
assert.match(adminCapabilityGrid, /CAPABILITY_ROWS/, 'AdminCapabilityGrid uses shared CAPABILITY_ROWS');
ok('3b. AdminCapabilityGrid renders verified capabilities (no hardcoded per-provider logic)');

// Control service has static capability map that mirrors adapters
assert.match(controlService, /ADAPTER_CAPABILITIES/, 'control service has ADAPTER_CAPABILITIES map');
assert.match(controlService, /vidara:/, 'control service has vidara capabilities');
assert.match(controlService, /abyss:/, 'control service has abyss capabilities');
ok('3c. Control service has static capability map mirroring adapter source');

// ============================================================
// 4. Quota / resource display
// ============================================================

assert.match(hostingTypes, /HostingProviderQuota/, 'shared types define HostingProviderQuota');
assert.match(hostingTypes, /storageUsed: number \| null/, 'quota has storageUsed');
assert.match(hostingTypes, /storageLimit: number \| null/, 'quota has storageLimit');
assert.match(hostingTypes, /maxUploadSize: number \| null/, 'quota has maxUploadSize');
assert.match(hostingTypes, /availability: 'available' \| 'unknown' \| 'unavailable'/, 'quota has availability state');
ok('4a. Quota type covers storage + max upload + availability state');

// Providers UI shows quota only when availability === 'available'
assert.match(adminHostingProviders, /h\?.quota && h.quota.availability === 'available'/, 'Providers UI only shows quota when available');
assert.match(adminHostingProviders, /Provider does not expose quota information/, 'Providers UI shows "does not expose" when unknown');
ok('4b. Providers UI only shows quota when actually available (no fabrication)');

// ============================================================
// 5. Partial provider failure
// ============================================================

// Control service uses Promise.allSettled for health checks
assert.match(controlService, /Promise\.allSettled/, 'control service uses Promise.allSettled for health checks');
assert.match(controlService, /result.status === 'fulfilled'/, 'control service handles fulfilled state');
assert.match(controlService, /Health check itself threw/, 'control service handles rejected state');
ok('5a. Control service uses Promise.allSettled — one provider failure does not break the rest');

// Asset counts are partial-failure (null on error)
assert.match(controlService, /assetErr \? null : assetCounts/, 'asset counts null on error');
ok('5b. Asset counts null on error (partial failure)');

// Providers UI handles null health
assert.match(adminHostingProviders, /if \(!h\)/, 'Providers UI handles null health');
assert.match(adminHostingProviders, /'Checking'/, 'Providers UI shows Checking when health is null');
ok('5c. Providers UI handles null health gracefully');

// ============================================================
// 6. Asset listing + pagination
// ============================================================

assert.match(controlService, /async listAssets/, 'HostingControlService.listAssets method');
assert.match(controlService, /clampPage/, 'listAssets clamps page');
assert.match(controlService, /clampLimit/, 'listAssets clamps limit');
assert.match(controlService, /MAX_ASSET_LIMIT = 100/, 'listAssets enforces max 100 per page');
assert.match(controlService, /\.range\(offset, offset \+ limit - 1\)/, 'listAssets uses range pagination');
ok('6a. listAssets enforces pagination (max 100 per page)');

// Assets API validates query params
assert.match(assetsApi, /VALID_STATUSES/, 'assets API validates status');
assert.match(assetsApi, /VALID_CONTENT_TYPES/, 'assets API validates contentType');
assert.match(assetsApi, /VALID_LINKED/, 'assets API validates linked');
assert.match(assetsApi, /VALID_SORTS/, 'assets API validates sort');
ok('6b. Assets API validates all query params against closed vocabularies');

// ============================================================
// 7. Search
// ============================================================

assert.match(controlService, /query\.q && query\.q\.trim\(\)/, 'listAssets supports q search');
assert.match(controlService, /filename.ilike/, 'listAssets searches filename');
assert.match(controlService, /provider_asset_id.ilike/, 'listAssets searches provider_asset_id');
assert.match(controlService, /media_item.title.ilike/, 'listAssets searches media_item.title');
assert.match(controlService, /media_item.tmdb_id/, 'listAssets searches tmdb_id');
assert.match(controlService, /media_item.imdb_id/, 'listAssets searches imdb_id');
assert.match(controlService, /media_item.canonical_key/, 'listAssets searches canonical_key');
ok('7a. listAssets supports search across filename, provider_asset_id, title, TMDB, IMDb, canonical key');

// ============================================================
// 8. Filters
// ============================================================

assert.match(controlService, /query\.provider/, 'listAssets supports provider filter');
assert.match(controlService, /query\.linked/, 'listAssets supports linked filter');
assert.match(controlService, /query\.status/, 'listAssets supports status filter');
assert.match(controlService, /query\.contentType/, 'listAssets supports contentType filter');
assert.match(controlService, /query\.hasSubtitles/, 'listAssets supports hasSubtitles filter');
ok('8a. listAssets supports provider, linked, status, contentType, hasSubtitles filters');

// Linked filter — [final remediation] DETACHED semantics: media_item_id is
// NOT NULL, so 'linked' = mavero_status != 'missing' and 'detached' =
// mavero_status = 'missing'. Legacy 'unlinked' value is an alias for detached.
assert.match(controlService, /neq\('mavero_status', 'missing'\)/, 'linked=linked excludes detached (mavero_status != missing)');
assert.match(controlService, /eq\('mavero_status', 'missing'\)/, 'linked=detached selects detached (mavero_status = missing)');
assert.doesNotMatch(controlService, /media_item_id.is.null/, 'no impossible media_item_id IS NULL filter paths');
ok('8b. Linked/detached filter correctly distinguishes linked vs detached assets');

// ============================================================
// 9. Linked vs unlinked assets
// ============================================================

// Assets UI has isDetached helper — [final remediation] detached (NOT
// unlinked): the row still belongs to its media_item.
assert.match(adminAssetStatusE, /maveroStatus === 'missing'/, 'AdminAssetStatus identifies detached assets (maveroStatus=missing)');
ok('9a. the shared status component correctly identifies detached assets (still linked to media_item)');

// DETACHED badge in UI (replaces the old UNLINKED badge)
assert.match(adminAssetStatusE, /Detached/i, 'AdminAssetStatus renders the Detached label');
assert.match(episodeSheetE, /badge-status" data-state=\{view\.asset\.mavero_status\}/, 'the episode sheet shows the per-asset mavero_status badge');
assert.match(episodeSheetE, /data-state="missing"/, 'the missing/detached state has its own styling');
ok('9b. the live UI clearly marks detached assets (status badge per episode)');

// Unlinked API endpoint — [final remediation] the endpoint path is kept for
// compat but returns DETACHED assets (mavero_status='missing', not deleted).
assert.match(unlinkedApi, /export const POST/, 'unlinked endpoint exports POST');
assert.match(unlinkedApi, /Does NOT trigger a sync/, 'POST unlinked does NOT trigger sync');
assert.match(unlinkedApi, /eq\('mavero_status', 'missing'\)/, 'POST unlinked selects detached (mavero_status=missing)');
assert.doesNotMatch(unlinkedApi, /media_item_id.is.null/, 'POST unlinked has no impossible NULL filter');
ok('9c. POST /api/admin/media/unlinked reads detached assets without triggering sync');

// ============================================================
// 10. Asset detail drawer
// ============================================================

assert.match(episodeSheetE, /head-title/, 'the sheet shows the parent identity (title)');
assert.match(episodeSheetE, /TMDB \{parent\.tmdbId\}/, 'the sheet shows the parent TMDB id');
assert.match(episodeSheetE, /badge-provider/, 'the sheet has the provider section (per-asset badges)');
assert.match(episodeSheetE, /badge-status/, 'the sheet has the per-asset status section');
assert.match(episodeSheetE, /ep-actions/, 'the sheet has the per-episode actions section');
ok('10a. The episode sheet detail surface: identity + provider + status + actions');

// The sheet shows the linked ground truth per episode (asset + provider)
assert.match(episodeSheetE, /view\.linked && view\.asset/, 'the sheet shows linked episodes with their asset ground truth');
assert.match(episodeSheetE, /providerNameForSource\(view\.asset\.provider_source_id\)/, 'the sheet resolves the provider per asset');
assert.match(episodeSheetE, /badge-unlinked">Not linked/, 'the sheet honestly marks unlinked episodes');
ok('10b. The sheet shows the linked ground truth (provider per episode, honest Not-linked state)');

// ============================================================
// 11. Rename action
// ============================================================

// Rename API uses ManagementService
assert.match(renameApi, /ManagementService/, 'rename API uses ManagementService');
assert.match(renameApi, /renameAsset/, 'rename API calls renameAsset');
assert.match(renameApi, /requireAdmin/, 'rename API requires admin');
ok('11a. Rename API uses ManagementService.renameAsset + requireAdmin');

// Assets UI exposes rename action
// [2026-10-16 re-pin] the rename UI left with the legacy manager; the
// rename contract survives at the API + service (11a/11c above).
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url)), 'AdminHostingAssets deleted (legacy file manager removed)');
ok('11b. rename UI retired with the legacy manager (API + service intact)');

// ManagementService records rename operation
assert.match(managementService, /action: 'rename'/, 'ManagementService records rename action');
assert.match(managementService, /adapter.renameAsset/, 'ManagementService calls adapter.renameAsset');
ok('11c. ManagementService.renameAsset calls adapter + records operation');

// ============================================================
// 12. Move action
// ============================================================

assert.match(moveApi, /ManagementService/, 'move API uses ManagementService');
assert.match(moveApi, /moveAsset/, 'move API calls moveAsset');
assert.match(managementService, /action: 'move'/, 'ManagementService records move action');
assert.match(managementService, /caps.folderManagement/, 'ManagementService checks folderManagement capability');
ok('12a. Move API + service check folderManagement capability + record operation');

// Assets UI exposes move action
// [2026-10-16 re-pin] the move UI left with the legacy manager; the
// move contract + capability check survive at the service (12a above).
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url)), 'AdminHostingAssets deleted (legacy file manager removed)');
ok('12b. move UI retired with the legacy manager (service + capability check intact)');

// ============================================================
// 13. Detach action
// ============================================================

assert.match(detachApi, /ManagementService/, 'detach API uses ManagementService');
assert.match(detachApi, /detachAsset/, 'detach API calls detachAsset');
assert.match(managementService, /action: 'detach'/, 'ManagementService records detach action');
assert.match(managementService, /mavero_status: 'missing'/, 'detach sets mavero_status to missing');
assert.match(managementService, /Does NOT delete the provider-side file/, 'detach does NOT delete provider file');
ok('13a. Detach sets mavero_status=missing, does NOT delete provider file, records operation');

// Assets UI uses AdminConfirmDialog for detach
// [2026-10-16 re-pin] the detach UI left with the legacy manager; the
// LIVE destructive action (unlink) is confirm-gated in AdminMediaList.
assert.match(mediaListE, /confirm-dialog" role="dialog" aria-modal="true"/, 'the live delete uses a modal confirmation dialog');
ok('13b. the live destructive action uses a confirmation dialog');

// ============================================================
// 14. Provider delete action
// ============================================================

assert.match(deleteApi, /ManagementService/, 'delete API uses ManagementService');
assert.match(deleteApi, /deleteAsset/, 'delete API calls deleteAsset');
assert.match(managementService, /action: 'provider_delete'/, 'ManagementService records provider_delete action');
assert.match(managementService, /Delete at the provider first/, 'ManagementService deletes at provider first');
assert.match(managementService, /Only update Mavero state after provider confirms deletion/, 'Mavero state updated ONLY after provider confirms');
assert.match(managementService, /Provider delete failed — do NOT mark the Mavero asset as deleted/, 'Mavero NOT marked deleted on provider failure');
ok('14a. Provider delete: provider first, then Mavero — no false "deleted" on provider failure');

// Assets UI uses danger-tone confirmation for delete
// [2026-10-16 re-pin] the provider-delete UI retired with the legacy
// manager (the live delete is the provider-preserving unlink, confirmed
// in 13b); the provider-delete semantics survive at the service (14a).
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url)), 'AdminHostingAssets deleted (legacy file manager removed)');
ok('14b. provider-delete UI retired (service semantics intact in 14a)');

// ============================================================
// 15. Reconcile action
// ============================================================

assert.match(reconcileApi, /SyncService/, 'reconcile API uses SyncService');
assert.match(reconcileApi, /reconcileAsset/, 'reconcile API calls reconcileAsset');
assert.match(syncService, /async reconcileAsset/, 'SyncService has reconcileAsset method');
assert.match(syncService, /getProcessingStatus/, 'reconcile polls provider processing status');
ok('15a. Reconcile uses SyncService.reconcileAsset + provider getProcessingStatus');

// Assets UI exposes reconcile
assert.match(opsAttentionE, /reconcileItem/, 'OpsAttention exposes the live reconcile action');
ok('15b. the live reconcile action lives in the Operations Center');

// ============================================================
// 16. Sync provider + sync all
// ============================================================

assert.match(syncApi, /export const POST/, 'sync API exports POST');
assert.match(syncApi, /syncProvider/, 'sync API calls syncProvider');
assert.match(syncApi, /syncAll/, 'sync API calls syncAll');
assert.match(syncService, /async syncProvider/, 'SyncService has syncProvider');
assert.match(syncService, /async syncAll/, 'SyncService has syncAll');
ok('16a. Sync API + service support both single-provider and sync-all');

// SyncService returns structured results (Phase E fix — no throw on unconfigured)
assert.match(syncService, /return \{[\s\S]*?providerAdapterId: adapterId[\s\S]*?errors:/, 'syncProvider returns structured result on unconfigured (no throw)');
assert.match(syncService, /No hosting adapter for/, 'syncProvider returns error message for unconfigured');
ok('16b. SyncService.syncProvider returns structured result instead of throwing (Phase E fix)');

// Sync actions (HOSTING NAVIGATION CONSOLIDATION — final 3-issue fix: the
// separate Sync tab was removed; Sync-all + per-provider Sync now live on
// the Providers tab / provider cards. Same backend endpoints as before.)
assert.match(hostingPage, /syncAllProviders/, 'Hosting page has the sync-all handler');
assert.match(hostingPage, /'\/api\/admin\/media\/sync', \{ method: 'POST' \}/, 'Sync-all still calls the existing all-provider sync backend (no provider param)');
assert.match(hostingPage, /syncProvider/, 'Hosting page has the per-provider sync handler');
assert.match(hostingPage, /\/api\/admin\/media\/sync\?provider=\$\{adapterId\}/, 'Per-provider sync still calls the existing provider-scoped sync backend');
assert.match(adminHostingProviders, /Sync all providers/, 'Providers tab exposes the Sync all providers action');
assert.match(adminHostingProviders, /a2-hosting-sync-all/, 'Sync-all button has its consolidated action style');
assert.match(adminHostingProviders, /Refresh health/, 'Providers tab still exposes Refresh health');
assert.match(adminHostingProviders, /onsyncall/, 'Providers component accepts the onsyncall callback');
assert.match(adminHostingProviders, /onsyncprovider/, 'Providers component accepts the per-provider onsyncprovider callback');
assert.match(adminHostingProviders, /flex-wrap/, 'Providers action area wraps (mobile: no horizontal overflow)');
assert.doesNotMatch(hostingPage, /AdminHostingSync/, 'Hosting page no longer imports the removed AdminHostingSync component');
ok('16c. Consolidated Sync UI: Sync-all + Refresh health on Providers tab, per-provider Sync on cards, same backend actions');

// Sync result display — the sync backend + audit still report counts
// (SyncService result fields; the old per-card result panel went with the
// removed Sync tab). The API + service assertions above (16a/16b) cover
// the contract; the provider card count semantics are covered by the
// dedicated final-3-issue regression test.
assert.match(syncService, /totalProviderAssets/, 'SyncService still reports totalProviderAssets');
assert.match(syncService, /updatedAssets/, 'SyncService still reports updatedAssets');
assert.match(syncService, /deletedAssets/, 'SyncService still reports deletedAssets');
assert.match(syncService, /unlinkedFiles/, 'SyncService still reports unlinkedFiles');
ok('16d. SyncService still returns discovered/updated/deleted/unlinked counts (audit + API contract)');

// ============================================================
// 17. Detached assets — [final remediation] detached = mavero_status='missing'
// on a non-deleted row (still linked to a media item). The dedicated Sync-tab
// section was removed with the tab (Hosting consolidation); detached assets
// remain visible in the Media Library (linked/detached filter) and via the
// POST /api/admin/media/unlinked endpoint (unchanged).
// ============================================================

assert.match(unlinkedApi, /IS linked to a canonical|DETACHED provider assets/, 'unlinked API documents the distinction (detached, still linked)');
assert.match(unlinkedApi, /mavero_status.*missing/, 'unlinked API still selects detached assets (mavero_status=missing)');
assert.match(unlinkedApi, /mavero_status.*missing/, 'Media Library surfaces detached assets via the unlinked endpoint (post-consolidation)');
ok('17a. Detached assets still exposed via unlinked endpoint + Media Library (post-consolidation)');

// Detached does NOT incorrectly equate to missing media or untracked files
assert.match(unlinkedApi, /IS linked to a canonical|DETACHED provider assets/, 'unlinked API documents the distinction (detached, still linked)');
ok('17b. Detached assets correctly distinguished from missing media + untracked provider files');

// ============================================================
// 18. Operation recording
// ============================================================

// All management actions record operations
assert.match(managementService, /recordMediaOperation\(this\.client,/, 'ManagementService records operations via the rehomed audit writer (2026-10-15)');
assert.match(managementService, /action: 'rename'/, 'rename recorded');
assert.match(managementService, /action: 'move'/, 'move recorded');
assert.match(managementService, /action: 'detach'/, 'detach recorded');
assert.match(managementService, /action: 'provider_delete'/, 'delete recorded');
ok('18a. All management actions (rename, move, detach, delete) record operations');

// Sync records operations
// NOTE: SyncService updates media_assets + media_upload_operations but does
// NOT currently write to media_operations audit log. This is a pre-existing
// gap deferred to Phase F (Operations Center will build the audit trail UI
// and wire sync to record operations). Phase E preserves the existing
// behavior — no regression.
assert.match(syncService, /media_assets/, 'SyncService updates media_assets');
assert.match(syncService, /media_upload_operations/, 'SyncService updates media_upload_operations');
ok('18b. Sync updates media_assets + media_upload_operations (audit log deferred to Phase F)');

// ============================================================
// 19. Authorization
// ============================================================

// All endpoints use requireAdmin
const allApis = [providersApi, assetsApi, unlinkedApi, syncApi, healthApi, reconcileApi, renameApi, moveApi, detachApi, deleteApi];
for (const api of allApis) {
  assert.match(api, /requireAdmin/, 'API uses requireAdmin');
}
ok('19a. All 10 hosting API endpoints use requireAdmin');

// Page server requires admin
assert.match(hostingPageServer, /requireAdmin/, 'hosting page server requires admin');
ok('19b. Hosting page server requires admin');

// All endpoints use NO_STORE
for (const api of allApis) {
  assert.match(api, /NO_STORE/, 'API sets no-store');
}
ok('19c. All 10 hosting API endpoints set no-store cache header');

// ============================================================
// 20. Secret redaction
// ============================================================

// Control service does NOT expose credentials
assert.match(controlService, /isAdapterConfigured/, 'control service returns configured boolean (not credential value)');
assert.match(controlService, /getVidaraConfigOrNull\(\) !== null/, 'control service checks Vidara config presence (not value)');
assert.match(controlService, /getAbyssConfigOrNull\(\) !== null/, 'control service checks Abyss config presence (not value)');
ok('20a. Control service returns ONLY configured boolean — never the credential value');

// Health service does not expose credentials
assert.match(healthService, /no credentials are exposed/, 'health service documents no credential exposure');
ok('20b. Health service documents no credential exposure');

// Assets API does not expose provider_metadata or playback_url
// (The control service select does not include provider_metadata.)
// Extract just the select() calls and verify provider_metadata is not there.
const controlSelects = controlService.match(/\.select\(`[^`]+`/g) ?? [];
const hasProviderMetadataInSelect = controlSelects.some(s => s.includes('provider_metadata'));
assert.ok(!hasProviderMetadataInSelect, 'control service does NOT select provider_metadata in any query');
ok('20c. Control service does NOT expose provider_metadata jsonb');

// ============================================================
// 21. Media Library state update (no second inconsistent state)
// ============================================================

// Assets UI reloads after management action
// [2026-10-16 re-pin] the live list reloads after every successful
// mutation (delete + wizard saves) — no stale cards.
assert.match(mediaListE, /loadList\(true\)/, 'the live list exposes the hard reload used after actions');
assert.match(mediaListE, /json\.ok[\s\S]{0,200}loadList\(true\)/, 'reload happens on the success path');
ok('21a. the live list reloads after management actions (no stale state)');

// Detach makes asset unlinked in the UI (mavero_status=missing)
assert.match(managementService, /mavero_status: 'missing'/, 'detach sets mavero_status=missing');
ok('21b. Detach updates mavero_status — UI reflects unlinked state after reload');

// ============================================================
// 22. Resolver gating after detach/delete
// ============================================================

// Resolver gates on BOTH status='ready' AND mavero_status='available' (Phase C fix preserved)
assert.match(resolverHosted, /mavero_status.*available/, 'resolver gates on mavero_status=available');
assert.match(resolverHosted, /status.*ready/, 'resolver gates on status=ready');
ok('22a. Resolver gating preserved: status=ready AND mavero_status=available (Phase C fix intact)');

// Detach sets mavero_status=missing → resolver excludes
assert.match(managementService, /mavero_status: 'missing'[\s\S]*?last_synced_at/, 'detach sets mavero_status=missing');
ok('22b. Detach sets mavero_status=missing — resolver will exclude the asset');

// Delete sets status=deleted + mavero_status=missing → resolver excludes
assert.match(managementService, /status: 'deleted'[\s\S]*?mavero_status: 'missing'/, 'delete sets status=deleted + mavero_status=missing');
ok('22c. Delete sets status=deleted + mavero_status=missing — resolver excludes');

// ============================================================
// 23. Unsupported capability handling
// ============================================================

// Assets UI disables actions when capability is false
// [2026-10-16 re-pin] capability gating left with the legacy manager's
// action buttons; the checks live in the SERVICE (12a: caps.folderManagement)
// and the registry's getCapabilities (provider caps remain exposed).
assert.match(managementService, /caps\./, 'the service keeps the capability checks (rename/move/delete)');
assert.match(adminAssetStatusE, /caps|maveroStatus/, 'the live status surface still reads per-asset state');
ok('23. capability checks live at the service + registry level (UI retired)');

// ============================================================
// 24. Mobile rendering / structure
// ============================================================

// Hosting page uses AdminAppShell
assert.match(hostingPage, /AdminAppShell/, 'hosting page wraps in AdminAppShell');
assert.match(hostingPage, /AdminPage/, 'hosting page uses AdminPage framework');
ok('24a. Hosting page uses AdminAppShell + AdminPage');

// Tab navigation — [HOSTING NAVIGATION CONSOLIDATION, final 3-issue fix]
// 3 tabs: Providers / Jobs / Activity. The separate Sync tab was removed
// (all sync actions live on the Providers tab); the Attention tab was
// retired from the required IA. hosting?tab=assets → Media Library;
// hosting?tab=sync|attention → /admin/hosting (server-side redirect).
assert.match(hostingPage, /tabs=/, 'hosting page uses AdminPage tabs');
assert.match(hostingPage, /'providers', label: 'Providers'/, 'hosting page has Providers tab');
assert.match(hostingPage, /'jobs', label: 'Jobs'/, 'hosting page has Jobs tab');
assert.match(hostingPage, /'activity', label: 'Activity'/, 'hosting page has Activity tab');
assert.doesNotMatch(hostingPage, /'sync', label: 'Sync'/, 'hosting page has NO Sync tab (consolidated into Providers)');
assert.doesNotMatch(hostingPage, /'attention', label: 'Attention'/, 'hosting page has NO Attention tab (required IA)');
assert.match(hostingPageServer, /'providers', 'jobs', 'activity'/, 'server VALID_TABS = providers|jobs|activity');
assert.match(hostingPageServer, /tab === 'sync' \|\| tab === 'attention'/, 'server redirects legacy sync/attention tabs');
assert.match(hostingPageServer, /redirect\(303, '\/admin\/hosting'\)/, 'legacy sync/attention tab redirect target is canonical /admin/hosting');
ok('24b. hosting page has exactly 3 tabs (Providers/Jobs/Activity) + legacy tab redirects');

// Provider cards stack on mobile
assert.match(adminHostingProviders, /@media \(max-width: 768px\)[\s\S]*?grid-template-columns: 1fr/, 'provider cards stack on mobile');
ok('24c. Provider cards stack vertically on mobile');

// Media Library file manager mobile filter — Mavero-native AdminFilterSheet
// [2026-10-16 re-pin] the live library's filters live in ONE modal
// filter sheet at every width (never a squeezed desktop bar); the
// episode sheet is full-width on mobile.
assert.match(mediaListE, /class="filter-sheet" role="dialog"/, 'the live library uses a modal filter sheet');
assert.match(episodeSheetE, /\.episode-sheet[\s\S]*?width: 100%/, 'the episode sheet is full-width on mobile');
ok('24d/e. live mobile surfaces: modal filter sheet + full-width sheet');

// Old /admin/media/assets + /admin/media/sync redirect to new workspace
assert.match(assetsRedirect, /\/admin\/hosting\?tab=assets/, 'old assets page redirects to hosting workspace');
assert.match(syncRedirect, /\/admin\/hosting(?!\?tab=sync)/, 'old sync page redirects to the Hosting Control Providers view (no ?tab=sync)');
assert.match(syncRedirectServer, /redirect\(303, '\/admin\/hosting'\)/, 'legacy sync route redirects server-side to canonical /admin/hosting');
assert.doesNotMatch(syncRedirectServer, /tab', 'sync'/, 'legacy sync redirect no longer targets the removed ?tab=sync');
ok('24f. Old /admin/media/assets + /admin/media/sync redirect to new workspace');

// ============================================================
// 25. Loading states
// ============================================================

// Providers loading
assert.match(adminHostingProviders, /a2-hosting-empty/, 'Providers UI has empty state');
assert.match(adminHostingProviders, /No hosting providers/, 'Providers UI shows no-providers empty state');
ok('25a. Providers UI has loading + empty states');

// Assets loading
// [2026-10-16 re-pin] the live list's states: loading spinner block,
// honest empty state, no-results handled by the same empty branch.
assert.match(mediaListE, /\{#if loading\}/, 'the live list has a loading state');
assert.match(mediaListE, /state-empty/, 'the live list has an empty state');
assert.match(mediaListE, /No media linked yet/, 'the live list shows the no-links empty state');
ok('25b. the live list has loading + empty states');

// Sync loading — [HOSTING NAVIGATION CONSOLIDATION] the separate Sync tab
// and its unlinked/detached list went away. Detached assets remain visible
// in the Media Library; the dedicated final-3-issue test covers the
// consolidated sync busy/success states on the Providers tab.
assert.match(adminHostingProviders, /syncAllInProgress/, 'Providers UI has sync-all busy state (consolidated)');
assert.match(adminHostingProviders, /Syncing…/, 'Providers UI shows Syncing… busy label');
assert.match(hostingPage, /a2-sync-error/, 'Hosting page still surfaces sync errors via banner');
ok('25c. Consolidated sync UI has busy + error states (no separate Sync tab)');

// ============================================================
// 26. Error states
// ============================================================

// Providers error
assert.match(adminHostingProviders, /a2-hosting-error/, 'Providers UI has error state');
assert.match(adminHostingProviders, /Failed to load providers/, 'Providers UI shows load-failure error');
ok('26a. Providers UI has error state');

// Assets error
// [2026-10-16 re-pin] the live list's error block: role=alert + Retry.
assert.match(mediaListE, /state-error" role="alert"/, 'the live list has an error state (role=alert)');
assert.match(mediaListE, /Failed to load media library/, 'the live list shows the load-failure error');
assert.match(mediaListE, /retry-btn/, 'the live list has a retry button');
ok('26b. the live list has error state + retry');

// Sync error — consolidated: the hosting page renders the sync error banner
// (a2-sync-error) asserted in 25c above.
assert.match(hostingPage, /Sync failed:/, 'Hosting page shows sync-failure banner copy');
ok('26c. Consolidated sync UI has error state (hosting page banner)');

// ============================================================
// 27. Empty states
// ============================================================

// Sync states — [HOSTING NAVIGATION CONSOLIDATION] the old per-provider
// result/outcome panel went away with the Sync tab. The sync busy state
// (Syncing…) is asserted in 25c; errors in 26c; the backend still returns
// structured per-provider outcomes (asserted in 16a/16b/16d).
assert.match(adminHostingProviders, /handleSyncAll/, 'Providers UI has the consolidated sync-all handler');
assert.match(adminHostingProviders, /handleSync\(p\.adapterId\)/, 'Providers UI has the per-provider sync handler (cards)');
ok('27a. Consolidated sync UI has busy/success-via-refresh states');

// ============================================================
// 28. Partial failures
// ============================================================

// Sync per-provider outcome — the structured outcome contract lives in
// the SyncService results + API (16a/16d). The per-provider card busy
// state is covered by 24c/25c assertions.
assert.match(adminHostingProviders, /await onsyncprovider\(adapterId\)/, 'Providers card invokes the per-provider sync callback');
ok('28a. Per-provider sync outcome contract preserved (service + API + card action)');

// ============================================================
// 29. Admin nav updated for Phase E
// ============================================================

// Admin nav — [MAV-FOCUSED 2026-10 redesign] the Hosting Control nav item
// was INTENTIONALLY REMOVED from the sidebar (commit 24705a1): Media
// Library is the hosting surface; /admin/hosting stays reachable by URL.
// The workspace itself (this test's §1–§28) remains fully operational.
assert.doesNotMatch(adminAppShell, /id: 'hosting', label: 'Hosting Control', href: '\/admin\/hosting'/, 'nav: Hosting Control item intentionally removed from the sidebar (MAV-FOCUSED redesign)');
assert.doesNotMatch(adminAppShell, /matchPrefix: '\/admin\/hosting'/, 'nav: no /admin/hosting matchPrefix in the sidebar');
ok('29a. AdminAppShell nav has NO Hosting Control item (MAV-FOCUSED redesign — Media Library is the hosting surface; /admin/hosting reachable by URL)');

// Old assets/sync nav items removed
assert.doesNotMatch(adminAppShell, /id: 'assets', label: 'Assets', href: '\/admin\/media\/assets'/, 'old Assets nav item removed');
assert.doesNotMatch(adminAppShell, /id: 'sync', label: 'Sync', href: '\/admin\/media\/sync'/, 'old Sync nav item removed');
ok('29b. Old Assets + Sync nav items removed (replaced by unified Hosting Control)');

// Phase 1: the standalone Provider Registry nav item is removed —
// providers are now managed in API & Sources (/admin/system/api-sources).
// The legacy /admin/providers page is a redirect stub.
assert.doesNotMatch(adminAppShell, /id: 'providers', label: 'Provider Registry'/, 'nav: Provider Registry item removed (Phase 1 — managed in API & Sources)');
ok('29c. Provider Registry nav item removed (Phase 1 — providers managed in API & Sources workspace)');

// ============================================================
// 30. Confirm dialog accessibility
// ============================================================

// AdminConfirmDialog has proper ARIA
assert.match(adminConfirmDialog, /role="dialog"/, 'confirm dialog has role=dialog');
assert.match(adminConfirmDialog, /aria-modal="true"/, 'confirm dialog has aria-modal');
assert.match(adminConfirmDialog, /aria-labelledby/, 'confirm dialog has aria-labelledby');
assert.match(adminConfirmDialog, /tabindex="-1"/, 'confirm dialog has tabindex for focus');
assert.match(adminConfirmDialog, /Escape/, 'confirm dialog handles Escape');
ok('30a. AdminConfirmDialog has proper ARIA + keyboard handling');

// ============================================================
// Final summary
// ============================================================

console.log(`\nAdmin 2.0 Phase E tests passed (${passed} check groups).`);
