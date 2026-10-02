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
 *   F. Jobs Deleted-status semantics — SUCCESSFUL provider_delete rows
 *      ONLY (failed deletes excluded from Deleted, present under Failed).
 *   G. Jobs pagination invariant — rows + total + hasMore all describe the
 *      SAME filtered dataset across pages, for Deleted/Failed/search.
 *   H. Jobs retryable/stale DB-side filters — exact counts (no post-fetch
 *      desynchronization), both true and false polarities.
 *   I. Jobs mixed-source correctness — no duplicate events, source-skew
 *      pagination (many uploads + few management ops), single-source
 *      filters, and empty-result states without phantom pages.
 *
 * The mock implements the subset of the PostgREST builder used by the
 * services under test: from/select/eq/neq/in/lt/gte/is/not/or/order/
 * limit/range/maybeSingle/update/insert + thenable resolution.
 *
 * FIDELITY NOTE: the mock's `count: 'exact'` mirrors REAL PostgREST
 * semantics (verified against the live Supabase instance): the exact
 * count is the size of the FULL filtered set and IGNORES .limit() — only
 * the returned data rows are windowed. The mock also EVALUATES .or()
 * filter expressions (comma-separated `path.op.value` conditions with
 * not.in lists, is.null, ilike, neq, gte) instead of no-oping them.
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
  private orFilters: string[] = [];
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
  gte(column: string, value: any) { this.filters.push({ type: 'gte', column, value }); return this; }
  is(column: string, value: any) { this.filters.push({ type: 'is', column, value }); return this; }
  not(_op: string, column: string, value: any) { this.filters.push({ type: 'neq', column, value }); return this; }
  or(filter: string) { this.orFilters.push(filter); return this; }
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
        case 'gte': if (!(v >= f.value)) return false; break;
        case 'is': if (v !== null) return false; break;
        default: break;
      }
    }
    // Multiple .or() params are ANDed (real PostgREST behavior — verified
    // against the live instance). Within one or-group, conditions are ORed.
    for (const orFilter of this.orFilters) {
      if (!this.matchesOr(row, orFilter)) return false;
    }
    return true;
  }

  /**
   * Evaluates ONE PostgREST or-expression: a comma-separated list of
   * `path.op.value` conditions (top-level commas only — commas inside
   * parenthesized lists are part of the value). Paths may be dotted
   * join paths (e.g. media_item.title). SQL three-value logic is
   * approximated: NULL comparisons are FALSE, which is equivalent for
   * OR-lists.
   */
  private matchesOr(row: Row, orFilter: string): boolean {
    const conditions: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of orFilter) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) { conditions.push(current); current = ''; }
      else current += ch;
    }
    if (current) conditions.push(current);
    for (const cond of conditions) {
      if (this.evalOrCondition(row, cond)) return true;
    }
    return conditions.length === 0;
  }

  private evalOrCondition(row: Row, cond: string): boolean {
    // `path.not.in.(a,b,c)` — negated list membership (checked first: the
    // '.not.in.' token is unambiguous in the grammar the services emit).
    const notInIdx = cond.indexOf('.not.in.');
    if (notInIdx !== -1) {
      const path = cond.slice(0, notInIdx);
      const listStr = cond.slice(notInIdx + '.not.in.'.length);
      const list = listStr.replace(/^\(/, '').replace(/\)$/, '').split(',');
      const v = this.resolvePath(row, path);
      if (v == null) return false; // SQL: NULL NOT IN (...) → NULL (not true)
      return !list.includes(String(v));
    }
    // Generic `path.op.value`: split into dot-separated segments and find
    // the FIRST segment that is a known operator token — that marks the
    // path/op boundary. Everything after it (rejoined with '.') is the
    // value. This handles BOTH dotted join paths (media_item.title.ilike.%X%)
    // AND dotted values (updated_at.gte.2026-10-02T04:53:56.578Z).
    const KNOWN_OPS = ['eq', 'neq', 'gte', 'gt', 'lt', 'lte', 'in', 'is', 'ilike'];
    const segments = cond.split('.');
    let opIdx = -1;
    for (let i = 1; i < segments.length; i++) {
      if (KNOWN_OPS.includes(segments[i])) { opIdx = i; break; }
    }
    if (opIdx === -1) return false;
    const path = segments.slice(0, opIdx).join('.');
    const op = segments[opIdx];
    const value = segments.slice(opIdx + 1).join('.');
    const v = this.resolvePath(row, path);
    if (value === 'null') {
      if (op === 'is') return v == null;
      return false;
    }
    if (v == null) return false; // NULL comparisons are not TRUE
    switch (op) {
      case 'eq': return String(v) === value;
      case 'neq': return String(v) !== value;
      case 'gte': return v >= value;
      case 'gt': return v > value;
      case 'lt': return v < value;
      case 'lte': return v <= value;
      case 'in': {
        const list = value.replace(/^\(/, '').replace(/\)$/, '').split(',');
        return list.includes(String(v));
      }
      case 'ilike': {
        // %contains% patterns (the only form the services emit).
        const needle = value.replace(/^%/, '').replace(/%$/, '').toLowerCase();
        return String(v).toLowerCase().includes(needle);
      }
      default: return false;
    }
  }

  private resolvePath(row: Row, path: string): any {
    if (!path.includes('.')) return row[path];
    let v: any = row;
    for (const part of path.split('.')) {
      if (v == null || typeof v !== 'object') return null;
      v = v[part];
    }
    return v ?? null;
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
      // FIDELITY: real PostgREST count=exact IGNORES .limit() — the count
      // is the size of the FULL filtered set (verified against the live
      // instance: limit(2) → count = 27). Only the data rows are windowed.
      const fullFiltered = this.table.rows.filter((r) => this.matches(r));
      const count = this.selectCount === 'exact' ? fullFiltered.length : null;
      resolve({ data, error: null, count });
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
// Helpers for the F/G/H/I fixtures (unified Jobs read model)
// ============================================================
function uploadRow(opts: {
  id: string; status: string; updatedAt: string; errorCode?: string | null;
  mediaTitle?: string | null; providerAssetId?: string | null; parentOp?: string | null; sourceUrl?: string | null;
}): Row {
  return {
    id: opts.id, status: opts.status, attempt_number: 1,
    parent_operation_id: opts.parentOp ?? null, provider_source_id: 'src-vidara',
    media_item_id: 'm1', media_asset_id: null,
    provider_asset_id: opts.providerAssetId ?? null, source_quality: '1080p',
    source_filename: `${opts.id}.mp4`, source_url: opts.sourceUrl ?? null,
    error_code: opts.errorCode ?? null, error_message: opts.errorCode ? `${opts.errorCode} failure` : null,
    queued_at: opts.updatedAt, upload_started_at: opts.updatedAt, uploaded_at: null,
    processing_started_at: null, ready_at: opts.status === 'ready' ? opts.updatedAt : null,
    failed_at: opts.status === 'failed' ? opts.updatedAt : null, cancelled_at: null,
    created_at: opts.updatedAt, updated_at: opts.updatedAt,
    media_item: opts.mediaTitle === null ? null : {
      id: 'm1', title: opts.mediaTitle ?? `Media ${opts.id}`, content_type: 'movie',
      tmdb_id: '1', season: null, episode: null,
    },
  };
}

function managementRow(opts: {
  id: string; action: string; status: string; occurredAt: string;
  errorCode?: string | null; mediaTitle?: string | null; uploadOperationId?: string | null;
}): Row {
  return {
    id: opts.id, action: opts.action, status: opts.status,
    error_code: opts.errorCode ?? null,
    error_message: opts.errorCode ? `${opts.errorCode} failure` : null,
    details: { provider_asset_id: `file-${opts.id}` },
    occurred_at: opts.occurredAt, created_at: opts.occurredAt, updated_at: opts.occurredAt,
    provider_source_id: 'src-vidara', media_item_id: 'm1', media_asset_id: `as-${opts.id}`,
    upload_operation_id: opts.uploadOperationId ?? null,
    media_item: opts.mediaTitle === null ? null : {
      id: 'm1', title: opts.mediaTitle ?? `Media ${opts.id}`, content_type: 'movie',
      tmdb_id: '1', season: null, episode: null,
    },
    media_asset: { id: `as-${opts.id}`, provider_asset_id: `file-${opts.id}` },
  };
}

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

// ============================================================
// F. Jobs Deleted-status semantics (Issue A) — successful
//    provider_delete rows ONLY; failed deletes under Failed.
// ============================================================
async function testDeletedSemantics() {
  const mock = new MockClient();
  mock.seed('media_upload_operations', [
    uploadRow({ id: 'u-ready', status: 'ready', updatedAt: minutesAgo(15), mediaTitle: 'Ready Movie' }),
    uploadRow({ id: 'u-failed-retryable', status: 'failed', updatedAt: minutesAgo(25), errorCode: 'RATE_LIMITED', mediaTitle: 'Retryable Movie' }),
    uploadRow({ id: 'u-failed-permanent', status: 'failed', updatedAt: minutesAgo(35), errorCode: 'PERMANENT', mediaTitle: 'Permanent Movie' }),
  ]);
  mock.seed('media_operations', [
    managementRow({ id: 'pd-ok-1', action: 'provider_delete', status: 'success', occurredAt: minutesAgo(10), mediaTitle: 'Deleted Movie A' }),
    managementRow({ id: 'pd-ok-2', action: 'provider_delete', status: 'success', occurredAt: minutesAgo(20), mediaTitle: 'Deleted Movie B' }),
    managementRow({ id: 'pd-fail-1', action: 'provider_delete', status: 'failed', occurredAt: minutesAgo(30), errorCode: 'AUTH', mediaTitle: 'Failed Movie C' }),
    managementRow({ id: 'pd-fail-2', action: 'provider_delete', status: 'failed', occurredAt: minutesAgo(40), errorCode: 'NOT_FOUND', mediaTitle: 'Failed Movie D' }),
    managementRow({ id: 'sync-1', action: 'sync', status: 'success', occurredAt: minutesAgo(5), mediaTitle: null }),
  ]);
  mock.seed('streaming_providers', [{ id: 'p-vidara', adapter_id: 'vidara' }]);
  mock.seed('streaming_sources', [{ id: 'src-vidara', provider_id: 'p-vidara' }]);
  const service = new OperationsService(asClient(mock));

  // F1: status='deleted' → ONLY the two SUCCESSFUL provider_delete rows.
  const deleted = await service.listJobs({ status: 'deleted' } as any);
  assert.equal(deleted.total, 2, `Deleted total must be 2 (successful deletes only), got ${deleted.total}`);
  assert.equal(deleted.items.length, 2);
  assert.ok(deleted.items.every((i) => i.operationType === 'delete' && i.origin === 'management'));
  assert.ok(deleted.items.every((i) => i.status === 'ready'), 'successful deletes map to ready (completed)');
  const deletedIds = deleted.items.map((i) => i.id).sort();
  assert.deepEqual(deletedIds, ['pd-ok-1', 'pd-ok-2'], 'no failed delete ids may appear under Deleted');
  assert.ok(!deletedIds.includes('pd-fail-1') && !deletedIds.includes('pd-fail-2'), 'FAILED deletes excluded from Deleted');
  ok('F1. status=deleted → successful file deletions ONLY (failed deletes excluded)');

  // F2: status='failed' → failed deletes + failed uploads; NOT successful deletes.
  const failed = await service.listJobs({ status: 'failed' } as any);
  assert.equal(failed.total, 4, `Failed total must be 4 (2 failed deletes + 2 failed uploads), got ${failed.total}`);
  const failedIds = failed.items.map((i) => i.id).sort();
  assert.deepEqual(failedIds, ['pd-fail-1', 'pd-fail-2', 'u-failed-permanent', 'u-failed-retryable'].sort());
  assert.ok(!failedIds.includes('pd-ok-1') && !failedIds.includes('pd-ok-2'), 'successful deletes never appear under Failed');
  assert.ok(!failedIds.includes('u-ready') && !failedIds.includes('sync-1'), 'ready/successful rows never appear under Failed');
  const failedDeleteRows = failed.items.filter((i) => i.operationType === 'delete');
  assert.equal(failedDeleteRows.length, 2, 'BOTH failed deletes appear under Failed');
  assert.ok(failedDeleteRows.every((i) => i.status === 'failed' && i.origin === 'management'));
  ok('F2. status=failed includes failed delete operations (and excludes successful ones)');

  // F3: Disjointness — no operation appears in both Deleted and Failed buckets.
  const overlap = deleted.items.filter((d) => failed.items.some((f) => f.id === d.id));
  assert.equal(overlap.length, 0, 'the same operation must not appear in contradictory status buckets');
  ok('F3. Deleted and Failed buckets are disjoint (no contradictory rows)');

  // F4: Type filter ('delete') is orthogonal to status — shows ALL delete ops.
  const deleteType = await service.listJobs({ operationType: 'delete' } as any);
  assert.equal(deleteType.total, 4, `Type=Delete File shows all 4 delete operations, got ${deleteType.total}`);
  assert.equal(deleteType.items.filter((i) => i.status === 'failed').length, 2, 'failed deletes visible via Type filter with status column');
  ok('F4. operationType=delete (Type filter) is status-orthogonal (all delete outcomes, status shown per row)');

  // F5: Deleted + search — a search matching only a FAILED delete returns 0.
  const deletedSearchFail = await service.listJobs({ status: 'deleted', q: 'Movie C' } as any);
  assert.equal(deletedSearchFail.total, 0, 'failed delete must not surface via Deleted+search');
  assert.equal(deletedSearchFail.items.length, 0);
  const deletedSearchOk = await service.listJobs({ status: 'deleted', q: 'Movie A' } as any);
  assert.equal(deletedSearchOk.total, 1);
  assert.equal(deletedSearchOk.items[0].id, 'pd-ok-1');
  ok('F5. Deleted+search filters the same successful-deletes dataset (failed delete not surfaced)');
}

// ============================================================
// G. Jobs pagination invariant (Issue B) — rows + total +
//    hasMore describe the SAME dataset on every page.
// ============================================================
async function testPaginationInvariant() {
  // G fixture: 60 successful deletes (exceeds one fetch window),
  // 10 failed deletes, 5 failed uploads, 3 ready uploads.
  const mgmt: Row[] = [];
  for (let i = 0; i < 60; i++) {
    mgmt.push(managementRow({ id: `gd-${String(i).padStart(3, '0')}`, action: 'provider_delete', status: 'success', occurredAt: minutesAgo(10 + i * 5), mediaTitle: `Deleted Movie ${i}` }));
  }
  for (let i = 0; i < 10; i++) {
    mgmt.push(managementRow({ id: `fd-${String(i).padStart(3, '0')}`, action: 'provider_delete', status: 'failed', occurredAt: minutesAgo(400 + i * 5), errorCode: 'AUTH', mediaTitle: `Failed Movie ${i}` }));
  }
  const uploads: Row[] = [];
  for (let i = 0; i < 5; i++) {
    uploads.push(uploadRow({ id: `fu-${i}`, status: 'failed', updatedAt: minutesAgo(300 + i * 5), errorCode: 'PERMANENT', mediaTitle: `Failed Upload ${i}`, providerAssetId: `fail-asset-${i}` }));
  }
  for (let i = 0; i < 3; i++) {
    uploads.push(uploadRow({ id: `ru-${i}`, status: 'ready', updatedAt: minutesAgo(50 + i), mediaTitle: `Ready Upload ${i}` }));
  }
  const mock = new MockClient();
  mock.seed('media_upload_operations', uploads);
  mock.seed('media_operations', mgmt);
  mock.seed('streaming_providers', []);
  mock.seed('streaming_sources', []);
  const service = new OperationsService(asClient(mock));

  // G1–G3: Deleted pagination — 60 successful deletes, limit 10.
  // This is the regression detector for "total is source count but rows
  // are post-filtered": a query window of 10 must NOT cap the total.
  const g1 = await service.listJobs({ status: 'deleted', page: 1, limit: 10 } as any);
  assert.equal(g1.items.length, 10, 'page 1 shows 10 rows');
  assert.equal(g1.total, 60, `total must be the FULL filtered count (60), got ${g1.total} — a fetch-window-capped total is the Issue B bug`);
  assert.equal(g1.hasMore, true);
  const g3 = await service.listJobs({ status: 'deleted', page: 3, limit: 10 } as any);
  assert.equal(g3.items.length, 10); assert.equal(g3.total, 60); assert.equal(g3.hasMore, true);
  const g6 = await service.listJobs({ status: 'deleted', page: 6, limit: 10 } as any);
  assert.equal(g6.items.length, 10, 'last page is full'); assert.equal(g6.total, 60); assert.equal(g6.hasMore, false, 'no page 7');
  const g7 = await service.listJobs({ status: 'deleted', page: 7, limit: 10 } as any);
  assert.equal(g7.items.length, 0, 'beyond-last page returns 0 rows');
  assert.equal(g7.total, 60); assert.equal(g7.hasMore, false, 'no phantom page after the end');
  ok('G1. Deleted + pagination: rows/total/hasMore agree on every page (60 successful deletes, 10/page)');

  // G4: Failed pagination — 10 failed deletes + 5 failed uploads = 15.
  const f1 = await service.listJobs({ status: 'failed', page: 1, limit: 10 } as any);
  assert.equal(f1.items.length, 10); assert.equal(f1.total, 15); assert.equal(f1.hasMore, true);
  const f2 = await service.listJobs({ status: 'failed', page: 2, limit: 10 } as any);
  assert.equal(f2.items.length, 5, 'last failed page has the remaining 5 rows');
  assert.equal(f2.total, 15); assert.equal(f2.hasMore, false);
  ok('G2. Failed + pagination: 15 failed ops (10 deletes + 5 uploads), pages agree');

  // G5: Deleted + search — 60 titles 'Deleted Movie N'; 'Movie 55' → 1 row.
  const s1 = await service.listJobs({ status: 'deleted', q: 'Movie 55', page: 1, limit: 10 } as any);
  assert.equal(s1.total, 1); assert.equal(s1.items.length, 1); assert.equal(s1.hasMore, false);
  // Failed + search: failed uploads have provider_asset_id 'fail-asset-N'.
  const s2 = await service.listJobs({ status: 'failed', q: 'fail-asset', page: 1, limit: 10 } as any);
  assert.equal(s2.total, 5, `failed+search over uploads matches 5 provider_asset_ids, got ${s2.total}`);
  assert.equal(s2.items.length, 5); assert.equal(s2.hasMore, false);
  ok('G3. Deleted+search and Failed+search keep rows/total consistent');
}

// ============================================================
// H. Jobs retryable/stale DB-side filters (Issue B) — exact
//    totals for BOTH polarities; no post-fetch desync.
// ============================================================
async function testRetryableStalePushdown() {
  const hour = 60 * 60 * 1000;
  const twoHoursAgo = new Date(Date.now() - 2 * hour).toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();

  const uploads: Row[] = [];
  // 8 retryable failed uploads.
  for (let i = 0; i < 8; i++) uploads.push(uploadRow({ id: `rt-${i}`, status: 'failed', updatedAt: minutesAgo(100 + i), errorCode: 'RATE_LIMITED', mediaTitle: `Retryable ${i}` }));
  // 8 permanently-failed uploads (NOT retryable).
  for (let i = 0; i < 8; i++) uploads.push(uploadRow({ id: `pf-${i}`, status: 'failed', updatedAt: minutesAgo(200 + i), errorCode: 'PERMANENT', mediaTitle: `Permanent ${i}` }));
  // 26 stale non-terminal uploads (uploading, > 60 min old).
  for (let i = 0; i < 26; i++) uploads.push({ ...uploadRow({ id: `st-${i}`, status: 'uploading', updatedAt: twoHoursAgo, mediaTitle: `Stale ${i}` }), updated_at: twoHoursAgo });
  // 4 fresh non-terminal uploads.
  for (let i = 0; i < 4; i++) uploads.push({ ...uploadRow({ id: `fr-${i}`, status: 'uploading', updatedAt: fiveMinAgo, mediaTitle: `Fresh ${i}` }), updated_at: fiveMinAgo });
  // 1 ready upload.
  uploads.push(uploadRow({ id: 'rd-0', status: 'ready', updatedAt: minutesAgo(10), mediaTitle: 'Ready One' }));
  // Total uploads = 8 + 8 + 26 + 4 + 1 = 47.

  const mock = new MockClient();
  mock.seed('media_upload_operations', uploads);
  mock.seed('media_operations', [
    managementRow({ id: 'mg-1', action: 'sync', status: 'success', occurredAt: minutesAgo(6), mediaTitle: null }),
    managementRow({ id: 'mg-2', action: 'sync', status: 'success', occurredAt: minutesAgo(7), mediaTitle: null }),
  ]);
  mock.seed('streaming_providers', []);
  mock.seed('streaming_sources', []);
  const service = new OperationsService(asClient(mock));

  // H1: retryable=true → exactly the 8 retryable failed uploads.
  const rt = await service.listJobs({ status: 'all', retryable: true, page: 1, limit: 10 } as any);
  assert.equal(rt.total, 8, `retryable=true total must be 8, got ${rt.total}`);
  assert.equal(rt.items.length, 8);
  assert.ok(rt.items.every((i) => i.isRetryable && i.origin === 'upload'), 'all retryable rows are failed uploads with transient codes');
  assert.equal(rt.hasMore, false);
  ok('H1. retryable=true → 8 retryable uploads, exact total (no post-fetch desync)');

  // H2: retryable=false → 39 non-retryable uploads + 2 management ops = 41.
  const rf = await service.listJobs({ status: 'all', retryable: false, page: 1, limit: 10 } as any);
  assert.equal(rf.total, 41, `retryable=false total must be 41 (39 uploads + 2 management), got ${rf.total}`);
  assert.equal(rf.items.length, 10);
  assert.equal(rf.hasMore, true);
  const rfAll: any[] = [];
  for (let p = 1; p <= 5; p++) {
    const r = await service.listJobs({ status: 'all', retryable: false, page: p, limit: 10 } as any);
    rfAll.push(...r.items);
    assert.equal(r.total, 41, `total constant across pages (page ${p})`);
  }
  assert.equal(rfAll.length, 41, 'pagination walks exactly the filtered dataset');
  assert.equal(rfAll.filter((i) => i.origin === 'management').length, 2, 'management ops (never retryable) included under retryable=false');
  assert.equal(new Set(rfAll.map((i) => i.id)).size, 41, 'no duplicated rows across pages');
  assert.ok(rfAll.every((i) => !i.isRetryable), 'no retryable row leaked into retryable=false');
  ok('H2. retryable=false → 41 rows across 5 pages, consistent total, no duplicates');

  // H3: stale=true → 26 stale uploads, paginated 10/10/6.
  const st1 = await service.listJobs({ status: 'all', stale: true, page: 1, limit: 10 } as any);
  assert.equal(st1.total, 26, `stale=true total must be 26, got ${st1.total}`);
  assert.equal(st1.items.length, 10); assert.equal(st1.hasMore, true);
  const st3 = await service.listJobs({ status: 'all', stale: true, page: 3, limit: 10 } as any);
  assert.equal(st3.items.length, 6); assert.equal(st3.total, 26); assert.equal(st3.hasMore, false);
  assert.ok(st1.items.every((i) => i.isStale), 'stale rows carry the STALE badge');
  ok('H3. stale=true → 26 stale jobs, pages 10/10/6, exact totals');

  // H4: stale=false → 21 non-stale uploads + 2 management = 23.
  const sf = await service.listJobs({ status: 'all', stale: false, page: 1, limit: 10 } as any);
  assert.equal(sf.total, 23, `stale=false total must be 23, got ${sf.total}`);
  assert.equal(sf.items.length, 10); assert.equal(sf.hasMore, true);
  ok('H4. stale=false → 23 rows (management included — never stale)');

  // H5: retryable=true + stale=true → disjoint semantics → empty, no phantom page.
  const both = await service.listJobs({ status: 'all', retryable: true, stale: true, page: 1, limit: 10 } as any);
  assert.equal(both.total, 0);
  assert.equal(both.items.length, 0);
  assert.equal(both.hasMore, false, 'empty result must not claim more pages');
  ok('H5. retryable+stale (disjoint) → total 0, empty items, no phantom page');

  // H6: status='failed' + retryable=true → still exactly the 8.
  const frt = await service.listJobs({ status: 'failed', retryable: true } as any);
  assert.equal(frt.total, 8);
  ok('H6. failed + retryable composes DB-side filters exactly');

  // H7: search + retryable=false — PostgREST ANDs repeated or-params
  // (verified against the live instance); the mock models the same.
  // 'Stale' matches the 26 stale upload titles; all 26 are non-terminal
  // (not failed-with-retryable-code) so they pass retryable=false too.
  const combo = await service.listJobs({ status: 'all', retryable: false, q: 'Stale', page: 1, limit: 10 } as any);
  assert.equal(combo.total, 26, `search+retryable=false must AND to the 26 stale titles, got ${combo.total}`);
  assert.equal(combo.items.length, 10);
  assert.equal(combo.hasMore, true);
  assert.ok(combo.items.every((i) => !i.isRetryable));
  ok('H7. search + retryable=false compose (ANDed or-params), rows/total agree');
}

// ============================================================
// I. Mixed-source correctness — no duplicate events, source
//    skew, single-source filters, empty states, and the §8
//    A=10/B=10 scenario with 3 Deleted / 4 Failed / 5 Retryable.
// ============================================================
async function testMixedSources() {
  // I1: upload-lifecycle rows in media_operations (audit mirror) must NOT
  // re-appear in the unified Jobs stream — no double counting.
  const mock = new MockClient();
  mock.seed('media_upload_operations', [
    uploadRow({ id: 'up-1', status: 'ready', updatedAt: minutesAgo(30), mediaTitle: 'Upload One' }),
    uploadRow({ id: 'up-2', status: 'failed', updatedAt: minutesAgo(25), errorCode: 'RATE_LIMITED', mediaTitle: 'Upload Two' }),
    uploadRow({ id: 'up-3', status: 'queued', updatedAt: minutesAgo(5), mediaTitle: 'Upload Three' }),
  ]);
  mock.seed('media_operations', [
    // Upload-lifecycle audit mirrors — MUST be excluded from Jobs.
    managementRow({ id: 'audit-upload', action: 'upload', status: 'success', occurredAt: minutesAgo(30), mediaTitle: 'Upload One', uploadOperationId: 'up-1' }),
    managementRow({ id: 'audit-ready', action: 'ready', status: 'success', occurredAt: minutesAgo(29), mediaTitle: 'Upload One', uploadOperationId: 'up-1' }),
    managementRow({ id: 'audit-failed', action: 'failed', status: 'failed', occurredAt: minutesAgo(25), mediaTitle: 'Upload Two', uploadOperationId: 'up-2' }),
    // Genuine management ops.
    managementRow({ id: 'mg-del', action: 'provider_delete', status: 'success', occurredAt: minutesAgo(20), mediaTitle: 'Upload One' }),
    managementRow({ id: 'mg-rename', action: 'rename', status: 'success', occurredAt: minutesAgo(15), mediaTitle: 'Upload One' }),
  ]);
  mock.seed('streaming_providers', []);
  mock.seed('streaming_sources', []);
  const service = new OperationsService(asClient(mock));

  const all = await service.listJobs({ status: 'all', page: 1, limit: 25 } as any);
  assert.equal(all.total, 5, `unified stream must be 3 uploads + 2 management ops (NOT 8 — audit mirrors excluded), got ${all.total}`);
  const ids = all.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicated rows');
  assert.ok(!ids.includes('audit-upload') && !ids.includes('audit-ready') && !ids.includes('audit-failed'), 'upload-lifecycle audit rows never duplicated into Jobs');
  assert.equal(all.items.filter((i) => i.origin === 'upload').length, 3);
  assert.equal(all.items.filter((i) => i.origin === 'management').length, 2);
  ok('I1. upload lifecycle events counted ONCE (audit mirrors excluded from Jobs)');

  // I2: source skew — 100 uploads + 3 management; page 4 and 5 exact.
  const skewMock = new MockClient();
  const manyUploads: Row[] = [];
  for (let i = 0; i < 100; i++) manyUploads.push(uploadRow({ id: `sk-${String(i).padStart(3, '0')}`, status: 'ready', updatedAt: minutesAgo(600 - i), mediaTitle: `Skew ${i}` }));
  skewMock.seed('media_upload_operations', manyUploads);
  skewMock.seed('media_operations', [
    managementRow({ id: 'sk-mg-1', action: 'sync', status: 'success', occurredAt: minutesAgo(3), mediaTitle: null }),
    managementRow({ id: 'sk-mg-2', action: 'sync', status: 'success', occurredAt: minutesAgo(4), mediaTitle: null }),
    managementRow({ id: 'sk-mg-3', action: 'sync', status: 'success', occurredAt: minutesAgo(5), mediaTitle: null }),
  ]);
  skewMock.seed('streaming_providers', []);
  skewMock.seed('streaming_sources', []);
  const skewService = new OperationsService(asClient(skewMock));

  const skew4 = await skewService.listJobs({ status: 'all', page: 4, limit: 25 } as any);
  assert.equal(skew4.total, 103, 'source-skew total = 100 uploads + 3 management');
  assert.equal(skew4.items.length, 25, 'page 4 full');
  assert.equal(skew4.hasMore, true);
  const skew5 = await skewService.listJobs({ status: 'all', page: 5, limit: 25 } as any);
  assert.equal(skew5.items.length, 3, 'page 5 has the last 3 rows');
  assert.equal(skew5.total, 103);
  assert.equal(skew5.hasMore, false);
  const skewAll: any[] = [];
  for (let p = 1; p <= 5; p++) skewAll.push(...(await skewService.listJobs({ status: 'all', page: p, limit: 25 } as any)).items);
  assert.equal(skewAll.length, 103, 'all pages sum to the total');
  assert.equal(new Set(skewAll.map((i) => i.id)).size, 103, 'no duplicated rows across the whole walk');
  ok('I2. source skew (100 uploads + 3 management): pages 25/25/25/25/3, total 103, no duplicates');

  // I3: single-source filters — status='queued' reads uploads only;
  // status='deleted' reads management only (uploads present but excluded).
  const queuedOnly = await skewService.listJobs({ status: 'queued' } as any);
  assert.equal(queuedOnly.total, 0, 'no queued uploads in the skew fixture — management never queued');
  ok('I3a. upload-only status filters read uploads only');

  // I4: the §8 scenario — SOURCE A: 10 uploads, SOURCE B: 10 management ops.
  // Filters: 3 Deleted, 4 Failed, 5 Retryable. Pages must agree.
  const s8mock = new MockClient();
  const s8uploads: Row[] = [];
  for (let i = 0; i < 5; i++) s8uploads.push(uploadRow({ id: `s8-rt-${i}`, status: 'failed', updatedAt: minutesAgo(100 + i), errorCode: 'RATE_LIMITED', mediaTitle: `S8 Retryable ${i}` }));
  for (let i = 0; i < 2; i++) s8uploads.push(uploadRow({ id: `s8-pf-${i}`, status: 'failed', updatedAt: minutesAgo(200 + i), errorCode: 'PERMANENT', mediaTitle: `S8 Permanent ${i}` }));
  for (let i = 0; i < 3; i++) s8uploads.push(uploadRow({ id: `s8-rd-${i}`, status: 'ready', updatedAt: minutesAgo(10 + i), mediaTitle: `S8 Ready ${i}` }));
  const s8mgmt: Row[] = [];
  for (let i = 0; i < 3; i++) s8mgmt.push(managementRow({ id: `s8-d-ok-${i}`, action: 'provider_delete', status: 'success', occurredAt: minutesAgo(20 + i), mediaTitle: `S8 Deleted ${i}` }));
  for (let i = 0; i < 4; i++) s8mgmt.push(managementRow({ id: `s8-d-fail-${i}`, action: 'provider_delete', status: 'failed', occurredAt: minutesAgo(300 + i), errorCode: 'AUTH', mediaTitle: `S8 FailedDel ${i}` }));
  for (let i = 0; i < 3; i++) s8mgmt.push(managementRow({ id: `s8-sync-${i}`, action: 'sync', status: 'success', occurredAt: minutesAgo(5 + i), mediaTitle: null }));
  s8mock.seed('media_upload_operations', s8uploads);
  s8mock.seed('media_operations', s8mgmt);
  s8mock.seed('streaming_providers', []);
  s8mock.seed('streaming_sources', []);
  const s8 = new OperationsService(asClient(s8mock));

  // Deleted = 3 → limit 2 → pages: 2 (hasMore) + 1 (last).
  const s8d1 = await s8.listJobs({ status: 'deleted', page: 1, limit: 2 } as any);
  assert.equal(s8d1.total, 3); assert.equal(s8d1.items.length, 2); assert.equal(s8d1.hasMore, true);
  const s8d2 = await s8.listJobs({ status: 'deleted', page: 2, limit: 2 } as any);
  assert.equal(s8d2.total, 3); assert.equal(s8d2.items.length, 1); assert.equal(s8d2.hasMore, false);
  const s8d3 = await s8.listJobs({ status: 'deleted', page: 3, limit: 2 } as any);
  assert.equal(s8d3.items.length, 0, 'no phantom page 3');
  ok('I4a. §8 scenario Deleted=3: pages 2+1, total 3, no phantom page');

  // Failed = 4 failed deletes + 7 failed uploads = 11 → limit 5: 5/5/1.
  const s8f1 = await s8.listJobs({ status: 'failed', page: 1, limit: 5 } as any);
  assert.equal(s8f1.total, 11); assert.equal(s8f1.items.length, 5); assert.equal(s8f1.hasMore, true);
  const s8f3 = await s8.listJobs({ status: 'failed', page: 3, limit: 5 } as any);
  assert.equal(s8f3.total, 11); assert.equal(s8f3.items.length, 1); assert.equal(s8f3.hasMore, false);
  ok('I4b. §8 scenario Failed=11 (4 failed deletes + 7 failed uploads): pages 5/5/1');

  // Retryable = 5 → limit 2: 2/2/1.
  const s8r1 = await s8.listJobs({ retryable: true, page: 1, limit: 2 } as any);
  assert.equal(s8r1.total, 5); assert.equal(s8r1.items.length, 2); assert.equal(s8r1.hasMore, true);
  const s8r3 = await s8.listJobs({ retryable: true, page: 3, limit: 2 } as any);
  assert.equal(s8r3.total, 5); assert.equal(s8r3.items.length, 1); assert.equal(s8r3.hasMore, false);
  ok('I4c. §8 scenario Retryable=5: pages 2/2/1, total constant');

  // I5: empty state — Deleted with ZERO successful deletes.
  const emptyMock = new MockClient();
  emptyMock.seed('media_upload_operations', [uploadRow({ id: 'e-1', status: 'ready', updatedAt: minutesAgo(5), mediaTitle: 'Only Ready' })]);
  emptyMock.seed('media_operations', [
    managementRow({ id: 'e-fail-del', action: 'provider_delete', status: 'failed', occurredAt: minutesAgo(30), errorCode: 'AUTH', mediaTitle: 'Failed Delete Only' }),
    managementRow({ id: 'e-sync', action: 'sync', status: 'success', occurredAt: minutesAgo(4), mediaTitle: null }),
  ]);
  emptyMock.seed('streaming_providers', []);
  emptyMock.seed('streaming_sources', []);
  const emptyService = new OperationsService(asClient(emptyMock));
  const empty = await emptyService.listJobs({ status: 'deleted', page: 1, limit: 25 } as any);
  assert.equal(empty.total, 0, 'zero successful deletes → total 0');
  assert.equal(empty.items.length, 0, 'zero rows');
  assert.equal(empty.hasMore, false, 'no phantom page on empty results');
  ok('I5. Deleted with zero successful deletes → empty state, total 0, no phantom page');
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
    ['F. deleted-status semantics', testDeletedSemantics],
    ['G. pagination invariant', testPaginationInvariant],
    ['H. retryable/stale pushdown', testRetryableStalePushdown],
    ['I. mixed sources + skew + empty', testMixedSources],
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
