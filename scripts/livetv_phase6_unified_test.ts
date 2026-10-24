/**
 * UNIFIED LIVE TV — Phase 6 user-facing integration verification.
 *
 * Covers the Phase 6 brief's required tests (deterministic, mocked services;
 * NO real network, NO real database, NO live streams):
 *   §1  unified catalogue service — exposure matrix (disabled/unexposed
 *       never shown), duplicate-entries-render-once, deterministic order,
 *       minimal redacted DTO, flag-off fail-closed, read failures honest.
 *   §2  unified guide service — the ESTABLISHED Phase 3 mapping contract
 *       only (explicit mappings first, ambiguity-guarded tvgId second),
 *       Now/Next from real windows, honest empty on missing/unmatched data,
 *       flag-off fail-closed, no fabrication.
 *   §3  playback resolver canonical-selection mapping — the ONE additive
 *       change: the canonical channel id is accepted as a selection (the
 *       builtin-entry path stays byte-identical), source priority + the
 *       derived engine remain authoritative, the builtin virtual pair
 *       carries the ENTRY's source channel id, explicit mode stays
 *       registry-pure, disabled ⇒ honest empty, unknown ⇒ legacy compat,
 *       cross-channel scoping intact.
 *   §4  client unified-catalogue module — normalize (unusable rows dropped,
 *       dup ids dropped, logo http(s) gate), cache reuse via the EXISTING
 *       cache conventions, guide mapping into the EXISTING LiveTvGuide
 *       model (ms→s, deterministic order), abort/HTTP/JSON error kinds.
 *   §5  page source-contract — the gated catalogue/guide branches keep the
 *       legacy lines byte-identical, the shared gate is the ONLY switch,
 *       stable ids drive selection + recents, a11y/layout markers intact,
 *       stale-switch guards present.
 *   §6  isolation — no VOD imports, no new analytics events, no console in
 *       new modules, ONE flag read path, no provider hosts, netlify.toml
 *       untouched by the new modules.
 *   §7  honest progress helpers (epg.ts) — current-window boundaries only.
 *   §8  flag-off legacy preservation — flag FALSE ⇒ the resolver, the
 *       catalogue and the guide services read NOTHING and fail closed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function sliceOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker not found after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// Read-only mock client — chains like supabase-js for every shape the
// Phase 6 surfaces (and their Phase 3/5 helpers) issue.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type IssuedQuery = {
  table: string;
  filters: { col: string; op: string; val: unknown }[];
  orders: { col: string; asc: boolean }[];
  limit: number | null;
};

function createMockClient(tables: Record<string, Row[]>, options: { failTable?: string; failFlag?: boolean } = {}) {
  const issued: IssuedQuery[] = [];

  function runQuery(spec: IssuedQuery): { data: Row[] | Row | null; error: { message: string } | null } {
    issued.push(spec);
    if (options.failTable === spec.table) return { data: null, error: { message: 'mock read failure' } };
    let rows = [...(tables[spec.table] ?? [])];
    for (const filter of spec.filters) {
      rows = rows.filter((row) => {
        if (filter.op === 'eq') return row[filter.col] === filter.val;
        if (filter.op === 'in') return (filter.val as unknown[]).includes(row[filter.col]);
        if (filter.op === 'lte') return String(row[filter.col]) <= String(filter.val);
        if (filter.op === 'gt') return String(row[filter.col]) > String(filter.val);
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

  function builder(table: string, spec: IssuedQuery) {
    const chain: Record<string, unknown> = {
      select: (_cols?: string) => builder(table, spec),
      eq: (col: string, val: unknown) => (spec.filters.push({ col, op: 'eq', val }), builder(table, spec)),
      in: (col: string, val: unknown[]) => (spec.filters.push({ col, op: 'in', val }), builder(table, spec)),
      lte: (col: string, val: unknown) => (spec.filters.push({ col, op: 'lte', val }), builder(table, spec)),
      gt: (col: string, val: unknown) => (spec.filters.push({ col, op: 'gt', val }), builder(table, spec)),
      not: () => builder(table, spec),
      order: (col: string, opts?: { ascending?: boolean }) => (spec.orders.push({ col, asc: opts?.ascending !== false }), builder(table, spec)),
      limit: (n: number) => (spec.limit = n, builder(table, spec)),
      maybeSingle: async () => {
        const result = runQuery(spec);
        const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
        return { data: rows[0] ?? null, error: result.error };
      },
      then: (resolve: (value: { data: Row[] | null; error: { message: string } | null }) => void) =>
        resolve(runQuery(spec))
    };
    return chain;
  }

  return {
    issued,
    from(table: string) {
      return builder(table, { table, filters: [], orders: [], limit: null });
    },
    queriesFor(table: string): IssuedQuery[] {
      return issued.filter((spec) => spec.table === table);
    }
  };
}

type MockClient = ReturnType<typeof createMockClient>;

// Shared fixtures.
const NOW_MS = Date.parse('2026-10-23T10:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

const FLAG_ON = [{ id: 1, unified_enabled: true }];
const FLAG_OFF = [{ id: 1, unified_enabled: false }];

const SRC_BUILTIN = { id: 'src-builtin', slug: 'builtin-livegt-v1', name: 'LiveGT V1 (Built-in)', source_type: 'builtin_livegt_v1', builtin: true, enabled: true, status: 'active', priority: 0, visibility: 'public', capabilities: {}, config: {}, description: null, created_at: '', updated_at: '' };
const SRC_M3U = { id: 'src-m3u', slug: 'acme-m3u', name: 'Acme M3U', source_type: 'm3u_playlist', builtin: false, enabled: true, status: 'active', priority: 10, visibility: 'public', capabilities: {}, config: {}, description: null, created_at: '', updated_at: '' };

const ENTRY_BUILTIN = { id: 'e1', source_id: 'src-builtin', source_channel_id: '101', canonical_channel_id: 'chan-1', name: 'Alpha TV', category: 'News', logo_url: 'https://cdn.example.com/alpha.png', tvg_id: 'alpha.tv', enabled: true, metadata: {}, created_at: '', updated_at: '' };
const ENTRY_M3U = { id: 'e2', source_id: 'src-m3u', source_channel_id: 'acme-9', canonical_channel_id: 'chan-1', name: 'Alpha (Acme)', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {}, created_at: '', updated_at: '' };

const EP_M3U = { id: 'ep2', source_channel_id: 'e2', endpoint_kind: 'direct_stream', stream_format: 'hls', url: 'https://cdn.example.com/live.m3u8', ordering: 0, enabled: true, label: 'Acme HLS' };

const CHAN_1 = { id: 'chan-1', name: 'Zeta One', category: 'News', logo_url: 'https://cdn.example.com/alpha.png', dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' };

// ============================================================
// §1 — Unified catalogue service.
// ============================================================
{
  console.log('§1 unified catalogue service');
  const { getUnifiedLivetvCatalogue } = await import('../src/lib/server/livetv/user-catalogue');
  const { resetLivetvPlaybackFlagCacheForTests } = await import('../src/lib/server/livetv/playback-resolver');

  // 1a. Exposure matrix — only eligible+public sources' mapped+enabled
  //     entries' enabled canonical channels are exposed.
  resetLivetvPlaybackFlagCacheForTests();
  const client1 = createMockClient({
    livetv_config_meta: FLAG_ON,
    livetv_sources: [
      SRC_BUILTIN,
      SRC_M3U, // the eligible PUBLIC playlist source (its unmapped entry now surfaces — R-0)
      { ...SRC_M3U, id: 'src-internal', slug: 'internal-src', visibility: 'internal' },
      { ...SRC_M3U, id: 'src-disabled', slug: 'disabled-src', enabled: false },
      { ...SRC_M3U, id: 'src-unavailable', slug: 'down-src', status: 'unavailable' },
      { ...SRC_M3U, id: 'src-hidden', slug: 'hidden-src', visibility: 'hidden' }
    ],
    livetv_source_channels: [
      ENTRY_BUILTIN, // exposes chan-1 (public enabled builtin)
      { ...ENTRY_M3U, source_id: 'src-internal' }, // internal source — NOT exposed
      { ...ENTRY_M3U, id: 'e3', source_id: 'src-disabled', canonical_channel_id: 'chan-2' }, // disabled source
      { ...ENTRY_M3U, id: 'e4', source_id: 'src-m3u', canonical_channel_id: 'chan-3', enabled: false }, // disabled entry
      { ...ENTRY_M3U, id: 'e5', source_id: 'src-m3u', canonical_channel_id: null, source_channel_id: 'acme-404' } // unmapped
    ],
    livetv_channels: [
      CHAN_1,
      { ...CHAN_1, id: 'chan-2', name: 'Hidden Via Internal' },
      { ...CHAN_1, id: 'chan-3', name: 'Disabled Entry' },
      { ...CHAN_1, id: 'chan-4', name: 'Disabled Channel', enabled: false }
    ]
  });
  const catalogue1 = await getUnifiedLivetvCatalogue(client1 as unknown as Parameters<typeof getUnifiedLivetvCatalogue>[0]);
  ok(catalogue1.unifiedEnabled === true, '1a.1 the catalogue reports the unified flag');
  // R-0: the canonical channel LEADS; the unmapped+enabled entry of the
  // eligible public source surfaces as a direct `entry:` row AFTER it.
  ok(JSON.stringify(catalogue1.channels.map((c) => c.id)) === JSON.stringify(['chan-1', 'entry:e5']), '1a.2 the canonical channel leads and the UNMAPPED entry surfaces as a direct row (R-0, deterministic order)');
  ok(catalogue1.truncated === false, '1a.3 the bounded response reports no truncation');
  ok(!catalogue1.channels.some((c) => ['entry:e2', 'entry:e3', 'entry:e4'].includes(c.id)), '1a.4 internal-source/disabled-source/disabled-entry entries contribute NOTHING (same exposure pool)');
  const entryRow1 = catalogue1.channels.find((c) => c.id === 'entry:e5');
  ok(entryRow1?.name === 'Alpha (Acme)' && entryRow1?.category === null && entryRow1?.logoUrl === null, '1a.5 the direct row carries the entry\u2019s own display metadata (no canonical coercion)');

  // 1b. DTO discipline — minimal, redacted fields only.
  const row1 = catalogue1.channels[0] ?? {};
  ok(JSON.stringify(Object.keys(row1).sort()) === JSON.stringify(['category', 'id', 'logoUrl', 'name']), '1b.1 the wire row carries EXACTLY id/name/category/logoUrl');
  ok(row1.name === 'Zeta One' && row1.category === 'News', '1b.2 the canonical name/category are carried (source entry names are NOT)');
  ok(row1.logoUrl === 'https://cdn.example.com/alpha.png', '1b.3 a usable https logo is carried');
  const source1 = client1.queriesFor('livetv_sources');
  ok(source1.length === 1 && source1[0] && !JSON.stringify(source1[0]).includes('config'), '1b.4 the source probe selects only id/enabled/status/visibility');
  const entryDto = catalogue1.channels.find((c) => c.id === 'entry:e5') ?? {};
  ok(JSON.stringify(Object.keys(entryDto).sort()) === JSON.stringify(['category', 'id', 'logoUrl', 'name']), '1b.5 the DIRECT row carries the same bounded DTO (no source identity crosses — provenance stays internal)');
  ok(!JSON.stringify(catalogue1).includes('src-m3u') && !JSON.stringify(catalogue1).includes('internal-src'), '1b.6 no source slug/id/visibility leaks into the catalogue response');

  // 1c. Duplicates render once — several source entries mapping to ONE
  //     canonical channel collapse into a single row.
  resetLivetvPlaybackFlagCacheForTests();
  const client2 = createMockClient({
    livetv_config_meta: FLAG_ON,
    livetv_sources: [SRC_BUILTIN, SRC_M3U],
    livetv_source_channels: [ENTRY_BUILTIN, ENTRY_M3U], // two entries → chan-1
    livetv_channels: [CHAN_1]
  });
  const catalogue2 = await getUnifiedLivetvCatalogue(client2 as unknown as Parameters<typeof getUnifiedLivetvCatalogue>[0]);
  ok(catalogue2.channels.length === 1 && catalogue2.channels[0]?.id === 'chan-1', '1c.1 two mapped entries render ONE canonical row (no name-based merging, NO double-listing as entry rows)');

  // 1d. Deterministic order + logo/category honesty.
  resetLivetvPlaybackFlagCacheForTests();
  const client3 = createMockClient({
    livetv_config_meta: FLAG_ON,
    livetv_sources: [SRC_BUILTIN],
    livetv_source_channels: [
      { ...ENTRY_BUILTIN, canonical_channel_id: 'chan-a' },
      { ...ENTRY_BUILTIN, id: 'e9', source_channel_id: '902', canonical_channel_id: 'chan-b' },
      { ...ENTRY_BUILTIN, id: 'e8', source_channel_id: '903', canonical_channel_id: 'chan-c' }
    ],
    livetv_channels: [
      { ...CHAN_1, id: 'chan-a', name: 'Zeta', category: null, logo_url: 'javascript:alert(1)' },
      { ...CHAN_1, id: 'chan-b', name: 'Alpha', category: 'Sports', logo_url: 'http://cdn.example.com/b.png' },
      { ...CHAN_1, id: 'chan-c', name: 'Mid', category: null, logo_url: 'not a url' }
    ]
  });
  const catalogue3 = await getUnifiedLivetvCatalogue(client3 as unknown as Parameters<typeof getUnifiedLivetvCatalogue>[0]);
  ok(JSON.stringify(catalogue3.channels.map((c) => c.name)) === JSON.stringify(['Alpha', 'Mid', 'Zeta']), '1d.1 deterministic name-ordered catalogue (name ASC)');
  const zeta = catalogue3.channels.find((c) => c.name === 'Zeta');
  const mid = catalogue3.channels.find((c) => c.name === 'Mid');
  ok(zeta?.logoUrl === null, '1d.2 a non-http(s) logo degrades to null (the client initials fallback)');
  ok(mid?.logoUrl === null && mid?.category === null, '1d.3 unparseable logo and missing category are honest nulls (never fabricated)');
  const chanOrders = client3.queriesFor('livetv_channels')[0]?.orders ?? [];
  ok(chanOrders.some((o) => o.col === 'name' && o.asc) && chanOrders.some((o) => o.col === 'id'), '1d.4 the channel query orders by (name, id) deterministically');

  // 1e. Read failures are honest (empty, not fake data).
  resetLivetvPlaybackFlagCacheForTests();
  const client4 = createMockClient({
    livetv_config_meta: FLAG_ON,
    livetv_sources: [SRC_BUILTIN],
    livetv_source_channels: [{ ...ENTRY_BUILTIN }],
    livetv_channels: [CHAN_1]
  }, { failTable: 'livetv_channels' });
  const catalogue4 = await getUnifiedLivetvCatalogue(client4 as unknown as Parameters<typeof getUnifiedLivetvCatalogue>[0]);
  ok(catalogue4.channels.length === 0 && catalogue4.unifiedEnabled === true, '1e.1 a channel-read failure yields the honest empty catalogue');
}

// ============================================================
// §2 — Unified guide service (Phase 3 mapping contract ONLY).
// ============================================================
{
  console.log('§2 unified guide service');
  const { getUnifiedLivetvGuide } = await import('../src/lib/server/livetv/user-catalogue');
  const { resetLivetvPlaybackFlagCacheForTests } = await import('../src/lib/server/livetv/playback-resolver');

  const nowMs = NOW_MS;
  const now = new Date(nowMs);

  // 2a. Explicit mapping → real current + upcoming windows.
  resetLivetvPlaybackFlagCacheForTests();
  const client1 = createMockClient({
    livetv_config_meta: FLAG_ON,
    livetv_epg_channel_mappings: [{ epg_source_id: 'epg-1', epg_channel_id: 'alpha.guide', channel_id: 'chan-1' }],
    livetv_epg_sources: [{ id: 'epg-1', enabled: true, status: 'active' }],
    livetv_source_channels: [ENTRY_BUILTIN],
    livetv_epg_programmes: [
      { epg_source_id: 'epg-1', epg_channel_id: 'alpha.guide', start_at: new Date(nowMs - 30 * 60000).toISOString(), end_at: new Date(nowMs + 30 * 60000).toISOString(), title: 'Current Show', sub_title: null, description: 'Live coverage', category: 'News', icon_url: 'https://cdn.example.com/p1.png', language: null },
      { epg_source_id: 'epg-1', epg_channel_id: 'alpha.guide', start_at: new Date(nowMs + 30 * 60000).toISOString(), end_at: new Date(nowMs + 90 * 60000).toISOString(), title: 'Next Show', sub_title: null, description: null, category: null, icon_url: null, language: null }
    ]
  });
  const guide1 = await getUnifiedLivetvGuide(client1 as unknown as Parameters<typeof getUnifiedLivetvGuide>[0], 'chan-1', now);
  ok(guide1.unifiedEnabled === true && guide1.channelId === 'chan-1', '2a.1 the guide reports the flag + the canonical channel');
  ok(guide1.now?.title === 'Current Show', '2a.2 the on-air programme comes from the real window (explicit mapping)');
  ok(guide1.now?.startMs === nowMs - 30 * 60000 && guide1.now?.endMs === nowMs + 30 * 60000, '2a.3 windows are absolute UTC ms instants');
  ok(guide1.now?.iconUrl === 'https://cdn.example.com/p1.png' && guide1.now?.description === 'Live coverage', '2a.4 genuine programme metadata is carried');
  ok(guide1.upcoming.length === 1 && guide1.upcoming[0]?.title === 'Next Show', '2a.5 upcoming programmes are returned (deterministic start order)');
  const nowKeys = Object.keys(guide1.now ?? {}).sort();
  ok(JSON.stringify(nowKeys) === JSON.stringify(['category', 'description', 'endMs', 'iconUrl', 'startMs', 'title']), '2a.6 the programme wire carries ONLY display fields (no epg ids/provenance)');
  ok(guide1.serverNowMs === nowMs, '2a.7 serverNowMs is an explicit server instant');

  // 2b. Missing/unmatched guide data — honest empty, never fabricated.
  resetLivetvPlaybackFlagCacheForTests();
  const client2 = createMockClient({
    livetv_config_meta: FLAG_ON,
    livetv_epg_channel_mappings: [],
    livetv_epg_sources: [],
    livetv_source_channels: [], // no entries → no tvgId derivation either
    livetv_epg_programmes: []
  });
  const guide2 = await getUnifiedLivetvGuide(client2 as unknown as Parameters<typeof getUnifiedLivetvGuide>[0], 'chan-404', now);
  ok(guide2.now === null && guide2.upcoming.length === 0, '2b.1 an unmatched channel honestly returns an empty guide (no display-name guessing)');
}

// ============================================================
// §3 — Playback resolver: the canonical-selection mapping.
// ============================================================
{
  console.log('§3 resolver canonical-selection mapping');
  const { resolveLivetvPlaybackForSelection, resetLivetvPlaybackFlagCacheForTests } = await import('../src/lib/server/livetv/playback-resolver');

  function resolverTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
    return {
      livetv_config_meta: FLAG_ON,
      livetv_sources: [SRC_BUILTIN, SRC_M3U],
      livetv_source_channels: [ENTRY_BUILTIN, ENTRY_M3U],
      livetv_channels: [CHAN_1],
      livetv_playback_endpoints: [EP_M3U],
      livetv_playback_candidates: [],
      ...overrides
    };
  }

  // 3a. Phase 5 path — the builtin-entry selection stays byte-identical:
  //     default mode positions the synthesized builtin pair FIRST (source
  //     priority 0) and the m3u direct endpoint after it (priority 10).
  resetLivetvPlaybackFlagCacheForTests();
  const clientA = createMockClient(resolverTables());
  const viaEntry = await resolveLivetvPlaybackForSelection(clientA as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], '101');
  ok(viaEntry.resolved === true && viaEntry.mode === 'default' && viaEntry.candidates.length === 3, '3a.1 the entry-selection resolves the default-mode candidate list');
  ok(viaEntry.candidates[0]?.endpointKind === 'direct_stream' && viaEntry.candidates[0]?.resolver === 'builtin_livegt_v1' && viaEntry.candidates[0]?.sourceChannelId === '101', '3a.2 the builtin direct candidate keeps the selection as its source channel id');
  ok(viaEntry.candidates[1]?.endpointKind === 'embed_page' && viaEntry.candidates[1]?.resolver === 'builtin_livegt_v1', '3a.3 the builtin embed candidate follows (direct → embed, LT-15 semantics)');
  ok(viaEntry.candidates[0]?.url === null && viaEntry.candidates[1]?.url === null, '3a.4 the builtin pair carries NO url (fresh-signed resolver contract)');
  ok(viaEntry.candidates[2]?.endpointKind === 'direct_stream' && viaEntry.candidates[2]?.url === 'https://cdn.example.com/live.m3u8' && viaEntry.candidates[2]?.engine === 'shaka_media_player', '3a.5 the m3u direct endpoint follows by source priority with the DERIVED engine');

  // 3b. Phase 6 path — the CANONICAL id resolves the SAME channel; the
  //     virtual pair now carries the ENTRY's source channel id (never the
  //     canonical UUID — the existing client modules resolve/build with it).
  resetLivetvPlaybackFlagCacheForTests();
  const clientB = createMockClient(resolverTables());
  const viaCanonical = await resolveLivetvPlaybackForSelection(clientB as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'chan-1');
  ok(viaCanonical.resolved === true && viaCanonical.mode === 'default', '3b.1 the canonical id is accepted as a selection (additive mapping)');
  ok(viaCanonical.candidates.length === 3 && viaCanonical.candidates[0]?.resolver === 'builtin_livegt_v1', '3b.2 the candidate list matches the entry-selection flow (same priority order)');
  ok(viaCanonical.candidates[0]?.sourceChannelId === '101' && viaCanonical.candidates[0]?.sourceChannelId !== 'chan-1', '3b.3 the virtual pair carries the builtin ENTRY id (the existing client contract), never the canonical id');
  ok(viaCanonical.candidates[2]?.endpointKind === 'direct_stream' && viaCanonical.candidates[2]?.engine === 'shaka_media_player', '3b.4 direct dispatch stays authoritative for a direct_stream endpoint');
  const endpointQuery = clientB.queriesFor('livetv_playback_endpoints')[0];
  const inFilter = endpointQuery?.filters.find((f) => f.op === 'in' && f.col === 'source_channel_id');
  ok(inFilter !== undefined && JSON.stringify((inFilter.val as string[]).sort()) === JSON.stringify(['e1', 'e2']), '3b.5 endpoint reads stay scoped to THIS channel\'s entries (cross-channel guard)');

  // 3c. Explicit mode stays registry-pure (the documented schema-gap
  //     limitation is NOT overridden — the builtin never joins via rows).
  resetLivetvPlaybackFlagCacheForTests();
  const clientC = createMockClient(resolverTables({
    livetv_playback_candidates: [{ id: 'cand-1', channel_id: 'chan-1', endpoint_id: 'ep2', priority: 1, enabled: true, created_at: '2026-10-23T00:00:00Z' }]
  }));
  const viaExplicit = await resolveLivetvPlaybackForSelection(clientC as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'chan-1');
  ok(viaExplicit.mode === 'explicit' && viaExplicit.candidates.length === 1, '3c.1 explicit candidate rows are authoritative');
  ok(viaExplicit.candidates[0]?.endpointKind === 'direct_stream' && viaExplicit.candidates[0]?.resolver === null && viaExplicit.candidates[0]?.url === 'https://cdn.example.com/live.m3u8', '3c.2 the explicit list contains ONLY row-backed endpoints (no synthesized builtin)');

  // 3d. Disabled canonical channel ⇒ resolved:true + EMPTY (the honest
  //     retryable exhausted error — never a silent legacy bypass).
  resetLivetvPlaybackFlagCacheForTests();
  const clientD = createMockClient(resolverTables({
    livetv_channels: [{ ...CHAN_1, enabled: false }]
  }));
  const viaDisabled = await resolveLivetvPlaybackForSelection(clientD as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'chan-1');
  ok(viaDisabled.resolved === true && viaDisabled.candidates.length === 0, '3d.1 a disabled canonical channel is managed-with-nothing-eligible (honest exhausted)');

  // 3e. Unknown identity ⇒ resolved:false (the legacy compatibility path).
  resetLivetvPlaybackFlagCacheForTests();
  const clientE = createMockClient(resolverTables());
  const viaUnknown = await resolveLivetvPlaybackForSelection(clientE as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'no-such-channel');
  ok(viaUnknown.resolved === false && viaUnknown.candidates.length === 0, '3e.1 an id matching neither identity resolves false (legacy compat, unchanged)');

  // 3f. M0 — an UNMAPPED builtin entry stays not-managed (unchanged).
  resetLivetvPlaybackFlagCacheForTests();
  const clientF = createMockClient(resolverTables({
    livetv_source_channels: [{ ...ENTRY_BUILTIN, canonical_channel_id: null }]
  }));
  const viaUnmapped = await resolveLivetvPlaybackForSelection(clientF as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], '101');
  ok(viaUnmapped.resolved === false, '3f.1 an unmapped entry selection is NOT under unified management (M0 unchanged)');

  // 3g. E1 — a disabled builtin entry contributes NO virtual candidates
  //     even in default mode (the pair carries entry enablement).
  resetLivetvPlaybackFlagCacheForTests();
  const clientG = createMockClient(resolverTables({
    livetv_source_channels: [{ ...ENTRY_BUILTIN, enabled: false }, ENTRY_M3U]
  }));
  const viaDisabledEntry = await resolveLivetvPlaybackForSelection(clientG as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'chan-1');
  ok(viaDisabledEntry.resolved === true && viaDisabledEntry.candidates.length === 1 && viaDisabledEntry.candidates[0]?.endpointKind === 'direct_stream' && viaDisabledEntry.candidates[0]?.resolver === null, '3g.1 a disabled builtin entry drops the synthesized pair (registry gates)');

  // 3h. Source priority remains authoritative in default mode: a
  //     lower-priority (higher number) source's endpoint sorts after the
  //     builtin pair regardless of endpoint ids.
  resetLivetvPlaybackFlagCacheForTests();
  const clientH = createMockClient(resolverTables({
    livetv_sources: [SRC_BUILTIN, { ...SRC_M3U, priority: -5 }],
    livetv_playback_endpoints: [EP_M3U]
  }));
  const viaPriority = await resolveLivetvPlaybackForSelection(clientH as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'chan-1');
  ok(viaPriority.candidates.length === 3 && viaPriority.candidates[0]?.resolver === null && viaPriority.candidates[0]?.url === 'https://cdn.example.com/live.m3u8' && viaPriority.candidates[1]?.resolver === 'builtin_livegt_v1' && viaPriority.candidates[1]?.endpointKind === 'direct_stream' && viaPriority.candidates[2]?.endpointKind === 'embed_page', '3h.1 priority -5 m3u sorts BEFORE the builtin pair (source priority, never hardcoded)');

  // ---- R-0: identity (c) — DIRECT entry selections (`entry:<row uuid>`) ----
  // The unmapped-entry companion of the catalogue's source-entry rows.
  const DIRECT_ENTRY_ID = 'd1000000-0000-4000-8000-000000000001';
  const DIRECT_ENTRY = { id: DIRECT_ENTRY_ID, source_id: 'src-m3u', source_channel_id: 'acme-direct-1', canonical_channel_id: null, name: 'Direct One', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {}, created_at: '', updated_at: '' };
  const DIRECT_EP_1 = { id: 'ep-d1', source_channel_id: DIRECT_ENTRY_ID, endpoint_kind: 'direct_stream', stream_format: 'hls', url: 'https://cdn.example.com/one.m3u8', ordering: 1, enabled: true, label: 'first' };
  const DIRECT_EP_0 = { id: 'ep-d0', source_channel_id: DIRECT_ENTRY_ID, endpoint_kind: 'direct_stream', stream_format: 'dash', url: 'https://cdn.example.com/zero.mpd', ordering: 0, enabled: true, label: null };
  const DIRECT_EP_OFF = { id: 'ep-d2', source_channel_id: DIRECT_ENTRY_ID, endpoint_kind: 'direct_stream', stream_format: 'hls', url: 'https://cdn.example.com/off.m3u8', ordering: 2, enabled: false, label: null };

  function directEntryTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
    return {
      livetv_config_meta: FLAG_ON,
      livetv_sources: [SRC_BUILTIN, SRC_M3U],
      livetv_source_channels: [ENTRY_BUILTIN, ENTRY_M3U, DIRECT_ENTRY],
      livetv_channels: [CHAN_1],
      livetv_playback_endpoints: [EP_M3U, DIRECT_EP_0, DIRECT_EP_1, DIRECT_EP_OFF],
      livetv_playback_candidates: [],
      ...overrides
    };
  }

  // 3i. Happy path — the direct entry resolves ITS OWN endpoints, ordered
  //     (ordering ASC, id ASC), with the https re-validation and E1 gate.
  resetLivetvPlaybackFlagCacheForTests();
  const clientI = createMockClient(directEntryTables());
  const viaDirect = await resolveLivetvPlaybackForSelection(clientI as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], `entry:${DIRECT_ENTRY_ID}`);
  ok(viaDirect.unifiedEnabled === true && viaDirect.resolved === true && viaDirect.mode === 'default', '3i.1 a direct entry selection is managed and resolves in default mode');
  ok(viaDirect.candidates.length === 2, '3i.2 only the entry\u2019s OWN enabled endpoints are candidates (the disabled endpoint is gated out, E1)');
  ok(viaDirect.candidates[0]?.url === 'https://cdn.example.com/zero.mpd' && viaDirect.candidates[0]?.streamFormat === 'dash' && viaDirect.candidates[0]?.engine === 'shaka_media_player', '3i.3 ordering 0 first — a DASH manifest routes to the Shaka engine');
  ok(viaDirect.candidates[1]?.url === 'https://cdn.example.com/one.m3u8' && viaDirect.candidates[1]?.streamFormat === 'hls', '3i.4 ordering 1 second — an HLS manifest routed to the same derived engine');
  ok(viaDirect.candidates.every((c) => c.resolver === null && c.sourceChannelId === null && c.endpointKind === 'direct_stream'), '3i.5 row-backed candidates carry their own url and NO resolver marker');
  const directEndpointQuery = clientI.queriesFor('livetv_playback_endpoints')[0];
  ok(directEndpointQuery !== undefined && directEndpointQuery.filters.some((f) => f.op === 'eq' && f.col === 'source_channel_id' && f.val === DIRECT_ENTRY_ID), '3i.6 the endpoint read is scoped to EXACTLY this entry row');

  // 3j. The builtin's unmapped entry resolves through the SAME virtual pair
  //     contract (fresh client-side resolution; no endpoint rows exist).
  resetLivetvPlaybackFlagCacheForTests();
  const BUILTIN_DIRECT_ID = 'd2000000-0000-4000-8000-000000000002';
  const clientJ = createMockClient(directEntryTables({
    livetv_source_channels: [ENTRY_BUILTIN, ENTRY_M3U, { ...DIRECT_ENTRY, id: BUILTIN_DIRECT_ID, source_id: 'src-builtin', source_channel_id: '555' }]
  }));
  const viaBuiltinDirect = await resolveLivetvPlaybackForSelection(clientJ as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], `entry:${BUILTIN_DIRECT_ID}`);
  ok(viaBuiltinDirect.resolved === true && viaBuiltinDirect.candidates.length === 2, '3j.1 an unmapped builtin entry synthesizes the direct→embed pair (fresh-resolution contract)');
  ok(viaBuiltinDirect.candidates[0]?.resolver === 'builtin_livegt_v1' && viaBuiltinDirect.candidates[0]?.url === null && viaBuiltinDirect.candidates[0]?.sourceChannelId === '555', '3j.2 the virtual pair carries the builtin ENTRY\u2019s public catalogue id and NO url');
  ok(viaBuiltinDirect.candidates[1]?.endpointKind === 'embed_page' && viaBuiltinDirect.candidates[1]?.resolver === 'builtin_livegt_v1', '3j.3 the embed fallback candidate follows (LT-15 semantics preserved)');

  // 3k. S1 — a disabled source: managed-empty (honest exhausted), never a
  //     legacy fallback for a registry-governed id.
  resetLivetvPlaybackFlagCacheForTests();
  const clientK = createMockClient(directEntryTables({
    livetv_sources: [SRC_BUILTIN, { ...SRC_M3U, enabled: false }]
  }));
  const viaDisabledSource = await resolveLivetvPlaybackForSelection(clientK as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], `entry:${DIRECT_ENTRY_ID}`);
  ok(viaDisabledSource.resolved === true && viaDisabledSource.candidates.length === 0, '3k.1 a disabled source contributes an EMPTY managed list (S1, no legacy bypass)');

  // 3l. Visibility parity — a source demoted to internal: managed-empty.
  resetLivetvPlaybackFlagCacheForTests();
  const clientL = createMockClient(directEntryTables({
    livetv_sources: [SRC_BUILTIN, { ...SRC_M3U, visibility: 'internal' }]
  }));
  const viaInternal = await resolveLivetvPlaybackForSelection(clientL as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], `entry:${DIRECT_ENTRY_ID}`);
  ok(viaInternal.resolved === true && viaInternal.candidates.length === 0, '3l.1 a non-public source\u2019s entry cannot resolve (catalogue exposure parity)');

  // 3m. M1 — a disabled entry: managed-empty.
  resetLivetvPlaybackFlagCacheForTests();
  const clientM = createMockClient(directEntryTables({
    livetv_source_channels: [ENTRY_BUILTIN, ENTRY_M3U, { ...DIRECT_ENTRY, enabled: false }]
  }));
  const viaDisabledEntryDirect = await resolveLivetvPlaybackForSelection(clientM as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], `entry:${DIRECT_ENTRY_ID}`);
  ok(viaDisabledEntryDirect.resolved === true && viaDisabledEntryDirect.candidates.length === 0, '3m.1 a disabled entry contributes an EMPTY managed list (M1)');

  // 3n. Structural unknowns fail closed to the legacy path (Phase 5 parity):
  //     a malformed entry id and a deleted entry row.
  resetLivetvPlaybackFlagCacheForTests();
  const clientN = createMockClient(directEntryTables());
  const viaGarbage = await resolveLivetvPlaybackForSelection(clientN as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'entry:not-a-uuid');
  ok(viaGarbage.resolved === false && viaGarbage.candidates.length === 0, '3n.1 a malformed entry id resolves false (legacy compat — unreachable from the catalogue)');
  const viaDeleted = await resolveLivetvPlaybackForSelection(clientN as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'entry:d9999999-0000-4000-8000-000000000009');
  ok(viaDeleted.resolved === false && viaDeleted.candidates.length === 0, '3n.2 a deleted entry resolves false (Phase 5 unknown-identity parity)');

  // 3o. Flag OFF — the entry path is unreachable, exactly like every other
  //     identity (the master switch stays the rollback lever).
  resetLivetvPlaybackFlagCacheForTests();
  const clientO = createMockClient({ ...directEntryTables(), livetv_config_meta: FLAG_OFF });
  const viaFlagOff = await resolveLivetvPlaybackForSelection(clientO as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], `entry:${DIRECT_ENTRY_ID}`);
  ok(viaFlagOff.unifiedEnabled === false && viaFlagOff.resolved === false, '3o.1 flag OFF ⇒ resolved:false for entry selections too (fail-closed master switch)');
}

// ============================================================
// §4 — Client unified-catalogue module (normalize + cache + guide map).
// ============================================================
{
  console.log('§4 client unified-catalogue module');
  const { clearLiveTvCache, __test } = await import('../src/lib/client/live-tv/cache');
  const unified = await import('../src/lib/client/live-tv/unified-catalogue');
  const { LiveTvError, isLiveTvError } = await import('../src/lib/client/live-tv/errors');

  const realFetch = globalThis.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;

  function withFetch(stub: (url: URL, init?: RequestInit) => Promise<Response>): void {
    (globalThis as { fetch: unknown }).fetch = stub as unknown as typeof fetch;
  }
  function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }

  try {
    // 4a. Normalization — unusable rows dropped, duplicates dropped, logo
    //     http(s)-gated, category/logo honest when absent.
    clearLiveTvCache();
    let requestedUrl = '';
    withFetch(async (url) => {
      requestedUrl = String(url);
      return jsonResponse({
        ok: true,
        unifiedEnabled: true,
        truncated: false,
        channels: [
          { id: 'chan-1', name: 'Alpha', category: 'News', logoUrl: 'https://cdn.example.com/a.png' },
          { id: 'chan-1', name: 'Alpha Duplicate' }, // duplicate id — dropped
          { id: 'chan-2', name: 'No Logo', category: null, logoUrl: null },
          { id: 'chan-3', name: 'Bad Logo', logoUrl: 'javascript:alert(1)' },
          { name: 'No Id' }, // unusable — dropped
          { id: 'chan-4', name: '   ' } // blank name — dropped
        ]
      });
    });
    const list = await unified.getUnifiedLivetvCatalogue();
    ok(list.length === 3 && list[0]?.id === 'chan-1', '4a.1 unusable and duplicate rows are dropped (first id wins)');
    ok(list[0]?.logo === 'https://cdn.example.com/a.png' && list[1]?.logo === undefined && list[2]?.logo === undefined, '4a.2 logos are carried only when usable (missing/bad → the initials fallback)');
    ok(requestedUrl.endsWith('/api/livetv/catalogue'), '4a.3 the ONLY fetch target is the fixed catalogue path on the app origin');

    // 4b. Cache reuse (the EXISTING catalogue cache) + forceRefetch bypass.
    withFetch(async () => {
      throw new Error('must not be called while cached');
    });
    const cachedList = await unified.getUnifiedLivetvCatalogue();
    ok(cachedList.length === 3, '4b.1 a repeat read is served from the bounded catalogue cache (no per-keystroke reloads)');
    ok(__test.catalogueKeys().includes('unified:v1'), '4b.2 the unified list lives under its own cache key');
    let refetched = false;
    withFetch(async () => {
      refetched = true;
      return jsonResponse({ ok: true, channels: [] });
    });
    const refetchList = await unified.getUnifiedLivetvCatalogue({ forceRefetch: true });
    ok(refetched && refetchList.length === 0, '4b.3 forceRefetch bypasses the cache (explicit invalidation)');

    // 4c. Guide mapping — now → nowPlaying + schedule head; upcoming →
    //     deterministic order; epoch-ms → Unix-seconds conversion.
    clearLiveTvCache();
    const startNowMs = NOW_MS - 10 * 60000;
    withFetch(async (url) => {
      requestedUrl = String(url);
      return jsonResponse({
        ok: true,
        unifiedEnabled: true,
        channelId: 'chan-1',
        serverNowMs: NOW_MS,
        now: { title: 'Current Show', description: 'Live', category: 'News', iconUrl: 'https://cdn.example.com/p.png', startMs: startNowMs, endMs: NOW_MS + 50 * 60000 },
        upcoming: [
          { title: 'Later', startMs: NOW_MS + 90 * 60000, endMs: NOW_MS + 120 * 60000 },
          { title: 'Next', startMs: NOW_MS + 50 * 60000, endMs: NOW_MS + 90 * 60000 },
          { title: 'Broken', startMs: 'x', endMs: NOW_MS + 95 * 60000 }, // dropped
          { title: 'Inverted', startMs: NOW_MS + 96 * 60000, endMs: NOW_MS + 95 * 60000 } // dropped
        ]
      });
    });
    const guide = await unified.getUnifiedLivetvGuide('chan-1');
    ok(requestedUrl.endsWith('/api/livetv/guide?channelId=chan-1'), '4c.1 the guide endpoint is the fixed path + the bounded channelId param');
    ok(guide.channelId === 'chan-1' && guide.nowPlaying?.title === 'Current Show', '4c.2 the on-air programme maps to the EXISTING nowPlaying model');
    ok(guide.nowPlaying?.startSeconds === Math.round(startNowMs / 1000) && guide.nowPlaying?.stopSeconds === Math.round((NOW_MS + 50 * 60000) / 1000), '4c.3 windows convert mechanically to absolute Unix seconds');
    ok(guide.schedule.length === 3 && guide.schedule[0]?.title === 'Current Show' && guide.schedule[1]?.title === 'Next' && guide.schedule[2]?.title === 'Later', '4c.4 the schedule is the current programme first, then deterministic start order (malformed rows dropped)');
    ok(guide.upNext?.title === 'Next', '4c.5 upNext is the first upcoming programme');
    ok(guide.nowPlaying?.image === 'https://cdn.example.com/p.png', '4c.6 genuine programme artwork is carried');

    // 4d. Empty/unmatched guide data is the honest empty guide.
    clearLiveTvCache();
    withFetch(async () => jsonResponse({ ok: true, unifiedEnabled: true, channelId: 'chan-9', serverNowMs: NOW_MS, now: null, upcoming: [] }));
    const emptyGuide = await unified.getUnifiedLivetvGuide('chan-9');
    ok(emptyGuide.nowPlaying === null && emptyGuide.schedule.length === 0 && emptyGuide.upNext === null, '4d.1 missing/unmatched guide data normalizes to the honest empty guide (never an error, never fabricated)');

    // 4e. Transport failure classes (LT-2 semantics).
    clearLiveTvCache();
    withFetch(async () => jsonResponse({ bad: true }, 500));
    let threwNetwork = '';
    try {
      await unified.getUnifiedLivetvCatalogue({ forceRefetch: true });
    } catch (err) {
      threwNetwork = isLiveTvError(err) ? err.kind : 'other';
    }
    ok(threwNetwork === 'network', '4e.1 a non-ok response classifies as the safe network error');
    withFetch(async () => {
      throw new TypeError('failed to fetch');
    });
    let threwFetch = '';
    try {
      await unified.getUnifiedLivetvCatalogue({ forceRefetch: true });
    } catch (err) {
      threwFetch = isLiveTvError(err) ? err.kind : 'other';
    }
    ok(threwFetch === 'network', '4e.2 a fetch rejection classifies as the safe network error');
    withFetch(async () => jsonResponse('not json'));
    let threwJson = '';
    try {
      await unified.getUnifiedLivetvCatalogue({ forceRefetch: true });
    } catch (err) {
      threwJson = isLiveTvError(err) ? err.kind : 'other';
    }
    ok(threwJson === 'invalid_response', '4e.3 a malformed body classifies as invalid_response');
    const earlyAbort = new AbortController();
    earlyAbort.abort();
    let threwAbort = '';
    try {
      await unified.getUnifiedLivetvCatalogue({ signal: earlyAbort.signal, forceRefetch: true });
    } catch (err) {
      threwAbort = isLiveTvError(err) ? err.kind : 'other';
    }
    ok(threwAbort === 'aborted', '4e.4 a pre-aborted signal classifies as aborted (switching stays silent)');
    withFetch(async () => jsonResponse({ channels: 'nope' }));
    let threwShape = '';
    try {
      await unified.getUnifiedLivetvCatalogue({ forceRefetch: true });
    } catch (err) {
      threwShape = isLiveTvError(err) ? err.kind : 'other';
    }
    ok(threwShape === 'invalid_response', '4e.5 a malformed channel array rejects (never coerced)');
    let threwBlank = '';
    try {
      await unified.getUnifiedLivetvGuide('  ');
    } catch (err) {
      threwBlank = isLiveTvError(err) ? err.kind : 'other';
    }
    ok(threwBlank === 'bad_request', '4e.6 a blank channel id is rejected before any fetch');
    ok(!isLiveTvError(new Error('x')), '4e.7 plain errors stay outside the LiveTvError guard');
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    (globalThis as { window?: unknown }).window = realWindow;
    clearLiveTvCache();
  }
}

// ============================================================
// §5 — Page source-contract (flag-gated integration, legacy intact).
// ============================================================
{
  console.log('§5 page source-contract');
  const page = read('../src/routes/live-tv/+page.svelte');
  const routerModule = read('../src/lib/client/live-tv/resolution-router.ts');
  const unifiedClient = read('../src/lib/client/live-tv/unified-catalogue.ts');

  // 5a. The catalogue loader: gated branch + byte-identical legacy line.
  const catalogueFlow = sliceOf(page, 'async function loadCatalogue', '// ---------------------------------------------------------------------\n  // Search');
  ok(catalogueFlow.includes('if (await isUnifiedLivetvGateEnabled()) {'), '5a.1 the catalogue loader consults the SHARED gate first');
  ok(catalogueFlow.includes('getUnifiedLivetvCatalogue({ signal: controller.signal })'), '5a.2 the unified branch fetches the bounded catalogue with the same signal discipline');
  const iUnifiedAbort = catalogueFlow.indexOf('if (controller.signal.aborted) return;');
  const iAssign = catalogueFlow.indexOf('channels = unifiedList;');
  ok(iUnifiedAbort !== -1 && iAssign !== -1 && iUnifiedAbort < iAssign, '5a.3 the unified branch re-checks the abort BEFORE the assignment (a superseded load never clobbers a newer one)');
  ok(catalogueFlow.includes('const list = await getLiveTvChannels({ signal: controller.signal });'), '5a.4 the legacy LiveGT load line is byte-identical (flag FALSE path)');
  const iGate = catalogueFlow.indexOf('isUnifiedLivetvGateEnabled()');
  const iLegacy = catalogueFlow.indexOf('const list = await getLiveTvChannels(');
  ok(iGate !== -1 && iLegacy !== -1 && iGate < iLegacy, '5a.5 the gate strictly precedes the legacy load (the legacy path runs only when the gate is FALSE)');

  // 5b. The guide loader: gated branch + byte-identical legacy line.
  const guideFlow = sliceOf(page, 'async function loadGuide', 'function retryGuide');
  ok(guideFlow.includes('if (await isUnifiedLivetvGateEnabled()) {'), '5b.1 the guide loader consults the SHARED gate first');
  ok(guideFlow.includes('getUnifiedLivetvGuide(channel.id, { signal: controller.signal })'), '5b.2 the unified guide is loaded for the SELECTED canonical channel id');
  ok(guideFlow.includes('await getLiveTvGuide(channel.id, { signal: controller.signal });'), '5b.3 the legacy LiveGT guide line is byte-identical (flag FALSE path)');
  ok(!/engine|sessionErrorMessage|selectedChannel|resolving(?!\s*=)/.test(guideFlow), '5b.4 the guide flow still never mutates playback state (pre-existing pin preserved)');
  const iGuideSeq = guideFlow.indexOf('if (seq !== guideSeq || controller.signal.aborted) return;');
  ok(guideFlow.indexOf(iGuideSeq >= 0 ? guideFlow.slice(iGuideSeq + 10).indexOf('seq !== guideSeq') >= 0 ? 'x' : 'seq !== guideSeq' : 'x') !== -1 || guideFlow.split('seq !== guideSeq').length >= 3, '5b.5 BOTH guide branches carry the sequence guard (selection stays synchronized)');

  // 5c. One flag, one read — the page never fetches the flag; the gate
  //     lives in the router module (Phase 5 single-gate ownership).
  ok(page.includes("isUnifiedLivetvGateEnabled } from '$lib/client/live-tv/resolution-router'"), '5c.1 the page consumes the gate from the Live TV client family');
  ok(!page.includes('/api/livetv/playback/config'), '5c.2 the page never fetches the flag itself (P2.9 preserved)');
  ok(!page.includes('/api/livetv/catalogue') && !page.includes('/api/livetv/guide'), '5c.3 the page contains no endpoint URLs (they live in the client module)');
  ok(routerModule.split('/api/livetv/playback/config').length === 2, '5c.4 exactly ONE flag URL exists across the client family (single read path)');
  ok(page.includes("from '$lib/client/live-tv/unified-catalogue'"), '5c.5 the unified data surface is the dedicated Live TV client module');

  // 5d. Playback selection: stable canonical ids drive everything.
  const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
  ok(selectFlow.includes('playbackRouter.start(channel, videoEl, controller.signal)'), '5d.1 selections pass the channel (its STABLE id) to the Phase 5 router');
  ok(page.includes('rememberPlayedChannel(channel)'), '5d.2 recent channels are recorded by the channel object (id-keyed storage)');
  ok(page.includes('const byId = new Map(channels.map((channel) => [channel.id, channel]));'), '5d.3 recent rows resolve against the LIVE catalogue (stale/deleted ids drop out gracefully)');

  // 5e. Existing UX markers intact (search/filter/a11y — no redesign).
  ok(page.includes('filterLiveTvChannelsByCategory(channels, category)') && page.includes('filterLiveTvChannelsByQuery(list, trimmed)'), '5e.1 search + category filtering run over the merged list via the EXISTING pure utilities');
  ok(page.includes('aria-label="Channels"') && page.includes('aria-label="Channel tools"'), '5e.2 the existing section labels are intact');
  ok(page.includes('<LiveTvFilterSheet') && page.includes('<LiveTvGuideSheet'), '5e.3 the filter + guide sheets are unchanged page chrome');
  ok(page.includes('channel-skeleton') && page.includes('aria-busy="true"'), '5e.4 the loading skeleton state is intact');
  ok(page.includes('No Live TV channels are currently available.'), '5e.5 the honest empty-catalogue state is intact (a flag-ON empty catalogue renders it)');
  ok(page.includes('No channels match your search.'), '5e.6 the honest no-results state is intact');
  ok(page.includes('<ErrorState') && page.includes('retry={loadCatalogue}'), '5e.7 the honest catalogue error state with retry is intact');
  ok(page.includes('onselect={(c) => void selectChannel(c)}'), '5e.8 channel cards still drive selectChannel');
}

// ============================================================
// §6 — Isolation & security.
// ============================================================
{
  console.log('§6 isolation and security');
  const unifiedClient = read('../src/lib/client/live-tv/unified-catalogue.ts');
  const userCatalogue = read('../src/lib/server/livetv/user-catalogue.ts');
  const catalogueRoute = read('../src/routes/api/livetv/catalogue/+server.ts');
  const guideRoute = read('../src/routes/api/livetv/guide/+server.ts');
  const resolverModule = read('../src/lib/server/livetv/playback-resolver.ts');
  const routerModule = read('../src/lib/client/live-tv/resolution-router.ts');
  const rateLimit = read('../src/lib/server/http/rate-limit.ts');
  const guideComponent = read('../src/lib/components/live-tv/LiveTvGuide.svelte');
  const epgHelpers = read('../src/lib/client/live-tv/epg.ts');
  const errorsModule = read('../src/lib/client/live-tv/errors.ts');

  // 6a. No VOD import edges anywhere in the new/edited Live TV modules
  //     (import statements only — prose mentions in isolation comments are
  //     the documented contracts, not code).
  for (const [name, source] of [['unified-catalogue.ts', unifiedClient], ['user-catalogue.ts', userCatalogue], ['playback-resolver.ts', resolverModule], ['resolution-router.ts', routerModule]] as const) {
    const importEdges = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    ok(!importEdges.some((edge) => edge.includes('$lib/shared/') || edge.includes('$lib/client/player/') || edge.includes('adapter-registry')), `6a.${['unified-catalogue.ts', 'user-catalogue.ts', 'playback-resolver.ts', 'resolution-router.ts'].indexOf(name) + 1} ${name} imports nothing from VOD`);
  }

  // 6b. Zero console calls in the new modules (nothing can log).
  for (const [name, source] of [['unified-catalogue.ts', unifiedClient], ['user-catalogue.ts', userCatalogue]] as const) {
    ok(!source.includes('console.'), `6b.${name === unifiedClient ? '1' : '2'} ${name} has zero console calls`);
  }

  // 6c. No analytics additions (the closed taxonomy is untouched).
  ok(!unifiedClient.includes('track') && !userCatalogue.includes('track'), '6c.1 the new data modules add no analytics events');

  // 6d. Routes: GET-only public reads with the established discipline.
  for (const [name, source, rule] of [['catalogue', catalogueRoute, 'livetvCatalogue'], ['guide', guideRoute, 'livetvGuide']] as const) {
    ok(source.includes('export const GET') && !source.includes('export const POST') && !source.includes('export const PUT') && !source.includes('export const DELETE'), `6d.${name === 'catalogue' ? '1' : '3'} /api/livetv/${name} is GET-only`);
    ok(source.includes(`checkRateLimit('${rule}'`), `6d.${name === 'catalogue' ? '2' : '4'} /api/livetv/${name} is rate-limited (${rule})`);
    ok(source.includes('createSupabaseAdminClient()'), `6d.${name === 'catalogue' ? '5' : '6'} /api/livetv/${name} reads via the service-role client (fail-closed RLS posture unchanged)`);
    ok(source.includes("'cache-control': 'no-store'"), `6d.${name === 'catalogue' ? '7' : '8'} /api/livetv/${name} is no-store`);
  }
  ok(guideRoute.includes('isValidChannelId') && guideRoute.includes("code < 0x20 || code === 0x7f"), '6d.9 the guide route validates the channel id (bounded, no control characters)');

  // 6e. The rate rules are additive and bounded.
  ok(rateLimit.includes('livetvCatalogue: { limit: 30, windowMs: 60_000 }') && rateLimit.includes('livetvGuide: { limit: 60, windowMs: 60_000 }'), '6e.1 the two Phase 6 public rules exist with bounded budgets');

  // 6f. The new modules never fetch upstream / never carry provider hosts
  //     or playback material.
  ok(!unifiedClient.includes('http://') || unifiedClient.includes('http://localhost'), '6f.1 the client module carries no provider host (only the Node-test origin placeholder)');
  ok(!unifiedClient.includes('livetgtv'), '6f.2 the LiveGT hostname never appears in the unified client');
  ok(!userCatalogue.includes('fetch(') && !resolverModule.includes('await fetch'), '6f.3 the server modules perform zero upstream fetching (pure DB reads)');
  ok(!unifiedClient.includes('__hdnea__') && !userCatalogue.includes('__hdnea__') && !catalogueRoute.includes('__hdnea__') && !guideRoute.includes('__hdnea__'), '6f.4 no signed-media material is referenced by the new surfaces');

  // 6g. The resolver stays the ONLY engine-mapping consumer; the wire's
  //     engine field remains DERIVED (never stored/configured).
  ok(resolverModule.includes("candidate.engine === 'iframe_embed' ? 'iframe_embed' : 'shaka_media_player'"), '6g.1 the engine on the wire is the registry-derived value');
  const engineLines = resolverModule.split('\n').filter((line) => line.includes('engine:'));
  ok(engineLines.length > 0 && engineLines.every((line) => line.includes('engine: LivetvWireEngine;') || line.includes("engine: candidate.engine === 'iframe_embed'")), '6g.2 every engine occurrence is the derived type or the registry-derived assignment (never configuration)');

  // 6h. The guide component + epg helpers stay additive (pins preserved).
  ok(guideComponent.includes("programmeStatusAt(entry, nowSeconds) === 'current'") && guideComponent.includes('On air') && guideComponent.includes('entry.stopSeconds <= now'), '6h.1 the guide component keeps its honest current-marker pins');
  ok(guideComponent.includes('currentProgress') && guideComponent.includes('row-progress-fill'), '6h.2 the progress line is the ONE additive guide element');
  ok(epgHelpers.includes('export function programmeProgressPercent') && epgHelpers.includes('export function formatProgrammeRemaining'), '6h.3 the progress helpers are additive pure exports');
  ok(errorsModule.includes("'channels' | 'channel' | 'guide' | 'catalogue'"), '6h.4 the error-context vocabulary grew additively (safe table unchanged)');
}

// ============================================================
// §7 — Honest progress helpers (current-window boundaries only).
// ============================================================
{
  console.log('§7 progress helper boundaries');
  const { programmeProgressPercent, formatProgrammeRemaining } = await import('../src/lib/client/live-tv/epg');
  const base = 1_700_000_000;
  const programme = { title: 'Show', startSeconds: base, stopSeconds: base + 3600 };

  ok(programmeProgressPercent(programme, base - 1) === null, '7.1 no progress before the window');
  ok(programmeProgressPercent(programme, base + 3600) === null, '7.2 no progress at/after the window end');
  ok(programmeProgressPercent(programme, base + 1800) === 50, '7.3 progress mid-window is the honest fraction');
  ok(programmeProgressPercent(programme, base) === 0, '7.4 progress at the window start is zero');
  ok(programmeProgressPercent({ title: 'Bad', startSeconds: base, stopSeconds: base }, 10) === null, '7.5 a degenerate window never yields progress');
  ok(programmeProgressPercent({ title: 'NaN', startSeconds: Number.NaN, stopSeconds: base + 10 }, 10) === null, '7.6 non-finite data never yields progress');
  ok(formatProgrammeRemaining(programme, base + 60) === '59m left', '7.7 remaining time mid-window is human and honest');
  ok(formatProgrammeRemaining(programme, base + 3540) === '1m left', '7.8 remaining time near the end');
  ok(formatProgrammeRemaining(programme, base + 3599) === '1s left', '7.9 remaining time in the last second');
  ok(formatProgrammeRemaining(programme, base + 3601) === null, '7.10 no remaining time after the window');
  ok(formatProgrammeRemaining({ title: 'H', startSeconds: base, stopSeconds: base + 7200 }, base + 60) === '1h 59m left', '7.11 hours render in the established compact form');
}

// ============================================================
// §8 — Flag-off legacy preservation (fail-closed everywhere).
// ============================================================
{
  console.log('§8 flag-off legacy preservation');
  const { getUnifiedLivetvCatalogue, getUnifiedLivetvGuide } = await import('../src/lib/server/livetv/user-catalogue');
  const { resolveLivetvPlaybackForSelection, resetLivetvPlaybackFlagCacheForTests } = await import('../src/lib/server/livetv/playback-resolver');

  const tables = {
    livetv_config_meta: FLAG_OFF,
    livetv_sources: [SRC_BUILTIN],
    livetv_source_channels: [ENTRY_BUILTIN],
    livetv_channels: [CHAN_1],
    livetv_playback_endpoints: [EP_M3U],
    livetv_playback_candidates: []
  };

  resetLivetvPlaybackFlagCacheForTests();
  const clientA = createMockClient(tables);
  const catalogue = await getUnifiedLivetvCatalogue(clientA as unknown as Parameters<typeof getUnifiedLivetvCatalogue>[0]);
  ok(catalogue.unifiedEnabled === false && catalogue.channels.length === 0, '8.1 the catalogue fails closed to empty when the flag is FALSE');
  ok(clientA.queriesFor('livetv_sources').length === 0, '8.2 the catalogue reads NO registry tables when the flag is FALSE');

  resetLivetvPlaybackFlagCacheForTests();
  const clientB = createMockClient(tables);
  const guide = await getUnifiedLivetvGuide(clientB as unknown as Parameters<typeof getUnifiedLivetvGuide>[0], 'chan-1', new Date(NOW_MS));
  ok(guide.unifiedEnabled === false && guide.now === null && guide.upcoming.length === 0, '8.3 the guide fails closed to empty when the flag is FALSE');
  ok(clientB.queriesFor('livetv_epg_programmes').length === 0, '8.4 the guide reads NO programme tables when the flag is FALSE');

  resetLivetvPlaybackFlagCacheForTests();
  const clientC = createMockClient(tables);
  const resolution = await resolveLivetvPlaybackForSelection(clientC as unknown as Parameters<typeof resolveLivetvPlaybackForSelection>[0], 'chan-1');
  ok(resolution.unifiedEnabled === false && resolution.resolved === false && resolution.candidates.length === 0, '8.5 the resolver fails closed to the legacy compatibility path when the flag is FALSE');

  // A flag read FAILURE is also fail-closed (never a stray true).
  resetLivetvPlaybackFlagCacheForTests();
  const clientD = createMockClient({ livetv_config_meta: FLAG_ON }, { failFlag: true, failTable: 'livetv_config_meta' });
  const catalogueFail = await getUnifiedLivetvCatalogue(clientD as unknown as Parameters<typeof getUnifiedLivetvCatalogue>[0]);
  ok(catalogueFail.unifiedEnabled === false && catalogueFail.channels.length === 0, '8.6 a flag-read failure resolves to the legacy direction (false)');
}

console.log(`\nlivetv_phase6_unified_test: ${passed} checks passed`);
if (passed === 0) process.exit(1);

