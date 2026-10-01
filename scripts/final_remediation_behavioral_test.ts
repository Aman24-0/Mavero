/**
 * FINAL REMEDIATION — BEHAVIORAL TESTS (not source-regex tests).
 *
 * These tests exercise REAL service behavior against an in-memory mock of
 * the Supabase query-builder surface. They verify the state transitions
 * that static regex tests cannot:
 *
 *   A. DemandService.sweepResolvedDemand resolves ALL open demands when
 *      multiple assets become ready (the .limit(1) collapse bug — the
 *      A/B/C scenario from the remediation prompt).
 *   B. sweepResolvedDemand does NOT resolve demands whose assets are
 *      detached (mavero_status='missing') or failed.
 *   C. DemandService.recordDemand does NOT create demand when a
 *      ready+available asset exists (lifecycle guard).
 *   D. OperationsService.listJobs — the UNIFIED operational read model:
 *      merged stream, deleted filter, delete type filter, counts.
 *   E. OperationsService.listJobs — status='stale' is pushed down to the
 *      DB query (STALE_STATES + updated_at threshold), matching rows.
 *
 * The mock implements the subset of the PostgREST builder used by the
 * services under test: from/select/eq/neq/in/lt/or/order/limit/range/
 * maybeSingle/update/insert + thenable resolution.
 */

import { strict as assert } from 'node:assert';

// ============================================================
// In-memory mock Supabase client
// ============================================================

type Row = Record<string, any>;

type Table = {
  name: string;
  rows: Row[];
};

class MockBuilder {
  private filters: Array<{ type: string; column: string; value: any }> = [];
  private updatePayload: Row | null = null;
  private insertPayload: Row | null = null;
  private isUpdate = false;
  private isInsert = false;
  private maybeSingleMode = false;
  private limitCount: number | null = null;
  private selectCount: 'exact' | null = null;
  private orderClause: { column: string; ascending: boolean } | null = null;
  // Tracks updates applied to the table (for assertions).
  public appliedUpdates: Array<{ filters: Array<{ type: string; column: string; value: any }>; payload: Row }> = [];
  public appliedInserts: Row[] = [];

  constructor(
    private readonly table: Table,
    private readonly recorder: MockClient,
  ) {}

  select(_columns?: string, options?: { count?: 'exact' }) {
    if (options?.count) this.selectCount = options.count;
    return this;
  }

  eq(column: string, value: any) { this.filters.push({ type: 'eq', column, value }); return this; }
  neq(column: string, value: any) { this.filters.push({ type: 'neq', column, value }); return this; }
  in(column: string, value: any[]) { this.filters.push({ type: 'in', column, value }); return this; }
  lt(column: string, value: any) { this.filters.push({ type: 'lt', column, value }); return this; }
  gt(column: string, value: any) { this.filters.push({ type: 'gt', column, value }); return this; }
  is(column: string, value: any) { this.filters.push({ type: 'is', column, value }); return this; }
  not(_op: string, column: string, value: any) { this.filters.push({ type: 'neq', column, value }); return this; }
  or(_filter: string) { this.filters.push({ type: 'noop-or', column: '', value: '' }); return this; }
  order(column: string, opts?: { ascending?: boolean }) { this.orderClause = { column, ascending: opts?.ascending ?? true }; return this; }
  limit(n: number) { this.limitCount = n; return this; }
  range(_from: number, _to: number) { return this; }
  maybeSingle() { this.maybeSingleMode = true; return this; }

  update(payload: Row, opts?: { count?: 'exact' }) {
    this.isUpdate = true;
    this.updatePayload = payload;
    if (opts?.count) this.selectCount = opts.count;
    return this;
  }

  insert(payload: Row) {
    this.isInsert = true;
    this.insertPayload = payload;
    return this;
  }

  /** Evaluates the recorded filters against a row. */
  private matches(row: Row): boolean {
    for (const f of this.filters) {
      const v = row[f.column];
      switch (f.type) {
        case 'eq': if (v !== f.value) return false; break;
        case 'neq': if (v === f.value) return false; break;
        case 'in': if (!Array.isArray(f.value) || !f.value.includes(v)) return false; break;
        case 'lt': if (!(v < f.value)) return false; break;
        case 'gt': if (!(v > f.value)) return false; break;
        case 'is': if (v !== null) return false; break;
        case 'noop-or': break; // or-filter not modeled; tests avoid relying on it
        default: break;
      }
    }
    return true;
  }

  private applyToRows(): Row[] {
    let rows = this.table.rows.filter((r) => this.matches(r));
    if (this.orderClause) {
      const col = this.orderClause.column;
      const asc = this.orderClause.ascending;
      rows = [...rows].sort((a, b) => {
        const av = a[col], bv = b[col];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return asc ? cmp : -cmp;
      });
    }
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  async then(resolve: (value: any) => void, reject: (reason?: any) => void) {
    try {
      if (this.isUpdate && this.updatePayload) {
        // Apply the update to matching rows (in place).
        const matched = this.applyToRows();
        for (const row of matched) Object.assign(row, this.updatePayload);
        this.recorder.logUpdate(this.table.name, this.filters, this.updatePayload, matched.length);
        resolve({ data: matched, error: null, count: this.selectCount === 'exact' ? matched.length : null });
        return;
      }
      if (this.isInsert && this.insertPayload) {
        this.table.rows.push({ ...this.insertPayload });
        this.recorder.logInsert(this.table.name, this.insertPayload);
        resolve({ data: [this.insertPayload], error: null, count: this.selectCount === 'exact' ? 1 : null });
        return;
      }
      const rows = this.applyToRows();
      const data = this.maybeSingleMode ? (rows[0] ?? null) : rows;
      resolve({ data, error: null, count: this.selectCount === 'exact' ? rows.length : null });
    } catch (err) {
      reject(err);
    }
  }
}

class MockClient {
  public tables: Map<string, Table> = new Map();
  public updates: Array<{ table: string; filters: any[]; payload: Row; count: number }> = [];
  public inserts: Array<{ table: string; payload: Row }> = [];

  table(name: string): Table {
    if (!this.tables.has(name)) this.tables.set(name, { name, rows: [] });
    return this.tables.get(name)!;
  }

  logUpdate(table: string, filters: any[], payload: Row, count: number) {
    this.updates.push({ table, filters, payload, count });
  }

  logInsert(table: string, payload: Row) {
    this.inserts.push({ table, payload });
  }

  from(name: string): any {
    return new MockBuilder(this.table(name), this);
  }

  // Helpers for tests
  seed(name: string, rows: Row[]) {
    const t = this.table(name);
    t.rows = rows.map((r) => ({ ...r }));
  }

  lastUpdateOn(table: string) {
    const ups = this.updates.filter((u) => u.table === table);
    return ups.length ? ups[ups.length - 1] : null;
  }
}

// The services take SupabaseClient<Database> — cast the mock.
function asClient(mock: MockClient): any {
  return mock as any;
}

// ============================================================
// Import the services under test (relative to this script).
// ============================================================

import { DemandService } from '../src/lib/server/hosting/demand/service';
import { OperationsService } from '../src/lib/server/hosting/operations/service';

let passed = 0;
let failed = 0;
function ok(name: string) { passed++; console.log(`  ok - ${name}`); }
function fail(name: string, err: unknown) {
  failed++;
  console.error(`  FAIL - ${name}`);
  console.error(err instanceof Error ? err.message : String(err));
}

// ============================================================
// A. sweepResolvedDemand — the A/B/C scenario (the .limit(1) bug)
// ============================================================
async function testSweepResolvesAll() {
  const mock = new MockClient();
  // Three open demands (A, B, C).
  mock.seed('media_availability_requests', [
    { id: 'd1', canonical_key: 'movie:tmdb:A', status: 'open', request_count: 2 },
    { id: 'd2', canonical_key: 'movie:tmdb:B', status: 'open', request_count: 1 },
    { id: 'd3', canonical_key: 'movie:tmdb:C', status: 'open', request_count: 5 },
  ]);
  // Three media items.
  mock.seed('media_items', [
    { id: 'iA', canonical_key: 'movie:tmdb:A' },
    { id: 'iB', canonical_key: 'movie:tmdb:B' },
    { id: 'iC', canonical_key: 'movie:tmdb:C' },
  ]);
  // THREE ready+available assets — one per item. Under the old .limit(1)
  // bug only ONE of these rows was returned, so only one demand resolved.
  mock.seed('media_assets', [
    { id: 'a1', media_item_id: 'iA', status: 'ready', mavero_status: 'available' },
    { id: 'a2', media_item_id: 'iB', status: 'ready', mavero_status: 'available' },
    { id: 'a3', media_item_id: 'iC', status: 'ready', mavero_status: 'available' },
  ]);

  const service = new DemandService(asClient(mock));
  const resolved = await service.sweepResolvedDemand();

  const requests = mock.table('media_availability_requests').rows;
  const a = requests.find((r) => r.id === 'd1');
  const b = requests.find((r) => r.id === 'd2');
  const c = requests.find((r) => r.id === 'd3');

  assert.equal(a?.status, 'ready', 'demand A should be resolved to ready');
  assert.equal(b?.status, 'ready', 'demand B should be resolved to ready');
  assert.equal(c?.status, 'ready', 'demand C should be resolved to ready');
  assert.equal(resolved, 3, 'sweep should report 3 resolved rows');
  ok('A. sweepResolvedDemand resolves ALL THREE open demands (A/B/C — no .limit(1) collapse)');
}

// ============================================================
// A2. sweepResolvedDemand skips detached/failed assets
// ============================================================
async function testSweepSkipsUnavailable() {
  const mock = new MockClient();
  mock.seed('media_availability_requests', [
    { id: 'd1', canonical_key: 'movie:tmdb:X', status: 'open', request_count: 1 },
    { id: 'd2', canonical_key: 'movie:tmdb:Y', status: 'open', request_count: 1 },
  ]);
  mock.seed('media_items', [
    { id: 'iX', canonical_key: 'movie:tmdb:X' },
    { id: 'iY', canonical_key: 'movie:tmdb:Y' },
  ]);
  // X's asset is ready but DETACHED (mavero_status='missing') — not playable.
  // Y's asset failed processing.
  mock.seed('media_assets', [
    { id: 'a1', media_item_id: 'iX', status: 'ready', mavero_status: 'missing' },
    { id: 'a2', media_item_id: 'iY', status: 'failed', mavero_status: 'failed' },
  ]);

  const service = new DemandService(asClient(mock));
  const resolved = await service.sweepResolvedDemand();
  const requests = mock.table('media_availability_requests').rows;
  assert.equal(resolved, 0, 'no demands should resolve');
  assert.equal(requests.find((r) => r.id === 'd1')?.status, 'open', 'detached asset does NOT resolve demand');
  assert.equal(requests.find((r) => r.id === 'd2')?.status, 'open', 'failed asset does NOT resolve demand');
  ok('A2. sweep does NOT resolve demands for detached/failed assets (dual gate)');
}

// ============================================================
// B. sweepStaleResolvedDemand — reopen when the last asset is deleted
// ============================================================
async function testSweepReopens() {
  const mock = new MockClient();
  mock.seed('media_availability_requests', [
    { id: 'd1', canonical_key: 'movie:tmdb:D1', status: 'ready', request_count: 3 },
    { id: 'd2', canonical_key: 'movie:tmdb:D2', status: 'ready', request_count: 2 },
  ]);
  mock.seed('media_items', [
    { id: 'iD1', canonical_key: 'movie:tmdb:D1' },
    { id: 'iD2', canonical_key: 'movie:tmdb:D2' },
  ]);
  // D1: only asset is DELETED → demand must reopen.
  // D2: still has a ready+available asset → demand stays ready.
  mock.seed('media_assets', [
    { id: 'a1', media_item_id: 'iD1', status: 'deleted', mavero_status: 'missing' },
    { id: 'a2', media_item_id: 'iD2', status: 'ready', mavero_status: 'available' },
  ]);

  const service = new DemandService(asClient(mock));
  const reopened = await service.sweepStaleResolvedDemand();
  const requests = mock.table('media_availability_requests').rows;
  assert.equal(requests.find((r) => r.id === 'd1')?.status, 'open', 'deleted last asset reopens demand');
  assert.equal(requests.find((r) => r.id === 'd2')?.status, 'ready', 'available asset keeps demand ready');
  assert.equal(reopened, 1);
  ok('B. sweepStaleResolvedDemand reopens D1 (asset deleted), keeps D2 ready (asset available)');
}

// ============================================================
// C. recordDemand availability guard
// ============================================================
async function testRecordDemandGuard() {
  const mock = new MockClient();
  mock.seed('media_items', [
    { id: 'iG', canonical_key: 'movie:tmdb:GUARD' },
  ]);
  mock.seed('media_assets', [
    { id: 'aG', media_item_id: 'iG', status: 'ready', mavero_status: 'available' },
  ]);
  // NO pre-existing demand row.

  const service = new DemandService(asClient(mock));
  const result = await service.recordDemand({
    canonicalKey: 'movie:tmdb:GUARD',
    contentType: 'movie',
    tmdbId: 'GUARD',
    title: 'Guarded Movie',
    userKind: 'authenticated',
  });

  const rows = mock.table('media_availability_requests').rows;
  assert.equal(rows.length, 0, 'no demand row must be created while an available asset exists');
  assert.equal(mock.inserts.filter((i) => i.table === 'media_availability_requests').length, 0, 'no insert issued');
  ok(`C. recordDemand skips creation when a ready+available asset exists (result status=${result?.status ?? 'null'})`);
}

// ============================================================
// D. OperationsService.listJobs — unified operational read model
// ============================================================
async function testUnifiedJobs() {
  const now = new Date().toISOString();
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
  const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();

  const mock = new MockClient();
  // Two upload pipeline jobs.
  mock.seed('media_upload_operations', [
    {
      id: '11111111-1111-1111-1111-111111111111', status: 'ready', attempt_number: 1,
      parent_operation_id: null, provider_source_id: 'src-vidara', media_item_id: 'm1',
      media_asset_id: 'as1', provider_asset_id: 'vid-file-1', source_quality: '1080p',
      source_filename: 'a.mp4', source_url: null, error_code: null, error_message: null,
      queued_at: twentyMinAgo, upload_started_at: twentyMinAgo, uploaded_at: fifteenMinAgo,
      processing_started_at: fifteenMinAgo, ready_at: tenMinAgo, failed_at: null, cancelled_at: null,
      created_at: twentyMinAgo, updated_at: tenMinAgo, media_item: { id: 'm1', title: 'Movie One', content_type: 'movie', tmdb_id: '1', season: null, episode: null },
    },
    {
      id: '22222222-2222-2222-2222-222222222222', status: 'failed', attempt_number: 2,
      parent_operation_id: '11111111-1111-1111-1111-111111111111', provider_source_id: 'src-abyss',
      media_item_id: 'm2', media_asset_id: null, provider_asset_id: null, source_quality: null,
      source_filename: 'b.mkv', source_url: 'https://example.com/b.mkv', error_code: 'RATE_LIMITED',
      error_message: 'Rate limited', queued_at: twentyMinAgo, upload_started_at: twentyMinAgo,
      uploaded_at: null, processing_started_at: null, ready_at: null, failed_at: tenMinAgo,
      cancelled_at: null, created_at: twentyMinAgo, updated_at: tenMinAgo,
      media_item: { id: 'm2', title: 'Show Two', content_type: 'series', tmdb_id: '2', season: 1, episode: 1 },
    },
  ]);
  // Management operations: a successful provider_delete + a successful sync.
  mock.seed('media_operations', [
    {
      id: '33333333-3333-3333-3333-333333333333', action: 'provider_delete', status: 'success',
      error_code: null, error_message: null, details: { provider_asset_id: 'vid-file-9' },
      occurred_at: now, created_at: now, updated_at: now, provider_source_id: 'src-vidara',
      media_item_id: 'm1', media_asset_id: 'as9',
      media_item: { id: 'm1', title: 'Movie One', content_type: 'movie', tmdb_id: '1', season: null, episode: null },
      media_asset: { id: 'as9', provider_asset_id: 'vid-file-9' },
    },
    {
      id: '44444444-4444-4444-4444-444444444444', action: 'sync', status: 'success',
      error_code: null, error_message: null, details: {},
      occurred_at: fifteenMinAgo, created_at: fifteenMinAgo, updated_at: fifteenMinAgo, provider_source_id: 'src-vidara',
      media_item_id: null, media_asset_id: null,
      media_item: null, media_asset: null,
    },
  ]);
  // Provider/source resolution for adapterId back-fill.
  mock.seed('streaming_providers', [{ id: 'p-vidara', adapter_id: 'vidara' }]);
  mock.seed('streaming_sources', [{ id: 'src-vidara', provider_id: 'p-vidara' }]);

  const service = new OperationsService(asClient(mock));

  // D1: 'all' → merged stream of 4 (2 uploads + 2 management ops), newest first.
  const all = await service.listJobs({ status: 'all', sort: 'recently_updated' } as any);
  assert.equal(all.total, 4, `expected total 4, got ${all.total}`);
  assert.equal(all.items.length, 4);
  assert.equal(all.items[0].operationType, 'delete', 'newest entry should be the provider_delete op');
  assert.equal(all.items[0].origin, 'management');
  assert.equal(all.items[0].status, 'ready', 'management success maps to ready (completed)');
  assert.equal(all.items[0].providerAssetId, 'vid-file-9', 'delete row exposes the provider asset id');
  const uploadIds = all.items.filter((i) => i.origin === 'upload').map((i) => i.id);
  assert.equal(uploadIds.length, 2, 'both upload jobs present — no duplicates, no loss');
  assert.equal(new Set(uploadIds).size, 2);
  ok('D1. status=all merges uploads + management ops (4 rows, correct order, no duplicates)');

  // D2: status='deleted' → ONLY provider_delete operations.
  const deleted = await service.listJobs({ status: 'deleted' } as any);
  assert.equal(deleted.items.length, 1, `expected 1 delete job, got ${deleted.items.length}`);
  assert.equal(deleted.items[0].operationType, 'delete');
  assert.equal(deleted.items[0].origin, 'management');
  assert.equal(deleted.total, 1);
  ok('D2. status=deleted returns delete-file operations only (the Deleted filter works)');

  // D3: operationType='delete' → same single row via the Type filter.
  const deleteType = await service.listJobs({ operationType: 'delete' } as any);
  assert.equal(deleteType.items.length, 1);
  assert.equal(deleteType.items[0].operationType, 'delete');
  ok('D3. operationType=delete (Type filter) returns delete operations');

  // D4: status='failed' → failed upload + (none here) — the delete op is
  // successful so it is excluded from Failed.
  const failedQ = await service.listJobs({ status: 'failed' } as any);
  assert.equal(failedQ.items.length, 1, 'only the failed upload job');
  assert.equal(failedQ.items[0].origin, 'upload');
  assert.equal(failedQ.items[0].isRetryable, true, 'RATE_LIMITED is retryable');
  ok('D4. status=failed returns failed work from the unified stream');

  // D5: status='ready' → completed uploads + successful management ops.
  const readyQ = await service.listJobs({ status: 'ready' } as any);
  const ids = readyQ.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'].sort(), 'ready upload + delete + sync ops');
  ok('D5. status=ready covers completed uploads AND successful management ops');

  // D6: status='active' → only non-terminal uploads; management ops never active.
  const activeQ = await service.listJobs({ status: 'active' } as any);
  assert.equal(activeQ.items.length, 0, 'no active jobs in this dataset');
  ok('D6. status=active excludes instantaneous management ops');
}

// ============================================================
// E. listJobs stale filter is pushed to the DB query
// ============================================================
async function testStaleFilter() {
  const staleThresholdMs = 60 * 60 * 1000;
  const twoHoursAgo = new Date(Date.now() - 2 * staleThresholdMs).toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();

  const mock = new MockClient();
  mock.seed('media_upload_operations', [
    { id: 's1', status: 'uploading', updated_at: twoHoursAgo, created_at: twoHoursAgo, queued_at: twoHoursAgo, attempt_number: 1, provider_source_id: 'src-v', media_item: null },
    { id: 's2', status: 'uploading', updated_at: fiveMinAgo, created_at: fiveMinAgo, queued_at: fiveMinAgo, attempt_number: 1, provider_source_id: 'src-v', media_item: null },
    { id: 's3', status: 'ready', updated_at: twoHoursAgo, created_at: twoHoursAgo, queued_at: twoHoursAgo, attempt_number: 1, provider_source_id: 'src-v', media_item: null },
  ]);
  mock.seed('streaming_providers', []);
  mock.seed('streaming_sources', []);

  const service = new OperationsService(asClient(mock));
  const stale = await service.listJobs({ status: 'stale' } as any);
  // s1: uploading + older than 60 min → stale. s2: fresh → not stale.
  // s3: terminal → not stale even though old.
  assert.equal(stale.items.length, 1, `expected 1 stale job, got ${stale.items.length}`);
  assert.equal(stale.items[0].id, 's1');
  assert.equal(stale.total, 1, 'stale filter is DB-side (exact count, not post-fetch)');
  ok('E. status=stale matches exactly the stuck>60min non-terminal jobs (DB-side filter)');
}

// ============================================================
// Runner
// ============================================================
(async () => {
  console.log('--- Final remediation behavioral tests ---');
  const tests: Array<[string, () => Promise<void>]> = [
    ['A. sweep A/B/C', testSweepResolvesAll],
    ['A2. sweep skips unavailable', testSweepSkipsUnavailable],
    ['B. sweep reopens deleted', testSweepReopens],
    ['C. recordDemand guard', testRecordDemandGuard],
    ['D. unified jobs read model', testUnifiedJobs],
    ['E. stale filter pushdown', testStaleFilter],
  ];
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (err) {
      fail(name, err);
    }
  }
  console.log(`\n  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('  All behavioral tests passed.');
})();
