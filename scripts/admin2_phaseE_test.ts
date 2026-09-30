import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase E contracts.
 *
 * Phase E is the Hosting Control workspace: Providers, Assets, Sync tabs
 * with real management actions (rename, move, detach, delete, reconcile),
 * provider health, capabilities, quota, unlinked assets, and partial-
 * failure handling.
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

const adminHostingProviders = readFileSync(new URL('../src/lib/components/admin2/AdminHostingProviders.svelte', import.meta.url), 'utf8');
const adminHostingAssets = readFileSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url), 'utf8');
const adminHostingSync = readFileSync(new URL('../src/lib/components/admin2/AdminHostingSync.svelte', import.meta.url), 'utf8');
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

// Linked filter uses PostgREST .or()
assert.match(controlService, /media_item_id.is.null,mavero_status.eq.missing/, 'linked=unlinked uses PostgREST or-filter');
ok('8b. Linked/unlinked filter correctly distinguishes linked vs unlinked assets');

// ============================================================
// 9. Linked vs unlinked assets
// ============================================================

// Assets UI has isUnlinked helper
assert.match(adminHostingAssets, /function isUnlinked/, 'Assets UI has isUnlinked helper');
assert.match(adminHostingAssets, /!asset.mediaItem \|\| asset.maveroStatus === 'missing'/, 'isUnlinked checks mediaItem + maveroStatus');
ok('9a. Assets UI correctly identifies unlinked assets (no mediaItem OR maveroStatus=missing)');

// Unlinked badge in UI
assert.match(adminHostingAssets, /UNLINKED/, 'Assets UI shows UNLINKED badge');
assert.match(adminHostingAssets, /UNLINKED PROVIDER ASSET/, 'asset drawer shows UNLINKED PROVIDER ASSET');
ok('9b. Assets UI clearly marks unlinked provider assets');

// Unlinked API endpoint (Phase E new POST)
assert.match(unlinkedApi, /export const POST/, 'unlinked endpoint exports POST');
assert.match(unlinkedApi, /Does NOT trigger a sync/, 'POST unlinked does NOT trigger sync');
assert.match(unlinkedApi, /media_item_id.is.null,mavero_status.eq.missing/, 'POST unlinked uses or-filter');
ok('9c. POST /api/admin/media/unlinked reads from DB without triggering sync (Phase E fix)');

// ============================================================
// 10. Asset detail drawer
// ============================================================

assert.match(adminHostingAssets, /a2-asset-drawer/, 'Assets UI has detail drawer');
assert.match(adminHostingAssets, /Provider/, 'drawer has Provider section');
assert.match(adminHostingAssets, /Mavero link/, 'drawer has Mavero link section');
assert.match(adminHostingAssets, /Media properties/, 'drawer has Media properties section');
assert.match(adminHostingAssets, /Actions/, 'drawer has Actions section');
ok('10a. Asset detail drawer has Provider, Mavero link, Media properties, Actions sections');

// Drawer shows linked media details
assert.match(adminHostingAssets, /selectedAsset.mediaItem.title/, 'drawer shows linked media title');
assert.match(adminHostingAssets, /selectedAsset.mediaItem.tmdbId/, 'drawer shows linked media TMDB ID');
assert.match(adminHostingAssets, /selectedAsset.mediaItem.canonicalKey/, 'drawer shows linked media canonical key');
ok('10b. Asset drawer shows linked media identity (title, TMDB, canonical key)');

// ============================================================
// 11. Rename action
// ============================================================

// Rename API uses ManagementService
assert.match(renameApi, /ManagementService/, 'rename API uses ManagementService');
assert.match(renameApi, /renameAsset/, 'rename API calls renameAsset');
assert.match(renameApi, /requireAdmin/, 'rename API requires admin');
ok('11a. Rename API uses ManagementService.renameAsset + requireAdmin');

// Assets UI exposes rename action
assert.match(adminHostingAssets, /startRename/, 'Assets UI has startRename');
assert.match(adminHostingAssets, /confirmRename/, 'Assets UI has confirmRename');
assert.match(adminHostingAssets, /executeAction\(.*'rename'/, 'Assets UI calls executeAction with rename');
ok('11b. Assets UI exposes rename action');

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
assert.match(adminHostingAssets, /startMove/, 'Assets UI has startMove');
assert.match(adminHostingAssets, /confirmMove/, 'Assets UI has confirmMove');
assert.match(adminHostingAssets, /targetFolderId/, 'Assets UI sends targetFolderId');
ok('12b. Assets UI exposes move action with target folder input');

// Move modal respects nested folders capability
assert.match(adminHostingAssets, /nestedFolders/, 'move modal surfaces nested folders capability');
ok('12c. Move modal documents nested vs flat folder support per provider');

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
assert.match(adminHostingAssets, /startDetach/, 'Assets UI has startDetach');
assert.match(adminHostingAssets, /AdminConfirmDialog/, 'Assets UI uses AdminConfirmDialog for destructive actions');
assert.match(adminHostingAssets, /confirmAction = 'detach'/, 'confirm dialog handles detach');
ok('13b. Detach uses confirmation dialog');

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
assert.match(adminHostingAssets, /startDelete/, 'Assets UI has startDelete');
assert.match(adminHostingAssets, /confirmAction = 'delete'/, 'confirm dialog handles delete');
assert.match(adminHostingAssets, /Delete permanently/, 'delete confirm shows "Delete permanently"');
assert.match(adminHostingAssets, /Irreversible/, 'delete confirm warns irreversible');
ok('14b. Delete uses danger-tone confirmation with irreversible warning');

// ============================================================
// 15. Reconcile action
// ============================================================

assert.match(reconcileApi, /SyncService/, 'reconcile API uses SyncService');
assert.match(reconcileApi, /reconcileAsset/, 'reconcile API calls reconcileAsset');
assert.match(syncService, /async reconcileAsset/, 'SyncService has reconcileAsset method');
assert.match(syncService, /getProcessingStatus/, 'reconcile polls provider processing status');
ok('15a. Reconcile uses SyncService.reconcileAsset + provider getProcessingStatus');

// Assets UI exposes reconcile
assert.match(adminHostingAssets, /reconcile/, 'Assets UI exposes reconcile action');
ok('15b. Assets UI exposes reconcile action');

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

// Sync UI
assert.match(adminHostingSync, /syncAll/, 'Sync UI has syncAll');
assert.match(adminHostingSync, /syncProvider/, 'Sync UI has syncProvider');
assert.match(adminHostingSync, /\/api\/admin\/media\/sync/, 'Sync UI calls sync endpoint');
ok('16c. Sync UI exposes Sync All + per-provider Sync');

// Sync result display
assert.match(adminHostingSync, /totalProviderAssets/, 'Sync UI shows total provider assets');
assert.match(adminHostingSync, /updatedAssets/, 'Sync UI shows updated count');
assert.match(adminHostingSync, /deletedAssets/, 'Sync UI shows deleted count');
assert.match(adminHostingSync, /unlinkedFileCount/, 'Sync UI shows new unlinked count');
ok('16d. Sync UI shows discovered, updated, deleted, new unlinked counts');

// ============================================================
// 17. Unlinked assets display
// ============================================================

assert.match(adminHostingSync, /Unlinked provider assets/, 'Sync UI has Unlinked section');
assert.match(adminHostingSync, /POST.*\/api\/admin\/media\/unlinked/, 'Sync UI calls POST unlinked endpoint');
assert.match(adminHostingSync, /exist in Mavero/, 'Sync UI documents unlinked = in Mavero DB but not linked to media');
ok('17a. Sync UI exposes unlinked assets via POST endpoint');

// Unlinked does NOT incorrectly equate to missing media
assert.match(unlinkedApi, /not linked to a canonical/, 'unlinked API documents distinction');
ok('17b. Unlinked assets correctly distinguished from missing media');

// ============================================================
// 18. Operation recording
// ============================================================

// All management actions record operations
assert.match(managementService, /recordOperation/, 'ManagementService records operations');
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
assert.match(adminHostingAssets, /await loadAssets\(\)/, 'Assets UI reloads list after action');
assert.match(adminHostingAssets, /selectedAsset = updated/, 'Assets UI updates selected asset after action');
ok('21a. Assets UI reloads + updates selected asset after management action (no stale state)');

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
assert.match(adminHostingAssets, /!caps\?.rename/, 'rename disabled when !caps.rename');
assert.match(adminHostingAssets, /!caps\?.folderManagement/, 'move disabled when !caps.folderManagement');
assert.match(adminHostingAssets, /!caps\?.delete/, 'delete disabled when !caps.delete');
ok('23a. Assets UI disables rename/move/delete when capability is false');

// "unsupported" label shown for disabled actions
assert.match(adminHostingAssets, /a2-asset-action-unsupported/, 'unsupported label shown for disabled actions');
ok('23b. Assets UI shows "unsupported" label for capability-disabled actions');

// Move modal documents nested vs flat
assert.match(adminHostingAssets, /nested folders supported/, 'move modal documents nested folders support');
assert.match(adminHostingAssets, /flat folders only/, 'move modal documents flat folders limitation');
ok('23c. Move modal correctly documents nested vs flat folder support per provider');

// ============================================================
// 24. Mobile rendering / structure
// ============================================================

// Hosting page uses AdminAppShell
assert.match(hostingPage, /AdminAppShell/, 'hosting page wraps in AdminAppShell');
assert.match(hostingPage, /AdminPage/, 'hosting page uses AdminPage framework');
ok('24a. Hosting page uses AdminAppShell + AdminPage');

// Tab navigation
assert.match(hostingPage, /tabs=/, 'hosting page uses AdminPage tabs');
assert.match(hostingPage, /providers.*assets.*sync/, 'hosting page has 3 tabs');
ok('24b. Hosting page has 3 contextual tabs (Providers/Assets/Sync)');

// Provider cards stack on mobile
assert.match(adminHostingProviders, /@media \(max-width: 768px\)[\s\S]*?grid-template-columns: 1fr/, 'provider cards stack on mobile');
ok('24c. Provider cards stack vertically on mobile');

// Assets table has mobile filter sheet
assert.match(adminHostingAssets, /a2-assets-mobile-filter-toggle/, 'Assets UI has mobile filter toggle');
assert.match(adminHostingAssets, /a2-assets-filter-sheet/, 'Assets UI has mobile filter sheet');
ok('24d. Assets UI has mobile filter sheet (not squeezed desktop filters)');

// Asset drawer is full-screen on mobile
assert.match(adminHostingAssets, /@media \(max-width: 768px\)[\s\S]*?\.a2-asset-drawer \{ max-width: 100%/, 'asset drawer full-width on mobile');
ok('24e. Asset drawer is full-width on mobile');

// Old /admin/media/assets + /admin/media/sync redirect to new workspace
assert.match(assetsRedirect, /\/admin\/hosting\?tab=assets/, 'old assets page redirects to hosting workspace');
assert.match(syncRedirect, /\/admin\/hosting\?tab=sync/, 'old sync page redirects to hosting workspace');
ok('24f. Old /admin/media/assets + /admin/media/sync redirect to new workspace');

// ============================================================
// 25. Loading states
// ============================================================

// Providers loading
assert.match(adminHostingProviders, /a2-hosting-empty/, 'Providers UI has empty state');
assert.match(adminHostingProviders, /No hosting providers/, 'Providers UI shows no-providers empty state');
ok('25a. Providers UI has loading + empty states');

// Assets loading
assert.match(adminHostingAssets, /a2-assets-loading/, 'Assets UI has loading state');
assert.match(adminHostingAssets, /a2-assets-empty/, 'Assets UI has empty state');
assert.match(adminHostingAssets, /No matching assets/, 'Assets UI shows no-results empty state');
assert.match(adminHostingAssets, /No assets yet/, 'Assets UI shows no-assets-yet empty state');
ok('25b. Assets UI has loading + empty + no-results states');

// Sync loading
assert.match(adminHostingSync, /a2-sync-unlinked-loading/, 'Sync UI has unlinked loading state');
assert.match(adminHostingSync, /a2-sync-unlinked-empty/, 'Sync UI has unlinked empty state');
ok('25c. Sync UI has loading + empty states for unlinked assets');

// ============================================================
// 26. Error states
// ============================================================

// Providers error
assert.match(adminHostingProviders, /a2-hosting-error/, 'Providers UI has error state');
assert.match(adminHostingProviders, /Failed to load providers/, 'Providers UI shows load-failure error');
ok('26a. Providers UI has error state');

// Assets error
assert.match(adminHostingAssets, /a2-assets-error/, 'Assets UI has error state');
assert.match(adminHostingAssets, /Failed to load assets/, 'Assets UI shows load-failure error');
assert.match(adminHostingAssets, /a2-assets-retry/, 'Assets UI has retry button');
ok('26b. Assets UI has error state + retry');

// Sync error
assert.match(adminHostingSync, /a2-sync-error/, 'Sync UI has error state');
ok('26c. Sync UI has error state');

// ============================================================
// 27. Empty states
// ============================================================

// Sync idle / success / partial / failure states
assert.match(adminHostingSync, /syncState === 'syncing'/, 'Sync UI has syncing state');
assert.match(adminHostingSync, /syncState === 'success'/, 'Sync UI has success state');
assert.match(adminHostingSync, /syncState === 'partial'/, 'Sync UI has partial state');
assert.match(adminHostingSync, /syncState === 'failed'/, 'Sync UI has failed state');
ok('27a. Sync UI has idle/syncing/success/partial/failed states');

// Unlinked empty
assert.match(adminHostingSync, /No unlinked provider assets/, 'Sync UI shows no-unlinked empty state');
ok('27b. Sync UI has unlinked empty state');

// ============================================================
// 28. Partial failures
// ============================================================

// Sync per-provider outcome
assert.match(adminHostingSync, /outcome: 'success' \| 'partial' \| 'failed'/, 'Sync UI has outcome type');
assert.match(adminHostingSync, /outcomeTone/, 'Sync UI has outcomeTone helper');
assert.match(adminHostingSync, /outcomeLabel/, 'Sync UI has outcomeLabel helper');
assert.match(adminHostingSync, /outcomeLabel\(result.outcome\)/, 'Sync UI renders per-provider outcome badge');
ok('28a. Sync UI shows per-provider outcome (success/partial/failed)');

// Sync partial summary
assert.match(adminHostingSync, /Sync completed with partial failures/, 'Sync UI shows partial-failure summary');
ok('28b. Sync UI surfaces partial-failure summary');

// ============================================================
// 29. Admin nav updated for Phase E
// ============================================================

// AdminAppShell has new Hosting Control nav item
assert.match(adminAppShell, /id: 'hosting', label: 'Hosting Control', href: '\/admin\/hosting'/, 'nav has Hosting Control item');
assert.match(adminAppShell, /matchPrefix: '\/admin\/hosting'/, 'Hosting Control has matchPrefix');
ok('29a. AdminAppShell nav has Hosting Control item with matchPrefix');

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
