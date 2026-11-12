/**
 * Task 3 behavioral regression (2026-10-15) — BULK episode linking.
 *
 * Executes the REAL shared write path the bulk-link endpoint drives —
 * batchEpisodeEligibility → validateReference → normalizeReference →
 * resolveMediaItemId → upsertLinkAsset (via: 'bulk-link') — against an
 * in-memory postgrest emulation (the mav_task1/mav_task2 mock pattern,
 * extended with insert + in/order/limit for the write-path shapes),
 * with the TMDB season transport stubbed at the fetch boundary.
 *
 * The per-item loop below mirrors the route's loop in
 * src/routes/api/admin/media/bulk-link/+server.ts EXACTLY (same check
 * order); the route wrapper's structural rejects (duplicates/limits)
 * are pinned by mav_focused_manual_link_contract_test §15 and the UI
 * outcomes are pinned by mav_task2_episode_sheet_dom_qa.
 *
 * Sections:
 *   §A  ONE season-metadata fetch evaluates the whole batch
 *   §B  mixed batch: per-episode outcomes (insert / EPISODE_NOT_RELEASED /
 *       INVALID_REQUEST), batch proceeds, results sorted + counted
 *   §C  distinct references → DISTINCT media_assets rows (never a shared
 *       provider_asset_id) with canonical embed playback URLs
 *   §D  retry semantics: resubmitting a succeeded episode is IDEMPOTENT
 *       (no new row); a failed episode fixed and resubmitted inserts
 *   §E  cross-request relink re-points ONE provider row (never duplicates)
 *   §F  the release gate is server-side: a released-looking client cannot
 *       write an unreleased episode
 *
 * No production data is touched — the "database" is an in-memory mock.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_task3_bulk_link_behavioral_test.ts
 */

// ---------------------------------------------------------------------------
// Environment: TMDB token + season transport stub BEFORE any src import
// (the env stub in scripts/env-stubs snapshots these at import time).
// ---------------------------------------------------------------------------
const SEASON_TMDB_ID = '1399';
const SEASON_NUMBER = 2;
const RELEASED = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'];
const UNRELEASED_EPISODE = 2; // air date in the future

type RecordedFetch = { url: string };
const tmdbFetches: RecordedFetch[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  tmdbFetches.push({ url: url.toString() });
  // tmdbRequest fetches `${BASE_URL}${path}` = https://api.themoviedb.org/3/tv/...
  // — match the path with or without the /3 version prefix.
  if (/^\/(3\/)?tv\/1399\/season\/2$/.test(url.pathname)) {
    const episodes = [1, 2, 3, 4, 5].map((n) => ({
      id: 1000 + n,
      episode_number: n,
      season_number: SEASON_NUMBER,
      name: `Episode ${n}`,
      air_date: n === UNRELEASED_EPISODE ? '2027-01-01' : RELEASED[Math.min(n - 1, 3)],
    }));
    return new Response(JSON.stringify({ id: SEASON_TMDB_ID, season_number: SEASON_NUMBER, name: `Season ${SEASON_NUMBER}`, episodes }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

(globalThis as Record<string, unknown>).__MAVERO_UPCOMING_TEST_ENV__ = { TMDB_READ_ACCESS_TOKEN: 'test-read-token' };

// NOTE: ALL src imports below are DYNAMIC — ES static imports are hoisted
// above module body code, which would snapshot the env stub BEFORE the
// token assignment runs (the upcoming-pipeline tests use the same
// dynamic-import ordering).
// ---------------------------------------------------------------------------
let validateReference: (typeof import('../src/lib/server/hosting/media/manual-link-contract'))['validateReference'];
let normalizeReference: (typeof import('../src/lib/server/hosting/media/manual-link-contract'))['normalizeReference'];
let batchEpisodeEligibility: (typeof import('../src/lib/server/hosting/media/manual-link-contract'))['batchEpisodeEligibility'];
let resolveProviderSource: (typeof import('../src/lib/server/hosting/media/manual-link-contract'))['resolveProviderSource'];
let upsertLinkAsset: (typeof import('../src/lib/server/hosting/media/manual-link-contract'))['upsertLinkAsset'];
let resolveMediaItemId: (typeof import('../src/lib/server/hosting/media/manual-link-identity'))['resolveMediaItemId'];
let CanonicalMediaService: (typeof import('../src/lib/server/hosting/media/service'))['CanonicalMediaService'];
let clearCache: (typeof import('../src/lib/server/content/cache'))['clearCache'];

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const modules = await Promise.all([
  import('../src/lib/server/hosting/media/manual-link-contract'),
  import('../src/lib/server/hosting/media/manual-link-identity'),
  import('../src/lib/server/hosting/media/service'),
  import('../src/lib/server/content/cache'),
]);
({ validateReference, normalizeReference, batchEpisodeEligibility, resolveProviderSource, upsertLinkAsset } = modules[0]);
({ resolveMediaItemId } = modules[1]);
({ CanonicalMediaService } = modules[2]);
({ clearCache } = modules[3]);
// (2026-10-15) the UploadService was removed with the Upload/Import
// workflow; the audit writer it provided is rehomed as
// recordMediaOperation(adminClient, params) — upsertLinkAsset now calls it
// internally with the same media_operations insert contract.

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

// ---------------------------------------------------------------------------
// In-memory postgrest emulation (mav_task1/mav_task2 pattern + insert/in/
// order/limit — the shapes the write paths use).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type ExecResult = { data: unknown; error: { message: string; code: string } | null; count: number | null };

class QueryBuilder {
  private op: 'select' | 'upsert' | 'update' | 'insert' = 'select';
  private filters: Array<(r: Row) => boolean> = [];
  private payload: Row | null = null;
  private onConflictKey: string | null = null;
  private selectCols: string | null = null;
  private expectSingle = false;
  private expectMaybe = false;
  private limitN: number | null = null;
  constructor(private rows: Row[], private name: string, private nextId: () => string) {}

  select(cols: string | null, opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    this.selectCols = cols;
    if (opts?.count === 'exact') { /* count unused by write paths */ }
    return this;
  }
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.op = 'upsert'; this.payload = payload; this.onConflictKey = opts?.onConflict ?? null; return this;
  }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  insert(payload: Row) { this.op = 'insert'; this.payload = payload; return this; }
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
  is(field: string, value: null) { this.filters.push((r) => r[field] === value); return this; }
  in(field: string, values: unknown[]) { this.filters.push((r) => values.includes(r[field])); return this; }
  limit(n: number) { this.limitN = n; return this; }
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
    if (this.op === 'select') {
      let found = this.rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.limitN != null) found = found.slice(0, this.limitN);
      if (this.expectSingle) {
        if (found.length !== 1) return { data: null, error: { message: 'row not found', code: 'PGRST116' }, count: null };
        return { data: this.project(found[0]), error: null, count: null };
      }
      if (this.expectMaybe) {
        if (found.length === 0) return { data: null, error: null, count: null };
        return { data: this.project(found[0]), error: null, count: null };
      }
      return { data: found.map((r) => this.project(r)), error: null, count: null };
    }
    if (this.op === 'upsert' && this.payload) {
      const conflictField = (this.onConflictKey ?? 'id').split(',')[0].trim();
      const idx = this.rows.findIndex((r) => r[conflictField] === this.payload![conflictField]);
      if (idx >= 0) {
        this.rows[idx] = { ...this.rows[idx], ...this.payload };
      } else {
        this.rows.push({ id: this.nextId(), ...this.payload });
      }
      const row = this.rows.find((r) => r[conflictField] === this.payload![conflictField])!;
      return { data: this.project(row), error: null, count: null };
    }
    if (this.op === 'insert' && this.payload) {
      const row = { id: this.nextId(), ...this.payload };
      this.rows.push(row);
      // postgrest-js `.insert(...).select('id').single()` returns the inserted
      // row — honor a trailing select()/single()/maybeSingle().
      if (this.expectSingle || this.expectMaybe) return { data: this.project(row), error: null, count: null };
      return { data: null, error: null, count: null };
    }
    if (this.op === 'update' && this.payload) {
      for (const r of this.rows) {
        if (this.filters.every((f) => f(r))) Object.assign(r, this.payload);
      }
      return { data: null, error: null, count: null };
    }
    return { data: null, error: { message: 'unsupported op', code: 'X' }, count: null };
  }

  then<T>(onFulfilled: (value: ExecResult) => T, onRejected?: (reason: unknown) => T): Promise<T> {
    return Promise.resolve(this.exec()).then(onFulfilled, onRejected);
  }
}

class MockSupabase {
  tables: Array<{ name: string; rows: Row[] }> = [
    { name: 'media_items', rows: [] },
    { name: 'media_assets', rows: [] },
    { name: 'media_folders', rows: [] },
    { name: 'media_operations', rows: [] },
    { name: 'streaming_providers', rows: [] },
    { name: 'streaming_sources', rows: [] },
  ];
  private seq = 0;
  private nextId(): string { this.seq += 1; return `uuid-${this.seq}`; }

  from(name: string): QueryBuilder {
    const table = this.tables.find((t) => t.name === name);
    if (!table) throw new Error(`unexpected table ${name}`);
    return new QueryBuilder(table.rows, name, () => this.nextId());
  }
}

// ---------------------------------------------------------------------------
// Harness: the route's exact per-item loop (same check order).
// ---------------------------------------------------------------------------
type BulkItem = { episode: number; reference: string; episodeTitle?: string };
type BulkOutcome =
  | { episode: number; ok: true; mediaAssetId: string; mode: 'insert' | 'relink' | 'update' | 'idempotent' }
  | { episode: number; ok: false; code: string; message: string };

let mock: MockSupabase;
let mediaService: InstanceType<typeof CanonicalMediaService>;
let providerSourceId: string;

// Every link operation recorded across ALL section databases (§G asserts
// on the cumulative audit trail — each section runs on a FRESH database).
const allLinkOps: Row[] = [];

async function freshDb(): Promise<void> {
  if (mock) {
    for (const op of mock.tables.find((t) => t.name === 'media_operations')!.rows) {
      if (op.action === 'link') allLinkOps.push(op);
    }
  }
  mock = new MockSupabase();
  mediaService = new CanonicalMediaService(mock as never);
  // Provider + source registration (the Phase 4 shape resolveProviderSource reads).
  mock.tables.find((t) => t.name === 'streaming_providers')!.rows.push({ id: 'prov-vidara-1', adapter_id: 'vidara' });
  mock.tables.find((t) => t.name === 'streaming_sources')!.rows.push({ id: 'src-vidara-1', provider_id: 'prov-vidara-1' });
  const resolved = await resolveProviderSource(mock as never, 'vidara');
  if (!resolved.ok) throw new Error('fixture provider resolution failed');
  providerSourceId = resolved.providerSourceId;
}
await freshDb();

const mediaAssets = () => mock.tables[1].rows;

async function runBulkBatch(items: BulkItem[]): Promise<BulkOutcome[]> {
  // Mirrors the route: ONE eligibility evaluation for the whole batch.
  const eligibility = await batchEpisodeEligibility('series', SEASON_TMDB_ID, SEASON_NUMBER, items.map((i) => i.episode));
  const results: BulkOutcome[] = [];
  for (const item of items) {
    const refError = validateReference('vidara', item.reference);
    if (refError) { results.push({ episode: item.episode, ok: false, code: 'INVALID_REQUEST', message: refError }); continue; }
    const eligibilityError = eligibility.get(item.episode);
    if (eligibilityError != null && eligibilityError !== '') {
      results.push({ episode: item.episode, ok: false, code: 'EPISODE_NOT_RELEASED', message: eligibilityError });
      continue;
    }
    const normalized = normalizeReference('vidara', item.reference)!;
    const resolvedMediaItemId = await resolveMediaItemId(mediaService, {
      contentType: 'series', tmdbId: SEASON_TMDB_ID, title: 'Bulk Test Show', year: 2026,
      seasonNum: SEASON_NUMBER, episodeNum: item.episode, episodeTitle: item.episodeTitle ?? null,
    });
    const upsert = await upsertLinkAsset({
      adminClient: mock as never, adminUserId: 'admin-user-1',
      resolvedMediaItemId, providerSourceId,
      providerAssetId: normalized.providerAssetId, playbackUrl: normalized.playbackUrl,
      via: 'bulk-link',
    });
    if (upsert.ok) results.push({ episode: item.episode, ok: true, mediaAssetId: upsert.mediaAssetId, mode: upsert.mode });
    else results.push({ episode: item.episode, ok: false, code: upsert.code, message: upsert.message });
  }
  results.sort((a, b) => a.episode - b.episode);
  return results;
}

// ===========================================================================
console.log('§A — ONE season-metadata fetch evaluates the whole batch');
// ===========================================================================
clearCache();
tmdbFetches.length = 0;
{
  const items: BulkItem[] = [
    { episode: 1, reference: 'Vw0hY4n13k83' },
    { episode: 3, reference: 'AbCdEfGh123' },
    { episode: 4, reference: 'ZxYwVuTsRq1' },
  ];
  await runBulkBatch(items);
  const isSeasonFetch = (f: RecordedFetch) => /\/3\/tv\/1399\/season\/2$/.test(new URL(f.url).pathname);
  const seasonFetches = tmdbFetches.filter(isSeasonFetch);
  ok(seasonFetches.length === 1, `A1. one TMDB season fetch for the whole batch (got ${seasonFetches.length})`);
  // A second batch in the same process is served from cache (no re-fetch).
  await runBulkBatch([{ episode: 5, reference: 'QqWwEeRrTtY1' }]);
  const seasonFetches2 = tmdbFetches.filter(isSeasonFetch);
  ok(seasonFetches2.length === 1, 'A2. a second batch reuses the cached season metadata (still one fetch)');
}

// ===========================================================================
console.log('\n§B — mixed batch: per-episode outcomes, batch proceeds');
// ===========================================================================
await freshDb(); // §A's batches wrote rows — §B starts from a clean database.
{
  const before = mediaAssets().length;
  const results = await runBulkBatch([
    { episode: 1, reference: 'Vw0hY4n13k83' },                              // valid
    { episode: 2, reference: 'UnreleasedCode1' },                           // unreleased episode
    { episode: 3, reference: 'https://evil.example.com/e/BadOriginCode' },  // disallowed origin
  ]);
  ok(results.length === 3, 'B1. every submitted item has an outcome');
  ok(results[0].ok === true && results[0].mode === 'insert', 'B2. the valid reference links (insert)');
  ok(results[1].ok === false && results[1].code === 'EPISODE_NOT_RELEASED', 'B3. the unreleased episode fails with EPISODE_NOT_RELEASED');
  ok((results[1] as { message?: string }).message?.includes('not been released') === true, 'B4. the unreleased failure message is explicit (not a generic error)');
  ok(results[2].ok === false && results[2].code === 'INVALID_REQUEST', 'B5. the disallowed-origin reference fails with INVALID_REQUEST');
  ok(results.map((r) => r.episode).join(',') === '1,2,3', 'B6. results are ordered by episode');
  const failedCount = results.filter((r) => !r.ok).length;
  const succeededCount = results.filter((r) => r.ok).length;
  ok(failedCount === 2 && succeededCount === 1, 'B7. explicit per-batch counts (1 succeeded, 2 failed)');
  ok(mediaAssets().length === before + 1, 'B8. ONLY the valid episode wrote an asset row (failures wrote nothing)');
}

// ===========================================================================
console.log('\n§C — distinct references → DISTINCT asset rows + canonical URLs');
// ===========================================================================
await freshDb();
{
  const before = mediaAssets().length;
  const results = await runBulkBatch([
    { episode: 4, reference: 'ZxYwVuTsRq1' },
    { episode: 5, reference: 'https://vidara.so/v/ShareUrlCode' }, // share-URL form
  ]);
  ok(results.every((r) => r.ok), 'C1. both distinct references link successfully');
  const e4row = mediaAssets().find((a) => a.provider_asset_id === 'ZxYwVuTsRq1');
  const e5row = mediaAssets().find((a) => a.provider_asset_id === 'ShareUrlCode');
  ok(Boolean(e4row) && Boolean(e5row), 'C2. each episode has its OWN provider_asset_id row (never a shared reference)');
  ok(e4row?.media_item_id !== e5row?.media_item_id, 'C3. the two rows point at DIFFERENT media items (per-episode identity)');
  ok(e5row?.playback_url === 'https://vidara.to/e/ShareUrlCode', 'C4. a share-URL input is stored as the CANONICAL embed URL (Phase 6 contract)');
  ok(e4row?.playback_url === 'https://vidara.to/e/ZxYwVuTsRq1', 'C5. a short-code input constructs the canonical embed URL');
  ok(mediaAssets().length === before + 2, 'C6. exactly two new rows (no duplicates, no extra rows)');
}

// ===========================================================================
console.log('\n§D — retry semantics: idempotent re-link, no duplicates');
// ===========================================================================
await freshDb();
// Prime: episode 1 linked once by an earlier successful batch.
await runBulkBatch([{ episode: 1, reference: 'Vw0hY4n13k83' }]);
{
  const before = mediaAssets().length;
  // Retry: the admin resubmits a batch containing the ALREADY-SUCCEEDED
  // episode 1 (same reference) — e.g. because episode 3 failed earlier and
  // was fixed.
  const results = await runBulkBatch([
    { episode: 1, reference: 'Vw0hY4n13k83' },        // already linked
    { episode: 3, reference: 'FixedValidCode' },      // previously failed, now fixed
  ]);
  const r1 = results.find((r) => r.episode === 1);
  const r3 = results.find((r) => r.episode === 3);
  ok(r1?.ok === true && r1.mode === 'idempotent', 'D1. resubmitting an already-linked episode returns mode=idempotent');
  ok(r3?.ok === true && r3.mode === 'insert', 'D2. the fixed previously-failed episode now inserts');
  const rowsForE1 = mediaAssets().filter((a) => a.provider_asset_id === 'Vw0hY4n13k83');
  ok(rowsForE1.length === 1, 'D3. the succeeded episode was NOT duplicated by the retry (still one row)');
  ok(mediaAssets().length === before + 1, 'D4. the retry batch added exactly the ONE new (fixed) row');
  // And a third resubmit of the same linked episodes still changes nothing.
  await runBulkBatch([
    { episode: 1, reference: 'Vw0hY4n13k83' },
    { episode: 3, reference: 'FixedValidCode' },
  ]);
  ok(mediaAssets().length === before + 1, 'D5. a full-batch resubmit is a no-op for already-linked episodes (zero new rows)');
}

// ===========================================================================
console.log('\n§E — cross-request relink re-points ONE provider row');
// ===========================================================================
await freshDb();
{
  // The same provider reference submitted for a DIFFERENT episode (a
  // re-assignment across requests) must re-point the single unique row,
  // never create a second row for the same provider_asset_id.
  const before = mediaAssets().length;
  // Episode 5 carries TWO independent references.
  await runBulkBatch([
    { episode: 5, reference: 'MovedCode0001' },
    { episode: 5, reference: 'OtherRef0002' },
  ]);
  const results = await runBulkBatch([{ episode: 5, reference: 'MovedCode0001' }]);
  ok(results[0]?.ok === true && results[0].mode === 'idempotent', 'E1a. the first reference is linked to episode 5 (idempotent on resubmit)');
  const otherRowBefore = mediaAssets().find((a) => a.provider_asset_id === 'OtherRef0002');
  const results2 = await runBulkBatch([{ episode: 4, reference: 'MovedCode0001' }]);
  ok(results2[0]?.ok === true && results2[0].mode === 'relink', 'E2. the same reference for a different episode re-links (mode=relink)');
  const rows = mediaAssets().filter((a) => a.provider_asset_id === 'MovedCode0001');
  ok(rows.length === 1, 'E3. still exactly ONE row for that provider reference (unique constraint honored)');
  const otherRowAfter = mediaAssets().find((a) => a.provider_asset_id === 'OtherRef0002');
  ok(Boolean(otherRowAfter) && otherRowAfter?.media_item_id === otherRowBefore?.media_item_id, 'E4. the sibling reference\u2019s row is untouched by the relink (same media item)');
  ok(mediaAssets().length === before + 2, 'E5. the relink added zero rows (only the two initial inserts)');
}

// ===========================================================================
console.log('\n§F — the release gate is server-side (unbypassable by the client)');
// ===========================================================================
await freshDb();
{
  // A client cannot smuggle an unreleased episode past the gate: eligibility
  // is computed from TMDB air dates server-side, before any write.
  const before = mediaAssets().length;
  const results = await runBulkBatch([{ episode: UNRELEASED_EPISODE, reference: 'PerfectlyValidRef' }]);
  ok(results[0]?.ok === false && results[0].code === 'EPISODE_NOT_RELEASED', 'F1. a valid reference for an unreleased episode is still rejected');
  const rows = mediaAssets().filter((a) => a.provider_asset_id === 'PerfectlyValidRef');
  ok(rows.length === 0, 'F2. no asset row exists for the unreleased episode');
  const itemsRow = mock.tables[0].rows.filter((r) => r.episode === UNRELEASED_EPISODE && r.parent_media_id != null);
  ok(itemsRow.length === 0, 'F3. not even a media_item row was created for the unreleased episode (write never reached identity resolution)');
  ok(mediaAssets().length === before, 'F4. zero writes for the whole batch');
}

// ===========================================================================
console.log('\n§G — audit trail: every bulk write is tagged via=bulk-link');
// ===========================================================================
await freshDb(); // harvest §F's (empty) ops into the cumulative trail.
{
  const ops = allLinkOps;
  ok(ops.length > 0, 'G1. link operations were recorded');
  const bulkTagged = ops.filter((o) => (o.details as Record<string, unknown> | undefined)?.via === 'bulk-link');
  ok(bulkTagged.length === ops.length, 'G2. every link operation carries via=bulk-link (distinguishable from manual-link)');
  ok(ops.every((o) => o.admin_user_id === 'admin-user-1'), 'G3. the admin identity is recorded on every operation');
}

globalThis.fetch = realFetch;
console.log(`\nTask 3 bulk-link behavioral: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
