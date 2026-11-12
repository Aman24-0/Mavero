/**
 * UNIFIED LIVE TV — Phase 2 ingestion + refresh service verification.
 *
 * Covers the Phase 2 brief §8/§9/§11 requirements:
 *   §1  planning (pure) — first refresh, idempotent re-plan, admin-owned
 *       field preservation (canonical mapping + enablement + endpoint
 *       ordering), endpoint dedup, classification updates, stale reporting.
 *   §2  conservative canonical mapping — entries NEVER auto-mapped; identical
 *       display names NEVER merged; no candidate rows ever planned.
 *   §3  executor (mock DB) — bounded batches, per-item error isolation,
 *       entry→endpoint FK resolution, idempotency through the executor
 *       (second run writes nothing), uniqueness enforcement, update payloads
 *       never touch admin-owned columns, zero candidate writes.
 *   §4  refresh service — eligibility gates (S1/S2), typed failures
 *       (not found / ineligible / adapter unavailable / fetch failure),
 *       duplicate refresh prevention, source isolation in "all" mode, no
 *       source mutation on failure, outcome recording, dry-run preview
 *       writes NOTHING.
 *
 * NO real network (injected fetchers), NO real database (mock client).
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import {
  planSourceIngestion,
  applySourceIngestion,
  type ExistingEndpointRow,
  type ExistingSourceChannelRow
} from '../src/lib/server/livetv/ingestion';
import {
  refreshLivetvSource,
  refreshAllEligibleLivetvSources,
  previewLivetvSource,
  getLivetvRefreshOutcomes,
  resetLivetvRefreshStateForTests
} from '../src/lib/server/livetv/refresh-service';
import { buildNormalizedEndpoint, type NormalizedLivetvChannel } from '../src/lib/server/livetv/adapters/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizedChannel(overrides: Partial<NormalizedLivetvChannel> = {}): NormalizedLivetvChannel {
  return {
    sourceChannelId: 'ch-1',
    name: 'Channel One',
    category: 'News',
    logoUrl: 'https://cdn.example/one.png',
    tvgId: 'tvg.one',
    endpoints: [
      buildNormalizedEndpoint({ endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/one.m3u8', ordering: 0, label: null })
    ],
    metadata: { sourceFormat: 'm3u' },
    ...overrides
  };
}

function existingEntry(overrides: Partial<ExistingSourceChannelRow> = {}): ExistingSourceChannelRow {
  return {
    id: 'entry-1',
    source_id: 'src-1',
    source_channel_id: 'ch-1',
    canonical_channel_id: null,
    name: 'Channel One',
    category: 'News',
    logo_url: 'https://cdn.example/one.png',
    tvg_id: 'tvg.one',
    enabled: true,
    metadata: { sourceFormat: 'm3u' },
    ...overrides
  };
}

function existingEndpoint(overrides: Partial<ExistingEndpointRow> = {}): ExistingEndpointRow {
  return {
    id: 'ep-1',
    source_channel_id: 'entry-1',
    endpoint_kind: 'direct_stream',
    stream_format: 'hls',
    url: 'https://cdn.example/one.m3u8',
    ordering: 0,
    enabled: true,
    label: null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// A faithful mock of the supabase-js subset the services use, with REAL
// uniqueness enforcement (so idempotency is tested against the DB contract).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function createMockDb() {
  const state: Record<string, Row[]> = {
    livetv_sources: [],
    livetv_source_channels: [],
    livetv_playback_endpoints: [],
    livetv_playback_candidates: []
  };
  const writes: { table: string; op: 'insert' | 'update'; payload: Row }[] = [];
  const updateTargets: { table: string; filters: [string, unknown][]; payload: Row }[] = [];
  const forcedFailures: { table: string; op: 'insert' | 'update'; match: (payload: Row) => boolean; message: string }[] = [];
  let uuidCounter = 0;
  const nextId = () => `gen-${(uuidCounter += 1).toString().padStart(4, '0')}`;

  function applyFilters(rows: Row[], filters: [string, unknown][]): Row[] {
    return rows.filter((row) => filters.every(([col, val]) => row[col] === val));
  }

  function enforceUniqueness(table: string, payload: Row): string | null {
    if (table === 'livetv_source_channels') {
      const dup = state[table].some((row) => row['source_id'] === payload['source_id'] && row['source_channel_id'] === payload['source_channel_id']);
      if (dup) return 'duplicate key value violates unique constraint "livetv_source_channels_source_id_source_channel_id_key"';
    }
    if (table === 'livetv_playback_endpoints') {
      const dup = state[table].some((row) => row['source_channel_id'] === payload['source_channel_id'] && row['url'] === payload['url']);
      if (dup) return 'duplicate key value violates unique constraint "livetv_playback_endpoints_source_channel_id_url_key"';
    }
    return null;
  }

  function makeBuilder(table: string) {
    const filters: [string, unknown][] = [];
    const builder = {
      _selectCols: null as string | null,
      select(cols: string) {
        this._selectCols = cols;
        return this;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return this;
      },
      order(_col: string, _opts?: unknown) {
        return this;
      },
      limit(_n: number) {
        return this;
      },
      // supabase-js builders are thenable — a plain `await builder` executes
      // the select. The refresh service uses this shape in loadExistingState.
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) => {
        (async () => {
          const rows = applyFilters(state[table] ?? [], filters);
          return { data: rows, error: null };
        })().then(resolve, reject);
      },
      async maybeSingle() {
        const rows = applyFilters(state[table] ?? [], filters);
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const rows = applyFilters(state[table] ?? [], filters);
        return { data: rows[0] ?? null, error: rows.length ? null : { message: 'no rows returned' } };
      },
      insert(payload: Row) {
        return {
          select() {
            return {
              single: async () => {
                const failure = forcedFailures.find((f) => f.table === table && f.op === 'insert' && f.match(payload));
                if (failure) return { data: null, error: { message: failure.message } };
                const dup = enforceUniqueness(table, payload);
                if (dup) return { data: null, error: { message: dup } };
                const row = { ...payload, id: nextId() };
                state[table].push(row);
                writes.push({ table, op: 'insert', payload });
                return { data: { id: row['id'] }, error: null };
              }
            };
          },
          then: (resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) => {
            (async () => {
              const failure = forcedFailures.find((f) => f.table === table && f.op === 'insert' && f.match(payload));
              if (failure) return { data: null, error: { message: failure.message } };
              const dup = enforceUniqueness(table, payload);
              if (dup) return { data: null, error: { message: dup } };
              const row = { ...payload, id: nextId() };
              state[table].push(row);
              writes.push({ table, op: 'insert', payload });
              return { data: row, error: null };
            })().then(resolve, reject);
          }
        };
      },
      update(payload: Row) {
        return {
          eq(col: string, val: unknown) {
            const targetFilters: [string, unknown][] = [...filters, [col, val]];
            return {
              then: (resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) => {
                (async () => {
                  const failure = forcedFailures.find((f) => f.table === table && f.op === 'update' && f.match(payload));
                  if (failure) return { data: null, error: { message: failure.message } };
                  const rows = applyFilters(state[table] ?? [], targetFilters);
                  for (const row of rows) Object.assign(row, payload);
                  writes.push({ table, op: 'update', payload });
                  updateTargets.push({ table, filters: targetFilters, payload });
                  return { data: rows[0] ?? null, error: null };
                })().then(resolve, reject);
              }
            };
          }
        };
      }
    };
    return builder;
  }

  const client = {
    from: (table: string) => {
      if (!(table in state)) throw new Error(`unexpected table: ${table}`);
      return makeBuilder(table);
    }
  };

  return { client, state, writes, updateTargets, forcedFailures };
}

// ============================================================
console.log('§1 planning (pure)');
// ============================================================
{
  // First refresh over an empty source.
  const emptyPlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel()], existingEntries: [], existingEndpoints: [] });
  ok(emptyPlan.entries.length === 1 && emptyPlan.entries[0]!.action === 'insert', '§1.1 a new entry plans an INSERT');
  ok(emptyPlan.endpoints.length === 1 && emptyPlan.endpoints[0]!.action === 'insert', '§1.2 its endpoint plans an INSERT');
  ok(emptyPlan.counts.discovered === 1 && emptyPlan.counts.entriesInserted === 1 && emptyPlan.counts.endpointsInserted === 1, '§1.3 counts: discovered/inserted');

  // Idempotent re-plan over identical state.
  const existing = [existingEntry()];
  const existingEps = [existingEndpoint()];
  const samePlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel()], existingEntries: existing, existingEndpoints: existingEps });
  ok(samePlan.entries[0]!.action === 'update' && samePlan.entries[0]!.changes === false, '§1.4 identical state plans a NO-OP update (changes=false)');
  ok(samePlan.endpoints[0]!.action === 'update' && samePlan.endpoints[0]!.changes === false, '§1.5 identical endpoint plans a NO-OP update');
  ok(samePlan.counts.entriesUpdated === 0 && samePlan.counts.endpointsUpdated === 0 && samePlan.counts.entriesUnchanged === 1, '§1.6 unchanged counts evidence idempotency');
  ok(samePlan.endpointsMissingUpstream.length === 0 && samePlan.entriesMissingUpstream === 0, '§1.7 no stale diagnostics for a complete payload');

  // Admin-owned fields are preserved and never written.
  // NOTE: the display name/category/logo/tvg are SOURCE-provided provenance
  // (refresh updates them from upstream); the ADMIN-owned fields are the
  // canonical mapping + enablement — preserved and never written (§1.8, §3.9).
  const adminEntry = existingEntry({ canonical_channel_id: 'canon-1', enabled: false });
  const adminPlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel()], existingEntries: [adminEntry], existingEndpoints: [] });
  ok(adminPlan.entries[0]!.action === 'update' && adminPlan.entries[0]!.preserved.canonicalChannelId === 'canon-1' && adminPlan.entries[0]!.preserved.enabled === false, '§1.8 the plan carries the admin-owned mapping + enablement');
  const updatePlan = adminPlan.entries[0]!;
  ok(updatePlan.action === 'update', '§1.9a sanity');
  ok(updatePlan.changes === false, '§1.9 identical source-provided metadata → update is a no-op even when the admin disabled the entry or mapped it');

  // Metadata change triggers a bounded update.
  const changed = [normalizedChannel({ metadata: { sourceFormat: 'm3u', groupTitle: 'Changed' } })];
  const changedPlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: changed, existingEntries: existing, existingEndpoints: existingEps });
  ok(changedPlan.entries[0]!.action === 'update' && changedPlan.entries[0]!.changes === true && changedPlan.counts.entriesUpdated === 1, '§1.10 a metadata change is detected (order-insensitive)');

  // New endpoint appears; old one goes stale (report-only).
  const twoEndpoints = normalizedChannel({
    endpoints: [
      buildNormalizedEndpoint({ endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/one.m3u8', ordering: 0, label: null }),
      buildNormalizedEndpoint({ endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/one-alt.m3u8', ordering: 1, label: null })
    ]
  });
  const newEpPlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [twoEndpoints], existingEntries: existing, existingEndpoints: existingEps });
  ok(newEpPlan.endpoints.filter((e) => e.action === 'insert').length === 1, '§1.11 a NEW url plans an insert (no duplicate for the known one)');
  const vanishing = normalizedChannel({ endpoints: [] });
  const stalePlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [vanishing], existingEntries: existing, existingEndpoints: existingEps });
  ok(stalePlan.endpointsMissingUpstream.length === 1 && stalePlan.endpointsMissingUpstream[0]!.url === 'https://cdn.example/one.m3u8', '§1.12 a vanished endpoint is REPORTED (report-only stale strategy)');
  ok(stalePlan.endpoints.every((e) => e.action !== 'update' || !e.changes), '§1.13 the vanished endpoint is NOT mutated (no disable, no delete)');

  // Entry missing upstream.
  const otherEntry = existingEntry({ id: 'entry-2', source_channel_id: 'ch-other' });
  const omitPlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel()], existingEntries: [...existing, otherEntry], existingEndpoints: [] });
  ok(omitPlan.entriesMissingUpstream === 1, '§1.14 an upstream-omitted entry is counted, never touched/deleted');

  // Classification update preserves endpoint enablement/ordering.
  const relabelled = normalizedChannel({ endpoints: [buildNormalizedEndpoint({ endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/one.m3u8', ordering: 0, label: 'Primary' })] });
  const rePlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [relabelled], existingEntries: existing, existingEndpoints: [existingEndpoint({ enabled: false, ordering: 7 })] });
  ok(rePlan.endpoints[0]!.action === 'update' && rePlan.endpoints[0]!.changes === true, '§1.15 a label change is a real update');
  ok(rePlan.endpoints[0]!.preserved.enabled === false && rePlan.endpoints[0]!.preserved.ordering === 7, '§1.16 endpoint enablement + ordering are admin-owned (preserved)');
}

// ============================================================
console.log('§2 conservative canonical mapping');
// ============================================================
{
  const sameName = [normalizedChannel(), normalizedChannel({ sourceChannelId: 'ch-2', tvgId: 'tvg.two', endpoints: [buildNormalizedEndpoint({ endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/two.m3u8', ordering: 0, label: null })] })];
  const plan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: sameName, existingEntries: [], existingEndpoints: [] });
  ok(plan.entries.length === 2, '§2.1 identical display names from one source stay SEPARATE entries (name never merges)');
  ok(plan.entries.every((e) => e.action === 'insert'), '§2.2 both planned as inserts');
  const canonicalWrites = plan.entries.filter((e) => 'canonicalChannelId' in e).length;
  ok(canonicalWrites === 0, '§2.3 the plan NEVER carries a canonical mapping (entries are born unmapped)');
  // No candidate planning surface exists at all — enforced by the type shape
  // (no plan variant writes livetv_playback_candidates; executor-checked in §3).
}

// ============================================================
console.log('§3 executor through the mock DB');
// ============================================================
{
  const db = createMockDb();
  db.client.from('livetv_sources') && db.state.livetv_sources.push({ id: 'src-1', slug: 'test-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/list.m3u8' } });
  const plan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel(), normalizedChannel({ sourceChannelId: 'ch-2', name: 'Channel Two', endpoints: [buildNormalizedEndpoint({ endpointKind: 'embed_page', url: 'https://cdn.example/two/embed', ordering: 0, label: null })] })], existingEntries: [], existingEndpoints: [] });
  const execution = await applySourceIngestion(db.client as never, plan);
  ok(execution.errors.length === 0, '§3.1 clean execution has no errors');
  ok(db.state.livetv_source_channels.length === 2, '§3.2 both entries inserted');
  ok(db.state.livetv_playback_endpoints.length === 2, '§3.3 both endpoints inserted (FK resolved from the inserted entry ids)');
  ok(db.state.livetv_source_channels.every((row) => row['canonical_channel_id'] === null || row['canonical_channel_id'] === undefined), '§3.4 inserted entries are UNMAPPED (conservative mapping)');
  ok(db.state.livetv_playback_candidates.length === 0, '§3.5 ZERO playback-candidate rows created (source-level default ordering remains available)');

  // Idempotency through the executor: re-plan + re-apply over the same state.
  const stateNow = db.state.livetv_source_channels as unknown as ExistingSourceChannelRow[];
  const epsNow = db.state.livetv_playback_endpoints as unknown as ExistingEndpointRow[];
  const plan2 = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel(), normalizedChannel({ sourceChannelId: 'ch-2', name: 'Channel Two', endpoints: [buildNormalizedEndpoint({ endpointKind: 'embed_page', url: 'https://cdn.example/two/embed', ordering: 0, label: null })] })], existingEntries: stateNow, existingEndpoints: epsNow });
  const execution2 = await applySourceIngestion(db.client as never, plan2);
  ok(execution2.appliedEntryWrites === 0 && execution2.appliedEndpointWrites === 0, '§3.6 a repeated refresh applies ZERO writes (idempotent convergence)');
  ok(db.state.livetv_source_channels.length === 2 && db.state.livetv_playback_endpoints.length === 2, '§3.7 no duplicate rows after the second run');

  // Update payloads never touch admin-owned columns (fresh DB with the
  // admin-owned row actually stored).
  const db2 = createMockDb();
  db2.state.livetv_source_channels.push({ ...existingEntry(), id: 'entry-admin', canonical_channel_id: 'canon-9', enabled: false, metadata: { stale: true } });
  const adminPlan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel({ metadata: { sourceFormat: 'm3u', fresh: true } })], existingEntries: db2.state.livetv_source_channels as unknown as ExistingSourceChannelRow[], existingEndpoints: [] });
  await applySourceIngestion(db2.client as never, adminPlan);
  const updateWrites = db2.writes.filter((w) => w.table === 'livetv_source_channels' && w.op === 'update');
  ok(updateWrites.length === 1, '§3.8 the metadata-only change is a single update');
  const payloadKeys = Object.keys(updateWrites[0]!.payload).sort();
  ok(JSON.stringify(payloadKeys) === JSON.stringify(['category', 'logo_url', 'metadata', 'name', 'tvg_id']), '§3.9 update payloads carry ONLY the five writable columns (canonical_channel_id/enabled never written)');
  const stored = db2.state.livetv_source_channels.find((row) => row['source_channel_id'] === 'ch-1')!;
  ok(stored['canonical_channel_id'] === 'canon-9' && stored['enabled'] === false, '§3.10 the admin-owned mapping + enablement SURVIVE the refresh');
  ok(JSON.stringify(stored['metadata']) === JSON.stringify({ sourceFormat: 'm3u', fresh: true }), '§3.11 the bounded provenance metadata is updated');
}

// ============================================================
console.log('§3b executor error isolation');
// ============================================================
{
  const db = createMockDb();
  db.forcedFailures.push({ table: 'livetv_source_channels', op: 'insert', match: (payload) => payload['source_channel_id'] === 'ch-1', message: 'simulated unique violation' });
  const plan = planSourceIngestion({ sourceId: 'src-1', adapterChannels: [normalizedChannel(), normalizedChannel({ sourceChannelId: 'ch-2', name: 'Channel Two', endpoints: [buildNormalizedEndpoint({ endpointKind: 'embed_page', url: 'https://cdn.example/two/embed', ordering: 0, label: null })] })], existingEntries: [], existingEndpoints: [] });
  const execution = await applySourceIngestion(db.client as never, plan);
  const entryInsertError = execution.errors.find((e) => e.scope === 'entry_insert');
  ok(!!entryInsertError && entryInsertError.sourceChannelId === 'ch-1', '§3b.1 the failing entry is recorded with scope + identity');
  ok(db.state.livetv_source_channels.some((row) => row['source_channel_id'] === 'ch-2'), '§3b.2 the OTHER entry still inserted (per-item isolation)');
  ok(execution.errors[0]!.url === null && execution.errors.some((e) => e.scope === 'endpoint_insert' && e.sourceChannelId === 'ch-1'), '§3b.3 the failed entry\u2019s endpoint insert is also isolated (missing FK) without crashing');
  ok(db.state.livetv_playback_endpoints.some((row) => row['url'] === 'https://cdn.example/two/embed'), '§3b.4 the healthy endpoint still inserted');
  // Simulated failures are bounded messages, never raw driver dumps.
  ok(execution.errors.every((e) => typeof e.message === 'string' && e.message.length <= 200), '§3b.5 error messages are bounded strings');
}

// ============================================================
console.log('§4 refresh service');
// ============================================================
{
  resetLivetvRefreshStateForTests();

  const okFetcher = (async (url: RequestInfo | URL) => {
    const text = ['#EXTM3U', '#EXTINF:-1 tvg-id="r.1",Refreshed', 'https://cdn.example/r1.m3u8'].join('\n');
    return new Response(text, { headers: { 'content-type': 'audio/x-mpegurl' } });
  }) as unknown as typeof fetch;
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];

  // Source lookup failure.
  let db = createMockDb();
  let outcome = await refreshLivetvSource(db.client as never, { slug: 'missing' });
  ok(outcome.ok === false && outcome.failure?.kind === 'source_not_found', '§4.1 a missing source is a typed source_not_found');

  // Ineligible: disabled.
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-1', slug: 'off-source', source_type: 'm3u_playlist', enabled: false, status: 'active', config: {} });
  outcome = await refreshLivetvSource(db.client as never, { id: 'src-1' });
  ok(outcome.ok === false && outcome.failure?.kind === 'source_ineligible', '§4.2 a DISABLED source is never refreshed (rule S1)');

  // Ineligible: status 'unavailable'.
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-2', slug: 'down-source', source_type: 'm3u_playlist', enabled: true, status: 'unavailable', config: {} });
  outcome = await refreshLivetvSource(db.client as never, { id: 'src-2' });
  ok(outcome.ok === false && outcome.failure?.kind === 'source_ineligible', '§4.3 a non-eligible STATUS is never refreshed (rule S2 parity)');

  // Adapter unavailable.
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-3', slug: 'embed-only', source_type: 'embed_provider', enabled: true, status: 'active', config: { allowedOrigins: ['https://player.example'] } });
  outcome = await refreshLivetvSource(db.client as never, { id: 'src-3' });
  ok(outcome.ok === false && outcome.failure?.kind === 'adapter_unavailable', '§4.4 a source type without a Phase 2 adapter is a typed failure');

  // Successful refresh (m3u via injected fetcher).
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-4', slug: 'm3u-live', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/list.m3u8' } });
  outcome = await refreshLivetvSource(db.client as never, { id: 'src-4' }, { fetcher: okFetcher, dnsResolver: resolver });
  ok(outcome.ok === true && outcome.adapterId === 'm3u_playlist', '§4.5 a healthy refresh succeeds with its adapter identity');
  ok(outcome.counts?.discovered === 1 && outcome.counts.entriesInserted === 1 && outcome.counts.endpointsInserted === 1, '§4.6 counts reflect the ingestion');
  ok(db.state.livetv_source_channels.length === 1 && db.state.livetv_playback_endpoints.length === 1, '§4.7 the mock DB now holds the ingested rows');
  ok(db.writes.every((w) => w.table !== 'livetv_sources'), '§4.8 the refresh NEVER mutates the source row (no accidental disabling)');

  // Re-run: idempotent, zero writes.
  const writesBefore = db.writes.length;
  const outcome2 = await refreshLivetvSource(db.client as never, { id: 'src-4' }, { fetcher: okFetcher, dnsResolver: resolver });
  ok(outcome2.ok === true && outcome2.counts?.entriesInserted === 0 && outcome2.counts.endpointsInserted === 0, '§4.9 the repeated refresh inserts nothing');
  ok(db.writes.length === writesBefore, '§4.10 the repeated refresh performs ZERO writes');

  // Fetch failure taxonomy.
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-5', slug: 'bad-url', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://private.example/list.m3u8' } });
  const failing = await refreshLivetvSource(db.client as never, { id: 'src-5' }, { fetcher: (async () => new Response('x')) as unknown as typeof fetch, dnsResolver: async () => [{ address: '10.0.0.9', family: 4 }] });
  ok(failing.ok === false && failing.failure?.kind === 'blocked_url', '§4.11 a private-network playlist host is a typed blocked_url source failure');
  ok(db.state.livetv_source_channels.length === 0, '§4.12 a failed refresh writes NOTHING (no partial ingestion)');

  // Invalid payload taxonomy.
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-6', slug: 'bad-payload', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/list.m3u8' } });
  const invalid = await refreshLivetvSource(db.client as never, { id: 'src-6' }, { fetcher: (async () => new Response('<html>error page</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch, dnsResolver: resolver });
  ok(invalid.ok === false && invalid.failure?.kind === 'unsupported_media_type', '§4.13 an HTML error page is a typed invalid-document failure (distinct from per-entry errors)');

  // Per-entry failures do NOT fail the source.
  // 2026-10 round 10 — Task 1: the "bad" URL `https://cdn.example/bad`
  // (no extension) is now ACCEPTED as HLS (self-correcting at load).
  // To test per-entry skip, we use a .html URL (still rejected).
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-7', slug: 'mixed-playlist', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/list.m3u8' } });
  const mixedFetcher = (async () => new Response(['#EXTM3U', '#EXTINF:-1 tvg-id="ok.one",Ok', 'https://cdn.example/ok.m3u8', '#EXTINF:-1 tvg-id="bad.one",Bad', 'https://cdn.example/bad.html'].join('\n'), { headers: { 'content-type': 'audio/x-mpegurl' } })) as unknown as typeof fetch;
  const mixed = await refreshLivetvSource(db.client as never, { id: 'src-7' }, { fetcher: mixedFetcher, dnsResolver: resolver });
  ok(mixed.ok === true, '§4.14 per-entry failures do NOT fail the refresh');
  ok(mixed.counts?.discovered === 1 && mixed.counts?.skipped === 1 && (mixed.skippedReasons?.['unknown_stream_format'] ?? 0) === 1, '§4.15 the invalid entry (.html) is counted as skipped with its typed reason');
  ok((mixed.entryErrors?.length ?? 0) === 1 && mixed.entryErrors?.[0]?.reason === 'unknown_stream_format', '§4.16 the per-entry diagnostic is structured');

  // Duplicate refresh prevention (in-flight).
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-8', slug: 'slow-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/slow.m3u8' } });
  let releaseSlow: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const slowFetcher = (async () => {
    await gate;
    return new Response('#EXTM3U\n#EXTINF:-1 tvg-id="s.1",Slow\nhttps://cdn.example/s.m3u8', { headers: { 'content-type': 'audio/x-mpegurl' } });
  }) as unknown as typeof fetch;
  const first = refreshLivetvSource(db.client as never, { id: 'src-8' }, { fetcher: slowFetcher, dnsResolver: resolver });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await refreshLivetvSource(db.client as never, { id: 'src-8' }, { fetcher: slowFetcher, dnsResolver: resolver });
  ok(second.ok === false && second.failure?.kind === 'refresh_in_progress', '§4.17 a concurrent second refresh is refused with a typed refresh_in_progress');
  releaseSlow!();
  const firstOutcome = await first;
  ok(firstOutcome.ok === true, '§4.18 the first refresh completes normally after the gate opens');

  // Multi-source isolation.
  db = createMockDb();
  db.state.livetv_sources.push(
    { id: 'src-a', slug: 'a-good', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/a.m3u8' }, priority: 10 },
    { id: 'src-b', slug: 'b-broken', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://private.example/b.m3u8' }, priority: 20 },
    { id: 'src-c', slug: 'c-off', source_type: 'm3u_playlist', enabled: false, status: 'active', config: {}, priority: 30 }
  );
  const goodFetcher = (async () => new Response('#EXTM3U\n#EXTINF:-1 tvg-id="g.1",Good\nhttps://cdn.example/g.m3u8', { headers: { 'content-type': 'audio/x-mpegurl' } })) as unknown as typeof fetch;
  const allOutcome = await refreshAllEligibleLivetvSources(db.client as never, { fetcher: goodFetcher, dnsResolver: async (host) => (host === 'private.example' ? [{ address: '10.0.0.9', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]) });
  ok(allOutcome.eligibleSources === 2 && allOutcome.refreshedSources === 2, '§4.19 the disabled source is excluded from the eligible set');
  const brokenOutcome = allOutcome.outcomes.find((o) => o.slug === 'b-broken')!;
  const goodOutcome = allOutcome.outcomes.find((o) => o.slug === 'a-good')!;
  ok(brokenOutcome.ok === false && brokenOutcome.failure?.kind === 'blocked_url', '§4.20 the broken source fails with its own typed error');
  ok(goodOutcome.ok === true && goodOutcome.counts?.entriesInserted === 1, '§4.21 the broken source did NOT prevent the healthy one (isolation)');

  // Outcome record + dry-run preview.
  const recorded = getLivetvRefreshOutcomes();
  ok(recorded.length >= 4, '§4.22 the bounded in-memory record holds the refresh outcomes (last-attempt reporting)');
  db = createMockDb();
  db.state.livetv_sources.push({ id: 'src-p', slug: 'preview-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/p.m3u8' } });
  const writesBeforePreview = db.writes.length;
  const preview = await previewLivetvSource(db.client as never, { id: 'src-p' }, { fetcher: goodFetcher, dnsResolver: resolver });
  ok(preview.ok === true && preview.adapterId === 'm3u_playlist' && preview.counts?.entriesInserted === 1, '§4.23 the dry-run preview plans the same ingestion');
  ok(db.writes.length === writesBeforePreview && db.state.livetv_source_channels.length === 0, '§4.24 the preview writes NOTHING (zero persistence)');
  ok(preview.endpointKinds !== null && JSON.stringify(Object.keys(preview.endpointKinds!)) === JSON.stringify(['direct_stream:hls']), '§4.25 the preview reports the endpoint-kind histogram (safe; no URLs)');
}

console.log(`\n=== livetv Phase 2 ingestion/refresh verification: ${passed} checks PASSED ===`);
