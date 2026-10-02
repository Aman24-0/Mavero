/**
 * FINAL 3-ISSUE REGRESSION TESTS.
 *
 * Issue 1 — Hosting provider Total Assets counts ONLY usable assets
 *           (status='ready' AND mavero_status='available' — the canonical
 *           playback availability predicate). BEHAVIORAL: runs the real
 *           HostingControlService.listProviders against an in-memory mock
 *           Supabase client.
 *
 * Issue 2 — Hosting navigation consolidation: exactly 3 tabs
 *           (Providers / Jobs / Activity); the separate Sync tab is gone;
 *           Sync-all + Refresh health live on the Providers tab; legacy
 *           ?tab=sync (and /admin/media/sync) redirect server-side to
 *           /admin/hosting; the same sync backend actions are preserved.
 *
 * Issue 3 — Vidara processing status: the adapter's getProcessingStatus
 *           consults the REAL encoding endpoint (GET /v1/video/status)
 *           BEFORE the file-info fallback, so an actively-encoding video
 *           (Vidara page: "Processing 14%") maps to Mavero 'processing'
 *           with the provider's real progress percentage — NOT 'queued'.
 *           BEHAVIORAL: runs the real VidaraAdapter against a mock HTTP
 *           fetcher that serves scripted /v1/video/status + /v1/video/info
 *           responses (the exact production shapes from the Vidara API
 *           document).
 *
 * Run: pnpm exec tsx --tsconfig ./tsconfig.behavioral.json scripts/final3_issue_regression_test.ts
 */

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';

// ============================================================
// In-memory mock Supabase client (subset used by listProviders)
// ============================================================

type Row = Record<string, any>;
type Table = { rows: Row[] };

class MockBuilder {
  private filters: Array<{ type: string; column: string; value: any }> = [];
  private limitCount: number | null = null;
  private orderClause: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly table: Table,
    private readonly recorder: MockClient,
  ) {}

  select(_columns?: string, _options?: { count?: 'exact' }) { return this; }
  eq(column: string, value: any) { this.filters.push({ type: 'eq', column, value }); return this; }
  in(column: string, value: any[]) { this.filters.push({ type: 'in', column, value }); return this; }
  not(_op: string, column: string, value: any) { this.filters.push({ type: 'neq', column, value }); return this; }
  is(column: string, value: any) { this.filters.push({ type: 'is', column, value }); return this; }
  order(column: string, opts?: { ascending?: boolean }) { this.orderClause = { column, ascending: opts?.ascending ?? true }; return this; }
  limit(n: number) { this.limitCount = n; return this; }
  range() { return this; }
  maybeSingle() { return this; }
  update(_payload: Row) { return this; }
  insert(_payload: Row) { return this; }

  private matches(row: Row): boolean {
    for (const f of this.filters) {
      const v = row[f.column];
      switch (f.type) {
        case 'eq': if (v !== f.value) return false; break;
        case 'neq': if (v === f.value) return false; break;
        case 'in': if (!Array.isArray(f.value) || !f.value.includes(v)) return false; break;
        case 'is': if (v !== null) return false; break;
        default: break;
      }
    }
    return true;
  }

  private async resolve(): Promise<{ data: Row[] | null; error: null }> {
    let rows = this.table.rows.filter((r) => this.matches(r));
    if (this.orderClause) {
      const { column, ascending } = this.orderClause;
      rows = [...rows].sort((a, b) => {
        const av = a[column] ?? '';
        const bv = b[column] ?? '';
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    return { data: rows, error: null };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | Promise<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | Promise<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.resolve().then(onfulfilled as any, onrejected as any);
  }
}

class MockClient {
  public tables: Record<string, Table> = {};
  public queries: string[] = [];

  from(table: string) {
    this.queries.push(table);
    this.tables[table] ??= { rows: [] };
    return new MockBuilder(this.tables[table], this);
  }
}

// ============================================================
// Read sources (contract part)
// ============================================================

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const controlService = read('src/lib/server/hosting/control/service.ts');
const hostingTypes = read('src/lib/shared/hosting-types.ts');
const hostingPage = read('src/routes/admin/hosting/+page.svelte');
const hostingPageServer = read('src/routes/admin/hosting/+page.server.ts');
const adminHostingProviders = read('src/lib/components/admin2/AdminHostingProviders.svelte');
const syncApi = read('src/routes/api/admin/media/sync/+server.ts');
const syncServiceSrc = read('src/lib/server/hosting/sync/service.ts');
const vidaraAdapterSrc = read('src/lib/server/hosting/vidara/adapter.ts');
const vidaraNormalizeSrc = read('src/lib/server/hosting/vidara/normalize.ts');
const vidaraTypesSrc = read('src/lib/server/hosting/vidara/types.ts');
const uploadServiceSrc = read('src/lib/server/hosting/upload/service.ts');
const uploadFlowSrc = read('src/lib/components/admin2/AdminUploadFlow.svelte');
const resolverSrc = read('src/lib/server/resolver/mavero-hosted.ts');
const appShellSrc = read('src/lib/components/admin2/AdminAppShell.svelte');
const legacySyncPage = read('src/routes/admin/media/sync/+page.svelte');
const legacySyncServer = read('src/routes/admin/media/sync/+page.server.ts');

let passCount = 0;
function ok(label: string) {
  passCount++;
  console.log(`  ok ${passCount} - ${label}`);
}

console.log('\n=== ISSUE 1 — Provider Total Assets = usable (ready + available) ===');

// ============================================================
// A. BEHAVIORAL — real HostingControlService.listProviders vs mock DB
// ============================================================

import { HostingControlService } from '../src/lib/server/hosting/control/service';

const PROVIDER_ID = 'prov-vidara-1';
const SOURCE_ID = 'src-vidara-1';

function buildClient(assets: Array<{ status: string; mavero_status: string }>): MockClient {
  const client = new MockClient();
  client.tables['streaming_providers'] = {
    rows: [{ id: PROVIDER_ID, name: 'Vidara', slug: 'vidara', adapter_id: 'vidara', enabled: true, status: 'active' }],
  };
  client.tables['streaming_sources'] = {
    rows: [{ id: SOURCE_ID, name: 'Vidara', slug: 'vidara', provider_id: PROVIDER_ID, status: 'active', enabled: true }],
  };
  client.tables['media_assets'] = {
    rows: assets.map((a, i) => ({
      id: `asset-${i}`,
      provider_source_id: SOURCE_ID,
      status: a.status,
      mavero_status: a.mavero_status,
      last_synced_at: '2026-10-02T07:00:00Z',
    })),
  };
  return client;
}

async function countsFor(assets: Array<{ status: string; mavero_status: string }>) {
  const client = buildClient(assets);
  const service = new HostingControlService(client as any);
  const overviews = await service.listProviders({ skipHealth: true });
  assert.equal(overviews.length, 1, 'one provider overview');
  assert.ok(overviews[0].assetCounts, 'assetCounts present');
  return overviews[0].assetCounts!;
}

// A1: ready + available = counted
{
  const c = await countsFor([
    { status: 'ready', mavero_status: 'available' },
  ]);
  assert.equal(c.total, 1, 'A1 total: ready+available counted');
  assert.equal(c.ready, 1, 'A1 ready');
  ok('A1. ready + available counted (total=1)');
}

// A2-A7: each non-usable state alone → NOT counted
for (const [state, label] of [
  ['queued', 'A2. queued NOT counted'],
  ['processing', 'A3. processing NOT counted'],
  ['failed', 'A4. failed NOT counted'],
  ['deleted', 'A5. deleted NOT counted (status only)'],
  ['uploaded', 'A6a. uploaded NOT counted'],
  ['uploading', 'A6b. uploading NOT counted'],
] as const) {
  const c = await countsFor([{ status: state, mavero_status: 'processing' }]);
  assert.equal(c.total, 0, `${label} total=0`);
  ok(`${label} (total=0)`);
}

// A6c: missing (detached ready file) NOT counted
{
  const c = await countsFor([{ status: 'ready', mavero_status: 'missing' }]);
  assert.equal(c.total, 0, 'A6c total: ready+missing (detached) not counted');
  assert.equal(c.detached, 1, 'A6c detached diagnostic preserved');
  ok('A6c. detached (ready + mavero_status=missing) NOT counted; detached diagnostic kept');
}

// A8: THE production scenario from the task — 3 assets (ready/available,
// deleted, failed) → Total Assets = 1
{
  const c = await countsFor([
    { status: 'ready', mavero_status: 'available' },
    { status: 'deleted', mavero_status: 'missing' },
    { status: 'failed', mavero_status: 'processing' },
  ]);
  assert.equal(c.total, 1, 'A8 total=1');
  assert.equal(c.ready, 1, 'A8 ready=1');
  assert.equal(c.deleted, 1, 'A8 deleted diagnostic');
  assert.equal(c.failed, 1, 'A8 failed diagnostic');
  ok('A8. 3 assets (ready/available + deleted + failed) → Total Assets = 1 (task example)');
}

// A9: all non-available → TOTAL 0 / READY 0 — exact screenshot reproduction
// (3 deleted rows) AND the live production state (3 deleted + 1 queued).
{
  const screenshot = await countsFor([
    { status: 'deleted', mavero_status: 'missing' },
    { status: 'deleted', mavero_status: 'missing' },
    { status: 'deleted', mavero_status: 'missing' },
  ]);
  assert.equal(screenshot.total, 0, 'A9 screenshot total=0');
  assert.equal(screenshot.ready, 0, 'A9 screenshot ready=0');

  const live = await countsFor([
    { status: 'deleted', mavero_status: 'missing' },
    { status: 'deleted', mavero_status: 'missing' },
    { status: 'deleted', mavero_status: 'missing' },
    { status: 'queued', mavero_status: 'processing' },
  ]);
  assert.equal(live.total, 0, 'A9 live total=0 (was 3 in prod screenshots, 4 after new upload)');
  assert.equal(live.ready, 0, 'A9 live ready=0');
  ok('A9. all non-usable → TOTAL ASSETS: 0, READY: 0 (screenshot + live reproduction)');
}

// A10: mixed inventory — only usable counted; diagnostics intact
{
  const c = await countsFor([
    { status: 'ready', mavero_status: 'available' },
    { status: 'ready', mavero_status: 'available' },
    { status: 'processing', mavero_status: 'processing' },
    { status: 'queued', mavero_status: 'processing' },
    { status: 'failed', mavero_status: 'processing' },
    { status: 'deleted', mavero_status: 'missing' },
    { status: 'ready', mavero_status: 'missing' },
  ]);
  assert.equal(c.total, 2, 'A10 total=2');
  assert.equal(c.ready, 2, 'A10 ready=2');
  assert.equal(c.processing, 2, 'A10 processing diagnostic=2 (processing+queued)');
  assert.equal(c.failed, 1, 'A10 failed diagnostic=1');
  assert.equal(c.deleted, 1, 'A10 deleted diagnostic=1');
  assert.equal(c.detached, 1, 'A10 detached diagnostic=1');
  ok('A10. mixed inventory: only usable counted; diagnostic breakdown intact');
}

// A11: single shared semantic — the card, the drawer, and (removed) sync
// page all render assetCounts from the SAME service; count source is
// control/service.ts (no parallel count model).
assert.match(adminHostingProviders, /counts\?\.total/, 'card renders assetCounts.total');
assert.match(adminHostingProviders, /<dt>Total assets<\/dt>/, 'card shows Total assets label');
assert.match(adminHostingProviders, /counts\?\.ready/, 'card renders assetCounts.ready');
assert.match(controlService, /row\.status === 'ready' && row\.mavero_status === 'available'/, 'service uses the canonical dual-gate predicate');
assert.doesNotMatch(controlService, /c\.total \+= 1;[\s\S]{0,120}?if \(row\.status === 'ready'\)/, 'service no longer counts every row (COUNT(*) semantics removed)');
assert.match(syncApi, /a\.status === 'ready' && a\.mavero_status === 'available'/, 'GET sync summary uses the same canonical predicate');
assert.match(hostingTypes, /status='ready' AND mavero_status='available'/, 'type docs pin the semantic');
ok('A11. provider card + shared service + sync summary all use the SAME canonical predicate');

// A12: the predicate matches the playback resolver's dual gate.
assert.match(resolverSrc, /\.eq\('status', 'ready'\)/, 'resolver gates on status=ready');
assert.match(resolverSrc, /\.eq\('mavero_status', 'available'\)/, 'resolver gates on mavero_status=available');
ok('A12. count predicate == playback eligibility predicate (ready AND available)');

export {};

console.log('\n=== ISSUE 2 — Hosting navigation consolidation (3 tabs, no Sync section) ===');

// B1: hosting tabs = exactly Providers / Jobs / Activity
{
  const tabIds = [...hostingPage.matchAll(/\{ id: '([a-z]+)', label:/g)].map((m) => m[1]);
  assert.deepEqual(tabIds, ['providers', 'jobs', 'activity'], 'B1 tab set is exactly [providers, jobs, activity]');
  ok('B1. Hosting tabs = exactly Providers, Jobs, Activity');
}

// B2: VALID_TABS (page + server) contain no sync/attention
{
  const pageTabsMatch = hostingPage.match(/VALID_TABS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(pageTabsMatch, 'B2 page VALID_TABS present');
  assert.equal(pageTabsMatch![1].includes('sync'), false, 'B2 page VALID_TABS has no sync');
  const serverTabsMatch = hostingPageServer.match(/VALID_TABS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(serverTabsMatch, 'B2 server VALID_TABS present');
  assert.equal(serverTabsMatch![1].includes('sync'), false, 'B2 server VALID_TABS has no sync');
  assert.equal(serverTabsMatch![1].includes('attention'), false, 'B2 server VALID_TABS has no attention');
  ok('B2. VALID_TABS (page + server) = providers | jobs | activity only');
}

// B3/B4: legacy ?tab=sync and ?tab=attention redirect server-side to the
// canonical /admin/hosting (never a broken route).
assert.match(hostingPageServer, /tab === 'sync' \|\| tab === 'attention'/, 'B3 server handles legacy sync/attention tabs');
assert.match(hostingPageServer, /throw redirect\(303, '\/admin\/hosting'\)/, 'B3 redirect target = canonical /admin/hosting');
assert.doesNotMatch(hostingPageServer, /error\(400[^)]*sync/, 'B3 legacy sync tab is NOT a 400 error');
ok('B3. /admin/hosting?tab=sync (and ?tab=attention) → 303 /admin/hosting (server-side)');

// B5: Sync all providers — SAME backend action as the old Sync tab
// (POST /api/admin/media/sync with NO provider param → syncAll()).
assert.match(hostingPage, /async function syncAllProviders/, 'B5 sync-all handler exists');
assert.match(hostingPage, /fetch\('\/api\/admin\/media\/sync', \{ method: 'POST' \}\)/, 'B5 exact sync-all backend call (no provider param)');
assert.match(adminHostingProviders, /Sync all providers/, 'B5 Providers tab renders the Sync all providers button');
assert.match(adminHostingProviders, /onsyncall/, 'B5 providers component wires onsyncall');
ok('B5. "Sync all providers" on Providers tab still calls the existing all-provider sync backend');

// B6: per-provider card Sync preserved — POST /api/admin/media/sync?provider=<adapter>
assert.match(hostingPage, /fetch\(`\/api\/admin\/media\/sync\?provider=\$\{adapterId\}`, \{ method: 'POST' \}\)/, 'B6 per-provider backend call');
assert.match(adminHostingProviders, /onclick=\{\(\) => handleSync\(p\.adapterId\)\}/, 'B6 card Sync button preserved');
ok('B6. Provider card "Sync" still works (provider-scoped backend action)');

// B7: legacy /admin/media/sync route → /admin/hosting (not ?tab=sync)
assert.match(legacySyncServer, /redirect\(303, '\/admin\/hosting'\)/, 'B7 server redirect');
assert.doesNotMatch(legacySyncServer, /params\.set\('tab', 'sync'\)/, 'B7 no ?tab=sync target');
assert.doesNotMatch(legacySyncPage, /admin\/hosting\?tab=sync/, 'B7 client fallback has no ?tab=sync');
assert.match(legacySyncPage, /\/admin\/hosting/, 'B7 client fallback targets /admin/hosting');
ok('B7. legacy /admin/media/sync redirects safely to /admin/hosting (server 303 + client fallback)');

// B8: no dead navigation / dead imports
{
  let dead = false;
  for (const src of [hostingPage, hostingPageServer, appShellSrc, adminHostingProviders]) {
    if (/AdminHostingSync/.test(src)) dead = true;
  }
  assert.equal(dead, false, 'B8 no AdminHostingSync import remains');
  assert.equal(existsSync(new URL('../src/lib/components/admin2/AdminHostingSync.svelte', import.meta.url)), false, 'B8 AdminHostingSync.svelte deleted');
  assert.doesNotMatch(appShellSrc, /tab=sync/, 'B8 shell nav has no tab=sync links');
  ok('B8. No dead Sync navigation or component imports remain');
}

// B9: mobile layout — actions wrap, no horizontal overflow
assert.match(adminHostingProviders, /\.a2-hosting-providers-actions \{[^}]*flex-wrap/, 'B9 actions container wraps');
assert.match(adminHostingProviders, /@media \(max-width: 640px\)[\s\S]{0,200}\.a2-hosting-providers-actions \{ width: 100%/, 'B9 mobile: actions take full width row');
assert.match(adminHostingProviders, /\.a2-hosting-sync-all \{[^}]*white-space: nowrap/, 'B9 sync-all label does not overflow');
ok('B9. Refresh health + Sync all providers stack/wrap on mobile without overflow');

// B10: sync backend + service preserved (no new sync system)
assert.match(syncServiceSrc, /async syncAll\(\)/, 'B10 SyncService.syncAll preserved');
assert.match(syncServiceSrc, /async syncProvider\(adapterId: string\)/, 'B10 SyncService.syncProvider preserved');
assert.match(syncApi, /provider\s*\?\s*\[await syncService\.syncProvider\(provider\)\]\s*:\s*await syncService\.syncAll\(\)/, 'B10 API preserves provider/all dispatch');
assert.match(syncApi, /export const POST/, 'B10 sync POST route intact');
ok('B10. Sync-all backend action, sync service, and sync API unchanged');

// B11: existing hosting routes keep working (Providers/Jobs/Activity content
// components still mounted; Jobs/Activity untouched)
assert.match(hostingPage, /<AdminOpsJobs \{badgeCounts\} \/>/, 'B11 Jobs tab mounted');
assert.match(hostingPage, /<AdminOpsHistory \/>/, 'B11 Activity tab mounted');
assert.match(hostingPage, /<AdminHostingProviders/, 'B11 Providers tab mounted');
ok('B11. Providers / Jobs / Activity routes + components intact');

// B12: Refresh health still on the Providers page action area, together
// with Sync all providers (the required IA).
assert.match(adminHostingProviders, /Refresh health/, 'B12 refresh health present');
{
  const actionsBlock = adminHostingProviders.match(/a2-hosting-providers-actions[\s\S]{0,900}?<\/header>/);
  assert.ok(actionsBlock, 'B12 actions block found');
  assert.match(actionsBlock![0], /Refresh health/, 'B12 refresh health inside action area');
  assert.match(actionsBlock![0], /Sync all providers/, 'B12 sync-all inside the SAME action area');
}
ok('B12. [Refresh health] [Sync all providers] together in the provider-page action area');

console.log('\n=== ISSUE 3 — Vidara processing status sync (real provider state) ===');

// ============================================================
// C. BEHAVIORAL — real VidaraAdapter vs scripted mock HTTP fetcher
// ============================================================

import { VidaraAdapter } from '../src/lib/server/hosting/vidara/adapter';
import type { HostingHttpFetcher, HostingHttpResponse } from '../src/lib/server/hosting/http-client';

type ScriptedResponse = { match: (url: string) => boolean; respond: () => HostingHttpResponse };

function jsonResponse(json: unknown): HostingHttpResponse {
  return { status: 200, ok: true, json, text: JSON.stringify(json), contentType: 'application/json', headers: {} };
}

function makeScriptedFetcher(script: ScriptedResponse[], log: string[] = []): HostingHttpFetcher {
  return async (request) => {
    log.push(`${request.method} ${request.url}`);
    for (const entry of script) {
      if (entry.match(request.url)) return entry.respond();
    }
    return { status: 404, ok: false, json: null, text: 'not found', contentType: 'text/plain', headers: {} };
  };
}

const FILECODE = 'Pirif32o5N3st';

/** /v1/video/status response with an active encoding entry. */
function encodingResponse(pct: string, filecode = FILECODE) {
  return jsonResponse({
    msg: 'OK', status: 200,
    result: { encodings: [{ filecode, type: 'encode', progress_percentage: pct, last_update: '0m', created_at: '2026-10-02 07:00:00' }], total: 1 },
  });
}

/** /v1/video/status response with nothing in progress (docs: encodings: null). */
const noEncodingResponse = jsonResponse({ msg: 'OK', status: 200, result: { encodings: null, total: 0 } });

/** /v1/video/info response with the given file status string. */
function fileInfoResponse(status: string) {
  return jsonResponse({
    server_time: '2026-10-02 07:00:00', status: 200,
    result: [{ player_img: 'https://vidara.so/thumb.jpg', status, filecode: FILECODE, link: `https://vidara.to/${FILECODE}`, video_length: '12', video_title: '51867', video_views: 0, video_created: '2026-10-02', file_active: status === 'active' ? 1 : 0 }],
  });
}

const adapterConfig = { apiKey: 'test-api-key', baseUrl: 'https://api.vidara.so' };

async function statusWith(script: ScriptedResponse[]): Promise<{ status: string; providerStatus: string; progressPercent: number | null }> {
  const log: string[] = [];
  const adapter = new VidaraAdapter({ config: adapterConfig, httpFetcher: makeScriptedFetcher(script, log) });
  const ps = await adapter.getProcessingStatus(FILECODE);
  return { status: ps.status, providerStatus: ps.providerStatus, progressPercent: ps.progressPercent };
}

// C1: upload accepted, nothing encoding yet, file pre-active → queued
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(r.status, 'queued', 'C1 queued');
  ok('C1. upload accepted → provider pre-active, no encoding → Mavero queued');
}

// C2: THE REGRESSION CASE — Vidara reports processing (encodings entry,
// 14%) while /v1/video/info still says "queued" → Mavero must be
// 'processing' with progress 14, NOT queued.
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('14%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.notEqual(r.status, 'queued', 'C2 MUST NOT remain queued');
  assert.equal(r.status, 'processing', 'C2 processing');
  assert.equal(r.progressPercent, 14, 'C2 progress 14 (the exact Vidara screenshot value)');
  ok('C2. REGRESSION CASE: Vidara reports processing 14% → Mavero processing (NOT queued) + progress 14');
}

// C3: "42%" (docs example) parsed to 42
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('42%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(r.progressPercent, 42, 'C3 42% → 42');
  ok('C3. progress_percentage "42%" (API-docs shape) → progressPercent 42');
}

// C4: numeric progress without % suffix
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse(7) },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(r.status, 'processing', 'C4 processing');
  assert.equal(r.progressPercent, 7, 'C4 numeric 7');
  ok('C4. numeric progress_percentage (7) → progressPercent 7');
}

// C5: completed — nothing in progress, file active → ready
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('active') },
  ]);
  assert.equal(r.status, 'ready', 'C5 ready');
  ok('C5. encoding finished + file active → ready');
}

// C6: failed — nothing in progress, file error → failed
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('error') },
  ]);
  assert.equal(r.status, 'failed', 'C6 failed');
  ok('C6. provider error (file status="error") → failed (the first upload\'s live behavior)');
}

// C7: documented "blocked" file status → failed (non-playable, actionable)
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('blocked') },
  ]);
  assert.equal(r.status, 'failed', 'C7 blocked → failed');
  ok('C7. documented "blocked" file status → failed (not an eternal processing)');
}

// C8: encoding endpoint fails (404/transient) → graceful fallback to file info
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => ({ status: 404, ok: false, json: null, text: 'not found', contentType: 'text/plain', headers: {} }) },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(r.status, 'queued', 'C8 fallback queued');
  ok('C8. encoding endpoint failure → graceful file-info fallback (poll stays alive)');
}

// C9: account-wide encodings response listing a DIFFERENT file → not ours
{
  const r = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('50%', 'OTHERCODE123') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(r.status, 'queued', 'C9 other file encoding ≠ our file in progress');
  ok('C9. encoding entry for a different filecode → correctly NOT processing for ours');
}

// C10: full success lifecycle — queued → processing(14%) → processing(99%) → ready
{
  const script: ScriptedResponse[] = [
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ];
  const step1 = await statusWith(script);
  assert.equal(step1.status, 'queued', 'C10 step 1 queued');

  const script2: ScriptedResponse[] = [
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('14%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ];
  const step2 = await statusWith(script2);
  assert.equal(step2.status, 'processing', 'C10 step 2 processing');
  assert.equal(step2.progressPercent, 14, 'C10 step 2 progress');

  const script3: ScriptedResponse[] = [
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('99%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ];
  const step3 = await statusWith(script3);
  assert.equal(step3.status, 'processing', 'C10 step 3 still processing');
  assert.equal(step3.progressPercent, 99, 'C10 step 3 progress 99');

  const script4: ScriptedResponse[] = [
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('active') },
  ];
  const step4 = await statusWith(script4);
  assert.equal(step4.status, 'ready', 'C10 step 4 ready');
  ok('C10. lifecycle: queued → processing 14% → processing 99% → ready (mock Vidara lifecycle)');
}

// C11: failure lifecycle — queued → processing → failed
{
  const step1 = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(step1.status, 'queued', 'C11 step 1 queued');

  const step2 = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('30%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(step2.status, 'processing', 'C11 step 2 processing');

  const step3 = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => noEncodingResponse },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('error') },
  ]);
  assert.equal(step3.status, 'failed', 'C11 step 3 failed');
  ok('C11. lifecycle: queued → processing → failed (mock Vidara failure)');
}

// C12: the adapter actually calls /v1/video/status (the encoding endpoint)
{
  const log: string[] = [];
  const adapter = new VidaraAdapter({ config: adapterConfig, httpFetcher: makeScriptedFetcher([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('42%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ], log) });
  await adapter.getProcessingStatus(FILECODE);
  assert.ok(log.some((u) => u.includes('/v1/video/status?filecode=')), 'C12 encoding endpoint called');
  assert.ok(log.every((u) => !u.includes('encoding_status')), 'C12 no nonexistent encoding_status endpoint');
  assert.ok(log.every((u) => u.includes('api_key=')), 'C12 every call authenticated');
  ok('C12. getProcessingStatus calls GET /v1/video/status?filecode= (authenticated, no legacy endpoints)');
}

// C13: while encoding, the info endpoint is NOT needed (single call)
{
  const log: string[] = [];
  const adapter = new VidaraAdapter({ config: adapterConfig, httpFetcher: makeScriptedFetcher([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('14%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ], log) });
  await adapter.getProcessingStatus(FILECODE);
  assert.equal(log.length, 1, 'C13 exactly one call while encoding');
  ok('C13. while encoding: only the video-status endpoint is called (info fallback skipped)');
}

// ============================================================
// C14-C21. Contract layer — poll persistence, playback safety, sync
// enrichment, wizard display, Abyss untouched, no migration
// ============================================================

// C14: the upload poll persists the provider progress on the operation row.
assert.match(uploadServiceSrc, /procStatus\.status === 'processing' && procStatus\.progressPercent != null/, 'C14 progress persistence guard');
assert.match(uploadServiceSrc, /progress_percent: procStatus\.progressPercent/, 'C14 progress_percent written via updateOperationState');
ok('C14. upload poll persists REAL provider progress (media_upload_operations.progress_percent)');

// C15: processing must NOT make the asset playable — only the ready path
// sets mavero_status='available' (the dual-gate is preserved).
{
  // Extract the poll's mavero_status update: it must be in the ready branch only.
  const readyBranch = uploadServiceSrc.match(/if \(procStatus\.status === 'ready'\) \{[\s\S]{0,900}?await this\.client[\s\S]{0,200}?update\(\{ mavero_status: 'available' \}\)/);
  assert.ok(readyBranch, 'C15 mavero_status=available only inside the ready branch');
  // The processing-persist block: strip comments, then verify no update
  // payload inside it writes mavero_status (docs text mentioning the gate
  // is fine — actual mutations are what matter).
  const processingPersist = uploadServiceSrc.match(/PERSIST PROVIDER PROGRESS[\s\S]{0,1400}?Update the operation state\./);
  assert.ok(processingPersist, 'C15 processing-persist block bounded before the ready branch');
  const codeOnly = processingPersist![0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(codeOnly, /mavero_status/, 'C15 processing path never mutates mavero_status');
  // The media_assets update in the poll writes status/provider_status ONLY
  // (availability remains governed exclusively by the ready branch below).
  const assetUpdate = uploadServiceSrc.match(/Poll the provider\.[\s\S]{0,700}?\.eq\('id', op\.media_asset_id\);/);
  assert.ok(assetUpdate, 'C15 poll asset update found');
  const assetUpdateCode = assetUpdate![0].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(assetUpdateCode, /mavero_status/, 'C15 the poll status update never writes mavero_status');
}
assert.match(resolverSrc, /\.eq\('status', 'ready'\)[\s\S]{0,120}?\.eq\('mavero_status', 'available'\)/, 'C15 resolver dual gate intact');
ok('C15. processing != playable: only ready+available sets availability (dual gate intact)');

// C16: the wizard displays the provider progress in the status line.
assert.match(uploadFlowSrc, /pollProgress = typeof json\.progressPercent === 'number' \? json\.progressPercent : null/, 'C16 poll captures progressPercent');
assert.match(uploadFlowSrc, /pollProgress != null \? ` · \$\{pollProgress\}%` : ''/, 'C16 status line renders progress');
ok('C16. upload wizard status line shows real provider progress ("Status: processing · 42%")');

// C17: sync enrichment — a queued-mapped provider asset is re-resolved via
// getProcessingStatus so a mid-encoding sync does NOT regress processing → queued.
assert.match(syncServiceSrc, /providerAsset\.status === 'queued'/, 'C17 queued-mapped assets trigger enrichment');
assert.match(syncServiceSrc, /await adapter\.getProcessingStatus\(providerAsset\.providerAssetId\)/, 'C17 enrichment uses the authoritative adapter method');
assert.match(syncServiceSrc, /status: effectiveStatus/, 'C17 sync update uses the effective (enriched) status');
assert.match(syncServiceSrc, /mavero_status: effectiveStatus === 'ready' && existing\.mavero_status !== 'missing' \? 'available' : existing\.mavero_status/, 'C17 detach durability + availability gate unchanged');
ok('C17. provider sync enriches pre-active files via getProcessingStatus (no processing→queued regression)');

// C18: the Vidara normalizer implements the docs contract.
assert.match(vidaraNormalizeSrc, /export function normalizeVidaraEncodingList/, 'C18 encoding-list normalizer exists');
assert.match(vidaraNormalizeSrc, /progress_percentage/, 'C18 parses progress_percentage');
assert.match(vidaraNormalizeSrc, /parseVidaraProgress/, 'C18 % suffix parser exists');
assert.match(vidaraTypesSrc, /VidaraVideoStatusResponse/, 'C18 response type defined');
ok('C18. Vidara encoding response contract (encodings/progress_percentage) normalized + typed');

// C19: adapter doc + implementation order — video/status BEFORE video/info.
{
  const fn = vidaraAdapterSrc.match(/async getProcessingStatus\([\s\S]{0,2400}?\n  \}/);
  assert.ok(fn, 'C19 getProcessingStatus found');
  const statusIdx = fn![0].indexOf("/v1/video/status");
  const infoIdx = fn![0].indexOf("/v1/video/info");
  assert.ok(statusIdx !== -1 && infoIdx !== -1, 'C19 both endpoints referenced');
  assert.ok(statusIdx < infoIdx, 'C19 encoding endpoint consulted FIRST');
}
ok('C19. adapter consults /v1/video/status first, /v1/video/info as fallback');

// C20: Abyss adapter untouched — its own status model, no Vidara endpoints.
{
  const abyssNormalize = read('src/lib/server/hosting/abyss/normalize.ts');
  const abyssAdapter = read('src/lib/server/hosting/abyss/adapter.ts');
  assert.match(abyssNormalize, /export function abyssStatusMapper/, 'C20 abyss mapper intact');
  assert.doesNotMatch(abyssAdapter, /\/v1\/video\/status/, 'C20 abyss does not call Vidara endpoints');
  assert.doesNotMatch(abyssNormalize, /progress_percentage/, 'C20 abyss normalize untouched');
}
ok('C20. Abyss adapter + normalize untouched (no cross-provider contamination)');

// C21: NO migration added — the audit proved no schema change was required
// (progress_percent + lifecycle statuses already exist in the foundation).
{
  const foundation = read('supabase/migrations/20260928200724_phase2_hosting_database_foundation.sql');
  assert.match(foundation, /progress_percent\s+integer/, 'C21 progress_percent column already in schema');
  assert.match(foundation, /media_upload_operations_progress_percent_check/, 'C21 progress check constraint exists');
}
ok('C21. NO new migration — progress_percent + statuses already in schema (verified)');

// ============================================================
// Summary
// ============================================================

// C22: malformed progress values are clamped to the DB CHECK range [0,100].
{
  const over = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('150%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(over.status, 'processing', 'C22 processing preserved');
  assert.equal(over.progressPercent, 100, 'C22 "150%" clamped to 100 (DB CHECK range)');

  const under = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse(-5) },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(under.progressPercent, 0, 'C22 -5 clamped to 0');

  const garbage = await statusWith([
    { match: (u) => u.includes('/v1/video/status'), respond: () => encodingResponse('abc%') },
    { match: (u) => u.includes('/v1/video/info'), respond: () => fileInfoResponse('queued') },
  ]);
  assert.equal(garbage.status, 'processing', 'C22 garbage progress still → processing');
  assert.equal(garbage.progressPercent, null, 'C22 malformed progress → null (no crash)');
}
ok('C22. progress values clamped/parsed safely (150%→100, -5→0, garbage→null)');

console.log(`\n=== Final 3-issue regression: ${passCount} check groups PASSED ===`);
