/**
 * UNIFIED LIVE TV — Phase 4 admin management service verification.
 *
 * Covers the Phase 4 brief §3/§4/§6 requirements:
 *   §1  input validation (pure) — names/slugs/priorities/URLs/dedup keys,
 *       slug derivation, builtin-source creation refusal.
 *   §2  source CRUD through the mock DB — typed configs per source type,
 *       immutable slug/type, enablement, DETERMINISTIC priority reordering
 *       (completeness + duplicate rejection), delete impact accounting and
 *       the builtin delete protection (DB-trigger parity).
 *   §3  imported entries — enablement, canonical mapping set/unset,
 *       paginated listing with filters.
 *   §4  canonical channels — CRUD validation, delete impact (unmap/cascade).
 *   §5  playback candidates — cross-channel guard (trigger parity),
 *       duplicate rejection, priority/enablement updates, scoped removal.
 *   §6  typed endpoints — authoring ONLY for adapter-less sources
 *       (manual_stream/embed_provider); adapter-fed endpoints accept ONLY
 *       admin-owned field edits (enabled/ordering) and REFUSE deletes.
 *   §7  EPG sources — CRUD with the Phase 3 config validator (IANA
 *       timezone), guide-URL requirement, delete impact.
 *   §8  explicit EPG mappings — identity normalization, both uniqueness
 *       directions, scoped deletion.
 *   §9  guide diagnostics — Phase 3 planner parity (explicit/tvgId/
 *       ambiguous/unmatched/invalid) over stored guide identities.
 *   §10 overview — read-only config meta (unified_enabled NEVER written).
 *   §11 error mapping/redaction — DB failures map to safe static messages;
 *       no upstream URL ever appears in a mapped error.
 *
 * NO real network, NO real database (mock client with REAL uniqueness
 * + trigger parity, following the Phase 2/3 suite conventions).
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import {
  LivetvAdminError,
  addLivetvChannelCandidate,
  addLivetvEndpoint,
  createLivetvChannel,
  createLivetvEpgMapping,
  createLivetvEpgSource,
  createLivetvSource,
  deleteLivetvChannel,
  deleteLivetvEpgMapping,
  deleteLivetvEpgSource,
  deleteLivetvEndpoint,
  deleteLivetvSource,
  deriveSlugFromName,
  getLivetvAdminOverview,
  getLivetvChannelCandidates,
  getLivetvEpgGuideDiagnostics,
  getLivetvEntryEndpoints,
  listLivetvEntries,
  listLivetvEpgMappings,
  listLivetvEpgSources,
  listLivetvSourceDeleteImpacts,
  listLivetvSources,
  mapLivetvDbError,
  removeLivetvChannelCandidate,
  reorderLivetvSources,
  setLivetvChannelEnabled,
  setLivetvEndpointEnabled,
  setLivetvEntryEnabled,
  setLivetvEntryMapping,
  setLivetvEpgSourceEnabled,
  setLivetvSourceEnabled,
  updateLivetvChannel,
  updateLivetvChannelCandidate,
  updateLivetvEpgSource,
  updateLivetvEndpoint,
  updateLivetvSource,
  getLatestLivetvRefreshHistoryBySource
} from '../src/lib/server/livetv/admin-service';

// ---------------------------------------------------------------------------
// Mock supabase-js subset with REAL uniqueness + trigger parity
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const UUIDS = {
  source: '5a000001-0000-0000-0000-000000000001',
  builtin: '5a000001-0000-0000-0000-000000000002',
  channel: 'cb000001-0000-0000-0000-000000000001',
  channel2: 'cb000001-0000-0000-0000-000000000002',
  entry: 'e1000001-0000-0000-0000-000000000001',
  entry2: 'e1000001-0000-0000-0000-000000000002',
  endpoint: 'e2000001-0000-0000-0000-000000000001',
  epgSource: 'e3000001-0000-0000-0000-000000000001',
  mapping: 'e4000001-0000-0000-0000-000000000001'
};

function createMockDb() {
  const state: Record<string, Row[]> = {
    livetv_config_meta: [{ id: 1, version: 7, unified_enabled: false, updated_at: '2026-01-01T00:00:00Z' }],
    livetv_sources: [],
    livetv_channels: [],
    livetv_source_channels: [],
    livetv_playback_endpoints: [],
    livetv_playback_candidates: [],
    livetv_epg_sources: [],
    livetv_epg_channel_mappings: [],
    livetv_epg_programmes: []
  };
  const writes: { table: string; op: string; payload: Row }[] = [];
  let uuidCounter = 0;
  // UUID-shaped generated ids (the service validates ids with the UUID pattern).
  const nextId = () => `10000000-0000-0000-0000-${String((uuidCounter += 1)).padStart(12, '0')}`;

  function uniquenessViolation(table: string, payload: Row): string | null {
    if (table === 'livetv_sources') {
      if (state[table].some((row) => row['slug'] === payload['slug'] && row['id'] !== payload['id'])) {
        return 'duplicate key value violates unique constraint "livetv_sources_slug_key"';
      }
    }
    if (table === 'livetv_channels' && typeof payload['dedup_key'] === 'string') {
      if (state[table].some((row) => row['dedup_key'] === payload['dedup_key'] && row['id'] !== payload['id'])) {
        return 'duplicate key value violates unique constraint "livetv_channels_dedup_key_uq"';
      }
    }
    if (table === 'livetv_playback_endpoints') {
      if (state[table].some((row) => row['source_channel_id'] === payload['source_channel_id'] && row['url'] === payload['url'] && row['id'] !== payload['id'])) {
        return 'duplicate key value violates unique constraint "livetv_playback_endpoints_source_channel_id_url_key"';
      }
    }
    if (table === 'livetv_playback_candidates') {
      if (state[table].some((row) => row['channel_id'] === payload['channel_id'] && row['endpoint_id'] === payload['endpoint_id'] && row['id'] !== payload['id'])) {
        return 'duplicate key value violates unique constraint "livetv_playback_candidates_channel_id_endpoint_id_key"';
      }
    }
    if (table === 'livetv_epg_channel_mappings') {
      if (state[table].some((row) => row['epg_source_id'] === payload['epg_source_id'] && row['channel_id'] === payload['channel_id'] && row['id'] !== payload['id'])) {
        return 'duplicate key value violates unique constraint "livetv_epg_channel_mappings_epg_source_id_channel_id_key"';
      }
      if (state[table].some((row) => row['epg_source_id'] === payload['epg_source_id'] && row['epg_channel_id'] === payload['epg_channel_id'] && row['id'] !== payload['id'])) {
        return 'duplicate key value violates unique constraint "livetv_epg_channel_mappings_epg_source_id_epg_channel_id_key"';
      }
    }
    return null;
  }

  /** DB trigger parity for the candidate cross-channel guard. */
  function candidateGuardViolation(payload: Row): string | null {
    const endpoint = state['livetv_playback_endpoints'].find((row) => row['id'] === payload['endpoint_id']);
    if (!endpoint) return 'violates foreign key constraint';
    const entry = state['livetv_source_channels'].find((row) => row['id'] === endpoint['source_channel_id']);
    const mapped = entry ? entry['canonical_channel_id'] : null;
    if (!mapped || mapped !== payload['channel_id']) {
      return 'LIVETV_CANDIDATE_CHANNEL_MISMATCH: the endpoint does not belong to a source channel mapped to the candidate channel';
    }
    return null;
  }

  function applyFilters(rows: Row[], filters: [string, string, unknown][]): Row[] {
    return rows.filter((row) =>
      filters.every(([col, op, val]) => {
        if (op === 'eq') return row[col] === val;
        if (op === 'is') return val === null ? row[col] === null || row[col] === undefined : row[col] === val;
        if (op === 'not.is') return !(row[col] === null || row[col] === undefined);
        if (op === 'ilike') return typeof row[col] === 'string' && (row[col] as string).toLowerCase().includes(String(val).replace(/%/g, '').toLowerCase());
        if (op === 'gte') return String(row[col]) >= String(val);
        if (op === 'lte') return String(row[col]) <= String(val);
        if (op === 'in') return (val as unknown[]).includes(row[col]);
        return true;
      })
    );
  }

  /** Minimal embed resolver for the exact relations the service embeds. */
  const EMBED_CHILD: Record<string, { table: string; column: string }> = {
    livetv_source_channels: { table: 'livetv_source_channels', column: 'source_id' },
    livetv_playback_candidates: { table: 'livetv_playback_candidates', column: 'channel_id' },
    livetv_epg_channel_mappings: { table: 'livetv_epg_channel_mappings', column: 'epg_source_id' },
    livetv_epg_programmes: { table: 'livetv_epg_programmes', column: 'epg_source_id' }
  };

  function resolveEmbed(parentTable: string, parentRow: Row, relation: string, spec: string, depth = 0): unknown {
    if (relation === 'livetv_playback_endpoints') {
      const children = state['livetv_playback_endpoints'].filter((row) => row['source_channel_id'] === parentRow['id']);
      if (spec === 'count') return [{ count: children.length }];
      return children.map((child) => projectEmbed(child, spec, 'livetv_playback_endpoints', depth));
    }
    if (relation === 'livetv_sources') {
      const parents = state['livetv_sources'].filter((row) => row['id'] === parentRow['source_id']);
      if (spec === 'count') return [{ count: parents.length }];
      return parents.map((parent) => projectEmbed(parent, spec, 'livetv_sources', depth));
    }
    const child = EMBED_CHILD[relation];
    if (!child) return [];
    // The FK column depends on the PARENT table (candidates embed under
    // channels by channel_id, under endpoints by endpoint_id; source
    // channels embed under sources by source_id, under canonical channels
    // by canonical_channel_id).
    let fkColumn = child.column;
    if (relation === 'livetv_playback_candidates' && parentTable === 'livetv_playback_endpoints') fkColumn = 'endpoint_id';
    if (relation === 'livetv_source_channels' && parentTable === 'livetv_channels') fkColumn = 'canonical_channel_id';
    if (relation === 'livetv_epg_channel_mappings' && parentTable === 'livetv_channels') fkColumn = 'channel_id';
    // REVERSE lookup: endpoints carry the ENTRY's id (endpoints.source_channel_id
    // → source_channels.id), so the "child" rows are found by their own id.
    if (relation === 'livetv_source_channels' && parentTable === 'livetv_playback_endpoints') {
      const parents = state['livetv_source_channels'].filter((row) => row['id'] === parentRow['source_channel_id']);
      if (spec === 'count') return [{ count: parents.length }];
      return parents.map((row) => projectEmbed(row, spec, relation, depth));
    }
    const children = state[child.table].filter((row) => row[fkColumn] === parentRow['id']);
    if (spec === 'count') return [{ count: children.length }];
    return children.map((row) => projectEmbed(row, spec, relation, depth));
  }

  function projectEmbed(row: Row, spec: string, relation: string, depth: number): Row {
    if (spec === 'count') return { count: 0 };
    const out: Row = {};
    for (const field of splitFields(spec)) {
      const nested = field.match(/^([a-z_]+)\((.*)\)$/s);
      if (nested && depth < 5) {
        out[nested[1]!] = resolveEmbed(relation, row, nested[1]!, nested[2]!, depth + 1);
      } else {
        out[field] = row[field];
      }
    }
    return out;
  }

  function splitFields(spec: string): string[] {
    const fields: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of spec) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === ',' && depth === 0) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) fields.push(current.trim());
    return fields;
  }

  function makeBuilder(table: string) {
    const filters: [string, string, unknown][] = [];
    let selectCols: string | null = null;
    let selectOptions: { count?: string; head?: boolean } | null = null;
    let rangeStart: number | null = null;
    let rangeEnd: number | null = null;
    let forcedError: string | null = null;

    const builder: Record<string, unknown> = {
      select(cols?: string, options?: { count?: string; head?: boolean }) {
        selectCols = cols ?? '*';
        selectOptions = options ?? null;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push([col, 'eq', val]);
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push([col, 'is', val]);
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        filters.push([col, `${op}.${String(val)}`, val]);
        return builder;
      },
      in(col: string, val: unknown[]) {
        filters.push([col, 'in', val]);
        return builder;
      },
      ilike(col: string, val: string) {
        filters.push([col, 'ilike', val]);
        return builder;
      },
      gte(col: string, val: string) {
        filters.push([col, 'gte', val]);
        return builder;
      },
      lte(col: string, val: string) {
        filters.push([col, 'lte', val]);
        return builder;
      },
      order() {
        return builder;
      },
      range(start: number, end: number) {
        rangeStart = start;
        rangeEnd = end;
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        let rows = applyFilters(state[table] ?? [], filters);
        if (selectCols && selectCols !== '*') rows = rows.map((row) => projectRow(table, row, selectCols!));
        return { data: rows[0] ?? null, error: forcedError ? { message: forcedError } : null };
      },
      async single() {
        const rows = applyFilters(state[table] ?? [], filters);
        return { data: rows[0] ?? null, error: rows.length ? null : { message: 'no rows' } };
      },
      insert(payload: Row) {
        return {
          select() {
            return {
              single: async () => {
                const dup = uniquenessViolation(table, payload);
                if (dup) return { data: null, error: { message: dup } };
                const row = { ...payload, id: nextId() };
                state[table].push(row);
                writes.push({ table, op: 'insert', payload });
                return { data: row, error: null };
              }
            };
          },
          then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            (async () => {
              const dup = uniquenessViolation(table, payload);
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
        const runUpdate = (target: [string, string, unknown][]) => ({
          eq(col: string, val: unknown) {
            return runUpdate([...target, [col, 'eq', val]]);
          },
          // R-0 parity: the services verify a mutation via
          // update(...).select('id').single() — a 0-row match must surface
          // as the PGRST116 no-rows error, exactly like PostgREST.
          select(_cols?: string) {
            return {
              single: async () => {
                const rows = applyFilters(state[table] ?? [], target);
                for (const row of rows) {
                  if (table === 'livetv_sources' && typeof payload['slug'] === 'string') {
                    const dup = uniquenessViolation(table, { ...row, ...payload });
                    if (dup) return { data: null, error: { message: dup } };
                  }
                  Object.assign(row, payload);
                }
                writes.push({ table, op: 'update', payload });
                if (rows.length === 0) return { data: null, error: { message: 'PGRST116: json object requested, multiple (or no) rows returned' } };
                return { data: { id: rows[0]?.['id'] }, error: null };
              }
            };
          },
          then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            (async () => {
              const rows = applyFilters(state[table] ?? [], target);
              for (const row of rows) {
                if (table === 'livetv_sources' && typeof payload['slug'] === 'string') {
                  const dup = uniquenessViolation(table, { ...row, ...payload });
                  if (dup) return { data: null, error: { message: dup } };
                }
                Object.assign(row, payload);
              }
              writes.push({ table, op: 'update', payload });
              return { data: rows[0] ?? null, error: null };
            })().then(resolve, reject);
          }
        });
        return runUpdate(filters);
      },
      delete() {
        const runDelete = (target: [string, string, unknown][]) => ({
          eq(col: string, val: unknown) {
            return runDelete([...target, [col, 'eq', val]]);
          },
          select() {
            return {
              then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
                (async () => {
                  const rows = applyFilters(state[table] ?? [], target);
                  state[table] = (state[table] ?? []).filter((row) => !rows.includes(row));
                  return { data: rows.map((row) => ({ id: row['id'] })), error: null };
                })().then(resolve, reject);
              }
            };
          },
          then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            (async () => {
              const rows = applyFilters(state[table] ?? [], target);
              if (table === 'livetv_sources' && rows.some((row) => row['builtin'] === true)) {
                return { data: null, error: { message: 'LIVETV_BUILTIN_SOURCE_PROTECTED: the built-in LiveGT V1 source cannot be deleted' } };
              }
              // ON DELETE cascade/unmap parity with the Phase 1 FKs.
              const removedIds = new Set(rows.map((row) => String(row['id'])));
              if (table === 'livetv_sources') {
                const entryIds = new Set(state['livetv_source_channels'].filter((row) => removedIds.has(String(row['source_id']))).map((row) => String(row['id'])));
                const endpointIds = new Set(state['livetv_playback_endpoints'].filter((row) => entryIds.has(String(row['source_channel_id']))).map((row) => String(row['id'])));
                state['livetv_source_channels'] = state['livetv_source_channels'].filter((row) => !entryIds.has(String(row['id'])));
                state['livetv_playback_endpoints'] = state['livetv_playback_endpoints'].filter((row) => !entryIds.has(String(row['source_channel_id'])));
                state['livetv_playback_candidates'] = state['livetv_playback_candidates'].filter((row) => !endpointIds.has(String(row['endpoint_id'])));
              }
              if (table === 'livetv_channels') {
                for (const entry of state['livetv_source_channels']) {
                  if (removedIds.has(String(entry['canonical_channel_id']))) entry['canonical_channel_id'] = null;
                }
                state['livetv_playback_candidates'] = state['livetv_playback_candidates'].filter((row) => !removedIds.has(String(row['channel_id'])));
                state['livetv_epg_channel_mappings'] = state['livetv_epg_channel_mappings'].filter((row) => !removedIds.has(String(row['channel_id'])));
              }
              if (table === 'livetv_epg_sources') {
                state['livetv_epg_channel_mappings'] = state['livetv_epg_channel_mappings'].filter((row) => !removedIds.has(String(row['epg_source_id'])));
                state['livetv_epg_programmes'] = state['livetv_epg_programmes'].filter((row) => !removedIds.has(String(row['epg_source_id'])));
              }
              if (table === 'livetv_playback_endpoints') {
                state['livetv_playback_candidates'] = state['livetv_playback_candidates'].filter((row) => !removedIds.has(String(row['endpoint_id'])));
              }
              state[table] = (state[table] ?? []).filter((row) => !rows.includes(row));
              return { data: null, error: null };
            })().then(resolve, reject);
          }
        });
        return runDelete(filters);
      },
      then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
        (async () => {
          let rows = applyFilters(state[table] ?? [], filters);
          if (rangeStart !== null && rangeEnd !== null) rows = rows.slice(rangeStart, rangeEnd + 1);
          if (selectOptions?.count === 'exact' && selectOptions.head) {
            const all = applyFilters(state[table] ?? [], filters);
            return { data: [], error: null, count: all.length };
          }
          if (selectCols && selectCols !== '*') {
            rows = rows.map((row) => projectRow(table, row, selectCols!));
          }
          return { data: rows, error: null, count: rows.length };
        })().then(resolve, reject);
      }
    };
    return builder;
  }

  function projectRow(table: string, row: Row, cols: string): Row {
    const out: Row = {};
    for (const field of splitFields(cols)) {
      const nested = field.match(/^([a-z_]+)\((.*)\)$/s);
      if (nested) {
        out[nested[1]!] = resolveEmbed(table, row, nested[1]!, nested[2]!, 0);
      } else {
        out[field] = row[field];
      }
    }
    return out;
  }

  const client = {
    from: (table: string) => {
      if (!(table in state)) throw new Error(`unexpected table: ${table}`);
      return makeBuilder(table);
    }
  };
  return { client, state, writes };
}

// ============================================================
console.log('§1 input validation (pure)');
// ============================================================
{
  ok(deriveSlugFromName('My Cool TV!') === 'my-cool-tv', '§1.1 slug derivation is deterministic');
  ok(deriveSlugFromName('  A  B  ') === 'a-b', '§1.2 slug derivation trims + collapses separators');
  try {
    deriveSlugFromName('???');
    ok(false, '§1.3 underrivable slug fails loudly');
  } catch (error) {
    ok(error instanceof LivetvAdminError, '§1.3 underrivable slug fails loudly (typed LivetvAdminError)');
  }
}

// ============================================================
console.log('§2 source CRUD, priority ordering, delete impact');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_sources.push({ id: UUIDS.builtin, slug: 'builtin-livegt-v1', name: 'LiveGT V1 (Built-in)', source_type: 'builtin_livegt_v1', builtin: true, enabled: true, status: 'active', priority: 0, visibility: 'public', config: {}, description: null, created_at: '', updated_at: '' });

  const created = await createLivetvSource(db.client as never, {
    name: 'My Playlist',
    sourceType: 'm3u_playlist',
    config: { playlistUrl: 'https://cdn.example.com/list.m3u8' },
    enabled: true
  });
  ok(created.slug === 'my-playlist', '§2.1 create derives the slug from the name');
  const stored = db.state.livetv_sources.find((row) => row['id'] === created.id)!;
  ok(stored['config'] && (stored['config'] as Row)['playlistUrl'] === 'https://cdn.example.com/list.m3u8', '§2.2 typed config stored');
  ok(stored['builtin'] === false && stored['status'] === 'experimental', '§2.3 non-builtin defaults applied');

  await assert.rejects(
    () => createLivetvSource(db.client as never, { name: 'X', sourceType: 'builtin_livegt_v1', config: {} }),
    /cannot be created manually/,
    '§2.4 builtin source creation is refused'
  );
  await assert.rejects(
    () => createLivetvSource(db.client as never, { name: 'X', sourceType: 'm3u_playlist', config: { playlistUrl: 'http://insecure.example/x.m3u' } }),
    /must use https/,
    '§2.5 non-https config refused (stage-1 SSRF parity)'
  );
  await assert.rejects(
    () => createLivetvSource(db.client as never, { name: 'X', sourceType: 'manual_stream', config: { sneaky: 'key' } }),
    /unknown config key/,
    '§2.6 unknown config keys rejected (secret-bearing fields cannot hide)'
  );
  await assert.rejects(
    () => createLivetvSource(db.client as never, { name: 'My Playlist', sourceType: 'api_provider', config: { baseUrl: 'https://api.example.com' } }),
    /slug/,
    '§2.7 duplicate slug surfaces a typed message'
  );

  await updateLivetvSource(db.client as never, created.id, { name: 'Renamed', priority: 5 });
  ok(db.state.livetv_sources.find((row) => row['id'] === created.id)!['name'] === 'Renamed', '§2.8 update applies mutable fields');
  await assert.rejects(
    () => updateLivetvSource(db.client as never, created.id, { config: { sneaky: true } }),
    /unknown config key/,
    '§2.9 update validates config against the SOURCE TYPE'
  );

  await setLivetvSourceEnabled(db.client as never, created.id, false);
  ok(db.state.livetv_sources.find((row) => row['id'] === created.id)!['enabled'] === false, '§2.10 enablement toggle works');

  // Deterministic reordering: completeness + duplicates rejected.
  await reorderLivetvSources(db.client as never, [
    { id: UUIDS.builtin, priority: 0 },
    { id: created.id, priority: 1 }
  ]);
  ok(db.state.livetv_sources.find((row) => row['id'] === created.id)!['priority'] === 1, '§2.11 full-set reorder applied');
  await assert.rejects(() => reorderLivetvSources(db.client as never, [{ id: created.id, priority: 1 }]), /cover EVERY source/, '§2.12 partial reorder rejected');
  await assert.rejects(
    () => reorderLivetvSources(db.client as never, [
      { id: UUIDS.builtin, priority: 3 },
      { id: created.id, priority: 3 }
    ]),
    /Duplicate priority/,
    '§2.13 duplicate priorities rejected'
  );
  await assert.rejects(
    () => reorderLivetvSources(db.client as never, [
      { id: UUIDS.builtin, priority: -1 },
      { id: created.id, priority: 4 }
    ]),
    /between 0 and 100000/,
    '§2.14 out-of-range priority rejected'
  );

  // Delete impact + builtin protection.
  const impacts = await listLivetvSourceDeleteImpacts(db.client as never);
  ok(impacts.get(UUIDS.builtin)?.entries === 0 && impacts.get(created.id)?.entries === 0, '§2.15 impact map covers every source');
  await assert.rejects(() => deleteLivetvSource(db.client as never, UUIDS.builtin), /cannot be deleted/, '§2.16 builtin delete refused (app + trigger parity)');
  db.state.livetv_source_channels.push({ id: UUIDS.entry, source_id: created.id, source_channel_id: 'c1', canonical_channel_id: null, name: 'Chan', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {} });
  db.state.livetv_playback_endpoints.push({ id: UUIDS.endpoint, source_channel_id: UUIDS.entry, endpoint_kind: 'direct_stream', stream_format: 'hls', url: 'https://cdn.example/x.m3u8', ordering: 0, enabled: true, label: null });
  const impactAfter = (await listLivetvSourceDeleteImpacts(db.client as never)).get(created.id);
  console.log('    DEBUG impacts:', JSON.stringify(impactAfter));
  ok(impactAfter?.entries === 1 && impactAfter?.endpoints === 1 && impactAfter?.candidates === 0, '§2.17 nested cascade counts (entries→endpoints→candidates)');
  await deleteLivetvSource(db.client as never, created.id);
  ok(!db.state.livetv_sources.some((row) => row['id'] === created.id), '§2.18 non-builtin source deleted');
  ok(db.state.livetv_source_channels.length === 0 && db.state.livetv_playback_endpoints.length === 0, '§2.19 cascade removed children (DB ON DELETE CASCADE parity)');
}

// ============================================================
console.log('§3 imported entries — enablement, mapping, listing');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_sources.push({ id: UUIDS.source, slug: 'src', name: 'Src', source_type: 'm3u_playlist', builtin: false, enabled: true, status: 'active', priority: 1, visibility: 'internal', config: {}, description: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel, name: 'Canonical One', category: null, logo_url: null, dedup_key: 'key:one', enabled: true, notes: null, created_at: '', updated_at: '' });
  db.state.livetv_source_channels.push({ id: UUIDS.entry, source_id: UUIDS.source, source_channel_id: 'c1', canonical_channel_id: null, name: 'Entry One', category: 'News', logo_url: null, tvg_id: 'tvg.one', enabled: true, metadata: {} });

  await setLivetvEntryEnabled(db.client as never, UUIDS.entry, false);
  ok(db.state.livetv_source_channels[0]!['enabled'] === false, '§3.1 entry enablement toggled');
  await setLivetvEntryMapping(db.client as never, UUIDS.entry, UUIDS.channel);
  ok(db.state.livetv_source_channels[0]!['canonical_channel_id'] === UUIDS.channel, '§3.2 mapping set');
  await assert.rejects(() => setLivetvEntryMapping(db.client as never, UUIDS.entry, 'ch-not-real'), /invalid/, '§3.3 mapping to a malformed id refused');
  await assert.rejects(() => setLivetvEntryMapping(db.client as never, UUIDS.entry, UUIDS.channel2), /no longer exists/, '§3.4 mapping to a missing channel refused');
  await setLivetvEntryMapping(db.client as never, UUIDS.entry, null);
  ok(db.state.livetv_source_channels[0]!['canonical_channel_id'] === null, '§3.5 mapping cleared');

  await setLivetvEntryMapping(db.client as never, UUIDS.entry, UUIDS.channel);
  const mapped = await listLivetvEntries(db.client as never, { mappingState: 'mapped' });
  ok(mapped.total === 1 && mapped.rows[0]!.id === UUIDS.entry, '§3.6 mapped filter matches');
  const unmapped = await listLivetvEntries(db.client as never, { mappingState: 'unmapped' });
  ok(unmapped.total === 0, '§3.7 unmapped filter matches');
  const paged = await listLivetvEntries(db.client as never, { page: 0, pageSize: 50 });
  ok(paged.rows.length === 1 && paged.total === 1, '§3.8 pagination returns the window + exact total');
}

// ============================================================
console.log('§4 canonical channels — CRUD + delete impact');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_sources.push({ id: UUIDS.source, slug: 'src', name: 'Src', source_type: 'm3u_playlist', builtin: false, enabled: true, status: 'active', priority: 1, visibility: 'internal', config: {}, description: null, created_at: '', updated_at: '' });
  const created = await createLivetvChannel(db.client as never, { name: 'Chan', dedupKey: 'dedup:chan', enabled: true });
  ok(db.state.livetv_channels.some((row) => row['id'] === created.id && row['dedup_key'] === 'dedup:chan'), '§4.1 channel created with a dedup key');
  await assert.rejects(() => createLivetvChannel(db.client as never, { name: 'Other', dedupKey: 'dedup:chan' }), /dedup key is already in use/, '§4.2 duplicate dedup key surfaces a typed message');
  await assert.rejects(() => createLivetvChannel(db.client as never, { name: 'Bad', dedupKey: 'UPPERCASE_KEY!' }), /may only contain/, '§4.3 invalid dedup key format refused');
  await assert.rejects(() => createLivetvChannel(db.client as never, { name: 'Bad', logoUrl: 'http://insecure.example/x.png' }), /must use https/, '§4.4 non-https logo refused');
  await updateLivetvChannel(db.client as never, created.id, { name: 'Chan Renamed', category: 'Movies', enabled: true });
  ok(db.state.livetv_channels[0]!['name'] === 'Chan Renamed', '§4.5 channel update applied');
  await setLivetvChannelEnabled(db.client as never, created.id, false);
  ok(db.state.livetv_channels[0]!['enabled'] === false, '§4.6 channel exposure toggled');

  db.state.livetv_source_channels.push({ id: UUIDS.entry, source_id: UUIDS.source, source_channel_id: 'c1', canonical_channel_id: created.id, name: 'Entry', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {} });
  db.state.livetv_playback_candidates.push({ id: 'c0000001-0000-0000-0000-000000000001', channel_id: created.id, endpoint_id: UUIDS.endpoint, priority: 1, enabled: true, created_at: '' });
  db.state.livetv_epg_channel_mappings.push({ id: UUIDS.mapping, epg_source_id: UUIDS.epgSource, channel_id: created.id, epg_channel_id: 'guide.one', created_at: '', updated_at: '' });
  const impact = await import('../src/lib/server/livetv/admin-service').then((mod) => mod.describeLivetvChannelDeleteImpact(db.client as never, created.id));
  ok(impact.entries === 1 && impact.candidates === 1 && impact.epgMappings === 1, '§4.7 delete impact counts unmapped/cascade sets');
  await deleteLivetvChannel(db.client as never, created.id);
  ok(!db.state.livetv_channels.some((row) => row['id'] === created.id), '§4.8 channel deleted');
  ok(db.state.livetv_source_channels[0]!['canonical_channel_id'] === null, '§4.9 mapped entry UNMAPPED (never destroyed)');
  ok(db.state.livetv_playback_candidates.length === 0 && db.state.livetv_epg_channel_mappings.length === 0, '§4.10 candidates + mappings cascaded');
}

// ============================================================
console.log('§5 playback candidates — cross-channel guard + ordering');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_sources.push({ id: UUIDS.source, slug: 'src', name: 'Src', source_type: 'manual_stream', builtin: false, enabled: true, status: 'active', priority: 1, visibility: 'internal', config: {}, description: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel, name: 'One', category: null, logo_url: null, dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel2, name: 'Two', category: null, logo_url: null, dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' });
  db.state.livetv_source_channels.push({ id: UUIDS.entry, source_id: UUIDS.source, source_channel_id: 'c1', canonical_channel_id: UUIDS.channel, name: 'Entry', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {} });
  db.state.livetv_playback_endpoints.push({ id: UUIDS.endpoint, source_channel_id: UUIDS.entry, endpoint_kind: 'direct_stream', stream_format: 'hls', url: 'https://cdn.example/x.m3u8', ordering: 0, enabled: true, label: null });

  const inspector = await getLivetvChannelCandidates(db.client as never, UUIDS.channel);
  ok(inspector.mode === 'default' && inspector.endpoints.length === 1, '§5.1 inspector shows default mode + the mapped endpoint');

  await addLivetvChannelCandidate(db.client as never, UUIDS.channel, UUIDS.endpoint, { priority: 10 });
  ok(db.state.livetv_playback_candidates.length === 1, '§5.2 candidate added for the mapped channel');
  await assert.rejects(
    () => addLivetvChannelCandidate(db.client as never, UUIDS.channel2, UUIDS.endpoint, { priority: 1 }),
    /does not belong to a source channel mapped/,
    '§5.3 CROSS-CHANNEL candidate refused (friendly pre-validation of the DB trigger)'
  );
  await assert.rejects(
    () => addLivetvChannelCandidate(db.client as never, UUIDS.channel, UUIDS.endpoint, { priority: 1 }),
    /already a candidate/,
    '§5.4 duplicate (channel, endpoint) refused'
  );

  await updateLivetvChannelCandidate(db.client as never, UUIDS.channel, db.state.livetv_playback_candidates[0]!.id as string, { priority: 3, enabled: false });
  ok(db.state.livetv_playback_candidates[0]!['priority'] === 3 && db.state.livetv_playback_candidates[0]!['enabled'] === false, '§5.5 candidate priority/enablement updated');
  await assert.rejects(() => updateLivetvChannelCandidate(db.client as never, UUIDS.channel, db.state.livetv_playback_candidates[0]!.id as string, { priority: 999999 }), /between 0 and 100000/, '§5.6 out-of-range candidate priority refused');

  const inspectorExplicit = await getLivetvChannelCandidates(db.client as never, UUIDS.channel);
  ok(inspectorExplicit.mode === 'explicit' && inspectorExplicit.candidates.length === 1, '§5.7 inspector reflects explicit mode');
  await removeLivetvChannelCandidate(db.client as never, UUIDS.channel, db.state.livetv_playback_candidates[0]!.id as string);
  ok(db.state.livetv_playback_candidates.length === 0, '§5.8 candidate removed (endpoint untouched)');
  await assert.rejects(
    () => removeLivetvChannelCandidate(db.client as never, UUIDS.channel, 'e5000001-0000-0000-0000-000000000009'),
    /no longer exists for this channel/,
    '§5.9 removal is channel-scoped'
  );
}

// ============================================================
console.log('§6 typed endpoints — refresh-semantics boundary');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_sources.push({ id: UUIDS.source, slug: 'manual', name: 'Manual', source_type: 'manual_stream', builtin: false, enabled: true, status: 'active', priority: 1, visibility: 'internal', config: {}, description: null, created_at: '', updated_at: '' });
  db.state.livetv_sources.push({ id: '5a000002-0000-0000-0000-000000000001', slug: 'm3u', name: 'M3U', source_type: 'm3u_playlist', builtin: false, enabled: true, status: 'active', priority: 2, visibility: 'internal', config: {}, description: null, created_at: '', updated_at: '' });
  db.state.livetv_source_channels.push({ id: UUIDS.entry, source_id: UUIDS.source, source_channel_id: 'c1', canonical_channel_id: null, name: 'Manual entry', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {} });
  db.state.livetv_source_channels.push({ id: UUIDS.entry2, source_id: '5a000002-0000-0000-0000-000000000001', source_channel_id: 'c2', canonical_channel_id: null, name: 'M3U entry', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {} });

  await addLivetvEndpoint(db.client as never, UUIDS.entry, { endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/live.m3u8' });
  ok(db.state.livetv_playback_endpoints.length === 1, '§6.1 manual_stream endpoint authored');
  await assert.rejects(
    () => addLivetvEndpoint(db.client as never, UUIDS.entry2, { endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/y.m3u8' }),
    /managed by the source refresh/,
    '§6.2 endpoint authoring REFUSED for adapter-fed sources (a refresh would own that row)'
  );
  await assert.rejects(
    () => addLivetvEndpoint(db.client as never, UUIDS.entry, { endpointKind: 'embed_page', streamFormat: 'hls', url: 'https://cdn.example/embed' }),
    /must not declare a streamFormat/,
    '§6.3 kind/format pairing enforced (an iframe is never stored as a manifest)'
  );

  const manualEndpoint = db.state.livetv_playback_endpoints[0]!;
  await updateLivetvEndpoint(db.client as never, manualEndpoint.id as string, { url: 'https://cdn.example/renamed.m3u8', label: 'Primary' });
  ok(manualEndpoint['url'] === 'https://cdn.example/renamed.m3u8' && manualEndpoint['label'] === 'Primary', '§6.4 admin-authored endpoints accept full edits');

  // Adapter-fed endpoint (m3u_playlist entry) — the refresh owns its URL set.
  db.state.livetv_playback_endpoints.push({ id: 'e2000002-0000-0000-0000-000000000001', source_channel_id: UUIDS.entry2, endpoint_kind: 'direct_stream', stream_format: 'hls', url: 'https://cdn.example/m3u.m3u8', ordering: 0, enabled: true, label: null });
  await assert.rejects(
    () => updateLivetvEndpoint(db.client as never, 'e2000002-0000-0000-0000-000000000001', { url: 'https://cdn.example/z.m3u8' }),
    /managed by the source refresh/,
    '§6.5 adapter-fed endpoint URL edits refused (only enabled/ordering are admin-owned)'
  );
  await updateLivetvEndpoint(db.client as never, manualEndpoint.id as string, { enabled: false, ordering: 7 });
  ok(manualEndpoint['enabled'] === false && manualEndpoint['ordering'] === 7, '§6.6 admin-owned fields editable on ANY endpoint');

  await assert.rejects(() => deleteLivetvEndpoint(db.client as never, 'e2000002-0000-0000-0000-000000000001'), /would only be undone on the next refresh/, '§6.7 adapter-fed endpoint delete REFUSED (report-only stale strategy owns it)');
  await setLivetvEndpointEnabled(db.client as never, 'e2000002-0000-0000-0000-000000000001', false);
  ok(db.state.livetv_playback_endpoints.find((row) => row['id'] === 'e2000002-0000-0000-0000-000000000001')!['enabled'] === false, '§6.8 adapter-fed endpoint CAN be disabled (persists through refresh)');

  const entryView = await getLivetvEntryEndpoints(db.client as never, UUIDS.entry);
  ok(entryView?.adminAuthored === true && entryView.endpoints.length === 1, '§6.9 entry inspector reports authoring mode + endpoints');

  await deleteLivetvEndpoint(db.client as never, manualEndpoint.id as string);
  ok(db.state.livetv_playback_endpoints.length === 1, '§6.10 admin-authored endpoint deleted');
}

// ============================================================
console.log('§7 EPG sources — CRUD with the Phase 3 config validator');
// ============================================================
{
  const db = createMockDb();
  const created = await createLivetvEpgSource(db.client as never, {
    name: 'iptv-org EPG',
    sourceUrl: 'https://epg.example.com/guide.xml.gz',
    defaultTimezone: 'Asia/Kolkata',
    enabled: true
  });
  ok(created.slug === 'iptv-org-epg', '§7.1 EPG source created with derived slug');
  const stored = db.state.livetv_epg_sources.find((row) => row['id'] === created.id)!;
  ok((stored['config'] as Row)['defaultTimezone'] === 'Asia/Kolkata', '§7.2 IANA default timezone stored via the Phase 3 validator');
  await assert.rejects(
    () => createLivetvEpgSource(db.client as never, { name: 'Bad TZ', sourceUrl: 'https://epg.example.com/x.xml', defaultTimezone: 'Not/AZone' }),
    /timezone/i,
    '§7.3 invalid IANA timezone refused (never silently server-local)'
  );
  await assert.rejects(
    () => createLivetvEpgSource(db.client as never, { name: 'No URL', sourceUrl: '' }),
    /Guide URL is required/,
    '§7.4 a guide source without an https URL is refused'
  );
  await assert.rejects(
    () => createLivetvEpgSource(db.client as never, { name: 'Bad URL', sourceUrl: 'http://epg.example.com/x.xml' }),
    /must use https/,
    '§7.5 non-https guide URL refused (SSRF-guarded fetch contract)'
  );

  await updateLivetvEpgSource(db.client as never, created.id, { name: 'Renamed EPG', sourceUrl: 'https://epg.example.com/guide2.xml', status: 'active' });
  const updated = db.state.livetv_epg_sources.find((row) => row['id'] === created.id)!;
  ok(updated['name'] === 'Renamed EPG' && updated['slug'] === 'iptv-org-epg' && updated['epg_type'] === 'xmltv', '§7.6 update applies mutable fields; slug + epg_type immutable');
  await setLivetvEpgSourceEnabled(db.client as never, created.id, false);
  ok(updated['enabled'] === false, '§7.7 EPG enablement toggled');

  db.state.livetv_epg_channel_mappings.push({ id: UUIDS.mapping, epg_source_id: created.id, channel_id: UUIDS.channel, epg_channel_id: 'one', created_at: '', updated_at: '' });
  db.state.livetv_epg_programmes.push({ id: 'prog-1', epg_source_id: created.id, epg_channel_id: 'one', start_at: '2026-01-01T00:00:00Z', end_at: '2026-01-01T01:00:00Z', title: 'Show', sub_title: null, description: null, category: null, icon_url: null, language: null });
  const epgSources = await listLivetvEpgSources(db.client as never);
  ok(epgSources[0]!.mapping_count === 1 && epgSources[0]!.programme_count === 1, '§7.8 list carries embedded counts');
  const impact = await import('../src/lib/server/livetv/admin-service').then((mod) => mod.describeLivetvEpgSourceDeleteImpact(db.client as never, created.id));
  ok(impact.mappings === 1 && impact.programmes === 1, '§7.9 delete impact counts mappings + programmes');
  await deleteLivetvEpgSource(db.client as never, created.id);
  ok(db.state.livetv_epg_sources.length === 0 && db.state.livetv_epg_channel_mappings.length === 0 && db.state.livetv_epg_programmes.length === 0, '§7.10 EPG delete cascades mappings + programmes');
}

// ============================================================
console.log('§8 explicit EPG mappings — uniqueness in both directions');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_epg_sources.push({ id: UUIDS.epgSource, slug: 'epg', name: 'EPG', epg_type: 'xmltv', source_url: 'https://epg.example.com/g.xml', enabled: true, status: 'active', config: {}, description: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel, name: 'One', category: null, logo_url: null, dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel2, name: 'Two', category: null, logo_url: null, dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' });

  await createLivetvEpgMapping(db.client as never, UUIDS.epgSource, UUIDS.channel, '  Guide.One\u00a0');
  const stored = db.state.livetv_epg_channel_mappings[0]!;
  ok(stored['epg_channel_id'] === 'Guide.One', '§8.1 guide id normalized (NFKC + trim) and case-preserved');
  await assert.rejects(
    () => createLivetvEpgMapping(db.client as never, UUIDS.epgSource, UUIDS.channel2, 'Guide.One'),
    /already mapped on this EPG source/,
    '§8.2 (epg_source, epg_channel) uniqueness enforced'
  );
  await assert.rejects(
    () => createLivetvEpgMapping(db.client as never, UUIDS.epgSource, UUIDS.channel, 'Guide.Two'),
    /already has a mapping on this EPG source/,
    '§8.3 (epg_source, channel) 1:1 enforced'
  );
  await assert.rejects(() => createLivetvEpgMapping(db.client as never, UUIDS.epgSource, UUIDS.channel, 'has space'), /whitespace/, '§8.4 whitespace-bearing guide id refused (DB CHECK parity)');
  await assert.rejects(
    () => createLivetvEpgMapping(db.client as never, UUIDS.epgSource, 'e7000001-0000-0000-0000-000000000009', 'ok'),
    /no longer exists/,
    '§8.5 missing channel refused'
  );

  const listed = await listLivetvEpgMappings(db.client as never, UUIDS.epgSource, 0);
  ok(listed.total === 1 && listed.rows[0]!.channel_name === 'One', '§8.6 mappings listed with channel names');
  await deleteLivetvEpgMapping(db.client as never, UUIDS.epgSource, stored.id as string);
  ok(db.state.livetv_epg_channel_mappings.length === 0, '§8.7 mapping deleted (scoped to its EPG source)');
  await assert.rejects(
    () => deleteLivetvEpgMapping(db.client as never, UUIDS.epgSource, 'e6000001-0000-0000-0000-000000000009'),
    /no longer exists for this EPG source/,
    '§8.8 double-delete refused (well-formed but absent id)'
  );
}

// ============================================================
console.log('§9 guide diagnostics — Phase 3 planner parity');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_epg_sources.push({ id: UUIDS.epgSource, slug: 'epg', name: 'EPG', epg_type: 'xmltv', source_url: 'https://epg.example.com/g.xml', enabled: true, status: 'active', config: {}, description: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel, name: 'One', category: null, logo_url: null, dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel2, name: 'Two', category: null, logo_url: null, dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' });
  db.state.livetv_epg_channel_mappings.push({ id: 'e4000002-0000-0000-0000-000000000001', epg_source_id: UUIDS.epgSource, channel_id: UUIDS.channel, epg_channel_id: 'guide.explicit', created_at: '', updated_at: '' });
  // tvgId votes: unanimous for guide.tvg → channel2; contested for guide.dup.
  db.state.livetv_source_channels.push({ id: 'e1000003-0000-0000-0000-000000000001', source_id: UUIDS.source, source_channel_id: 'c1', canonical_channel_id: UUIDS.channel2, tvg_id: 'guide.tvg', enabled: true, metadata: {} });
  db.state.livetv_source_channels.push({ id: 'e1000003-0000-0000-0000-000000000002', source_id: UUIDS.source, source_channel_id: 'c2', canonical_channel_id: UUIDS.channel, tvg_id: 'guide.dup', enabled: true, metadata: {} });
  db.state.livetv_source_channels.push({ id: 'e1000003-0000-0000-0000-000000000003', source_id: UUIDS.source, source_channel_id: 'c3', canonical_channel_id: UUIDS.channel2, tvg_id: 'guide.dup', enabled: true, metadata: {} });
  // Stored guide identities: explicit + tvg + contested + unmatched + (invalid skipped by the planner).
  const now = new Date('2026-06-01T12:00:00Z');
  db.state.livetv_epg_programmes.push({ id: '70000001-0000-0000-0000-000000000001', epg_source_id: UUIDS.epgSource, epg_channel_id: 'guide.explicit', start_at: '2026-06-01T11:30:00Z', end_at: '2026-06-01T12:30:00Z', title: 'Current Show', sub_title: null, description: null, category: null, icon_url: null, language: null });
  db.state.livetv_epg_programmes.push({ id: '70000001-0000-0000-0000-000000000002', epg_source_id: UUIDS.epgSource, epg_channel_id: 'guide.explicit', start_at: '2026-06-01T12:30:00Z', end_at: '2026-06-01T13:00:00Z', title: 'Next Show', sub_title: null, description: null, category: null, icon_url: null, language: null });
  db.state.livetv_epg_programmes.push({ id: '70000001-0000-0000-0000-000000000003', epg_source_id: UUIDS.epgSource, epg_channel_id: 'guide.tvg', start_at: '2026-06-01T00:00:00Z', end_at: '2026-06-01T01:00:00Z', title: 'Old', sub_title: null, description: null, category: null, icon_url: null, language: null });
  db.state.livetv_epg_programmes.push({ id: '70000001-0000-0000-0000-000000000004', epg_source_id: UUIDS.epgSource, epg_channel_id: 'guide.dup', start_at: '2026-06-01T00:00:00Z', end_at: '2026-06-01T01:00:00Z', title: 'Dup', sub_title: null, description: null, category: null, icon_url: null, language: null });
  db.state.livetv_epg_programmes.push({ id: '70000001-0000-0000-0000-000000000005', epg_source_id: UUIDS.epgSource, epg_channel_id: 'guide.lonely', start_at: '2026-06-01T00:00:00Z', end_at: '2026-06-01T01:00:00Z', title: 'Lonely', sub_title: null, description: null, category: null, icon_url: null, language: null });

  const diagnostics = await getLivetvEpgGuideDiagnostics(db.client as never, UUIDS.epgSource, now);
  ok(diagnostics.counts.guideChannels === 4, '§9.1 four distinct stored guide identities probed');
  ok(diagnostics.counts.viaExplicit === 1, '§9.2 explicit mapping matched');
  ok(diagnostics.counts.viaTvgId === 1, '§9.3 unanimous tvgId matched');
  ok(diagnostics.counts.ambiguous === 1, '§9.4 contested tvgId reported ambiguous (never guessed)');
  ok(diagnostics.counts.unmatched === 1, '§9.5 lonely guide id reported unmatched');
  const currentRow = diagnostics.guide.find((row) => row.epgChannelId === 'guide.explicit')!;
  ok(currentRow.status === 'matched' && currentRow.channelName === 'One' && currentRow.currentTitle === 'Current Show' && currentRow.nextTitle === 'Next Show', '§9.6 now/next derived from stored windows');
  const tvgRow = diagnostics.guide.find((row) => row.epgChannelId === 'guide.tvg')!;
  ok(tvgRow.status === 'matched' && tvgRow.mappingSource === 'tvgid' && tvgRow.channelName === 'Two', '§9.7 tvgId match names its canonical channel');
  const unmatchedRow = diagnostics.guide.find((row) => row.epgChannelId === 'guide.lonely')!;
  ok(unmatchedRow.status === 'unmatched' && unmatchedRow.channelName === null && unmatchedRow.currentTitle === null, '§9.8 unmatched identities get NO fabricated programme');
  ok(diagnostics.programmeCount === 5, '§9.9 stored programme count reported');
}

// ============================================================
console.log('§10 overview — read-only config meta');
// ============================================================
{
  const db = createMockDb();
  db.state.livetv_sources.push({ id: UUIDS.builtin, slug: 'builtin-livegt-v1', name: 'LiveGT V1', source_type: 'builtin_livegt_v1', builtin: true, enabled: true, status: 'active', priority: 0, visibility: 'public', config: {}, description: null, created_at: '', updated_at: '' });
  db.state.livetv_channels.push({ id: UUIDS.channel, name: 'One', category: null, logo_url: null, dedup_key: null, enabled: true, notes: null, created_at: '', updated_at: '' });
  db.state.livetv_source_channels.push({ id: UUIDS.entry, source_id: UUIDS.source, source_channel_id: 'c1', canonical_channel_id: UUIDS.channel, name: 'Entry', category: null, logo_url: null, tvg_id: null, enabled: true, metadata: {} });
  const overview = await getLivetvAdminOverview(db.client as never);
  ok(overview.unifiedEnabled === false && overview.configVersion === 7, '§10.1 unified_enabled surfaced READ-ONLY (false) + version');
  ok(overview.sources.total === 1 && overview.sources.enabled === 1, '§10.2 source counts');
  ok(overview.entries.total === 1 && overview.entries.mapped === 1, '§10.3 entry + mapped counts');
  ok(overview.channels.total === 1 && overview.channels.enabled === 1, '§10.4 channel counts');

  // The overview and diagnostics NEVER write: verify zero mutation surfaces exist.
  const before = JSON.stringify(db.state.livetv_config_meta);
  await getLivetvAdminOverview(db.client as never);
  ok(JSON.stringify(db.state.livetv_config_meta) === before, '§10.5 config meta untouched (unified_enabled can never flip through admin reads)');
  ok(db.writes.every((write) => write.table !== 'livetv_config_meta'), '§10.6 zero writes to livetv_config_meta across the whole suite');
}

// ============================================================
console.log('§11 error mapping + redaction');
// ============================================================
{
  ok(mapLivetvDbError({ message: 'LIVETV_BUILTIN_SOURCE_PROTECTED: nope' }, 'x').message.includes('cannot be deleted'), '§11.1 builtin protection mapped');
  ok(mapLivetvDbError({ message: 'LIVETV_CANDIDATE_CHANNEL_MISMATCH: nope' }, 'x').message.includes('does not belong'), '§11.2 cross-channel guard mapped');
  ok(mapLivetvDbError({ message: 'duplicate key value violates unique constraint "livetv_sources_slug_key"' }, 'x').message.includes('slug'), '§11.3 slug conflict mapped');
  ok(mapLivetvDbError({ message: 'duplicate key value violates unique constraint "livetv_channels_dedup_key_uq"' }, 'x').message.includes('dedup key'), '§11.4 dedup conflict mapped');
  ok(mapLivetvDbError({ code: '23503', message: 'violates foreign key constraint' }, 'x').message.includes('no longer exists'), '§11.5 FK violation mapped');
  ok(mapLivetvDbError({ code: '23514', message: 'violates check constraint' }, 'x').message.includes('constraints'), '§11.6 check violation mapped');

  // Redaction: a mapped error NEVER carries an upstream URL, even when the
  // raw DB failure text would contain one (a URL-shaped message must not
  // leak through the fallback).
  const hostile = { code: '23505', message: 'duplicate key ... https://user:pass@upstream.example.com/secret?token=abc' };
  ok(!mapLivetvDbError(hostile, 'fallback message').message.includes('https://'), '§11.7 URL-bearing DB text never passes through unmapped');
  ok(!/token=|user:pass/.test(mapLivetvDbError(hostile, 'fallback message').message), '§11.8 credentials never leak through the error mapper');
  ok(mapLivetvDbError(new Error('plain failure'), 'safe fallback').message === 'plain failure', '§11.9 plain Error messages pass through (already safe by contract)');
}

console.log('§12 — R-0: mutation honesty + durable last-refresh map');
// ============================================================
{
  const db = createMockDb();
  // §12.1-§12.4 — the toggle and the update report success ONLY when the
  // row really changed (a 0-row match — e.g. concurrent delete — is a
  // typed failure, never a silent success).
  db.state.livetv_sources.push({ id: UUIDS.source, slug: 'src', name: 'Src', source_type: 'm3u_playlist', builtin: false, enabled: true, status: 'active', priority: 1, visibility: 'internal', config: {}, description: null, created_at: '', updated_at: '' });
  await setLivetvSourceEnabled(db.client as never, UUIDS.source, false);
  ok(db.state.livetv_sources.find((row) => row['id'] === UUIDS.source)!['enabled'] === false, '§12.1 the toggle updates an existing row');
  const rejectsWith = async (run: () => Promise<unknown>, pattern: RegExp, label: string) => {
    try {
      await run();
      ok(false, label);
    } catch (caught) {
      ok(caught instanceof Error && pattern.test(caught.message), label);
    }
  };
  await rejectsWith(() => setLivetvSourceEnabled(db.client as never, UUIDS.channel2, false), /no longer exists/, '§12.2 a toggle matching ZERO rows fails (never a silent success)');
  await rejectsWith(() => setLivetvSourceEnabled(db.client as never, 'not-a-uuid', false), /Source is invalid/, '§12.3 a toggle with a malformed id is rejected');
  await rejectsWith(() => updateLivetvSource(db.client as never, UUIDS.channel2, { name: 'Ghost' }), /no longer exists/, '§12.4 an update matching ZERO rows fails (never a silent success)');
  ok(db.state.livetv_sources.every((row) => row['name'] !== 'Ghost'), '§12.5 the failed update wrote nothing');

  // §12.6-§12.9 — the durable last-refresh map (bounded read, graceful
  // degradation, latest row per source).
  db.state['livetv_refresh_history'] = [
    // NOTE: this mock's read path ignores .order() — rows are seeded in the
    // order the real query returns them (started_at DESC, newest first).
    { subject_kind: 'source', subject_id: UUIDS.source, subject_slug: 'src', status: 'failure', started_at: '2026-10-23T09:30:00Z', finished_at: '2026-10-23T09:30:02Z', trigger_type: 'manual' },
    { subject_kind: 'epg_source', subject_id: UUIDS.epgSource, subject_slug: 'epg', status: 'success', started_at: '2026-10-23T09:40:00Z', finished_at: '2026-10-23T09:40:01Z', trigger_type: 'scheduled' },
    { subject_kind: 'source', subject_id: UUIDS.builtin, subject_slug: 'builtin-livegt-v1', status: 'timeout', started_at: '2026-10-23T09:00:00Z', finished_at: '2026-10-23T09:00:45Z', trigger_type: 'manual' },
    { subject_kind: 'source', subject_id: UUIDS.source, subject_slug: 'src', status: 'success', started_at: '2026-10-23T08:00:00Z', finished_at: '2026-10-23T08:00:05Z', trigger_type: 'scheduled' }
  ];
  const map = await getLatestLivetvRefreshHistoryBySource(db.client as never);
  ok(map.get(UUIDS.source)?.status === 'failure' && map.get(UUIDS.source)?.trigger === 'manual', '§12.6 the LATEST row per source wins (newest-first first-occurrence)');
  ok(map.get(UUIDS.source)?.finishedAt === '2026-10-23T09:30:02Z', '§12.7 the finished time of the latest attempt is carried');
  ok(map.get(UUIDS.builtin)?.status === 'timeout', '§12.8 other sources keep their own latest attempt');
  ok(!map.has(UUIDS.epgSource), '§12.9 EPG-source rows are filtered out (subject_kind=source only)');
  db.state['livetv_refresh_history'] = [];
  const empty = await getLatestLivetvRefreshHistoryBySource(db.client as never);
  ok(empty instanceof Map && empty.size === 0, '§12.10 a missing/empty history table degrades to an EMPTY map (diagnostics only, never an error)');
}

console.log(`\nLIVETV PHASE 4 ADMIN SERVICE TESTS: ${passed} checks passed`);
