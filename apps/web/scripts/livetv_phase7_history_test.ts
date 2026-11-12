/**
 * UNIFIED LIVE TV — Phase 7 persistent refresh history (deterministic).
 *
 * Covers (Phase 7 brief §5 + required regression areas #8/#9/#10/#15/#17):
 *   §1  sanitized outcome → history-row builders (bounded counts, bounded
 *       slug, sanitized error text, status vocabulary)
 *   §2  SECRET-VALUE regression: unique fake secret values driven through
 *       the row builders NEVER survive into the serialized row
 *   §3  best-effort persistence containment: a history write failure NEVER
 *       fails a refresh (drill #10 — database unavailable during history
 *       persistence), for both the source and the EPG path
 *   §4  per-subject health aggregation (last attempt/success, consecutive
 *       failures, stalest-first ordering, deleted subjects stay readable)
 *   §5  bounded retention sweep (id-paged batches, convergence, bounds
 *       validation) — drill-style, offline
 *   §6  correlation grouping (attempt numbering within one correlation)
 *
 * NO network, NO real database (mock client + forced failures).
 */

import assert from 'node:assert/strict';
import { livetvHistoryRowFromSourceOutcome, livetvHistoryRowFromEpgOutcome, recordLivetvRefreshHistory, getLivetvRefreshHistoryPage, summarizeLivetvSubjectHealth, applyLivetvHistoryRetention, LIVETV_HISTORY_RETENTION_BATCH_SIZE } from '../src/lib/server/livetv/history';
import { refreshLivetvSource, resetLivetvRefreshStateForTests, type LivetvRefreshSourceOutcome } from '../src/lib/server/livetv/refresh-service';
import { refreshLivetvEpgSource, resetLivetvEpgStateForTests, type LivetvEpgRefreshOutcome } from '../src/lib/server/livetv/epg/guide-service';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
        assert.ok(condition, hint ? `${label} (${hint})` : label);
        passed += 1;
        console.log(`  ok ${passed} - ${label}`);
}

type Row = Record<string, unknown>;

/** Mock DB with an insert-failure injector for the history table. */
function createMockDb(options: { failHistoryInserts?: boolean } = {}) {
        const state: Record<string, Row[]> = {
                livetv_sources: [],
                livetv_epg_sources: [],
                livetv_refresh_history: [],
                livetv_source_channels: [],
                livetv_playback_endpoints: [],
                livetv_epg_channel_mappings: [],
                livetv_epg_programmes: []
        };
        let uuidCounter = 0;
        const nextId = () => `gen-${(uuidCounter += 1).toString().padStart(4, '0')}`;

        function makeBuilder(table: string) {
                const filters: [string, unknown][] = [];
                let orderCols: { col: string; asc: boolean }[] = [];
                let limitN: number | null = null;
                let inFilter: { col: string; values: unknown[] } | null = null;
                let ltFilter: { col: string; value: unknown } | null = null;
                const builder = {
                        select(_cols?: string) {
                                return this;
                        },
                        eq(col: string, val: unknown) {
                                filters.push([col, val]);
                                return this;
                        },
                        lt(col: string, val: unknown) {
                                ltFilter = { col, value: val };
                                return this;
                        },
                        gte(_col: string, _val: unknown) {
                                return this;
                        },
                        lte(_col: string, _val: unknown) {
                                return this;
                        },
                        in(col: string, values: unknown[]) {
                                inFilter = { col, values };
                                return this;
                        },
                        order(col: string, opts?: { ascending?: boolean }) {
                                orderCols.push({ col, asc: opts?.ascending !== false });
                                return this;
                        },
                        limit(n: number) {
                                limitN = n;
                                return this;
                        },
                        then: (resolve: (value: { data: unknown; error: unknown }) => unknown, reject: (reason: unknown) => unknown) => {
                                (async () => {
                                        let rows = [...(state[table] ?? [])];
                                        rows = rows.filter((row) => filters.every(([col, val]) => row[col] === val));
                                        if (inFilter) rows = rows.filter((row) => inFilter.values.includes(row[inFilter.col]));
                                        if (ltFilter) rows = rows.filter((row) => String(row[ltFilter.col]) < String(ltFilter.value));
                                        for (const { col, asc } of orderCols.reverse()) {
                                                rows.sort((a, b) => (a[col] === b[col] ? 0 : (a[col] ?? '') < (b[col] ?? '') ? (asc ? -1 : 1) : asc ? 1 : -1));
                                        }
                                        if (limitN !== null) rows = rows.slice(0, limitN);
                                        return { data: rows, error: null };
                                })().then(resolve, reject);
                        },
                        async maybeSingle() {
                                const rows = (state[table] ?? []).filter((row) => filters.every(([col, val]) => row[col] === val));
                                return { data: rows[0] ?? null, error: null };
                        },
                        async single() {
                                const rows = (state[table] ?? []).filter((row) => filters.every(([col, val]) => row[col] === val));
                                return { data: rows[0] ?? null, error: rows.length ? null : { message: 'no rows returned' } };
                        },
                        insert(payload: Row) {
                                return {
                                        select() {
                                                return {
                                                        single: async () => {
                                                                const row = { ...payload, id: nextId() };
                                                                state[table].push(row);
                                                                return { data: { id: row['id'] }, error: null };
                                                        }
                                                };
                                        },
                                        then: (resolve2: (value: { data: unknown; error: unknown }) => unknown, reject2: (reason: unknown) => unknown) => {
                                                (async () => {
                                                        if (options.failHistoryInserts && table === 'livetv_refresh_history') {
                                                                return { data: null, error: { message: 'simulated database unavailable' } };
                                                        }
                                                        const row = { ...payload, id: nextId() };
                                                        state[table].push(row);
                                                        return { data: row, error: null };
                                                })().then(resolve2, reject2);
                                        }
                                };
                        },
                        update(payload: Row) {
                                return {
                                        eq(col: string, val: unknown) {
                                                const targetFilters: [string, unknown][] = [...filters, [col, val]];
                                                return {
                                                        then: (resolve2: (value: { data: unknown; error: unknown }) => unknown, reject2: (reason: unknown) => unknown) => {
                                                                (async () => {
                                                                        const rows = (state[table] ?? []).filter((row) => targetFilters.every(([c, v]) => row[c] === v));
                                                                        for (const row of rows) Object.assign(row, payload);
                                                                        return { data: rows[0] ?? null, error: null };
                                                                })().then(resolve2, reject2);
                                                        }
                                                };
                                        }
                                };
                        },
                        delete() {
                                return {
                                        in(_col: string, values: unknown[]) {
                                                state[table] = (state[table] ?? []).filter((row) => !values.includes(row['id']));
                                                return Promise.resolve({ data: null, error: null });
                                        }
                                };
                        },
                        upsert(_payload: unknown) {
                                return Promise.resolve({ data: null, error: null });
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

        return { client, state };
}

// Unique fake secret values (§2 asserts these EXACT values never leak).
const FAKE_SIGNED_TOKEN = 'st=1700000000~exp=1799999999~acl=/hls/live*~hmac=DEADBEEF0123456789SECRETVALUE';
const FAKE_API_KEY = 'SK-LIVE-99887766554433221100SECRETKEY';
const FAKE_BEARER = 'Bearer eyJfakeheader.fakepayloadFAKESECRETSIGNATURE';

function sourceOutcome(overrides: Partial<LivetvRefreshSourceOutcome> = {}): LivetvRefreshSourceOutcome {
        return {
                sourceId: '00000000-0000-4000-8000-000000000001',
                slug: 'test-source',
                sourceType: 'm3u_playlist',
                adapterId: 'm3u_playlist',
                startedAt: new Date(Date.now() - 5_000).toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 5_000,
                ok: true,
                failure: null,
                counts: { discovered: 3, skipped: 1, failed: 0, entriesInserted: 2, entriesUpdated: 1, endpointsInserted: 4, endpointsUpdated: 0, endpointsMissingUpstream: 0, entriesMissingUpstream: 0 },
                entryErrors: null,
                ingestionErrors: null,
                skippedReasons: { invalid: 1 },
                trigger: 'manual',
                stateTruncated: false,
                historyPersisted: null,
                ...overrides
        };
}

function epgOutcome(overrides: Partial<LivetvEpgRefreshOutcome> = {}): LivetvEpgRefreshOutcome {
        return {
                epgSourceId: '00000000-0000-4000-8000-0000000000aa',
                slug: 'test-epg',
                epgType: 'xmltv',
                startedAt: new Date(Date.now() - 9_000).toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 9_000,
                ok: true,
                failure: null,
                counts: null,
                parseSamples: null,
                executionErrors: null,
                skipReasons: null,
                mappingSamples: null,
                timezonePolicy: null,
                trigger: 'manual',
                entriesTruncated: false,
                historyPersisted: null,
                ...overrides
        };
}

async function main() {
        resetLivetvRefreshStateForTests();
        resetLivetvEpgStateForTests();

        // ------------------------------------------------------------------
        console.log('§1 — sanitized outcome → history row builders');
        // ------------------------------------------------------------------
        {
                const row = livetvHistoryRowFromSourceOutcome(sourceOutcome(), { trigger: 'scheduled', correlationId: '00000000-0000-4000-8000-0000000000cc', attemptNumber: 2 });
                ok(row !== null, '§1.1 a resolved outcome produces a row');
                ok(row!['subject_kind'] === 'source' && row!['operation'] === 'refresh', '§1.2 subject kind + operation recorded');
                ok(row!['trigger_type'] === 'scheduled' && row!['attempt_count'] === 2, '§1.3 trigger + attempt number recorded');
                ok(row!['status'] === 'success', '§1.4 a clean outcome maps to success');
                ok(row!['imported_count'] === 6 && row!['updated_count'] === 1 && row!['skipped_count'] === 1 && row!['error_count'] === 0, '§1.5 bounded counts (imported=entriesInserted+endpointsInserted)');
                ok(row!['error_category'] === null && row!['error_message'] === null, '§1.6 no error fields on success');

                const failed = livetvHistoryRowFromSourceOutcome(
                        sourceOutcome({
                                ok: false,
                                counts: null,
                                failure: { kind: 'timeout', message: 'The source request exceeded its time budget.' }
                        }),
                        { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000cd', attemptNumber: 1 }
                );
                ok(failed!['status'] === 'timeout', '§1.7 a timeout outcome maps to the timeout status');
                ok(failed!['error_category'] === 'timeout', '§1.8 the bounded category is recorded');

                const ineligible = livetvHistoryRowFromSourceOutcome(sourceOutcome({ ok: false, counts: null, failure: { kind: 'source_ineligible', message: 'not eligible' } }), { trigger: 'scheduled', correlationId: '00000000-0000-4000-8000-0000000000ce', attemptNumber: 1 });
                ok(ineligible!['status'] === 'skipped', '§1.9 an ineligible outcome maps to skipped');

                const partial = livetvHistoryRowFromSourceOutcome(sourceOutcome({ counts: { discovered: 5, skipped: 0, failed: 2, entriesInserted: 1, entriesUpdated: 0, endpointsInserted: 1, endpointsUpdated: 0, endpointsMissingUpstream: 0, entriesMissingUpstream: 0 } }), { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000cf', attemptNumber: 1 });
                ok(partial!['status'] === 'partial', '§1.10 ok:true with per-item failures maps to partial');

                const unknown = livetvHistoryRowFromSourceOutcome(sourceOutcome({ sourceId: 'unknown' }), { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000d0', attemptNumber: 1 });
                ok(unknown === null, '§1.11 an unresolved subject (unknown id) records NOTHING (honest attribution)');

                const nonUuid = livetvHistoryRowFromSourceOutcome(sourceOutcome({ sourceId: 'not-a-uuid' }), { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000d1', attemptNumber: 1 });
                ok(nonUuid === null, '§1.12 a non-uuid subject id records NOTHING');

                const epgRow = livetvHistoryRowFromEpgOutcome(
                        epgOutcome({ ok: false, counts: null, failure: { kind: 'decompression_too_large', message: 'decompressed guide exceeded the size budget' } }),
                        { trigger: 'scheduled', correlationId: '00000000-0000-4000-8000-0000000000d2', attemptNumber: 1 }
                );
                ok(epgRow!['subject_kind'] === 'epg_source' && epgRow!['operation'] === 'epg_refresh' && epgRow!['status'] === 'failure', '§1.13 the EPG twin records subject_kind=epg_source with its own status mapping');

                const capped = livetvHistoryRowFromSourceOutcome(sourceOutcome({ slug: 'x'.repeat(500), durationMs: 9_999_999 }), { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000d3', attemptNumber: 99 });
                ok(String(capped!['subject_slug']).length <= 120, '§1.14 an over-long slug snapshot is bounded to 120');
                ok(capped!['duration_ms'] === 3_600_000, '§1.15 an absurd duration is capped at 1h');
                ok(capped!['attempt_count'] === 10, '§1.16 the attempt count is bounded to 10');
        }

        // ------------------------------------------------------------------
        console.log('§2 — SECRET-VALUE regression (unique fake values never leak)');
        // ------------------------------------------------------------------
        {
                // Realistic leak shapes: a signed playlist URL, a query-string
                // API key, an Authorization header echoed into a message.
                const hostileMessage = `fetch failed for https://upstream.example/feed?__hdnea__=${FAKE_SIGNED_TOKEN}&api_key=${FAKE_API_KEY}&x=1 (Authorization: ${FAKE_BEARER})`;
                const row = livetvHistoryRowFromSourceOutcome(sourceOutcome({ ok: false, counts: null, failure: { kind: 'network', message: hostileMessage } }), { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000d4', attemptNumber: 1 });
                const serialized = JSON.stringify(row);
                ok(!serialized.includes(FAKE_SIGNED_TOKEN), '§2.1 the fake signed token VALUE never survives into the row');
                ok(!serialized.includes(FAKE_API_KEY), '§2.2 the fake API key VALUE never survives into the row');
                ok(!serialized.includes(FAKE_BEARER), '§2.3 the fake bearer credential VALUE never survives into the row');
                ok(String(row!['error_message']).includes('[REDACTED]'), '§2.4 the sanitizer marks the redaction explicitly');
                ok(String(row!['error_message']).length <= 240, '§2.5 the sanitized message stays within the DB CHECK bound');
                ok(String(row!['error_message']).includes('api_key='), '§2.6 the parameter NAME is preserved (operators see WHAT was redacted)');
        }

        // ------------------------------------------------------------------
        console.log('§3 — best-effort persistence containment (drill #10)');
        // ------------------------------------------------------------------
        {
                // History INSERTS fail (database unavailable) — the REFRESH must
                // still succeed and report historyPersisted:false honestly.
                const db = createMockDb({ failHistoryInserts: true });
                const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
                db.state['livetv_sources'].push({ id: UUID(1), slug: 'drill-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/list.m3u8' } });
                const okFetcher = (async () => new Response('#EXTM3U\n#EXTINF:-1 tvg-id="a" tvg-name="Chan",Chan\nhttps://cdn.example/a.m3u8\n', { headers: { 'content-type': 'audio/x-mpegurl' } })) as unknown as typeof fetch;
                const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
                const outcome = await refreshLivetvSource(db.client as never, { id: UUID(1) }, { fetcher: okFetcher, dnsResolver: resolver });
                ok(outcome.ok === true, '§3.1 the refresh itself SUCCEEDS while the history DB is unavailable (containment)');
                ok(outcome.historyPersisted === false, '§3.2 the outcome honestly reports historyPersisted=false');
                ok(db.state['livetv_refresh_history'].length === 0, '§3.3 no history row was (partially) written');

                // The EPG twin has the same containment.
                const dbEpg = createMockDb({ failHistoryInserts: true });
                dbEpg.state['livetv_epg_sources'].push({ id: UUID(10), slug: 'drill-epg', epg_type: 'xmltv', enabled: true, status: 'active', config: {}, source_url: 'https://cdn.example/guide.xml' });
                const xmlFetcher = (async () => new Response('<?xml version="1.0"?><tv><channel id="a"><display-name>Chan</display-name></channel><programme start="20261122000000 +0000" stop="20261123000000 +0000" channel="a"><title>P</title></programme></tv>', { headers: { 'content-type': 'text/xml' } })) as unknown as typeof fetch;
                const epgOutcomeResult = await refreshLivetvEpgSource(dbEpg.client as never, { id: UUID(10) }, { fetcher: xmlFetcher, dnsResolver: resolver, retention: false });
                ok(epgOutcomeResult.ok === true && epgOutcomeResult.historyPersisted === false, '§3.4 the EPG refresh has identical history-failure containment');

                // recordLivetvRefreshHistory never throws even on a crashing client.
                const throwingClient = { from: () => { throw new Error('connection refused'); } } as never;
                const persisted = await recordLivetvRefreshHistory(throwingClient, livetvHistoryRowFromSourceOutcome(sourceOutcome(), { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000d5', attemptNumber: 1 }));
                ok(persisted === false, '§3.5 a throwing client resolves to persisted=false (never throws)');

                // And a healthy write lands.
                const dbHealthy = createMockDb();
                const persistedOk = await recordLivetvRefreshHistory(dbHealthy.client as never, livetvHistoryRowFromSourceOutcome(sourceOutcome(), { trigger: 'manual', correlationId: '00000000-0000-4000-8000-0000000000d6', attemptNumber: 1 }));
                ok(persistedOk === true && dbHealthy.state['livetv_refresh_history'].length === 1, '§3.6 a healthy write persists exactly one row');
        }

        // ------------------------------------------------------------------
        console.log('§4 — per-subject health aggregation');
        // ------------------------------------------------------------------
        {
                const db = createMockDb();
                const now = Date.now();
                const mkRow = (n: number, subject: string, kind: string, status: string, startedOffsetMs: number, category?: string) => ({
                        id: `row-${n}`,
                        subject_kind: kind,
                        subject_id: subject,
                        subject_slug: kind === 'source' ? `slug-${subject.slice(-1)}` : `epg-${subject.slice(-1)}`,
                        operation: kind === 'source' ? 'refresh' : 'epg_refresh',
                        trigger_type: 'scheduled',
                        correlation_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
                        attempt_count: 1,
                        status,
                        imported_count: 0,
                        updated_count: 0,
                        skipped_count: 0,
                        error_count: 0,
                        error_category: category ?? null,
                        error_message: null,
                        duration_ms: 100,
                        started_at: new Date(now - startedOffsetMs).toISOString(),
                        finished_at: new Date(now - startedOffsetMs + 100).toISOString(),
                        created_at: new Date(now - startedOffsetMs).toISOString()
                });
                // Subject A: 3 consecutive recent failures. Subject B: last success 2h ago.
                // Subject C (epg): one failure then success. Deleted subject D: only history remains.
                db.state['livetv_refresh_history'].push(
                        mkRow(1, '00000000-0000-4000-8000-00000000000a', 'source', 'failure', 1_000, 'http_error'),
                        mkRow(2, '00000000-0000-4000-8000-00000000000a', 'source', 'failure', 2_000, 'network'),
                        mkRow(3, '00000000-0000-4000-8000-00000000000a', 'source', 'failure', 3_000, 'timeout'),
                        mkRow(4, '00000000-0000-4000-8000-00000000000b', 'source', 'success', 2 * 60 * 60_000),
                        mkRow(5, '00000000-0000-4000-8000-00000000000b', 'source', 'failure', 2 * 60 * 60_000 + 5_000, 'blocked_url'),
                        mkRow(6, '00000000-0000-4000-8000-00000000000c', 'epg_source', 'failure', 5 * 60 * 60_000, 'empty_document'),
                        mkRow(7, '00000000-0000-4000-8000-00000000000c', 'epg_source', 'success', 4 * 60 * 60_000),
                        mkRow(8, '00000000-0000-4000-8000-00000000000d', 'source', 'success', 30 * 24 * 60 * 60_000)
                );
                const page = await getLivetvRefreshHistoryPage(db.client as never, { limit: 300 });
                ok(page.length === 8, '§4.1 the bounded page reads all rows');
                const summaries = summarizeLivetvSubjectHealth(page);
                ok(summaries.length === 4, '§4.2 four distinct subjects aggregated');
                const a = summaries.find((s) => s.subjectId.endsWith('a'))!;
                ok(a.consecutiveFailures === 3 && a.lastErrorCategory === 'http_error' && a.lastStatus === 'failure', '§4.3 trailing failures counted; the NEWEST category wins');
                const b = summaries.find((s) => s.subjectId.endsWith('b'))!;
                ok(b.consecutiveFailures === 0 && b.lastSuccessAt !== null && b.lastStatus === 'success', '§4.4 a trailing success resets the failure streak');
                const c = summaries.find((s) => s.subjectId.endsWith('c'))!;
                ok(c.subjectKind === 'epg_source' && c.lastSuccessAt !== null && c.lastErrorCategory === 'empty_document', '§4.5 the EPG subject keeps its last error category alongside the later success');
                ok(summaries[0].subjectId.endsWith('d') || summaries[0].subjectId.endsWith('a'), '§4.6 stalest-first ordering (oldest last attempt first)');
                ok(summaries[summaries.length - 1].subjectId.endsWith('a'), '§4.7 the most-recently-attempted subject is last');
                // Deleted subjects: the summary is still readable (slug snapshot).
                const d = summaries.find((s) => s.subjectId.endsWith('d'))!;
                ok(d.slug === 'slug-d' && d.lastAttemptAt !== null, '§4.8 a DELETED subject remains readable from history (no FK)');
        }

        // ------------------------------------------------------------------
        console.log('§5 — bounded retention sweep (drill-style, offline)');
        // ------------------------------------------------------------------
        {
                const db = createMockDb();
                const now = Date.now();
                for (let i = 0; i < LIVETV_HISTORY_RETENTION_BATCH_SIZE + 50; i += 1) {
                        db.state['livetv_refresh_history'].push({
                                id: `old-${i}`,
                                subject_kind: 'source',
                                subject_id: '00000000-0000-4000-8000-00000000000e',
                                subject_slug: 'bulk',
                                operation: 'refresh',
                                trigger_type: 'scheduled',
                                correlation_id: '00000000-0000-4000-8000-0000000000e0',
                                attempt_count: 1,
                                status: 'success',
                                imported_count: 0,
                                updated_count: 0,
                                skipped_count: 0,
                                error_count: 0,
                                error_category: null,
                                error_message: null,
                                duration_ms: 10,
                                started_at: new Date(now - 60 * 24 * 60 * 60_000).toISOString(), // 60 days old
                                finished_at: null,
                                created_at: new Date(now - 60 * 24 * 60 * 60_000).toISOString()
                        });
                }
                db.state['livetv_refresh_history'].push({
                        id: 'fresh-1',
                        subject_kind: 'source',
                        subject_id: '00000000-0000-4000-8000-00000000000f',
                        subject_slug: 'fresh',
                        operation: 'refresh',
                        trigger_type: 'manual',
                        correlation_id: '00000000-0000-4000-8000-0000000000e1',
                        attempt_count: 1,
                        status: 'success',
                        imported_count: 0,
                        updated_count: 0,
                        skipped_count: 0,
                        error_count: 0,
                        error_category: null,
                        error_message: null,
                        duration_ms: 10,
                        started_at: new Date(now - 1_000).toISOString(),
                        finished_at: null,
                        created_at: new Date(now - 1_000).toISOString()
                });

                const result1 = await applyLivetvHistoryRetention(db.client as never, { now, retainMs: 30 * 24 * 60 * 60_000 });
                ok(result1.deleted === 550 && result1.batches === 2 && result1.exhausted === false, '§5.1 the sweep converges within bounded batches (all 550 expired rows gone)');
                const result2 = await applyLivetvHistoryRetention(db.client as never, { now, retainMs: 30 * 24 * 60 * 60_000 });
                ok(result2.deleted === 0 && result2.batches === 0, '§5.2 a repeated sweep is an idempotent no-op');
                const result3 = await applyLivetvHistoryRetention(db.client as never, { now, retainMs: 30 * 24 * 60 * 60_000 });
                ok(result3.deleted === 0 && result3.batches === 0, '§5.3 a converged sweep stays a no-op');
                ok(db.state['livetv_refresh_history'].length === 1 && (db.state['livetv_refresh_history'][0] as Row)['id'] === 'fresh-1', '§5.4 ONLY the expired rows were deleted (fresh row untouched)');

                let rejected = false;
                try {
                        await applyLivetvHistoryRetention(db.client as never, { retainMs: 1000 });
                } catch {
                        rejected = true;
                }
                ok(rejected, '§5.5 a sub-hour retention window is rejected (bound validation)');
                rejected = false;
                try {
                        await applyLivetvHistoryRetention(db.client as never, { retainMs: 400 * 24 * 60 * 60_000 });
                } catch {
                        rejected = true;
                }
                ok(rejected, '§5.6 a >90-day retention window is rejected');
        }

        // ------------------------------------------------------------------
        console.log('§6 — correlation grouping (attempt numbering)');
        // ------------------------------------------------------------------
        {
                const db = createMockDb();
                const correlation = '00000000-0000-4000-8000-0000000000f0';
                const row1 = livetvHistoryRowFromSourceOutcome(sourceOutcome({ ok: false, counts: null, failure: { kind: 'network', message: 'attempt one' } }), { trigger: 'scheduled', correlationId: correlation, attemptNumber: 1 });
                const row2 = livetvHistoryRowFromSourceOutcome(sourceOutcome({ ok: true, counts: { discovered: 1, skipped: 0, failed: 0, entriesInserted: 1, entriesUpdated: 0, endpointsInserted: 1, endpointsUpdated: 0, endpointsMissingUpstream: 0, entriesMissingUpstream: 0 } }), { trigger: 'scheduled', correlationId: correlation, attemptNumber: 2 });
                await recordLivetvRefreshHistory(db.client as never, row1);
                await recordLivetvRefreshHistory(db.client as never, row2);
                const rows = db.state['livetv_refresh_history'];
                ok(rows.length === 2 && rows.every((row) => row['correlation_id'] === correlation), '§6.1 both attempts share the correlation id');
                ok(rows[0]['attempt_count'] === 1 && rows[1]['attempt_count'] === 2, '§6.2 attempt numbers are recorded 1,2');
                ok(rows[0]['status'] === 'failure' && rows[1]['status'] === 'success', '§6.3 the transient failure then success sequence is honestly recorded');
        }

        console.log(`\n=== livetv Phase 7 history verification: ${passed} checks PASSED ===`);
}

main()
        .catch((error) => {
                console.error(error);
                process.exit(1);
        })
        .finally(() => {
                resetLivetvRefreshStateForTests();
                resetLivetvEpgStateForTests();
        });
