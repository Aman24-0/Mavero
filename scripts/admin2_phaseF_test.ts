import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase F contracts.
 *
 * Phase F is the Operations Center: Jobs, Activity/History, Attention tabs
 * with real operational visibility, retry/reconcile actions, sync audit
 * logging, stale detection, and nav badges.
 *
 * This test pins the contracts that Phase G+ will depend on. It also
 * verifies the audit-driven fixes:
 *
 *   - SyncService now records audit events in media_operations
 *   - ReconcileAsset now records audit events
 *   - Stale detection preserved (60-min threshold)
 *   - Retry only available for retryable error codes
 *   - Attention is live-state based (no permanent "resolved" flag)
 *   - Nav badges show active job count + attention count
 *   - No credentials exposed
 *   - Resolver gating preserved
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ============================================================
// Source files under test
// ============================================================

const opsTypes = readFileSync(new URL('../src/lib/shared/operations-types.ts', import.meta.url), 'utf8');
const opsService = readFileSync(new URL('../src/lib/server/hosting/operations/service.ts', import.meta.url), 'utf8');
const jobsApi = readFileSync(new URL('../src/routes/api/admin/operations/jobs/+server.ts', import.meta.url), 'utf8');
const historyApi = readFileSync(new URL('../src/routes/api/admin/operations/history/+server.ts', import.meta.url), 'utf8');
const attentionApi = readFileSync(new URL('../src/routes/api/admin/operations/attention/+server.ts', import.meta.url), 'utf8');
const countsApi = readFileSync(new URL('../src/routes/api/admin/operations/counts/+server.ts', import.meta.url), 'utf8');

const opsPage = readFileSync(new URL('../src/routes/admin/operations/+page.svelte', import.meta.url), 'utf8');
const opsPageServer = readFileSync(new URL('../src/routes/admin/operations/+page.server.ts', import.meta.url), 'utf8');
const opsJobsRedirect = readFileSync(new URL('../src/routes/admin/media/operations/+page.svelte', import.meta.url), 'utf8');
const opsHistoryRedirect = readFileSync(new URL('../src/routes/admin/media/history/+page.svelte', import.meta.url), 'utf8');
const opsStaleRedirect = readFileSync(new URL('../src/routes/admin/media/stale/+page.svelte', import.meta.url), 'utf8');

const adminOpsJobs = readFileSync(new URL('../src/lib/components/admin2/AdminOpsJobs.svelte', import.meta.url), 'utf8');
const adminOpsHistory = readFileSync(new URL('../src/lib/components/admin2/AdminOpsHistory.svelte', import.meta.url), 'utf8');
const adminOpsAttention = readFileSync(new URL('../src/lib/components/admin2/AdminOpsAttention.svelte', import.meta.url), 'utf8');

const syncService = readFileSync(new URL('../src/lib/server/hosting/sync/service.ts', import.meta.url), 'utf8');
const managementService = readFileSync(new URL('../src/lib/server/hosting/management/service.ts', import.meta.url), 'utf8');
const uploadService = readFileSync(new URL('../src/lib/server/hosting/upload/service.ts', import.meta.url), 'utf8');
const errorsFile = readFileSync(new URL('../src/lib/server/hosting/errors.ts', import.meta.url), 'utf8');
const resolverHosted = readFileSync(new URL('../src/lib/server/resolver/mavero-hosted.ts', import.meta.url), 'utf8');
const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Jobs endpoint + service
// ============================================================

assert.match(opsTypes, /export type JobRow/, 'shared types export JobRow');
assert.match(opsTypes, /export type JobQuery/, 'shared types export JobQuery');
assert.match(opsTypes, /export type JobListResult/, 'shared types export JobListResult');
ok('1a. Jobs types defined in shared types');

assert.match(opsService, /async listJobs/, 'OperationsService.listJobs method');
assert.match(opsService, /clampPage/, 'listJobs clamps page');
assert.match(opsService, /MAX_LIMIT = 100/, 'listJobs enforces max 100 per page');
ok('1b. OperationsService.listJobs exists with pagination');

assert.match(jobsApi, /export const GET/, 'jobs API exports GET');
assert.match(jobsApi, /requireAdmin/, 'jobs API requires admin');
assert.match(jobsApi, /NO_STORE/, 'jobs API sets no-store');
ok('1c. Jobs API endpoint is admin-gated + no-store');

// ============================================================
// 2. Jobs pagination
// ============================================================

assert.match(opsService, /\.range\(offset, offset \+ limit - 1\)/, 'listJobs uses range pagination');
assert.match(opsService, /hasMore/, 'listJobs returns hasMore flag');
ok('2a. Jobs pagination uses range + hasMore');

// ============================================================
// 3. Jobs filtering
// ============================================================

assert.match(opsService, /query\.status/, 'listJobs supports status filter');
assert.match(opsService, /query\.operationType/, 'listJobs supports operationType filter');
assert.match(opsService, /query\.provider/, 'listJobs supports provider filter');
assert.match(opsService, /query\.retryable/, 'listJobs supports retryable filter');
assert.match(opsService, /query\.stale/, 'listJobs supports stale filter');
assert.match(opsService, /query\.sort/, 'listJobs supports sort');
ok('3a. Jobs supports status, operationType, provider, retryable, stale, sort filters');

// 'active' status filter = non-terminal states
assert.match(opsService, /'active'/, 'listJobs supports active status (non-terminal)');
assert.match(opsService, /queued.*uploading.*uploaded.*processing/, 'active = queued+uploading+uploaded+processing');
ok('3b. Jobs active filter correctly identifies non-terminal states');

// ============================================================
// 4. Jobs search
// ============================================================

assert.match(opsService, /query\.q/, 'listJobs supports q search');
assert.match(opsService, /media_item\.title\.ilike/, 'listJobs searches media title');
assert.match(opsService, /provider_asset_id\.ilike/, 'listJobs searches provider_asset_id');
ok('4a. Jobs search covers operation id, media title, provider asset id');

// ============================================================
// 5. Job detail
// ============================================================

assert.match(adminOpsJobs, /a2-job-drawer/, 'Jobs UI has detail drawer');
assert.match(adminOpsJobs, /Identity/, 'drawer has Identity section');
assert.match(adminOpsJobs, /Timeline/, 'drawer has Timeline section');
assert.match(adminOpsJobs, /Error/, 'drawer has Error section');
assert.match(adminOpsJobs, /Actions/, 'drawer has Actions section');
ok('5a. Job detail drawer has Identity, Timeline, Error, Actions sections');

// Timeline shows lifecycle
assert.match(adminOpsJobs, /Queued/, 'timeline shows Queued');
assert.match(adminOpsJobs, /Upload started/, 'timeline shows Upload started');
assert.match(adminOpsJobs, /Uploaded/, 'timeline shows Uploaded');
assert.match(adminOpsJobs, /Processing/, 'timeline shows Processing');
ok('5b. Job timeline shows full lifecycle');

// ============================================================
// 6. Active jobs prioritized
// ============================================================

assert.match(adminOpsJobs, /isActive/, 'Jobs UI has isActive helper');
assert.match(adminOpsJobs, /queued.*uploading.*uploaded.*processing/, 'isActive checks non-terminal states');
ok('6a. Jobs UI correctly identifies active jobs');

// 'active' filter option in UI
assert.match(adminOpsJobs, /value="active"/, 'Jobs UI has active filter option');
ok('6b. Jobs UI exposes active filter option');

// ============================================================
// 7. History endpoint + service
// ============================================================

assert.match(opsTypes, /export type HistoryRow/, 'shared types export HistoryRow');
assert.match(opsTypes, /export type HistoryQuery/, 'shared types export HistoryQuery');
ok('7a. History types defined in shared types');

assert.match(opsService, /async listHistory/, 'OperationsService.listHistory method');
assert.match(historyApi, /export const GET/, 'history API exports GET');
assert.match(historyApi, /requireAdmin/, 'history API requires admin');
assert.match(historyApi, /NO_STORE/, 'history API sets no-store');
ok('7b. History API endpoint is admin-gated + no-store');

// ============================================================
// 8. History pagination
// ============================================================

assert.match(opsService, /async listHistory[\s\S]*?\.range\(/, 'listHistory uses range pagination');
ok('8a. History pagination uses range');

// ============================================================
// 9. History filtering
// ============================================================

assert.match(opsService, /query\.action/, 'listHistory supports action filter');
assert.match(opsService, /query\.status/, 'listHistory supports status filter');
assert.match(opsService, /query\.provider/, 'listHistory supports provider filter');
ok('9a. History supports action, status, provider filters');

// All 22 action values supported
const VALID_ACTIONS = [
  'upload', 'upload_remote', 'processing_started', 'ready', 'failed',
  'retry', 'rename', 'move', 'replace', 'subtitle_upload', 'sync',
  'provider_delete', 'detach', 'create_media_item', 'update_media_item',
  'delete_media_item', 'create_folder', 'update_folder', 'delete_folder',
  'create_folder_mapping', 'update_folder_mapping', 'delete_folder_mapping',
  'resolve_availability',
];
for (const action of VALID_ACTIONS) {
  assert.ok(historyApi.includes(action), `history API validates action: ${action}`);
}
ok('9b. History API supports all 22+ action values from media_operations CHECK constraint');

// ============================================================
// 10. History search
// ============================================================

assert.match(opsService, /query\.q[\s\S]*?media_item\.title\.ilike/, 'listHistory searches media title');
assert.match(opsService, /error_code\.ilike/, 'listHistory searches error code');
ok('10a. History search covers operation id, media title, error code');

// ============================================================
// 11. History detail
// ============================================================

assert.match(adminOpsHistory, /a2-event-drawer/, 'History UI has detail drawer');
assert.match(adminOpsHistory, /Event/, 'drawer has Event section');
assert.match(adminOpsHistory, /Related media/, 'drawer has Related media section');
assert.match(adminOpsHistory, /Related asset/, 'drawer has Related asset section');
assert.match(adminOpsHistory, /Metadata/, 'drawer has Metadata section');
ok('11a. History detail drawer has Event, Related media/asset, Metadata sections');

// ============================================================
// 12. Attention endpoint + service
// ============================================================

assert.match(opsTypes, /export type AttentionItem/, 'shared types export AttentionItem');
assert.match(opsTypes, /export type AttentionQuery/, 'shared types export AttentionQuery');
assert.match(opsTypes, /export type AttentionListResult/, 'shared types export AttentionListResult');
ok('12a. Attention types defined in shared types');

assert.match(opsService, /async listAttention/, 'OperationsService.listAttention method');
assert.match(attentionApi, /export const GET/, 'attention API exports GET');
assert.match(attentionApi, /requireAdmin/, 'attention API requires admin');
assert.match(attentionApi, /NO_STORE/, 'attention API sets no-store');
ok('12b. Attention API endpoint is admin-gated + no-store');

// ============================================================
// 13. Failed detection
// ============================================================

assert.match(opsService, /eq\('status', 'failed'\)/, 'Attention detects failed operations');
assert.match(opsTypes, /AttentionCategory = 'failed' \| 'stale' \| 'unconfigured' \| 'degraded'/, 'Attention has failed category in AttentionCategory type');
ok('13a. Attention detects failed upload operations');

// ============================================================
// 14. Stale detection (60-min threshold preserved)
// ============================================================

assert.match(opsService, /STALE_THRESHOLD_MS = 60 \* 60 \* 1000/, 'Attention uses 60-min stale threshold');
assert.match(opsService, /STALE_STATES = \['uploading', 'uploaded', 'processing'\]/, 'Attention uses correct stale states');
assert.match(opsService, /lt\('updated_at', staleBefore\)/, 'Attention queries stale by updated_at');
ok('14a. Stale detection preserves 60-min threshold for uploading/uploaded/processing');

// UI explains stale threshold (in the service-generated description)
assert.match(opsService, /over 60 minutes/, 'Attention service explains stale threshold in description');
ok('14b. Attention explains "over 60 minutes" in stale item description');

// ============================================================
// 15. Unconfigured detection
// ============================================================

assert.match(opsService, /getVidaraConfigOrNull\(\) !== null/, 'Attention checks Vidara config');
assert.match(opsService, /getAbyssConfigOrNull\(\) !== null/, 'Attention checks Abyss config');
assert.match(opsTypes, /AttentionCategory = 'failed' \| 'stale' \| 'unconfigured' \| 'degraded'/, 'Attention has unconfigured category in AttentionCategory type');
ok('15a. Attention detects unconfigured providers');

// ============================================================
// 16. Retryable detection
// ============================================================

assert.match(opsService, /RETRYABLE_ERROR_CODES/, 'OperationsService has RETRYABLE_ERROR_CODES set');
assert.match(opsService, /RATE_LIMITED.*TRANSIENT.*NETWORK.*TIMEOUT/, 'retryable codes match errors.ts');
assert.match(errorsFile, /isRetryable/, 'errors.ts has isRetryable function');
assert.match(errorsFile, /RATE_LIMITED.*TRANSIENT.*NETWORK.*TIMEOUT/, 'errors.ts retryable codes');
ok('16a. Retryable detection uses RATE_LIMITED, TRANSIENT, NETWORK, TIMEOUT');

// Job row has isRetryable derived field
assert.match(opsTypes, /isRetryable: boolean/, 'JobRow has isRetryable field');
ok('16b. JobRow exposes isRetryable derived field');

// ============================================================
// 17. Retry restrictions
// ============================================================

// Retry only available for failed + retryable
assert.match(adminOpsJobs, /selectedJob.status === 'failed' && selectedJob.isRetryable/, 'Retry only shown for failed + retryable');
ok('17a. Retry button only shown for failed + retryable jobs');

// Retry unavailable message for permanent errors
assert.match(adminOpsJobs, /Retry unavailable.*permanent error/, 'Retry unavailable message for permanent errors');
ok('17b. Retry unavailable message shown for permanent errors');

// ============================================================
// 18. Retry operation
// ============================================================

assert.match(adminOpsJobs, /retryJob/, 'Jobs UI has retryJob function');
assert.match(adminOpsJobs, /\/api\/admin\/media\/upload\/.*\/retry/, 'Jobs UI calls retry endpoint');
assert.match(uploadService, /async retryOperation/, 'UploadService has retryOperation');
assert.match(uploadService, /parent_operation_id: operationId/, 'retry links to parent_operation_id');
assert.match(uploadService, /attempt_number: op.attempt_number \+ 1/, 'retry increments attempt_number');
ok('18a. Retry creates new operation linked to parent, increments attempt');

// ============================================================
// 19. Reconcile action
// ============================================================

assert.match(adminOpsJobs, /reconcileJob/, 'Jobs UI has reconcileJob function');
assert.match(adminOpsJobs, /\/api\/admin\/media\/assets\/.*\/reconcile/, 'Jobs UI calls reconcile endpoint');
assert.match(adminOpsAttention, /reconcileItem/, 'Attention UI has reconcileItem function');
ok('19a. Reconcile action available in Jobs + Attention UIs');

// ============================================================
// 20. Sync audit event (Phase F fix)
// ============================================================

assert.match(syncService, /recordSyncAudit/, 'SyncService has recordSyncAudit method');
assert.match(syncService, /action: 'sync'/, 'sync audit uses action=sync');
assert.match(syncService, /media_operations.*insert/, 'sync audit inserts into media_operations');
assert.match(syncService, /outcome/, 'sync audit records outcome');
assert.match(syncService, /total_provider_assets/, 'sync audit records total count');
assert.match(syncService, /updated_assets/, 'sync audit records updated count');
assert.match(syncService, /deleted_assets/, 'sync audit records deleted count');
assert.match(syncService, /unlinked_count/, 'sync audit records unlinked count');
ok('20a. SyncService records audit event with aggregate counts (Phase F fix)');

// Sync audit is fire-and-forget (must NOT break sync)
assert.match(syncService, /Silently absorb.*audit logging must NOT break sync/, 'sync audit is fire-and-forget');
ok('20b. Sync audit is fire-and-forget — does not break sync');

// ============================================================
// 21. Reconcile audit event (Phase F fix)
// ============================================================

assert.match(syncService, /reconcile: true/, 'reconcile audit has reconcile=true flag in details');
assert.match(syncService, /previous_status/, 'reconcile audit records previous status');
assert.match(syncService, /new_status/, 'reconcile audit records new status');
ok('21a. ReconcileAsset records audit event with status transition (Phase F fix)');

// ============================================================
// 22. Rename audit event
// ============================================================

assert.match(managementService, /action: 'rename'/, 'ManagementService records rename');
assert.match(managementService, /adapter.renameAsset/, 'rename calls adapter first');
assert.match(managementService, /recordOperation[\s\S]*?action: 'rename'[\s\S]*?status: 'success'/, 'rename records success after adapter');
ok('22a. Rename records audit event AFTER adapter succeeds');

// ============================================================
// 23. Move audit event
// ============================================================

assert.match(managementService, /action: 'move'/, 'ManagementService records move');
assert.match(managementService, /caps.folderManagement/, 'move checks folderManagement capability');
ok('23a. Move records audit event + checks capability');

// ============================================================
// 24. Detach audit event
// ============================================================

assert.match(managementService, /action: 'detach'/, 'ManagementService records detach');
assert.match(managementService, /mavero_status: 'missing'/, 'detach sets mavero_status=missing');
assert.match(managementService, /Does NOT delete the provider-side file/, 'detach does NOT delete provider file');
ok('24a. Detach records audit event, sets mavero_status=missing, does NOT delete provider file');

// ============================================================
// 25. Provider delete audit event
// ============================================================

assert.match(managementService, /action: 'provider_delete'/, 'ManagementService records provider_delete');
assert.match(managementService, /Delete at the provider first/, 'delete calls provider first');
assert.match(managementService, /Only update Mavero state after provider confirms deletion/, 'Mavero state updated ONLY after provider confirms');
assert.match(managementService, /Provider delete failed.*do NOT mark the Mavero asset as deleted/, 'Mavero NOT marked deleted on provider failure');
ok('25a. Provider delete records audit event, provider first, no false deleted');

// ============================================================
// 26. Badge counts
// ============================================================

assert.match(opsService, /async getBadgeCounts/, 'OperationsService has getBadgeCounts');
assert.match(opsService, /jobsActive/, 'badge counts has jobsActive');
assert.match(opsService, /attentionTotal/, 'badge counts has attentionTotal');
assert.match(opsService, /head: true/, 'badge counts uses head:true for performance');
ok('26a. Badge counts endpoint uses efficient head:true count queries');

// Counts API endpoint
assert.match(countsApi, /export const GET/, 'counts API exports GET');
assert.match(countsApi, /requireAdmin/, 'counts API requires admin');
ok('26b. Counts API endpoint is admin-gated');

// [final remediation] /admin/operations is a 303 redirect to /admin/hosting —
// the Hosting Control page server owns the badge-count preload and the tabs
// that render them. Verified against the hosting page server + component.
const hostingPageServer = readFileSync(new URL('../src/routes/admin/hosting/+page.server.ts', import.meta.url), 'utf8');
const hostingPage = readFileSync(new URL('../src/routes/admin/hosting/+page.svelte', import.meta.url), 'utf8');
assert.match(hostingPageServer, /getBadgeCounts/, 'hosting page server preloads badge counts');
assert.match(opsPageServer, /redirect/, 'Operations page server redirects (merged into Hosting Control)');
ok('26c. Hosting Control page server preloads badge counts (Operations redirects into it)');

// Page shows badges on tabs
assert.match(hostingPage, /badge/, 'Hosting Control page shows badges on tabs');
ok('26d. Hosting Control page shows badge counts on tabs');

// ============================================================
// 27. Admin authorization
// ============================================================

const allOpsApis = [jobsApi, historyApi, attentionApi, countsApi];
for (const api of allOpsApis) {
  assert.match(api, /requireAdmin/, 'API uses requireAdmin');
}
ok('27a. All 4 operations API endpoints use requireAdmin');

// Page server requires admin
// [final remediation] /admin/operations is a pure redirect into the admin-gated
// Hosting Control workspace (requireAdmin enforced by the hosting page server).
assert.match(hostingPageServer, /requireAdmin/, 'hosting page server requires admin (owns the merged workspace)');
ok('27b. Hosting Control page server requires admin (Operations redirects into it)');

// All endpoints use NO_STORE
for (const api of allOpsApis) {
  assert.match(api, /NO_STORE/, 'API sets no-store');
}
ok('27c. All 4 operations API endpoints set no-store');

// ============================================================
// 28. Secret redaction
// ============================================================

// OperationsService does NOT expose provider_metadata or playback_url
const opsSelects = opsService.match(/\.select\(`[^`]+`/g) ?? [];
const hasProviderMetadataInSelect = opsSelects.some(s => s.includes('provider_metadata'));
const hasPlaybackUrlInSelect = opsSelects.some(s => s.includes('playback_url'));
assert.ok(!hasProviderMetadataInSelect, 'OperationsService does NOT select provider_metadata');
assert.ok(!hasPlaybackUrlInSelect, 'OperationsService does NOT select playback_url');
ok('28a. OperationsService does NOT expose provider_metadata or playback_url');

// Sync audit details are safe (no credentials)
assert.match(uploadService, /SECURITY.*never store credentials.*details/, 'upload service documents details safety');
ok('28b. Audit details are documented as safe (no credentials)');

// ============================================================
// 29. No N+1 behavior
// ============================================================

// Jobs batch-fetches adapter ids via adapterBySourceIds
assert.match(opsService, /adapterBySourceIds/, 'OperationsService batch-fetches adapter ids');
assert.match(opsService, /new Set\(merged\.map/, 'OperationsService deduplicates source ids before batch lookup');
ok('29a. Jobs batch-fetches adapter ids (no N+1)');

// History batch-fetches adapter ids
assert.match(opsService, /sourceIds = \[\.\.\.new Set\(/, 'History batch-fetches adapter ids via sourceIds Set');
ok('29b. History batch-fetches adapter ids (no N+1)');

// Badge counts uses head:true (no row data)
assert.match(opsService, /head: true/, 'badge counts uses head:true');
ok('29c. Badge counts uses head:true (no row data fetched)');

// ============================================================
// 30. Resolver regression
// ============================================================

// Resolver gates on BOTH status='ready' AND mavero_status='available' (Phase C fix preserved)
assert.match(resolverHosted, /mavero_status.*available/, 'resolver gates on mavero_status=available');
assert.match(resolverHosted, /status.*ready/, 'resolver gates on status=ready');
ok('30a. Resolver gating preserved: status=ready AND mavero_status=available');

// Detach sets mavero_status=missing → resolver excludes
assert.match(managementService, /mavero_status: 'missing'[\s\S]*?last_synced_at/, 'detach sets mavero_status=missing');
ok('30b. Detach sets mavero_status=missing — resolver excludes');

// Delete sets status=deleted + mavero_status=missing → resolver excludes
assert.match(managementService, /status: 'deleted'[\s\S]*?mavero_status: 'missing'/, 'delete sets status=deleted + mavero_status=missing');
ok('30c. Delete sets status=deleted + mavero_status=missing — resolver excludes');

// ============================================================
// 31. Empty states
// ============================================================

// Jobs empty state
assert.match(adminOpsJobs, /No active jobs/, 'Jobs UI shows "No active jobs" empty state');
ok('31a. Jobs has distinct "No active jobs" empty state');

// History empty state
assert.match(adminOpsHistory, /No activity yet/, 'History UI shows "No activity yet" empty state');
ok('31b. History has distinct "No activity yet" empty state');

// Attention empty state
assert.match(adminOpsAttention, /All systems clear/, 'Attention UI shows "All systems clear" empty state');
ok('31c. Attention has distinct "All systems clear" empty state');

// ============================================================
// 32. Error states
// ============================================================

// Jobs error state
assert.match(adminOpsJobs, /Unable to load operations/, 'Jobs UI shows error state');
assert.match(adminOpsJobs, /a2-jobs-retry/, 'Jobs UI has retry button on error');
ok('32a. Jobs has error state + retry button');

// History error state
assert.match(adminOpsHistory, /Unable to load operations/, 'History UI shows error state');
assert.match(adminOpsHistory, /a2-history-retry/, 'History UI has retry button on error');
ok('32b. History has error state + retry button');

// Attention error state
assert.match(adminOpsAttention, /Unable to load operations/, 'Attention UI shows error state');
assert.match(adminOpsAttention, /a2-attention-retry/, 'Attention UI has retry button on error');
ok('32c. Attention has error state + retry button');

// ============================================================
// 33. Mobile structure
// ============================================================

// [final remediation] Operations merged into Hosting Control — the hosting
// page owns the AdminAppShell/AdminPage + 5 tabs (providers/sync/jobs/
// activity/attention); the Operations route is a redirect stub.
assert.match(hostingPage, /AdminAppShell/, 'Hosting Control page wraps in AdminAppShell');
assert.match(hostingPage, /AdminPage/, 'Hosting Control page uses AdminPage framework');
ok('33a. Hosting Control page uses AdminAppShell + AdminPage (Operations redirects into it)');

// Tab navigation — 5 tabs, Jobs/Activity/Attention included
assert.match(hostingPage, /tabs=/, 'Hosting Control page uses AdminPage tabs');
assert.match(hostingPage, /'providers', label: 'Providers'/, 'Hosting Control has Providers tab');
assert.match(hostingPage, /'sync', label: 'Sync'/, 'Hosting Control has Sync tab');
assert.match(hostingPage, /'jobs', label: 'Jobs'/, 'Hosting Control has Jobs tab');
assert.match(hostingPage, /'activity', label: 'Activity'/, 'Hosting Control has Activity tab');
assert.match(hostingPage, /'attention', label: 'Attention'/, 'Hosting Control has Attention tab');
ok('33b. Hosting Control has 5 tabs (Providers/Sync/Jobs/Activity/Attention)');

// Jobs mobile filter — Mavero-native AdminFilterSheet (no native <select>)
assert.match(adminOpsJobs, /a2-jobs-mobile-filter-toggle/, 'Jobs UI has mobile filter toggle');
assert.match(adminOpsJobs, /AdminFilterSheet/, 'Jobs UI uses the Mavero-native chip filter sheet');
ok('33c. Jobs UI has mobile filter sheet');

// History mobile filter — Mavero-native AdminFilterSheet (no native <select>)
assert.match(adminOpsHistory, /a2-history-mobile-filter-toggle/, 'History UI has mobile filter toggle');
assert.match(adminOpsHistory, /AdminFilterSheet/, 'History UI uses the Mavero-native chip filter sheet');
ok('33d. History UI has mobile filter sheet');

// Job drawer full-width on mobile
assert.match(adminOpsJobs, /@media \(max-width: 768px\)[\s\S]*?\.a2-job-drawer \{ max-width: 100%/, 'job drawer full-width on mobile');
ok('33e. Job drawer is full-width on mobile');

// Old placeholder pages redirect
assert.match(opsJobsRedirect, /\/admin\/operations\?tab=jobs/, 'old jobs page redirects to Operations Center');
assert.match(opsHistoryRedirect, /\/admin\/operations\?tab=history/, 'old history page redirects to Operations Center');
assert.match(opsStaleRedirect, /\/admin\/operations\?tab=attention/, 'old stale page redirects to Operations Center');
ok('33f. Old /admin/media/{operations,history,stale} redirect to Operations Center');

// ============================================================
// 34. Partial failures
// ============================================================

// Attention health check is best-effort (doesn't break the list)
assert.match(opsService, /Health check failed.*skip this item/, 'Attention health check is best-effort');
ok('34a. Attention health check failure does NOT break the list');

// Badge counts are decorative (don't break the page)
assert.match(hostingPageServer, /Badge counts are decorative/, 'hosting page server documents badge counts as decorative');
ok('34b. Badge counts failure does NOT break the page');

// ============================================================
// Final summary
// ============================================================

console.log(`\nAdmin 2.0 Phase F tests passed (${passed} check groups).`);
