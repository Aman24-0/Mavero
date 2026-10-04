/**
 * Abyss direct-upload discovery + generic existing-file linking + provider
 * inventory/playback hardening — REGRESSION SUITE.
 *
 * Root causes this suite guards (all confirmed live/official-contract):
 *   RC-1  normalizeAbyssFileList parsed data/files/result while the REAL
 *         /v1/resources response is { name, breadcrumbs, domainEmbed,
 *         items: [...], pageToken } → ALWAYS [] → every Abyss sync audit
 *         reported outcome=success total_provider_assets=0 (false success).
 *   RC-2  Status vocabulary: 'public' (playable) and 'banned' (failed)
 *         were unmapped → playable files never became ready via sync.
 *   RC-3  No pagination (default 25 rows), wrong folder param
 *         (folder_id vs folderId), no type=files filter.
 *   RC-4  Missing Media had no "Link existing file" action.
 *   RC-5  Silent-empty fallthroughs (unconfigured adapter / non-JSON /
 *         unrecognized shape → [] masquerading as "zero files").
 *   RC-6  Health (API reachable) said nothing about inventory sync.
 *
 * Contract source: the OFFICIAL dash.abyss.to SPA bundle's embedded API
 * documentation (GET /v1/resources → items+pageToken, query
 * key/q/searchType/type/folderId/maxResults≤100/orderBy/pageToken; file
 * status vocabulary waiting|in-processing|ready|public|error|banned;
 * player URL https://player.abyssplayer.com/<id>; folders list =
 * GET /v1/folders/list; move = PATCH ?parentId=; create body {name,parentId}).
 *
 * Run: pnpm exec tsx --tsconfig ./tsconfig.behavioral.json
 *      scripts/abyss_inventory_link_regression_test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { HostingHttpFetcher } from '../src/lib/server/hosting/http-client';
import { HostingProviderError } from '../src/lib/server/hosting/errors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  try { assert.ok(condition, label); passed += 1; }
  catch (err) {
    failed += 1;
    console.error(`  FAIL: ${label}`);
    if (err instanceof Error && err.message !== label) console.error(`        ${err.message}`);
  }
}
async function expectThrows(fn: () => Promise<unknown>, label: string, code?: string) {
  try {
    await fn();
    failed += 1;
    console.error(`  FAIL: ${label} (did not throw)`);
  } catch (err) {
    if (code) {
      ok(err instanceof HostingProviderError && err.code === code, `${label} (code=${code})`);
    } else {
      passed += 1;
      console.log(`    ok — ${label}`);
    }
  }
}

console.log('=== Abyss inventory + existing-file linking regression ===\n');

// ===========================================================================
// PART A — Abyss adapter BEHAVIORAL against the REAL /v1/resources contract
// ===========================================================================

const { AbyssAdapter } = await import('../src/lib/server/hosting/abyss/adapter');
const { abyssStatusMapper, normalizeAbyssFileList } = await import('../src/lib/server/hosting/abyss/normalize');

type MockResponse = { status?: number; json?: unknown; headers?: Record<string, string> };
const makeFetcher = (handler: (req: { method: string; url: string; body?: unknown }) => MockResponse): HostingHttpFetcher =>
  async (request) => {
    const mock = handler(request);
    const status = mock.status ?? 200;
    if (!(status >= 200 && status < 300)) {
      throw new HostingProviderError('AUTHENTICATION', { httpStatus: status });
    }
    return { status, ok: true, json: (mock.json ?? null) as never, headers: mock.headers ?? {} };
  };

/** The REAL contract shape, straight from the official dashboard docs. */
const realResourcesPage = (files: Array<Record<string, unknown>>, pageToken?: string) => ({
  name: 'Root',
  breadcrumbs: [],
  domainEmbed: 'domain-iframe',
  items: files,
  ...(pageToken ? { pageToken } : {}),
});

const abyssConfig = { baseUrl: 'https://api.test.abyss', email: 'test@abyss', password: 'test-pass', apiKey: 'test-api-key' };

// A1 — real-contract discovery: the BigBuckBunny doc example + a folder row.
{
  const requests: Array<{ method: string; url: string }> = [];
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      requests.push({ method: req.method, url: req.url });
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1', expiresIn: 3600 } };
      if (req.url.includes('/v1/resources')) {
        return {
          json: realResourcesPage([
            { isDir: true, id: 'fldr1', name: 'Movies', createdAt: '2018-01-01T00:00:00.000Z' },
            { isDir: false, id: 'ltJEfKQxR', name: 'BigBuckBunny.mp4', size: 81347747, status: 'ready', resolutions: ['SD', 'HD', 'FullHD', '2K', '4K'], createdAt: '2018-01-01T00:00:00.000Z', updatedAt: '2018-01-01T00:00:00.000Z' },
            { isDir: false, id: 'w8tgUq', name: 'waiting-file.mkv', size: 1024, status: 'waiting', resolutions: [], createdAt: '2018-01-02T00:00:00.000Z' },
          ]),
        };
      }
      return { status: 404, json: null };
    }),
  });

  const assets = await adapter.listAssets(null);
  ok(assets.length === 2, 'A1.1 real contract: 2 FILES discovered (folder row excluded)');
  ok(assets.every((a) => a.providerAssetId !== 'fldr1'), 'A1.2 isDir rows never become files');
  const bunny = assets.find((a) => a.providerAssetId === 'ltJEfKQxR');
  ok(!!bunny, 'A1.3 providerAssetId = file id (no slug on resource rows)');
  ok(bunny?.filename === 'BigBuckBunny.mp4', 'A1.4 filename from name');
  ok(bunny?.sizeBytes === 81347747, 'A1.5 size normalized');
  ok(bunny?.status === 'ready', 'A1.6 status ready → ready');
  ok(bunny?.availableQualities.join(',') === 'SD,HD,FullHD,2K,4K', 'A1.7 resolutions → availableQualities');
  ok(bunny?.playbackUrl === 'https://player.abyssplayer.com/ltJEfKQxR', 'A1.8 playback URL = player.abyssplayer.com/<id>');
  const waiting = assets.find((a) => a.providerAssetId === 'w8tgUq');
  ok(waiting?.status === 'queued', 'A1.9 waiting → queued (pre-conversion)');
  const resourcesCall = requests.find((r) => r.url.includes('/v1/resources'));
  ok(!!resourcesCall, 'A1.10 /v1/resources is the inventory endpoint');
  ok(resourcesCall?.url.includes('type=files'), 'A1.11 type=files filter requested');
  ok(resourcesCall?.url.includes('maxResults=100'), 'A1.12 maxResults=100 (API default is 25 — must be explicit)');
  ok(resourcesCall?.url.includes('orderBy='), 'A1.13 orderBy requested');
  ok(!resourcesCall?.url.includes('folder_id='), 'A1.14 no snake_case folder_id param');
}
console.log('  ok — A1 real-contract discovery (14 checks)');

// A2 — pagination: 3 pages with pageToken chain → all files; loop terminates.
{
  const urls: string[] = [];
  const pageData = [
    realResourcesPage(Array.from({ length: 100 }, (_, i) => ({ isDir: false, id: `f${i}`, name: `f${i}.mp4`, status: 'ready', size: 1 })), 'page-2'),
    realResourcesPage(Array.from({ length: 100 }, (_, i) => ({ isDir: false, id: `g${i}`, name: `g${i}.mp4`, status: 'public', size: 1 })), 'page-3'),
    realResourcesPage([{ isDir: false, id: 'last', name: 'last.mp4', status: 'ready', size: 1 }]),
  ];
  let call = 0;
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      if (req.url.includes('/v1/resources')) {
        urls.push(req.url);
        return { json: pageData[Math.min(call++, pageData.length - 1)] };
      }
      return { status: 404, json: null };
    }),
  });
  const assets = await adapter.listAssets(null);
  ok(assets.length === 201, 'A2.1 pagination: all 201 files across 3 pages');
  ok(urls.length === 3, 'A2.2 exactly 3 HTTP calls (loop stops without pageToken)');
  ok(urls[1]?.includes('pageToken=page-2') ?? false, 'A2.3 pageToken forwarded');
  ok(urls[2]?.includes('pageToken=page-3') ?? false, 'A2.4 second pageToken forwarded');
  ok(assets.some((a) => a.providerAssetId === 'last' && a.status === 'ready'), 'A2.5 final page contents included');
}
console.log('  ok — A2 pagination (5 checks)');

// A3 — UNRECOGNIZED shape → typed VALIDATION error (NEVER a silent []).
// This is the exact production false-success: the old normalizer looked
// for data/files/result, the real key is items.
{
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      if (req.url.includes('/v1/resources')) return { json: { resultset: [{ id: 'x' }], meta: { total: 1 } } };
      return { status: 404, json: null };
    }),
  });
  await expectThrows(() => adapter.listAssets(null), 'A3 unrecognized shape throws (not silent [])', 'VALIDATION');
}
console.log('  ok — A3 unrecognized response shape → typed error');

// A4 — non-JSON response → typed VALIDATION error (never silent []).
{
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      if (req.url.includes('/v1/resources')) return { json: null };
      return { status: 404, json: null };
    }),
  });
  await expectThrows(() => adapter.listAssets(null), 'A4 non-JSON response throws (not silent [])', 'VALIDATION');
}
console.log('  ok — A4 non-JSON response → typed error');

// A5 — recognized EMPTY list is a legitimate zero.
{
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      if (req.url.includes('/v1/resources')) return { json: realResourcesPage([]) };
      return { status: 404, json: null };
    }),
  });
  const assets = await adapter.listAssets(null);
  ok(assets.length === 0, 'A5 items:[] is a legitimate zero (no error)');
}
console.log('  ok — A5 recognized empty list is honest zero');

// A6 — folder-scoped listing uses the REAL folderId param.
{
  const urls: string[] = [];
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      if (req.url.includes('/v1/resources')) { urls.push(req.url); return { json: realResourcesPage([]) }; }
      return { status: 404, json: null };
    }),
  });
  await adapter.listAssets('fldr42');
  ok(urls[0]?.includes('folderId=fldr42') ?? false, 'A6.1 folder scoping uses folderId (camelCase)');
}
console.log('  ok — A6 folderId param');

// A7 — status vocabulary (RC-2).
{
  const cases: Array<[string, string]> = [
    ['ready', 'ready'],
    ['public', 'ready'],
    ['active', 'ready'],
    ['waiting', 'queued'],
    ['queued', 'queued'],
    ['in-processing', 'processing'],
    ['processing', 'processing'],
    ['error', 'failed'],
    ['banned', 'failed'],
    ['weird-unknown', 'processing'],
  ];
  for (const [providerStatus, expected] of cases) {
    ok(abyssStatusMapper(providerStatus) === expected, `A7 status '${providerStatus}' → ${expected}`);
  }
}
console.log('  ok — A7 status vocabulary (10 checks)');

// A8 — getAsset: flat /v1/files/:id response (the REAL shape).
{
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      if (req.url.includes('/v1/files/ltJEfKQxR')) {
        return { json: { id: 'ltJEfKQxR', name: 'BigBuckBunny.mp4', size: 81347747, status: 'public', createdAt: '2018-01-01T00:00:00.000Z', updatedAt: '2018-01-01T00:00:00.000Z' } };
      }
      return { status: 404, json: null };
    }),
  });
  const asset = await adapter.getAsset('ltJEfKQxR');
  ok(asset.providerAssetId === 'ltJEfKQxR', 'A8.1 flat file-info: id → providerAssetId');
  ok(asset.status === 'ready', 'A8.2 public → ready (was the never-ready bug)');
  ok(asset.playbackUrl === 'https://player.abyssplayer.com/ltJEfKQxR', 'A8.3 canonical player URL constructed');
  const processing = await adapter.getProcessingStatus('ltJEfKQxR');
  ok(processing.status === 'ready', 'A8.4 processing status follows the same mapping');
}
console.log('  ok — A8 flat file-info contract (4 checks)');

// A9 — folder + move contract fixes (RC-7 latent bugs).
{
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      requests.push({ method: req.method, url: req.url, body: req.body });
      if (req.url.includes('/v1/folders/list')) return { json: { name: 'Root', breadcrumbs: [], items: [{ id: 'f1', name: 'Movies', createdAt: '2018-01-01T00:00:00.000Z' }], pageToken: null } };
      if (req.method === 'POST' && req.url.endsWith('/v1/folders')) return { json: { id: 'f2', name: 'New', createdAt: '2018-01-01T00:00:00.000Z' } };
      if (req.url.includes('/v1/files/')) return { json: { id: 'ltJEfKQxR', name: 'BigBuckBunny.mp4', status: 'ready' } };
      return { json: {} };
    }),
  });

  const folders = await adapter.listFolders('f1');
  ok(folders.length === 1 && folders[0].providerFolderId === 'f1', 'A9.1 folders listed from /v1/folders/list items');
  ok(requests.some((r) => r.url.includes('/v1/folders/list') && r.url.includes('folderId=f1')), 'A9.2 folders/list endpoint + folderId param');

  await adapter.moveAsset('ltJEfKQxR', 'f1');
  const moveReq = requests.find((r) => r.method === 'PATCH' && r.url.includes('/files/ltJEfKQxR/move'));
  ok(!!moveReq, 'A9.3 move file uses PATCH /files/:id/move');
  ok(moveReq?.url.includes('parentId=f1') ?? false, 'A9.4 move file passes parentId as QUERY param (contract)');

  await adapter.moveFolder('f1', 'f2');
  const moveFolderReq = requests.find((r) => r.method === 'PATCH' && r.url.includes('/folders/f1/move'));
  ok(moveFolderReq?.url.includes('parentId=f2') ?? false, 'A9.5 move folder uses query parentId');

  const created = await adapter.createFolder({ name: 'New', parentFolderId: 'f1' });
  ok(created.providerFolderId === 'f2', 'A9.6 create folder: FLAT response object accepted (the dashboard docs shape)');
  const createReq = requests.find((r) => r.method === 'POST' && r.url.endsWith('/v1/folders'));
  ok((createReq?.body as Record<string, unknown>)?.parentId === 'f1', 'A9.7 create folder body { name, parentId } (contract)');
}
console.log('  ok — A9 folders/move contract (7 checks)');

// A10 — upload contract unchanged (existing behavior).
{
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const adapter = new AbyssAdapter({
    config: abyssConfig,
    httpFetcher: makeFetcher((req) => {
      requests.push({ method: req.method, url: req.url, body: req.body });
      if (req.url.includes('/auth/login')) return { json: { token: 'jwt-1' } };
      if (req.url.startsWith('https://up.abyss.to/')) return { json: { slug: 'newfile1' } };
      return { json: {} };
    }),
  });
  const result = await adapter.uploadFile({ content: new Blob(['x'], { type: 'video/mp4' }), filename: 'demo.mp4', providerFolderId: null });
  ok(result.providerAssetId === 'newfile1', 'A10.1 upload response {slug} → providerAssetId');
  ok(result.playbackUrl === 'https://player.abyssplayer.com/newfile1', 'A10.2 upload playback URL uses the same player construction');
  ok(requests.some((r) => r.method === 'POST' && r.url === 'https://up.abyss.to/test-api-key'), 'A10.3 upload posts to up.abyss.to/:apiKey (unchanged)');
  // delete contract unchanged
  await adapter.deleteAsset('newfile1');
  ok(requests.some((r) => r.method === 'DELETE' && r.url.includes('/v1/files/newfile1')), 'A10.4 delete = DELETE /v1/files/:id (unchanged)');
}
console.log('  ok — A10 upload/delete contracts unchanged (4 checks)');

// ===========================================================================
// PART B — normalize unit edge cases
// ===========================================================================

// B1 — legacy tolerated shapes still work (data/files/result fallbacks).
{
  const legacy = normalizeAbyssFileList({ data: [{ id: 'a', status: 'ready' }] } as never);
  ok(legacy.length === 1 && legacy[0].providerAssetId === 'a', 'B1.1 legacy data[] tolerated');
  const legacyFiles = normalizeAbyssFileList({ files: [{ id: 'b', status: 'ready' }] } as never);
  ok(legacyFiles.length === 1, 'B1.2 legacy files[] tolerated');
}
console.log('  ok — B1 legacy shape tolerance (2 checks)');

// B2 — direct normalizer: garbage object throws.
{
  try {
    normalizeAbyssFileList({ resultset: [] } as never);
    failed += 1; console.error('  FAIL: B2 garbage shape should throw');
  } catch (err) {
    ok(err instanceof HostingProviderError && err.code === 'VALIDATION', 'B2 unrecognized keys → HostingProviderError(VALIDATION)');
  }
}
console.log('  ok — B2 normalizer refuses garbage');

// ===========================================================================
// PART C — SyncService: honest outcomes + inventory aggregates (contract)
// ===========================================================================

const syncSrc = read('src/lib/server/hosting/sync/service.ts');
ok(syncSrc.includes("inventoryValidFiles = providerAssets.filter((a) => a.status !== 'failed' && a.status !== 'deleted')"), 'C1 sync computes valid-file inventory (excludes failed/deleted)');
ok(syncSrc.includes("inventoryReadyFiles = providerAssets.filter((a) => a.status === 'ready')"), 'C2 sync computes ready-file inventory');
ok(syncSrc.includes('inventoryValidFiles,'), 'C3 inventory aggregates persisted on the sync audit');
ok(syncSrc.includes('valid_files:'), 'C4 audit details.inventory.valid_files recorded');
ok(syncSrc.includes("outcome: errors.length > 0 ? (updatedAssets > 0 ? 'partial' : 'failed') : 'success'"), 'C5 outcome honest (partial/failed when errors)');
// The audit is only written AFTER a successful listing — a throwing
// listAssets propagates (recorded as failed by the catch paths), never a
// fabricated success with zero files.
ok(syncSrc.includes('const providerAssets = await adapter.listAssets(null);'), 'C6 listing precedes any audit write');
ok(syncSrc.includes('adapter.listAssets(null)'), 'C7 sync lists via the adapter (root scope)');
console.log('  ok — C sync service contract (7 checks)');

// ===========================================================================
// PART D — HostingControlService.listProviders BEHAVIORAL (mock DB)
//         — provider inventory Assets/Ready/Linked semantics (RC on counts)
// ===========================================================================

type Row = Record<string, any>;
type Table = { rows: Row[] };

class MockBuilder2 {
  private filters: Array<{ type: string; column: string; value: any }> = [];
  private limitCount: number | null = null;
  private orderClause: { column: string; ascending: boolean } | null = null;
  constructor(private readonly table: Table) {}
  select(_columns?: string) { return this; }
  eq(column: string, value: any) { this.filters.push({ type: 'eq', column, value }); return this; }
  in(column: string, value: any[]) { this.filters.push({ type: 'in', column, value }); return this; }
  not(_op: string, column: string, value: any) { this.filters.push({ type: 'neq', column, value }); return this; }
  is(column: string, value: any) { this.filters.push({ type: 'is', column, value }); return this; }
  contains(column: string, value: Record<string, any>) { this.filters.push({ type: 'contains', column, value }); return this; }
  order(column: string, opts?: { ascending?: boolean }) { this.orderClause = { column, ascending: opts?.ascending ?? true }; return this; }
  limit(n: number) { this.limitCount = n; return this; }
  range() { return this; }
  maybeSingle() { return this; }
  private matches(row: Row): boolean {
    for (const f of this.filters) {
      const v = row[f.column];
      switch (f.type) {
        case 'eq': if (v !== f.value) return false; break;
        case 'neq': if (v === f.value) return false; break;
        case 'in': if (!Array.isArray(f.value) || !f.value.includes(v)) return false; break;
        case 'is': if (v !== null) return false; break;
        case 'contains': {
          if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
          for (const [key, expected] of Object.entries(f.value as Row)) {
            if ((v as Row)[key] !== expected) return false;
          }
          break;
        }
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
        const av = a[column] ?? ''; const bv = b[column] ?? '';
        return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    return { data: rows, error: null };
  }
  then<T1 = any, T2 = never>(onf?: ((v: any) => T1 | Promise<T1>) | null, onr?: ((r: any) => T2 | Promise<T2>) | null): Promise<T1 | T2> {
    return this.resolve().then(onf as any, onr as any);
  }
}

class MockClient2 {
  public tables: Record<string, Table> = {};
  from(table: string) {
    this.tables[table] ??= { rows: [] };
    return new MockBuilder2(this.tables[table]);
  }
}

const { HostingControlService } = await import('../src/lib/server/hosting/control/service');

function baseProviderDb(): MockClient2 {
  const client = new MockClient2();
  client.tables['streaming_providers'] = {
    rows: [
      { id: 'prov-vidara', slug: 'vidara', name: 'Vidara', adapter_id: 'vidara', enabled: true, status: 'active' },
      { id: 'prov-abyss', slug: 'abyss', name: 'Abyss', adapter_id: 'abyss', enabled: true, status: 'active' },
    ],
  };
  client.tables['streaming_sources'] = {
    rows: [
      { id: 'src-vidara', slug: 'mavero-1', name: 'Mavero 1', provider_id: 'prov-vidara', status: 'experimental', enabled: true },
      { id: 'src-abyss', slug: 'mavero-2', name: 'Mavero 2', provider_id: 'prov-abyss', status: 'experimental', enabled: true },
    ],
  };
  client.tables['media_assets'] = { rows: [] };
  client.tables['media_operations'] = { rows: [] };
  return client;
}

// D1 — the task's example: 3 valid provider files, 3 ready, 2 linked.
{
  const client = baseProviderDb();
  client.tables['media_operations'].rows = [
    {
      action: 'sync',
      details: { sync: true, adapter: 'abyss', outcome: 'success', total_provider_assets: 3, inventory: { valid_files: 3, ready_files: 3 } },
      created_at: '2026-10-04T10:00:00Z',
    },
  ];
  client.tables['media_assets'].rows = [
    { provider_source_id: 'src-abyss', provider_asset_id: 'f1', status: 'ready', mavero_status: 'available' },
    { provider_source_id: 'src-abyss', provider_asset_id: 'f2', status: 'ready', mavero_status: 'available' },
    // third provider file is UNLINKED — no row can exist (NOT NULL media_item_id)
  ];
  const service = new HostingControlService(client as never);
  const overviews = await service.listProviders({ skipHealth: true });
  const abyss = overviews.find((o) => o.adapterId === 'abyss');
  ok(abyss?.inventory?.assets === 3, 'D1.1 Assets=3 (all valid provider files, incl. the unlinked one)');
  ok(abyss?.inventory?.ready === 3, 'D1.2 Ready=3');
  ok(abyss?.inventory?.linked === 2, 'D1.3 Linked=2 (live media_assets association)');
  ok(abyss?.lastSyncOutcome === 'success', 'D1.4 last sync outcome surfaced');
}
console.log('  ok — D1 task example: 3/3/2 (4 checks)');

// D2 — no audit rows → inventory null (honest unknown, not a fake zero).
{
  const client = baseProviderDb();
  const service = new HostingControlService(client as never);
  const overviews = await service.listProviders({ skipHealth: true });
  const abyss = overviews.find((o) => o.adapterId === 'abyss');
  ok(abyss?.inventory === null, 'D2.1 never synced → inventory null');
  ok(abyss?.lastSyncOutcome === null, 'D2.2 no outcome');
}
console.log('  ok — D2 honest unknown when never synced');

// D3 — pre-hardening audit rows (no inventory field) → null, not 0.
{
  const client = baseProviderDb();
  client.tables['media_operations'].rows = [
    { action: 'sync', details: { sync: true, adapter: 'abyss', outcome: 'success', total_provider_assets: 0 }, created_at: '2026-10-03T17:10:19Z' },
  ];
  const service = new HostingControlService(client as never);
  const overviews = await service.listProviders({ skipHealth: true });
  ok(overviews.find((o) => o.adapterId === 'abyss')?.inventory === null, 'D3.1 pre-hardening success audit (the false-zero kind) → inventory null');
}
console.log('  ok — D3 pre-hardening audits ignored (no fake 0)');

// D4 — latest sync FAILED → outcome failed + error message; inventory falls
//      back to the previous SUCCESS row (a failed listing is unknown, not 0).
{
  const client = baseProviderDb();
  client.tables['media_operations'].rows = [
    { action: 'sync', details: { sync: true, adapter: 'abyss', outcome: 'failed', total_provider_assets: 0, first_error: { errorCode: 'VALIDATION', errorMessage: 'Abyss resources response has no recognized file list' } }, created_at: '2026-10-04T12:00:00Z', error_message: 'Abyss resources response has no recognized file list' },
    { action: 'sync', details: { sync: true, adapter: 'abyss', outcome: 'success', total_provider_assets: 4, inventory: { valid_files: 4, ready_files: 2 } }, created_at: '2026-10-04T10:00:00Z' },
  ];
  client.tables['media_assets'].rows = [
    { provider_source_id: 'src-abyss', provider_asset_id: 'f1', status: 'ready', mavero_status: 'available' },
    { provider_source_id: 'src-abyss', provider_asset_id: 'f2', status: 'ready', mavero_status: 'missing' },
    { provider_source_id: 'src-abyss', provider_asset_id: 'f3', status: 'deleted', mavero_status: 'missing' },
  ];
  const service = new HostingControlService(client as never);
  const overviews = await service.listProviders({ skipHealth: true });
  const abyss = overviews.find((o) => o.adapterId === 'abyss');
  ok(abyss?.lastSyncOutcome === 'failed', 'D4.1 latest failed sync surfaced as outcome=failed');
  ok(typeof abyss?.lastSyncError === 'string' && (abyss?.lastSyncError ?? '').length > 0, 'D4.2 failed sync error message surfaced');
  ok(abyss?.inventory?.assets === 4, 'D4.3 inventory falls back to the LAST SUCCESS sync');
  ok(abyss?.inventory?.ready === 2, 'D4.4 ready from the success snapshot');
  ok(abyss?.inventory?.linked === 2, 'D4.5 linked counts non-deleted rows (detached still linked; deleted excluded)');
}
console.log('  ok — D4 failed-sync visibility + fallback inventory (5 checks)');

// D5 — per-asset reconcile events (action='sync' WITHOUT details.sync) are
//      never mistaken for provider sync summaries.
{
  const client = baseProviderDb();
  client.tables['media_operations'].rows = [
    { action: 'sync', details: { reconcile: true, adapter: 'abyss', new_status: 'ready' }, created_at: '2026-10-04T11:00:00Z' },
    { action: 'sync', details: { sync: true, adapter: 'abyss', outcome: 'success', inventory: { valid_files: 1, ready_files: 1 } }, created_at: '2026-10-04T10:00:00Z' },
  ];
  const service = new HostingControlService(client as never);
  const overviews = await service.listProviders({ skipHealth: true });
  const abyss = overviews.find((o) => o.adapterId === 'abyss');
  ok(abyss?.inventory?.assets === 1, 'D5.1 reconcile events ignored — the sync summary row used');
  ok(abyss?.lastSyncOutcome === 'success', 'D5.2 reconcile event not mistaken for a sync outcome');
}
console.log('  ok — D5 reconcile events filtered (2 checks)');

// D6 — deleted provider files are not "linked" (stale rows don't count).
{
  const client = baseProviderDb();
  client.tables['media_operations'].rows = [
    { action: 'sync', details: { sync: true, adapter: 'abyss', outcome: 'success', inventory: { valid_files: 2, ready_files: 2 } }, created_at: '2026-10-04T10:00:00Z' },
  ];
  client.tables['media_assets'].rows = [
    { provider_source_id: 'src-abyss', provider_asset_id: 'f1', status: 'ready', mavero_status: 'available' },
    { provider_source_id: 'src-abyss', provider_asset_id: 'f2', status: 'deleted', mavero_status: 'missing' },
  ];
  const service = new HostingControlService(client as never);
  const overviews = await service.listProviders({ skipHealth: true });
  ok(overviews.find((o) => o.adapterId === 'abyss')?.inventory?.linked === 1, 'D6.1 terminal-deleted row excluded from linked');
}
console.log('  ok — D6 deleted assets excluded from linked');

// D7 — assetCounts (drawer diagnostics) semantics unchanged.
{
  const client = baseProviderDb();
  client.tables['media_assets'].rows = [
    { provider_source_id: 'src-abyss', provider_asset_id: 'f1', status: 'ready', mavero_status: 'available' },
    { provider_source_id: 'src-abyss', provider_asset_id: 'f2', status: 'ready', mavero_status: 'missing' },
    { provider_source_id: 'src-abyss', provider_asset_id: 'f3', status: 'processing', mavero_status: 'processing' },
    { provider_source_id: 'src-abyss', provider_asset_id: 'f4', status: 'deleted', mavero_status: 'missing' },
  ];
  const service = new HostingControlService(client as never);
  const overviews = await service.listProviders({ skipHealth: true });
  const abyss = overviews.find((o) => o.adapterId === 'abyss');
  ok(abyss?.assetCounts?.total === 1 && abyss?.assetCounts?.ready === 1, 'D7.1 usable total/ready = dual-gate (ready+available only)');
  ok(abyss?.assetCounts?.processing === 1, 'D7.2 processing diagnostic');
  ok(abyss?.assetCounts?.deleted === 1, 'D7.3 deleted diagnostic');
  ok(abyss?.assetCounts?.detached === 1, 'D7.4 detached diagnostic');
}
console.log('  ok — D7 assetCounts diagnostics unchanged (4 checks)');

// ===========================================================================
// PART E — listUnlinkedProviderFiles honest errors (RC-5)
// ===========================================================================

const { ManagementService } = await import('../src/lib/server/hosting/management/service');
const { CanonicalMediaService } = await import('../src/lib/server/hosting/media/service');

// E1 — unconfigured adapter throws (was silent []).
{
  const client = new MockClient2();
  const mgmt = new ManagementService(client as never, new CanonicalMediaService(client as never));
  await expectThrows(() => mgmt.listUnlinkedProviderFiles('abyss'), 'E1 unconfigured adapter → typed error', 'UNSUPPORTED');
}
console.log('  ok — E1 unconfigured adapter is an honest error');

// E2 — configured adapter with unlinked + linked files → only unlinked listed.
//      (Env stubs make the registry null-config — exercise via source pins +
//       the already-verified adapter filter logic instead of a live adapter.)
const mgmtSrc = read('src/lib/server/hosting/management/service.ts');
ok(mgmtSrc.includes(`throw new HostingProviderError('UNSUPPORTED'`) && mgmtSrc.includes('hosting adapter is not configured'), 'E2.1 unconfigured adapter throws UNSUPPORTED with a reason');
ok(mgmtSrc.includes(`throw new HostingProviderError('NOT_FOUND'`) && mgmtSrc.includes('No streaming source row is registered'), 'E2.2 missing source row throws NOT_FOUND');
ok(mgmtSrc.includes('!linkedIds.has(f.providerAssetId)'), 'E2.3 already-linked provider files filtered out');
console.log('  ok — E2 honest errors + link filter (3 checks)');

// ===========================================================================
// PART F — linkAsset canonical guards (the operation Missing Media reuses)
// ===========================================================================

ok(mgmtSrc.includes('async linkAsset('), 'F1 linkAsset canonical operation exists');
ok(mgmtSrc.includes("existingRow.mavero_status === 'missing' && existingRow.media_item_id === mediaItemId"), 'F2 detached + same item → reactivate');
ok(mgmtSrc.includes('idempotent: true'), 'F3 same item + available → idempotent (no duplicate)');
ok(mgmtSrc.includes('already linked to a different media asset'), 'F4 different item → rejected (detach first)');
ok(mgmtSrc.includes("code = 'DUPLICATE_PROVIDER_ASSET'"), 'F5 UNIQUE violation → DUPLICATE_PROVIDER_ASSET');
ok(mgmtSrc.includes("code = 'ASSET_DELETED'") || mgmtSrc.includes("'ASSET_DELETED'"), 'F6 terminal deleted rows rejected');
ok(mgmtSrc.includes('adapter.getAsset(providerAssetId)'), 'F7 link verifies the file with the adapter (provider identity inside the adapter)');
ok(mgmtSrc.includes('demandService.resolveDemand('), 'F8 link resolves the missing-media demand');
ok(mgmtSrc.includes('playback_url: assetInfo.playbackUrl'), 'F9 playback URL persisted from the adapter (never copied from the dashboard)');
console.log('  ok — F linkAsset guards intact (9 checks)');

// ===========================================================================
// PART G — Missing Media → Link Existing File endpoint + UI (RC-4)
// ===========================================================================

const missingLinkRoute = read('src/routes/api/admin/media/missing/link/+server.ts');
ok(missingLinkRoute.includes("export const POST"), 'G1 POST /api/admin/media/missing/link exists');
ok(missingLinkRoute.includes('await requireAdmin(locals'), 'G2 requireAdmin enforced');
ok(missingLinkRoute.includes('UUID_RE.test(requestId)') && missingLinkRoute.includes('UUID_RE.test(providerSourceId)'), 'G3 UUID validation for requestId + providerSourceId');
ok(missingLinkRoute.includes("from('media_availability_requests')"), 'G4 demand row loaded by id');
ok(missingLinkRoute.includes('ensureMovie') && missingLinkRoute.includes('ensureSeries') && missingLinkRoute.includes('ensureEpisode') && missingLinkRoute.includes('ensureAnime'), 'G5 canonical media item ensured (movie/series/anime — the UploadService pattern)');
ok(missingLinkRoute.includes('management.linkAsset('), 'G6 delegates to the CANONICAL linkAsset (no duplicated link logic)');
ok(!missingLinkRoute.includes("'vidara'") && !missingLinkRoute.includes("'abyss'"), 'G7 provider-AGNOSTIC — no provider hardcode');
ok(missingLinkRoute.includes('HostingProviderError'), 'G8 typed errors mapped to honest 400s');
ok(missingLinkRoute.includes('providerSourceId (the hosting provider source id'), 'G9 docs: body contract documented');
console.log('  ok — G missing/link endpoint contract (9 checks)');

const missingPage = read('src/routes/admin/media/missing/+page.svelte');
ok(missingPage.includes('Link existing'), 'G10 Missing Media card exposes the Link existing action');
ok(missingPage.includes("'/api/admin/media/missing/link'"), 'G11 UI posts to the link endpoint');
ok(missingPage.includes('/api/admin/hosting/providers/'), 'G12 file picker consumes the generic unlinked-files API');
ok(missingPage.includes('await invalidateAll();'), 'G13 invalidateAll refreshes demand/library/counts');
ok(missingPage.includes('uploadUrl(req)'), 'G14 Upload action preserved (distinct from Link)');
ok(missingPage.includes('no re-upload') || missingPage.includes('no re-upload') || missingPage.includes('WITHOUT re-uploading'), 'G15 UX distinguishes link from upload');
ok(missingPage.includes('Escape'), 'G16 sheet closes on Escape');
console.log('  ok — G Missing Media UI contract (7 checks)');

// ===========================================================================
// PART H — provider files endpoint: registry-derived, future adapters
// ===========================================================================

const filesRoute = read('src/routes/api/admin/hosting/providers/[adapterId]/files/+server.ts');
ok(filesRoute.includes('getHostingAdapterKeys'), 'H1 whitelist derived from the hosting registry');
ok(!filesRoute.includes("new Set(['vidara', 'abyss'])"), 'H2 no hardcoded provider list');
ok(filesRoute.includes('await requireAdmin(locals'), 'H3 admin-only');
const registrySrc = read('src/lib/server/hosting/registry.ts');
ok(registrySrc.includes('ADAPTER_ID_TO_KEY'), 'H4 registry remains the single adapter map');
console.log('  ok — H files endpoint genericity (4 checks)');

// ===========================================================================
// PART I — VIDARA PROTECTION (no regressions)
// ===========================================================================

const vidaraNormalizeSrc = read('src/lib/server/hosting/vidara/normalize.ts');
const vidaraAdapterSrc = read('src/lib/server/hosting/vidara/adapter.ts');
ok(vidaraNormalizeSrc.includes('VIDARA_EMBED_URL_BASE') || vidaraNormalizeSrc.includes('vidara.to/e/'), 'I1 Vidara playback URL construction unchanged (vidara.to/e/)');
ok(vidaraAdapterSrc.includes("'/v1/video/list'"), 'I2 Vidara listAssets endpoint unchanged');
ok(vidaraAdapterSrc.includes("'/v1/video/info'"), 'I3 Vidara file info endpoint unchanged');
ok(vidaraAdapterSrc.includes('/v1/video/status'), 'I4 Vidara encoding-status flow unchanged');
// The Vidara guard is behavior-preserving: recognized shapes (incl. result
// null) keep returning [], only keyless garbage throws.
const { normalizeVidaraFileList } = await import('../src/lib/server/hosting/vidara/normalize');
{
  const files = normalizeVidaraFileList({ result: { videos: [{ file_code: 'abc', status: 1, title: 'T' }] } } as never);
  ok(files.length === 1 && files[0].providerAssetId === 'abc', 'I5 Vidara result.videos shape works (unchanged)');
  const empty = normalizeVidaraFileList({ result: null } as never);
  ok(Array.isArray(empty) && empty.length === 0, 'I6 Vidara result:null still [] (behavior preserved)');
  try {
    normalizeVidaraFileList({ msg: 'OK', status: 200 } as never);
    failed += 1; console.error('  FAIL: I7 keyless error body should throw');
  } catch (err) {
    ok(err instanceof HostingProviderError && err.code === 'VALIDATION', 'I7 Vidara keyless error body → typed error (the silent-zero guard)');
  }
}
console.log('  ok — I Vidara protection (7 checks)');

// ===========================================================================
// PART J — upload flow untouched (existing behavior)
// ===========================================================================

const uploadServiceSrc = read('src/lib/server/hosting/upload/service.ts');
ok(uploadServiceSrc.includes('async createOperation('), 'J1 upload createOperation unchanged');
ok(uploadServiceSrc.includes('this.mediaService.ensureMovie(') && uploadServiceSrc.includes('this.mediaService.ensureEpisode('), 'J2 upload ensure pattern unchanged (the same pattern the link endpoint reuses)');
ok(uploadServiceSrc.includes('private async createMediaAsset('), 'J3 upload asset creation unchanged');
console.log('  ok — J upload flow untouched (3 checks)');

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n=== Abyss inventory + linking regression: ${passed} checks passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
export {};
