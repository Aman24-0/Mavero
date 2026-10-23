// ============================================================================
// Unified Live TV Phase 7 — admin operational diagnostics endpoint.
//
// GET /api/admin/livetv/ops/status
//   → 200 { ok, result: { subsystems, scheduler, sources, epgSources, inFlight } }
//
// The admin-only monitoring surface for the hardening phase (brief §6). It
// distinguishes the FOUR health layers without collapsing them:
//
//   * application/process health → the existing /api/health surface
//     (UNTOUCHED — this endpoint adds no liveness semantics);
//   * database connectivity → one bounded probe below;
//   * refresh-subsystem health → the durable history summary (last tick,
//     trigger counts, per-source staleness);
//   * individual upstream source health → last attempt/success +
//     consecutive failures + the sanitized error CATEGORY per subject.
//
// HONESTY BOUNDARY: a source whose catalogue fetch returned HTTP 200 is
// NOT thereby "playable" — nothing here probes protected media, bypasses
// DRM/authentication/geo-restrictions, or infers playback compatibility
// from ingestion health. Source health describes REFRESH operations only;
// playback selection remains exclusively the Phase 5 router's job.
//
// SECURITY / RESPONSE DISCIPLINE:
//   * requireAdmin FIRST, `no-store`, no parameters, bounded queries.
//   * Per-subject rows are bounded (≤25 sources + ≤10 EPG sources,
//     stalest-first) and carry ONLY: ids, slugs, timestamps, the bounded
//     status vocabulary and the sanitized error CATEGORY (≤60 chars).
//     NEVER: configuration, URLs, error message bodies, stack traces,
//     credentials, signed material, or any env value.
//   * The scheduler secret's PRESENCE is reported as a boolean — the
//     secret itself is never reflected anywhere.
//   * `unified_enabled` is reported as a boolean only.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { isUnifiedLivetvEnabled } from '$lib/server/livetv/playback-resolver';
import { getLivetvRefreshHistoryPage, summarizeLivetvSubjectHealth, type LivetvSubjectHealthSummary } from '$lib/server/livetv/history';
import { isLivetvSchedulerConfigured } from '$lib/server/livetv/scheduler';
import { getLivetvRefreshInFlightCount } from '$lib/server/livetv/refresh-service';
import { getLivetvEpgInFlightCount } from '$lib/server/livetv/epg/guide-service';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Bounds for the diagnostics response (predictable size). */
const MAX_SOURCE_ROWS = 25;
const MAX_EPG_ROWS = 10;
/** The history page read for the aggregation (bounded). */
const HISTORY_PAGE = 300;
/** Bounded probe timeout for the DB reachability check. */
const DB_PROBE_TIMEOUT_MS = 2_000;

type SubjectRow = {
        id: string;
        slug: string;
        lastAttemptAt: string | null;
        lastSuccessAt: string | null;
        consecutiveFailures: number;
        lastErrorCategory: string | null;
        lastStatus: string | null;
};

function toSubjectRow(summary: LivetvSubjectHealthSummary): SubjectRow {
        return {
                id: summary.subjectId,
                slug: summary.slug,
                lastAttemptAt: summary.lastAttemptAt,
                lastSuccessAt: summary.lastSuccessAt,
                consecutiveFailures: summary.consecutiveFailures,
                lastErrorCategory: summary.lastErrorCategory,
                lastStatus: summary.lastStatus
        };
}

/** Cheap bounded DB probe: SELECT over the config-meta singleton (1 row). */
async function probeDatabase(client: ReturnType<typeof createSupabaseAdminClient>): Promise<{ reachable: boolean; latencyMs: number }> {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DB_PROBE_TIMEOUT_MS);
        try {
                const { error } = await client.from('livetv_config_meta').select('unified_enabled').limit(1).abortSignal(controller.signal);
                return { reachable: !error, latencyMs: Date.now() - started };
        } catch {
                return { reachable: false, latencyMs: Date.now() - started };
        } finally {
                clearTimeout(timer);
        }
}

/** EPG freshness: the newest programme window end per guide source (bounded, indexed). */
async function epgFreshness(client: ReturnType<typeof createSupabaseAdminClient>, epgSourceIds: string[]): Promise<Map<string, string | null>> {
        const freshness = new Map<string, string | null>();
        for (const id of epgSourceIds) {
                const { data, error } = await client
                        .from('livetv_epg_programmes')
                        .select('end_at')
                        .eq('epg_source_id', id)
                        .order('end_at', { ascending: false })
                        .limit(1);
                const row = error ? null : ((data ?? []) as unknown as { end_at: string }[])[0];
                freshness.set(id, row?.end_at ?? null);
        }
        return freshness;
}

export const GET: RequestHandler = async ({ locals }) => {
        await requireAdmin(locals, { redirectTo: '/admin/system/livetv' });

        let client: ReturnType<typeof createSupabaseAdminClient>;
        try {
                client = createSupabaseAdminClient();
        } catch {
                return json(
                        {
                                ok: true,
                                result: {
                                        subsystems: { database: { reachable: false, latencyMs: 0 }, refresh: null, unified: { enabled: false } },
                                        scheduler: { configured: isLivetvSchedulerConfigured() },
                                        sources: [],
                                        epgSources: [],
                                        inFlight: { sources: getLivetvRefreshInFlightCount(), epgSources: getLivetvEpgInFlightCount() }
                                }
                        },
                        { headers: NO_STORE }
                );
        }

        // Bounded reads: one history page + one DB probe + ≤10 freshness probes.
        const [historyRows, dbProbe] = await Promise.all([getLivetvRefreshHistoryPage(client, { limit: HISTORY_PAGE }), probeDatabase(client)]);
        const summaries = summarizeLivetvSubjectHealth(historyRows);
        const sourceRows = summaries.filter((summary) => summary.subjectKind === 'source').slice(0, MAX_SOURCE_ROWS).map(toSubjectRow);
        const epgRowsRaw = summaries.filter((summary) => summary.subjectKind === 'epg_source').slice(0, MAX_EPG_ROWS);
        const epgRows = epgRowsRaw.map(toSubjectRow);
        const freshness = await epgFreshness(client, epgRowsRaw.map((summary) => summary.subjectId));
        const epgRowsWithFreshness = epgRows.map((row, index) => ({ ...row, guideWindowEndAt: freshness.get(epgRowsRaw[index]?.subjectId ?? '') ?? null }));

        // Refresh-subsystem summary from the same bounded history page.
        const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
        let scheduledLast24h = 0;
        let manualLast24h = 0;
        let lastTickAt: string | null = null;
        let lastTickStatus: string | null = null;
        for (const row of historyRows) {
                const startedMs = Date.parse(row.started_at);
                if (Number.isFinite(startedMs) && startedMs >= dayAgoMs) {
                        if (row.trigger_type === 'scheduled') scheduledLast24h += 1;
                        else manualLast24h += 1;
                }
                if (row.trigger_type === 'scheduled' && (!lastTickAt || row.started_at > lastTickAt)) {
                        lastTickAt = row.started_at;
                        lastTickStatus = row.status;
                }
        }

        let unifiedEnabled = false;
        try {
                unifiedEnabled = await isUnifiedLivetvEnabled(client);
        } catch {
                unifiedEnabled = false; // fail-closed parity with the resolver
        }

        return json(
                {
                        ok: true,
                        result: {
                                subsystems: {
                                        database: { reachable: dbProbe.reachable, latencyMs: dbProbe.latencyMs },
                                        refresh: {
                                                lastTickAt,
                                                lastTickStatus,
                                                scheduledTriggersLast24h: scheduledLast24h,
                                                manualTriggersLast24h: manualLast24h,
                                                historyScope: 'durable'
                                        },
                                        unified: { enabled: unifiedEnabled }
                                },
                                scheduler: { configured: isLivetvSchedulerConfigured() },
                                sources: sourceRows,
                                epgSources: epgRowsWithFreshness,
                                inFlight: { sources: getLivetvRefreshInFlightCount(), epgSources: getLivetvEpgInFlightCount() }
                        }
                },
                { headers: NO_STORE }
        );
};
