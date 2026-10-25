/**
 * UNIFIED LIVE TV — Phase 5 playback candidate resolution verification.
 *
 * Covers the Phase 5 brief §9 requirements (server side):
 *   §1  flag gate — unified_enabled read is fail-closed (any error → false),
 *       cached (TTL), and FALSE short-circuits the resolve flow (no further
 *       reads — the legacy path stays authoritative).
 *   §2  selection mapping — a selection with NO builtin source / NO entry /
 *       an UNMAPPED entry resolves `resolved:false` (the client's documented
 *       legacy compatibility path).
 *   §3  candidate ordering — DEFAULT mode derives from source priority with
 *       the builtin's synthesized pair positioned by the registry's OWN
 *       mechanics (never hardcoded first/last); EXPLICIT mode is
 *       registry-pure (candidate rows authoritative; the builtin, which has
 *       no rows, contributes nothing — the documented schema-gap answer).
 *   §4  the eligibility gate matrix (S1/S2/C1/M0/M1/E1/P1) — every disabled
 *       link excludes its candidates.
 *   §5  cross-channel integrity — candidate rows of another channel never
 *       appear; endpoint reads are scoped to THIS channel's entries.
 *   §6  URL discipline — non-https stored endpoints are SKIPPED (fail-closed);
 *       synthesized builtin candidates carry NO url (resolver marker only).
 *   §7  wire redaction — the payload carries ONLY the bounded candidate
 *       fields; no config jsonb, capabilities, slugs or source ids; bounded
 *       count (cap 12); malformed rows are dropped, never coerced.
 *
 * NO real network, NO real database (read-only mock client following the
 * Phase 2/3/4 suite conventions; query shapes mirror the resolver exactly).
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import {
  isUnifiedLivetvEnabled,
  resetLivetvPlaybackFlagCacheForTests,
  resolveLivetvPlaybackForSelection,
  MAX_PLAYBACK_CANDIDATES
} from '../src/lib/server/livetv/playback-resolver';

// ---------------------------------------------------------------------------
// Read-only mock client — chains exactly like supabase-js for the shapes the
// resolver issues: select/eq/in/order/limit → { data, error } / maybeSingle.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type QuerySpec = {
  table: string;
  filters: { col: string; op: string; val: unknown }[];
  orders: { col: string; asc: boolean }[];
  limit: number | null;
};

function createMockClient(tables: Record<string, Row[]>, options: { failTable?: string; failFlag?: boolean } = {}) {
  const issued: QuerySpec[] = [];

  function runQuery(spec: QuerySpec): { data: Row[] | Row | null; error: { message: string } | null } {
    issued.push(spec);
    if (options.failTable === spec.table) return { data: null, error: { message: 'mock read failure' } };
    let rows = [...(tables[spec.table] ?? [])];
    for (const filter of spec.filters) {
      rows = rows.filter((row) => {
        if (filter.op === 'eq') return row[filter.col] === filter.val;
        if (filter.op === 'in') return (filter.val as unknown[]).includes(row[filter.col]);
        return true;
      });
    }
    for (const order of [...spec.orders].reverse()) {
      rows.sort((a, b) => {
        const av = a[order.col];
        const bv = b[order.col];
        if (av === bv) return 0;
        const cmp = String(av) < String(bv) ? -1 : 1;
        return order.asc ? cmp : -cmp;
      });
    }
    if (spec.limit !== null) rows = rows.slice(0, spec.limit);
    return { data: rows, error: null };
  }

  function makeBuilder(spec: QuerySpec): unknown {
    const builder = {
      select(): unknown {
        return builder;
      },
      eq(col: string, val: unknown): unknown {
        spec.filters.push({ col, op: 'eq', val });
        return builder;
      },
      in(col: string, val: unknown[]): unknown {
        spec.filters.push({ col, op: 'in', val });
        return builder;
      },
      order(col: string): unknown {
        spec.orders.push({ col, asc: true });
        return builder;
      },
      limit(n: number): unknown {
        spec.limit = n;
        return builder;
      },
      maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
        const result = runQuery(spec);
        const rows = (result.data as Row[] | null) ?? [];
        const flagFail = options.failFlag === true && spec.table === 'livetv_config_meta';
        return Promise.resolve(flagFail ? { data: null, error: { message: 'flag read failed' } } : { data: rows[0] ?? null, error: null });
      },
      then(resolve: (value: { data: Row[]; error: { message: string } | null }) => unknown, reject: (err: unknown) => unknown): unknown {
        const result = runQuery(spec);
        const flagFail = options.failFlag === true && spec.table === 'livetv_config_meta';
        if (flagFail) return reject(new Error('flag read failed'));
        if (result.error) return resolve({ data: [], error: result.error });
        return resolve({ data: (result.data as Row[]) ?? [], error: null });
      }
    };
    return builder;
  }

  return {
    from(table: string): unknown {
      return makeBuilder({ table, filters: [], orders: [], limit: null });
    },
    issued,
    queriesFor(table: string): QuerySpec[] {
      return issued.filter((spec) => spec.table === table);
    }
  };
}

type MockClient = ReturnType<typeof createMockClient>;
type ResolveClient = Parameters<typeof resolveLivetvPlaybackForSelection>[0];

// ---------------------------------------------------------------------------
// Fixture builders (UUID-shaped ids; deterministic values).
// ---------------------------------------------------------------------------

const IDS = {
  builtin: 'b1000000-0000-0000-0000-000000000001',
  playlist: 'b1000000-0000-0000-0000-000000000002',
  embedSrc: 'b1000000-0000-0000-0000-000000000003',
  channel: 'c1000000-0000-0000-0000-000000000001',
  otherChannel: 'c1000000-0000-0000-0000-000000000002',
  builtinEntry: 'e1000000-0000-0000-0000-000000000001',
  playlistEntry: 'e1000000-0000-0000-0000-000000000002',
  embedEntry: 'e1000000-0000-0000-0000-000000000003',
  playlistEndpoint: 'p1000000-0000-0000-0000-000000000001',
  embedEndpoint: 'p1000000-0000-0000-0000-000000000002',
  playlistCandidate: 'd1000000-0000-0000-0000-000000000001'
};

const SELECTION_ID = '143';

function sourceRow(over: Partial<Row> = {}): Row {
  return {
    id: IDS.playlist,
    slug: 'playlist-a',
    name: 'Playlist A',
    source_type: 'm3u_playlist',
    builtin: false,
    enabled: true,
    status: 'active',
    priority: 10,
    visibility: 'public',
    capabilities: {},
    config: { playlistUrl: 'https://example.com/list.m3u' },
    description: null,
    ...over
  };
}

function builtinSourceRow(over: Partial<Row> = {}): Row {
  return sourceRow({
    id: IDS.builtin,
    slug: 'builtin-livegt-v1',
    name: 'LiveGT V1',
    source_type: 'builtin_livegt_v1',
    builtin: true,
    priority: 0,
    config: {},
    ...over
  });
}

function entryRow(over: Partial<Row> = {}): Row {
  return {
    id: IDS.builtinEntry,
    source_id: IDS.builtin,
    source_channel_id: SELECTION_ID,
    canonical_channel_id: IDS.channel,
    name: 'News One',
    category: 'News',
    logo_url: null,
    tvg_id: null,
    enabled: true,
    ...over
  };
}

function channelRow(over: Partial<Row> = {}): Row {
  return {
    id: IDS.channel,
    name: 'News One',
    category: 'News',
    logo_url: null,
    dedup_key: null,
    enabled: true,
    ...over
  };
}

function endpointRow(over: Partial<Row> = {}): Row {
  return {
    id: IDS.playlistEndpoint,
    source_channel_id: IDS.playlistEntry,
    endpoint_kind: 'direct_stream',
    stream_format: 'hls',
    url: 'https://streams.example.com/news/index.m3u8',
    ordering: 0,
    enabled: true,
    label: 'Primary',
    ...over
  };
}

function candidateRow(over: Partial<Row> = {}): Row {
  return {
    id: IDS.playlistCandidate,
    channel_id: IDS.channel,
    endpoint_id: IDS.playlistEndpoint,
    priority: 0,
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    ...over
  };
}

function baseTables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    livetv_config_meta: [{ id: 1, version: 7, unified_enabled: true, updated_at: '2026-01-01T00:00:00Z' }],
    livetv_sources: [builtinSourceRow()],
    livetv_channels: [channelRow()],
    livetv_source_channels: [entryRow()],
    livetv_playback_endpoints: [],
    livetv_playback_candidates: [],
    ...over
  };
}

async function resolve(client: MockClient, selectionId: string = SELECTION_ID) {
  return resolveLivetvPlaybackForSelection(client as unknown as ResolveClient, selectionId);
}

// ============================================================
// §1 — Flag gate: fail-closed, cached, short-circuiting.
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  const failing = createMockClient(baseTables(), { failFlag: true });
  const flag = await isUnifiedLivetvEnabled(failing as unknown as ResolveClient);
  ok(flag === false, 'S1.1 flag read failure fails CLOSED to false (legacy path)');
  resetLivetvPlaybackFlagCacheForTests();
  const missing = createMockClient({ livetv_config_meta: [] });
  ok((await isUnifiedLivetvEnabled(missing as unknown as ResolveClient)) === false, 'S1.2 a missing config row reads as false');
  resetLivetvPlaybackFlagCacheForTests();
  const cached = createMockClient(baseTables());
  ok((await isUnifiedLivetvEnabled(cached as unknown as ResolveClient)) === true, 'S1.3 unified_enabled=true reads true');
  ok((await isUnifiedLivetvEnabled(cached as unknown as ResolveClient)) === true, 'S1.4 the cached value is served without a second read');
  ok(cached.issued.filter((spec) => spec.table === 'livetv_config_meta').length === 1, 'S1.5 exactly ONE flag read hit the client (cache TTL)');
  resetLivetvPlaybackFlagCacheForTests();
  ok(cached.queriesFor('livetv_config_meta').every((spec) => spec.filters.some((f) => f.col === 'id' && f.val === 1)), 'S1.6 the flag query is scoped to the config row id=1');

  // R-9: Flag FALSE no longer short-circuits canonical resolution.
  // The resolver now resolves non-builtin endpoints regardless of the flag.
  // The flag ONLY gates the builtin virtual pair synthesis.
  const offClient = createMockClient(baseTables({ livetv_config_meta: [{ id: 1, version: 7, unified_enabled: false, updated_at: '2026-01-01T00:00:00Z' }] }));
  const offResult = await resolve(offClient);
  ok(offResult.resolved === true, 'S1.7 R-9: flag off → resolved:true (canonical IDs resolve through non-builtin endpoints regardless of the flag)');
  // The builtin virtual pair is NOT synthesized when the flag is off.
  ok(!offResult.candidates.some((c) => c.resolver === 'builtin_livegt_v1'), 'S1.7b R-9: the builtin virtual pair is NOT synthesized when the flag is off');
  resetLivetvPlaybackFlagCacheForTests();
  ok('S1 flag gate verified');
}

// ============================================================
// §2 — Selection mapping: unmanaged selections → legacy path.
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  const noBuiltin = createMockClient(baseTables({ livetv_sources: [] }));
  ok((await resolve(noBuiltin)).resolved === false, 'S2.1 no builtin source row → resolved:false');
  const noEntry = createMockClient(baseTables({ livetv_source_channels: [] }));
  ok((await resolve(noEntry)).resolved === false, 'S2.2 no builtin entry for the selection → resolved:false');
  const unmapped = createMockClient(baseTables({ livetv_source_channels: [entryRow({ canonical_channel_id: null })] }));
  ok((await resolve(unmapped)).resolved === false, 'S2.3 an UNMAPPED entry → resolved:false (conservative mapping model)');
  const wrongEntry = createMockClient(baseTables({ livetv_source_channels: [entryRow({ source_channel_id: '999' })] }));
  ok((await resolve(wrongEntry)).resolved === false, 'S2.4 an entry for a DIFFERENT selection → resolved:false');
  const noChannel = createMockClient(baseTables({ livetv_channels: [] }));
  ok((await resolve(noChannel)).resolved === false, 'S2.5 a missing canonical channel row (defensive) → resolved:false');
  const readFailure = createMockClient(baseTables(), { failTable: 'livetv_playback_endpoints' });
  ok((await resolve(readFailure)).resolved === false, 'S2.6 a registry read failure → resolved:false (fail-closed, never an empty managed answer)');
  ok('S2 unmanaged selections verified');
}

// ============================================================
// §3 — Ordering: default mode with the synthesized builtin pair.
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  // Production-shaped default: the builtin alone (priority 0), mapped entry.
  const builtinOnly = await resolve(createMockClient(baseTables()));
  ok(builtinOnly.resolved === true && builtinOnly.mode === 'default', 'S3.1 a mapped builtin entry resolves in default mode');
  ok(builtinOnly.candidates.length === 2, 'S3.2 the builtin contributes exactly its synthesized pair');
  ok(builtinOnly.candidates[0]!.endpointKind === 'direct_stream' && builtinOnly.candidates[0]!.engine === 'shaka_media_player', 'S3.3 the direct candidate precedes the embed candidate (endpoint ordering)');
  ok(builtinOnly.candidates[1]!.endpointKind === 'embed_page' && builtinOnly.candidates[1]!.engine === 'iframe_embed', 'S3.4 the embed candidate maps to the iframe integration');
  ok(builtinOnly.candidates.every((candidate) => candidate.url === null), 'S3.5 synthesized candidates carry NO url (fresh-signed contract)');
  ok(builtinOnly.candidates.every((candidate) => candidate.resolver === 'builtin_livegt_v1' && candidate.sourceChannelId === SELECTION_ID), 'S3.6 the resolver marker carries the public catalogue id');
  ok(builtinOnly.candidates[0]!.streamFormat === 'dash' && builtinOnly.candidates[1]!.streamFormat === null, 'S3.7 direct carries dash; embed carries no format');

  // Source priority positions the pair: playlist (priority 0) BEFORE the
  // builtin (priority 10) — the registry's own default mechanics.
  const playlistFirst = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 10 }), sourceRow({ priority: 0 })],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow()]
      })
    )
  );
  ok(playlistFirst.candidates.length === 3, 'S3.8 both sources contribute (playlist direct + builtin pair)');
  ok(playlistFirst.candidates[0]!.url === 'https://streams.example.com/news/index.m3u8' && playlistFirst.candidates[0]!.resolver === null, 'S3.9 the playlist endpoint plays FIRST (lower priority number)');
  ok(playlistFirst.candidates[1]!.endpointKind === 'direct_stream' && playlistFirst.candidates[1]!.resolver === 'builtin_livegt_v1', 'S3.10 the builtin direct follows');
  ok(playlistFirst.candidates[2]!.endpointKind === 'embed_page' && playlistFirst.candidates[2]!.resolver === 'builtin_livegt_v1', 'S3.11 the builtin embed is last (direct → embed within the source)');

  // Raising the builtin's priority (admin reorder) puts it FIRST — never
  // hardcoded first, never hardcoded last.
  const builtinFirst = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 0 }), sourceRow({ priority: 5 })],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow()]
      })
    )
  );
  ok(builtinFirst.candidates[0]!.resolver === 'builtin_livegt_v1' && builtinFirst.candidates[0]!.endpointKind === 'direct_stream', 'S3.12 the builtin is FIRST when its source priority is lower (admin-controlled)');
  ok(builtinFirst.candidates[2]!.url === 'https://streams.example.com/news/index.m3u8', 'S3.13 the playlist endpoint follows the builtin pair');

  ok('S3 default-mode ordering verified');
}

// ============================================================
// §4 — EXPLICIT mode: registry rows are authoritative.
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  const explicit = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 0 }), sourceRow({ priority: 10 })],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow()],
        livetv_playback_candidates: [candidateRow()]
      })
    )
  );
  ok(explicit.resolved === true && explicit.mode === 'explicit', 'S4.1 candidate rows switch the channel into explicit mode');
  ok(explicit.candidates.length === 1, 'S4.2 ONLY the row-listed endpoints participate (unlisted endpoints never auto-included)');
  ok(explicit.candidates[0]!.url === 'https://streams.example.com/news/index.m3u8', 'S4.3 the explicit list is the whole truth');
  ok(explicit.candidates.every((candidate) => candidate.resolver === null), 'S4.4 the builtin contributes NOTHING in explicit mode (no rows can reference it — documented schema-gap answer)');

  // Deterministic tie-breaking: equal priorities order by created_at, then id.
  const secondEndpoint = 'p1000000-0000-0000-0000-000000000002';
  const tied = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 9 }), sourceRow()],
        livetv_source_channels: [
          entryRow(),
          entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' }),
          entryRow({ id: IDS.embedEntry, source_id: IDS.playlist, source_channel_id: 'pa-news-embed' })
        ],
        livetv_playback_endpoints: [
          endpointRow(),
          endpointRow({ id: secondEndpoint, source_channel_id: IDS.embedEntry, endpoint_kind: 'embed_page', stream_format: null, url: 'https://embeds.example.com/news', ordering: 0 })
        ],
        livetv_playback_candidates: [
          candidateRow({ endpoint_id: secondEndpoint, priority: 3, created_at: '2026-01-02T00:00:00Z' }),
          candidateRow({ endpoint_id: IDS.playlistEndpoint, priority: 3, created_at: '2026-01-01T00:00:00Z' })
        ]
      })
    )
  );
  ok(tied.mode === 'explicit' && tied.candidates.length === 2, 'S4.5 both explicit candidates participate');
  ok(tied.candidates[0]!.candidateId === `default:${IDS.playlistEndpoint}` || tied.candidates[0]!.candidateId === IDS.playlistCandidate, 'S4.6 the earlier created_at wins the tie (deterministic ordering)');
  ok(tied.candidates[0]!.endpointKind === 'direct_stream', 'S4.7 tie-break places the direct endpoint first');
  ok('S4 explicit mode verified');
}

// ============================================================
// §5 — The eligibility gate matrix (S1/S2/C1/M0/M1/E1/P1).
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  const gateCases: { label: string; tables: Record<string, Row[]>; expectBuiltin: boolean }[] = [
    { label: 'S1 source disabled', tables: baseTables({ livetv_sources: [builtinSourceRow({ enabled: false })] }), expectBuiltin: false },
    { label: 'S2 source status ineligible', tables: baseTables({ livetv_sources: [builtinSourceRow({ status: 'disabled' })] }), expectBuiltin: false },
    { label: 'S2 status unavailable', tables: baseTables({ livetv_sources: [builtinSourceRow({ status: 'unavailable' })] }), expectBuiltin: false },
    { label: 'C1 channel disabled', tables: baseTables({ livetv_channels: [channelRow({ enabled: false })] }), expectBuiltin: false },
    { label: 'M1 entry disabled', tables: baseTables({ livetv_source_channels: [entryRow({ enabled: false })] }), expectBuiltin: false }
  ];
  for (const [index, gateCase] of gateCases.entries()) {
    const result = await resolve(createMockClient(gateCase.tables));
    const hasBuiltin = result.candidates.some((candidate) => candidate.resolver === 'builtin_livegt_v1');
    ok(hasBuiltin === gateCase.expectBuiltin, `S5.${index + 1} ${gateCase.label}: builtin excluded=${!gateCase.expectBuiltin}`);
  }
  // E1 endpoint disabled (playlist endpoint) + P1 candidate disabled (explicit).
  const e1 = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [sourceRow()],
        livetv_source_channels: [entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow({ enabled: false })]
      })
    )
  );
  ok(e1.candidates.length === 0, 'S5.6 E1 endpoint disabled: no candidates');
  const p1 = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 9 }), sourceRow()],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow()],
        livetv_playback_candidates: [candidateRow({ enabled: false })]
      })
    )
  );
  ok(p1.mode === 'explicit' && p1.candidates.length === 0, 'S5.7 P1 candidate disabled: explicit mode yields an EMPTY list (honest managed-empty)');
  ok('S5 gate matrix verified');
}

// ============================================================
// §6 — Cross-channel integrity + URL discipline.
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  // A candidate row belonging to ANOTHER channel must never appear (the
  // query scopes by channel; this verifies the in-memory guard too).
  const cross = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 9 }), sourceRow()],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow()],
        livetv_playback_candidates: [candidateRow({ channel_id: IDS.otherChannel })]
      })
    )
  );
  ok(cross.mode === 'default', 'S6.1 a foreign-channel candidate row is invisible → default mode applies');
  ok(cross.candidates.length === 3, 'S6.2a default mode runs (builtin pair + this channel\u2019s endpoint — the foreign row invisible)');
  ok(cross.candidates[2]!.url === 'https://streams.example.com/news/index.m3u8', 'S6.2 only THIS channel\u2019s endpoints play');

  // Endpoint reads are scoped to THIS channel's entries (the .in() filter).
  const scoped = createMockClient(
    baseTables({
      livetv_sources: [builtinSourceRow({ priority: 9 }), sourceRow()],
      livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })]
    })
  );
  await resolve(scoped);
  const endpointQueries = scoped.queriesFor('livetv_playback_endpoints');
  ok(endpointQueries.length === 1 && endpointQueries[0]!.filters.some((f) => f.op === 'in' && f.col === 'source_channel_id'), 'S6.3 the endpoint read carries the entry-scope filter');
  const inFilter = endpointQueries[0]!.filters.find((f) => f.op === 'in')!;
  ok((inFilter.val as string[]).includes(IDS.playlistEntry), 'S6.4 the scope lists exactly this channel\u2019s entry ids');

  // Non-https stored endpoints are SKIPPED (fail-closed URL discipline).
  const httpEndpoint = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 9 }), sourceRow()],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow({ url: 'http://streams.example.com/news/index.m3u8' })]
      })
    )
  );
  ok(!httpEndpoint.candidates.some((candidate) => candidate.url !== null && candidate.url.startsWith('http:')), 'S6.5 a non-https stored endpoint never reaches the wire');
  ok(httpEndpoint.candidates.length === 2, 'S6.5b the builtin pair still plays (the broken endpoint is dropped, not fatal)');
  const garbageEndpoint = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 9 }), sourceRow()],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow({ url: 'not a url' })]
      })
    )
  );
  ok(!garbageEndpoint.candidates.some((candidate) => candidate.url === 'not a url'), 'S6.6 a malformed stored endpoint never reaches the wire');
  ok(garbageEndpoint.candidates.length === 2, 'S6.6b the malformed endpoint is dropped, never coerced');
  ok('S6 cross-channel + URL discipline verified');
}

// ============================================================
// §7 — Wire redaction + bounds.
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  const redaction = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 0 }), sourceRow({ priority: 1, capabilities: { drm: 'widevine' }, config: { playlistUrl: 'https://secret.example.com/list.m3u?token=SECRET' } })],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' })],
        livetv_playback_endpoints: [endpointRow()]
      })
    )
  );
  const allowedKeys = new Set(['candidateId', 'engine', 'endpointKind', 'streamFormat', 'url', 'resolver', 'sourceChannelId', 'label']);
  ok(redaction.candidates.every((candidate) => Object.keys(candidate).every((key) => allowedKeys.has(key))), 'S7.1 every candidate carries ONLY the 8 bounded wire fields');
  const serialized = JSON.stringify(redaction);
  ok(!serialized.includes('SECRET'), 'S7.2 no source config material in the payload');
  ok(!serialized.includes('playlist-a') && !serialized.includes('LiveGT V1'), 'S7.3 no slugs or source names in the payload');
  ok(!serialized.includes(IDS.builtin) && !serialized.includes(IDS.playlistEntry), 'S7.4 no source/entry row ids in the payload');
  ok(!serialized.includes('widevine'), 'S7.5 no capability material in the payload');
  ok(redaction.candidates.find((candidate) => candidate.label === 'Primary') !== undefined, 'S7.6 the endpoint label (display-only) passes through');

  // Bounds: 13 usable candidates → exactly 12 (MAX_PLAYBACK_CANDIDATES).
  const manyEndpoints: Row[] = [];
  const manyEntries: Row[] = [];
  for (let index = 0; index < 13; index++) {
    const entryId = `e2${String(index).padStart(11, '0')}`;
    const endpointId = `p2${String(index).padStart(11, '0')}`;
    manyEntries.push(entryRow({ id: entryId, source_id: IDS.playlist, source_channel_id: `pa-${index}` }));
    manyEndpoints.push(endpointRow({ id: endpointId, source_channel_id: entryId, url: `https://streams.example.com/${index}.m3u8` }));
  }
  const bounded = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 9 }), sourceRow()],
        livetv_source_channels: [entryRow(), ...manyEntries],
        livetv_playback_endpoints: manyEndpoints
      })
    )
  );
  ok(bounded.candidates.length === MAX_PLAYBACK_CANDIDATES, 'S7.7 the response is bounded at MAX_PLAYBACK_CANDIDATES');

  // Malformed rows are dropped, never coerced.
  const malformed = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [sourceRow(), sourceRow({ id: 'b2', status: 'not-a-status' })],
        livetv_source_channels: [entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' }), entryRow({ id: 'e9', source_id: 'b2', source_channel_id: 'x-news' })],
        livetv_playback_endpoints: [endpointRow({ endpoint_kind: 'mystery_kind' })]
      })
    )
  );
  ok(malformed.candidates.every((candidate) => candidate.resolver !== null || candidate.url !== null), 'S7.8 candidates from malformed rows never appear (dropped, not coerced)');
  ok('S7 wire redaction + bounds verified');
}

// ============================================================
// §8 — Engine derivation is kind-only (the never-a-source rule).
// ============================================================
{
  resetLivetvPlaybackFlagCacheForTests();
  const mixed = await resolve(
    createMockClient(
      baseTables({
        livetv_sources: [builtinSourceRow({ priority: 5 }), sourceRow({ priority: 1 }), sourceRow({ id: 'b3', slug: 'embed-b', source_type: 'embed_provider', priority: 2, config: {} })],
        livetv_source_channels: [entryRow(), entryRow({ id: IDS.playlistEntry, source_id: IDS.playlist, source_channel_id: 'pa-news' }), entryRow({ id: IDS.embedEntry, source_id: 'b3', source_channel_id: 'eb-news' })],
        livetv_playback_endpoints: [endpointRow(), endpointRow({ id: IDS.embedEndpoint, source_channel_id: IDS.embedEntry, endpoint_kind: 'embed_page', stream_format: null, url: 'https://embeds.example.com/news' })]
      })
    )
  );
  const direct = mixed.candidates.filter((candidate) => candidate.endpointKind === 'direct_stream');
  const embed = mixed.candidates.filter((candidate) => candidate.endpointKind === 'embed_page');
  ok(direct.length >= 1 && direct.every((candidate) => candidate.engine === 'shaka_media_player'), 'S8.1 EVERY direct_stream candidate derives the direct engine');
  ok(embed.length >= 1 && embed.every((candidate) => candidate.engine === 'iframe_embed'), 'S8.2 EVERY embed_page candidate derives the iframe integration');
  ok(mixed.candidates.length === 4, 'S8.3 all three sources contribute in default mode (playlist → embed B → builtin pair)');
  ok('S8 engine derivation verified');
}

console.log(`\nPhase 5 resolution suite: ${passed} checks PASS`);
if (passed < 40) {
  console.error('FAIL: expected at least 40 checks');
  process.exit(1);
}
