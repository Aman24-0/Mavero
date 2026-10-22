/**
 * UNIFIED LIVE TV — Phase 3 EPG pipeline verification (mapping, ingestion,
 * retention, refresh service, guide queries).
 *
 * Covers the Phase 3 brief §12 items:
 *  13  correct mapping by tvgId
 *  14  missing / unmatched / ambiguous / overridden (explicit) mappings
 *  15  idempotent repeated ingestion (zero writes on re-run)
 *  16  failed refresh preserves the last good guide
 *  17  malformed single-record isolation (one bad record never fails the source)
 *  18  bounded retention never deletes current/upcoming programmes
 *  19  current/upcoming helper boundary conditions (explicit clock)
 *  21  safe diagnostics + redaction (no URLs/XML/credentials in outcomes)
 *  22  existing LiveGT guide helper + embed fallback regression checks
 *
 * NO real network (injected fetchers), NO real database (mock client with
 * REAL uniqueness enforcement — the same convention as the Phase 2 suite).
 */

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import { planEpgMapping, type EpgMappingRow, type EpgSourceChannelRow } from '../src/lib/server/livetv/epg/mapping';
import { applyGuideIngestion, planGuideIngestion, type ExistingEpgProgrammeRow } from '../src/lib/server/livetv/epg/ingestion';
import { applyEpgRetention, EPG_RETENTION_PAST_MS } from '../src/lib/server/livetv/epg/retention';
import {
  refreshLivetvEpgSource,
  refreshAllEligibleLivetvEpgSources,
  previewLivetvEpgSource,
  getLivetvEpgRefreshOutcomes,
  resetLivetvEpgStateForTests,
  validateEpgSourceConfig
} from '../src/lib/server/livetv/epg/guide-service';
import { getCurrentEpgProgramme, getUpcomingEpgProgrammes } from '../src/lib/server/livetv/epg/queries';
import { LivetvSourceFetchError } from '../src/lib/server/livetv/fetch-safe';
import { determineCurrentProgramme } from '../src/lib/client/live-tv/epg';

// ---------------------------------------------------------------------------
// Mock supabase-js subset with REAL uniqueness enforcement
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function createMockDb() {
  const state: Record<string, Row[]> = {
    livetv_epg_sources: [],
    livetv_epg_channel_mappings: [],
    livetv_epg_programmes: [],
    livetv_source_channels: [],
    livetv_sources: []
  };
  const writes: { table: string; op: string; payload?: Row; count?: number }[] = [];
  const deletes: { table: string; ids: string[] }[] = [];
  const forcedUpsertFailures: { table: string; matchChannelId?: string; message: string }[] = [];
  let uuidCounter = 0;
  const nextId = () => `gen-${(uuidCounter += 1).toString().padStart(4, '0')}`;

  function applyFilters(rows: Row[], filters: [string, string, unknown][]): Row[] {
    return rows.filter((row) =>
      filters.every(([col, op, val]) => {
        const left = row[col];
        switch (op) {
          case 'eq':
            return left === val;
          case 'neq':
            return left !== val;
          case 'in':
            return (val as unknown[]).includes(left);
          // ISO-8601 UTC strings of identical shape compare lexicographically.
          case 'gte':
            return String(left) >= String(val);
          case 'lte':
            return String(left) <= String(val);
          case 'gt':
            return String(left) > String(val);
          case 'lt':
            return String(left) < String(val);
          default:
            return false;
        }
      })
    );
  }

  function makeBuilder(table: string) {
    const filters: [string, string, unknown][] = [];
    const orders: [string, boolean][] = [];
    let limitN: number | null = null;
    const builder = {
      select(_cols?: string) {
        return this;
      },
      eq(col: string, val: unknown) {
        filters.push([col, 'eq', val]);
        return this;
      },
      neq(col: string, val: unknown) {
        filters.push([col, 'neq', val]);
        return this;
      },
      in(col: string, vals: unknown[]) {
        filters.push([col, 'in', vals]);
        return this;
      },
      gte(col: string, val: unknown) {
        filters.push([col, 'gte', val]);
        return this;
      },
      lte(col: string, val: unknown) {
        filters.push([col, 'lte', val]);
        return this;
      },
      gt(col: string, val: unknown) {
        filters.push([col, 'gt', val]);
        return this;
      },
      lt(col: string, val: unknown) {
        filters.push([col, 'lt', val]);
        return this;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push([col, opts?.ascending !== false]);
        return this;
      },
      limit(n: number) {
        limitN = n;
        return this;
      },
      upsert(payload: Row | Row[], _opts?: { onConflict?: string }) {
        const rows = Array.isArray(payload) ? payload : [payload];
        const self = this;
        return {
          then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) {
            (async () => {
              const forced = forcedUpsertFailures.find((f) => f.table === table);
              if (forced) {
                const hit = rows.some((r) => !forced.matchChannelId || r['epg_channel_id'] === forced.matchChannelId);
                if (hit) return { data: null, error: { message: forced.message } };
              }
              for (const row of rows) {
                const dupIndex = state[table].findIndex(
                  (existing) => existing['epg_source_id'] === row['epg_source_id'] && existing['epg_channel_id'] === row['epg_channel_id'] && existing['start_at'] === row['start_at'] && existing['end_at'] === row['end_at']
                );
                if (dupIndex >= 0) {
                  state[table][dupIndex] = { ...state[table][dupIndex], ...row };
                } else {
                  state[table].push({ ...row, id: nextId(), created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() });
                }
                writes.push({ table, op: 'upsert', payload: row });
              }
              return { data: rows, error: null };
            })().then(resolve, reject);
          }
        };
      },
      delete() {
        return {
          in(col: string, ids: string[]) {
            filters.push([col, 'in', ids]);
            return this;
          },
          eq(col: string, val: unknown) {
            filters.push([col, 'eq', val]);
            return this;
          },
          then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) {
            (async () => {
              const doomed = applyFilters(state[table], filters);
              const ids = doomed.map((row) => String(row['id']));
              if (ids.length > 0) {
                const idSet = new Set(ids);
                state[table] = state[table].filter((row) => !idSet.has(String(row['id'])));
                deletes.push({ table, ids });
                writes.push({ table, op: 'delete', count: ids.length });
              }
              return { data: null, error: null };
            })().then(resolve, reject);
          }
        };
      },
      async maybeSingle() {
        const rows = applyFilters(state[table], filters);
        return { data: rows[0] ?? null, error: null };
      },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) {
        (async () => {
          let rows = applyFilters(state[table], filters);
          for (const [col, ascending] of [...orders].reverse()) {
            rows = [...rows].sort((a, b) => {
              const av = String(a[col]);
              const bv = String(b[col]);
              return av === bv ? 0 : av < bv === ascending ? -1 : 1;
            });
          }
          if (limitN !== null) rows = rows.slice(0, limitN);
          return { data: rows, error: null };
        })().then(resolve, reject);
      }
    };
    return builder;
  }

  return {
    state,
    writes,
    deletes,
    forcedUpsertFailures,
    from(table: string) {
      return makeBuilder(table);
    }
  };
}

type MockDb = ReturnType<typeof createMockDb>;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 10, 0, 0, 0); // 2026-01-10T00:00:00Z
const HOUR = 3_600_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function guideXml(programmes: string, channels = '<channel id="ch.1"><display-name>One</display-name></channel><channel id="ch.2"><display-name>Two</display-name></channel>'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><tv>${channels}${programmes}</tv>`;
}

function prog(channelId: string, startMs: number, endMs: number, title: string, extra = ''): string {
  const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, ' +0000');
  return `<programme start="${stamp(startMs)}" stop="${stamp(endMs)}" channel="${channelId}"><title>${title}</title>${extra}</programme>`;
}

function okResponse(body: Buffer | string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

/** Public unblocked DNS answers so the stage-2 guard passes for fixture hosts. */
const SAFE_RESOLVER = async () => [{ address: '93.184.216.34', family: 4 }] as const;

function seedEpgSource(db: MockDb, overrides: Partial<Row> = {}): Row {
  const row = {
    id: 'epg-1',
    slug: 'guide-1',
    epg_type: 'xmltv',
    enabled: true,
    status: 'active',
    config: {},
    source_url: 'https://guides.example/guide.xml',
    ...overrides
  };
  db.state.livetv_epg_sources.push(row);
  return row;
}

function existingRow(overrides: Partial<ExistingEpgProgrammeRow> = {}): ExistingEpgProgrammeRow {
  return {
    id: 'p-1',
    epg_source_id: 'epg-1',
    epg_channel_id: 'ch.1',
    startMs: T0,
    endMs: T0 + HOUR,
    title: 'Show A',
    sub_title: null,
    description: null,
    category: null,
    icon_url: null,
    language: null,
    ...overrides
  };
}

// ===========================================================================
console.log('§1/§2/§13/§14 — mapping plan (pure)');
// ===========================================================================
{
  const sourceChannels: EpgSourceChannelRow[] = [
    { id: 's1', source_id: 'src-a', source_channel_id: 'a1', canonical_channel_id: 'can-1', tvg_id: 'ch.1', enabled: true },
    { id: 's2', source_id: 'src-b', source_channel_id: 'b1', canonical_channel_id: 'can-5', tvg_id: 'CH.1', enabled: true }, // case-different = a DIFFERENT identity (resolves to its own channel)
    { id: 's3', source_id: 'src-c', source_channel_id: 'c1', canonical_channel_id: 'can-2', tvg_id: 'ch.2', enabled: true },
    { id: 's4', source_id: 'src-d', source_channel_id: 'd1', canonical_channel_id: 'can-3', tvg_id: 'ch.2', enabled: true }, // ambiguity: can-2 vs can-3
    { id: 's5', source_id: 'src-e', source_channel_id: 'e1', canonical_channel_id: null, tvg_id: 'ch.9', enabled: true }, // unmapped: never votes
    { id: 's6', source_id: 'src-f', source_channel_id: 'f1', canonical_channel_id: 'can-4', tvg_id: ' ch.4 ', enabled: true } // stored verbatim; normalized match
  ];
  const mappings: EpgMappingRow[] = [
    { epg_channel_id: 'ch.explicit', channel_id: 'can-x' },
    { epg_channel_id: ' ch.norm ', channel_id: 'can-y' }
  ];

  const plan = planEpgMapping({
    guideChannelIds: ['ch.1', 'ch.2', 'ch.explicit', 'ch.norm', 'ch.9', 'ch.missing', 'bad id', 'CH.1'],
    explicitMappings: mappings,
    sourceChannels
  });

  ok(plan.matches.get('ch.explicit')?.status === 'matched' && plan.matches.get('ch.explicit')?.source === 'explicit', '§14 explicit override matches exactly (authoritative)');
  ok(plan.matches.get('ch.explicit')?.channelId === 'can-x', '§14 explicit override resolves the mapped canonical channel');
  ok(plan.matches.get('ch.norm')?.status === 'matched' && plan.matches.get('ch.norm')?.channelId === 'can-y', '§14 explicit mapping matches after safe normalization (trim)');

  ok(plan.matches.get('ch.1')?.status === 'matched' && plan.matches.get('ch.1')?.channelId === 'can-1', '§13 tvgId match: unanimous mapped entries resolve the canonical channel');
  ok(plan.matches.get('CH.1')?.status === 'matched' && plan.matches.get('CH.1')?.channelId === 'can-5', '§14 case differences NEVER merge (CH.1 resolves to its OWN channel, not ch.1\'s)');

  ok(plan.matches.get('ch.2')?.status === 'ambiguous', '§14 entries mapped to different canonical channels → ambiguous, never guessed');
  ok(plan.matches.get('ch.9')?.status === 'unmatched', '§14 unmapped entries never vote; the guide id stays unmatched');
  ok(plan.matches.get('ch.missing')?.status === 'unmatched', '§14 missing guide id → honest unmatched');

  ok(plan.matches.get('bad id')?.status === 'invalid', '§14 whitespace-bearing id reported as invalid');
  ok(plan.counts.matched === 4 && plan.counts.viaExplicit === 2 && plan.counts.viaTvgId === 2, '§14 counts honest (matched = explicit + tvgId)');
  ok(plan.counts.ambiguous === 1 && plan.counts.unmatched === 2 && plan.counts.invalid === 1, '§14 ambiguity/unmatched/invalid counts honest');
  ok(plan.samples.unmatched.includes('ch.missing') && plan.samples.ambiguous.includes('ch.2'), '§14 bounded samples collected');

  // Display names are NEVER identity.
  const namePlan = planEpgMapping({ guideChannelIds: ['some-other-name'], explicitMappings: [], sourceChannels: [{ id: 's9', source_id: 'src', source_channel_id: 'x', canonical_channel_id: 'can-1', tvg_id: null, enabled: true }] });
  ok(namePlan.matches.get('some-other-name')?.status === 'unmatched', '§14 a guide id never matches by display-name similarity');
}

// ===========================================================================
console.log('§15 — ingestion plan + executor idempotency (mock DB)');
// ===========================================================================
{
  const programmes = [
    { channelId: 'ch.1', startMs: T0, endMs: T0 + HOUR, title: 'Show A', subTitle: null, description: null, category: null, iconUrl: null, language: null, timeResolution: 'explicit_offset' as const },
    { channelId: 'ch.1', startMs: T0 + HOUR, endMs: T0 + 2 * HOUR, title: 'Show B', subTitle: null, description: null, category: null, iconUrl: null, language: null, timeResolution: 'explicit_offset' as const }
  ];

  // First import — everything inserts.
  const plan1 = planGuideIngestion({ epgSourceId: 'epg-1', programmes, existingRows: [] });
  ok(plan1.counts.inserted === 2 && plan1.counts.unchanged === 0, '§15 first import plans inserts');
  ok(plan1.upserts.every((row) => row.epg_source_id === 'epg-1'), '§15 every planned write carries its source id');
  const writeKeySet = Object.keys(plan1.upserts[0]!).sort().join(',');
  ok(writeKeySet === 'category,description,end_at,epg_channel_id,epg_source_id,icon_url,language,start_at,sub_title,title', '§15 write payload key set is exactly the source-derived columns (no admin-owned fields exist)');

  const db = createMockDb();
  const exec1 = await applyGuideIngestion(db as never, plan1);
  ok(exec1.appliedWrites === 2 && exec1.errors.length === 0, '§15 executor applies the first import');
  ok(db.state.livetv_epg_programmes.length === 2, '§15 rows persisted');

  // Second import of IDENTICAL input — zero writes.
  const existing: ExistingEpgProgrammeRow[] = db.state.livetv_epg_programmes.map((row) => ({
    id: String(row['id']),
    epg_source_id: String(row['epg_source_id']),
    epg_channel_id: String(row['epg_channel_id']),
    startMs: Date.parse(String(row['start_at'])),
    endMs: Date.parse(String(row['end_at'])),
    title: String(row['title']),
    sub_title: (row['sub_title'] as string | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    category: (row['category'] as string | null) ?? null,
    icon_url: (row['icon_url'] as string | null) ?? null,
    language: (row['language'] as string | null) ?? null
  }));
  const plan2 = planGuideIngestion({ epgSourceId: 'epg-1', programmes, existingRows: existing });
  ok(plan2.counts.unchanged === 2 && plan2.upserts.length === 0, '§15 repeat import of unchanged input plans ZERO writes (idempotent)');
  const writesBefore = db.writes.length;
  await applyGuideIngestion(db as never, plan2);
  ok(db.writes.length === writesBefore, '§15 executor performs zero writes for an unchanged plan');

  // A title correction → exactly one update.
  const corrected = programmes.map((p) => (p.title === 'Show A' ? { ...p, title: 'Show A (corrected)' } : p));
  const plan3 = planGuideIngestion({ epgSourceId: 'epg-1', programmes: corrected, existingRows: existing });
  ok(plan3.counts.updated === 1 && plan3.counts.unchanged === 1, '§15 changed field plans exactly one update');

  // Defensive skip of an invalid record (parser already gates these).
  const invalid = [{ ...programmes[0]!, startMs: T0 + 5 * HOUR, endMs: T0 + HOUR, title: 'Backwards' }];
  const plan4 = planGuideIngestion({ epgSourceId: 'epg-1', programmes: invalid, existingRows: [] });
  ok(plan4.counts.skipped === 1 && plan4.upserts.length === 0, '§15 an invalid window is skipped, never written');

  // Missing upstream is report-only.
  const partial = [programmes[0]!];
  const plan5 = planGuideIngestion({ epgSourceId: 'epg-1', programmes: partial, existingRows: existing });
  ok(plan5.programmesMissingUpstream === 1 && plan5.upserts.length === 0, '§15 an upstream-omitted row is counted report-only (never deleted/disabled)');
}

// ===========================================================================
console.log('§15b — executor error isolation (forced batch failure)');
// ===========================================================================
{
  const plan = planGuideIngestion({
    epgSourceId: 'epg-1',
    programmes: [
      { channelId: 'ch.a', startMs: T0, endMs: T0 + HOUR, title: 'A', subTitle: null, description: null, category: null, iconUrl: null, language: null, timeResolution: 'explicit_offset' as const },
      { channelId: 'ch.bad', startMs: T0 + HOUR, endMs: T0 + 2 * HOUR, title: 'Bad', subTitle: null, description: null, category: null, iconUrl: null, language: null, timeResolution: 'explicit_offset' as const },
      { channelId: 'ch.c', startMs: T0 + 2 * HOUR, endMs: T0 + 3 * HOUR, title: 'C', subTitle: null, description: null, category: null, iconUrl: null, language: null, timeResolution: 'explicit_offset' as const }
    ],
    existingRows: []
  });
  const db = createMockDb();
  db.forcedUpsertFailures.push({ table: 'livetv_epg_programmes', matchChannelId: 'ch.bad', message: 'duplicate key value violates unique constraint "livetv_epg_programmes_epg_source_id_epg_channel_id_start_at_end_at_key"' });
  const result = await applyGuideIngestion(db as never, plan);
  ok(result.appliedWrites === 2 && result.errors.length === 1, '§15b a failing row is isolated; the rest of the batch survives');
  ok(result.errors[0]!.message.includes('unique constraint'), '§15b the DB error message (constraint name only) is reported');
  ok(db.state.livetv_epg_programmes.length === 2, '§15b only the healthy rows persisted');
}

// ===========================================================================
console.log('§16 — refresh service: eligibility, config, failure taxonomy');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();

  // Not found.
  const notFound = await refreshLivetvEpgSource(db as never, { id: 'missing' });
  ok(notFound.ok === false && notFound.failure?.kind === 'epg_source_not_found', '§16 unknown guide source → typed not-found');

  // Ineligible: disabled.
  seedEpgSource(db, { id: 'epg-off', slug: 'guide-off', enabled: false });
  const disabled = await refreshLivetvEpgSource(db as never, { id: 'epg-off' });
  ok(disabled.ok === false && disabled.failure?.kind === 'epg_source_ineligible', '§16 disabled guide source is never refreshed');

  // Ineligible: unavailable status.
  seedEpgSource(db, { id: 'epg-un', slug: 'guide-un', status: 'unavailable' });
  const unavailable = await refreshLivetvEpgSource(db as never, { id: 'epg-un' });
  ok(unavailable.ok === false && unavailable.failure?.kind === 'epg_source_ineligible', '§16 unavailable status is never refreshed');

  // Invalid config: unknown key.
  seedEpgSource(db, { id: 'epg-cfg', slug: 'guide-cfg', config: { defaultTimezone: 'UTC', secret: 'x' } });
  const badConfig = await refreshLivetvEpgSource(db as never, { id: 'epg-cfg' });
  ok(badConfig.ok === false && badConfig.failure?.kind === 'invalid_source_config', '§16 unknown config key rejected (no credential field can hide)');
  seedEpgSource(db, { id: 'epg-tz', slug: 'guide-tz', config: { defaultTimezone: 'Not/AZone' } });
  const badTz = await refreshLivetvEpgSource(db as never, { id: 'epg-tz' });
  ok(badTz.ok === false && badTz.failure?.kind === 'invalid_source_config', '§16 a non-IANA timezone is rejected at the config boundary');

  // Config validator direct checks.
  ok(validateEpgSourceConfig({}).defaultTimezone === undefined, '§16 empty config valid');
  ok(validateEpgSourceConfig({ defaultTimezone: 'Asia/Kolkata' }).defaultTimezone === 'Asia/Kolkata', '§16 valid IANA timezone accepted');
  ok(validateEpgSourceConfig(null).defaultTimezone === undefined, '§16 null config accepted (jsonb default shape)');
  let cfgFailed = false;
  try {
    validateEpgSourceConfig({ defaultTimezone: 42 });
  } catch {
    cfgFailed = true;
  }
  ok(cfgFailed, '§16 non-string timezone rejected');

  // Missing/unsafe URL.
  seedEpgSource(db, { id: 'epg-nourl', slug: 'guide-nourl', source_url: null });
  const noUrl = await refreshLivetvEpgSource(db as never, { id: 'epg-nourl' });
  ok(noUrl.ok === false && noUrl.failure?.kind === 'invalid_url', '§16 missing source URL → typed invalid_url');

  // https-only re-assertion on the guide fetch path.
  seedEpgSource(db, { id: 'epg-http', slug: 'guide-http', source_url: 'http://guides.example/guide.xml' });
  const httpOutcome = await refreshLivetvEpgSource(db as never, { id: 'epg-http' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse('<tv></tv>', 'application/xml') });
  ok(httpOutcome.ok === false && httpOutcome.failure?.kind === 'invalid_url', '§16 non-https guide URL rejected before any fetch');
}

// ===========================================================================
console.log('§16b — refresh: guarded-fetch failure taxonomy');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();
  seedEpgSource(db);

  const timeout = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => { throw new LivetvSourceFetchError('timeout', 'The source request exceeded its time budget.'); } });
  ok(timeout.ok === false && timeout.failure?.kind === 'timeout', '§16b fetch timeout → typed timeout outcome');
  const blocked = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => { throw new LivetvSourceFetchError('blocked_url', 'The source URL points at a network location that is not allowed.'); } });
  ok(blocked.ok === false && blocked.failure?.kind === 'blocked_url', '§16b blocked target → typed blocked_url outcome');
  const httpErr = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => new Response('nope', { status: 500 }) });
  ok(httpErr.ok === false && httpErr.failure?.kind === 'http_error', '§16b HTTP error status → typed http_error outcome');

  // Document-level failures (zero writes, last guide untouched).
  const badXml = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse('<html><body>error page</body></html>', 'text/html') });
  ok(badXml.ok === false && badXml.failure?.kind === 'unsupported_media_type', '§16b an HTML page is rejected by the fetch gate (never a guide document)');
  const badEncoding = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse('<?xml version="1.0" encoding="ISO-8859-1"?><tv></tv>', 'application/xml') });
  ok(badEncoding.ok === false && badEncoding.failure?.kind === 'unsupported_encoding', '§16b a non-UTF-8 declaration is refused (never misread)');

  ok(db.writes.length === 0, '§16b no failed refresh wrote anything');
}

// ===========================================================================
console.log('§17 — happy-path refresh (gzip + plain), counts + mapping report');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();
  seedEpgSource(db, { config: { defaultTimezone: 'UTC' } });
  db.state.livetv_source_channels.push(
    { id: 's1', source_id: 'src-a', source_channel_id: 'a1', canonical_channel_id: 'can-1', tvg_id: 'ch.1', enabled: true },
    { id: 's2', source_id: 'src-a', source_channel_id: 'a2', canonical_channel_id: null, tvg_id: 'ch.ghost', enabled: true }
  );
  db.state.livetv_epg_channel_mappings.push({ id: 'm1', epg_source_id: 'epg-1', channel_id: 'can-2', epg_channel_id: 'ch.2' });

  const xml = guideXml(
    prog('ch.1', T0, T0 + HOUR, 'Show A') +
      prog('ch.1', T0 + HOUR, T0 + 2 * HOUR, 'Show B') +
      prog('ch.2', T0, T0 + HOUR, 'Explicit Guide Show') +
      prog('ch.ghost', T0, T0 + HOUR, 'Unmatched Show') +
      prog('ch.1', T0 + 9 * HOUR, T0 + 8 * HOUR, 'Reversed Window')
  );
  const gz = gzipSync(Buffer.from(xml, 'utf8'));

  const outcome = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER,
    fetcher: async () => okResponse(gz, 'application/gzip'),
    retention: false
  });

  ok(outcome.ok === true && outcome.failure === null, '§17 gzip guide refresh succeeds');
  ok(outcome.counts!.programmesDiscovered === 5, '§17 all programmes discovered');
  ok(outcome.counts!.programmesInserted === 4, '§17 four healthy programmes inserted');
  ok(outcome.counts!.programmesSkipped === 1, '§17 the reversed window is a per-record skip (single-record isolation)');
  ok(outcome.counts!.programmesSkippedInvalid === 0 && outcome.counts!.programmesFailed === 0, '§17 no invalid writes, no failed writes');
  ok(outcome.counts!.channelsMatched === 2 && outcome.counts!.channelsMatchedTvgId === 1 && outcome.counts!.channelsMatchedExplicit === 1 && outcome.counts!.channelsUnmatched === 1, '§17 mapping diagnostics: tvgId + explicit + unmatched counted');
  ok(outcome.mappingSamples!.unmatched.includes('ch.ghost'), '§17 unmatched guide id reported (bounded sample)');
  ok(outcome.timezonePolicy!.configured === 'UTC', '§17 timezone policy reported');
  ok(db.state.livetv_epg_programmes.length === 4, '§17 programme rows persisted');

  // Idempotent second refresh of the SAME guide (plain XML this time).
  const writesBefore = db.writes.length;
  const outcome2 = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER,
    fetcher: async () => okResponse(xml, 'application/xml'),
    retention: false
  });
  ok(outcome2.ok === true && outcome2.counts!.programmesUnchanged === 4 && outcome2.counts!.programmesInserted === 0 && outcome2.counts!.programmesUpdated === 0, '§17 repeat refresh: every record unchanged');
  ok(db.writes.length === writesBefore, '§17 repeat refresh performed ZERO writes');
  ok(db.state.livetv_epg_programmes.length === 4, '§17 no duplicate rows after repeat import');

  // The refresh never mutates the EPG source row or the mapping table.
  ok(!db.writes.some((w) => w.table === 'livetv_epg_sources'), '§17 no write ever touches the guide source row');
  ok(!db.writes.some((w) => w.table === 'livetv_epg_channel_mappings'), '§17 no write ever touches channel mappings');
  ok(!db.writes.some((w) => w.table === 'livetv_source_channels' || w.table === 'livetv_sources'), '§17 no write ever touches channel/source registry tables');
}

// ===========================================================================
console.log('§16c — failed refresh preserves the last good guide');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();
  seedEpgSource(db);
  const xml = guideXml(prog('ch.1', T0, T0 + HOUR, 'Show A'));
  const good = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse(xml, 'application/xml'), retention: false });
  ok(good.ok === true && db.state.livetv_epg_programmes.length === 1, '§16c first refresh stores the good guide');

  // The upstream dies — outcome fails, the stored guide survives untouched.
  const failed = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => { throw new LivetvSourceFetchError('network', 'The source request failed at the network layer.'); }, retention: false });
  ok(failed.ok === false && failed.counts === null, '§16c a failed refresh reports no counts');
  ok(db.state.livetv_epg_programmes.length === 1 && db.state.livetv_epg_programmes[0]!['title'] === 'Show A', '§16c the last good guide is intact after the failure');
  ok(db.state.livetv_epg_sources[0]!['enabled'] === true && db.state.livetv_epg_sources[0]!['status'] === 'active', '§16c the source is NEVER disabled/marked unavailable by a refresh failure');
  ok(!db.writes.some((w) => w.table === 'livetv_epg_sources'), '§16c zero writes to the source row across both refreshes');

  // A garbage payload likewise preserves the snapshot.
  const garbage = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse('C:\\ corrupt', 'application/octet-stream'), retention: false });
  ok(garbage.ok === false && garbage.failure!.kind === 'structure_invalid', '§16c a corrupt payload fails with a typed error');
  ok(db.state.livetv_epg_programmes.length === 1, '§16c the snapshot survives the corrupt payload too');
}

// ===========================================================================
console.log('§18 — retention: bounded, never deletes current/upcoming');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();
  seedEpgSource(db);
  // Relative to the REAL clock: the refresh-time sweep runs with the wall
  // clock, so the fixture windows must be relative to it too.
  const now = Date.now();
  const xml = guideXml(
    prog('ch.1', now - 30 * HOUR, now - 29 * HOUR, 'Ancient Past'),
    '<channel id="ch.1"><display-name>One</display-name></channel>'
  );
  // NOTE: guideXml signature (programmes, channels) — fix the call below.
  const fixedXml = guideXml(
    prog('ch.1', now - 30 * HOUR, now - 29 * HOUR, 'Ancient Past') +
      prog('ch.1', now - 3 * HOUR, now - 2 * HOUR, 'Recently Ended') +
      prog('ch.1', now - HOUR, now + HOUR, 'Current') +
      prog('ch.1', now + 2 * HOUR, now + 3 * HOUR, 'Upcoming')
  );
  void xml;
  const seed = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse(fixedXml, 'application/xml'), retention: false });
  ok(seed.ok === true && db.state.livetv_epg_programmes.length === 4, '§18 four windows seeded');

  const sweep = await applyEpgRetention(db as never, { now, epgSourceId: 'epg-1' });
  ok(sweep.deleted === 1, '§18 only the window that ended beyond the grace is deleted');
  const titles = db.state.livetv_epg_programmes.map((row) => String(row['title'])).sort();
  ok(titles.join('|') === 'Current|Recently Ended|Upcoming', '§18 current + upcoming + grace-window rows survive');
  ok(sweep.cutoffMs === now - EPG_RETENTION_PAST_MS, '§18 cutoff is exactly now − retention window');

  // Idempotent: a second sweep deletes nothing.
  const sweep2 = await applyEpgRetention(db as never, { now, epgSourceId: 'epg-1' });
  ok(sweep2.deleted === 0 && sweep2.batches === 0, '§18 the sweep is idempotent');

  // Bounded batches.
  const sweep3 = await applyEpgRetention(db as never, { now, epgSourceId: 'epg-1', maxBatches: 0 });
  ok(sweep3.deleted === 0 && sweep3.exhausted === true, '§18 the per-call batch budget bounds the sweep');

  // Validation: insane retention windows are rejected.
  let rejected = false;
  try {
    await applyEpgRetention(db as never, { now, retainPastMs: -1 });
  } catch {
    rejected = true;
  }
  ok(rejected, '§18 a negative retention window is rejected');
  let rejected2 = false;
  try {
    await applyEpgRetention(db as never, { now: Number.NaN });
  } catch {
    rejected2 = true;
  }
  ok(rejected2, '§18 a non-finite clock is rejected');

  // Refresh-time sweep: runs after persistence and only touches the past.
  // The payload still republishes 'Ancient Past' (upserted again), so the
  // sweep deletes exactly that row — never the current/upcoming ones.
  const refreshSweep = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse(fixedXml, 'application/xml') });
  ok(refreshSweep.ok === true && refreshSweep.counts!.retentionDeleted === 1, '§18 the refresh-time sweep deletes only the past window');
  const survivorsAfterRefresh = db.state.livetv_epg_programmes.map((row) => String(row['title'])).sort().join('|');
  ok(survivorsAfterRefresh === 'Current|Recently Ended|Upcoming', '§18 after refresh+sweep, current/upcoming/grace rows survive and only the expired row is gone');
}

// ===========================================================================
console.log('§19 — current/upcoming helpers (explicit clock, deterministic)');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();
  seedEpgSource(db);
  // Explicit mapping wins over tvgId; ambiguous tvgId serves nothing.
  db.state.livetv_epg_channel_mappings.push({ id: 'm1', epg_source_id: 'epg-1', channel_id: 'can-1', epg_channel_id: 'ch.1' });
  db.state.livetv_source_channels.push(
    { id: 's1', source_id: 'src', source_channel_id: 'a', canonical_channel_id: 'can-2', tvg_id: 'ch.2', enabled: true },
    { id: 's2', source_id: 'src', source_channel_id: 'b', canonical_channel_id: 'can-3', tvg_id: 'ch.2', enabled: true } // can-2 vs can-3 → ambiguous
  );
  const now = T0 + 5 * HOUR;
  const rows = [
    { epg_source_id: 'epg-1', epg_channel_id: 'ch.1', start_at: iso(now - HOUR), end_at: iso(now + HOUR), title: 'Overlap Long', sub_title: null, description: 'd', category: null, icon_url: null, language: null },
    { epg_source_id: 'epg-1', epg_channel_id: 'ch.1', start_at: iso(now - 30 * 60_000), end_at: iso(now + 30 * 60_000), title: 'Overlap Tight', sub_title: null, description: null, category: null, icon_url: null, language: null },
    { epg_source_id: 'epg-1', epg_channel_id: 'ch.1', start_at: iso(now + HOUR), end_at: iso(now + 2 * HOUR), title: 'Next Show', sub_title: null, description: null, category: null, icon_url: null, language: null },
    { epg_source_id: 'epg-1', epg_channel_id: 'ch.1', start_at: iso(now + 2 * HOUR), end_at: iso(now + 3 * HOUR), title: 'Later Show', sub_title: null, description: null, category: null, icon_url: null, language: null },
    { epg_source_id: 'epg-1', epg_channel_id: 'ch.1', start_at: iso(now + 8 * HOUR), end_at: iso(now + 9 * HOUR), title: 'Horizon Show', sub_title: null, description: null, category: null, icon_url: null, language: null },
    { epg_source_id: 'epg-1', epg_channel_id: 'ch.2', start_at: iso(now - HOUR), end_at: iso(now + HOUR), title: 'Ambiguous Show', sub_title: null, description: null, category: null, icon_url: null, language: null }
  ];
  db.state.livetv_epg_programmes.push(...rows.map((row) => ({ ...row, id: `p-${row['title']}` })));

  // Current: start <= now < end; the most specific window wins deterministically.
  const current = await getCurrentEpgProgramme(db as never, 'can-1', new Date(now));
  ok(current !== null && current.title === 'Overlap Tight', '§19 current programme: the latest-starting containing window wins (deterministic overlap rule)');
  ok(current!.mappingSource === 'explicit' && current!.epgSourceId === 'epg-1' && current!.epgChannelId === 'ch.1', '§19 provenance returned (explicit mapping, source + guide id)');

  // Boundary: exactly at start.
  const atStart = await getCurrentEpgProgramme(db as never, 'can-1', new Date(now + HOUR));
  ok(atStart !== null && atStart.title === 'Next Show', '§19 start boundary inclusive (start <= now)');

  // Boundary: exactly at end → next programme.
  const atEnd = await getCurrentEpgProgramme(db as never, 'can-1', new Date(now + 2 * HOUR));
  ok(atEnd !== null && atEnd.title === 'Later Show', '§19 end boundary exclusive (now < end) — the next window is current');

  // Gap: no window contains the instant → honest null (never fabricated).
  db.state.livetv_epg_programmes = db.state.livetv_epg_programmes.filter((row) => String(row['title']) !== 'Later Show');
  const inGap = await getCurrentEpgProgramme(db as never, 'can-1', new Date(now + 2 * HOUR + 1));
  ok(inGap === null, '§19 a coverage gap returns null (honest empty state, no fake progress)');

  // Ambiguous tvgId (can-2/can-3 both claim ch.2) serves NOTHING.
  const ambiguousChannel = await getCurrentEpgProgramme(db as never, 'can-2', new Date(now));
  ok(ambiguousChannel === null, '§19 an identity contested by another canonical channel never serves guide data');

  // Upcoming: stable UTC ordering, bounded limit, current excluded.
  const upcoming = await getUpcomingEpgProgrammes(db as never, 'can-1', new Date(now), { limit: 10 });
  ok(upcoming.map((p) => p.title).join('|') === 'Next Show|Horizon Show', '§19 upcoming ordered by start (stable UTC order); current excluded');
  const limited = await getUpcomingEpgProgrammes(db as never, 'can-1', new Date(now), { limit: 1 });
  ok(limited.length === 1 && limited[0]!.title === 'Next Show', '§19 upcoming limit honored');

  // Horizon.
  const horizon = await getUpcomingEpgProgrammes(db as never, 'can-1', new Date(now), { horizonMs: 3 * HOUR });
  ok(horizon.map((p) => p.title).join('|') === 'Next Show', '§19 horizon excludes programmes beyond the window');

  // No mapping at all → empty results (no fabrication).
  const unknownChannel = await getCurrentEpgProgramme(db as never, 'can-none', new Date(now));
  ok(unknownChannel === null, '§19 a channel with no guide mapping returns null');

  // Ineligible EPG source never serves data.
  db.state.livetv_epg_sources[0]!['enabled'] = false;
  const disabledSource = await getCurrentEpgProgramme(db as never, 'can-1', new Date(now));
  ok(disabledSource === null, '§19 a disabled guide source is excluded from lookups');
}

// ===========================================================================
console.log('§20b — duplicate refresh guard + preview + all-mode isolation');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();
  seedEpgSource(db);

  let releaseFetch: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const slowFetcher = async () => {
    await gate;
    return okResponse(guideXml(prog('ch.1', T0, T0 + HOUR, 'Slow')), 'application/xml');
  };

  const first = refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: slowFetcher, retention: false });
  // Give the first call a tick to register in-flight, then issue the second.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: slowFetcher, retention: false });
  ok(second.ok === false && second.failure?.kind === 'refresh_in_progress', '§20b a concurrent second refresh is refused with a typed outcome');
  releaseFetch!();
  const firstOutcome = await first;
  ok(firstOutcome.ok === true, '§20b the first refresh completes normally after the gate opens');

  // Preview: full pipeline, ZERO writes.
  const preview = await previewLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER, fetcher: async () => okResponse(guideXml(prog('ch.1', T0, T0 + HOUR, 'Previewed')), 'application/xml') });
  ok(preview.ok === true && preview.counts!.programmesInserted === 1, '§20b preview plans the import');
  ok(db.writes.length === 1, '§20b preview performed ZERO writes (only the earlier refresh wrote)');

  // All-mode: per-source isolation.
  resetLivetvEpgStateForTests();
  const db2 = createMockDb();
  seedEpgSource(db2, { id: 'epg-1', slug: 'guide-1' });
  seedEpgSource(db2, { id: 'epg-2', slug: 'guide-2', source_url: 'https://guides.example/two.xml' });
  seedEpgSource(db2, { id: 'epg-3', slug: 'guide-3', enabled: false });
  const all = await refreshAllEligibleLivetvEpgSources(db2 as never, { dnsResolver: SAFE_RESOLVER,
    fetcher: async (_url: string | URL) => {
      if (String(_url).includes('two.xml')) throw new LivetvSourceFetchError('http_error', 'The source endpoint returned an HTTP error status.', { httpStatus: 500 });
      return okResponse(guideXml(prog('ch.1', T0, T0 + HOUR, 'From Guide One')), 'application/xml');
    },
    retention: false
  });
  ok(all.eligibleSources === 2 && all.refreshedSources === 2, '§20b the ineligible source is never considered');
  const outcomes = new Map(all.outcomes.map((o) => [o.epgSourceId, o]));
  ok(outcomes.get('epg-1')!.ok === true && outcomes.get('epg-2')!.ok === false, '§20b one failing source never prevents the other');
  ok(outcomes.get('epg-2')!.failure!.kind === 'http_error', '§20b the failing source reports its typed failure');
  ok(db2.state.livetv_epg_programmes.length === 1, '§20b the healthy source persisted its data');

  // Outcome record: bounded, most recent first, reachable by the status API.
  const recorded = getLivetvEpgRefreshOutcomes();
  ok(recorded.length >= 2, '§20b outcomes recorded for the status endpoint');
  ok(recorded.every((o) => !JSON.stringify(o).includes('guides.example')), '§20b no upstream URL leaks into any recorded outcome');
}

// ===========================================================================
console.log('§21b — diagnostics redaction (no XML/URLs/credentials in outcomes)');
// ===========================================================================
{
  resetLivetvEpgStateForTests();
  const db = createMockDb();
  seedEpgSource(db, { source_url: 'https://guides.example/private-guide.xml?token=supersecret' });
  const outcome = await refreshLivetvEpgSource(db as never, { id: 'epg-1' }, { dnsResolver: SAFE_RESOLVER,
    fetcher: async () => { throw new LivetvSourceFetchError('too_large', 'The source document exceeds the configured size budget.'); },
    retention: false
  });
  ok(outcome.ok === false && outcome.failure!.kind === 'too_large', '§21b oversized guide → typed too_large');
  const serialized = JSON.stringify(outcome);
  ok(!serialized.includes('supersecret') && !serialized.includes('private-guide'), '§21b no URL/query/token material in the outcome');
  ok(!serialized.includes('<tv'), '§21b no raw XML in the outcome');
}

// ===========================================================================
console.log('§22 — existing LiveGT guide helper + embed fallback regression');
// ===========================================================================
{
  // The client EPG contract is untouched: provider hint first, timestamp
  // scan second, null otherwise (never fabricated).
  const nowSeconds = 1_700_000_000;
  const hinted = determineCurrentProgramme(
    {
      channel: { id: '143', name: 'CNBC TV18 Prime' },
      nowPlaying: { title: 'Hinted', startSeconds: nowSeconds - 60, stopSeconds: nowSeconds + 60 },
      schedule: [{ title: 'Scanned', startSeconds: nowSeconds - 1, stopSeconds: nowSeconds + 1 }]
    } as never,
    nowSeconds
  );
  ok(hinted?.title === 'Hinted', '§22 determineCurrentProgramme: provider hint remains authoritative');

  const scanned = determineCurrentProgramme(
    {
      channel: { id: '143', name: 'CNBC TV18 Prime' },
      schedule: [
        { title: 'Earlier', startSeconds: nowSeconds - 3600, stopSeconds: nowSeconds - 10 },
        { title: 'Current', startSeconds: nowSeconds - 1, stopSeconds: nowSeconds + 100 }
      ]
    } as never,
    nowSeconds
  );
  ok(scanned?.title === 'Current', '§22 timestamp-scan fallback unchanged ([start, stop) window semantics)');

  const none = determineCurrentProgramme({ channel: { id: '143', name: 'X' }, schedule: [] } as never, nowSeconds);
  ok(none === null, '§22 an empty guide still yields an honest null (no fabrication)');
}

console.log(`\nEPG PHASE 3 PIPELINE TESTS: ${passed} checks passed`);
if (passed === 0) process.exit(1);
