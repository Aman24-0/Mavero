/**
 * Post-Deployment Production Bugfix — Regression Tests
 *
 * Verifies:
 *   1. Hosting source mapping — explicit queries, not nested join
 *   2. Upload provider discovery — reliable, no silent empty fallback
 *   3. Deep-link metadata — reads json.item, not json directly
 *   4. Stremio preview — JSON endpoint, no form-action hack
 *   5. Vidara playback URL — still vidara.to/e/
 *   6. Missing Media sweep — still checks mavero_status=available
 *   7. Theme scoping — root green, admin cyan
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const libraryServer = read('src/routes/admin/media/library/+page.server.ts');
const uploadServer = read('src/routes/admin/media/upload/+page.server.ts');
const uploadFlow = read('src/lib/components/admin2/AdminUploadFlow.svelte');
const integrationsPage = read('src/routes/admin/system/integrations/+page.svelte');
const vidaraNormalize = read('src/lib/server/hosting/vidara/normalize.ts');
const demandService = read('src/lib/server/hosting/demand/service.ts');
const rootLayout = read('src/routes/+layout.svelte');
const adminAppShell = read('src/lib/components/admin2/AdminAppShell.svelte');

// ============================================================
// 1. Hosting source mapping — explicit queries
// ============================================================

// 1a. Library page does NOT use nested join for hosting sources (check the actual select, not comments)
assert.doesNotMatch(libraryServer, /\.select\('id, name, provider:streaming_providers\(/, '1a. Library page does NOT use nested PostgREST join for hosting sources');
// 1b. Library page queries streaming_providers explicitly
assert.match(libraryServer, /from\('streaming_providers'\)/, '1b. Library page queries streaming_providers explicitly');
assert.match(libraryServer, /adapter_id.*vidara.*abyss|in\('adapter_id'.*vidara/, '1c. Library page filters by adapter_id IN (vidara, abyss)');
// 1c. Library page joins in application code
assert.match(libraryServer, /providerMap|providerById|Map|\.find\(|\.get\(/, '1d. Library page joins providers + sources in application code');
// 1d. Library page returns hostingSourcesError
assert.match(libraryServer, /hostingSourcesError/, '1e. Library page returns hostingSourcesError so DB failure is distinguishable from empty config');
ok('1. Hosting source mapping: explicit queries + application-code join (no nested PostgREST)');

// ============================================================
// 2. Upload provider discovery — reliable, no silent fallback
// ============================================================

// 2a. Upload page does NOT use !inner nested join (check the actual select, not comments)
assert.doesNotMatch(uploadServer, /\.select\(.*streaming_providers!inner/, '2a. Upload page does NOT use streaming_providers!inner nested join');
// 2b. Upload page queries providers then sources separately
assert.match(uploadServer, /from\('streaming_providers'\)[\s\S]*?in\('adapter_id'/, '2b. Upload page queries streaming_providers by adapter_id');
assert.match(uploadServer, /from\('streaming_sources'\)[\s\S]*?in\('provider_id'/, '2c. Upload page queries streaming_sources by provider_id');
// 2c. Upload page returns hostingSourcesError
assert.match(uploadServer, /hostingSourcesError/, '2d. Upload page returns hostingSourcesError');
ok('2. Upload provider discovery: explicit queries, no fragile nested join, error state returned');

// ============================================================
// 3. Deep-link metadata — reads json.item, not json
// ============================================================

// 3a. Deep-link checks json.ok and extracts json.item
assert.match(uploadFlow, /json\.ok[\s\S]*?json\.item/, '3a. Deep-link checks json.ok and extracts json.item');
// 3b. Title comes from item, not json directly
assert.match(uploadFlow, /item\.title|json\.item\.title/, '3b. Title read from json.item, not json directly');
// 3c. Poster comes from item
assert.match(uploadFlow, /item\.poster|json\.item\.poster/, '3c. Poster read from json.item');
// 3d. ExternalIds come from item
assert.match(uploadFlow, /item\.externalIds|json\.item\.externalIds/, '3d. ExternalIds read from json.item');
// 3e. Error handling for ok=false
assert.match(uploadFlow, /json\.ok.*false|!json\.ok|json\.error/, '3e. Deep-link handles ok=false / error response');
ok('3. Deep-link metadata: reads json.item envelope correctly, handles errors');

// ============================================================
// 4. Stremio preview — JSON endpoint, no form-action hack
// ============================================================

// 4a. New JSON endpoint exists
assert.ok(existsSync(new URL('../src/routes/api/admin/integrations/preview/+server.ts', import.meta.url)), '4a. Stremio preview JSON endpoint exists');
const previewEndpoint = read('src/routes/api/admin/integrations/preview/+server.ts');
assert.match(previewEndpoint, /requireAdmin/, '4b. Preview endpoint calls requireAdmin');
assert.match(previewEndpoint, /previewAddonFromManifestUrl/, '4c. Preview endpoint reuses existing secure previewAddonFromManifestUrl');
assert.match(previewEndpoint, /ok: true/, '4d. Preview endpoint returns { ok: true } envelope');
assert.match(previewEndpoint, /ok: false/, '4e. Preview endpoint returns { ok: false } on error');

// 4b. Client uses the JSON endpoint, not form action (check actual fetch calls, not comments)
assert.doesNotMatch(integrationsPage, /fetch\('\/admin\/system\/integrations\?\/previewAddon/, '4f. Client does NOT use form-action URL for preview');
assert.match(integrationsPage, /\/api\/admin\/integrations\/preview/, '4g. Client calls JSON API endpoint for preview');
// 4c. Client parses standard JSON response
assert.match(integrationsPage, /json\.ok[\s\S]*?json\.preview/, '4h. Client checks json.ok and reads json.preview');
// 4d. Client clears loading in finally
assert.match(integrationsPage, /finally[\s\S]*?previewing\s*=\s*false/, '4i. Client clears previewing in finally block (no stuck spinner)');
// 4e. Client shows inline error, not alert
assert.doesNotMatch(integrationsPage, /alert\(.*preview\|alert\(.*manifest/i, '4j. Client does NOT use alert() for preview errors');
assert.match(integrationsPage, /previewError/, '4k. Client uses inline previewError state');
ok('4. Stremio preview: JSON API endpoint + standard response parsing + inline error + no stuck spinner');

// ============================================================
// 5. Vidara playback URL — still vidara.to/e/
// ============================================================

assert.match(vidaraNormalize, /vidara\.to\/e\//, '5a. Vidara normalize uses vidara.to/e/ (not vidara.so/v/)');
assert.doesNotMatch(vidaraNormalize, /VIDARA_PLAYBACK_URL_BASE.*vidara\.so\/v\//, '5b. Vidara normalize does NOT use old vidara.so/v/ as the playback URL base constant');
ok('5. Vidara playback URL: still uses vidara.to/e/ embed URL (no regression)');

// ============================================================
// 6. Missing Media sweep — still checks mavero_status=available
// ============================================================

assert.match(demandService, /eq\('mavero_status', 'available'\)/, '6a. Sweep checks mavero_status=available');
assert.match(demandService, /eq\('status', 'ready'\)/, '6b. Sweep checks status=ready');
assert.doesNotMatch(demandService, /for \(const key of availableKeys\)/, '6c. Sweep does NOT have N+1 per-key loop');
ok('6. Missing Media sweep: checks both status=ready AND mavero_status=available, no N+1 (no regression)');

// ============================================================
// 7. Theme scoping — root green, admin cyan
// ============================================================

assert.match(rootLayout, /var\(--color-primary, #00ff9c\)/, '7a. Root layout uses --color-primary (green)');
assert.doesNotMatch(rootLayout, /var\(--a2-cyan/, '7b. Root layout does NOT use --a2-cyan (no admin leak)');
assert.match(adminAppShell, /\.a2-shell ~ :global\(\.nav-spinner\)/, '7c. AdminAppShell has cyan override scoped via .a2-shell ~');
ok('7. Theme scoping: root green for user pages, admin cyan override via .a2-shell ~ (no regression)');

console.log(`\nPost-deployment regression tests passed (${passed} check groups).`);
