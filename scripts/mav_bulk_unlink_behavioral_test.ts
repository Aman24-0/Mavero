/**
 * Task 4 regression (2026-10-15) — safe bulk season deletion.
 *
 * Behavioral tests for the bulk-unlink contract
 * (src/lib/server/hosting/media/bulk-unlink-contract.ts) against an
 * in-memory postgrest emulation (the mav_task2/mav_task3 pattern).
 *
 * Required coverage (from the task):
 *   §A  several linked episodes deleted from the selected season
 *   §B  unlinked episodes are not affected (idempotent outcomes)
 *   §C  another season remains untouched
 *   §D  invalid parent/season/episode requests fail safely
 *   §E  authorization is enforced by the ROUTE (source contract — the
 *       contract function never bypasses requireAdmin)
 *   §F  partial failures are reported accurately
 *   §G  retrying failed deletions does not damage successful results
 *   §H  audit records follow the existing conventions
 *   §I  provider-hosted files are NEVER deleted (no provider writes)
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_bulk_unlink_behavioral_test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

// ---------------------------------------------------------------------------
// TMDB fetch + env stubs (the mav_task3 pattern) — MUST run BEFORE the
// dynamic contract import: batchEpisodeEligibility resolves season
// metadata through getSeriesSeason, which needs a TMDB-shaped response
// with PAST air dates so the episodes count as released. Static imports
// would snapshot the env before the stub is assigned.
// ---------------------------------------------------------------------------
type RecordedFetch = { url: string };
const tmdbFetches: RecordedFetch[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  tmdbFetches.push({ url: url.toString() });
  // Season 1: episodes 1-3 released long ago.
  if (/^\/(3\/)?tv\/46648\/season\/1$/.test(url.pathname)) {
    const episodes = [1, 2, 3].map((n) => ({
      id: 1000 + n,
      episode_number: n,
      season_number: 1,
      name: `Episode ${n}`,
      air_date: '2020-06-01',
    }));
    return new Response(JSON.stringify({ id: '46648', season_number: 1, name: 'Season 1', episodes }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Season 2: episodes 1-2 released.
  if (/^\/(3\/)?tv\/46648\/season\/2$/.test(url.pathname)) {
    const episodes = [1, 2].map((n) => ({
      id: 2000 + n,
      episode_number: n,
      season_number: 2,
      name: `Episode ${n}`,
      air_date: '2020-06-01',
    }));
    return new Response(JSON.stringify({ id: '46648', season_number: 2, name: 'Season 2', episodes }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Season 3: UNRELEASED (future air date) — for the eligibility-gate case.
  if (/^\/(3\/)?tv\/46648\/season\/3$/.test(url.pathname)) {
    const episodes = [1].map((n) => ({
      id: 3000 + n,
      episode_number: n,
      season_number: 3,
      name: `Episode ${n}`,
      air_date: '2027-01-01',
    }));
    return new Response(JSON.stringify({ id: '46648', season_number: 3, name: 'Season 3', episodes }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

(globalThis as Record<string, unknown>).__MAVERO_UPCOMING_TEST_ENV__ = { TMDB_READ_ACCESS_TOKEN: 'test-read-token' };

// Dynamic import AFTER the stubs (see note above).
const { validateBulkUnlinkInput, bulkUnlinkSeason } = await import('../src/lib/server/hosting/media/bulk-unlink-contract');

// ---------------------------------------------------------------------------
// In-memory postgrest emulation (mav_task3 pattern + neq + failing deletes)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type ExecResult = { data: unknown; error: { message: string; code: string } | null; count: number | null };

class QueryBuilder {
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private filters: Array<(r: Row) => boolean> = [];
  private payload: Row | null = null;
  private selectCols: string | null = null;
  private expectSingle = false;
  private expectMaybe = false;
  private orders: Array<{ field: string; ascending: boolean; nullsFirst: boolean }> = [];
  constructor(
    private rows: Row[],
    private name: string,
    private nextId: () => string,
    private failDeleteFor: (assetId: string) => boolean,
  ) {}

  select(cols: string | null) { this.selectCols = cols; return this; }
  insert(payload: Row) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
  neq(field: string, value: unknown) { this.filters.push((r) => r[field] !== value); return this; }
  is(field: string, value: null) { this.filters.push((r) => r[field] === value); return this; }
  in(field: string, values: unknown[]) { this.filters.push((r) => values.includes(r[field])); return this; }
  order(field: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push({ field, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst ?? true });
    return this;
  }
  single() { this.expectSingle = true; return this; }
  maybeSingle() { this.expectMaybe = true; return this; }

  private project(r: Row): Row {
    if (!this.selectCols) return { ...r };
    const cols = this.selectCols.split(',').map((c) => c.trim());
    const out: Row = {};
    for (const c of cols) if (c in r) out[c] = r[c];
    return out;
  }

  private exec(): ExecResult {
    if (this.op === 'delete') {
      // Injectable failure: simulates a DB error deleting a specific asset.
      const targets = this.rows.filter((r) => this.filters.every((f) => f(r)));
      const failing = targets.find((r) => this.name === 'media_assets' && this.failDeleteFor(String(r.id)));
      if (failing) {
        return { data: null, error: { message: `simulated delete failure for ${failing.id}`, code: '23503' }, count: null };
      }
      for (let i = this.rows.length - 1; i >= 0; i -= 1) {
        if (this.filters.every((f) => f(this.rows[i]))) this.rows.splice(i, 1);
      }
      return { data: null, error: null, count: null };
    }
    if (this.op === 'insert' && this.payload) {
      this.rows.push({ id: this.nextId(), ...this.payload });
      return { data: this.project(this.rows[this.rows.length - 1]), error: null, count: null };
    }
    if (this.op === 'update' && this.payload) {
      for (const r of this.rows) {
        if (this.filters.every((f) => f(r))) Object.assign(r, this.payload);
      }
      return { data: null, error: null, count: null };
    }
    // select
    let found = this.rows.filter((r) => this.filters.every((f) => f(r)));
    for (const o of [...this.orders].reverse()) {
      found = [...found].sort((a, b) => {
        const av = a[o.field]; const bv = b[o.field];
        const an = av == null; const bn = bv == null;
        if (an && bn) return 0;
        if (an) return o.nullsFirst ? -1 : 1;
        if (bn) return o.nullsFirst ? 1 : -1;
        const cmp = av! > bv! ? 1 : av! < bv! ? -1 : 0;
        return o.ascending ? cmp : -cmp;
      });
    }
    const projectAll = (rows: Row[]) => rows.map((r) => this.project(r));
    if (this.expectSingle) {
      if (found.length !== 1) return { data: null, error: { message: 'row not found', code: 'PGRST116' }, count: null };
      return { data: this.project(found[0]), error: null, count: null };
    }
    if (this.expectMaybe) {
      if (found.length === 0) return { data: null, error: null, count: null };
      return { data: this.project(found[0]), error: null, count: null };
    }
    return { data: projectAll(found), error: null, count: null };
  }

  then<T>(onFulfilled: (value: ExecResult) => T, onRejected?: (reason: unknown) => T): Promise<T> {
    return Promise.resolve(this.exec()).then(onFulfilled, onRejected);
  }
}

class MockSupabase {
  tables: Table[] = [
    { name: 'media_items', rows: [] },
    { name: 'media_assets', rows: [] },
    { name: 'media_operations', rows: [] },
  ];
  private seq = 0;
  private nextId(): string { this.seq += 1; return `uuid-${this.seq}`; }
  failDeleteFor: (assetId: string) => boolean = () => false;

  from(name: string): QueryBuilder {
    const table = this.tables.find((t) => t.name === name);
    if (!table) throw new Error(`unexpected table ${name}`);
    return new QueryBuilder(table.rows, name, () => this.nextId(), this.failDeleteFor);
  }
}
type Table = { name: string; rows: Row[] };

// ---------------------------------------------------------------------------
// Fixtures — "Dark" parent with episodes in seasons 1 + 2.
// ---------------------------------------------------------------------------

function seedSeason(mock: MockSupabase, parentId: string, season: number, episodes: number[], linked: number[]): void {
  for (const e of episodes) {
    const epRow: Row = {
      id: `dark-s${season}e${e}`,
      canonical_key: `series:tmdb:46648:s${season}:e${e}`,
      content_type: 'series',
      tmdb_id: '46648',
      title: 'Dark',
      year: 2017,
      season,
      episode: e,
      episode_title: `Episode ${e}`,
      parent_media_id: parentId,
      poster_path: null,
      backdrop_path: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    };
    mock.tables[0].rows.push(epRow);
    if (linked.includes(e)) {
      mock.tables[1].rows.push({
        id: `asset-s${season}e${e}`,
        media_item_id: epRow.id,
        provider_source_id: 'src-vidara-1',
        provider_asset_id: `code-s${season}e${e}`,
        status: 'ready',
        mavero_status: 'available',
        playback_url: `https://vidara.to/e/code-s${season}e${e}`,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      });
    }
  }
}

function seedShow(): MockSupabase {
  const mock = new MockSupabase();
  mock.tables[0].rows.push({
    id: 'parent-dark',
    canonical_key: 'series:tmdb:46648',
    content_type: 'series',
    tmdb_id: '46648',
    title: 'Dark',
    year: 2017,
    season: null,
    episode: null,
    parent_media_id: null,
    poster_path: null,
    backdrop_path: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  });
  seedSeason(mock, 'parent-dark', 1, [1, 2, 3], [1, 2]);   // S1: E1+E2 linked, E3 unlinked
  seedSeason(mock, 'parent-dark', 2, [1, 2], [1]);          // S2: E1 linked
  return mock;
}

const assets = (mock: MockSupabase) => mock.tables[1].rows;
const ops = (mock: MockSupabase) => mock.tables[2].rows;

// ===========================================================================
console.log('§A — several linked episodes deleted from the selected season');
// ===========================================================================
{
  const mock = seedShow();
  const outcome = await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  ok(outcome.ok, 'A1a. request succeeds');
  if (outcome.ok) {
    ok(outcome.succeeded === 3 && outcome.failed === 0, `A1b. all 3 S1 episodes processed (2 deleted + 1 idempotent), got ${outcome.succeeded}/${outcome.failed}`);
    ok(outcome.deletedAssets === 2, `A1c. exactly 2 asset rows deleted, got ${outcome.deletedAssets}`);
    const sorted = outcome.results.map((r) => `${r.episode}:${r.ok ? r.mode : 'fail'}`);
    ok(sorted.join(',') === '1:deleted,2:deleted,3:idempotent', `A1d. per-episode results sorted + explicit, got ${sorted.join(',')}`);
  }
  ok(assets(mock).every((a) => a.id !== 'asset-s1e1' && a.id !== 'asset-s1e2'), 'A1e. S1 assets gone');
  ok(assets(mock).some((a) => a.id === 'asset-s2e1'), 'A1f. S2 asset still present');
  ok(mock.tables[0].rows.length === 6, `A1g. NO media_items rows deleted (parent + 5 episodes remain), got ${mock.tables[0].rows.length}`);
}

// ===========================================================================
console.log('§B — unlinked episodes are not affected');
// ===========================================================================
{
  const mock = seedShow();
  const outcome = await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  ok(outcome.ok && outcome.results.find((r) => r.episode === 3)?.ok === true, 'B1a. unlinked episode reports ok');
  ok(outcome.ok && (outcome.results.find((r) => r.episode === 3) as { mode?: string }).mode === 'idempotent', 'B1b. unlinked episode reports idempotent (nothing to delete)');
  ok(mock.tables[0].rows.some((r) => r.id === 'dark-s1e3'), 'B1c. unlinked episode media_items row preserved');
}

// ===========================================================================
console.log('§C — another season remains untouched');
// ===========================================================================
{
  const mock = seedShow();
  await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  ok(assets(mock).some((a) => a.id === 'asset-s2e1'), 'C1a. season 2 asset untouched');
  ok(mock.tables[0].rows.some((r) => r.id === 'dark-s2e1') && mock.tables[0].rows.some((r) => r.id === 'dark-s2e2'), 'C1b. season 2 episode rows untouched');
}

// ===========================================================================
console.log('§D — invalid parent/season/episode requests fail safely');
// ===========================================================================
{
  const mock = seedShow();
  const missing = await bulkUnlinkSeason(mock as never, 'admin-user-1', 'no-such-parent', 1);
  ok(!missing.ok && (!missing.ok && missing.error.code === 'PARENT_NOT_FOUND'), 'D1a. unknown parent → PARENT_NOT_FOUND');

  const movieMock = new MockSupabase();
  movieMock.tables[0].rows.push({ id: 'movie-1', canonical_key: 'movie:tmdb:1', content_type: 'movie', tmdb_id: '1', parent_media_id: null, season: null, episode: null });
  const movie = await bulkUnlinkSeason(movieMock as never, 'admin-user-1', 'movie-1', 1);
  ok(!movie.ok && movie.error.code === 'INVALID_PARENT', 'D1b. movie parent → INVALID_PARENT (episodic parents only)');

  const episodeMock = new MockSupabase();
  episodeMock.tables[0].rows.push({ id: 'ep-1', canonical_key: 'series:tmdb:46648:s1:e1', content_type: 'series', tmdb_id: '46648', parent_media_id: 'parent-dark', season: 1, episode: 1 });
  const epAsParent = await bulkUnlinkSeason(episodeMock as never, 'admin-user-1', 'ep-1', 1);
  ok(!epAsParent.ok && epAsParent.error.code === 'INVALID_PARENT', 'D1c. episode row as parent → INVALID_PARENT');

  const v1 = validateBulkUnlinkInput('parent-dark', 1);
  ok('season' in v1 && v1.season === 1, 'D1d. valid input passes validation');
  const v2 = validateBulkUnlinkInput('parent-dark', 0);
  ok(!('season' in v2) && (!('season' in v2) && v2.code === 'SEASON_INVALID'), 'D1e. season 0 → SEASON_INVALID');
  const v3 = validateBulkUnlinkInput('parent-dark', 'nan');
  ok(!('season' in v3) && v3.code === 'SEASON_INVALID', 'D1f. non-numeric season → SEASON_INVALID');
  const v4 = validateBulkUnlinkInput('', 1);
  ok(!('season' in v4) && v4.code === 'SEASON_INVALID', 'D1g. missing parentId → invalid');

  // Season with NO episode rows: empty results, nothing crashes.
  const emptySeason = await bulkUnlinkSeason(seedShow() as never, 'admin-user-1', 'parent-dark', 9);
  ok(emptySeason.ok && emptySeason.ok && emptySeason.total === 0, 'D1h. unknown season → empty result set (safe)');

  // D2 — the release-eligibility gate mirrors the single-episode DELETE
  // contract: an UNRELEASED episode's association is NOT bulk-deleted.
  {
    const gateMock = seedShow();
    // Season 3, episode 1 — linked but not released (stub air date 2027).
    seedSeason(gateMock, 'parent-dark', 3, [1], [1]);
    const gate = await bulkUnlinkSeason(gateMock as never, 'admin-user-1', 'parent-dark', 3);
    ok(gate.ok, 'D2a. gate request itself succeeds (per-episode outcomes)');
    if (gate.ok) {
      const e1 = gate.results.find((r) => r.episode === 1);
      ok(e1?.ok === false, 'D2b. unreleased episode reports failure');
      if (!e1.ok) ok(e1.code === 'EPISODE_NOT_RELEASED', `D2c. code EPISODE_NOT_RELEASED, got ${e1.code}`);
      ok(assets(gateMock).some((a) => a.id === 'asset-s3e1'), 'D2d. the unreleased episode association SURVIVES');
    }
  }
}

// ===========================================================================
console.log('§E — authorization is enforced by the ROUTE (never UI-only)');
// ===========================================================================
{
  const route = read('src/routes/api/admin/media/bulk-unlink/+server.ts');
  ok(/requireAdmin/.test(route), 'E1a. route calls requireAdmin (server-side admin gate)');
  ok(/locals/.test(route), 'E1b. route uses hook-resolved locals (no client trust)');
  const contract = read('src/lib/server/hosting/media/bulk-unlink-contract.ts');
  ok(!/import.*requireAdmin|requireAdmin\(/.test(contract), 'E1c. contract module holds NO authorization code (single gate in the route; the doc comment references the route)');
  ok(/adminUserId/.test(contract), 'E1d. contract records the authenticated admin id on every audit row');
}

// ===========================================================================
console.log('§F — partial failures are reported accurately');
// ===========================================================================
{
  const mock = seedShow();
  // Make the S1E2 asset delete FAIL server-side; S1E1 succeeds.
  mock.failDeleteFor = (assetId) => assetId === 'asset-s1e2';
  const outcome = await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  ok(outcome.ok, 'F1a. request itself succeeds (per-episode outcomes)');
  if (outcome.ok) {
    const e1 = outcome.results.find((r) => r.episode === 1);
    const e2 = outcome.results.find((r) => r.episode === 2);
    ok(e1?.ok === true, 'F1b. E1 reports ok (deleted)');
    ok(e2?.ok === false, 'F1c. E2 reports failure (accurate per-episode status)');
    if (!e2.ok) {
      ok(e2.code === 'DELETE_FAILED', `F1d. failure carries DELETE_FAILED code, got ${e2.code}`);
      ok(e2.message.length > 0, 'F1e. failure carries the honest message');
    }
    ok(outcome.failed === 1, `F1f. summary counts the failure, got ${outcome.failed}`);
    // The failed asset SURVIVES for the retry round.
    ok(assets(mock).some((a) => a.id === 'asset-s1e2'), 'F1g. the failed asset row survives (retryable)');
    ok(!assets(mock).some((a) => a.id === 'asset-s1e1'), 'F1h. the successful asset is gone');
  }
}

// ===========================================================================
console.log('§G — retrying failed deletions does not damage successful results');
// ===========================================================================
{
  const mock = seedShow();
  mock.failDeleteFor = (assetId) => assetId === 'asset-s1e2';
  const first = await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  ok(first.ok, 'G1a. first pass ran');
  // Clear the failure — retry round.
  mock.failDeleteFor = () => false;
  const retry = await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  ok(retry.ok, 'G1b. retry request succeeds');
  if (retry.ok) {
    // S1E1 was already deleted → idempotent this round; S1E2 now deletes.
    const e1 = retry.results.find((r) => r.episode === 1);
    const e2 = retry.results.find((r) => r.episode === 2);
    ok(e1?.ok === true && (e1 as { mode?: string }).mode === 'idempotent', 'G1c. previously-successful episode reports idempotent (no duplicate work)');
    ok(e2?.ok === true, 'G1d. previously-failed episode now deletes');
    ok(!assets(mock).some((a) => a.id === 'asset-s1e1' || a.id === 'asset-s1e2'), 'G1e. no asset rows resurrected or duplicated');
    ok(assets(mock).some((a) => a.id === 'asset-s2e1'), 'G1f. other season still intact after retry');
  }
}

// ===========================================================================
console.log('§H — audit records follow the existing conventions');
// ===========================================================================
{
  const mock = seedShow();
  await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  const unlinkOps = ops(mock).filter((o) => o.action === 'unlink');
  ok(unlinkOps.length === 2, `H1a. one audit row per DELETED asset (2), got ${unlinkOps.length}`);
  const success = unlinkOps.find((o) => o.status === 'success')!;
  ok(success != null, 'H1b. success audit exists');
  ok(success.media_item_id === 'dark-s1e1' || success.media_item_id === 'dark-s1e2', 'H1c. success audit carries media_item_id');
  ok(!('media_asset_id' in success) || success.media_asset_id == null, 'H1d. success audit omits top-level media_asset_id (FK-safe)');
  ok((success.details as Row)?.via === 'bulk-unlink', 'H1e. details.via = bulk-unlink (endpoint discriminator)');
  ok((success.details as Row)?.media_asset_id != null, 'H1f. details carries media_asset_id for context');
  ok((success.details as Row)?.season === 1, 'H1g. details carries the season');
  ok(success.admin_user_id === 'admin-user-1', 'H1h. admin_user_id recorded');
  ok(typeof (success.details as Row)?.note === 'string', 'H1i. note documents provider-file preservation');
  // No duplicate ops for the idempotent episode (nothing deleted → no audit).
  ok(ops(mock).filter((o) => (o.details as Row)?.episode === 3).length === 0, 'H1j. idempotent episode writes NO audit row');
}

// ===========================================================================
console.log('§I — provider-hosted files are NEVER deleted');
// ===========================================================================
{
  const mock = seedShow();
  // Track every table write during the operation.
  const providerTouches: string[] = [];
  const origFrom = mock.from.bind(mock);
  (mock as unknown as { from: (n: string) => unknown }).from = (name: string) => {
    if (name !== 'media_items' && name !== 'media_assets' && name !== 'media_operations') {
      providerTouches.push(name);
    }
    return origFrom(name);
  };
  const outcome = await bulkUnlinkSeason(mock as never, 'admin-user-1', 'parent-dark', 1);
  ok(outcome.ok, 'I1a. operation completes');
  ok(providerTouches.length === 0, `I1b. ONLY media_items/media_assets/media_operations touched (no provider tables), got ${providerTouches.join(',')}`);
  const contract = read('src/lib/server/hosting/media/bulk-unlink-contract.ts');
  const route = read('src/routes/api/admin/media/bulk-unlink/+server.ts');
  ok(!/deleteAsset|adapter\.|getHostingAdapter|providerApi|fetch\(/.test(contract), 'I1c. contract makes NO adapter/provider calls');
  ok(!/deleteAsset|adapter\./.test(route), 'I1d. route makes NO adapter/provider calls');
  // The single-episode DELETE behavior is unchanged (regression guard).
  const manualLink = read('src/routes/api/admin/media/manual-link/+server.ts');
  ok(/Does NOT call provider APIs/.test(manualLink), 'I1e. single-episode delete still documents provider-file preservation');
}

console.log(`\nmav_bulk_unlink_behavioral_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
