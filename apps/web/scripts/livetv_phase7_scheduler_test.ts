/**
 * UNIFIED LIVE TV — Phase 7 scheduler orchestration (deterministic).
 *
 * Covers (Phase 7 brief §3 + required regression areas #1/#2/#3/#16):
 *   §1  secret verification (fail-closed unset env, wrong/absent secret,
 *       timing-safe path; boolean-only configured probe)
 *   §2  interval resolution from the EXISTING config contract (+ defensive
 *       fallback on garbage)
 *   §3  PURE tick planner: due/deferred, most-overdue-first, per-kind caps,
 *       deterministic per-source jitter bounds, consecutive-failure backoff
 *       (bounded), duplicate window, capacity skips
 *   §4  executeLivetvSchedulerTick: scheduled-trigger history rows with a
 *       shared correlation id, per-source isolation, budget deferral,
 *       duplicate-window skip, in-flight guard interplay, retention sweep
 *   §5  duplicate scheduler invocation protection (in-flight + history)
 *
 * NO network, NO real sleeps (sleep/clock injected), deterministic fixtures.
 */

import assert from 'node:assert/strict';
import {
        LIVETV_SCHEDULER_DUPLICATE_WINDOW_MS,
        LIVETV_SCHEDULER_MAX_EPG_SOURCES_PER_TICK,
        LIVETV_SCHEDULER_MAX_JITTER_MS,
        LIVETV_SCHEDULER_MAX_SOURCES_PER_TICK,
        executeLivetvSchedulerTick,
        isLivetvSchedulerConfigured,
        livetvSchedulerIntervalMinutesFromConfig,
        planLivetvSchedulerTick,
        verifyLivetvSchedulerSecret,
        type LivetvSchedulerCandidate
} from '../src/lib/server/livetv/scheduler';
import { resetLivetvRefreshStateForTests } from '../src/lib/server/livetv/refresh-service';
import { resetLivetvEpgStateForTests } from '../src/lib/server/livetv/epg/guide-service';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
        assert.ok(condition, hint ? `${label} (${hint})` : label);
        passed += 1;
        console.log(`  ok ${passed} - ${label}`);
}

type Row = Record<string, unknown>;

/** A minimal supabase-shaped mock covering the scheduler + refresh surface. */
function createMockDb() {
        const state: Record<string, Row[]> = {
                livetv_sources: [],
                livetv_epg_sources: [],
                livetv_refresh_history: [],
                livetv_source_channels: [],
                livetv_playback_endpoints: [],
                livetv_epg_channel_mappings: [],
                livetv_epg_programmes: []
        };
        const historyInserts: Row[] = [];
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
                                                        const row = { ...payload, id: nextId() };
                                                        state[table].push(row);
                                                        if (table === 'livetv_refresh_history') historyInserts.push(row);
                                                        return { data: row, error: null };
                                                })().then(resolve2, reject2);
                                        }
                                };
                        },
                        delete() {
                                return {
                                        in(col: string, values: unknown[]) {
                                                const before = (state[table] ?? []).length;
                                                state[table] = (state[table] ?? []).filter((row) => !values.includes(row[col]));
                                                return Promise.resolve({ data: null, error: null, deleted: before - state[table].length });
                                        }
                                };
                        },
                        upsert(payload: Row[] | Row) {
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

        return { client, state, historyInserts };
}

function candidate(overrides: Partial<LivetvSchedulerCandidate> = {}): LivetvSchedulerCandidate {
        return { kind: 'source', id: `src-${Math.random().toString(36).slice(2, 8)}`, slug: 'test-source', intervalMinutes: 60, lastAttemptMs: null, lastSuccessMs: null, consecutiveFailures: 0, ...overrides };
}

async function main() {
        resetLivetvRefreshStateForTests();
        resetLivetvEpgStateForTests();

        // ------------------------------------------------------------------
        console.log('§1 — secret verification (fail-closed, timing-safe)');
        // ------------------------------------------------------------------
        {
                const saved = process.env['LIVETV_SCHEDULER_SECRET'];
                try {
                        delete process.env['LIVETV_SCHEDULER_SECRET'];
                        ok(verifyLivetvSchedulerSecret('anything') === false, '§1.1 unset env ⇒ NO secret can authenticate (fail-closed)');
                        ok(verifyLivetvSchedulerSecret(null) === false, '§1.2 absent header rejected with unset env');
                        ok(isLivetvSchedulerConfigured() === false, '§1.3 configured probe reports false (boolean only)');

                        process.env['LIVETV_SCHEDULER_SECRET'] = 'phase7-test-secret-value';
                        ok(verifyLivetvSchedulerSecret('phase7-test-secret-value') === true, '§1.4 the correct secret authenticates');
                        ok(verifyLivetvSchedulerSecret('wrong-secret') === false, '§1.5 a wrong secret is rejected');
                        ok(verifyLivetvSchedulerSecret('') === false, '§1.6 an empty secret is rejected');
                        ok(verifyLivetvSchedulerSecret(null) === false, '§1.7 a missing header is rejected');
                        ok(verifyLivetvSchedulerSecret(' phase7-test-secret-value ') === true, '§1.8 whitespace-padded secret still matches (trimmed compare)');
                        ok(isLivetvSchedulerConfigured() === true, '§1.9 configured probe reports true');
                        ok(verifyLivetvSchedulerSecret('x'.repeat(10_000)) === false, '§1.10 an oversized secret is rejected (no unbounded work)');
                        // The configured-secret override path (the endpoint uses env; tests pin determinism).
                        ok(verifyLivetvSchedulerSecret('abc', 'abc') === true, '§1.11 explicit configured-secret override works');
                        ok(verifyLivetvSchedulerSecret('abc', 'zzz') === false, '§1.12 explicit configured-secret mismatch rejected');
                } finally {
                        if (saved === undefined) delete process.env['LIVETV_SCHEDULER_SECRET'];
                        else process.env['LIVETV_SCHEDULER_SECRET'] = saved;
                }
                ok(process.env['LIVETV_SCHEDULER_SECRET'] === undefined, '§1.13 the test restored the environment (no secret leaks into other suites)');
        }

        // ------------------------------------------------------------------
        console.log('§2 — interval resolution from the existing config contract');
        // ------------------------------------------------------------------
        {
                ok(livetvSchedulerIntervalMinutesFromConfig(undefined) === 720, '§2.1 absent config ⇒ the 12h default');
                ok(livetvSchedulerIntervalMinutesFromConfig({}) === 720, '§2.2 empty config ⇒ default');
                ok(livetvSchedulerIntervalMinutesFromConfig({ refreshIntervalMinutes: 90 }) === 90, '§2.3 a valid interval is honored');
                ok(livetvSchedulerIntervalMinutesFromConfig({ refreshIntervalMinutes: 15 }) === 15, '§2.4 the minimum bound is honored');
                ok(livetvSchedulerIntervalMinutesFromConfig({ refreshIntervalMinutes: 10_080 }) === 10_080, '§2.5 the maximum bound is honored');
                ok(livetvSchedulerIntervalMinutesFromConfig({ refreshIntervalMinutes: 14 }) === 720, '§2.6 below the minimum ⇒ defensive default');
                ok(livetvSchedulerIntervalMinutesFromConfig({ refreshIntervalMinutes: 10_081 }) === 720, '§2.7 above the maximum ⇒ defensive default');
                ok(livetvSchedulerIntervalMinutesFromConfig({ refreshIntervalMinutes: 22.5 }) === 720, '§2.8 a non-integer ⇒ defensive default');
                ok(livetvSchedulerIntervalMinutesFromConfig({ refreshIntervalMinutes: '90' }) === 720, '§2.9 a non-number ⇒ defensive default');
                ok(livetvSchedulerIntervalMinutesFromConfig('garbage') === 720, '§2.10 a non-object config ⇒ defensive default');
        }

        // ------------------------------------------------------------------
        console.log('§3 — pure tick planner (deterministic)');
        // ------------------------------------------------------------------
        {
                // §3.1 never-attempted candidates are due immediately.
                const plan1 = planLivetvSchedulerTick({ nowMs: 1_000_000, candidates: [candidate({ slug: 'a' })] });
                ok(plan1.planned.length === 1 && plan1.planned[0].slug === 'a', '§3.1 a never-attempted source is due immediately');

                // §3.2 a recently-attempted source defers until interval+jitter elapsed.
                const nowMs = 10_000_000;
                const plan2 = planLivetvSchedulerTick({ nowMs, candidates: [candidate({ slug: 'a', intervalMinutes: 60, lastAttemptMs: nowMs - 30 * 60_000 })] });
                ok(plan2.planned.length === 0 && plan2.deferred.length === 1, '§3.2 a source inside its interval+jitter defers');
                const dueIn = plan2.deferred[0].dueInMs;
                ok(dueIn > (60 - 30) * 60_000 && dueIn <= (60 - 30) * 60_000 + Math.min(60 * 60_000 * 0.1 * 2, LIVETV_SCHEDULER_MAX_JITTER_MS), '§3.3 the deferred due date is interval+jitter-bounded');

                // §3.3 jitter bounds: for MANY slugs, due = interval ± 10% (cap 30min).
                let jitterSaw = { min: Infinity, max: -Infinity };
                for (let i = 0; i < 200; i += 1) {
                        const slug = `jitter-source-${i}`;
                        const p = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: [candidate({ slug, intervalMinutes: 720, lastAttemptMs: 10_000_000_000 - 720 * 60_000 })] });
                        // The source is overdue by interval; dueInMs measures the jitter overshoot.
                        if (p.deferred.length === 1) {
                                const overshoot = p.deferred[0].dueInMs;
                                jitterSaw.min = Math.min(jitterSaw.min, overshoot);
                                jitterSaw.max = Math.max(jitterSaw.max, overshoot);
                        }
                }
                ok(jitterSaw.max <= Math.min(720 * 60_000 * 0.1 * 2, LIVETV_SCHEDULER_MAX_JITTER_MS), '§3.4 every jitter overshoot is within ±10% capped at 30 minutes');
                ok(jitterSaw.min < jitterSaw.max, '§3.5 jitter actually varies across sources (desynchronization is real)');

                // §3.4 determinism: the same inputs produce the same plan.
                const cands = [candidate({ slug: 'b', intervalMinutes: 60, lastAttemptMs: 1000 }), candidate({ slug: 'a', intervalMinutes: 60, lastAttemptMs: 2000 })];
                const planA = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: cands.map((c) => ({ ...c })) });
                const planB = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: cands.map((c) => ({ ...c })) });
                ok(JSON.stringify(planA) === JSON.stringify(planB), '§3.6 the planner is fully deterministic');

                // §3.5 most-overdue-first ordering + per-kind caps. The attempt
                // gaps are hours apart so the (bounded) jitter can never
                // reorder them — near-ties MAY legitimately reorder by jitter
                // (that IS the desynchronization).
                const many = [
                        candidate({ slug: 'late-1', lastAttemptMs: 10_000_000_000 - 10 * 60 * 60_000, intervalMinutes: 60 }),
                        candidate({ slug: 'late-2', lastAttemptMs: 10_000_000_000 - 8 * 60 * 60_000, intervalMinutes: 60 }),
                        candidate({ slug: 'late-3', lastAttemptMs: 10_000_000_000 - 6 * 60 * 60_000, intervalMinutes: 60 }),
                        candidate({ slug: 'late-4', lastAttemptMs: 10_000_000_000 - 6 * 60 * 60_000, intervalMinutes: 60 }),
                        candidate({ slug: 'late-5', lastAttemptMs: 10_000_000_000 - 6 * 60 * 60_000, intervalMinutes: 60 })
                ];
                const plan3 = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: many });
                ok(plan3.planned.length === LIVETV_SCHEDULER_MAX_SOURCES_PER_TICK, '§3.7 the per-tick source cap applies', String(plan3.planned.length));
                ok(plan3.skippedForCapacity.length === many.length - LIVETV_SCHEDULER_MAX_SOURCES_PER_TICK, '§3.8 the overflow is honestly reported as capacity-skipped');
                // The two clearly-most-overdue slugs always lead; the third slot
                // belongs to the tied group (jitter decides within near-ties —
                // that IS the desynchronization; the slug tiebreak covers only
                // EXACTLY equal due dates).
                ok(plan3.planned[0].slug === 'late-1' && plan3.planned[1].slug === 'late-2', '§3.9 most-overdue-first ordering (stable under the jitter bound)');
                ok(['late-3', 'late-4', 'late-5'].includes(plan3.planned[2].slug), '§3.10 the tied group fills the remaining slot');

                // §3.6 EPG sources get their own cap.
                const epgMany = Array.from({ length: 5 }, (_, i) => candidate({ kind: 'epg_source' as const, slug: `epg-${i}`, lastAttemptMs: 1000, intervalMinutes: 60 }));
                const plan4 = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: epgMany });
                ok(plan4.planned.length === LIVETV_SCHEDULER_MAX_EPG_SOURCES_PER_TICK, '§3.11 the EPG cap is independent of the source cap');

                // §3.7 consecutive-failure backoff stretches the interval, bounded ×8.
                const healthy = candidate({ slug: 'h', intervalMinutes: 60, lastAttemptMs: 10_000_000_000 - 65 * 60_000 });
                const planHealthy = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: [healthy] });
                const failing = candidate({ slug: 'f', intervalMinutes: 60, lastAttemptMs: 10_000_000_000 - 65 * 60_000, consecutiveFailures: 4 });
                const planFailing = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: [failing] });
                ok(planHealthy.planned.length === 1 && planFailing.deferred.length === 1, '§3.12 a repeatedly-failing source backs off (due later than a healthy one)');
                const capped = candidate({ slug: 'c', intervalMinutes: 60, lastAttemptMs: 10_000_000_000 - 60 * 8 * 60_000 - 13 * 60_000, consecutiveFailures: 20 });
                const planCapped = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: [capped] });
                ok(planCapped.planned.length === 1, '§3.13 the backoff is capped at ×8 (the source still becomes due — never dropped)');

                // §3.8 duplicate window: a source attempted seconds ago is skipped as duplicate.
                const dup = candidate({ slug: 'd', intervalMinutes: 60, lastAttemptMs: 10_000_000_000 - 10_000 });
                const planDup = planLivetvSchedulerTick({ nowMs: 10_000_000_000, candidates: [dup], duplicateWindowMs: LIVETV_SCHEDULER_DUPLICATE_WINDOW_MS });
                ok(planDup.skippedDuplicates.length === 1 && planDup.planned.length === 0, '§3.14 a recent attempt is skipped as a duplicate invocation');
        }

        // ------------------------------------------------------------------
        console.log('§4 — bounded tick execution (scheduled history, budget, isolation)');
        // ------------------------------------------------------------------
        {
                const db = createMockDb();
                const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
                // One healthy m3u source (the mock fetcher answers instantly) and one failing one.
                db.state['livetv_sources'].push(
                        { id: UUID(1), slug: 'good-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/list.m3u8' }, priority: 0 },
                        { id: UUID(2), slug: 'bad-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://blocked.example/list.m3u8' }, priority: 1 }
                );
                const okFetcher = (async () => new Response('#EXTM3U\n#EXTINF:-1 tvg-id="a" tvg-name="Chan",Chan\nhttps://cdn.example/a.m3u8\n', { headers: { 'content-type': 'audio/x-mpegurl' } })) as unknown as typeof fetch;
                const badFetcher = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
                const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
                const calls: string[] = [];
                const fetchRouter = ((url: unknown) => {
                        calls.push(String(url));
                        return String(url).includes('blocked.example') ? badFetcher(url as never) : okFetcher(url as never);
                }) as unknown as typeof fetch;

                let fakeNow = 1_000_000;
                const tick = await executeLivetvSchedulerTick(db.client as never, {
                        fetcher: fetchRouter,
                        dnsResolver: resolver,
                        now: () => fakeNow,
                        sleep: async (ms) => {
                                fakeNow += ms;
                        },
                        retention: true
                });

                ok(tick.ok === false, '§4.1 the tick honestly reports not-ok when a planned subject failed');
                const goodEntry = tick.results.find((entry) => entry.slug === 'good-source');
                const badEntry = tick.results.find((entry) => entry.slug === 'bad-source');
                ok(goodEntry?.ok === true, '§4.1b the healthy source succeeded');
                ok(badEntry?.ok === false && badEntry?.status === 'http_error' && badEntry.deferred === false, '§4.1c the failing source reports its typed category (http_error) without deferral');
                ok(tick.plannedSources === 2, '§4.2 both eligible sources were planned', JSON.stringify({ planned: tick.plannedSources, results: tick.results.length }));
                ok(tick.results.length === 2, '§4.3 both planned sources executed');
                ok(tick.results.every((entry) => entry.kind === 'source' && typeof entry.ok === 'boolean'), '§4.4 per-subject results carry kind+ok');
                ok(tick.results.every((entry) => /^[0-9a-f-]{36}$/.test(entry.correlationId)), '§4.5 every subject carries a correlation id');

                // Scheduled-trigger history rows with the SAME correlation id per subject.
                ok(db.state['livetv_refresh_history'].length >= 2, '§4.6 persistent history rows were appended', String(db.state['livetv_refresh_history'].length));
                const historyRows = db.state['livetv_refresh_history'] as unknown as Row[];
                ok(historyRows.every((row) => row['trigger_type'] === 'scheduled'), '§4.7 every history row records trigger_type=scheduled');
                ok(historyRows.every((row) => row['operation'] === 'refresh' && row['subject_kind'] === 'source'), '§4.8 rows carry the operation + subject kind');
                const bySubject = new Map<string, Row[]>();
                for (const row of historyRows) {
                        const key = String(row['subject_id']);
                        bySubject.set(key, [...(bySubject.get(key) ?? []), row]);
                }
                ok([...bySubject.values()].every((rows) => new Set(rows.map((row) => row['correlation_id'])).size === 1), '§4.9 the attempts of one subject share ONE correlation id');

                // The healthy source's summary is bounded and redacted.
                const goodResult = tick.results.find((entry) => entry.slug === 'good-source');
                ok(goodResult && goodResult.ok === true && goodResult.errorCategory === null, '§4.10 the healthy source has no error category');
                const serialized = JSON.stringify(tick);
                ok(!serialized.includes('blocked.example') && !serialized.includes('cdn.example') && !serialized.includes('list.m3u8'), '§4.11 the tick summary contains NO URLs (bounded summary discipline)');

                // Ineligible sources are never scheduled (fresh registry state:
                // no history ⇒ both eligible sources are due immediately).
                const dbElig = createMockDb();
                dbElig.state['livetv_sources'].push(
                        { id: UUID(1), slug: 'good-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/list.m3u8' }, priority: 0 },
                        { id: UUID(2), slug: 'bad-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://blocked.example/list.m3u8' }, priority: 1 },
                        { id: UUID(3), slug: 'disabled-source', source_type: 'm3u_playlist', enabled: false, status: 'active', config: { playlistUrl: 'https://cdn.example/x.m3u8' }, priority: 2 },
                        { id: UUID(4), slug: 'maintenance-source', source_type: 'm3u_playlist', enabled: true, status: 'disabled', config: { playlistUrl: 'https://cdn.example/y.m3u8' }, priority: 3 }
                );
                const tick2 = await executeLivetvSchedulerTick(dbElig.client as never, { fetcher: fetchRouter, dnsResolver: resolver, now: () => 5_000_000, sleep: async () => {}, retention: false });
                ok(tick2.plannedSources === 2, '§4.12 disabled/maintenance sources are NEVER planned (eligibility gates respected)');
        }

        // ------------------------------------------------------------------
        console.log('§5 — duplicate invocation & budget deferral (overlap protection)');
        // ------------------------------------------------------------------
        {
                const db = createMockDb();
                const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
                db.state['livetv_sources'].push({ id: UUID(1), slug: 'slow-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/slow.m3u8' }, priority: 0 });
                let releaseFetch: (() => void) | null = null;
                const gate = new Promise<void>((resolve) => {
                        releaseFetch = resolve;
                });
                let fetchCount = 0;
                const slowFetcher = (async () => {
                        fetchCount += 1;
                        await gate;
                        return new Response('#EXTM3U\n', { headers: { 'content-type': 'audio/x-mpegurl' } }) as unknown as Response;
                }) as unknown as typeof fetch;
                const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

                // Tick A starts and blocks inside the fetch.
                const tickA = executeLivetvSchedulerTick(db.client as never, { fetcher: slowFetcher, dnsResolver: resolver, now: () => 1_000_000, sleep: async () => {}, retention: false });
                await new Promise((resolve) => setTimeout(resolve, 25));
                // Tick B (a duplicate invocation on the same instance) must NOT
                // double-fetch: the per-source in-flight guard returns a typed
                // refresh_in_progress outcome (history row status=skipped).
                const tickB = await executeLivetvSchedulerTick(db.client as never, { fetcher: slowFetcher, dnsResolver: resolver, now: () => 1_000_050, sleep: async () => {}, retention: false });
                const dupResults = tickB.results.filter((entry) => entry.slug === 'slow-source');
                ok(dupResults.length === 1 && dupResults[0].ok === false && dupResults[0].status === 'refresh_in_progress', '§5.1 the duplicate tick receives the typed in-progress outcome (no second upstream fetch)');
                ok(fetchCount === 1, '§5.2 exactly ONE upstream fetch happened across both invocations');
                releaseFetch?.();
                const finishedA = await tickA;
                ok(finishedA.results.every((entry) => entry.ok), '§5.3 the original tick completes normally after release');

                // History-backed duplicate window across invocations: the
                // durable attempt (real-timestamped by the refresh outcome)
                // is seconds old in REAL time, so a tick running with the
                // real clock skips the just-refreshed source even though its
                // interval has not elapsed.
                const tickC = await executeLivetvSchedulerTick(db.client as never, { fetcher: slowFetcher, dnsResolver: resolver, now: () => Date.now(), sleep: async () => {}, retention: false });
                ok(tickC.skippedDuplicates >= 1, '§5.4 the history-backed duplicate window skips the just-refreshed source');

                // Budget deferral: a 1.2s budget cannot start a 1.5s-minimum slice.
                const db2 = createMockDb();
                db2.state['livetv_sources'].push({ id: UUID(9), slug: 'budget-source', source_type: 'm3u_playlist', enabled: true, status: 'active', config: { playlistUrl: 'https://cdn.example/b.m3u8' }, priority: 0 });
                let fetchCount2 = 0;
                const countingFetcher = (async () => {
                        fetchCount2 += 1;
                        return new Response('#EXTM3U\n', { headers: { 'content-type': 'audio/x-mpegurl' } }) as unknown as Response;
                }) as unknown as typeof fetch;
                const tickD = await executeLivetvSchedulerTick(db2.client as never, { fetcher: countingFetcher, dnsResolver: resolver, budgetMs: 1_200, now: () => 5_000_000, sleep: async () => {}, retention: false });
                ok(tickD.plannedSources === 1 && tickD.results.length === 0, '§5.5 a budget below the minimum attempt slice defers the subject honestly');
                ok(fetchCount2 === 0, '§5.6 no upstream request is made for a deferred subject');
        }

        console.log(`\n=== livetv Phase 7 scheduler verification: ${passed} checks PASSED ===`);
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
