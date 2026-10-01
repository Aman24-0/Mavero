/**
 * Hosting Lifecycle — Deep Regression Tests
 *
 * Verifies the complete Vidara/Abyss hosting subsystem after the
 * hosting lifecycle audit fix:
 *   1. Media Library hostingSources do NOT filter by enabled=true
 *   2. Upload API route uses explicit queries (not nested PostgREST join)
 *   3. Detach preserves all fields (only mavero_status changes)
 *   4. linkAsset handles detached rows (reactivates instead of blocking)
 *   5. reactivateAsset method exists and restores playback
 *   6. getMediaAsset returns status field (needed for reactivate logic)
 *   7. Media Operations CHECK constraint includes 'link' and 'reactivate'
 *   8. Vidara embed URL still vidara.to/e/
 *   9. Resolver still requires status=ready AND mavero_status=available
 *   10. Missing Media sweep still checks mavero_status=available
 *   11. Theme scoping still correct (root green, admin cyan)
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const libraryServer = read('src/routes/admin/media/library/+page.server.ts');
const uploadApi = read('src/routes/api/admin/media/upload/+server.ts');
const managementService = read('src/lib/server/hosting/management/service.ts');
const vidaraNormalize = read('src/lib/server/hosting/vidara/normalize.ts');
const resolver = read('src/lib/server/resolver/mavero-hosted.ts');
const demandService = read('src/lib/server/hosting/demand/service.ts');
const rootLayout = read('src/routes/+layout.svelte');
const adminAppShell = read('src/lib/components/admin2/AdminAppShell.svelte');
const migration = read('supabase/migrations/20261012000000_add_link_reactivate_actions.sql');

// ============================================================
// 1. Media Library hostingSources — NO enabled=true filter
// ============================================================

// Phase C audit fix: the library page server now delegates to the
// canonical provider resolver ($lib/server/hosting/provider-resolver).
// The resolver does the two-query lookup with NO enabled filter.
// Verify the resolver module has the correct queries, and the library
// page server imports + calls it.
const resolverFile = read('src/lib/server/hosting/provider-resolver.ts');

// The resolver queries streaming_providers WITHOUT enabled filter.
const resolverProvidersMatch = resolverFile.match(/from\('streaming_providers'\)[\s\S]*?\.select\('id, name, adapter_id, enabled'\)/);
assert.ok(resolverProvidersMatch, '1a. Provider resolver queries streaming_providers');
assert.doesNotMatch(resolverFile, /\.eq\('enabled', true\)/, '1b. Provider resolver does NOT filter by enabled=true');

// The resolver queries streaming_sources WITHOUT enabled filter.
const resolverSourcesMatch = resolverFile.match(/from\('streaming_sources'\)[\s\S]*?\.select\('id, name, provider_id, enabled'\)/);
assert.ok(resolverSourcesMatch, '1c. Provider resolver queries streaming_sources');
assert.doesNotMatch(resolverFile, /\.eq\('enabled', true\)/, '1d. Provider resolver does NOT filter by enabled=true (sources)');

// The library page server imports and calls the resolver.
assert.match(libraryServer, /import.*resolveHostingSources.*from/, '1e. Library page server imports resolveHostingSources');
assert.match(libraryServer, /resolveHostingSources\(adminClient\)/, '1f. Library page server calls resolveHostingSources');
ok('1. Media Library hostingSources: no enabled=true filter (canonical resolver — fixes "Not linked" for disabled providers)');

// ============================================================
// 2. Upload API route — uses canonical resolver (not inline queries)
// ============================================================

// Phase C audit fix: the upload API route now uses resolveAdapterForSource
// instead of inline two-query lookup.
assert.match(uploadApi, /resolveAdapterForSource/, '2a. Upload API uses canonical resolver');
assert.doesNotMatch(uploadApi, /\.select\(.*streaming_providers\(adapter_id\)/, '2b. Upload API does NOT use nested PostgREST join');
assert.doesNotMatch(uploadApi, /Could not derive providerAdapterId from providerSourceId/, '2c. Upload API does NOT have the old error message');
ok('2. Upload API route: uses canonical resolver (no fragile inline queries)');

// ============================================================
// 3. Detach preserves all fields
// ============================================================

assert.match(managementService, /mavero_status: 'missing'[\s\S]*?last_synced_at/, '3a. detachAsset sets mavero_status=missing + last_synced_at');
// Verify detach does NOT clear provider_source_id, provider_asset_id, or playback_url
const detachMatch = managementService.match(/async detachAsset[\s\S]*?\.eq\('id', mediaAssetId\)/);
assert.ok(detachMatch, '3b. detachAsset method found');
assert.doesNotMatch(detachMatch[0], /provider_source_id.*null|provider_asset_id.*null|playback_url.*null/, '3c. detachAsset does NOT clear provider_source_id, provider_asset_id, or playback_url');
ok('3. Detach: only mavero_status changes — all provider identity preserved for recovery');

// ============================================================
// 4. linkAsset handles detached rows (reactivates instead of blocking)
// ============================================================

assert.match(managementService, /mavero_status.*===.*'missing'/, '4a. linkAsset checks for mavero_status=missing on existing rows');
assert.match(managementService, /reactivateAsset\(existingRow\.id/, '4b. linkAsset calls reactivateAsset for detached rows (instead of throwing)');
assert.match(managementService, /Detach it first/, '4c. linkAsset gives clear error for rows linked to different media_item');
ok('4. linkAsset: handles detached rows via reactivation (fixes detach → relink lifecycle)');

// ============================================================
// 5. reactivateAsset method exists and restores playback
// ============================================================

assert.match(managementService, /async reactivateAsset\(/, '5a. reactivateAsset method exists');
assert.match(managementService, /action: 'reactivate'/, '5b. reactivateAsset records action=reactivate');
assert.match(managementService, /newMaveroStatus.*available/, '5c. reactivateAsset sets mavero_status to available (restoring playback)');
assert.match(managementService, /Resolve any open demand/, '5d. reactivateAsset resolves demand after reactivation');
ok('5. reactivateAsset: restores mavero_status=available + resolves demand (completes detach → reattach lifecycle)');

// ============================================================
// 6. getMediaAsset returns status field
// ============================================================

assert.match(managementService, /select\('id, media_item_id, provider_source_id, provider_asset_id, filename, status'\)/, '6a. getMediaAsset includes status field (needed for reactivate logic)');
ok('6. getMediaAsset: returns status field (enables reactivateAsset to determine new mavero_status)');

// ============================================================
// 7. Migration adds 'link' and 'reactivate' to action CHECK constraint
// ============================================================

assert.match(migration, /'link'.*'reactivate'/, '7a. Migration adds link + reactivate to media_operations action CHECK');
assert.match(migration, /DROP CONSTRAINT IF EXISTS media_operations_action_check/, '7b. Migration drops old constraint first (idempotent)');
assert.match(migration, /ADD CONSTRAINT media_operations_action_check/, '7c. Migration re-adds constraint with expanded list');
ok('7. Migration: adds link + reactivate to media_operations action CHECK (idempotent)');

// ============================================================
// 8. Vidara embed URL — still vidara.to/e/
// ============================================================

assert.match(vidaraNormalize, /vidara\.to\/e\//, '8a. Vidara normalize uses vidara.to/e/ embed URL');
assert.doesNotMatch(vidaraNormalize, /VIDARA_PLAYBACK_URL_BASE.*vidara\.so\/v\//, '8b. Vidara normalize does NOT use old vidara.so/v/ as base constant');
ok('8. Vidara playback URL: still uses vidara.to/e/ embed URL (no regression)');

// ============================================================
// 9. Resolver — still requires status=ready AND mavero_status=available
// ============================================================

assert.match(resolver, /eq\('status', 'ready'\)/, '9a. Resolver requires status=ready');
assert.match(resolver, /eq\('mavero_status', 'available'\)/, '9b. Resolver requires mavero_status=available');
ok('9. Playback resolver: dual-gate intact (status=ready AND mavero_status=available)');

// ============================================================
// 10. Missing Media sweep — still checks mavero_status=available
// ============================================================

assert.match(demandService, /eq\('mavero_status', 'available'\)/, '10a. Sweep checks mavero_status=available');
assert.match(demandService, /eq\('status', 'ready'\)/, '10b. Sweep checks status=ready');
ok('10. Missing Media sweep: checks both filters (no regression)');

// ============================================================
// 11. Theme scoping — root green, admin cyan
// ============================================================

assert.match(rootLayout, /var\(--color-primary, #00ff9c\)/, '11a. Root layout uses --color-primary (green)');
assert.doesNotMatch(rootLayout, /var\(--a2-cyan/, '11b. Root layout does NOT use --a2-cyan');
assert.match(adminAppShell, /\.a2-shell ~ :global\(\.nav-spinner\)/, '11c. AdminAppShell has cyan override scoped via .a2-shell ~');
ok('11. Theme scoping: root green for user pages, admin cyan override via .a2-shell ~ (no regression)');

console.log(`\nHosting lifecycle regression tests passed (${passed} check groups).`);
